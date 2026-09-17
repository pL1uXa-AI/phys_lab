/**
 * Тесты потенциала Леннарда-Джонса.
 *
 * Проверяем не «код работает», а физику: положение минимума, его глубину,
 * нуль потенциала, знак силы и совпадение аналитической силы с численной
 * производной энергии. Последняя проверка ловит опечатку в показателе
 * степени, которую не заметит ни один тест «на значения»: сила всё равно
 * будет похожа на правильную.
 */

import { describe, expect, it } from 'vitest';
import {
  LJ_MIN_ENERGY,
  LJ_MIN_RADIUS,
  ljEnergy,
  ljForce,
  ljForceOverR,
  ljShift,
  virialCoefficient,
} from '../core/potential.js';

const CUTOFF = 2.5;
const SHIFT = ljShift(CUTOFF);

/** Энергия без сдвига — чтобы сверяться с учебной формулой. */
function rawEnergy(r: number): number {
  const inv6 = 1 / (r * r * r * r * r * r);
  return 4 * (inv6 * inv6 - inv6);
}

describe('потенциал Леннарда-Джонса', () => {
  it('минимум достигается при r = 2^(1/6) и равен −ε', () => {
    expect(rawEnergy(LJ_MIN_RADIUS)).toBeCloseTo(LJ_MIN_ENERGY, 10);
    expect(LJ_MIN_RADIUS).toBeCloseTo(1.122462048309373, 12);
  });

  it('потенциал обращается в ноль при r = σ', () => {
    expect(rawEnergy(1)).toBeCloseTo(0, 12);
  });

  it('энергия на радиусе обрезания равна нулю', () => {
    expect(ljEnergy(CUTOFF * CUTOFF, SHIFT)).toBeCloseTo(0, 12);
  });

  it('энергия согласована с силой: U_sf(r) = U(r) − U(rc) + ½s(r² − rc²)', () => {
    // Слагаемое ½s(r²−rc²) не косметическое: без него производная энергии
    // перестаёт совпадать с силой и симплектический интегратор «греет» систему.
    const r = 1.3;
    const r2 = r * r;
    const expected =
      rawEnergy(r) - rawEnergy(CUTOFF) + 0.5 * SHIFT.forceOverR * (r2 - CUTOFF * CUTOFF);
    expect(ljEnergy(r2, SHIFT)).toBeCloseTo(expected, 12);
  });

  it('сила отталкивает вблизи и притягивает на средних расстояниях', () => {
    // F/r > 0 — отталкивание; F/r < 0 — притяжение.
    expect(ljForceOverR(0.9 * 0.9, SHIFT)).toBeGreaterThan(0);
    expect(ljForceOverR(1.3 * 1.3, SHIFT)).toBeLessThan(0);
  });

  it('сила непрерывна на радиусе обрезания (shifted-force)', () => {
    expect(Math.abs(ljForceOverR(2.4999 * 2.4999, SHIFT))).toBeLessThan(1e-4);
    expect(Math.abs(ljForceOverR(CUTOFF * CUTOFF, SHIFT))).toBeLessThan(1e-12);
  });

  it('аналитическая сила совпадает с численной производной энергии', () => {
    const h = 1e-6;
    for (const r of [0.95, 1.05, 1.2, 1.6, 2.0, 2.4]) {
      // Сила F = −dU/dr, значит F/r = −(dU/dr)/r.
      const forward = ljEnergy((r + h) * (r + h), SHIFT);
      const backward = ljEnergy((r - h) * (r - h), SHIFT);
      const numerical = -(forward - backward) / (2 * h) / r;
      expect(ljForceOverR(r * r, SHIFT)).toBeCloseTo(numerical, 5);
    }
  });

  it('вектор силы направлен от соседа (отталкивание при сжатии)', () => {
    // Частица j справа от i (dx > 0) на сжатом расстоянии: сила на i должна
    // быть направлена ВЛЕВО, то есть иметь отрицательную x-компоненту.
    // Ошибка знака здесь делает систему притягивающейся и «взрывает»
    // интегратор за десятки шагов, никак не проявляясь в модуле силы.
    const [fx, fy, fz] = ljForce(0.9, 0, 0, SHIFT);
    expect(fx).toBeLessThan(0);
    expect(fy).toBeCloseTo(0, 12);
    expect(fz).toBeCloseTo(0, 12);

    // Та же пара на расстоянии притяжения: сила на i направлена ВПРАВО.
    const [ax, ay, az] = ljForce(1.4, 0, 0, SHIFT);
    expect(ax).toBeGreaterThan(0);
    expect(ay).toBeCloseTo(0, 12);
    expect(az).toBeCloseTo(0, 12);

    // Направление по оси y — чтобы знак не оказался случайно верным
    // только для x.
    const [bx, by] = ljForce(0, 0.9, 0, SHIFT);
    expect(bx).toBeCloseTo(0, 12);
    expect(by).toBeLessThan(0);
  });

  it('модуль силы не зависит от ориентации пары', () => {
    const a = ljForce(0.8, 0.4, -0.2, SHIFT);
    const b = ljForce(-0.4, 0.8, -0.2, SHIFT);
    const norm = (v: number[]): number => Math.hypot(v[0], v[1], v[2]);
    expect(norm(a)).toBeCloseTo(norm(b), 12);
  });

  it('сила антисимметрична: F(i→j) = −F(j→i)', () => {
    const f = ljForce(0.7, -0.5, 0.3, SHIFT);
    const g = ljForce(-0.7, 0.5, -0.3, SHIFT);
    expect(f[0]).toBeCloseTo(-g[0], 12);
    expect(f[1]).toBeCloseTo(-g[1], 12);
    expect(f[2]).toBeCloseTo(-g[2], 12);
  });

  it('второй вириальный коэффициент при высокой T положителен', () => {
    // Слабое притяжение при высокой температуре → B2 > 0.
    expect(virialCoefficient(5)).toBeGreaterThan(0);
  });

  it('второй вириальный коэффициент при низкой T отрицателен', () => {
    // Притяжение побеждает → B2 < 0, газ конденсируется.
    expect(virialCoefficient(0.5)).toBeLessThan(0);
  });
});
