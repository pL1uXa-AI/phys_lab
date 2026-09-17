/**
 * Связи ближних соседей — то, что делает структуру видимой.
 *
 * ─── Зачем это нужно ─────────────────────────────────────────────────────
 *
 * В проекции частицы выглядят одинаковыми кружками, и кристалл, жидкость и
 * газ отличаются только плотностью точек. Глаз не видит ГЛАВНОГО: кто с кем
 * соседствует. Если соединить отрезком каждую пару, попавшую в первый
 * координационный слой, картинка меняется качественно:
 *
 *   - кристалл превращается в правильную решётку (у ГЦК ровно 12 связей
 *     на атом, все одной длины);
 *   - жидкость — в подвижную сетку с постоянно рвущимися связями;
 *   - газ — почти в отсутствие линий: соседей просто нет.
 *
 * Это не украшение, а измеримая величина: среднее число связей на частицу
 * есть координационное число, а разброс длин связей — мера искажения
 * решётки. Обе величины используются интерфейсом и проверяются тестами.
 *
 * ─── Как считается ───────────────────────────────────────────────────────
 *
 * Тем же способом, что и g(r): своя сетка ячеек с размером НЕ МЕНЬШЕ
 * радиуса связи, обход 13 «передних» ячеек плюс своя. Каждая пара попадает
 * в список ровно один раз — это инвариант, который проверяется тестом
 * сравнением с честным перебором.
 *
 * Если ящик настолько мал, что ячейка выходит меньше радиуса связи, сосед
 * окажется «через одну» ячейку и часть пар потеряется МОЛЧА. В этом случае
 * (как и в g(r)) включается честный перебор O(N²).
 */

import { buildGrid, HALF_NEIGHBOUR_OFFSETS } from './grid.js';
import type { CellGrid, ParticleState } from './types.js';

/**
 * Радиус связи по умолчанию, в единицах σ.
 *
 * Минимум потенциала Леннарда-Джонса лежит на 2^(1/6) ≈ 1.122σ, и первый
 * координационный слой в жидкости простирается примерно до 1.4σ. Порог 1.45σ
 * захватывает ровно первую оболочку: у ГЦК-кристалла при ρ* = 0.95 это даёт
 * ровно 12 связей на атом — то самое координационное число.
 */
export const DEFAULT_BOND_RADIUS = 1.45;

/** Во сколько раз радиус связи должен превышать минимум потенциала. */
const EQUILIBRIUM = 1.122462048309373; // 2^(1/6)

/** Максимум связей, которые вообще рисуются: выше — визуальный шум и лишняя работа. */
const MAX_PAIRS = 300000;

/**
 * Сеть связей: какие пары частиц находятся ближе радиуса связи.
 *
 * Пара хранится один раз: `a[k] < b[k]`. Это позволяет рисовать каждую связь
 * ровно одним отрезком и честно сравнивать число связей с перебором.
 */
export class BondNetwork {
  /** Радиус связи в единицах σ. */
  cutoff: number;

  /** Первые частицы пар. */
  readonly a = new Int32Array(MAX_PAIRS);
  /** Вторые частицы пар (всегда больше первой). */
  readonly b = new Int32Array(MAX_PAIRS);
  /** Длина связи — нужна для раскраски по деформации. */
  readonly length = new Float32Array(MAX_PAIRS);
  /**
   * Вектор от `a[k]` к `b[k]` с МИНИМАЛЬНЫМ ОБРАЗОМ.
   *
   * Хранится затем, чтобы отрисовка не строила связь «напрямую» между
   * координатами частиц: у периодических границ частица и её сосед могут
   * стоять у противоположных стенок, и прямая линия пересекла бы весь ящик.
   * Минимальный образ даёт правильное направление — к ближайшему изображению
   * соседа.
   */
  readonly dx = new Float32Array(MAX_PAIRS);
  readonly dy = new Float32Array(MAX_PAIRS);
  readonly dz = new Float32Array(MAX_PAIRS);

