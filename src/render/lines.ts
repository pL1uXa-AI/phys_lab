/**
 * Слой линий на PixiJS.
 *
 * Поверх частиц нужно рисовать три разных набора отрезков: связи ближних
 * соседей, шлейфы траекторий и векторы скоростей. Все три — это «отрезок
 * между двумя точками экрана», и различаются только цветом и толщиной.
 *
 * Реализация одна на всех: `ParticleContainer` с текстурой вытянутого
 * прямоугольника. Это не «обычные» спрайты, а батч — десятки тысяч линий
 * рисуются за один вызов отрисовки. Альтернатива (`Graphics` с `moveTo`/
 * `lineTo`) перестраивала бы геометрию на CPU каждый кадр и на 20 000
 * частиц не тянет вовсе.
 *
 * ─── Что важно про этот API ──────────────────────────────────────────────
 *
 *   - у `Particle` нет `visible`: скрыть отрезок можно только нулевым
 *     масштабом или прозрачностью;
 *   - в `dynamicProperties` обязателен `rotation`, иначе все отрезки
 *     останутся горизонтальными и решётка превратится в штриховку;
 *   - спрайты переиспользуются: пул растёт по мере надобности, а лишние
 *     каждый кадр гасятся прозрачностью, а не удаляются.
 */

import { Particle, ParticleContainer, Texture } from 'pixi.js';
import type { SegmentBuffer } from './trails.js';

/** Длина текстуры отрезка в пикселях. */
const TEXTURE_LENGTH = 64;
/** Толщина текстуры отрезка в пикселях. */
const TEXTURE_THICKNESS = 4;

/**
 * Потолок числа отрезков в одном слое.
 *
 * Верхняя граница нужна не «на всякий случай»: на 20 000 частиц с
 * координационным числом 12 связей выходит 120 000, и без ограничения
 * память под спрайты растёт неконтролируемо, а пользы от такого количества
 * линий нет — они сливаются в заливку.
 */
export const MAX_SEGMENTS = 60000;

/** Что нужно знать слою, чтобы нарисовать кадр. */
export interface LineDrawOptions {
  /** Цвет линий (CSS-строка или число). */
  color: string | number;
  /** Толщина в пикселях. */
  thickness: number;
  /** Прозрачность. */
  alpha?: number;
  /** Проекция мировой точки в экранные пиксели. */
  project(x: number, y: number, z: number): { x: number; y: number };
}

/** Слой отрезков. */
export class LineLayer {
  private readonly container: ParticleContainer;
  private readonly sprites: Particle[] = [];
  private allocated = 0;
  private readonly texture: Texture;

  constructor() {
    this.texture = makeSegmentTexture();
    this.container = new ParticleContainer({
      // `rotation` обязателен: без него все отрезки горизонтальны.
      dynamicProperties: { position: true, rotation: true, vertex: true, color: true },
    });
  }

  /** Контейнер для вставки в сцену. */
  get view(): ParticleContainer {
    return this.container;
  }

  /** Сколько спрайтов выделено. */
  get spriteCount(): number {
    return this.allocated;
  }

  /**
   * Спрайты слоя — для сквозных проверок в браузере.
   *
   * Открыто наружу намеренно: ориентацию отрезков иначе не проверить. Дефект
   * «забыли `rotation` в dynamicProperties`» не виден ни в типах, ни в
   * юнит-тестах, а на экране даёт штриховку вместо решётки.
   */
  get segmentSprites(): readonly Particle[] {
    return this.sprites;
  }

  /**
   * Отрисовка набора отрезков.
   *
   * @param buffer  отрезки в МИРОВЫХ координатах
   * @param options цвет, толщина и функция проекции
   * @returns       сколько отрезков нарисовано
   */
  draw(buffer: SegmentBuffer, options: LineDrawOptions): number {
    const total = Math.min(buffer.count, MAX_SEGMENTS);
    if (total === 0) {
      this.hideAll();
      return 0;
    }
    this.ensure(total);

    const data = buffer.data;
    const alpha = options.alpha ?? 1;
    let drawn = 0;

    for (let k = 0; k < total; k++) {
      const base = k * 6;
      const p1 = options.project(data[base], data[base + 1], data[base + 2]);
      const p2 = options.project(data[base + 3], data[base + 4], data[base + 5]);
      const dx = p2.x - p1.x;
      const dy = p2.y - p1.y;
      const length = Math.hypot(dx, dy);
      // Слишком короткий отрезок превращается в мигающую точку — пропускаем.
      if (length < 0.6) continue;

      const sprite = this.sprites[drawn];
      sprite.x = (p1.x + p2.x) * 0.5;
      sprite.y = (p1.y + p2.y) * 0.5;
      sprite.rotation = Math.atan2(dy, dx);
      sprite.scaleX = length / TEXTURE_LENGTH;
      sprite.scaleY = options.thickness / TEXTURE_THICKNESS;
      sprite.alpha = alpha;
      sprite.tint = options.color;
      drawn++;
    }
    for (let i = drawn; i < this.allocated; i++) this.sprites[i].alpha = 0;
    return drawn;
  }

  /** Погасить все отрезки слоя. */
  hideAll(): void {
    for (let i = 0; i < this.allocated; i++) this.sprites[i].alpha = 0;
  }

  /** Рост пула: выделяем пачкой, чтобы не пересобирать буферы каждый кадр. */
  private ensure(count: number): void {
    if (count <= this.allocated) return;
    const target = Math.min(MAX_SEGMENTS, Math.ceil(count * 1.25));
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
    this.container.addParticle(...added);
    this.container.update();
  }

  /** Уничтожение слоя. */
  destroy(): void {
    this.container.destroy();
    this.texture.destroy(true);
    this.sprites.length = 0;
    this.allocated = 0;
  }
}

/**
 * Текстура отрезка: вытянутый прямоугольник с мягкими краями.
 *
 * Центр текстуры совпадает с центром отрезка — поэтому привязка 0.5 и
 * поворот вокруг середины работают как надо. Мягкие края по вертикали
 * убирают ступеньки на стыках линий с частицами.
 */
export function makeSegmentTexture(length = TEXTURE_LENGTH, thickness = TEXTURE_THICKNESS): Texture {
  const canvas = document.createElement('canvas');
  canvas.width = length;
  canvas.height = thickness;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Не удалось получить 2D-контекст для текстуры отрезка');
  const gradient = ctx.createLinearGradient(0, 0, 0, thickness);
  gradient.addColorStop(0, 'rgba(255,255,255,0)');
  gradient.addColorStop(0.25, 'rgba(255,255,255,1)');
  gradient.addColorStop(0.75, 'rgba(255,255,255,1)');
  gradient.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, length, thickness);
  return Texture.from(canvas);
}
