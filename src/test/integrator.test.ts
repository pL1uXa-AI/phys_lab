/**
 * Тесты интегратора и термостатов.
 *
 * Здесь проверяется то, ради чего выбран Верле: сохранение энергии на длинном
 * прогоне, обратимость по времени и устойчивость при шаге, на котором явный
 * Эйлер уже развалился бы. Плюс термостаты: каждый обязан удерживать заданную
 * температуру, а Ланжевен — ещё и давать правильную дисперсию скоростей.
 */

import { describe, expect, it } from 'vitest';
import { Rng } from '../core/rng.js';
import { buildState } from '../core/initializers.js';
import { kineticEnergyOfState, removeDriftNow } from '../core/velocity.js';
import {
  applyBerendsen,
  applyLangevin,
  applyNoseHoover,
  allocNoseHoover,
  drift,
  kick,
  reflectWalls,
  removeEscaped,
} from '../core/integrator.js';
import { computeForces } from '../core/forces.js';
import { buildGrid } from '../core/grid.js';
import { ljShift } from '../core/potential.js';
import { type CellGrid, type ParticleState } from '../core/types.js';

const CUTOFF = 2.5;
const SHIFT = ljShift(CUTOFF);

/** Мини-система: 500 частиц, сетка и честный расчёт сил. */
function miniSystem(count = 500, density = 0.85, temperature = 0.6, seed = 43) {
  const built = buildState('fcc', count, density, temperature, seed);
  const state = built.state;
  const box = built.box;
  const size = CUTOFF * 1.05;
  const n = Math.max(3, Math.floor(box / size));
  const cells = n * n * n;
  const grid: CellGrid = {
    n,
    size: box / n,
    cellStart: new Int32Array(cells + 1),
    order: new Int32Array(state.count),
    cellIndex: new Int32Array(state.count),
    counts: new Int32Array(cells),
  };
  const forces = (): number => {
    buildGrid(state, grid);
    return computeForces(state, grid, box, CUTOFF, SHIFT, true, false).potential;
  };
  return { state, box, forces };
}

function totalEnergy(state: ParticleState, potential: number): number {
  return potential + kineticEnergyOfState(state);
}

/** Один шаг Верле: половина толчка — дрейф — силы — половина толчка. */
function verletStep(
  state: ParticleState,
  box: number,
  forces: () => number,
  dt: number,
): number {
  kick(state, dt * 0.5);
  drift(state, dt, box, true, true);
  const potential = forces();
  kick(state, dt * 0.5);
  return potential;
}

/** Двухчастичная система для точных проверок. */
function twoParticles(): ParticleState {
  const { state } = buildState('sc', 8, 0.5, 0, 1);
  state.count = 2;
  state.alive.fill(1);
  state.x[0] = 0;
  state.y[0] = 0;
  state.z[0] = 0;
  state.x[1] = 3;
  state.y[1] = 0;
  state.z[1] = 0;
  state.vx.fill(0);
  state.vy.fill(0);
  state.vz.fill(0);
  state.fx.fill(0);
  state.fy.fill(0);
  state.fz.fill(0);
  return state;
}

