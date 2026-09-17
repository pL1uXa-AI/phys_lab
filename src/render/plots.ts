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

/**
 * Общая заготовка осей для кривых с «физическими» осями (не время-величина).
 *
 * Понадобилась, когда к g(r) добавились S(k) и MSD: у всех трёх по X идёт
 * физическая величина, а не время, и повторять разметку осей трижды —
 * верный способ сделать их непохожими друг на друга.
 */
interface AxesBox {
  left: number;
  right: number;
  top: number;
  bottom: number;
  plotWidth: number;
  plotHeight: number;
}

/** Подготовка канваса: размеры, контекст и рамка области построения. */
function prepareCanvas(
  canvas: HTMLCanvasElement,
): { ctx: CanvasRenderingContext2D; cssWidth: number; cssHeight: number; box: AxesBox } | null {
  const ratio = window.devicePixelRatio || 1;
  const cssWidth = canvas.clientWidth || 300;
  const cssHeight = canvas.clientHeight || 120;
  if (canvas.width !== Math.round(cssWidth * ratio) || canvas.height !== Math.round(cssHeight * ratio)) {
    canvas.width = Math.round(cssWidth * ratio);
    canvas.height = Math.round(cssHeight * ratio);
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, cssWidth, cssHeight);

  const padding = 8;
  const left = padding + 30;
  const right = cssWidth - padding - 6;
  const top = padding + 16;
  const bottom = cssHeight - padding - 14;
  const box: AxesBox = {
    left,
    right,
    top,
    bottom,
    plotWidth: Math.max(1, right - left),
    plotHeight: Math.max(1, bottom - top),
  };
  ctx.fillStyle = '#0e1520';
  ctx.fillRect(left, top, box.plotWidth, box.plotHeight);
  ctx.strokeStyle = '#1e2a3a';
  ctx.strokeRect(left + 0.5, top + 0.5, box.plotWidth - 1, box.plotHeight - 1);
  return { ctx, cssWidth, cssHeight, box };
}

/** Заголовок графика и число кадров в правом верхнем углу. */
function drawCaption(
  ctx: CanvasRenderingContext2D,
  box: AxesBox,
  title: string,
  colour: string,
  badge: string,
): void {
  ctx.fillStyle = '#a8bdd4';
  ctx.font = '11px system-ui, -apple-system, Segoe UI, sans-serif';
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';
  ctx.fillText(title, 8, 2);
  void colour;
  if (badge) {
    ctx.fillStyle = '#5f7a9a';
    ctx.font = '10px ui-monospace, monospace';
    ctx.textAlign = 'right';
    ctx.fillText(badge, box.right, 2);
    ctx.textAlign = 'left';
  }
}

/** Подписи делений по обеим осям. */
function drawTicks(
  ctx: CanvasRenderingContext2D,
  box: AxesBox,
  cssHeight: number,
  xMax: number,
  yMax: number,
  xFormat: (value: number) => string,
  yFormat: (value: number) => string,
): void {
  ctx.fillStyle = '#5f7a9a';
  ctx.font = '10px ui-monospace, monospace';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'right';
  for (let i = 0; i <= 2; i++) {
    const value = (yMax * i) / 2;
    ctx.fillText(yFormat(value), box.left - 5, box.bottom - (value / yMax) * box.plotHeight);
  }
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  for (let i = 0; i <= 3; i++) {
    const value = (xMax * i) / 3;
    ctx.fillText(xFormat(value), box.left + (value / xMax) * box.plotWidth, cssHeight - 1);
  }
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
}

/**
 * Структурный фактор S(k).
 *
 * Главное, что должно быть видно: у кристалла — узкие высокие пики, у
 * жидкости — один широкий горб, у газа — почти прямая линия на уровне 1.
 * Поэтому опорная линия S = 1 (предел идеального газа) обязательна: без неё
 * «горб» и «пик» выглядят одинаково.
 */
