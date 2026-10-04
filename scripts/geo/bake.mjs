// Bakes the cached open data into the files the site loads (public/geo/), on the projection the scene uses
// (src/geo/project.ts). GEOGRAPHY_PLAN.md §6.
//
//   node scripts/geo/bake.mjs
//
// The terrain grid is 30 m on the ground (10 m in the 1:3 world), rows north to south, columns west to east.
// Each cell gets a height (decimetres about mean sea level) and a kind (land, mangrove, tidal flat, water
// joined to the sea, inland water) with a flag saying whether the height was measured or modelled:
//   land         DeltaDTM on the low ground, FABDEM on the hills (both bare earth), blended between 5 and 10 m
//   mangrove     the same, kept between mean sea level and high water springs (the floor of a tidal forest)
//   tidal flat   ground the water covers part of the time (JRC occurrence): set at the level the tide stays
//                above for that share of the satellite passes — the tide's own height distribution
//   sea water    below the low-water line, deepening with the distance from the shore, then GEBCO offshore
//   inland water ponds, pans and the ash ponds: their beds a little under the surface the DEM measured
import { existsSync, readdirSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { deflateRawSync, inflateSync } from 'node:zlib';
import { fromFile } from 'geotiff';
import proj4 from 'proj4';
import { MAP_SCALE, ORIGIN, fromGround, toGround } from '../../src/geo/project.ts';
import { BBOX, CACHE } from './config.mjs';
import { encodePng } from './lib/png.mjs';
import { predictor } from './lib/tide.mjs';

const at = (name) => fileURLToPath(new URL(name, CACHE));
const OUT = fileURLToPath(new URL('../../public/geo/', import.meta.url));
const VIEW = at('view/');

/** Ground metres per cell: the DEMs' own spacing. */
const SPACING = 30;
/** The tide gauge records the tide this much too small (GEO_AUDIT.md §2.6). */
const TIDE_SCALE = 1.38;
/** JRC's Landsat passes come over at about 10:00 local solar time: 04:00 UTC here. */
const PASS_UTC_HOUR = 4;

const KIND = { land: 0, mangrove: 1, tidal: 2, sea: 3, inland: 4 };
const MODELLED = 0x80;

const smoothstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

// ---------- sources ----------

async function tile(file) {
  const image = await (await fromFile(at(file))).getImage();
  const [ox, oy] = image.getOrigin();
  const [rx, ry] = image.getResolution();
  const [data] = await image.readRasters();
  return { ox, oy, rx, ry, w: image.getWidth(), h: image.getHeight(), data, nodata: image.getGDALNoData() };
}

/**
 * Bilinear over 1° DEM tiles (pixel-is-area origins), null where any neighbour has no data. In a tile's
 * last half-pixel the neighbour is in the next tile, so the sample clamps inside rather than leave a seam.
 */
function demSampler(tiles) {
  return (lat, lon) => {
    for (const t of tiles) {
      const fx = Math.min(t.w - 1.001, Math.max(0, (lon - t.ox) / t.rx - 0.5));
      const fy = Math.min(t.h - 1.001, Math.max(0, (lat - t.oy) / t.ry - 0.5));
      if ((lon - t.ox) / t.rx < 0 || (lon - t.ox) / t.rx >= t.w || (lat - t.oy) / t.ry < 0 || (lat - t.oy) / t.ry >= t.h) continue;
      const c = Math.floor(fx);
      const r = Math.floor(fy);
      const i = r * t.w + c;
      const v = [t.data[i], t.data[i + 1], t.data[i + t.w], t.data[i + t.w + 1]];
      if (v.some((x) => x === t.nodata || Number.isNaN(x) || x < -1000)) return null;
      const tx = fx - c;
      const ty = fy - r;
      return (v[0] * (1 - tx) + v[1] * tx) * (1 - ty) + (v[2] * (1 - tx) + v[3] * tx) * ty;
    }
    return null;
  };
}

function nearestSampler(tiles) {
  return (lat, lon) => {
    for (const t of tiles) {
      const c = Math.floor((lon - t.ox) / t.rx);
      const r = Math.floor((lat - t.oy) / t.ry);
      if (c < 0 || r < 0 || c >= t.w || r >= t.h) continue;
      return t.data[r * t.w + c];
    }
    return null;
  };
}

/**
 * A cached EPSG:4326 window (fetch.mjs) as a lookup: nearest cell for classes, or bilinear for smooth
 * fields such as GEBCO's depths, whose ≈460 m cells would otherwise show as steps on the sea floor.
 */
async function windowSampler(id, Type, smooth = false) {
  const meta = JSON.parse(await readFile(at(`${id}.json`), 'utf8'));
  const bin = await readFile(at(`${id}.bin`));
  const data = new Type(bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength), 0, meta.width * meta.height);
  const [x0, y0, x1, y1] = meta.bbox;
  const { width: w, height: h } = meta;
  return (lat, lon) => {
    const fx = ((lon - x0) / (x1 - x0)) * w;
    const fy = ((y1 - lat) / (y1 - y0)) * h;
    if (fx < 0 || fy < 0 || fx >= w || fy >= h) return null;
    if (!smooth) return data[Math.floor(fy) * w + Math.floor(fx)];
    const cx = Math.min(w - 1.001, Math.max(0, fx - 0.5));
    const cy = Math.min(h - 1.001, Math.max(0, fy - 0.5));
    const c = Math.floor(cx);
    const r = Math.floor(cy);
    const tx = cx - c;
    const ty = cy - r;
    const v = (rr, cc) => data[rr * w + cc];
    return (v(r, c) * (1 - tx) + v(r, c + 1) * tx) * (1 - ty) + (v(r + 1, c) * (1 - tx) + v(r + 1, c + 1) * tx) * ty;
  };
}

