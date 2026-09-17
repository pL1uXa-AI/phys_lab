/**
 * Сохранение и загрузка состояния мира.
 *
 * ─── Зачем это нужно ─────────────────────────────────────────────────────
 *
 * До сих пор состояние жило только внутри сессии: закрыл страницу — потерял
 * и конфигурацию, и накопленную статистику. Из-за этого нельзя ни вернуться
 * к интересному кадру, ни поделиться ссылкой на конкретный эксперимент,
 * ни сравнить два запуска.
 *
 * ─── Главное требование: воспроизводимость ───────────────────────────────
 *
 * Восстановленный мир обязан продолжить ровно ту же траекторию, а не
 * «похожую». Для этого мало сохранить координаты и скорости: случайные
 * числа участвуют в термостате Ланжевена и в тепловом шуме, поэтому надо
 * сохранить и состояние генератора (`Rng.save()`). Плюс важно восстановить
 * поля, которые не выводятся из координат: накопленный путь, смещение,
 * опорные координаты решётки и счётчики времени и шагов.
 *
 * Проверяется тестом буквально: сохранить → восстановить → прогнать N шагов
 * в обоих мирах → координаты должны совпасть побитово (или с точностью
 * порядка машинного эпсилона, потому что вычисления идут в одном порядке).
 *
 * ─── Формат ──────────────────────────────────────────────────────────────
 *
 * JSON с версией. Числа пишутся как есть (не «красиво»): округление при
 * выводе сломало бы бит-в-бит воспроизведение. Массивы координат — обычные
 * списки чисел: так файл остаётся читаемым и переносимым между языками,
 * а размер на 20 000 частиц ≈ 5 МБ, что приемлемо для ручного сохранения.
 */

import { Rng } from './rng.js';
import { allocState, boxLength, type ParticleState, type WorldParams } from './types.js';

/** Версия формата: загрузчик обязан её проверять. */
export const SAVE_VERSION = 1;

/** Снимок мира в переносимом виде. */
export interface WorldSnapshot {
  version: number;
  /** Момент сохранения — для интерфейса и отладки. */
  savedAt: string;
  /** Параметры мира. */
  params: WorldParams;
  /** Длина ящика: не выводится из параметров однозначно при открытых границах. */
  box: number;
  /** Накопленное время и число шагов. */
  time: number;
  steps: number;
  /** Состояние генератора случайных чисел. */
  rng: [number, number, number, number];
  /** Число частиц. */
  count: number;
  /** Маска заморозки. */
  frozen: number[];
  /**
   * Состояние частиц.
   *
   * Координаты и скорости обязательны; остальное нужно для того, чтобы
   * статистика (смещение, путь) продолжилась, а не началась с нуля.
   */
  state: {
    x: number[];
    y: number[];
    z: number[];
    px: number[];
    py: number[];
    pz: number[];
    vx: number[];
    vy: number[];
    vz: number[];
    travel: number[];
    displacement: number[];
    refX: number[];
    refY: number[];
    refZ: number[];
    alive: number[];
    type: number[];
    charge: number[];
  };
}

/** Сериализуемый минимум, который нужен от мира (чтобы не тянуть весь класс). */
export interface SnapshotSource {
  params: WorldParams;
  state: ParticleState;
  frozen: Uint8Array;
  box: number;
  time: number;
  steps: number;
  rng: Rng;
}

/** Снять снимок с мира. */
export function snapshotWorld(world: SnapshotSource): WorldSnapshot {
  const s = world.state;
  return {
    version: SAVE_VERSION,
    savedAt: new Date().toISOString(),
    params: { ...world.params },
    box: world.box,
    time: world.time,
    steps: world.steps,
    rng: world.rng.save(),
    count: s.count,
    frozen: Array.from(world.frozen.subarray(0, s.count)),
    // `Float64Array` → обычный массив: JSON не умеет типизированные массивы,
    // а `Array.from` на Float64Array сохраняет значения без округления.
    state: {
      x: Array.from(s.x),
      y: Array.from(s.y),
      z: Array.from(s.z),
      px: Array.from(s.px),
      py: Array.from(s.py),
      pz: Array.from(s.pz),
      vx: Array.from(s.vx),
      vy: Array.from(s.vy),
      vz: Array.from(s.vz),
      travel: Array.from(s.travel),
      displacement: Array.from(s.displacement),
      refX: Array.from(s.refX),
      refY: Array.from(s.refY),
      refZ: Array.from(s.refZ),
      alive: Array.from(s.alive),
      type: Array.from(s.type),
      charge: Array.from(s.charge),
    },
  };
}

/** Результат загрузки: состояние плюс всё, что нужно восстановить в мире. */
export interface LoadedSnapshot {
  params: WorldParams;
  state: ParticleState;
  frozen: Uint8Array;
  box: number;
  time: number;
  steps: number;
  rng: [number, number, number, number];
}

/**
 * Проверка снимка перед загрузкой.
 *
 * Без неё битый или чужой файл приводил бы к «тихо неправильному» миру:
 * часть массивов короче других, координаты `undefined`, и только через
 * сотню шагов становилось бы ясно, что что-то не так. Лучше отказать сразу
 * и внятно.
 */
