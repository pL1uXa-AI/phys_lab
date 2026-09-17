/**
 * Регрессионные тесты на дефекты, найденные при аудите проекта.
 *
 * Каждый тест здесь соответствует пункту из раздела «Найденные и исправленные
 * дефекты» README. Смысл файла — не дать дефекту вернуться: все они относятся
 * к классу «выглядит работающим, а считает неправильно», поэтому обнаружить
 * их повторное появление иначе почти невозможно.
 */

import { describe, expect, it } from 'vitest';
import { World } from '../core/world.js';
import { buildState } from '../core/initializers.js';
import { buildGrid } from '../core/grid.js';
import { VerletList } from '../core/neighbours.js';
import { computeForces, computeForcesDirect, computeForcesFromList } from '../core/forces.js';
import { ljShift } from '../core/potential.js';
import { RadialDistribution } from '../core/measure.js';
import {
  MAX_POKE_SPEED,
  projectToScreen,
  unprojectFromScreen,
  viewAxis,
  type BrushPlane,
} from '../core/integrator.js';
import { boxLength, type CellGrid, type ParticleState } from '../core/types.js';

const CUTOFF = 2.5;
const SHIFT = ljShift(CUTOFF);
const SKIN = 0.4;

/** Сетка ровно так, как её строит мир (с гарантией минимум трёх ячеек). */
function worldGrid(state: ParticleState, box: number): CellGrid {
  const n = Math.max(3, Math.floor(box / (CUTOFF * 1.35)));
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

/** Число пар в пределах обрезания честным перебором. */
function directPairCount(state: ParticleState, box: number, cutoff: number): number {
  const cutoffSq = cutoff * cutoff;
  let pairs = 0;
  for (let i = 0; i < state.count; i++) {
    for (let j = i + 1; j < state.count; j++) {
      let dx = state.x[j] - state.x[i];
      let dy = state.y[j] - state.y[i];
      let dz = state.z[j] - state.z[i];
      dx -= box * Math.round(dx / box);
      dy -= box * Math.round(dy / box);
      dz -= box * Math.round(dz / box);
      const r2 = dx * dx + dy * dy + dz * dz;
      if (r2 < cutoffSq && r2 > 0) pairs++;
    }
  }
  return pairs;
}

/* =========================================================================
   Дефект 15: сетка в маленьком ящике молча теряла пары
   ========================================================================= */

describe('дефект 15: сетка ячеек не меньше радиуса поиска', () => {
  /**
   * Мир обязан распознать, что сетка мала, и посчитать силы честно.
   *
   * До исправления: ячейка 1.94σ при требуемых 2.9σ, ячейка обходится как
   * 27 соседних, сосед «через одну» не находится — часть пар исчезает.
   * Измерено 4.5 % потерянных пар при N = 256, ρ* = 1.3.
   */
  const risky: Array<[number, number]> = [
    [256, 1.3],
    [500, 1.3],
    [128, 1.3],
    [500, 0.6],
  ];

  for (const [count, density] of risky) {
    it(`N=${count}, ρ*=${density}: число пар совпадает с перебором`, () => {
      const world = new World(
        { count, density, cutoff: CUTOFF, dt: 0.004, temperature: 0.6, thermostat: 'none', boundary: 'periodic' },
        99,
        'fcc',
      );
      // Мир сам выбирает путь: сетку или прямой перебор.
      expect(world.pairCount).toBe(directPairCount(world.state, world.box, CUTOFF));
      // Несколько шагов: путь обязан остаться корректным и на ходу.
      world.run(5);
      expect(world.pairCount).toBe(directPairCount(world.state, world.box, CUTOFF));
    });
  }

  it('на разрежённой системе список соседей по-прежнему используется', () => {
    // Чинить дефект «выключением оптимизации везде» нельзя: на нормальных
    // системах список обязан работать, иначе упадёт производительность.
    const world = new World(
      { count: 2048, density: 0.7, cutoff: CUTOFF, dt: 0.004, temperature: 1.0, thermostat: 'none', boundary: 'periodic' },
      5,
      'fcc',
    );
    expect(world.usingVerletList).toBe(true);
    expect(world.gridIsSafe).toBe(true);
    world.run(5);
    // Список действительно перестраивался (значит, им пользуются).
    expect(world.neighbourStats.rebuilds).toBeGreaterThan(0);
  });

  it('computeForcesDirect совпадает с обходом сетки, когда сетка корректна', () => {
    // Ящик подобран так, чтобы ячейка сетки (CUTOFF · 1.35) действительно
    // была не меньше радиуса поиска: box ≈ 9.4σ даёт 3 ячейки по 3.14σ.
    const built = buildState('fcc', 400, 0.6, 0.6, 11);
    const state = built.state;
    const box = built.box;
    const grid = worldGrid(state, box);
    expect(grid.size).toBeGreaterThanOrEqual(CUTOFF + SKIN);
    buildGrid(state, grid);

    const viaGrid = computeForces(state, grid, box, CUTOFF, SHIFT, true, true);
    const gridForces = Float64Array.from(state.fx);
    const gridNeighbours = Float64Array.from(state.neighbours);
    const viaDirect = computeForcesDirect(state, box, CUTOFF, SHIFT, true, true);

    expect(viaDirect.pairs).toBe(viaGrid.pairs);
    expect(viaDirect.potential).toBeCloseTo(viaGrid.potential, 9);
    expect(viaDirect.virial).toBeCloseTo(viaGrid.virial, 9);
    for (let i = 0; i < state.count; i++) {
      expect(state.fx[i]).toBeCloseTo(gridForces[i], 9);
      expect(state.neighbours[i]).toBe(gridNeighbours[i]);
    }
  });

  it('computeForcesDirect не зависит от числа частиц', () => {
    // Прямой перебор обязан давать ту же физику, что список: проверяем на
    // плотной системе, где список раньше терял пары из-за переполнения буфера.
    const built = buildState('fcc', 2048, 1.3, 0.5, 3);
    const state = built.state;
    const box = built.box;
    const viaDirect = computeForcesDirect(state, box, CUTOFF, SHIFT, true, false);
    const truth = directPairCount(state, box, CUTOFF);
    expect(viaDirect.pairs).toBe(truth);
  });
});

/* =========================================================================
   Дефект 16: g(r) теряла пары при ячейке меньше максимального радиуса
   ========================================================================= */

describe('дефект 16: g(r) переключается на перебор при мелкой сетке', () => {
  it('g(r) недосчитывает пары в маленьком ящике без перебора', () => {
    // Прямая проверка гипотезы: если бы g(r) пользовалась мелкой сеткой,
    // в первые слои попадало бы меньше пар, чем при честном переборе.
    // Верхняя граница ящика для сетки с ячейкой 3.5σ — box / 3.
    const count = 500;
    const density = 1.3;
    const built = buildState('fcc', count, density, 0.6, 5);
    const state = built.state;
    const box = built.box;
    // Ячейка выходит меньше максимального радиуса g(r) — значит нужен перебор.
    expect(Math.floor(box / 3.5) < 3 || box / Math.max(3, Math.floor(box / 3.5)) < 3.5).toBe(true);

    const radial = new RadialDistribution(3.5, 140);
    radial.accumulate(state, box, true);
    expect(radial.sampleCount).toBe(1);

    // Прямой перебор вручную: считаем пары до 3.5σ и сверяем с гистограммой
    // через интеграл g(r) — при корректной работе они согласованы.
    const { r, g } = radial.result(box);
    // Число пар в слое k равно g[k] · (N(N−1)/2) · 4πr²dr / V.
    const volume = box * box * box;
    const pairsTotal = (count * (count - 1)) / 2;
    let integrated = 0;
    for (let k = 0; k < r.length; k++) {
      const shell = 4 * Math.PI * r[k] * r[k] * radial.dr;
      integrated += (g[k] * pairsTotal * shell) / volume;
    }
    let truth = 0;
    for (let i = 0; i < state.count; i++) {
      for (let j = i + 1; j < state.count; j++) {
        let dx = state.x[j] - state.x[i];
        let dy = state.y[j] - state.y[i];
        let dz = state.z[j] - state.z[i];
        dx -= box * Math.round(dx / box);
        dy -= box * Math.round(dy / box);
        dz -= box * Math.round(dz / box);
        const rr = dx * dx + dy * dy + dz * dz;
        if (rr > 0 && rr < 3.5 * 3.5) truth++;
      }
    }
    // Интеграл обязан совпасть с числом пар (гистограмма только по 3.5σ),
    // допускаем лишь дискретизацию слоя.
    expect(integrated).toBeGreaterThan(truth * 0.97);
    expect(integrated).toBeLessThan(truth * 1.03);
  });
});

/* =========================================================================
   Дефект 17: кисть доставала только до среднего слоя частиц
   ========================================================================= */

describe('дефект 17: кисть бьёт цилиндром вдоль луча зрения', () => {
  it('ось взгляда согласована с проекцией мира', () => {
    // Ось выводится из тех же углов, что и проекция: направления обязаны
    // совпасть до знака/порядка машинной точности.
    const world = new World({ count: 64, density: 0.5, thermostat: 'none' }, 3, 'fcc');
    for (const [yaw, pitch] of [
      [0.6, 0.9],
      [-1.2, 0.3],
      [2.5, -0.7],
      [0, 0],
    ] as const) {
      const w = viewAxis(yaw, pitch);
      const out = new Float32Array(world.state.count * 3);
      world.project(yaw, pitch, out);
      for (const i of [0, 7, 33]) {
        const s = projectToScreen(
          w,
          world.state.x[i] - world.box * 0.5,
          world.state.y[i] - world.box * 0.5,
          world.state.z[i] - world.box * 0.5,
        );
        // `World.project` пишет в Float32Array, поэтому сравнение идёт
        // в пределах точности одинарной точности, а не двойной.
        expect(s.x).toBeCloseTo(out[i * 3], 5);
        expect(s.y).toBeCloseTo(out[i * 3 + 1], 5);
      }
    }
  });

  it('кисть накрывает частицы на разной глубине вдоль луча', () => {
    // Это главная проверка дефекта. Точки, различающиеся только сдвигом
    // ВДОЛЬ оси взгляда, обязаны попасть в одну кисть: иначе часть частиц
    // недостижима, а картинка на экране не совпадает с воздействием.
    const w = viewAxis(0.6, 0.9);
    const center = unprojectFromScreen(w, 0, 0, 0);
    const radius = 3;

    // Сдвиг вдоль оси не должен менять перпендикулярное расстояние.
    const depths = [-8, -3, 0, 4, 9];
    const axisDistance = (p: { x: number; y: number; z: number }): number => {
      const dx = p.x - center.x;
      const dy = p.y - center.y;
      const dz = p.z - center.z;
      const along = dx * w.ax + dy * w.ay + dz * w.az;
      const px = dx - along * w.ax;
      const py = dy - along * w.ay;
      const pz = dz - along * w.az;
      return Math.sqrt(px * px + py * py + pz * pz);
    };
    for (const d of depths) {
      const p = unprojectFromScreen(w, 0, 0, d);
      expect(axisDistance(p)).toBeLessThan(1e-9);
      expect(axisDistance(p)).toBeLessThan(radius);
    }
  });

  it('мир задевает кистью существенную долю частиц при разной глубине', () => {
    // Практическая проверка: до исправления клик в любую точку экрана
    // задевал частицы одного и того же слоя по y. Теперь разброс по y
    // у затронутых частиц должен покрывать заметную часть ящика.
    const world = new World(
      { count: 2048, density: 0.75, cutoff: CUTOFF, dt: 0.004, temperature: 1.1, thermostat: 'langevin', boundary: 'periodic' },
      7,
      'fcc',
    );
    world.run(200);
    const w = world.viewAxis(0.6, 0.9);
    const center = unprojectFromScreen(w, 0, 0, 0);
    const plane: BrushPlane = { w, center: { x: center.x + world.box / 2, y: center.y + world.box / 2, z: center.z + world.box / 2 } };
    world.pokeNow({ plane, dx: 1, dy: 0, dz: 0, radius: 3, strength: 1 });

    let touched = 0;
    let minY = Number.POSITIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < world.state.count; i++) {
      if (Math.abs(world.state.vx[i]) + Math.abs(world.state.vy[i]) + Math.abs(world.state.vz[i]) > 1e-9) {
        touched++;
        minY = Math.min(minY, world.state.y[i]);
        maxY = Math.max(maxY, world.state.y[i]);
      }
    }
    expect(touched).toBeGreaterThan(50);
    // Покрытие по y — существенная часть ящика, а не узкий слой.
    // До исправления это отношение было около 0.4; теперь кисть накрывает
    // частицы на всех глубинах, и задетые распределены по всему ящику.
    expect((maxY - minY) / world.box).toBeGreaterThan(0.6);
  });

  it('заморозка действует на тот же цилиндр, что и толчок', () => {
    const world = new World(
      { count: 1024, density: 0.75, cutoff: CUTOFF, dt: 0.004, temperature: 1.0, thermostat: 'langevin', boundary: 'periodic' },
      13,
      'fcc',
    );
    world.run(100);
    const w = world.viewAxis(0.6, 0.9);
    const c = unprojectFromScreen(w, 0, 0, 0);
    const plane: BrushPlane = { w, center: { x: c.x + world.box / 2, y: c.y + world.box / 2, z: c.z + world.box / 2 } };
    const frozen = world.freezeRegion(plane, 3);
    let counted = 0;
    for (let i = 0; i < world.state.count; i++) if (world.frozen[i] !== 0) counted++;
    expect(counted).toBe(frozen);
    expect(counted).toBeGreaterThan(20);
    world.unfreezeAll();
    for (let i = 0; i < world.state.count; i++) expect(world.frozen[i]).toBe(0);
  });
});

