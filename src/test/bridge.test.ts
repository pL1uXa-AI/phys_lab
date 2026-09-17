/**
 * Тесты моста физики и зеркала.
 *
 * ─── Что здесь проверяется ───────────────────────────────────────────────
 *
 * Мост — это место, где легче всего получить «тихо неправильное» поведение:
 * команда ушла не туда, состояние прочитано из одного места, а изменено в
 * другом, кадр не обновился. Такие дефекты не бросаются в глаза: сцена
 * выглядит работающей, просто немного не той.
 *
 * Поэтому проверяется три группы свойств:
 *
 *   1. Маршрутизация команд — в локальном режиме они доходят до мира, в
 *      режиме воркера уходят в порт и не трогают локальный мир.
 *   2. Зеркало отдаёт ЧИТАТЕЛЯМ то же, что настоящий мир: проекция, цвета,
 *      связи, измерение. Расхождение здесь означало бы, что клики бьют мимо,
 *      а цвета не соответствуют физике.
 *   3. Откат: если воркер не поднялся, мост остаётся рабочим на локальном
 *      мире и сообщает причину, а не падает и не молчит.
 */

import { describe, expect, it } from 'vitest';
import { World } from '../core/world.js';
import { PhysicsBridge } from '../worker/bridge.js';
import { WorldMirror } from '../worker/mirror.js';
// Ось взгляда живёт в ядре, и тест сверяет зеркало именно с ней: формулы
// обязаны совпадать, иначе кисть бьёт не туда, куда смотрит курсор.
import { viewAxis } from '../core/integrator.js';
import { localFrame } from '../worker/client.js';
import type { WorkerCommand } from '../worker/protocol.js';

/** Подставной порт воркера: записывает команды и умеет отвечать. */
class FakePort {
  readonly commands: WorkerCommand[] = [];
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  terminated = false;

  postMessage(command: WorkerCommand): void {
    this.commands.push(command);
  }

  terminate(): void {
    this.terminated = true;
  }

  reply(event: unknown): void {
    this.onmessage?.({ data: event } as MessageEvent<unknown>);
  }

  ofType(type: string): WorkerCommand[] {
    return this.commands.filter((command) => command.type === type);
  }

  get last(): WorkerCommand | undefined {
    return this.commands[this.commands.length - 1];
  }
}

/** Мир для тестов. */
function makeWorld(count = 256, seed = 20260214): World {
  const world = new World(
    { count, density: 0.8, temperature: 1.0, thermostat: 'langevin', boundary: 'periodic' },
    seed,
    'fcc',
  );
  world.run(60);
  return world;
}

/** Мост в локальном режиме. */
function localBridge(): { bridge: PhysicsBridge; world: World } {
  const world = makeWorld();
  return { bridge: new PhysicsBridge(world), world };
}

/** Мост в режиме воркера с подставным портом. */
function workerBridge(): { bridge: PhysicsBridge; port: FakePort; local: World } {
  const local = makeWorld();
  const bridge = new PhysicsBridge(local);
  const port = new FakePort();
  const ok = bridge.enableWorker(() => port as unknown as Worker);
  expect(ok).toBe(true);
  port.reply({ type: 'ready', count: local.state.count, box: local.box });
  return { bridge, port, local };
}

