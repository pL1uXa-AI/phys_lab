/**
 * Тесты сетки ячеек (списков Верле).
 *
 * Сетка — оптимизация, которая обязана быть неотличима от честного перебора
 * всех пар. Поэтому здесь два уровня проверки: корректность раскладки по
 * ячейкам и совпадение сил, посчитанных через сетку, с прямым суммированием.
 *
 * Отдельно проверяется главная ловушка — направление силы. Тесты «на модуль»
 * её не ловят (см. `forces.ts`), а цена ошибки — система, которая не сохраняет
 * энергию и разлетается за десятки шагов.
 */

import { describe, expect, it } from 'vitest';
import { buildGrid, cellOf, gridIsSafe } from '../core/grid.js';
import { computeForces, pairForce } from '../core/forces.js';
import { ljShift } from '../core/potential.js';
import { buildState } from '../core/initializers.js';
import { boxLength, type CellGrid } from '../core/types.js';

const CUTOFF = 2.5;
const SHIFT = ljShift(CUTOFF);

function makeGrid(box: number, count: number, size: number): CellGrid {
  const n = Math.max(3, Math.floor(box / size));
  const cells = n * n * n;
  return {
    n,
    size: box / n,
    cellStart: new Int32Array(cells + 1),
    order: new Int32Array(count),
    cellIndex: new Int32Array(count),
    counts: new Int32Array(cells),
  };
}

/**
 * Прямое суммирование сил по всем парам — эталон для сравнения.
 *
 * Обрезание проверяется ДО вызова `pairForce`: сама эта функция знает только
 * про потенциал и про обрезание ничего не знает, поэтому пары за его
 * пределами в эталон попадать не должны.
 */
function bruteForce(state: ReturnType<typeof buildState>['state'], box: number) {
  const fx = new Float64Array(state.count);
  const fy = new Float64Array(state.count);
  const fz = new Float64Array(state.count);
  let potential = 0;
  let pairs = 0;
  const cutoffSq = CUTOFF * CUTOFF;
  for (let i = 0; i < state.count; i++) {
    for (let j = i + 1; j < state.count; j++) {
      let dx = state.x[j] - state.x[i];
      let dy = state.y[j] - state.y[i];
      let dz = state.z[j] - state.z[i];
      dx -= box * Math.round(dx / box);
      dy -= box * Math.round(dy / box);
      dz -= box * Math.round(dz / box);
      const rr = dx * dx + dy * dy + dz * dz;
      if (rr >= cutoffSq) continue;
      const [ax, ay, az] = pairForce(state, i, j, box, SHIFT);
      fx[i] += ax;
      fy[i] += ay;
      fz[i] += az;
      fx[j] -= ax;
      fy[j] -= ay;
      fz[j] -= az;
      pairs++;
      const inv6 = 1 / (rr * rr * rr);
      potential +=
        4 * (inv6 * inv6 - inv6) + 0.5 * SHIFT.forceOverR * (rr - cutoffSq) - SHIFT.energy;
    }
  }
  return { fx, fy, fz, potential, pairs };
}