  /** Сколько пар в списке на последнем построении. */
  pairCount = 0;
  /** Упёрлись ли в потолок `MAX_PAIRS` — диагностика для интерфейса. */
  truncated = false;

  private grid: CellGrid | null = null;

  constructor(cutoff = DEFAULT_BOND_RADIUS) {
    this.cutoff = cutoff;
  }

  /**
   * Смена радиуса связи. Сетка пересобирается при следующем построении:
   * её размер жёстко связан с радиусом, и оставлять старую нельзя — соседи
   * начнут теряться молча.
   */
  setCutoff(cutoff: number): void {
    if (Math.abs(cutoff - this.cutoff) < 1e-9) return;
    this.cutoff = cutoff;
    this.grid = null;
  }

  /** Сетка под текущий ящик; пересоздаётся только при смене геометрии. */
  private ensureGrid(count: number, box: number): CellGrid {
    const size = this.cutoff;
    const n = Math.max(3, Math.floor(box / size));
    const cells = n * n * n;
    const existing = this.grid;
    if (
      existing &&
      existing.n === n &&
      existing.order.length === count &&
      Math.abs(existing.size - box / n) < 1e-9
    ) {
      return existing;
    }
    const grid: CellGrid = {
      n,
      size: box / n,
      cellStart: new Int32Array(cells + 1),
      order: new Int32Array(count),
      cellIndex: new Int32Array(count),
      counts: new Int32Array(cells),
    };
    this.grid = grid;
    return grid;
  }

  /**
   * Построение списка связей по текущим координатам.
   *
   * @param periodic применять ли минимальный образ (периодические границы)
   */
  build(state: ParticleState, box: number, periodic: boolean): void {
    const count = state.count;
    this.pairCount = 0;
    this.truncated = false;
    if (count < 2) return;

    const grid = this.ensureGrid(count, box);
    // Ячейка обязана вмещать радиус связи. Проверяем ФАКТИЧЕСКИЙ размер,
    // а не число ячеек: в маленьком ящике `max(3, …)` даёт ячейку меньше
    // радиуса, и пары теряются без единого признака ошибки.
    if (grid.size + 1e-9 < this.cutoff) {
      this.buildBruteForce(state, box, periodic);
      return;
    }
    this.buildFromGrid(state, box, periodic, grid);
  }

  /**
   * Обход сетки: своя ячейка плюс 13 «передних».
   *
   * Пара (i, j) обязана храниться один раз у частицы с меньшим индексом.
   * Индексы внутри ячеек не упорядочены, поэтому сравнение индексов
   * обязательно — без него пара (i, j) и (j, i) попадёт в список дважды,
   * и число связей удвоится.
   */
  private buildFromGrid(state: ParticleState, box: number, periodic: boolean, grid: CellGrid): void {
    const n = grid.n;
    const alive = state.alive;
    const cellStart = grid.cellStart;
    const order = grid.order;
    const cellCount = n * n * n;
    const limSq = this.cutoff * this.cutoff;
    const half = box * 0.5;

    buildGrid(state, grid);

    for (let c = 0; c < cellCount; c++) {
      const gz = c % n;
      const gy = ((c - gz) / n) % n;
      const gx = (c - gz - n * gy) / (n * n);
      const startA = cellStart[c];
      const endA = cellStart[c + 1];
      if (startA === endA) continue;

      for (let p = startA; p < endA; p++) {
        const i = order[p];
        if (alive[i] === 0) continue;

        // Своя ячейка: пары «вперёд» по порядку раскладки.
        for (let q = p + 1; q < endA; q++) {
          const j = order[q];
          if (alive[j] === 0) continue;
          if (!this.tryPair(state, i, j, box, half, periodic, limSq)) return;
        }

        for (let o = 0; o < HALF_NEIGHBOUR_OFFSETS.length; o += 3) {
          let nx = gx + HALF_NEIGHBOUR_OFFSETS[o];
          let ny = gy + HALF_NEIGHBOUR_OFFSETS[o + 1];
          let nz = gz + HALF_NEIGHBOUR_OFFSETS[o + 2];
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
          const c2 = (nx * n + ny) * n + nz;
          const startB = cellStart[c2];
          const endB = cellStart[c2 + 1];
          for (let q = startB; q < endB; q++) {
            const j = order[q];
            if (alive[j] === 0) continue;
            // Индексы пришли из разных ячеек и не упорядочены — приводим к i < j.
            const lo = i < j ? i : j;
            const hi = i < j ? j : i;
            if (!this.tryPair(state, lo, hi, box, half, periodic, limSq)) return;
          }
        }
      }
    }
  }

