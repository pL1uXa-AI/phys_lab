/**
 * Отрисовка простого markdown.
 *
 * Нужно ровно три вещи: заголовки, абзацы со списками и таблицы, — а также
 * инлайн-разметка `code`, **жирный** и *курсив*. Тянуть полноценный парсер
 * ради этого не стоит: теория уровней пишется нами и не содержит ничего
 * экзотического. Зато собственная функция гарантированно не съест текст
 * целиком при неожиданном символе.
 *
 * HTML экранируется везде, где вставляется текст: теория — это данные,
 * и они не должны уметь ломать разметку (а если её когда-нибудь начнут
 * загружать из файла — тем более).
 */

/** Экранирование HTML. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Инлайн-разметка: код, жирный, курсив. */
function inline(text: string): string {
  let out = escapeHtml(text);
  out = out.replace(/`([^`]+)`/g, '<code>$1</code>');
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  return out;
}

/**
 * Разбор markdown в HTML.
 *
 * Поддерживаются: заголовки `#`…`####`, списки `-` и `1.`, таблицы с
 * разделителем `|---|`, блоки кода в тройных кавычках, горизонтальные
 * линии `---`, абзацы.
 */
export function renderMarkdown(source: string): string {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];

    // Блок кода.
    if (line.trimStart().startsWith('```')) {
      const code: string[] = [];
      index++;
      while (index < lines.length && !lines[index].trimStart().startsWith('```')) {
        code.push(lines[index]);
        index++;
      }
      index++; // закрывающая строка
      out.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
      continue;
    }

    // Заголовок.
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = Math.min(6, heading[1].length);
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      index++;
      continue;
    }

    // Горизонтальная линия.
    if (/^\s*---+\s*$/.test(line)) {
      out.push('<hr>');
      index++;
      continue;
    }

    // Таблица: строка, затем разделитель.
    if (line.includes('|') && index + 1 < lines.length && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[index + 1])) {
      const header = splitRow(line);
      index += 2;
      const rows: string[][] = [];
      while (index < lines.length && lines[index].includes('|')) {
        rows.push(splitRow(lines[index]));
        index++;
      }
      const head = header.map((cell) => `<th>${inline(cell)}</th>`).join('');
      const body = rows
        .map((row) => `<tr>${row.map((cell) => `<td>${inline(cell)}</td>`).join('')}</tr>`)
        .join('');
      out.push(`<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`);
      continue;
    }

    // Списки (маркированные и нумерованные) — склеиваются в один блок,
    // пока идут подряд.
    if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\.\s+/.test(line);
      const items: string[] = [];
      while (index < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[index])) {
        items.push(lines[index].replace(/^\s*([-*]|\d+\.)\s+/, ''));
        index++;
      }
      const tag = ordered ? 'ol' : 'ul';
      out.push(`<${tag}>${items.map((item) => `<li>${inline(item)}</li>`).join('')}</${tag}>`);
      continue;
    }

    // Пустая строка.
    if (line.trim() === '') {
      index++;
      continue;
    }

    // Абзац: подряд идущие непустые строки.
    const paragraph: string[] = [];
    while (
      index < lines.length &&
      lines[index].trim() !== '' &&
      !/^(#{1,6})\s+/.test(lines[index]) &&
      !lines[index].trimStart().startsWith('```') &&
      !/^\s*([-*]|\d+\.)\s+/.test(lines[index])
    ) {
      paragraph.push(lines[index]);
      index++;
    }
    out.push(`<p>${inline(paragraph.join(' '))}</p>`);
  }

  return out.join('\n');
}

/** Разбор строки таблицы на ячейки. */
function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
}
