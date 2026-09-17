/**
 * Тесты структурного фактора S(k).
 *
 * ─── Что здесь проверяется и почему именно так ────────────────────────────
 *
 * S(k) — величина, у которой легко получить «похожую на правду» кривую при
 * грубой ошибке: сдвинутая нормировка, потерянные частицы, суммирование по
 * нецелым векторам k — всё это даёт гладкую кривую, которую глазом не отличить
 * от корректной. Поэтому проверки идут по трём независимым опорам:
 *
 *   1. АНАЛИТИКА. Идеальная ГЦК-решётка обязана дать S = N ровно на векторе
 *      обратной решётки: все фазы k·r_j кратны 2π, каждый exp равен единице,
 *      |Σ|² = N², деление на N даёт N. Это единственный тест, который
 *      проверяет нормировку абсолютно, а не «на порядок».
 *
 *   2. НЕЗАВИСИМЫЙ ПЕРЕСЧЁТ. Прямое суммирование по тем же векторам k с
 *      ручным биннингом — эталон для сверки. Ловит ошибки в отборе векторов,
 *      границах бинов и усреднении, которые аналитический тест пропускает.
 *
 *   3. ИНВАРИАНТЫ. Сдвиг системы, заворачивание через границу ящика, порядок
 *      частиц и мёртвые частицы не должны менять результат. Это свойства
 *      самого определения, и их нарушение — самый частый дефект.
 *
 * Физические ожидания (проверены прогоном):
 *
 *   ГЦК ρ* = 0.95 (a = 1.6148):  |G₁₁₁| = 2π√3/a = 6.74
 *     кристалл T* = 0.05:  резкий пик высотой ≈ 250 при N = 256
 *     жидкость T* = 1.1:   широкий горб высотой ≈ 3
 *   газ ρ* = 0.05: S(k) → 1 на больших k с точностью долей процента
 *
 * ─── Важно про расплав ────────────────────────────────────────────────────
 *
 * ГЦК-решётка при T* = 1.1 и ρ* = 0.95 САМА не плавится за разумное время:
 * измерено, что после 1000 шагов доля подвижных частиц остаётся 0.06, то есть
 * система сидит в переохлаждённом (метастабильном) кристалле и даёт пик S(k)
 * высотой 155 — как у кристалла. Чтобы получить настоящую жидкость, тест
 * сначала плавит её при T* = 3 (выше точки плавления ≈ 0.7), а затем остужает
 * до T* = 1.1. Это не «подгонка»: без этого шага сравнивались бы два кристалла.
 *
 * ─── Важно про положение пика ─────────────────────────────────────────────
 *
 * Пик S(k) кристалла стоит на векторе ОБРАТНОЙ решётки, а не на 2π/r_сосед.
 * Для ГЦК низший разрешённый вектор — (111), |G₁₁₁| = 2π√3/a = 6.74 при
 * ρ* = 0.95. Величина 2π/r_nn = 2π/1.1418 = 5.50 относится к положению
 * первого пика g(r) и на S(k) не переносится: S(k) есть фурье-образ g(r), а
 * не её копия, и максимум фурье-образа сдвинут относительно 2π/r_nn.
 * Тест поэтому проверяет окно вокруг ИСТИННОГО вектора обратной решётки.
 */

import { describe, expect, it } from 'vitest';
import { StructureFactor } from '../core/structure.js';
import { World } from '../core/world.js';
import { buildState } from '../core/initializers.js';
import { allocState, boxLength, type ParticleState } from '../core/types.js';
import { Rng } from '../core/rng.js';

const CUTOFF = 2.5;
/** Число ячеек ГЦК решётки для N = 256: 4·4³ = 256. */
const FCC_CELLS = 4;

/* =========================================================================
   Вспомогательное
   ========================================================================= */

/** Идеальный газ: N случайных точек в ящике, без взаимодействия вообще. */
function idealGas(count: number, density: number, seed: number): { state: ParticleState; box: number } {
  const box = boxLength(count, density);
  const rng = new Rng(seed);
  const state = allocState(count);
  state.alive.fill(1);
  for (let i = 0; i < count; i++) {
    state.x[i] = rng.next() * box;
    state.y[i] = rng.next() * box;
    state.z[i] = rng.next() * box;
  }
  return { state, box };
}

