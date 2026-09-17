/**
 * Мир: ядро симуляции молекулярной динамики.
 *
 * Один шаг устроен так (velocity Verlet с термостатом между половинами):
 *
 *   1. v += F·dt/2  — по силам, посчитанным на прошлом шаге
 *   2. термостат (Ланжевен / Берендсен / Нозе-Хувер) — трогает только скорости
 *   3. x += v·dt, заворачивание в ящик (или отражение от стенок)
 *   4. перестроить сетку, посчитать силы заново
 *   5. v += F·dt/2
 *   6. измерения: T, E, P, обновление кэшей для раскраски
 *
 * Смысл такого порядка: термостат работает с уже «половинно» обновлёнными
 * скоростями и потому не разрушает симпатическую структуру шага. Без
 * термостата интегрирование сохраняет энергию с точностью до флуктуаций
 * порядка dt² — это проверяется отдельным тестом на дрейф энергии.
 *
 * Класс намеренно ничего не знает ни про DOM, ни про Pixi: то же ядро
 * гоняют тесты в чистом Node, и его же позже можно вынести в Web Worker.
 */

import { computeForcesDirect, computeForcesFromList, type ForceStats } from './forces.js';
import { DEFAULT_SKIN, VerletList } from './neighbours.js';
import { buildGrid, cellSizeFor } from './grid.js';
import {
  applyBerendsen,
  applyFrozenMask,
  applyLangevin,
  applyNoseHoover,
  allocNoseHoover,
  type BrushPlane,
  type NoseHooverState,
  type ViewAxis,
  clampSpeeds,
  drift,
  freezeRegion as freezeRegionOf,
  kick,
  maxStableSpeed,
  pokeRegion,
  reflectWalls,
  removeEscaped,
  setTemperature,
  viewAxis as makeViewAxis,
} from './integrator.js';
import {
  buildState,
  normaliseTemperature,
  recallReferences,
  rescaleBox,
} from './initializers.js';
import { aliveCount, kineticEnergyOfState } from './velocity.js';
import { measure, RadialDistribution, type Measurement } from './measure.js';
import { ljShift, type LjShift } from './potential.js';
import { Rng } from './rng.js';
import {
  boxLength,
  DEFAULT_PARAMS,
  type CellGrid,
  type ColorMode,
  type LatticeKind,
  type ParticleState,
  type WorldParams,
} from './types.js';

/** Один замер для графиков: время и величины. */
export interface Sample {
  /** Время в приведённых единицах τ. */
  time: number;
  temperature: number;
  potential: number;
  kinetic: number;
  total: number;
  pressure: number;
  /** Высота первого пика g(r) — индикатор кристалличности. */
  orderPeak: number;
  mobileFraction: number;
}

/** Ёмкость кольцевого буфера графиков: при dt = 0.004 это ≈ 16 τ. */
const HISTORY_CAPACITY = 4096;

/**
 * Кольцевой буфер замеров.
 *
 * Массивы не растут: длинная симуляция не должна «съедать» память. При
 * переполнении самое старое значение вытесняется — для графиков это ровно
 * то, что нужно (окно наблюдения скользит).
 */
export class History {
  private readonly capacity: number;
  private readonly buffer: Array<Sample | undefined>;
  private start = 0;
  private length = 0;

  constructor(capacity = HISTORY_CAPACITY) {
    this.capacity = capacity;
    this.buffer = new Array<Sample | undefined>(capacity);
  }

  get size(): number {
    return this.length;
  }

  push(sample: Sample): void {
    if (this.length === this.capacity) {
      this.buffer[this.start] = sample;
      this.start = (this.start + 1) % this.capacity;
    } else {
      this.buffer[(this.start + this.length) % this.capacity] = sample;
      this.length++;
    }
  }

  get(index: number): Sample | undefined {
    if (index < 0 || index >= this.length) return undefined;
    return this.buffer[(this.start + index) % this.capacity];
  }

  last(): Sample | undefined {
    return this.length === 0 ? undefined : this.get(this.length - 1);
  }

  clear(): void {
    this.start = 0;
    this.length = 0;
  }

  /**
   * Прореживание для графика: не более `maxPoints` точек, но последняя
   * всегда входит в выборку. Без этого на длинной симуляции Canvas рисует
   * десятки тысяч отрезков за кадр и роняет частоту обновления.
   */
  series(key: keyof Omit<Sample, 'time'>, maxPoints = 720): { t: number[]; v: number[] } {
    const t: number[] = [];
    const v: number[] = [];
    const n = this.length;
    if (n === 0) return { t, v };
    const step = Math.max(1, Math.ceil(n / maxPoints));
    for (let i = 0; i < n; i += step) {
      const s = this.get(i);
      if (!s) continue;
      t.push(s.time);
      v.push(s[key]);
    }
    const lastSample = this.get(n - 1);
    if (lastSample && (t.length === 0 || t[t.length - 1] !== lastSample.time)) {
      t.push(lastSample.time);
      v.push(lastSample[key]);
    }
    return { t, v };
  }
}

