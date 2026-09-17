/**
 * Камера сцены: перевод «мир ↔ экран».
 *
 * Мир трёхмерный, а проекция на экран выполняется в `World.project`.
 * Камера отвечает только за масштаб и сдвиг — и обязана делать это обратимо,
 * иначе клики мышью перестанут попадать в частицы.
 *
 * Здесь же задаются ориентация (yaw/pitch) и поворот по крену, чтобы можно
 * было облететь кристалл и посмотреть на него сбоку: фазовые переходы
 * в проекции «сверху» выглядят куда беднее, чем в перспективе.
 */

/** Ориентация камеры в радианах. */
export interface CameraAngles {
  /** Поворот вокруг вертикальной оси. */
  yaw: number;
  /** Наклон: 0 — вид сбоку, π/2 — вид сверху. */
  pitch: number;
}

/** Цвет неба/глубины сцены по расстоянию до камеры. */
export const CAMERA_DEFAULTS: CameraAngles = {
  yaw: 0.6,
  pitch: 0.9,
};

/** Камера: масштаб (пикселей на σ) и смещение центра мира на экране. */
export class Camera {
  /** Масштаб: сколько пикселей приходится на единицу длины σ. */
  scale = 40;
  /** Положение центра ящика в пикселях канваса. */
  centerX = 0;
  centerY = 0;

  /** Ориентация. */
  yaw = CAMERA_DEFAULTS.yaw;
  pitch = CAMERA_DEFAULTS.pitch;

  /** Размер области просмотра в пикселях. */
  width = 800;
  height = 600;

  /** Сколько пикселей приходится на единицу длины при текущей ориентации. */
  get pixelsPerUnit(): number {
    return this.scale;
  }

  /** Подгонка камеры под ящик: вписать его целиком с небольшим полем. */
  fit(box: number, width: number, height: number, margin = 1.12): void {
    this.width = width;
    this.height = height;
    this.centerX = width * 0.5;
    this.centerY = height * 0.5;
    // Диагональ ящика — верхняя оценка видимого размера при любом повороте:
    // гарантирует, что кристалл целиком попадёт в кадр.
    const diagonal = box * Math.sqrt(3);
    const target = Math.min(width, height) / (diagonal * margin);
    this.scale = target;
  }

  /** Мировые координаты (проекция, в σ) → пиксели канваса. */
  worldToScreen(px: number, py: number): { x: number; y: number } {
    return {
      x: this.centerX + px * this.scale,
      // Ось Y экрана направлена вниз, а мира — вверх: инвертируем.
      y: this.centerY - py * this.scale,
    };
  }

  /** Пиксели канваса → координаты проекции. */
  screenToWorld(sx: number, sy: number): { x: number; y: number } {
    return {
      x: (sx - this.centerX) / this.scale,
      y: (this.centerY - sy) / this.scale,
    };
  }

  /** Сдвиг камеры в пикселях (панорамирование мышью). */
  pan(dxPixels: number, dyPixels: number): void {
    this.centerX += dxPixels;
    this.centerY += dyPixels;
  }

  /** Масштабирование колесом вокруг точки экрана. */
  zoomAt(sx: number, sy: number, factor: number, min = 2, max = 400): void {
    const before = this.screenToWorld(sx, sy);
    this.scale = Math.min(max, Math.max(min, this.scale * factor));
    const after = this.screenToWorld(sx, sy);
    // Сдвигаем камеру так, чтобы точка под курсором осталась на месте.
    this.centerX += (after.x - before.x) * this.scale;
    this.centerY -= (after.y - before.y) * this.scale;
  }

  /** Поворот сцены. */
  rotate(dYaw: number, dPitch: number): void {
    this.yaw += dYaw;
    this.pitch = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, this.pitch + dPitch));
  }

  /** Снимок параметров — для тестов и сериализации. */
  snapshot(): { scale: number; centerX: number; centerY: number; yaw: number; pitch: number } {
    return {
      scale: this.scale,
      centerX: this.centerX,
      centerY: this.centerY,
      yaw: this.yaw,
      pitch: this.pitch,
    };
  }
}