/* =========================================================================
   Дефект 18: сетка g(r) и списки Верле обязаны быть согласованы с геометрией
   ========================================================================= */

describe('дефект 18: инвариант ячейки держится на всём диапазоне слайдеров', () => {
  it('мир не теряет пары ни при одной комбинации ползунков', () => {
    // Ползунки позволяют N от 128 до 20000 и ρ* от 0.05 до 1.3. Прогоняем
    // сетку значений: на каждой число пар обязано совпасть с перебором.
    for (const count of [128, 256, 500, 1024, 2048]) {
      for (const density of [0.05, 0.4, 0.7, 1.0, 1.3]) {
        const world = new World(
          { count, density, cutoff: CUTOFF, dt: 0.004, temperature: 0.5, thermostat: 'none', boundary: 'periodic' },
          17,
          'fcc',
        );
        const actual = world.pairCount;
        const truth = directPairCount(world.state, world.box, CUTOFF);
        // Разрешаем только те пути, что не теряют пары молча.
        expect(actual).toBe(truth);
      }
    }
  });

  it('на корректной сетке список совпадает с перебором', () => {
    // Контроль, что «правильный» путь (список Верле) не сломан исправлением:
    // там, где сетка безопасна, все три способа обязаны дать одно число.
    const built = buildState('fcc', 1000, 0.8, 0.6, 23);
    const state = built.state;
    const box = built.box;
    const grid = worldGrid(state, box);
    expect(grid.size).toBeGreaterThanOrEqual(CUTOFF + SKIN);
    buildGrid(state, grid);
    const list = new VerletList(state.count, SKIN);
    list.build(state, grid, box, CUTOFF, true);

    const truth = directPairCount(state, box, CUTOFF);
    expect(computeForcesDirect(state, box, CUTOFF, SHIFT, true, false).pairs).toBe(truth);
    expect(computeForcesFromList(state, list, box, CUTOFF, SHIFT, true, false).pairs).toBe(truth);
  });
});