// ---------- the grid ----------

/**
 * The grid inside the area's bbox on the ground (cell centres at east0 + (i + ½)·SPACING). Inside, not
 * round it: meridians converge, so the rectangle round the bbox has corners where the cached windows have
 * no data, and its rim (where the flood fill from the sea starts) would be blank.
 */
function gridSpec() {
  const along = (f) => Array.from({ length: 11 }, (_, k) => f(k / 10));
  const west = along((t) => toGround(BBOX.south + t * (BBOX.north - BBOX.south), BBOX.west).east);
  const east = along((t) => toGround(BBOX.south + t * (BBOX.north - BBOX.south), BBOX.east).east);
  const south = along((t) => toGround(BBOX.south, BBOX.west + t * (BBOX.east - BBOX.west)).north);
  const north = along((t) => toGround(BBOX.north, BBOX.west + t * (BBOX.east - BBOX.west)).north);
  const east0 = Math.ceil(Math.max(...west) / SPACING) * SPACING;
  const east1 = Math.floor(Math.min(...east) / SPACING) * SPACING;
  const north0 = Math.ceil(Math.max(...south) / SPACING) * SPACING;
  const north1 = Math.floor(Math.min(...north) / SPACING) * SPACING;
  return { spacing: SPACING, east0, north1, width: (east1 - east0) / SPACING, height: (north1 - north0) / SPACING };
}

/** The tide's levels at the satellite's passing hour over 1990–2020, sorted: the ground's wetness becomes a height. */
async function passLevels() {
  const { constituents } = JSON.parse(await readFile(at('tide-coxs-bazar.json'), 'utf8'));
  const level = predictor(constituents, TIDE_SCALE);
  const out = [];
  for (let t = Date.UTC(1990, 0, 1, PASS_UTC_HOUR); t < Date.UTC(2021, 0, 1); t += 86400000) out.push(level(t));
  return Float64Array.from(out).sort();
}

/** Squared Euclidean distance transform (Felzenszwalb–Huttenlocher), in cells², of the cells where `inside` is set. */
function distanceToOutside(inside, w, h) {
  const INF = 1e20;
  const d = new Float64Array(w * h);
  for (let i = 0; i < w * h; i++) d[i] = inside[i] ? INF : 0;
  const n = Math.max(w, h);
  const f = new Float64Array(n);
  const out = new Float64Array(n);
  const v = new Int32Array(n);
  const z = new Float64Array(n + 1);
  const pass = (len) => {
    let k = 0;
    v[0] = 0;
    z[0] = -INF;
    z[1] = INF;
    for (let q = 1; q < len; q++) {
      let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      while (s <= z[k]) {
        k--;
        s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      }
      k++;
      v[k] = q;
      z[k] = s;
      z[k + 1] = INF;
    }
    k = 0;
    for (let q = 0; q < len; q++) {
      while (z[k + 1] < q) k++;
      out[q] = (q - v[k]) ** 2 + f[v[k]];
    }
  };
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = d[y * w + x];
    pass(h);
    for (let y = 0; y < h; y++) d[y * w + x] = out[y];
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) f[x] = d[y * w + x];
    pass(w);
    for (let x = 0; x < w; x++) d[y * w + x] = out[x];
  }
  return d;
}