/** Заявка на «тычок» мышью: цилиндр вдоль оси взгляда. */
export interface PokeRequest {
  /** Ось взгляда и точка на ней. */
  plane: BrushPlane;
  /** Импульс в экранных направлениях (dx — экранный X, dy — экранный Y, dz — вглубь). */
  dx: number;
  dy: number;
  dz: number;
  radius: number;
  strength: number;
}

/**
 * Квантиль величины по живым частицам, без полной сортировки.
 *
 * Нужна для верхней границы цветовой шкалы: одиночный выброс не должен
 * управлять всей палитрой (см. `World.colorValues`).
 *
 * Реализация — гистограмма по логарифмической сетке от `min` до `max`.
 * Линейная сетка здесь не годится: скорости распределены по Максвеллу с
 * длинным «хвостом», и в верхних бакетах оказалось бы по одной частице, что
 * делает квантиль неустойчивым. Логарифмическая сетка (128 бакетов на
 * 12 декад) даёт ошибку в пределах нескольких процентов от самого значения —
 * для цвета этого более чем достаточно.
 *
 * @param values массив значений (может содержать мусор за пределами count)
 * @param count  сколько элементов массива действительно принадлежат частицам
 * @param alive  маска живых частиц
 */
function quantileOf(
  values: Float64Array,
  count: number,
  alive: Uint8Array,
  q: number,
  min: number,
  max: number,
): number {
  if (!(max > min) || !Number.isFinite(min) || !Number.isFinite(max)) return max;
  const BINS = 128;
  const positives = min > 0;
  // Логарифмическая сетка требует положительных значений; если минимум нулевой
  // (так бывает у плотности и смещения), добавляем сдвиг.
  const shift = positives ? 0 : Math.max(1e-6, (max - min) * 1e-3);
  const lo = Math.log(min + shift);
  const hi = Math.log(max + shift);
  if (!(hi > lo) || !Number.isFinite(lo) || !Number.isFinite(hi)) return max;
  const invSpan = BINS / (hi - lo);
  const histogram = new Int32Array(BINS + 1);
  let total = 0;
  for (let i = 0; i < count; i++) {
    if (alive[i] === 0) continue;
    const v = values[i];
    if (!Number.isFinite(v)) continue;
    let b = Math.floor((Math.log(v + shift) - lo) * invSpan);
    if (b < 0) b = 0;
    else if (b > BINS) b = BINS;
    histogram[b]++;
    total++;
  }
  if (total === 0) return max;
  const target = q * total;
  let running = 0;
  for (let b = 0; b <= BINS; b++) {
    running += histogram[b];
    if (running >= target) {
      return Math.exp(lo + ((b + 0.5) / BINS) * (hi - lo)) - shift;
    }
  }
  return max;
}

/** Мир целиком: частицы, параметры, статистика. */
export class World {
  params: WorldParams;
  state: ParticleState;
  box: number;
  grid: CellGrid;
  shift: LjShift;
  rng: Rng;
  nh: NoseHooverState;

  /** Маска замороженных частиц (1 — частица зафиксирована на месте). */
  frozen: Uint8Array;

  readonly history = new History();
  readonly radial = new RadialDistribution(3.5, 140);

  /** Накопленное время симуляции в единицах τ. */
  time = 0;
  /** Число выполненных шагов. */
  steps = 0;

  private stats: ForceStats = { potential: 0, virial: 0, pairs: 0 };
  private current: Measurement;
  /** Последнее измеренное значение первого пика g(r) — для графика. */
  private lastPeak = 0;
  private pendingPoke: PokeRequest | null = null;
  private pendingRebuild: { kind: LatticeKind; keepTemperature: boolean } | null = null;

  /**
   * Список соседей Верле — основной ускоритель шага.
   *
   * Просматривать все частицы 27 ячеек ради ~46 настоящих соседей расточительно:
   * около 90 % проверок расстояния уходят впустую. Список соседей с «кожей»
   * перестраивается раз в десятки шагов, а между перестроениями шаг трогает
   * только реальных соседей — это примерно втрое быстрее.
   */
  readonly verlet = new VerletList(1, DEFAULT_SKIN);
  /** Сколько шагов прожил текущий список — для статистики и панели. */
  private listAge = 0;
  /** Перестраивался ли список на последнем шаге. */
  private listRebuilt = false;
  /** Число перестроений за всю жизнь мира. */
  private listRebuilds = 0;

  /**
   * Кэш оси взгляда для кисти.
   *
   * Углы камеры не меняются между кликами, а `sin`/`cos` в горячем пути
   * «протянул мышью — подействовало на сотни частиц» ни к чему. Кэш
   * сбрасывается при смене углов; ключ — сами углы.
   */
  private axisCache: { yaw: number; pitch: number; axis: ViewAxis } | null = null;

  /**
   * Сколько частиц получило ограничение скорости на последнем шаге.
   *
   * Диагностика: ненулевое значение означает, что система подошла к пределу
   * устойчивости дискретизации (см. `maxStableSpeed`). В штатной работе — 0.
   */
  private clampedLastStep = 0;

