/**
 * Тесты кампании: описания уровней и вычисление условий.
 *
 * Два разных предмета проверки.
 *
 * 1. **Данные уровней.** Опечатка в описании не роняет приложение — уровень
 *    просто становится непроходимым, и понять почему можно только вручную.
 *    Поэтому проверяются инварианты: уникальные идентификаторы, разумные
 *    параметры мира, положительное окно выхода на режим, непустая теория.
 *
 * 2. **Вычисление условий.** Здесь важно, чтобы `evaluateCheck` правильно
 *    понимал границы. Ошибка «строгое вместо нестрогого» или перепутанные
 *    `min`/`max` делают уровень проходимым при неверных условиях — а это
 *    хуже, чем непроходимый уровень, потому что незаметно.
 */

import { describe, expect, it } from 'vitest';
import { LEVELS, levelById, levelNumber, nextLevel } from '../levels/levels.js';
import { evaluateCheck, MeasurementWindow, type LevelMetrics } from '../levels/checks.js';
import { World } from '../core/world.js';

/** Мир для проверок условий. */
function makeWorld(): World {
  return new World(
    { count: 256, density: 0.8, cutoff: 2.5, dt: 0.004, temperature: 0.8, thermostat: 'langevin', boundary: 'periodic' },
    7,
    'fcc',
  );
}

/** Величины для проверок. */
function makeMetrics(overrides: Partial<LevelMetrics> = {}): LevelMetrics {
  const base: LevelMetrics = {
    temperature: 0.8,
    density: 0.8,
    mobility: 0.1,
    meanSpeed: 1.2,
    pressure: 1.0,
    orderPeak: 5.0,
    count: 1000,
    escaped: 0,
    confinedFraction: () => 1,
  };
  return { ...base, ...overrides };
}

