/**
 * Тесты сети связей ближних соседей.
 *
 * Сеть связей — это «видимая структура» системы, и она же несёт измеримый
 * смысл: среднее число связей на атом есть координационное число. Поэтому
 * проверки здесь двух видов:
 *
 *   1. Механическая корректность — каждая пара ровно один раз, полное
 *      совпадение с честным перебором, правильный минимальный образ.
 *   2. Физический смысл — у ГЦК-кристалла ровно 12 связей на атом (это
 *      координационное число ГЦК), у газа связей почти нет, у жидкости
 *      число связей между этими крайностями.
 *
 * Вторая группа важна не меньше первой: сетка может быть «правильной» и при
 * этом собирать не ту окрестность — например, если радиус связи задан
 * заметно больше межатомного расстояния, «соседями» окажутся атомы второй
 * оболочки, и координационное число перестанет что-либо означать.
 */

import { describe, expect, it } from 'vitest';
import { BondNetwork, DEFAULT_BOND_RADIUS } from '../core/bonds.js';
import { World } from '../core/world.js';
import { boxLength, type ParticleState } from '../core/types.js';
import { buildState } from '../core/initializers.js';

/** Прямой перебор пар ближе радиуса — эталон для сравнения. */
function bruteForcePairs(
  state: ParticleState,
  box: number,
  cutoff: number,
  periodic: boolean,
): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const half = box * 0.5;
  const limSq = cutoff * cutoff;
  for (let i = 0; i < state.count; i++) {
    if (state.alive[i] === 0) continue;
    for (let j = i + 1; j < state.count; j++) {
      if (state.alive[j] === 0) continue;
      let dx = state.x[j] - state.x[i];
      let dy = state.y[j] - state.y[i];
      let dz = state.z[j] - state.z[i];
      if (periodic) {
        if (dx > half) dx -= box;
        else if (dx < -half) dx += box;
        if (dy > half) dy -= box;
        else if (dy < -half) dy += box;
        if (dz > half) dz -= box;
        else if (dz < -half) dz += box;
      }
      if (dx * dx + dy * dy + dz * dz < limSq) out.push([i, j]);
    }
  }
  return out;
}

/** Ключ пары — для сравнения множеств без учёта порядка. */
function keyOf(i: number, j: number): string {
  return `${Math.min(i, j)}-${Math.max(i, j)}`;
}

/** Мир с заданными параметрами, прогретый до равновесия. */
function makeWorld(count: number, density: number, temperature: number, steps = 400): World {
  const world = new World(
    {
      count,
      density,
      temperature,
      thermostat: temperature > 0.3 ? 'berendsen' : 'none',
      boundary: 'periodic',
    },
    777,
    'fcc',
  );
  if (steps > 0) world.run(steps);
  return world;
}

