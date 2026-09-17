/**
 * Тесты экспорта данных.
 *
 * Проверяется именно ФОРМАТ и точность, а не «функция что-то вернула»:
 * файл читает внешняя программа, и ошибка в разделителе, числе или
 * экранировании делает выгрузку бесполезной, никак не проявляясь в
 * интерфейсе.
 *
 * Отдельное внимание — точности чисел: CSV не должен «портить» данные.
 * Число, записанное с недостаточной точностью, даёт график, не совпадающий
 * с исходным, и заметить это можно только сравнением.
 */

import { describe, expect, it } from 'vitest';
import {
  historyToCsv,
  radialToCsv,
  structureToCsv,
  timestampedName,
  type HistoryRow,
} from '../render/export.js';

/** Разбор строки CSV с учётом кавычек — чтобы проверять структуру честно. */
function parseCsvLine(line: string, delimiter = ';'): string[] {
  const out: string[] = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === delimiter) {
      out.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  out.push(current);
  return out;
}

function makeRow(overrides: Partial<HistoryRow> = {}): HistoryRow {
  return {
    time: 1.5,
    temperature: 0.9,
    kinetic: 100.25,
    potential: -300.5,
    total: -200.25,
    pressure: 0.42,
    orderPeak: 2.5,
    mobileFraction: 0.75,
    ...overrides,
  };
}

describe('экспорт CSV', () => {
  it('история содержит строку заголовка и по строке на замер', () => {
    const rows = [makeRow(), makeRow({ time: 2.5 })];
    const csv = historyToCsv(rows);
    const lines = csv.trimEnd().split('\n');
    expect(lines).toHaveLength(3);
    const header = parseCsvLine(lines[0]);
    expect(header[0]).toBe('время_tau');
    expect(header).toContain('T*');
    expect(header).toContain('P*');
    expect(header).toContain('подвижных_доля');
  });

  it('число столбцов одинаково во всех строках', () => {
    const rows = [makeRow(), makeRow({ time: 10 }), makeRow({ time: 100 })];
    const lines = historyToCsv(rows).trimEnd().split('\n');
    const width = parseCsvLine(lines[0]).length;
    for (const line of lines) expect(parseCsvLine(line)).toHaveLength(width);
  });

  it('значения переносятся без искажений', () => {
    const row = makeRow({ temperature: 0.123456789, pressure: -12.5 });
    const lines = historyToCsv([row]).trimEnd().split('\n');
    const values = parseCsvLine(lines[1]);
    // Точность 6 знаков после запятой: этого достаточно, чтобы график по
    // файлу совпал с исходным.
    expect(Number(values[1])).toBeCloseTo(0.123456789, 6);
    expect(Number(values[5])).toBeCloseTo(-12.5, 6);
  });

  it('очень большие и очень малые числа не превращаются в ноль', () => {
    // Дефект, который легко не заметить: `toFixed` на большой величине
    // выводит сотни знаков, а на очень малой — просто «0.000000».
    const csv = historyToCsv([makeRow({ kinetic: 1.5e12, potential: -3.2e-9 })]);
    const values = parseCsvLine(csv.trimEnd().split('\n')[1]);
    expect(Number(values[2])).toBeCloseTo(1.5e12, -6);
    expect(Number(values[3])).toBeCloseTo(-3.2e-9, 15);
    expect(Number(values[3])).not.toBe(0);
  });

  it('нечисловые значения дают пустое поле, а не NaN в файле', () => {
    const csv = historyToCsv([makeRow({ temperature: Number.NaN })]);
    const values = parseCsvLine(csv.trimEnd().split('\n')[1]);
    expect(values[1]).toBe('');
    expect(csv).not.toContain('NaN');
  });

  it('файл заканчивается переводом строки', () => {
    // Без завершающего перевода некоторые инструменты импорта теряют
    // последнюю строку — это реальная, а не выдуманная проблема.
    expect(historyToCsv([makeRow()]).endsWith('\n')).toBe(true);
  });

  it('пустая история даёт только заголовок', () => {
    const lines = historyToCsv([]).trimEnd().split('\n');
    expect(lines).toHaveLength(1);
    expect(parseCsvLine(lines[0])).toHaveLength(8);
  });

  it('разделитель — точка с запятой (требование русского Excel)', () => {
    const csv = historyToCsv([makeRow()]);
    // Первая строка содержит 7 разделителей при 8 столбцах.
    expect(csv.split('\n')[0].split(';')).toHaveLength(8);
  });

  it('g(r) экспортируется с числом накопленных кадров', () => {
    const r = new Float64Array([0.025, 0.075, 0.125]);
    const g = new Float64Array([0, 1.5, 2.25]);
    const csv = radialToCsv(r, g, 42);
    const lines = csv.trimEnd().split('\n');
    expect(lines).toHaveLength(4);
    expect(parseCsvLine(lines[0])).toEqual(['r_sigma', 'g(r)', 'кадров']);
    const second = parseCsvLine(lines[1]);
    expect(Number(second[0])).toBeCloseTo(0.025, 6);
    expect(Number(second[1])).toBeCloseTo(0, 6);
    expect(Number(second[2])).toBe(42);
  });

  it('g(r) обрезается по короткому массиву, а не падает', () => {
    // Массивы одной длины по построению, но защита нужна: экспорт не должен
    // ронять приложение из-за расхождения, которое уже случалось в кэшах.
    const csv = radialToCsv(new Float64Array([1, 2, 3]), new Float64Array([1, 2]), 5);
    expect(csv.trimEnd().split('\n')).toHaveLength(3);
  });

  it('структурный фактор экспортируется отдельно', () => {
    const csv = structureToCsv(new Float64Array([1, 2]), new Float64Array([0.5, 3.5]), 7);
    const lines = csv.trimEnd().split('\n');
    expect(parseCsvLine(lines[0])).toEqual(['k_sigma^-1', 'S(k)', 'кадров']);
    expect(Number(parseCsvLine(lines[2])[1])).toBeCloseTo(3.5, 6);
  });

  it('подвижность выгружается как доля, а не процент', () => {
    // Важная деталь: в интерфейсе доля умножается на 100, а в файл должна
    // идти «сырая» величина, иначе данные нельзя сравнивать с измерениями.
    const csv = historyToCsv([makeRow({ mobileFraction: 0.25 })]);
    const values = parseCsvLine(csv.trimEnd().split('\n')[1]);
    expect(Number(values[7])).toBeCloseTo(0.25, 6);
  });
});

describe('имена файлов экспорта', () => {
  it('имя содержит отметку времени и расширение', () => {
    const now = new Date(2026, 1, 14, 9, 5, 3);
    const name = timestampedName('phys-lab-история', 'csv', now);
    expect(name).toBe('phys-lab-история-20260214-090503.csv');
  });

  it('два экспорта подряд не перетирают друг друга', () => {
    const first = timestampedName('phys-lab-g(r)', 'csv', new Date(2026, 0, 1, 0, 0, 1));
    const second = timestampedName('phys-lab-g(r)', 'csv', new Date(2026, 0, 1, 0, 0, 2));
    expect(first).not.toBe(second);
  });

  it('однозначные числа дополняются нулём', () => {
    const name = timestampedName('x', 'png', new Date(2026, 8, 7, 6, 5, 4));
    expect(name).toBe('x-20260907-060504.png');
  });
});
