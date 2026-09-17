/**
 * Витринные кадры и проверка визуальных состояний.
 *
 * Запуск: node scripts/showcase.mjs
 * Требует запущенного предпросмотра (`npm run preview`).
 *
 * Зачем это отдельно от сквозной проверки. Смоук отвечает на вопрос «работает
 * ли», а здесь мы смотрим, как это ВЫГЛЯДИТ: снимаем кадры каждого пресета
 * в спокойном состоянии и сохраняем в `docs/images/`. Кадры попадают в README,
 * поэтому их вид — часть результата, а не побочный продукт.
 *
 * Скрипт падает с ненулевым кодом, если какая-то сцена оказалась пустой
 * (например, все частицы улетели или камера уехала) — иначе в README можно
 * было бы вставить пустой прямоугольник и не заметить.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import http from 'node:http';

const URL_TARGET = process.env['SHOWCASE_URL'] ?? 'http://localhost:4174/';
const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
];
const DEBUG_PORT = 9335;
const OUT_DIR = 'docs/images';

/**
 * Что снимаем. Для каждого кадра: пресет, сколько шагов прогреть,
 * сколько шагов статистики g(r) накопить и на что смотреть.
 */
const SHOTS = [
  { name: 'crystal', preset: 'crystal', warmup: 300, radial: 60, title: 'Кристалл' },
  { name: 'melting', preset: 'melting', warmup: 400, radial: 60, title: 'Плавление' },
  { name: 'liquid', preset: 'liquid', warmup: 300, radial: 60, title: 'Жидкость' },
  { name: 'gas', preset: 'gas', warmup: 200, radial: 40, title: 'Газ' },
  { name: 'droplet', preset: 'droplet', warmup: 300, radial: 50, title: 'Капля' },
  { name: 'condensation', preset: 'condensation', warmup: 400, radial: 60, title: 'Конденсация' },
];

function findBrowser() {
  for (const path of CHROME_CANDIDATES) if (existsSync(path)) return path;
  throw new Error('Не найден Chrome/Edge');
}

function httpJson(path) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: DEBUG_PORT, path }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
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

class Cdp {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = Buffer.alloc(0);
    socket.on('data', (c) => this.onData(c));
  }
  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      if (this.buffer.length < 2) return;
      const opcode = this.buffer[0] & 0x0f;
      const masked = (this.buffer[1] & 0x80) !== 0;
      let length = this.buffer[1] & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (this.buffer.length < 4) return;
        length = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.buffer.length < 10) return;
        length = Number(this.buffer.readBigUInt64BE(2));
        offset = 10;
      }
      if (masked) offset += 4;
      if (this.buffer.length < offset + length) return;
      const payload = this.buffer.subarray(offset, offset + length);
      this.buffer = this.buffer.subarray(offset + length);
      if (opcode === 0x1) {
        try {
          const msg = JSON.parse(payload.toString('utf8'));
          if (msg.id !== undefined && this.pending.has(msg.id)) {
            const { resolve, reject } = this.pending.get(msg.id);
            this.pending.delete(msg.id);
            if (msg.error) reject(new Error(msg.error.message));
            else resolve(msg.result);
          }
        } catch {
          /* пропускаем */
        }
      } else if (opcode === 0x8) return;
    }
  }
  sendFrame(text) {
    const payload = Buffer.from(text, 'utf8');
    const mask = Buffer.from([1, 2, 3, 4]);
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.from([0x81, 0x80 | len]);
    } else if (len < 65536) {
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
    this.socket.write(Buffer.concat([header, mask, out]));
  }
  send(method, params = {}, timeoutMs = 120000) {
    const id = this.nextId++;
    const text = JSON.stringify({ id, method, params });
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.sendFrame(text);
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`таймаут ${method}`));
        }
      }, timeoutMs);
    });
  }
  async eval(expression, timeoutMs = 120000) {
    const r = await this.send(
      'Runtime.evaluate',
      { expression, awaitPromise: true, returnByValue: true },
      timeoutMs,
    );
    if (r.exceptionDetails) {
      throw new Error(
        r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? 'ошибка на странице',
      );
    }
    return r.result.value;
  }
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
      const idx = hs.indexOf('\r\n\r\n');
      if (idx < 0) return;
      socket.removeListener('data', onData);
      if (!hs.startsWith('HTTP/1.1 101')) {
        rej(new Error(`рукопожатие не удалось: ${hs.split('\r\n')[0]}`));
        return;
      }
      const rest = Buffer.from(hs.slice(idx + 4), 'latin1');
      if (rest.length) socket.unshift(rest);
      res();
    };
    socket.on('data', onData);
    socket.once('error', rej);
  });
  return new Cdp(socket);
}

