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
import { LevelSession } from '../levels/session.js';
import { LEVELS } from '../levels/levels.js';
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

/**
 * Подтвердить воркеру, что он выполнил заказанные шаги.
 *
 * Мост держит очередь заказов и не шлёт новые, пока воркер не подтвердил
 * предыдущие кадром. В тестах воркер отвечает только `ready`, поэтому очередь
 * нужно «разгружать» вручную — иначе обратное давление (намеренно) заблокирует
 * все последующие заказы.
 */
function confirmSteps(bridge: PhysicsBridge, port: FakePort, executed: number): void {
  const world = makeWorld();
  const frame = localFrame(world);
  port.reply({
    type: 'frame',
    payload: { ...frame, summary: { ...frame.summary, stepsExecuted: executed } },
  });
  bridge.sync();
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
    // Воркер при создании получил заказ «догнать» локальный мир. Пока он его
    // не подтвердил, кадров нет, и обратное давление обязано придержать
    // новые заказы — иначе очередь росла бы.
    confirmSteps(bridge, port, local.steps);
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

  it('заморозка области уходит в воркер вместе с осью взгляда', () => {
    /*
     * Раньше здесь проверялось обратное: `freezeRegion` возвращал 0 и НИЧЕГО
     * не отправлял, потому что «ось взгляда в команду передать нельзя».
     * На деле её передавать можно — тем же способом, что и кисть (см. соседний
     * тест), поэтому кнопка «Заморозить» в режиме воркера была мертва.
     *
     * Теперь проверяется, что команда уходит и несёт ровно те данные, по
     * которым воркер построит тот же цилиндр, что и главный поток.
     */
    const { bridge, port } = workerBridge();
    const before = port.commands.length;
    const axis = viewAxis(0.6, 0.9);
    const result = bridge.freezeRegion({ w: axis, center: { x: 1, y: 2, z: 3 } }, 2.5);

    // Отрицательное значение — «отправлено, число узнаем из кадра»: оно
    // отличимо от «заморожено 0 частиц», и это важно (см. нули в CSV).
    expect(result).toBe(-1);
    expect(port.commands.length).toBe(before + 1);
    const command = port.last as unknown as {
      type: string;
      axis: { ax: number; ay: number; az: number };
      center: { x: number; y: number; z: number };
      radius: number;
    };
    expect(command.type).toBe('freezeRegion');
    expect(command.radius).toBe(2.5);
    expect(command.center).toEqual({ x: 1, y: 2, z: 3 });
    expect(command.axis.ax).toBeCloseTo(axis.ax, 9);
    expect(command.axis.ay).toBeCloseTo(axis.ay, 9);
    expect(command.axis.az).toBeCloseTo(axis.az, 9);
  });

  it('заморозка области в локальном режиме возвращает число частиц', () => {
    // Локальный режим считает сразу, поэтому здесь ответ конкретный, и он
    // отличается от «отправлено» — проверяем именно различие.
    const { bridge, world } = localBridge();
    // Ставим частицы плотной решёткой и морозим цилиндр через центр ящика.
    const center = world.box * 0.5;
    const frozen = bridge.freezeRegion(
      { w: viewAxis(0, 0), center: { x: center, y: center, z: center } },
      world.box * 0.6,
    );
    expect(frozen).toBeGreaterThan(0);
    let masked = 0;
    for (let i = 0; i < world.state.count; i++) if (world.frozen[i] !== 0) masked++;
    expect(masked).toBe(frozen);
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

  /*
   * ─── Обратное давление очереди ──────────────────────────────────────────
   *
   * Группа проверок на регрессию, из-за которой «не работала пауза».
   *
   * Главный поток заказывал шаги каждый кадр отрисовки, не глядя, успевает ли
   * воркер. На замерах очередь доходила до 2100 шагов, и после нажатия
   * «Пауза» воркер продолжал шагать ещё около 950 шагов — со стороны это
   * выглядело как «кнопка не работает». Причина была именно в отсутствии
   * обратной связи, а не в самой кнопке.
   */
  it('пока воркер не подтвердил шаги, новые порции не заказываются', () => {
    const { bridge, port } = workerBridge();
    // Мир воркера создан, но кадра с подтверждением ещё не было: в очереди
    // висит начальный заказ, и новый заказ обязан быть придержан.
    const before = port.ofType('run').length;
    bridge.advance(8);
    expect(port.ofType('run').length).toBe(before);
    expect(bridge.backlog).toBeGreaterThan(0);
  });

  it('после подтверждения кадром очередь снова пропускает заказы', () => {
    const { bridge, port, local } = workerBridge();
    confirmSteps(bridge, port, local.steps);
    expect(bridge.backlog).toBe(0);
    const before = port.ofType('run').length;
    bridge.advance(8);
    expect(port.ofType('run').length).toBe(before + 1);
  });

  it('одиночный «Шаг» выполняется даже при занятой очереди', () => {
    /*
     * Покадровый заказ обязан уважать обратное давление, но дискретное
     * действие игрока — нет: молча проглотить нажатие «Шаг» значит показать
     * игроку неработающую кнопку. Это ровно тот класс дефектов, который и
     * привёл к жалобе на «Пуск/Пауза».
     */
    const { bridge, port } = workerBridge();
    const before = port.ofType('run').length;
    bridge.advance(1, true);
    expect(port.ofType('run').length).toBe(before + 1);
  });

  it('смена числа частиц согласует учёт очереди, а не залипает', () => {
    // Пересборка заменяет мир, поэтому «долг» надо пересчитать от того, что
    // воркер уже подтвердил. Иначе очередь либо залипнет навсегда, либо
    // обратное давление перестанет работать.
    const { bridge, port, local } = workerBridge();
    confirmSteps(bridge, port, local.steps);
    bridge.resize(512, 0.8, 'fcc');
    expect(bridge.backlog).toBe(0);
    const before = port.ofType('run').length;
    bridge.advance(6);
    expect(port.ofType('run').length).toBe(before + 1);
  });

  it('счётчик выполненного доходит из кадра и не путается со steps', () => {
    const { bridge, port, local } = workerBridge();
    confirmSteps(bridge, port, local.steps + 500);
    expect(bridge.world.stepsExecuted).toBe(local.steps + 500);
    // `steps` — про текущую траекторию, он сбрасывается пересборкой.
    expect(bridge.world.steps).toBe(local.steps);
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

  it('зеркало отдаёт ВСЕ столбцы истории, а не нули вместо части из них', () => {
    /*
     * Регрессия с тихой потерей данных.
     *
     * Давление, пик g(r) и доля подвижных сначала не кладывались в кадр:
     * «их графиков в приложении нет». Но те же замеры выгружаются в CSV, и в
     * режиме воркера три столбца из восьми уходили нулями, тогда как в
     * локальном режиме были заполнены. Внешне файл выглядел нормальным —
     * поэтому дефект и жил.
     *
     * Проверка сравнивает зеркало с настоящим миром по КАЖДОМУ столбцу:
     * расхождение хотя бы в одном снова сделало бы выгрузку неполной.
     */
    const world = makeWorld();
    world.run(400);
    /*
     * Первый пик g(r) заполняется только на кадре статистики: без явного
     * `sampleRadial` он остаётся нулём, и проверка «мир обязан заполнять
     * orderPeak» падала бы — но по вине теста, а не кода. Здесь статистика
     * собирается так же, как это делает приложение.
     */
    for (let i = 0; i < 6; i++) {
      world.run(20);
      world.sampleRadial();
    }
    const mirror = new WorldMirror(localFrame(world));
    expect(mirror.history.size).toBeGreaterThan(0);

    const columns = ['temperature', 'kinetic', 'potential', 'total', 'pressure', 'orderPeak', 'mobileFraction'] as const;
    for (const key of columns) {
      const worldSeries = world.history.series(key);
      const mirrorSeries = mirror.history.series(key);
      let worldSum = 0;
      let mirrorSum = 0;
      for (const value of worldSeries.v) worldSum += Math.abs(value);
      for (const value of mirrorSeries.v) mirrorSum += Math.abs(value);
      expect(worldSum, `мир обязан заполнять ${key}`).toBeGreaterThan(0);
      expect(mirrorSum, `зеркало потеряло столбец ${key}`).toBeGreaterThan(0);
    }

    // И через `get` тоже: по нему собирается CSV на экспорт.
    const last = mirror.history.get(mirror.history.size - 1);
    expect(last?.pressure).not.toBe(0);
    expect(last?.mobileFraction).toBeGreaterThan(0);
  });

  it('зеркало не обнуляет число начал отсчёта MSD', () => {
    /*
     * Тот же класс дефекта, что и потерянные столбцы истории: зеркало
     * возвращало ноль с обоснованием «величина ничего не решает». Отличить
     * «начал нет» от «данные не передали» по такому числу невозможно, а
     * `metrics().msdOrigins` показывал ноль даже при набранной статистике.
     */
    const world = makeWorld();
    for (let i = 0; i < 8; i++) {
      world.run(20);
      world.sampleRadial();
    }
    expect(world.msd.originCount).toBeGreaterThan(0);
    const mirror = new WorldMirror(localFrame(world));
    expect(mirror.msd.originCount).toBe(world.msd.originCount);
    expect(mirror.msd.originCount).toBeGreaterThan(0);
  });

  it('зеркало передаёт участок подгонки MSD, а не весь диапазон', () => {
    /*
     * Зеркало возвращало в `lagRange` весь диапазон лагов. Формально график
     * оставался верным, но подсвеченным оказывался весь график — то есть
     * игрок видел неправду о том, где измерена прямая, по которой посчитан D.
     */
    const world = makeWorld();
    for (let i = 0; i < 40; i++) {
      world.run(20);
      world.sampleRadial();
    }
    const fromWorld = world.diffusion();
    const mirror = new WorldMirror(localFrame(world));
    const fromMirror = mirror.diffusion();
    expect(fromMirror.lagRange[0]).toBeCloseTo(fromWorld.lagRange[0], 6);
    expect(fromMirror.lagRange[1]).toBeCloseTo(fromWorld.lagRange[1], 6);
    // Участок обязан быть уже полного диапазона: иначе это снова «весь график».
    const full = world.msdCurve().lag;
    const fullEnd = full[full.length - 1];
    expect(fromMirror.lagRange[1]).toBeLessThan(fullEnd);
  });

  it('энергия на частицу совпадает с миром, включая убыль частиц', () => {
    /*
     * `potentialPerParticle` — точка отсчёта условия «энергия упала на 25 %»
     * в уровнях. Знаменатель у `World` — число ЖИВЫХ частиц, и на уровнях с
     * открытыми границами (испарение, капля) оно меньше `count`. Если бы
     * зеркало делило на общее число, величина систематически расходилась бы,
     * и уровень не проходился бы в режиме воркера — при полностью верной
     * физике.
     */
    const periodic = makeWorld();
    const mirrorP = new WorldMirror(localFrame(periodic));
    expect(mirrorP.potentialPerParticle).toBeCloseTo(periodic.potentialPerParticle, 9);

    const open = new World(
      { count: 500, density: 0.25, temperature: 1.6, thermostat: 'langevin', boundary: 'open' },
      77,
      'random',
    );
    // Гоняем достаточно, чтобы часть частиц покинула ящик и `alive` стал
    // меньше общего числа — именно этот случай и был опасен.
    open.run(600);
    const frame = localFrame(open);
    let alive = 0;
    for (let i = 0; i < frame.summary.count; i++) if (frame.alive[i] !== 0) alive++;
    expect(alive).toBeLessThan(frame.summary.count);

    const mirrorO = new WorldMirror(frame);
    expect(mirrorO.potentialPerParticle).toBeCloseTo(open.potentialPerParticle, 9);
  });

  it('сессия уровня даёт одинаковый отчёт по миру и по зеркалу', () => {
    /*
     * Это главное доказательство, что кампания может идти в режиме воркера.
     *
     * Раньше при старте уровня приложение ВЫКЛЮЧАЛО воркер, потому что сессия
     * уровня читала накопленную статистику, которой в зеркале не было.
     * Проверка сравнивает отчёты двух сессий на одном и том же состоянии:
     * одну кормят настоящим миром, другую — зеркалом его кадра. Совпадение
     * всех условий означает, что проверки уровня не зависят от источника
     * данных, и воркер выключать не нужно.
     *
     * Ошибка здесь означала бы, что уровень проходится (или не проходится) в
     * зависимости от режима физики — при одном и том же состоянии системы.
     */
    const world = makeWorld(512, 20260214);
    // Прогоняем с накоплением статистики: уровням нужны g(r) и история.
    for (let i = 0; i < 20; i++) {
      world.run(20);
      world.sampleRadial();
    }
    const frame = localFrame(world);
    const mirror = new WorldMirror(frame);

    const level = LEVELS[0];
    // Обе сессии получают ОДНО состояние; окно наполняем одинаково.
    const fromWorld = new LevelSession(level, world);
    const fromMirror = new LevelSession(level, mirror);
    for (let i = 0; i < 200; i++) {
      world.step();
      fromWorld.tick(world);
      // Зеркало обновляем тем же состоянием, что и мир: сравниваем логику
      // проверок, а не синхронность потоков.
      fromMirror.tick(new WorldMirror(localFrame(world)));
    }
    const reportWorld = fromWorld.checkNow(world);
    const reportMirror = fromMirror.checkNow(new WorldMirror(localFrame(world)));

    expect(reportMirror.passed).toBe(reportWorld.passed);
    expect(reportMirror.results.length).toBe(reportWorld.results.length);
    for (let i = 0; i < reportWorld.results.length; i++) {
      expect(reportMirror.results[i].passed, `условие ${i}`).toBe(
        reportWorld.results[i].passed,
      );
    }
    void frame;
  });

  it('зеркало считает ЖИВЫХ частиц, а не размер массивов', () => {
    /*
     * Дефект, из-за которого кампания не работала в режиме воркера.
     *
     * `state.count` — размер массивов; при испарении он НЕ меняется, потому
     * что `removeEscaped` лишь помечает частицу мёртвой. Зеркало подставляло
     * это число в `measurement.count`, а проверки уровней считают убыль как
     * `startCount − count`. Получалось `N − N = 0`: уровень «Испарение»
     * ВСЕГДА видел «испарилось 0 частиц» и не проходился никогда.
     *
     * Замерено до исправления: локально уровень проходился за 21 с, в режиме
     * воркера — не проходился за 90 с (условия «T* ≥ 1.3» и «испарилось ≥ 40»
     * показывали 0.000). После — 8.3 с в воркере и 16.8 с локально.
     */
    const open = new World(
      { count: 500, density: 0.25, temperature: 1.8, thermostat: 'langevin', boundary: 'open' },
      20260214,
      'random',
    );
    open.run(900);
    const frame = localFrame(open);

    let alive = 0;
    for (let i = 0; i < frame.summary.count; i++) if (frame.alive[i] !== 0) alive++;
    // Часть частиц обязана улететь — иначе проверка ничего не проверяет.
    expect(alive).toBeLessThan(frame.summary.count);
    expect(frame.summary.aliveCount).toBe(alive);

    const mirror = new WorldMirror(frame);
    expect(mirror.measurement.count).toBe(alive);
    expect(mirror.measurement.count).toBe(open.measurement.count);
    // Убыль по зеркалу обязана совпасть с убылью по миру — по ней и работает
    // уровень «Испарение».
    const startCount = frame.summary.count;
    expect(startCount - mirror.measurement.count).toBe(startCount - open.measurement.count);
    // `state.count` при этом остаётся размером массивов: по нему идёт обход
    // отрисовки, и он не должен «схлопываться» при испарении.
    expect(mirror.state.count).toBe(frame.summary.count);
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