async function bakeTerrain() {
  const g = gridSpec();
  const { width: W, height: H } = g;
  const pair = (id) => [`${id}-N21E091.tif`, `${id}-N21E092.tif`].filter((f) => existsSync(at(f)));
  const fabdem = demSampler(await Promise.all(pair('fabdem').map(tile)));
  const deltadtm = demSampler(await Promise.all(pair('deltadtm').map(tile)));
  const gmw = nearestSampler(await Promise.all(['gmw-N22E091.tif', 'gmw-N22E092.tif'].map(tile)));
  const occurrence = await windowSampler('jrc-occurrence', Uint8Array);
  const seasonality = await windowSampler('jrc-seasonality', Uint8Array);
  const worldcover = await windowSampler('worldcover-2021', Uint8Array);
  const gebco = await windowSampler('gebco-2025', Int16Array, true);
  const levels = await passLevels();
  /** The level the tide stays above for share `p` of the passes. */
  const exceeded = (p) => levels[Math.min(levels.length - 1, Math.max(0, Math.round((1 - p) * (levels.length - 1))))];
  const lowWater = exceeded(0.9);
  const highWaterSprings = 1.79;

  const height = new Float32Array(W * H);
  const kind = new Uint8Array(W * H);
  const dem = new Float32Array(W * H);
  const occ = new Uint8Array(W * H);
  const deep = new Float32Array(W * H);
  // 1. what each cell is, and its height where the DEMs measured it
  for (let r = 0; r < H; r++) {
    const north = g.north1 - (r + 0.5) * SPACING;
    for (let c = 0; c < W; c++) {
      const i = r * W + c;
      const { lat, lon } = fromGround(g.east0 + (c + 0.5) * SPACING, north);
      const fab = fabdem(lat, lon);
      const dtm = deltadtm(lat, lon);
      // bare earth: DeltaDTM where low (it is truer there, and ends at 30 m), FABDEM up the hills
      dem[i] = dtm === null ? (fab ?? 0) : fab === null ? dtm : dtm + (fab - dtm) * smoothstep(5, 10, fab);
      const o = occurrence(lat, lon);
      occ[i] = o === null || o > 100 ? 0 : o;
      deep[i] = gebco(lat, lon) ?? 0;
      const wc = worldcover(lat, lon);
      const months = seasonality(lat, lon) ?? 0;
      if (occ[i] >= 90) kind[i] = KIND.sea;
      // wet part of the time in most months of the year, on open ground: a tidal flat (pans and paddies are wet only a season)
      else if (occ[i] >= 5 && months >= 9 && (wc === 80 || wc === 60 || wc === 90 || wc === 95)) kind[i] = KIND.tidal;
      else if (wc === 95 || gmw(lat, lon) === 1) kind[i] = KIND.mangrove;
      else if (wc === 80) kind[i] = KIND.inland;
      else kind[i] = KIND.land;
    }
  }
  // 2. water and flats joined to the open sea (through water or flats) belong to the tide; the rest is inland
  const joined = new Uint8Array(W * H);
  const queue = new Int32Array(W * H);
  let head = 0;
  let tail = 0;
  const wet = (i) => kind[i] === KIND.sea || kind[i] === KIND.tidal;
  for (let c = 0; c < W; c++)
    for (const r of [0, H - 1]) {
      const i = r * W + c;
      if (wet(i) && !joined[i]) (joined[i] = 1), (queue[tail++] = i);
    }
  for (let r = 0; r < H; r++)
    for (const c of [0, W - 1]) {
      const i = r * W + c;
      if (wet(i) && !joined[i]) (joined[i] = 1), (queue[tail++] = i);
    }
  while (head < tail) {
    const i = queue[head++];
    const c = i % W;
    for (const j of [i - W, i + W, c > 0 ? i - 1 : -1, c < W - 1 ? i + 1 : -1]) {
      if (j < 0 || j >= W * H || joined[j] || !wet(j)) continue;
      joined[j] = 1;
      queue[tail++] = j;
    }
  }
  for (let i = 0; i < W * H; i++) if (wet(i) && !joined[i]) kind[i] = KIND.inland;
  // 3. heights
  const seaCells = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) seaCells[i] = kind[i] === KIND.sea ? 1 : 0;
  const dist2 = distanceToOutside(seaCells, W, H);
  for (let i = 0; i < W * H; i++) {
    switch (kind[i]) {
      case KIND.land:
        height[i] = dem[i];
        break;
      case KIND.mangrove:
        height[i] = Math.min(highWaterSprings, Math.max(0, dem[i]));
        kind[i] |= MODELLED;
        break;
      case KIND.tidal:
        height[i] = exceeded(occ[i] / 100);
        kind[i] |= MODELLED;
        break;
      case KIND.sea: {
        // the bed falls away from the low-water line at 1:50 to at most 8 m more, then takes GEBCO offshore
        const d = Math.sqrt(dist2[i]) * SPACING;
        const shelf = lowWater - Math.min(8, d * 0.02);
        height[i] = shelf + (Math.min(shelf, deep[i]) - shelf) * smoothstep(2000, 6000, d);
        kind[i] |= MODELLED;
        break;
      }
      default:
        // inland water: the DEM measured its surface; its bed lies a little below
        height[i] = dem[i] - 1.2;
        kind[i] |= MODELLED;
    }
  }

  const terrain = new Int16Array(W * H);
  for (let i = 0; i < W * H; i++) terrain[i] = Math.round(Math.max(-3000, Math.min(3000, height[i] * 10)));
  await mkdir(OUT, { recursive: true });
  await writeFile(`${OUT}terrain.bin`, deflateRawSync(Buffer.from(terrain.buffer)));
  await writeFile(`${OUT}kind.bin`, deflateRawSync(Buffer.from(kind.buffer)));

  const counts = {};
  for (let i = 0; i < W * H; i++) {
    const name = Object.keys(KIND).find((k) => KIND[k] === (kind[i] & 0x7f));
    counts[name] = (counts[name] ?? 0) + 1;
  }
  const km2 = Object.fromEntries(Object.entries(counts).map(([k, n]) => [k, +((n * SPACING * SPACING) / 1e6).toFixed(1)]));
  await preview(g, height, kind);
  return { grid: g, kind, km2, lowWater: +lowWater.toFixed(2), highest: +height.reduce((a, v) => Math.max(a, v), -Infinity).toFixed(1), deepest: +height.reduce((a, v) => Math.min(a, v), Infinity).toFixed(1) };
}