  /** Честный перебор всех пар. Используется на мелких ящиках. */
  private buildBruteForce(state: ParticleState, box: number, periodic: boolean): void {
    const count = state.count;
    const limSq = this.cutoff * this.cutoff;
    const half = box * 0.5;
    const alive = state.alive;

    for (let i = 0; i < count; i++) {
      if (alive[i] === 0) continue;
      for (let j = i + 1; j < count; j++) {
        if (alive[j] === 0) continue;
        if (!this.tryPair(state, i, j, box, half, periodic, limSq)) return;
      }
    }
  }

  /**
   * Проверить пару и, если она ближе радиуса, добавить её в список.
   *
   * Возвращает false, когда буфер пар заполнен: в этом случае обход надо
   * прекратить, иначе счётчик поползёт за границу массива.
   */
  private tryPair(
    state: ParticleState,
    i: number,
    j: number,
    box: number,
    half: number,
    periodic: boolean,
    limSq: number,
  ): boolean {
    const x = state.x;
    const y = state.y;
    const z = state.z;
    let dx = x[j] - x[i];
    let dy = y[j] - y[i];
    let dz = z[j] - z[i];
    if (periodic) {
      if (dx > half) dx -= box;
      else if (dx < -half) dx += box;
      if (dy > half) dy -= box;
      else if (dy < -half) dy += box;
      if (dz > half) dz -= box;
      else if (dz < -half) dz += box;
    }
    const r2 = dx * dx + dy * dy + dz * dz;
    if (r2 >= limSq) return true;
    const k = this.pairCount;
    if (k >= MAX_PAIRS) {
      this.truncated = true;
      return false;
    }
    this.a[k] = i;
    this.b[k] = j;
    this.length[k] = Math.sqrt(r2);
    // Вектор направлен от меньшего индекса к большему — так же, как пара
    // хранится, поэтому отрисовке не нужно ничего пересчитывать.
    this.dx[k] = dx;
    this.dy[k] = dy;
    this.dz[k] = dz;
    this.pairCount = k + 1;
    return true;
  }

  /**
   * Среднее число связей на одну живую частицу — координационное число.
   *
   * Считается по числу КОНЦОВ связей, а не по числу пар: одна связь даёт
   * вклад двум частицам. Для ГЦК-кристалла при радиусе 1.45σ получается
   * ровно 12.
   */
  meanCoordination(state: ParticleState): number {
    let alive = 0;
    for (let i = 0; i < state.count; i++) if (state.alive[i] !== 0) alive++;
    if (alive === 0) return 0;
    return (2 * this.pairCount) / alive;
  }

  /**
   * Разброс длин связей относительно равновесной длины 2^(1/6)σ.
   *
   * Ноль — идеальная решётка, где все связи одной длины. Рост величины
   * означает искажение: тепловое расширение, плавление, дефекты. Это
   * количественная замена фразе «на картинке видно, что решётка поехала».
   */
  lengthSpread(): number {
    const n = this.pairCount;
    if (n === 0) return 0;
    let sum = 0;
    for (let k = 0; k < n; k++) {
      const d = this.length[k] - EQUILIBRIUM;
      sum += d * d;
    }
    return Math.sqrt(sum / n);
  }

  /** Равновесная длина связи (минимум потенциала) — 2^(1/6)σ. */
  static get equilibriumLength(): number {
    return EQUILIBRIUM;
  }
}
