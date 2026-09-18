/**
 * Контракт ЧТЕНИЯ физики.
 *
 * ─── Зачем он нужен ──────────────────────────────────────────────────────
 *
 * Отрисовке и интерфейсу нужен не весь `World`, а небольшая часть: массив
 * частиц, маска заморозки, габарит ящика, проекция, раскраска, сеть связей
 * и сводка измерений. Мутаторы (`step`, `resize`, `setDensity`) им не нужны
 * вовсе.
 *
 * Пока физика была одна, это было незаметно: все брали `World` целиком. Но
 * когда тот же набор данных начал приходить из воркера, выяснилось, что
 * подменять `World` нельзя — зеркало не имеет (и не должно иметь) мутаторов,
 * поэтому оно не совместимо по типу с `World`.
 *
 * `PhysicsView` описывает ровно то, что нужно чтению. Ему удовлетворяют и
 * `World`, и `WorldMirror`, поэтому рендер работает с обоими без единой
 * проверки режима — и, что важнее, БЕЗ возможности случайно вызвать мутатор:
 * их в контракте просто нет.
 *
 * ─── Правило, которое здесь закреплено ───────────────────────────────────
 *
 * Всё, что меняет физику, обязано идти через `PhysicsBridge`. Если у типа
 * появляется `step()`, значит кто-то снова может посчитать физику в главном
 * потоке — и тогда состояние разъедется с воркером.
 */

import type { Measurement } from './measure.js';
import type { BoundaryMode, ThermostatKind } from './types.js';

/** Состояние частиц в объёме, нужном отрисовке. */
export interface ViewState {
  count: number;
  x: Float64Array;
  y: Float64Array;
  z: Float64Array;
  vx: Float64Array;
  vy: Float64Array;
  vz: Float64Array;
  /** Модуль скорости — кэш для раскраски. */
  speed: Float64Array;
  /** Модуль смещения от исходного места — для раскраски «Смещение». */
  displacement: Float64Array;
  /** Локальная плотность — для раскраски по числу соседей. */
  neighbours: Float64Array;
  /** Признак «частица внутри ящика». */
  alive: Uint8Array;
}

/** Параметры мира в объёме, нужном интерфейсу. */
export interface ViewParams {
  count: number;
  density: number;
  cutoff: number;
  dt: number;
  temperature: number;
  boundary: BoundaryMode;
  thermostat: ThermostatKind;
  thermostatTau: number;
  friction: number;
}

/** Сеть связей в том виде, в каком её читает отрисовка. */
export interface ViewBonds {
  pairCount: number;
  a: Int32Array;
  b: Int32Array;
  length: Float32Array;
  dx: Float32Array;
  dy: Float32Array;
  dz: Float32Array;
  /**
   * Упёрлась ли сеть в потолок числа пар.
   *
   * Нужно отрисовке, чтобы честно сообщить: часть связей не поместилась, и
   * картинка показывает не всю структуру. Молча обрезать нельзя — игрок
   * решил бы, что связей действительно столько.
   */
  truncated: boolean;
}

/** Ось взгляда и базис экрана — то, что нужно кисти. */
export interface ViewAxisLike {
  ax: number;
  ay: number;
  az: number;
  rx: number;
  ry: number;
  rz: number;
  ux: number;
  uy: number;
  uz: number;
}

/** Один замер истории измерений. */
export interface ViewSample {
  time: number;
  temperature: number;
  kinetic: number;
  potential: number;
  total: number;
  pressure: number;
  orderPeak: number;
  mobileFraction: number;
}

/** Названия рядов истории, которые рисуются графиками. */
export type ViewSeriesKey =
  | 'temperature'
  | 'kinetic'
  | 'potential'
  | 'total'
  | 'pressure'
  | 'orderPeak'
  | 'mobileFraction';

/** История измерений в объёме, нужном графикам. */
export interface ViewHistory {
  readonly size: number;
  get(index: number): ViewSample | undefined;
  series(key: ViewSeriesKey, maxPoints?: number): { t: number[]; v: number[] };
}

/** Вид g(r) для графиков и панелей. */
export interface ViewRadial {
  readonly sampleCount: number;
  /**
   * Готовая кривая.
   *
   * В ядре `result(box)` требует длину ящика для нормировки; в зеркале
   * нормировка уже сделана воркером, и аргумент не нужен. Поэтому параметр
   * здесь НЕобязательный: иначе типы двух источников не сошлись бы, и
   * пришлось бы либо тащить `box` в зеркало без надобности, либо подгонять
   * сигнатуру на месте вызова.
   */
  result(box?: number): { r: Float64Array; g: Float64Array };
}

