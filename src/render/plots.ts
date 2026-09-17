/**
 * Графики непрерывных величин.
 *
 * Идея взята из проекта logic_lab (осциллограф), но предмет другой: там были
 * дискретные сигналы по тактам, здесь — непрерывные величины по времени.
 * Общий остаётся принцип: панель рисует то, что ей дали, ничего не зная
 * о симуляции, а масштаб подбирается автоматически по данным.
 *
 * Почему Canvas2D, а не Pixi: графики обновляются раз в несколько кадров,
 * линии тонкие, и WebGL здесь дал бы только лишнюю сложность. Canvas2D
 * на пару тысяч отрезков работает за доли миллисекунды.
 */

/** Серия данных для графика. */
export interface Series {
  /** Подпись для легенды. */
  label: string;
  /** Цвет линии в формате CSS. */
  color: string;
  /** Значения по времени. */
  values: number[];
  /** Времена (общая шкала для всех серий панели). */
  times: number[];
  /** Толщина линии. */
  width?: number;
  /** Рисовать ли заливку под линией. */
  fill?: boolean;
}

/** Описание графика. */
export interface PlotSpec {
  title: string;
  series: Series[];
  /** Подпись оси Y (единицы измерения). */
  unit?: string;
  /** Фиксированный диапазон по Y: [min, max]. Иначе подбирается по данным. */
  range?: [number, number];
  /** Опорная линия (например, целевая температура). */
  guide?: { value: number; label: string; color: string };
}

/** Цвета линий графиков. */
export const PLOT_COLORS = {
  temperature: '#f2a65a',
  kinetic: '#6fb3e0',
  potential: '#8fd694',
  total: '#e8e4d8',
  pressure: '#c99ae0',
  peak: '#f2d06a',
  mobile: '#7fd6c0',
  guide: '#5a6b85',
};

/**
 * Отрисовка графика в канвас.
 *
 * Размеры берутся из самого канваса с учётом devicePixelRatio: иначе на
 * HiDPI-экране линии выглядят размытыми.
 */
