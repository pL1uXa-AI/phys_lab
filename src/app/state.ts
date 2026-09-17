/**
 * Состояние приложения.
 *
 * Здесь живёт всё, что не является частью физики: идёт ли симуляция, какая
 * скорость воспроизведения, что выбрано в интерфейсе, какой уровень открыт.
 * Мир (`World`) — отдельный объект, и его класс не знает про эти настройки.
 *
 * Хранилище намеренно простое: набор полей и список подписчиков. Цикл
 * симуляции читает поля напрямую (это горячий путь), а интерфейс подписывается
 * на изменения и перерисовывается.
 */

import type { ColorMode, LatticeKind, ThermostatKind, BoundaryMode } from '../core/types.js';

/** Что показывает сцена. */
export interface ViewState {
  /** Режим раскраски частиц. */
  colorMode: ColorMode;
  /** Показывать ли стенки ящика. */
  showWalls: boolean;
  /** Масштаб частиц (визуальный, на физику не влияет). */
  particleScale: number;
  /** Учитывать ли глубину при отрисовке. */
  depthShading: boolean;
  /**
   * Рисовать ли связи ближних соседей.
   *
   * Включено по умолчанию: без связей кристалл, жидкость и газ на экране
   * почти неотличимы — это и была главная претензия к виду сцены.
   */
  showBonds: boolean;
  /** Радиус связи в единицах σ. */
  bondRadius: number;
  /** Рисовать ли шлейфы траекторий у частиц-«меченых». */
  showTrails: boolean;
  /** Рисовать ли векторы скоростей. */
  showVectors: boolean;
}

/** Состояние приложения. */
export class AppState {
  /** Идёт ли симуляция. */
  running = true;
  /**
   * Сколько шагов физики выполнять за один кадр отрисовки.
   * Один шаг при dt = 0.004 — это «условная фемтосекунда»: для плавной
   * картинки нужно несколько шагов на кадр.
   */
  stepsPerFrame = 8;
  /** Целевая частота кадров: ограничение, чтобы не жечь процессор зря. */
  targetFps = 60;
  /**
   * Подстраивать ли число шагов на кадр автоматически.
   *
   * Нужно для больших систем: на 20 000 частиц восемь шагов на кадр не
   * укладываются в бюджет, и картинка становится дёрганой. Автоподстройка
   * снижает их, пока кадр не станет дешёвым, и повышает обратно, когда
   * система считается быстро. Ползунок продолжает работать: выставленное
   * вручную значение — стартовая точка для подстройки.
   */
  autoSteps = true;

  /** Настройки отрисовки. */
  view: ViewState = {
    colorMode: 'speed',
    showWalls: true,
    particleScale: 1,
    depthShading: true,
    showBonds: true,
    bondRadius: 1.45,
    showTrails: true,
    showVectors: false,
  };

  /** Активный пресет (для подсветки кнопки). */
  presetId: string | null = 'crystal';

  /** Открытый уровень кампании или null в режиме песочницы. */
  levelId: string | null = null;

  /** Инструмент мыши. */
  tool: 'poke' | 'freeze' | 'unfreeze' | 'pan' = 'poke';

  /** Обновлять ли g(r) (дорого при большом числе частиц). */
  sampleRadial = true;

  /**
   * Идёт ли эксперимент с фазовым переходом.
   *
   * В этом режиме обычная симуляция не крутится: время отдано свипу по
   * температуре. Сцена продолжает рисоваться — видно, как кристалл плавится
   * по мере прохождения кривой.
   */
  experimentRunning = false;

  /** Показывать ли подсказки по управлению. */
  showHints = true;

  private listeners = new Set<() => void>();

  /** Подписка на изменения. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Сообщить подписчикам, что состояние изменилось. */
  notify(): void {
    for (const listener of this.listeners) listener();
  }
}

/** Настройки параметров мира, которые меняет интерфейс. */
export interface WorldControls {
  count: number;
  density: number;
  temperature: number;
  thermostat: ThermostatKind;
  boundary: BoundaryMode;
  dt: number;
  lattice: LatticeKind;
}

/** Форматирование чисел для подписей интерфейса. */
export const format = {
  /** Температура и другие безразмерные величины. */
  value(value: number, digits = 3): string {
    if (!Number.isFinite(value)) return '—';
    const abs = Math.abs(value);
    if (abs >= 10000) return value.toExponential(2);
    return value.toFixed(digits);
  },
  /** Целое с разделителями разрядов. */
  int(value: number): string {
    return Math.round(value).toLocaleString('ru-RU');
  },
  /** Время в приведённых единицах. */
  time(value: number): string {
    if (value >= 1000) return `${(value / 1000).toFixed(2)}·10³`;
    return value.toFixed(2);
  },
  /** Энергия: величины большие, нужны разряды. */
  energy(value: number): string {
    if (!Number.isFinite(value)) return '—';
    const abs = Math.abs(value);
    if (abs >= 100000) return (value / 1000).toFixed(1) + 'k';
    return value.toFixed(1);
  },
};
