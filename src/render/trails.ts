/**
 * Запись шлейфов траекторий.
 *
 * ─── Зачем это нужно ─────────────────────────────────────────────────────
 *
 * Статичный кадр не показывает САМОГО ГЛАВНОГО: двигаются частицы или стоят
 * на месте. В кристалле атомы колеблются вокруг узла, в жидкости уезжают
 * далеко — но на одном кадре эти состояния выглядят одинаково.
 *
 * Шлейф решает эту задачу буквально: если запомнить, где частица была
 * последние несколько десятков кадров, и соединить эти точки, то у кристалла
 * получается крошечная «клякса» вокруг узла, а у жидкости — длинная извилистая
 * линия. Диффузия, течение, испарение становятся видны сразу.
 *
 * ─── Почему только у части меченых частиц ────────────────────────────────
 *
 * Рисовать шлейф каждому из 20 000 атомов бессмысленно: линии заполнят весь
 * экран и превратятся в кашу, а стоимость вырастет на порядок. Поэтому
 * выбирается небольшое подмножество — «меченые» частицы, равномерно
 * разбросанные по индексам. Это не подмена: любая достаточно большая
 * случайная подвыборка показывает ту же статистику.
 *
 * Модуль не знает ни про Pixi, ни про DOM — он хранит только координаты и
 * возвращает отрезки. Благодаря этому его поведение проверяется тестами
 * в чистом Node.
 */

/** Сколько частиц максимум помечается для шлейфов. */
export const MAX_MARKED = 64;

/**
 * Кольцевой буфер траекторий меченых частиц.
 *
 * Хранит последние `length` положений каждой меченой частицы. Кольцевая
 * структура выбрана по той же причине, что и в истории графиков: длинная
 * сессия не должна наращивать память.
 */
export class TrailBuffer {
  /** Сколько кадров хранит шлейф. */
  readonly length: number;

  /** Индексы меченых частиц. */
  private readonly marked: Int32Array;
  /** Число реально помеченных частиц. */
  private markedCount = 0;

  /**
   * Координаты: `points[(slot * markedCount + m) * 3 + axis]`.
   *
   * Раскладка «сначала слот, потом частица» выбрана потому, что при
   * отрисовке мы обходим отрезки по частицам и нам нужны соседние слоты
   * одной частицы — так они лежат через `markedCount * 3`.
   */
  private points: Float32Array;
  /** Сколько слотов уже занято (растёт до `length`, дальше кольцо). */
  private filled = 0;
  /** Куда пишется следующий слот. */
  private head = 0;

  constructor(length = 60, maxMarked = MAX_MARKED) {
    this.length = Math.max(2, Math.floor(length));
    this.marked = new Int32Array(Math.max(1, maxMarked));
    this.points = new Float32Array(this.length * Math.max(1, maxMarked) * 3);
  }

  /** Сколько частиц помечено. */
  get count(): number {
    return this.markedCount;
  }

  /** Сколько слотов истории заполнено (от 0 до `length`). */
  get depth(): number {
    return this.filled;
  }

  /**
   * Выбрать меченые частицы.
   *
   * Индексы берутся равномерно по всему диапазону, а не подряд: подряд
   * идущие атомы стоят рядом в пространстве, и шлейфы слились бы в одну
   * линию. Шаг по индексу к тому же детерминирован — одна и та же система
   * всегда даёт одни и те же меченые частицы.
   */
  markEvenly(count: number, maxMarked = this.marked.length): void {
    const n = Math.max(0, Math.min(count, maxMarked));
    this.markedCount = n;
    this.filled = 0;
    this.head = 0;
    if (n === 0) return;
    // Равномерный шаг по «живым» индексам. Для больших систем это выборка
    // по всему объёму ящика, а не по его углу.
    const stride = count / n;
    for (let m = 0; m < n; m++) {
      this.marked[m] = Math.min(count - 1, Math.floor(m * stride));
    }
    // Буфер под текущее число меченых: если пометили меньше, память
    // по-прежнему вмещает максимум, перевыделять не нужно.
    const need = this.length * this.marked.length * 3;
    if (this.points.length < need) this.points = new Float32Array(need);
  }

  /** Индекс меченой частицы по её порядковому номеру. */
  markedIndex(m: number): number {
    return this.marked[m];
  }