export function drawPlot(
  canvas: HTMLCanvasElement,
  spec: PlotSpec,
  options: { padding?: number } = {},
): void {
  const ratio = window.devicePixelRatio || 1;
  const cssWidth = canvas.clientWidth || 300;
  const cssHeight = canvas.clientHeight || 120;
  if (canvas.width !== Math.round(cssWidth * ratio) || canvas.height !== Math.round(cssHeight * ratio)) {
    canvas.width = Math.round(cssWidth * ratio);
    canvas.height = Math.round(cssHeight * ratio);
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, cssWidth, cssHeight);

  const padding = options.padding ?? 8;
  const left = padding + 44;
  const right = cssWidth - padding - 6;
  const top = padding + 16;
  const bottom = cssHeight - padding - 14;
  const plotWidth = Math.max(1, right - left);
  const plotHeight = Math.max(1, bottom - top);

  // Область построения.
  ctx.fillStyle = '#0e1520';
  ctx.fillRect(left, top, plotWidth, plotHeight);
  ctx.strokeStyle = '#1e2a3a';
  ctx.lineWidth = 1;
  ctx.strokeRect(left + 0.5, top + 0.5, plotWidth - 1, plotHeight - 1);

  const bounds = computeBounds(spec);
  const tMin = bounds.tMin;
  const tMax = bounds.tMax;
  const vMin = bounds.vMin;
  const vMax = bounds.vMax;
  const tSpan = tMax - tMin || 1;
  const vSpan = vMax - vMin || 1;

  const toX = (t: number): number => left + ((t - tMin) / tSpan) * plotWidth;
  const toY = (v: number): number => bottom - ((v - vMin) / vSpan) * plotHeight;

  // Сетка: четыре горизонтальные линии с подписями.
  ctx.strokeStyle = '#182334';
  ctx.fillStyle = '#5f7a9a';
  ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.textBaseline = 'middle';
  for (let i = 0; i <= 4; i++) {
    const value = vMin + (vSpan * i) / 4;
    const y = toY(value);
    ctx.beginPath();
    ctx.moveTo(left, y);
    ctx.lineTo(right, y);
    ctx.stroke();
    ctx.textAlign = 'right';
    ctx.fillText(formatTick(value), left - 6, y);
  }

  // Опорная линия (целевая температура).
  if (spec.guide) {
    const y = toY(spec.guide.value);
    if (y >= top && y <= bottom) {
      ctx.save();
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = spec.guide.color;
      ctx.beginPath();
      ctx.moveTo(left, y);
      ctx.lineTo(right, y);
      ctx.stroke();
      ctx.restore();
      ctx.fillStyle = spec.guide.color;
      ctx.textAlign = 'left';
      ctx.fillText(spec.guide.label, left + 4, y - 7);
    }
  }

  // Серии.
  for (const series of spec.series) {
    if (series.values.length < 2) continue;
    ctx.strokeStyle = series.color;
    ctx.lineWidth = series.width ?? 1.5;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    let started = false;
    for (let i = 0; i < series.values.length; i++) {
      const t = series.times[i];
      const v = series.values[i];
      if (!Number.isFinite(t) || !Number.isFinite(v)) continue;
      const x = toX(t);
      const y = toY(v);
      if (!started) {
        ctx.moveTo(x, y);
        started = true;
      } else {
        ctx.lineTo(x, y);
      }
    }
    ctx.stroke();

    if (series.fill) {
      const last = series.values.length - 1;
      ctx.lineTo(toX(series.times[last]), bottom);
      ctx.lineTo(toX(series.times[0]), bottom);
      ctx.closePath();
      ctx.globalAlpha = 0.12;
      ctx.fillStyle = series.color;
      ctx.fill();
      ctx.globalAlpha = 1;
    }
  }

  // Заголовок и легенда.
  ctx.fillStyle = '#a8bdd4';
  ctx.font = '11px system-ui, -apple-system, Segoe UI, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText(spec.title, padding, 2);

  let legendX = left;
  ctx.font = '10px ui-monospace, monospace';
  for (const series of spec.series) {
    if (series.values.length === 0) continue;
    const last = series.values[series.values.length - 1];
    const text = `${series.label} ${formatTick(last)}`;
    const width = ctx.measureText(text).width;
    if (legendX + width > right) break;
    ctx.fillStyle = series.color;
    ctx.fillRect(legendX, cssHeight - 10, 6, 6);
    ctx.fillStyle = '#8fa6bf';
    ctx.fillText(text, legendX + 9, cssHeight - 12);
    legendX += width + 18;
  }

  if (spec.unit) {
    ctx.fillStyle = '#4d6a88';
    ctx.textAlign = 'right';
    ctx.fillText(spec.unit, right, 2);
  }
}

/**
 * Диапазоны по осям.
 *
 * Особый случай — постоянная величина (например, температура, которую держит
 * термостат). Тогда span = 0, и линия обязана лечь посередине, а не в нижний
 * край: поэтому диапазон расширяется на ±5 % от значения.
 */
export function computeBounds(spec: PlotSpec): {
  tMin: number;
  tMax: number;
  vMin: number;
  vMax: number;
} {
  let tMin = Number.POSITIVE_INFINITY;
  let tMax = Number.NEGATIVE_INFINITY;
  let vMin = Number.POSITIVE_INFINITY;
  let vMax = Number.NEGATIVE_INFINITY;

  for (const series of spec.series) {
    for (let i = 0; i < series.values.length; i++) {
      const t = series.times[i];
      const v = series.values[i];
      if (!Number.isFinite(t) || !Number.isFinite(v)) continue;
      if (t < tMin) tMin = t;
      if (t > tMax) tMax = t;
      if (v < vMin) vMin = v;
      if (v > vMax) vMax = v;
    }
  }

  if (spec.range) {
    vMin = spec.range[0];
    vMax = spec.range[1];
  }
  if (spec.guide) {
    vMin = Math.min(vMin, spec.guide.value);
    vMax = Math.max(vMax, spec.guide.value);
  }

  if (!Number.isFinite(tMin) || !Number.isFinite(tMax)) {
    tMin = 0;
    tMax = 1;
  }
  if (tMax - tMin < 1e-9) tMax = tMin + 1;

  if (!Number.isFinite(vMin) || !Number.isFinite(vMax)) {
    vMin = 0;
    vMax = 1;
  }
  if (vMax - vMin < 1e-9) {
    const pad = Math.max(0.05, Math.abs(vMin) * 0.05);
    vMin -= pad;
    vMax += pad;
  } else {
    const pad = (vMax - vMin) * 0.06;
    vMin -= pad;
    vMax += pad;
  }
  return { tMin, tMax, vMin, vMax };
}

