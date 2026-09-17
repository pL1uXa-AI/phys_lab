/**
 * Тесты эксперимента с фазовым переходом.
 *
 * Проверяется не «код не падает», а что кривая несёт физический смысл:
 * при плавлении энергия меняется в правильную сторону, теплоёмкость даёт
 * пик, а ветви нагрева и охлаждения расходятся (гистерезис перехода
 * первого рода). Если расхождения нет — эксперимент бесполезен, потому
 * что тогда он не отличает переход от плавного изменения.
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_EXPERIMENT,
  hysteresisWidth,
  PhaseExperiment,
  counterpartConfig,
  totalPlannedSteps,
  type ExperimentConfig,
} from '../core/experiment.js';

/** Быстрая конфигурация: тесты не должны идти минутами. */
function quickConfig(overrides: Partial<ExperimentConfig> = {}): ExperimentConfig {
  return {
    ...DEFAULT_EXPERIMENT,
    count: 108,
    temperatures: [0.4, 0.6, 0.75, 0.9, 1.1],
    equilibrate: 400,
    sample: 400,
    sampleEvery: 4,
    ...overrides,
  };
}

/** Довести эксперимент до конца. */
function runToEnd(experiment: PhaseExperiment, batch = 4000): void {
  let guard = 0;
  while (!experiment.done && guard < 10000) {
    experiment.advance(batch);
    guard++;
  }
}