  /** Сколько раз система восстанавливалась после NaN/Infinity. */
  private recoveredFromNaN = 0;

  /**
   * Достаточно ли мелкая сетка, чтобы обход 27 ячеек был корректен.
   *
   * Инвариант: ячейка обязана быть НЕ МЕНЬШЕ радиуса поиска (rc + кожа).
   * `makeGrid` строит не меньше трёх ячеек по оси, и в маленьком ящике
   * `box / n` может оказаться меньше `rc + skin`. Тогда ближайший сосед
   * попадает не в соседнюю ячейку, а через одну, и часть пар теряется МОЛЧА:
   * силы просто не считаются, система «остывает».
   *
   * Измерено до исправления: N = 256, ρ* = 1.3 давали ячейку 1.94σ при
   * требуемых 2.9σ, и список терял 451 пару из 9984 (4.5 %); N = 500 при той
   * же плотности — 875 из 19500. Проверка кэшируется, потому что зависит
   * только от геометрии, а не от координат.
   */
  private gridTooCoarse = false;

  constructor(params: Partial<WorldParams> = {}, seed = 20260214, lattice: LatticeKind = 'fcc') {
    this.params = { ...DEFAULT_PARAMS, ...params };
    this.rng = new Rng(seed);
    this.nh = allocNoseHoover();
    this.shift = ljShift(this.params.cutoff);
    this.box = boxLength(this.params.count, this.params.density);

    const built = buildState(
      lattice,
      this.params.count,
      this.params.density,
      this.params.temperature,
      seed,
    );
    this.state = built.state;
    this.box = built.box;
    this.frozen = new Uint8Array(this.state.count);
    this.grid = this.makeGrid();
    this.verlet.resize(this.state.count);
    normaliseTemperature(this.state, this.params.temperature, this.rng);
    recallReferences(this.state);

    this.rebuildForces();
    this.current = this.measureNow();
    this.history.push(this.makeSample());
  }

  /* ------------------------------------------------------------------ */
  /* Служебное                                                           */
  /* ------------------------------------------------------------------ */

  /** Нужно ли вычитать движение центра масс из числа степеней свободы. */
  private subtractDrift(): boolean {
    return this.params.boundary === 'periodic';
  }

  private makeGrid(): CellGrid {
    // Ячейка обязана вмещать радиус поиска вместе с «кожей» списка
    // соседей: иначе сосед окажется через одну ячейку и часть пар потеряется.
    const size = cellSizeFor(this.params.cutoff);
    const n = Math.max(3, Math.floor(this.box / size));
    const cells = n * n * n;
    const grid: CellGrid = {
      n,
      size: this.box / n,
      cellStart: new Int32Array(cells + 1),
      order: new Int32Array(this.state.count),
      cellIndex: new Int32Array(this.state.count),
      counts: new Int32Array(cells),
    };
    // Радиус поиска — обрезание плюс кожа списка Верле. Сетка, которая его
    // не вмещает, даёт не «медленно», а НЕПРАВИЛЬНО: пары теряются.
    const searchRadius = this.params.cutoff + DEFAULT_SKIN;
    this.gridTooCoarse = grid.size + 1e-9 < searchRadius;
    return grid;
  }

  /**
   * Полный пересчёт: сетка, список соседей, силы.
   * Вызывается после любой смены геометрии или координат «извне».
   */
  private rebuildForces(): void {
    if (this.gridTooCoarse) {
      // Сетка не вмещает радиус поиска — считаем честным перебором.
      // Дороже на маленьких системах, но правильно; альтернатива — молча
      // терять пары (см. `gridTooCoarse`).
      this.stats = computeForcesDirect(
        this.state,
        this.box,
        this.params.cutoff,
        this.shift,
        this.params.boundary === 'periodic',
        true,
      );
      this.listAge = 0;
      this.listRebuilt = true;
      this.listRebuilds = 1;
      return;
    }
    buildGrid(this.state, this.grid);
    this.verlet.build(
      this.state,
      this.grid,
      this.box,
      this.params.cutoff,
      this.params.boundary === 'periodic',
    );
    this.stats = computeForcesFromList(
      this.state,
      this.verlet,
      this.box,
      this.params.cutoff,
      this.shift,
      this.params.boundary === 'periodic',
      true,
    );
    this.listAge = 0;
    this.listRebuilt = true;
    this.listRebuilds = 1;
  }

