/**
 * Начальные конфигурации.
 *
 * Физика фазового перехода видна только при осмысленном старте, поэтому здесь
 * три разных рецепта:
 *
 *   - ГЦК-решётка (fcc) — равновесная структура Леннарда-Джонса при низкой
 *     температуре. Из неё наблюдают плавление: частицы колеблются около узлов,
 *     а при нагреве узел «плывёт»;
 *   - случайный газ — старт для конденсации: при охлаждении частицы сами
 *     собираются в капли и кристаллиты;
 *   - капля в пустоте — для поверхностного натяжения: капля стягивается в шар,
 *     потому что поверхностные атомы «недосчитались» соседей.
 *
 * ─── Главное правило: решётка и плотность должны быть согласованы ─────────
 *
 * Раньше здесь стояла ошибка, которую стоит описать: решётка строилась на
 * `ceil(cbrt(N/4))` ячейках, а длина ящика бралась из (N/ρ)^(1/3). Эти два
 * числа не связаны, и шаг решётки a = L/ячеек оказывался таким, что настоящая
 * плотность кристалла была 4/a³ — совсем не та, что просили (при N = 400,
 * ρ = 0.85 выходило 1.06). Система стартовала в сильно сжатом состоянии,
 * интегратор «взрывался» на 25-м шаге.
 *
 * Теперь порядок обратный: сначала выбирается число ячеек n, из него —
 * реальное число частиц N = 4n³, и только потом длина ящика L = (N/ρ)^(1/3).
 * Плотность получается ровно заданной, вакансий нет вовсе, решётка идеальна.
 * Цена — число частиц округляется до ближайшего представимого (2000 → 2048,
 * 400 → 500); фактическое значение возвращается в `placed` и показывается
 * в интерфейсе.
 */

import { Rng } from './rng.js';
import { allocState, boxLength, type LatticeKind, type ParticleState } from './types.js';
import { kineticEnergyOfState, removeDriftNow } from './velocity.js';

/** Результат построения конфигурации. */
export interface BuildResult {
  state: ParticleState;
  /** Длина ящика, согласованная с плотностью. */
  box: number;
  /** Сколько частиц реально размещено — может отличаться от запрошенного. */
  placed: number;
}

/** Плотность внутри свободной капли: у жидкости Леннарда-Джонса ≈ 1.0 σ⁻³. */
const DROPLET_DENSITY = 1.0;

/**
 * Построение состояния.
 *
 * @param kind        тип начальной конфигурации
 * @param count       желаемое число частиц (для решёток округляется)
 * @param density     ρ* = N/V
 * @param temperature начальная T*
 * @param seed        зерно генератора
 */
export function buildState(
  kind: LatticeKind,
  count: number,
  density: number,
  temperature: number,
  seed = 12345,
): BuildResult {
  const rng = new Rng(seed);

  let placed: number;
  let box: number;
  let state: ParticleState;
  let fill: (state: ParticleState, box: number, rng: Rng) => number;

  switch (kind) {
    case 'fcc': {
      const cells = Math.max(1, Math.round(Math.cbrt(count / 4)));
      placed = 4 * cells * cells * cells;
      box = boxLength(placed, density);
      state = allocState(placed);
      fill = (s, b, r) => fillFcc(s, b, cells, r);
      break;
    }
    case 'sc': {
      const cells = Math.max(1, Math.round(Math.cbrt(count)));
      placed = cells * cells * cells;
      box = boxLength(placed, density);
      state = allocState(placed);
      fill = (s, b, r) => fillSimpleCubic(s, b, cells, r);
      break;
    }
    case 'droplet': {
      placed = Math.max(1, Math.round(count));
      box = boxLength(placed, density);
      state = allocState(placed);
      fill = (s, b, r) => fillDroplet(s, b, r);
      break;
    }
    case 'random':
    default: {
      placed = Math.max(1, Math.round(count));
      box = boxLength(placed, density);
      state = allocState(placed);
      fill = (s, b, r) => fillRandom(s, b, r);
      break;
    }
  }

  state.alive.fill(1);
  const filled = fill(state, box, rng);
  if (filled < placed) {
    // Рецепт не смог расставить всех (например, теснота при случайном газе).
    // Лишние места честно помечаются несуществующими, и фактическое число
    // частиц возвращается наружу — иначе вызывающий код считал бы, что
    // расставлены все, и читал бы нулевые координаты незанятых мест.
    for (let i = filled; i < placed; i++) state.alive[i] = 0;
    state.count = filled;
    placed = filled;
  }

  assignMaxwellVelocities(state, temperature, rng);
  removeDriftNow(state);
  normaliseTemperature(state, temperature, rng);
  recallReferences(state);
  return { state, box, placed };
}

