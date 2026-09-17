/**
 * Самодиффузия: коэффициент D по среднеквадратичному смещению (MSD).
 *
 * ─── Зачем это измерение ──────────────────────────────────────────────────
 *
 * Подвижность по смещению (`Measurement.mobileFraction`) отвечает на вопрос
 * «кто уехал далеко», но ничего не говорит о том, КАК быстро частицы блуждают.
 * Коэффициент самодиффузии D — количественный признак фазы: у кристалла
 * частица колеблется вокруг узла, смещение остаётся порядка 0.1σ сколько
 * угодно долго, и D = 0. У жидкости смещение растёт линейно по времени, и
 * D порядка 0.1 в приведённых единицах. Именно D, а не «высота пика g(r)»,
 * отличает кристалл от жидкости при взгляде на одну и ту же картинку.
 *
 * ─── Соотношение Эйнштейна ────────────────────────────────────────────────
 *
 * Для броуновского блуждания в d-мерном пространстве средний квадрат
 * смещения растёт линейно по времени:
 *
 *   MSD(t) = ⟨|r(t) − r(0)|²⟩ = 2·d·D·t.
 *
 * В трёхмерном пространстве d = 3, то есть MSD(t) = 6·D·t. Отсюда и
 * множитель 1/6 при переходе от наклона к коэффициенту:
 *
 *   D = (1/6)·dMSD/dt.
 *
 * Перепутать множитель легко (2 вместо 6, или наоборот), а ошибка выходит
 * ровно втрое — при этом кривая MSD выглядит совершенно правильно.
 *
 * ─── Почему не одно начало отсчёта, а много ───────────────────────────────
 *
 * MSD — это среднее по ансамблю. Одна траектория из N частиц даёт всего N
 * слагаемых: при N = 500 относительная ошибка среднего ~1/√500 ≈ 4 %, а на
 * больших лагах частиц «с историей» ещё меньше. Если брать начало отсчёта
 * не только в момент 0, а на каждом кадре статистики, число слагаемых
 * умножается на число начал, и дисперсия оценки падает во столько же раз.
 * Физически это законно: система в равновесии стационарна (эргодичность),
 * поэтому ⟨|r(t₀+τ) − r(t₀)|²⟩ не зависит от t₀.
 *
 * ─── Почему координаты копируются ─────────────────────────────────────────
 *
 * Начало отсчёта обязано «застыть»: частицы продолжают двигаться, и ссылка на
 * живой массив `state.x` через шаг показала бы нулевое смещение. Поэтому
 * координаты начала копируются в собственные буферы.
 *
 * ─── Почему минимальный образ обязателен ──────────────────────────────────
 *
 * Координаты лежат в [0, L) — это инвариант периодических границ. Частица,
 * перешедшая через грань ящика, «телепортируется» из 0.01 в L−0.01, и
 * наивная разность дала бы смещение в целый ящик вместо 0.02σ. Минимальный
 * образ возвращает физически верное смещение: dx −= L·round(dx/L), то есть
 * то же самое, что и в `measure.ts`.
 */

import type { ParticleState } from './types.js';

/** Ёмкость хранилища начал отсчёта — верхняя граница по числу штук. */
const MAX_ORIGINS = 512;
/**
 * Бюджет памяти на эталонные координаты (байт).
 *
 * Каждое начало хранит 3·N чисел по 8 байт. При N = 20 000 и 512 началах это
 * 245 МБ — недопустимо много. Поэтому ёмкость дополнительно ограничивается
 * сверху по памяти: на больших системах начал будет меньше, но каждое из них
 * содержит больше частиц, и статистика всё равно набирается.
 */
const MAX_ORIGIN_BYTES = 32 * 1024 * 1024;

/** Кривая MSD: лаг, средний квадрат смещения и число слагаемых в бине. */
export interface MsdCurve {
  /** Время лага в единицах τ (нижняя граница бина: bin·width). */
  lag: Float64Array;
  /** MSD(лаг) в единицах σ². */
  msd: Float64Array;
  /**
   * Сколько слагаемых (пар «начало × частица») усреднено в бине.
   * Ноль означает «данных нет»: соответствующая точка MSD равна нулю и
   * в подгонку не попадает.
   */
  counts: Int32Array;
}

/** Результат оценки коэффициента самодиффузии. */
export interface DiffusionResult {
  /** D в приведённых единицах (σ²/τ). Ноль, если данных мало. */
  D: number;
  /** Коэффициент детерминации линейной подгонки MSD(лаг). */
  r2: number;
  /** Границы отрезка подгонки по времени: [начало, конец] в τ. */
  lagRange: [number, number];
}