describe('описания уровней', () => {
  it('идентификаторы уникальны и идут по порядку', () => {
    const ids = LEVELS.map((level) => level.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (let i = 0; i < LEVELS.length; i++) {
      expect(levelNumber(LEVELS[i])).toBe(i + 1);
    }
  });

  it('у каждого уровня есть цель, теория, подсказки и условия', () => {
    for (const level of LEVELS) {
      expect(level.title.length).toBeGreaterThan(0);
      expect(level.goal.length).toBeGreaterThan(10);
      expect(level.theory.length).toBeGreaterThan(80);
      expect(level.hints.length).toBeGreaterThanOrEqual(2);
      expect(level.checks.length).toBeGreaterThanOrEqual(2);
      expect(level.task.length).toBeGreaterThan(0);
    }
  });

  it('параметры мира у всех уровней осмысленны', () => {
    for (const level of LEVELS) {
      const setup = level.setup;
      expect(setup.count).toBeGreaterThanOrEqual(128);
      expect(setup.count).toBeLessThanOrEqual(20000);
      expect(setup.density).toBeGreaterThan(0.01);
      expect(setup.density).toBeLessThanOrEqual(1.4);
      expect(setup.temperature).toBeGreaterThan(0);
      expect(setup.temperature).toBeLessThanOrEqual(3);
      // Термостат и границы обязаны быть заданы явно, иначе уровень
      // унаследует значение по умолчанию и может не соответствовать описанию.
      expect(typeof setup.thermostat).toBe('string');
      expect(typeof setup.boundary).toBe('string');
    }
  });

  it('окно выхода на режим положительно и не бесконечно', () => {
    for (const level of LEVELS) {
      expect(level.equilibrate).toBeGreaterThanOrEqual(0);
      expect(level.equilibrate).toBeLessThanOrEqual(50000);
      expect(level.sampleWindow).toBeGreaterThan(0);
    }
  });

  it('условия уровня не противоречат друг другу', () => {
    // Условие с min > max непроходимо в принципе — это опечатка.
    for (const level of LEVELS) {
      for (const check of level.checks) {
        if ('min' in check && 'max' in check && check.min !== undefined && check.max !== undefined) {
          expect(check.min).toBeLessThanOrEqual(check.max);
        }
        expect(check.label.length).toBeGreaterThan(3);
      }
    }
  });

  it('навигация по уровням работает', () => {
    expect(levelById('level-01')?.title).toBe('Кристалл');
    expect(levelById('level-99')).toBeUndefined();
    expect(nextLevel('level-01')?.id).toBe('level-02');
    expect(nextLevel('level-10')).toBeUndefined();
  });

  it('первый уровень требует только наблюдения, последний — действия', () => {
    const first = LEVELS[0];
    const last = LEVELS[LEVELS.length - 1];
    // Первый уровень не должен требовать чего-то, что само не произойдёт:
    // его условия — только «система осталась кристаллом».
    for (const check of first.checks) {
      expect(['mobility', 'orderPeak', 'temperature']).toContain(check.kind);
    }
    // Последний — сборка: обязан требовать и плотность, и порядок.
    const kinds = last.checks.map((check) => check.kind);
    expect(kinds).toContain('density');
    expect(kinds).toContain('orderPeak');
  });
});

describe('вычисление условий', () => {
  const window = new MeasurementWindow();
  window.add('pressure', 3.5);
  window.add('totalEnergy', -100);
  window.addRange('totalEnergy', -100);
  window.addRange('totalEnergy', -99.5);
  window.add('energyDrop', -0.4);
  window.add('msdDelta', 2.5);
  window.size = 10;

  it('температура: границы включительные', () => {
    const world = makeWorld();
    const inside = evaluateCheck(
      { kind: 'temperature', min: 0.6, max: 1.0, label: '' },
      makeMetrics({ temperature: 0.6 }),
      window,
      world,
    );
    expect(inside.passed).toBe(true);
    const outside = evaluateCheck(
      { kind: 'temperature', min: 0.6, max: 1.0, label: '' },
      makeMetrics({ temperature: 0.59 }),
      window,
      world,
    );
    expect(outside.passed).toBe(false);
  });

  it('подвижность: только верхняя граница', () => {
    const world = makeWorld();
    const ok = evaluateCheck(
      { kind: 'mobility', max: 0.04, label: '' },
      makeMetrics({ mobility: 0.0 }),
      window,
      world,
    );
    expect(ok.passed).toBe(true);
    const bad = evaluateCheck(
      { kind: 'mobility', max: 0.04, label: '' },
      makeMetrics({ mobility: 0.05 }),
      window,
      world,
    );
    expect(bad.passed).toBe(false);
  });

  it('пик порядка g(r): нижняя граница отделяет кристалл от жидкости', () => {
    const world = makeWorld();
    // Уровень «Кристалл» требует пик ≥ 3.0; у жидкости он около 2.5.
    expect(
      evaluateCheck({ kind: 'orderPeak', min: 3.0, label: '' }, makeMetrics({ orderPeak: 3.0 }), window, world).passed,
    ).toBe(true);
    expect(
      evaluateCheck({ kind: 'orderPeak', min: 3.0, label: '' }, makeMetrics({ orderPeak: 2.5 }), window, world).passed,
    ).toBe(false);
  });

  it('исчезнувшие частицы считаются по стартовому числу', () => {
    const world = makeWorld();
    const result = evaluateCheck(
      { kind: 'escaped', min: 40, label: '' },
      makeMetrics({ escaped: 55 }),
      window,
      world,
    );
    expect(result.passed).toBe(true);
  });

  it('доля связанных частиц берётся из метрик', () => {
    const world = makeWorld();
    const together = evaluateCheck(
      { kind: 'confinement', radius: 14, min: 0.8, label: '' },
      makeMetrics({ confinedFraction: () => 0.9 }),
      window,
      world,
    );
    expect(together.passed).toBe(true);
    const spread = evaluateCheck(
      { kind: 'confinement', radius: 14, min: 0.8, label: '' },
      makeMetrics({ confinedFraction: () => 0.2 }),
      window,
      world,
    );
    expect(spread.passed).toBe(false);
  });

  it('величины из окна используются для средних', () => {
    const world = makeWorld();
    // Давление в окне равно 3.5 — условие ≥ 2 обязано выполняться.
    expect(
      evaluateCheck({ kind: 'pressure', min: 2, label: '' }, makeMetrics(), window, world).passed,
    ).toBe(true);
    // MSD в окне 2.5.
    expect(
      evaluateCheck({ kind: 'msd', min: 1.5, label: '' }, makeMetrics(), window, world).passed,
    ).toBe(true);
    // Энергия упала на 40 % — условие «не меньше 25 %» выполняется.
    expect(
      evaluateCheck({ kind: 'energyDrop', max: -0.25, label: '' }, makeMetrics(), window, world).passed,
    ).toBe(true);
  });

  it('пустое окно не даёт ложного прохождения', () => {
    const world = makeWorld();
    const empty = new MeasurementWindow();
    // Условия по средним без данных обязаны НЕ проходить: иначе уровень
    // засчитается сразу после старта, до всякой симуляции.
    expect(
      evaluateCheck({ kind: 'msd', min: 1.5, label: '' }, makeMetrics(), empty, world).passed,
    ).toBe(false);
    expect(
      evaluateCheck({ kind: 'pressure', min: 2, label: '' }, makeMetrics(), empty, world).passed,
    ).toBe(false);
    expect(
      evaluateCheck({ kind: 'energyDrift', max: 0.01, label: '' }, makeMetrics(), empty, world).passed,
    ).toBe(false);
  });

  it('термостат и границы читаются из мира, а не из метрик', () => {
    const world = makeWorld();
    // Мир создан с термостатом Ланжевена и периодическими границами.
    expect(
      evaluateCheck({ kind: 'thermostat', value: 'langevin', label: '' }, makeMetrics(), window, world).passed,
    ).toBe(true);
    expect(
      evaluateCheck({ kind: 'thermostat', value: 'none', label: '' }, makeMetrics(), window, world).passed,
    ).toBe(false);
    expect(
      evaluateCheck({ kind: 'boundary', value: 'periodic', label: '' }, makeMetrics(), window, world).passed,
    ).toBe(true);
    expect(
      evaluateCheck({ kind: 'boundary', value: 'reflective', label: '' }, makeMetrics(), window, world).passed,
    ).toBe(false);
  });

  it('дрейф энергии считается относительным размахом', () => {
    const world = makeWorld();
    // В окне энергия прошла от −100 до −99.5, то есть размах 0.5 % от 100.
    const result = evaluateCheck(
      { kind: 'energyDrift', max: 0.01, label: '' },
      makeMetrics(),
      window,
      world,
    );
    expect(result.passed).toBe(true);
    expect(result.value).toBeCloseTo(0.005, 5);

    const strict = evaluateCheck(
      { kind: 'energyDrift', max: 0.001, label: '' },
      makeMetrics(),
      window,
      world,
    );
    expect(strict.passed).toBe(false);
  });

  it('плотность проверяется по значению мира', () => {
    const world = makeWorld();
    const lower = evaluateCheck(
      { kind: 'density', min: 0.85, label: '' },
      makeMetrics({ density: 0.7 }),
      window,
      world,
    );
    expect(lower.passed).toBe(false);
    const reached = evaluateCheck(
      { kind: 'density', min: 0.85, label: '' },
      makeMetrics({ density: 0.9 }),
      window,
      world,
    );
    expect(reached.passed).toBe(true);
  });
});

describe('окно измерений', () => {
  it('усредняет добавленные значения', () => {
    const w = new MeasurementWindow();
    w.add('x', 1);
    w.add('x', 3);
    expect(w.mean('x')).toBeCloseTo(2, 10);
  });

  it('размах считается по первому и последнему значению', () => {
    const w = new MeasurementWindow();
    w.addRange('e', -100);
    w.addRange('e', -98);
    w.addRange('e', -99);
    // Размах — от первого до последнего, а не минимум/максимум.
    expect(w.range('e')).toBe(1);
  });

  it('пустое окно даёт NaN, а не ноль', () => {
    const w = new MeasurementWindow();
    expect(Number.isNaN(w.mean('нет'))).toBe(true);
    expect(Number.isNaN(w.range('нет'))).toBe(true);
  });

  it('сброс очищает накопленное', () => {
    const w = new MeasurementWindow();
    w.add('x', 5);
    w.addRange('e', 1);
    w.reset();
    expect(Number.isNaN(w.mean('x'))).toBe(true);
    expect(Number.isNaN(w.range('e'))).toBe(true);
  });

  it('нечисловые значения не попадают в окно', () => {
    const w = new MeasurementWindow();
    w.add('x', Number.NaN);
    w.add('x', Number.POSITIVE_INFINITY);
    expect(Number.isNaN(w.mean('x'))).toBe(true);
  });
});