describe('сеть связей', () => {
  it('содержит ровно те пары, что и прямой перебор', () => {
    const world = makeWorld(500, 0.7, 0.9);
    const net = new BondNetwork(DEFAULT_BOND_RADIUS);
    net.build(world.state, world.box, true);

    const expected = bruteForcePairs(world.state, world.box, DEFAULT_BOND_RADIUS, true);
    expect(net.pairCount).toBe(expected.length);

    const got = new Set<string>();
    for (let k = 0; k < net.pairCount; k++) got.add(keyOf(net.a[k], net.b[k]));
    const want = new Set(expected.map(([i, j]) => keyOf(i, j)));
    expect(got).toEqual(want);
  });

  it('каждая пара встречается ровно один раз и упорядочена по индексу', () => {
    const world = makeWorld(400, 0.8, 0.6);
    const net = new BondNetwork(DEFAULT_BOND_RADIUS);
    net.build(world.state, world.box, true);

    const seen = new Set<string>();
    for (let k = 0; k < net.pairCount; k++) {
      // Инвариант хранения: первая частица пары всегда с меньшим индексом.
      // Без него пара (i, j) попадёт дважды, и число связей удвоится.
      expect(net.a[k]).toBeLessThan(net.b[k]);
      const key = keyOf(net.a[k], net.b[k]);
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
    expect(seen.size).toBe(net.pairCount);
  });

  it('длина связи совпадает с расстоянием, а вектор — с направлением', () => {
    const world = makeWorld(300, 0.75, 0.8);
    const net = new BondNetwork(DEFAULT_BOND_RADIUS);
    net.build(world.state, world.box, true);

    const half = world.box * 0.5;
    let checked = 0;
    for (let k = 0; k < net.pairCount; k += 7) {
      const i = net.a[k];
      const j = net.b[k];
      let dx = world.state.x[j] - world.state.x[i];
      let dy = world.state.y[j] - world.state.y[i];
      let dz = world.state.z[j] - world.state.z[i];
      if (dx > half) dx -= world.box;
      else if (dx < -half) dx += world.box;
      if (dy > half) dy -= world.box;
      else if (dy < -half) dy += world.box;
      if (dz > half) dz -= world.box;
      else if (dz < -half) dz += world.box;

      expect(net.dx[k]).toBeCloseTo(dx, 5);
      expect(net.dy[k]).toBeCloseTo(dy, 5);
      expect(net.dz[k]).toBeCloseTo(dz, 5);
      // Длина, сохранённая в списке, обязана совпадать с модулем вектора —
      // иначе раскраска по деформации и отрисовка разойдутся.
      const r = Math.sqrt(dx * dx + dy * dy + dz * dz);
      expect(net.length[k]).toBeCloseTo(r, 5);
      expect(net.length[k]).toBeLessThan(DEFAULT_BOND_RADIUS);
      checked++;
    }
    expect(checked).toBeGreaterThan(10);
  });

  it('у ГЦК-кристалла ровно 12 связей на атом', () => {
    // Координационное число ГЦК равно 12 — это определённая величина, а не
    // «примерно». Радиус 1.45σ захватывает первую оболочку (1.122σ) и
    // отсекает вторую (1.587σ), поэтому проверка точная.
    const world = makeWorld(500, 0.95, 0.15);
    const net = new BondNetwork(DEFAULT_BOND_RADIUS);
    net.build(world.state, world.box, true);

    const coordination = net.meanCoordination(world.state);
    expect(coordination).toBeGreaterThan(11.4);
    expect(coordination).toBeLessThan(12.6);
  });

  it('у разрежённого газа связей почти нет', () => {
    const world = new World(
      { count: 400, density: 0.05, temperature: 1.5, thermostat: 'berendsen', boundary: 'periodic' },
      4242,
      'random',
    );
    world.run(200);
    const net = new BondNetwork(DEFAULT_BOND_RADIUS);
    net.build(world.state, world.box, true);
    // При ρ* = 0.05 среднее расстояние ≈ 2.7σ, что заметно больше радиуса
    // связи 1.45σ: соседей почти нет.
    expect(net.meanCoordination(world.state)).toBeLessThan(1);
  });

  it('число связей у жидкости между кристаллом и газом', () => {
    const crystal = makeWorld(400, 0.95, 0.15);
    const liquid = makeWorld(400, 0.7, 1.1);
    const gas = new World(
      { count: 400, density: 0.05, temperature: 1.5, thermostat: 'berendsen', boundary: 'periodic' },
      99,
      'random',
    );
    gas.run(200);

    const net = new BondNetwork(DEFAULT_BOND_RADIUS);
    net.build(crystal.state, crystal.box, true);
    const cCrystal = net.meanCoordination(crystal.state);
    net.build(liquid.state, liquid.box, true);
    const cLiquid = net.meanCoordination(liquid.state);
    net.build(gas.state, gas.box, true);
    const cGas = net.meanCoordination(gas.state);

    expect(cCrystal).toBeGreaterThan(cLiquid);
    expect(cLiquid).toBeGreaterThan(cGas);
    // У жидкости координационное число заметно ниже 12: связи постоянно
    // рвутся и образуются, часть атомов имеет 10–11 соседей.
    expect(cLiquid).toBeLessThan(11.8);
  });

  it('разброс длин связей: у кристалла меньше, чем у жидкости', () => {
    const net = new BondNetwork(DEFAULT_BOND_RADIUS);
    const crystal = makeWorld(500, 0.95, 0.1);
    net.build(crystal.state, crystal.box, true);
    const spreadCrystal = net.lengthSpread();

    const liquid = makeWorld(500, 0.7, 1.2);
    net.build(liquid.state, liquid.box, true);
    const spreadLiquid = net.lengthSpread();

    expect(spreadCrystal).toBeLessThan(spreadLiquid);
    // У идеального кристалла длины связей почти равны: разброс в разы меньше,
    // чем у жидкости, где оболочка размыта тепловым движением.
    expect(spreadCrystal).toBeLessThan(0.08);
  });

  it('без периодических границ связи не «прошивают» ящик', () => {
    // Открытый ящик: минимальный образ применяться не должен. Частицы у
    // противоположных стенок соединены быть не могут, каким бы близким ни
    // казалось расстояние «через границу».
    const world = new World(
      { count: 300, density: 0.5, temperature: 0.9, thermostat: 'berendsen', boundary: 'open' },
      555,
      'random',
    );
    world.run(100);
    const net = new BondNetwork(DEFAULT_BOND_RADIUS);
    net.build(world.state, world.box, false);

    const expected = bruteForcePairs(world.state, world.box, DEFAULT_BOND_RADIUS, false);
    expect(net.pairCount).toBe(expected.length);

    // Ни один вектор связи не длиннее радиуса — при ошибке с минимальным
    // образом появились бы отрезки длиной порядка ящика.
    for (let k = 0; k < net.pairCount; k++) {
      expect(net.length[k]).toBeLessThanOrEqual(DEFAULT_BOND_RADIUS);
    }
  });

  it('работает и на ящике, который не вмещает сетку (мелкий ящик)', () => {
    // Маленький ящик: n = max(3, floor(box / 1.45)) даёт ячейку меньше
    // радиуса связи, и обход окрестности потерял бы пары. Мир обязан
    // переключиться на честный перебор.
    const world = new World(
      { count: 64, density: 0.9, temperature: 0.5, thermostat: 'berendsen', boundary: 'periodic' },
      13,
      'fcc',
    );
    const net = new BondNetwork(DEFAULT_BOND_RADIUS);
    net.build(world.state, world.box, true);

    const expected = bruteForcePairs(world.state, world.box, DEFAULT_BOND_RADIUS, true);
    expect(net.pairCount).toBe(expected.length);
    expect(net.pairCount).toBeGreaterThan(0);
  });

  it('пересчёт на новом положении не оставляет старых пар', () => {
    const world = makeWorld(400, 0.7, 0.9);
    const net = new BondNetwork(DEFAULT_BOND_RADIUS);
    net.build(world.state, world.box, true);
    const before = net.pairCount;

    // Раздуваем систему: плотность падает, связей должно стать меньше.
    world.setDensity(0.25);
    net.build(world.state, world.box, true);
    expect(net.pairCount).toBeLessThan(before);
    // Счётчик обязан быть именно числом актуальных пар, а не «накопленным»:
    // старые записи за пределами `pairCount` не должны попадать в статистику.
    const expected = bruteForcePairs(world.state, world.box, DEFAULT_BOND_RADIUS, true);
    expect(net.pairCount).toBe(expected.length);
  });

  it('смена радиуса связи перестраивает окрестность', () => {
    const world = makeWorld(400, 0.8, 0.3);
    const net = new BondNetwork(1.3);
    net.build(world.state, world.box, true);
    const narrow = net.pairCount;

    net.setCutoff(1.8);
    net.build(world.state, world.box, true);
    const wide = net.pairCount;

    // Больший радиус обязан дать не меньше пар: первая оболочка целиком
    // входит во вторую.
    expect(wide).toBeGreaterThan(narrow);
    const expected = bruteForcePairs(world.state, world.box, 1.8, true);
    expect(wide).toBe(expected.length);
  });

  it('координационное число равно 12 и при другой плотности кристалла', () => {
    // Радиус связи должен захватывать первую оболочку при разумном сжатии и
    // растяжении решётки: иначе «12» окажется случайным совпадением
    // одной плотности.
    for (const density of [0.9, 1.0, 1.05]) {
      const world = new World(
        { count: 500, density, temperature: 0.1, thermostat: 'none', boundary: 'periodic' },
        321,
        'fcc',
      );
      world.run(300);
      const net = new BondNetwork(DEFAULT_BOND_RADIUS);
      net.build(world.state, world.box, true);
      const coordination = net.meanCoordination(world.state);
      expect(coordination, `плотность ${density}`).toBeGreaterThan(11);
      expect(coordination, `плотность ${density}`).toBeLessThan(12.9);
    }
  });

  it('длина связи близка к 2^(1/6)σ у равновесного кристалла', () => {
    const world = makeWorld(500, 0.95, 0.05, 600);
    const net = new BondNetwork(DEFAULT_BOND_RADIUS);
    net.build(world.state, world.box, true);
    let sum = 0;
    for (let k = 0; k < net.pairCount; k++) sum += net.length[k];
    const mean = sum / net.pairCount;
    expect(mean).toBeGreaterThan(1.08);
    expect(mean).toBeLessThan(1.16);
    expect(BondNetwork.equilibriumLength).toBeCloseTo(1.1225, 3);
  });

  it('на пустой системе не падает и не выдумывает связи', () => {
    const state = buildState('random', 1, 0.5, 1, 1).state;
    const net = new BondNetwork(DEFAULT_BOND_RADIUS);
    net.build(state, boxLength(1, 0.5), true);
    expect(net.pairCount).toBe(0);
    expect(net.meanCoordination(state)).toBe(0);
    expect(net.lengthSpread()).toBe(0);
    expect(net.truncated).toBe(false);
  });
});
