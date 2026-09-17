/**
 * Замеры производительности ядра.
 *
 * Запуск: npx vite-node scripts/bench-hot.ts
 *
 * Эти скрипты не участвуют в сборке и не запускаются автоматически: они нужны,
 * когда меняешь горячий код и хочешь увидеть эффект в числах, а не на глаз.
 * Исторические замеры и разбор оптимизаций — в README, раздел
 * «Производительность».
 *
 *   bench-hot.ts    — шаг физики, g(r), проекция, раскраска на 2k/8k/20k
 *   bench-list.ts   — как часто перестраивается список соседей и во что это
 *                     обходится
 *   bench-skin.ts   — подбор толщины «кожи»: полный шаг для разных значений
 */
import { World } from '../src/core/world.js';

function bench(count: number): void {
  const world = new World(
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
  const n = world.state.count;

  // Прогрев: первый шаг включает построение списка соседей, и без прогрева
  // замер показал бы его стоимость, а не установившийся режим.
  for (let i = 0; i < 50; i++) world.step();

  const steps = 400;
  let t0 = performance.now();
  for (let i = 0; i < steps; i++) world.step();
  const stepMs = (performance.now() - t0) / steps;

  t0 = performance.now();
  for (let i = 0; i < 20; i++) world.sampleRadial();
  const radialMs = (performance.now() - t0) / 20;

  t0 = performance.now();
  const projected = new Float32Array(n * 3);
  for (let i = 0; i < 200; i++) world.project(0.6, 0.9, projected);
  const projectMs = (performance.now() - t0) / 200;

  t0 = performance.now();
  for (let i = 0; i < 200; i++) world.colorValues('speed');
  const colorMs = (performance.now() - t0) / 200;

  const stats = world.neighbourStats;
  console.log(
    `N=${n}: шаг ${stepMs.toFixed(3)} мс | g(r) ${radialMs.toFixed(2)} мс | ` +
      `проекция ${projectMs.toFixed(3)} мс | цвета ${colorMs.toFixed(3)} мс`,
  );
  console.log(
    `  8 шагов/кадр = ${(stepMs * 8).toFixed(2)} мс · ` +
      `g(r) каждые 40 шагов = ${((radialMs / 40) * 8).toFixed(3)} мс/кадр · ` +
      `список соседей: ${stats.pairs} пар, возраст ${stats.age} шагов`,
  );
}

for (const count of [2048, 8000, 20000]) bench(count);
