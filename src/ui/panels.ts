/**
 * Боковые панели управления.
 *
 * Панель — это «свёрнутый» блок с заголовком. Панели не хранят состояние:
 * они получают колбэки и вызывают их. Единственное исключение — элементы
 * управления, чьё отображаемое значение нужно синхронизировать, когда
 * параметр меняется не из интерфейса (пресет, уровень): для них возвращается
 * объект с методом `set`.
 *
 * Почему так: если панель начнёт держать свою копию параметров, рано или
 * поздно она разойдётся с миром — а отлаживать «ползунок показывает одно,
 * а физика считает другое» крайне неприятно.
 */

import { h, rangeControl, toggleControl, checkbox, button, type RangeControl } from './dom.js';
import { BOUNDARIES, LATTICES, PRESETS, THERMOSTATS, type Preset } from '../core/presets.js';
import { COLOR_MODES, legendStops } from '../render/palette.js';
import type { ColorMode, LatticeKind } from '../core/types.js';

/** Обработчики, которые панели вызывают. */
export interface PanelActions {
  setTemperature(value: number): void;
  setDensity(value: number): void;
  setCount(value: number): void;
  setThermostat(value: string): void;
  setBoundary(value: string): void;
  setLattice(value: LatticeKind): void;
  setColorMode(value: ColorMode): void;
  setParticleScale(value: number): void;
  setDepthShading(value: boolean): void;
  setShowWalls(value: boolean): void;
  setStepsPerFrame(value: number): void;
  setSampleRadial(value: boolean): void;
  applyPreset(preset: Preset): void;
  heat(factor: number): void;
  cool(factor: number): void;
  freezeAll(): void;
  unfreezeAll(): void;
  applyTemperatureNow(): void;
  compress(factor: number): void;
  expand(factor: number): void;
  resetWorld(): void;
  resample(): void;
  setTool(tool: string): void;
}

/** Свёртываемая панель. */
export function panel(title: string, body: HTMLElement, options: { collapsed?: boolean; id?: string } = {}): HTMLElement {
  const root = h('section', { class: `panel${options.collapsed ? ' panel--collapsed' : ''}` });
  if (options.id) root.dataset['panel'] = options.id;
  const toggle = h('span', { class: 'panel__toggle' }, options.collapsed ? '▸' : '▾');
  const head = h(
    'header',
    {
      class: 'panel__head',
      on: {
        click: () => {
          const collapsed = root.classList.toggle('panel--collapsed');
          toggle.textContent = collapsed ? '▸' : '▾';
        },
      },
    },
    h('b', {}, title),
    toggle,
  );
  root.append(head, body);
  return root;
}

/** Набор элементов управления, которые нужно синхронизировать снаружи. */
export interface ControlBindings {
  temperature: RangeControl;
  density: RangeControl;
  count: RangeControl;
  stepsPerFrame: RangeControl;
  particleScale: RangeControl;
  colorMode: { set(value: ColorMode): void };
  thermostat: { set(value: string): void };
  boundary: { set(value: string): void };
  lattice: { set(value: LatticeKind): void };
}

/**
 * Панель «Мир»: параметры системы и пресеты.
 */
export function worldPanel(actions: PanelActions, initial: {
  temperature: number;
  density: number;
  count: number;
  thermostat: string;
  boundary: string;
  lattice: LatticeKind;
}): { root: HTMLElement; bindings: Partial<ControlBindings> } {
  const temperature = rangeControl({
    label: 'Температура T*',
    min: 0.05,
    max: 3,
    step: 0.05,
    value: initial.temperature,
    format: (v) => v.toFixed(2),
    onInput: actions.setTemperature,
  });
  const density = rangeControl({
    label: 'Плотность ρ*',
    min: 0.05,
    max: 1.3,
    step: 0.01,
    value: initial.density,
    format: (v) => v.toFixed(2),
    onInput: actions.setDensity,
  });
  const count = rangeControl({
    label: 'Число частиц',
    min: 128,
    max: 20000,
    step: 128,
    value: initial.count,
    format: (v) => Math.round(v).toLocaleString('ru-RU'),
    onInput: actions.setCount,
  });
  const thermostat = toggleControl({
    label: 'Термостат',
    items: THERMOSTATS.map((t) => ({ id: t.id, label: t.label, title: t.note })),
    value: initial.thermostat,
    onChange: actions.setThermostat,
  });
  const boundary = toggleControl({
    label: 'Границы',
    items: BOUNDARIES.map((b) => ({ id: b.id, label: b.label, title: b.note })),
    value: initial.boundary,
    onChange: actions.setBoundary,
  });
  const lattice = toggleControl({
    label: 'Начальная структура',
    items: LATTICES.map((l) => ({ id: l.id, label: l.label })),
    value: initial.lattice,
    onChange: (value) => actions.setLattice(value as LatticeKind),
  });

  const body = h(
    'div',
    { class: 'panel__body' },
    temperature.root,
    density.root,
    count.root,
    thermostat.root,
    boundary.root,
    lattice.root,
    h('div', { class: 'row' }, button('Сбросить', actions.resetWorld)),
    h(
      'p',
      { class: 'hint' },
      'Смена плотности масштабирует ящик на месте; смена структуры и числа частиц пересобирает систему.',
    ),
  );

  return {
    root: panel('Мир', body, { id: 'world' }),
    bindings: { temperature, density, count, thermostat, boundary, lattice },
  };
}

