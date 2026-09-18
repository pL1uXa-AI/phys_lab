/**
 * Зеркало мира: то, что читает отрисовка и интерфейс, собранное из кадров.
 *
 * ─── Зачем это нужно ─────────────────────────────────────────────────────
 *
 * Отрисовка и интерфейс синхронно читают у мира десятки вещей: координаты,
 * скорости, маску заморозки, сеть связей, измерение, кривые для графиков.
 * Сделать все эти чтения асинхронными — значит переписать `app.ts`,
 * `scene.ts` и панели.
 *
 * Вместо этого здесь собран объект с ТЕМ ЖЕ интерфейсом, но наполняемый из
 * кадров. Рендер и панели продолжают работать без единой правки: они не
 * знают, что данные приходят из другого потока.
 *
 * ─── Что здесь ЕСТЬ и чего НЕТ ───────────────────────────────────────────
 *
 * Есть: всё, что нужно ЧТЕНИЮ, — состояние частиц, заморозка, box, params,
 * measurement, кривые, сеть связей, проекция, раскраска.
 *
 * Нет: всего, что МЕНЯЕТ физику. `step()`, `resize()`, `setDensity()` и
 * прочие мутаторы отсутствуют намеренно. Если бы они здесь были, рано или
 * поздно кто-нибудь вызвал бы их «для быстрого исправления», физика пошла бы
 * в двух местах сразу, и рассинхрон проявился бы как «частицы дрожат».
 * Мутаторы уходят командами в воркер — см. `PhysicsWorkerClient`.
 *
 * ─── Почему `state` — НЕ полный `ParticleState` ──────────────────────────
 *
 * Соблазн подставить вместо отсутствующих полей (`px`, `refX`, `fx`) те же
 * массивы, что есть, велик: код бы скомпилировался. Но это ложь в типах —
 * `px` означает «координата на прошлом шаге», и однажды кто-то прочитает её
 * как таковую и получит нынешнюю координату. Поэтому здесь отдельный тип
 * `MirrorState` с теми полями, которые отрисовке действительно нужны, и
 * проверено, что больше она ничего не читает.
 */

import type { Measurement } from '../core/measure.js';
import type { BoundaryMode, ThermostatKind } from '../core/types.js';
// Ось взгляда берётся ИЗ ЯДРА, а не дублируется здесь.
//
// Первая версия зеркала повторяла формулу «по смыслу» — и тест на совпадение
// с миром сразу показал расхождение: у ядра `ay = sinP`, а я написал `cosP`.
// Кисть в этом случае бьёт не туда, куда смотрит курсор, и заметить это
// можно было бы только руками в браузере. Любая формула, которую использует
// и ядро, и главный поток, обязана иметь ОДНУ реализацию.
import { viewAxis } from '../core/integrator.js';
import {
  bondsOfFrame,
  colorValuesOfFrame,
  projectFrame,
  type MirrorBonds,
} from './client.js';
import type { FrameCurves, FramePayload } from './protocol.js';

/**
 * Состояние частиц в том объёме, в каком его читает отрисовка.
 *
 * Проверено поиском по коду: `px/py/pz`, `refX..refZ`, `fx..fz` и `travel`
 * читающие модули не используют — они нужны только физике, которая осталась
 * в воркере.
 */
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

/** Параметры мира в объёме, нужном интерфейсу. */
export interface MirrorParams {
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

/** История в виде, который читает приложение: только размер и доступ по индексу. */
export interface MirrorHistory {
  size: number;
  get(index: number): MirrorSample | undefined;
  series(key: MirrorSeriesKey, maxPoints?: number): { t: number[]; v: number[] };
}

/** Замер истории. */
export interface MirrorSample {
  time: number;
  temperature: number;
  kinetic: number;
  potential: number;
  total: number;
  pressure: number;
  orderPeak: number;
  mobileFraction: number;
}

/** Какие ряды умеет отдавать история. */
export type MirrorSeriesKey =
  | 'temperature'
  | 'kinetic'
  | 'potential'
  | 'total'
  | 'pressure'
  | 'orderPeak'
  | 'mobileFraction';

/** Вид g(r) для панелей — столько, сколько они читают. */
export interface MirrorRadial {
  readonly sampleCount: number;
  result(): { r: Float64Array; g: Float64Array };
  firstPeak(): number;
}

/** Вид S(k) для панелей. */
export interface MirrorStructure {
  readonly sampleCount: number;
  firstPeak(): { k: number; height: number };
}

/**
 * Зеркало одного кадра.
 *
 * Создаётся заново на каждый полученный кадр: предыдущий уже отдан воркеру
 * обратно (буферы по владению), и читать из него нельзя.
 */
export class WorldMirror {
  readonly state: MirrorState;
  readonly frozen: Uint8Array;
  readonly box: number;
  readonly params: MirrorParams;
  readonly time: number;
  readonly steps: number;
  readonly measurement: Measurement;
  readonly history: MirrorHistory;
  readonly radial: MirrorRadial;
  readonly structure: MirrorStructure;
  readonly msd: { originCount: number };
  readonly orderPeak: number;
  readonly pairCount: number;
  readonly speedClampedCount: number;
  readonly gridIsSafe: boolean;
  readonly potentialEnergy: number;
  readonly volume: number;
  readonly msdReady: boolean;
  readonly msdProgress: number;
  /** Сколько шагов воркер выполнил — монотонно, не сбрасывается пересборкой. */
  readonly stepsExecuted: number;
  /** Измеренная воркером стоимость одного шага, мс. */
  readonly stepCostMs: number;

