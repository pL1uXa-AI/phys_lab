/** Подбор толщины «кожи»: замер полного шага для разных значений. */
import { World } from '../src/core/world.js';

function run(skin: number, count: number): { stepMs: number; rebuildEvery: number; pairs: number } {
  const world = new World(
    { count, density: 0.7, cutoff: 2.5, dt: 0.004, temperature: 1.0, thermostat: 'langevin', boundary: 'periodic' },
    1,
    'fcc',
  );
  world.verlet.skin = skin;
  world.rebuildForces();
  // Прогрев: пусть система выйдет на рабочую температуру.
  for (let i = 0; i < 300; i++) world.step();

  const r0 = world.verlet.rebuilds;
  const steps = 600;
  const t0 = performance.now();
  for (let i = 0; i < steps; i++) world.step();
  const stepMs = (performance.now() - t0) / steps;
  const rebuilds = world.verlet.rebuilds - r0;
  return {
    stepMs,
    rebuildEvery: rebuilds > 0 ? steps / rebuilds : Infinity,
    pairs: world.verlet.pairCount,
  };
}

for (const count of [2048, 8000, 19652]) {
  console.log(`\n=== N = ${count} ===`);
  for (const skin of [0.2, 0.3, 0.4, 0.5, 0.7, 1.0]) {
    const r = run(skin, count);
    console.log(
      `кожа ${skin.toFixed(1)}: ${r.stepMs.toFixed(2)} мс/шаг, перестроение каждые ${r.rebuildEvery.toFixed(1)} шагов, пар ${r.pairs}`,
    );
  }
}