describe('интегрирование Верле', () => {
  it('свободная частица движется равномерно', () => {
    const state = twoParticles();
    state.count = 1;
    state.alive[1] = 0;
    state.x[0] = 1;
    state.vx[0] = 2;
    const dt = 0.01;
    for (let i = 0; i < 100; i++) {
      kick(state, dt * 0.5);
      drift(state, dt, 10, false, false);
      kick(state, dt * 0.5);
    }
    expect(state.x[0]).toBeCloseTo(1 + 2 * 100 * dt, 10);
    expect(state.vx[0]).toBeCloseTo(2, 12);
  });

  it('периодические границы заворачивают координату', () => {
    const state = twoParticles();
    state.count = 1;
    state.alive[1] = 0;
    state.x[0] = 9.5;
    state.vx[0] = 10;
    drift(state, 0.1, 10, true, false);
    // 9.5 + 1 = 10.5 → 0.5
    expect(state.x[0]).toBeCloseTo(0.5, 9);
  });

  it('накопленный путь не зависит от заворачивания', () => {
    const state = twoParticles();
    state.count = 1;
    state.alive[1] = 0;
    state.x[0] = 9.5;
    state.vx[0] = 10;
    state.travel[0] = 0;
    for (let i = 0; i < 10; i++) drift(state, 0.1, 10, true, true);
    // Прошла 10 шагов по 1σ — путь 10σ, несмотря на переход через границу.
    expect(state.travel[0]).toBeCloseTo(10, 9);
  });

  it('отражение от стенки меняет знак скорости', () => {
    const state = twoParticles();
    state.count = 1;
    state.alive[1] = 0;
    state.x[0] = 9.8;
    state.vx[0] = 5;
    drift(state, 0.1, 10, false, false);
    reflectWalls(state, 10);
    expect(state.vx[0]).toBeLessThan(0);
    expect(state.x[0]).toBeLessThan(10);
    expect(state.x[0]).toBeGreaterThanOrEqual(0);
  });

  it('двойное отражение при большой скорости не оставляет частицу снаружи', () => {
    const state = twoParticles();
    state.count = 1;
    state.alive[1] = 0;
    state.x[0] = 0.2;
    state.vx[0] = -50;
    drift(state, 0.1, 10, false, false);
    reflectWalls(state, 10);
    expect(state.x[0]).toBeGreaterThanOrEqual(0);
    expect(state.x[0]).toBeLessThan(10);
    expect(state.vx[0]).toBeGreaterThan(0);
  });

  it('открытый ящик удаляет улетевшие частицы', () => {
    const state = twoParticles();
    state.x[0] = 20;
    state.x[1] = 5;
    const removed = removeEscaped(state, 10, 2);
    expect(removed).toBe(1);
    expect(state.alive[0]).toBe(0);
    expect(state.alive[1]).toBe(1);
  });
});

describe('термостат Берендсена', () => {
  it('приводит температуру к целевой', () => {
    const { state } = buildState('fcc', 500, 0.8, 3.0, 17);
    const dof = 3 * state.count - 3;
    for (let i = 0; i < 4000; i++) {
      const k = kineticEnergyOfState(state);
      applyBerendsen(state, k, dof, 0.5, 0.002, 0.4);
    }
    const temperature = (2 * kineticEnergyOfState(state)) / dof;
    expect(temperature).toBeCloseTo(0.5, 2);
  });

  it('не трогает систему, уже находящуюся при целевой температуре', () => {
    const { state } = buildState('fcc', 500, 0.8, 1.0, 19);
    removeDriftNow(state);
    const dof = 3 * state.count - 3;
    const before = Array.from(state.vx);
    const k = kineticEnergyOfState(state);
    applyBerendsen(state, k, dof, 1.0, 0.002, 0.4);
    for (let i = 0; i < before.length; i++) expect(state.vx[i]).toBeCloseTo(before[i], 3);
  });
});

describe('термостат Ланжевена', () => {
  it('удерживает заданную температуру', () => {
    const { state } = buildState('fcc', 800, 0.7, 0.1, 23);
    const rng = new Rng(101);
    const dt = 0.002;
    const target = 1.4;
    // Разгон: сначала система должна выйти на режим.
    for (let i = 0; i < 4000; i++) applyLangevin(state, dt, 1.0, target, rng);
    let sum = 0;
    const samples = 4000;
    for (let i = 0; i < samples; i++) {
      applyLangevin(state, dt, 1.0, target, rng);
      sum += kineticEnergyOfState(state);
    }
    const dof = 3 * state.count - 3;
    const temperature = (2 * (sum / samples)) / dof;
    expect(temperature).toBeGreaterThan(target * 0.9);
    expect(temperature).toBeLessThan(target * 1.1);
  });

  it('без шума (T = 0) останавливает систему', () => {
    const { state } = buildState('fcc', 200, 0.8, 1.0, 29);
    const rng = new Rng(7);
    for (let i = 0; i < 4000; i++) applyLangevin(state, 0.005, 2.0, 0, rng);
    const temperature = (2 * kineticEnergyOfState(state)) / (3 * state.count - 3);
    expect(temperature).toBeLessThan(1e-3);
  });

  it('трение и шум сбалансированы: дисперсия по компоненте равна T', () => {
    const { state } = buildState('fcc', 400, 0.8, 1.0, 31);
    const rng = new Rng(13);
    const target = 0.8;
    for (let i = 0; i < 3000; i++) applyLangevin(state, 0.005, 1.0, target, rng);
    let sum = 0;
    let sumSq = 0;
    let n = 0;
    for (let s = 0; s < 3000; s++) {
      applyLangevin(state, 0.005, 1.0, target, rng);
      for (let i = 0; i < state.count; i++) {
        sum += state.vx[i];
        sumSq += state.vx[i] * state.vx[i];
        n++;
      }
    }
    const mean = sum / n;
    const variance = sumSq / n - mean * mean;
    // Точное свойство точной дискретизации Ланжевена: дисперсия = T.
    expect(variance).toBeCloseTo(target, 1);
  });
});

