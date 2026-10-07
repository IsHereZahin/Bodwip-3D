// The site's icons drawn from its logo (public/brand/logo.svg, favicon.svg) in headless Chrome: the PNG favicon,
// the Apple touch icon and the app icons the manifest names. Run after changing the logo:
//   node scripts/brand/icons.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChrome, Page } from '../headless/cdp.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const BRAND = path.join(ROOT, 'public/brand');
// (inlined: a page from a data: URL may not load file: URLs)
const url = (name) => `data:image/svg+xml;base64,${fs.readFileSync(path.join(BRAND, name)).toString('base64')}`;
/** The night the icons stand on (the loader's and the page's own). */
const GROUND = '#0d0c0b';

/** Each icon: its file, its size (px), the drawing, how much of the square it fills, and its ground (none: clear). */
const ICONS = [
  { file: 'favicon-32.png', size: 32, src: 'favicon.svg', fill: 1, ground: null },
  { file: 'apple-touch-icon.png', size: 180, src: 'logo.svg', fill: 0.84, ground: GROUND },
  { file: 'icon-192.png', size: 192, src: 'logo.svg', fill: 0.84, ground: GROUND },
  { file: 'icon-512.png', size: 512, src: 'logo.svg', fill: 0.84, ground: GROUND },
  // (a maskable icon keeps what matters within the middle 80%: the launcher cuts it to its own shape)
  { file: 'icon-maskable-512.png', size: 512, src: 'logo.svg', fill: 0.66, ground: GROUND },
];

const { proc, port } = await launchChrome({ port: 9349, swiftshader: false, width: 512, height: 512 });
let page;
try {
  page = await Page.open(port);
  await page.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
  for (const icon of ICONS) {
    await page.send('Emulation.setDeviceMetricsOverride', { width: icon.size, height: icon.size, deviceScaleFactor: 1, mobile: false });
    const side = Math.round(icon.size * icon.fill);
    const html = `<!doctype html><body style="margin:0;width:${icon.size}px;height:${icon.size}px;display:grid;place-items:center;background:${icon.ground ?? 'transparent'}"><img src="${url(icon.src)}" width="${side}" height="${side}"></body>`;
    await page.navigate(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    await new Promise((r) => setTimeout(r, 400));
    const shot = await page.send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: icon.size, height: icon.size, scale: 1 } });
    fs.writeFileSync(path.join(BRAND, icon.file), Buffer.from(shot.data, 'base64'));
    console.log('wrote', icon.file);
  }
} finally {
  page?.close();
  proc.kill();
}