/**
 * Накопить S(k) по кадрам: `frames` кадров с прогоном `jump` шагов между ними.
 * Прыжок нужен, чтобы кадры были некоррелированы: подряд идущие шаги дают
 * почти одинаковые конфигурации, и усреднение по ним ничего не улучшает.
 */
function accumulate(
  world: World,
  kMax: number,
  steps: number,
  frames: number,
  jump: number,
): StructureFactor {
  const sf = new StructureFactor(kMax, steps);
  sf.prepare(world.box);
  for (let f = 0; f < frames; f++) {
    sf.accumulate(world.state, world.box);
    if (jump > 0) world.run(jump);
  }
  return sf;
}

/**
 * Кристалл ГЦК: N = 256, ρ* = 0.95, T* = 0.05.
 *
 * Мир строится один раз и переиспользуется: 1000 шагов релаксации стоят
 * заметное время, а тесты только ЧИТАЮТ его (accumulate состояние не меняет).
 */
let crystalCache: World | null = null;
function crystalWorld(): World {
  if (!crystalCache) {
    crystalCache = new World(
      {
        count: 256,
        density: 0.95,
        cutoff: CUTOFF,
        dt: 0.004,
        temperature: 0.05,
        thermostat: 'langevin',
        boundary: 'periodic',
      },
      7,
      'fcc',
    );
    crystalCache.run(1000);
  }
  return crystalCache;
}

/**
 * Жидкость при ρ* = 0.95, T* = 1.1 — через плавление и остывание.
 *
 * Простой нагрев стартовой решётки до T* = 1.1 её НЕ плавит (см. заголовок
 * файла), поэтому сначала T* = 3, затем термостат возвращает систему к 1.1.
 * Проверено: доля подвижных частиц после этого 1.00, смещение ≈ 2σ.
 */
let liquidCache: World | null = null;
function liquidWorld(): World {
  if (!liquidCache) {
    liquidCache = new World(
      {
        count: 256,
        density: 0.95,
        cutoff: CUTOFF,
        dt: 0.004,
        temperature: 3.0,
        thermostat: 'langevin',
        boundary: 'periodic',
      },
      7,
      'fcc',
    );
    liquidCache.run(1200);
    liquidCache.params.temperature = 1.1;
    liquidCache.run(1500);
  }
  return liquidCache;
}

/** Порядковый номер максимального элемента массива (первого из равных). */
function argMax(values: Float64Array): number {
  let best = 0;
  for (let i = 1; i < values.length; i++) if (values[i] > values[best]) best = i;
  return best;
}

/* =========================================================================
   Аналитика: нормировка и определение
   ========================================================================= */