describe('сетка ячеек', () => {
  it('все живые частицы попадают ровно в одну ячейку', () => {
    const built = buildState('fcc', 256, 0.85, 0.3, 3);
    const box = built.box;
    const state = built.state;
    const grid = makeGrid(box, state.count, CUTOFF * 1.05);
    buildGrid(state, grid);
    const seen = new Array(state.count).fill(0);
    for (let c = 0; c < grid.n ** 3; c++) {
      for (let k = grid.cellStart[c]; k < grid.cellStart[c + 1]; k++) {
        const i = grid.order[k];
        seen[i]++;
        expect(grid.cellIndex[i]).toBe(c);
      }
    }
    for (let i = 0; i < state.count; i++) expect(seen[i]).toBe(1);
  });

  it('номер ячейки соответствует своим координатам', () => {
    expect(cellOf(0, 0, 0, 5)).toBe(0);
    expect(cellOf(1, 0, 0, 5)).toBe(25);
    expect(cellOf(0, 1, 0, 5)).toBe(5);
    expect(cellOf(0, 0, 1, 5)).toBe(1);
    expect(cellOf(4, 4, 4, 5)).toBe(124);
  });

  it('размер ячейки не меньше радиуса обрезания', () => {
    const box = boxLength(2000, 0.65);
    const grid = makeGrid(box, 2000, CUTOFF * 1.05);
    expect(gridIsSafe(grid, CUTOFF)).toBe(true);
  });

  it('силы через сетку совпадают с прямым суммированием', () => {
    const built = buildState('fcc', 240, 0.55, 0.6, 9);
    const box = built.box;
    const state = built.state;
    const count = state.count;
    const grid = makeGrid(box, count, CUTOFF * 1.05);
    buildGrid(state, grid);
    const viaGrid = computeForces(state, grid, box, CUTOFF, SHIFT, true, false);

    const reference = bruteForce(state, box);
    expect(viaGrid.pairs).toBe(reference.pairs);
    expect(viaGrid.potential).toBeCloseTo(reference.potential, 8);
    for (let i = 0; i < count; i++) {
      expect(state.fx[i]).toBeCloseTo(reference.fx[i], 8);
      expect(state.fy[i]).toBeCloseTo(reference.fy[i], 8);
      expect(state.fz[i]).toBeCloseTo(reference.fz[i], 8);
    }
  });

  it('сумма всех сил равна нулю (третий закон соблюдён)', () => {
    const built = buildState('fcc', 400, 0.8, 0.9, 12);
    const box = built.box;
    const state = built.state;
    const count = state.count;
    const grid = makeGrid(box, count, CUTOFF * 1.05);
    buildGrid(state, grid);
    computeForces(state, grid, box, CUTOFF, SHIFT, true, false);
    let sx = 0;
    let sy = 0;
    let sz = 0;
    for (let i = 0; i < count; i++) {
      sx += state.fx[i];
      sy += state.fy[i];
      sz += state.fz[i];
    }
    expect(Math.abs(sx)).toBeLessThan(1e-9);
    expect(Math.abs(sy)).toBeLessThan(1e-9);
    expect(Math.abs(sz)).toBeLessThan(1e-9);
  });

  it('сила, посчитанная по сетке, есть производная энергии (знак!)', () => {
    // Сдвигаем ОДНУ частицу и смотрим, как меняется энергия: F = −dU/dx.
    // Это единственная проверка, которая ловит ошибку направления силы:
    // проверки «на модуль» её пропускают, а интегратор после неё греет
    // систему до 10³⁰ за десятки шагов.
    const built = buildState('fcc', 500, 0.85, 0.6, 43);
    const box = built.box;
    const state = built.state;
    const count = state.count;
    const grid = makeGrid(box, count, CUTOFF * 1.05);

    // Слегка искажаем решётку: иначе все силы почти нулевые и тест пуст.
    for (let i = 0; i < count; i++) {
      state.x[i] += 0.03 * Math.sin(i * 1.7);
      state.y[i] += 0.03 * Math.cos(i * 2.3);
    }

    buildGrid(state, grid);
    computeForces(state, grid, box, CUTOFF, SHIFT, true, false);
    const analytic = Float64Array.from(state.fx);

    const h = 1e-6;
    for (const k of [0, 3, 17, 99, 250, 401]) {
      state.x[k] += h;
      buildGrid(state, grid);
      const plus = computeForces(state, grid, box, CUTOFF, SHIFT, true, false).potential;
      state.x[k] -= 2 * h;
      buildGrid(state, grid);
      const minus = computeForces(state, grid, box, CUTOFF, SHIFT, true, false).potential;
      state.x[k] += h;
      const numerical = -(plus - minus) / (2 * h);
      expect(analytic[k]).toBeCloseTo(numerical, 5);
    }
  });

  it('соседи считаются по всем 26 ячейкам, а не по половине', () => {
    // Крупный радиус обрезания → мало ячеек → частица обязана найти соседей
    // «позади» себя. Ошибка в списке смещений отняла бы ровно половину пар.
    const built = buildState('fcc', 1000, 0.8, 0.5, 21);
    const box = built.box;
    const state = built.state;
    const count = state.count;
    const grid = makeGrid(box, count, CUTOFF * 1.05);
    buildGrid(state, grid);
    computeForces(state, grid, box, CUTOFF, SHIFT, true, true);
    // В ГЦК при ρ = 0.8 у частицы 12 ближайших соседей; в сфере 1.4σ их
    // должно быть не меньше двенадцати.
    let minNeighbours = Number.POSITIVE_INFINITY;
    for (let i = 0; i < count; i++) minNeighbours = Math.min(minNeighbours, state.neighbours[i]);
    expect(minNeighbours).toBeGreaterThanOrEqual(12);
  });

  it('обрезание действительно ограничивает число пар', () => {
    const built = buildState('fcc', 500, 0.6, 0.7, 31);
    const box = built.box;
    const state = built.state;
    const count = state.count;
    const grid = makeGrid(box, count, CUTOFF * 1.05);
    buildGrid(state, grid);
    const stats = computeForces(state, grid, box, CUTOFF, SHIFT, true, false);
    // Полное число пар 500·499/2 = 124 750; при ρ = 0.6 и rc = 2.5 в сфере
    // обрезания около 39 соседей, то есть примерно 9700 пар.
    expect(stats.pairs).toBeLessThan(count * 40);
    expect(stats.pairs).toBeGreaterThan(count * 20);
  });
});