  /**
   * Обновление сил на шаге.
   *
   * Список соседей перестраивается только когда «кожа» исчерпана — то есть
   * когда какая-то частица ушла от координат построения больше чем на skin/2.
   * В остальные шаги перебираются лишь реальные соседи.
   */
  private updateForces(): void {
    this.listRebuilt = false;
    if (this.gridTooCoarse) {
      this.stats = computeForcesDirect(
        this.state,
        this.box,
        this.params.cutoff,
        this.shift,
        this.params.boundary === 'periodic',
        true,
      );
      return;
    }
    if (this.verlet.needsRebuild(this.state, this.params.boundary === 'periodic', this.box)) {
      buildGrid(this.state, this.grid);
      this.verlet.build(
        this.state,
        this.grid,
        this.box,
        this.params.cutoff,
        this.params.boundary === 'periodic',
      );
      this.listAge = 0;
      this.listRebuilt = true;
      this.listRebuilds++;
    } else {
      this.listAge++;
    }
    this.stats = computeForcesFromList(
      this.state,
      this.verlet,
      this.box,
      this.params.cutoff,
      this.shift,
      this.params.boundary === 'periodic',
      true,
    );
  }

  private measureNow(): Measurement {
    return measure(
      this.state,
      this.box,
      this.stats.potential,
      this.stats.virial,
      this.subtractDrift(),
    );
  }

  private makeSample(): Sample {
    return {
      time: this.time,
      temperature: this.current.temperature,
      potential: this.stats.potential,
      kinetic: this.current.kinetic,
      total: this.stats.potential + this.current.kinetic,
      pressure: this.current.pressure,
      orderPeak: this.lastPeak,
      mobileFraction: this.current.mobileFraction,
    };
  }

  /* ------------------------------------------------------------------ */
  /* Шаг                                                                 */
  /* ------------------------------------------------------------------ */

  /** Один полный шаг интегрирования. Возвращает замер после шага. */
  step(): Measurement {
    const dt = this.params.dt;
    const half = dt * 0.5;

    this.applyPending();

    const frozen = this.hasFrozen();

    // 1. Половина толчка по силам с прошлого шага.
    kick(this.state, half);

    // 1a. Замороженные обнуляются СРАЗУ после толчка.
    //
    // Раньше маска применялась только в конце шага. Этого недостаточно:
    // `kick` успевал придать замороженной частице скорость F·dt/2, и `drift`
    // тут же сдвигал её на (F·dt/2)·dt. За 200 шагов они «проезжали» 8σ —
    // то есть «заморозить» означало «сильно замедлить», а не «остановить».
    // Маскировать надо между толчком и дрейфом: тогда v = 0 на входе в дрейф
    // и координата не меняется вовсе.
    if (frozen) applyFrozenMask(this.state, this.frozen);

    // 2. Термостат: трогает только скорости.
    this.applyThermostat(dt);

    // 2a. Термостат тоже трогает замороженных (Берендсен и Нозе-Хувер
    // масштабируют ВСЕ скорости). Если маску не повторить, термостат
    // «оживит» остановленные частицы, и они снова начнут дрейфовать.
    if (frozen) applyFrozenMask(this.state, this.frozen);

    // 2b. Предел устойчивости дискретизации.
    //
    // Численный выброс необратим: термостат убирает ~1 % энергии за шаг, а
    // силы при разлёте растут экспоненциально, поэтому «остудить» улетевшую
    // систему нельзя в принципе (измерено: 1.5·10¹⁹ → 1.16·10⁴⁷ за 100 шагов).
    // Единственная защита — не дать скоростям превысить то, что шаг ещё
    // разрешает. При штатных температурах ограничение не срабатывает.
    this.clampedLastStep = clampSpeeds(this.state, maxStableSpeed(dt));
    // 3. Дрейф и границы.
    const periodic = this.params.boundary === 'periodic';
    drift(this.state, dt, this.box, periodic, true);
    if (this.params.boundary === 'reflective') {
      reflectWalls(this.state, this.box);
    } else if (this.params.boundary === 'open') {
      removeEscaped(this.state, this.box, 4);
    }

    // 4. Новые силы + вторая половина толчка.
    //    Здесь список соседей перестраивается только при необходимости.
    this.updateForces();
    kick(this.state, half);

    // 5. И снова обнуляем: вторая половина толчка тоже добавила скорость.
    if (frozen) applyFrozenMask(this.state, this.frozen);

    this.time += dt;
    this.steps++;

    // 6. Замер и проверка на нечисловой мусор (NaN/Infinity).
    //
    // Даже с ограничением скорости возможны патологические комбинации
    // (например, частица, «выброшенная» толчком точно в сердечник потенциала
    // другой частицы). Тогда вся система мгновенно становится NaN, и все
    // последующие вычисления бессмысленны: графики рисуют мусор, а игрок не
    // понимает, что произошло. Дешевле обнаружить это здесь и восстановить
    // состояние, чем оставить приложение в нерабочем виде.
    this.current = this.measureNow();
    if (!Number.isFinite(this.current.temperature) || !Number.isFinite(this.current.total)) {
      this.recoverFromNaN();
      this.current = this.measureNow();
    }
    this.history.push(this.makeSample());
    return this.current;
  }