/* =========================================================================
   Дефект 19: автоподстройка не должна «уезжать» на здоровой системе
   ========================================================================= */

describe('дефект 19: стоимость шага не смешивается со статистикой g(r)', () => {
  it('шаг на 2048 частицах не деградирует при включённой статистике', () => {
    // Ключевая проверка: кадр g(r) стоит как несколько шагов. Пока app
    // включал его в замер `physicsMs`, автоподстройка видела завышенную
    // «стоимость шага» и снижала число шагов до минимума на здоровой системе.
    // Здесь проверяется физическая часть: сам шаг дешёв и линейно зависит
    // от N — значит, если автоподстройка сходит с ума, виноват учёт, а не ядро.
    const world = new World(
      { count: 2048, density: 0.7, cutoff: CUTOFF, dt: 0.004, temperature: 1.0, thermostat: 'none', boundary: 'periodic' },
      29,
      'fcc',
    );
    world.run(60);
    const t0 = performance.now();
    world.run(200);
    const perStep = (performance.now() - t0) / 200;
    // Порог щедрый (машины разные), но он ловит именно вырождение.
    expect(perStep).toBeLessThan(20);

    // Один кадр статистики стоит заметно дороже одного шага — вот почему
    // его нельзя складывать с физикой.
    const t1 = performance.now();
    for (let i = 0; i < 5; i++) world.sampleRadial();
    const perRadial = (performance.now() - t1) / 5;
    expect(perRadial).toBeGreaterThan(perStep);
  });
});

