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
import { drawPlot, drawMsd, drawRadial, drawStructure, drawTransition, PLOT_COLORS } from '../render/plots.js';
import { InputController } from '../input/controller.js';
import { unprojectFromScreen, type BrushPlane } from '../core/integrator.js';
import { AppState, format } from './state.js';
import { h, need, setContent } from '../ui/dom.js';
import {
  actionsPanel,
  dataPanel,
  experimentPanel,
  presetsPanel,
  viewPanel,
  worldPanel,
  type PanelActions,
} from '../ui/panels.js';
import { CampaignPanel, openHelp } from '../ui/campaign.js';
import { LevelSession } from '../levels/session.js';
import { LEVELS, levelNumber, type Level } from '../levels/levels.js';
import type { LevelReport } from '../levels/checks.js';
import { parseSnapshot, serializeSnapshot } from '../core/snapshot.js';
import { PhaseExperiment, type ExperimentConfig } from '../core/experiment.js';
import { PhysicsBridge } from '../worker/bridge.js';
import type { PhysicsView } from '../core/physics-view.js';
import {
  canvasToPng,
  downloadDataUrl,
  downloadText,
  historyToCsv,
  radialToCsv,
  structureToCsv,
  timestampedName,
  type HistoryRow,
} from '../render/export.js';

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
 * Задержка перед дорогой пересборкой системы.
 *
 * Ползунок числа частиц приходит десятками событий за протяжку, а каждое
 * такое событие пересобирает систему и обнуляет статистику. 200 мс — это
 * ещё «живая» реакция, но уже не поток пересборок.
 */
const REBUILD_DELAY_MS = 200;

/**
 * Приложение целиком.
 */
export class App {
  readonly state = new AppState();
  /**
   * Мир для ЧТЕНИЯ: настоящий или зеркало воркера.
   *
   * Тип — не `World`, а контракт `PhysicsView`. Это осознанно: у зеркала
   * мутаторов нет и быть не должно, поэтому компилятор не даст случайно
   * вызвать `this.world.step()` и посчитать физику в главном потоке, пока
   * её считает воркер. Все изменения идут через `this.bridge`.
   */
  get world(): PhysicsView {
    return this.bridge.world;
  }
  /** Мост: единственный путь к изменениям физики. */
  readonly bridge: PhysicsBridge;
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
  /** Таймер скрытия уведомления. */
  private noticeTimer = 0;
  /** Идущий эксперимент со свипом по температуре или null. */
  private experiment: PhaseExperiment | null = null;
  /** Выбранная ветвь свипа. */
  private experimentBranch: 'heating' | 'cooling' = 'heating';
  private experimentPanel: { setProgress(progress: number, phase: string): void } | null = null;
  /** Отложенная пересборка: что применить и таймеры ожидания. */
  private pendingCount: number | null = null;
  private pendingDensity: number | null = null;
  private countTimer = 0;
  private densityTimer = 0;
  /**
   * Чего игрок ждёт от ползунков.
   *
   * В режиме воркера зеркало отстаёт на кадр, и синхронизация по нему
   * откатывала бы только что выбранное значение. Пока мир не подтвердил
   * заказ, показываем именно заказанное.
   */
  private desiredCount: number | null = null;
  private desiredDensity: number | null = null;
  /** Каким было число частиц до запроса на пересборку. */
  private countBeforeRequest = -1;
  /** До какого момента ждать подтверждения заказа на число частиц. */
  private countRequestUntil = 0;
  /** Интервал между кадрами для честной подписи частоты кадров. */
  private frameIntervalMs = 0;
  /** Предыдущая точка замера скорости шагов. */
  private stepRateMark: { time: number; executed: number } | null = null;
  /** Последняя оценка скорости шагов — чтобы подпись не мигала нулём. */
  private lastStepRate = 0;
  /** Момент предыдущего кадра — для честной частоты кадров. */
  private lastFrameTick = 0;

  /** Ссылки на панели и их управляющие элементы для синхронизации. */
  private bindings: Partial<ReturnType<typeof worldPanel>['bindings']> = {};
  private campaign!: CampaignPanel;
  private stage!: HTMLElement;
  private hud!: HTMLElement;
  private plotT!: HTMLCanvasElement;
  private plotE!: HTMLCanvasElement;
  private plotR!: HTMLCanvasElement;
  private plotS!: HTMLCanvasElement;
  private plotM!: HTMLCanvasElement;
  private legendMin: HTMLElement | null = null;
  private legendMax: HTMLElement | null = null;
  private presetHighlight: (id: string | null) => void = () => {};

  constructor(host: HTMLElement, app: Application) {
    this.host = host;
    this.app = app;
    const world = new World({ ...DEFAULT_PARAMS }, 20260214, 'fcc');
    world.params.thermostat = 'berendsen';
    this.bridge = new PhysicsBridge(world);
  }

  /**
   * Попытаться перевести физику в воркер.
   *
   * Вызывается ПОСЛЕ построения интерфейса: если воркер не поднимется,
   * приложение обязано остаться рабочим на локальном мире, и об этом надо
   * сообщить, а не молча деградировать.
   */
  private enableWorkerIfPossible(): void {
    if (!this.bridge.enableWorker()) {
      const error = this.bridge.status().error ?? 'неизвестная причина';
      console.info(`Физика считается в главном потоке: ${error}`);
      return;
    }
    console.info('Физика вынесена в воркер');
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
    /*
     * Физика выносится в воркер ДО первого пресета.
     *
     * Порядок важен: `applyPreset` пересобирает систему, и если воркер
     * поднимется после, пересборка уйдёт в локальный мир, а воркер получит
     * уже другое состояние. Если воркер недоступен, приложение просто
     * продолжит считать локально — об этом сообщается в консоль.
     */
    this.enableWorkerIfPossible();
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
    this.plotS = h('canvas', {});
    this.plotM = h('canvas', {});
    plots.append(
      h('div', { class: 'plot' }, this.plotT),
      h('div', { class: 'plot' }, this.plotE),
      h('div', { class: 'plot' }, this.plotR),
      h('div', { class: 'plot' }, this.plotS),
      h('div', { class: 'plot' }, this.plotM),
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
      showBonds: this.state.view.showBonds,
      bondRadius: this.state.view.bondRadius,
      showTrails: this.state.view.showTrails,
      showVectors: this.state.view.showVectors,
      stepsPerFrame: this.state.stepsPerFrame,
      sampleRadial: this.state.sampleRadial,
      autoSteps: this.state.autoSteps,
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

    const experimentResult = experimentPanel(actions, () => {});
    this.experimentPanel = experimentResult;
    sidebar.append(
      worldPanelResult.root,
      actionsPanel(actions),
      presets.root,
      experimentResult.root,
      viewPanelResult.root,
      dataPanel(actions),
      this.campaign.root,
    );

    // Скрытое поле выбора файла: браузер открывает диалог только по действию
    // пользователя, поэтому кнопка «Загрузить JSON» кликает по нему.
    const loadInput = sidebar.querySelector<HTMLInputElement>('[data-role="load-state"]');
    loadInput?.addEventListener('change', () => {
      const file = loadInput.files?.[0];
      if (file) void this.loadStateFile(file);
      // Сбрасываем значение: иначе повторный выбор ТОГО ЖЕ файла не вызовет
      // событие `change`, и загрузка «не сработает» второй раз.
      loadInput.value = '';
    });
    this.bindings = { ...worldPanelResult.bindings, ...viewPanelResult.bindings };
    // Подписи концов легенды: без чисел цвет частицы не связать с физикой.
    this.legendMin = viewPanelResult.root.querySelector('[data-legend="min"]');
    this.legendMax = viewPanelResult.root.querySelector('[data-legend="max"]');

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
        this.bridge.setTemperature(value);
        this.notifyWorldChanged();
      },
      setDensity: (value) => {
        /*
         * Плотность меняет ящик без пересборки решётки, но тоже сбрасывает
         * историю и g(r) (см. `World.setDensity`). Поэтому и здесь протяжка
         * только показывает значение, а применяется оно после паузы.
         */
        this.scheduleDensityChange(value);
      },
      commitDensity: (value) => this.applyDensityNow(value),
      setCount: (value) => {
        /*
         * Протяжка ползунка числа частиц НЕ пересобирает систему.
         *
         * Пересборка — это десятки миллисекунд, и она обнуляет шаги, историю
         * измерений и накопленные g(r)/S(k)/MSD. Раньше она запускалась на
         * каждое событие движения мыши: игрок тянул ползунок — графики
         * «сбрасывались» десятки раз подряд, а у воркера копилась очередь
         * пересборок. Теперь во время протяжки обновляется только подпись,
         * а сама пересборка выполняется один раз после паузы.
         */
        this.scheduleCountRebuild(value);
      },
      commitCount: (value) => this.applyCountNow(value),
      setThermostat: (value) => {
        this.bridge.setThermostat(value);
        this.notifyWorldChanged();
      },
      setBoundary: (value) => {
        this.bridge.setBoundary(value);
        this.notifyWorldChanged();
      },
      setLattice: (value) => {
        this.bridge.requestRebuild(value as LatticeKind, true);
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
      setShowBonds: (value) => {
        this.state.view.showBonds = value;
        this.renderer.options.showBonds = value;
      },
      setBondRadius: (value) => {
        this.state.view.bondRadius = value;
        this.renderer.options.bondRadius = value;
      },
      setShowTrails: (value) => {
        this.state.view.showTrails = value;
        this.renderer.options.showTrails = value;
      },
      setShowVectors: (value) => {
        this.state.view.showVectors = value;
        this.renderer.options.showVectors = value;
      },
      setStepsPerFrame: (value) => {
        this.state.stepsPerFrame = Math.round(value);
      },
      setSampleRadial: (value) => {
        this.state.sampleRadial = value;
      },
      setAutoSteps: (value) => {
        this.state.autoSteps = value;
      },
      applyPreset: (preset) => this.applyPreset(preset),
      heat: (factor) => this.bridge.scaleVelocities(factor),
      cool: (factor) => this.bridge.scaleVelocities(factor),
      freezeAll: () => this.bridge.freezeAll(),
      unfreezeAll: () => this.bridge.unfreezeAll(),
      applyTemperatureNow: () => this.bridge.applyTemperatureNow(),
      compress: (factor) => {
        const density = this.world.params.density / factor ** 3;
        this.bridge.setDensity(density);
        this.syncControls();
      },
      expand: (factor) => {
        const density = this.world.params.density / factor ** 3;
        this.bridge.setDensity(density);
        this.syncControls();
      },
      resetWorld: () => this.resetWorld(),
      resample: () => this.resample(),
      setTool: (tool) => {
        this.input.tool = tool as 'poke';
      },
      saveState: () => this.saveState(),
      loadState: () => this.openLoadDialog(),
      exportHistory: () => this.exportHistory(),
      exportRadial: () => this.exportRadial(),
      exportStructure: () => this.exportStructure(),
      exportPlot: (which) => this.exportPlot(which),
      toggleExperiment: () => this.toggleExperiment(),
      setExperimentBranch: (branch) => this.setExperimentBranch(branch),
    };
  }