/** A shaded relief with the kinds coloured, to look at (cache/view/terrain.png). */
async function preview(g, height, kind) {
  const { width: W, height: H } = g;
  const rgb = new Uint8Array(W * H * 3);
  for (let r = 0; r < H; r++)
    for (let c = 0; c < W; c++) {
      const i = r * W + c;
      const h = height[i];
      const dx = (height[r * W + Math.min(W - 1, c + 1)] - height[r * W + Math.max(0, c - 1)]) / (2 * SPACING);
      const dy = (height[Math.max(0, r - 1) * W + c] - height[Math.min(H - 1, r + 1) * W + c]) / (2 * SPACING);
      // light from the north-west, slopes exaggerated ×3 as the 1:3 world will show them
      const shade = Math.max(0, Math.min(1, 0.75 + (-dx + dy) * 3 * 0.5));
      const k = kind[i] & 0x7f;
      let col;
      if (k === KIND.sea) col = [20 + 3 * Math.max(-25, h), 70 + 4 * Math.max(-25, h), 140 + 3 * Math.max(-25, h)].map((v) => Math.max(10, v));
      else if (k === KIND.inland) col = [60, 120, 170];
      else if (k === KIND.tidal) col = [150, 140, 110];
      else if (k === KIND.mangrove) col = [40, 110, 60];
      else col = h < 3 ? [150, 170, 110] : h < 20 ? [120, 150, 90] : h < 50 ? [140, 130, 90] : [170, 150, 120];
      for (let j = 0; j < 3; j++) rgb[i * 3 + j] = Math.max(0, Math.min(255, col[j] * (k === KIND.sea ? 1 : shade)));
    }
  await mkdir(VIEW, { recursive: true });
  await writeFile(`${VIEW}terrain.png`, encodePng(rgb, W, H, 3));
}