  /**
   * Восстановление системы после численного мусора.
   *
   * Координаты и скорости заменяются заново: если в них попал NaN или
   * Infinity, он мгновенно «размазывается» по всей системе через силы, и
   * сохранить что-то осмысленное всё равно нельзя. Частицы расставляются
   * регулярной решёткой при целевой температуре — система продолжает работу,
   * а игрок видит, что произошёл сброс, а не «застывшую» сцену.
   */
  private recoverFromNaN(): void {
    const target = Number.isFinite(this.params.temperature)
      ? Math.max(0.05, Math.min(3, this.params.temperature))
      : 0.5;
    const built = buildState(
      'fcc',
      this.params.count,
      this.params.density,
      target,
      this.rng.nextUint32(),
    );
    this.state = built.state;
    this.box = built.box;
    this.frozen = new Uint8Array(built.state.count);
    this.nh = allocNoseHoover();
    this.grid = this.makeGrid();
    this.verlet.resize(this.state.count);
    recallReferences(this.state);
    this.rebuildForces();
    this.recoveredFromNaN++;
  }

  /** Сколько раз система восстанавливалась после численного мусора. */
  get nanRecoveries(): number {
    return this.recoveredFromNaN;
  }

  /**
   * Сделать `count` шагов подряд, не собирая статистику g(r).
   * Нужно для «отжига» пресетов и для скриптов витрины.
   */
  run(count: number): void {
    for (let i = 0; i < count; i++) this.step();
  }

  private hasFrozen(): boolean {
    for (let i = 0; i < this.frozen.length; i++) if (this.frozen[i] !== 0) return true;
    return false;
  }

  private applyThermostat(dt: number): void {
    const kind = this.params.thermostat;
    if (kind === 'none') return;
    const dof = this.degreesOfFreedom();
    const kinetic = kineticEnergyOfState(this.state);
    const target = this.params.temperature;

    switch (kind) {
      case 'berendsen':
        applyBerendsen(this.state, kinetic, dof, target, dt, this.params.thermostatTau);
        break;
      case 'langevin':
        applyLangevin(this.state, dt, this.params.friction, target, this.rng);
        break;
      case 'nose-hoover':
        applyNoseHoover(this.state, this.nh, kinetic, dof, target, dt, this.params.thermostatTau);
        break;
      default:
        break;
    }
  }

  private degreesOfFreedom(): number {
    const n = aliveCount(this.state);
    if (n <= 1) return 1;
    return 3 * n - (this.subtractDrift() ? 3 : 0);
  }

  /**
   * Кадр статистики для g(r).
   *
   * Гистограмма строится по той же сетке, что и силы, поэтому стоимость
   * линейна по числу частиц. Вызывается приложением раз в несколько шагов:
   * чаще не нужно, кривая накапливается десятками кадров.
   */
  sampleRadial(): void {
    this.radial.accumulate(this.state, this.box, this.params.boundary === 'periodic');
    this.lastPeak = this.radial.firstPeak(this.box);
  }

  /**
   * Высота первого пика g(r) — грубая мера кристалличности.
   *
   * У жидкости первый пик ≈ 2.5…3, у кристалла 5 и выше, причём пики
   * расщепляются. Значение шумное при малой статистике, поэтому служит
   * индикатором на графике и признаком в проверках уровней, где число
   * кадров контролируется.
   */
  get orderPeak(): number {
    return this.lastPeak;
  }

  /* ------------------------------------------------------------------ */
  /* Управление                                                          */
  /* ------------------------------------------------------------------ */

  /** Отложенная перестройка: применится в начале ближайшего шага. */
  requestRebuild(kind: LatticeKind, keepTemperature = true): void {
    this.pendingRebuild = { kind, keepTemperature };
  }

  private applyPending(): void {
    if (this.pendingPoke) {
      const p = this.pendingPoke;
      this.pendingPoke = null;
      pokeRegion(
        this.state,
        p.plane,
        this.box,
        p.radius,
        p.strength,
        p.dx,
        p.dy,
        p.dz,
        this.params.boundary === 'periodic',
      );
    }
    if (this.pendingRebuild) {
      const request = this.pendingRebuild;
      this.pendingRebuild = null;
      this.rebuild(request.kind, request.keepTemperature);
    }
  }

  /**
   * Перестройка мира под текущие count/density с выбранной решёткой.
   * История и g(r) сбрасываются: это уже другая система.
   *
   * @param keepTemperature сохранять ли заданную T*. Сейчас оба значения
   *   совпадают: цель термостата переносится всегда, и отдельного «сбросить
   *   температуру к исходной» сценария в интерфейсе нет. Параметр оставлен,
   *   потому что он часть контракта вызывающих (`requestRebuild`) и точка
   *   расширения для «пересобрать холодным».
   */
  rebuild(kind: LatticeKind, keepTemperature: boolean): void {
    const temperature = this.params.temperature;
    void keepTemperature;
    const count = this.params.count;
    const built = buildState(
      kind,
      count,
      this.params.density,
      temperature,
      this.rng.nextUint32(),
    );
    this.state = built.state;
    this.box = built.box;
    this.frozen = new Uint8Array(count);
    this.nh = allocNoseHoover();
    this.grid = this.makeGrid();
    this.verlet.resize(this.state.count);
    this.resetStatistics();
    normaliseTemperature(this.state, temperature, this.rng);
    recallReferences(this.state);
    this.rebuildForces();
    this.current = this.measureNow();
    this.history.push(this.makeSample());
  }