describe('эксперимент: кривая фазового перехода', () => {
  it('проходит все температуры свипа и даёт по точке на каждую', () => {
    const config = quickConfig();
    const experiment = new PhaseExperiment(config);
    runToEnd(experiment);

    const result = experiment.result();
    expect(experiment.done).toBe(true);
    expect(result.points).toHaveLength(config.temperatures.length);
    // Температуры точек обязаны идти как задано.
    expect(result.points.map((p) => p.temperature)).toEqual(config.temperatures);
    for (const point of result.points) {
      expect(point.samples).toBeGreaterThan(10);
      expect(Number.isFinite(point.energy)).toBe(true);
      expect(Number.isFinite(point.heatCapacity)).toBe(true);
    }
  });

  it('прогресс растёт от 0 до 1 и не превышает единицу', () => {
    const experiment = new PhaseExperiment(quickConfig());
    expect(experiment.progress).toBe(0);
    const seen: number[] = [];
    for (let i = 0; i < 40 && !experiment.done; i++) {
      experiment.advance(300);
      seen.push(experiment.progress);
    }
    for (const value of seen) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
    // Прогресс обязан именно расти, а не «дёргаться».
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1]);
    expect(experiment.progress).toBeCloseTo(1, 6);
  });

  it('advance не делает больше шагов, чем попросили', () => {
    // Это важно для интерфейса: если `advance` перебирает, кадр подвиснет.
    const experiment = new PhaseExperiment(quickConfig({ equilibrate: 10000 }));
    const performed = experiment.advance(50);
    expect(performed).toBe(50);
    void totalPlannedSteps;
  });

  it('внутренняя энергия растёт с температурой', () => {
    // Нагретая система сидит выше по энергии: это базовая проверка, что
    // эксперимент вообще считает то, что заявлено.
    const experiment = new PhaseExperiment(quickConfig());
    runToEnd(experiment);
    const points = experiment.result().points;
    const cold = points[0];
    const hot = points[points.length - 1];
    expect(hot.energy).toBeGreaterThan(cold.energy);
  });

  it('фактическая температура сходится к заданной', () => {
    /*
     * Термостат обязан удерживать T*: если он систематически врёт, вся кривая
     * сдвинута, и «точка перехода» получится не там.
     *
     * Проверяется СРЕДНЕЕ отклонение по свипу, а не каждое по отдельности.
     * Отдельная точка флуктуирует: T* — мгновенная величина, усреднённая по
     * конечному окну, а система конечного размера. Требовать малого
     * отклонения в каждой точке значило бы проверять не работу термостата,
     * а везение конкретного запуска.
     */
    const experiment = new PhaseExperiment(quickConfig());
    runToEnd(experiment);
    const points = experiment.result().points;
    let totalDeviation = 0;
    let maxDeviation = 0;
    for (const point of points) {
      const deviation = Math.abs(point.measuredTemperature - point.temperature);
      totalDeviation += deviation;
      maxDeviation = Math.max(maxDeviation, deviation);
    }
    const meanDeviation = totalDeviation / points.length;
    expect(meanDeviation).toBeLessThan(0.06);
    // Ни одна точка не должна уехать слишком далеко: это признак того, что
    // система не успела выйти на режим за отведённое равновесие.
    expect(maxDeviation).toBeLessThan(0.15);
  });

  it('теплоёмкость неотрицательна и не бесконечна', () => {
    const experiment = new PhaseExperiment(quickConfig());
    runToEnd(experiment);
    for (const point of experiment.result().points) {
      expect(point.heatCapacity).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(point.heatCapacity)).toBe(true);
      // Теплоёмкость на частицу в приведённых единицах — величина порядка
      // единиц; сотни означали бы ошибку в нормировке.
      expect(point.heatCapacity).toBeLessThan(100);
    }
  });

  it('энергия испытывает скачок — признак перехода первого рода', () => {
    /*
     * ─── Почему проверяется скачок, а не пик C_v ─────────────────────────
     *
     * Идеальный ГЦК-кристалл при периодических границах ПЕРЕГРЕВАЕТСЯ:
     * плавление начинается с зародыша (поверхности или дефекта), а в
     * однородной решётке зародыша нет, и она остаётся метастабильной выше
     * точки плавления. Измерено на этой системе: при плотности 0.95
     * равновесная температура плавления T* ≈ 0.7, но скачок энергии
     * наблюдается между T* = 1.2 и 1.3 — решётка «терпит» перегрев.
     *
     * Поэтому проверять положение пика в окне вокруг 0.7 было бы неверно:
     * тест ловил бы не физику, а отсутствие зародышей. Здесь проверяется
     * то, что устойчиво воспроизводится: СКАЧОК энергии на кривой, то есть
     * разрыв производной — признак перехода первого рода.
     *
     * Скрытая теплота уходит именно в этот скачок: между соседними
     * температурами энергия меняется в разы сильнее, чем на остальной
     * кривой, где она растёт почти линейно.
     */
    const experiment = new PhaseExperiment({
      // 500 частиц, а не 256: скачок энергии при плавлении конечен, а
      // флуктуации энергии падают как 1/√N. На 256 частицах скачок сравним
      // с шумом (измерено: максимальный перепад 0.27 против типичного 0.31),
      // и проверка ловила бы случайность. На 500 различие устойчиво.
      count: 500,
      density: 0.95,
      temperatures: [0.9, 1.0, 1.1, 1.2, 1.25, 1.3, 1.4],
      equilibrate: 1500,
      sample: 1500,
      sampleEvery: 4,
      lattice: 'fcc',
      branch: 'heating',
      seed: 20260214,
    });
    runToEnd(experiment);
    const points = experiment.result().points;

    // Перепад энергии между соседними температурами.
    let maxJump = 0;
    let typicalJump = 0;
    for (let i = 1; i < points.length; i++) {
      const jump = Math.abs(points[i].energy - points[i - 1].energy);
      maxJump = Math.max(maxJump, jump);
      typicalJump += jump;
    }
    typicalJump /= Math.max(1, points.length - 1);

    // Скачок обязан быть заметно больше среднего шага: иначе это не переход,
    // а просто наклон кривой.
    expect(maxJump).toBeGreaterThan(typicalJump * 1.8);
    // И энергия при нагреве растёт, а не падает.
    expect(points[points.length - 1].energy).toBeGreaterThan(points[0].energy);
  });

  it('ветви нагрева и охлаждения расходятся (гистерезис первого рода)', () => {
    // Это главная содержательная проверка эксперимента. Если расхождения
    // нет, значит ветви идут по одной кривой — и тогда эксперимент не
    // показывает переход, а просто рисует гладкую функцию.
    const base: Partial<ExperimentConfig> = {
      count: 256,
      density: 0.95,
      temperatures: [0.9, 1.1, 1.2, 1.3, 1.4],
      equilibrate: 900,
      sample: 900,
      sampleEvery: 4,
    };
    const heating = new PhaseExperiment({ ...base, branch: 'heating', lattice: 'fcc' } as ExperimentConfig);
    runToEnd(heating);

    // Охлаждение идёт по тем же температурам в обратном порядке, стартуя
    // с уже расплавленной системы.
    const cooling = new PhaseExperiment({
      ...base,
      branch: 'cooling',
      lattice: 'fcc',
      temperatures: [...(base.temperatures as number[])].reverse(),
    } as ExperimentConfig);
    runToEnd(cooling);

    const gap = hysteresisWidth(heating.result(), cooling.result());
    // Ширина петли должна быть различима на фоне шага по температуре.
    expect(gap.maxGap).toBeGreaterThan(0.005);
  });

  it('энергия и давление конечны на всём свипе, система не разлетается', () => {
    const experiment = new PhaseExperiment(quickConfig());
    runToEnd(experiment);
    for (const point of experiment.result().points) {
      expect(Number.isFinite(point.energy)).toBe(true);
      expect(Number.isFinite(point.pressure)).toBe(true);
      expect(Math.abs(point.energy)).toBeLessThan(100);
    }
    // Ограничитель скорости не должен срабатывать: срабатывание означало бы,
    // что эксперимент «нагревает и сжимает» до неустойчивости.
    expect(experiment.simulation.speedClampedCount).toBe(0);
  });

  it('результат воспроизводим при одном и том же зерне', () => {
    // Без воспроизводимости нельзя ни отладить редкий случай, ни сравнить
    // два запуска.
    const config = quickConfig({ temperatures: [0.6, 0.8], equilibrate: 300, sample: 300 });
    const first = new PhaseExperiment(config);
    runToEnd(first);
    const second = new PhaseExperiment(config);
    runToEnd(second);

    const a = first.result().points;
    const b = second.result().points;
    expect(a).toHaveLength(b.length);
    for (let i = 0; i < a.length; i++) {
      expect(a[i].energy).toBe(b[i].energy);
      expect(a[i].heatCapacity).toBe(b[i].heatCapacity);
    }
  });

  it('парная конфигурация меняет и направление, и начальную структуру', () => {
    const heating = counterpartConfig({ ...DEFAULT_EXPERIMENT, branch: 'cooling', lattice: 'random' });
    expect(heating.branch).toBe('heating');
    expect(heating.lattice).toBe('fcc');

    const cooling = counterpartConfig(heating);
    expect(cooling.branch).toBe('cooling');
    expect(cooling.lattice).toBe('random');
    // Температуры — копия, а не общая ссылка: иначе правка одной ветви
    // молча изменила бы другую.
    expect(cooling.temperatures).not.toBe(heating.temperatures);
    expect(cooling.temperatures).toEqual(heating.temperatures);
  });

  it('общее число шагов считается верно', () => {
    const config = quickConfig({ temperatures: [0.5, 0.6, 0.7], equilibrate: 100, sample: 200 });
    expect(totalPlannedSteps(config)).toBe(3 * 300);
  });

  it('до завершения result() отдаёт уже посчитанные точки', () => {
    // Интерфейс рисует кривую по мере готовности, а не ждёт конца.
    const experiment = new PhaseExperiment(quickConfig({ equilibrate: 50, sample: 50, sampleEvery: 2 }));
    experiment.advance(200);
    const partial = experiment.result();
    expect(partial.points.length).toBeGreaterThan(0);
    expect(partial.points.length).toBeLessThan(5);
  });

  it('повторный advance после завершения не делает шагов', () => {
    const experiment = new PhaseExperiment(quickConfig({ temperatures: [0.7], equilibrate: 50, sample: 50 }));
    runToEnd(experiment);
    expect(experiment.done).toBe(true);
    expect(experiment.advance(1000)).toBe(0);
  });
});
