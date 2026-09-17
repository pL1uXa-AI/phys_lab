/**
 * Нагрузочные проверки производительности.
 *
 * Запуск: `npm run bench`
 *
 * Это НЕ обычные тесты. Их задача — поймать регрессию производительности,
 * а не проверить корректность. Пороги намеренно щедрые: они рассчитаны на
 * самую медленную машину, где проект вообще имеет смысл запускать, и падают
 * только при качественном ухудшении (например, возврате O(N²) в g(r) или
 * отключении списков соседей).
 *
 * Историческая справка (20 000 частиц, один поток Node):
 *   до оптимизаций: шаг 52 мс, кадр g(r) 1904 мс
 *   после:          шаг 14 мс, кадр g(r)   42 мс
 */

import { describe, expect, it } from 'vitest';
import { World } from '../core/world.js';

/** Мир под нагрузочный замер. */
function makeWorld(count: number): World {
  return new World(
    {
      count,
      density: 0.7,
      cutoff: 2.5,
      dt: 0.004,
      temperature: 1.0,
      thermostat: 'langevin',
      boundary: 'periodic',
    },
    1,
    'fcc',
  );
}

/** Среднее время операции в миллисекундах. */
function timeMs(reps: number, fn: () => void): number {
  // Прогрев: первый вызов включает построение списка соседей и заполнение
  // кэшей, и без него замер показал бы не установившийся режим.
  fn();
  const t0 = performance.now();
  for (let i = 0; i < reps; i++) fn();
  return (performance.now() - t0) / reps;
}

describe('производительность ядра', () => {
  it('шаг на 2 000 частиц дешевле 8 мс', () => {
    const world = makeWorld(2048);
    const ms = timeMs(200, () => world.step());
    // eslint-disable-next-line no-console
    console.log(`        2 048 частиц: ${ms.toFixed(2)} мс/шаг`);
    expect(ms).toBeLessThan(8);
  });

  it('шаг на 8 000 частиц дешевле 25 мс', () => {
    const world = makeWorld(8000);
    const ms = timeMs(120, () => world.step());
    // eslint-disable-next-line no-console
    console.log(`        8 000 частиц: ${ms.toFixed(2)} мс/шаг`);
    expect(ms).toBeLessThan(25);
  });

  it('шаг на 20 000 частиц дешевле 60 мс', () => {
    const world = makeWorld(20000);
    const ms = timeMs(60, () => world.step());
    // eslint-disable-next-line no-console
    console.log(`       20 000 частиц: ${ms.toFixed(2)} мс/шаг`);
    expect(ms).toBeLessThan(60);
  });

  it('стоимость шага растёт линейно, а не квадратично', () => {
    const small = makeWorld(2048);
    const large = makeWorld(20000);
    const smallMs = timeMs(150, () => small.step());
    const largeMs = timeMs(50, () => large.step());
    const ratio = largeMs / smallMs;
    // Частиц в 9.8 раза больше. Линейный рост — ×9.8, квадратичный — ×95.
    // Порог ×20 отделяет одно от другого с большим запасом.
    // eslint-disable-next-line no-console
    console.log(`        рост стоимости: ×${ratio.toFixed(1)} при ×9.8 частиц`);
    expect(ratio).toBeLessThan(20);
  });

  it('кадр статистики g(r) на 20 000 частиц дешевле 150 мс', () => {
    const world = makeWorld(20000);
    for (let i = 0; i < 50; i++) world.step();
    const ms = timeMs(15, () => world.sampleRadial());
    // eslint-disable-next-line no-console
    console.log(`        g(r) на 20 000 частиц: ${ms.toFixed(1)} мс`);
    // Было 1904 мс при честном переборе всех пар.
    expect(ms).toBeLessThan(150);
  });

  it('список соседей живёт много шагов (кожа окупается)', () => {
    const world = makeWorld(8000);
    for (let i = 0; i < 200; i++) world.step();
    const before = world.neighbourStats.rebuilds;
    for (let i = 0; i < 100; i++) world.step();
    const rebuilds = world.neighbourStats.rebuilds - before;
    const every = rebuilds > 0 ? 100 / rebuilds : Infinity;
    // eslint-disable-next-line no-console
    console.log(`        перестроение каждые ${every.toFixed(1)} шагов`);
    // Если список перестраивается каждый шаг, «кожа» не работает и
    // построение съедает всю выгоду.
    expect(every).toBeGreaterThan(3);
  });

  it('проекция и раскраска дешевле шага физики', () => {
    const world = makeWorld(20000);
    const out = new Float32Array(world.state.count * 3);
    const stepMs = timeMs(50, () => world.step());
    const projectMs = timeMs(200, () => world.project(0.6, 0.9, out));
    const colorMs = timeMs(200, () => world.colorValues('speed'));
    // eslint-disable-next-line no-console
    console.log(
      `        шаг ${stepMs.toFixed(2)} мс, проекция ${projectMs.toFixed(3)} мс, ` +
        `раскраска ${colorMs.toFixed(3)} мс`,
    );
    // Рендер обязан быть на порядок дешевле физики, иначе он станет узким
    // местом кадра.
    expect(projectMs + colorMs).toBeLessThan(stepMs);
  });
});