describe('термостат Нозе-Хувера', () => {
  it('выходит на заданную температуру', () => {
    const { state } = buildState('fcc', 600, 0.75, 0.2, 37);
    const nh = allocNoseHoover();
    const dof = 3 * state.count - 3;
    const target = 1.0;
    for (let i = 0; i < 20000; i++) {
      const k = kineticEnergyOfState(state);
      applyNoseHoover(state, nh, k, dof, target, 0.002, 0.5);
    }
    let sum = 0;
    const samples = 5000;
    for (let i = 0; i < samples; i++) {
      const k = kineticEnergyOfState(state);
      applyNoseHoover(state, nh, k, dof, target, 0.002, 0.5);
      sum += k;
    }
    const temperature = (2 * (sum / samples)) / dof;
    expect(temperature).toBeGreaterThan(target * 0.85);
    expect(temperature).toBeLessThan(target * 1.15);
  });

  it('температура не уходит в бесконечность (устойчивость)', () => {
    const { state } = buildState('fcc', 300, 0.8, 1.0, 41);
    const nh = allocNoseHoover();
    const dof = 3 * state.count - 3;
    for (let i = 0; i < 50000; i++) {
      const k = kineticEnergyOfState(state);
      applyNoseHoover(state, nh, k, dof, 0.6, 0.004, 0.5);
      expect(Number.isFinite(state.vx[0])).toBe(true);
    }
    const temperature = (2 * kineticEnergyOfState(state)) / dof;
    expect(temperature).toBeLessThan(5);
  });
});

