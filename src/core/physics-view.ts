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
