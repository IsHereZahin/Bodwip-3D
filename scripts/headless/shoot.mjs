// Headless stills of the river for visual checks. Dev tooling only; never part of the build.
// Start the dev server first (`npm run dev`), then:
//   node scripts/headless/shoot.mjs <outDir> [--base http://127.0.0.1:5173/] [--swiftshader] [--shots '<json>']
// Each shot is { name, journey?, hour?, moon?, yaw?, pitch?, dist?, face?: 'sun' | 'moon', free?: [x, y, z, yaw, pitch],
// film?: [shotIndex, u] } and becomes <outDir>/<name>.png. See window.__river.shot in src/main.ts.
// Env: W / H set the viewport (default 1280×720); HUD=1 keeps the page UI in the frame.
// Prints draw calls, triangles and frame time per shot, then every console message from the page.
// cdp.mjs is a copy of the main repo's scripts/headless/cdp.mjs.
import fs from 'node:fs';
import path from 'node:path';
import { launchChrome, Page } from './cdp.mjs';

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
};
const OUT = path.resolve(argv[0] && !argv[0].startsWith('--') ? argv[0] : 'shots');
const BASE = arg('base', 'http://127.0.0.1:5173/');
const SWIFT = argv.includes('--swiftshader');
const SHOTS = JSON.parse(arg('shots', '[{"name":"golden","journey":0.05,"hour":17.5}]'));
const W = Number(process.env.W ?? 1280);
const H = Number(process.env.H ?? 720);
fs.mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const { proc, port } = await launchChrome({ port: 9341, swiftshader: SWIFT, width: W, height: H });
let page;
try {
  page = await Page.open(port);
  await page.send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: W < 700 });
  const t0 = Date.now();
  await page.navigate(new URL('?debug', BASE).href);
  await page.waitFor('window.__river && window.__river.ready', { timeoutMs: 300000, label: '__river.ready' });
  console.log('ready in', Date.now() - t0, 'ms');
  if (!process.env.HUD) {
    await page.eval(
      `(() => { const s = document.createElement('style'); s.textContent = '#title,#hint,#dock,#toast,#ui-restore{display:none!important}'; document.head.appendChild(s); })()`,
    );
  }
  // let the loader fade and the adaptive resolution settle before the first still
  await sleep(4000);
  console.log('running', await page.eval('JSON.stringify(window.__river.info())'));
  for (const s of SHOTS) {
    await page.eval(`window.__river.shot(${JSON.stringify(s)})`);
    await page.eval('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(r))))');
    await sleep(300);
    const info = await page.eval('JSON.stringify(window.__river.info())');
    const shot = await page.send('Page.captureScreenshot', { format: 'png' });
    const file = path.join(OUT, `${s.name}.png`);
    fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
    console.log('saved', file, info);
  }
} catch (err) {
  console.error('FAILED', err.message);
  process.exitCode = 1;
} finally {
  if (page) {
    const msgs = page.console.filter((m) => m.level !== 'debug');
    console.log(`--- console (${msgs.length}) ---`);
    for (const m of msgs.slice(0, 40)) console.log(`[${m.level}] ${m.text.slice(0, 600)}`);
    page.close();
  }
  proc.kill();
}