export function drawStructure(
  canvas: HTMLCanvasElement,
  k: Float64Array,
  s: Float64Array,
  options: { samples: number; peak?: { k: number; height: number } } = { samples: 0 },
): void {
  // Сетка с логарифмом по Y дала бы «правильный» вид, но усложнила бы чтение
  // чисел на оси; для сравнения кривых линейной шкалы достаточно.
  const prepared = prepareCanvas(canvas);
  if (!prepared) return;
  const { ctx, cssHeight, box } = prepared;

  const n = Math.min(k.length, s.length);
  /*
   * Ось X обрезается по последнему НЕПУСТОМУ бину.
   *
   * `result()` отдаёт все бины до kMax включительно, но при малом числе
   * частиц на дальних оболочках векторов просто нет, и значения там нули.
   * На графике это выглядело как «полка» из нулей в правой трети — будто
   * S(k) там действительно падает до нуля. Обрезка показывает ровно тот
   * диапазон, где данные есть.
   */
  let last = -1;
  for (let i = 0; i < n; i++) {
    if (Number.isFinite(s[i]) && s[i] > 0) last = i;
  }
  const used = last >= 2 ? last + 1 : n;
  const kMax = used > 0 ? Math.max(1e-6, k[used - 1]) : 18;
  let sMax = 1.4;
  for (let i = 0; i < used; i++) if (Number.isFinite(s[i]) && s[i] > sMax) sMax = s[i];

  // Опорная линия S = 1 — предел идеального газа.
  ctx.save();
  ctx.setLineDash([4, 4]);
  ctx.strokeStyle = '#3d4f68';
  ctx.beginPath();
  const yOf = (value: number): number => box.bottom - (value / sMax) * box.plotHeight;
  ctx.moveTo(box.left, yOf(1));
  ctx.lineTo(box.right, yOf(1));
  ctx.stroke();
  ctx.restore();

  ctx.strokeStyle = PLOT_COLORS.peak;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  for (let i = 0; i < used; i++) {
    const x = box.left + (k[i] / kMax) * box.plotWidth;
    const y = yOf(Number.isFinite(s[i]) ? s[i] : 0);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();

  drawCaption(ctx, box, 'S(k) — структурный фактор', PLOT_COLORS.peak, options.samples > 0 ? `кадров: ${options.samples}` : 'накопление…');
  drawTicks(ctx, box, cssHeight, kMax, sMax, (v) => v.toFixed(1), formatTick);

  // Отметка первого пика: без неё «на глаз» не понять, где именно максимум.
  const peak = options.peak;
  if (peak && peak.height > 0 && peak.k > 0) {
    const x = box.left + (peak.k / kMax) * box.plotWidth;
    const y = yOf(peak.height);
    ctx.fillStyle = '#f2d06a';
    ctx.beginPath();
    ctx.arc(x, y, 2.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.font = '10px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText(`${peak.height.toFixed(1)}`, x, y - 4);
  }
}

/**
 * Кривая фазового перехода: энергия и теплоёмкость от температуры.
 *
 * Особенность графика в том, что по X идёт НЕ время, а температура —
 * параметр, который мы сами задаём. Поэтому ось X здесь равномерная по
 * индексу точки, а не пропорциональная T: шаг свипа может быть неравномерным
 * (у перехода его хочется мельче), и пропорциональная шкала сжимала бы
 * интересную область перехода в точку.
 *
 * Две серии рисуются в разных масштабах (энергия порядка −5, теплоёмкость
 * порядка 1), поэтому каждая нормируется на свой диапазон — иначе одна
 * кривая была бы плоской линией на фоне другой. Для этого на графике две
 * вертикальные шкалы с подписями.
 */
export function drawTransition(
  canvas: HTMLCanvasElement,
  points: ReadonlyArray<{ temperature: number; energy: number; heatCapacity: number }>,
  options: { branch?: string; progress?: number } = {},
): void {
  const prepared = prepareCanvas(canvas);
  if (!prepared) return;
  const { ctx, cssHeight, box } = prepared;

  if (points.length === 0) {
    drawCaption(ctx, box, 'Фазовый переход', PLOT_COLORS.temperature, 'нет данных');
    return;
  }

  const count = points.length;
  // Равномерная шкала по индексу точки: см. комментарий выше.
  const xOf = (index: number): number =>
    box.left + (count <= 1 ? 0 : (index / (count - 1)) * box.plotWidth);

  let eMin = Number.POSITIVE_INFINITY;
  let eMax = Number.NEGATIVE_INFINITY;
  let cMax = 0;
  for (const point of points) {
    if (Number.isFinite(point.energy)) {
      eMin = Math.min(eMin, point.energy);
      eMax = Math.max(eMax, point.energy);
    }
    if (Number.isFinite(point.heatCapacity)) cMax = Math.max(cMax, point.heatCapacity);
  }
  if (!Number.isFinite(eMin) || !Number.isFinite(eMax)) {
    eMin = 0;
    eMax = 1;
  }
  if (eMax - eMin < 1e-6) eMax = eMin + 1e-6;
  if (cMax < 1e-6) cMax = 1;
  const eSpan = eMax - eMin;
  const yOfEnergy = (value: number): number => box.bottom - ((value - eMin) / eSpan) * box.plotHeight;
  const yOfHeat = (value: number): number => box.bottom - (value / cMax) * box.plotHeight;

  // Энергия — основная кривая.
  ctx.strokeStyle = PLOT_COLORS.temperature;
  ctx.lineWidth = 1.8;
  ctx.beginPath();
  for (let i = 0; i < count; i++) {
    const x = xOf(i);
    const y = yOfEnergy(points[i].energy);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();

  // Теплоёмкость — второй серией, другим цветом и с заливкой: её пик и есть
  // отметка перехода.
  ctx.strokeStyle = PLOT_COLORS.mobile;
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  for (let i = 0; i < count; i++) {
    const x = xOf(i);
    const y = yOfHeat(points[i].heatCapacity);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();

  // Точки данных: при малом числе температур линия без них читается как
  // непрерывная зависимость, хотя между точками ничего не измерялось.
  ctx.fillStyle = PLOT_COLORS.temperature;
  for (let i = 0; i < count; i++) {
    ctx.beginPath();
    ctx.arc(xOf(i), yOfEnergy(points[i].energy), 2, 0, Math.PI * 2);
    ctx.fill();
  }

  const branchLabel = options.branch === 'cooling' ? 'охлаждение' : 'нагрев';
  const badge =
    options.progress !== undefined && options.progress < 1
      ? `набор ${(options.progress * 100).toFixed(0)} %`
      : `${points.length} точек · ${branchLabel}`;
  drawCaption(ctx, box, 'E/N (жёлтая) и C_v/N (зелёная)', PLOT_COLORS.temperature, badge);

  // Подписи оси X — температуры (по индексам), чтобы точки не наезжали.
  ctx.fillStyle = '#5f7a9a';
  ctx.font = '10px ui-monospace, monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  const labels = Math.min(5, count);
  for (let i = 0; i < labels; i++) {
    const index = Math.round((i / Math.max(1, labels - 1)) * (count - 1));
    ctx.fillText(points[index].temperature.toFixed(2), xOf(index), cssHeight - 1);
  }
  // Подписи оси Y: только концы диапазона энергии.
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  ctx.fillText(formatTick(eMax), box.left - 5, yOfEnergy(eMax));
  ctx.fillText(formatTick(eMin), box.left - 5, yOfEnergy(eMin));
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
}

/**
 * Среднеквадратичное смещение MSD(лаг).
 *
 * Кривая читается по наклону: у кристалла она выходит на плато (атомы
 * колеблются вокруг узла), у жидкости растёт линейно. Именно линейный
 * участок и даёт коэффициент диффузии D, поэтому на графике отмечается
 * отрезок, по которому идёт подгонка, — иначе связь «кривая → число D»
 * остаётся для игрока невидимой.
 */
export function drawMsd(
  canvas: HTMLCanvasElement,
  lag: Float64Array,
  msd: Float64Array,
  options: {
    D: number;
    r2: number;
    lagRange: [number, number];
    ready: boolean;
    /** Число наблюдений в каждом бине — по нему обрезается кривая. */
    counts?: Int32Array;
  },
): void {
  const prepared = prepareCanvas(canvas);
  if (!prepared) return;
  const { ctx, cssHeight, box } = prepared;

  /*
   * Обрезка по последнему бину с данными.
   *
   * ─── Почему это обязательно ──────────────────────────────────────────────
   *
   * `result()` отдаёт все бины, а пустые заполняет нулём. На графике это
   * выглядело как обрыв: кривая доходила до последнего лага, на котором
   * успело накопиться хотя бы одно наблюдение, и дальше падала в ноль —
   * то есть рисовался «спад MSD», которого в физике нет. Хуже того, бины
   * с ОДНИМ наблюдением дают большой разброс, и именно они создавали
   * ложный излом в конце.
   *
   * Поэтому рисуем только до последнего бина, где данных хватает: не менее
   * четверти от максимума по всем бинам. Это тот же порог, по которому
   * вообще имеет смысл говорить о среднем.
   */
  const counts = options.counts;
  let limit = Math.min(lag.length, msd.length);
  if (counts && counts.length > 0) {
    let maxCount = 0;
    for (let i = 0; i < counts.length; i++) if (counts[i] > maxCount) maxCount = counts[i];
    let last = -1;
    for (let i = 0; i < limit; i++) {
      if (i < counts.length && counts[i] >= Math.max(1, maxCount * 0.25)) last = i;
    }
    if (last >= 2) limit = last + 1;
  }

  const n = limit;
  let lagMax = 1e-6;
  let msdMax = 1e-6;
  for (let i = 0; i < n; i++) {
    if (Number.isFinite(lag[i]) && lag[i] > lagMax) lagMax = lag[i];
    if (Number.isFinite(msd[i]) && msd[i] > msdMax) msdMax = msd[i];
  }
  const xOf = (value: number): number => box.left + (value / lagMax) * box.plotWidth;
  const yOf = (value: number): number => box.bottom - (value / msdMax) * box.plotHeight;

  // Отрезок подгонки: по нему считается D.
  if (options.ready && options.lagRange[1] > options.lagRange[0]) {
    const x1 = xOf(options.lagRange[0]);
    const x2 = xOf(options.lagRange[1]);
    ctx.fillStyle = 'rgba(127, 214, 192, 0.10)';
    ctx.fillRect(x1, box.top, Math.max(1, x2 - x1), box.plotHeight);
  }

  ctx.strokeStyle = PLOT_COLORS.mobile;
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const x = xOf(lag[i]);
    const y = yOf(Number.isFinite(msd[i]) ? msd[i] : 0);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();

  // Подпись D: ноль до набора статистики и ноль у кристалла — разные вещи,
  // поэтому при недобранном окне пишется прогресс, а не число.
  const badge = options.ready
    ? `D = ${options.D.toFixed(4)}  r² = ${options.r2.toFixed(2)}`
    : 'набор статистики…';
  drawCaption(ctx, box, 'MSD — смещение', PLOT_COLORS.mobile, badge);
  drawTicks(ctx, box, cssHeight, lagMax, msdMax, (v) => `${v.toFixed(1)}τ`, formatTick);
}
