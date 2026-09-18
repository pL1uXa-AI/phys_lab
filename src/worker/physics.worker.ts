/**
 * Воркер физики: считает мир в отдельном потоке.
 *
 * ─── Что здесь происходит ────────────────────────────────────────────────
 *
 * Воркер владеет объектом `World` и выполняет все команды, меняющие физику:
 * шаги, термостаты, заморозку, пересборку, накопление статистики. Главный
 * поток больше не вызывает `world.step()` — он присылает команду и получает
 * обратно кадр состояния для отрисовки.
 *
 * ─── Почему кадр передаётся целиком, а не «дельтой» ──────────────────────
 *
 * Соблазн передавать только изменившееся (например, одни координаты) велик,
 * но отрисовке нужны ещё скорости (раскраска), маска заморозки, признак
 * «живая», кэши измерения и сеть связей. Собирать это из разных сообщений
 * значило бы гарантированно получить рассинхрон: часть данных от одного
 * шага, часть от другого.
 *
 * Данные передаются по владению (`Transferable`) и возвращаются обратно по
 * тому же принципу: набор буферов ходит «пинг-понгом» между потоками, и в
 * установившемся режиме новых аллокаций нет, а копирования нет вовсе.
 *
 * ─── Чего здесь НЕТ ──────────────────────────────────────────────────────
 *
 * Ни DOM, ни Pixi, ни проекции, ни цветов, ни графиков — всё это осталось
 * в главном потоке. Воркер знает только про `World` и протокол обмена.
 */

/// <reference lib="webworker" />

import { World } from '../core/world.js';
import { parseSnapshot, serializeSnapshot } from '../core/snapshot.js';
import type { LatticeKind } from '../core/types.js';
import {
  bondCapacityFor,
  buildCurves,
  type FrameBuffersPayload,
  type FramePayload,
  type FrameSummary,
  type WorkerCommand,
  type WorkerEvent,
} from './protocol.js';

/** Мир, которым владеет воркер. */
let world: World | null = null;

/**
 * Сколько шагов воркер выполнил за всё время.
 *
 * Счётчик МОНОТОННЫЙ и не сбрасывается пересборкой системы — в отличие от
 * `world.steps`, который описывает текущую траекторию. По нему главный поток
 * считает, сколько заказанных шагов ещё не сделано, и не даёт очереди расти
 * бесконечно.
 */
let stepsExecuted = 0;

/**
 * Измеренная стоимость одного шага в миллисекундах.
 *
 * Нужна главному потоку для автоподстройки числа шагов: измерить её там
 * невозможно — шаги идут в другом потоке, а `postMessage` возвращается сразу.
 *
 * ─── Почему замер идёт по ВСЕЙ команде, а не по циклу шагов ───────────────
 *
 * Первая версия мерила только цикл `w.step()`. Этого мало: после шагов тот
 * же поток собирает кадр — строит сеть связей, копирует буферы, готовит
 * кривые, — и на 2000 частиц это заметная доля времени. Из-за заниженной
 * оценки автоподстройка считала, что порцию можно увеличивать, и очередь
 * росла. Здесь измеряется обработка команды целиком, включая сборку кадра,
 * то есть ровно то, что ограничивает пропускную способность воркера.
 *
 * Оценка сглажена экспоненциально: одиночный замер гуляет в разы из-за
 * сборки мусора и планировщика.
 */
let stepCostMs = 0;

/** Сглаживание оценки стоимости шага (доля нового замера). */
const COST_SMOOTHING = 0.25;

/** Выполнить шаги. Стоимость измеряется вызывающим — вместе со сборкой кадра. */
function runSteps(w: World, steps: number): void {
  for (let i = 0; i < steps; i++) w.step();
  stepsExecuted += steps;
}

/** Учесть замер стоимости команды «run» вместе со сборкой кадра. */
function accountStepCost(steps: number, measuredMs: number): void {
  if (steps <= 0 || measuredMs <= 0) return;
  const measured = measuredMs / steps;
  stepCostMs = stepCostMs === 0 ? measured : stepCostMs * (1 - COST_SMOOTHING) + measured * COST_SMOOTHING;
}

/**
 * Набор буферов кадра.
 *
 * Тип задан через `FrameBuffersPayload` из протокола, а не через вычитание
 * полей из `FramePayload`: последний теперь содержит ещё и кривые, которые
 * по владению НЕ передаются (они маленькие и копируются обычным образом).
 */
type FrameBuffers = FrameBuffersPayload;

/** Имена буферов — чтобы не перечислять их дважды при передаче. */
const BUFFER_KEYS = [
  'x',
  'y',
  'z',
  'vx',
  'vy',
  'vz',
  'speed',
  'displacement',
  'neighbours',
  'frozen',
  'alive',
  'bondA',
  'bondB',
  'bondLength',
  'bondDx',
  'bondDy',
  'bondDz',
] as const;

/** Свободные наборы, вернувшиеся от главного потока. */
const pool: FrameBuffers[] = [];

