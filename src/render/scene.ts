/**
 * Рендер частиц на PixiJS.
 *
 * ─── Как рисуем ──────────────────────────────────────────────────────────
 *
 * Частицы — это `Particle` в одном `ParticleContainer`. Это не «обычные»
 * спрайты: контейнер собирает их в один батч и обновляет свойства напрямую
 * в типизированных буферах, поэтому 10 000 частиц рисуются за один вызов.
 * Текстура кружка печётся один раз, цвет задаётся через `tint`.
 *
 * ─── Что важно помнить про этот API ──────────────────────────────────────
 *
 *   1. У `Particle` НЕТ свойства `visible` и НЕТ `scale`/`alpha` как у
 *      Container: есть `scaleX`/`scaleY`, `alpha` и `tint`. Скрыть частицу
 *      можно только нулевым масштабом или прозрачностью — что мы и делаем.
 *   2. Список `dynamicProperties` задаёт, какие атрибуты пересчитываются
 *      каждый кадр. Если включить лишние, платим за них; если забыть нужный
 *      (например, `color`), частицы «застынут» в первом цвете.
 *   3. Глубина (координата z после поворота) управляет размером и
 *      прозрачностью: дальние частицы меньше и бледнее. Это даёт ощущение
 *      объёма без настоящей перспективной матрицы.
 */

import {
  Application,
  Graphics,
  Particle,
  ParticleContainer,
  Texture,
} from 'pixi.js';
import type { ColorMode } from '../core/types.js';
import type { World } from '../core/world.js';
import { Camera } from './camera.js';
import { colorFor, FROZEN_COLOR, WALL_COLOR } from './palette.js';

/** Максимальное число частиц в буфере проекции. */
const MAX_PROJECTED = 60000;

/** Сколько частиц рисуется максимум: выше начинается «каша» из пикселей. */
const DRAW_LIMIT = 40000;

/** Радиус кружка в текстуре (пиксели). */
const TEXTURE_SIZE = 32;

/** Результат одного кадра отрисовки. */
export interface RenderStats {
  drawn: number;
  frameMs: number;
}

/** Настройки отрисовки, меняемые из интерфейса. */
export interface RenderOptions {
  colorMode: ColorMode;
  showWalls: boolean;
  particleScale: number;
  depthShading: boolean;
  brushRadius: number;
}

/** Сцена: частицы и служебный слой. */
export class SceneRenderer {
  readonly app: Application;
  readonly camera = new Camera();

  options: RenderOptions = {
    colorMode: 'speed',
    showWalls: true,
    particleScale: 1,
    depthShading: true,
    brushRadius: 3,
  };

  private particles!: ParticleContainer;
  private overlay!: Graphics;
  private readonly sprites: Particle[] = [];
  private texture!: Texture;
  private projected = new Float32Array(MAX_PROJECTED * 3);
  private allocated = 0;
  private lastDrawn = 0;

  constructor(app: Application) {
    this.app = app;
  }

  /** Инициализация сцены. Вызывается один раз после `app.init`. */
  init(mount: HTMLElement): void {
    this.camera.fit(10, this.app.renderer.width, this.app.renderer.height);

    this.texture = makeCircleTexture(TEXTURE_SIZE);

    // Канвас обязан оказаться в разметке: `new Application()` создаёт его,
    // но НЕ вставляет в документ. Без этой строки приложение считает кадры,
    // а на экране пусто — и заметить это можно только в настоящем браузере.
    mount.append(this.app.canvas);
    // Канвас — блочный элемент, растягиваемый по контейнеру; CSS-размер
    // задаётся стилями `.stage canvas`, а буфер подгоняется в `resize`.
    this.app.canvas.style.display = 'block';
    this.app.canvas.style.width = '100%';
    this.app.canvas.style.height = '100%';

    this.overlay = new Graphics();
    this.app.stage.addChild(this.overlay);

    this.particles = new ParticleContainer({
      // Позиция, вершины и цвет меняются каждый кадр; поворот и UV — нет.
      // Если забыть `color`, частицы останутся в цвете первого кадра.
      dynamicProperties: { position: true, vertex: true, color: true },
    });
    this.app.stage.addChild(this.particles);
  }

  /** Подгонка камеры под ящик при изменении размера области просмотра. */
  resize(width: number, height: number, box: number): void {
    this.app.renderer.resize(width, height);
    this.camera.fit(box, width, height);
  }

