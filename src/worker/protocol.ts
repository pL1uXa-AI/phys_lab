/**
 * Протокол обмена с воркером физики.
 *
 * ─── Почему воркер есть, а SharedArrayBuffer нет ─────────────────────────
 *
 * Физика считается в основном потоке и на 20 000 частиц занимает ~13 мс на
 * шаг. Автоподстройка держит кадр в пределах бюджета, но ввод в это время
 * не обрабатывается: перетаскивание мышью и нажатия кнопок запаздывают.
 * Замерено (см. `scripts/dev-profile.mjs`): пять шагов физики — 16 мс,
 * вся отрисовка — 5.2 мс. То есть устранять надо именно физику.
 *
 * Обычное решение — `SharedArrayBuffer` + `Atomics`: воркер пишет, главный
 * поток синхронно читает. Но `SharedArrayBuffer` доступен только при
 * `crossOriginIsolated`, то есть требует заголовков COOP/COEP. А собранная
 * версия обязана работать с `file://` (это заявлено в README и используется
 * `start.bat`), где таких заголовков нет.
 *
 * Поэтому обмен идёт через `postMessage`, а состояние передаётся
 * **передаваемыми** буферами (`Transferable`): массив не копируется, а
 * передаётся по владению. Буферы ходят «пинг-понгом» между потоками, так
 * что в установившемся режиме аллокаций нет вовсе.
 *
 * ─── Кто что делает ──────────────────────────────────────────────────────
 *
 * Воркер: шаги интегрирования, силы, термостаты, сетка, измерения, g(r),
 * S(k), MSD, сеть связей. Главный поток: проекция, цвета, спрайты, графики,
 * интерфейс. Разделение выбрано так, чтобы в главном потоке не осталось
 * тяжёлой физики, а все синхронные чтения, нужные отрисовке, обслуживались
 * локальным состоянием-зеркалом.
 *
 * Файл не знает ни про DOM, ни про Pixi, ни про Worker API: только типы.
 * Благодаря этому протокол тестируется в чистом Node.
 */

import type { LatticeKind, WorldParams } from '../core/types.js';

/**
 * Буферы кадра без сводки — та часть, которой обмениваются потоки.
 *
 * Вынесено в отдельный тип, потому что этим же набором главный поток
 * возвращает память обратно в воркер командой `recycle`.
 */
export interface FrameBuffersPayload {
  x: Float64Array;
  y: Float64Array;
  z: Float64Array;
  vx: Float64Array;
  vy: Float64Array;
  vz: Float64Array;
  speed: Float64Array;
  displacement: Float64Array;
  neighbours: Float64Array;
  frozen: Uint8Array;
  alive: Uint8Array;
  bondA: Int32Array;
  bondB: Int32Array;
  bondLength: Float32Array;
  bondDx: Float32Array;
  bondDy: Float32Array;
  bondDz: Float32Array;
}