  /* ------------------------------------------------------------------ */
  /* Эксперимент: свип по температуре                                    */
  /* ------------------------------------------------------------------ */

  /**
   * Запуск или остановка свипа.
   *
   * Свип идёт СВОИМ миром, а не текущим: он должен начинаться с известного
   * состояния (кристалл для нагрева, газ для охлаждения), иначе результат
   * зависит от того, что игрок делал до этого, и перестаёт воспроизводиться.
   * Мир эксперимента подменяет основной на время расчёта.
   */
  private toggleExperiment(): void {
    if (this.experiment) {
      this.experiment = null;
      this.state.experimentRunning = false;
      // Возвращаем для чтения основной мир: иначе сцена осталась бы на
      // последнем кадре свипа, и «Пуск» не давал бы видимого эффекта.
      this.bridge.restoreReadingWorld();
      this.experimentPanel?.setProgress(0, 'остановлен');
      this.updateExperimentButton();
      return;
    }

    this.experiment = new PhaseExperiment({
      count: Math.min(500, this.world.state.count),
      density: this.world.params.density,
      branch: this.experimentBranch,
    });
    // Показываем мир эксперимента: сцена и графики должны рисовать именно
    // его. Основной мир (в том числе мир воркера) при этом не трогается —
    // мост вернёт его, когда свип закончится.
    this.bridge.showWorldForReading(this.experiment.simulation);
    this.state.experimentRunning = true;
    this.paused = false;
    this.state.running = true;
    const runBtn = this.host.querySelector<HTMLButtonElement>('[data-action="run"]');
    if (runBtn) {
      runBtn.textContent = 'Пауза';
      runBtn.classList.add('btn--primary');
    }
    // Камера подстраивается под ящик нового мира: у эксперимента он свой,
    // и без этого сцена окажется в другом масштабе.
    this.renderer.camera.fit(this.world.box, this.app.renderer.width, this.app.renderer.height);
    this.updateExperimentButton();
  }

  /** Смена ветви эксперимента. */
  private setExperimentBranch(branch: 'heating' | 'cooling'): void {
    this.experimentBranch = branch;
    for (const btn of this.host.querySelectorAll<HTMLButtonElement>('[data-branch]')) {
      btn.classList.toggle('btn--on', btn.dataset['branch'] === branch);
    }
    // Перезапуск, если свип уже идёт: смена ветви на ходу дала бы мешанину
    // из двух разных начальных состояний.
    if (this.experiment) {
      this.experiment = null;
      this.state.experimentRunning = false;
      this.toggleExperiment();
    }
  }

  private updateExperimentButton(): void {
    const btn = this.host.querySelector<HTMLButtonElement>('[data-action="experiment-toggle"]');
    if (!btn) return;
    btn.textContent = this.experiment ? 'Остановить свип' : 'Запустить свип';
    btn.classList.toggle('btn--primary', Boolean(this.experiment));
  }

  /**
   * Шаги эксперимента за кадр.
   *
   * Бюджет ограничен временем, а не числом шагов: на 500 частицах шаг дешевле,
   * но при переключении на модель крупнее картинка не должна дёргаться.
   */
  private advanceExperiment(frameStart: number): void {
    const experiment = this.experiment;
    if (!experiment || experiment.done) {
      if (experiment && experiment.done) {
        this.experimentPanel?.setProgress(1, 'готово');
        this.updateExperimentButton();
        this.experiment = null;
        this.state.experimentRunning = false;
        // Свип закончился — возвращаем сцену на основной мир.
        this.bridge.restoreReadingWorld();
      }
      return;
    }
    const budgetMs = 12;
    // Шагаем порциями, проверяя время: `advance` сам разбивает работу, но
    // точный бюджет известен только по факту.
    let guard = 0;
    while (performance.now() - frameStart < budgetMs && guard < 50) {
      const performed = experiment.advance(200);
      guard++;
      if (performed === 0) break;
      if (performance.now() - frameStart >= budgetMs) break;
    }
    const result = experiment.result();
    const phase = experiment.done
      ? 'готово'
      : `T* = ${experiment.currentTemperature.toFixed(2)} · точек ${result.points.length}`;
    this.experimentPanel?.setProgress(experiment.progress, phase);
  }

  /* ------------------------------------------------------------------ */
  /* Данные: сохранение, загрузка, экспорт                               */
  /* ------------------------------------------------------------------ */

  /** Сохранить состояние мира в JSON-файл. */
  private saveState(): void {
    /*
     * Снимок берётся ЧЕРЕЗ МОСТ, а не у мира напрямую.
     *
     * В режиме воркера мира в главном потоке нет — есть только зеркало
     * последнего кадра, из которого полное состояние (генератор случайных
     * чисел, опорные координаты) не восстановить. Поэтому снимок
     * запрашивается у воркера и приходит отдельным событием.
     */
    void this.bridge.requestSnapshot().then((text) => {
      downloadText(
        timestampedName('phys-lab-состояние', 'json'),
        text,
        'application/json;charset=utf-8',
      );
      this.showNotice('Состояние сохранено');
    });
  }