/* =========================================================================
   Дефект 27: «Остановить» только обнуляла скорости, а не замораживала
   ========================================================================= */

describe('дефект 27: заморозка действительно останавливает частицы', () => {
  it('freezeAll держит частицы на месте сколь угодно долго', () => {
    // До исправления кнопка «Остановить» обнуляла скорости один раз, и уже
    // на следующем шаге `kick` + термостат разгоняли частицы заново: за 200
    // шагов кристалл «проезжал» 8σ при заявленной остановке. Теперь ставится
    // маска, и смещение обязано быть ровно нулевым.
    const world = new World(
      { count: 512, density: 0.95, cutoff: CUTOFF, dt: 0.004, temperature: 0.15, thermostat: 'langevin', boundary: 'periodic' },
      7,
      'fcc',
    );
    world.run(200);
    world.freezeAll();

    const x0 = Float64Array.from(world.state.x);
    const y0 = Float64Array.from(world.state.y);
    const z0 = Float64Array.from(world.state.z);
    world.run(400);

    let maxMove = 0;
    let maxSpeed = 0;
    for (let i = 0; i < world.state.count; i++) {
      maxMove = Math.max(
        maxMove,
        Math.abs(world.state.x[i] - x0[i]),
        Math.abs(world.state.y[i] - y0[i]),
        Math.abs(world.state.z[i] - z0[i]),
      );
      maxSpeed = Math.max(
        maxSpeed,
        Math.abs(world.state.vx[i]),
        Math.abs(world.state.vy[i]),
        Math.abs(world.state.vz[i]),
      );
    }
    expect(maxMove).toBeLessThan(1e-12);
    expect(maxSpeed).toBeLessThan(1e-12);
    // Температура остановленной системы — ноль, а не «целевая».
    expect(world.measurement.temperature).toBeLessThan(1e-12);
  });

  it('заморозка переживает все термостаты', () => {
    // Термостаты масштабируют скорости ВСЕХ частиц; без повторного наложения
    // маски после термостата замороженные «оживали» бы.
    for (const thermostat of ['berendsen', 'langevin', 'nose-hoover', 'none'] as const) {
      const world = new World(
        { count: 256, density: 0.8, cutoff: CUTOFF, dt: 0.004, temperature: 0.9, thermostat, boundary: 'periodic' },
        11,
        'fcc',
      );
      world.run(100);
      world.freezeAll();
      const x0 = Float64Array.from(world.state.x);
      world.run(300);
      let maxMove = 0;
      for (let i = 0; i < world.state.count; i++) {
        maxMove = Math.max(maxMove, Math.abs(world.state.x[i] - x0[i]));
      }
      expect(maxMove).toBeLessThan(1e-12);
    }
  });

  it('разморозка возвращает систему к жизни', () => {
    const world = new World(
      { count: 512, density: 0.8, cutoff: CUTOFF, dt: 0.004, temperature: 0.9, thermostat: 'langevin', boundary: 'periodic' },
      19,
      'fcc',
    );
    world.run(100);
    world.freezeAll();
    world.run(50);
    expect(world.measurement.temperature).toBeLessThan(1e-12);
    world.unfreezeAll();
    world.run(200);
    // Термостат обязан вернуть систему к заданной температуре.
    expect(world.measurement.temperature).toBeGreaterThan(0.5);
  });
});