  /** Смена числа частиц и/или плотности с полной перестройкой. */
  resize(count: number, density: number, kind: LatticeKind = 'fcc'): void {
    const nextCount = Math.max(16, Math.min(60000, Math.round(count)));
    const nextDensity = Math.max(0.01, Math.min(1.4, density));
    this.params.count = nextCount;
    this.params.density = nextDensity;

    const built = buildState(
      kind,
      nextCount,
      nextDensity,
      this.params.temperature,
      this.rng.nextUint32(),
    );
    this.state = built.state;
    this.box = built.box;
    this.frozen = new Uint8Array(nextCount);
    this.nh = allocNoseHoover();
    this.grid = this.makeGrid();
    this.verlet.resize(this.state.count);
    this.resetStatistics();
    normaliseTemperature(this.state, this.params.temperature, this.rng);
    recallReferences(this.state);
    this.rebuildForces();
    this.current = this.measureNow();
    this.history.push(this.makeSample());
  }

  private resetStatistics(): void {
    this.time = 0;
    this.steps = 0;
    this.lastPeak = 0;
    this.history.clear();
    this.radial.reset();
  }

  /**
   * Изменение плотности без перестройки решётки: ящик сжимается, координаты
   * масштабируются вместе с ним. Физически это быстрая деформация — система
   * сама придёт к равновесию, и по графику давления видно, как именно.
   */
  setDensity(density: number): void {
    const next = Math.max(0.01, Math.min(1.4, density));
    const newBox = boxLength(this.state.count, next);
    rescaleBox(this.state, this.box, newBox, this.params.boundary === 'periodic');
    this.params.density = next;
    this.box = newBox;
    this.grid = this.makeGrid();
    this.verlet.resize(this.state.count);
    this.radial.reset();
    this.history.clear();
    this.rebuildForces();
    this.current = this.measureNow();
    this.history.push(this.makeSample());
  }

  /**
   * Разовая установка температуры: скорости пересчитываются так, чтобы
   * температура в точности равнялась целевой. Это не термостат — полезно,
   * когда нужно «поставить» систему в состояние и дальше смотреть на её
   * собственную динамику.
   */
  applyTemperatureNow(): void {
    const n = aliveCount(this.state);
    const dof = Math.max(1, 3 * n - (this.subtractDrift() ? 3 : 0));
    setTemperature(this.state, this.params.temperature, dof, this.rng);
    this.current = this.measureNow();
    this.history.push(this.makeSample());
  }

  /**
   * Полная остановка: обнуляются скорости И ставится маска заморозки.
   *
   * ─── Почему одной установки скоростей в ноль недостаточно ─────────────────
   *
   * Раньше здесь было только `vx.fill(0); vy.fill(0); vz.fill(0)`. Это
   * «остановить на мгновение», а не «заморозить»: уже на следующем шаге
   * `kick` придаёт частицам скорость по действующим силам, а термостат
   * (Берендсен, Лангевеи, Нозе-Хувер) возвращает их к заданной T* — потому что
   * при обнулённых скоростях измеренная температура равна нулю, и для
   * термостата это максимальное отклонение от цели. В результате кнопка
   * выглядела сломанной: «заморозил, а они двигаются».
   *
   * Теперь ставится маска: она обнуляет скорости на каждой стадии шага
   * (после каждого толчка и после термостата), поэтому частицы действительно
   * стоят. Парная кнопка «Разморозить» снимает маску и возвращает подвижность.
   */
  freezeAll(): void {
    this.frozen.fill(1);
    this.state.vx.fill(0);
    this.state.vy.fill(0);
    this.state.vz.fill(0);
    this.current = this.measureNow();
    this.history.push(this.makeSample());
  }

  /** Масштабирование скоростей — кнопки «нагреть» и «остудить». */
  scaleVelocities(factor: number): void {
    const f = Math.max(0.01, factor);
    for (let i = 0; i < this.state.count; i++) {
      this.state.vx[i] *= f;
      this.state.vy[i] *= f;
      this.state.vz[i] *= f;
    }
    this.current = this.measureNow();
    this.history.push(this.makeSample());
  }

  /** Снять заморозку со всех. */
  unfreezeAll(): void {
    this.frozen.fill(0);
  }

