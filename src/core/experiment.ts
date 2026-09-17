/**
 * Эксперимент: кривая фазового перехода.
 *
 * ─── Зачем это нужно ─────────────────────────────────────────────────────
 *
 * Всё остальное в проекте показывает систему В ОДНОЙ точке: задал T* и ρ*,
 * посмотрел. Но самый интересный вопрос — «а что происходит при изменении
 * параметра?» — так не задать. Фазовый переход виден именно как АНОМАЛИЯ на
 * кривой: теплота плавления уходит в скрытую теплоту, и внутренняя энергия
 * при постоянной температуре «прыгает».
 *
 * Здесь выполняется свип по температуре: система последовательно проходит
 * набор T*, на каждом выходит на равновесие и накапливает средние.
 *
 * ─── Почему ДВЕ ветви, а не одна ─────────────────────────────────────────
 *
 * Плавление — переход первого рода, и ему свойственен ГИСТЕРЕЗИС: кристалл
 * можно перегреть выше точки плавления (он метастабилен), а жидкость —
 * переохладить. Одна ветвь показала бы просто плавную кривую и ничего не
 * сказала бы о переходе.
 *
 * Поэтому эксперимент идёт дважды: НАГРЕВ от кристалла и ОХЛАЖДЕНИЕ от
 * жидкости. Там, где ветви расходятся, лежит область сосуществования фаз;
 * ширина петли — мера метастабильности. Это не «артефакт расчёта», а
 * измеримая физическая величина, и она воспроизводится.
 *
 * ─── Почему теплоёмкость считается по флуктуациям ────────────────────────
 *
 * C_v = ⟨ΔU²⟩ / (k_B T² N) — флуктуационная формула, где ⟨ΔU²⟩ берётся от
 * ПОЛНОЙ энергии, а не от удельной. Прямое численное дифференцирование
 * U(T) дало бы шумную кривую, потому что шаг по температуре конечен.
 * Флуктуационная формула использует те же данные, но устойчивее, и на
 * переходе даёт отчётливый пик.
 *
 * Требование к термостату: он обязан давать канонический ансамбль, иначе
 * флуктуации подавлены и C_v выходит нулём (см. комментарий про выбор
 * термостата в конструкторе).
 *
 * Модуль не знает ни про DOM, ни про рендер: эксперимент можно запустить и
 * проверить в чистом Node. Прогресс отдаётся наружу, потому что расчёт
 * длится секунды и интерфейс обязан показать, что работа идёт.
 */

import { World } from './world.js';
import type { LatticeKind, WorldParams } from './types.js';

/** Какую ветвь считаем. */
export type ExperimentBranch = 'heating' | 'cooling';

/** Настройки эксперимента. */
export interface ExperimentConfig {
  /** Число частиц (округлится до 4n³ для решёток). */
  count: number;
  /** Плотность ρ* — фиксирована на протяжении всего свипа. */
  density: number;
  /** Температуры, которые проходит система. */
  temperatures: number[];
  /** Шагов на выход на равновесие при каждой температуре. */
  equilibrate: number;
  /** Шагов накопления статистики при каждой температуре. */
  sample: number;
  /** Через сколько шагов накапливать замер (реже — дешевле). */
  sampleEvery: number;
  /** Начальная решётка: для нагрева — кристалл, для охлаждения — жидкость. */
  lattice: LatticeKind;
  /** Направление свипа. */
  branch: ExperimentBranch;
  /** Зерно генератора: от него зависит воспроизводимость. */
  seed: number;
}

/** Точка кривой: одна температура. */
export interface ExperimentPoint {
  /** Температура, при которой измеряли. */
  temperature: number;
  /** Фактически получившаяся T* (термостат держит её с ошибкой). */
  measuredTemperature: number;
  /** Средняя потенциальная энергия на частицу. */
  energy: number;
  /** Среднее давление P*. */
  pressure: number;
  /** Теплоёмкость на частицу, C_v / N. */
  heatCapacity: number;
  /** Число накопленных замеров. */
  samples: number;
}

