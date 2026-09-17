/**
 * Панель кампании.
 *
 * Показывает текущий уровень, список задач с отметками выполнения и кнопки
 * управления. Теория открывается в модальном окне: она длинная, и держать
 * её в боковой панели значит отнять место у ползунков.
 *
 * Задачи обновляются на каждом отчёте проверки. Показывается именно список
 * с «✓ / •», а не одна галочка: игрок должен видеть, чего не хватает, —
 * иначе уровень превращается в угадайку.
 */

import { h, button, setContent, clear, need } from './dom.js';
import { renderMarkdown } from './markdown.js';
import { LEVELS, levelNumber, nextLevel, type Level } from '../levels/levels.js';
import type { LevelReport } from '../levels/checks.js';

/** Действия панели кампании. */
export interface CampaignActions {
  startLevel(level: Level): void;
  checkLevel(): void;
  exitToSandbox(): void;
}

/** Панель кампании. */
export class CampaignPanel {
  readonly root: HTMLElement;
  private readonly actions: CampaignActions;
  private readonly list: HTMLElement;
  private readonly card: HTMLElement;
  private readonly levelButtons = new Map<string, HTMLButtonElement>();
  private completed = new Set<string>();

  constructor(actions: CampaignActions) {
    this.actions = actions;
    this.list = h('div', { class: 'preset-list' });
    this.card = h('div', { class: 'level-card' });

    for (const level of LEVELS) {
      const btn = h(
        'button',
        {
          class: 'preset',
          type: 'button',
          on: { click: () => actions.startLevel(level) },
        },
        h('div', { class: 'preset__title' }, `${levelNumber(level)}. ${level.title}`),
      );
      this.levelButtons.set(level.id, btn);
      this.list.append(btn);
    }

    const body = h(
      'div',
      { class: 'panel__body' },
      this.card,
      h('div', { class: 'row' }, button('Выйти в песочницу', () => actions.exitToSandbox())),
      h('p', { class: 'hint' }, 'Уровни кампании: 10 заданий от кристалла до самосборки.'),
      this.list,
    );
    this.root = h('section', { class: 'panel', dataset: { panel: 'campaign' } });
    const toggle = h('span', { class: 'panel__toggle' }, '▾');
    this.root.append(
      h(
        'header',
        {
          class: 'panel__head',
          on: {
            click: () => {
              const collapsed = this.root.classList.toggle('panel--collapsed');
              toggle.textContent = collapsed ? '▸' : '▾';
            },
          },
        },
        h('b', {}, 'Кампания'),
        toggle,
      ),
      body,
    );

    this.showIdleCard();
  }

  /** Карточка, когда уровень не выбран. */
  private showIdleCard(): void {
    setContent(
      this.card,
      h('div', { class: 'level-card__title' }, 'Песочница'),
      h(
        'div',
        { class: 'level-card__goal' },
        'Выберите уровень слева или просто экспериментируйте: параметры, пресеты и воздействия ' +
          'доступны всегда.',
      ),
    );
  }

  /** Показ уровня. */
  showLevel(level: Level, report: LevelReport | null, progress: number): void {
    this.card.dataset['level'] = level.id;
    this.card.dataset['status'] = report ? (report.passed ? 'passed' : 'running') : 'running';
    this.card.dataset['progress'] = progress.toFixed(3);
    const badge = report
      ? report.passed
        ? h('span', { class: 'badge badge--ok' }, 'выполнено')
        : h('span', { class: 'badge badge--wait' }, 'в работе')
      : h('span', { class: 'badge' }, progress < 1 ? 'выход на режим' : 'измерение');

    clear(this.card);
    this.card.append(
      h(
        'div',
        { class: 'level-card__title' },
        `${levelNumber(level)}. ${level.title} `,
        badge,
      ),
      h('div', { class: 'level-card__goal' }, level.goal),
      h(
        'div',
        { class: 'row' },
        button('Теория', () => openLevelTheory(level)),
        button('Проверить', () => this.actions.checkLevel(), { class: 'btn--primary' }),
      ),
    );

    if (report) {
      const tasks = report.results.map((result) => ({
        label: result.check.label,
        done: result.passed,
        detail: result.detail,
      }));
      this.card.append(
        h(
          'ul',
          { class: 'level-card__tasks' },
          ...tasks.map((task) =>
            h(
              'li',
              { class: task.done ? 'level-card__task--done' : '', title: task.detail },
              `${task.done ? '✓' : '•'} ${task.label} — ${task.detail}`,
            ),
          ),
        ),
      );
    } else {
      this.card.append(
        h(
          'p',
          { class: 'hint' },
          progress < 1
            ? `Выход на равновесие: ${Math.round(progress * 100)} %.`
            : 'Измерение: подождите, идёт набор статистики.',
        ),
      );
    }

    if (report?.passed) {
      const next = nextLevel(level.id);
      this.card.append(
        h(
          'div',
          { class: 'row' },
          next ? button('Следующий уровень →', () => this.actions.startLevel(next)) : h('span', {}, ''),
        ),
      );
    }

    for (const [id, btn] of this.levelButtons) btn.classList.toggle('preset--on', id === level.id);
  }

  /** Отметить уровень пройденным (для списка). */
  markCompleted(levelId: string): void {
    if (this.completed.has(levelId)) return;
    this.completed.add(levelId);
    const btn = this.levelButtons.get(levelId);
    if (btn) {
      btn.classList.add('preset--on');
      const title = btn.querySelector('.preset__title');
      if (title && !title.textContent?.startsWith('✓')) {
        title.textContent = `✓ ${title.textContent ?? ''}`;
      }
    }
  }

