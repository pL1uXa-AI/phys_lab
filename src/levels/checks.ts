/**
 * Вычисление условий уровней.
 *
 * Каждое условие — это сравнение ИЗМЕРЕННОЙ величины с порогом. Здесь важно
 * не ошибиться в двух местах:
 *
 *   1. Окно усреднения. Мгновенный замер доли подвижных частиц в системе из
 *      двух тысяч частиц колеблется на проценты; решение по одному кадру
 *      приводило бы к «случайно прошло». Поэтому величина копится в окне
 *      и сравнивается среднее.
 *
 *   2. Момент замера. Сразу после перестройки мира система ещё не в
 *      равновесии: г(z) не накоплена, температура не установилась. Отсюда
 *      параметр `equilibrate` у уровня — сколько шагов пропустить, прежде
 *      чем начинать считать.
 */

import type { World } from '../core/world.js';
import type { LevelCheck } from './levels.js';

/** Один измеренный признак. */
export interface CheckResult {
  check: LevelCheck;
  /** Значение величины. */
  value: number | string;
  /** Выполнено ли условие. */
  passed: boolean;
  /** Человекочитаемое пояснение: что получилось и что нужно. */
  detail: string;
}

/** Накопитель окна усреднения. */
export class MeasurementWindow {
  private sums = new Map<string, number>();
  private counts = new Map<string, number>();
  /** Сколько шагов окно уже набрало. */
  size = 0;

  add(key: string, value: number): void {
    if (!Number.isFinite(value)) return;
    this.sums.set(key, (this.sums.get(key) ?? 0) + value);
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
  }

  mean(key: string): number {
    const count = this.counts.get(key) ?? 0;
    if (count === 0) return Number.NaN;
    return (this.sums.get(key) ?? 0) / count;
  }

  /** Значение на конце окна минус значение в начале — для дрейфа. */
  private first = new Map<string, number>();
  private last = new Map<string, number>();

  addRange(key: string, value: number): void {
    if (!Number.isFinite(value)) return;
    if (!this.first.has(key)) this.first.set(key, value);
    this.last.set(key, value);
  }

  range(key: string): number {
    const a = this.first.get(key);
    const b = this.last.get(key);
    if (a === undefined || b === undefined) return Number.NaN;
    return b - a;
  }

  reset(): void {
    this.sums.clear();
    this.counts.clear();
    this.first.clear();
    this.last.clear();
    this.size = 0;
  }
}

/**
 * Текущие измеренные величины мира, по которым считаются проверки.
 * Собирается в одном месте, чтобы условие уровня не лазило по миру напрямую.
 */
export interface LevelMetrics {
  temperature: number;
  density: number;
  mobility: number;
  meanSpeed: number;
  pressure: number;
  orderPeak: number;
  count: number;
  escaped: number;
  /**
   * Доля частиц в сфере радиуса r вокруг центра масс. Используется для
   * проверки «капля собралась»: у свободной капли это почти единица,
   * у разлетевшегося газа — много меньше.
   */
  confinedFraction(radius: number): number;
}

/** Сбор величин из мира. */
export function metricsOf(world: World, startCount: number): LevelMetrics {
  const measurement = world.measurement;
  const alive = measurement.count;
  return {
    temperature: measurement.temperature,
    density: world.params.density,
    mobility: measurement.mobileFraction,
    meanSpeed: measurement.meanSpeed,
    pressure: measurement.pressure,
    orderPeak: world.orderPeak,
    count: alive,
    escaped: Math.max(0, startCount - alive),
    confinedFraction(radius: number): number {
      return confinedFraction(world, radius);
    },
  };
}

/**
 * Доля живых частиц внутри сферы радиуса `radius` вокруг центра масс.
 *
 * Центр масс считается по живым частицам: у открытого ящика он уезжает вслед
 * за испаряющимися частицами, и привязка к геометрическому центру ящика дала
 * бы ложную картину.
 */
export function confinedFraction(world: World, radius: number): number {
  const state = world.state;
  let count = 0;
  let cx = 0;
  let cy = 0;
  let cz = 0;
  for (let i = 0; i < state.count; i++) {
    if (state.alive[i] === 0) continue;
    cx += state.x[i];
    cy += state.y[i];
    cz += state.z[i];
    count++;
  }
  if (count === 0) return 0;
  cx /= count;
  cy /= count;
  cz /= count;

  const periodic = world.params.boundary === 'periodic';
  const box = world.box;
  const r2 = radius * radius;
  let inside = 0;
  for (let i = 0; i < state.count; i++) {
    if (state.alive[i] === 0) continue;
    let dx = state.x[i] - cx;
    let dy = state.y[i] - cy;
    let dz = state.z[i] - cz;
    if (periodic) {
      dx -= box * Math.round(dx / box);
      dy -= box * Math.round(dy / box);
      dz -= box * Math.round(dz / box);
    }
    if (dx * dx + dy * dy + dz * dz <= r2) inside++;
  }
  return inside / count;
}

