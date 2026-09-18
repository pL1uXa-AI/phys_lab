/**
 * Клиент воркера физики со стороны главного потока.
 *
 * ─── Задача ──────────────────────────────────────────────────────────────
 *
 * Отдать отрисовке те же данные, что давал локальный `World`, но так, чтобы
 * тяжёлые шаги физики шли в другом потоке. Главный поток держит «зеркало»
 * состояния — набор буферов, пришедших последним кадром, — и все синхронные
 * чтения (проекция, цвета, связи) обслуживаются из него.
 *
 * ─── Почему зеркало, а не запрос каждый раз ──────────────────────────────
 *
 * Отрисовка синхронна: `world.project(...)`, `world.colorValues(...)`,
 * `world.bondNetwork()` вызываются прямо в цикле кадра. Сделать их
 * асинхронными — значит переписать весь `app.ts`. Поэтому воркер присылает
 * кадр заранее, а главный поток читает последний полученный.
 *
 * ─── Обязательный откат ──────────────────────────────────────────────────
 *
 * Воркеры могут быть недоступны (нет поддержки, запрет политикой, ошибка
 * загрузки модуля). В этом случае клиент сообщает `available === false`, и
 * приложение продолжает работать на локальном мире, как раньше. Половинчатый
 * worker хуже отсутствующего: важно, чтобы отказ был виден и обработан.
 */

import { World } from '../core/world.js';
import type { LatticeKind, WorldParams } from '../core/types.js';
import type { ViewBonds } from '../core/physics-view.js';
import {
  buildCurves,
  workerSupported,
  type FramePayload,
  type WorkerCommand,
  type WorkerEvent,
} from './protocol.js';

/** Что клиент сообщает наружу о своём состоянии. */
export interface WorkerStatus {
  /** Доступен ли воркер (иначе приложение работает на локальном мире). */
  available: boolean;
  /** Готов ли мир в воркере. */
  ready: boolean;
  /** Текст ошибки, если что-то пошло не так. */
  error: string | null;
  /** Сколько кадров получено — диагностика. */
  framesReceived: number;
}

/**
 * Источник состояния для отрисовки.
 *
 * Интерфейс намеренно повторяет те методы `World`, которые нужны рендеру и
 * панелям. Благодаря этому приложение не знает, откуда данные — из воркера
 * или из локального мира, — и переключение между режимами не разветвляет
 * код отрисовки.
 */
export interface PhysicsSource {
  readonly state: MirrorState;
  readonly frozen: Uint8Array;
  readonly box: number;
  readonly params: WorldParams;
  readonly time: number;
  readonly steps: number;
  readonly summary: FrameSummaryLike;
  /** Проекция точек на экран. */
  project(yaw: number, pitch: number, out: Float32Array): void;
  /** Значения для раскраски. */
  colorValues(mode: string): { values: Float64Array; min: number; max: number };
  /** Сеть связей для отрисовки. */
  bonds(): MirrorBonds;
}

/** Минимум полей состояния, нужный отрисовке. */
export interface MirrorState {
  count: number;
  x: Float64Array;
  y: Float64Array;
  z: Float64Array;
  vx: Float64Array;
  vy: Float64Array;
  vz: Float64Array;
  speed: Float64Array;
  displacement: Float64Array;
  neighbours: Float64Array;
  alive: Uint8Array;
}

/** Сеть связей в том виде, в каком её читает отрисовка. */
export interface MirrorBonds extends ViewBonds {}

/** Сводка измерений — повторяет `FrameSummary` без параметров мира. */
export type FrameSummaryLike = Omit<FramePayload['summary'], 'params'>;

/*
 * Цветовая шкала считается функцией ИЗ МИРА, а не своей копией.
 *
 * Первая версия клиента считала квантиль сама — простой сортировкой — и тест
 * «раскраска из кадра совпадает с раскраской мира» сразу показал расхождение:
 * 2.7587 против 2.7524. Мир использует логарифмическую гистограмму (скорости
 * распределены по Максвеллу с длинным хвостом, и линейная сетка даёт
 * неустойчивый квантиль), а сортировка — совсем другой алгоритм.
 *
 * Расхождение в 0.2 % на цвет незаметно глазом, поэтому такой дефект жил бы
 * долго. Отсюда правило: любая величина, которую считают оба потока, обязана
 * иметь ОДНУ реализацию в ядре.
 */