// ---------- cover and trees ----------

/** What covers the ground. WorldCover's classes, with bare ground split into sand and mud, and the pans. */
const COVER = { none: 0, tree: 1, shrub: 2, grass: 3, crop: 4, built: 5, bare: 6, sand: 7, mud: 8, marsh: 9, mangrove: 10, saltpan: 11, pond: 12, water: 13 };
const FROM_WORLDCOVER = { 10: COVER.tree, 20: COVER.shrub, 30: COVER.grass, 40: COVER.crop, 50: COVER.built, 60: COVER.bare, 80: COVER.water, 90: COVER.marsh, 95: COVER.mangrove, 100: COVER.grass };
/**
 * Brightness (mean of R, G, B in the true-colour image) above which bare ground is sand: on the
 * 2026-02-26 scene clean sand reads ≈170, tidal mud 90–110, salt pans ≈110, the sea ≈70.
 */
const SAND_BRIGHTNESS = 140;

/** The Sentinel-2 mosaic's brightest 10 m pixel round a point (sand shows even as a thin strip in a 30 m cell). */
async function sentinelBrightest() {
  proj4.defs('EPSG:32646', '+proj=utm +zone=46 +datum=WGS84 +units=m +no_defs');
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
  return {
    scene: name,
    at(lat, lon) {
      const [e, n] = proj4('EPSG:4326', 'EPSG:32646', [lon, lat]);
      const c0 = Math.floor((e - meta.bbox[0]) / 10);
      const r0 = Math.floor((meta.bbox[3] - n) / 10);
      let best = 0;
      for (let r = r0 - 1; r <= r0 + 1; r++)
        for (let c = c0 - 1; c <= c0 + 1; c++) {
          if (r < 0 || c < 0 || r >= meta.height || c >= meta.width) continue;
          const o = r * stride + 1 + c * 3;
          best = Math.max(best, (raw[o] + raw[o + 1] + raw[o + 2]) / 3);
        }
      return best;
    },
  };
}

/** OSM's salt pans as polygons, with a point-in-polygon test. */
async function saltPans() {
  const { elements } = JSON.parse(await readFile(at('osm-landuse.json'), 'utf8'));
  const rings = [];
  for (const e of elements) {
    if (e.tags?.landuse !== 'salt_pond') continue;
    const parts = e.type === 'way' ? [e.geometry] : (e.members ?? []).filter((m) => m.role === 'outer').map((m) => m.geometry);
    for (const ring of parts) {
      if (!ring?.length) continue;
      const lats = ring.map((p) => p.lat);
      const lons = ring.map((p) => p.lon);
      rings.push({ ring, s: Math.min(...lats), n: Math.max(...lats), w: Math.min(...lons), e: Math.max(...lons) });
    }
  }
  return (lat, lon) =>
    rings.some((p) => {
      if (lat < p.s || lat > p.n || lon < p.w || lon > p.e) return false;
      let inside = false;
      for (let i = 0, j = p.ring.length - 1; i < p.ring.length; j = i++) {
        const a = p.ring[i];
        const b = p.ring[j];
        if (a.lat > lat !== b.lat > lat && lon < ((b.lon - a.lon) * (lat - a.lat)) / (b.lat - a.lat) + a.lon) inside = !inside;
      }
      return inside;
    });
}

/** Meta/WRI canopy height (EPSG:3857 window, ≈5 m cells, metres). */
async function canopySampler() {
  const meta = JSON.parse(await readFile(at('canopy-meta.json'), 'utf8'));
  const data = await readFile(at('canopy-meta.bin'));
  const [x0, y0, x1, y1] = meta.bbox;
  const R = 6378137;
  return (lat, lon) => {
    const x = (lon * Math.PI * R) / 180;
    const y = R * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
    const c = Math.floor(((x - x0) / (x1 - x0)) * meta.width);
    const r = Math.floor(((y1 - y) / (y1 - y0)) * meta.height);
    return c < 0 || r < 0 || c >= meta.width || r >= meta.height ? 0 : data[r * meta.width + c];
  };
}

