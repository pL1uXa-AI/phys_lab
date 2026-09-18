/**
 * Профиль кадра: физика против отрисовки.
 *
 * Отвечает на вопрос, который нельзя решить рассуждением: что именно
 * ограничивает частоту кадров на больших системах. Если физика — нужен
 * Web Worker; если рендер связей — нужен другой слой отрисовки, и никакой
 * воркер не поможет.
 *
 * Запуск (требует `npm run preview`): node scripts/dev-profile.mjs
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import http from 'node:http';

const URL_TARGET = process.env['PROFILE_URL'] ?? 'http://localhost:4174/';
const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
];
const DEBUG_PORT = 9337;
const OUT_DIR = '.verify/profile';

function findBrowser() {
  for (const path of CHROME_CANDIDATES) if (existsSync(path)) return path;
  throw new Error('Не найден Chrome/Edge');
}

function httpJson(path) {
  return new Promise((res, rej) => {
    const req = http.get({ host: '127.0.0.1', port: DEBUG_PORT, path }, (r) => {
      let d = '';
      r.on('data', (c) => (d += c));
      r.on('end', () => {
        try {
          res(JSON.parse(d));
        } catch (e) {
          rej(e);
        }
      });
    });
    req.on('error', rej);
    req.setTimeout(5000, () => req.destroy(new Error('таймаут')));
  });
}

async function waitForTarget(timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const list = await httpJson('/json/list');
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch {
      /* ещё не поднялся */
    }
    if (Date.now() > deadline) throw new Error('Chrome не открыл порт отладки');
    await delay(300);
  }
}

/** Минимальный websocket-клиент: тот же приём, что в showcase.mjs. */
function makeClient(socket) {
  let nextId = 1;
  const pending = new Map();
  let buffer = Buffer.alloc(0);

  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      if (buffer.length < 2) return;
      const opcode = buffer[0] & 0x0f;
      const masked = (buffer[1] & 0x80) !== 0;
      let length = buffer[1] & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buffer.length < 4) return;
        length = buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (buffer.length < 10) return;
        length = Number(buffer.readBigUInt64BE(2));
        offset = 10;
      }
      if (masked) offset += 4;
      if (buffer.length < offset + length) return;
      const payload = buffer.subarray(offset, offset + length);
      buffer = buffer.subarray(offset + length);
      if (opcode !== 0x1) continue;
      try {
        const msg = JSON.parse(payload.toString('utf8'));
        const entry = pending.get(msg.id);
        if (!entry) continue;
        pending.delete(msg.id);
        if (msg.error) entry.reject(new Error(msg.error.message));
        else entry.resolve(msg.result);
      } catch {
        /* пропускаем неполное */
      }
    }
  });

  function sendFrame(text) {
    const payload = Buffer.from(text, 'utf8');
    const mask = Buffer.from([1, 2, 3, 4]);
    const len = payload.length;
    let header;
    if (len < 126) header = Buffer.from([0x81, 0x80 | len]);
    else if (len < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x81;
      header[1] = 0x80 | 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x81;
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    const out = Buffer.alloc(len);
    for (let i = 0; i < len; i++) out[i] = payload[i] ^ mask[i % 4];
    socket.write(Buffer.concat([header, mask, out]));
  }

  return {
    send(method, params = {}, timeoutMs = 300000) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        sendFrame(JSON.stringify({ id, method, params }));
        setTimeout(() => {
          if (pending.has(id)) {
            pending.delete(id);
            reject(new Error(`таймаут ${method}`));
          }
        }, timeoutMs);
      });
    },
    async eval(expression, timeoutMs) {
      const r = await this.send(
        'Runtime.evaluate',
        { expression, awaitPromise: true, returnByValue: true },
        timeoutMs,
      );
      if (r.exceptionDetails) {
        throw new Error(r.exceptionDetails.exception?.description ?? 'ошибка на странице');
      }
      return r.result.value;
    },
  };
}