/** Прямая наименьших квадратов y = a + b·x и её коэффициент детерминации. */
function linearFit(x: Float64Array, y: Float64Array, index: Int32Array): { slope: number; r2: number } {
  const n = index.length;
  if (n < 3) return { slope: 0, r2: 0 };

  let sx = 0;
  let sy = 0;
  for (let k = 0; k < n; k++) {
    sx += x[index[k]];
    sy += y[index[k]];
  }
  const mx = sx / n;
  const my = sy / n;

  let sxx = 0;
  let sxy = 0;
  for (let k = 0; k < n; k++) {
    const dx = x[index[k]] - mx;
    sxx += dx * dx;
    sxy += dx * (y[index[k]] - my);
  }
  // Все точки в одной абсциссе — наклон не определён, а не «бесконечность».
  if (sxx <= 0) return { slope: 0, r2: 0 };
  const slope = sxy / sxx;
  const intercept = my - slope * mx;

  let ssRes = 0;
  let ssTot = 0;
  for (let k = 0; k < n; k++) {
    const xi = x[index[k]];
    const yi = y[index[k]];
    const model = intercept + slope * xi;
    ssRes += (yi - model) * (yi - model);
    ssTot += (yi - my) * (yi - my);
  }
  // ssTot = 0 означает идеально горизонтальную кривую: у неё нет разброса,
  // который подгонка могла бы объяснить, поэтому r² не определён.
  const r2 = ssTot > 0 ? Math.max(0, 1 - ssRes / ssTot) : 0;
  return { slope, r2 };
}

/**
 * Накопитель MSD с усреднением по множеству начал отсчёта.
 *
 * Типовой сценарий использования:
 *
 *   const msd = new MeanSquareDisplacement(40, 10);
 *   msd.prepare(world.state.count);
 *   for (шагов симуляции) {
 *     if (пора снять кадр) {
 *       msd.addOrigin(world.state, world.box);   // новое начало
 *       msd.sample(world.state, world.box, true, world.time);
 *     }
 *   }
 *   const { D, r2 } = msd.diffusion();
 */
export class MeanSquareDisplacement {
  /** Число временных бинов (лаг).
   *
   * Начало отсчёта, добавленное на каждом кадре статистики, «работает» до
   * лага `maxLag`, после чего становится бесполезным и выбрасывается. Поэтому
   * число живых начал определяется частотой снятия кадров, а не длиной
   * прогона: длинная симуляция не «съедает» память.
   */
  readonly lags: number;
  /** Максимальное время лага в τ. */
  readonly maxLag: number;
  /** Ширина одного бина по времени: maxLag / lags. */
  readonly width: number;

  /** Число частиц, под которое выделены буферы. */
  private count = 0;
  /** Сколько начал отсчёта помещается сейчас. */
  private capacity = 0;
  /** Сколько начал отсчёта сейчас живо. */
  private origins = 0;

  /** Эталонные координаты начал: плоский массив capacity × count. */
  private refX = new Float64Array(0);
  private refY = new Float64Array(0);
  private refZ = new Float64Array(0);
  /**
   * Время добавления начала отсчёта (в τ).
   *
   * У `addOrigin` нет аргумента времени, поэтому моментом начала считается
   * время последнего снятого кадра (`lastTime`). При обычном порядке
   * «addOrigin → sample(t)` это даёт прошедшее время 0 и MSD(0) = 0: кадр
   * снимается сразу после запоминания координат.
   */
  private originTime = new Float64Array(0);

  /** Сумма квадратов смещений по бинам. */
  private readonly sums: Float64Array;
  /** Число слагаемых по бинам. */
  private readonly counts: Int32Array;

  /** Сколько кадров было снято — диагностика. */
  private frames = 0;
  /** Время последнего кадра: по нему отсеиваются мёртвые начала. */
  private lastTime = 0;

  /**
   * @param lags   число бинов по времени (по умолчанию 40)
   * @param maxLag максимальный лаг в τ (по умолчанию 10)
   */
  constructor(lags = 40, maxLag = 10) {
    this.lags = Math.max(1, Math.floor(lags));
    // Неположительный или нечисловой лаг не имеет физического смысла и вёл бы
    // к делению на ноль; подставляем разумное умолчание.
    this.maxLag = Number.isFinite(maxLag) && maxLag > 0 ? maxLag : 10;
    this.width = this.maxLag / this.lags;
    this.sums = new Float64Array(this.lags);
    this.counts = new Int32Array(this.lags);
  }

  /** Число живых начал отсчёта. */
  get originCount(): number {
    return this.origins;
  }

  /** Число снятых кадров статистики. */
  get sampleCount(): number {
    return this.frames;
  }

  /** Число частиц, под которое выделены буферы. */
  get particleCount(): number {
    return this.count;
  }

