/**
 * Интегрирование уравнений движения.
 *
 * Схема — «скоростная» форма Верле (velocity Verlet):
 *
 *   v(t + dt/2) = v(t) + a(t)·dt/2
 *   x(t + dt)   = x(t) + v(t + dt/2)·dt
 *   вычислить a(t + dt)
 *   v(t + dt)   = v(t + dt/2) + a(t + dt)·dt/2
 *
 * Это ровно тот же результат, что даёт классическая формула
 * x(t+dt) = 2x(t) − x(t−dt) + a(t)dt², но скорости хранятся явно, а не
 * восстанавливаются разностью — так не теряется точность при малых dt.
 *
 * Почему это важно: Верле — симплектический интегратор. Он сохраняет фазовый
 * объём, поэтому энергия не «дрейфует» систематически, а колеблется возле
 * истинного значения. Явный метод Эйлера этим свойством не обладает: он
 * накачивает или съедает энергию, и система либо взрывается, либо замерзает.
 *
 * Разделение на «толчок» (kick) и «дрейф» (drift) не только соответствует
 * схеме, но и позволяет вставить термостат между половинами шага.
 */

import type { ParticleState } from './types.js';
import { type Rng } from './rng.js';
import { kineticEnergyOfState } from './velocity.js';

/**
 * Первая половина толчка: v += a·dt/2 по уже посчитанным силам.
 * Силы обязаны быть актуальны на момент вызова (их считает шаг симуляции).
 */
export function kick(state: ParticleState, halfDt: number): void {
  const vx = state.vx;
  const vy = state.vy;
  const vz = state.vz;
  const fx = state.fx;
  const fy = state.fy;
  const fz = state.fz;
  // Масса частицы равна единице, поэтому ускорение — это сила.
  for (let i = 0; i < state.count; i++) {
    vx[i] += fx[i] * halfDt;
    vy[i] += fy[i] * halfDt;
    vz[i] += fz[i] * halfDt;
  }
}

/**
 * Дрейф: x += v·dt. Заодно накапливается пройденный путь — по нему видно
 * плавление: у кристалла частица колеблется вокруг узла и путь растёт как
 * корень из времени, у жидкости — линейно.
 *
 * @param wrap       заворачивать ли координаты в ящик (периодические границы)
 * @param trackPath  накапливать ли смещение (для раскраски по подвижности)
 */
export function drift(
  state: ParticleState,
  dt: number,
  box: number,
  wrap: boolean,
  trackPath: boolean,
): void {
  const x = state.x;
  const y = state.y;
  const z = state.z;
  const vx = state.vx;
  const vy = state.vy;
  const vz = state.vz;
  const travel = state.travel;
  const invBox = 1 / box;

  for (let i = 0; i < state.count; i++) {
    if (state.alive[i] === 0) continue;
    // Сдвиг внутри ящика; при периодических границах он же — вектор перемещения.
    let sx = vx[i] * dt;
    let sy = vy[i] * dt;
    let sz = vz[i] * dt;
    if (trackPath) {
      if (wrap) {
        // Минимальный образ: частица, перескочившая через границу, прошла
        // короткий путь, а не почти весь ящик.
        sx -= box * Math.round(sx * invBox);
        sy -= box * Math.round(sy * invBox);
        sz -= box * Math.round(sz * invBox);
      }
      travel[i] += Math.sqrt(sx * sx + sy * sy + sz * sz);
    }
    let nx = x[i] + vx[i] * dt;
    let ny = y[i] + vy[i] * dt;
    let nz = z[i] + vz[i] * dt;
    if (wrap) {
      // Приведение в [0, box) без ветвлений и без накопления ошибки.
      nx -= box * Math.floor(nx * invBox);
      ny -= box * Math.floor(ny * invBox);
      nz -= box * Math.floor(nz * invBox);
    }
    x[i] = nx;
    y[i] = ny;
    z[i] = nz;
  }
}

/** Вторая половина толчка — вызывается после пересчёта сил. */
export function kickSecondHalf(state: ParticleState, halfDt: number): void {
  kick(state, halfDt);
}

/**
 * Упругие (отражающие) стенки — метод отражения с компенсацией.
 *
 * При столкновении координата зеркалится внутрь ящика, а скорость меняет знак.
 * Зеркалится именно избыток, поэтому частица не «залипает» в стенке и
 * не вылетает наружу при большой скорости.
 */
