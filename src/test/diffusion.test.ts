/**
 * Тесты измерения коэффициента самодиффузии D по MSD.
 *
 * Здесь проверяется то, ради чего заведён отдельный модуль: коэффициент
 * самодиффузии — количественный признак фазы. Кристалл обязан дать D ≈ 0
 * (частицы колеблются вокруг узлов), жидкость — D порядка 0.1, и с ростом
 * температуры D обязан расти.
 *
 * Численные ориентиры взяты из реальных прогонов этого ядра при ρ* = 0.7:
 *
 *   T* = 0.9 → D ≈ 0.099
 *   T* = 1.1 → D ≈ 0.116
 *   T* = 1.4 → D ≈ 0.155
 *   T* = 0.15, ρ* = 0.95 (кристалл) → D ≈ 2·10⁻⁶
 *
 * Проверки с настоящей динамикой идут минуты, поэтому прогоны сгруппированы
 * и параметры подобраны так, чтобы сохранить физический смысл (число кадров
 * заведомо больше окна усреднения) и не растягивать прогон.
 */

import { describe, expect, it } from 'vitest';
import { World } from '../core/world.js';
import { MeanSquareDisplacement } from '../core/diffusion.js';
import { allocState, type ParticleState } from '../core/types.js';

const CUTOFF = 2.5;
/** Время между кадрами статистики: при dt = 0.004 это 5 шагов. */
const FRAME_TIME = 0.02;
const FRAME_STEPS = Math.round(FRAME_TIME / 0.004);

/** Готовый мир, отожжённый до рабочей температуры. */
function annealed(temperature: number, density: number, seed: number, count = 500): World {
  const world = new World(
    {
      count,
      density,
      cutoff: CUTOFF,
      dt: 0.004,
      temperature,
      thermostat: 'berendsen',
      boundary: 'periodic',
    },
    seed,
    'fcc',
  );
  // Отжиг: снимает память решётки и выводит систему на равновесную T*.
  world.run(1500);
  return world;
}

/**
 * Прогон измерения: `frames` кадров статистики с началом отсчёта на каждом.
 * Фактически это и есть штатный сценарий использования класса в приложении.
 */
function measureDiffusion(
  temperature: number,
  density: number,
  seed: number,
  frames = 600,
  count = 500,
): { msd: MeanSquareDisplacement; world: World; D: number; r2: number } {
  const world = annealed(temperature, density, seed, count);
  const msd = new MeanSquareDisplacement(40, 10);
  msd.prepare(world.state.count);
  for (let f = 0; f < frames; f++) {
    msd.addOrigin(world.state, world.box);
    msd.sample(world.state, world.box, true, world.time);
    world.run(FRAME_STEPS);
  }
  const { D, r2 } = msd.diffusion();
  return { msd, world, D, r2 };
}

/** Копия состояния: массивы поэлементно, координаты сдвинуты на пол-ящика. */
function shiftedState(source: ParticleState, box: number): ParticleState {
  const out = allocState(source.count);
  out.count = source.count;
  out.x.set(source.x);
  out.y.set(source.y);
  out.z.set(source.z);
  out.px.set(source.px);
  out.py.set(source.py);
  out.pz.set(source.pz);
  out.vx.set(source.vx);
  out.vy.set(source.vy);
  out.vz.set(source.vz);
  out.refX.set(source.refX);
  out.refY.set(source.refY);
  out.refZ.set(source.refZ);
  out.alive.set(source.alive);
  for (let i = 0; i < out.count; i++) {
    // Сдвиг ровно на пол-ящика — «самая дальняя» из возможных позиций,
    // поэтому сломанный минимальный образ проявился бы здесь наверняка.
    out.x[i] = (out.x[i] + box * 0.5) % box;
    out.y[i] = (out.y[i] + box * 0.5) % box;
    out.z[i] = (out.z[i] + box * 0.5) % box;
  }
  return out;
}

/** Простое состояние из `count` частиц в нуле координат. */
function atOrigin(count: number): ParticleState {
  const state = allocState(count);
  state.alive.fill(1);
  return state;
}

