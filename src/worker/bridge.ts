/**
 * Мост между приложением и физикой.
 *
 * ─── Задача ──────────────────────────────────────────────────────────────
 *
 * Приложение общается с физикой двумя способами: ЧИТАЕТ состояние каждый
 * кадр (проекция, цвета, измерение, кривые) и ПИШЕТ команды (шаги, смена
 * плотности, заморозка, кисть). Раньше и то и другое шло напрямую в `World`.
 *
 * Здесь эта разница спрятана: мост владеет либо локальным `World`, либо
 * клиентом воркера, и предоставляет приложению один и тот же набор методов.
 * Приложение не знает, где считаются силы, и не может случайно прочитать
 * состояние из одного места, а изменить в другом.
 *
 * ─── Почему мост, а не флаг в приложении ────────────────────────────────
 *
 * Соблазн был проверять `if (workerMode)` в каждом месте вызова. Но тогда
 * рано или поздно одно из мест забудут, и получится, что рендер рисует мир
 * воркера, а кнопка «нагреть» греет локальный — то есть ничего. С мостом
 * такого состояния не существует: маршрутизация ровно одна.
 *
 * ─── Откат ──────────────────────────────────────────────────────────────
 *
 * Если воркер недоступен (нет поддержки, запрет политикой, ошибка загрузки
 * модуля), мост остаётся на локальном мире и сообщает об этом через
 * `mode`. Половинчатый worker хуже отсутствующего, поэтому отказ виден
 * снаружи, а не проглатывается.
 */

import { World, type PokeRequest } from '../core/world.js';
import { parseSnapshot, serializeSnapshot } from '../core/snapshot.js';
import type { LatticeKind, WorldParams } from '../core/types.js';
import { PhysicsWorkerClient } from './client.js';
import { WorldMirror } from './mirror.js';

/** Где считаются силы. */
export type PhysicsMode = 'worker' | 'local';

/** Что мост сообщает приложению о своём состоянии. */
export interface PhysicsStatus {
  mode: PhysicsMode;
  /** Готов ли мир (в режиме воркера — пришёл ли ответ `ready`). */
  ready: boolean;
  /** Текст ошибки, если воркер не поднялся. */
  error: string | null;
  /** Сколько кадров получено от воркера. */
  framesReceived: number;
}

/**
 * Мост физики.
 *
 * Чтение всегда идёт через `world` — это либо настоящий `World` (локальный
 * режим), либо `WorldMirror` (режим воркера). Оба предоставляют одинаковый
 * набор методов, нужный отрисовке и панелям.
 */
export class PhysicsBridge {
  /** Мир для ЧТЕНИЯ: настоящий или зеркало. */
  world: World | WorldMirror;
  private readonly local: World;
  private readonly client = new PhysicsWorkerClient();
  private mode: PhysicsMode = 'local';
  private ready = false;
  private error: string | null = null;
  /** Последний полученный кадр — из него строится зеркало. */
  private mirror: WorldMirror | null = null;

  constructor(initial: World) {
    this.local = initial;
    this.world = initial;
  }

  /** Текущий статус. */
  status(): PhysicsStatus {
    return {
      mode: this.mode,
      ready: this.ready,
      error: this.error,
      framesReceived: this.client.currentStatus.framesReceived,
    };
  }

  /** Хочет ли приложение работать через воркер. */
  get usingWorker(): boolean {
    return this.mode === 'worker';
  }

  /** Готов ли мир воркера принимать команды. */
  get workerReady(): boolean {
    return this.mode === 'worker' && this.ready;
  }

  /**
   * Попытаться поднять воркер.
   *
   * @returns получилось ли переключиться
   */
  enableWorker(create?: () => Worker): boolean {
    if (this.mode === 'worker') return true;
    const started = this.client.start(create);
    if (!started) {
      this.error = this.client.currentStatus.error;
      return false;
    }
    this.mode = 'worker';
    this.ready = false;
    this.error = null;

    this.client.subscribe((event) => {
      if (event.type === 'ready') {
        this.ready = true;
      } else if (event.type === 'error') {
        this.error = event.message;
      }
    });

    // Мир воркера создаётся с текущими параметрами локального: переключение
    // не должно менять систему, иначе игрок увидит «прыжок» состояния.
    this.client.init(
      { ...this.local.params },
      // Зерно генератора взять у локального мира нельзя (оно приватное),
      // поэтому используется постоянное: воспроизводимость в режиме воркера
      // обеспечивается снимком, а не совпадением с локальным миром.
      20260214,
      'fcc',
    );
    this.client.run(this.local.steps);
    return true;
  }

  /**
   * Забрать свежий кадр и обновить зеркало.
   *
   * Вызывается раз в кадр отрисовки ДО чтения состояния. Возвращает true,
   * если пришёл новый кадр.
   */
  sync(): boolean {
    if (this.mode !== 'worker') return false;
    const frame = this.client.consume();
    if (!frame) return false;
    // Зеркало пересоздаётся на каждый кадр: буферы предыдущего уже отданы
    // воркеру обратно, и читать из них нельзя.
    this.mirror = new WorldMirror(frame);
    this.world = this.mirror;
    return true;
  }

  /**
   * Выполнить шаги физики.
   *
   * В режиме воркера шаги только ЗАКАЗЫВАЮТСЯ: результат придёт следующим
   * кадром. Это принципиально — ждать его синхронно значило бы потерять весь
   * смысл воркера.
   */
  advance(steps: number): void {
    if (this.mode === 'worker') {
      if (this.ready) this.client.run(steps);
      return;
    }
    for (let i = 0; i < steps; i++) this.local.step();
  }

