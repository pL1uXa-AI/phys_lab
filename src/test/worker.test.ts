/**
 * Тесты протокола воркера и клиента.
 *
 * ─── Что здесь проверяется и почему именно так ───────────────────────────
 *
 * Настоящий `Worker` в Node недоступен, и это к лучшему: проверять надо не
 * «браузер умеет воркеры», а СВОЮ логику — сборку кадра, обмен буферами по
 * владению, очередь команд до готовности, откат при недоступности воркера.
 *
 * Поэтому клиенту подставляется подставной порт: объект с методами
 * `postMessage`/`terminate`, который записывает команды и умеет отвечать
 * событиями. Это даёт полный контроль над сценарием и не зависит от среды.
 *
 * Отдельная группа тестов сверяет, что проекция и раскраска из кадра
 * СОВПАДАЮТ с тем, что даёт локальный `World`: если формулы разойдутся,
 * клики мышью перестанут попадать в частицы, а цвета поедут — и заметить это
 * можно было бы только глазами в браузере.
 */

import { describe, expect, it } from 'vitest';
import { World } from '../core/world.js';
import {
  PhysicsWorkerClient,
  bondsOfFrame,
  colorValuesOfFrame,
  localFrame,
  projectFrame,
} from '../worker/client.js';
import { bondCapacityFor, type FramePayload, type WorkerCommand, type WorkerEvent } from '../worker/protocol.js';

/**
 * Подставной порт воркера.
 *
 * Записывает отправленные команды и переданные буферы, а также позволяет
 * «ответить» событием — так воспроизводятся сценарии, которые иначе
 * требовали бы настоящего потока.
 */
