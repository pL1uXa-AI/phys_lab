/**
 * Расчёт сил — самый горячий код проекта.
 *
 * ─── Что здесь оптимизировано и почему ───────────────────────────────────
 *
 * 1. **Минимальный образ без деления.** Наивная запись
 *    `dx -= box * Math.round(dx / box)` стоит три деления на каждую пару —
 *    это ~20 тактов каждое. Координаты при периодических границах лежат
 *    в [0, box), поэтому dx ∈ (−box, box) и достаточно ОДНОЙ поправки:
 *
 *        if (dx > half) dx -= box; else if (dx < −half) dx += box;
 *
 * 2. **Периодичность вынесена из цикла.** Проверка `if (periodic)` внутри
 *    обхода 450 000 пар мешает оптимизатору: ветка хоть и предсказуема,
 *    но мешает векторизации и держит лишние значения в регистрах. Есть две
 *    специализированные копии тела цикла — с заворачиванием и без.
 *
 * 3. **Плоские смещения соседних ячеек.** Массив массивов давал три загрузки
 *    из памяти на каждую из 13 ячеек; плоский `Int32Array` с шагом 3 читается
 *    последовательно и попадает в кэш.
 *
 * 4. **Никаких объектов на пару.** Только числа и типизированные массивы.
 *
 * 5. **Проверка обрезания до дорогих операций.** Сначала r², и только если
 *    пара ближе обрезания, считаются степени и сила.
 *
 * 6. **Третий закон вручную.** Каждая пара ячеек обходится один раз, сила
 *    пишется обеим частицам — вдвое меньше работы, чем при обходе каждой
 *    частицей всех соседей.
 *
 * ─── Знак силы (место, где легко ошибиться) ──────────────────────────────
 *
 * Пусть `d = r_j − r_i` — вектор ОТ i К j. Сила, действующая НА i, направлена
 * против d:  F_i = −(F(r)/r)·d,  F_j = +(F(r)/r)·d.
 *
 * Ошибка в знаке не ломает ничего заметно на глаз: система начинает
 * притягиваться там, где должна отталкиваться, и за десятки шагов энергия
 * улетает в 10³⁰. Тесты «на модуль силы» её пропускают, поэтому направление
 * проверяется отдельно — по совпадению с производной энергии и по признаку
 * «частицы не слипаются».
 */

import type { VerletList } from './neighbours.js';
import type { CellGrid, ParticleState } from './types.js';
import { type LjShift, ljForceOverR } from './potential.js';

/**
 * 13 «передних» соседних ячеек из 26, плоским списком по три числа.
 * Половина окрестности выбирается по правилу
 * `dz > 0 ∨ (dz = 0 ∧ dy > 0) ∨ (dz = dy = 0 ∧ dx > 0)` — это 9 + 3 + 1.
 */