describe('структурный фактор S(k)', () => {
  it('идеальная ГЦК-решётка даёт ровно S = N на векторе обратной решётки', () => {
    // Это абсолютная проверка нормировки S(k) = (1/N)|Σ exp(i k·r)|².
    //
    // У идеальной решётки на векторе обратной решётки все k·r_j кратны 2π,
    // поэтому каждое слагаемое равно единице и |Σ|² = N². Деление на N даёт
    // ровно N — ни меньше, ни больше. Ошибка в множителе 1/N, в пропуске
    // векторов или в выборе k исказит это число сразу.
    const built = buildState('fcc', 256, 0.95, 0, 7);
    const sf = new StructureFactor(8, 60);
    sf.prepare(built.box);
    sf.accumulate(built.state, built.box);

    const peak = sf.firstPeak();
    expect(peak.height).toBeCloseTo(built.state.count, 6);
    expect(peak.k).toBeGreaterThan(0);
  });

  it('пик кристалла стоит на векторе обратной решётки (111), |G| = 2π√3/a', () => {
    // Для ГЦК с шагом решётки a разрешены отражения с индексами hkl, где все
    // индексы чётные или все нечётные. Низший — (111): |G₁₁₁| = 2π√3/a.
    //
    // Численно: a = L/4 = 6.4591/4 = 1.6148 при ρ* = 0.95, откуда
    // |G₁₁₁| = 6.7395. Здесь и обязана стоять вершина первого пика.
    //
    // Отдельно подчеркнём, чего здесь НЕТ: пика при 2π/r_сосед = 2π/1.1418 =
    // 5.50. Это положение максимума g(r), а S(k) — фурье-образ g(r), у него
    // максимум сдвинут. Проверять S(k) по 2π/r_nn — распространённая ошибка.
    const world = crystalWorld();
    const a = world.box / FCC_CELLS;
    const g111 = (2 * Math.PI * Math.sqrt(3)) / a;

    const sf = accumulate(world, 8, 60, 4, 8);
    const peak = sf.firstPeak();

    expect(peak.k).toBeGreaterThan(g111 - 0.35);
    expect(peak.k).toBeLessThan(g111 + 0.35);
    // Заодно фиксируем само значение: 6.74, а не 5.5.
    expect(g111).toBeCloseTo(6.7395, 3);

    // И контроль «от противного»: в окне 2π/r_nn пика нет — там S(k) мала.
    const { k, s } = sf.result();
    let maxNearNeighbourScale = 0;
    for (let i = 0; i < k.length; i++) {
      if (k[i] > 5.2 && k[i] < 5.8) maxNearNeighbourScale = Math.max(maxNearNeighbourScale, s[i]);
    }
    expect(maxNearNeighbourScale).toBeLessThan(1);
  });

  it('у идеального газа S(k) ≈ 1 на больших k', () => {
    // Газ не имеет структуры: фазы k·r_j независимы и равномерны, поэтому
    // |Σ exp|² флуктуирует около N, а S(k) — около единицы. Это же значение
    // служит проверкой нормировки «снизу»: завышенный или заниженный
    // множитель 1/N сразу увёл бы среднее от 1.
    const { state, box } = idealGas(400, 0.05, 2024);
    const sf = new StructureFactor(4, 40);
    sf.prepare(box);
    sf.accumulate(state, box);

    const { k, s } = sf.result();
    let sum = 0;
    let bins = 0;
    for (let i = 0; i < k.length; i++) {
      if (k[i] <= 2.5) continue;
      sum += s[i];
      bins++;
    }
    expect(bins).toBeGreaterThan(3);
    expect(sum / bins).toBeGreaterThan(0.85);
    expect(sum / bins).toBeLessThan(1.15);
  });

  it('одна частица даёт S(k) = 1 при любом k', () => {
    // Предельный случай без статистики: |exp(i k·r)|² = 1, значит S = 1/1 = 1
    // для всех векторов. Это самая чистая проверка формулы (1/N)|Σ|².
    const state = allocState(1);
    state.alive.fill(1);
    state.x[0] = 0.37;
    state.y[0] = 1.11;
    state.z[0] = 2.05;

    const sf = new StructureFactor(6, 30);
    sf.prepare(20);
    sf.accumulate(state, 20);
    const { s } = sf.result();
    expect(s.length).toBeGreaterThan(0);
    for (let i = 0; i < s.length; i++) expect(s[i]).toBeCloseTo(1, 10);
  });

  /* =======================================================================
     Физика фаз: кристалл против жидкости
     ======================================================================= */

  it('у кристалла ГЦК резкий высокий пик', () => {
    // Кристалл когерентно рассеивает на векторах обратной решётки, поэтому
    // пик узкий и высокий. При N = 256 и T* = 0.05 измеренная высота ≈ 250 —
    // то есть почти предельные N: тепловое движение её почти не сбивает.
    const world = crystalWorld();
    const sf = accumulate(world, 8, 60, 4, 8);
    const peak = sf.firstPeak();

    expect(peak.height).toBeGreaterThan(50);
    expect(peak.k).toBeGreaterThan(0.5);
    // Пик действительно РЕЗКИЙ, а не просто «большое число»: соседние бины
    // на расстоянии одного шага по k обязаны быть в разы ниже.
    const { k, s } = sf.result();
    const atPeak = argMax(s);
    const neighbour = Math.max(
      atPeak > 0 ? s[atPeak - 1] : 0,
      atPeak + 1 < s.length ? s[atPeak + 1] : 0,
    );
    expect(k[atPeak]).toBeCloseTo(peak.k, 6);
    expect(peak.height).toBeGreaterThan(neighbour * 10);
  });

  it('у жидкости пик в разы ниже, чем у кристалла', () => {
    // Это главное практическое достоинство S(k) перед g(r): у плотной
    // жидкости первый пик g(r) высокий (≈ 3), и от кристалла её отличает
    // плохо, а по S(k) разница — десятки раз.
    //
    // Измерено: кристалл ≈ 250, жидкость ≈ 3.2, то есть отношение ≈ 78.
    // Порог 10 оставлен с большим запасом, чтобы тест не был хрупким.
    const crystal = accumulate(crystalWorld(), 8, 60, 4, 8).firstPeak();
    const liquid = accumulate(liquidWorld(), 8, 60, 4, 8).firstPeak();

    expect(crystal.height / liquid.height).toBeGreaterThan(10);
    // И абсолютные величины: жидкость далека от кристалла.
    expect(liquid.height).toBeLessThan(10);
    expect(crystal.height).toBeGreaterThan(50);

    // Контроль к самому сравнению: без плавления стартовая решётка при
    // T* = 1.1 остаётся метастабильным кристаллом (доля подвижных ≈ 0.06),
    // и сравнение выродилось бы в «кристалл против кристалла».
    const m = liquidWorld().measurement;
    expect(m.temperature).toBeGreaterThan(0.9);
    expect(m.temperature).toBeLessThan(1.4);
    expect(m.mobileFraction).toBeGreaterThan(0.8);
    expect(m.meanDisplacement).toBeGreaterThan(1);
  });

  /* =======================================================================
     Инварианты определения
     ======================================================================= */

  it('S(k) не меняется при сдвиге всей системы', () => {
    // Σ exp(i k·(r_j + c)) = exp(i k·c)·Σ exp(i k·r_j), а |exp(i k·c)| = 1.
    // Поэтому сдвиг начала координат не может влиять на S(k) — если влияет,
    // значит в сумме участвует что-то ещё (например, фаза берётся от
    // расстояния до центра ящика).
    const built = buildState('fcc', 256, 0.95, 0.3, 7);
    const box = built.box;

    const shifted = allocState(built.state.count);
    shifted.alive.fill(1);
    for (let i = 0; i < built.state.count; i++) {
      shifted.x[i] = built.state.x[i] + 0.37 * box;
      shifted.y[i] = built.state.y[i] - 0.11 * box;
      shifted.z[i] = built.state.z[i] + 0.29 * box;
    }

    const a = new StructureFactor(8, 60);
    a.prepare(box);
    a.accumulate(built.state, box);
    const b = new StructureFactor(8, 60);
    b.prepare(box);
    b.accumulate(shifted, box);

    const ra = a.result();
    const rb = b.result();
    expect(ra.s.length).toBe(rb.s.length);
    let maxDiff = 0;
    for (let i = 0; i < ra.s.length; i++) maxDiff = Math.max(maxDiff, Math.abs(ra.s[i] - rb.s[i]));
    // Различие только от пересчёта cos/sin на других аргументах, то есть на
    // уровне машинного эпсилона, а не физики.
    expect(maxDiff).toBeLessThan(1e-9);
  });

  it('S(k) не меняется при заворачивании частиц через границу ящика', () => {
    // Сдвиг на целое число ящиков: k·(r + nL) = k·r + 2π·(целое), фаза
    // exp(i·2π·m) = 1. Это не косметика: интегратор заворачивает координаты
    // в [0, L) на каждом шаге, и без этого свойства S(k) «дёргался» бы при
    // каждом переходе границы, а усреднение по кадрам стало бы мусором.
    const built = buildState('fcc', 256, 0.95, 0.3, 7);
    const box = built.box;

    const wrapped = allocState(built.state.count);
    wrapped.alive.fill(1);
    for (let i = 0; i < built.state.count; i++) {
      wrapped.x[i] = built.state.x[i] + 3 * box;
      wrapped.y[i] = built.state.y[i] - 2 * box;
      wrapped.z[i] = built.state.z[i];
    }

    const a = new StructureFactor(8, 60);
    a.prepare(box);
    a.accumulate(built.state, box);
    const b = new StructureFactor(8, 60);
    b.prepare(box);
    b.accumulate(wrapped, box);

    const ra = a.result();
    const rb = b.result();
    let maxDiff = 0;
    for (let i = 0; i < ra.s.length; i++) maxDiff = Math.max(maxDiff, Math.abs(ra.s[i] - rb.s[i]));
    expect(maxDiff).toBeLessThan(1e-9);
  });

  it('мёртвые частицы пропускаются, а N — число живых', () => {
    // У открытого ящика частицы вылетают навсегда. Если делить на исходное
    // число частиц, S(k) систематически занижается по мере испарения; если
    // же учитывать мёртвых в сумме, они дадут вклад из нулевых координат.
    // Проверка: половина состояния с alive = 0 обязана дать ровно то же,
    // что отдельное состояние из одних живых частиц.
    const built = buildState('fcc', 256, 0.95, 0.3, 7);
    const box = built.box;

    const half = allocState(256);
    half.alive.fill(1);
    for (let i = 0; i < 128; i++) {
      half.x[i] = built.state.x[i];
      half.y[i] = built.state.y[i];
      half.z[i] = built.state.z[i];
    }
    for (let i = 128; i < 256; i++) half.alive[i] = 0;

    const only = allocState(128);
    only.alive.fill(1);
    for (let i = 0; i < 128; i++) {
      only.x[i] = built.state.x[i];
      only.y[i] = built.state.y[i];
      only.z[i] = built.state.z[i];
    }

    const withDead = new StructureFactor(8, 60);
    withDead.prepare(box);
    withDead.accumulate(half, box);
    const aliveOnly = new StructureFactor(8, 60);
    aliveOnly.prepare(box);
    aliveOnly.accumulate(only, box);

    const ra = withDead.result();
    const rb = aliveOnly.result();
    let maxDiff = 0;
    for (let i = 0; i < ra.s.length; i++) maxDiff = Math.max(maxDiff, Math.abs(ra.s[i] - rb.s[i]));
    expect(maxDiff).toBeLessThan(1e-12);

    // А состояние из одних мёртвых частиц — это N = 0, то есть деление на
    // ноль. Такой кадр обязан быть пропущен целиком, а не добавить NaN.
    const allDead = allocState(16);
    allDead.alive.fill(0);
    const empty = new StructureFactor(6, 30);
    empty.prepare(10);
    empty.accumulate(allDead, 10);
    expect(empty.sampleCount).toBe(0);
    const { s: emptyS } = empty.result();
    for (let i = 0; i < emptyS.length; i++) expect(Number.isFinite(emptyS[i])).toBe(true);
  });

  it('перестановка частиц не меняет S(k)', () => {
    // S(k) — симметричная функция координат: сумма по частицам не зависит от
    // их нумерации. Проверка ловит случайное использование индекса частицы
    // как физической величины (например, фазу, зависящую от номера).
    const built = buildState('fcc', 256, 0.95, 0.3, 7);
    const box = built.box;
    const count = built.state.count;

    const permuted = allocState(count);
    permuted.alive.fill(1);
    for (let i = 0; i < count; i++) {
      const j = count - 1 - i;
      permuted.x[i] = built.state.x[j];
      permuted.y[i] = built.state.y[j];
      permuted.z[i] = built.state.z[j];
    }

    const a = new StructureFactor(8, 60);
    a.prepare(box);
    a.accumulate(built.state, box);
    const b = new StructureFactor(8, 60);
    b.prepare(box);
    b.accumulate(permuted, box);

    const ra = a.result();
    const rb = b.result();
    let maxDiff = 0;
    for (let i = 0; i < ra.s.length; i++) maxDiff = Math.max(maxDiff, Math.abs(ra.s[i] - rb.s[i]));
    expect(maxDiff).toBeLessThan(1e-9);
  });

  /* =======================================================================
     Численные свойства: сетка k, бины, очистка
     ======================================================================= */

  it('кривая корректна: k строго растёт, значения конечны и неотрицательны', () => {
    // result() отдаёт центры НЕПУСТЫХ бинов. Монотонность обязана быть
    // строгой: обработка (поиск пика, сглаживание) рассчитывает на
    // упорядоченность и на постоянный шаг. S(k) = (1/N)|Σ exp|² по
    // построению неотрицательна, а NaN или Infinity появились бы от деления
    // на ноль и мгновенно «размазались» бы по всей обработке.
    for (const world of [crystalWorld(), liquidWorld()]) {
      const { k, s } = accumulate(world, 12, 80, 2, 8).result();
      expect(k.length).toBe(s.length);
      expect(k.length).toBeGreaterThan(50);

      const dk = 12 / 80;
      for (let i = 0; i < k.length; i++) {
        if (i > 0) expect(k[i]).toBeGreaterThan(k[i - 1]);
        // Центр бина лежит строго внутри (0, kMax] по построению сетки.
        expect(k[i]).toBeGreaterThan(0);
        expect(k[i]).toBeLessThanOrEqual(12);

        expect(Number.isFinite(s[i])).toBe(true);
        expect(s[i]).toBeGreaterThanOrEqual(0);
      }
      // Шаг между соседними непустыми бинами кратен dk — иначе привязка
      // бинов к kMax была бы нарушена (в кристалле часть бинов пуста).
      for (let i = 1; i < k.length; i++) {
        const ratio = (k[i] - k[i - 1]) / dk;
        expect(Math.abs(ratio - Math.round(ratio))).toBeLessThan(1e-6);
      }
    }
  });

  it('result() до накопления даёт нули, reset() обнуляет накопленное', () => {
    // График обязан нарисовать нулевую линию при старте, а не упасть и не
    // показать мусор: приложение вызывает result() и до первого кадра.
    // Смена пресета и кнопка «сброс» вызывают reset(); если он забудет
    // обнулить суммы (или, наоборот, счётчик), новая система унаследует
    // статистику старой — а кривая смешает две разные физики.
    const fresh = new StructureFactor(8, 60);
    fresh.prepare(10);
    const initial = fresh.result();
    expect(fresh.sampleCount).toBe(0);
    expect(initial.k.length).toBeGreaterThan(0);
    for (let i = 0; i < initial.s.length; i++) expect(initial.s[i]).toBe(0);
    expect(fresh.firstPeak()).toEqual({ k: 0, height: 0 });

    const world = crystalWorld();
    const sf = new StructureFactor(8, 60);
    sf.prepare(world.box);
    sf.accumulate(world.state, world.box);
    sf.accumulate(world.state, world.box);
    expect(sf.sampleCount).toBe(2);
    const before = sf.result();
    expect(before.s[argMax(before.s)]).toBeGreaterThan(0);

    sf.reset();
    expect(sf.sampleCount).toBe(0);
    const after = sf.result();
    for (let i = 0; i < after.s.length; i++) expect(after.s[i]).toBe(0);
    // Сетка векторов остаётся готовой: она зависит только от ящика.
    expect(sf.preparedBoxLength).toBe(world.box);
    expect(sf.vectorCount).toBeGreaterThan(0);
  });

  it('усреднение по кадрам сходится, а не расходится', () => {
    // Смысл накопления: одиночный кадр шумный, среднее по многим — гладкое.
    // Проверяем на жидкости. Если бы суммы не делились на число кадров или
    // копились повторно, среднее росло бы с числом кадров, а не стабилизировалось.
    const world = liquidWorld();
    const one = accumulate(world, 8, 60, 1, 0).result();
    const many = accumulate(world, 8, 60, 6, 8).result();

    const peakOne = Math.max(...Array.from(one.s).filter((_, i) => one.k[i] > 0.5));
    const peakMany = Math.max(...Array.from(many.s).filter((_, i) => many.k[i] > 0.5));
    // Обе величины — порядка единиц, а не N и не «число кадров × S».
    expect(peakMany).toBeGreaterThan(1);
    expect(peakMany).toBeLessThan(peakOne * 3);
    // На больших k среднее близко к 1 (нет структуры), а не растёт с кадрами.
    let sum = 0;
    let bins = 0;
    for (let i = 0; i < many.k.length; i++) {
      if (many.k[i] < 6) continue;
      sum += many.s[i];
      bins++;
    }
    expect(bins).toBeGreaterThan(0);
    expect(sum / bins).toBeLessThan(2);
    expect(sum / bins).toBeGreaterThan(0.3);
  });

  it('смена ящика пересобирает сетку векторов k', () => {
    // Узлы обратной решётки k = 2π/L·(nx,ny,nz) зависят от L. Если при смене
    // ящика сетка остаётся старой, S(k) считается по векторам другого ящика —
    // молчаливая ошибка, которая не падает, а тихо портит кривую.
    const world = crystalWorld();
    const sf = new StructureFactor(8, 60);
    sf.prepare(world.box);
    sf.accumulate(world.state, world.box);
    const before = sf.vectorCount;
    expect(sf.preparedBoxLength).toBe(world.box);

    const bigger = world.box * 1.5;
    sf.accumulate(world.state, bigger);
    expect(sf.preparedBoxLength).toBe(bigger);
    // Больший ящик — более плотная сетка k, то есть больше векторов.
    expect(sf.vectorCount).toBeGreaterThan(before);
  });

  it('первый пик ищется только при k > 0.5, нулевой вектор в сетку не входит', () => {
    // Область малых k управляется конечным размером системы, а не структурой:
    // S(k → 0) для жидкости стремится к сжимаемости и на одном кадре даёт
    // выбросы. Физический интерес — первый настоящий максимум. Нулевой вектор
    // k = 0 дал бы S = N («весь ящик целиком») — гигантский выброс, который
    // забил бы все остальные бины, поэтому он исключён из сетки.
    const { state, box } = idealGas(200, 0.2, 77);
    const direct = new StructureFactor(4, 40);
    direct.prepare(box);
    direct.accumulate(state, box);
    const peak = direct.firstPeak();

    expect(peak.k).toBeGreaterThan(0.5);
    const { k } = direct.result();
    for (let i = 0; i < k.length; i++) expect(k[i]).toBeGreaterThan(0);
  });

  /* =======================================================================
     Независимый пересчёт
     ======================================================================= */

  it('совпадает с прямым суммированием по тем же векторам k', () => {
    // Эталон считает S(k) «в лоб»: сам перебирает тройки (nx,ny,nz), сам
    // суммирует cos/sin и сам раскладывает по бинам. Совпадать обязан
    // поэлементно, до машинной точности. Это ловит ошибки, которые
    // аналитические тесты пропускают: неверные границы бинов, потерянные
    // при отборе векторы, неравномерное деление внутри бина.
    const built = buildState('fcc', 256, 0.95, 0.4, 13);
    const box = built.box;
    const kMax = 6;
    const steps = 45;

    const sf = new StructureFactor(kMax, steps);
    sf.prepare(box);
    sf.accumulate(built.state, box);
    const got = sf.result();

    // Прямой пересчёт.
    const twoPiOverL = (2 * Math.PI) / box;
    const nMax = Math.ceil(kMax / twoPiOverL);
    const sums = new Float64Array(steps);
    const counts = new Float64Array(steps);
    let n = 0;
    for (let i = 0; i < built.state.count; i++) if (built.state.alive[i] !== 0) n++;
    for (let nx = -nMax; nx <= nMax; nx++) {
      const kx = twoPiOverL * nx;
      for (let ny = -nMax; ny <= nMax; ny++) {
        const ky = twoPiOverL * ny;
        for (let nz = -nMax; nz <= nMax; nz++) {
          const kz = twoPiOverL * nz;
          const km = Math.sqrt(kx * kx + ky * ky + kz * kz);
          if (km > kMax || km < 1e-12) continue;
          let c = 0;
          let sn = 0;
          for (let i = 0; i < built.state.count; i++) {
            if (built.state.alive[i] === 0) continue;
            const phase = kx * built.state.x[i] + ky * built.state.y[i] + kz * built.state.z[i];
            c += Math.cos(phase);
            sn += Math.sin(phase);
          }
          const b = Math.min(steps - 1, Math.floor((km / kMax) * steps));
          sums[b] += (c * c + sn * sn) / n;
          counts[b]++;
        }
      }
    }

    // Сверяем только непустые бины, ровно тем же порядком, что отдаёт result().
    let w = 0;
    let compared = 0;
    for (let b = 0; b < steps; b++) {
      if (counts[b] === 0) continue;
      expect(got.k[w]).toBeCloseTo((b + 0.5) * (kMax / steps), 9);
      expect(got.s[w]).toBeCloseTo(sums[b] / counts[b], 9);
      w++;
      compared++;
    }
    expect(compared).toBeGreaterThan(10);
    expect(w).toBe(got.k.length);
  });
});
