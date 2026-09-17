/**
 * Тесты сохранения и загрузки состояния.
 *
 * Главное требование к сохранению — не «данные не потерялись», а
 * ПРОДОЛЖЕНИЕ ТОЙ ЖЕ ТРАЕКТОРИИ. Поэтому центральный тест здесь такой:
 * сохранить мир, восстановить его в новый объект, прогнать обоих на
 * одинаковое число шагов и сравнить координаты. Расхождение означает, что
 * в снимок не попало что-то, что влияет на динамику, — и найти это
 * «что-то» иначе почти невозможно: мир выглядит работающим.
 *
 * Отдельно проверяются защитные свойства: битый файл обязан быть отвергнут
 * с внятной причиной, а не восстановлен «частично».
 */

import { describe, expect, it } from 'vitest';
import { World } from '../core/world.js';
import {
  effectiveDensity,
  parseSnapshot,
  serializeSnapshot,
  validateSnapshot,
  SAVE_VERSION,
  type WorldSnapshot,
} from '../core/snapshot.js';
import { DEFAULT_PARAMS } from '../core/types.js';

/** Мир с воспроизводимыми параметрами. */
function makeWorld(overrides: Partial<typeof DEFAULT_PARAMS> = {}): World {
  return new World(
    {
      count: 256,
      density: 0.8,
      temperature: 0.9,
      thermostat: 'langevin',
      boundary: 'periodic',
      ...overrides,
    },
    424242,
    'fcc',
  );
}