  private readonly frame: FramePayload;
  private readonly bondView: MirrorBonds;

  constructor(frame: FramePayload) {
    this.frame = frame;
    const s = frame.summary;
    this.box = s.box;
    this.params = s.params;
    this.time = s.time;
    this.steps = s.steps;
    this.orderPeak = s.orderPeak;
    this.pairCount = s.pairCount;
    this.speedClampedCount = s.speedClamped;
    this.gridIsSafe = s.gridIsSafe;
    this.potentialEnergy = s.potential;
    this.volume = s.box * s.box * s.box;
    this.msdReady = s.msdReady;
    this.msdProgress = s.msdProgress;
    this.stepsExecuted = s.stepsExecuted;
    this.stepCostMs = s.stepCostMs;
    this.frozen = frame.frozen;
    this.bondView = bondsOfFrame(frame);

    /*
     * Массивы НЕ копируются: воркер отдал их по владению и больше не тронет.
     * Именно в этом смысл обмена без SharedArrayBuffer — на 20 000 частиц
     * копия стоила бы около мегабайта на кадр.
     */
    this.state = {
      count: s.count,
      x: frame.x,
      y: frame.y,
      z: frame.z,
      vx: frame.vx,
      vy: frame.vy,
      vz: frame.vz,
      speed: frame.speed,
      displacement: frame.displacement,
      neighbours: frame.neighbours,
      alive: frame.alive,
    };

    this.measurement = {
      count: s.count,
      kinetic: s.kinetic,
      potential: s.potential,
      total: s.total,
      temperature: s.temperature,
      // Число степеней свободы: три забраны движением центра масс при
      // периодических границах — та же формула, что в ядре.
      dof: Math.max(1, 3 * s.count - (s.params.boundary === 'periodic' && s.count > 1 ? 3 : 0)),
      pressure: s.pressure,
      virial: s.virial,
      meanSpeed: s.meanSpeed,
      mobileFraction: s.mobileFraction,
      meanDisplacement: s.meanDisplacement,
    };

    this.history = makeHistory(frame.curves);
    const curves = frame.curves;
    this.radial = {
      sampleCount: s.radialSamples,
      result: (): { r: Float64Array; g: Float64Array } => ({
        r: curves.radialR,
        g: curves.radialG,
      }),
      firstPeak: (): number => s.orderPeak,
    };
    this.structure = {
      sampleCount: s.structureSamples,
      firstPeak: (): { k: number; height: number } => ({
        k: s.structurePeakK,
        height: s.structurePeak,
      }),
    };
    /*
     * Число начал отсчёта MSD.
     *
     * Раньше здесь стоял ноль с обоснованием «нужно только подписи, ничего не
     * решает». Это тот же класс дефекта, что и потерянные столбцы истории:
     * диагностическая величина молча показывала ноль, и отличить «начал нет»
     * от «данные не передали» было нельзя.
     */
    this.msd = { originCount: s.msdOriginCount };
  }

  /** Готовая функция g(r). */
  radialDistribution(): { r: Float64Array; g: Float64Array } {
    return { r: this.frame.curves.radialR, g: this.frame.curves.radialG };
  }

  /** Структурный фактор S(k). */
  structureFactor(): { k: Float64Array; s: Float64Array } {
    return { k: this.frame.curves.structureK, s: this.frame.curves.structureS };
  }