async function bakeCover(g, kind) {
  const { width: W, height: H } = g;
  const worldcover = await windowSampler('worldcover-2021', Uint8Array);
  const seasonality = await windowSampler('jrc-seasonality', Uint8Array);
  const sentinel = await sentinelBrightest();
  const inSaltPan = await saltPans();
  const chm = await canopySampler();
  const cover = new Uint8Array(W * H);
  // per cell: tree height (90th percentile of the canopy pixels ≥ 3 m, metres) and tree cover (0..255)
  const canopy = new Uint8Array(W * H * 2);
  const vote = new Uint8Array(256);
  for (let r = 0; r < H; r++) {
    const north = g.north1 - (r + 0.5) * SPACING;
    for (let c = 0; c < W; c++) {
      const i = r * W + c;
      const { lat, lon } = fromGround(g.east0 + (c + 0.5) * SPACING, north);
      const dLat = 10 / 110574;
      const dLon = 10 / (111320 * Math.cos(lat * RAD_DEG));
      // WorldCover's 10 m classes, the most common of the nine in the cell
      vote.fill(0);
      let wc = 0;
      for (let y = -1; y <= 1; y++)
        for (let x = -1; x <= 1; x++) {
          const v = worldcover(lat + y * dLat, lon + x * dLon) ?? 0;
          if (++vote[v] > vote[wc]) wc = v;
        }
      const k = kind[i] & 0x7f;
      let cls = FROM_WORLDCOVER[wc] ?? COVER.none;
      if (k === KIND.sea) cls = COVER.water;
      else if (k === KIND.mangrove) cls = COVER.mangrove;
      // salt pans hold water only through the rains (3–9 months a year, as inside OSM's pans); shrimp ponds and tanks most of the year
      else if (k === KIND.inland) cls = inSaltPan(lat, lon) || isSeasonal(seasonality(lat, lon)) ? COVER.saltpan : COVER.pond;
      else if (k === KIND.tidal) cls = sentinel.at(lat, lon) >= SAND_BRIGHTNESS ? COVER.sand : COVER.mud;
      else if (inSaltPan(lat, lon)) cls = COVER.saltpan;
      else if (cls === COVER.bare && sentinel.at(lat, lon) >= SAND_BRIGHTNESS) cls = COVER.sand;
      else if (cls === COVER.water) cls = COVER.pond;
      cover[i] = cls;
      // trees: the canopy map's ≈5 m pixels in the cell
      const heights = [];
      let n = 0;
      for (let y = -2.5; y <= 2.5; y++)
        for (let x = -2.5; x <= 2.5; x++) {
          const h = chm(lat + y * dLat * 0.5, lon + x * dLon * 0.5);
          n++;
          if (h >= 3) heights.push(h);
        }
      heights.sort((a, b) => a - b);
      canopy[i * 2] = heights.length ? heights[Math.floor(0.9 * (heights.length - 1))] : 0;
      canopy[i * 2 + 1] = Math.round((heights.length / n) * 255);
    }
  }
  await writeFile(`${OUT}cover.bin`, deflateRawSync(Buffer.from(cover.buffer)));
  await writeFile(`${OUT}canopy.bin`, deflateRawSync(Buffer.from(canopy.buffer)));
  await coverPreview(g, cover, canopy);
  const km2 = {};
  for (let i = 0; i < W * H; i++) {
    const name = Object.keys(COVER).find((key) => COVER[key] === cover[i]);
    km2[name] = (km2[name] ?? 0) + (SPACING * SPACING) / 1e6;
  }
  return { scene: sentinel.scene, km2: Object.fromEntries(Object.entries(km2).map(([k, v]) => [k, +v.toFixed(1)])) };
}

const COVER_COLOURS = {
  [COVER.none]: [0, 0, 0], [COVER.tree]: [30, 100, 40], [COVER.shrub]: [110, 140, 60], [COVER.grass]: [150, 190, 90],
  [COVER.crop]: [210, 200, 100], [COVER.built]: [200, 60, 60], [COVER.bare]: [170, 150, 120], [COVER.sand]: [250, 235, 170],
  [COVER.mud]: [120, 100, 80], [COVER.marsh]: [100, 160, 150], [COVER.mangrove]: [20, 70, 40], [COVER.saltpan]: [240, 240, 250],
  [COVER.pond]: [80, 150, 200], [COVER.water]: [30, 60, 120],
};