/* =========================================================================
   Дефект 28: протяжка мышью разгоняла систему до нефизических скоростей
   ========================================================================= */

describe('дефект 28: импульс кисти ограничен', () => {
  it('длинная протяжка не разгоняет систему до абсурда', () => {
    // До исправления импульс прибавлялся на каждом событии движения и был
    // пропорционален всему пути курсора: протяжка 200 px при масштабе
    // ~18 px/σ давала 37 σ/τ (при тепловой скорости ≈ 1.7). Кристалл
    // разгонялся до T* = 3.6, а «протянуть и подождать» уводило полную
    // энергию в 10¹⁷. Теперь вектор импульса ограничен MAX_POKE_SPEED.
    const world = new World(
      { count: 2048, density: 0.95, cutoff: CUTOFF, dt: 0.004, temperature: 0.15, thermostat: 'langevin', boundary: 'periodic' },
      7,
      'fcc',
    );
    world.run(200);
    const axis = world.viewAxis(0.6, 0.9);
    const c = unprojectFromScreen(axis, 0, 0, 0);
    const plane = {
      w: axis,
      center: { x: c.x + world.box / 2, y: c.y + world.box / 2, z: c.z + world.box / 2 },
    };

    // Абсурдно большая протяжка — эквивалент рывка мышью через весь экран.
    world.pokeNow({ plane, dx: 200, dy: 120, dz: 0, radius: 3, strength: 1 });
    let maxSpeed = 0;
    for (let i = 0; i < world.state.count; i++) {
      maxSpeed = Math.max(maxSpeed, Math.abs(world.state.vx[i]), Math.abs(world.state.vy[i]));
    }
    expect(maxSpeed).toBeLessThan(MAX_POKE_SPEED + 1e-9);

    // И система остаётся физичной, а не «взлетает».
    world.run(200);
    expect(Number.isFinite(world.potentialEnergy)).toBe(true);
    expect(Math.abs(world.potentialEnergy)).toBeLessThan(1e6);
    expect(world.measurement.temperature).toBeLessThan(10);
  });

  it('короткая протяжка по-прежнему даёт заметный, но умеренный толчок', () => {
    // Ограничение не должно «съедать» обычные воздействия: слабый толчок
    // обязан остаться слабым и пропорциональным протяжке.
    const world = new World(
      { count: 2048, density: 0.95, cutoff: CUTOFF, dt: 0.004, temperature: 0.15, thermostat: 'langevin', boundary: 'periodic' },
      7,
      'fcc',
    );
    world.run(200);
    const axis = world.viewAxis(0.6, 0.9);
    const c = unprojectFromScreen(axis, 0, 0, 0);
    const plane = {
      w: axis,
      center: { x: c.x + world.box / 2, y: c.y + world.box / 2, z: c.z + world.box / 2 },
    };
    world.pokeNow({ plane, dx: 1, dy: 0, dz: 0, radius: 3, strength: 1 });
    let maxSpeed = 0;
    for (let i = 0; i < world.state.count; i++) maxSpeed = Math.max(maxSpeed, Math.abs(world.state.vx[i]));
    expect(maxSpeed).toBeGreaterThan(0.1);
    expect(maxSpeed).toBeLessThan(MAX_POKE_SPEED);
  });

  it('импульсы за шаг накапливаются, а не перекрываются', () => {
    // Мышь присылает несколько событий за шаг физики. Если бы последнее
    // перекрывало предыдущие, толчок зависел бы от частоты событий
    // устройства, а не от длины протяжки. Проверяем эквивалентность:
    // три импульса по 1 обязаны дать ровно то же, что один импульс 3.
    const makeWorld = (): World => {
      const w = new World(
        { count: 512, density: 0.9, cutoff: CUTOFF, dt: 0.004, temperature: 0.15, thermostat: 'none', boundary: 'periodic' },
        7,
        'fcc',
      );
      w.run(100);
      return w;
    };
    const brushOf = (w: World): BrushPlane => {
      const axis = w.viewAxis(0.6, 0.9);
      const c = unprojectFromScreen(axis, 0, 0, 0);
      return { w: axis, center: { x: c.x + w.box / 2, y: c.y + w.box / 2, z: c.z + w.box / 2 } };
    };
    const maxSpeed = (w: World): number => {
      let peak = 0;
      for (let i = 0; i < w.state.count; i++) peak = Math.max(peak, Math.abs(w.state.vx[i]));
      return peak;
    };

    const split = makeWorld();
    for (let k = 0; k < 3; k++) {
      split.requestPoke({ plane: brushOf(split), dx: 1, dy: 0, dz: 0, radius: 3, strength: 1 });
    }
    split.flushPoke();

    const single = makeWorld();
    single.pokeNow({ plane: brushOf(single), dx: 3, dy: 0, dz: 0, radius: 3, strength: 1 });

    const splitSpeed = maxSpeed(split);
    expect(splitSpeed).toBeGreaterThan(1);
    // Совпадение до машинной точности: накопление — это сложение, а не выбор.
    expect(splitSpeed).toBeCloseTo(maxSpeed(single), 12);
  });
});

