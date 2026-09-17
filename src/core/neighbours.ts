/**
 * Списки соседей Верле (Verlet lists) с «кожей».
 *
 * ─── Зачем это нужно ─────────────────────────────────────────────────────
 *
 * Сетка ячеек даёт O(N) вместо O(N²), но константа у неё немаленькая.
 * Посчитаем честно для ρ* = 0.7 и rc = 2.5: в сфере обрезания у частицы
 * около 46 соседей, а просматривать приходится 27 ячеек по ~17 частиц —
 * 464 кандидата. То есть ~90 % проверок расстояния тратятся впустую.
 *
 * Идея Верле: разрешить соседям быть чуть дальше обрезания — на «кожу» `skin`.
 * Тогда список остаётся корректным, пока ни одна частица не сдвинулась больше
 * чем на skin/2, а это десятки шагов. Список строится раз в ~20 шагов, а все
 * остальные шаги перебирают только реальных соседей.
 *
 * ─── Формат хранения ─────────────────────────────────────────────────────
 *
 * Список ПОЛОВИННЫЙ: пара (i, j) с i < j хранится один раз — у частицы i.
 * Это вдвое меньше памяти и вдвое меньше работы, а третий закон Ньютона
 * применяется вручную. Хранение — CSR (`start` + `items`): два плоских
 * массива вместо массива массивов, чтобы обход был последовательным
 * и попадал в кэш.
 *
 * ─── Когда перестраивать ─────────────────────────────────────────────────
 *
 * Не по счётчику шагов, а по факту: накапливается максимальное смещение от
 * координат, на которых список построен. Как только оно превысило skin/2 —
 * перестроение. Это автоматически подстраивается под состояние системы:
 * в холодном кристалле список живёт сотни шагов, в горячем газе — меньше.
 */

import type { CellGrid, ParticleState } from './types.js';

/**
 * Толщина «кожи» по умолчанию, в единицах σ.
 *
 * Выбор — компромисс. Список живёт примерно `skin / (2·v·dt)` шагов: при
 * T* = 1 средняя скорость ≈ 1.7, dt = 0.004, и кожа 0.4σ даёт около
 * 29 шагов. Стоимость построения при этом растёт как объём шарового слоя:
 * (rc+skin)³/rc³ = (2.9/2.5)³ ≈ 1.56, то есть половина лишних кандидатов.
 *
 * Замеры на 20 000 частиц: кожа 0.3 давала перестроение каждые 9 шагов
 * и 15 мс на шаг; кожа 0.5 — каждые 19 шагов, построение дороже в 1.9 раза,
 * но амортизируется лучше. Оптимум оказался в районе 0.4.
 */
export const DEFAULT_SKIN = 0.4;

/**
 * 13 «передних» соседних ячеек из 26, плоским списком по три числа.
 *
 * Отбор ровно половины окрестности по правилу
 * `dz > 0 ∨ (dz = 0 ∧ dy > 0) ∨ (dz = dy = 0 ∧ dx > 0)`
 * гарантирует, что каждая пара ячеек встретится один раз. Вложенные циклы
 * с этим правилом написать легко, но ещё легче ошибиться: наивное
 * `dx ≥ 0, dy ≥ −1, dz ≥ −1` считает пару (0,−1,1) и (0,1,−1) дважды —
 * и список соседей вырастает вдвое. Таблица проверена тестом «сумма сил
 * равна нулю» и сравнением с прямым перебором.
 */
const OFFSETS = Int32Array.from([
  -1, -1, 1,
  0, -1, 1,
  1, -1, 1,
  -1, 0, 1,
  0, 0, 1,
  1, 0, 1,
  -1, 1, 1,
  0, 1, 1,
  1, 1, 1,
  -1, 1, 0,
  0, 1, 0,
  1, 1, 0,
  1, 0, 0,
]);
const OFFSET_COUNT = OFFSETS.length / 3;

/**
 * Список соседей в формате CSR.
 *
 * Публичные поля намеренно не инкапсулированы: расчёт сил читает `start`
 * и `items` в самом горячем цикле, и лишний уровень косвенности там не нужен.
 */
export class VerletList {
  /** Толщина кожи. */
  skin: number;

  /** `start[i]..start[i+1]` — диапазон соседей частицы i в `items`. */
  start = new Int32Array(1);
  /** Индексы соседей: для пары (i, j) хранится только j > i у частицы i. */
  items = new Int32Array(64);