async function connect(wsUrl) {
  const net = await import('node:net');
  const { randomBytes } = await import('node:crypto');
  const url = new URL(wsUrl);
  const socket = net.connect({ host: url.hostname, port: Number(url.port) });
  await new Promise((res, rej) => {
    socket.once('connect', res);
    socket.once('error', rej);
  });
  const key = randomBytes(16).toString('base64');
  socket.write(
    `GET ${url.pathname} HTTP/1.1\r\nHost: ${url.host}\r\nUpgrade: websocket\r\n` +
      `Connection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
  );
  await new Promise((res, rej) => {
    let hs = '';
    const onData = (chunk) => {
      hs += chunk.toString('latin1');
      if (!hs.includes('\r\n\r\n')) return;
      socket.off('data', onData);
      if (hs.includes('101')) res();
      else rej(new Error('рукопожатие websocket не удалось'));
    };
    socket.on('data', onData);
  });
  return makeClient(socket);
}

async function main() {
  const browser = findBrowser();
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

  const child = spawn(
    browser,
    [
      '--headless=new',
      '--disable-gpu',
      '--use-gl=swiftshader',
      '--enable-unsafe-swiftshader',
      '--no-sandbox',
      '--no-first-run',
      '--disable-extensions',
      `--user-data-dir=${resolve(OUT_DIR, 'chrome-profile')}`,
      `--remote-debugging-port=${DEBUG_PORT}`,
      '--window-size=1600,900',
      URL_TARGET,
    ],
    { stdio: 'ignore' },
  );

  try {
    const target = await waitForTarget();
    const client = await connect(target.webSocketDebuggerUrl);
    await client.send('Runtime.enable');

    /*
     * Ждём, пока приложение выставит свой API.
     *
     * Фиксированная задержка тут ненадёжна: под софтверным WebGL инициализация
     * WebGL занимает секунды, и скрипт успевал обратиться к `window.__physLab`
     * до его появления — падал с «Cannot read properties of undefined».
     * Опрашиваем вместо этого.
     */
    let ready = false;
    for (let i = 0; i < 60; i++) {
      ready = await client.eval('Boolean(window.__physLab && window.__physLab.actions)');
      if (ready) break;
      await delay(500);
    }
    if (!ready) throw new Error('приложение не выставило window.__physLab за 30 секунд');
    console.log('Профиль кадра: физика против отрисовки\n');
    console.log('N\tшаг, мс\tфизика(5 шагов)\tотрисовка, мс\tсвязей\tкадр 60fps');
    const rows = await client.eval(
      `
      (() => {
        const app = window.__physLab;
        const out = [];
        // Только 2048 частиц и меньшее число кадров отрисовки: софтверный
        // WebGL в headless-режиме считает кадр в десятки раз медленнее
        // реальной видеокарты, и большой прогон просто не заканчивается.
        // Пропорция «физика против отрисовки» видна и на одном размере —
        // главное, что оба числа получены в одинаковых условиях.
        for (const n of [2048]) {
          app.actions.applyPreset('liquid');
          app.world.resize(n, 0.7, 'fcc');
          app.actions.runSteps(60);

          const t0 = performance.now();
          app.actions.runSteps(150);
          const stepMs = (performance.now() - t0) / 150;

          const draw = app.measureDraw(5);

          out.push({
            n: app.metrics().count,
            stepMs,
            drawMs: draw.msPerFrame,
            bonds: draw.bonds,
          });
        }
        return out;
      })()
    `,
      600000,
    );

    for (const row of rows) {
      const physicsFrame = row.stepMs * 5;
      const frame = physicsFrame + row.drawMs;
      console.log(
        `${row.n}\t${row.stepMs.toFixed(2)}\t${physicsFrame.toFixed(1)} мс\t\t` +
          `${row.drawMs.toFixed(2)}\t\t${row.bonds}\t${((frame / 16.7) * 100).toFixed(0)} %`,
      );
    }

    console.log('\nВклад слоя связей в отрисовку (N = 2048)');
    const toggle = await client.eval(
      `
      (() => {
        const app = window.__physLab;
        app.actions.applyPreset('liquid');
        app.world.resize(2048, 0.7, 'fcc');
        app.actions.runSteps(60);
        app.actions.setShowBonds(true);
        const withBonds = app.measureDraw(5);
        app.actions.setShowBonds(false);
        const without = app.measureDraw(5);
        return { withBonds: withBonds.msPerFrame, without: without.msPerFrame, bonds: withBonds.bonds };
      })()
    `,
      600000,
    );
    console.log(
      `  со связями: ${toggle.withBonds.toFixed(2)} мс (связей ${toggle.bonds})\n` +
        `  без связей: ${toggle.without.toFixed(2)} мс\n` +
        `  вклад связей: ${(toggle.withBonds - toggle.without).toFixed(2)} мс`,
    );

    /*
     * Пропускная способность воркера в зависимости от порции.
     *
     * Зачем это мерить. Автоподстройка числа шагов в режиме воркера выбирает
     * размер порции. Наивное «сколько шагов укладывается в кадр» неверно:
     * замерено, что после 16 шагов пропускная способность воркера падает
     * втрое — очередь заказов перестаёт разгружаться. Без этих чисел граница
     * порции была бы догадкой, а с ними она проверяема.
     */
    console.log('\nПропускная способность воркера: порция → шагов в секунду (N = 2048)');
    const curve = await client.eval(
      `
      (async () => {
        const app = window.__physLab;
        if (app.physicsMode() !== 'worker') return null;
        app.state.autoSteps = false;
        app.actions.applyPreset('liquid');
        const rows = [];
        for (const batch of [1, 2, 4, 8, 16, 32, 48]) {
          app.state.stepsPerFrame = batch;
          await new Promise((r) => setTimeout(r, 3500));
          const row = await new Promise((resolve) => {
            const a0 = app.workerDiagnostics();
            const t0 = performance.now();
            let frames = 0;
            const tick = () => {
              frames++;
              if (performance.now() - t0 < 3000) requestAnimationFrame(tick);
              else {
                const dt = (performance.now() - t0) / 1000;
                resolve({
                  batch: app.state.stepsPerFrame,
                  rate: (app.workerDiagnostics().stepsExecuted - a0.stepsExecuted) / dt,
                  fps: frames / dt,
                  cost: app.workerDiagnostics().stepCostMs,
                  backlog: app.workerDiagnostics().backlog,
                });
              }
            };
            requestAnimationFrame(tick);
          });
          rows.push(row);
        }
        app.state.autoSteps = true;
        return rows;
      })()
    `,
      600000,
    );
    if (curve) {
      for (const row of curve) {
        console.log(
          `  порция ${String(row.batch).padStart(2)}: ${row.rate.toFixed(0).padStart(4)} шаг/с` +
            `, ${row.fps.toFixed(1).padStart(5)} кадр/с, шаг ${row.cost.toFixed(2)} мс, отставание ${row.backlog}`,
        );
      }
      const best = curve.reduce((a, b) => (b.rate > a.rate ? b : a));
      console.log(`  максимум: ${best.rate.toFixed(0)} шаг/с при порции ${best.batch}`);
    } else {
      console.log('  пропущено: физика считается локально, воркер не поднят');
    }
  } finally {
    child.kill();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