  /**
   * Выделение буферов под эталонные координаты.
   *
   * Вызывается при старте измерения и при смене числа частиц. Накопленная
   * статистика при этом НЕ стирается: MSD — среднее на частицу, и добавление
   * кадров с другим N не портит уже усреднённые бины (счётчики `counts`
   * взвешивают слагаемые честно). Начала отсчёта сбрасываются: их координаты
   * относились к прежнему набору частиц.
   */
  prepare(count: number): void {
    const n = Math.max(0, Math.floor(count));
    this.count = n;
    this.origins = 0;

    if (n === 0) {
      this.capacity = 0;
      this.refX = new Float64Array(0);
      this.refY = new Float64Array(0);
      this.refZ = new Float64Array(0);
      this.originTime = new Float64Array(0);
      return;
    }

    // Каждое начало стоит 3·N чисел по 8 байт (24·N байт).
    const byMemory = Math.floor(MAX_ORIGIN_BYTES / (n * 24));
    this.capacity = Math.max(8, Math.min(MAX_ORIGINS, byMemory));
    this.refX = new Float64Array(this.capacity * n);
    this.refY = new Float64Array(this.capacity * n);
    this.refZ = new Float64Array(this.capacity * n);
    this.originTime = new Float64Array(this.capacity);
  }

  /**
   * Запомнить текущие координаты как новое начало отсчёта.
   *
   * Координаты КОПИРУЮТСЯ: массив `state.x` продолжает меняться на каждом
   * шаге, и ссылка на него дала бы нулевое смещение для всех начал.
   *
   * `box` в подписи сохранён ради единообразия с `sample`, но здесь не нужен:
   * координаты уже лежат в [0, L), а минимальный образ применяется в момент
   * сравнения, а не в момент запоминания.
   */
  addOrigin(state: ParticleState, _box: number): void {
    const n = Math.max(0, state.count);
    if (n !== this.count) this.prepare(n);
    if (n === 0) return;

    if (this.origins === this.capacity) {
      // Все места заняты. Сначала пробуем убрать отжившие начала (старше
      // рабочего окна) — на стабильной частоте кадров этого достаточно.
      this.retire(this.lastTime);
      if (this.origins === this.capacity) {
        // Память под начала ограничена, а кадры идут чаще, чем нужно для
        // полного окна. Сохраняем СВЕЖИЕ начала: именно они дают ещё не
        // набранные большие лаги, тогда как старые повторяют те же данные.
        // Новое начало при этом ставится на последнее место (см. ниже), а
        // освободившийся хвост переиспользуется — так массив начал медленно
        // «проворачивается» вперёд.
        const drop = Math.max(1, this.capacity >> 1);
        const keep = this.capacity - drop;
        if (n > 0) {
          const from = drop * n;
          const to = 0;
          const len = (keep - 1) * n;
          if (len > 0) {
            this.refX.copyWithin(to, from, from + len);
            this.refY.copyWithin(to, from, from + len);
            this.refZ.copyWithin(to, from, from + len);
          }
        }
        this.originTime.copyWithin(0, drop, drop + keep - 1);
        this.origins = keep - 1;
      }
    }

    const base = this.origins * n;
    const x = state.x;
    const y = state.y;
    const z = state.z;
    for (let i = 0; i < n; i++) {
      this.refX[base + i] = x[i];
      this.refY[base + i] = y[i];
      this.refZ[base + i] = z[i];
    }
    this.originTime[this.origins] = this.lastTime;
    this.origins++;
  }

  /**
   * Накопить смещения всех живых начал на момент времени `time`.
   *
   * Каждое начало попадает ровно в один бин — соответствующий прошедшему
   * времени. Смещение считается с минимальным образом, потому что координаты
   * лежат в [0, L) и частица, перешедшая через грань, иначе «прыгнула» бы на
   * целый ящик.
   *
   * @param periodic применять ли минимальный образ (для открытого ящика — нет)
   * @param time     текущее время симуляции в τ
   */
  sample(state: ParticleState, box: number, periodic: boolean, time: number): void {
    if (state.count !== this.count) this.prepare(state.count);
    this.lastTime = time;
    this.retire(time);

    const n = this.count;
    if (n === 0 || this.origins === 0) return;

    const half = box * 0.5;
    const width = this.width;
    const lags = this.lags;
    const x = state.x;
    const y = state.y;
    const z = state.z;
    const alive = state.alive;

    // Бин считается по НИЖНЕЙ границе интервала: кадр, снятый ровно в момент
    // начала отсчёта, попадает в бин 0, где MSD обязана быть нулём. Верхняя
    // граница (центр бина) дала бы систематически заниженный бин 0 и заметно
    // испортила бы именно раннюю часть кривой.
    for (let o = 0; o < this.origins; o++) {
      const elapsed = time - this.originTime[o];
      if (!(elapsed >= 0)) continue;
      const bin = Math.floor(elapsed / width);
      if (bin >= lags) continue;

      const base = o * n;
      const refX = this.refX;
      const refY = this.refY;
      const refZ = this.refZ;
      let sum = 0;
      let counted = 0;
      for (let i = 0; i < n; i++) {
        if (alive[i] === 0) continue;
        let dx = x[i] - refX[base + i];
        let dy = y[i] - refY[base + i];
        let dz = z[i] - refZ[base + i];
        if (periodic) {
          if (dx > half) dx -= box;
          else if (dx < -half) dx += box;
          if (dy > half) dy -= box;
          else if (dy < -half) dy += box;
          if (dz > half) dz -= box;
          else if (dz < -half) dz += box;
        }
        sum += dx * dx + dy * dy + dz * dz;
        counted++;
      }
      // Прибавляем к бину один раз на начало: запись в массив в горячем цикле
      // по частицам обошлась бы заметно дороже.
      this.sums[bin] += sum;
      this.counts[bin] += counted;
    }
    this.frames++;
  }

