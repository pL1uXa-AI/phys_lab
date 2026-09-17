/**
 * Точка входа приложения.
 *
 * Задачи: создать Pixi-приложение, поднять интерфейс, выставить публичный
 * API и перехватить ошибки. Перехват ошибок нужен не «на всякий случай»:
 * сквозная проверка в браузере (`npm run smoke`) читает их список, и без
 * этого любая ошибка в кадре осталась бы незамеченной — юнит-тесты её не
 * увидят, потому что они не запускают браузер.
 */

import './ui/styles.css';
import { Application } from 'pixi.js';
import { App } from './app/app.js';
import { BACKGROUND } from './render/palette.js';

/** Список ошибок, собранных на странице — читается смоук-тестом. */
interface ErrorSink {
  __smokeErrors?: string[];
  __physLab?: unknown;
}

async function main(): Promise<void> {
  const sink = window as unknown as ErrorSink;
  sink.__smokeErrors = sink.__smokeErrors ?? [];

  window.addEventListener('error', (event) => {
    sink.__smokeErrors?.push(String(event.message));
  });
  window.addEventListener('unhandledrejection', (event) => {
    sink.__smokeErrors?.push(`unhandledrejection: ${String(event.reason)}`);
  });

  const host = document.getElementById('app');
  if (!host) throw new Error('Не найден контейнер #app');

  const app = new Application();
  await app.init({
    // Размер выставит SceneRenderer при первой подгонке под ящик.
    width: 800,
    height: 600,
    background: BACKGROUND,
    antialias: true,
    // Без явного указания Pixi в браузере может выбрать WebGL2 или WebGL;
    // оба подходят. Canvas-фолбэк оставляем, чтобы приложение работало
    // даже там, где WebGL отключён (например, в headless-проверке).
    preference: 'webgl',
    autoDensity: true,
    resolution: Math.min(2, window.devicePixelRatio || 1),

  });

  const physLab = new App(host, app);
  await physLab.init();
  sink.__physLab = physLab.api();

  // Первый запуск: показать справку. Она же объясняет, что вообще происходит.
  const seen = localStorage.getItem('phys-lab.seen-help');
  if (!seen) {
    localStorage.setItem('phys-lab.seen-help', '1');
    // Небольшая задержка: дать сцене отрисоваться, чтобы справка
    // не перекрывала пустой экран.
    setTimeout(() => physLab.api().actions.openHelp(), 600);
  }
}

main().catch((error: unknown) => {
  const sink = window as unknown as ErrorSink;
  sink.__smokeErrors?.push(`boot: ${String(error)}`);
  const host = document.getElementById('app');
  if (host) {
    host.textContent = `Не удалось запустить приложение: ${String(error)}`;
  }
  console.error(error);
});