const failures = [];
function check(name, ok, detail = '') {
  console.log(`[${ok ? ' OK ' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(`${name}: ${detail}`);
}

async function main() {
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  const browser = findBrowser();
  console.log(`Браузер: ${browser}`);
  console.log(`Снимаем: ${URL_TARGET}\n`);

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
      `--user-data-dir=${resolve('.verify', 'chrome-showcase')}`,
      `--remote-debugging-port=${DEBUG_PORT}`,
      // Кадр делаем крупным: он уходит в README, там важна детализация.
      '--window-size=1600,1000',
      URL_TARGET,
    ],
    { stdio: 'ignore' },
  );

  let client;
  try {
    const target = await waitForTarget();
    client = await connect(target.webSocketDebuggerUrl);
    await client.send('Runtime.enable');
    await client.send('Page.enable');
    await delay(3500);

    // Справка при первом запуске перекрывает сцену — закрываем её.
    await client.eval(`
      (() => {
        localStorage.setItem('phys-lab.seen-help', '1');
        for (const b of document.querySelectorAll('.modal-backdrop')) b.remove();
      })()
    `);

    // Панели сворачиваем: на витринном кадре нужна сцена, а не интерфейс.
    // Но не все: подписи пресета и графики должны остаться видимыми.
    await client.eval(`
      (() => {
        const collapse = (name) => {
          const panel = document.querySelector('[data-panel="' + name + '"]');
          if (panel) panel.classList.add('panel--collapsed');
        };
        // Оставляем раскрытыми «Вид» и «Кампания», сворачиваем остальное.
        for (const name of ['world', 'actions', 'presets']) collapse(name);
        const campaign = document.querySelector('[data-panel="campaign"]');
        if (campaign) campaign.classList.add('panel--collapsed');
      })()
    `);

    for (const shot of SHOTS) {
      const info = await client.eval(
        `
        (async () => {
          const app = window.__physLab;
          const ok = app.actions.applyPreset(${JSON.stringify(shot.preset)});
          if (!ok) return { error: 'пресет не найден' };
          // Прогрев и накопление статистики g(r): без неё график пуст.
          app.actions.runSteps(${shot.warmup});
          for (let i = 0; i < ${shot.radial}; i++) {
            app.actions.runSteps(20);
            app.world.sampleRadial();
          }
          // Останавливаем движение: на статичном кадре частицы не смазываются.
          if (app.state.running) app.actions.toggleRun();
          app.renderer.render(app.world);
          await new Promise((r) => requestAnimationFrame(r));
          await new Promise((r) => requestAnimationFrame(r));

          const m = app.metrics();
          const { r, g } = app.world.radialDistribution();
          let peak = 0;
          for (let k = 0; k < r.length; k++) {
            if (r[k] > 0.9 && r[k] < 1.7 && g[k] > peak) peak = g[k];
          }
          return {
            count: m.count,
            temperature: m.temperature,
            density: m.density,
            orderPeak: peak,
            drawn: app.renderer.drawnCount,
            radialSamples: app.world.radial.sampleCount,
          };
        })()
      `,
        300000,
      );

      if (info.error) {
        check(`кадр «${shot.title}»`, false, info.error);
        continue;
      }

      // Пустая сцена — брак: значит камера уехала или частицы исчезли.
      check(
        `кадр «${shot.title}»: сцена не пуста`,
        info.drawn > 100,
        `нарисовано ${info.drawn} из ${info.count}`,
      );
      check(
        `кадр «${shot.title}»: g(r) накоплена`,
        info.radialSamples >= shot.radial && info.orderPeak > 0,
        `кадров ${info.radialSamples}, первый пик ${info.orderPeak.toFixed(2)}`,
      );

      const png = await client.send('Page.captureScreenshot', { format: 'png' });
      writeFileSync(resolve(OUT_DIR, `${shot.name}.png`), Buffer.from(png.data, 'base64'));
      console.log(
        `        ${OUT_DIR}/${shot.name}.png — ${info.count} частиц, ` +
          `T* = ${info.temperature.toFixed(2)}, ρ* = ${info.density.toFixed(2)}`,
      );
    }

    // Отдельный кадр с интерфейсом целиком — для README нужен и он.
    await client.eval(`
      (() => {
        for (const p of document.querySelectorAll('.panel')) p.classList.remove('panel--collapsed');
        window.__physLab.actions.applyPreset('melting');
        window.__physLab.actions.runSteps(600);
        document.querySelector('.sidebar').scrollTop = 0;
      })()
    `);
    await delay(1200);
    const full = await client.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(resolve(OUT_DIR, 'interface.png'), Buffer.from(full.data, 'base64'));
    console.log(`        ${OUT_DIR}/interface.png — интерфейс целиком`);
    check('кадр интерфейса снят', existsSync(resolve(OUT_DIR, 'interface.png')));
  } finally {
    client?.socket?.destroy?.();
    child.kill();
  }

  console.log(`\nГотово. Провалов: ${failures.length}`);
  if (failures.length) {
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
