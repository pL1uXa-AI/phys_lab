/**
 * Сессия уровня: следит за ходом выполнения задания.
 *
 * Уровень — это не «пройдено / не пройдено», а набор признаков, каждый из
 * которых либо выполнен, либо нет. Игрок должен видеть, ЧТО именно осталось,
 * поэтому сессия отдаёт список задач с отметками, а не одну галочку.
 *
 * Сессия ничего не считает по своей воле: приложение сообщает ей о каждом
 * шаге (`tick`), а она решает, когда начать накопление статистики, когда
 * посчитать отчёт и как часто это повторять.
 */

import type { World } from '../core/world.js';
import {
  type LevelMetrics,
  type LevelReport,
  MeasurementWindow,
  evaluateLevel,
  metricsOf,
} from './checks.js';
import type { Level } from './levels.js';

/** Состояние прохождения уровня. */
export type LevelStatus = 'setup' | 'equilibrating' | 'measuring' | 'passed' | 'idle';

/** Сессия одного уровня. */
export class LevelSession {
  readonly level: Level;
  status: LevelStatus = 'setup';
  /** Номер шага с момента старта уровня. */
  steps = 0;  /** Накопитель окна измерений. */
  readonly window = new MeasurementWindow();
  /** Последний отчёт проверки. */
  lastReport: LevelReport | null = null;
  /** Число частиц на момент старта — для счётчика испарившихся. */
  private startCount = 0;
  /** Позиция частиц в начале окна — для среднего квадрата смещения. */
  private readonly msdOrigin: Float64Array;
  private msdSamples = 0;
  private msdAccum = 0;
  /**
   * Потенциальная энергия на частицу в начале окна. Служит точкой отсчёта
   * для условия «энергия упала»: сравнивать с абсолютным нулём бессмысленно,
   * потому что у каждого старта своя глубина потенциальной ямы.
   */
  private energyOrigin: number;
  /** Как часто пересчитывать отчёт (в шагах) — не каждый шаг. */
  private readonly reportInterval = 120;
  private lastReportStep = -1;

  constructor(level: Level, world: World) {
    this.level = level;
    this.startCount = world.measurement.count;
    this.msdOrigin = new Float64Array(world.state.count * 3);
    this.msdSamples = 0;
    this.msdAccum = 0;
    this.energyOrigin = world.potentialPerParticle;
    this.captureMsdOrigin(world);
    this.status = level.equilibrate > 0 ? 'equilibrating' : 'measuring';
  }

  /** Привязать сессию к миру: пересобрать буферы под новое число частиц. */
  private captureMsdOrigin(world: World): void {
    const state = world.state;
    for (let i = 0; i < state.count; i++) {
      this.msdOrigin[i * 3] = state.x[i];
      this.msdOrigin[i * 3 + 1] = state.y[i];
      this.msdOrigin[i * 3 + 2] = state.z[i];
    }
  }

  /**
   * Сообщить сессии, что мир сделал шаг.
   *
   * @returns отчёт, если его пора пересчитать, иначе null
   */
  tick(world: World): LevelReport | null {
    if (this.status === 'passed' || this.status === 'idle') return null;
    this.steps++;

    if (this.status === 'equilibrating') {
      if (this.steps < this.level.equilibrate) return null;
      // Равновесие достигнуто: сбрасываем окно и начинаем измерять.
      this.status = 'measuring';
      this.window.reset();
      this.energyOriginReset(world);
      this.captureMsdOrigin(world);
      this.msdAccum = 0;
      this.msdSamples = 0;
      return null;
    }
    if (this.status !== 'measuring') return null;

    const metrics = metricsOf(world, this.startCount);
    this.collect(world, metrics);

    if (this.steps - this.lastReportStep < this.reportInterval) return null;
    this.lastReportStep = this.steps;

    const report = evaluateLevel(
      this.level.id,
      this.level.checks,
      metrics,
      this.window,
      world,
    );
    this.lastReport = report;
    if (report.passed) this.status = 'passed';
    return report;
  }

  /**
   * Накопление величин, которые нельзя измерить в один момент:
   * давление, энергия и средний квадрат смещения требуют окна.
   */
  private collect(world: World, metrics: LevelMetrics): void {
    this.window.size++;
    this.window.add('temperature', metrics.temperature);
    this.window.add('pressure', metrics.pressure);
    this.window.add('mobility', metrics.mobility);

    const total = world.measurement.total;
    this.window.add('totalEnergy', total);
    this.window.addRange('totalEnergy', total);

    const perParticle = world.potentialPerParticle;
    if (Math.abs(this.energyOrigin) > 1e-9) {
      this.window.add('energyDrop', perParticle / this.energyOrigin - 1);
    }

    // Средний квадрат смещения считается от начала окна: так измеряется
    // именно диффузия за время наблюдения, а не абсолютный сдвиг.
    const state = world.state;
    const periodic = world.params.boundary === 'periodic';
    const box = world.box;
    let sum = 0;
    let count = 0;
    for (let i = 0; i < state.count; i++) {
      if (state.alive[i] === 0) continue;
      let dx = state.x[i] - this.msdOrigin[i * 3];
      let dy = state.y[i] - this.msdOrigin[i * 3 + 1];
      let dz = state.z[i] - this.msdOrigin[i * 3 + 2];
      if (periodic) {
        dx -= box * Math.round(dx / box);
        dy -= box * Math.round(dy / box);
        dz -= box * Math.round(dz / box);
      }
      sum += dx * dx + dy * dy + dz * dz;
      count++;
    }
    if (count > 0) {
      this.msdAccum += sum / count;
      this.msdSamples++;
      this.window.add('msdDelta', this.msdAccum / this.msdSamples);
    }
  }

  private energyOriginReset(world: World): void {
    this.energyOrigin = world.potentialPerParticle;
  }

  /** Отчёт по текущему состоянию без ожидания окна — для кнопки «Проверить». */
  checkNow(world: World): LevelReport {
    const metrics = metricsOf(world, this.startCount);
    // Даём хотя бы один замер в окно, иначе условия по средним не посчитаются.
    if (this.window.size === 0) {
      this.window.add('pressure', metrics.pressure);
      this.window.add('totalEnergy', world.measurement.total);
      this.window.addRange('totalEnergy', world.measurement.total);
      this.window.add('energyDrop', 0);
      this.window.add('msdDelta', 0);
      this.window.size = 1;
    }
    const report = evaluateLevel(this.level.id, this.level.checks, metrics, this.window, world);
    this.lastReport = report;
    if (report.passed) this.status = 'passed';
    return report;
  }

  /** Прогресс подготовки к проверке: 0…1. */
  get progress(): number {
    if (this.status === 'passed') return 1;
    if (this.status === 'measuring' || this.status === 'idle') return 1;
    if (this.status !== 'equilibrating') return 0;
    return Math.min(1, this.steps / Math.max(1, this.level.equilibrate));
  }
}
