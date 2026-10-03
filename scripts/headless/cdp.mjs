// Minimal Chrome DevTools Protocol driver for the headless checks (Node ≥ 22: global WebSocket and
// fetch, so no dependency). Dev tooling only; never part of the build.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Headless Chrome with remote debugging. The real GPU is used unless `swiftshader` (software WebGL). */
export async function launchChrome({ port = 9333, swiftshader = false, width = 1280, height = 800 }) {
  const profile = path.join(os.tmpdir(), `headless-chrome-${port}`);
  fs.mkdirSync(profile, { recursive: true });
  const args = [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--mute-audio',
    '--autoplay-policy=no-user-gesture-required',
    `--window-size=${width},${height}`,
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    '--ignore-gpu-blocklist',
  ];
  if (swiftshader) args.push('--use-angle=swiftshader', '--enable-unsafe-swiftshader');
  const proc = spawn(CHROME, args, { stdio: 'ignore' });
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return { proc, port };
    } catch {}
    await sleep(100);
  }
  proc.kill();
  throw new Error('chrome did not start');
}

export class Page {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.console = [];
    this.listeners = new Set();
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(typeof event.data === 'string' ? event.data : event.data.toString());
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message}`));
        else p.resolve(msg.result);
        return;
      }
      if (msg.method === 'Runtime.consoleAPICalled') {
        const text = msg.params.args.map((a) => a.value ?? a.description ?? a.type).join(' ');
        this.console.push({ level: msg.params.type, text });
      } else if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails;
        this.console.push({ level: 'exception', text: d.exception?.description ?? d.text });
      } else if (msg.method === 'Log.entryAdded') {
        const e = msg.params.entry;
        this.console.push({ level: `log-${e.level}`, text: `${e.text} ${e.url ?? ''}` });
      }
      for (const l of this.listeners) l(msg);
    });
  }

  static async open(port) {
    const res = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' });
    const target = await res.json();
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', reject, { once: true });
    });
    const page = new Page(ws);
    await page.send('Runtime.enable');
    await page.send('Log.enable');
    await page.send('Page.enable');
    return page;
  }

  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject, method }));
  }

  async eval(expression, { awaitPromise = true, timeout = 600000 } = {}) {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true, timeout });
    if (result.exceptionDetails) {
      throw new Error(`eval failed: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}\n${expression.slice(0, 200)}`);
    }
    return result.result.value;
  }

  async waitFor(expression, { timeoutMs = 240000, pollMs = 500, label = expression } = {}) {
    const start = Date.now();
    for (;;) {
      let ok = false;
      try {
        ok = await this.eval(`(() => { try { return !!(${expression}); } catch { return false; } })()`);
      } catch {}
      if (ok) return Date.now() - start;
      if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${label}`);
      await sleep(pollMs);
    }
  }

  async navigate(url) {
    const loaded = new Promise((resolve) => {
      const l = (msg) => {
        if (msg.method === 'Page.loadEventFired') {
          this.listeners.delete(l);
          resolve();
        }
      };
      this.listeners.add(l);
    });
    await this.send('Page.navigate', { url });
    await loaded;
  }

  close() {
    this.ws.close();
  }
}

export function savePngDataUrl(dataUrl, file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64'));
}

/**
 * Virtual clock injected before any page script: performance.now / Date.now advance exactly 1/60 s
 * per animation frame, Math.random is seeded, and frames can be paused and stepped from CDP.
 */
export function virtualClockScript({ paused }) {
  return `(() => {
  const FRAME = 1000 / 60;
  let vt = 1000;
  const dateBase = 1767225600000;
  performance.now = () => vt;
  Date.now = () => dateBase + Math.floor(vt);
  let s = 12345 >>> 0;
  Math.random = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const nativeRaf = window.requestAnimationFrame.bind(window);
  let queue = new Map();
  let nextId = 1;
  let paused = ${paused ? 'true' : 'false'};
  let frames = 0;
  window.requestAnimationFrame = (cb) => { const id = nextId++; queue.set(id, cb); return id; };
  window.cancelAnimationFrame = (id) => { queue.delete(id); };
  const runFrame = () => {
    vt += FRAME;
    frames++;
    const q = queue;
    queue = new Map();
    for (const cb of q.values()) { try { cb(vt); } catch (e) { console.error('[vclock]', e); } }
  };
  const pump = () => { if (!paused) runFrame(); nativeRaf(pump); };
  nativeRaf(pump);
  window.__vclock = {
    pause() { paused = true; },
    resume() { paused = false; },
    step(n) { for (let i = 0; i < n; i++) runFrame(); },
    get frames() { return frames; },
  };
})();`;
}