/** Команды главного потока воркеру. */
export type WorkerCommand =
  /** Создать мир. */
  | { type: 'init'; params: Partial<WorldParams>; seed: number; lattice: LatticeKind }
  /** Изменить параметры без пересборки. */
  | { type: 'configure'; patch: Partial<WorldParams> }
  /** Пересобрать систему под новое число частиц и плотность. */
  | { type: 'resize'; count: number; density: number; lattice: LatticeKind }
  /** Сменить плотность без пересборки (ящик деформируется). */
  | { type: 'setDensity'; density: number }
  /** Сделать шаги. */
  | { type: 'run'; steps: number }
  /** Разовая установка температуры. */
  | { type: 'applyTemperatureNow' }
  /** Масштабировать скорости (нагрев/охлаждение). */
  | { type: 'scaleVelocities'; factor: number }
  /** Заморозить всё / разморозить. */
  | { type: 'freezeAll' }
  | { type: 'unfreezeAll' }
  /** Отложенная пересборка на заданной решётке. */
  | { type: 'rebuild'; lattice: LatticeKind; keepTemperature: boolean }
  /** Радиус связей. */
  | { type: 'setBondRadius'; radius: number }
  /** Кадр статистики g(r) и S(k). */
  | { type: 'sampleRadial' }
  /** Снимок состояния для сохранения. */
  | { type: 'snapshot' }
  /** Восстановление из снимка. */
  | { type: 'restore'; json: string }
  /** Воздействие кистью: ось взгляда и толчок. */
  | {
      type: 'poke';
      axis: { ax: number; ay: number; az: number; rx: number; ry: number; rz: number; ux: number; uy: number; uz: number };
      center: { x: number; y: number; z: number };
      dx: number;
      dy: number;
      dz: number;
      radius: number;
      strength: number;
    }
  /** Единичный замер времени (для диагностики). */
  | { type: 'timing' }
  /**
   * Вернуть использованные буферы кадра в пул воркера.
   *
   * Отдельная команда, потому что после `postMessage` с `Transferable`
   * буфер отчуждается: пользоваться им в главном потоке уже нельзя, а
   * выбросить жалко — на 20 000 частиц это около мегабайта на кадр.
   * Главный поток присылает их обратно, и воркер переиспользует память.
   */
  | ({ type: 'recycle' } & FrameBuffersPayload);

/** События воркера в главный поток. */
export type WorkerEvent =
  /** Мир создан или пересоздан. */
  | { type: 'ready'; count: number; box: number }
  /**
   * Кадр состояния.
   *
   * Буферы ПЕРЕДАЮТСЯ по владению: после `postMessage` они отчуждаются от
   * отправителя, поэтому воркер каждый раз берёт свежую пару из пула.
   */
  | { type: 'frame'; payload: FramePayload }
  /** Снимок состояния (JSON). */
  | { type: 'snapshot'; json: string }
  /** Ошибка выполнения команды. */
  | { type: 'error'; message: string };

/**
 * Состояние, которое воркер отдаёт главному потоку каждый кадр.
 *
 * Набор подобран так, чтобы главный поток мог обслужить ВСЁ, что нужно
 * отрисовке и интерфейсу, без обращения к физике: координаты и скорости
 * для проекции и раскраски, маска заморозки, признак «живая», готовые
 * сводные величины, а также сеть связей (её построение — часть визуала,
 * но данные о парах считает всё равно воркер, чтобы не дублировать работу).
 */
export interface FramePayload extends FrameBuffersPayload {
  /** Сколько пар связей действительно заполнено. */
  bondCount: number;
  /** Упёрлась ли сеть связей в потолок числа пар. */
  bondTruncated: boolean;
  /** Сводка измерений — её показывает панель HUD. */
  summary: FrameSummary;
  /** Кривые для графиков. */
  curves: FrameCurves;
}

/**
 * Данные графиков.
 *
 * Передаются обычным копированием, а не по владению: они маленькие и
 * неизменяемые между кадрами (пересчитываются только на кадре статистики).
 * Копия на 20 000 частиц занимает считаные десятки килобайт, тогда как
 * передача по владению потребовала бы отдельного пула и усложнила обмен.
 */
export interface FrameCurves {
  /** g(r): радиусы и значения. */
  radialR: Float64Array;
  radialG: Float64Array;
  /** S(k): волновые числа и значения. */
  structureK: Float64Array;
  structureS: Float64Array;
  /** MSD: лаги и смещения. */
  msdLag: Float64Array;
  msdMsd: Float64Array;
  /**
   * История измерений для графиков T и энергий.
   *
   * Уже прорежена до `historyPoints` точек: держать в кадре все 4096 замеров
   * было бы расточительно, а графику больше и не нужно — он всё равно
   * прореживает ряд.
   */
  historyTime: Float64Array;
  historyTemperature: Float64Array;
  historyKinetic: Float64Array;
  historyPotential: Float64Array;
  historyTotal: Float64Array;
}