  /**
   * Отбросить начала, вышедшие за пределы рабочего окна.
   *
   * Начало старше `maxLag` уже не даст ни одного нового бина, но продолжало бы
   * занимать память и обходиться в каждом кадре. Живые начала сдвигаются к
   * началу буфера (copyWithin из большего индекса в меньший безопасен).
   */
  private retire(now: number): void {
    const limit = this.maxLag + this.width;
    const n = this.count;
    let live = 0;
    for (let o = 0; o < this.origins; o++) {
      if (now - this.originTime[o] > limit) continue;
      if (live !== o) {
        this.originTime[live] = this.originTime[o];
        if (n > 0) {
          const from = o * n;
          const to = live * n;
          this.refX.copyWithin(to, from, from + n);
          this.refY.copyWithin(to, from, from + n);
          this.refZ.copyWithin(to, from, from + n);
        }
      }
      live++;
    }
    this.origins = live;
  }

  /** Готовая кривая MSD. */
  result(): MsdCurve {
    const lags = this.lags;
    const lag = new Float64Array(lags);
    const msd = new Float64Array(lags);
    for (let k = 0; k < lags; k++) {
      lag[k] = k * this.width;
      // Пустой бин даёт ноль, а не NaN: «данных нет» и «смещение ноль» —
      // разные вещи, но и то и другое не должно ломать график и подгонку.
      msd[k] = this.counts[k] > 0 ? this.sums[k] / this.counts[k] : 0;
    }
    return { lag, msd, counts: Int32Array.from(this.counts) };
  }

  /**
   * Коэффициент самодиффузии D по наклону линейного участка MSD(лаг).
   *
   * ─── Почему 1/6 ─────────────────────────────────────────────────────────
   *
   * MSD(t) = 6·D·t в трёхмерном пространстве (соотношение Эйнштейна при d = 3),
   * значит D = наклон / 6.
   *
   * ─── Почему отрезок 20 %…80 % ───────────────────────────────────────────
   *
   * На самых малых лагах частица ещё летит баллистически (MSD ∝ t²), и
   * «наклон» там занижает D. На самых больших лагах сказывается и шум, и
   * асимметрия статистики: начал, доживших до конца окна, меньше всего, да и
   * каждая ошибка в одном длинном смещении весит больше. Середина кривой —
   * компромисс: режим уже диффузионный, а статистика ещё богатая.
   *
   * Отрицательный наклон — это шум, а не «отрицательная диффузия»: физически
   * осмысленный D неотрицателен, поэтому он ограничен снизу нулём.
   */
  diffusion(): DiffusionResult {
    const { lag, msd, counts } = this.result();
    const last = this.lags - 1;
    const from = Math.floor(0.2 * last);
    const to = Math.ceil(0.8 * last);

    // В подгонку берём только бины с данными: пустые бины — это нули,
    // они бы «притянули» наклон к нулю и испортили r².
    const index: number[] = [];
    for (let k = from; k <= to; k++) if (counts[k] > 0) index.push(k);
    if (index.length < 3) return { D: 0, r2: 0, lagRange: [lag[from], lag[to]] };

    const idx = Int32Array.from(index);
    const { slope, r2 } = linearFit(lag, msd, idx);
    const D = slope > 0 ? slope / 6 : 0;
    return { D, r2, lagRange: [lag[index[0]], lag[index[index.length - 1]]] };
  }

  /** Полный сброс: и начала, и накопленная статистика. */
  reset(): void {
    this.sums.fill(0);
    this.counts.fill(0);
    this.origins = 0;
    this.frames = 0;
    this.lastTime = 0;
  }
}
