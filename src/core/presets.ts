/**
 * Пресеты состояний.
 *
 * Слайдеры и кнопки — это удобно, но воспроизвести «то, что было на картинке
 * в README» по памяти невозможно. Пресет фиксирует всю конфигурацию целиком:
 * число частиц, плотность, температуру, термостат, границы и решётку. Именно
 * на них построены уровни кампании и витринные кадры.
 */

import type { LatticeKind, ThermostatKind, BoundaryMode, WorldParams } from './types.js';
import { DEFAULT_PARAMS } from './types.js';

/** Полное описание состояния мира. */
export interface Preset extends WorldParams {
  /** Идентификатор: используется уровнями и ссылками. */
  id: string;
  /** Название для интерфейса. */
  title: string;
  /** Одна строка пояснения: что должно быть видно. */
  hint: string;
  /** Начальная решётка. */
  lattice: LatticeKind;
  /** Идёт ли симуляция сразу после применения пресета. */
  running: boolean;
  /** Проводить ли «отжиг» — короткий прогон для выхода на равновесие. */
  equilibrate: number;
}

/** Сборка пресета с разумными умолчаниями. */
function preset(
  id: string,
  title: string,
  hint: string,
  overrides: Partial<Preset> & { lattice: LatticeKind },
): Preset {
  return {
    ...DEFAULT_PARAMS,
    ...overrides,
    id,
    title,
    hint,
    // Значения ниже перекрываются явными полями вызова.
    running: overrides.running ?? true,
    equilibrate: overrides.equilibrate ?? 0,
  };
}

/** Каталог пресетов. Порядок важен: он же порядок кнопок в интерфейсе. */
export const PRESETS: Preset[] = [
  preset('crystal', 'Кристалл', 'ГЦК-решётка при T* = 0.15: частицы колеблются около узлов', {
    lattice: 'fcc',
    count: 2048,
    density: 0.95,
    temperature: 0.15,
    thermostat: 'langevin',
    boundary: 'periodic',
    dt: 0.004,
    equilibrate: 800,
  }),
  preset(
    'melting',
    'Плавление',
    'Кристалл при T* = 0.85: решётка «плывёт», первый пик g(r) падает',
    {
      lattice: 'fcc',
      count: 2048,
      density: 0.95,
      temperature: 0.85,
      thermostat: 'langevin',
      boundary: 'periodic',
      dt: 0.004,
      equilibrate: 1200,
    },
  ),
  preset('liquid', 'Жидкость', 'Плотная жидкость T* = 1.1: движется, но держится вместе', {
    lattice: 'fcc',
    count: 2048,
    density: 0.75,
    temperature: 1.1,
    thermostat: 'langevin',
    boundary: 'periodic',
    dt: 0.004,
    equilibrate: 1200,
  }),
  preset('gas', 'Газ', 'Разрежённый газ T* = 1.6: частицы разлетаются по всему ящику', {
    lattice: 'random',
    count: 1200,
    density: 0.06,
    temperature: 1.6,
    thermostat: 'langevin',
    boundary: 'periodic',
    dt: 0.005,
    equilibrate: 400,
  }),
  preset(
    'condensation',
    'Конденсация',
    'Случайный газ при T* = 0.55: частицы сами собираются в капли и кристаллиты',
    {
      lattice: 'random',
      count: 1600,
      density: 0.18,
      temperature: 0.55,
      thermostat: 'langevin',
      boundary: 'periodic',
      dt: 0.004,
      equilibrate: 2000,
    },
  ),
  preset(
    'droplet',
    'Капля',
    'Свободная капля в пустоте T* = 0.8: поверхностное натяжение стягивает её в шар',
    {
      lattice: 'droplet',
      count: 2600,
      density: 0.28,
      temperature: 0.8,
      thermostat: 'langevin',
      boundary: 'open',
      dt: 0.004,
      equilibrate: 400,
    },
  ),
  preset(
    'evaporation',
    'Испарение',
    'Жидкая плёнка в открытом ящике T* = 1.4: быстрые частицы покидают систему',
    {
      lattice: 'fcc',
      count: 1800,
      density: 0.9,
      temperature: 1.4,
      thermostat: 'langevin',
      boundary: 'open',
      dt: 0.004,
      equilibrate: 0,
    },
  ),
  preset(
    'diffusion',
    'Диффузия',
    'Две метки в одной жидкости: видно, как частицы проникают друг в друга',
    {
      lattice: 'fcc',
      count: 2048,
      density: 0.7,
      temperature: 1.3,
      thermostat: 'langevin',
      boundary: 'periodic',
      dt: 0.004,
      equilibrate: 600,
    },
  ),
  preset(
    'microcanonical',
    'Без термостата',
    'Микроканонический ансамбль: температура не задаётся, энергия сохраняется',
    {
      lattice: 'fcc',
      count: 1500,
      density: 0.8,
      temperature: 0.9,
      thermostat: 'none',
      boundary: 'periodic',
      dt: 0.002,
      equilibrate: 0,
    },
  ),
];

/** Пресет по идентификатору. */
export function presetById(id: string): Preset | undefined {
  return PRESETS.find((p) => p.id === id);
}

/** Термостаты в порядке отображения в интерфейсе. */
export const THERMOSTATS: ReadonlyArray<{ id: ThermostatKind; label: string; note: string }> = [
  { id: 'berendsen', label: 'Берендсен', note: 'Масштабирование скоростей: просто и надёжно' },
  { id: 'langevin', label: 'Ланжевен', note: 'Трение и шум: локальный, не портит динамику' },
  { id: 'nose-hoover', label: 'Нозе-Хувер', note: 'Канонический ансамбль: верные флуктуации' },
  { id: 'none', label: 'Нет', note: 'Энергия сохраняется, температура свободна' },
];

/** Граничные условия для интерфейса. */
export const BOUNDARIES: ReadonlyArray<{ id: BoundaryMode; label: string; note: string }> = [
  { id: 'periodic', label: 'Периодические', note: 'Бесконечный кристалл: ящик без стенок' },
  { id: 'reflective', label: 'Стенки', note: 'Конечный ящик с отражением' },
  { id: 'open', label: 'Открытые', note: 'Частицы улетают: видно испарение' },
];

/** Начальные решётки для интерфейса. */
export const LATTICES: ReadonlyArray<{ id: LatticeKind; label: string }> = [
  { id: 'fcc', label: 'ГЦК-решётка' },
  { id: 'sc', label: 'Кубическая' },
  { id: 'random', label: 'Случайный газ' },
  { id: 'droplet', label: 'Капля' },
];
