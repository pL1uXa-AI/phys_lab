/**
 * Приложение: склейка ядра, рендера и интерфейса.
 *
 * Здесь живёт цикл: шаги физики, раз в несколько шагов — кадр статистики,
 * раз в кадр — отрисовка и обновление панелей. Приложение ничего не считает
 * само: физика в `core/`, отрисовка в `render/`, панели в `ui/`.
 *
 * Наружу выставляется объект `window.__physLab` — точка входа для сквозных
 * проверок в реальном браузере (smoke/showcase). Это тот же приём, что и в
 * logic_lab: юнит-тесты проверяют ядро, но не проверяют, что приложение
 * действительно запускается, рисует сцену и реагирует на действия игрока.
 */

import { Application } from 'pixi.js';
import { World } from '../core/world.js';
import { PRESETS, type Preset } from '../core/presets.js';
import {
  boxLength,
  DEFAULT_PARAMS,
  type ColorMode,
  type LatticeKind,
  type WorldParams,
} from '../core/types.js';
import { SceneRenderer } from '../render/scene.js';
import { drawPlot, drawRadial, PLOT_COLORS } from '../render/plots.js';
import { InputController } from '../input/controller.js';
import { AppState, format } from './state.js';
import { h, need, setContent } from '../ui/dom.js';
import { actionsPanel, presetsPanel, viewPanel, worldPanel, type PanelActions } from '../ui/panels.js';
import { CampaignPanel, openHelp } from '../ui/campaign.js';
import { LevelSession } from '../levels/session.js';
import { LEVELS, levelNumber, type Level } from '../levels/levels.js';
import type { LevelReport } from '../levels/checks.js';

/**
 * Сколько шагов между кадрами статистики g(r).
 *
 * Значение — база; при большом числе частиц приложение увеличивает интервал
 * автоматически, чтобы один кадр статистики не съедал бюджет времени.
 */
const RADIAL_INTERVAL = 40;

/** Сколько шагов между перестройкой ползунков из мира. */
const UI_SYNC_INTERVAL = 30;

/**
 * Приложение целиком.
 */
export class App {
  readonly state = new AppState();
  world: World;
  renderer!: SceneRenderer;
  input!: InputController;
  session: LevelSession | null = null;

  private readonly host: HTMLElement;
  private app: Application;
  private lastFrame = 0;
  private frameCounter = 0;
  private radialCounter = 0;
  private uiCounter = 0;
  private paused = false;
  private drawMs = 0;
  private physicsMs = 0;
  private lastAutoTune = 0;

  /** Ссылки на панели и их управляющие элементы для синхронизации. */
  private bindings: Partial<ReturnType<typeof worldPanel>['bindings']> = {};
  private campaign!: CampaignPanel;
  private stage!: HTMLElement;
  private hud!: HTMLElement;
  private plotT!: HTMLCanvasElement;
  private plotE!: HTMLCanvasElement;
  private plotR!: HTMLCanvasElement;
  private presetHighlight: (id: string | null) => void = () => {};

  constructor(host: HTMLElement, app: Application) {
    this.host = host;
    this.app = app;
    this.world = new World({ ...DEFAULT_PARAMS }, 20260214, 'fcc');
    this.world.params.thermostat = 'berendsen';
  }

  /** Полная инициализация: сцена, интерфейс, цикл. */
  async init(): Promise<void> {
    this.buildLayout();
    this.renderer = new SceneRenderer(this.app);
    // Канвас Pixi вставляется в сцену явно: сама библиотека его не монтирует.
    this.renderer.init(this.stage);
    this.resize();
    this.renderer.options.colorMode = this.state.view.colorMode;

    this.input = new InputController(this.stage, this.renderer, this.world, {
      onPoke: (x, y, dx, dy) => this.poke(x, y, dx, dy),
      onFreeze: (x, y) => this.freezeAt(x, y),
      onUnfreeze: (x, y) => this.unfreezeAt(x, y),
      onToggleRun: () => this.toggleRun(),
      onReset: () => this.resetWorld(),
      onStep: () => this.stepOnce(),
      onHelp: () => openHelp(),
    });

    window.addEventListener('resize', () => this.resize());
    this.applyPreset(PRESETS[0], { silent: true });
    this.loop();
  }