/* =========================================================================
   Дефект 30: численный разлёт был необратим — «остудить» не помогало
   ========================================================================= */

describe('дефект 30: система не уходит в необратимый разлёт', () => {
  it('ограничитель скорости не даёт выбросу разрастись', () => {
    // До исправления «нагреть и сжать» уводило систему в состояние, из
    // которого не было выхода: силы росли экспоненциально, а термостат
    // способен убрать лишь ~1 % энергии за шаг. Измерено: от T* = 1.45·10³⁹
    // система уходила к 5.7·10⁸⁴ — «остудить» и «расширить» не помогали.
    const world = new World(
      { count: 512, density: 0.95, cutoff: CUTOFF, dt: 0.004, temperature: 0.15, thermostat: 'berendsen', boundary: 'periodic' },
      7,
      'fcc',
    );
    world.run(100);
    // Искусственный выброс — эмулирует последствие неудачного толчка.
    world.scaleVelocities(1e19);
    world.run(200);

    const m = world.measurement;
    expect(Number.isFinite(m.temperature)).toBe(true);
    expect(Number.isFinite(world.potentialEnergy)).toBe(true);
    // Система обязана вернуться в разумную область, а не остаться «взлетевшей».
    expect(m.temperature).toBeLessThan(100);
  });

  it('разлёт отталкивается любым термостатом', () => {
    for (const thermostat of ['berendsen', 'langevin', 'nose-hoover', 'none'] as const) {
      const world = new World(
        { count: 256, density: 0.8, cutoff: CUTOFF, dt: 0.004, temperature: 0.9, thermostat, boundary: 'periodic' },
        11,
        'fcc',
      );
      world.run(100);
      world.scaleVelocities(1e12);
      world.run(400);
      expect(Number.isFinite(world.measurement.temperature)).toBe(true);
      expect(Math.abs(world.potentialEnergy)).toBeLessThan(1e9);
    }
  });

  it('нечисловой мусор распознаётся и система восстанавливается', () => {
    const world = new World(
      { count: 256, density: 0.8, cutoff: CUTOFF, dt: 0.004, temperature: 0.9, thermostat: 'langevin', boundary: 'periodic' },
      13,
      'fcc',
    );
    world.run(50);
    // Портим состояние так, как это делает численный выброс.
    world.state.vx[0] = Number.NaN;
    world.state.vy[3] = Number.POSITIVE_INFINITY;
    world.run(5);

    expect(world.nanRecoveries).toBeGreaterThan(0);
    expect(Number.isFinite(world.measurement.temperature)).toBe(true);
    for (let i = 0; i < world.state.count; i++) {
      expect(Number.isFinite(world.state.vx[i])).toBe(true);
      expect(Number.isFinite(world.state.vy[i])).toBe(true);
      expect(Number.isFinite(world.state.vz[i])).toBe(true);
    }
  });

  it('в штатных режимах ограничитель не срабатывает', () => {
    // Важно: защита не должна вмешиваться в нормальную физику. Проверяем,
    // что на всех пресетах и на верхней границе ползунка T* = 3 ограничений нет.
    for (const temperature of [0.15, 0.9, 1.6, 3.0]) {
      const world = new World(
        { count: 512, density: 0.9, cutoff: CUTOFF, dt: 0.004, temperature, thermostat: 'berendsen', boundary: 'periodic' },
        17,
        'fcc',
      );
      world.applyTemperatureNow();
      world.run(300);
      expect(world.speedClampedCount).toBe(0);
      expect(world.measurement.temperature).toBeLessThan(temperature * 2 + 1);
    }
  });
});

