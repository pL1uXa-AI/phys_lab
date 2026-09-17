/**
 * Тесты генератора случайных чисел и построения состояний.
 *
 * Генератор — фундамент воспроизводимости: если он не детерминирован
 * или даёт смещённое распределение, «одинаковые» запуски расходятся,
 * а максвелловские скорости приводят к неверной температуре.
 */

import { describe, expect, it } from 'vitest';
import { Rng } from '../core/rng.js';
import { buildState } from '../core/initializers.js';
import { kineticEnergyOfState, removeDriftNow } from '../core/velocity.js';

describe('генератор псевдослучайных чисел', () => {
  it('одинаковое зерно даёт одинаковую последовательность', () => {
    const a = new Rng(42);
    const b = new Rng(42);
    for (let i = 0; i < 100; i++) expect(a.nextUint32()).toBe(b.nextUint32());
  });

  it('разные зёрна дают разные последовательности', () => {
    const a = new Rng(1);
    const b = new Rng(2);
    let same = 0;
    for (let i = 0; i < 100; i++) if (a.nextUint32() === b.nextUint32()) same++;
    expect(same).toBeLessThan(5);
  });

  it('равномерное распределение: среднее ≈ 0.5, все квартили заняты', () => {
    const rng = new Rng(7);
    let sum = 0;
    const buckets = new Array(10).fill(0);
    const n = 100000;
    for (let i = 0; i < n; i++) {
      const v = rng.next();
      sum += v;
      buckets[Math.min(9, Math.floor(v * 10))]++;
    }
    expect(sum / n).toBeCloseTo(0.5, 2);
    for (const count of buckets) {
      // Ожидание 10 000, допуск 5 %.
      expect(Math.abs(count - n / 10)).toBeLessThan(n / 200);
    }
  });

  it('нормальное распределение: среднее 0, дисперсия 1', () => {
    const rng = new Rng(11);
    const n = 200000;
    let sum = 0;
    let sumSq = 0;
    for (let i = 0; i < n; i++) {
      const v = rng.normal();
      sum += v;
      sumSq += v * v;
    }
    expect(sum / n).toBeCloseTo(0, 2);
    expect(sumSq / n).toBeCloseTo(1, 1);
  });

  it('сохранение и восстановление состояния продолжает ту же серию', () => {
    const rng = new Rng(99);
    for (let i = 0; i < 17; i++) rng.next();
    const saved = rng.save();
    const expected = [rng.next(), rng.next(), rng.next()];
    const other = new Rng(1);
    other.restore(saved);
    expect([other.next(), other.next(), other.next()]).toEqual(expected);
  });

  it('вектор на сфере единичной длины', () => {
    const rng = new Rng(5);
    for (let i = 0; i < 200; i++) {
      const [x, y, z] = rng.unitVector();
      expect(Math.hypot(x, y, z)).toBeCloseTo(1, 10);
    }
  });
});

describe('построение начальных состояний', () => {
  it('ГЦК-решётка даёт идеальную структуру заданной плотности', () => {
    const { state, placed, box } = buildState('fcc', 500, 0.9, 0.2, 1);
    // Число частиц округляется до ближайшего представимого: 4n³.
    expect(placed).toBe(500);
    expect(state.count).toBe(500);
    expect(state.alive[0]).toBe(1);
    expect(state.alive[499]).toBe(1);
    // Плотность согласована с ящиком — это то, что раньше было сломано.
    expect(500 / (box * box * box)).toBeCloseTo(0.9, 9);
  });

  it('число частиц округляется до 4n³, а плотность остаётся точной', () => {
    for (const requested of [100, 1000, 2000, 9999]) {
      const { placed, box } = buildState('fcc', requested, 0.7, 0.5, 2);
      expect(placed % 4).toBe(0);
      expect(Math.cbrt(placed / 4)).toBeCloseTo(Math.round(Math.cbrt(placed / 4)), 9);
      expect(placed / (box * box * box)).toBeCloseTo(0.7, 9);
    }
  });

  it('координаты лежат внутри ящика', () => {
    const { state, box } = buildState('fcc', 300, 0.8, 1.0, 3);
    for (let i = 0; i < state.count; i++) {
      expect(state.x[i]).toBeGreaterThanOrEqual(0);
      expect(state.x[i]).toBeLessThan(box + 1e-9);
      expect(state.y[i]).toBeGreaterThanOrEqual(0);
      expect(state.z[i]).toBeGreaterThanOrEqual(0);
    }
  });

  it('в ГЦК-решётке расстояние между соседями равно шагу решётки', () => {
    const requested = 500;
    const density = 0.9;
    const { state, box } = buildState('fcc', requested, density, 0.1, 4);
    // В идеальной ГЦК ближайшее расстояние a/√2, где a = L/n, n³·4 = N.
    const cells = Math.round(Math.cbrt(state.count / 4));
    const a = box / cells;
    const nearest = a / Math.SQRT2;
    let minDistance = Number.POSITIVE_INFINITY;
    for (let i = 0; i < state.count; i++) {
      for (let j = i + 1; j < state.count; j++) {
        let dx = state.x[j] - state.x[i];
        let dy = state.y[j] - state.y[i];
        let dz = state.z[j] - state.z[i];
        dx -= box * Math.round(dx / box);
        dy -= box * Math.round(dy / box);
        dz -= box * Math.round(dz / box);
        minDistance = Math.min(minDistance, Math.hypot(dx, dy, dz));
      }
    }
    expect(minDistance).toBeCloseTo(nearest, 9);
    // Никаких вакансий: узлов ровно столько, сколько частиц, и все заняты.
    expect(state.count).toBe(4 * cells * cells * cells);
  });

  it('скорости соответствуют заданной температуре точно', () => {
    const { state } = buildState('fcc', 400, 0.85, 1.25, 5);
    removeDriftNow(state);
    const dof = 3 * state.count - 3;
    const temperature = (2 * kineticEnergyOfState(state)) / dof;
    // Инициализация нормирует температуру точно, а не «примерно».
    expect(temperature).toBeCloseTo(1.25, 6);
  });

  it('капля занимает центр ящика и не касается стенок', () => {
    const { state, box, placed } = buildState('droplet', 800, 0.3, 0.5, 6);
    expect(placed).toBeGreaterThan(400);
    const center = box / 2;
    for (let i = 0; i < placed; i++) {
      const d = Math.hypot(state.x[i] - center, state.y[i] - center, state.z[i] - center);
      expect(d).toBeLessThan(box / 2);
    }
  });

  it('случайный газ не создаёт близких пар', () => {
    const { state, box } = buildState('random', 200, 0.1, 0.8, 7);
    let tooClose = 0;
    for (let i = 0; i < state.count; i++) {
      for (let j = i + 1; j < state.count; j++) {
        let dx = state.x[j] - state.x[i];
        let dy = state.y[j] - state.y[i];
        let dz = state.z[j] - state.z[i];
        dx -= box * Math.round(dx / box);
        dy -= box * Math.round(dy / box);
        dz -= box * Math.round(dz / box);
        if (dx * dx + dy * dy + dz * dz < 0.64) tooClose++;
      }
    }
    expect(tooClose).toBe(0);
  });
});
