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
  setShowBonds(value: boolean): void;
  setBondRadius(value: number): void;
  setShowTrails(value: boolean): void;
  setShowVectors(value: boolean): void;
  setStepsPerFrame(value: number): void;
  setSampleRadial(value: boolean): void;
  setAutoSteps(value: boolean): void;
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
  /** Сохранить состояние мира в файл. */
  saveState(): void;
  /** Загрузить состояние мира из файла. */
  loadState(): void;
  /** Выгрузить историю измерений в CSV. */
  exportHistory(): void;
  /** Выгрузить g(r) в CSV. */
  exportRadial(): void;
  /** Выгрузить S(k) в CSV. */
  exportStructure(): void;
  /** Сохранить график в PNG. */
  exportPlot(which: 'temperature' | 'energy' | 'radial'): void;
  /** Начать или остановить эксперимент с фазовым переходом. */
  toggleExperiment(): void;
  /** Переключить ветвь эксперимента (нагрев или охлаждение). */
  setExperimentBranch(branch: 'heating' | 'cooling'): void;
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
    // «(цель)» — не украшение. Ползунок задаёт ЦЕЛЕВУЮ температуру термостата,
    // а не мгновенную: при выключенном термостате они вообще не связаны, а при
    // включённом сходятся только после выхода на режим. Без этого уточнения
    // ползунок читается как «показание», и возникает законный вопрос, почему
    // он не совпадает с T* в сводке.
    label: 'Целевая температура T*',
    min: 0.05,
    max: 3,
    step: 0.05,
    value: initial.temperature,
    format: (v) => v.toFixed(2),
    onInput: actions.setTemperature,
  });
  const density = rangeControl({
    // Плотность — параметр системы, а не мгновенное измерение: ρ* = N/V
    // задаётся ящиком и совпадает с фактической точно (это проверяется тестом).
    label: 'Плотность ρ*',
    min: 0.05,
    max: 1.3,
    step: 0.01,
    value: initial.density,
    format: (v) => v.toFixed(2),
    onInput: actions.setDensity,
  });
  const count = rangeControl({
    // ГЦК-решётка округляет число до 4n³, поэтому фактическое число частиц
    // может отличаться от положения ползунка — фактическое видно в сводке.
    label: 'Число частиц (до 4n³)',
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
  showBonds: boolean;
  bondRadius: number;
  showTrails: boolean;
  showVectors: boolean;
  stepsPerFrame: number;
  sampleRadial: boolean;
  autoSteps: boolean;
}): { root: HTMLElement; legend: HTMLElement; bindings: Partial<ControlBindings> } {
  const legendRamp = h('div', { class: 'legend__ramp' });
  const legendMin = h('span', { class: 'legend__bound', dataset: { legend: 'min' } }, '—');
  const legendMax = h('span', { class: 'legend__bound', dataset: { legend: 'max' } }, '—');
  const legend = h('div', { class: 'legend' }, legendMin, legendRamp, legendMax);

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
  const bondRadius = rangeControl({
    label: 'Радиус связи, σ',
    min: 1.15,
    max: 2.2,
    step: 0.05,
    value: initial.bondRadius,
    format: (v) => v.toFixed(2),
    onInput: actions.setBondRadius,
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
    checkbox({
      label: 'Связи ближних соседей',
      checked: initial.showBonds,
      onChange: actions.setShowBonds,
    }),
    bondRadius.root,
    checkbox({ label: 'Шлейфы траекторий', checked: initial.showTrails, onChange: actions.setShowTrails }),
    checkbox({ label: 'Векторы скоростей', checked: initial.showVectors, onChange: actions.setShowVectors }),
    stepsPerFrame.root,
    checkbox({
      label: 'Подстраивать шаги автоматически',
      checked: initial.autoSteps,
      onChange: actions.setAutoSteps,
    }),
    checkbox({ label: 'Тени глубины', checked: initial.depthShading, onChange: actions.setDepthShading }),
    checkbox({ label: 'Стенки ящика', checked: initial.showWalls, onChange: actions.setShowWalls }),
    checkbox({ label: 'Считать g(r)', checked: initial.sampleRadial, onChange: actions.setSampleRadial }),
    h(
      'p',
      { class: 'hint' },
      '«Связи» соединяют атомы, стоящие ближе выбранного радиуса: у кристалла ' +
        'выходит правильная решётка (12 связей на атом), у жидкости — рвущаяся сетка, ' +
        'у газа линий почти нет. Это самый быстрый способ увидеть разницу фаз.',
    ),
    h(
      'p',
      { class: 'hint' },
      'Цвет — это величина из раскраски (легенда показывает её диапазон на шкале от ' +
        'минимума к максимуму). «Скорость»: синие частицы медленные, красные быстрые. ' +
        '«Плотность»: тусклые — мало соседей, оранжевые — много. ' +
        '«Смещение»: тёмные сидят на месте, светлые уехали далеко.',
    ),
    h(
      'p',
      { class: 'hint' },
      'Мышь: тянуть — толкать частицы (кисть бьёт цилиндром вдоль луча зрения, ' +
        'поэтому задевает частицы на любой глубине), колесо — масштаб, ' +
        'правая кнопка — поворот, Shift+тянуть — сдвиг камеры.',
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

/**
 * Панель «Данные»: сохранение состояния и выгрузка результатов.
 *
 * Почему отдельная панель, а не кнопки в «Воздействиях»: это не воздействие
 * на мир, а работа с ним как с данными. Смешивать «нагреть» и «сохранить в
 * файл» в одном блоке — верный способ запутать.
 *
 * Загрузка сделана через скрытый `<input type="file">`: браузер не даёт
 * открыть диалог выбора файла иначе, как по действию пользователя, поэтому
 * кнопка «Загрузить» программно кликает по этому полю.
 */
export function dataPanel(actions: PanelActions): HTMLElement {
  const fileInput = h('input', {
    type: 'file',
    accept: '.json,application/json',
    style: 'display: none',
    dataset: { role: 'load-state' },
  });

  const body = h(
    'div',
    { class: 'panel__body' },
    h(
      'div',
      { class: 'row' },
      button('Сохранить JSON', actions.saveState),
      button('Загрузить JSON', () => {
        actions.loadState();
      }),
    ),
    h(
      'div',
      { class: 'row' },
      button('История → CSV', actions.exportHistory),
      button('g(r) → CSV', actions.exportRadial),
    ),
    h(
      'div',
      { class: 'row' },
      button('S(k) → CSV', actions.exportStructure),
    ),
    h(
      'p',
      { class: 'hint' },
      'Сохранённый JSON восстанавливает состояние точно: продолжение даёт ту же ' +
        'траекторию, включая случайные числа термостата. Экспорт CSV открывается ' +
        'в Excel (разделитель — точка с запятой, кодировка UTF-8 с BOM).',
    ),
    fileInput,
  );
  void actions.exportPlot;
  return panel('Данные', body, { id: 'data', collapsed: true });
}

/**
 * Панель «Эксперимент»: свип по температуре.
 *
 * Отдельная панель, а не кнопка в «Воздействиях», потому что это другой
 * режим работы приложения: обычная симуляция останавливается, и управление
 * на время переходит к свипу. Смешивать «нагреть» и «запустить часовой
 * расчёт» в одном блоке — верный способ запутать.
 */
export function experimentPanel(
  actions: PanelActions,
  onProgress: (update: (progress: number, phase: string) => void) => void,
): { root: HTMLElement; setProgress: (progress: number, phase: string) => void } {
  const progressBar = h('div', { class: 'progress__fill' });
  const progressText = h('span', { class: 'progress__text' }, 'не запущен');
  const progress = h('div', { class: 'progress' }, progressBar, progressText);

  const toggle = button('Запустить свип', () => actions.toggleExperiment());
  toggle.dataset['action'] = 'experiment-toggle';
  const heating = button('Нагрев', () => actions.setExperimentBranch('heating'));
  heating.dataset['branch'] = 'heating';
  heating.classList.add('btn--on');
  const cooling = button('Охлаждение', () => actions.setExperimentBranch('cooling'));
  cooling.dataset['branch'] = 'cooling';

  const setProgress = (value: number, phase: string): void => {
    const clamped = Math.max(0, Math.min(1, value));
    progressBar.style.width = `${(clamped * 100).toFixed(1)}%`;
    progressText.textContent = phase;
    void onProgress;
  };

  const body = h(
    'div',
    { class: 'panel__body' },
    h('div', { class: 'row' }, heating, cooling),
    h('div', { class: 'row' }, toggle),
    progress,
    h(
      'p',
      { class: 'hint' },
      'Свип проводит систему по набору температур при постоянной плотности и ' +
        'строит энергию и теплоёмкость. Жёлтая кривая — энергия, зелёная — C_v: ' +
        'её пик и отмечает переход. Нагрев идут от кристалла, охлаждение — от ' +
        'жидкости; там, где кривые расходятся, лежит петля гистерезиса.',
    ),
    h(
      'p',
      { class: 'hint' },
      'Важно: однородный кристалл ПЕРЕГРЕВАЕТСЯ — плавление начинается с ' +
        'зародыша, которого внутри идеальной решётки нет. Поэтому скачок энергии ' +
        'виден при T* ≈ 1.2, хотя равновесная температура плавления ≈ 0.7.',
    ),
  );
  return { root: panel('Эксперимент', body, { id: 'experiment', collapsed: true }), setProgress };
}