/** Выделить новый набор. */
function allocBuffers(count: number): FrameBuffers {
  const bondCapacity = bondCapacityFor(count);
  return {
    x: new Float64Array(count),
    y: new Float64Array(count),
    z: new Float64Array(count),
    vx: new Float64Array(count),
    vy: new Float64Array(count),
    vz: new Float64Array(count),
    speed: new Float64Array(count),
    displacement: new Float64Array(count),
    neighbours: new Float64Array(count),
    frozen: new Uint8Array(count),
    alive: new Uint8Array(count),
    bondA: new Int32Array(bondCapacity),
    bondB: new Int32Array(bondCapacity),
    bondLength: new Float32Array(bondCapacity),
    bondDx: new Float32Array(bondCapacity),
    bondDy: new Float32Array(bondCapacity),
    bondDz: new Float32Array(bondCapacity),
  };
}

/**
 * Взять набор из пула под нужный размер.
 *
 * Набор подходит только при совпадении и числа частиц, и ёмкости связей:
 * иначе буфер окажется короче данных, и копирование молча обрежет хвост.
 */
function takeBuffers(count: number): FrameBuffers {
  const need = bondCapacityFor(count);
  const index = pool.findIndex(
    (candidate) => candidate.x.length === count && candidate.bondA.length === need,
  );
  if (index >= 0) {
    const [found] = pool.splice(index, 1);
    return found;
  }
  return allocBuffers(count);
}

/** Положить набор в пул. */
function recycle(buffers: FrameBuffers): void {
  // Пул ограничен: длинная сессия со сменой числа частиц иначе копила бы
  // наборы всех размеров, когда-либо встречавшихся.
  if (pool.length < 4) pool.push(buffers);
}

/** Список передаваемых буферов. */
function transferList(buffers: FrameBuffers): ArrayBuffer[] {
  return BUFFER_KEYS.map((key) => buffers[key].buffer as ArrayBuffer);
}

/** Отправить событие в главный поток. */
function emit(event: WorkerEvent, transfer?: ArrayBuffer[]): void {
  const port = self as unknown as Worker;
  if (transfer && transfer.length > 0) port.postMessage(event, transfer);
  else port.postMessage(event);
}

/**
 * Сборка кадра состояния.
 *
 * Копирование в буферы — единственное место, где данные дублируются, и оно
 * неизбежно: главному потоку нужен свой массив, потому что воркер продолжит
 * менять свой на следующем шаге.
 */
function makeFrame(w: World): FramePayload {
  const count = w.state.count;
  const buffers = takeBuffers(count);
  const bondCapacity = buffers.bondA.length;

  buffers.x.set(w.state.x.subarray(0, count));
  buffers.y.set(w.state.y.subarray(0, count));
  buffers.z.set(w.state.z.subarray(0, count));
  buffers.vx.set(w.state.vx.subarray(0, count));
  buffers.vy.set(w.state.vy.subarray(0, count));
  buffers.vz.set(w.state.vz.subarray(0, count));
  buffers.speed.set(w.state.speed.subarray(0, count));
  buffers.displacement.set(w.state.displacement.subarray(0, count));
  buffers.neighbours.set(w.state.neighbours.subarray(0, count));
  buffers.frozen.set(w.frozen.subarray(0, count));
  buffers.alive.set(w.state.alive.subarray(0, count));

  // Сеть связей строится лениво в мире; здесь забираем её текущее состояние.
  // Копируем только занятую часть: массивы сети фиксированной ёмкости, и
  // хвост за `pairCount` содержит мусор от прошлых построений.
  const net = w.bondNetwork();
  const pairs = Math.min(net.pairCount, bondCapacity);
  buffers.bondA.set(net.a.subarray(0, pairs));
  buffers.bondB.set(net.b.subarray(0, pairs));
  buffers.bondLength.set(net.length.subarray(0, pairs));
  buffers.bondDx.set(net.dx.subarray(0, pairs));
  buffers.bondDy.set(net.dy.subarray(0, pairs));
  buffers.bondDz.set(net.dz.subarray(0, pairs));

  const measurement = w.measurement;
  const structurePeak = w.structure.firstPeak();
  const diffusionResult = w.diffusion();
  /*
   * Число ЖИВЫХ частиц.
   *
   * `w.state.count` — это размер массивов, он не меняется, когда частицы
   * улетают за открытые границы: `removeEscaped` лишь помечает их мёртвыми.
   * Именно по убыли живых проверяется уровень «Испарение», поэтому величина
   * считается здесь, а не берётся из общего числа.
   */
  let aliveCount = 0;
  for (let i = 0; i < count; i++) if (w.state.alive[i] !== 0) aliveCount++;
  const summary: FrameSummary = {
    count,
    aliveCount,
    box: w.box,
    time: w.time,
    steps: w.steps,
    temperature: measurement.temperature,
    kinetic: measurement.kinetic,
    potential: w.potentialEnergy,
    total: measurement.total,
    pressure: measurement.pressure,
    virial: measurement.virial,
    meanSpeed: measurement.meanSpeed,
    mobileFraction: measurement.mobileFraction,
    meanDisplacement: measurement.meanDisplacement,
    orderPeak: w.orderPeak,
    coordination: net.meanCoordination(w.state),
    bondSpread: net.lengthSpread(),
    diffusion: diffusionResult.D,
    diffusionR2: diffusionResult.r2,
    diffusionLagStart: diffusionResult.lagRange[0],
    diffusionLagEnd: diffusionResult.lagRange[1],
    msdReady: w.msdReady,
    msdProgress: w.msdProgress,
    msdOriginCount: w.msd.originCount,
    radialSamples: w.radial.sampleCount,
    structureSamples: w.structure.sampleCount,
    structurePeak: structurePeak.height,
    structurePeakK: structurePeak.k,
    pairCount: w.pairCount,
    speedClamped: w.speedClampedCount,
    gridIsSafe: w.gridIsSafe,
    params: { ...w.params },
    stepsExecuted,
    stepCostMs,
  };
  return {
    ...buffers,
    bondCount: pairs,
    // Обрезали ли сеть: если пар больше, чем влезло в буфер, отрисовка
    // обязана сообщить об этом, а не рисовать молча неполную структуру.
    bondTruncated: net.truncated || net.pairCount > bondCapacity,
    summary,
    curves: buildCurves(w),
  };
}

