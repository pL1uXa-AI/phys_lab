/**
 * Измерения: температура, энергия, давление, радиальная функция g(r).
 *
 * Термодинамические величины в приведённых единицах Леннарда-Джонса
 * (ε = σ = m = k_B = 1):
 *
 *   кинетическая энергия   K = ½ Σ m v²
 *   температура            T = 2K / N_df,  N_df = 3N − 3
 *   давление               P = (N T + W/3) / V,  W = Σ F_i·r_i
 *
 * Почему N_df = 3N − 3, а не 3N: три степени свободы забраны движением
 * центра масс, которое в периодическом ящике лишено физического смысла.
 * Если его не вычесть, температура окажется систематически завышена —
 * а термостат, наоборот, переохладит систему.
 */

import { buildGrid } from './grid.js';
import type { CellGrid, ParticleState } from './types.js';

/** Мгновенные измерения системы. */
export interface Measurement {
  /** Число «живых» частиц. */
  count: number;
  kinetic: number;
  potential: number;
  /** Полная энергия. Термостат в неё не входит: он — внешняя среда. */
  total: number;
  /** T* — температура. */
  temperature: number;
  /** Число степеней свободы, по которым считалась температура. */
  dof: number;
  /** P* — давление. */
  pressure: number;
  /** Вириал W = Σ F_i·r_i. */
  virial: number;
  /** Средний модуль скорости. */
  meanSpeed: number;
  /**
   * Доля частиц, СМЕСТИВШИХСЯ больше чем на половину σ от исходного места.
   *
   * Именно смещение, а не накопленный путь. Разница принципиальна: у
   * кристалла частица колеблется вокруг узла, накапливая за минуту несколько σ
   * пути, но оставаясь в пределах 0.1σ от узла. Признак по пути объявил бы
   * кристалл жидкостью — эта ошибка уже случалась и ловится уровнями.
   */
  mobileFraction: number;
  /** Средний модуль смещения по всем частицам (в σ). */
  meanDisplacement: number;
}

/**
 * Давление P* = (N T + W/3) / V.
 *
 * Знак перед вириалом легко перепутать, поэтому выведем его один раз.
 * Вириальная теорема для парных сил:
 *
 *   3PV = N k T + ⟨Σ_{i<j} r_ij · f_ij⟩,
 *
 * где r_ij = r_i − r_j, а f_ij — сила, действующая НА i СО СТОРОНЫ j.
 * При притяжении f_ij направлена от i к j, то есть противоположна r_ij, и
 * вклад пары отрицателен — давление падает ниже идеального. Это правильная
 * физика: притяжение «стягивает» систему.
 *
 * Ровно так же вириал накапливается в `computeForces`: там `raw = (F/r)·d`
 * есть сила на j, а вклад записывается как `raw·d` = r_ij·f_ij.
 */
export function pressureOf(
  count: number,
  temperature: number,
  virial: number,
  volume: number,
): number {
  return (count * temperature + virial / 3) / volume;
}

/**
 * Полное измерение состояния по уже посчитанным силам и вириалу.
 *
 * Потенциальная энергия передаётся снаружи: она уже известна из расчёта сил,
 * и второй обход всех пар только ради неё — непозволительная роскошь.
 * Здесь же обновляются кэши для раскраски (модуль скорости и смещение).
 *
 * @param subtractDrift учитывать ли фиксацию центра масс (периодические границы)
 */
