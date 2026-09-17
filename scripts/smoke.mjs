/**
 * Сквозная проверка приложения в настоящем браузере.
 *
 * Запуск: node scripts/smoke.mjs
 * Требует запущенного предпросмотра (`npm run preview`) на http://localhost:4174.
 *
 * Зачем это нужно помимо юнит-тестов. Юнит-тесты проверяют ядро, но не
 * проверяют, что приложение действительно запускается, рисует сцену, считает
 * графики и умеет проходить уровни. Три дефекта из истории проекта юнит-тесты
 * не поймали бы в принципе: неверный знак силы в связке с рендером,
 * «пустая» сцена из-за нулевого размера канваса и графики, которые не
 * перерисовывались. Здесь мы управляем Chrome напрямую через протокол
 * DevTools (без сторонних зависимостей) и оцениваем выражения в контексте
 * страницы — то есть видим ровно то, что видит игрок.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import http from 'node:http';

const URL_TARGET = process.env['SMOKE_URL'] ?? 'http://localhost:4174/';
const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
];

const DEBUG_PORT = 9334;
const SHOT_DIR = '.verify';

function findBrowser() {
  for (const path of CHROME_CANDIDATES) {
    if (existsSync(path)) return path;
  }
  throw new Error('Не найден Chrome/Edge для сквозной проверки');
}

/** Простейший HTTP-клиент к протоколу DevTools. */
function httpJson(path) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: DEBUG_PORT, path }, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          reject(new Error(`Некорректный ответ ${path}: ${data.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('Таймаут запроса к DevTools')));
  });
}

/** Ожидание появления цели отладки. */
async function waitForTarget(timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const list = await httpJson('/json/list');
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch {
      // Chrome ещё не поднялся — ждём дальше.
    }
    if (Date.now() > deadline) throw new Error('Chrome не открыл порт отладки');
    await delay(300);
  }
}

/**
 * Минимальный клиент WebSocket поверх net-сокета.
 * Реализован вручную, чтобы не тянуть зависимость ради одного теста.
 */
class CdpClient {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = Buffer.alloc(0);
    socket.on('data', (chunk) => this.onData(chunk));
  }

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      if (this.buffer.length < 2) return;
      const first = this.buffer[0];
      const second = this.buffer[1];
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      let length = second & 0x7f;
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
      if (opcode === 0x1) this.handleMessage(payload.toString('utf8'));
      else if (opcode === 0x8) return;
    }
  }

  handleMessage(text) {
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    if (message.id !== undefined && this.pending.has(message.id)) {
      const { resolve, reject } = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
    }
  }

  sendFrame(text) {
    const payload = Buffer.from(text, 'utf8');
    const mask = Buffer.from([1, 2, 3, 4]);
    const length = payload.length;
    let header;
    if (length < 126) {
      header = Buffer.alloc(2);
      header[0] = 0x81;
      header[1] = 0x80 | length;
    } else if (length < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x81;
      header[1] = 0x80 | 126;
      header.writeUInt16BE(length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x81;
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(length), 2);
    }
    const masked = Buffer.alloc(length);
    for (let i = 0; i < length; i++) masked[i] = payload[i] ^ mask[i % 4];
    this.socket.write(Buffer.concat([header, mask, masked]));
  }

  send(method, params = {}, timeoutMs = 20000) {
    const id = this.nextId++;
    const message = JSON.stringify({ id, method, params });
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.sendFrame(message);
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`Таймаут вызова ${method}`));
        }
      }, timeoutMs);
    });
  }

  async evaluate(expression, timeoutMs = 20000) {
    const result = await this.send(
      'Runtime.evaluate',
      { expression, awaitPromise: true, returnByValue: true },
      timeoutMs,
    );
    if (result.exceptionDetails) {
      const text =
        result.exceptionDetails.exception?.description ??
        result.exceptionDetails.text ??
        'неизвестная ошибка';
      throw new Error(`Ошибка на странице: ${text}`);
    }
    return result.result.value;
  }
}

/** Подключение к отладочному WebSocket через сырой сокет с рукопожатием. */
async function connect(wsUrl) {
  const net = await import('node:net');
  const { randomBytes } = await import('node:crypto');
  const url = new URL(wsUrl);
  const socket = net.connect({ host: url.hostname, port: Number(url.port) });
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  const key = randomBytes(16).toString('base64');
  socket.write(
    `GET ${url.pathname} HTTP/1.1\r\n` +
      `Host: ${url.host}\r\n` +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Key: ${key}\r\n` +
      'Sec-WebSocket-Version: 13\r\n\r\n',
  );
  await new Promise((resolve, reject) => {
    let handshake = '';
    const onData = (chunk) => {
      handshake += chunk.toString('latin1');
      const index = handshake.indexOf('\r\n\r\n');
      if (index < 0) return;
      socket.removeListener('data', onData);
      if (!handshake.startsWith('HTTP/1.1 101')) {
        reject(new Error(`Рукопожатие WebSocket не удалось: ${handshake.split('\r\n')[0]}`));
        return;
      }
      const rest = Buffer.from(handshake.slice(index + 4), 'latin1');
      if (rest.length > 0) socket.unshift(rest);
      resolve();
    };
    socket.on('data', onData);
    socket.once('error', reject);
  });
  return new CdpClient(socket);
}