/** The cover in colour, trees darkened by how tall they stand (cache/view/cover.png). */
async function coverPreview(g, cover, canopy) {
  const { width: W, height: H } = g;
  const rgb = new Uint8Array(W * H * 3);
  for (let i = 0; i < W * H; i++) {
    const col = COVER_COLOURS[cover[i]];
    const shade = 1 - Math.min(0.5, canopy[i * 2] / 40) * (canopy[i * 2 + 1] / 255);
    for (let j = 0; j < 3; j++) rgb[i * 3 + j] = col[j] * shade;
  }
  await writeFile(`${VIEW}cover.png`, encodePng(rgb, W, H, 3));
}

const RAD_DEG = Math.PI / 180;
const isSeasonal = (months) => months !== null && months >= 3 && months <= 9;

const terrain = await bakeTerrain();
const coverage = await bakeCover(terrain.grid, terrain.kind);
const manifest = {
  made: new Date().toISOString().slice(0, 10),
  projection: { kind: 'transverse Mercator on the origin meridian, WGS84 (src/geo/project.ts)', origin: ORIGIN, mapScale: MAP_SCALE },
  grid: { ...terrain.grid, rows: 'north to south', columns: 'west to east', note: 'cell centre (c, r): east = east0 + (c + 0.5)·spacing, north = north1 − (r + 0.5)·spacing, ground metres' },
  layers: {
    terrain: { file: 'terrain.bin', encoding: 'deflate-raw', type: 'int16', unit: 'decimetre', datum: 'mean sea level (EGM2008)' },
    kind: { file: 'kind.bin', encoding: 'deflate-raw', type: 'uint8', codes: KIND, modelledBit: MODELLED },
    cover: {
      file: 'cover.bin',
      encoding: 'deflate-raw',
      type: 'uint8',
      codes: COVER,
      note: `WorldCover 2021, the commonest of nine 10 m samples per cell; sand where bare or tidal ground is brighter than ${SAND_BRIGHTNESS} in ${coverage.scene}; salt pans from OSM, and inland water wet 3–9 months a year (JRC seasonality)`,
      licence: 'ODbL (salt pans from OpenStreetMap), with CC BY 4.0 WorldCover',
    },
    canopy: { file: 'canopy.bin', encoding: 'deflate-raw', type: 'uint8 × 2', fields: ['tree height, metres (90th percentile of canopy pixels ≥ 3 m)', 'tree cover, 0..255'], licence: 'CC BY 4.0 (Meta/WRI)' },
  },
  coverKm2: coverage.km2,
  tide: { source: "Cox's Bazar gauge fit (tide-coxs-bazar.json)", amplitudeScale: TIDE_SCALE, lowWater: terrain.lowWater },
  areaKm2: terrain.km2,
  licence: 'each layer its own: terrain and kind CC BY-NC-SA 4.0 (from FABDEM V1-2), cover ODbL, canopy CC BY 4.0',
  attribution: [
    'FABDEM V1-2 (Hawker et al. 2022, University of Bristol / Fathom), CC BY-NC-SA 4.0',
    'DeltaDTM © Pronk et al. 2024, CC BY 4.0',
    'GEBCO Compilation Group (2025) GEBCO 2025 Grid (doi:10.5285/37c52e96-24ea-67ce-e063-7086abc05f29)',
    'Source: EC JRC/Google (Pekel et al. 2016)',
    '© ESA WorldCover project / Contains modified Copernicus Sentinel data (2021) processed by ESA WorldCover consortium',
    'Global Mangrove Watch v3.0 (Bunting et al. 2022), CC BY 4.0',
    "Tide: UHSLC research quality data, Cox's Bazar (h136a)",
    'High Resolution Canopy Height Maps by WRI and Meta (2023), CC BY 4.0',
    '© OpenStreetMap contributors, ODbL',
    'Contains modified Copernicus Sentinel data 2026',
  ],
};
await writeFile(`${OUT}manifest.json`, JSON.stringify(manifest, null, 2));
console.log(JSON.stringify({ grid: terrain.grid, km2: terrain.km2, cover: coverage.km2, lowWater: terrain.lowWater, highest: terrain.highest, deepest: terrain.deepest }, null, 1));