  /**
   * Записать текущие положения меченых частиц.
   *
   * Вызывается раз в кадр отрисовки, а не на каждый шаг физики: шлейф —
   * это визуальный след, и привязывать его к шагам интегрирования значило бы
   * хранить десятки тысяч точек там, где хватает десятков.
   */
  record(x: Float64Array, y: Float64Array, z: Float64Array, alive: Uint8Array): void {
    if (this.markedCount === 0) return;
    const slot = this.head;
    const stride = this.markedCount * 3;
    const base = slot * stride;
    for (let m = 0; m < this.markedCount; m++) {
      const i = this.marked[m];
      const offset = base + m * 3;
      if (alive[i] === 0) {
        // Мёртвая частица: помечаем координату как NaN, чтобы отрисовка
        // разорвала линию, а не соединила её с последним положением в
        // другом конце ящика.
        this.points[offset] = Number.NaN;
        this.points[offset + 1] = Number.NaN;
        this.points[offset + 2] = Number.NaN;
        continue;
      }
      this.points[offset] = x[i];
      this.points[offset + 1] = y[i];
      this.points[offset + 2] = z[i];
    }
    this.head = (this.head + 1) % this.length;
    if (this.filled < this.length) this.filled++;
  }

  /**
   * Отрезки шлейфов в мировых координатах.
   *
   * Каждый отрезок — это пара последовательных положений одной меченой
   * частицы. Хранимые координаты лежат в [0, L), поэтому при периодических
   * границах переход через стенку дал бы отрезок длиной в ящик; такие
   * отрезки помечаются флагом `wrapped` и отрисовкой пропускаются — иначе
   * на экране появлялись бы длинные линии поперёк всей сцены.
   *
   * Данные отдаются в переиспользуемый массив, чтобы не создавать мусор
   * каждый кадр.
   */
  segments(box: number, periodic: boolean, out: SegmentBuffer): SegmentBuffer {
    out.count = 0;
    const n = this.markedCount;
    const depth = this.filled;
    if (n === 0 || depth < 2) return out;

    // Старейший слот: если кольцо заполнено целиком, история начинается
    // с головы; иначе — с нулевого слота.
    const start = depth < this.length ? 0 : this.head;
    const half = box * 0.5;

    for (let m = 0; m < n; m++) {
      let prevSet = false;
      let px = 0;
      let py = 0;
      let pz = 0;
      for (let s = 0; s < depth; s++) {
        const slot = (start + s) % this.length;
        const offset = slot * n * 3 + m * 3;
        const cx = this.points[offset];
        const cy = this.points[offset + 1];
        const cz = this.points[offset + 2];
        if (Number.isNaN(cx)) {
          prevSet = false;
          continue;
        }
        if (prevSet) {
          let dx = cx - px;
          let dy = cy - py;
          let dz = cz - pz;
          let wrapped = false;
          if (periodic) {
            if (dx > half || dx < -half || dy > half || dy < -half || dz > half || dz < -half) {
              wrapped = true;
            } else {
              // Даже без выхода за половину ящика шаг шлейфа обязан быть
              // мал: скачок означает, что частица «телепортировалась»
              // через границу, и линию рисовать нельзя.
              const stepSq = dx * dx + dy * dy + dz * dz;
              if (stepSq > (box * 0.25) * (box * 0.25)) wrapped = true;
            }
          }
          out.push(px, py, pz, cx, cy, cz, wrapped);
        }
        px = cx;
        py = cy;
        pz = cz;
        prevSet = true;
      }
    }
    return out;
  }

  /** Полная очистка истории (при пересборке мира). */
  clear(): void {
    this.filled = 0;
    this.head = 0;
  }
}

/** Плоский буфер отрезков, переиспользуемый между кадрами. */
export class SegmentBuffer {
  /** Число отрезков. */
  count = 0;
  /** Координаты: по 6 чисел на отрезок (начало и конец). */
  data: Float32Array;
  /** Флаг «отрезок разорван периодической границей». */
  wrapped: Uint8Array;

  constructor(capacity = 8192) {
    this.data = new Float32Array(capacity * 6);
    this.wrapped = new Uint8Array(capacity);
  }

  /** Добавить отрезок. Возвращает false, если буфер заполнен. */
  push(
    x1: number,
    y1: number,
    z1: number,
    x2: number,
    y2: number,
    z2: number,
    wrapped: boolean,
  ): boolean {
    const k = this.count;
    if ((k + 1) * 6 > this.data.length) return false;
    const base = k * 6;
    this.data[base] = x1;
    this.data[base + 1] = y1;
    this.data[base + 2] = z1;
    this.data[base + 3] = x2;
    this.data[base + 4] = y2;
    this.data[base + 5] = z2;
    this.wrapped[k] = wrapped ? 1 : 0;
    this.count = k + 1;
    return true;
  }
}