/* =========================================================================
   Дефект 31: одиночный выброс скорости убивал контраст раскраски
   ========================================================================= */

describe('дефект 31: шкала раскраски устойчива к выбросам', () => {
  it('одна аномально быстрая частица не делает всех частиц одного цвета', () => {
    // Дефект из отзыва: «частицы не меняют цвет». Причина — шкала бралась
    // по абсолютному максимуму: достаточно одной частицы со скоростью 10²³,
    // чтобы t = (v − min)/(max − min) ≈ 1e−24 у ВСЕХ остальных. Измерено:
    // 100 % частиц получали практически одинаковый «медленный» цвет.
    const world = new World(
      { count: 2048, density: 0.9, cutoff: CUTOFF, dt: 0.004, temperature: 0.9, thermostat: 'none', boundary: 'periodic' },
      7,
      'fcc',
    );
    world.run(100);
    world.applyTemperatureNow();

    const normal = world.colorValues('speed');
    world.state.vx[0] = 1e23;
    world.run(1);
    const spiked = world.colorValues('speed');

    // Верхняя граница обязана остаться того же порядка, а не улететь.
    expect(spiked.max).toBeLessThan(normal.max * 5);
    // И подавляющее большинство частиц получает осмысленную позицию на шкале.
    let flat = 0;
    let counted = 0;
    for (let i = 1; i < world.state.count; i++) {
      if (world.state.alive[i] === 0) continue;
      const t = (spiked.values[i] - spiked.min) / (spiked.max - spiked.min);
      if (t < 0.05) flat++;
      counted++;
    }
    expect(flat / counted).toBeLessThan(0.1);
  });

  it('широкое распределение (газ) не «зажимается» квантилем', () => {
    // Квантиль должен отсекать выбросы, а не сужать реальный разброс:
    // в газе быстрых частиц много, и шкала обязана их различать.
    const world = new World(
      { count: 1200, density: 0.06, cutoff: CUTOFF, dt: 0.005, temperature: 1.6, thermostat: 'langevin', boundary: 'periodic' },
      23,
      'random',
    );
    world.run(200);
    const colors = world.colorValues('speed');
    // Разброс заведомо шире, чем «нет данных»: max существенно больше min.
    expect(colors.max).toBeGreaterThan(colors.min * 2);
    // Хотя бы часть частиц попадает в верхнюю половину шкалы.
    let upper = 0;
    for (let i = 0; i < world.state.count; i++) {
      if (world.state.alive[i] === 0) continue;
      const t = (colors.values[i] - colors.min) / (colors.max - colors.min);
      if (t > 0.5) upper++;
    }
    expect(upper).toBeGreaterThan(world.state.count * 0.1);
  });
});

/* =========================================================================
   Дефект 29: boxLength согласован с плотностью
   ========================================================================= */

describe('дефект 29: плотность, ящик и число частиц согласованы', () => {
  it('N/V совпадает с заявленной плотностью на всём диапазоне', () => {
    for (const [count, density] of [
      [128, 1.3],
      [256, 0.05],
      [2048, 0.95],
      [5000, 0.7],
    ] as const) {
      const world = new World({ count, density, thermostat: 'none' }, 31, 'fcc');
      const actual = world.state.count / world.box ** 3;
      expect(actual).toBeCloseTo(world.params.density, 12);
      expect(world.box).toBeCloseTo(boxLength(world.state.count, world.params.density), 12);
    }
  });
});