class FakePort {
  readonly commands: WorkerCommand[] = [];
  readonly transfers: ArrayBuffer[][] = [];
  onmessage: ((event: MessageEvent<WorkerEvent>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  terminated = false;

  postMessage(command: WorkerCommand, transfer?: ArrayBuffer[]): void {
    this.commands.push(command);
    this.transfers.push(transfer ?? []);
  }

  terminate(): void {
    this.terminated = true;
  }

  /** Ответить событием, как это сделал бы воркер. */
  reply(event: WorkerEvent): void {
    this.onmessage?.({ data: event } as MessageEvent<WorkerEvent>);
  }

  /** Последняя отправленная команда. */
  get last(): WorkerCommand | undefined {
    return this.commands[this.commands.length - 1];
  }

  /** Все команды заданного типа. */
  ofType(type: string): WorkerCommand[] {
    return this.commands.filter((command) => command.type === type);
  }
}

/** Клиент с подставным портом. */
function makeClient(): { client: PhysicsWorkerClient; port: FakePort } {
  const client = new PhysicsWorkerClient();
  const port = new FakePort();
  const started = client.start(() => port as unknown as Worker);
  expect(started).toBe(true);
  return { client, port };
}

/** Кадр от локального мира — эталон для сравнения. */
function makeFrame(count = 256, seed = 20260214): { world: World; frame: FramePayload } {
  const world = new World(
    { count, density: 0.8, temperature: 1.0, thermostat: 'langevin', boundary: 'periodic' },
    seed,
    'fcc',
  );
  world.run(60);
  return { world, frame: localFrame(world) };
}

describe('протокол воркера: размеры буферов', () => {
  it('ёмкость под связи растёт с числом частиц и ограничена', () => {
    expect(bondCapacityFor(0)).toBeGreaterThanOrEqual(1024);
    expect(bondCapacityFor(1000)).toBe(9000);
    // Потолок: у очень большой системы буфер не должен расти бесконечно.
    expect(bondCapacityFor(100000)).toBe(300000);
  });

  it('ёмкости хватает на реальную сеть связей', () => {
    // Проверяем не формулу, а что её ХВАТАЕТ: если буфер окажется меньше
    // числа пар, кадр молча обрежется, и часть связей исчезнет с экрана.
    for (const count of [256, 500, 2048]) {
      const world = new World(
        { count, density: 0.95, temperature: 0.2, thermostat: 'none', boundary: 'periodic' },
        4242,
        'fcc',
      );
      world.run(80);
      const net = world.bondNetwork();
      expect(net.pairCount, `N = ${count}`).toBeLessThanOrEqual(bondCapacityFor(world.state.count));
    }
  });
});

describe('протокол воркера: клиент', () => {
  it('start сообщает о доступности и подписывается на события', () => {
    const { client } = makeClient();
    expect(client.available).toBe(true);
    expect(client.currentStatus.ready).toBe(false);
  });

  it('init отправляется сразу, остальные команды ждут готовности', () => {
    // Мир в воркере создаётся асинхронно. Если отправить `run` раньше, чем
    // пришло `ready`, воркер ответит ошибкой «команда до создания мира».
    const { client, port } = makeClient();
    client.init({ count: 256 }, 1, 'fcc');
    client.run(10);
    client.run(20);

    expect(port.ofType('init')).toHaveLength(1);
    expect(port.ofType('run')).toHaveLength(0);

    port.reply({ type: 'ready', count: 256, box: 8 });
    // После готовности очередь выливается — и в исходном порядке.
    const runs = port.ofType('run') as Array<{ type: 'run'; steps: number }>;
    expect(runs).toHaveLength(2);
    expect(runs[0].steps).toBe(10);
    expect(runs[1].steps).toBe(20);
  });

  it('кадр сохраняется и отдаётся через consume', () => {
    const { client, port } = makeClient();
    client.init({}, 1, 'fcc');
    port.reply({ type: 'ready', count: 10, box: 5 });

    const frame = localFrame(makeSyntheticWorld());
    port.reply({ type: 'frame', payload: frame });
    expect(client.currentStatus.framesReceived).toBe(1);
    expect(client.consume()).toBe(frame);
  });

  it('consume возвращает буферы прошлого кадра, когда пришёл новый', () => {
    const { client, port } = makeClient();
    client.init({}, 1, 'fcc');
    port.reply({ type: 'ready', count: 10, box: 5 });

    const first = localFrame(makeSyntheticWorld());
    port.reply({ type: 'frame', payload: first });
    client.consume();
    expect(port.ofType('recycle')).toHaveLength(0);

    const second = localFrame(makeSyntheticWorld());
    port.reply({ type: 'frame', payload: second });
    client.consume();
    // Прошлый кадр вернулся ровно один раз.
    expect(port.ofType('recycle')).toHaveLength(1);
  });

  it('ПОВТОРНЫЙ consume без нового кадра НЕ возвращает буферы', () => {
    /*
     * Это тест на дефект, найденный только в браузере.
     *
     * `sync()` вызывается каждый кадр отрисовки, а воркер присылает новый
     * кадр не каждый (на 20 000 частиц шаг дольше кадра экрана). Прежняя
     * версия `consume` возвращала в пул «предыдущий» кадр, не проверяя,
     * сменился ли он, — то есть отчуждала буферы ТОГО САМОГО кадра, который
     * в этот момент читало зеркало. Падение выглядело как
     * «Cannot perform Construct on a detached ArrayBuffer».
     *
     * Поэтому здесь проверяется именно ПОВТОРНЫЙ вызов без нового кадра:
     * буферы не должны уйти воркеру, пока кадр не сменился.
     */
    const { client, port } = makeClient();
    client.init({}, 1, 'fcc');
    port.reply({ type: 'ready', count: 10, box: 5 });

    const frame = localFrame(makeSyntheticWorld());
    port.reply({ type: 'frame', payload: frame });
    client.consume();
    expect(port.ofType('recycle')).toHaveLength(0);

    // Второй вызов подряд: нового кадра нет.
    client.consume();
    client.consume();
    expect(port.ofType('recycle')).toHaveLength(0);

    // А когда кадр действительно сменился — буферы уходят.
    port.reply({ type: 'frame', payload: localFrame(makeSyntheticWorld()) });
    client.consume();
    expect(port.ofType('recycle')).toHaveLength(1);
  });

  it('stop обнуляет кадр: ссылки на отчуждённую память не остаётся', () => {
    /*
     * После передачи по владению буфер отчуждён, и обращение к нему падает.
     * Если клиент хранит такой кадр после остановки, зеркало продолжит его
     * читать — этим и была сломана легенда раскраски в браузере.
     */
    const { client, port } = makeClient();
    client.init({}, 1, 'fcc');
    port.reply({ type: 'ready', count: 10, box: 5 });
    port.reply({ type: 'frame', payload: localFrame(makeSyntheticWorld()) });
    client.consume();
    client.stop();
    expect(client.frame).toBeNull();
    expect(client.lastFrame).toBeNull();
  });

  it('ошибка воркера видна в статусе, а не глотается', () => {
    const { client, port } = makeClient();
    port.reply({ type: 'error', message: 'что-то сломалось' });
    expect(client.currentStatus.error).toBe('что-то сломалось');
  });

  it('stop завершает воркер и сбрасывает состояние', () => {
    const { client, port } = makeClient();
    client.init({}, 1, 'fcc');
    port.reply({ type: 'ready', count: 10, box: 5 });
    port.reply({ type: 'frame', payload: localFrame(makeSyntheticWorld()) });

    client.stop();
    expect(port.terminated).toBe(true);
    expect(client.available).toBe(false);
    expect(client.frame).toBeNull();
  });

  it('недоступность воркера возвращает false, а не бросает', () => {
    // Откат обязан быть предсказуемым: приложение должно узнать, что воркера
    // нет, и продолжить на локальном мире.
    const client = new PhysicsWorkerClient();
    const started = client.start(() => {
      throw new Error('воркеры запрещены политикой');
    });
    expect(started).toBe(false);
    expect(client.available).toBe(false);
    expect(client.currentStatus.error).toContain('воркеры запрещены');
  });

  it('подписка на события получает кадры и снимки', () => {
    const { client, port } = makeClient();
    const seen: string[] = [];
    const unsubscribe = client.subscribe((event) => seen.push(event.type));
    port.reply({ type: 'ready', count: 1, box: 1 });
    port.reply({ type: 'snapshot', json: '{}' });
    unsubscribe();
    port.reply({ type: 'ready', count: 1, box: 1 });
    expect(seen).toEqual(['ready', 'snapshot']);
  });

  it('до старта команды игнорируются, а не копятся бесконечно', () => {
    const client = new PhysicsWorkerClient();
    client.run(10);
    expect(client.currentStatus.framesReceived).toBe(0);
  });
});

describe('протокол воркера: кадр и локальный мир не расходятся', () => {
  it('проекция из кадра совпадает с проекцией мира', () => {
    // Совпадение критично: по этой формуле считается попадание мыши в
    // частицы. Разочарование в один пиксель уже ломает кисть.
    const { world, frame } = makeFrame();
    const yaw = 0.7;
    const pitch = 0.9;
    const fromWorld = new Float32Array(world.state.count * 3);
    world.project(yaw, pitch, fromWorld);

    const fromFrame = new Float32Array(frame.summary.count * 3);
    projectFrame(frame, yaw, pitch, fromFrame);

    for (let i = 0; i < world.state.count * 3; i++) {
      expect(fromFrame[i]).toBeCloseTo(fromWorld[i], 6);
    }
  });

  it('раскраска из кадра совпадает с раскраской мира', () => {
    const { world, frame } = makeFrame();
    for (const mode of ['speed', 'density', 'travel', 'plain'] as const) {
      const fromWorld = world.colorValues(mode);
      const fromFrame = colorValuesOfFrame(frame, mode);
      expect(fromFrame.min, `режим ${mode}`).toBeCloseTo(fromWorld.min, 6);
      expect(fromFrame.max, `режим ${mode}`).toBeCloseTo(fromWorld.max, 6);
      for (let i = 0; i < world.state.count; i += 17) {
        expect(fromFrame.values[i], `режим ${mode}, частица ${i}`).toBeCloseTo(fromWorld.values[i], 6);
      }
    }
  });

  it('сеть связей из кадра совпадает с сетью мира', () => {
    const { world, frame } = makeFrame();
    const net = world.bondNetwork();
    const mirrored = bondsOfFrame(frame);
    expect(mirrored.pairCount).toBe(net.pairCount);
    for (let k = 0; k < net.pairCount; k += 23) {
      expect(mirrored.a[k]).toBe(net.a[k]);
      expect(mirrored.b[k]).toBe(net.b[k]);
      expect(mirrored.length[k]).toBeCloseTo(net.length[k], 5);
      expect(mirrored.dx[k]).toBeCloseTo(net.dx[k], 5);
    }
  });

  it('сводка кадра совпадает с измерениями мира', () => {
    const { world, frame } = makeFrame();
    const m = world.measurement;
    expect(frame.summary.count).toBe(world.state.count);
    expect(frame.summary.temperature).toBeCloseTo(m.temperature, 9);
    expect(frame.summary.total).toBeCloseTo(m.total, 9);
    expect(frame.summary.pressure).toBeCloseTo(m.pressure, 9);
    expect(frame.summary.coordination).toBeCloseTo(world.coordination, 9);
    expect(frame.summary.box).toBeCloseTo(world.box, 12);
    expect(frame.summary.steps).toBe(world.steps);
  });

  it('заморозка и признак «живая» доходят до кадра', () => {
    const { world, frame } = makeFrame(256);
    world.freezeAll();
    world.run(5);
    const next = localFrame(world);
    let frozen = 0;
    for (let i = 0; i < world.state.count; i++) if (next.frozen[i] !== 0) frozen++;
    expect(frozen).toBe(world.state.count);
    expect(next.alive.length).toBe(world.state.count);
    void frame;
  });
});

/** Мир для тестов обмена буферами: нужен только валидный кадр. */
function makeSyntheticWorld(): World {
  return new World(
    { count: 128, density: 0.7, temperature: 1.0, thermostat: 'berendsen', boundary: 'periodic' },
    777,
    'fcc',
  );
}