/** Итог эксперимента. */
export interface ExperimentResult {
  branch: ExperimentBranch;
  density: number;
  count: number;
  points: ExperimentPoint[];
  /** Температура с максимальной теплоёмкостью — оценка точки перехода. */
  transitionTemperature: number;
  /** Максимальная теплоёмкость (высота пика). */
  peakHeatCapacity: number;
}

/**
 * Значения по умолчанию: разумный компромисс между временем и качеством.
 *
 * ─── Почему диапазон такой широкий ───────────────────────────────────────
 *
 * Равновесная температура плавления объёмного Леннард-Джонса при ρ* = 0.95
 * равна T* ≈ 0.7. Но однородный ГЦК-кристалл при периодических границах
 * ПЕРЕГРЕВАЕТСЯ: плавление начинается с зародыша (свободной поверхности или
 * дефекта), а внутри идеальной решётки зародыша нет. Измерено на этой
 * системе: скачок энергии, отвечающий плавлению, наблюдается между
 * T* = 1.2 и 1.3, то есть решётка «терпит» перегрев почти вдвое.
 *
 * Поэтому свип начинается задолго до 0.7 и заканчивается выше 1.3: иначе
 * переход просто не попал бы в окно, и эксперимент показывал бы гладкую
 * кривую без всякой физики.
 *
 * Наглядный способ увидеть равновесную температуру — вести ОХЛАЖДЕНИЕ от
 * жидкости: переохлаждение выражено слабее перегрева, и кристаллизация
 * идёт ближе к 0.7.
 */
export const DEFAULT_EXPERIMENT: ExperimentConfig = {
  count: 256,
  density: 0.95,
  temperatures: [0.6, 0.7, 0.8, 0.9, 1.0, 1.1, 1.2, 1.25, 1.3, 1.4, 1.5],
  equilibrate: 1200,
  sample: 1200,
  sampleEvery: 8,
  lattice: 'fcc',
  branch: 'heating',
  seed: 20260214,
};

/**
 * Живой эксперимент: продвигается пошагово, чтобы интерфейс не замерзал.
 *
 * Один вызов `advance(steps)` делает указанное число шагов физики и
 * возвращает управление. Прогресс считается по числу пройденных шагов от
 * общего плана, поэтому полоса загрузки честная, а не «примерная».
 */
export class PhaseExperiment {
  readonly config: ExperimentConfig;
  private world: World;
  private readonly points: ExperimentPoint[] = [];

  /** Индекс текущей температуры в свипе. */
  private temperatureIndex = 0;
  /** Шагов сделано на текущей температуре (включая выход на равновесие). */
  private stepsAtTemperature = 0;
  /** Накопители по текущей температуре. */
  private energySum = 0;
  private energySqSum = 0;
  private pressureSum = 0;
  private temperatureSum = 0;
  private sampleCount = 0;
  private stepsSinceSample = 0;
  private finished = false;

  constructor(config: Partial<ExperimentConfig> = {}) {
    this.config = { ...DEFAULT_EXPERIMENT, ...config };
    const first = this.config.temperatures[0] ?? 1;
    this.world = new World(
      {
        count: this.config.count,
        density: this.config.density,
        temperature: first,
        /*
         * Термостат Ланжевена, а НЕ Берендсена — и это принципиально.
         *
         * Теплоёмкость здесь считается по ФЛУКТУАЦИЯМ энергии:
         * C_v = ⟨ΔU²⟩ / (k_B T² N). Такой способ требует, чтобы термостат
         * давал правильный канонический ансамбль.
         *
         * Берендсен этого не умеет: он просто масштабирует все скорости к
         * целевой температуре, то есть подавляет именно те флуктуации, из
         * которых считается C_v. Измерено на этом эксперименте: с
         * Берендсеном C_v выходила РОВНО нулём на всех температурах, и пик
         * перехода не появлялся вовсе. Ошибка не бросается в глаза —
         * кривая U(T) выглядит разумно, — поэтому термостат зафиксирован
         * здесь, а не вынесен в настройки.
         *
         * Ланжевен (трение + случайная сила) канонический ансамбль даёт
         * корректно; проверено тестом «трение и шум сбалансированы».
         */
        thermostat: 'langevin',
        friction: 0.5,
        boundary: 'periodic',
      },
      this.config.seed,
      this.config.lattice,
    );
    this.world.params.temperature = first;
    this.world.applyTemperatureNow();
  }