/** Проверка одного условия по усреднённым величинам. */
export function evaluateCheck(
  check: LevelCheck,
  metrics: LevelMetrics,
  window: MeasurementWindow,
  world: World,
): CheckResult {
  const within = (value: number, min?: number, max?: number): boolean =>
    (min === undefined || value >= min) && (max === undefined || value <= max);

  const describe = (value: number, min?: number, max?: number): string => {
    const parts: string[] = [`получено ${value.toFixed(3)}`];
    if (min !== undefined && max !== undefined) parts.push(`нужно ${min}…${max}`);
    else if (min !== undefined) parts.push(`нужно ≥ ${min}`);
    else if (max !== undefined) parts.push(`нужно ≤ ${max}`);
    return parts.join(', ');
  };

  switch (check.kind) {
    case 'temperature': {
      const value = metrics.temperature;
      return {
        check,
        value,
        passed: within(value, check.min, check.max),
        detail: describe(value, check.min, check.max),
      };
    }
    case 'mobility': {
      const value = metrics.mobility;
      return {
        check,
        value,
        passed: within(value, check.min, check.max),
        detail: describe(value, check.min, check.max),
      };
    }
    case 'msd': {
      const value = window.mean('msdDelta');
      return {
        check,
        value,
        passed: Number.isFinite(value) && within(value, check.min, check.max),
        detail: Number.isFinite(value)
          ? describe(value, check.min, check.max)
          : 'мало данных: симуляция ещё не набрала статистику',
      };
    }
    case 'orderPeak': {
      const value = metrics.orderPeak;
      return {
        check,
        value,
        passed: within(value, check.min, check.max),
        detail: describe(value, check.min, check.max),
      };
    }
    case 'confinement': {
      const value = metrics.confinedFraction(check.radius);
      return {
        check,
        value,
        passed: within(value, check.min, check.max),
        detail: describe(value, check.min, check.max),
      };
    }
    case 'remaining': {
      const value = metrics.count;
      return {
        check,
        value,
        passed: within(value, check.min, check.max),
        detail: describe(value, check.min, check.max),
      };
    }
    case 'escaped': {
      const value = metrics.escaped;
      return {
        check,
        value,
        passed: within(value, check.min, check.max),
        detail: describe(value, check.min, check.max),
      };
    }
    case 'meanSpeed': {
      const value = metrics.meanSpeed;
      return {
        check,
        value,
        passed: within(value, check.min, check.max),
        detail: describe(value, check.min, check.max),
      };
    }
    case 'energyDrop': {
      const value = window.mean('energyDrop');
      return {
        check,
        value,
        passed: Number.isFinite(value) && within(value, check.min, check.max),
        detail: Number.isFinite(value)
          ? describe(value, check.min, check.max)
          : 'мало данных: симуляция ещё не набрала статистику',
      };
    }
    case 'pressure': {
      const value = window.mean('pressure');
      return {
        check,
        value,
        passed: Number.isFinite(value) && within(value, check.min, check.max),
        detail: Number.isFinite(value)
          ? describe(value, check.min, check.max)
          : 'мало данных: симуляция ещё не набрала статистику',
      };
    }
    case 'density': {
      const value = metrics.density;
      return {
        check,
        value,
        passed: within(value, check.min, check.max),
        detail: describe(value, check.min, check.max),
      };
    }
    case 'energyDrift': {
      // Относительный размах полной энергии за окно: у симплектической схемы
      // он должен быть мал и не расти, у «сломанной» силы — экспоненциально.
      const range = window.range('totalEnergy');
      const mean = window.mean('totalEnergy');
      const value = Number.isFinite(range) && Math.abs(mean) > 1e-9 ? Math.abs(range / mean) : Number.NaN;
      return {
        check,
        value,
        passed: Number.isFinite(value) && value <= check.max,
        detail: Number.isFinite(value)
          ? `относительный размах ${value.toExponential(2)}, нужно ≤ ${check.max}`
          : 'мало данных: симуляция ещё не набрала статистику',
      };
    }
    case 'thermostat': {
      const value = world.params.thermostat;
      const wanted = check.value ?? 'none';
      return {
        check,
        value,
        passed: value === wanted,
        detail: `сейчас «${value}», нужно «${wanted}»`,
      };
    }
    case 'boundary': {
      const value = world.params.boundary;
      const wanted = check.value ?? 'reflective';
      return {
        check,
        value,
        passed: value === wanted,
        detail: `сейчас «${value}», нужно «${wanted}»`,
      };
    }
    default: {
      // Исчерпывающий разбор: если появится новое условие, TypeScript
      // укажет на это место, а не молча «пройдёт» проверку.
      const exhaustive: never = check;
      return { check: exhaustive, value: '', passed: false, detail: 'неизвестное условие' };
    }
  }
}

/** Итог проверки уровня. */
export interface LevelReport {
  levelId: string;
  passed: boolean;
  results: CheckResult[];
}

/** Проверка всех условий уровня. */
export function evaluateLevel(
  levelId: string,
  checks: LevelCheck[],
  metrics: LevelMetrics,
  window: MeasurementWindow,
  world: World,
): LevelReport {
  const results = checks.map((check) => evaluateCheck(check, metrics, window, world));
  return {
    levelId,
    passed: results.every((result) => result.passed),
    results,
  };
}