  /* ------------------------------------------------------------------ */
  /* Разметка                                                            */
  /* ------------------------------------------------------------------ */

  private buildLayout(): void {
    const sidebar = h('aside', { class: 'sidebar', dataset: { panel: 'sidebar' } });
    const stage = h('div', { class: 'stage', dataset: { stage: 'true' } });
    const plots = h('div', { class: 'plots', dataset: { panel: 'plots' } });
    this.stage = stage;
    this.hud = h('div', { class: 'stage__hud' });
    stage.append(this.hud);
    stage.append(
      h(
        'div',
        { class: 'stage__hint' },
        'тянуть — толкать · колесо — масштаб · правая кнопка — поворот · Shift — сдвиг',
      ),
    );

    this.plotT = h('canvas', {});
    this.plotE = h('canvas', {});
    this.plotR = h('canvas', {});
    plots.append(
      h('div', { class: 'plot' }, this.plotT),
      h('div', { class: 'plot' }, this.plotE),
      h('div', { class: 'plot' }, this.plotR),
    );

    const topbar = this.buildTopbar();
    const layout = h('div', { class: 'layout' }, sidebar, stage, plots);
    this.host.append(topbar, layout);

    // Панели.
    const actions = this.panelActions();
    const worldPanelResult = worldPanel(actions, {
      temperature: this.world.params.temperature,
      density: this.world.params.density,
      count: this.world.state.count,
      thermostat: this.world.params.thermostat,
      boundary: this.world.params.boundary,
      lattice: 'fcc',
    });
    const viewPanelResult = viewPanel(actions, {
      colorMode: this.state.view.colorMode,
      particleScale: this.state.view.particleScale,
      depthShading: this.state.view.depthShading,
      showWalls: this.state.view.showWalls,
      stepsPerFrame: this.state.stepsPerFrame,
      sampleRadial: this.state.sampleRadial,
    });
    const presets = presetsPanel(actions, (id) => {
      this.state.presetId = id;
    });
    this.presetHighlight = presets.highlight;
    this.campaign = new CampaignPanel({
      startLevel: (level) => this.startLevel(level),
      checkLevel: () => this.checkLevel(),
      exitToSandbox: () => this.exitToSandbox(),
    });

    sidebar.append(
      worldPanelResult.root,
      actionsPanel(actions),
      presets.root,
      viewPanelResult.root,
      this.campaign.root,
    );
    this.bindings = { ...worldPanelResult.bindings, ...viewPanelResult.bindings };

    // Кнопки выбора инструмента — добавлены к панели «Воздействия».
    const toolRow = h('div', { class: 'row' });
    for (const [id, label] of [
      ['poke', 'Толкать'],
      ['freeze', 'Заморозить'],
      ['unfreeze', 'Разморозить'],
    ] as const) {
      const btn = h(
        'button',
        {
          class: `btn btn--small${id === 'poke' ? ' btn--on' : ''}`,
          type: 'button',
          dataset: { tool: id },
          on: {
            click: () => {
              this.input.tool = id;
              for (const other of toolRow.querySelectorAll('button')) {
                other.classList.toggle('btn--on', other === btn);
              }
            },
          },
        },
        label,
      );
      toolRow.append(btn);
    }
    const actionsBody = need('[data-panel="actions"] .panel__body', sidebar);
    actionsBody.append(h('span', { class: 'field__label' }, 'Инструмент'), toolRow);
  }