/** Панель «Воздействия»: нагрев, охлаждение, сжатие, заморозка. */
export function actionsPanel(actions: PanelActions): HTMLElement {
  const body = h(
    'div',
    { class: 'panel__body' },
    h(
      'div',
      { class: 'row' },
      button('Нагреть', () => actions.heat(1.4)),
      button('Остудить', () => actions.cool(0.7)),
    ),
    h(
      'div',
      { class: 'row' },
      button('Сжать', () => actions.compress(0.92)),
      button('Расширить', () => actions.expand(1.08)),
    ),
    h(
      'div',
      { class: 'row' },
      button('Задать T точно', actions.applyTemperatureNow),
      button('Остановить', actions.freezeAll),
    ),
    h(
      'div',
      { class: 'row' },
      button('Разморозить', actions.unfreezeAll),
      button('Пересобрать', actions.resample),
    ),
    h(
      'p',
      { class: 'hint' },
      '«Нагреть» и «Остудить» умножают скорости; термостат затем вернёт заданную T*. ' +
        '«Сжать» и «Расширить» деформируют ящик вместе с координатами.',
    ),
  );
  return panel('Воздействия', body, { id: 'actions' });
}

/** Панель пресетов. */
export function presetsPanel(
  actions: PanelActions,
  onHighlight: (id: string) => void,
): { root: HTMLElement; highlight: (id: string | null) => void } {
  const list = h('div', { class: 'preset-list' });
  const buttons = new Map<string, HTMLButtonElement>();
  for (const preset of PRESETS) {
    const btn = h(
      'button',
      {
        class: 'preset',
        type: 'button',
        on: {
          click: () => {
            actions.applyPreset(preset);
            highlight(preset.id);
          },
        },
      },
      h('div', { class: 'preset__title' }, preset.title),
      h('div', { class: 'preset__hint' }, preset.hint),
    );
    buttons.set(preset.id, btn);
    list.append(btn);
  }
  function highlight(id: string | null): void {
    for (const [key, btn] of buttons) btn.classList.toggle('preset--on', key === id);
  }
  onHighlight('crystal');
  highlight('crystal');
  const body = h(
    'div',
    { class: 'panel__body' },
    list,
    h('p', { class: 'hint' }, 'Пресет задаёт все параметры сразу и запускает короткий отжиг.'),
  );
  return { root: panel('Пресеты', body, { id: 'presets' }), highlight };
}

/** Панель «Вид»: раскраска, масштаб, подсказки. */
export function viewPanel(actions: PanelActions, initial: {
  colorMode: ColorMode;
  particleScale: number;
  depthShading: boolean;
  showWalls: boolean;
  stepsPerFrame: number;
  sampleRadial: boolean;
}): { root: HTMLElement; legend: HTMLElement; bindings: Partial<ControlBindings> } {
  const legendRamp = h('div', { class: 'legend__ramp' });
  const legend = h(
    'div',
    { class: 'legend' },
    h('span', {}, 'мин'),
    legendRamp,
    h('span', {}, 'макс'),
  );

  function updateLegend(mode: string): void {
    const stops = legendStops(mode, 5);
    legendRamp.style.background = `linear-gradient(90deg, ${stops.join(', ')})`;
  }

  const colorMode = toggleControl({
    label: 'Раскраска',
    items: COLOR_MODES.map((m) => ({ id: m.id, label: m.label })),
    value: initial.colorMode,
    onChange: (value) => {
      updateLegend(value);
      actions.setColorMode(value as ColorMode);
    },
  });
  updateLegend(initial.colorMode);

  const particleScale = rangeControl({
    label: 'Размер частиц',
    min: 0.4,
    max: 2.5,
    step: 0.1,
    value: initial.particleScale,
    format: (v) => `${v.toFixed(1)}×`,
    onInput: actions.setParticleScale,
  });
  const stepsPerFrame = rangeControl({
    label: 'Шагов за кадр',
    min: 1,
    max: 40,
    step: 1,
    value: initial.stepsPerFrame,
    format: (v) => String(Math.round(v)),
    onInput: actions.setStepsPerFrame,
  });

  const body = h(
    'div',
    { class: 'panel__body' },
    colorMode.root,
    legend,
    particleScale.root,
    stepsPerFrame.root,
    checkbox({ label: 'Тени глубины', checked: initial.depthShading, onChange: actions.setDepthShading }),
    checkbox({ label: 'Стенки ящика', checked: initial.showWalls, onChange: actions.setShowWalls }),
    checkbox({ label: 'Считать g(r)', checked: initial.sampleRadial, onChange: actions.setSampleRadial }),
    h(
      'p',
      { class: 'hint' },
      'Мышь: тянуть — толкать частицы, колесо — масштаб, правая кнопка — поворот, ' +
        'Shift+колесо — сдвиг камеры.',
    ),
  );

  return {
    root: panel('Вид', body, { id: 'view' }),
    legend,
    bindings: { colorMode, particleScale, stepsPerFrame },
  };
}

/** Блок задач уровня (используется панелью кампании). */
export function taskList(items: Array<{ label: string; done: boolean; detail: string }>): HTMLElement {
  const list = h('ul', { class: 'level-card__tasks' });
  for (const item of items) {
    list.append(
      h(
        'li',
        { class: item.done ? 'level-card__task--done' : '', title: item.detail },
        `${item.done ? '✓' : '•'} ${item.label}`,
      ),
    );
  }
  return list;
}