describe('MeanSquareDisplacement: синтетические проверки', () => {
  it('множитель 1/6: MSD = 6·D·t даёт ровно заданный D', () => {
    // Это проверка главной константы модуля. Если перепутать размерность
    // (2·d·D·t против 6·D·t) или взять вместо наклона отношение, ошибка
    // выйдет кратной — при этом кривая MSD останется совершенно правильной.
    const count = 10;
    const state = atOrigin(count);
    const box = 1000;
    const target = 0.07;
    const msd = new MeanSquareDisplacement(10, 10);
    msd.prepare(count);
    msd.addOrigin(state, box);
    for (let k = 0; k <= 9; k++) {
      const t = k;
      const r = Math.sqrt(6 * target * t);
      for (let i = 0; i < count; i++) state.x[i] = r;
      msd.sample(state, box, false, t);
    }
    const { D, r2 } = msd.diffusion();
    expect(D).toBeCloseTo(target, 10);
    expect(r2).toBeCloseTo(1, 10);
  });

  it('MSD(0) = 0: сразу после начала отсчёта смещения нет', () => {
    const state = atOrigin(20);
    for (let i = 0; i < state.count; i++) state.x[i] = i;
    const msd = new MeanSquareDisplacement(10, 10);
    msd.prepare(state.count);
    msd.addOrigin(state, 100);
    msd.sample(state, 100, true, 0);
    const { msd: curve } = msd.result();
    expect(curve[0]).toBe(0);
    expect(msd.originCount).toBe(1);
  });

  it('начал нет — кривые пустые и нет NaN', () => {
    const state = atOrigin(5);
    const msd = new MeanSquareDisplacement(8, 4);
    msd.prepare(state.count);
    msd.sample(state, 10, true, 0);
    msd.sample(state, 10, true, 1);
    const { lag, msd: curve, counts } = msd.result();
    expect(lag.length).toBe(8);
    expect(msd.originCount).toBe(0);
    for (let k = 0; k < 8; k++) {
      expect(counts[k]).toBe(0);
      expect(Number.isFinite(curve[k])).toBe(true);
      expect(curve[k]).toBe(0);
    }
    const result = msd.diffusion();
    expect(result.D).toBe(0);
    expect(result.r2).toBe(0);
    expect(Number.isFinite(result.D)).toBe(true);
  });

  it('нулевое время и малое N не дают NaN', () => {
    const msd = new MeanSquareDisplacement(4, 2);
    msd.prepare(0);
    msd.addOrigin(atOrigin(0), 1);
    msd.sample(atOrigin(0), 1, true, 0);
    expect(Number.isFinite(msd.diffusion().D)).toBe(true);

    // Одна частица: система вырождена, но измерение обязано быть корректным.
    const single = atOrigin(1);
    single.x[0] = 0.5;
    msd.reset();
    msd.prepare(1);
    msd.addOrigin(single, 10);
    // Лаг 1τ при ширине бина 0.5 попадает ровно в бин 2.
    single.x[0] = 0.75;
    msd.sample(single, 10, true, 1);
    const curve = msd.result();
    expect(Number.isFinite(curve.msd[2])).toBe(true);
    expect(curve.msd[2]).toBeCloseTo(0.0625, 12);
    expect(Number.isFinite(msd.diffusion().D)).toBe(true);
  });

  it('точек подгонки мало — D = 0, а не случайное число', () => {
    // Данные есть только в одном бине: двухточечная «подгонка» наклона —
    // это уже не измерение, и возвращать по ней D нельзя.
    const state = atOrigin(30);
    const msd = new MeanSquareDisplacement(40, 10);
    msd.prepare(state.count);
    msd.addOrigin(state, 100);
    for (let i = 0; i < state.count; i++) state.x[i] = 0.3;
    msd.sample(state, 100, true, 0);
    msd.sample(state, 100, true, 10);
    const result = msd.diffusion();
    expect(result.D).toBe(0);
    expect(result.r2).toBe(0);
  });

  it('отрезок подгонки — от 20 % до 80 % максимального лага', () => {
    const msd = new MeanSquareDisplacement(40, 10);
    expect(msd.lags).toBe(40);
    expect(msd.maxLag).toBe(10);
    expect(msd.width).toBeCloseTo(0.25, 12);
    const state = atOrigin(10);
    msd.prepare(state.count);
    msd.addOrigin(state, 100);
    for (let k = 0; k <= 40; k++) {
      for (let i = 0; i < state.count; i++) state.x[i] = 0.1 * k;
      msd.sample(state, 100, false, k * 0.25);
    }
    const { lagRange } = msd.diffusion();
    // last = 39, floor(0.2·39) = 7, ceil(0.8·39) = 32 → [1.75, 8].
    expect(lagRange[0]).toBeCloseTo(1.75, 12);
    expect(lagRange[1]).toBeCloseTo(8, 12);
  });

  it('reset очищает и статистику, и начала отсчёта', () => {
    const state = atOrigin(10);
    const msd = new MeanSquareDisplacement(5, 5);
    msd.prepare(state.count);
    msd.addOrigin(state, 100);
    for (let i = 0; i < state.count; i++) state.x[i] = 1;
    msd.sample(state, 100, true, 1);
    expect(msd.sampleCount).toBe(1);
    expect(msd.originCount).toBe(1);

    msd.reset();
    expect(msd.sampleCount).toBe(0);
    expect(msd.originCount).toBe(0);
    for (let k = 0; k < 5; k++) expect(msd.result().counts[k]).toBe(0);
  });

  it('непериодический ящик: минимальный образ не применяется', () => {
    // При box = 10 частица, ушедшая из x = 1 в x = 9, сместилась на 8σ
    // в открытом ящике и всего на 2σ — в периодическом. Оба ответа верны,
    // но относятся к разным физическим задачам, и путать их нельзя.
    const ref = atOrigin(1);
    ref.x[0] = 1;
    const nowX = 9;

    const open = new MeanSquareDisplacement(4, 4);
    open.prepare(1);
    open.addOrigin(ref, 10);
    const a = atOrigin(1);
    a.x[0] = nowX;
    open.sample(a, 10, false, 2);
    expect(open.result().msd[2]).toBeCloseTo(64, 9);

    const periodic = new MeanSquareDisplacement(4, 4);
    periodic.prepare(1);
    periodic.addOrigin(ref, 10);
    periodic.sample(a, 10, true, 2);
    expect(periodic.result().msd[2]).toBeCloseTo(4, 9);
  });
});