  private buildTopbar(): HTMLElement {
    const runBtn = h(
      'button',
      {
        class: 'btn btn--primary',
        type: 'button',
        dataset: { action: 'run' },
        on: { click: () => this.toggleRun() },
      },
      'Пауза',
    );
    const fpsField = h('span', { class: 'topbar__field', dataset: { field: 'fps' } }, '— FPS');
    const statsField = h('span', { class: 'topbar__field', dataset: { field: 'stats' } }, '');

    return h(
      'header',
      { class: 'topbar', dataset: { panel: 'topbar' } },
      h('div', { class: 'topbar__brand' }, 'Phys', h('span', {}, 'Lab'), ' — молекулярная динамика'),
      h(
        'div',
        { class: 'topbar__group' },
        runBtn,
        h(
          'button',
          {
            class: 'btn',
            type: 'button',
            dataset: { action: 'step' },
            on: { click: () => this.stepOnce() },
          },
          'Шаг',
        ),
        h(
          'button',
          {
            class: 'btn',
            type: 'button',
            dataset: { action: 'reset' },
            on: { click: () => this.resetWorld() },
          },
          'Сброс',
        ),
      ),
      h(
        'div',
        { class: 'topbar__group topbar__group--right' },
        statsField,
        fpsField,
        h(
          'button',
          {
            class: 'btn btn--ghost',
            type: 'button',
            dataset: { action: 'help' },
            on: { click: () => openHelp() },
          },
          'Справка',
        ),
      ),
    );
  }

  /** Действия для панелей. */
  private panelActions(): PanelActions {
    return {
      setTemperature: (value) => {
        this.world.params.temperature = value;
        this.notifyWorldChanged();
      },
      setDensity: (value) => {
        this.world.setDensity(value);
        this.notifyWorldChanged();
      },
      setCount: (value) => {
        this.world.resize(Math.round(value), this.world.params.density);
        this.afterRebuild();
      },
      setThermostat: (value) => {
        this.world.params.thermostat = value as WorldParams['thermostat'];
        this.notifyWorldChanged();
      },
      setBoundary: (value) => {
        this.world.params.boundary = value as WorldParams['boundary'];
        this.notifyWorldChanged();
      },
      setLattice: (value) => {
        this.world.requestRebuild(value as LatticeKind, true);
        this.notifyWorldChanged();
      },
      setColorMode: (value) => {
        this.state.view.colorMode = value as ColorMode;
        this.renderer.options.colorMode = value;
      },
      setParticleScale: (value) => {
        this.state.view.particleScale = value;
        this.renderer.options.particleScale = value;
      },
      setDepthShading: (value) => {
        this.state.view.depthShading = value;
        this.renderer.options.depthShading = value;
      },
      setShowWalls: (value) => {
        this.state.view.showWalls = value;
        this.renderer.options.showWalls = value;
      },
      setStepsPerFrame: (value) => {
        this.state.stepsPerFrame = Math.round(value);
      },
      setSampleRadial: (value) => {
        this.state.sampleRadial = value;
      },
      applyPreset: (preset) => this.applyPreset(preset),
      heat: (factor) => this.world.scaleVelocities(factor),
      cool: (factor) => this.world.scaleVelocities(factor),
      freezeAll: () => this.world.freezeAll(),
      unfreezeAll: () => this.world.unfreezeAll(),
      applyTemperatureNow: () => this.world.applyTemperatureNow(),
      compress: (factor) => {
        const density = this.world.params.density / factor ** 3;
        this.world.setDensity(density);
        this.syncControls();
      },
      expand: (factor) => {
        const density = this.world.params.density / factor ** 3;
        this.world.setDensity(density);
        this.syncControls();
      },
      resetWorld: () => this.resetWorld(),
      resample: () => this.resample(),
      setTool: (tool) => {
        this.input.tool = tool as 'poke';
      },
    };
  }

  /* ------------------------------------------------------------------ */
  /* Управление                                                          */
  /* ------------------------------------------------------------------ */

  private notifyWorldChanged(): void {
    this.state.notify();
  }

  private afterRebuild(): void {
    this.renderer.camera.fit(this.world.box, this.app.renderer.width, this.app.renderer.height);
    this.syncControls();
    this.state.notify();
  }

  /** Применение пресета: параметры, решётка, короткий отжиг. */
  applyPreset(preset: Preset, options: { silent?: boolean } = {}): void {
    this.world.params = {
      ...DEFAULT_PARAMS,
      count: preset.count,
      density: preset.density,
      cutoff: preset.cutoff,
      dt: preset.dt,
      temperature: preset.temperature,
      boundary: preset.boundary,
      thermostat: preset.thermostat,
      thermostatTau: preset.thermostatTau,
      friction: preset.friction,
    };
    this.world.resize(preset.count, preset.density, preset.lattice);
    // Отжиг: прогоняем систему до равновесия, чтобы картинка соответствовала
    // описанию пресета сразу, а не через минуту ручной работы.
    if (preset.equilibrate > 0) this.world.run(preset.equilibrate);

    this.state.presetId = preset.id;
    if (!options.silent) this.presetHighlight(preset.id);
    this.session = null;
    this.state.levelId = null;
    this.campaign.showSandbox();
    this.paused = false;
    this.afterRebuild();
  }

