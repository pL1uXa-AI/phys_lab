/**
 * Палитра и цветовые шкалы.
 *
 * Цвет несёт физический смысл, поэтому шкала задана явно, а не «по вкусу».
 * Для скорости берётся последовательность синий → голубой → жёлтый → красный:
 * она монотонна по светлоте (видно и на плохом экране, и в оттенках серого)
 * и не использует крайние тона, которые сливаются с фоном.
 *
 * Всё возвращается как готовые CSS-строки: Pixi 8 принимает их напрямую,
 * а панели интерфейса показывают те же цвета в легенде.
 */

/** Цвет фона сцены. */
export const BACKGROUND = '#0b0f16';

/** Цвет стенок ящика. */
export const WALL_COLOR = '#2a3648';

/** Точки разметки шкалы «скорость». */
const SPEED_STOPS: ReadonlyArray<readonly [number, number, number]> = [
  [0x25, 0x4a, 0x9a],
  [0x38, 0x9c, 0xd6],
  [0x63, 0xd4, 0xb0],
  [0xf2, 0xd0, 0x62],
  [0xe8, 0x6a, 0x3c],
];

/** Точки разметки шкалы «плотность». */
const DENSITY_STOPS: ReadonlyArray<readonly [number, number, number]> = [
  [0x1c, 0x24, 0x36],
  [0x3f, 0x5f, 0x8c],
  [0x6d, 0xa8, 0xa0],
  [0xd6, 0xd0, 0x7a],
  [0xf0, 0x9a, 0x52],
];

/** Точки разметки шкалы «накопленный путь». */
const TRAVEL_STOPS: ReadonlyArray<readonly [number, number, number]> = [
  [0x22, 0x3a, 0x5e],
  [0x4a, 0x7c, 0xb8],
  [0xa0, 0x8c, 0xd0],
  [0xe0, 0x8c, 0x9a],
  [0xf4, 0xd0, 0x86],
];

/** Линейная интерполяция по таблице цветов, t ∈ [0, 1]. */
export function rampColor(
  stops: ReadonlyArray<readonly [number, number, number]>,
  t: number,
): string {
  const clamped = t < 0 ? 0 : t > 1 ? 1 : t;
  const scaled = clamped * (stops.length - 1);
  const index = Math.min(stops.length - 2, Math.floor(scaled));
  const frac = scaled - index;
  const a = stops[index];
  const b = stops[index + 1];
  const r = Math.round(a[0] + (b[0] - a[0]) * frac);
  const g = Math.round(a[1] + (b[1] - a[1]) * frac);
  const bl = Math.round(a[2] + (b[2] - a[2]) * frac);
  return `rgb(${r},${g},${bl})`;
}

/** Цвет по нормированной величине для конкретного режима раскраски. */
export function colorFor(mode: string, t: number): string {
  switch (mode) {
    case 'density':
      return rampColor(DENSITY_STOPS, t);
    case 'travel':
      return rampColor(TRAVEL_STOPS, t);
    case 'plain':
      return '#7fb2e5';
    case 'speed':
    default:
      return rampColor(SPEED_STOPS, t);
  }
}

/**
 * Готовые ступени для легенды: пять цветов плюс подписи от min до max.
 * Легенда обязана использовать ту же функцию, что и рендер, — иначе она
 * рано или поздно разойдётся с картинкой.
 */
export function legendStops(mode: string, count = 5): string[] {
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    out.push(colorFor(mode, count === 1 ? 0.5 : i / (count - 1)));
  }
  return out;
}

/** Цвет выделенных (замороженных) частиц. */
export const FROZEN_COLOR = '#dfe7f2';

/**
 * Цвет связей ближних соседей.
 *
 * Намеренно тусклый и синеватый: связи — это фон структуры, а не главный
 * объект. Яркие линии перетянули бы внимание на себя, а частицы потерялись
 * бы; кроме того, на плотных системах линии накладываются друг на друга,
 * и яркий цвет превратил бы решётку в сплошное пятно.
 */
export const BOND_COLOR = '#3d5875';

/** Цвет хвоста траектории. */
export const TRAIL_COLOR = 'rgba(120, 180, 240, 0.35)';

/** Порядок режимов раскраски и подписи. */
export const COLOR_MODES: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'speed', label: 'Скорость' },
  { id: 'density', label: 'Плотность' },
  { id: 'travel', label: 'Смещение' },
  { id: 'plain', label: 'Одинаково' },
];
