/**
 * Экспорт результатов: данные в CSV, графики в PNG.
 *
 * ─── Зачем это нужно ─────────────────────────────────────────────────────
 *
 * Симуляция до сих пор была «вещью в себе»: посмотреть на графики можно,
 * а вынести измерение из неё — нет. Для отчёта, лабораторной или просто
 * сравнения двух запусков нужны числа, а не скриншот экрана.
 *
 * Здесь два независимых экспорта:
 *
 *   1. **CSV** — вся история измерений (T, K, U, E, P, пик g(r), подвижность)
 *      плюс отдельный файл для g(r) и структурного фактора. Разделитель —
 *      точка с запятой, потому что русский Excel ждёт именно его, а запятая
 *      служит десятичным разделителем. Числа пишутся с достаточной
 *      точностью, чтобы данные не «поехали» при повторном анализе.
 *
 *   2. **PNG** — снимок канваса графика. Канвасы рисуются с учётом
 *      devicePixelRatio, поэтому копия делается в отдельный канвас того же
 *      размера: иначе картинка вышла бы обрезанной или размытой.
 *
 * Никаких зависимостей: `Blob`, `URL.createObjectURL` и `<a download>` —
 * всё есть в браузере. Модуль не трогает DOM напрямую, кроме создания
 * ссылки для скачивания, поэтому функции сериализации тестируются в Node.
 */

/** Строка истории измерений в том виде, в каком её отдаёт мир. */
export interface HistoryRow {
  time: number;
  temperature: number;
  kinetic: number;
  potential: number;
  total: number;
  pressure: number;
  orderPeak: number;
  mobileFraction: number;
}

/** Разделитель: точка с запятой — требование русского Excel. */
const DELIMITER = ';';

/** Формат числа для CSV. */

/**
 * Формат числа для CSV.
 *
 * 6 знаков после запятой — компромисс: достаточно, чтобы график, построенный
 * по файлу, совпал с исходным, и при этом файл не раздувается до мегабайтов
 * на длинной серии. Экспоненциальная запись сохраняется для очень больших и
 * очень малых величин — иначе `toFixed` превратил бы их в 0 или в строку
 * на сотни знаков.
 */
function csvNumber(value: number): string {
  if (!Number.isFinite(value)) return '';
  if (value === 0) return '0';
  const abs = Math.abs(value);
  if (abs >= 1e7 || abs < 1e-4) return value.toExponential(6);
  return value.toFixed(6);
}

/** CSV истории измерений. */
export function historyToCsv(rows: readonly HistoryRow[]): string {
  const header = [
    'время_tau',
    'T*',
    'E_кин_eps',
    'E_пот_eps',
    'E_полн_eps',
    'P*',
    'пик_g(r)',
    'подвижных_доля',
  ];
  const lines = [header.join(DELIMITER)];
  for (const row of rows) {
    lines.push(
      [
        csvNumber(row.time),
        csvNumber(row.temperature),
        csvNumber(row.kinetic),
        csvNumber(row.potential),
        csvNumber(row.total),
        csvNumber(row.pressure),
        csvNumber(row.orderPeak),
        csvNumber(row.mobileFraction),
      ].join(DELIMITER),
    );
  }
  // Завершающий перевод строки: без него некоторые инструменты теряют
  // последнюю строку.
  return lines.join('\n') + '\n';
}

/**
 * CSV радиальной функции распределения.
 *
 * Столбцы `r` и `g` — то, что нужно для построения кривой в любой внешней
 * программе. Число кадров указано отдельным столбцом-константой: без него
 * непонятно, насколько кривая «зрелая» (см. `equilibriumLabel`).
 */
export function radialToCsv(
  r: Float64Array | readonly number[],
  g: Float64Array | readonly number[],
  samples: number,
): string {
  const lines = ['r_sigma;g(r);кадров'];
  const n = Math.min(r.length, g.length);
  for (let i = 0; i < n; i++) {
    lines.push(`${csvNumber(r[i])}${DELIMITER}${csvNumber(g[i])}${DELIMITER}${Math.round(samples)}`);
  }
  return lines.join('\n') + '\n';
}

/** CSV структурного фактора S(k). */
export function structureToCsv(
  k: Float64Array | readonly number[],
  s: Float64Array | readonly number[],
  samples: number,
): string {
  const lines = ['k_sigma^-1;S(k);кадров'];
  const n = Math.min(k.length, s.length);
  for (let i = 0; i < n; i++) {
    lines.push(`${csvNumber(k[i])}${DELIMITER}${csvNumber(s[i])}${DELIMITER}${Math.round(samples)}`);
  }
  return lines.join('\n') + '\n';
}

/**
 * Снимок канваса в PNG.
 *
 * Возвращает data-URL. Копирование в отдельный канвас обязательно: сам
 * канвас графика имеет размер буфера с учётом devicePixelRatio, и
 * `toDataURL` вернул бы картинку правильного размера, но с прозрачным
 * фоном — на белом листе отчётности чёрные линии на прозрачном фоне
 * читались бы плохо. Поэтому фон заливается явно.
 *
 * @param background цвет фона; по умолчанию тёмный, как в интерфейсе
 */
export function canvasToPng(canvas: HTMLCanvasElement, background = '#0b0f16'): string {
  const out = document.createElement('canvas');
  out.width = canvas.width;
  out.height = canvas.height;
  const ctx = out.getContext('2d');
  if (!ctx) return canvas.toDataURL('image/png');
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.drawImage(canvas, 0, 0);
  return out.toDataURL('image/png');
}

/**
 * Скачать текст как файл.
 *
 * BOM в начале нужен для Excel: без него кириллица в заголовках CSV
 * превращается в кракозябры. Другие программы BOM игнорируют.
 */
export function downloadText(filename: string, text: string, mime = 'text/csv;charset=utf-8'): void {
  const blob = new Blob(['\ufeff' + text], { type: mime });
  triggerDownload(filename, URL.createObjectURL(blob));
}

/** Скачать data-URL как файл (используется для PNG). */
export function downloadDataUrl(filename: string, dataUrl: string): void {
  triggerDownload(filename, dataUrl);
}

/** Общий путь скачивания: временная ссылка и программный клик. */
function triggerDownload(filename: string, url: string): void {
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  // Освобождаем blob-URL: иначе каждый экспорт оставлял бы данные в памяти
  // до перезагрузки страницы. Data-URL освобождать не нужно.
  if (url.startsWith('blob:')) setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Имя файла с отметкой времени — чтобы экспорты не перетирали друг друга. */
export function timestampedName(prefix: string, extension: string, now = new Date()): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${prefix}-${stamp}.${extension}`;
}
