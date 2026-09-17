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
 * Предел скорости, выше которого дискретизация Верле теряет смысл.
 *
 * ─── Откуда берётся предел ───────────────────────────────────────────────
 *
 * За шаг частица проходит `v·dt`. Пока это много меньше σ, потенциал
 * разрешается корректно; когда путь сравним с σ, частица «перескакивает»
 * отталкивающий сердечник потенциала (U ~ r⁻¹²), и сила на следующем шаге
 * оказывается ещё больше — классическая потеря устойчивости, после которой
 * энергия растёт экспоненциально.
 *
 * Порог выведен из самого шага: путь за шаг не более 5 % σ, то есть
 * `0.05 / dt`. При dt = 0.004 это 12.5 σ/τ — выше тепловой скорости любого
 * пресета (газ при T* = 1.6: ≈ 2.2) и выше верхней границы ползунка T* = 3
 * (≈ 3.0), поэтому штатную работу ограничение не задевает.
 *
 * Проверено на устойчивость: при dt = 0.004 система разлетается начиная
 * примерно с T* ≈ 50 (скорость ≈ 12.2), а до T* = 30 (≈ 9.5) держится.
 * Прежний, слишком щедрый порог (`0.5/dt` = 125) разлёт НЕ останавливал:
 * при v = 125 путь за шаг равен 0.5σ, сила на таком сближении ~10⁵, и
 * система продолжала греться (измерено: T* 1.05·10⁵ → 6.8·10²⁸ за 100 шагов).
 */
export function maxStableSpeed(dt: number): number {
  return 0.05 / Math.max(1e-9, dt);
}

/**
 * Не даёт скоростям превысить предел устойчивости.
 *
 * Вызывается после термостата. Если скорость частицы больше предела, она
 * ограничивается, что физически означает «шаг перестаёт разрешать такое
 * движение» — и, что важнее, не даёт выбросу разрастись. Работает мягко:
 * при штатных температурах (T* ≤ 30 на dt = 0.004) не срабатывает вообще.
 *
 * @returns число частиц, которым ограничили скорость (для диагностики)
 */
export function clampSpeeds(state: ParticleState, limit: number): number {
  const limitSq = limit * limit;
  const vx = state.vx;
  const vy = state.vy;
  const vz = state.vz;
  let clamped = 0;
  for (let i = 0; i < state.count; i++) {
    if (state.alive[i] === 0) continue;
    const v2 = vx[i] * vx[i] + vy[i] * vy[i] + vz[i] * vz[i];
    if (v2 <= limitSq) continue;
    const k = limit / Math.sqrt(v2);
    vx[i] *= k;
    vy[i] *= k;
    vz[i] *= k;
    clamped++;
  }
  return clamped;
}

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
 * Параметры кисти: цилиндр вдоль оси взгляда.
 *
 * ─── Почему цилиндр, а не сфера ──────────────────────────────────────────
 *
 * Курсор задаёт точку на ПЛОСКОСТИ экрана. Прямая, проходящая через эту точку
 * вдоль луча зрения, пересекает частицы на всех глубинах. Первая версия
 * ограничивала воздействие сферой вокруг точки, лежащей на «плоскости
 * экрана» в центре ящика: у кристалла 2048 частиц и углов yaw = 0.6,
 * pitch = 0.9 это давало доступ примерно к 40 % частиц, причём независимо
 * от того, куда игрок попадает курсором, — терялся именно разброс по глубине
 * вдоль луча (измерено: клик в любую точку экрана задевал частицы с
 * y ∈ [4.2, 9.7] при ящике 14 σ, то есть один и тот же слой по вертикали).
 *
 * Сфера «на плоскости экрана» не спасала: она либо мала и не достаёт до
 * реальных частиц, либо велика и снова превращается в слой. Ограничение
 * обязано быть инвариантно относительно сдвига ВДОЛЬ луча зрения — тогда
 * положение курсора на экране однозначно выбирает цилиндр и ничего не теряется.
 *
 * ─── Как строится ось ────────────────────────────────────────────────────
 *
 * Прямая часть проекции переводит мир в систему экрана ортонормированным
 * преобразованием `R = Rx(pitch) · Ry(yaw)`. Ось взгляда — это третья строка
 * `R`, а две первые строки задают экранные координаты. Поэтому одного вектора
 * оси достаточно: из него выводится всё остальное, и разойтись с проекцией
 * этот расчёт не может по построению.
 */

