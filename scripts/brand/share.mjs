// The card a shared link to the site shows (Open Graph, Twitter; vite.config.ts names it): the loader's still of this
// world (public/brand/loader.webp, the bil at sunset) with the mark and the name over it, drawn in headless Chrome
// at 1200×630 in the site's own face. Run after changing the logo or the loader's still:
//   node scripts/brand/share.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChrome, Page } from '../headless/cdp.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const BRAND = path.join(ROOT, 'public/brand');
const W = 1200;
const H = 630;
// (inlined: a page from a data: URL may not load file: URLs)
const inline = (name, type) => `data:${type};base64,${fs.readFileSync(path.join(BRAND, name)).toString('base64')}`;

const html = `<!doctype html>
<html lang="bn"><head><meta charset="utf-8">
<link href="https://fonts.googleapis.com/css2?family=Noto+Serif+Bengali:wght@300;700&display=block" rel="stylesheet">
<style>
  html, body { margin: 0; width: ${W}px; height: ${H}px; overflow: hidden; background: #0d0c0b; }
  .still { position: absolute; inset: 0; background: url('${inline('loader.webp', 'image/webp')}') center / cover; filter: saturate(1.05); }
  /* darker toward the left and the foot, where the words stand */
  .veil { position: absolute; inset: 0; background: linear-gradient(90deg, rgba(13, 12, 11, 0.82) 0%, rgba(13, 12, 11, 0.5) 52%, rgba(13, 12, 11, 0.12) 100%), linear-gradient(0deg, rgba(13, 12, 11, 0.55), rgba(13, 12, 11, 0) 45%); }
  .card { position: absolute; left: 84px; top: 50%; transform: translateY(-50%); display: flex; align-items: center; gap: 40px; font-family: 'Noto Serif Bengali', serif; color: #f4ecdc; }
  .card img { width: 190px; height: 190px; filter: drop-shadow(0 6px 24px rgba(0, 0, 0, 0.45)); }
  h1 { margin: 0; font-size: 104px; font-weight: 700; line-height: 1.05; letter-spacing: 0.02em; text-shadow: 0 2px 28px rgba(0, 0, 0, 0.5); }
  p { margin: 14px 0 0; font-size: 30px; font-weight: 300; letter-spacing: 0.02em; color: rgba(244, 236, 220, 0.88); text-shadow: 0 1px 16px rgba(0, 0, 0, 0.6); }
  p.en { margin-top: 8px; font-size: 24px; color: rgba(244, 236, 220, 0.7); }
</style></head>
<body><div class="still"></div><div class="veil"></div>
<div class="card"><img src="${inline('logo.svg', 'image/svg+xml')}" alt="">
<div><h1>বদ্বীপ 3D</h1><p>বাংলার গ্রাম, নদী আর ছয় ঋতু</p><p class="en">Bodwip 3D · a Bangla 3D village in the browser</p></div></div>
</body></html>`;

const { proc, port } = await launchChrome({ port: 9348, swiftshader: false, width: W, height: H });
let page;
try {
  page = await Page.open(port);
  await page.send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  await page.navigate(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  // the words drawn only once their face has come
  await page.eval(`document.fonts.load('700 104px "Noto Serif Bengali"', 'বদ্বীপ').then(() => document.fonts.ready)`);
  await new Promise((r) => setTimeout(r, 300));
  const shot = await page.send('Page.captureScreenshot', { format: 'jpeg', quality: 86, clip: { x: 0, y: 0, width: W, height: H, scale: 1 } });
  fs.writeFileSync(path.join(BRAND, 'share.jpg'), Buffer.from(shot.data, 'base64'));
  console.log('wrote share.jpg');
} finally {
  page?.close();
  proc.kill();
}
