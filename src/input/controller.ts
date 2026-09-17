/**
 * Управление мышью и клавиатурой.
 *
 * Задача контроллера — перевести события указателя в физические действия:
 * протяжка мышью толкает частицы, колесо меняет масштаб, правая кнопка
 * вращает сцену. Никакой физики здесь нет.
 *
 * Две тонкости, из-за которых такой код часто работает «почти правильно»:
 *
 *   1. Координаты указателя нужно переводить в мировые через камеру, а не
 *      через размер канваса: сцена масштабируется и панорамируется.
 *   2. Проекция трёхмерная, а указатель двумерный. Толчок поэтому задаётся
 *      в плоскости экрана, а третью компоненту получает только сфера захвата.
 *      Для «потыкать и посмотреть на отклик» этого достаточно и не требует
 *      raycasting по всем частицам.
 */

import type { SceneRenderer } from '../render/scene.js';
import type { PhysicsView } from '../core/physics-view.js';

/** Что делает контроллер. */
export interface InputActions {
  onPoke(x: number, y: number, dx: number, dy: number): void;
  onFreeze(x: number, y: number): void;
  onUnfreeze(x: number, y: number): void;
  onToggleRun(): void;
  onReset(): void;
  onStep(): void;
  onHelp(): void;
}

/** Режим указателя. */
type DragMode = 'none' | 'poke' | 'rotate' | 'pan';

/**
 * Контроллер ввода.
 *
 * `frozenRing` — текущая кисть заморозки; рендер рисует её по этому полю,
 * чтобы игрок видел, куда попадёт. Поле публичное: это часть контракта
 * между вводом и отрисовкой.
 */
export class InputController {
  readonly actions: InputActions;
  readonly renderer: SceneRenderer;
  readonly world: PhysicsView;

  /** Кисть: где и какого радиуса (в σ) будет воздействие. */
  brush = { x: 0, y: 0, radius: 3, active: false };

  /** Радиус кисти в единицах σ. */
  brushRadius = 3;

  /** Сила толчка. */
  pokeStrength = 3.4;

  /** Режим левой кнопки: толкать или замораживать. */
  tool: 'poke' | 'freeze' | 'unfreeze' = 'poke';

  private dragging: DragMode = 'none';
  private lastX = 0;
  private lastY = 0;
  private readonly element: HTMLElement;
  private readonly disposers: Array<() => void> = [];

  constructor(element: HTMLElement, renderer: SceneRenderer, world: PhysicsView, actions: InputActions) {
    this.element = element;
    this.renderer = renderer;
    this.world = world;
    this.actions = actions;
    this.attach();
  }

  private attach(): void {
    const el = this.element;
    const on = <K extends keyof HTMLElementEventMap>(
      type: K,
      handler: (event: HTMLElementEventMap[K]) => void,
      options?: AddEventListenerOptions,
    ): void => {
      el.addEventListener(type, handler as EventListener, options);
      this.disposers.push(() => el.removeEventListener(type, handler as EventListener));
    };

    on('pointerdown', (event) => this.onPointerDown(event));
    on('pointermove', (event) => this.onPointerMove(event));
    on('pointerup', (event) => this.onPointerUp(event));
    on('pointerleave', () => this.onPointerLeave());
    on('wheel', (event) => this.onWheel(event), { passive: false });
    on('contextmenu', (event) => event.preventDefault());

    const onKey = (event: KeyboardEvent): void => this.onKeyDown(event);
    window.addEventListener('keydown', onKey);
    this.disposers.push(() => window.removeEventListener('keydown', onKey));
  }

  /** Локальные координаты указателя внутри элемента. */
  private local(event: PointerEvent | WheelEvent): { x: number; y: number } {
    const rect = this.element.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  private onPointerDown(event: PointerEvent): void {
    // Захват указателя может не сработать (синтетическое событие, указатель
    // уже отпущен) и бросить DOMException. Ронять из-за этого весь обработчик
    // нельзя: вместе с ним терялось бы и действие кнопки. Поэтому — try.
    try {
      this.element.setPointerCapture?.(event.pointerId);
    } catch {
      // Захват недоступен — работаем без него.
    }
    const { x, y } = this.local(event);
    this.lastX = x;
    this.lastY = y;

    if (event.button === 2) {
      this.dragging = 'rotate';
      return;
    }
    if (event.button === 1 || event.shiftKey) {
      this.dragging = 'pan';
      return;
    }
    if (event.button !== 0) return;

    const world = this.toWorld(x, y);
    if (this.tool === 'freeze') {
      this.actions.onFreeze(world.x, world.y);
      this.dragging = 'none';
      return;
    }
    if (this.tool === 'unfreeze') {
      this.actions.onUnfreeze(world.x, world.y);
      this.dragging = 'none';
      return;
    }
    this.dragging = 'poke';
    this.brush = { x: world.x, y: world.y, radius: this.brushRadius, active: true };
  }

  private onPointerMove(event: PointerEvent): void {
    const { x, y } = this.local(event);
    const dx = x - this.lastX;
    const dy = y - this.lastY;
    this.lastX = x;
    this.lastY = y;

    const world = this.toWorld(x, y);
    this.brush.x = world.x;
    this.brush.y = world.y;
    this.brush.radius = this.brushRadius;
    this.brush.active = true;

    switch (this.dragging) {
      case 'rotate':
        // Поворот: по горизонтали — вокруг вертикальной оси, по вертикали —
        // наклон. Масштаб делим, чтобы вращение не зависело от зума.
        this.renderer.camera.rotate(dx * 0.006, dy * 0.006);
        break;
      case 'pan':
        this.renderer.camera.pan(dx, dy);
        break;
      case 'poke':
        this.actions.onPoke(world.x, world.y, dx, -dy);
        break;
      default:
        break;
    }
  }

  private onPointerUp(event: PointerEvent): void {
    this.dragging = 'none';
    try {
      this.element.releasePointerCapture?.(event.pointerId);
    } catch {
      // Указатель не был захвачен — освобождать нечего.
    }
  }

  private onPointerLeave(): void {
    this.brush.active = false;
  }

  private onWheel(event: WheelEvent): void {
    event.preventDefault();
    const { x, y } = this.local(event);
    // Нормализация: у разных устройств deltaY отличается на порядки.
    const factor = Math.exp(-event.deltaY * 0.0012);
    this.renderer.camera.zoomAt(x, y, factor);
  }

  private onKeyDown(event: KeyboardEvent): void {
    // Не перехватываем ввод в полях.
    const target = event.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
    switch (event.key) {
      case ' ':
        event.preventDefault();
        this.actions.onToggleRun();
        break;
      case 'r':
      case 'R':
      case 'к':
      case 'К':
        this.actions.onReset();
        break;
      case '.':
      case '>':
        this.actions.onStep();
        break;
      case 'h':
      case 'H':
      case 'р':
      case 'Р':
        this.actions.onHelp();
        break;
      default:
        break;
    }
  }

  /**
   * Экран → координаты проекции.
   *
   * Обратите внимание: возвращается ПЛОСКАЯ точка. Толчок применяется ко всем
   * частицам внутри цилиндра (а не шара) вдоль оси взгляда — иначе, потянув
   * мышью «мимо» кристалла по глубине, игрок не увидел бы никакой реакции.
   */
  private toWorld(x: number, y: number): { x: number; y: number } {
    return this.renderer.camera.screenToWorld(x, y);
  }

  /** Освобождение слушателей. */
  destroy(): void {
    for (const dispose of this.disposers) dispose();
    this.disposers.length = 0;
  }
}