/** Вектор оси взгляда и связанный с ним базис экрана. */
export interface ViewAxis {
  /** Направление «от камеры в сцену» (третья строка матрицы проекции). */
  ax: number;
  ay: number;
  az: number;
  /** Декартов базис: `r` — направление экранного X, `u` — экранного Y. */
  rx: number;
  ry: number;
  rz: number;
  ux: number;
  uy: number;
  uz: number;
}

/**
 * Ось взгляда по углам камеры.
 *
 * Возвращаются три СТРОКИ матрицы проекции (она ортонормированная, поэтому
 * строки — это и есть базисные векторы):
 *
 *   R = Rx(pitch)·Ry(yaw )
 *   r = ( cosY,            0,    −sinY        )   первая строка  → экранный X
 *   u = (−sinY·sinP,   cosP,    −cosY·sinP   )   вторая строка  → экранный Y
 *   a = ( sinY·cosP,   sinP,     cosY·cosP   )   третья строка  → ось взгляда
 *
 * Эти же выражения дословно повторяет `World.project`, поэтому направления
 * гарантированно согласованы с отрисовкой: «куда смотрит камера» и «куда
 * бьёт кисть» разойтись не могут.
 */
export function viewAxis(yaw: number, pitch: number): ViewAxis {
  const cosY = Math.cos(yaw);
  const sinY = Math.sin(yaw);
  const cosP = Math.cos(pitch);
  const sinP = Math.sin(pitch);
  return {
    ax: sinY * cosP,
    ay: sinP,
    az: cosY * cosP,
    rx: cosY,
    ry: 0,
    rz: -sinY,
    ux: -sinY * sinP,
    uy: cosP,
    uz: -cosY * sinP,
  };
}

/** Проекция точки (со знаком) на экранную плоскость — те же rx и ry, что и в `World.project`. */
export function projectToScreen(
  v: ViewAxis,
  px: number,
  py: number,
  pz: number,
): { x: number; y: number } {
  return {
    x: px * v.rx + py * v.ry + pz * v.rz,
    y: px * v.ux + py * v.uy + pz * v.uz,
  };
}

/** Точка мира, соответствующая экранной точке и глубине `along` вдоль оси взгляда. */
export function unprojectFromScreen(
  v: ViewAxis,
  sx: number,
  sy: number,
  along: number,
): { x: number; y: number; z: number } {
  return {
    x: sx * v.rx + sy * v.ux + along * v.ax,
    y: sx * v.ry + sy * v.uy + along * v.ay,
    z: sx * v.rz + sy * v.uz + along * v.az,
  };
}

/** Кисть: цилиндр вокруг оси взгляда, проходящей через выбранную точку экрана. */
export interface BrushPlane {
  /** Ось взгляда и базис экрана — задают ориентацию цилиндра. */
  w: ViewAxis;
  /** Точка на оси цилиндра в мировых координатах. */
  center: { x: number; y: number; z: number };
}

/** Квадрат расстояния от точки до оси цилиндра (перпендикулярная часть). */
function axialDistanceSq(
  p: BrushPlane,
  x: number,
  y: number,
  z: number,
  box: number,
  periodic: boolean,
): number {
  let dx = x - p.center.x;
  let dy = y - p.center.y;
  let dz = z - p.center.z;
  if (periodic) {
    dx -= box * Math.round(dx / box);
    dy -= box * Math.round(dy / box);
    dz -= box * Math.round(dz / box);
  }
  // Вычитаем составляющую вдоль оси — остаётся перпендикулярный вектор.
  const along = dx * p.w.ax + dy * p.w.ay + dz * p.w.az;
  const px = dx - along * p.w.ax;
  const py = dy - along * p.w.ay;
  const pz = dz - along * p.w.az;
  return px * px + py * py + pz * pz;
}