  /**
   * Заявка на «тычок» мышью.
   *
   * Импульсы НАКАПЛИВАЮТСЯ, а не перекрываются: за один шаг физики мышь
   * успевает прислать несколько событий `pointermove`, и каждое несёт свой
   * кусочек протяжки. Если бы последнее перекрывало предыдущие, толчок
   * зависел бы от частоты событий мыши (у разных устройств она разная), а не
   * от длины протяжки.
   *
   * Накопленный вектор применяется один раз за шаг и ограничивается сверху
   * в `pokeRegion` (см. `MAX_POKE_SPEED`) — иначе долгая протяжка разгоняла
   * систему до нефизических скоростей.
   */
  requestPoke(poke: PokeRequest): void {
    const pending = this.pendingPoke;
    if (pending) {
      pending.dx += poke.dx;
      pending.dy += poke.dy;
      pending.dz += poke.dz;
      // Кисть могла переехать — берём её последнее положение и радиус.
      pending.plane = poke.plane;
      pending.radius = poke.radius;
      pending.strength = poke.strength;
    } else {
      this.pendingPoke = { ...poke };
    }
  }

  /** Применить «тычок» немедленно — нужно тестам, скриптам и работе на паузе. */
  pokeNow(poke: PokeRequest): void {
    pokeRegion(
      this.state,
      poke.plane,
      this.box,
      poke.radius,
      poke.strength,
      poke.dx,
      poke.dy,
      poke.dz,
      this.params.boundary === 'periodic',
    );
  }

  /**
   * Применить накопленный «тычок» сейчас, не дожидаясь шага.
   *
   * Нужно на паузе: шагов нет, а `applyPending` вызывается только из `step`,
   * поэтому без явного сброса протяжка мышью на паузе не давала бы никакого
   * отклика — игрок не увидел бы даже, куда попал.
   */
  flushPoke(): void {
    if (!this.pendingPoke) return;
    const p = this.pendingPoke;
    this.pendingPoke = null;
    this.pokeNow(p);
  }

  /**
   * Инструмент «заморозить»: цилиндр вдоль оси взгляда.
   *
   * Раньше здесь стояла сфера вокруг точки на плоскости экрана. Вместе с
   * кистью это давало один и тот же дефект: доступным оказывался только
   * средний слой частиц (см. `integrator.BrushPlane`).
   */
  freezeRegion(plane: BrushPlane, radius: number): number {
    return freezeRegionOf(
      this.state,
      this.frozen,
      plane,
      this.box,
      radius,
      this.params.boundary === 'periodic',
    );
  }

  /**
   * Ось взгляда по углам камеры, с кэшем.
   *
   * Кисть и проекция обязаны пользоваться ОДНИМ расчётом ориентации: если
   * вывести ось в одном месте, а строки матрицы в другом, они рано или поздно
   * разойдутся, и клик начнёт попадать мимо. Здесь же `sin`/`cos` считаются
   * один раз на смену углов, а не на каждую протяжку мыши.
   */
  viewAxis(yaw: number, pitch: number): ViewAxis {
    const cached = this.axisCache;
    if (cached && cached.yaw === yaw && cached.pitch === pitch) return cached.axis;
    const axis = makeViewAxis(yaw, pitch);
    this.axisCache = { yaw, pitch, axis };
    return axis;
  }

  /* ------------------------------------------------------------------ */
  /* Измерения                                                           */
  /* ------------------------------------------------------------------ */

  /** Последнее измерение: T, энергии, давление. */
  get measurement(): Measurement {
    return this.current;
  }

  /**
   * Число пар в пределах обрезания на последнем шаге — диагностика сетки.
   */
  get pairCount(): number {
    return this.stats.pairs;
  }

  /**
   * Вмещает ли ячейка текущей сетки радиус поиска.
   *
   * Открыто наружу для диагностики и тестов: если `false`, мир считает силы
   * прямым перебором, и это НЕ ошибка, а правильное поведение (см.
   * `gridTooCoarse`). Но знать об этом нужно: на такой системе цена шага
   * квадратична по N.
   */
  get gridIsSafe(): boolean {
    return !this.gridTooCoarse;
  }

  /** Используется ли список соседей Верле (то есть работает ли «кожа»). */
  get usingVerletList(): boolean {
    return !this.gridTooCoarse;
  }

  /**
   * Сколько частиц упёрлось в предел устойчивости на последнем шаге.
   *
   * Открыто наружу, чтобы интерфейс и проверки могли отличить «система
   * действительно горячая» от «система улетела и её удерживает ограничитель».
   */
  get speedClampedCount(): number {
    return this.clampedLastStep;
  }

  /**
   * Статистика списка соседей.
   *
   * Нужна, чтобы видеть эффект «кожи»: сколько шагов живёт список между
   * перестроениями и сколько пар в нём лежит. Если `age` стабильно равен 0,
   * кожа слишком тонкая и построение списка не окупается.
   */
  get neighbourStats(): { age: number; rebuilt: boolean; rebuilds: number; pairs: number } {
    return {
      age: this.listAge,
      rebuilt: this.listRebuilt,
      rebuilds: this.listRebuilds,
      pairs: this.verlet.pairCount,
    };
  }

  /** Полная потенциальная энергия. */
  get potentialEnergy(): number {
    return this.stats.potential;
  }

  /** Текущий вириал. */
  get currentVirial(): number {
    return this.stats.virial;
  }

  /** Средняя потенциальная энергия на частицу. */
  get potentialPerParticle(): number {
    const n = Math.max(1, aliveCount(this.state));
    return this.stats.potential / n;
  }