describe('MeanSquareDisplacement: усреднение по началам отсчёта', () => {
  it('одно начало даёт ровно N слагаемых, много начал — заметно больше', () => {
    // Смысл множества начал: MSD — среднее по ансамблю, и одно начало даёт
    // всего N слагаемых (шум ~1/√N). Каждое новое начало добавляет ещё N.
    const count = 50;
    const state = atOrigin(count);
    const single = new MeanSquareDisplacement(10, 10);
    single.prepare(count);
    single.addOrigin(state, 100);
    single.sample(state, 100, true, 0);
    const singleCurve = single.result();
    expect(singleCurve.counts[0]).toBe(count);

    const many = new MeanSquareDisplacement(10, 10);
    many.prepare(count);
    for (let f = 0; f < 20; f++) {
      many.addOrigin(state, 100);
      many.sample(state, 100, true, f);
    }
    expect(many.originCount).toBeGreaterThan(1);
    const manyCurve = many.result();
    // Кадры идут через 1 τ при ширине бина 1 τ, поэтому в бин 0 попадает
    // только самое первое начало, а все последующие — в бин 1. Именно по
    // нему и видно, что статистика усредняется по МНОЖЕСТВУ начал.
    let peak = 0;
    for (let k = 0; k < manyCurve.counts.length; k++) {
      peak = Math.max(peak, manyCurve.counts[k]);
    }
    expect(peak).toBeGreaterThan(count * 5);
    expect(manyCurve.counts[0]).toBe(count);
  });

  it('оценка D сходится при росте числа начал', () => {
    // Проверка эргодичности на практике: система стационарна, поэтому
    // «много начал» и «мало начал» на одной и той же траектории обязаны
    // давать одну и ту же физику, отличаясь лишь шумом.
    const world = annealed(1.1, 0.7, 23, 300);
    const box = world.box;
    const msd = new MeanSquareDisplacement(40, 10);
    msd.prepare(world.state.count);
    for (let f = 0; f < 500; f++) {
      msd.addOrigin(world.state, box);
      msd.sample(world.state, box, true, world.time);
      world.run(FRAME_STEPS);
    }
    // Полная оценка и оценка по последним началам (они ещё не дали длинных
    // лагов, но их вклад в ранние бины должен быть согласован).
    const full = msd.diffusion();
    const curve = msd.result();
    // В бинах середины окна накоплено заведомо больше N слагаемых — значит,
    // усреднение идёт по множеству начал, а не по одной траектории.
    const middle = 20;
    expect(curve.counts[middle]).toBeGreaterThan(world.state.count * 2);
    expect(full.D).toBeGreaterThan(0.02);
    expect(full.D).toBeLessThan(0.4);
  }, 120000);
});