const NEIGHBOUR_OFFSETS = Int32Array.from([
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

/** Число смещений (не чисел). */
const OFFSET_COUNT = NEIGHBOUR_OFFSETS.length / 3;

/** Квадрат радиуса, в пределах которого частица считается «соседом». */
const NEIGHBOUR_RADIUS_SQ = 1.4 * 1.4;

/** Сводка по шагу. */
export interface ForceStats {
  /** Полная потенциальная энергия (в единицах ε). */
  potential: number;
  /** Вириал W = Σ F_i·r_i — нужен для давления. */
  virial: number;
  /** Число пар в пределах обрезания — диагностика построения сетки. */
  pairs: number;
}

/**
 * Общая часть: заполнение и подготовка константа.
 * Вынесено, чтобы специализированные варианты не дублировали пролог.
 */
interface ForceContext {
  x: Float64Array;
  y: Float64Array;
  z: Float64Array;
  fx: Float64Array;
  fy: Float64Array;
  fz: Float64Array;
  neighbours: Float64Array;
  n: number;
  cellStart: Int32Array;
  order: Int32Array;
  cellCount: number;
  cutoffSq: number;
  box: number;
  half: number;
  shiftForce: number;
  halfShift: number;
  energyConstant: number;
}

function makeContext(
  state: ParticleState,
  grid: CellGrid,
  box: number,
  cutoff: number,
  shift: LjShift,
): ForceContext {
  state.fx.fill(0);
  state.fy.fill(0);
  state.fz.fill(0);
  return {
    x: state.x,
    y: state.y,
    z: state.z,
    fx: state.fx,
    fy: state.fy,
    fz: state.fz,
    neighbours: state.neighbours,
    n: grid.n,
    cellStart: grid.cellStart,
    order: grid.order,
    cellCount: grid.n * grid.n * grid.n,
    cutoffSq: cutoff * cutoff,
    box,
    half: box * 0.5,
    shiftForce: shift.forceOverR,
    halfShift: 0.5 * shift.forceOverR,
    energyConstant: shift.energy + 0.5 * shift.forceOverR * shift.cutoffSq,
  };
}

/**
 * Силы всех частиц в текущей конфигурации.
 *
 * @param state           состояние; изменяются fx, fy, fz, neighbours
 * @param grid            уже построенная сетка (buildGrid)
 * @param box             длина ящика
 * @param cutoff          радиус обрезания
 * @param shift           постоянные сдвига (ljShift)
 * @param periodic        применять ли минимальный образ
 * @param countNeighbours считать ли локальную плотность
 */
export function computeForces(
  state: ParticleState,
  grid: CellGrid,
  box: number,
  cutoff: number,
  shift: LjShift,
  periodic: boolean,
  countNeighbours = true,
): ForceStats {
  const ctx = makeContext(state, grid, box, cutoff, shift);
  if (periodic) {
    return countNeighbours ? forcesPeriodicNeighbours(ctx) : forcesPeriodic(ctx);
  }
  return countNeighbours ? forcesOpenNeighbours(ctx) : forcesOpen(ctx);
}

/* ===========================================================================
   Специализированные варианты тела цикла
   =========================================================================== */

/** Периодические границы + подсчёт соседей (основной путь для кристаллов). */
function forcesPeriodicNeighbours(c: ForceContext): ForceStats {
  const {
    x, y, z, fx, fy, fz, neighbours, n, cellStart, order, cellCount,
    cutoffSq, box, half, shiftForce, halfShift, energyConstant,
  } = c;
  neighbours.fill(0);

  let potential = 0;
  let virial = 0;
  let pairs = 0;

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
      let fxi = 0;
      let fyi = 0;
      let fzi = 0;

      // Внутри ячейки: пары «вперёд» по индексу.
      for (let b = a + 1; b < endA; b++) {
        const j = order[b];
        let dx = x[j] - xi;
        let dy = y[j] - yi;
        let dz = z[j] - zi;
        if (dx > half) dx -= box;
        else if (dx < -half) dx += box;
        if (dy > half) dy -= box;
        else if (dy < -half) dy += box;
        if (dz > half) dz -= box;
        else if (dz < -half) dz += box;
        const r2 = dx * dx + dy * dy + dz * dz;
        if (r2 >= cutoffSq || r2 === 0) continue;
        const inv2 = 1 / r2;
        const inv6 = inv2 * inv2 * inv2;
        const inv12 = inv6 * inv6;
        const foR = 24 * (2 * inv12 - inv6) * inv2 - shiftForce;
        const rx = foR * dx;
        const ry = foR * dy;
        const rz = foR * dz;
        fxi -= rx;
        fyi -= ry;
        fzi -= rz;
        fx[j] += rx;
        fy[j] += ry;
        fz[j] += rz;
        potential += 4 * (inv12 - inv6) + halfShift * r2 - energyConstant;
        virial += rx * dx + ry * dy + rz * dz;
        pairs++;
        if (r2 < NEIGHBOUR_RADIUS_SQ) {
          neighbours[i]++;
          neighbours[j]++;
        }
      }

      // 13 «передних» соседних ячеек.
      for (let o = 0; o < OFFSET_COUNT; o++) {
        const o3 = o * 3;
        let nx = gx + NEIGHBOUR_OFFSETS[o3];
        let ny = gy + NEIGHBOUR_OFFSETS[o3 + 1];
        let nz = gz + NEIGHBOUR_OFFSETS[o3 + 2];
        if (nx < 0) nx += n;
        else if (nx >= n) nx -= n;
        if (ny < 0) ny += n;
        else if (ny >= n) ny -= n;
        if (nz < 0) nz += n;
        else if (nz >= n) nz -= n;
        const cell2 = (nx * n + ny) * n + nz;
        const startB = cellStart[cell2];
        const endB = cellStart[cell2 + 1];
        if (startB === endB) continue;

        for (let b = startB; b < endB; b++) {
          const j = order[b];
          let dx = x[j] - xi;
          let dy = y[j] - yi;
          let dz = z[j] - zi;
          if (dx > half) dx -= box;
          else if (dx < -half) dx += box;
          if (dy > half) dy -= box;
          else if (dy < -half) dy += box;
          if (dz > half) dz -= box;
          else if (dz < -half) dz += box;
          const r2 = dx * dx + dy * dy + dz * dz;
          if (r2 >= cutoffSq || r2 === 0) continue;
          const inv2 = 1 / r2;
          const inv6 = inv2 * inv2 * inv2;
          const inv12 = inv6 * inv6;
          const foR = 24 * (2 * inv12 - inv6) * inv2 - shiftForce;
          const rx = foR * dx;
          const ry = foR * dy;
          const rz = foR * dz;
          fxi -= rx;
          fyi -= ry;
          fzi -= rz;
          fx[j] += rx;
          fy[j] += ry;
          fz[j] += rz;
          potential += 4 * (inv12 - inv6) + halfShift * r2 - energyConstant;
          virial += rx * dx + ry * dy + rz * dz;
          pairs++;
          if (r2 < NEIGHBOUR_RADIUS_SQ) {
            neighbours[i]++;
            neighbours[j]++;
          }
        }
      }

      fx[i] += fxi;
      fy[i] += fyi;
      fz[i] += fzi;
    }
  }

  return { potential, virial, pairs };
}

