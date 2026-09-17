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

import { computeForcesFromList, type ForceStats } from './forces.js';
import { DEFAULT_SKIN, VerletList } from './neighbours.js';
import { buildGrid, cellSizeFor } from './grid.js';
import {
  applyBerendsen,
  applyFrozenMask,
  applyLangevin,
  applyNoseHoover,
  allocNoseHoover,
  type NoseHooverState,
  drift,
  kick,
  pokeRegion,
  reflectWalls,
  removeEscaped,
  setTemperature,
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

/** Заявка на «тычок» мышью: импульс в сфере. */
export interface PokeRequest {
  x: number;
  y: number;
  z: number;
  dx: number;
  dy: number;
  dz: number;
  radius: number;
  strength: number;
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
    return {
      n,
      size: this.box / n,
      cellStart: new Int32Array(cells + 1),
      order: new Int32Array(this.state.count),
      cellIndex: new Int32Array(this.state.count),
      counts: new Int32Array(cells),
    };
  }

  /**
   * Полный пересчёт: сетка, список соседей, силы.
   * Вызывается после любой смены геометрии или координат «извне».
   */
  private rebuildForces(): void {
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

    // 1. Половина толчка по силам с прошлого шага.
    kick(this.state, half);

    // 2. Термостат: трогает только скорости.
    this.applyThermostat(dt);

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

    // 5. Замороженные частицы снова обнуляются: сначала силе дали
    // подействовать (иначе они «прилипали» бы к соседям), затем вернули
    // строгую неподвижность.
    if (this.hasFrozen()) applyFrozenMask(this.state, this.frozen);

    this.time += dt;
    this.steps++;
    this.current = this.measureNow();
    this.history.push(this.makeSample());
    return this.current;
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
        p.x,
        p.y,
        p.z,
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
   */
  rebuild(kind: LatticeKind, keepTemperature: boolean): void {
    const temperature = keepTemperature ? this.params.temperature : this.params.temperature;
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

  /** Полная остановка: все скорости обнуляются. */
  freezeAll(): void {
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

  /** Заморозить частицы, попавшие в сферу вокруг точки. */
  freezeRegion(cx: number, cy: number, cz: number, radius: number): number {
    const periodic = this.params.boundary === 'periodic';
    let touched = 0;
    for (let i = 0; i < this.state.count; i++) {
      if (this.state.alive[i] === 0) continue;
      let dx = this.state.x[i] - cx;
      let dy = this.state.y[i] - cy;
      let dz = this.state.z[i] - cz;
      if (periodic) {
        dx -= this.box * Math.round(dx / this.box);
        dy -= this.box * Math.round(dy / this.box);
        dz -= this.box * Math.round(dz / this.box);
      }
      if (dx * dx + dy * dy + dz * dz > radius * radius) continue;
      this.frozen[i] = 1;
      this.state.vx[i] = 0;
      this.state.vy[i] = 0;
      this.state.vz[i] = 0;
      touched++;
    }
    return touched;
  }

  /** Снять заморозку со всех. */
  unfreezeAll(): void {
    this.frozen.fill(0);
  }

  /** Заявка на «тычок» мышью: применится на ближайшем шаге. */
  requestPoke(poke: PokeRequest): void {
    this.pendingPoke = poke;
  }

  /** Применить «тычок» немедленно — нужно тестам и скриптам. */
  pokeNow(poke: PokeRequest): void {
    pokeRegion(
      this.state,
      poke.x,
      poke.y,
      poke.z,
      this.box,
      poke.radius,
      poke.strength,
      poke.dx,
      poke.dy,
      poke.dz,
      this.params.boundary === 'periodic',
    );
  }

  /* ------------------------------------------------------------------ */
  /* Измерения                                                           */
  /* ------------------------------------------------------------------ */

  /** Последнее измерение: T, энергии, давление. */
  get measurement(): Measurement {
    return this.current;
  }

  /** Число пар в пределах обрезания на последнем шаге — диагностика сетки. */
  get pairCount(): number {
    return this.stats.pairs;
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
        if (v < min) min = v;
        if (v > max) max = v;
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