/* ============================================================
   Сценарий проверки
   ============================================================ */

const results = [];
function check(name, passed, detail = '') {
  results.push({ name, passed, detail });
  console.log(`[${passed ? '  OK  ' : ' FAIL '}] ${name}${detail ? ` — ${detail}` : ''}`);
}

async function main() {
  const browser = findBrowser();
  if (!existsSync(SHOT_DIR)) mkdirSync(SHOT_DIR, { recursive: true });

  console.log(`Браузер: ${browser}`);
  console.log(`Проверяем: ${URL_TARGET}\n`);

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
      `--user-data-dir=${resolve(SHOT_DIR, 'chrome-profile')}`,
      `--remote-debugging-port=${DEBUG_PORT}`,
      '--window-size=1600,900',
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

    // Даём приложению инициализировать WebGL и построить сцену.
    await delay(4000);

    /* --- 1. Приложение запустилось --- */
    const booted = await client.evaluate('Boolean(window.__physLab)');
    check('приложение выставило публичный API', booted === true);

    const canvasInfo = await client.evaluate(`
      (() => {
        const canvas = document.querySelector('.stage canvas');
        if (!canvas) return null;
        const rect = canvas.getBoundingClientRect();
        return { w: canvas.width, h: canvas.height, cssW: Math.round(rect.width), cssH: Math.round(rect.height) };
      })()
    `);
    check(
      'канвас создан и имеет ненулевой размер',
      canvasInfo && canvasInfo.w > 0 && canvasInfo.h > 0,
      canvasInfo ? `${canvasInfo.w}×${canvasInfo.h}` : 'канвас не найден',
    );
    // Дефект, который ловится только здесь: рендерер инициализируется в
    // одном размере, а показывается в другом — картинка сжата, клики мимо.
    check(
      'размер отрисовки совпадает с размером на экране',
      canvasInfo && Math.abs(canvasInfo.w - canvasInfo.cssW) <= 2 && Math.abs(canvasInfo.h - canvasInfo.cssH) <= 2,
      canvasInfo ? `экран ${canvasInfo.cssW}×${canvasInfo.cssH}, отрисовка ${canvasInfo.w}×${canvasInfo.h}` : '',
    );

    /* --- 2. Ошибок в консоли нет --- */
    const errors = await client.evaluate('(window.__smokeErrors || []).length');
    check('нет перехваченных ошибок', errors === 0, `ошибок: ${errors}`);
    if (errors > 0) {
      const text = await client.evaluate('JSON.stringify(window.__smokeErrors)');
      console.log(`        ${text}`);
    }

    /* --- 3. Частицы действительно рисуются --- */
    const drawn = await client.evaluate('window.__physLab.renderer.drawnCount');
    check('частицы попадают в кадр', drawn > 500, `нарисовано: ${drawn}`);

    /* --- 3b. Частицы разноцветные, а не белёсые --- */
    // Дефект, который ловится только здесь: при широком градиенте текстуры и
    // полупрозрачности дальних частиц десятки атомов, стоящих вдоль луча
    // зрения, складываются в белёсое пятно — цвет пропадает. Проверяем, что
    // в спрайтах действительно разные насыщенные цвета и почти полная
    // непрозрачность.
    const colors = await client.evaluate(`
      (() => {
        const app = window.__physLab;
        app.actions.applyPreset('melting');
        app.actions.runSteps(300);
        app.renderer.render(app.world);
        const sprites = app.renderer.sprites || [];
        const tints = new Set();
        let minAlpha = 1;
        // Насыщенность: разница между максимальным и минимальным каналом.
        let saturated = 0;
        let counted = 0;
        for (let i = 0; i < Math.min(300, sprites.length); i++) {
          const s = sprites[i];
          if (!s || s.alpha <= 0) continue;
          counted++;
          minAlpha = Math.min(minAlpha, s.alpha);
          const packed = s.tint;
          const r = (packed >> 16) & 0xff;
          const g = (packed >> 8) & 0xff;
          const b = packed & 0xff;
          tints.add(packed);
          if (Math.max(r, g, b) - Math.min(r, g, b) > 30) saturated++;
        }
        return { distinct: tints.size, minAlpha, saturated, counted };
      })()
    `);
    check(
      'частицы окрашены разнообразно и непрозрачны',
      colors.distinct >= 8 && colors.minAlpha > 0.75 && colors.saturated > colors.counted * 0.2,
      `различных цветов ${colors.distinct}, непрозрачность от ${colors.minAlpha.toFixed(2)}, ` +
        `насыщенных ${colors.saturated} из ${colors.counted}`,
    );

    /* --- 4. Симуляция продвигается --- */
    const advanced = await client.evaluate(`
      (() => {
        const app = window.__physLab;
        const before = app.metrics().steps;
        app.actions.runSteps(200);
        const after = app.metrics().steps;
        return { before, after };
      })()
    `);
    check(
      'симуляция делает шаги',
      advanced.after > advanced.before,
      `${advanced.before} → ${advanced.after}`,
    );

    /* --- 4b. Производительность на большом числе частиц --- */
    // Меряем ЧИСТОЕ время шага физики без отрисовки — так число не зависит
    // от того, насколько быстро рисует софтверный WebGL в песочнице.
    //
    // Порог 25 мс на 20 000 частиц выбран не «на глаз». Вместе с
    // автоподстройкой шагов на кадр это даёт около 40 кадров в секунду
    // симуляции: когда шаг дороже, приложение само уменьшает их число.
    // Историческая справка: до оптимизации (списки соседей + сетка для g(r))
    // шаг занимал 52 мс, а кадр статистики — 1900 мс вместо 37.
    const perf = await client.evaluate(`
      (async () => {
        const app = window.__physLab;
        const rows = [];
        for (const n of [2048, 8000, 20000]) {
          app.world.resize(n, 0.7, 'fcc');
          app.actions.runSteps(60);
          const t0 = performance.now();
          app.actions.runSteps(200);
          const stepMs = (performance.now() - t0) / 200;
          const t1 = performance.now();
          for (let i = 0; i < 10; i++) app.world.sampleRadial();
          const radialMs = (performance.now() - t1) / 10;
          rows.push({ n: app.metrics().count, stepMs, radialMs });
        }
        return rows;
      })()
    `, 300000);
    const perfText = perf
      .map((row) => `${row.n}: ${row.stepMs.toFixed(2)} мс/шаг, g(r) ${row.radialMs.toFixed(1)} мс`)
      .join(' | ');
    check(
      'шаг физики укладывается в бюджет на 20 000 частиц',
      perf.every((row) => row.stepMs < 25),
      perfText,
    );
    check(
      'кадр статистики g(r) дешевле 100 мс на 20 000 частиц',
      perf.every((row) => row.radialMs < 100),
      perfText,
    );
    check(
      'стоимость шага растёт линейно, а не квадратично',
      // Квадратичный рост дал бы на 20 000 частиц в 100 раз больше, чем на
      // 2000. Допускаем десятикратный рост: он соответствует O(N).
      perf[2].stepMs < perf[0].stepMs * 12,
      `2048 → ${perf[0].stepMs.toFixed(2)} мс, 20 000 → ${perf[2].stepMs.toFixed(2)} мс ` +
        `(рост ×${(perf[2].stepMs / perf[0].stepMs).toFixed(1)})`,
    );

    /* --- 4c. Список соседей экономит работу --- */
    // Меряем ЧАСТОТУ перестроений за окно, а не мгновенный «возраст»:
    // возраст равен нулю, если перестроение случилось ровно на последнем
    // шаге, и это ничего не говорит о среднем поведении.
    const verlet = await client.evaluate(`
      (async () => {
        const app = window.__physLab;
        app.world.resize(8000, 0.7, 'fcc');
        app.actions.setTemperature(1.0);
        app.actions.setThermostat('langevin');
        // Прогрев: список строится на первом шаге, и без прогрева счётчик
        // показал бы именно его, а не установившийся режим.
        app.actions.runSteps(200);
        const before = app.world.neighbourStats.rebuilds;
        const steps = 200;
        app.actions.runSteps(steps);
        const rebuilds = app.world.neighbourStats.rebuilds - before;
        const stats = app.world.neighbourStats;
        return {
          rebuilds,
          steps,
          every: rebuilds > 0 ? steps / rebuilds : Infinity,
          pairs: stats.pairs,
          count: app.metrics().count,
        };
      })()
    `, 180000);
    check(
      'список соседей живёт много шагов (кожа работает)',
      verlet.every > 3,
      `перестроение каждые ${verlet.every.toFixed(1)} шагов ` +
        `(${verlet.rebuilds} раз за ${verlet.steps}), пар ${verlet.pairs} на ${verlet.count} частиц`,
    );

    /* --- 5. Физика: знак силы --- */
    // Ключевой тест. Если знак силы перепутан, система «схлопывается»:
    // плотность растёт, энергия улетает. Проверяем, что за 400 шагов
    // без термостата энергия НЕ убежала и частицы не слиплись.
    const physics = await client.evaluate(`
      (async () => {
        const app = window.__physLab;
        app.actions.applyPreset('microcanonical');
        await new Promise(r => setTimeout(r, 200));
        const before = app.metrics();
        app.actions.runSteps(400);
        const after = app.metrics();
        // Минимальное расстояние между частицами: при перепутанном знаке
        // силы оно уходит к нулю.
        const w = app.world;
        let minR2 = Infinity;
        const box = w.box;
        const n = Math.min(w.state.count, 400);
        for (let i = 0; i < n; i++) {
          for (let j = i + 1; j < n; j++) {
            let dx = w.state.x[j] - w.state.x[i];
            let dy = w.state.y[j] - w.state.y[i];
            let dz = w.state.z[j] - w.state.z[i];
            dx -= box * Math.round(dx / box);
            dy -= box * Math.round(dy / box);
            dz -= box * Math.round(dz / box);
            minR2 = Math.min(minR2, dx * dx + dy * dy + dz * dz);
          }
        }
        return {
          t0: before.temperature, t1: after.temperature,
          minR: Math.sqrt(minR2),
          finite: Number.isFinite(after.temperature),
        };
      })()
    `, 60000);
    check(
      'энергия не «улетает» без термостата',
      physics.finite && physics.t1 < physics.t0 * 4 && physics.t1 > 0,
      `T* ${physics.t0.toFixed(3)} → ${physics.t1.toFixed(3)}`,
    );
    check(
      'частицы не слипаются (знак силы верен)',
      physics.minR > 0.7,
      `минимальное расстояние ${physics.minR.toFixed(3)}σ`,
    );

    /* --- 6. Термостаты держат температуру --- */
    const thermostats = await client.evaluate(`
      (async () => {
        const app = window.__physLab;
        const out = [];
        for (const kind of ['berendsen', 'langevin', 'nose-hoover']) {
          app.actions.setThermostat(kind);
          app.actions.setTemperature(1.2);
          app.actions.runSteps(1200);
          out.push({ kind, t: app.metrics().temperature });
        }
        return out;
      })()
    `, 120000);
    const thermostatOk = thermostats.every((entry) => Math.abs(entry.t - 1.2) < 0.35);
    check(
      'все три термостата удерживают заданную T*',
      thermostatOk,
      thermostats.map((e) => `${e.kind}=${e.t.toFixed(2)}`).join(', '),
    );

    /* --- 7. Графики рисуются --- */
    const plots = await client.evaluate(`
      (() => {
        const app = window.__physLab;
        const out = [];
        for (const [name, canvas] of [['T', app.plots.temperature()], ['E', app.plots.energy()], ['g(r)', app.plots.radial()]]) {
          const ctx = canvas.getContext('2d');
          const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
          // Считаем непрозрачные пиксели: если график пуст, их почти нет.
          let ink = 0;
          for (let i = 3; i < data.length; i += 4) if (data[i] > 0) ink++;
          out.push({ name, w: canvas.width, h: canvas.height, ink });
        }
        return out;
      })()
    `);
    const plotsOk = plots.every((p) => p.w > 0 && p.h > 0 && p.ink > 500);
    check(
      'все три графика нарисованы',
      plotsOk,
      plots.map((p) => `${p.name}: ${p.ink} px`).join(', '),
    );

    /* --- 8. g(r) показывает структуру --- */
    const radial = await client.evaluate(`
      (async () => {
        const app = window.__physLab;
        app.actions.applyPreset('crystal');
        for (let i = 0; i < 300; i++) {
          app.actions.runSteps(40);
          app.world.sampleRadial();
        }
        const { r, g } = app.world.radialDistribution();
        // Первый максимум должен быть заметно выше единицы: это порядок.
        let peak = 0, peakR = 0;
        for (let k = 0; k < r.length; k++) {
          if (r[k] < 0.9) continue;
          if (r[k] > 1.7) break;
          if (g[k] > peak) { peak = g[k]; peakR = r[k]; }
        }
        return { peak, peakR, samples: app.world.radial.sampleCount };
      })()
    `, 180000);
    check(
      'g(r) у кристалла имеет выраженный первый пик',
      radial.peak > 3,
      `пик ${radial.peak.toFixed(2)} при r = ${radial.peakR.toFixed(2)}σ, кадров ${radial.samples}`,
    );

    /* --- 9. Пресеты применяются --- */
    const presets = await client.evaluate(`
      (async () => {
        const app = window.__physLab;
        const ids = ['crystal', 'melting', 'liquid', 'gas', 'condensation', 'droplet', 'evaporation', 'diffusion', 'microcanonical'];
        const failed = [];
        const rows = [];
        for (const id of ids) {
          const ok = app.actions.applyPreset(id);
          await new Promise(r => setTimeout(r, 120));
          const m = app.metrics();
          rows.push(id + '=' + m.count + 'ρ' + m.density.toFixed(2));
          if (!ok || !Number.isFinite(m.temperature) || m.count < 16) failed.push(id);
        }
        return { failed, rows };
      })()
    `, 240000);
    check(
      'все пресеты применяются без ошибок',
      presets.failed.length === 0,
      presets.failed.length ? `сломаны: ${presets.failed.join(', ')}` : presets.rows.join(' '),
    );

    /* --- 10. Уровни выполняются --- */
    const levels = await client.evaluate(`
      (async () => {
        const app = window.__physLab;
        return app.levels();
      })()
    `);
    check('кампания содержит 10 уровней', levels.length === 10, `уровней: ${levels.length}`);

    const levelRun = await client.evaluate(`
      (async () => {
        const app = window.__physLab;
        const started = app.actions.startLevel('level-01');
        await new Promise(r => setTimeout(r, 300));
        const body = document.body.dataset.level;
        const session = app.getSession();
        return { started, body, hasSession: Boolean(session), level: session ? session.level.id : null };
      })()
    `, 60000);
    check(
      'уровень 1 запускается и создаёт сессию',
      levelRun.started && levelRun.hasSession && levelRun.level === 'level-01',
      `метка на странице: ${levelRun.body}`,
    );

    const levelCheck = await client.evaluate(`
      (async () => {
        const app = window.__physLab;
        app.actions.startLevel('level-01');
        await new Promise(r => setTimeout(r, 200));
        // Прогоняем достаточно шагов, чтобы пройти выход на режим и проверку.
        for (let i = 0; i < 40; i++) app.actions.runSteps(120);
        const report = app.actions.checkLevel();
        return {
          passed: report ? report.passed : false,
          results: report ? report.results.map(r => ({ label: r.check.label, passed: r.passed, detail: r.detail })) : [],
        };
      })()
    `, 240000);
    check(
      'уровень 1 «Кристалл» проходится',
      levelCheck.passed === true,
      levelCheck.passed
        ? `все ${levelCheck.results.length} условия выполнены`
        : levelCheck.results.filter((r) => !r.passed).map((r) => `${r.label}: ${r.detail}`).join('; '),
    );

    /* --- 11. Подсказки уровня видны в интерфейсе --- */
    const tasks = await client.evaluate(`
      (() => {
        const items = document.querySelectorAll('.level-card__tasks li');
        return { count: items.length, text: [...items].map(li => li.textContent).join(' | ') };
      })()
    `);
    check(
      'панель кампании показывает задачи уровня',
      tasks.count > 0,
      `${tasks.count} задач: ${tasks.text.slice(0, 120)}`,
    );

    /* --- 12. Интерфейс собран целиком --- */
    const ui = await client.evaluate(`
      (() => {
        const panels = [...document.querySelectorAll('.panel')].map(p => p.dataset.panel || '?');
        const presets = document.querySelectorAll('.preset').length;
        const ranges = document.querySelectorAll('.range').length;
        const toggles = document.querySelectorAll('.toggle__item').length;
        const buttons = document.querySelectorAll('.btn').length;
        return { panels, presets, ranges, toggles, buttons };
      })()
    `);
    check(
      'панели, пресеты и элементы управления собраны',
      ui.panels.length >= 5 && ui.presets >= 9 && ui.ranges >= 4 && ui.buttons >= 8,
      `панелей ${ui.panels.length}, пресетов ${ui.presets}, ползунков ${ui.ranges}, кнопок ${ui.buttons}`,
    );

    /* --- 12b. Панели не налезают друг на друга --- */
    // Дефект, ради которого эта проверка и написана: во flex-колонке панели
    // по умолчанию СЖИМАЮТСЯ, и вместо появления скролла они наезжают одна
    // на другую, обрезая подписи. Проверяем попарные пересечения
    // прямоугольников всех панелей боковой колонки.
    const overlap = await client.evaluate(`
      (() => {
        const sidebar = document.querySelector('.sidebar');
        // Раскрываем все панели: в свёрнутом виде пересечений и не будет.
        for (const panel of sidebar.querySelectorAll('.panel')) {
          panel.classList.remove('panel--collapsed');
        }
        const rects = [...sidebar.children].map((el) => {
          const r = el.getBoundingClientRect();
          return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
        });
        let worst = 0;
        let pair = '';
        for (let i = 0; i < rects.length; i++) {
          for (let j = i + 1; j < rects.length; j++) {
            const a = rects[i], b = rects[j];
            const v = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
            const h = Math.min(a.right, b.right) - Math.max(a.left, b.left);
            if (v > 1 && h > 1 && v > worst) {
              worst = v;
              pair = i + '/' + j;
            }
          }
        }
        return {
          worst,
          pair,
          scrollHeight: sidebar.scrollHeight,
          clientHeight: sidebar.clientHeight,
          children: sidebar.children.length,
        };
      })()
    `);
    check(
      'панели боковой колонки не перекрываются',
      overlap.worst < 2,
      `максимальное перекрытие ${overlap.worst.toFixed(1)} px` +
        (overlap.pair ? ` (панели ${overlap.pair})` : '') +
        `, содержимое ${overlap.scrollHeight} при высоте ${overlap.clientHeight}`,
    );

    /* --- 12c. Текст подписей не обрезан --- */
    // Кнопки с `white-space: nowrap` при нехватке места режут подписи:
    // «Нозе-Хувер» превращался в «Нозе-Хуве». scrollWidth > clientWidth —
    // точный признак обрезки.
    const clipped = await client.evaluate(`
      (() => {
        const bad = [];
        for (const el of document.querySelectorAll('.toggle__item, .panel__head b')) {
          if (el.scrollWidth > el.clientWidth + 1 && el.clientWidth > 0) {
            bad.push((el.textContent || '').trim() + ' (' + el.scrollWidth + '>' + el.clientWidth + ')');
          }
        }
        return bad;
      })()
    `);
    check(
      'подписи переключателей не обрезаны',
      clipped.length === 0,
      clipped.length ? clipped.slice(0, 4).join(', ') : 'все подписи помещаются',
    );

    /* --- 13. Ввод: толчок мышью меняет состояние --- */
    const poke = await client.evaluate(`
      (async () => {
        const app = window.__physLab;
        app.actions.applyPreset('liquid');
        await new Promise(r => setTimeout(r, 200));
        const canvas = document.querySelector('.stage canvas');
        const rect = canvas.getBoundingClientRect();
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        // Считаем частицы, получившие импульс: сравниваем скорости до и после.
        const before = Array.from(app.world.state.vx.slice(0, 200));
        const fire = (type, x, y, buttons) => canvas.dispatchEvent(new PointerEvent(type, {
          clientX: x, clientY: y, buttons, button: 0, bubbles: true, pointerId: 1,
        }));
        fire('pointerdown', cx, cy, 1);
        for (let i = 1; i <= 10; i++) fire('pointermove', cx + i * 8, cy + i * 4, 1);
        fire('pointerup', cx + 80, cy + 40, 0);
        app.actions.runSteps(2);
        const after = Array.from(app.world.state.vx.slice(0, 200));
        let changed = 0;
        for (let i = 0; i < before.length; i++) if (Math.abs(after[i] - before[i]) > 1e-6) changed++;
        return changed;
      })()
    `, 60000);
    check('протяжка мышью толкает частицы', poke > 0, `изменилось скоростей: ${poke}`);

    /* --- 14. Камера: масштаб и поворот --- */
    const camera = await client.evaluate(`
      (async () => {
        const app = window.__physLab;
        const cam = app.camera;
        const canvas = document.querySelector('.stage canvas');
        const rect = canvas.getBoundingClientRect();
        const before = { scale: cam.scale, yaw: cam.yaw };
        canvas.dispatchEvent(new WheelEvent('wheel', {
          clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2,
          deltaY: -240, bubbles: true, cancelable: true,
        }));
        const afterZoom = cam.scale;
        // Правая кнопка — поворот.
        const fire = (type, x, y, button, buttons) => canvas.dispatchEvent(new PointerEvent(type, {
          clientX: x, clientY: y, button, buttons, bubbles: true, pointerId: 2,
        }));
        const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
        fire('pointerdown', cx, cy, 2, 2);
        fire('pointermove', cx + 60, cy, 2, 2);
        fire('pointerup', cx + 60, cy, 2, 0);
        return { scaleChanged: afterZoom !== before.scale, yawChanged: cam.yaw !== before.yaw };
      })()
    `);
    check('колесо меняет масштаб', camera.scaleChanged === true);
    check('правая кнопка поворачивает сцену', camera.yawChanged === true);

    /* --- 15. Заморозка частиц --- */
    const frozen = await client.evaluate(`
      (async () => {
        const app = window.__physLab;
        app.actions.applyPreset('liquid');
        await new Promise(r => setTimeout(r, 200));
        const w = app.world;
        const before = w.frozen.reduce((a, b) => a + b, 0);
        w.freezeRegion(w.box / 2, w.box / 2, w.box / 2, 4);
        const after = w.frozen.reduce((a, b) => a + b, 0);
        w.unfreezeAll();
        const cleared = w.frozen.reduce((a, b) => a + b, 0);
        return { added: after - before, cleared };
      })()
    `, 60000);
    check(
      'заморозка выделяет частицы и снимается',
      frozen.added > 0 && frozen.cleared === 0,
      `заморожено ${frozen.added}, после разморозки ${frozen.cleared}`,
    );

    /* --- 16. Плотность и сжатие --- */
    const density = await client.evaluate(`
      (async () => {
        const app = window.__physLab;
        app.actions.applyPreset('liquid');
        await new Promise(r => setTimeout(r, 200));
        const before = app.metrics();
        const btn = [...document.querySelectorAll('.btn')].find(b => b.textContent === 'Сжать');
        if (!btn) return { error: 'нет кнопки «Сжать»' };
        btn.click();
        await new Promise(r => setTimeout(r, 200));
        const after = app.metrics();
        // Проверяем согласованность: заявленная плотность обязана совпасть
        // с фактической N/V. Именно здесь раньше расходились решётка и ящик.
        const actual = after.count / (after.box ** 3);
        return {
          densityBefore: before.density,
          densityAfter: after.density,
          actual,
          consistent: Math.abs(actual - after.density) < 1e-6,
        };
      })()
    `, 60000);
    check(
      'кнопка «Сжать» увеличивает плотность',
      !density.error && density.densityAfter > density.densityBefore,
      density.error ?? `ρ* ${density.densityBefore.toFixed(3)} → ${density.densityAfter.toFixed(3)}`,
    );
    check(
      'заявленная плотность совпадает с N/V',
      density.consistent === true,
      density.error ?? `фактическая ${density.actual.toFixed(4)}`,
    );

    /* --- 17. Справка открывается и закрывается --- */
    const help = await client.evaluate(`
      (async () => {
        window.__physLab.actions.openHelp();
        await new Promise(r => setTimeout(r, 300));
        const modal = document.querySelector('.modal');
        if (!modal) return 'окно не открылось';
        const headings = modal.querySelectorAll('h2, h3').length;
        const tables = modal.querySelectorAll('table').length;
        const closeButtons = [...modal.querySelectorAll('.modal__foot button')]
          .filter(b => b.textContent.trim() === 'Закрыть' || b.textContent.trim() === 'Понятно');
        if (closeButtons.length !== 1) return 'кнопок закрытия: ' + closeButtons.length;
        closeButtons[0].click();
        await new Promise(r => setTimeout(r, 300));
        if (document.querySelector('.modal')) return 'окно не закрылось';
        return 'ok:' + headings + ':' + tables;
      })()
    `, 40000);
    check(
      'справка открывается, содержит разделы и закрывается',
      typeof help === 'string' && help.startsWith('ok:'),
      String(help),
    );

    /* --- 18. Пауза и шаг --- */
    const pause = await client.evaluate(`
      (async () => {
        const app = window.__physLab;
        app.actions.toggleRun();
        await new Promise(r => setTimeout(r, 400));
        const a = app.metrics().steps;
        await new Promise(r => setTimeout(r, 400));
        const b = app.metrics().steps;
        app.actions.toggleRun();
        app.actions.stepOnce();
        const c = app.metrics().steps;
        const btn = document.querySelector('[data-action="run"]').textContent;
        return { pausedDelta: b - a, stepDelta: c - b, button: btn };
      })()
    `, 40000);
    check(
      'пауза останавливает симуляцию, «Шаг» делает один шаг',
      pause.pausedDelta === 0 && pause.stepDelta === 1,
      `за паузу ${pause.pausedDelta} шагов, шаг кнопкой ${pause.stepDelta}`,
    );

    /* --- 19. Число частиц меняется --- */
    const resize = await client.evaluate(`
      (async () => {
        const app = window.__physLab;
        app.actions.setDensity(0.7);
        // ГЦК-решётка округляет число частиц до 4n³: 4000 — это 4·10³,
        // ближайшее представимое значение к 3456. Проверяем именно то,
        // что система пересобралась и плотность осталась точной.
        app.world.resize(3456, 0.7, 'fcc');
        await new Promise(r => setTimeout(r, 300));
        app.renderer.render(app.world);
        await new Promise(r => setTimeout(r, 200));
        const m = app.metrics();
        const sprites = app.renderer.spriteCount;
        const actualDensity = m.count / (m.box ** 3);
        return {
          count: m.count,
          sprites,
          box: m.box,
          actualDensity,
          stated: m.density,
          // Сколько частиц было до пересборки: должно измениться заметно.
          cells: Math.round(Math.cbrt(m.count / 4)),
        };
      })()
    `, 60000);
    check(
      'изменение числа частиц пересобирает систему',
      resize.count > 3000 &&
        resize.count === 4 * resize.cells ** 3 &&
        resize.sprites >= resize.count &&
        Math.abs(resize.actualDensity - resize.stated) < 1e-6,
      `частиц ${resize.count} = 4·${resize.cells}³, спрайтов ${resize.sprites}, ` +
        `ρ* ${resize.actualDensity.toFixed(4)}`,
    );

    /* --- 20. Скриншот витрины --- */
    const shot = await client.send('Page.captureScreenshot', { format: 'png' });
    const { writeFileSync } = await import('node:fs');
    writeFileSync(resolve(SHOT_DIR, 'smoke.png'), Buffer.from(shot.data, 'base64'));
    check('скриншот снят', true, `${SHOT_DIR}/smoke.png`);
  } finally {
    if (client) client.socket?.destroy?.();
    child.kill();
  }

  const failed = results.filter((r) => !r.passed);
  console.log(`\nИтог: ${results.length - failed.length}/${results.length} проверок пройдено`);
  if (failed.length > 0) {
    console.log('Провалены:');
    for (const item of failed) console.log(`  - ${item.name}: ${item.detail}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