describe('сохранение состояния', () => {
  it('восстановленный мир продолжает ту же траекторию бит-в-бит', () => {
    // Термостат Ланжевена выбран намеренно: он потребляет случайные числа,
    // поэтому без сохранения состояния генератора траектории разойдутся.
    const original = makeWorld({ thermostat: 'langevin' });
    original.run(200);

    const text = serializeSnapshot(original.snapshot());
    const parsed = parseSnapshot(text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const restored = makeWorld({ thermostat: 'langevin' });
    restored.restore(parsed.loaded);

    // Сравниваем не только координаты, но и то, что мир «помнит» время.
    expect(restored.time).toBe(original.time);
    expect(restored.steps).toBe(original.steps);

    original.run(150);
    restored.run(150);

    for (let i = 0; i < original.state.count; i++) {
      // Точное равенство: вычисления идут в одном и том же порядке над одними
      // и теми же числами, поэтому расхождение хотя бы на один бит означало бы
      // потерю данных при сериализации.
      expect(restored.state.x[i]).toBe(original.state.x[i]);
      expect(restored.state.y[i]).toBe(original.state.y[i]);
      expect(restored.state.z[i]).toBe(original.state.z[i]);
      expect(restored.state.vx[i]).toBe(original.state.vx[i]);
      expect(restored.state.vy[i]).toBe(original.state.vy[i]);
      expect(restored.state.vz[i]).toBe(original.state.vz[i]);
    }
  });

  it('без сохранения генератора траектория разошлась бы', () => {
    // Обратная проверка к предыдущей: она доказывает, что тест выше имеет
    // смысл, а не проходит «сам собой». Если сбить состояние генератора,
    // траектории обязаны разойтись — иначе тест на бит-в-бит ничего не ловит.
    const original = makeWorld({ thermostat: 'langevin' });
    original.run(100);

    const parsed = parseSnapshot(serializeSnapshot(original.snapshot()));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const tampered = makeWorld({ thermostat: 'langevin' });
    tampered.restore(parsed.loaded);
    // Портим состояние генератора: подменяем одно слово.
    tampered.rng.restore([1, 2, 3, 4]);

    original.run(60);
    tampered.run(60);

    let maxDiff = 0;
    for (let i = 0; i < original.state.count; i++) {
      maxDiff = Math.max(maxDiff, Math.abs(original.state.x[i] - tampered.state.x[i]));
    }
    expect(maxDiff).toBeGreaterThan(1e-6);
  });

  it('сохраняются все поля, влияющие на динамику', () => {
    const world = makeWorld({ thermostat: 'langevin' });
    world.run(50);
    const snapshot = world.snapshot();

    expect(snapshot.version).toBe(SAVE_VERSION);
    expect(snapshot.count).toBe(world.state.count);
    expect(snapshot.params.thermostat).toBe('langevin');
    expect(snapshot.box).toBe(world.box);
    expect(snapshot.rng).toHaveLength(4);
    // Опорные координаты и накопленные величины нужны, чтобы статистика
    // «смещение» и «путь» продолжилась, а не началась с нуля.
    expect(snapshot.state.refX.length).toBe(snapshot.count);
    expect(snapshot.state.travel.length).toBe(snapshot.count);
    expect(snapshot.state.displacement.length).toBe(snapshot.count);
    expect(snapshot.state.alive.length).toBe(snapshot.count);
    expect(snapshot.frozen.length).toBe(snapshot.count);
  });

  it('маска заморозки переживает сохранение', () => {
    const world = makeWorld();
    // Замораживаем цилиндр вдоль оси X прямо через ось взгляда: так тест не
    // зависит от углов камеры и проверяет именно сохранение маски.
    const axis = world.viewAxis(0, Math.PI / 2);
    world.freezeRegion(
      { w: axis, center: { x: world.box * 0.5, y: world.box * 0.5, z: world.box * 0.5 } },
      world.box * 0.4,
    );
    const frozenBefore = world.frozen.reduce((sum, value) => sum + value, 0);
    expect(frozenBefore).toBeGreaterThan(0);

    const parsed = parseSnapshot(serializeSnapshot(world.snapshot()));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const restored = makeWorld();
    restored.restore(parsed.loaded);

    const frozenAfter = restored.frozen.reduce((sum, value) => sum + value, 0);
    expect(frozenAfter).toBe(frozenBefore);
    // Позиции замороженных обязаны совпасть с исходными.
    expect(Array.from(restored.frozen)).toEqual(Array.from(world.frozen));
  });

  it('замороженная частица остаётся замороженной и после восстановления', () => {
    const world = makeWorld({ thermostat: 'berendsen' });
    world.freezeAll();
    world.run(30);
    const xBefore = Array.from(world.state.x);

    const parsed = parseSnapshot(serializeSnapshot(world.snapshot()));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const restored = makeWorld({ thermostat: 'berendsen' });
    restored.restore(parsed.loaded);
    restored.run(30);

    for (let i = 0; i < restored.state.count; i++) {
      expect(restored.state.x[i]).toBeCloseTo(xBefore[i], 10);
    }
  });

  it('плотность согласована с фактическим ящиком', () => {
    const world = makeWorld({ density: 0.7 });
    const snapshot = world.snapshot();
    const density = effectiveDensity(snapshot);
    expect(density).toBeCloseTo(world.params.density, 6);
  });

  it('снимок сериализуется и разбирается без потери значений', () => {
    const world = makeWorld();
    world.run(20);
    const text = serializeSnapshot(world.snapshot());
    const parsed = parseSnapshot(text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    for (let i = 0; i < world.state.count; i += 13) {
      // `toBe` (строгое равенство), а не `toBeCloseTo`: JSON обязан хранить
      // double-числа точно, а не «примерно».
      expect(parsed.loaded.state.x[i]).toBe(world.state.x[i]);
      expect(parsed.loaded.state.vz[i]).toBe(world.state.vz[i]);
    }
    expect(parsed.loaded.time).toBe(world.time);
  });

  it('битый JSON отвергается с внятной причиной', () => {
    const result = parseSnapshot('{ это не json');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('JSON');
  });

  it('файл чужой версии отвергается', () => {
    const world = makeWorld();
    const snapshot = world.snapshot() as WorldSnapshot & { version: number };
    snapshot.version = SAVE_VERSION + 99;
    const checked = validateSnapshot(snapshot);
    expect(checked.ok).toBe(false);
    if (checked.ok) return;
    expect(checked.error).toContain('версия');
  });

  it('файл с недостающим массивом отвергается, а не грузится частично', () => {
    const world = makeWorld();
    const snapshot = world.snapshot();
    // Удаляем скорости: без них мир восстановился бы «наполовину» и повёл
    // бы себя странно только через десятки шагов.
    const broken = JSON.parse(serializeSnapshot(snapshot)) as Record<string, unknown>;
    const state = broken['state'] as Record<string, unknown>;
    delete state['vx'];
    const checked = validateSnapshot(broken);
    expect(checked.ok).toBe(false);
    if (checked.ok) return;
    expect(checked.error).toContain('vx');
  });

  it('файл с нечисловыми координатами отвергается', () => {
    const world = makeWorld();
    const snapshot = world.snapshot();
    const broken = JSON.parse(serializeSnapshot(snapshot)) as Record<string, unknown>;
    const state = broken['state'] as Record<string, unknown>;
    // JSON не умеет NaN: он превращается в null при разборе. Проверяем
    // именно этот случай — он и бывает на практике.
    (state['x'] as unknown[])[5] = null;
    const checked = validateSnapshot(broken);
    expect(checked.ok).toBe(false);
    if (checked.ok) return;
    expect(checked.error).toContain('x');
  });

  it('файл с нулевым ящиком отвергается', () => {
    const world = makeWorld();
    const broken = JSON.parse(serializeSnapshot(world.snapshot())) as Record<string, unknown>;
    broken['box'] = 0;
    const checked = validateSnapshot(broken);
    expect(checked.ok).toBe(false);
    if (checked.ok) return;
    expect(checked.error).toContain('ящик');
  });

  it('восстановление меняет число частиц и пересобирает служебные структуры', () => {
    const small = makeWorld({ count: 256 });
    const parsed = parseSnapshot(serializeSnapshot(small.snapshot()));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const big = makeWorld({ count: 500 });
    expect(big.state.count).not.toBe(parsed.loaded.state.count);
    big.restore(parsed.loaded);

    expect(big.state.count).toBe(parsed.loaded.state.count);
    // Список соседей и сетка обязаны быть подогнаны под новое число частиц:
    // иначе шаг читал бы чужие ячейки и пары.
    expect(big.verlet.start.length).toBe(parsed.loaded.state.count + 1);
    big.run(20);
    expect(Number.isFinite(big.measurement.temperature)).toBe(true);
    expect(big.measurement.temperature).toBeGreaterThan(0);
  });

  it('после восстановления статистика продолжается, а не начинается заново', () => {
    const world = makeWorld();
    // Прогоняем так, чтобы накопилось смещение от исходных координат.
    world.run(120);
    const displacementBefore = Array.from(world.state.displacement);

    const parsed = parseSnapshot(serializeSnapshot(world.snapshot()));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const restored = makeWorld();
    restored.restore(parsed.loaded);

    for (let i = 0; i < restored.state.count; i += 17) {
      expect(restored.state.displacement[i]).toBe(displacementBefore[i]);
    }
    // И опорные координаты — те же, что были: иначе «смещение» обнулилось бы.
    expect(Array.from(restored.state.refX)).toEqual(Array.from(world.state.refX));
  });

  it('углы камеры и параметры отрисовки в снимок не входят', () => {
    // Это осознанное разделение: снимок — про физику. Камера и раскраска
    // живут в состоянии приложения и не должны влиять на воспроизводимость.
    const world = makeWorld();
    const snapshot = world.snapshot();
    const keys = Object.keys(snapshot);
    expect(keys).not.toContain('camera');
    expect(keys).not.toContain('view');
    expect(keys).toContain('params');
    expect(keys).toContain('state');
  });

  it('сохранение микроканонического мира сохраняет и энергию', () => {
    // Без термостата энергия — интеграл движения. Сравнивать надо не «энергию
    // до и после», а два мира, стартовавших ИЗ ОДНОЙ точки: тогда любое
    // расхождение означает потерю данных при сохранении, а не естественную
    // флуктуацию интегрирования.
    const original = makeWorld({ thermostat: 'none' });
    original.applyTemperatureNow();
    original.run(200);

    const parsed = parseSnapshot(serializeSnapshot(original.snapshot()));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const restored = makeWorld({ thermostat: 'none' });
    restored.restore(parsed.loaded);

    original.run(200);
    restored.run(200);

    // Бит-в-бит то же самое состояние — значит и энергия совпадает точно.
    expect(restored.measurement.total).toBe(original.measurement.total);
    // И энергия не «улетела»: она осталась порядка начальной.
    expect(Math.abs(restored.measurement.total)).toBeLessThan(Math.abs(parsed.loaded.params.count * 5));
  });
});