/**
 * Клиент воркера.
 *
 * Живёт в главном потоке, владеет последним полученным кадром и пересылает
 * команды. Не знает про Pixi и DOM — только про `Worker` и протокол, поэтому
 * его буферная логика проверяется в Node с подставным портом.
 */
export class PhysicsWorkerClient {
  private worker: Worker | null = null;
  private latest: FramePayload | null = null;
  private buffered: FramePayload | null = null;
  private status: WorkerStatus = { available: false, ready: false, error: null, framesReceived: 0 };
  /** Очередь команд до готовности мира. */
  private queue: WorkerCommand[] = [];
  /** Слушатели событий (снимок, ошибка). */
  private readonly listeners = new Set<(event: WorkerEvent) => void>();

  /** Доступен ли воркер. */
  get available(): boolean {
    return this.status.available;
  }

  /** Текущий статус. */
  get currentStatus(): WorkerStatus {
    return { ...this.status };
  }

  /** Последний полученный кадр или null. */
  get frame(): FramePayload | null {
    return this.latest;
  }

  /**
   * Последний кадр, полученный от воркера.
   *
   * Отличается от `consume()` тем, что НЕ забирает буферы: нужен там, где
   * важны только сводные величины кадра (например, в самопроверке), и
   * возвращать буферы обратно воркеру не требуется — процесс всё равно
   * завершается.
   */
  get lastFrame(): FramePayload | null {
    return this.latest;
  }

  /**
   * Запуск воркера.
   *
   * @param create порт воркера; параметр нужен для тестов, где `Worker`
   *               недоступен и подставляется заглушка
   */
  start(create?: () => Worker): boolean {
    if (this.status.available) return true;
    if (!create && !workerSupported()) {
      this.status = { ...this.status, available: false, error: 'Воркеры не поддерживаются' };
      return false;
    }
    try {
      this.worker = create ? create() : createPhysicsWorker();
      this.worker.onmessage = (event: MessageEvent<WorkerEvent>) => this.handle(event.data);
      this.worker.onerror = (event: ErrorEvent) => {
        this.status = { ...this.status, error: event.message || 'ошибка воркера' };
      };
      this.status = { ...this.status, available: true, error: null };
      return true;
    } catch (error) {
      this.status = {
        ...this.status,
        available: false,
        error: `Не удалось запустить воркер: ${(error as Error).message}`,
      };
      return false;
    }
  }