  /** Пересборка текущей конфигурации с нуля. */
  private resample(): void {
    this.world.rebuild('fcc', true);
    this.afterRebuild();
  }

  private resetWorld(): void {
    this.world.resize(this.world.state.count, this.world.params.density, 'fcc');
    this.world.params.temperature = this.world.params.temperature;
    this.afterRebuild();
  }

  private toggleRun(): void {
    this.paused = !this.paused;
    this.state.running = !this.paused;
    const btn = need<HTMLButtonElement>('[data-action="run"]', this.host);
    btn.textContent = this.paused ? 'Пуск' : 'Пауза';
    btn.classList.toggle('btn--primary', !this.paused);
  }

  private stepOnce(): void {
    this.world.step();
    this.sampleIfDue(true);
    this.updateHud();
  }

  private poke(screenX: number, screenY: number, dx: number, dy: number): void {
    // Экранные координаты переводятся в координаты проекции, а толчок
    // задаётся по всем трём осям: основной импульс — по направлению протяжки.
    const scale = this.renderer.camera.scale;
    if (scale <= 0) return;
    const worldDx = (dx / scale) * this.input.pokeStrength;
    const worldDy = (dy / scale) * this.input.pokeStrength;
    const [x, y, z] = this.unproject(screenX, screenY);

    this.world.pokeNow({
      x,
      y,
      z,
      dx: worldDx,
      dy: worldDy,
      dz: 0,
      radius: this.input.brushRadius,
      strength: 1,
    });
  }

  /**
   * Обратная проекция точки плоскости экрана в мир.
   *
   * Проекция была: поворот на yaw вокруг Y, затем наклон на pitch, затем
   * отбрасывание z. Обратно восстанавливаем точку с z = 0, что даёт
   * «плоскость экрана», проходящую через центр ящика. Этого достаточно:
   * сфера захвата всё равно объёмная, и частицы за плоскостью тоже получат
   * импульс.
   */
  private unproject(px: number, py: number): [number, number, number] {
    const center = this.world.box * 0.5;
    const cosP = Math.cos(this.renderer.camera.pitch);
    const sinP = Math.sin(this.renderer.camera.pitch);
    const cosY = Math.cos(this.renderer.camera.yaw);
    const sinY = Math.sin(this.renderer.camera.yaw);
    // Обратные преобразования: сначала «снимаем» наклон, затем поворот.
    const rz = -py / (sinP || 1e-6);
    const rx = px;
    const ry = py + rz * sinP;
    const ax = rx * cosY + rz * sinY;
    const az = -rx * sinY + rz * cosY;
    void cosP;
    return [ax + center, ry + center, az + center];
  }

  private freezeAt(px: number, py: number): void {
    const [x, y, z] = this.unproject(px, py);
    this.world.freezeRegion(x, y, z, this.input.brushRadius);
  }

  private unfreezeAt(_px: number, _py: number): void {
    this.world.unfreezeAll();
  }

  /* ------------------------------------------------------------------ */
  /* Уровни                                                              */
  /* ------------------------------------------------------------------ */