  /** Мир эксперимента — открыт для интерфейса и тестов. */
  get simulation(): World {
    return this.world;
  }

  /** Готов ли эксперимент. */
  get done(): boolean {
    return this.finished;
  }

  /** Прогресс от 0 до 1. */
  get progress(): number {
    return totalPlannedSteps(this.config) === 0
      ? 1
      : Math.min(1, this.stepsDone() / totalPlannedSteps(this.config));
  }

  /** Сколько шагов уже сделано. */
  private stepsDone(): number {
    const perTemperature = this.config.equilibrate + this.config.sample;
    return this.temperatureIndex * perTemperature + this.stepsAtTemperature;
  }

  /** Текущая температура свипа. */
  get currentTemperature(): number {
    return this.config.temperatures[Math.min(this.temperatureIndex, this.config.temperatures.length - 1)] ?? 1;
  }

  /**
   * Сделать порцию шагов.
   *
   * @param steps максимальное число шагов физики за вызов
   * @returns сколько шагов реально сделано
   */
  advance(steps: number): number {
    if (this.finished) return 0;
    const perTemperature = this.config.equilibrate + this.config.sample;
    let performed = 0;

    while (performed < steps && !this.finished) {
      const temperature = this.currentTemperature;
      // Температура задаётся до шагов: термостат подтянет систему к ней.
      this.world.params.temperature = temperature;

      const inEquilibration = this.stepsAtTemperature < this.config.equilibrate;
      this.world.step();
      this.stepsAtTemperature++;
      performed++;

      if (!inEquilibration) {
        this.stepsSinceSample++;
        if (this.stepsSinceSample >= this.config.sampleEvery) {
          this.stepsSinceSample = 0;
          const energy = this.world.potentialPerParticle;
          this.energySum += energy;
          this.energySqSum += energy * energy;
          this.pressureSum += this.world.measurement.pressure;
          this.temperatureSum += this.world.measurement.temperature;
          this.sampleCount++;
        }
      }

      if (this.stepsAtTemperature >= perTemperature) {
        this.points.push(this.finishTemperature());
        this.temperatureIndex++;
        this.stepsAtTemperature = 0;
        if (this.temperatureIndex >= this.config.temperatures.length) {
          this.finished = true;
        }
      }
    }
    return performed;
  }

