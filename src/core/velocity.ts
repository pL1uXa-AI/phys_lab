/**
 * Работа со скоростями: дрейф центра масс, кинетическая энергия, нормировка.
 *
 * Вынесено отдельно, чтобы модуль построения конфигураций и интегратор
 * пользовались одной и той же арифметикой. Дублирование здесь стоило бы
 * дорого: разошедшаяся на копейку нормировка температуры превращается
 * в разные результаты у «одинаковых» запусков.
 */

import type { ParticleState } from './types.js';

/** Кинетическая энергия ½ Σ v² (масса частицы — единица). */
export function kineticEnergyOfState(state: ParticleState): number {
  let sum = 0;
  const vx = state.vx;
  const vy = state.vy;
  const vz = state.vz;
  const alive = state.alive;
  for (let i = 0; i < state.count; i++) {
    if (alive[i] === 0) continue;
    sum += vx[i] * vx[i] + vy[i] * vy[i] + vz[i] * vz[i];
  }
  return 0.5 * sum;
}

/** Число «живых» частиц. */
export function aliveCount(state: ParticleState): number {
  let n = 0;
  for (let i = 0; i < state.count; i++) if (state.alive[i] !== 0) n++;
  return n;
}

/**
 * Вычитание скорости центра масс.
 *
 * Зачем: в периодическом ящике равномерное движение всех частиц неотличимо
 * от покоя — у него нет физического смысла, но оно добавляет к кинетической
 * энергии N·v²/2, которая целиком уходит в «температуру». Дрейф появляется
 * от любой асимметрии сил, поэтому его убирают перед измерением T.
 */
export function removeDriftNow(state: ParticleState): void {
  let mx = 0;
  let my = 0;
  let mz = 0;
  let n = 0;
  for (let i = 0; i < state.count; i++) {
    if (state.alive[i] === 0) continue;
    mx += state.vx[i];
    my += state.vy[i];
    mz += state.vz[i];
    n++;
  }
  if (n === 0) return;
  mx /= n;
  my /= n;
  mz /= n;
  for (let i = 0; i < state.count; i++) {
    if (state.alive[i] === 0) continue;
    state.vx[i] -= mx;
    state.vy[i] -= my;
    state.vz[i] -= mz;
  }
}

/** Температура по кинетической энергии и числу степеней свободы. */
export function temperatureOf(kinetic: number, dof: number): number {
  return dof > 0 ? (2 * kinetic) / dof : 0;
}
