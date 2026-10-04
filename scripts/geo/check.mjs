// Checks the baked map (public/geo/) against independent references, in numbers and in pictures
// (GEOGRAPHY_PLAN.md §11). P1 checks: the shoreline against OSM's coastline, the landmarks against the
// ground they must stand on, and overlays of OSM's lines on the baked relief and on Sentinel-2.
//
//   node scripts/geo/check.mjs        prints the results; pictures go to scripts/geo/cache/view/
import { readdirSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { inflateRawSync, inflateSync } from 'node:zlib';
import proj4 from 'proj4';
import { MAP_SCALE, fromGround, toGround } from '../../src/geo/project.ts';
import { CACHE } from './config.mjs';
import { encodePng } from './lib/png.mjs';
import { PLACES } from './places.mjs';

proj4.defs('EPSG:32646', '+proj=utm +zone=46 +datum=WGS84 +units=m +no_defs');
const at = (name) => fileURLToPath(new URL(name, CACHE));
const GEO = fileURLToPath(new URL('../../public/geo/', import.meta.url));
const VIEW = at('view/');

const manifest = JSON.parse(await readFile(`${GEO}manifest.json`, 'utf8'));
const g = manifest.grid;
const { width: W, height: H, spacing: S } = g;
const layer = async (name, Type) => {
  const raw = inflateRawSync(await readFile(`${GEO}${manifest.layers[name].file}`));
  return new Type(raw.buffer, raw.byteOffset, raw.byteLength / Type.BYTES_PER_ELEMENT);
};
const terrain = await layer('terrain', Int16Array);
const kind = await layer('kind', Uint8Array);
const KIND = manifest.layers.kind.codes;
const cellOf = (east, north) => {
  const c = Math.floor((east - g.east0) / S);
  const r = Math.floor((g.north1 - north) / S);
  return c < 0 || r < 0 || c >= W || r >= H ? -1 : r * W + c;
};
const percentile = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)))];

// ---------- 1. the shoreline against OSM's coastline ----------

/**
 * OSM draws the coastline at mean high water; the baked counterpart is the +1.4 m contour (MHW, between
 * BIWTA's MHWN 0.97 and MHWS 1.79 above MSL). For each point every 30 m along OSM's coastline: the distance
 * to the nearest cell on the other side of that contour.
 */
async function shoreline() {
  const MHW = 14; // decimetres
  const above = (i) => terrain[i] > MHW;
  const { elements } = JSON.parse(await readFile(at('osm-coast.json'), 'utf8'));
  const dists = [];
  const worst = [];
  for (const e of elements) {
    if (e.tags?.natural !== 'coastline' || !e.geometry) continue;
    for (let k = 1; k < e.geometry.length; k++) {
      const a = toGround(e.geometry[k - 1].lat, e.geometry[k - 1].lon);
      const b = toGround(e.geometry[k].lat, e.geometry[k].lon);
      const steps = Math.max(1, Math.ceil(Math.hypot(b.east - a.east, b.north - a.north) / S));
      for (let s = 0; s < steps; s++) {
        const east = a.east + ((b.east - a.east) * s) / steps;
        const north = a.north + ((b.north - a.north) * s) / steps;
        const i = cellOf(east, north);
        if (i < 0) continue;
        // search outward in rings for a cell whose side of the contour differs from a neighbour's
        let found = Infinity;
        const c0 = i % W;
        const r0 = Math.floor(i / W);
        for (let rad = 0; rad <= 40 && found === Infinity; rad++)
          for (let dr = -rad; dr <= rad; dr++)
            for (let dc = -rad; dc <= rad; dc++) {
              if (Math.max(Math.abs(dr), Math.abs(dc)) !== rad) continue;
              const r = r0 + dr;
              const c = c0 + dc;
              if (r < 0 || c < 0 || r >= H - 1 || c >= W - 1) continue;
              const j = r * W + c;
              if (above(j) !== above(j + 1) || above(j) !== above(j + W)) found = Math.min(found, Math.hypot(dr, dc) * S);
            }
        dists.push(found);
        if (found > 300) worst.push({ ...fromGround(east, north), m: found === Infinity ? '>1200' : Math.round(found) });
      }
    }
  }
  dists.sort((a, b) => a - b);
  return {
    points: dists.length,
    medianM: Math.round(percentile(dists, 0.5)),
    p75M: Math.round(percentile(dists, 0.75)),
    p90M: Math.round(percentile(dists, 0.9)),
    within30m: +(dists.filter((d) => d <= 30).length / dists.length).toFixed(2),
    within90m: +(dists.filter((d) => d <= 90).length / dists.length).toFixed(2),
    worstSamples: worst.filter((_, k) => k % Math.max(1, Math.floor(worst.length / 8)) === 0).slice(0, 8).map((w) => ({ lat: +w.lat.toFixed(4), lon: +w.lon.toFixed(4), m: w.m })),
  };
}