/** Вид S(k) для графиков и панелей. */
export interface ViewStructure {
  readonly sampleCount: number;
  firstPeak(): { k: number; height: number };
}

/** Вид накопителя MSD для панелей. */
export interface ViewMsd {
  readonly originCount: number;
}

/**
 * Всё, что отрисовка и панели читают у физики.
 *
 * Намеренно только методы и свойства ЧТЕНИЯ.
 */
export interface PhysicsView {
  readonly state: ViewState;
  readonly frozen: Uint8Array;
  readonly box: number;
  readonly params: ViewParams;
  readonly time: number;
  readonly steps: number;
  readonly measurement: Measurement;
  /** Полная потенциальная энергия. */
  readonly potentialEnergy: number;
  /**
   * Потенциальная энергия на живую частицу.
   *
   * Нужна проверкам уровней: условие «энергия упала» сравнивает текущее
   * значение с исходным, а абсолютный ноль для этого не годится — у каждого
   * старта своя глубина потенциальной ямы. Раньше величина была только у
   * `World`, из-за чего сессия уровня не могла работать с зеркалом воркера.
   */
  readonly potentialPerParticle: number;
  /** Объём ящика. */
  readonly volume: number;
  /** Первый пик g(r). */
  readonly orderPeak: number;
  /** Число пар в списке соседей. */
  readonly pairCount: number;
  /** Сколько частиц упёрлось в ограничитель скорости. */
  readonly speedClampedCount: number;
  /** Вмещает ли сетка радиус поиска. */
  readonly gridIsSafe: boolean;

  /** Проекция частиц на плоскость экрана. */
  project(yaw: number, pitch: number, out: Float32Array): void;
  /** Значения для раскраски и границы шкалы. */
  colorValues(mode: string): { values: Float64Array; min: number; max: number };
  /** Сеть связей ближних соседей. */
  bondNetwork(radius?: number): ViewBonds;
  /** Ось взгляда по углам камеры. */
  viewAxis(yaw: number, pitch: number): ViewAxisLike;
  /** История измерений — по ней рисуются графики T и энергий. */
  readonly history: ViewHistory;
  /** Готовая функция g(r). */
  radialDistribution(): { r: Float64Array; g: Float64Array };
  /** Накопитель g(r) — нужен ради счётчика кадров. */
  readonly radial: ViewRadial;
  /** Готовая кривая структурного фактора S(k). */
  structureFactor(): { k: Float64Array; s: Float64Array };
  /** Накопитель S(k) — нужен ради счётчика кадров и первого пика. */
  readonly structure: ViewStructure;
  /** Накопитель MSD — нужен ради числа начал отсчёта. */
  readonly msd: ViewMsd;
  /** Кривая среднеквадратичного смещения. */
  msdCurve(): { lag: Float64Array; msd: Float64Array; counts: Int32Array };
  /** Коэффициент диффузии и качество подгонки. */
  diffusion(): { D: number; r2: number; lagRange: [number, number] };
  /** Готово ли окно наблюдения MSD. */
  readonly msdReady: boolean;
  /** Доля заполнения окна MSD. */
  readonly msdProgress: number;
  /** Среднее координационное число. */
  readonly coordination: number;
  /** Разброс длин связей. */
  readonly bondSpread: number;
  /**
   * Сколько шагов физики выполнено за всё время — МОНОТОННО.
   *
   * Не путать со `steps`: тот сбрасывается при пересборке системы, потому
   * что описывает текущую траекторию. Монотонный счётчик нужен, чтобы:
   *   * считать фактическую скорость расчёта (шагов в секунду), которую в
   *     режиме воркера нельзя вывести из времени кадра;
   *   * ограничивать очередь заказанных шагов (см. `PhysicsBridge.backlog`).
   */
  readonly stepsExecuted: number;
}

/*
 * ─── Компиляторная проверка совместимости ────────────────────────────────
 *
 * Здесь зафиксировано главное требование контракта: ему обязаны
 * удовлетворять И настоящий мир, И зеркало воркера. Проверка сделана типами,
 * а не тестом, потому что расхождение должно ломать СБОРКУ, а не выясняться
 * при запуске конкретного сценария.
 *
 * Если однажды у зеркала появится метод, которого нет у `World` (или
 * наоборот), эти строки перестанут компилироваться — и это правильный
 * момент, чтобы подумать, не разъезжаются ли источники данных.
 */
import type { World } from './world.js';
import type { WorldMirror } from '../worker/mirror.js';

/** Настоящий мир обязан удовлетворять контракту чтения. */
export type WorldSatisfiesView = World extends PhysicsView ? true : never;
/** Зеркало воркера обязано удовлетворять тому же контракту. */
export type MirrorSatisfiesView = WorldMirror extends PhysicsView ? true : never;