export function reflectWalls(state: ParticleState, box: number): void {
  const x = state.x;
  const y = state.y;
  const z = state.z;
  const vx = state.vx;
  const vy = state.vy;
  const vz = state.vz;
  const n = state.count;
  for (let i = 0; i < n; i++) {
    if (state.alive[i] === 0) continue;
    if (x[i] < 0) {
      x[i] = -x[i];
      vx[i] = -vx[i];
    } else if (x[i] >= box) {
      x[i] = 2 * box - x[i];
      vx[i] = -vx[i];
    }
    if (y[i] < 0) {
      y[i] = -y[i];
      vy[i] = -vy[i];
    } else if (y[i] >= box) {
      y[i] = 2 * box - y[i];
      vy[i] = -vy[i];
    }
    if (z[i] < 0) {
      z[i] = -z[i];
      vz[i] = -vz[i];
    } else if (z[i] >= box) {
      z[i] = 2 * box - z[i];
      vz[i] = -vz[i];
    }
  }
}

/**
 * Открытый ящик: частица, ушедшая дальше `margin` за границу, помечается
 * «улетевшей» и исключается из расчётов. Так выглядит испарение — без стенок
 * система теряет частицы, и это физически осмысленно.
 */
export function removeEscaped(state: ParticleState, box: number, margin: number): number {
  let removed = 0;
  const lim = box + margin;
  for (let i = 0; i < state.count; i++) {
    if (state.alive[i] === 0) continue;
    const beyond =
      state.x[i] < -margin ||
      state.x[i] > lim ||
      state.y[i] < -margin ||
      state.y[i] > lim ||
      state.z[i] < -margin ||
      state.z[i] > lim;
    if (beyond) {
      state.alive[i] = 0;
      state.vx[i] = 0;
      state.vy[i] = 0;
      state.vz[i] = 0;
      removed++;
    }
  }
  return removed;
}

/* ===========================================================================
   Термостаты
   =========================================================================== */

/**
 * Термостат Берендсена: масштабирование скоростей.
 *
 *   λ = √(1 + (dt/τ)(T₀/T − 1)),  v ← λv
 *
 * Дёшево и надёжно удерживает температуру, но даёт НЕправильные флуктуации
 * (канонический ансамбль не воспроизводится). Для визуализации фазовых
 * переходов этого достаточно; для честной статистики — Нозе-Хувер.
 *
 * @returns текущую температуру до масштабирования
 */
export function applyBerendsen(
  state: ParticleState,
  kinetic: number,
  dof: number,
  target: number,
  dt: number,
  tau: number,
): number {
  if (dof <= 0) return 0;
  const temperature = (2 * kinetic) / dof;
  if (temperature < 1e-12) return temperature;
  const factor = Math.sqrt(Math.max(0, 1 + (dt / tau) * (target / temperature - 1)));
  const vx = state.vx;
  const vy = state.vy;
  const vz = state.vz;
  for (let i = 0; i < state.count; i++) {
    vx[i] *= factor;
    vy[i] *= factor;
    vz[i] *= factor;
  }
  return temperature;
}

/**
 * Термостат Ланжевена: трение плюс шум.
 *
 * Уравнение Ланжевена  m v̇ = F − γ m v + ξ(t),  ⟨ξ(t)ξ(t′)⟩ = 2γ m k_B T δ(t−t′).
 *
 * Дискретизация взята точная для одного шага (не Эйлер—Марюяма):
 *
 *   c₁ = exp(−γ dt),   c₂ = √(T (1 − c₁²)),   v ← c₁ v + c₂ 𝒩(0,1)
 *
 * Это устойчиво при любых γ dt и правильно воспроизводит распределение
 * Максвелла: дисперсия после шага равна T, как и требует равновесие.
 *
 * Важно: трение задаётся ПО КАЖДОЙ компоненте скорости — шум должен быть
 * сбалансирован с ним, иначе температура «уедет». Коэффициент c₂ выведен
 * именно из этого баланса (флуктуационно-диссипационная теорема).
 */
export function applyLangevin(
  state: ParticleState,
  dt: number,
  friction: number,
  target: number,
  rng: Rng,
): void {
  const c1 = Math.exp(-friction * dt);
  const c2 = Math.sqrt(Math.max(0, target * (1 - c1 * c1)));
  const vx = state.vx;
  const vy = state.vy;
  const vz = state.vz;
  for (let i = 0; i < state.count; i++) {
    if (state.alive[i] === 0) continue;
    vx[i] = c1 * vx[i] + c2 * rng.normal();
    vy[i] = c1 * vy[i] + c2 * rng.normal();
    vz[i] = c1 * vz[i] + c2 * rng.normal();
  }
}