describe('мост физики: режимы', () => {
  it('по умолчанию работает на локальном мире', () => {
    const { bridge, world } = localBridge();
    expect(bridge.status().mode).toBe('local');
    expect(bridge.world).toBe(world);
    expect(bridge.usingWorker).toBe(false);
  });

  it('enableWorker переключает режим и создаёт мир в воркере', () => {
    const { bridge, port } = workerBridge();
    expect(bridge.status().mode).toBe('worker');
    expect(bridge.workerReady).toBe(true);
    // Мир создаётся с параметрами локального: переключение не должно
    // менять систему, иначе игрок увидит «прыжок» состояния.
    const init = port.ofType('init')[0] as unknown as { params: { density: number } };
    expect(init.params.density).toBeCloseTo(0.8, 9);
  });

  it('если воркер не поднялся, мост остаётся на локальном мире', () => {
    // Ключевая проверка отката: приложение обязано продолжить работу, а не
    // упасть и не остаться без физики вовсе.
    const local = makeWorld();
    const bridge = new PhysicsBridge(local);
    const ok = bridge.enableWorker(() => {
      throw new Error('воркеры запрещены политикой');
    });
    expect(ok).toBe(false);
    expect(bridge.status().mode).toBe('local');
    expect(bridge.status().error).toContain('воркеры запрещены');
    // И приложение продолжает считать локально.
    bridge.advance(5);
    expect(bridge.world).toBe(local);
  });

  it('disableWorker возвращает локальный мир', () => {
    const { bridge, port } = workerBridge();
    bridge.disableWorker();
    expect(bridge.status().mode).toBe('local');
    expect(port.terminated).toBe(true);
  });
});

describe('мост физики: маршрутизация команд', () => {
  it('в локальном режиме шаги идут в мир', () => {
    const { bridge, world } = localBridge();
    const before = world.steps;
    bridge.advance(7);
    expect(world.steps - before).toBe(7);
  });

  it('в режиме воркера шаги уходят командой, а не считаются локально', () => {
    // Если бы шаги считались ещё и локально, физика пошла бы в двух местах
    // сразу — это и есть «частицы дрожат».
    const { bridge, port, local } = workerBridge();
    const before = local.steps;
    bridge.advance(12);
    const run = port.ofType('run').pop() as unknown as { steps: number };
    expect(run.steps).toBe(12);
    expect(local.steps).toBe(before);
  });

  it('команды до готовности мира не теряются', () => {
    const local = makeWorld();
    const bridge = new PhysicsBridge(local);
    const port = new FakePort();
    bridge.enableWorker(() => port as unknown as Worker);
    // Мир ещё не ответил `ready`, но приложение уже шлёт шаги.
    bridge.advance(5);
    bridge.setTemperature(1.4);
    expect(port.ofType('run')).toHaveLength(0);

    port.reply({ type: 'ready', count: local.state.count, box: local.box });
    expect(port.ofType('run')).toHaveLength(1);
    const configure = port.ofType('configure').pop() as unknown as { patch: { temperature: number } };
    expect(configure.patch.temperature).toBe(1.4);
  });

  it('каждая команда уходит в воркер своей формой', () => {
    const { bridge, port } = workerBridge();
    bridge.setDensity(0.9);
    expect(port.last).toEqual({ type: 'setDensity', density: 0.9 });

    bridge.resize(500, 0.7, 'fcc');
    expect(port.last).toEqual({ type: 'resize', count: 500, density: 0.7, lattice: 'fcc' });

    bridge.setThermostat('berendsen');
    expect(port.last).toEqual({ type: 'configure', patch: { thermostat: 'berendsen' } });

    bridge.setBoundary('open');
    expect(port.last).toEqual({ type: 'configure', patch: { boundary: 'open' } });

    bridge.freezeAll();
    expect(port.last).toEqual({ type: 'freezeAll' });

    bridge.unfreezeAll();
    expect(port.last).toEqual({ type: 'unfreezeAll' });

    bridge.applyTemperatureNow();
    expect(port.last).toEqual({ type: 'applyTemperatureNow' });

    bridge.scaleVelocities(1.3);
    expect(port.last).toEqual({ type: 'scaleVelocities', factor: 1.3 });

    bridge.setBondRadius(1.6);
    expect(port.last).toEqual({ type: 'setBondRadius', radius: 1.6 });

    bridge.sampleRadial();
    expect(port.last).toEqual({ type: 'sampleRadial' });
  });

  it('заморозка области в режиме воркера не подменяется молча', () => {
    // Область задаётся осью взгляда, а её в команду передать пока нельзя.
    // Вернуть «заморозили всё» было бы хуже, чем вернуть ноль: игрок увидит,
    // что операция не сработала, а не получит неверный результат.
    const { bridge, port } = workerBridge();
    const frozenCount = port.commands.length;
    const result = bridge.freezeRegion(
      { w: viewAxis(0, 1), center: { x: 1, y: 1, z: 1 } },
      2,
    );
    expect(result).toBe(0);
    expect(port.commands.length).toBe(frozenCount);
  });

  it('кисть уходит в воркер вместе с осью взгляда', () => {
    const { bridge, port } = workerBridge();
    const axis = viewAxis(0.5, 0.9);
    bridge.requestPoke({
      plane: { w: axis, center: { x: 2, y: 3, z: 4 } },
      dx: 0.1,
      dy: 0.2,
      dz: 0,
      radius: 3,
      strength: 1,
    });
    const poke = port.last as unknown as { type: string; center: { x: number }; radius: number };
    expect(poke.type).toBe('poke');
    expect(poke.center.x).toBe(2);
    expect(poke.radius).toBe(3);
  });

  it('снимок в локальном режиме доступен сразу', async () => {
    const { bridge } = localBridge();
    const json = await bridge.requestSnapshot();
    expect(json.length).toBeGreaterThan(1000);
    expect(json).toContain('"version"');
  });

  it('снимок в режиме воркера приходит отдельным событием', async () => {
    const { bridge, port } = workerBridge();
    const pending = bridge.requestSnapshot();
    port.reply({ type: 'snapshot', json: '{"version":1}' });
    await expect(pending).resolves.toBe('{"version":1}');
  });

  it('восстановление в локальном режиме проверяет снимок', () => {
    const { bridge } = localBridge();
    expect(bridge.restoreJson('не json')).toContain('JSON');
  });
});