  /**
   * Отрисовка одного кадра.
   *
   * @param world       состояние симуляции
   * @param brush       кисть воздействия (рисуется кольцом) или null
   */
  render(world: World, brush: { x: number; y: number; radius: number } | null = null): RenderStats {
    const started = performance.now();
    const count = Math.min(world.state.count, DRAW_LIMIT);
    this.ensureSprites(count);

    // Проекция считается в мире, камера только масштабирует.
    world.project(this.camera.yaw, this.camera.pitch, this.projected);
    const color = world.colorValues(this.options.colorMode);

    const halfDiagonal = world.box * 1.1;
    /**
     * Радиус частицы в единицах σ.
     *
     * Раньше он выводился из объёма, приходящегося на частицу, и на плотном
     * кристалле получался ~0.38σ — почти вплотную к половине межатомного
     * расстояния. Сферы сливались в сплошное пятно, и решётку было не видно.
     *
     * Теперь радиус — фиксированная доля σ, независимая от числа частиц:
     * при ρ* = 0.95 соседние атомы стоят на 1.02σ, и радиус 0.3σ оставляет
     * между ними просвет. Именно так кристалл читается как решётка, а не
     * как каша. Для разрежённого газа частицы при этом выглядят мелкими —
     * это правильно, они и физически далеко друг от друга.
     */
    const radiusBase = 0.3;
    const scale = this.camera.scale * this.options.particleScale;

    let drawn = 0;
    for (let i = 0; i < count; i++) {
      const sprite = this.sprites[i];
      if (world.state.alive[i] === 0) {
        sprite.alpha = 0;
        continue;
      }
      const px = this.projected[i * 3];
      const py = this.projected[i * 3 + 1];
      const pz = this.projected[i * 3 + 2];
      if (px < -halfDiagonal || px > halfDiagonal || py < -halfDiagonal || py > halfDiagonal) {
        sprite.alpha = 0;
        continue;
      }
      const screen = this.camera.worldToScreen(px, py);
      const depth = depthFactor(pz, world.box);
      const diameter = radiusBase * scale * depth;

      // Частица меньше половины пикселя превращается в шум: рисуем её
      // прозрачной, а не мигающей точкой.
      if (diameter < 0.5) {
        sprite.alpha = 0;
        continue;
      }
      sprite.x = screen.x;
      sprite.y = screen.y;
      // Текстура кружка имеет диаметр TEXTURE_SIZE пикселей.
      const factor = (diameter * 2) / TEXTURE_SIZE;
      sprite.scaleX = factor;
      sprite.scaleY = factor;
      /*
       * Прозрачность.
       *
       * Раньше дальние частицы были полупрозрачными (0.5…1.0), и это оказалось
       * главной причиной «белёсого» вида: в трёхмерной проекции вдоль луча
       * зрения стоят десятки атомов, их полупрозрачные края складываются,
       * и всё сливается в туман. Атомы должны быть непрозрачными — глубину
       * передаёт размер, а не прозрачность.
       *
       * Небольшое затемнение дальних частиц оставлено (нижняя граница 0.82):
       * его достаточно для ощущения объёма и мало для тумана.
       */
      sprite.alpha = this.options.depthShading ? 0.82 + 0.18 * depth : 1;
      sprite.tint = world.frozen[i] !== 0
        ? FROZEN_COLOR
        : colorFor(this.options.colorMode, (color.values[i] - color.min) / (color.max - color.min));
      drawn++;
    }
    for (let i = count; i < this.allocated; i++) this.sprites[i].alpha = 0;
    this.lastDrawn = drawn;

    this.drawOverlay(world, brush);

    return { drawn, frameMs: performance.now() - started };
  }

  /** Сколько частиц нарисовано в последнем кадре. */
  get drawnCount(): number {
    return this.lastDrawn;
  }

  /** Стенки ящика и кисть. */
  private drawOverlay(world: World, brush: { x: number; y: number; radius: number } | null): void {
    const g = this.overlay;
    g.clear();

    if (this.options.showWalls && world.params.boundary !== 'periodic') {
      for (const [a, b] of boxEdges(world.box)) {
        const p1 = this.projectPoint(world, a);
        const p2 = this.projectPoint(world, b);
        g.moveTo(p1.x, p1.y);
        g.lineTo(p2.x, p2.y);
      }
      g.stroke({ width: 1, color: WALL_COLOR, alpha: 0.85 });
    }

    if (brush) {
      // ВАЖНО: `brush` приходит в мировых координатах проекции, а Graphics
      // рисует в координатах сцены, то есть в пикселях. Раньше сюда попадали
      // мировые числа напрямую, и кольцо кисти приклеивалось к левому краю
      // сцены в виде огромной дуги. Координаты обязаны пройти через камеру.
      const screen = this.camera.worldToScreen(brush.x, brush.y);
      const radiusPixels = brush.radius * this.camera.scale;
      g.circle(screen.x, screen.y, radiusPixels);
      g.stroke({ width: 1.5, color: 0x8fb8e8, alpha: 0.6 });
    }
  }