export function validateSnapshot(raw: unknown): { ok: true; snapshot: WorldSnapshot } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'Файл не содержит объекта состояния' };
  const snapshot = raw as Partial<WorldSnapshot>;
  if (snapshot.version !== SAVE_VERSION) {
    return {
      ok: false,
      error: `Неподдерживаемая версия файла: ${String(snapshot.version)} (ожидается ${SAVE_VERSION})`,
    };
  }
  if (!snapshot.params || typeof snapshot.params !== 'object') {
    return { ok: false, error: 'В файле нет параметров мира' };
  }
  if (!Number.isFinite(snapshot.box) || (snapshot.box as number) <= 0) {
    return { ok: false, error: 'Некорректная длина ящика' };
  }
  const state = snapshot.state;
  if (!state || typeof state !== 'object') return { ok: false, error: 'В файле нет состояния частиц' };
  const count = snapshot.count;
  if (!Number.isInteger(count) || (count as number) <= 0) {
    return { ok: false, error: 'Некорректное число частиц' };
  }
  const required: Array<keyof WorldSnapshot['state']> = [
    'x',
    'y',
    'z',
    'px',
    'py',
    'pz',
    'vx',
    'vy',
    'vz',
    'travel',
    'displacement',
    'refX',
    'refY',
    'refZ',
    'alive',
    'type',
    'charge',
  ];
  for (const key of required) {
    const array = state[key];
    if (!Array.isArray(array) || array.length !== count) {
      return {
        ok: false,
        error: `Массив «${key}» отсутствует или его длина не равна числу частиц (${String(count)})`,
      };
    }
  }
  // Координаты и скорости обязаны быть конечными числами: NaN в файле
  // означал бы, что сохранён уже разлетевшийся мир, и восстанавливать его
  // бессмысленно.
  for (const key of ['x', 'y', 'z', 'vx', 'vy', 'vz'] as const) {
    const array = state[key] as number[];
    for (let i = 0; i < array.length; i++) {
      if (!Number.isFinite(array[i])) {
        return { ok: false, error: `В массиве «${key}» есть нечисловое значение (частица ${i})` };
      }
    }
  }
  return { ok: true, snapshot: snapshot as WorldSnapshot };
}

/** Восстановить состояние из проверенного снимка. */
export function restoreSnapshot(snapshot: WorldSnapshot): LoadedSnapshot {
  const count = snapshot.count;
  const state = allocState(count);
  const src = snapshot.state;
  // `set` копирует значения как есть — без промежуточной арифметики,
  // поэтому восстановление не меняет ни одного бита.
  state.x.set(src.x);
  state.y.set(src.y);
  state.z.set(src.z);
  state.px.set(src.px);
  state.py.set(src.py);
  state.pz.set(src.pz);
  state.vx.set(src.vx);
  state.vy.set(src.vy);
  state.vz.set(src.vz);
  state.travel.set(src.travel);
  state.displacement.set(src.displacement);
  state.refX.set(src.refX);
  state.refY.set(src.refY);
  state.refZ.set(src.refZ);
  state.alive.set(src.alive);
  state.type.set(src.type);
  state.charge.set(src.charge);

  const frozen = new Uint8Array(count);
  if (Array.isArray(snapshot.frozen)) {
    frozen.set(snapshot.frozen.slice(0, count));
  }

  const params = { ...snapshot.params };
  // Число частиц в параметрах обязано совпадать с состоянием: иначе
  // интерфейс покажет одно, а физика будет считать другое.
  params.count = count;

  return {
    params,
    state,
    frozen,
    // Ящик берётся из файла, а не пересчитывается из плотности: при
    // открытых границах частицы могли уйти далеко, и пересчёт дал бы
    // другую геометрию, чем была в момент сохранения.
    box: snapshot.box,
    time: snapshot.time,
    steps: snapshot.steps,
    rng: snapshot.rng,
  };
}

/** Полный цикл: текст JSON → готовое к загрузке состояние. */
export function parseSnapshot(text: string): { ok: true; loaded: LoadedSnapshot } | { ok: false; error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return { ok: false, error: `Не удалось разобрать JSON: ${(error as Error).message}` };
  }
  const checked = validateSnapshot(raw);
  if (!checked.ok) return checked;
  return { ok: true, loaded: restoreSnapshot(checked.snapshot) };
}

/** Сериализация снимка в текст файла. */
export function serializeSnapshot(snapshot: WorldSnapshot): string {
  return JSON.stringify(snapshot);
}

/**
 * Проверка согласованности плотности и ящика у снимка.
 *
 * Нужна при загрузке: если пользователь правил файл руками и плотность
 * разошлась с ящиком, физика будет считать одно, а подписи показывать
 * другое. Возвращает плотность, соответствующую фактическому ящику.
 */
export function effectiveDensity(snapshot: WorldSnapshot): number {
  return snapshot.count / (snapshot.box * snapshot.box * snapshot.box);
}

/** Ящик, соответствующий плотности при данном числе частиц. */
export function boxForDensity(count: number, density: number): number {
  return boxLength(count, density);
}