describe('зеркало: чтение совпадает с настоящим миром', () => {
  it('проекция, цвета, связи и измерение совпадают', () => {
    const world = makeWorld();
    const mirror = new WorldMirror(localFrame(world));

    const yaw = 0.6;
    const pitch = 0.9;
    const fromWorld = new Float32Array(world.state.count * 3);
    const fromMirror = new Float32Array(mirror.state.count * 3);
    world.project(yaw, pitch, fromWorld);
    mirror.project(yaw, pitch, fromMirror);
    for (let i = 0; i < fromWorld.length; i++) {
      expect(fromMirror[i]).toBeCloseTo(fromWorld[i], 6);
    }

    for (const mode of ['speed', 'density', 'travel'] as const) {
      const a = world.colorValues(mode);
      const b = mirror.colorValues(mode);
      expect(b.min, mode).toBeCloseTo(a.min, 9);
      expect(b.max, mode).toBeCloseTo(a.max, 9);
    }

    const netWorld = world.bondNetwork();
    const netMirror = mirror.bondNetwork();
    expect(netMirror.pairCount).toBe(netWorld.pairCount);

    expect(mirror.measurement.temperature).toBeCloseTo(world.measurement.temperature, 9);
    expect(mirror.potentialEnergy).toBeCloseTo(world.potentialEnergy, 9);
    expect(mirror.box).toBeCloseTo(world.box, 12);
    expect(mirror.time).toBeCloseTo(world.time, 9);
    expect(mirror.steps).toBe(world.steps);
  });

  it('число степеней свободы учитывает границы', () => {
    // При периодических границах три степени свободы забраны центром масс.
    // Если это не учесть, температура окажется систематически завышена.
    const periodic = makeWorld();
    const mirrorP = new WorldMirror(localFrame(periodic));
    expect(mirrorP.measurement.dof).toBe(3 * periodic.state.count - 3);

    const open = new World(
      { count: 200, density: 0.5, temperature: 1.0, thermostat: 'berendsen', boundary: 'open' },
      5,
      'random',
    );
    open.run(20);
    const mirrorO = new WorldMirror(localFrame(open));
    expect(mirrorO.measurement.dof).toBe(3 * open.state.count);
  });

  it('кривые для графиков доходят через зеркало', () => {
    const world = makeWorld();
    for (let i = 0; i < 12; i++) {
      world.run(20);
      world.sampleRadial();
    }
    const mirror = new WorldMirror(localFrame(world));

    const radialWorld = world.radialDistribution();
    const radialMirror = mirror.radialDistribution();
    expect(radialMirror.r.length).toBe(radialWorld.r.length);
    expect(radialMirror.g.length).toBe(radialWorld.g.length);

    const structureMirror = mirror.structureFactor();
    expect(structureMirror.k.length).toBeGreaterThan(0);
    expect(mirror.structure.sampleCount).toBe(world.structure.sampleCount);

    const msdMirror = mirror.msdCurve();
    expect(msdMirror.lag.length).toBe(world.msdCurve().lag.length);

    // История есть и доступна по индексу — по ней рисуются графики T и E.
    expect(mirror.history.size).toBeGreaterThan(0);
    const series = mirror.history.series('temperature');
    expect(series.t.length).toBeGreaterThan(0);
    expect(series.v.length).toBe(series.t.length);
    expect(Number.isFinite(series.v[series.v.length - 1])).toBe(true);
  });

  it('история отдаёт нужные ряды и не врёт про размер', () => {
    const world = makeWorld();
    world.run(200);
    const mirror = new WorldMirror(localFrame(world));
    for (const key of ['temperature', 'kinetic', 'potential', 'total'] as const) {
      const series = mirror.history.series(key);
      let sum = 0;
      for (const value of series.v) sum += Math.abs(value);
      // Нулевой ряд означал бы, что поле не заполнено — молчаливая потеря
      // данных на графике.
      expect(sum, `ряд ${key}`).toBeGreaterThan(0);
    }
    // Недоступный индекс отдаёт undefined, а не падает.
    expect(mirror.history.get(-1)).toBeUndefined();
    expect(mirror.history.get(mirror.history.size)).toBeUndefined();
  });

  it('ось взгляда совпадает с осью мира', () => {
    // По ней бьёт кисть: расхождение означало бы, что толчок уходит не туда,
    // куда показывает курсор.
    const world = makeWorld();
    for (const [yaw, pitch] of [
      [0, 0],
      [0.6, 0.9],
      [-1.2, -0.4],
    ] as const) {
      const fromWorld = world.viewAxis(yaw, pitch);
      const fromMirror = viewAxis(yaw, pitch);
      expect(fromMirror.ax).toBeCloseTo(fromWorld.ax, 9);
      expect(fromMirror.ay).toBeCloseTo(fromWorld.ay, 9);
      expect(fromMirror.az).toBeCloseTo(fromWorld.az, 9);
      expect(fromMirror.rx).toBeCloseTo(fromWorld.rx, 9);
      expect(fromMirror.ry).toBeCloseTo(fromWorld.ry, 9);
      expect(fromMirror.rz).toBeCloseTo(fromWorld.rz, 9);
      expect(fromMirror.ux).toBeCloseTo(fromWorld.ux, 9);
      expect(fromMirror.uy).toBeCloseTo(fromWorld.uy, 9);
      expect(fromMirror.uz).toBeCloseTo(fromWorld.uz, 9);
    }
  });

  it('зеркало не предоставляет мутаторов', () => {
    // Это не «стилистическое» требование: наличие step() у зеркала однажды
    // привело бы к тому, что кто-то «быстро поправит» физику в главном
    // потоке, и состояние разъедется с воркером.
    const mirror = new WorldMirror(localFrame(makeWorld(64))) as unknown as Record<string, unknown>;
    for (const name of ['step', 'run', 'resize', 'setDensity', 'applyTemperatureNow', 'rebuild']) {
      expect(mirror[name], `у зеркала не должно быть ${name}`).toBeUndefined();
    }
  });
});