/** Периодические границы без подсчёта соседей. */
function forcesPeriodic(c: ForceContext): ForceStats {
  const {
    x, y, z, fx, fy, fz, n, cellStart, order, cellCount,
    cutoffSq, box, half, shiftForce, halfShift, energyConstant,
  } = c;

  let potential = 0;
  let virial = 0;
  let pairs = 0;

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
      let fxi = 0;
      let fyi = 0;
      let fzi = 0;

      for (let b = a + 1; b < endA; b++) {
        const j = order[b];
        let dx = x[j] - xi;
        let dy = y[j] - yi;
        let dz = z[j] - zi;
        if (dx > half) dx -= box;
        else if (dx < -half) dx += box;
        if (dy > half) dy -= box;
        else if (dy < -half) dy += box;
        if (dz > half) dz -= box;
        else if (dz < -half) dz += box;
        const r2 = dx * dx + dy * dy + dz * dz;
        if (r2 >= cutoffSq || r2 === 0) continue;
        const inv2 = 1 / r2;
        const inv6 = inv2 * inv2 * inv2;
        const inv12 = inv6 * inv6;
        const foR = 24 * (2 * inv12 - inv6) * inv2 - shiftForce;
        const rx = foR * dx;
        const ry = foR * dy;
        const rz = foR * dz;
        fxi -= rx;
        fyi -= ry;
        fzi -= rz;
        fx[j] += rx;
        fy[j] += ry;
        fz[j] += rz;
        potential += 4 * (inv12 - inv6) + halfShift * r2 - energyConstant;
        virial += rx * dx + ry * dy + rz * dz;
        pairs++;
      }

      for (let o = 0; o < OFFSET_COUNT; o++) {
        const o3 = o * 3;
        let nx = gx + NEIGHBOUR_OFFSETS[o3];
        let ny = gy + NEIGHBOUR_OFFSETS[o3 + 1];
        let nz = gz + NEIGHBOUR_OFFSETS[o3 + 2];
        if (nx < 0) nx += n;
        else if (nx >= n) nx -= n;
        if (ny < 0) ny += n;
        else if (ny >= n) ny -= n;
        if (nz < 0) nz += n;
        else if (nz >= n) nz -= n;
        const cell2 = (nx * n + ny) * n + nz;
        const startB = cellStart[cell2];
        const endB = cellStart[cell2 + 1];
        if (startB === endB) continue;

        for (let b = startB; b < endB; b++) {
          const j = order[b];
          let dx = x[j] - xi;
          let dy = y[j] - yi;
          let dz = z[j] - zi;
          if (dx > half) dx -= box;
          else if (dx < -half) dx += box;
          if (dy > half) dy -= box;
          else if (dy < -half) dy += box;
          if (dz > half) dz -= box;
          else if (dz < -half) dz += box;
          const r2 = dx * dx + dy * dy + dz * dz;
          if (r2 >= cutoffSq || r2 === 0) continue;
          const inv2 = 1 / r2;
          const inv6 = inv2 * inv2 * inv2;
          const inv12 = inv6 * inv6;
          const foR = 24 * (2 * inv12 - inv6) * inv2 - shiftForce;
          const rx = foR * dx;
          const ry = foR * dy;
          const rz = foR * dz;
          fxi -= rx;
          fyi -= ry;
          fzi -= rz;
          fx[j] += rx;
          fy[j] += ry;
          fz[j] += rz;
          potential += 4 * (inv12 - inv6) + halfShift * r2 - energyConstant;
          virial += rx * dx + ry * dy + rz * dz;
          pairs++;
        }
      }

      fx[i] += fxi;
      fy[i] += fyi;
      fz[i] += fzi;
    }
  }

  return { potential, virial, pairs };
}