  /** Запуск уровня. */
  startLevel(level: Level): void {
    const setup = level.setup;
    this.world.params = {
      ...DEFAULT_PARAMS,
      ...setup,
      count: setup.count ?? DEFAULT_PARAMS.count,
      density: setup.density ?? DEFAULT_PARAMS.density,
      cutoff: setup.cutoff ?? DEFAULT_PARAMS.cutoff,
      dt: setup.dt ?? DEFAULT_PARAMS.dt,
      temperature: setup.temperature ?? DEFAULT_PARAMS.temperature,
      thermostat: setup.thermostat,
      thermostatTau: setup.thermostatTau ?? DEFAULT_PARAMS.thermostatTau,
      friction: setup.friction ?? DEFAULT_PARAMS.friction,
      boundary: setup.boundary,
    };
    this.world.resize(this.world.params.count, this.world.params.density, setup.lattice);
    this.state.levelId = level.id;
    this.state.presetId = null;
    this.presetHighlight(null);
    this.session = new LevelSession(level, this.world);
    this.paused = false;
    this.state.running = true;
    const btn = need<HTMLButtonElement>('[data-action="run"]', this.host);
    btn.textContent = 'Пауза';
    this.afterRebuild();
    this.campaign.showLevel(level, this.session.lastReport, this.session.progress);
    document.body.dataset['level'] = level.id;
  }

  private exitToSandbox(): void {
    this.session = null;
    this.state.levelId = null;
    delete document.body.dataset['level'];
    this.campaign.showSandbox();
  }

  /** Немедленная проверка уровня (кнопка «Проверить»). */
  checkLevel(): LevelReport | null {
    if (!this.session) return null;
    const report = this.session.checkNow(this.world);
    this.campaign.showLevel(this.session.level, report, this.session.progress);
    if (report.passed) {
      this.campaign.markCompleted(this.session.level.id);
      document.body.dataset['levelPassed'] = this.session.level.id;
    }
    return report;
  }

  /* ------------------------------------------------------------------ */
  /* Цикл                                                                */
  /* ------------------------------------------------------------------ */

  private loop = (): void => {
    const frameStart = performance.now();
    const target = 1000 / Math.max(1, this.state.targetFps);
    const elapsed = frameStart - this.lastFrame;

    if (!this.paused && elapsed >= target * 0.6) {
      this.lastFrame = frameStart;
      const steps = Math.max(1, this.state.stepsPerFrame);
      const physicsStart = performance.now();
      for (let i = 0; i < steps; i++) {
        this.world.step();
        this.tickSession();
        this.sampleIfDue(false);
      }
      this.physicsMs = performance.now() - physicsStart;
      this.frameCounter++;
    }

    const drawn = this.renderer.render(this.world, this.input.brush.active ? this.input.brush : null);
    this.drawMs = drawn.frameMs;

    this.uiCounter++;
    if (this.uiCounter >= UI_SYNC_INTERVAL) {
      this.uiCounter = 0;
      this.updateHud();
      this.drawPlots();
    }
    this.updateFps(frameStart);
    this.autoTuneSteps();

    this.app.render();
    requestAnimationFrame(this.loop);
  };

  private tickSession(): void {
    if (!this.session) return;
    const report = this.session.tick(this.world);
    if (report && this.uiCounter % 4 === 0) {
      this.campaign.showLevel(this.session.level, report, this.session.progress);
      if (report.passed) {
        this.campaign.markCompleted(this.session.level.id);
        document.body.dataset['levelPassed'] = this.session.level.id;
      }
    }
  }

  /** Кадр статистики g(r) — дорого, поэтому не каждый шаг. */
  private sampleIfDue(force: boolean): void {
    if (!this.state.sampleRadial && !force) return;
    this.radialCounter++;
    if (force || this.radialCounter >= this.radialEvery) {
      this.radialCounter = 0;
      this.world.sampleRadial();
    }
  }

  /**
   * Сколько шагов между кадрами статистики g(r) — подстраивается под размер.
   *
   * Один кадр статистики стоит примерно как 6 шагов физики при 2000 частицах
   * и как 2 шага при 20000 (гистограмма линейна по N, а шаг — тоже, но
   * с большей константой). Держать интервал постоянным нельзя: на больших
   * системах g(r) успевал бы съесть весь бюджет кадра. Поэтому интервал
   * растёт пропорционально числу частиц — статистика набирается медленнее,
   * но плавность не страдает.
   */
  private get radialEvery(): number {
    const count = this.world.state.count;
    if (count <= 4000) return RADIAL_INTERVAL;
    return Math.min(240, Math.round(RADIAL_INTERVAL * (count / 4000)));
  }