  /** Открыть диалог выбора файла состояния. */
  private openLoadDialog(): void {
    const input = this.host.querySelector<HTMLInputElement>('[data-role="load-state"]');
    input?.click();
  }

  /**
   * Загрузка состояния из выбранного файла.
   *
   * Ошибки показываются игроку, а не глотаются: «файл не загрузился» без
   * причины — худший вариант, потому что непонятно, что чинить.
   */
  private async loadStateFile(file: File): Promise<void> {
    try {
      const text = await file.text();
      // Проверка снимка идёт здесь, а восстановление — через мост: в режиме
      // воркера восстанавливать должен он, иначе состояние разъедется.
      const parsed = parseSnapshot(text);
      if (!parsed.ok) {
        this.showNotice(`Не удалось загрузить: ${parsed.error}`, true);
        return;
      }
      const error = this.bridge.restoreJson(text);
      if (error) {
        this.showNotice(`Не удалось загрузить: ${error}`, true);
        return;
      }
      this.session = null;
      this.state.levelId = null;
      this.campaign.showSandbox();
      this.paused = true;
      this.state.running = false;
      const btn = this.host.querySelector<HTMLButtonElement>('[data-action="run"]');
      if (btn) {
        btn.textContent = 'Пуск';
        btn.classList.remove('btn--primary');
      }
      this.afterRebuild();
      this.showNotice(`Состояние загружено: ${format.int(this.world.state.count)} частиц, τ = ${format.time(this.world.time)}`);
    } catch (error) {
      this.showNotice(`Не удалось прочитать файл: ${(error as Error).message}`, true);
    }
  }

  /** Выгрузить историю измерений в CSV. */
  private exportHistory(): void {
    const history = this.world.history;
    const rows: HistoryRow[] = [];
    for (let i = 0; i < history.size; i++) {
      const sample = history.get(i);
      if (!sample) continue;
      rows.push({
        time: sample.time,
        temperature: sample.temperature,
        kinetic: sample.kinetic,
        potential: sample.potential,
        total: sample.total,
        pressure: sample.pressure,
        orderPeak: sample.orderPeak,
        mobileFraction: sample.mobileFraction,
      });
    }
    if (rows.length === 0) {
      this.showNotice('История пуста — нечего выгружать', true);
      return;
    }
    downloadText(timestampedName('phys-lab-история', 'csv'), historyToCsv(rows));
    this.showNotice(`Выгружено строк: ${rows.length}`);
  }

  /** Выгрузить g(r) в CSV. */
  private exportRadial(): void {
    const { r, g } = this.world.radialDistribution();
    const samples = this.world.radial.sampleCount;
    if (samples === 0) {
      this.showNotice('Статистика g(r) ещё не накоплена', true);
      return;
    }
    downloadText(timestampedName('phys-lab-gr', 'csv'), radialToCsv(r, g, samples));
    this.showNotice(`g(r) выгружена, кадров: ${samples}`);
  }

  /** Выгрузить S(k) в CSV. */
  private exportStructure(): void {
    const { k, s } = this.world.structureFactor();
    const samples = this.world.structure.sampleCount;
    if (samples === 0) {
      this.showNotice('Структурный фактор ещё не накоплен', true);
      return;
    }
    downloadText(timestampedName('phys-lab-sk', 'csv'), structureToCsv(k, s, samples));
    this.showNotice(`S(k) выгружен, кадров: ${samples}`);
  }

  /**
   * Сохранить график в PNG.
   *
   * Доступны все пять графиков: раньше отсюда можно было выгрузить только три
   * (`T`, энергия, g(r)`), хотя S(k) и MSD — самые показательные кривые
   * (пик S(k) отличает кристалл от жидкости, наклон MSD даёт D). Заодно у
   * функции не было ни одной кнопки в интерфейсе.
   */
  private exportPlot(which: 'temperature' | 'energy' | 'radial' | 'structure' | 'msd'): void {
    const canvas =
      which === 'temperature' ? this.plotT
      : which === 'energy' ? this.plotE
      : which === 'radial' ? this.plotR
      : which === 'structure' ? this.plotS
      : this.plotM;
    downloadDataUrl(timestampedName(`phys-lab-${which}`, 'png'), canvasToPng(canvas));
    this.showNotice(`График сохранён: ${which}.png`);
  }

  /**
   * Краткое уведомление в углу сцены.
   *
   * Нужно для операций, у которых нет видимого результата: сохранение файла
   * или неудачная загрузка иначе выглядят как «кнопка ничего не делает».
   */
  private showNotice(message: string, isError = false): void {
    let node = this.host.querySelector<HTMLElement>('[data-role="notice"]');
    if (!node) {
      node = h('div', { class: 'notice', dataset: { role: 'notice' } });
      // Уведомление живёт ВНУТРИ сцены: так оно позиционируется относительно
      // неё и не перекрывает графики и панели.
      this.stage.append(node);
    }
    node.textContent = message;
    node.classList.toggle('notice--error', isError);
    node.classList.add('notice--visible');
    window.clearTimeout(this.noticeTimer);
    this.noticeTimer = window.setTimeout(() => {
      node?.classList.remove('notice--visible');
    }, 4000);
  }

  /* ------------------------------------------------------------------ */
  /* Управление                                                          */
  /* ------------------------------------------------------------------ */

  private notifyWorldChanged(): void {
    this.state.notify();
  }

  /**
   * Отложенная пересборка под новое число частиц.
   *
   * Пока игрок тянет ползунок, команда не отправляется: подпись уже
   * обновлена обработчиком `input`, а система пересобирается один раз —
   * после короткой паузы. Задержка мала (200 мс), поэтому реакция остаётся
   * «живой», но десятки пересборок подряд исчезают.
   */
  private scheduleCountRebuild(value: number): void {
    const count = Math.round(value);
    this.pendingCount = count;
    window.clearTimeout(this.countTimer);
    this.countTimer = window.setTimeout(() => {
      if (this.pendingCount === null) return;
      const target = this.pendingCount;
      this.pendingCount = null;
      this.applyCountNow(target);
    }, REBUILD_DELAY_MS);
  }

  /** Применить новое число частиц немедленно. */
  private applyCountNow(value: number): void {
    const count = Math.round(value);
    // Повторная пересборка на то же число не нужна: она лишь сбросила бы
    // накопленную статистику без всякой пользы.
    if (count === this.world.state.count) return;
    window.clearTimeout(this.countTimer);
    this.pendingCount = null;
    this.desiredCount = count;
    /*
     * Запоминаем, ОТКУДА пересобираем.
     *
     * ГЦК округляет число частиц до 4n³, поэтому запрошенное значение почти
     * никогда не совпадёт с фактическим: 3456 превращается в 4000. Первая
     * версия ждала точного совпадения `мир.count === desiredCount` — и
     * «заказанное» значение не сбрасывалось НИКОГДА. Ползунок залипал на
     * 3456 и продолжал врать даже после смены пресета (мир уже 2048, а
     * подпись показывала 3456). Замерено в браузере.
     *
     * Поэтому признак подтверждения — не совпадение, а ИЗМЕНЕНИЕ числа
     * относительно того, каким оно было на момент запроса.
     */
    this.countBeforeRequest = this.world.state.count;
    /*
     * Страховка по времени.
     *
     * Есть крайний случай: игрок просит число, которое ГЦК округляет обратно
     * к текущему (текущее 4000, просим 3456 → снова 4000). Тогда «мир
     * изменился» не наступает никогда, и без ограничения ползунок залип бы
     * навсегда. Через секунду ожидания считаем, что заказ выполнен, и дальше
     * показываем то, что действительно в мире.
     */
    this.countRequestUntil = performance.now() + 1000;
    this.bridge.resize(count, this.world.params.density, 'fcc');
    this.afterRebuild();
  }