/**
 * ГЦК-решётка: четыре базисных атома на ячейку —
 * (0,0,0), (0,½,½), (½,0,½), (½,½,0).
 *
 * Это структура плотнейшей упаковки, именно в неё садится Леннард-Джонс при
 * затвердевании. Шаг решётки a = L/n задан конструкцией, а не подбирается:
 * отсюда и согласованность плотности.
 */
function fillFcc(state: ParticleState, box: number, cells: number, _rng: Rng): number {
  const a = box / cells;
  const basis: ReadonlyArray<readonly [number, number, number]> = [
    [0, 0, 0],
    [0, 0.5, 0.5],
    [0.5, 0, 0.5],
    [0.5, 0.5, 0],
  ];
  let k = 0;
  for (let gx = 0; gx < cells; gx++) {
    for (let gy = 0; gy < cells; gy++) {
      for (let gz = 0; gz < cells; gz++) {
        for (let b = 0; b < 4; b++) {
          const atom = basis[b];
          state.x[k] = (gx + atom[0]) * a;
          state.y[k] = (gy + atom[1]) * a;
          state.z[k] = (gz + atom[2]) * a;
          k++;
        }
      }
    }
  }
  return k;
}

/** Простая кубическая решётка — грубее ГЦК, но нагляднее «сеточкой». */
function fillSimpleCubic(state: ParticleState, box: number, cells: number, _rng: Rng): number {
  const a = box / cells;
  let k = 0;
  for (let gx = 0; gx < cells; gx++) {
    for (let gy = 0; gy < cells; gy++) {
      for (let gz = 0; gz < cells; gz++) {
        state.x[k] = gx * a;
        state.y[k] = gy * a;
        state.z[k] = gz * a;
        k++;
      }
    }
  }
  return k;
}

/**
 * Случайный газ с запретом наложений.
 *
 * Равномерная расстановка почти всегда даёт пары ближе σ, а это энергия
 * порядка 10⁴ ε — мгновенный «взрыв» на первом же шаге. Поэтому каждая новая
 * частица проверяется на минимальное расстояние; после серии неудач порог
 * ослабляется — лучше слегка тесная конфигурация, чем бесконечный цикл.
 * Если расставить всех так и не удалось, `placed` окажется меньше запрошенного,
 * и это будет видно в интерфейсе.
 */