  /** Проекция произвольной точки мира на экран. */
  projectPoint(world: World, point: readonly [number, number, number]): { x: number; y: number } {
    const center = world.box * 0.5;
    const ax = point[0] - center;
    const ay = point[1] - center;
    const az = point[2] - center;
    const cosY = Math.cos(this.camera.yaw);
    const sinY = Math.sin(this.camera.yaw);
    const cosP = Math.cos(this.camera.pitch);
    const sinP = Math.sin(this.camera.pitch);
    const rx = ax * cosY - az * sinY;
    const rz = ax * sinY + az * cosY;
    const ry = ay * cosP - rz * sinP;
    return this.camera.worldToScreen(rx, ry);
  }

  /** Рост пула спрайтов. Выделяем с запасом, чтобы не делать это каждый кадр. */
  private ensureSprites(count: number): void {
    if (count <= this.allocated) return;
    const target = Math.min(MAX_PROJECTED, Math.ceil(count * 1.25));
    const added: Particle[] = [];
    for (let i = this.allocated; i < target; i++) {
      const particle = new Particle({
        texture: this.texture,
        anchorX: 0.5,
        anchorY: 0.5,
        alpha: 0,
      });
      this.sprites.push(particle);
      added.push(particle);
    }
    this.allocated = target;
    // Добавляем пачкой и один раз просим контейнер пересобрать буферы:
    // добавление по одному делало бы это на каждой частице.
    this.particles.addParticle(...added);
    this.particles.update();
    if (this.projected.length < target * 3) {
      this.projected = new Float32Array(target * 3);
    }
  }

  /** Сколько спрайтов выделено — для панелей и тестов. */
  get spriteCount(): number {
    return this.allocated;
  }

  /** Уничтожение сцены. */
  destroy(): void {
    this.particles?.destroy();
    this.overlay?.destroy();
    this.texture?.destroy(true);
    this.sprites.length = 0;
    this.allocated = 0;
  }
}

/** Приведение z к множителю размера в диапазоне ≈ [0.8, 1.2]. */
function depthFactor(z: number, box: number): number {
  const span = box * 0.9;
  const t = span > 0 ? z / span : 0;
  return 1 + 0.2 * Math.max(-1, Math.min(1, t));
}

/** Рёбра куба ящика — список пар точек. */
function boxEdges(box: number): Array<[[number, number, number], [number, number, number]]> {
  const v: Array<[number, number, number]> = [
    [0, 0, 0],
    [box, 0, 0],
    [box, box, 0],
    [0, box, 0],
    [0, 0, box],
    [box, 0, box],
    [box, box, box],
    [0, box, box],
  ];
  const pairs: Array<[number, number]> = [
    [0, 1],
    [1, 2],
    [2, 3],
    [3, 0],
    [4, 5],
    [5, 6],
    [6, 7],
    [7, 4],
    [0, 4],
    [1, 5],
    [2, 6],
    [3, 7],
  ];
  return pairs.map(([a, b]) => [v[a], v[b]]);
}

/**
 * Текстура круглой частицы.
 *
 * Край делается мягким всего на волосок — примерно на один пиксель из
 * тридцати двух. Первая версия имела широкий градиент (30 % радиуса), и это
 * оказалось плохим решением: в трёхмерной проекции вдоль луча зрения
 * выстраиваются десятки частиц, полупрозрачные края накладываются друг на
 * друга, и кристалл превращается в белёсое пятно — что и было видно на
 * скриншоте. Атом должен быть плотным диском, а не размытым шариком.
 */
function makeCircleTexture(size: number): Texture {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Не удалось получить 2D-контекст для текстуры частицы');
  const center = size / 2;
  const radius = size / 2 - 1;
  const gradient = ctx.createRadialGradient(center, center, 0, center, center, radius);
  gradient.addColorStop(0, 'rgba(255,255,255,1)');
  gradient.addColorStop(0.86, 'rgba(255,255,255,1)');
  gradient.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.arc(center, center, radius, 0, Math.PI * 2);
  ctx.fill();
  return Texture.from(canvas);
}
