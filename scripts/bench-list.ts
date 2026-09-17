/**
 * Сколько раз перестраивается список соседей и во что это обходится.
 *
 * Запуск: npx vite-node scripts/bench-list.ts
 *
 * Главный вопрос здесь: окупается ли «кожа». Если список живёт один шаг,
 * построение не окупается вдвое большим числом пар, и кожу надо увеличивать.
 */
import { World } from '../src/core/world.js';

const count = Number(process.env['N'] ?? 19652);

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
for (let i = 0; i < 100; i++) world.step();

const r0 = world.neighbourStats.rebuilds;
const steps = 200;
const t0 = performance.now();
for (let i = 0; i < steps; i++) world.step();
const total = performance.now() - t0;
const rebuilds = world.neighbourStats.rebuilds - r0;

console.log(`${steps} шагов: ${total.toFixed(1)} мс, ${(total / steps).toFixed(2)} мс/шаг`);
console.log(
  `перестроений списка: ${rebuilds} → каждые ${(steps / Math.max(1, rebuilds)).toFixed(1)} шагов`,
);
console.log(`пар в списке: ${world.neighbourStats.pairs}`);
console.log(`возраст текущего списка: ${world.neighbourStats.age} шагов`);

// Отдельно: чистое построение списка.
const t1 = performance.now();
for (let i = 0; i < 20; i++) world.verlet.build(world.state, world.grid, world.box, 2.5, true);
console.log(`list.build: ${((performance.now() - t1) / 20).toFixed(2)} мс`);