  /** Пройденные уровни. */
  get completedIds(): string[] {
    return [...this.completed];
  }

  /** Вернуться к карточке песочницы. */
  showSandbox(): void {
    for (const btn of this.levelButtons.values()) btn.classList.remove('preset--on');
    this.showIdleCard();
  }
}

/**
 * Модальное окно с теорией уровня.
 *
 * Кнопка «Закрыть» здесь ровно одна: в logic_lab этот дефект уже ловили —
 * вторая кнопка на самой панели закрывала её, оставляя пустое окно.
 * Поэтому закрытие собрано в одном месте, и смоук-тест проверяет его.
 */
export function openLevelTheory(level: Level): void {
  const body = h('div', { class: 'modal__body', html: theoryHtml(level) });
  const backdrop = h('div', { class: 'modal-backdrop' });
  const close = (): void => {
    backdrop.remove();
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') close();
  };
  const modal = h(
    'div',
    { class: 'modal' },
    h('div', { class: 'modal__head' }, `${levelNumber(level)}. ${level.title}`),
    body,
    h('div', { class: 'modal__foot' }, button('Закрыть', close, { class: 'btn--primary' })),
  );
  backdrop.append(modal);
  backdrop.addEventListener('modal:close', close);
  document.body.append(backdrop);
  document.addEventListener('keydown', onKey);
}

/** HTML теории уровня — с формулой и подсказками. */
export function theoryHtml(level: Level): string {
  const parts: string[] = [renderMarkdown(level.theory)];
  if (level.formula) {
    parts.push('<h3>Формула</h3>');
    parts.push(`<pre><code>${level.formula.replace(/</g, '&lt;')}</code></pre>`);
  }
  parts.push('<h3>Задача</h3>');
  parts.push(`<p>${level.task}</p>`);
  parts.push('<h3>Подсказки</h3>');
  parts.push(`<ul>${level.hints.map((hint) => `<li>${hint}</li>`).join('')}</ul>`);
  return parts.join('\n');
}

/**
 * Модальное окно «Справка»: что это за проект и как им пользоваться.
 * Показывается при первом запуске.
 */
export function openHelp(): void {
  const html = `
<h2>Phys Lab — песочница молекулярной динамики</h2>
<p>Это честная симуляция: никаких заранее запрограммированных фаз. Есть частицы, между ними силы —
и всё, что вы видите (кристалл, плавление, испарение, капля), <strong>возникает</strong> из уравнений движения.</p>
<h3>Что происходит под капотом</h3>
<ul>
<li><strong>Потенциал Леннарда-Джонса</strong>: <code>U(r) = 4ε[(σ/r)¹² − (σ/r)⁶]</code> — отталкивание вблизи,
притяжение на средних расстояниях.</li>
<li><strong>Интегрирование Верле</strong>: симплектическая схема, которая сохраняет энергию, а не «съедает» её.</li>
<li><strong>Списки Верле</strong>: сетка ячеек превращает перебор пар из O(N²) в O(N) — поэтому 10 000 частиц считаются в браузере.</li>
<li><strong>Термостаты</strong>: Берендсен (масштабирование скоростей), Ланжевен (трение и шум),
Нозе-Хувер (канонический ансамбль) или никакого — тогда энергия сохраняется.</li>
</ul>
<h3>Как управлять</h3>
<table>
<thead><tr><th>Действие</th><th>Результат</th></tr></thead>
<tbody>
<tr><td>Тянуть левой кнопкой</td><td>Толкать частицы — создавать локальное возмущение</td></tr>
<tr><td>Колесо мыши</td><td>Масштаб</td></tr>
<tr><td>Правая кнопка + тянуть</td><td>Поворот сцены</td></tr>
<tr><td>Shift + тянуть</td><td>Сдвиг камеры</td></tr>
<tr><td>Пробел</td><td>Пауза / продолжить</td></tr>
<tr><td>R</td><td>Пересобрать систему</td></tr>
</tbody>
</table>
<h3>Что читать на экране</h3>
<p>Цвет частицы — её скорость (синяя медленная, красная быстрая). График <strong>g(r)</strong> — радиальная функция
распределения: у кристалла она даёт резкие пики, у жидкости — размытые, у газа — почти единицу.
Это самая надёжная «рентгенограмма» состояния, доступная прямо на экране.</p>
<h3>Честность единиц</h3>
<p>Все величины приведены в единицах Леннарда-Джонса: ε = σ = m = k<sub>B</sub> = 1. Для аргона
σ ≈ 0.34 нм, ε/k<sub>B</sub> ≈ 120 К — то есть T* = 1.0 соответствует примерно 120 К.</p>
  `;
  const body = h('div', { class: 'modal__body', html });
  const backdrop = h('div', { class: 'modal-backdrop' });
  const close = (): void => {
    backdrop.remove();
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') close();
  };
  backdrop.append(
    h(
      'div',
      { class: 'modal' },
      h('div', { class: 'modal__head' }, 'Справка'),
      body,
      h('div', { class: 'modal__foot' }, button('Понятно', close, { class: 'btn--primary' })),
    ),
  );
  document.body.append(backdrop);
  document.addEventListener('keydown', onKey);
}

/** Проверка, что нужный элемент интерфейса действительно создан. */
export function assertCampaignMount(root: HTMLElement): void {
  need('[data-panel="campaign"]', root);
}