describe('сохранение энергии (проверка симплектичности)', () => {
  it('микроканоническая энергия не дрейфует на 4000 шагов', () => {
    // Это ключевая проверка. У явного Эйлера энергия систематически растёт
    // или падает; у Верле — колеблется около постоянного значения.
    // Тест ловит и ошибку знака силы, и рассогласование энергии с силой:
    // и то и другое превращает колебания в экспоненциальный рост.
    const { state, box, forces } = miniSystem(500, 0.85, 0.6, 43);
    const dt = 0.004;

    let potential = forces();
    const energies: number[] = [totalEnergy(state, potential)];
    for (let s = 1; s <= 4000; s++) {
      potential = verletStep(state, box, forces, dt);
      if (s % 100 === 0) energies.push(totalEnergy(state, potential));
    }

    const mean = energies.reduce((a, b) => a + b, 0) / energies.length;
    for (const e of energies) {
      expect(Math.abs(e - mean) / Math.abs(mean)).toBeLessThan(0.02);
    }
    // Систематического ухода нет: первая и последняя четверть совпадают.
    const head = energies.slice(0, 5).reduce((a, b) => a + b, 0) / 5;
    const tail = energies.slice(-5).reduce((a, b) => a + b, 0) / 5;
    expect(Math.abs(tail - head) / Math.abs(head)).toBeLessThan(0.005);
  });

  it('энергия сохраняется при разных плотностях и температурах', () => {
    for (const [density, temperature] of [
      [0.95, 0.3],
      [0.8, 1.0],
      [0.6, 1.2],
      [0.65, 0.9],
    ] as const) {
      const { state, box, forces } = miniSystem(500, density, temperature, 43);
      const dt = 0.004;
      let potential = forces();
      const head: number[] = [];
      const tail: number[] = [];
      for (let s = 1; s <= 3000; s++) {
        potential = verletStep(state, box, forces, dt);
        if (s <= 300) head.push(totalEnergy(state, potential));
        if (s > 2700) tail.push(totalEnergy(state, potential));
      }
      const mean = (a: number[]): number => a.reduce((x, y) => x + y, 0) / a.length;
      const e0 = mean(head);
      const e1 = mean(tail);
      expect(Math.abs(e1 - e0) / Math.abs(e0)).toBeLessThan(0.01);
    }
  });

  it('интегратор обратим по времени', () => {
    // Обратимость — характеристическое свойство симплектической схемы.
    // Если энергия согласована с силой, обратный прогон возвращает систему
    // в исходную точку с точностью, ограниченной только накоплением
    // округлений.
    //
    // Внимание к деталям: дрейф обязан быть БЕЗ заворачивания координат.
    // Операция `x − box·floor(x/box)` разрывна, и обратный проход через неё
    // не возвращает точку — не потому, что схема плохая, а потому что мы
    // сами выбросили информацию. Поэтому проверка обратимости идёт
    // на бесконечной системе без границ.
    const { state, box, forces } = miniSystem(200, 0.85, 0.6, 43);
    const dt = 0.001;
    const STEPS = 200;

    const x0 = Float64Array.from(state.x);
    const y0 = Float64Array.from(state.y);
    const z0 = Float64Array.from(state.z);
    const v0 = Float64Array.from(state.vx);

    const stepOpen = (): number => {
      kick(state, dt * 0.5);
      drift(state, dt, box, false, false);
      const potential = forces();
      kick(state, dt * 0.5);
      return potential;
    };

    for (let s = 0; s < STEPS; s++) stepOpen();
    for (let i = 0; i < state.count; i++) {
      state.vx[i] = -state.vx[i];
      state.vy[i] = -state.vy[i];
      state.vz[i] = -state.vz[i];
    }
    for (let s = 0; s < STEPS; s++) stepOpen();
    for (let i = 0; i < state.count; i++) {
      state.vx[i] = -state.vx[i];
      state.vy[i] = -state.vy[i];
      state.vz[i] = -state.vz[i];
    }

    let positionError = 0;
    let velocityError = 0;
    for (let i = 0; i < state.count; i++) {
      positionError = Math.max(
        positionError,
        Math.abs(state.x[i] - x0[i]),
        Math.abs(state.y[i] - y0[i]),
        Math.abs(state.z[i] - z0[i]),
      );
      velocityError = Math.max(velocityError, Math.abs(state.vx[i] - v0[i]));
    }
    expect(positionError).toBeLessThan(1e-8);
    expect(velocityError).toBeLessThan(1e-8);
  });

  it('две частицы сохраняют энергию и остаются связанными', () => {
    const state = allocTwoBody(1.1225, 0.1);
    const box = 200;
    const dt = 0.002;
    const forces = (): number => computePairForce(state, box);
    let potential = forces();
    const e0 = totalEnergy(state, potential);
    for (let s = 0; s < 20000; s++) {
      potential = verletStep(state, box, forces, dt);
    }
    const e1 = totalEnergy(state, potential);
    expect(Math.abs(e1 - e0)).toBeLessThan(1e-3);
  });
});

/** Две частицы, разнесённые по x. */
function allocTwoBody(r0: number, v0: number): ParticleState {
  const { state } = buildState('sc', 8, 0.5, 0, 1);
  state.count = 2;
  state.alive.fill(1);
  state.x[0] = 0;
  state.y[0] = 0;
  state.z[0] = 0;
  state.x[1] = r0;
  state.y[1] = 0;
  state.z[1] = 0;
  state.vx.fill(0);
  state.vy.fill(0);
  state.vz.fill(0);
  state.vx[1] = v0;
  state.fx.fill(0);
  state.fy.fill(0);
  state.fz.fill(0);
  return state;
}

/** Силы только для пары 0–1. */
function computePairForce(state: ParticleState, box: number): number {
  state.fx.fill(0);
  state.fy.fill(0);
  state.fz.fill(0);
  const dx = state.x[1] - state.x[0] - box * Math.round((state.x[1] - state.x[0]) / box);
  const r2 = dx * dx;
  const inv6 = 1 / (r2 * r2 * r2);
  const inv12 = inv6 * inv6;
  const f = (24 * (2 * inv12 - inv6)) / r2;
  state.fx[0] = -f * dx;
  state.fx[1] = f * dx;
  return 4 * (inv12 - inv6);
}