function fillRandom(state: ParticleState, box: number, rng: Rng): number {
  const count = state.count;
  let minDistance = 0.9;
  let placed = 0;
  let attempts = 0;
  const maxAttempts = count * 80;
  while (placed < count && attempts < maxAttempts) {
    attempts++;
    if (attempts % (count * 4) === 0) minDistance = Math.max(0.55, minDistance * 0.85);
    const x = rng.next() * box;
    const y = rng.next() * box;
    const z = rng.next() * box;
    let ok = true;
    const limit = minDistance * minDistance;
    for (let i = 0; i < placed; i++) {
      let dx = x - state.x[i];
      let dy = y - state.y[i];
      let dz = z - state.z[i];
      dx -= box * Math.round(dx / box);
      dy -= box * Math.round(dy / box);
      dz -= box * Math.round(dz / box);
      if (dx * dx + dy * dy + dz * dz < limit) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    state.x[placed] = x;
    state.y[placed] = y;
    state.z[placed] = z;
    placed++;
  }
  return placed;
}

/**
 * Капля: ГЦК-решётка, обрезанная сферой в центре ящика.
 *
 * Шаг решётки соответствует плотности внутри капли (≈ 1.0 σ⁻³), а радиус
 * подбирается так, чтобы внутрь попало примерно N частиц. Плотность всего
 * ящика при этом много меньше — так и должно быть, свободная капля окружена
 * пустотой.
 */
function fillDroplet(state: ParticleState, box: number, _rng: Rng): number {
  const count = state.count;
  const a = Math.cbrt(4 / DROPLET_DENSITY);
  const radius = Math.cbrt((3 * count) / (4 * Math.PI * DROPLET_DENSITY));
  const center = box / 2;
  const cells = Math.ceil((2 * radius) / a) + 1;
  const r2Limit = radius * radius;

  const basis: ReadonlyArray<readonly [number, number, number]> = [
    [0, 0, 0],
    [0, 0.5, 0.5],
    [0.5, 0, 0.5],
    [0.5, 0.5, 0],
  ];

  let placed = 0;
  const start = center - (cells * a) / 2;
  for (let gx = 0; gx < cells && placed < count; gx++) {
    for (let gy = 0; gy < cells && placed < count; gy++) {
      for (let gz = 0; gz < cells && placed < count; gz++) {
        for (let b = 0; b < 4 && placed < count; b++) {
          const atom = basis[b];
          const px = start + (gx + atom[0]) * a;
          const py = start + (gy + atom[1]) * a;
          const pz = start + (gz + atom[2]) * a;
          const dx = px - center;
          const dy = py - center;
          const dz = pz - center;
          if (dx * dx + dy * dy + dz * dz > r2Limit) continue;
          state.x[placed] = px;
          state.y[placed] = py;
          state.z[placed] = pz;
          placed++;
        }
      }
    }
  }
  return placed;
}

/** Максвелловские скорости: компоненты нормальны с дисперсией T/m. */
export function assignMaxwellVelocities(state: ParticleState, temperature: number, rng: Rng): void {
  const sigma = Math.sqrt(Math.max(0, temperature));
  for (let i = 0; i < state.count; i++) {
    if (state.alive[i] === 0) {
      state.vx[i] = 0;
      state.vy[i] = 0;
      state.vz[i] = 0;
      continue;
    }
    state.vx[i] = sigma * rng.normal();
    state.vy[i] = sigma * rng.normal();
    state.vz[i] = sigma * rng.normal();
  }
}

/**
 * Точная нормировка температуры.
 *
 * После вычитания дрейфа температура «примерно T»: максвелловская выборка
 * конечного размера даёт разброс порядка 1/√N. Здесь она приводится к T
 * ровно, чтобы первый кадр на графике не противоречил слайдеру.
 */
export function normaliseTemperature(state: ParticleState, target: number, rng: Rng): void {
  let n = 0;
  for (let i = 0; i < state.count; i++) if (state.alive[i] !== 0) n++;
  if (n < 2) return;
  const dof = 3 * n - 3;
  const kinetic = kineticEnergyOfState(state);
  if (kinetic < 1e-12) {
    assignMaxwellVelocities(state, target, rng);
    return;
  }
  const current = (2 * kinetic) / dof;
  if (current <= 0) return;
  const factor = Math.sqrt(target / current);
  for (let i = 0; i < state.count; i++) {
    state.vx[i] *= factor;
    state.vy[i] *= factor;
    state.vz[i] *= factor;
  }
}

/** Запомнить исходные координаты — точка отсчёта накопленного пути. */
export function recallReferences(state: ParticleState): void {
  state.refX.set(state.x);
  state.refY.set(state.y);
  state.refZ.set(state.z);
  state.travel.fill(0);
}

/**
 * Изменение плотности «на месте»: ящик сжимается или растягивается,
 * а координаты масштабируются вместе с ним. Так работает кнопка «сжать»:
 * мгновенная деформация, дальше система релаксирует сама.
 */
export function rescaleBox(
  state: ParticleState,
  oldBox: number,
  newBox: number,
  periodic: boolean,
): void {
  const factor = newBox / oldBox;
  for (let i = 0; i < state.count; i++) {
    state.x[i] *= factor;
    state.y[i] *= factor;
    state.z[i] *= factor;
    state.refX[i] *= factor;
    state.refY[i] *= factor;
    state.refZ[i] *= factor;
    if (periodic) {
      state.x[i] -= newBox * Math.floor(state.x[i] / newBox);
      state.y[i] -= newBox * Math.floor(state.y[i] / newBox);
      state.z[i] -= newBox * Math.floor(state.z[i] / newBox);
    }
  }
}
