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
import type { FramePayload } from './protocol.js';

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
  private current: World | WorldMirror;
  private readonly local: World;
  private readonly client = new PhysicsWorkerClient();
  private mode: PhysicsMode = 'local';
  private ready = false;
  private error: string | null = null;
  /** Последний полученный кадр — из него строится зеркало. */
  private mirror: WorldMirror | null = null;
  /**
   * Сколько шагов главный поток ЗАКАЗАЛ у воркера.
   *
   * Вместе с `executedSteps` даёт «долг» — число заказанных, но ещё не
   * выполненных шагов. Именно из-за отсутствия этого учёта возникала
   * регрессия: главный поток заказывал новую порцию каждый кадр отрисовки,
   * не глядя, успевает ли воркер. На 2048 частицах воркер считал ~200 шагов
   * в секунду, а заказывалось ~1200 — очередь росла, шаги продолжались после
   * нажатия «Пауза», и интерфейс показывал состояние всё более отстающее.
   */
  private orderedSteps = 0;
  /** Сколько шагов воркер подтвердил последним кадром. */
  private executedSteps = 0;

  constructor(initial: World) {
    this.local = initial;
    this.current = initial;
  }

  /**
   * Мир для ЧТЕНИЯ.
   *
   * В локальном режиме это настоящий `World`, в режиме воркера — зеркало
   * последнего полученного кадра. Геттер, а не открытое поле: подменить мир
   * можно только осознанно (`showWorldForReading`), а не присваиванием
   * где-то в глубине приложения.
   */
  get world(): World | WorldMirror {
    return this.current;
  }

  /**
   * Локальный мир напрямую.
   *
   * Нужен там, где требуется именно объект `World`, а не контракт чтения:
   * например, сессия кампании читает историю измерений и накопленную
   * статистику, которых в зеркале кадра нет. Обращение явное и намеренно
   * неудобное — чтобы не возникало соблазна «просто взять мир» в обычном коде.
   */
  get localWorld(): World {
    return this.local;
  }

  /**
   * Проверка воркера «на живом»: поднять, прогнать шаги, вернуть сводку.
   *
   * Нужна сквозной проверке в браузере. Юнит-тесты подставляют подставной
   * порт и потому НЕ доказывают, что настоящий `Worker` действительно
   * стартует, что Vite собрал модуль воркера и что обмен кадрами работает
   * в реальной среде. Этот метод закрывает именно этот пробел.
   *
   * @returns сводка после прогона или текст ошибки
   */
  static async selfTest(steps = 40): Promise<{ ok: boolean; error?: string; summary?: unknown }> {
    const world = new World({ count: 256 }, 20260214, 'fcc');
    const bridge = new PhysicsBridge(world);
    if (!bridge.enableWorker()) {
      return { ok: false, error: bridge.status().error ?? 'воркер не поднялся' };
    }
    // Ждём готовности мира: она приходит асинхронно.
    const deadline = Date.now() + 15000;
    while (!bridge.workerReady && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      bridge.sync();
    }
    if (!bridge.workerReady) {
      bridge.destroy();
      return { ok: false, error: 'мир воркера не сообщил о готовности за 15 с' };
    }
    bridge.advance(steps);
    // Даём воркеру время посчитать и прислать кадр.
    const frameDeadline = Date.now() + 15000;
    let frame: FramePayload | null = null;
    while (!frame && Date.now() < frameDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      bridge.sync();
      frame = bridge.client.lastFrame;
    }
    bridge.destroy();
    if (!frame) return { ok: false, error: 'кадр от воркера не пришёл за 15 с' };
    /*
     * Возвращается СВОДКА кадра, а не `measurement`: в сводке есть время и
     * число шагов, по которым проверка убеждается, что воркер действительно
     * считал, а не прислал начальное состояние.
     */
    return { ok: true, summary: frame.summary };
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
    /*
     * Мир в воркере создан заново, поэтому его счётчик выполненного — с нуля.
     * Начальный «долг» равен только что заказанным шагам, и никаких других
     * заказов в полёте нет.
     */
    this.executedSteps = 0;
    this.orderedSteps = 0;
    this.orderSteps(this.local.steps);
    return true;
  }

  /**
   * Забрать свежий кадр и обновить зеркало.
   *
   * Вызывается раз в кадр отрисовки ДО чтения состояния. Возвращает true,
   * если пришёл новый кадр.
   *
   * ─── Почему зеркало строится раньше возврата буферов ─────────────────────
   *
   * `consume()` возвращает буферы ПРЕДЫДУЩЕГО кадра воркеру — а это отчуждает
   * память. Поэтому порядок такой: сначала берём новый кадр, строим по нему
   * зеркало (оно ссылается на новые буферы), и только потом возвращаем старые.
   *
   * Раньше `consume()` вызывался первым, и получалось, что текущее зеркало
   * ссылается на отчуждённые буферы: чтение падало с «Cannot perform
   * Construct on a detached ArrayBuffer».
   */
  sync(): boolean {
    if (this.mode !== 'worker') return false;
    const frame = this.client.consume();
    if (!frame) return false;
    this.executedSteps = frame.summary.stepsExecuted;
    // Зеркало пересоздаётся на каждый кадр: буферы предыдущего уже отданы
    // воркеру обратно, и читать из них нельзя.
    this.mirror = new WorldMirror(frame);
    this.current = this.mirror;
    return true;
  }

  /**
   * Сколько заказанных шагов воркер ещё не выполнил.
   *
   * Это «долг» в шагах. Ноль означает, что воркер догнал заказы и следующий
   * заказ будет выполнен сразу.
   */
  get backlog(): number {
    if (this.mode !== 'worker') return 0;
    return Math.max(0, this.orderedSteps - this.executedSteps);
  }

  /**
   * Стоимость одного шага, измеренная воркером (мс).
   *
   * Возвращает 0, пока воркер не прислал ни одного кадра с замером: тогда
   * автоподстройка обязана воздержаться от выводов, а не считать по нулю.
   */
  get stepCostMs(): number {
    return this.mirror?.stepCostMs ?? 0;
  }

  /**
   * Выполнить шаги физики.
   *
   * В режиме воркера шаги только ЗАКАЗЫВАЮТСЯ: результат придёт следующим
   * кадром. Это принципиально — ждать его синхронно значило бы потерять весь
   * смысл воркера.
   *
   * ─── Обратное давление ──────────────────────────────────────────────────
   *
   * Новая порция заказывается, только если воркер уже разобрал предыдущую.
   * Без этого правила главный поток (60 кадров в секунду) заказывал бы шаги
   * быстрее, чем воркер успевает считать, и получалась бы растущая очередь:
   *   * «Пауза» не останавливала движение — в очереди ждали сотни шагов;
   *   * на экране было состояние всё более далёкого прошлого;
   *   * автоподстройка, видя «дешёвый» заказ, ещё увеличивала порцию.
   * Измерено до исправления: в очереди накапливалось 2100+ шагов, а после
   * нажатия «Пауза» воркер продолжал шагать ещё около 950 шагов.
   *
   * Теперь в полёте не больше одной порции: темп физики задаёт воркер, а не
   * частота кадров отрисовки. Отрисовка при этом продолжает идти на 60 к/с —
   * пропускается только ЗАКАЗ, и картинка остаётся плавной.
   */
  advance(steps: number, force = false): void {
    if (this.mode === 'worker') {
      if (!this.ready) return;
      const batch = Math.max(1, Math.round(steps));
      /*
       * `force` — для дискретного действия игрока («Шаг»).
       *
       * Покадровый заказ обязан уважать обратное давление, иначе очередь
       * растёт. Но одиночный шаг, нажатый человеком, обязан выполниться
       * всегда: молча проглотить нажатие — это ровно тот класс дефектов,
       * из-за которого интерфейс кажется сломанным.
       */
      /*
       * В полёте держим не больше ДВУХ порций.
       *
       * Одной мало: пока воркер считает порцию и отправляет кадр, он мог бы
       * простаивать. Больше двух — это уже растущая очередь, из-за которой
       * «Пауза» вступала в силу с задержкой в сотни шагов.
       *
       * Условие строгое (`>=`): при `backlog > batch` и единственной
       * заказанной порции заказ всё равно проходил, и очередь росла на порцию
       * за каждый кадр отрисовки — исходная регрессия возвращалась.
       */
      if (!force && this.backlog >= batch * 2) return;
      this.orderSteps(batch);
      return;
    }
    for (let i = 0; i < steps; i++) this.local.step();
  }

  /**
   * Прогнать шаги СИНХРОННО на локальном мире.
   *
   * Нужно инструментам проверки: они гоняют сотни шагов и сразу читают
   * результат, что в режиме воркера невозможно в принципе (шаги там
   * асинхронны). Метод намеренно назван отдельно от `advance`, чтобы
   * случайно не вызвать его в игровом цикле и не посчитать физику дважды.
   *
   * @param onStep вызывается после каждого шага (сессия уровня, статистика)
   */
  advanceLocal(steps: number, onStep?: () => void): void {
    for (let i = 0; i < steps; i++) {
      this.local.step();
      onStep?.();
    }
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

  /**
   * Заказать у воркера порцию шагов, учитывая её в «долге».
   *
   * Единая точка для ВСЕХ заказов шагов: если где-то отправить `run` напрямую,
   * учёт разойдётся, и обратное давление либо залипнет (долг никогда не
   * обнулится), либо перестанет ограничивать очередь. Ровно так и возникала
   * регрессия с неработающей паузой.
   */
  private orderSteps(steps: number): void {
    if (!Number.isFinite(steps) || steps <= 0) return;
    const batch = Math.max(1, Math.round(steps));
    this.orderedSteps += batch;
    this.client.run(batch);
  }

  /**
   * Применить НАБОР параметров и пересобрать систему.
   *
   * Одним вызовом, а не девятью командами: пресет задаёт все параметры сразу,
   * и промежуточные состояния (например, новая температура при старой
   * плотности) воркеру видеть незачем — он успел бы сделать по ним шаг.
   */
  applyParamsAndResize(
    params: Partial<WorldParams>,
    count: number,
    density: number,
    lattice: LatticeKind,
    equilibrate = 0,
  ): void {
    if (this.mode === 'worker') {
      this.client.send({ type: 'configure', patch: params });
      this.client.send({ type: 'resize', count, density, lattice });
      if (equilibrate > 0) {
        // Отжиг — это тоже шаги, и они обязаны попасть в учёт: иначе
        // обратное давление не увидит, что воркер занят, и закажет ещё.
        this.orderSteps(equilibrate);
      }
      return;
    }
    this.local.params = { ...this.local.params, ...params };
    this.local.resize(count, density, lattice);
    if (equilibrate > 0) this.local.run(equilibrate);
  }

  /*
   * ─── Почему пересборка НЕ трогает учёт очереди ───────────────────────────
   *
   * Ни `resize`, ни `rebuild`, ни `restore` не сбрасывают `orderedSteps` и
   * `executedSteps`. Оба счётчика монотонные, и их разность остаётся верной
   * после смены мира: и заказ отжига, и заказ шагов игрока проходят через
   * один `orderSteps`, а `stepsExecuted` воркера пересборка не обнуляет.
   *
   * Здесь была ошибка. Первая версия «согласовывала» счётчики, приравнивая
   * `orderedSteps` к последнему подтверждённому значению. Это съедало заказы,
   * которые уже ушли воркеру, но ещё не подтверждены кадром: разность уходила
   * в минус (измерено −742 шага), обратное давление переставало ограничивать
   * очередь, и регрессия с неработающей паузой возвращалась.
   */

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
    /*
     * Сначала возвращаем мир для чтения, потом гасим воркер.
     *
     * Здесь был дефект, который ловился только в браузере: `disableWorker`
     * завершал воркер, но в зеркале оставались буферы последнего кадра —
     * а они были ПЕРЕДАНЫ по владению и к этому моменту отчуждены
     * (`detached`). Следующее обращение к ним падало с «Cannot perform
     * Construct on a detached ArrayBuffer», и падала легенда раскраски:
     * она читает `colorValues`, а тот проходит по отчуждённому массиву.
     *
     * Порядок обязателен: мир для чтения переключается на локальный, пока
     * зеркало ещё не утратило актуальность как объект.
     */
    this.current = this.local;
    this.mirror = null;
    this.orderedSteps = 0;
    this.executedSteps = 0;
    this.client.stop();
    this.mode = 'local';
    this.ready = false;
  }

  /**
   * Подменить мир для ЧТЕНИЯ.
   *
   * Нужно режиму эксперимента: свип по температуре идёт в СВОЁМ мире, чтобы
   * результат не зависел от того, что игрок делал до запуска. Сцена и
   * графики при этом должны показывать именно мир эксперимента.
   *
   * Воркер на время эксперимента не останавливается: вернув основной мир,
   * приложение продолжит с того же места.
   */
  showWorldForReading(world: World | WorldMirror): void {
    this.current = world;
  }

  /** Вернуть для чтения основной мир. */
  restoreReadingWorld(): void {
    this.current = this.mode === 'worker' && this.mirror ? this.mirror : this.local;
  }

  /** Освободить ресурсы. */
  destroy(): void {
    this.client.stop();
  }
}