/** Состояние термостата Нозе-Хувера. */
export interface NoseHooverState {
  /** Координата термостата η. */
  eta: number;
}

/** Создание термостата Нозе-Хувера. */
export function allocNoseHoover(): NoseHooverState {
  return { eta: 0 };
}

/**
 * Термостат Нозе-Хувера в форме Гувера.
 *
 *   Q = N_df T₀ τ²                            — «масса» термостата
 *   η̇ = (T − T₀) / (T₀ τ²)                    — уравнение движения термостата
 *   v ← v · exp(−η dt)
 *
 * В отличие от Берендсена, даёт правильный канонический ансамбль: система
 * обменивается энергией с тепловым резервуаром, и флуктуации температуры
 * имеют физически верную величину. Плата — одно экспоненцирование на шаг
 * и необходимость следить за устойчивостью при слишком малом τ.
 */
export function applyNoseHoover(
  state: ParticleState,
  nh: NoseHooverState,
  kinetic: number,
  dof: number,
  target: number,
  dt: number,
  tau: number,
): void {
  if (dof <= 0 || target <= 0) return;
  const temperature = (2 * kinetic) / dof;
  // Q сокращается: η̇ = dof(T − T₀)/Q = (T − T₀)/(T₀ τ²).
  nh.eta += (dt * (temperature - target)) / (target * tau * tau);
  const decay = Math.exp(-nh.eta * dt);
  const vx = state.vx;
  const vy = state.vy;
  const vz = state.vz;
  for (let i = 0; i < state.count; i++) {
    vx[i] *= decay;
    vy[i] *= decay;
    vz[i] *= decay;
  }
}

/* ===========================================================================
   Внешние воздействия
   =========================================================================== */

/**
 * «Заморозка»: у выбранных частиц обнуляются скорости и смещения.
 * Маска — Uint8Array той же длины, что и число частиц.
 */
export function applyFrozenMask(state: ParticleState, frozen: Uint8Array): void {
  const vx = state.vx;
  const vy = state.vy;
  const vz = state.vz;
  for (let i = 0; i < state.count; i++) {
    if (frozen[i] !== 0) {
      vx[i] = 0;
      vy[i] = 0;
      vz[i] = 0;
    }
  }
}

/**
 * Локальный импульс от курсора: частицам в радиусе `radius` добавляется
 * скорость по направлению протяжки. Так создаётся возмущение, за которым
 * видно отклик системы — «тыканье в воду».
 *
 * @returns число затронутых частиц
 */
export function pokeRegion(
  state: ParticleState,
  cx: number,
  cy: number,
  cz: number,
  box: number,
  radius: number,
  strength: number,
  dx: number,
  dy: number,
  dz: number,
  periodic: boolean,
): number {
  const r2Limit = radius * radius;
  let touched = 0;
  for (let i = 0; i < state.count; i++) {
    if (state.alive[i] === 0) continue;
    let ax = state.x[i] - cx;
    let ay = state.y[i] - cy;
    let az = state.z[i] - cz;
    if (periodic) {
      ax -= box * Math.round(ax / box);
      ay -= box * Math.round(ay / box);
      az -= box * Math.round(az / box);
    }
    const r2 = ax * ax + ay * ay + az * az;
    if (r2 > r2Limit) continue;
    // Профиль спадает к краю — нет резкой границы воздействия.
    const falloff = 1 - Math.sqrt(r2) / radius;
    state.vx[i] += dx * strength * falloff;
    state.vy[i] += dy * strength * falloff;
    state.vz[i] += dz * strength * falloff;
    touched++;
  }
  return touched;
}

/**
 * Мгновенная установка температуры: скорости пересчитываются так, чтобы
 * температура в точности равнялась целевой. Это не термостат, а разовое
 * действие по кнопке «задать T».
 */
export function setTemperature(
  state: ParticleState,
  target: number,
  dof: number,
  rng: Rng,
): void {
  const kinetic = kineticEnergyOfState(state);
  if (kinetic < 1e-12) {
    // Система стоит: даём максвелловский набор с нуля.
    const sigma = Math.sqrt(Math.max(0, target));
    for (let i = 0; i < state.count; i++) {
      if (state.alive[i] === 0) continue;
      state.vx[i] = sigma * rng.normal();
      state.vy[i] = sigma * rng.normal();
      state.vz[i] = sigma * rng.normal();
    }
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
