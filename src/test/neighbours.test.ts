/**
 * Тесты списков соседей Верле.
 *
 * Список — вторая оптимизация после сетки, и ошибиться в ней легче, чем
 * кажется: достаточно неверно выбрать половину окрестности, и каждая пара
 * попадёт в список дважды (силы удвоятся), либо потеряется часть соседей
 * (система начнёт «холодать»). Ни то, ни другое не бросается в глаза.
 *
 * Поэтому проверяется главное: список содержит РОВНО те пары, что и честный
 * перебор, силы по списку совпадают с силами по сетке, а кожа действительно
 * позволяет не перестраивать список каждый шаг.
 */

import { describe, expect, it } from 'vitest';
import { VerletList } from '../core/neighbours.js';
import { buildGrid } from '../core/grid.js';
import { computeForces, computeForcesFromList } from '../core/forces.js';
import { ljShift } from '../core/potential.js';
import { buildState } from '../core/initializers.js';
import { drift, kick } from '../core/integrator.js';
import { type CellGrid, type ParticleState } from '../core/types.js';

const CUTOFF = 2.5;
const SHIFT = ljShift(CUTOFF);

/** Сетка по радиусу обрезания — такая же, как в мире. */
function makeGrid(state: ParticleState, box: number): CellGrid {
  const size = CUTOFF * 1.05;
  const n = Math.max(3, Math.floor(box / size));
  const cells = n * n * n;
  return {
    n,
    size: box / n,
    cellStart: new Int32Array(cells + 1),
    order: new Int32Array(state.count),
    cellIndex: new Int32Array(state.count),
    counts: new Int32Array(cells),
  };
}

/**
 * Прямой перебор: все пары в пределах `cutoff`.
 *
 * @param periodic применять ли минимальный образ. Для открытого ящика его
 *                 быть не должно — иначе эталон посчитает «соседями» частицы
 *                 у противоположных стенок, и тест потребует от списка
 *                 невозможного.
 */
function referencePairs(
  state: ParticleState,
  box: number,
  cutoff: number,
  periodic = true,
): Set<string> {
  const found = new Set<string>();
  const r2Limit = cutoff * cutoff;
  const half = box * 0.5;
  for (let i = 0; i < state.count; i++) {
    for (let j = i + 1; j < state.count; j++) {
      let dx = state.x[j] - state.x[i];
      let dy = state.y[j] - state.y[i];
      let dz = state.z[j] - state.z[i];
      if (periodic) {
        if (dx > half) dx -= box;
        else if (dx < -half) dx += box;
        if (dy > half) dy -= box;
        else if (dy < -half) dy += box;
        if (dz > half) dz -= box;
        else if (dz < -half) dz += box;
      }
      const r2 = dx * dx + dy * dy + dz * dz;
      if (r2 < r2Limit && r2 > 0) found.add(`${i}:${j}`);
    }
  }
  return found;
}

/** Пары, которые лежат в списке (в пределах cutoff, без кожи). */
function listPairs(
  state: ParticleState,
  list: VerletList,
  box: number,
  cutoff: number,
  periodic = true,
): Set<string> {
  const found = new Set<string>();
  const r2Limit = cutoff * cutoff;
  const half = box * 0.5;
  for (let i = 0; i < state.count; i++) {
    for (let k = list.start[i]; k < list.start[i + 1]; k++) {
      const j = list.items[k];
      let dx = state.x[j] - state.x[i];
      let dy = state.y[j] - state.y[i];
      let dz = state.z[j] - state.z[i];
      if (periodic) {
        if (dx > half) dx -= box;
        else if (dx < -half) dx += box;
        if (dy > half) dy -= box;
        else if (dy < -half) dy += box;
        if (dz > half) dz -= box;
        else if (dz < -half) dz += box;
      }
      const r2 = dx * dx + dy * dy + dz * dz;
      if (r2 < r2Limit && r2 > 0) found.add(`${i}:${j}`);
    }
  }
  return found;
}