  /** Готовая функция g(r). */
  radialDistribution(): { r: Float64Array; g: Float64Array } {
    return this.radial.result(this.box);
  }

  /**
   * Объём ящика. Считается один раз при смене геометрии, а не в каждом
   * измерении: `box³` в горячем пути — лишнее умножение на каждом шаге.
   */
  get volume(): number {
    return this.box * this.box * this.box;
  }

  /**
   * Значения для раскраски частиц.
   *
   * Вынесено из рендера: величина зависит от физики (скорость, локальная
   * плотность, смещение), и её нужно проверять тестами без графики.
   *
   * Внимание на длины массивов. `out.set(source)` требует, чтобы источник был
   * НЕ ДЛИННЕЕ приёмника, и падает с `RangeError`, если это не так. Число
   * частиц меняется при resize, и кэши могут оказаться длиннее текущего
   * состояния — поэтому копируем по минимуму длин, а не «как получится».
   */
  colorValues(mode: ColorMode): { values: Float64Array; min: number; max: number } {
    const n = this.state.count;
    const out = new Float64Array(n);
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;

    /** Копирование с учётом возможного расхождения длин. */
    const copyFrom = (source: Float64Array): void => {
      const take = Math.min(n, source.length);
      for (let i = 0; i < take; i++) out[i] = source[i];
    };

    switch (mode) {
      case 'density':
        copyFrom(this.state.neighbours);
        break;
      case 'travel':
        // Раскраска «Смещение»: берём модуль смещения от исходного места,
        // а не накопленный путь. У кристалла смещение остаётся порядка 0.1σ
        // сколько угодно долго, у жидкости растёт — по картинке сразу видно
        // разницу, тогда как путь у колеблющейся частицы тоже набегает.
        copyFrom(this.state.displacement);
        break;
      case 'plain':
        out.fill(0.5);
        min = 0;
        max = 1;
        break;
      case 'speed':
      default:
        copyFrom(this.state.speed);
        break;
    }

    if (mode !== 'plain') {
      for (let i = 0; i < n; i++) {
        if (this.state.alive[i] === 0) continue;
        const v = out[i];
        if (!Number.isFinite(v)) continue;
        if (v < min) min = v;
        if (v > max) max = v;
      }
      // Верхняя граница шкалы — квантиль, а не абсолютный максимум.
      //
      // ─── Почему нельзя брать просто max ────────────────────────────────
      //
      // Достаточно ОДНОЙ частицы с аномальной скоростью, чтобы весь диапазон
      // шкалы схлопнулся: max становится 10²³, а все остальные получают
      // t = (v − min)/(max − min) ≈ 1e−24, то есть одинаковый «медленный»
      // цвет. Измерено: при выбросе 100 % частиц получали t < 0.05, и картинка
      // переставала меняться — ровно то, что видно как «частицы не меняют
      // цвет». Именно так выглядит начало численного разлёта.
      //
      // 0.995 отсекает верхние 0.5 % значений: одиночный выброс больше не
      // управляет всей палитрой, а физически осмысленный разброс (газ, где
      // быстрых частиц много) сохраняется — квантиль по построению устойчив
      // к выбросам, но не «зажимает» широкое распределение.
      if (Number.isFinite(max) && Number.isFinite(min) && max > min) {
        max = quantileOf(out, n, this.state.alive, 0.995, min, max);
      }
    }
    if (!Number.isFinite(min) || !Number.isFinite(max)) {
      min = 0;
      max = 1;
    }
    if (max - min < 1e-9) max = min + 1e-9;
    return { values: out, min, max };
  }

  /**
   * Проекция частиц на плоскость экрана.
   *
   * Симуляция трёхмерная, а экран плоский, поэтому рендер поворачивает
   * систему на углы `yaw` и `pitch` и строит две координаты. Делается это
   * здесь, а не в рендере: проекция — часть модели, её проверяют тесты,
   * и она нужна одновременно и отрисовке, и попаданию мышью по частицам.
   *
   * При периодических границах частицы, «выглядывающие» за грань ящика,
   * дублируются: иначе кристалл выглядел бы рваным на краях.
   */
  project(
    yaw: number,
    pitch: number,
    out: Float32Array,
  ): void {
    const cosY = Math.cos(yaw);
    const sinY = Math.sin(yaw);
    const cosP = Math.cos(pitch);
    const sinP = Math.sin(pitch);
    const center = this.box * 0.5;
    const x = this.state.x;
    const y = this.state.y;
    const z = this.state.z;
    for (let i = 0; i < this.state.count; i++) {
      const ax = x[i] - center;
      const ay = y[i] - center;
      const az = z[i] - center;
      const rx = ax * cosY - az * sinY;
      const rz = ax * sinY + az * cosY;
      const ry = ay * cosP - rz * sinP;
      out[i * 3] = rx;
      out[i * 3 + 1] = ry;
      out[i * 3 + 2] = ay * sinP + rz * cosP;
    }
  }
}