/** Открытый ящик: минимальный образ не нужен, соседние ячейки не заворачиваются. */
function forcesOpenNeighbours(c: ForceContext): ForceStats {
  const {
    x, y, z, fx, fy, fz, neighbours, n, cellStart, order, cellCount,
    cutoffSq, shiftForce, halfShift, energyConstant,
  } = c;
  neighbours.fill(0);

  let potential = 0;
  let virial = 0;
  let pairs = 0;

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
      let fxi = 0;
      let fyi = 0;
      let fzi = 0;

      for (let b = a + 1; b < endA; b++) {
        const j = order[b];
        const dx = x[j] - xi;
        const dy = y[j] - yi;
        const dz = z[j] - zi;
        const r2 = dx * dx + dy * dy + dz * dz;
        if (r2 >= cutoffSq || r2 === 0) continue;
        const inv2 = 1 / r2;
        const inv6 = inv2 * inv2 * inv2;
        const inv12 = inv6 * inv6;
        const foR = 24 * (2 * inv12 - inv6) * inv2 - shiftForce;
        const rx = foR * dx;
        const ry = foR * dy;
        const rz = foR * dz;
        fxi -= rx;
        fyi -= ry;
        fzi -= rz;
        fx[j] += rx;
        fy[j] += ry;
        fz[j] += rz;
        potential += 4 * (inv12 - inv6) + halfShift * r2 - energyConstant;
        virial += rx * dx + ry * dy + rz * dz;
        pairs++;
        if (r2 < NEIGHBOUR_RADIUS_SQ) {
          neighbours[i]++;
          neighbours[j]++;
        }
      }

      for (let o = 0; o < OFFSET_COUNT; o++) {
        const o3 = o * 3;
        const nx = gx + NEIGHBOUR_OFFSETS[o3];
        const ny = gy + NEIGHBOUR_OFFSETS[o3 + 1];
        const nz = gz + NEIGHBOUR_OFFSETS[o3 + 2];
        if (nx < 0 || nx >= n || ny < 0 || ny >= n || nz < 0 || nz >= n) continue;
        const cell2 = (nx * n + ny) * n + nz;
        const startB = cellStart[cell2];
        const endB = cellStart[cell2 + 1];
        if (startB === endB) continue;

        for (let b = startB; b < endB; b++) {
          const j = order[b];
          const dx = x[j] - xi;
          const dy = y[j] - yi;
          const dz = z[j] - zi;
          const r2 = dx * dx + dy * dy + dz * dz;
          if (r2 >= cutoffSq || r2 === 0) continue;
          const inv2 = 1 / r2;
          const inv6 = inv2 * inv2 * inv2;
          const inv12 = inv6 * inv6;
          const foR = 24 * (2 * inv12 - inv6) * inv2 - shiftForce;
          const rx = foR * dx;
          const ry = foR * dy;
          const rz = foR * dz;
          fxi -= rx;
          fyi -= ry;
          fzi -= rz;
          fx[j] += rx;
          fy[j] += ry;
          fz[j] += rz;
          potential += 4 * (inv12 - inv6) + halfShift * r2 - energyConstant;
          virial += rx * dx + ry * dy + rz * dz;
          pairs++;
          if (r2 < NEIGHBOUR_RADIUS_SQ) {
            neighbours[i]++;
            neighbours[j]++;
          }
        }
      }

      fx[i] += fxi;
      fy[i] += fyi;
      fz[i] += fzi;
    }
  }

  return { potential, virial, pairs };
}