/** Короткая подпись числа для оси и легенды. */
export function formatTick(value: number): string {
  if (!Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  if (abs >= 10000) return value.toExponential(1);
  if (abs >= 100) return value.toFixed(0);
  if (abs >= 10) return value.toFixed(1);
  if (abs >= 1) return value.toFixed(2);
  if (abs >= 0.01) return value.toFixed(3);
  return value.toExponential(1);
}

/**
 * Отрисовка радиальной функции распределения g(r).
 *
 * Отдельная функция, потому что оси здесь необычные: по X — расстояние в σ,
 * по Y — безразмерная величина около единицы. На график наносится опорная
 * линия g = 1 (идеальный газ) — именно отклонения от неё и интересны.
 */
export function drawRadial(
  canvas: HTMLCanvasElement,
  r: Float64Array,
  g: Float64Array,
  options: { samples: number } = { samples: 0 },
): void {
  const ratio = window.devicePixelRatio || 1;
  const cssWidth = canvas.clientWidth || 300;
  const cssHeight = canvas.clientHeight || 120;
  if (canvas.width !== Math.round(cssWidth * ratio) || canvas.height !== Math.round(cssHeight * ratio)) {
    canvas.width = Math.round(cssWidth * ratio);
    canvas.height = Math.round(cssHeight * ratio);
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, cssWidth, cssHeight);

  const padding = 8;
  const left = padding + 26;
  const right = cssWidth - padding - 6;
  const top = padding + 16;
  const bottom = cssHeight - padding - 14;
  const plotWidth = Math.max(1, right - left);
  const plotHeight = Math.max(1, bottom - top);

  ctx.fillStyle = '#0e1520';
  ctx.fillRect(left, top, plotWidth, plotHeight);
  ctx.strokeStyle = '#1e2a3a';
  ctx.strokeRect(left + 0.5, top + 0.5, plotWidth - 1, plotHeight - 1);

  const rMax = r.length > 0 ? r[r.length - 1] : 1;
  let gMax = 1.5;
  for (let i = 0; i < g.length; i++) if (Number.isFinite(g[i]) && g[i] > gMax) gMax = g[i];
  const toX = (value: number): number => left + (value / rMax) * plotWidth;
  const toY = (value: number): number => bottom - (value / gMax) * plotHeight;

  // Горизонтальная опорная линия g = 1: идеальный газ.
  ctx.save();
  ctx.setLineDash([4, 4]);
  ctx.strokeStyle = '#3d4f68';
  ctx.beginPath();
  ctx.moveTo(left, toY(1));
  ctx.lineTo(right, toY(1));
  ctx.stroke();
  ctx.restore();

  ctx.strokeStyle = '#7fd6c0';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  for (let i = 0; i < r.length; i++) {
    const x = toX(r[i]);
    const y = toY(Number.isFinite(g[i]) ? g[i] : 0);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();

  ctx.fillStyle = '#a8bdd4';
  ctx.font = '11px system-ui, -apple-system, Segoe UI, sans-serif';
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';
  ctx.fillText('g(r) — радиальная функция', padding, 2);

  ctx.fillStyle = '#5f7a9a';
  ctx.font = '10px ui-monospace, monospace';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'right';
  for (let i = 0; i <= 2; i++) {
    const value = (gMax * i) / 2;
    ctx.fillText(formatTick(value), left - 5, toY(value));
  }
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  for (let i = 0; i <= 3; i++) {
    const value = (rMax * i) / 3;
    ctx.fillText(`${value.toFixed(1)}σ`, toX(value), cssHeight - 1);
  }

  ctx.textAlign = 'right';
  ctx.textBaseline = 'top';
  ctx.fillStyle = '#5f7a9a';
  ctx.fillText(options.samples > 0 ? `кадров: ${options.samples}` : 'накопление…', right, 2);
}