export function measure(
  state: ParticleState,
  box: number,
  potential: number,
  virial: number,
  subtractDrift: boolean,
): Measurement {
  let count = 0;
  let kinetic = 0;
  let speedSum = 0;
  let mobile = 0;
  let displacementSum = 0;

  const vx = state.vx;
  const vy = state.vy;
  const vz = state.vz;
  const speed = state.speed;
  const displacement = state.displacement;
  const x = state.x;
  const y = state.y;
  const z = state.z;
  const refX = state.refX;
  const refY = state.refY;
  const refZ = state.refZ;
  const alive = state.alive;
  const half = box * 0.5;

  for (let i = 0; i < state.count; i++) {
    if (alive[i] === 0) continue;
    count++;
    const v2 = vx[i] * vx[i] + vy[i] * vy[i] + vz[i] * vz[i];
    kinetic += 0.5 * v2;
    const s = Math.sqrt(v2);
    speed[i] = s;
    speedSum += s;

    // Смещение от исходного положения с минимальным образом: частица,
    // перешедшая через границу ящика, сместилась на полклетки, а не на весь L.
    let dx = x[i] - refX[i];
    let dy = y[i] - refY[i];
    let dz = z[i] - refZ[i];
    if (dx > half) dx -= box;
    else if (dx < -half) dx += box;
    if (dy > half) dy -= box;
    else if (dy < -half) dy += box;
    if (dz > half) dz -= box;
    else if (dz < -half) dz += box;

    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    displacement[i] = d;
    displacementSum += d;
    if (d > 0.5) mobile++;
  }

  const dof = Math.max(1, 3 * count - (subtractDrift && count > 1 ? 3 : 0));
  const temperature = (2 * kinetic) / dof;
  const volume = box * box * box;
  return {
    count,
    kinetic,
    potential,
    total: potential + kinetic,
    temperature,
    dof,
    pressure: pressureOf(count, temperature, virial, volume),
    virial,
    meanSpeed: count > 0 ? speedSum / count : 0,
    mobileFraction: count > 0 ? mobile / count : 0,
    meanDisplacement: count > 0 ? displacementSum / count : 0,
  };
}

/* ===========================================================================
   Радиальная функция распределения
   =========================================================================== */

/** Максимальное число слоёв: выше 200 кривая становится шумной. */
const MAX_BINS = 200;

/**
 * 13 «передних» соседних ячеек — те же, что и в расчёте сил.
 * Плоским списком по три числа, чтобы обход не разыменовывал массивы.
 */
const HALF_OFFSETS = Int32Array.from([
  -1, -1, 1,
  0, -1, 1,
  1, -1, 1,
  -1, 0, 1,
  0, 0, 1,
  1, 0, 1,
  -1, 1, 1,
  0, 1, 1,
  1, 1, 1,
  -1, 1, 0,
  0, 1, 0,
  1, 1, 0,
  1, 0, 0,
]);

/** Квадрат расстояния между частицей j и точкой, с минимальным образом. */
function distanceSq(
  x: Float64Array,
  y: Float64Array,
  z: Float64Array,
  j: number,
  xi: number,
  yi: number,
  zi: number,
  box: number,
  half: number,
  periodic: boolean,
): number {
  let dx = x[j] - xi;
  let dy = y[j] - yi;
  let dz = z[j] - zi;
  if (periodic) {
    if (dx > half) dx -= box;
    else if (dx < -half) dx += box;
    if (dy > half) dy -= box;
    else if (dy < -half) dy += box;
    if (dz > half) dz -= box;
    else if (dz < -half) dz += box;
  }
  return dx * dx + dy * dy + dz * dz;
}

/**
 * Радиальная функция распределения g(r).
 *
 * ─── Почему это переписано ───────────────────────────────────────────────
 *
 * Первая версия считала все пары честно: N(N−1)/2 на каждый кадр статистики.
 * На 2000 частиц это 22 мс, на 20 000 — 1.9 СЕКУНДЫ на кадр. Приложение
 * упиралось именно в g(r), а не в физику: шаг симуляции стоил 5 мс, то есть
 * один кадр статистики был дороже 380 шагов.
 *
 * Теперь гистограмма строится по ТОЙ ЖЕ сетке ячеек, что и силы: частица
 * сравнивается только с соседями из ближайших ячеек, и стоимость падает
 * с O(N²) до O(N). Пара учитывается один раз (лексикографический порядок
 * ячеек), поэтому третий закон соблюдён.
 *
 * ─── Что такое g(r) ──────────────────────────────────────────────────────
 *
 * Главная «рентгенограмма» состояния: у кристалла — набор резких пиков на
 * расстояниях, кратных шагу решётки; у жидкости — несколько размытых;
 * у газа — почти единица с горбом на расстоянии притяжения.
 *
 * Нормировка:  ⟨пар в слое k⟩ = N(N−1)/2 · (4πr²dr / V) · g(r).
 *
 * Одного кадра мало: при N = 2000 в тонкий слой попадают единицы пар,
 * и кривая выходит рваной. Копить нужно десятки кадров.
 */
