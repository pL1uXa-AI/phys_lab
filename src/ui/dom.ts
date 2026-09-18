/**
 * Мини-хелпер для построения DOM.
 *
 * Фреймворк здесь не нужен: интерфейс — это десяток панелей с редкими
 * обновлениями, а весь горячий рендер живёт в Pixi. Свой `h()` оказался
 * дешевле по весу и избавил от согласования состояния между фреймворком
 * и сценой — тот же выбор, что и в logic_lab (там он проверен на большом
 * интерфейсе).
 *
 * Содержимое задаётся ОДНИМ способом: либо дочерними аргументами, либо
 * свойством `text`/`html`. Если задать оба, применяется `text`/`html` —
 * иначе текст задваивался бы.
 */

type Child = Node | string | number | null | undefined | false;

/** Создание элемента. */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<Record<string, unknown>> & { class?: string } = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  applyProps(el, props);
  const hasOwnContent = props['text'] !== undefined || props['html'] !== undefined;
  if (hasOwnContent) {
    if (props['html'] !== undefined) el.innerHTML = String(props['html']);
    else el.textContent = String(props['text']);
  } else {
    append(el, children);
  }
  return el;
}

/** Создание элемента SVG (для простых иконок и разметки). */
export function svg(
  tag: string,
  props: Record<string, unknown> = {},
  ...children: Child[]
): SVGElement {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    el.setAttribute(key === 'class' ? 'class' : key, String(value));
  }
  append(el, children);
  return el;
}

function applyProps(el: HTMLElement, props: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    switch (key) {
      case 'class':
        el.className = String(value);
        break;
      case 'style':
        if (typeof value === 'string') el.style.cssText = value;
        else if (typeof value === 'object') Object.assign(el.style, value);
        break;
      case 'dataset':
        for (const [dk, dv] of Object.entries(value as Record<string, unknown>)) {
          el.dataset[dk] = String(dv);
        }
        break;
      case 'text':
      case 'html':
        // Обрабатываются в h(): содержимое задаётся один раз.
        break;
      case 'on':
        for (const [event, handler] of Object.entries(value as Record<string, EventListener>)) {
          el.addEventListener(event, handler);
        }
        break;
      case 'value':
        (el as HTMLInputElement).value = String(value);
        break;
      case 'checked':
      case 'disabled':
      case 'selected':
        (el as unknown as Record<string, unknown>)[key] = Boolean(value);
        break;
      default:
        el.setAttribute(key, String(value));
        break;
    }
  }
}

function append(el: Element, children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

/** Заменить содержимое элемента. */
export function setContent(el: HTMLElement, ...children: Child[]): void {
  el.replaceChildren();
  append(el, children);
}

/** Удалить все дочерние узлы. */
export function clear(el: HTMLElement): void {
  el.replaceChildren();
}

/** Короткая форма запроса элемента по селектору. */
export function qs<T extends Element = HTMLElement>(
  selector: string,
  root: ParentNode = document,
): T | null {
  return root.querySelector<T>(selector);
}

/** Требовательный вариант: бросает, если элемента нет. */
export function need<T extends Element = HTMLElement>(
  selector: string,
  root: ParentNode = document,
): T {
  const el = root.querySelector<T>(selector);
  if (!el) throw new Error(`Элемент не найден: ${selector}`);
  return el;
}

/** Кнопка с единым оформлением. */
export function button(
  label: string,
  onClick: () => void,
  extra: Record<string, unknown> = {},
): HTMLButtonElement {
  return h(
    'button',
    {
      class: `btn ${String(extra['class'] ?? '')}`.trim(),
      type: 'button',
      on: { click: onClick },
      ...extra,
    },
    label,
  );
}

/**
 * Ползунок с подписью и числовым значением.
 *
 * Возвращает способ обновить отображение снаружи: пресет или уровень может
 * изменить параметр помимо ползунка, и подпись обязана это показать.
 */
export interface RangeControl {
  root: HTMLElement;
  set(value: number): void;
  readonly input: HTMLInputElement;
  readonly output: HTMLOutputElement;
}

export function rangeControl(options: {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  format?: (value: number) => string;
  onInput: (value: number) => void;
  /**
   * Вызывается, когда пользователь ОТПУСТИЛ ползунок.
   *
   * Нужен там, где реакция на каждое движение мыши слишком дорога: смена
   * числа частиц пересобирает систему целиком, и протяжка ползунка — это
   * десятки пересборок подряд. Каждая из них обнуляет историю и шаги, из-за
   * чего графики «сбрасывались» на глазах. С этим колбэком дорогое действие
   * выполняется один раз, а во время протяжки обновляется только подпись.
   */
  onCommit?: (value: number) => void;
}): RangeControl {
  const format = options.format ?? ((v: number) => String(v));
  const output = h('output', { class: 'field__value' }, format(options.value));
  const read = (target: EventTarget | null): number =>
    Number((target as HTMLInputElement).value);
  const input = h('input', {
    class: 'range',
    type: 'range',
    min: options.min,
    max: options.max,
    step: options.step,
    value: options.value,
    on: {
      input: (event: Event) => {
        const value = read(event.target);
        output.textContent = format(value);
        options.onInput(value);
      },
      // `change` в браузере наступает по окончании протяжки, `pointerup` и
      // `keyup` — для клавиатуры и синтетических событий, где `change` может
      // не прийти вовсе.
      change: (event: Event) => options.onCommit?.(read(event.target)),
      pointerup: (event: Event) => options.onCommit?.(read(event.target)),
      keyup: (event: Event) => options.onCommit?.(read(event.target)),
    },
  });
  const root = h(
    'label',
    { class: 'field' },
    h('span', { class: 'field__label' }, options.label),
    input,
    output,
  );
  return {
    root,
    input,
    output,
    set(value: number): void {
      input.value = String(value);
      output.textContent = format(value);
    },
  };
}

/** Переключатель: группа кнопок с одним выбранным значением. */
export interface ToggleControl<T extends string> {
  root: HTMLElement;
  set(value: T): void;
}

export function toggleControl<T extends string>(options: {
  label: string;
  items: ReadonlyArray<{ id: T; label: string; title?: string }>;
  value: T;
  onChange: (value: T) => void;
}): ToggleControl<T> {
  let current = options.value;
  const buttons = new Map<T, HTMLButtonElement>();
  const root = h(
    'div',
    { class: 'field field--toggle' },
    h('span', { class: 'field__label' }, options.label),
  );
  const group = h('div', { class: 'toggle' });
  for (const item of options.items) {
    const btn = h(
      'button',
      {
        class: 'toggle__item',
        type: 'button',
        title: item.title ?? '',
        on: {
          click: () => {
            current = item.id;
            sync();
            options.onChange(item.id);
          },
        },
      },
      item.label,
    );
    buttons.set(item.id, btn);
    group.append(btn);
  }
  root.append(group);

  function sync(): void {
    for (const [id, btn] of buttons) btn.classList.toggle('toggle__item--on', id === current);
  }
  sync();

  return {
    root,
    set(value: T): void {
      current = value;
      sync();
    },
  };
}

/** Флажок. */
export function checkbox(options: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}): HTMLElement {
  const input = h('input', {
    type: 'checkbox',
    checked: options.checked,
    on: {
      change: (event: Event) => options.onChange((event.target as HTMLInputElement).checked),
    },
  });
  return h('label', { class: 'field field--check' }, input, h('span', {}, options.label));
}