  /**
   * Автоматическая подстройка числа шагов на кадр.
   *
   * Цель — уложить физику в бюджет кадра (по умолчанию ~10 мс, то есть
   * 100 кадров в секунду расчёта). Если шаги стали дороже, их станет меньше;
   * если система «остыла» и считается быстрее — больше. Игроку не нужно
   * крутить ползунок, чтобы получить плавную картинку на 20000 частиц.
   *
   * Реакция намеренно медленная (по одному шагу за замер, не чаще раза
   * в 30 кадров): иначе автоколебания вокруг целевого времени.
   */
  private autoTuneSteps(): void {
    if (!this.state.autoSteps) return;
    const budget = 10;
    const perStep = this.physicsMs / Math.max(1, this.state.stepsPerFrame);
    if (perStep <= 0 || !Number.isFinite(perStep)) return;
    const frameStart = performance.now();
    if (frameStart - this.lastAutoTune < 500) return;
    this.lastAutoTune = frameStart;

    const ideal = Math.max(1, Math.min(40, Math.floor(budget / perStep)));
    if (ideal > this.state.stepsPerFrame && this.physicsMs < budget * 0.7) {
      this.state.stepsPerFrame++;
      this.bindings.stepsPerFrame?.set(this.state.stepsPerFrame);
    } else if (ideal < this.state.stepsPerFrame && this.physicsMs > budget) {
      this.state.stepsPerFrame = Math.max(1, this.state.stepsPerFrame - 1);
      this.bindings.stepsPerFrame?.set(this.state.stepsPerFrame);
    }
  }

  private updateFps(frameStart: number): void {
    const field = this.host.querySelector('[data-field="fps"]');
    if (!field) return;
    const total = this.physicsMs + this.drawMs;
    field.textContent = `${(1000 / Math.max(1, total)).toFixed(0)} расч/с · шаг ${this.world.steps}`;
    void frameStart;
  }

  private updateHud(): void {
    const m = this.world.measurement;
    const rows: Array<[string, string]> = [
      ['частиц', format.int(m.count)],
      ['T*', format.value(m.temperature)],
      ['ρ*', format.value(this.world.params.density)],
      ['E кин', format.energy(m.kinetic)],
      ['E пот', format.energy(this.world.potentialEnergy)],
      ['E полн', format.energy(m.total)],
      ['P*', format.value(m.pressure, 2)],
      ['пик g(r)', format.value(this.world.orderPeak, 2)],
      ['время τ', format.time(this.world.time)],
      ['пар', format.int(this.world.pairCount)],
    ];
    setContent(
      this.hud,
      ...rows.flatMap(([label, value]) => [
        document.createTextNode(`${label}: `),
        h('b', {}, value),
        document.createElement('br'),
      ]),
    );

    const statsField = this.host.querySelector('[data-field="stats"]');
    if (statsField) {
      statsField.textContent =
        `T* = ${format.value(m.temperature)}  ·  E = ${format.energy(m.total)}  ·  ` +
        `${format.int(m.count)} частиц  ·  P* = ${format.value(m.pressure, 2)}`;
    }
  }

  private syncControls(): void {
    this.bindings.temperature?.set(this.world.params.temperature);
    this.bindings.density?.set(this.world.params.density);
    this.bindings.count?.set(this.world.state.count);
    this.bindings.thermostat?.set(this.world.params.thermostat);
    this.bindings.boundary?.set(this.world.params.boundary);
  }

  /** Отрисовка всех трёх графиков. */
  private drawPlots(): void {
    const history = this.world.history;
    const guide = this.world.params.thermostat === 'none'
      ? undefined
      : {
          value: this.world.params.temperature,
          label: 'цель',
          color: PLOT_COLORS.guide,
        };

    const temperature = history.series('temperature');
    drawPlot(this.plotT, {
      title: 'Температура T*',
      unit: 'ε/k_B',
      guide,
      series: [
        {
          label: 'T*',
          color: PLOT_COLORS.temperature,
          values: temperature.v,
          times: temperature.t,
          fill: true,
        },
      ],
    });

    const kinetic = history.series('kinetic');
    const potential = history.series('potential');
    const total = history.series('total');
    drawPlot(this.plotE, {
      title: 'Энергия',
      unit: 'ε',
      series: [
        { label: 'K', color: PLOT_COLORS.kinetic, values: kinetic.v, times: kinetic.t },
        { label: 'U', color: PLOT_COLORS.potential, values: potential.v, times: potential.t },
        { label: 'E', color: PLOT_COLORS.total, values: total.v, times: total.t, width: 1.8 },
      ],
    });

    const { r, g } = this.world.radialDistribution();
    drawRadial(this.plotR, r, g, { samples: this.world.radial.sampleCount });
  }