/** Сводные величины кадра: всё, что интерфейс показывает числами. */
export interface FrameSummary {
  count: number;
  box: number;
  time: number;
  steps: number;
  temperature: number;
  kinetic: number;
  potential: number;
  total: number;
  pressure: number;
  virial: number;
  meanSpeed: number;
  mobileFraction: number;
  meanDisplacement: number;
  /** Первый пик g(r) — индикатор кристалличности. */
  orderPeak: number;
  /** Среднее координационное число. */
  coordination: number;
  /** Разброс длин связей. */
  bondSpread: number;
  /** Коэффициент диффузии и качество подгонки. */
  diffusion: number;
  diffusionR2: number;
  /** Готово ли окно MSD. */
  msdReady: boolean;
  msdProgress: number;
  /** Число кадров статистики и пик S(k). */
  radialSamples: number;
  structureSamples: number;
  structurePeak: number;
  structurePeakK: number;
  /** Число пар в списке соседей и число частиц под ограничителем скорости. */
  pairCount: number;
  speedClamped: number;
  /** Вмещает ли сетка радиус поиска. */
  gridIsSafe: boolean;
  /** Параметры, которые могли измениться на стороне воркера. */
  params: WorldParams;
}

/** Размер буфера под связи: выводится из числа частиц на стороне воркера. */
export function bondCapacityFor(count: number): number {
  // Верхняя оценка: у плотной системы на атом приходится до ~16 соседей,
  // то есть до 8·N пар. Берём с запасом и ограничиваем, как в BondNetwork.
  return Math.min(300000, Math.max(1024, count * 9));
}

/** Есть ли в среде поддержка воркеров. */
export function workerSupported(): boolean {
  return typeof Worker !== 'undefined';
}

/** Сколько точек истории кладётся в кадр. */
export const HISTORY_POINTS = 360;

/**
 * Сборка кривых для графиков.
 *
 * Функция общая для воркера и для локального режима: график обязан выглядеть
 * одинаково независимо от того, откуда пришли данные. Дублировать эту логику
 * нельзя — расхождение прореживания дало бы разные кривые при одних данных.
 *
 * @param world мир-источник (в воркере — свой, в главном потоке — локальный)
 */
export function buildCurves(world: {
  history: { size: number; get(index: number): HistorySampleLike | undefined };
  radialDistribution(): { r: Float64Array; g: Float64Array };
  structureFactor(): { k: Float64Array; s: Float64Array };
  msdCurve(): { lag: Float64Array; msd: Float64Array };
}): FrameCurves {
  const radial = world.radialDistribution();
  const structure = world.structureFactor();
  const msd = world.msdCurve();

  // История прореживается равномерно: график всё равно не покажет больше
  // точек, чем пикселей по горизонтали, а держать 4096 замеров в каждом
  // кадре незачем.
  const size = world.history.size;
  const take = Math.min(HISTORY_POINTS, size);
  const historyTime = new Float64Array(take);
  const historyTemperature = new Float64Array(take);
  const historyKinetic = new Float64Array(take);
  const historyPotential = new Float64Array(take);
  const historyTotal = new Float64Array(take);
  const stride = size > 0 ? size / take : 1;
  for (let i = 0; i < take; i++) {
    const sample = world.history.get(Math.min(size - 1, Math.floor(i * stride)));
    if (!sample) continue;
    historyTime[i] = sample.time;
    historyTemperature[i] = sample.temperature;
    historyKinetic[i] = sample.kinetic;
    historyPotential[i] = sample.potential;
    historyTotal[i] = sample.total;
  }

  return {
    radialR: radial.r,
    radialG: radial.g,
    structureK: structure.k,
    structureS: structure.s,
    msdLag: msd.lag,
    msdMsd: msd.msd,
    historyTime,
    historyTemperature,
    historyKinetic,
    historyPotential,
    historyTotal,
  };
}

/** Минимум полей замера истории, нужный кривым. */
export interface HistorySampleLike {
  time: number;
  temperature: number;
  kinetic: number;
  potential: number;
  total: number;
}