/** Открытый ящик без подсчёта соседей. */
function forcesOpen(c: ForceContext): ForceStats {
  const {
    x, y, z, fx, fy, fz, n, cellStart, order, cellCount,
    cutoffSq, shiftForce, halfShift, energyConstant,
  } = c;

  let potential = 0;
  let virial = 0;
  let pairs = 0;

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
      let fxi = 0;
      let fyi = 0;
      let fzi = 0;

      for (let b = a + 1; b < endA; b++) {
        const j = order[b];
        const dx = x[j] - xi;
        const dy = y[j] - yi;
        const dz = z[j] - zi;
        const r2 = dx * dx + dy * dy + dz * dz;
        if (r2 >= cutoffSq || r2 === 0) continue;
        const inv2 = 1 / r2;
        const inv6 = inv2 * inv2 * inv2;
        const inv12 = inv6 * inv6;
        const foR = 24 * (2 * inv12 - inv6) * inv2 - shiftForce;
        const rx = foR * dx;
        const ry = foR * dy;
        const rz = foR * dz;
        fxi -= rx;
        fyi -= ry;
        fzi -= rz;
        fx[j] += rx;
        fy[j] += ry;
        fz[j] += rz;
        potential += 4 * (inv12 - inv6) + halfShift * r2 - energyConstant;
        virial += rx * dx + ry * dy + rz * dz;
        pairs++;
      }

      for (let o = 0; o < OFFSET_COUNT; o++) {
        const o3 = o * 3;
        const nx = gx + NEIGHBOUR_OFFSETS[o3];
        const ny = gy + NEIGHBOUR_OFFSETS[o3 + 1];
        const nz = gz + NEIGHBOUR_OFFSETS[o3 + 2];
        if (nx < 0 || nx >= n || ny < 0 || ny >= n || nz < 0 || nz >= n) continue;
        const cell2 = (nx * n + ny) * n + nz;
        const startB = cellStart[cell2];
        const endB = cellStart[cell2 + 1];
        if (startB === endB) continue;

        for (let b = startB; b < endB; b++) {
          const j = order[b];
          const dx = x[j] - xi;
          const dy = y[j] - yi;
          const dz = z[j] - zi;
          const r2 = dx * dx + dy * dy + dz * dz;
          if (r2 >= cutoffSq || r2 === 0) continue;
          const inv2 = 1 / r2;
          const inv6 = inv2 * inv2 * inv2;
          const inv12 = inv6 * inv6;
          const foR = 24 * (2 * inv12 - inv6) * inv2 - shiftForce;
          const rx = foR * dx;
          const ry = foR * dy;
          const rz = foR * dz;
          fxi -= rx;
          fyi -= ry;
          fzi -= rz;
          fx[j] += rx;
          fy[j] += ry;
          fz[j] += rz;
          potential += 4 * (inv12 - inv6) + halfShift * r2 - energyConstant;
          virial += rx * dx + ry * dy + rz * dz;
          pairs++;
        }
      }

      fx[i] += fxi;
      fy[i] += fyi;
      fz[i] += fzi;
    }
  }

  return { potential, virial, pairs };
}