  private resize(): void {
    if (!this.renderer) return;
    const rect = this.stage.getBoundingClientRect();
    const width = Math.max(240, Math.floor(rect.width));
    const height = Math.max(180, Math.floor(rect.height));
    this.renderer.resize(width, height, this.world.box);
  }

  /** Доступ для сквозных проверок и скриптов витрины. */
  api(): PhysLabApi {
    return {
      world: this.world,
      state: this.state,
      renderer: this.renderer,
      input: this.input,
      camera: this.renderer.camera,
      getSession: () => this.session,
      actions: {
        startLevel: (id: string) => {
          const level = LEVELS.find((item) => item.id === id);
          if (level) this.startLevel(level);
          return Boolean(level);
        },
        checkLevel: () => this.checkLevel(),
        exitToSandbox: () => this.exitToSandbox(),
        applyPreset: (id: string) => {
          const preset = PRESETS.find((item) => item.id === id);
          if (preset) this.applyPreset(preset);
          return Boolean(preset);
        },
        setTemperature: (value: number) => {
          this.world.params.temperature = value;
          this.syncControls();
        },
        setDensity: (value: number) => {
          this.world.setDensity(value);
          this.syncControls();
        },
        setThermostat: (value: string) => {
          this.world.params.thermostat = value as WorldParams['thermostat'];
          this.syncControls();
        },
        setBoundary: (value: string) => {
          this.world.params.boundary = value as WorldParams['boundary'];
          this.syncControls();
        },
        toggleRun: () => this.toggleRun(),
        stepOnce: () => this.stepOnce(),
        runSteps: (count: number) => {
          for (let i = 0; i < count; i++) {
            this.world.step();
            this.tickSession();
            this.sampleIfDue(false);
          }
          this.updateHud();
          this.drawPlots();
        },
        openHelp: () => openHelp(),
      },
      plots: {
        temperature: () => this.plotT,
        energy: () => this.plotE,
        radial: () => this.plotR,
      },
      levels: () =>
        LEVELS.map((level) => ({
          id: level.id,
          number: levelNumber(level),
          title: level.title,
          checks: level.checks.length,
        })),
      metrics: () => ({
        temperature: this.world.measurement.temperature,
        count: this.world.measurement.count,
        density: this.world.params.density,
        pressure: this.world.measurement.pressure,
        orderPeak: this.world.orderPeak,
        mobility: this.world.measurement.mobileFraction,
        time: this.world.time,
        steps: this.world.steps,
        box: this.world.box,
      }),
      boxLength: (count: number, density: number) => boxLength(count, density),
    };
  }
}

/** Публичный API приложения для инструментов проверки. */
export interface PhysLabApi {
  world: World;
  state: AppState;
  renderer: SceneRenderer;
  input: InputController;
  camera: SceneRenderer['camera'];
  getSession(): LevelSession | null;
  actions: {
    startLevel(id: string): boolean;
    checkLevel(): LevelReport | null;
    exitToSandbox(): void;
    applyPreset(id: string): boolean;
    setTemperature(value: number): void;
    setDensity(value: number): void;
    setThermostat(value: string): void;
    setBoundary(value: string): void;
    toggleRun(): void;
    stepOnce(): void;
    runSteps(count: number): void;
    openHelp(): void;
  };
  plots: {
    temperature(): HTMLCanvasElement;
    energy(): HTMLCanvasElement;
    radial(): HTMLCanvasElement;
  };
  levels(): Array<{ id: string; number: number; title: string; checks: number }>;
  metrics(): {
    temperature: number;
    count: number;
    density: number;
    pressure: number;
    orderPeak: number;
    mobility: number;
    time: number;
    steps: number;
    box: number;
  };
  boxLength(count: number, density: number): number;
}