export class RadialDistribution {
  /** Число слоёв. */
  readonly bins: number;
  /** Ширина слоя. */
  readonly dr: number;
  /** Максимальный радиус. */
  readonly maxRadius: number;

  private readonly histogram: Float64Array;
  private frames = 0;
  /** Живых частиц в последнем кадре — нужно для нормировки. */
  private lastCount = 0;

  /**
   * Собственная сетка ячеек.
   *
   * Размер ячейки равен максимальному радиусу, а не радиусу обрезания
   * потенциала. Тогда достаточно ровно 27 соседних ячеек — обход постоянный
   * и предсказуемый. Использовать сетку сил здесь нельзя: её ячейка (2.5σ)
   * меньше максимального радиуса g(r) (3.5σ), и окрестность превращалась бы
   * в сотни ячеек, то есть в честный O(N²).
   */
  private grid: CellGrid | null = null;

  constructor(maxRadius = 3.5, bins = 140) {
    this.bins = Math.min(bins, MAX_BINS);
    this.maxRadius = maxRadius;
    this.dr = maxRadius / this.bins;
    this.histogram = new Float64Array(this.bins);
  }

  /** Радиус центра слоя k. */
  radius(k: number): number {
    return (k + 0.5) * this.dr;
  }

  /** Число накопленных кадров. */
  get sampleCount(): number {
    return this.frames;
  }

  /** Пересоздание собственной сетки под ящик (вызывается при смене геометрии). */
  prepare(count: number, box: number): void {
    const size = this.maxRadius;
    const n = Math.max(3, Math.floor(box / size));
    const cells = n * n * n;
    this.grid = {
      n,
      // Ячейка ровно по размеру сетки: box делится на n, и n берётся так,
      // чтобы итоговый размер был НЕ МЕНЬШЕ максимального радиуса.
      size: box / n,
      cellStart: new Int32Array(cells + 1),
      order: new Int32Array(count),
      cellIndex: new Int32Array(count),
      counts: new Int32Array(cells),
    };
  }

  /**
   * Добавить один кадр.
   *
   * Сетка строится здесь же: пересчёт занимает доли миллисекунды, а держать
   * её актуальной между кадрами статистики всё равно невозможно — координаты
   * меняются каждый шаг.
   *
   * @param periodic применять ли минимальный образ
   */
  accumulate(state: ParticleState, box: number, periodic: boolean): void {
    const count = state.count;
    if (count < 2) return;

    const alive = state.alive;
    let aliveCount = 0;
    for (let i = 0; i < count; i++) if (alive[i] !== 0) aliveCount++;
    if (aliveCount < 2) return;
    this.lastCount = aliveCount;

    if (!this.grid || this.grid.order.length !== count) this.prepare(count, box);
    const grid = this.grid;
    if (!grid) return;

    // Ячейка не меньше радиуса: n = floor(box / maxRadius), size = box / n.
    // Если ящик мал настолько, что ячеек меньше трёх, честный перебор дешевле.
    if (grid.n < 3) {
      this.accumulateBruteForce(state, box, periodic);
      return;
    }

    buildGrid(state, grid);

    const n = grid.n;
    const limSq = this.maxRadius * this.maxRadius;
    const invDr = 1 / this.dr;
    const half = box * 0.5;
    const x = state.x;
    const y = state.y;
    const z = state.z;
    const cellStart = grid.cellStart;
    const order = grid.order;
    const cellCount = n * n * n;
    const histogram = this.histogram;
    const bins = this.bins;

    for (let c = 0; c < cellCount; c++) {
      const gz = c % n;
      const gy = ((c - gz) / n) % n;
      const gx = (c - gz - n * gy) / (n * n);
      const startA = cellStart[c];
      const endA = cellStart[c + 1];
      if (startA === endA) continue;

      for (let a = startA; a < endA; a++) {
        const i = order[a];
        const xi = x[i];
        const yi = y[i];
        const zi = z[i];

        // Своя ячейка: пары «вперёд» по индексу.
        for (let b = a + 1; b < endA; b++) {
          const j = order[b];
          const r2 = distanceSq(x, y, z, j, xi, yi, zi, box, half, periodic);
          if (r2 >= limSq) continue;
          const k = (Math.sqrt(r2) * invDr) | 0;
          if (k < bins) histogram[k]++;
        }

        // 13 «передних» ячеек — каждая пара ячеек ровно один раз.
        for (let o = 0; o < HALF_OFFSETS.length; o += 3) {
          let nx = gx + HALF_OFFSETS[o];
          let ny = gy + HALF_OFFSETS[o + 1];
          let nz = gz + HALF_OFFSETS[o + 2];
          if (periodic) {
            if (nx < 0) nx += n;
            else if (nx >= n) nx -= n;
            if (ny < 0) ny += n;
            else if (ny >= n) ny -= n;
            if (nz < 0) nz += n;
            else if (nz >= n) nz -= n;
          } else if (nx < 0 || nx >= n || ny < 0 || ny >= n || nz < 0 || nz >= n) {
            continue;
          }
          const c2 = (nx * n + ny) * n + nz;
          const startB = cellStart[c2];
          const endB = cellStart[c2 + 1];
          for (let b = startB; b < endB; b++) {
            const j = order[b];
            const r2 = distanceSq(x, y, z, j, xi, yi, zi, box, half, periodic);
            if (r2 >= limSq) continue;
            const k = (Math.sqrt(r2) * invDr) | 0;
            if (k < bins) histogram[k]++;
          }
        }
      }
    }
    this.frames++;
  }