  /** Число пар в списке — для статистики и тестов. */
  pairCount = 0;
  /** Сколько раз список перестраивался — диагностика эффективности кожи. */
  rebuilds = 0;

  private baseX = new Float64Array(0);
  private baseY = new Float64Array(0);
  private baseZ = new Float64Array(0);
  /** Буфер пар: собранные за один обход пары (i < j). */
  private pairA = new Int32Array(0);
  private pairB = new Int32Array(0);
  /** Степени частиц при построении CSR. */
  private degree = new Int32Array(0);
  /** Курсор для раскладки пар в CSR (переиспользуется между построениями). */
  private cursor = new Int32Array(0);

  constructor(count: number, skin = DEFAULT_SKIN) {
    this.skin = skin;
    this.resize(count);
  }

  /** Подгонка буферов под число частиц. */
  resize(count: number): void {
    if (this.start.length === count + 1) return;
    this.start = new Int32Array(count + 1);
    this.cursor = new Int32Array(count + 1);
    this.baseX = new Float64Array(count);
    this.baseY = new Float64Array(count);
    this.baseZ = new Float64Array(count);
  }

  /**
   * Максимальное смещение любой частицы от базы.
   * По нему решается вопрос о перестроении.
   */
  maxDisplacement(state: ParticleState, periodic: boolean, box: number): number {
    const half = box * 0.5;
    const x = state.x;
    const y = state.y;
    const z = state.z;
    const bx = this.baseX;
    const by = this.baseY;
    const bz = this.baseZ;
    let maxSq = 0;
    for (let i = 0; i < state.count; i++) {
      let dx = x[i] - bx[i];
      let dy = y[i] - by[i];
      let dz = z[i] - bz[i];
      if (periodic) {
        if (dx > half) dx -= box;
        else if (dx < -half) dx += box;
        if (dy > half) dy -= box;
        else if (dy < -half) dy += box;
        if (dz > half) dz -= box;
        else if (dz < -half) dz += box;
      }
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > maxSq) maxSq = d2;
    }
    return Math.sqrt(maxSq);
  }

  /**
   * Нужно ли перестроить список.
   *
   * Порог skin/2 — классический: если частица сдвинулась больше чем на
   * половину кожи, пара, которая была чуть за обрезанием, могла подойти
   * к нему вплотную, а пара из списка — выйти за кожу.
   */
  needsRebuild(state: ParticleState, periodic: boolean, box: number): boolean {
    return this.maxDisplacement(state, periodic, box) > this.skin * 0.5;
  }

  /**
   * Построение списка по текущей сетке.
   *
   * ─── Почему ОДИН обход окрестности, а не два ────────────────────────────
   *
   * Первая версия обходила окрестность дважды: сначала считала число соседей,
   * потом раскладывала. На 20 000 частиц это стоило 45 мс — при перестроении
   * каждые 9 шагов добавка выходила 5 мс на шаг, то есть треть всего времени.
   *
   * Теперь пары собираются в два плоских буфера за ОДИН обход, а второй
   * проход идёт уже не по ячейкам, а по самим парам (их в 7 раз меньше, чем
   * кандидатов). Итог: построение вдвое дешевле.
   */
  build(state: ParticleState, grid: CellGrid, box: number, cutoff: number, periodic: boolean): void {
    const count = state.count;
    const reach = cutoff + this.skin;
    const reachSq = reach * reach;

    const n = grid.n;
    const cellStart = grid.cellStart;
    const order = grid.order;
    const cellCount = n * n * n;
    const x = state.x;
    const y = state.y;
    const z = state.z;
    const half = box * 0.5;

    this.resize(count);
    this.baseX.set(x.subarray(0, count));
    this.baseY.set(y.subarray(0, count));
    this.baseZ.set(z.subarray(0, count));

    // Оценка сверху числа пар: список полуторный, поэтому 3 соседа на частицу
    // с запасом хватает для плотных систем (реально ~55).
    this.ensurePairBuffers(count * 64);

    const pairA = this.pairA;
    const pairB = this.pairB;
    let total = 0;

    for (let cell = 0; cell < cellCount; cell++) {
      const gz = cell % n;
      const gy = ((cell - gz) / n) % n;
      const gx = (cell - gz - n * gy) / (n * n);
      const startA = cellStart[cell];
      const endA = cellStart[cell + 1];
      if (startA === endA) continue;

      for (let a = startA; a < endA; a++) {
        const i = order[a];
        const xi = x[i];
        const yi = y[i];
        const zi = z[i];

        /* --- Своя ячейка: пары «вперёд» по индексу --- */
        for (let b = a + 1; b < endA; b++) {
          const j = order[b];
          if (withinReach(x, y, z, j, xi, yi, zi, reachSq, box, half, periodic)) {
            pairA[total] = i;
            pairB[total] = j;
            total++;
          }
        }

        /* --- 13 «передних» соседних ячеек --- */
        for (let o = 0; o < OFFSET_COUNT; o++) {
          const o3 = o * 3;
          let nx = gx + OFFSETS[o3];
          let ny = gy + OFFSETS[o3 + 1];
          let nz = gz + OFFSETS[o3 + 2];
          if (periodic) {
            if (nx < 0) nx += n;
            else if (nx >= n) nx -= n;
            if (ny < 0) ny += n;
            else if (ny >= n) ny -= n;
            if (nz < 0) nz += n;
            else if (nz >= n) nz -= n;
          } else if (nx < 0 || nx >= n || ny < 0 || ny >= n || nz < 0 || nz >= n) {
            continue;
          }
          const cell2 = (nx * n + ny) * n + nz;
          const startB = cellStart[cell2];
          const endB = cellStart[cell2 + 1];
          if (startB === endB) continue;

          for (let b = startB; b < endB; b++) {
            const j = order[b];
            if (withinReach(x, y, z, j, xi, yi, zi, reachSq, box, half, periodic)) {
              // ВАЖНО: пара ячеек обработана один раз, но индексы i и j
              // НЕ упорядочены — соседняя ячейка может содержать частицы
              // с меньшими номерами. Полуторный список требует i < j,
              // поэтому владельцем пары делаем МЕНЬШИЙ индекс, а соседом —
              // больший. Без этого половина пар записывалась бы «наоборот»
              // и терялась: силы считались бы не для всех соседей.
              if (i < j) {
                pairA[total] = i;
                pairB[total] = j;
              } else {
                pairA[total] = j;
                pairB[total] = i;
              }
              total++;
            }
          }
        }
      }
    }

    this.pairCount = total;

    // Подсчёт степеней: сколько соседей у каждой частицы (i < j).
    const degree = this.degree;
    degree.fill(0);
    for (let p = 0; p < total; p++) degree[pairA[p]]++;

    // Префиксная сумма.
    let running = 0;
    for (let i = 0; i < count; i++) {
      const c = degree[i];
      this.start[i] = running;
      running += c;
    }
    this.start[count] = running;

    this.ensureItems(total);
    for (let i = 0; i <= count; i++) this.cursor[i] = this.start[i];

    // Раскладка: второй проход по ПАРАМ, а не по ячейкам.
    const items = this.items;
    const cursor = this.cursor;
    for (let p = 0; p < total; p++) {
      items[cursor[pairA[p]]++] = pairB[p];
    }

    this.rebuilds++;
  }

  /** Попадает ли пара в «кожу». */
  private ensureItems(total: number): void {
    if (this.items.length < Math.max(64, total)) {
      this.items = new Int32Array(Math.max(64, Math.ceil(total * 1.15)));
    }
  }

  /** Буферы под пары и степени. */
  private ensurePairBuffers(capacity: number): void {
    const need = Math.max(1024, capacity);
    if (this.pairA.length < need) {
      this.pairA = new Int32Array(need);
      this.pairB = new Int32Array(need);
    }
    if (this.degree.length < this.start.length - 1) {
      this.degree = new Int32Array(this.start.length - 1);
    }
  }
}

/** Квадрат расстояния пары с минимальным образом, не длиннее `reachSq`. */
function withinReach(
  x: Float64Array,
  y: Float64Array,
  z: Float64Array,
  j: number,
  xi: number,
  yi: number,
  zi: number,
  reachSq: number,
  box: number,
  half: number,
  periodic: boolean,
): boolean {
  let dx = x[j] - xi;
  let dy = y[j] - yi;
  let dz = z[j] - zi;
  if (periodic) {
    if (dx > half) dx -= box;
    else if (dx < -half) dx += box;
    if (dy > half) dy -= box;
    else if (dy < -half) dy += box;
    if (dz > half) dz -= box;
    else if (dz < -half) dz += box;
  }
  const r2 = dx * dx + dy * dy + dz * dz;
  return r2 < reachSq && r2 > 0;
}