  /** Свернуть накопленное по текущей температуре в точку кривой. */
  private finishTemperature(): ExperimentPoint {
    const n = Math.max(1, this.sampleCount);
    const meanEnergy = this.energySum / n;
    // Дисперсия по формуле «среднее квадратов минус квадрат среднего». При
    // малом числе замеров она может выйти чуть отрицательной из-за
    // округления — зажимаем в ноль, иначе C_v окажется отрицательной.
    const variance = Math.max(0, this.energySqSum / n - meanEnergy * meanEnergy);
    const measured = this.temperatureSum / n;
    const particles = Math.max(1, this.world.state.count);
    /*
     * Теплоёмкость на частицу.
     *
     * ─── Здесь была ошибка нормировки ─────────────────────────────────────
     *
     * Накапливается энергия НА ЧАСТИЦУ (u = U/N), а каноническая формула
     * требует дисперсию ПОЛНОЙ энергии:
     *
     *     C_v = ⟨ΔU²⟩ / (k_B T²),   C_v/N = ⟨ΔU²⟩ / (k_B T² N).
     *
     * Дисперсия удельной величины в N² раз меньше: ⟨Δu²⟩ = ⟨ΔU²⟩ / N².
     * Значит из накопленного нужно восстановить полную дисперсию, умножив
     * на N², и только потом делить на N:
     *
     *     C_v/N = ⟨Δu²⟩ · N / (k_B T²).
     *
     * Прежний код делил на N вместо умножения — то есть ошибался в N² раз.
     * Измерено до исправления: C_v выходила ровно нулём при N = 256
     * (величина 0.001 округлялась до нуля), и пик перехода не появлялся.
     */
    const heatCapacity = measured > 1e-9 ? (variance * particles) / (measured * measured) : 0;
    const point: ExperimentPoint = {
      temperature: this.currentTemperature,
      measuredTemperature: measured,
      energy: meanEnergy,
      pressure: this.pressureSum / n,
      heatCapacity,
      samples: this.sampleCount,
    };
    this.energySum = 0;
    this.energySqSum = 0;
    this.pressureSum = 0;
    this.temperatureSum = 0;
    this.sampleCount = 0;
    return point;
  }

  /** Итог. До завершения отдаёт уже посчитанные точки. */
  result(): ExperimentResult {
    const points = [...this.points];
    let peak = 0;
    let peakTemperature = 0;
    for (const point of points) {
      if (point.heatCapacity > peak) {
        peak = point.heatCapacity;
        peakTemperature = point.temperature;
      }
    }
    return {
      branch: this.config.branch,
      density: this.config.density,
      count: this.config.count,
      points,
      transitionTemperature: peakTemperature,
      peakHeatCapacity: peak,
    };
  }
}

/** Полное число шагов, которое потребует конфигурация. */
export function totalPlannedSteps(config: ExperimentConfig): number {
  return config.temperatures.length * (config.equilibrate + config.sample);
}

/**
 * Сравнение ветвей: где нагрев и охлаждение расходятся.
 *
 * Возвращает ширину петли гистерезиса — максимальное расхождение энергии
 * между ветвями в общей для них области температур. Ноль означал бы
 * отсутствие перехода (или его слишком малую скрытую теплоту).
 */
export function hysteresisWidth(
  heating: ExperimentResult,
  cooling: ExperimentResult,
): { maxGap: number; temperature: number } {
  let maxGap = 0;
  let temperature = 0;
  for (const hot of heating.points) {
    // Ищем точку охлаждения с ближайшей температурой.
    let best: ExperimentPoint | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const cold of cooling.points) {
      const distance = Math.abs(cold.temperature - hot.temperature);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = cold;
      }
    }
    // Сравнивать имеет смысл только близкие температуры: иначе разница
    // объясняется самим наклоном кривой, а не гистерезисом.
    if (!best || bestDistance > 0.051) continue;
    const gap = Math.abs(hot.energy - best.energy);
    if (gap > maxGap) {
      maxGap = gap;
      temperature = hot.temperature;
    }
  }
  return { maxGap, temperature };
}

/** Конфигурация эксперимента, парного данному (нагрев ↔ охлаждение). */
export function counterpartConfig(config: ExperimentConfig): ExperimentConfig {
  // Направление меняется на противоположное, и структура берётся под НОВОЕ
  // направление: нагрев начинают с кристалла, охлаждение — со случайного
  // газа (он расплавится на первой же, самой горячей, температуре свипа).
  // Раньше структура выбиралась по старой ветви, и парный эксперимент
  // начинался не с того состояния — петля гистерезиса выходила бессмысленной.
  const nextBranch: ExperimentBranch = config.branch === 'heating' ? 'cooling' : 'heating';
  return {
    ...config,
    branch: nextBranch,
    lattice: nextBranch === 'heating' ? 'fcc' : 'random',
    temperatures: [...config.temperatures],
  };
}

/** Тип мира, который нужен эксперименту (для проверок в тестах). */
export type ExperimentWorldParams = WorldParams;