  /** Отложенная смена плотности — по той же причине, что и числа частиц. */
  private scheduleDensityChange(value: number): void {
    this.pendingDensity = value;
    window.clearTimeout(this.densityTimer);
    this.densityTimer = window.setTimeout(() => {
      if (this.pendingDensity === null) return;
      const target = this.pendingDensity;
      this.pendingDensity = null;
      this.applyDensityNow(target);
    }, REBUILD_DELAY_MS);
  }

  /** Применить новую плотность немедленно. */
  private applyDensityNow(value: number): void {
    window.clearTimeout(this.densityTimer);
    this.pendingDensity = null;
    if (Math.abs(value - this.world.params.density) < 1e-9) return;
    this.desiredDensity = value;
    this.bridge.setDensity(value);
    // Подпись синхронизируется сразу: значение уже принято, и ждать
    // следующего кадра воркера незачем — иначе ползунок «отпрыгнет» назад.
    this.syncControls();
    this.state.notify();
  }

  private afterRebuild(): void {
    this.renderer.camera.fit(this.world.box, this.app.renderer.width, this.app.renderer.height);
    this.syncControls();
    this.state.notify();
  }

  /** Применение пресета: параметры, решётка, короткий отжиг. */
  applyPreset(preset: Preset, options: { silent?: boolean } = {}): void {
    /*
     * Пресет применяется ЧЕРЕЗ МОСТ и одним вызовом.
     *
     * В локальном режиме это набор параметров плюс пересборка. В режиме
     * воркера — те же действия командами. Отдельный метод нужен потому, что
     * пресет задаёт параметры ЦЕЛИКОМ: если слать их по одному, воркер
     * успеет сделать шаг в промежуточном состоянии (например, с новой
     * температурой, но старой плотностью).
     */
    const params: Partial<WorldParams> = {
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
    this.bridge.applyParamsAndResize(
      params,
      preset.count,
      preset.density,
      preset.lattice,
      preset.equilibrate,
    );

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
    this.bridge.rebuild('fcc', true);
    this.afterRebuild();
  }

  private resetWorld(): void {
    this.bridge.resize(this.world.state.count, this.world.params.density, 'fcc');
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
    // `force`: одиночный шаг — дискретное действие игрока, и он обязан
    // выполниться даже если воркер ещё считает предыдущую порцию.
    this.bridge.advance(1, true);
    this.sampleIfDue(true);
    this.updateHud();
    this.flashStepButton();
  }

  /**
   * Вспышка кнопки «Шаг».
   *
   * Отклик на один шаг почти невидим: счётчик шагов меняется, но глазу за ним
   * не уследить, и нажатие выглядит как «ничего не произошло». Короткая
   * подсветка кнопки даёт понять, что шаг действительно сделан.
   */
  private flashStepButton(): void {
    const btn = this.host.querySelector<HTMLButtonElement>('[data-action="step"]');
    if (!btn) return;
    btn.classList.add('btn--flash');
    window.setTimeout(() => btn.classList.remove('btn--flash'), 180);
  }

  private poke(screenX: number, screenY: number, dx: number, dy: number): void {
    // Экранные координаты переводятся в координаты проекции, а толчок
    // задаётся по экранным осям: протяжка мышью идёт вдоль экрана.
    const scale = this.renderer.camera.scale;
    if (scale <= 0) return;
    const worldDx = (dx / scale) * this.input.pokeStrength;
    const worldDy = (dy / scale) * this.input.pokeStrength;

    // Импульс НАКАПЛИВАЕТСЯ в мире и применяется один раз за кадр: за кадр
    // мышь присылает несколько событий, и «последнее побеждает» сделало бы
    // толчок зависимым от частоты событий устройства, а не от протяжки.
    this.bridge.requestPoke({
      plane: this.brushPlane(screenX, screenY),
      dx: worldDx,
      dy: worldDy,
      dz: 0,
      radius: this.input.brushRadius,
      strength: 1,
    });
  }

  /**
   * Кисть в мировых координатах: цилиндр вдоль оси взгляда через точку экрана.
   *
   * Вход — координаты ПРОЕКЦИИ (то, что даёт `camera.screenToWorld`), то есть
   * система после поворота yaw/pitch. Раньше отсюда возвращалась одна точка
   * на «плоскости экрана», и воздействие ограничивалось сферой вокруг неё:
   * доступным оказывался только средний слой частиц. Теперь возвращается ось:
   * точка на ней берётся в плоскости, проходящей через центр ящика, — так она
   * остаётся внутри ящика, и минимальный образ работает корректно.
   *
   * Направление оси выводится из тех же углов, что и проекция (`World.project`),
   * поэтому «куда смотрит камера» и «куда бьёт кисть» не могут разойтись.
   */
  private brushPlane(screenX: number, screenY: number): BrushPlane {
    const center = this.world.box * 0.5;
    const w = this.world.viewAxis(this.renderer.camera.yaw, this.renderer.camera.pitch);
    const p = unprojectFromScreen(w, screenX, screenY, 0);
    return { w, center: { x: p.x + center, y: p.y + center, z: p.z + center } };
  }

  private freezeAt(px: number, py: number): void {
    this.bridge.freezeRegion(this.brushPlane(px, py), this.input.brushRadius);
  }

  private unfreezeAt(_px: number, _py: number): void {
    this.bridge.unfreezeAll();
  }

  /* ------------------------------------------------------------------ */
  /* Уровни                                                              */
  /* ------------------------------------------------------------------ */

  /** Запуск уровня. */
  startLevel(level: Level): void {
    const setup = level.setup;
    // Уровень, как и пресет, задаёт параметры ЦЕЛИКОМ и пересобирает систему:
    // промежуточные состояния воркеру видеть незачем.
    const params: Partial<WorldParams> = {
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
    this.bridge.applyParamsAndResize(
      params,
      params.count ?? DEFAULT_PARAMS.count,
      params.density ?? DEFAULT_PARAMS.density,
      setup.lattice,
    );
    this.state.levelId = level.id;
    this.state.presetId = null;
    this.presetHighlight(null);
    /*
     * Сессия уровня работает с ЛОКАЛЬНЫМ миром.
     *
     * Это осознанное ограничение: проверки уровня читают историю измерений
     * и накопленную статистику, а в режиме воркера в главном потоке есть
     * только зеркало последнего кадра. Поэтому при запуске уровня физика
     * возвращается в главный поток, и кампания работает как раньше.
     */
    this.bridge.disableWorker();
    this.session = new LevelSession(level, this.bridge.localWorld);
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
    const report = this.session.checkNow(this.bridge.localWorld);
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
    if (this.lastFrameTick > 0) this.frameIntervalMs = frameStart - this.lastFrameTick;
    this.lastFrameTick = frameStart;
    const target = 1000 / Math.max(1, this.state.targetFps);
    const elapsed = frameStart - this.lastFrame;

    /*
     * Свежий кадр от воркера — ДО всего остального.
     *
     * Порядок принципиален: сначала забираем то, что воркер успел посчитать,
     * и только потом заказываем новую порцию шагов. Если поменять местами,
     * отрисовка всегда показывала бы состояние на один кадр старше, а
     * измерения читались бы дважды за один и тот же момент.
     *
     * В локальном режиме метод ничего не делает и стоит одного сравнения.
     */
    if (this.experiment) {
      // Во время свипа сцена показывает мир эксперимента, а он считается
      // локально: кадры воркера здесь не нужны и только мешали бы.
    } else {
      this.bridge.sync();
    }

    if (this.experiment) {
      // Режим эксперимента: обычная симуляция уступает время свипу.
      // Физика внутри свипа своя, поэтому `stepsPerFrame` здесь не при чём.
      this.advanceExperiment(frameStart);
      this.physicsMs = performance.now() - frameStart;
    } else if (!this.paused && elapsed >= target * 0.6) {
      this.lastFrame = frameStart;
      const steps = Math.max(1, this.state.stepsPerFrame);
      const physicsStart = performance.now();
      /*
       * Шаги идут ЧЕРЕЗ МОСТ.
       *
       * В локальном режиме это обычный цикл `world.step()`. В режиме воркера
       * `bridge.advance` только ЗАКАЗЫВАЕТ шаги и возвращается сразу —
       * ждать их синхронно значило бы потерять весь смысл воркера. Поэтому
       * `physicsMs` здесь измеряет время заказа, а не расчёта; реальную
       * стоимость видно по частоте кадров и по `timings()`.
       */
      this.bridge.advance(steps);
      for (let i = 0; i < steps; i++) this.tickSession();
      this.physicsMs = performance.now() - physicsStart;
      // Кадр статистики g(r) считается ПОСЛЕ замера шага.
      //
      // Раньше он вызывался внутри цикла и попадал в `physicsMs`. Это ломало
      // автоподстройку: она делила суммарное время на число шагов и получала
      // завышенную «стоимость шага» — при 2048 частицах g(r) стоит примерно
      // как шесть шагов, то есть замер был в разы больше правды, и число
      // шагов на кадр уезжало к единице на здоровой системе.
      this.sampleIfDue(false, steps);
      this.frameCounter++;
    } else {
      // Шагов физики в этом кадре не было (пауза или троттлинг частоты), а
      // накопленный толчок мыши применить всё равно нужно: иначе на паузе
      // протяжка не давала бы никакого отклика, и игрок не увидел бы, куда
      // попал. Заявка ограничена одной на кадр, поэтому «тыканье» на паузе
      // остаётся управляемым.
      this.bridge.flushPoke();
    }

    const drawn = this.renderer.render(this.world, this.input.brush.active ? this.input.brush : null);
    this.drawMs = drawn.frameMs;

    this.uiCounter++;
    if (this.uiCounter >= UI_SYNC_INTERVAL) {
      this.uiCounter = 0;
      this.updateHud();
      this.drawPlots();
      this.updateLegendValues();
      /*
       * Ползунки подтягиваются из мира.
       *
       * Без этого они залипали на значении, снятом один раз при пересборке:
       * в режиме воркера зеркало в тот момент ещё старое, поэтому число
       * частиц показывалось прежним (2048 вместо 4000) уже навсегда.
       */
      this.syncControls();
    }
    this.updateFps(frameStart);
    this.autoTuneSteps();

    this.app.render();
    requestAnimationFrame(this.loop);
  };

  private tickSession(): void {
    if (!this.session) return;
    const report = this.session.tick(this.bridge.localWorld);
    if (report && this.uiCounter % 4 === 0) {
      this.campaign.showLevel(this.session.level, report, this.session.progress);
      if (report.passed) {
        this.campaign.markCompleted(this.session.level.id);
        document.body.dataset['levelPassed'] = this.session.level.id;
      }
    }
  }

  /** Кадр статистики g(r) — дорого, поэтому не каждый шаг. */
  private sampleIfDue(force: boolean, stepsTaken = 1): void {
    if (!this.state.sampleRadial && !force) return;
    this.radialCounter += stepsTaken;
    if (force || this.radialCounter >= this.radialEvery) {
      this.radialCounter = 0;
      this.bridge.sampleRadial();
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
    const now = performance.now();
    if (now - this.lastAutoTune < 500) return;
    this.lastAutoTune = now;
    if (this.bridge.usingWorker) {
      this.autoTuneWorkerSteps();
      return;
    }
    /*
     * Локальный режим: физика считается ПРЯМО В КАДРЕ, поэтому её надо
     * уложить в бюджет времени. При 8 шагах и цели 60 кадров/с это 10 мс —
     * примерно шестая часть кадра, остальное достаётся отрисовке и браузеру.
     */
    const budget = 10;
    const perStep = this.physicsMs / Math.max(1, this.state.stepsPerFrame);
    if (perStep <= 0 || !Number.isFinite(perStep)) return;
    const ideal = Math.max(1, Math.min(40, Math.floor(budget / perStep)));
    if (ideal > this.state.stepsPerFrame && this.physicsMs < budget * 0.7) {
      this.setStepsPerFrame(this.state.stepsPerFrame + 1);
    } else if (ideal < this.state.stepsPerFrame && this.physicsMs > budget) {
      this.setStepsPerFrame(this.state.stepsPerFrame - 1);
    }
  }

  /**
   * Автоподстройка числа шагов в режиме воркера.
   *
   * ─── Почему здесь нельзя мерить время кадра, как в локальном режиме ──────
   *
   * В локальном режиме физика блокирует кадр, поэтому её укладывают в бюджет:
   * это и делает ветка выше. В режиме воркера физика кадр НЕ блокирует —
   * главный поток лишь отправляет команду. Первая версия перенесла сюда тот
   * же бюджет и стала мерить стоимость `postMessage` (доли миллисекунды):
   * число шагов на кадр уползало к 21 и выше, воркер не успевал, очередь
   * росла, а «Пауза» перестала останавливать движение. Это и была жалоба на
   * «просевший FPS».
   *
   * ─── Что здесь на самом деле нужно ───────────────────────────────────────
   *
   * Заказать ровно столько шагов, чтобы воркер был занят примерно один кадр.
   * Меньше — воркер простаивает, система считается медленнее, чем может.
   * Больше — очередь растёт, и картинка отстаёт от действий игрока.
   *
   * Величины для этого есть: интервал кадров измеряет главный поток, а
   * стоимость шага — сам воркер (из главного потока её не видно). Отсюда
   * порция:
   *
   *     шагов на кадр = интервал кадра / стоимость шага
   *
   * Замерено на 2048 частицах (`scripts/dev-profile.mjs`, порция фиксирована):
   * при 8–16 шагах воркер выдаёт ~190 шаг/с, при 32 и выше пропускная
   * способность падает втрое, потому что заказы начинают блокироваться
   * очередью. Формула как раз держит порцию в рабочей зоне.
   */
  private autoTuneWorkerSteps(): void {
    const stepCost = this.bridge.stepCostMs;
    if (stepCost <= 0) return;
    // До первого измерения интервала ориентируемся на 60 кадров/с.
    const frameMs = this.frameIntervalMs > 0 ? this.frameIntervalMs : 1000 / 60;
    /*
     * Верхняя граница порции — 16, и это ИЗМЕРЕННАЯ величина.
     *
     * В `scripts/dev-profile.mjs` порция задавалась вручную, и пропускная
     * способность воркера оказалась такой (N = 2048):
     *
     *     порция:   1     2     4     8     16    32    48
     *     шаг/с:   18    33    67   142   190    84    31
     *
     * То есть после 16 шагов пропускная способность падает втрое: очередь
     * заказов перестаёт разгружаться, и воркер начинает тратить время на
     * разбор отставания, а не на физику. Формула `кадр / стоимость шага` в
     * медленном окружении (софтверный рендер, длинный кадр) даёт 26 и
     * попадает ровно в провал. Поэтому результат формулы ограничивается
     * значением из этой таблицы.
     */
    const MAX_WORKER_BATCH = 16;    const target = Math.min(MAX_WORKER_BATCH, Math.max(1, Math.round(frameMs / stepCost)));
    /*
     * Приближение к цели — по одному шагу за замер.
     *
     * Прыжок сразу к расчётному значению дал бы автоколебания: в оценку
     * стоимости входит и сборка кадра, поэтому она зависит от самой порции.
     * Медленное движение (раз в 500 мс) гасит эту обратную связь.
     */
    const current = this.state.stepsPerFrame;
    if (target > current) this.setStepsPerFrame(current + 1);
    else if (target < current) this.setStepsPerFrame(current - 1);
  }

  /** Выставить число шагов на кадр и обновить ползунок в панели. */
  private setStepsPerFrame(value: number): void {
    const clamped = Math.max(1, Math.min(40, Math.round(value)));
    if (clamped === this.state.stepsPerFrame) return;
    this.state.stepsPerFrame = clamped;
    this.bindings.stepsPerFrame?.set(clamped);
    this.state.notify();
  }

  private updateFps(frameStart: number): void {
    const field = this.host.querySelector('[data-field="fps"]');
    if (!field) return;
    void frameStart;
    // На паузе «0 расч/с» читается как поломка, хотя это верное поведение.
    // Показываем явное «пауза» вместо нуля.
    if (this.paused) {
      field.textContent = `пауза · шаг ${this.world.steps}`;
      return;
    }
    /*
     * ─── Почему подпись считается именно так ────────────────────────────────
     *
     * Раньше здесь стояло `1000 / (physicsMs + drawMs)`. В локальном режиме
     * это осмысленно, но в режиме воркера `physicsMs` — только время отправки
     * сообщения: сам расчёт идёт в другом потоке. Подпись показывала «294
     * расч/с», хотя счётчик шагов рядом вырастал за секунду примерно на 300,
     * а кадров интерфейса было около 15. Человек видел противоречие и решал,
     * что сломаны и счётчик, и производительность.
     *
     * Поэтому показываются две ЧЕСТНЫЕ величины: реальная частота кадров
     * (по интервалу между кадрами) и фактическая скорость шагов физики
     * (по приросту подтверждённых воркером шагов).
     */
    const interval = this.frameIntervalMs;
    const fps = interval > 0 ? 1000 / interval : 0;
    const perSecond = this.measureStepRate();
    field.textContent = `${fps.toFixed(0)} кадр/с · ${perSecond.toFixed(0)} шаг/с · всего ${this.world.steps}`;
  }

  /**
   * Фактическая скорость шагов физики, шагов в секунду.
   *
   * Считается по приросту монотонного счётчика выполненного: в режиме
   * воркера это единственная величина, которая отражает реальный расчёт,
   * а не темп отправки команд.
   *
   * ─── Почему точка замера двигается не каждый кадр ────────────────────────
   *
   * Воркер присылает кадр не каждый кадр отрисовки (на 2048 частицах — реже).
   * Если пересчитывать скорость на каждом кадре, то между кадрами воркера
   * прирост равен нулю, и подпись мигала бы «0 шаг/с» — то есть врала ровно
   * в тот момент, когда система работает нормально. Поэтому точка замера
   * сдвигается только когда счётчик вырос, а измерение идёт по интервалу
   * между такими сдвигами.
   */
  private measureStepRate(): number {
    const executed = this.bridge.usingWorker
      ? this.world.stepsExecuted
      : this.world.steps;
    const now = performance.now();
    const previous = this.stepRateMark;
    if (!previous) {
      this.stepRateMark = { time: now, executed };
      return 0;
    }
    if (executed === previous.executed) {
      // Прогресса нет: держим последнюю оценку, но не дольше секунды —
      // иначе подпись показывала бы скорость уже остановившейся системы.
      return now - previous.time > 1000 ? 0 : this.lastStepRate;
    }
    const dt = (now - previous.time) / 1000;
    this.stepRateMark = { time: now, executed };
    if (dt <= 0) return this.lastStepRate;
    this.lastStepRate = Math.max(0, (executed - previous.executed) / dt);
    return this.lastStepRate;
  }

  private updateHud(): void {
    const m = this.world.measurement;
    const diffusion = this.world.diffusion();
    const rows: Array<[string, string]> = [
      ['частиц', format.int(m.count)],
      ['T*', format.value(m.temperature)],
      ['ρ*', format.value(this.world.params.density)],
      ['E кин', format.energy(m.kinetic)],
      ['E пот', format.energy(this.world.potentialEnergy)],
      ['E полн', format.energy(m.total)],
      ['P*', format.value(m.pressure, 2)],
      ['связей/атом', format.value(this.world.coordination, 2)],
      ['разброс связей', format.value(this.world.bondSpread, 3)],
      ['D (диффузия)', this.diffusionLabel(diffusion.D)],
      ['пик g(r)', format.value(this.world.orderPeak, 2)],
      ['пик S(k)', format.value(this.world.structure.firstPeak().height, 2)],
      ['время τ', format.time(this.world.time)],
      ['пар', format.int(this.world.pairCount)],
      ['кадров g(r)', format.int(this.world.radial.sampleCount)],
      ['подвижных', `${(m.mobileFraction * 100).toFixed(0)} %`],
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
        `${format.int(m.count)} частиц  ·  P* = ${format.value(m.pressure, 2)}` +
        this.equilibriumLabel();
    }
  }

  /**
   * Подпись коэффициента диффузии.
   *
   * Ноль до набора статистики и ноль у настоящего кристалла — разные вещи,
   * и показывать их одинаково нельзя: игрок решит, что жидкость застыла.
   * Поэтому при недобранном окне выводится прогресс набора, а не число.
   */
  private diffusionLabel(value: number): string {
    if (!this.world.msdReady) {
      return `набор ${(this.world.msdProgress * 100).toFixed(0)} %`;
    }
    return format.value(value, 4);
  }

  /**
   * Готова ли статистика: набралось ли достаточно кадров g(r).
   *
   * Смысл — не дать игроку поверить цифрам, которые ещё «плывут». Один кадр
   * g(r) шумный, а у больших систем ещё и дорогой, поэтому приложение
   * сознательно растягивает интервал. Пока кадров мало, кривая не готова, и
   * об этом нужно сказать прямо, а не оставлять игрока догадываться.
   */
  private equilibriumLabel(): string {
    // Выключенный сбор g(r) — не «выход на режим», а сознательный выбор
    // игрока: в этом режиме статистики не будет вообще, и обещать прогресс
    // нельзя. Показываем прочерк, а не вечные 0 %.
    if (!this.state.sampleRadial) return '';
    const samples = this.world.radial.sampleCount;
    if (this.world.params.thermostat === 'none') {
      // Без термостата «равновесие» = сохранение энергии, а не выход на T*.
      return samples < 20 ? '  ·  набор статистики' : '';
    }
    const target = this.world.params.temperature;
    const current = this.world.measurement.temperature;
    const settled = Math.abs(current - target) < Math.max(0.05, target * 0.08);
    if (!settled) return `  ·  выход на режим (T* ${current.toFixed(2)} → ${target.toFixed(2)})`;
    if (samples < 20) return `  ·  набор статистики (${samples}/20)`;
    return '  ·  равновесие';
  }

  /**
   * Привести элементы управления к текущему состоянию мира.
   *
   * ─── Почему здесь нужны «заказанные» значения ────────────────────────────
   *
   * В режиме воркера `this.world` — это ЗЕРКАЛО последнего полученного кадра.
   * Сразу после команды оно ещё показывает прежнее состояние: воркер не успел
   * прислать новый кадр. Если синхронизировать ползунки по зеркалу в этот
   * момент, они откатываются на старое значение — именно так «не
   * настраивалось» число частиц: ползунок возвращался на 2048, хотя система
   * пересобиралась на 4000.
   *
   * Поэтому у ползунков числа частиц и плотности есть «заказанное» значение:
   * пока зеркало не догнало, показывается оно.
   */
  private syncControls(): void {
    this.bindings.temperature?.set(this.world.params.temperature);
    /*
     * Число частиц: у ГЦК оно округляется до 4n³, поэтому «заказанное»
     * значение снимается не по совпадению, а по факту пересборки: как только
     * мир показал ДРУГОЕ число, чем было до запроса, значит заказ выполнен и
     * дальше ползунок обязан следовать за миром.
     */
    if (
      this.desiredCount !== null &&
      (this.world.state.count !== this.countBeforeRequest ||
        performance.now() > this.countRequestUntil)
    ) {
      this.desiredCount = null;
    }
    this.bindings.count?.set(this.desiredCount ?? this.world.state.count);
    if (this.desiredDensity !== null && Math.abs(this.world.params.density - this.desiredDensity) < 1e-9) {
      this.desiredDensity = null;
    }
    this.bindings.density?.set(this.desiredDensity ?? this.world.params.density);
    this.bindings.thermostat?.set(this.world.params.thermostat);
    this.bindings.boundary?.set(this.world.params.boundary);
  }

  /**
   * Подписи концов легенды: во что превращается шкала 0…1 в текущей раскраске.
   *
   * Легенда обязана объяснять не только «от синего к красному», но и что
   * именно измеряется: без чисел «мин / макс» игрок не может связать цвет
   * с физической величиной (сообщение из отзыва: «не понятно, что за цвета
   * у частиц, что на них влияет»). Диапазон берётся из того же
   * `world.colorValues`, которым пользуется рендер, поэтому разойтись они
   * не могут.
   */
  private updateLegendValues(): void {
    if (!this.legendMin || !this.legendMax) return;
    const { min, max } = this.world.colorValues(this.state.view.colorMode);
    const mode = this.state.view.colorMode;
    const unit = mode === 'speed' ? 'σ/τ' : mode === 'travel' ? 'σ' : '';
    const text = (value: number): string => {
      if (mode === 'plain') return '—';
      const digits = Math.abs(value) >= 100 ? 0 : Math.abs(value) >= 10 ? 1 : 2;
      return unit ? `${value.toFixed(digits)} ${unit}` : value.toFixed(digits);
    };
    this.legendMin.textContent = text(min);
    this.legendMax.textContent = text(max);
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

    // Структурный фактор: у кристалла узкие пики, у жидкости широкий горб —
    // это самое наглядное отличие фаз на графике.
    const structure = this.world.structureFactor();
    drawStructure(this.plotS, structure.k, structure.s, {
      samples: this.world.structure.sampleCount,
      peak: this.world.structure.firstPeak(),
    });

    // MSD: по наклону кривой читается диффузия. Во время эксперимента здесь
    // показывается кривая перехода — она важнее, а MSD в этом режиме не
    // накапливается, потому что свип идёт своим миром.
    if (this.experiment) {
      const result = this.experiment.result();
      drawTransition(this.plotM, result.points, {
        branch: result.branch,
        progress: this.experiment.progress,
      });
    } else {
      const msd = this.world.msdCurve();
      const diffusion = this.world.diffusion();
      drawMsd(this.plotM, msd.lag, msd.msd, {
        D: diffusion.D,
        r2: diffusion.r2,
        lagRange: diffusion.lagRange,
        ready: this.world.msdReady,
        counts: msd.counts,
      });
    }
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
      /*
       * Скрипты проверки получают ЛОКАЛЬНЫЙ мир (`World`), а не зеркало.
       *
       * Это осознанно: smoke и showcase вызывают `resize`, `sampleRadial`,
       * `pokeNow` — то есть меняют физику, и должны видеть последствия
       * немедленно. Через зеркало это было бы невозможно: оно только для
       * чтения. Режим воркера проверяется ОТДЕЛЬНО, через `workerSelfTest`.
       */
      world: this.bridge.localWorld,
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
          this.bridge.setTemperature(value);
          this.syncControls();
        },
        setDensity: (value: number) => {
          this.bridge.setDensity(value);
          this.syncControls();
        },
        setThermostat: (value: string) => {
          this.bridge.setThermostat(value);
          this.syncControls();
        },
        setBoundary: (value: string) => {
          this.bridge.setBoundary(value);
          this.syncControls();
        },
        toggleRun: () => this.toggleRun(),
        stepOnce: () => this.stepOnce(),
        runSteps: (count: number) => {
          /*
           * Скрипты проверки гоняют шаги СИНХРОННО, и это правильно.
           *
           * В режиме воркера так нельзя: шаги там асинхронны, и «прогнать 200
           * шагов и сразу прочитать результат» не сработает. Поэтому API
           * проверок работает с локальным миром — см. комментарий к `world`
           * в этом же объекте. Для проверки воркера есть `workerSelfTest`.
           */
          this.bridge.advanceLocal(count, () => {
            this.tickSession();
            this.sampleIfDue(false);
          });
          this.updateHud();
          this.drawPlots();
        },
        openHelp: () => openHelp(),
        setBondRadius: (value: number) => {
          this.state.view.bondRadius = value;
          this.renderer.options.bondRadius = value;
          this.bridge.setBondRadius(value);
        },
        setShowBonds: (value: boolean) => {
          this.state.view.showBonds = value;
          this.renderer.options.showBonds = value;
        },
        msdCsv: () => {
          const curve = this.bridge.localWorld.msdCurve();
          return { lag: Array.from(curve.lag), msd: Array.from(curve.msd) };
        },
        /**
         * Снимок мира как JSON-строка — для сквозных проверок.
         *
         * Настоящее сохранение идёт через скачивание файла, а его в headless
         * браузере не перехватить. Здесь тот же самый код сериализации, так
         * что проверяется он, а не «похожий».
         */
        snapshotJson: () => serializeSnapshot(this.bridge.localWorld.snapshot()),
        /** Загрузить состояние из JSON-строки. Возвращает текст ошибки или null. */
        restoreJson: (text: string) => {
          const parsed = parseSnapshot(text);
          if (!parsed.ok) return parsed.error;
          this.bridge.localWorld.restore(parsed.loaded);
          this.afterRebuild();
          return null;
        },
        /** CSV-тексты для проверки формата. */
        historyCsv: () => {
          const history = this.world.history;
          const rows: HistoryRow[] = [];
          for (let i = 0; i < history.size; i++) {
            const sample = history.get(i);
            if (sample) rows.push({ ...sample });
          }
          return historyToCsv(rows);
        },
        radialCsv: () => {
          const { r, g } = this.world.radialDistribution();
          return radialToCsv(r, g, this.world.radial.sampleCount);
        },
        structureCsv: () => {
          const { k, s } = this.world.structureFactor();
          return structureToCsv(k, s, this.world.structure.sampleCount);
        },
        /** Запустить свип по температуре и довести его до конца. */
        runExperiment: (branch: 'heating' | 'cooling', config?: Partial<ExperimentConfig>) => {
          const experiment = new PhaseExperiment({
            count: 256,
            density: 0.95,
            temperatures: [0.9, 1.1, 1.2, 1.3, 1.4],
            equilibrate: 800,
            sample: 800,
            sampleEvery: 4,
            branch,
            lattice: 'fcc',
            ...config,
          });
          let guard = 0;
          while (!experiment.done && guard < 2000) {
            experiment.advance(5000);
            guard++;
          }
          const result = experiment.result();
          return {
            done: experiment.done,
            branch: result.branch,
            points: result.points.map((point) => ({
              temperature: point.temperature,
              energy: point.energy,
              heatCapacity: point.heatCapacity,
              measuredTemperature: point.measuredTemperature,
            })),
            transitionTemperature: result.transitionTemperature,
            peakHeatCapacity: result.peakHeatCapacity,
          };
        },
      },
      plots: {
        temperature: () => this.plotT,
        energy: () => this.plotE,
        radial: () => this.plotR,
        structure: () => this.plotS,
        msd: () => this.plotM,
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
        coordination: this.world.coordination,
        bondPairs: this.world.bondNetwork().pairCount,
        bondSpread: this.world.bondSpread,
        bondsDrawn: this.renderer.bondStatsSnapshot.drawn,
        diffusion: this.world.diffusion().D,
        diffusionR2: this.world.diffusion().r2,
        msdOrigins: this.world.msd.originCount,
        structurePeak: this.world.structure.firstPeak().height,
        structurePeakK: this.world.structure.firstPeak().k,
      }),
      boxLength: (count: number, density: number) => boxLength(count, density),
      /**
       * Разбивка времени кадра.
       *
       * Замеры уже ведутся для автоподстройки шагов, но наружу не выводились,
       * а без них нельзя ответить на вопрос «что именно тормозит»: физика,
       * отрисовка или статистика. Гадать об этом бессмысленно — стоимость
       * рендера связей растёт вместе с числом частиц и вполне может
       * перевесить расчёт сил.
       */
      timings: () => ({
        physicsMs: this.physicsMs,
        drawMs: this.drawMs,
        stepsPerFrame: this.state.stepsPerFrame,
        bondsDrawn: this.renderer.bondStatsSnapshot.drawn,
        /**
         * Очередь заказанных, но ещё не выполненных шагов.
         *
         * Это главный диагностический признак для режима воркера: растущая
         * очередь означает, что главный поток заказывает быстрее, чем воркер
         * считает. Именно так выглядела регрессия с неработающей паузой, и
         * без этого числа её нельзя было бы заметить до жалобы игрока.
         */
        workerBacklog: this.bridge.backlog,
        /** Стоимость шага, измеренная воркером (мс); 0 вне режима воркера. */
        stepCostMs: this.bridge.stepCostMs,
      }),
      /**
       * Замер отрисовки в отрыве от физики: N отрисовок подряд.
       *
       * Нужен, чтобы отделить стоимость рендера от стоимости шага. В обычном
       * цикле они перемешаны, и по `frameMs` нельзя понять, что оптимизировать.
       */
      measureDraw: (frames: number) => {
        let particles = 0;
        let bonds = 0;
        let total = 0;
        for (let i = 0; i < frames; i++) {
          const stats = this.renderer.render(this.world, null);
          total += stats.frameMs;
          particles = stats.drawn;
        }
        bonds = this.renderer.bondStatsSnapshot.drawn;
        return { msPerFrame: total / Math.max(1, frames), particles, bonds };
      },
      workerSelfTest: (steps?: number) => PhysicsBridge.selfTest(steps),
      /**
       * Диагностика физики: где считается и что происходит с очередью.
       *
       * Нужна инструментам проверки (`smoke`, `showcase`, профилировщику).
       * Считать это «отладочным мусором» нельзя: регрессия с неработающей
       * паузой была видна РОВНО здесь — как растущая очередь заказанных
       * шагов, — а `metrics()` её не показывал вовсе. Без этого числа дефект
       * снова прошёл бы незамеченным до жалобы игрока.
       */
      workerDiagnostics: () => {
        const status = this.bridge.status();
        return {
          mode: status.mode,
          workerReady: status.ready,
          framesReceived: status.framesReceived,
          error: status.error,
          /** Очередь заказанных, но не выполненных шагов. */
          backlog: this.bridge.backlog,
          /** Стоимость шага по замеру воркера (мс). */
          stepCostMs: this.bridge.stepCostMs,
          /** Монотонный счётчик выполненных шагов. */
          stepsExecuted: this.world.stepsExecuted,
          /** Число шагов на кадр, выбранное автоподстройкой. */
          stepsPerFrame: this.state.stepsPerFrame,
          paused: this.paused,
          /*
           * Статистика МИРА ДЛЯ ЧТЕНИЯ (в режиме воркера — зеркала).
           *
           * Именно эти числа рисуются на графиках, и в режиме воркера их
           * источник другой, чем локальный мир (`api().world` — это ЛОКАЛЬНЫЙ
           * мир, он стоит на месте). Без этих полей проверить, что графики
           * наполняются, было нельзя: замер по локальному миру показывал
           * нули и выглядел как «графики не работают».
           */
          historyPoints: this.world.history.size,
          radialSamples: this.world.radial.sampleCount,
          structureSamples: this.world.structure.sampleCount,
          msdOrigins: this.world.msd.originCount,
        };
      },
      /**
       * Вернуть физику в главный поток.
       *
       * Нужно инструментам проверки. Скрипты (smoke, showcase) МЕНЯЮТ мир:
       * вызывают `resize`, `pokeNow`, `sampleRadial` и сразу читают
       * результат. В режиме воркера это невозможно: изменения уходят
       * асинхронно, а рендер показывает зеркало последнего кадра, то есть
       * ДРУГОЙ мир. Проверять это было бы проверкой рассинхрона, а не
       * физики.
       *
       * Поэтому скрипты явно переводят приложение в локальный режим и
       * проверяют его как раньше, а работа воркера проверяется отдельно —
       * методом `workerSelfTest`.
       */
      useLocalPhysics: () => {
        this.bridge.disableWorker();
      },
      /** Где сейчас считается физика. */
      physicsMode: () => this.bridge.status().mode,
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
    /** Сменить радиус связей (и перестроить сеть). */
    setBondRadius(value: number): void;
    /** Включить или выключить слой связей. */
    setShowBonds(value: boolean): void;
    /** Кривая MSD (лаг и смещение) — для проверок. */
    msdCsv(): { lag: number[]; msd: number[] };
    /** Сериализованный снимок мира (JSON-строка). */
    snapshotJson(): string;
    /** Восстановить мир из JSON; возвращает текст ошибки или null при успехе. */
    restoreJson(text: string): string | null;
    /** История измерений в формате CSV. */
    historyCsv(): string;
    /** Радиальная функция g(r) в формате CSV. */
    radialCsv(): string;
    /** Структурный фактор S(k) в формате CSV. */
    structureCsv(): string;
    /** Провести свип по температуре и вернуть его результат. */
    runExperiment(
      branch: 'heating' | 'cooling',
      config?: Partial<ExperimentConfig>,
    ): {
      done: boolean;
      branch: string;
      points: Array<{
        temperature: number;
        energy: number;
        heatCapacity: number;
        measuredTemperature: number;
      }>;
      transitionTemperature: number;
      peakHeatCapacity: number;
    };
  };
  plots: {
    temperature(): HTMLCanvasElement;
    energy(): HTMLCanvasElement;
    radial(): HTMLCanvasElement;
    /** График структурного фактора S(k). */
    structure(): HTMLCanvasElement;
    /** График среднеквадратичного смещения MSD. */
    msd(): HTMLCanvasElement;
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
    /** Среднее число связей на частицу (координационное число). */
    coordination: number;
    /** Число пар в сети связей. */
    bondPairs: number;
    /** Разброс длин связей относительно 2^(1/6)σ. */
    bondSpread: number;
    /** Сколько связей реально нарисовано в последнем кадре. */
    bondsDrawn: number;
    /** Коэффициент самодиффузии D из MSD. */
    diffusion: number;
    /** Качество линейной подгонки MSD (коэффициент детерминации). */
    diffusionR2: number;
    /** Сколько начал отсчёта накоплено для MSD. */
    msdOrigins: number;
    /** Высота первого пика S(k). */
    structurePeak: number;
    /** Волновое число первого пика S(k). */
    structurePeakK: number;
  };
  boxLength(count: number, density: number): number;
  /** Разбивка времени кадра: физика, отрисовка, число шагов. */
  timings(): {
    physicsMs: number;
    drawMs: number;
    stepsPerFrame: number;
    bondsDrawn: number;
    /** Очередь заказанных, но не выполненных шагов (режим воркера). */
    workerBacklog: number;
    /** Стоимость шага по замеру воркера, мс (0 вне режима воркера). */
    stepCostMs: number;
  };
  /** Замер только отрисовки, без шагов физики. */
  measureDraw(frames: number): { msPerFrame: number; particles: number; bonds: number };
  /**
   * Самопроверка воркера физики «на живом».
   *
   * Поднимает настоящий воркер, гоняет шаги и возвращает сводку. Нужна
   * сквозной проверке в браузере: юнит-тесты подставляют подставной порт и
   * потому не доказывают, что Vite собрал модуль воркера и что обмен
   * кадрами работает в реальной среде.
   */
  workerSelfTest(steps?: number): Promise<{ ok: boolean; error?: string; summary?: unknown }>;
  /** Диагностика физики: режим, очередь заказанных шагов, стоимость шага. */
  workerDiagnostics(): {
    mode: 'worker' | 'local';
    workerReady: boolean;
    framesReceived: number;
    error: string | null;
    backlog: number;
    stepCostMs: number;
    stepsExecuted: number;
    stepsPerFrame: number;
    paused: boolean;
    /** Точки истории на графиках T и E — из мира ДЛЯ ЧТЕНИЯ. */
    historyPoints: number;
    /** Кадры статистики g(r). */
    radialSamples: number;
    /** Кадры статистики S(k). */
    structureSamples: number;
    /** Число начал отсчёта MSD. */
    msdOrigins: number;
  };
  /**
   * Вернуть физику в главный поток — для инструментов проверки.
   *
   * Скрипты меняют мир синхронно и сразу читают результат; в режиме воркера
   * это невозможно. Работа воркера проверяется отдельно, `workerSelfTest`.
   */
  useLocalPhysics(): void;
  /** Где сейчас считается физика. */
  physicsMode(): 'worker' | 'local';
}