  /** Кадр статистики. */
  sampleRadial(): void {
    if (this.mode === 'worker') {
      this.client.send({ type: 'sampleRadial' });
      return;
    }
    this.local.sampleRadial();
  }

  /** Смена температуры термостата. */
  setTemperature(value: number): void {
    if (this.mode === 'worker') {
      this.client.send({ type: 'configure', patch: { temperature: value } });
      return;
    }
    this.local.params.temperature = value;
  }

  /** Смена термостата. */
  setThermostat(value: string): void {
    if (this.mode === 'worker') {
      this.client.send({ type: 'configure', patch: { thermostat: value as WorldParams['thermostat'] } });
      return;
    }
    this.local.params.thermostat = value as WorldParams['thermostat'];
  }

  /** Смена границ. */
  setBoundary(value: string): void {
    if (this.mode === 'worker') {
      this.client.send({ type: 'configure', patch: { boundary: value as WorldParams['boundary'] } });
      return;
    }
    this.local.params.boundary = value as WorldParams['boundary'];
  }

  /** Смена плотности без пересборки. */
  setDensity(density: number): void {
    if (this.mode === 'worker') {
      this.client.send({ type: 'setDensity', density });
      return;
    }
    this.local.setDensity(density);
  }

  /** Пересборка под новое число частиц. */
  resize(count: number, density: number, lattice: LatticeKind): void {
    if (this.mode === 'worker') {
      this.client.send({ type: 'resize', count, density, lattice });
      return;
    }
    this.local.resize(count, density, lattice);
  }

  /** Отложенная пересборка на заданной решётке. */
  requestRebuild(lattice: LatticeKind, keepTemperature: boolean): void {
    if (this.mode === 'worker') {
      this.client.send({ type: 'rebuild', lattice, keepTemperature });
      return;
    }
    this.local.requestRebuild(lattice, keepTemperature);
  }

  /** Полная пересборка. */
  rebuild(lattice: LatticeKind, keepTemperature: boolean): void {
    if (this.mode === 'worker') {
      this.client.send({ type: 'rebuild', lattice, keepTemperature });
      return;
    }
    this.local.rebuild(lattice, keepTemperature);
  }

  /** Разовая установка температуры. */
  applyTemperatureNow(): void {
    if (this.mode === 'worker') {
      this.client.send({ type: 'applyTemperatureNow' });
      return;
    }
    this.local.applyTemperatureNow();
  }

  /** Масштабирование скоростей. */
  scaleVelocities(factor: number): void {
    if (this.mode === 'worker') {
      this.client.send({ type: 'scaleVelocities', factor });
      return;
    }
    this.local.scaleVelocities(factor);
  }

  /** Заморозить всё. */
  freezeAll(): void {
    if (this.mode === 'worker') {
      this.client.send({ type: 'freezeAll' });
      return;
    }
    this.local.freezeAll();
  }

  /** Разморозить всё. */
  unfreezeAll(): void {
    if (this.mode === 'worker') {
      this.client.send({ type: 'unfreezeAll' });
      return;
    }
    this.local.unfreezeAll();
  }

  /**
   * Заморозить область.
   *
   * В режиме воркера область заморозить нельзя: цилиндр кисти задаётся осью
   * взгляда, а она зависит от камеры главного потока, и передать её целиком
   * в команду пока нельзя. Вместо тихой подмены (например, «заморозить всё»)
   * возвращается 0 — приложение покажет, что операция недоступна.
   */
  freezeRegion(plane: Parameters<World['freezeRegion']>[0], radius: number): number {
    if (this.mode === 'worker') return 0;
    return this.local.freezeRegion(plane, radius);
  }

  /** Заявка на толчок кистью. */
  requestPoke(request: PokeRequest): void {
    if (this.mode === 'worker') {
      this.client.send({
        type: 'poke',
        axis: request.plane.w,
        center: request.plane.center,
        dx: request.dx,
        dy: request.dy,
        dz: request.dz,
        radius: request.radius,
        strength: request.strength,
      });
      return;
    }
    this.local.requestPoke(request);
  }

  /** Применить накопленный толчок (в локальном режиме). */
  flushPoke(): void {
    if (this.mode !== 'worker') this.local.flushPoke();
  }

  /** Радиус связей. */
  setBondRadius(radius: number): void {
    if (this.mode === 'worker') {
      this.client.send({ type: 'setBondRadius', radius });
      return;
    }
    this.local.bondNetwork(radius);
  }

  /** Снимок состояния (JSON-строка). */
  requestSnapshot(): Promise<string> {
    if (this.mode !== 'worker') {
      return Promise.resolve(serializeSnapshot(this.local.snapshot()));
    }
    return new Promise<string>((resolve) => {
      const unsubscribe = this.client.subscribe((event) => {
        if (event.type === 'snapshot') {
          unsubscribe();
          resolve(event.json);
        }
      });
      this.client.send({ type: 'snapshot' });
    });
  }

  /** Восстановление из снимка. */
  restoreJson(json: string): string | null {
    if (this.mode === 'worker') {
      this.client.send({ type: 'restore', json });
      return null;
    }
    const parsed = parseSnapshot(json);
    if (!parsed.ok) return parsed.error;
    this.local.restore(parsed.loaded);
    return null;
  }

  /** Остановить воркер и вернуться к локальному миру. */
  disableWorker(): void {
    this.client.stop();
    this.mode = 'local';
    this.ready = false;
    this.mirror = null;
    this.world = this.local;
  }

  /** Освободить ресурсы. */
  destroy(): void {
    this.client.stop();
  }
}