  /**
   * Кривая среднеквадратичного смещения.
   *
   * `counts` восстанавливается по ненулевым бинам: графику он нужен лишь для
   * обрезки по последнему бину с данными, и этой оценки достаточно. Нулевое
   * смещение при живых началах невозможно — MSD неотрицательна и растёт.
   */
  msdCurve(): { lag: Float64Array; msd: Float64Array; counts: Int32Array } {
    const curves = this.frame.curves;
    const counts = new Int32Array(curves.msdLag.length);
    for (let i = 0; i < counts.length; i++) counts[i] = curves.msdMsd[i] > 0 ? 1 : 0;
    return { lag: curves.msdLag, msd: curves.msdMsd, counts };
  }

  /** Коэффициент диффузии и качество подгонки. */
  diffusion(): { D: number; r2: number; lagRange: [number, number] } {
    return {
      D: this.frame.summary.diffusion,
      r2: this.frame.summary.diffusionR2,
      /*
       * Границы участка фита.
       *
       * Раньше здесь возвращался весь диапазон лагов: считалось, что без
       * подсветки «график остаётся верным». Формально да, но игрок видел
       * подсвеченным весь график — то есть неправду о том, где именно
       * измерена прямая, по которой посчитан D. Теперь участок передаётся.
       */
      lagRange: [this.frame.summary.diffusionLagStart, this.frame.summary.diffusionLagEnd],
    };
  }

  /** Среднее координационное число. */
  get coordination(): number {
    return this.frame.summary.coordination;
  }

  /** Разброс длин связей. */
  get bondSpread(): number {
    return this.frame.summary.bondSpread;
  }

  /** Размер окна MSD — для панели. */
  get msdOriginCount(): number {
    return this.msd.originCount;
  }

  /** Сеть связей для отрисовки. */
  bondNetwork(_radius?: number): MirrorBonds {
    return this.bondView;
  }

  /** Проекция частиц: та же формула, что в мире (совпадение проверено тестом). */
  project(yaw: number, pitch: number, out: Float32Array): void {
    projectFrame(this.frame, yaw, pitch, out);
  }

  /** Значения для раскраски. */
  colorValues(mode: string): { values: Float64Array; min: number; max: number } {
    return colorValuesOfFrame(this.frame, mode);
  }

  /** Ось взгляда для кисти: считается локально, физики не требует. */
  viewAxis(yaw: number, pitch: number): ReturnType<typeof viewAxis> {
    return viewAxis(yaw, pitch);
  }
}

/**
 * История из прореженного ряда, пришедшего в кадре.
 *
 * Прореживание сделано на стороне воркера: держать в кадре все 4096 замеров
 * незачем, график всё равно не покажет больше точек, чем пикселей.
 */
function makeHistory(curves: FrameCurves): MirrorHistory {
  const size = curves.historyTime.length;
  return {
    size,
    get(index: number): MirrorSample | undefined {
      if (index < 0 || index >= size) return undefined;
      return {
        time: curves.historyTime[index],
        temperature: curves.historyTemperature[index],
        kinetic: curves.historyKinetic[index],
        potential: curves.historyPotential[index],
        total: curves.historyTotal[index],
        /*
         * Давление, пик g(r) и подвижность.
         *
         * Раньше здесь стояли нули «потому что графиков нет». Это оказалось
         * тихой потерей данных: те же замеры выгружаются в CSV, и в режиме
         * воркера три столбца из восьми уходили нулями, тогда как в локальном
         * режиме были заполнены. Измерено: P* — 0 непустых значений против
         * 923 в локальном режиме, и файл при этом выглядел нормальным.
         */
        pressure: curves.historyPressure[index],
        orderPeak: curves.historyOrderPeak[index],
        mobileFraction: curves.historyMobileFraction[index],
      };
    },
    series(key: MirrorSeriesKey, maxPoints = 720): { t: number[]; v: number[] } {
      const stride = Math.max(1, Math.ceil(size / maxPoints));
      const t: number[] = [];
      const v: number[] = [];
      for (let i = 0; i < size; i += stride) {
        t.push(curves.historyTime[i]);
        v.push(seriesValue(curves, key, i));
      }
      return { t, v };
    },
  };
}

/** Значение ряда истории по ключу. */
function seriesValue(curves: FrameCurves, key: MirrorSeriesKey, index: number): number {
  switch (key) {
    case 'temperature':
      return curves.historyTemperature[index];
    case 'kinetic':
      return curves.historyKinetic[index];
    case 'potential':
      return curves.historyPotential[index];
    case 'total':
      return curves.historyTotal[index];
    // Эти ряды доступны так же, как остальные: раньше здесь возвращался ноль,
    // и панель, попросив ряд, молча получала пустую линию.
    case 'pressure':
      return curves.historyPressure[index];
    case 'orderPeak':
      return curves.historyOrderPeak[index];
    case 'mobileFraction':
      return curves.historyMobileFraction[index];
    default:
      return 0;
  }
}