// ---------- 2. the landmarks ----------

function landmarks() {
  const names = Object.fromEntries(Object.entries(KIND).map(([k, v]) => [v, k]));
  const ok = { land: ['land'], water: ['sea', 'inland'], wet: ['tidal', 'mangrove', 'sea', 'inland'], any: Object.keys(KIND) };
  return PLACES.map((p) => {
    const q = toGround(p.lat, p.lon);
    const i = cellOf(q.east, q.north);
    const k = i < 0 ? 'outside' : names[kind[i] & 0x7f];
    return { id: p.id, expect: p.expect, got: k, ground: i < 0 ? null : terrain[i] / 10, pass: ok[p.expect].includes(k) };
  });
}

// ---------- 3. pictures: OSM's lines over the relief and over the satellite ----------

async function sentinelOnGrid() {
  const name = readdirSync(fileURLToPath(CACHE)).filter((f) => /^sentinel-.*\.png$/.test(f)).sort().pop();
  const meta = JSON.parse(await readFile(at(name.replace('.png', '.json')), 'utf8'));
  const png = await readFile(at(name));
  const idat = [];
  for (let p = 8; p < png.length; ) {
    const len = png.readUInt32BE(p);
    if (png.toString('latin1', p + 4, p + 8) === 'IDAT') idat.push(png.subarray(p + 8, p + 8 + len));
    p += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = meta.width * 3 + 1;
  const rgb = new Uint8Array(W * H * 3);
  for (let r = 0; r < H; r++)
    for (let c = 0; c < W; c++) {
      const { lat, lon } = fromGround(g.east0 + (c + 0.5) * S, g.north1 - (r + 0.5) * S);
      const [e, n] = proj4('EPSG:4326', 'EPSG:32646', [lon, lat]);
      const sc = Math.floor((e - meta.bbox[0]) / meta.res);
      const sr = Math.floor((meta.bbox[3] - n) / meta.res);
      if (sc < 0 || sr < 0 || sc >= meta.width || sr >= meta.height) continue;
      for (let k = 0; k < 3; k++) rgb[(r * W + c) * 3 + k] = Math.min(255, raw[sr * stride + 1 + sc * 3 + k] * 1.6);
    }
  return rgb;
}

const COLOURS = { road: [255, 255, 255], rail: [255, 120, 0], waterway: [60, 230, 255], structure: [255, 40, 40], power: [255, 230, 0] };

function drawLines(rgb, vectors) {
  const plot = (east, north, col) => {
    const i = cellOf(east, north);
    if (i >= 0) rgb.set(col, i * 3);
  };
  for (const l of vectors.lines) {
    if (l.k === 'road' && /^(footway|path|steps|service|track)$/.test(l.t)) continue;
    const col = COLOURS[l.k];
    for (let k = 2; k < l.p.length; k += 2) {
      const e0 = l.p[k - 2] / 10;
      const n0 = l.p[k - 1] / 10;
      const e1 = l.p[k] / 10;
      const n1 = l.p[k + 1] / 10;
      const steps = Math.max(1, Math.ceil(Math.hypot(e1 - e0, n1 - n0) / (S / 2)));
      for (let s = 0; s <= steps; s++) plot(e0 + ((e1 - e0) * s) / steps, n0 + ((n1 - n0) * s) / steps, col);
    }
  }
  for (const p of PLACES) {
    const q = toGround(p.lat, p.lon);
    for (let d = -3; d <= 3; d++) {
      plot(q.east + d * S, q.north, [255, 0, 255]);
      plot(q.east, q.north + d * S, [255, 0, 255]);
    }
  }
}

async function terrainImage() {
  const png = await readFile(`${VIEW}terrain.png`);
  const idat = [];
  for (let p = 8; p < png.length; ) {
    const len = png.readUInt32BE(p);
    if (png.toString('latin1', p + 4, p + 8) === 'IDAT') idat.push(png.subarray(p + 8, p + 8 + len));
    p += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const rgb = new Uint8Array(W * H * 3);
  for (let r = 0; r < H; r++) raw.copy(rgb, r * W * 3, r * (W * 3 + 1) + 1, (r + 1) * (W * 3 + 1));
  return rgb;
}

/** A square crop round a real place, `size` ground metres across, enlarged. */
function crop(rgb, lat, lon, size, zoom) {
  const q = toGround(lat, lon);
  const half = Math.round(size / S / 2);
  const c0 = Math.floor((q.east - g.east0) / S) - half;
  const r0 = Math.floor((g.north1 - q.north) / S) - half;
  const n = half * 2;
  const out = new Uint8Array(n * zoom * n * zoom * 3);
  for (let y = 0; y < n * zoom; y++)
    for (let x = 0; x < n * zoom; x++) {
      const r = r0 + Math.floor(y / zoom);
      const c = c0 + Math.floor(x / zoom);
      if (r < 0 || c < 0 || r >= H || c >= W) continue;
      out.set(rgb.subarray((r * W + c) * 3, (r * W + c) * 3 + 3), (y * n * zoom + x) * 3);
    }
  return encodePng(out, n * zoom, n * zoom, 3);
}

const vectors = JSON.parse(inflateRawSync(await readFile(`${GEO}vectors.bin`)).toString());
const shore = await shoreline();
const marks = landmarks();
const satellite = await sentinelOnGrid();
const relief = await terrainImage();
drawLines(satellite, vectors);
drawLines(relief, vectors);
await writeFile(`${VIEW}overlay-satellite.png`, encodePng(satellite, W, H, 3));
await writeFile(`${VIEW}overlay-terrain.png`, encodePng(relief, W, H, 3));
for (const [name, lat, lon, size, zoom] of [
  ['gorakghata', 21.522, 91.972, 4000, 4],
  ['matarbari', 21.7, 91.875, 6000, 3],
  ['sonadia', 21.487, 91.88, 7000, 2],
]) {
  await writeFile(`${VIEW}${name}-satellite.png`, crop(satellite, lat, lon, size, zoom));
  await writeFile(`${VIEW}${name}-terrain.png`, crop(relief, lat, lon, size, zoom));
}
console.log(JSON.stringify({ worldKm: [+((W * S) / MAP_SCALE / 1000).toFixed(1), +((H * S) / MAP_SCALE / 1000).toFixed(1)], shoreline: shore }, null, 1));
console.log('landmarks:');
for (const m of marks) console.log(`  ${m.pass ? 'ok  ' : 'FAIL'} ${m.id.padEnd(26)} expect ${m.expect.padEnd(5)} got ${m.got.padEnd(8)} ${m.ground ?? ''}`);
console.log(`  ${marks.filter((m) => m.pass).length}/${marks.length} on the ground they should be`);