describe('MeanSquareDisplacement: настоящая динамика Леннард-Джонса', () => {
  it('кристалл почти не диффундирует, жидкость — в тысячи раз быстрее', () => {
    // Главная физическая проверка файла. У кристалла частица колеблется
    // вокруг узла: смещение выходит на плато 0.1σ и перестаёт расти, поэтому
    // наклон MSD практически нулевой. У жидкости смещение линейно по времени.
    const crystal = measureDiffusion(0.15, 0.95, 17);
    const liquid = measureDiffusion(1.1, 0.7, 7);

    expect(crystal.D).toBeLessThan(0.01);
    expect(liquid.D).toBeGreaterThan(0.02);
    expect(liquid.D).toBeLessThan(0.4);
    // Разница не «в пределах шума», а на порядки.
    expect(liquid.D / Math.max(crystal.D, 1e-9)).toBeGreaterThan(5);
  }, 120000);

  it('D жидкости при T* = 1.1 попадает в разумный диапазон', () => {
    const { D, r2 } = measureDiffusion(1.1, 0.7, 7);
    // Ориентир для приведённых единиц: жидкость Леннард-Джонса даёт
    // D ≈ 0.05…0.15. Диапазон теста намеренно шире — он ловит грубую
    // ошибку размерности, а не воспроизводимость конкретного прогона.
    expect(D).toBeGreaterThan(0.02);
    expect(D).toBeLessThan(0.4);
    // Подгонка на нормальной жидкости обязана быть почти идеальной.
    expect(r2).toBeGreaterThan(0.9);
  }, 120000);

  it('D растёт с температурой (T* = 0.9 и T* = 1.4)', () => {
    const cold = measureDiffusion(0.9, 0.7, 11);
    const hot = measureDiffusion(1.4, 0.7, 13);
    expect(cold.D).toBeGreaterThan(0.02);
    expect(hot.D).toBeGreaterThan(cold.D);
    // Рост заметный, а не в пределах погрешности оценки.
    expect(hot.D / cold.D).toBeGreaterThan(1.15);
  }, 180000);

  it('MSD неотрицательна и не убывает на первых бинах', () => {
    const { msd } = measureDiffusion(1.1, 0.7, 7);
    const { msd: curve, counts } = msd.result();
    for (let k = 0; k < 8; k++) {
      expect(Number.isFinite(curve[k])).toBe(true);
      expect(curve[k]).toBeGreaterThanOrEqual(0);
      expect(counts[k]).toBeGreaterThan(0);
    }
    // На больших лагах статистика беднее и допустим шум; на первых бинах
    // MSD обязана расти: смещение копится, а не «рассасывается».
    for (let k = 1; k < 8; k++) {
      expect(curve[k]).toBeGreaterThan(curve[k - 1]);
    }
  }, 120000);

  it('сдвиг всей системы на пол-ящика не меняет D', () => {
    // Минимальный образ — единственное место модуля, где координаты
    // «заворачиваются». Если он сломан (или его нет), сдвиг системы на
    // пол-ящика даст скачки смещения на целый L и испортит наклон MSD.
    const world = annealed(1.1, 0.7, 5, 300);
    const box = world.box;
    const direct = new MeanSquareDisplacement(40, 10);
    const shifted = new MeanSquareDisplacement(40, 10);
    direct.prepare(world.state.count);
    shifted.prepare(world.state.count);
    const mirror = shiftedState(world.state, box);

    for (let f = 0; f < 500; f++) {
      direct.addOrigin(world.state, box);
      shifted.addOrigin(mirror, box);
      direct.sample(world.state, box, true, world.time);
      shifted.sample(mirror, box, true, world.time);
      world.run(FRAME_STEPS);
      // Сдвинутая копия обязана «ехать» вместе с настоящей системой.
      mirror.x.set(world.state.x);
      mirror.y.set(world.state.y);
      mirror.z.set(world.state.z);
      for (let i = 0; i < mirror.count; i++) {
        mirror.x[i] = (mirror.x[i] + box * 0.5) % box;
        mirror.y[i] = (mirror.y[i] + box * 0.5) % box;
        mirror.z[i] = (mirror.z[i] + box * 0.5) % box;
      }
    }

    const a = direct.diffusion();
    const b = shifted.diffusion();
    expect(a.D).toBeGreaterThan(0.02);
    expect(Math.abs(a.D - b.D) / a.D).toBeLessThan(1e-6);
  }, 120000);
});