/**
 * Предел импульса кисти, σ/τ.
 *
 * ─── Почему предел обязателен ─────────────────────────────────────────────
 *
 * Импульс пропорционален протяжке в пикселях и прибавляется на КАЖДОМ событии
 * `pointermove`. Суммарная добавка поэтому равна всему пути курсора, делённому
 * на масштаб: при масштабе ~18 px/σ протяжка 200 px давала 37 σ/τ на частицу.
 * Для сравнения, средняя скорость при T* = 1 равна ≈ 1.7 σ/τ.
 *
 * Последствия измерены: движение мыши разгоняло кристалл до T* = 3.6, а
 * «протянуть и подождать» — до полного разлёта (полная энергия 10¹⁷, давление
 * 10¹³): система переставала быть физической. Предел превращает чрезмерную
 * протяжку в «сильный, но конечный» толчок — играбельно и не ломает физику.
 *
 * 4 σ/τ выбрано как заметно выше тепловой скорости при T* = 1.6 (газ, ≈ 2.2),
 * но ниже порога, на котором кристалл разрушается за десяток шагов.
 */
export const MAX_POKE_SPEED = 4;

/**
 * Локальный импульс от курсора: частицам внутри цилиндра вдоль луча зрения
 * добавляется скорость по направлению протяжки.
 *
 * Так создаётся возмущение, за которым видно отклик системы — «тыканье в воду».
 * Радиус отсчитывается в плоскости экрана, поэтому кисть накрывает частицы на
 * любой глубине и её размер на картинке совпадает с физическим воздействием.
 *
 * Величина добавки ограничена `MAX_POKE_SPEED`: без предела протяжка мышью
 * разгоняла систему до нефизических скоростей (см. комментарий к константе).
 *
 * @returns число затронутых частиц
 */
export function pokeRegion(
  state: ParticleState,
  plane: BrushPlane,
  box: number,
  radius: number,
  strength: number,
  dx: number,
  dy: number,
  dz: number,
  periodic: boolean,
): number {
  const r2Limit = radius * radius;
  const w = plane.w;
  // Импульс переводится из экранных направлений в мировые: протяжка мышью
  // идёт вдоль экрана, поэтому и толчок обязан идти в ту же сторону.
  let pushX = dx * w.rx + dy * w.ux + dz * w.ax;
  let pushY = dx * w.ry + dy * w.uy + dz * w.ay;
  let pushZ = dx * w.rz + dy * w.uz + dz * w.az;
  // Ограничиваем ВЕКТОР, а не компоненты: иначе направление толчка искажалось
  // бы при больших протяжках по одной оси.
  const pushLength = Math.sqrt(pushX * pushX + pushY * pushY + pushZ * pushZ);
  if (pushLength > MAX_POKE_SPEED) {
    const k = MAX_POKE_SPEED / pushLength;
    pushX *= k;
    pushY *= k;
    pushZ *= k;
  }

  let touched = 0;
  for (let i = 0; i < state.count; i++) {
    if (state.alive[i] === 0) continue;
    const r2 = axialDistanceSq(plane, state.x[i], state.y[i], state.z[i], box, periodic);
    if (r2 > r2Limit) continue;
    // Профиль спадает к краю — нет резкой границы воздействия.
    const falloff = 1 - Math.sqrt(r2) / radius;
    state.vx[i] += pushX * strength * falloff;
    state.vy[i] += pushY * strength * falloff;
    state.vz[i] += pushZ * strength * falloff;
    touched++;
  }
  return touched;
}

/**
 * Заморозка частиц внутри цилиндра вдоль луча зрения.
 *
 * Ограничение то же, что у кисти: иначе «заморозить» можно было бы только
 * средний слой, и кнопка вела бы себя не так, как выглядит на экране.
 *
 * @returns число замороженных частиц
 */
export function freezeRegion(
  state: ParticleState,
  frozen: Uint8Array,
  plane: BrushPlane,
  box: number,
  radius: number,
  periodic: boolean,
): number {
  const r2Limit = radius * radius;
  let touched = 0;
  for (let i = 0; i < state.count; i++) {
    if (state.alive[i] === 0) continue;
    const r2 = axialDistanceSq(plane, state.x[i], state.y[i], state.z[i], box, periodic);
    if (r2 > r2Limit) continue;
    frozen[i] = 1;
    state.vx[i] = 0;
    state.vy[i] = 0;
    state.vz[i] = 0;
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