describe('список соседей Верле', () => {
  it('содержит ровно те пары, что и прямой перебор', () => {
    const built = buildState('fcc', 500, 0.85, 0.6, 43);
    const state = built.state;
    const box = built.box;
    const grid = makeGrid(state, box);
    buildGrid(state, grid);

    const list = new VerletList(state.count, 0.3);
    list.build(state, grid, box, CUTOFF, true);

    const expected = referencePairs(state, box, CUTOFF);
    const actual = listPairs(state, list, box, CUTOFF);

    // Список шире (в нём есть «кожа»), поэтому проверяем вложенность:
    // все настоящие соседи обязаны быть в списке.
    for (const pair of expected) {
      expect(actual.has(pair)).toBe(true);
    }
    // И обратное: в пределах обрезания лишних пар быть не должно.
    expect(actual.size).toBe(expected.size);
  });

  it('каждая пара встречается ровно один раз', () => {
    const built = buildState('sc', 500, 0.7, 0.6, 7);
    const state = built.state;
    const box = built.box;
    const grid = makeGrid(state, box);
    buildGrid(state, grid);

    const list = new VerletList(state.count, 0.3);
    list.build(state, grid, box, CUTOFF, true);

    const seen = new Set<string>();
    let duplicates = 0;
    for (let i = 0; i < state.count; i++) {
      for (let k = list.start[i]; k < list.start[i + 1]; k++) {
        const j = list.items[k];
        const key = `${Math.min(i, j)}:${Math.max(i, j)}`;
        if (seen.has(key)) duplicates++;
        seen.add(key);
        // Полуторный список: у частицы i лежат только j > i.
        expect(j).toBeGreaterThan(i);
      }
    }
    expect(duplicates).toBe(0);
  });

  it('силы по списку совпадают с силами по сетке', () => {
    const built = buildState('fcc', 600, 0.8, 0.8, 11);
    const state = built.state;
    const box = built.box;
    const grid = makeGrid(state, box);
    buildGrid(state, grid);

    const list = new VerletList(state.count, 0.3);
    list.build(state, grid, box, CUTOFF, true);

    const viaGrid = computeForces(state, grid, box, CUTOFF, SHIFT, true, true);
    const gridForce = Float64Array.from(state.fx);

    const viaList = computeForcesFromList(state, list, box, CUTOFF, SHIFT, true, true);

    expect(viaList.pairs).toBe(viaGrid.pairs);
    expect(viaList.potential).toBeCloseTo(viaGrid.potential, 8);
    expect(viaList.virial).toBeCloseTo(viaGrid.virial, 8);
    for (let i = 0; i < state.count; i++) {
      expect(state.fx[i]).toBeCloseTo(gridForce[i], 8);
    }
  });

  it('кожа позволяет не перестраивать список каждый шаг', () => {
    const built = buildState('fcc', 800, 0.85, 0.6, 13);
    const state = built.state;
    const box = built.box;
    const grid = makeGrid(state, box);
    buildGrid(state, grid);

    const list = new VerletList(state.count, 0.3);
    list.build(state, grid, box, CUTOFF, true);

    const before = list.rebuilds;
    // Прогоняем несколько шагов свободной динамики (без сил: важно лишь
    // смещение координат, от которого зависит необходимость перестроения).
    const dt = 0.002;
    for (let s = 0; s < 5; s++) {
      kick(state, dt * 0.5);
      drift(state, dt, box, true, false);
      kick(state, dt * 0.5);
    }
    expect(list.needsRebuild(state, true, box)).toBe(false);
    expect(list.rebuilds).toBe(before);
  });

  it('при большом смещении список требует перестроения', () => {
    const built = buildState('fcc', 300, 0.8, 0.6, 17);
    const state = built.state;
    const box = built.box;
    const grid = makeGrid(state, box);
    buildGrid(state, grid);

    const list = new VerletList(state.count, 0.3);
    list.build(state, grid, box, CUTOFF, true);
    expect(list.needsRebuild(state, true, box)).toBe(false);

    // Сдвигаем всех на расстояние больше кожи — список обязан устареть.
    for (let i = 0; i < state.count; i++) state.x[i] += 0.5;
    expect(list.needsRebuild(state, true, box)).toBe(true);
  });

  it('построенный список не теряет соседей при периодических границах', () => {
    // Частицы специально ставятся у самой грани: минимальный образ обязан
    // «сшить» их с противоположной стороной ящика.
    const built = buildState('fcc', 256, 0.6, 0.5, 19);
    const state = built.state;
    const box = built.box;
    // Сдвигаем систему так, чтобы часть частиц легла на границу x = 0.
    for (let i = 0; i < state.count; i++) {
      state.x[i] -= box * 0.5;
      state.x[i] -= box * Math.floor(state.x[i] / box);
    }
    const grid = makeGrid(state, box);
    buildGrid(state, grid);

    const list = new VerletList(state.count, 0.3);
    list.build(state, grid, box, CUTOFF, true);

    const expected = referencePairs(state, box, CUTOFF);
    const actual = listPairs(state, list, box, CUTOFF);
    expect(actual.size).toBe(expected.size);
    for (const pair of expected) expect(actual.has(pair)).toBe(true);
  });

  it('открытый ящик учитывает только реально близкие пары', () => {
    const built = buildState('fcc', 400, 0.7, 0.6, 23);
    const state = built.state;
    const box = built.box;
    const grid = makeGrid(state, box);
    buildGrid(state, grid);

    // Без заворачивания: у открытого ящика частицы у противоположных стенок
    // не соседи, и список обязан это учитывать.
    const list = new VerletList(state.count, 0.3);
    list.build(state, grid, box, CUTOFF, false);

    const expected = referencePairs(state, box, CUTOFF, false);
    const actual = listPairs(state, list, box, CUTOFF, false);
    expect(actual.size).toBe(expected.size);
    for (const pair of expected) expect(actual.has(pair)).toBe(true);
  });
});