  /** Подписка на события воркера (снимки, ошибки). */
  subscribe(listener: (event: WorkerEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Создать мир в воркере. */
  init(params: Partial<WorldParams>, seed: number, lattice: LatticeKind): void {
    this.send({ type: 'init', params, seed, lattice });
  }

  /** Отправить команду. До готовности мира команды копятся в очереди. */
  send(command: WorkerCommand): void {
    if (!this.worker) return;
    if (!this.status.ready && command.type !== 'init') {
      this.queue.push(command);
      return;
    }
    this.post(command);
  }

  /** Сделать шаги физики. */
  run(steps: number): void {
    this.send({ type: 'run', steps });
  }

  /**
   * Забрать последний кадр.
   *
   * Вызывается раз в кадр отрисовки. Возвращает последний кадр и возвращает
   * воркеру буферы ТОГО кадра, который этот сменил.
   *
   * ─── Дефект, который здесь был ───────────────────────────────────────────
   *
   * Прежняя версия возвращала буферы «предыдущего» кадра, не проверяя,
   * сменился ли кадр вообще. А `sync()` вызывается КАЖДЫЙ кадр отрисовки,
   * тогда как воркер присылает новый кадр не каждый — на 20 000 частиц шаг
   * идёт дольше кадра экрана.
   *
   * В итоге на «пустых» кадрах возвращался в пул ТОТ ЖЕ кадр, который прямо
   * сейчас читает зеркало. Возврат передаёт буферы по владению, то есть
   * ОТЧУЖАЕТ память, и следующее обращение падало с «Cannot perform Construct
   * on a detached ArrayBuffer». В браузере это выглядело как сломанная
   * легенда раскраски; в юнит-тестах не воспроизводилось, потому что
   * подставной порт ничего не отчуждает.
   *
   * Теперь возвращается только тот кадр, который действительно СМЕНИЛСЯ.
   */
  consume(): FramePayload | null {
    const latest = this.latest;
    if (!latest) return null;
    // Возвращаем буферы только если пришёл НОВЫЙ кадр: старый тогда уже
    // никем не читается. Иначе — отдали бы память под ногами у зеркала.
    if (this.buffered && this.buffered !== latest) {
      this.recycleBuffers(this.buffered);
      this.buffered = null;
    }
    this.buffered = latest;
    return latest;
  }

  /**
   * Забыть последний кадр.
   *
   * Нужно после передачи его буферов обратно в воркер: кадр становится
   * недействительным (память отчуждена), и держать на него ссылку опасно —
   * попытка прочитать массив упадёт. Явный метод вместо «просто не трогать»:
   * так намерение видно в коде.
   */
  invalidate(): void {
    this.latest = null;
  }

  /** Вернуть буферы кадра воркеру. */
  private recycleBuffers(frame: FramePayload): void {
    if (!this.worker) return;
    // Кривые и сводка не входят в набор буферов: они не передавались по
    // владению и живут в главном потоке как обычные копии.
    const { bondCount, bondTruncated, summary, curves, ...buffers } = frame;
    void bondCount;
    void bondTruncated;
    void summary;
    void curves;
    const command = { type: 'recycle', ...buffers } as unknown as WorkerCommand;
    const transfer = Object.values(buffers)
      .map((value) => (value as { buffer?: ArrayBuffer }).buffer)
      .filter((buffer): buffer is ArrayBuffer => buffer instanceof ArrayBuffer);
    this.post(command, transfer);
  }

  /** Остановить воркер и сбросить состояние. */
  stop(): void {
    this.worker?.terminate();
    this.worker = null;
    this.status = { ...this.status, available: false, ready: false };
    /*
     * Буферы последнего кадра ОБЯЗАТЕЛЬНО обнуляются.
     *
     * После `postMessage` с `Transferable` они отчуждены: `ArrayBuffer`
     * существует как объект, но память под ним уже принадлежит другому
     * потоку. Любое обращение — включая `new Float64Array(буфер)` — падает
     * с «Cannot perform Construct on a detached ArrayBuffer».
     *
     * Дефект был найден в браузере: после переключения в локальный режим
     * зеркало продолжало держать ссылку на такой кадр, и падала легенда
     * раскраски. В юнит-тестах это не воспроизводилось, потому что
     * подставной порт не отчуждает память по-настоящему.
     */
    this.latest = null;
    this.buffered = null;
    this.queue.length = 0;
  }

  private post(command: WorkerCommand, transfer?: ArrayBuffer[]): void {
    if (!this.worker) return;
    if (transfer && transfer.length > 0) this.worker.postMessage(command, transfer);
    else this.worker.postMessage(command);
  }

  private handle(event: WorkerEvent): void {
    switch (event.type) {
      case 'ready':
        this.status = { ...this.status, ready: true, error: null };
        // Отдаём накопленные команды: они были набраны до готовности мира.
        for (const command of this.queue) this.post(command);
        this.queue.length = 0;
        break;
      case 'frame':
        this.status = { ...this.status, framesReceived: this.status.framesReceived + 1 };
        this.latest = event.payload;
        break;
      case 'error':
        this.status = { ...this.status, error: event.message };
        break;
      default:
        break;
    }
    for (const listener of this.listeners) listener(event);
  }
}

/**
 * Создание воркера.
 *
 * `new URL(..., import.meta.url)` — штатный способ Vite: он собирает
 * воркер отдельным файлом и подставляет правильный путь. Работает и при
 * сборке с относительной базой, то есть и с `file://`.
 */
export function createPhysicsWorker(): Worker {
  return new Worker(new URL('./physics.worker.ts', import.meta.url), { type: 'module' });
}

/**
 * Зеркало локального мира.
 *
 * Используется, когда воркер недоступен. Возвращает ровно тот же интерфейс,
 * что и кадр воркера, поэтому приложение не разветвляется.
 */
export class LocalPhysicsMirror {
  constructor(private readonly world: World) {}

  get frame(): FramePayload {
    return localFrame(this.world);
  }
}

/** Сборка кадра из локального мира — для режима без воркера. */
export function localFrame(world: World): FramePayload {
  const count = world.state.count;
  const net = world.bondNetwork();
  const m = world.measurement;
  const peak = world.structure.firstPeak();
  return {
    x: world.state.x,
    y: world.state.y,
    z: world.state.z,
    vx: world.state.vx,
    vy: world.state.vy,
    vz: world.state.vz,
    speed: world.state.speed,
    displacement: world.state.displacement,
    neighbours: world.state.neighbours,
    frozen: world.frozen,
    alive: world.state.alive,
    bondA: net.a,
    bondB: net.b,
    bondLength: net.length,
    bondDx: net.dx,
    bondDy: net.dy,
    bondDz: net.dz,
    bondCount: net.pairCount,
    bondTruncated: net.truncated,
    curves: buildCurves(world),
    summary: {
      count,
      box: world.box,
      time: world.time,
      steps: world.steps,
      temperature: m.temperature,
      kinetic: m.kinetic,
      potential: world.potentialEnergy,
      total: m.total,
      pressure: m.pressure,
      virial: m.virial,
      meanSpeed: m.meanSpeed,
      mobileFraction: m.mobileFraction,
      meanDisplacement: m.meanDisplacement,
      orderPeak: world.orderPeak,
      coordination: net.meanCoordination(world.state),
      bondSpread: net.lengthSpread(),
      diffusion: world.diffusion().D,
      diffusionR2: world.diffusion().r2,
      msdReady: world.msdReady,
      msdProgress: world.msdProgress,
      radialSamples: world.radial.sampleCount,
      structureSamples: world.structure.sampleCount,
      structurePeak: peak.height,
      structurePeakK: peak.k,
      pairCount: world.pairCount,
      speedClamped: world.speedClampedCount,
      gridIsSafe: world.gridIsSafe,
      params: { ...world.params },
      stepsExecuted: world.steps,
      stepCostMs: 0,
    },
  };
}

/**
 * Проекция точек из кадра.
 *
 * Дублирует `World.project` намеренно: в режиме воркера мира в главном
 * потоке нет, а формула обязана совпадать с ним до последнего знака, иначе
 * клики мышью перестанут попадать в частицы. Совпадение проверяется тестом.
 */
export function projectFrame(
  frame: FramePayload,
  yaw: number,
  pitch: number,
  out: Float32Array,
): void {
  const cosY = Math.cos(yaw);
  const sinY = Math.sin(yaw);
  const cosP = Math.cos(pitch);
  const sinP = Math.sin(pitch);
  const center = frame.summary.box * 0.5;
  const count = frame.summary.count;
  const x = frame.x;
  const y = frame.y;
  const z = frame.z;
  for (let i = 0; i < count; i++) {
    const ax = x[i] - center;
    const ay = y[i] - center;
    const az = z[i] - center;
    const rx = ax * cosY - az * sinY;
    const rz = ax * sinY + az * cosY;
    const ry = ay * cosP - rz * sinP;
    out[i * 3] = rx;
    out[i * 3 + 1] = ry;
    out[i * 3 + 2] = ay * sinP + rz * cosP;
  }
}

/** Значения для раскраски из кадра. */
export function colorValuesOfFrame(
  frame: FramePayload,
  mode: string,
): { values: Float64Array; min: number; max: number } {
  const count = frame.summary.count;
  const out = new Float64Array(count);
  switch (mode) {
    case 'density':
      out.set(frame.neighbours.subarray(0, count));
      break;
    case 'travel':
      out.set(frame.displacement.subarray(0, count));
      break;
    case 'plain':
      out.fill(0.5);
      return { values: out, min: 0, max: 1 };
    case 'speed':
    default:
      out.set(frame.speed.subarray(0, count));
      break;
  }
  const { min, max } = World.colorRange(out, frame.alive);
  return { values: out, min, max };
}

/** Сеть связей из кадра в форме, которую ждёт отрисовка. */
export function bondsOfFrame(frame: FramePayload): MirrorBonds {
  return {
    pairCount: frame.bondCount,
    a: frame.bondA,
    b: frame.bondB,
    length: frame.bondLength,
    dx: frame.bondDx,
    dy: frame.bondDy,
    dz: frame.bondDz,
    // Обрезка связей происходит на стороне воркера: он знает и число пар, и
    // ёмкость буфера. Сюда приходит уже готовый признак.
    truncated: frame.bondTruncated,
  };
}