/**
 * Силы по списку соседей Верле — основной путь для больших систем.
 *
 * Здесь перебираются только реальные соседи (плюс «кожа»), а не все частицы
 * 27 ячеек. Это примерно втрое меньше работы на шаг, чем обход сетки: для
 * ρ* = 0.7 и rc = 2.5 в списке около 55 записей на частицу против 464
 * кандидатов при обходе ячеек.
 *
 * Список ПОЛОВИННЫЙ, поэтому третий закон Ньютона применяется вручную.
 *
 * @param state    состояние; изменяются fx, fy, fz, neighbours
 * @param list     построенный список соседей
 * @param box      длина ящика
 * @param cutoff   радиус обрезания
 * @param shift    постоянные сдвига
 * @param periodic применять ли минимальный образ
 * @param countNeighbours считать ли локальную плотность
 */
export function computeForcesFromList(
  state: ParticleState,
  list: VerletList,
  box: number,
  cutoff: number,
  shift: LjShift,
  periodic: boolean,
  countNeighbours = true,
): ForceStats {
  const x = state.x;
  const y = state.y;
  const z = state.z;
  const fx = state.fx;
  const fy = state.fy;
  const fz = state.fz;
  const neighbours = state.neighbours;
  const start = list.start;
  const items = list.items;

  fx.fill(0);
  fy.fill(0);
  fz.fill(0);
  if (countNeighbours) neighbours.fill(0);

  const cutoffSq = cutoff * cutoff;
  const half = box * 0.5;
  const shiftForce = shift.forceOverR;
  const halfShift = 0.5 * shiftForce;
  const energyConstant = shift.energy + halfShift * shift.cutoffSq;

  let potential = 0;
  let virial = 0;
  let pairs = 0;

  for (let i = 0; i < state.count; i++) {
    const endI = start[i + 1];
    if (start[i] === endI) continue;
    const xi = x[i];
    const yi = y[i];
    const zi = z[i];
    let fxi = 0;
    let fyi = 0;
    let fzi = 0;
    let ni = 0;

    for (let k = start[i]; k < endI; k++) {
      const j = items[k];
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
      if (r2 >= cutoffSq || r2 === 0) continue;
      const inv2 = 1 / r2;
      const inv6 = inv2 * inv2 * inv2;
      const inv12 = inv6 * inv6;
      const foR = 24 * (2 * inv12 - inv6) * inv2 - shiftForce;
      const rx = foR * dx;
      const ry = foR * dy;
      const rz = foR * dz;
      fxi -= rx;
      fyi -= ry;
      fzi -= rz;
      fx[j] += rx;
      fy[j] += ry;
      fz[j] += rz;
      potential += 4 * (inv12 - inv6) + halfShift * r2 - energyConstant;
      virial += rx * dx + ry * dy + rz * dz;
      pairs++;
      if (countNeighbours && r2 < NEIGHBOUR_RADIUS_SQ) {
        ni++;
        neighbours[j]++;
      }
    }

    fx[i] += fxi;
    fy[i] += fyi;
    fz[i] += fzi;
    if (countNeighbours) neighbours[i] += ni;
  }

  return { potential, virial, pairs };
}

/**
 * Сила, действующая на частицу i со стороны частицы j.
 *
 * Возвращается именно сила НА i: d направлен от i к j, поэтому F_i = −(F/r)·d.
 */
export function pairForce(
  state: ParticleState,
  i: number,
  j: number,
  box: number,
  shift: LjShift,
): [number, number, number] {
  let dx = state.x[j] - state.x[i];
  let dy = state.y[j] - state.y[i];
  let dz = state.z[j] - state.z[i];
  dx -= box * Math.round(dx / box);
  dy -= box * Math.round(dy / box);
  dz -= box * Math.round(dz / box);
  const f = ljForceOverR(dx * dx + dy * dy + dz * dz, shift);
  return [-f * dx, -f * dy, -f * dz];
}