  /**
   * Честный перебор всех пар — для разрежённого газа и мелких сеток.
   * Стоимость O(N²), но при малой плотности это дешевле обхода окрестности.
   */
  private accumulateBruteForce(state: ParticleState, box: number, periodic: boolean): void {
    const count = state.count;
    const limSq = this.maxRadius * this.maxRadius;
    const invDr = 1 / this.dr;
    const half = box * 0.5;
    const x = state.x;
    const y = state.y;
    const z = state.z;
    const alive = state.alive;
    const histogram = this.histogram;
    const bins = this.bins;

    for (let i = 0; i < count; i++) {
      if (alive[i] === 0) continue;
      const xi = x[i];
      const yi = y[i];
      const zi = z[i];
      for (let j = i + 1; j < count; j++) {
        if (alive[j] === 0) continue;
        let dx = x[j] - xi;
        let dy = y[j] - yi;
        let dz = z[j] - zi;
        if (periodic) {
          if (dx > half) dx -= box;
          else if (dx < -half) dx += box;
          if (dy > half) dy -= box;
          else if (dy < -half) dy += box;
          if (dz > half) dz -= box;
          else if (dz < -half) dz += box;
        }
        const r2 = dx * dx + dy * dy + dz * dz;
        if (r2 >= limSq) continue;
        const k = (Math.sqrt(r2) * invDr) | 0;
        if (k < bins) histogram[k]++;
      }
    }
    this.frames++;
  }

  /** Очистить накопленное. */
  reset(): void {
    this.histogram.fill(0);
    this.frames = 0;
    this.lastCount = 0;
  }

  /** Готовая функция g(r). */
  result(box: number): { r: Float64Array; g: Float64Array } {
    const bins = this.bins;
    const r = new Float64Array(bins);
    const g = new Float64Array(bins);
    const n = this.lastCount;
    const frames = Math.max(1, this.frames);
    const volume = box * box * box;
    const pairsTotal = (n * (n - 1)) / 2;
    for (let k = 0; k < bins; k++) {
      const radius = this.radius(k);
      r[k] = radius;
      const shell = 4 * Math.PI * radius * radius * this.dr;
      const ideal = (pairsTotal * shell * frames) / volume;
      g[k] = ideal > 0 ? this.histogram[k] / ideal : 0;
    }
    return { r, g };
  }

  /**
   * Высота первого пика — грубая мера кристалличности.
   * У жидкости ≈ 2.5…3, у кристалла 5 и выше.
   */
  firstPeak(box: number): number {
    const { r, g } = this.result(box);
    let peak = 0;
    for (let k = 0; k < r.length; k++) {
      if (r[k] < 0.9) continue;
      if (r[k] > 1.7) break;
      if (g[k] > peak) peak = g[k];
    }
    return peak;
  }
}