/** Собрать и отправить кадр. */
function emitFrame(): void {
  if (!world) return;
  const payload = makeFrame(world);
  const { bondCount, bondTruncated, summary, curves, ...buffers } = payload;
  void bondCount;
  void bondTruncated;
  void summary;
  void curves;
  emit({ type: 'frame', payload }, transferList(buffers));
}

/**
 * Разбор команды восстановления.
 *
 * `parseSnapshot` возвращает размеченный результат, а не бросает исключение,
 * поэтому ошибку надо проверять явно — иначе повреждённый файл приведёт к
 * `undefined` вместо внятного сообщения.
 */
function restoreFromJson(json: string): void {
  if (!world) return;
  const parsed = parseSnapshot(json);
  if (!parsed.ok) throw new Error(parsed.error);
  world.restore(parsed.loaded);
}

/** Обработка команд. */
self.onmessage = (event: MessageEvent<WorkerCommand>) => {
  const command = event.data;

  if (command.type === 'init') {
    try {
      world = new World(command.params, command.seed, command.lattice);
      emit({ type: 'ready', count: world.state.count, box: world.box });
      emitFrame();
    } catch (error) {
      emit({ type: 'error', message: `Не удалось создать мир: ${(error as Error).message}` });
    }
    return;
  }

  if (command.type === 'recycle') {
    const { type, ...buffers } = command;
    void type;
    recycle(buffers as FrameBuffers);
    return;
  }

  const w = world;
  if (!w) {
    emit({ type: 'error', message: `Команда «${command.type}» пришла до создания мира` });
    return;
  }

  try {
    /*
     * Замер стоимости начинается ДО команды и заканчивается ПОСЛЕ отправки
     * кадра: воркер последовательно считает шаги и собирает кадр, поэтому
     * пропускную способность ограничивает именно эта сумма, а не одни шаги.
     */
    const commandStarted = performance.now();
    switch (command.type) {
      case 'configure':
        Object.assign(w.params, command.patch);
        if (command.patch.density !== undefined) w.setDensity(command.patch.density);
        break;
      case 'resize':
        w.resize(command.count, command.density, command.lattice as LatticeKind);
        break;
      case 'setDensity':
        w.setDensity(command.density);
        break;
      case 'run':
        runSteps(w, command.steps);
        break;
      case 'applyTemperatureNow':
        w.applyTemperatureNow();
        break;
      case 'scaleVelocities':
        w.scaleVelocities(command.factor);
        break;
      case 'freezeAll':
        w.freezeAll();
        break;
      case 'unfreezeAll':
        w.unfreezeAll();
        break;
      case 'freezeRegion':
        w.freezeRegion(
          { w: command.axis, center: command.center },
          command.radius,
        );
        break;
      case 'rebuild':
        w.requestRebuild(command.lattice, command.keepTemperature);
        break;
      case 'setBondRadius':
        w.bondNetwork(command.radius);
        break;
      case 'sampleRadial':
        w.sampleRadial();
        break;
      case 'snapshot':
        // Снимок — отдельное событие: он большой и нужен не каждый кадр.
        emit({ type: 'snapshot', json: serializeSnapshot(w.snapshot()) });
        return;
      case 'restore':
        restoreFromJson(command.json);
        break;
      case 'poke':
        w.pokeNow({
          plane: { w: command.axis, center: command.center },
          dx: command.dx,
          dy: command.dy,
          dz: command.dz,
          radius: command.radius,
          strength: command.strength,
        });
        break;
      default:
        break;
    }
    emitFrame();
    if (command.type === 'run') {
      accountStepCost(command.steps, performance.now() - commandStarted);
    }
  } catch (error) {
    emit({ type: 'error', message: `Ошибка команды ${command.type}: ${(error as Error).message}` });
  }
};
