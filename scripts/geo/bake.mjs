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
//   tidal flat   tidal wetland in Murray et al.'s map; set at the level the tide stays above for the share of
//                the satellite passes JRC saw it wet: the tide's own height distribution
//   sea water    below the low-water line, deepening with the distance from the shore, then GEBCO offshore
//   inland water ponds, pans and the ash ponds: their beds a little under the surface the DEM measured
import { existsSync, readdirSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { deflateRawSync, inflateSync } from 'node:zlib';
import { fromFile } from 'geotiff';
import proj4 from 'proj4';
import { CROP_GROUND, MAP_SCALE, ORIGIN, fromGround, toGround } from '../../src/geo/project.ts';
import { BBOX, CACHE } from './config.mjs';
import { PLACES } from './places.mjs';
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
/** Open water that may be a river or creek of the sea, decided by the flood fill (never written out). */
const CHANNEL = 5;
/** Bare ground the tide reaches, its height measured (bakeTerrain 2b); baked as tidal. */
const BARE_TIDAL = 6;
const MODELLED = 0x80;
/** Inland water on ground rising more than this (m) across the 3 × 3 cells round it is ground (bakeTerrain). */
const INLAND_SLOPE = 3;
/**
 * The Matarbari plant's ash ponds, dug and bunded after the DEMs and WorldCover were made, so drawn in here: the
 * north one (OSM way 1537055661) full of water on Sentinel-2 (2026-02-26), the east one (way 1537056321) mostly
 * dry ash and sand on the same scene, its bed as ground. Their water's level, beds and bunds' crests (m about
 * MSL) are [মডেল].
 */
const ASH_PONDS = [
  { id: 1537055661, level: 6, bund: 8 },
  { id: 1537056321, bed: 5, bund: 8 },
];
/** The ash pond mask's codes: inside a pond of water, its bunds, inside a dry pond. */
const ASH = { water: 1, bund: 2, dry: 3 };
/**
 * Matarbari port's works, reclaimed and dredged after the DEMs, JRC's water and WorldCover were made: inside
 * this box the ground is land or water as Sentinel-2 saw it (2026-02-26), the reclaimed land standing at
 * `reclaimed` m about MSL [মডেল: the fill's level is not published]; the breakwaters (OSM) stay water, their
 * mounds drawn by the scene (world/port.ts).
 */
const PORT_ZONE = { s: 21.68, n: 21.7065, w: 91.841, e: 91.879, reclaimed: 4.5 };

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
  // the data's box, cut to the compact map's extent (src/geo/project.ts CROP)
  const east0 = Math.ceil(Math.max(...west, CROP_GROUND.east0) / SPACING) * SPACING;
  const east1 = Math.floor(Math.min(...east, CROP_GROUND.east1) / SPACING) * SPACING;
  const north0 = Math.ceil(Math.max(...south, CROP_GROUND.north0) / SPACING) * SPACING;
  const north1 = Math.floor(Math.min(...north, CROP_GROUND.north1) / SPACING) * SPACING;
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

/** OSM's breakwaters by the port, in ground metres: [[east, north], …] for each. */
async function portBreakwaters() {
  const { elements } = JSON.parse(await readFile(at('osm-infrastructure.json'), 'utf8'));
  return elements
    .filter((e) => e.type === 'way' && e.tags?.man_made === 'breakwater' && e.geometry?.length)
    .map((e) => e.geometry.map((p) => {
      const q = toGround(p.lat, p.lon);
      return [q.east, q.north];
    }));
}

/** Whether (east, north) lies within `d` m of any of the lines. */
function nearLine(lines, e, n, d) {
  for (const l of lines)
    for (let k = 1; k < l.length; k++) {
      const [ax, ay] = l[k - 1];
      const [bx, by] = l[k];
      const sx = bx - ax;
      const sy = by - ay;
      const t = Math.max(0, Math.min(1, ((e - ax) * sx + (n - ay) * sy) / (sx * sx + sy * sy || 1)));
      if (Math.hypot(e - ax - sx * t, n - ay - sy * t) < d) return true;
    }
  return false;
}

/** The ash ponds on the grid (`ASH` codes; `pond` which of ASH_PONDS each cell belongs to): inside, and the ring of cells round each (its bunds). */
async function ashPondMask(g) {
  const { width: W, height: H } = g;
  const mask = new Uint8Array(W * H);
  const pond = new Uint8Array(W * H);
  const { elements } = JSON.parse(await readFile(at('osm-landuse.json'), 'utf8'));
  ASH_PONDS.forEach((spec, k) => {
    const way = elements.find((e) => e.type === 'way' && e.id === spec.id && e.geometry?.length);
    if (!way) return;
    const ring = way.geometry.map((p) => toGround(p.lat, p.lon));
    const inside = (e, n) => {
      let c = false;
      for (let a = 0, b = ring.length - 1; a < ring.length; b = a++)
        if (ring[a].north > n !== ring[b].north > n && e < ((ring[b].east - ring[a].east) * (n - ring[a].north)) / (ring[b].north - ring[a].north) + ring[a].east) c = !c;
      return c;
    };
    const code = spec.level !== undefined ? ASH.water : ASH.dry;
    for (let r = 0; r < H; r++)
      for (let c = 0; c < W; c++)
        if (inside(g.east0 + (c + 0.5) * SPACING, g.north1 - (r + 0.5) * SPACING)) {
          mask[r * W + c] = code;
          pond[r * W + c] = k;
        }
  });
  for (let i = 0; i < W * H; i++) {
    if (mask[i]) continue;
    const c = i % W;
    for (const j of [i - W, i + W, c > 0 ? i - 1 : -1, c < W - 1 ? i + 1 : -1])
      if (j >= 0 && j < W * H && (mask[j] === ASH.water || mask[j] === ASH.dry)) {
        mask[i] = ASH.bund;
        pond[i] = pond[j];
      }
  }
  return { mask, pond };
}

async function bakeTerrain() {
  const g = gridSpec();
  const { width: W, height: H } = g;
  const pair = (id) => [`${id}-N21E091.tif`, `${id}-N21E092.tif`].filter((f) => existsSync(at(f)));
  const fabdem = demSampler(await Promise.all(pair('fabdem').map(tile)));
  const deltadtm = demSampler(await Promise.all(pair('deltadtm').map(tile)));
  const gmw = nearestSampler(await Promise.all(['gmw-N22E091.tif', 'gmw-N22E092.tif'].map(tile)));
  const occurrence = await windowSampler('jrc-occurrence', Uint8Array);
  const worldcover = await windowSampler('worldcover-2021', Uint8Array);
  const gebco = await windowSampler('gebco-2025', Int16Array, true);
  const murray = await windowSampler('murray-tidal', Uint8Array);
  const seasonality = await windowSampler('jrc-seasonality', Uint8Array);
  const levels = await passLevels();
  const scene = await sentinelBrightest();
  const breakwaters = await portBreakwaters();
  /** The level the tide stays above for share `p` of the passes. */
  const exceeded = (p) => levels[Math.min(levels.length - 1, Math.max(0, Math.round((1 - p) * (levels.length - 1))))];
  const lowWater = exceeded(0.9);
  const highWaterSprings = 1.79;

  const height = new Float32Array(W * H);
  const kind = new Uint8Array(W * H);
  const dem = new Float32Array(W * H);
  const occ = new Uint8Array(W * H);
  const deep = new Float32Array(W * H);
  /** WorldCover's class under each cell. */
  const cls = new Uint8Array(W * H);
  /** The cells of the port's zone, taken from Sentinel-2. */
  const zone = new Uint8Array(W * H);
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
      cls[i] = wc ?? 0;
      if (occ[i] >= 90) kind[i] = KIND.sea;
      else if (wc === 95 || gmw(lat, lon) === 1) kind[i] = KIND.mangrove;
      // Murray et al. map tidal wetland (flats, marsh) directly; JRC's wetness alone cannot tell a tidal flat
      // from a salt pan or a shrimp pond, which are wet as often (GEO_AUDIT.md)
      else if ((murray(lat, lon) ?? 0) >= 50) kind[i] = KIND.tidal;
      // rivers, creeks and the port basin: wet most of the time all twelve months (pans are wet a season)
      else if (occ[i] >= 60 && seasonality(lat, lon) === 12) kind[i] = CHANNEL;
      else if (wc === 80) kind[i] = KIND.inland;
      else kind[i] = KIND.land;
      // the port's works as Sentinel-2 saw them: open water (green over red) or land; the mixed edge as it was
      if (lat > PORT_ZONE.s && lat < PORT_ZONE.n && lon > PORT_ZONE.w && lon < PORT_ZONE.e && !nearLine(breakwaters, g.east0 + (c + 0.5) * SPACING, north, 25)) {
        zone[i] = 1;
        const rgb = scene.mean(lat, lon);
        if (rgb && rgb[1] - rgb[0] >= 15 && rgb[1] >= rgb[2]) {
          kind[i] = KIND.sea;
          occ[i] = 100;
        } else if (rgb && rgb[1] - rgb[0] <= 5 && kind[i] !== KIND.land) {
          kind[i] = KIND.land;
          dem[i] = Math.max(dem[i], PORT_ZONE.reclaimed);
        }
      }
    }
  }
  // ... and no islets or ponds a cell or two across left by the scene's mixed pixels: each cell of the zone
  // goes with the most of the nine round it, twice over
  for (let pass = 0; pass < 2; pass++) {
    const was = kind.slice();
    for (let i = 0; i < W * H; i++) {
      if (!zone[i]) continue;
      const c = i % W;
      let wet = 0;
      for (let dr = -1; dr <= 1; dr++)
        for (let dc = -1; dc <= 1; dc++) {
          const j = i + dr * W + dc;
          if (c + dc < 0 || c + dc >= W || j < 0 || j >= W * H) continue;
          if (was[j] !== KIND.land) wet++;
        }
      if (wet >= 6 && was[i] === KIND.land) {
        kind[i] = KIND.sea;
        occ[i] = 100;
      } else if (wet <= 3 && was[i] !== KIND.land) {
        kind[i] = KIND.land;
        dem[i] = Math.max(dem[i], PORT_ZONE.reclaimed);
      }
    }
  }
  // 2. water and flats joined to the open sea (through water, flats or mangrove) belong to the tide; the rest is inland
  const joined = new Uint8Array(W * H);
  const queue = new Int32Array(W * H);
  let head = 0;
  let tail = 0;
  const wet = (i) => kind[i] === KIND.sea || kind[i] === KIND.tidal;
  const passable = (i) => wet(i) || kind[i] === KIND.mangrove || kind[i] === CHANNEL;
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
      if (j < 0 || j >= W * H || joined[j] || !passable(j)) continue;
      joined[j] = 1;
      queue[tail++] = j;
    }
  }
  for (let i = 0; i < W * H; i++) {
    if (kind[i] === CHANNEL) kind[i] = joined[i] ? KIND.sea : KIND.inland;
    else if (wet(i) && !joined[i]) kind[i] = KIND.inland;
  }
  // 2b. the bare ground the tide reaches: a beach's lower sand, a bare flat Murray's map leaves out. From the
  // sea's water and flats, through open ground (WorldCover's bare, water or wetland: not the fields, which lie
  // behind their bunds) below the spring tides' high water, it is a tidal flat with the height the DEM measured.
  const intertidal = (i) => kind[i] === KIND.land && dem[i] < highWaterSprings && (cls[i] === 60 || cls[i] === 80 || cls[i] === 90);
  head = 0;
  tail = 0;
  for (let i = 0; i < W * H; i++) if (joined[i] && (kind[i] === KIND.sea || kind[i] === KIND.tidal || kind[i] === KIND.mangrove)) queue[tail++] = i;
  const reached = new Uint8Array(W * H);
  while (head < tail) {
    const i = queue[head++];
    const c = i % W;
    for (const j of [i - W, i + W, c > 0 ? i - 1 : -1, c < W - 1 ? i + 1 : -1]) {
      if (j < 0 || j >= W * H || reached[j] || !intertidal(j)) continue;
      reached[j] = 1;
      queue[tail++] = j;
    }
  }
  for (let i = 0; i < W * H; i++) if (reached[i]) kind[i] = BARE_TIDAL;
  // 3. heights
  const seaCells = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) seaCells[i] = kind[i] === KIND.sea ? 1 : 0;
  const dist2 = distanceToOutside(seaCells, W, H);
  for (let i = 0; i < W * H; i++) {
    switch (kind[i]) {
      case KIND.land:
        height[i] = dem[i];
        break;
      case BARE_TIDAL:
        kind[i] = KIND.tidal;
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
        // inland water: its surface and bed are set below, once all of it is known
        kind[i] |= MODELLED;
    }
  }
  // 4. inland water lies level: the DEM's surface over a pond or a gher wanders by a metre or more (noise, the
  // bunds between ghers), so each cell takes the median surface of the inland water round it (±2 cells), its
  // bed 1.2 m under that. Water the DEM puts on a slope (more than INLAND_SLOPE m across the 3 × 3 cells round
  // it: a hill stream, or a misread) cannot lie there and is ground.
  const level = new Float32Array(W * H);
  const isInland = (i) => (kind[i] & 0x7f) === KIND.inland;
  const near = [];
  for (let i = 0; i < W * H; i++) {
    if (!isInland(i)) continue;
    const c = i % W;
    const r = (i - c) / W;
    let lo = Infinity;
    let hi = -Infinity;
    near.length = 0;
    for (let y = -2; y <= 2; y++)
      for (let x = -2; x <= 2; x++) {
        if (c + x < 0 || r + y < 0 || c + x >= W || r + y >= H) continue;
        const j = (r + y) * W + c + x;
        if (Math.abs(x) <= 1 && Math.abs(y) <= 1) (lo = Math.min(lo, dem[j])), (hi = Math.max(hi, dem[j]));
        if (isInland(j)) near.push(dem[j]);
      }
    near.sort((a, b) => a - b);
    level[i] = hi - lo > INLAND_SLOPE ? NaN : near[near.length >> 1];
  }
  for (let i = 0; i < W * H; i++) {
    if (!isInland(i)) continue;
    if (Number.isNaN(level[i])) {
      kind[i] = KIND.land;
      height[i] = dem[i];
      level[i] = 0;
    } else height[i] = level[i] - 1.2;
  }
  // 5. the plant's ash ponds, standing above the land round them inside their bunds: one of water, one dry
  const { mask: ash, pond } = await ashPondMask(g);
  for (let i = 0; i < W * H; i++) {
    const spec = ASH_PONDS[pond[i]];
    if (ash[i] === ASH.water) {
      kind[i] = KIND.inland | MODELLED;
      level[i] = spec.level;
      height[i] = spec.level - 1.2;
    } else if (ash[i] === ASH.dry) {
      kind[i] = KIND.land;
      level[i] = 0;
      height[i] = spec.bed;
    } else if (ash[i] === ASH.bund) {
      kind[i] = KIND.land;
      height[i] = Math.max(dem[i], spec.bund);
    }
  }
  return { grid: g, kind, height, dem, level, ash, lowWater: +lowWater.toFixed(2) };
}

/**
 * Writes the ground's layers (terrain, kind, level), once the cover has settled which inland water is a salt
 * pan (ground, its brine painted by the scene: GEOGRAPHY_PLAN.md) rather than standing water; and the preview.
 */
async function writeGround(t, cover) {
  const { grid: g, kind, height, dem, level } = t;
  const { width: W, height: H } = g;
  for (let i = 0; i < W * H; i++) {
    if ((kind[i] & 0x7f) !== KIND.inland || cover[i] !== COVER.saltpan) continue;
    kind[i] = KIND.land;
    height[i] = dem[i];
    level[i] = 0;
  }
  const terrain = new Int16Array(W * H);
  for (let i = 0; i < W * H; i++) terrain[i] = Math.round(Math.max(-3000, Math.min(3000, height[i] * 10)));
  await mkdir(OUT, { recursive: true });
  await writeFile(`${OUT}terrain.bin`, deflateRawSync(Buffer.from(terrain.buffer)));
  await writeFile(`${OUT}kind.bin`, deflateRawSync(Buffer.from(kind.buffer)));
  // inland water's surface (its bed lies 1.2 m below); 0 elsewhere
  const surface = new Int16Array(W * H);
  for (let i = 0; i < W * H; i++) if ((kind[i] & 0x7f) === KIND.inland) surface[i] = Math.round(level[i] * 10);
  await writeFile(`${OUT}level.bin`, deflateRawSync(Buffer.from(surface.buffer)));

  const counts = {};
  for (let i = 0; i < W * H; i++) {
    const name = Object.keys(KIND).find((k) => KIND[k] === (kind[i] & 0x7f));
    counts[name] = (counts[name] ?? 0) + 1;
  }
  await preview(g, height, kind);
  return {
    km2: Object.fromEntries(Object.entries(counts).map(([k, n]) => [k, +((n * SPACING * SPACING) / 1e6).toFixed(1)])),
    highest: +height.reduce((a, v) => Math.max(a, v), -Infinity).toFixed(1),
    deepest: +height.reduce((a, v) => Math.min(a, v), Infinity).toFixed(1),
  };
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
    /** The scene's mean colour over the 3 × 3 pixels round a point (≈ a cell), [r, g, b]. */
    mean(lat, lon) {
      const [e, n] = proj4('EPSG:4326', 'EPSG:32646', [lon, lat]);
      const c0 = Math.floor((e - meta.bbox[0]) / 10);
      const r0 = Math.floor((meta.bbox[3] - n) / 10);
      const out = [0, 0, 0];
      let k = 0;
      for (let r = r0 - 1; r <= r0 + 1; r++)
        for (let c = c0 - 1; c <= c0 + 1; c++) {
          if (r < 0 || c < 0 || r >= meta.height || c >= meta.width) continue;
          const o = r * stride + 1 + c * 3;
          out[0] += raw[o];
          out[1] += raw[o + 1];
          out[2] += raw[o + 2];
          k++;
        }
      return k ? out.map((v) => v / k) : null;
    },
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

async function bakeCover(g, kind, ash) {
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
      else if (k === KIND.inland) cls = ash[i] === ASH.water ? COVER.pond : inSaltPan(lat, lon) || isSeasonal(seasonality(lat, lon)) ? COVER.saltpan : COVER.pond;
      else if (ash[i] === ASH.bund || ash[i] === ASH.dry) cls = COVER.bare;
      else if (k === KIND.tidal) cls = sentinel.at(lat, lon) >= SAND_BRIGHTNESS ? COVER.sand : COVER.mud;
      else if (inSaltPan(lat, lon)) cls = COVER.saltpan;
      else if (cls === COVER.bare && sentinel.at(lat, lon) >= SAND_BRIGHTNESS) cls = COVER.sand;
      // WorldCover's water where the ground is not (a hill stream, a bed on a slope): wet ground
      else if (cls === COVER.water) cls = COVER.marsh;
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
  return { cover, scene: sentinel.scene, km2: Object.fromEntries(Object.entries(km2).map(([k, v]) => [k, +v.toFixed(1)])) };
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

// ---------- buildings ----------

/** What a building is (buildings.bin), for how the scene builds it. */
const BUILDING = { house: 0, pucca: 1, mosque: 2, temple: 3, pagoda: 4, school: 5, civic: 6, commercial: 7, industrial: 8 };
/** How many of the real buildings stand on the 1:3 map: a ninth, as the land is (GEOGRAPHY_PLAN.md §5.1). */
const BUILDING_SHARE = 9;

/** A building's kind from its OSM tags (none for Microsoft's footprints: a house, or pucca if big). */
function buildingKind(tags, area) {
  const t = tags ?? {};
  const b = t.building ?? '';
  if (t.religion === 'muslim' || b === 'mosque') return BUILDING.mosque;
  if (t.religion === 'hindu' || b === 'temple') return BUILDING.temple;
  if (t.religion === 'buddhist' || b === 'pagoda') return BUILDING.pagoda;
  if (/^(school|college|university|kindergarten)$/.test(b) || /^(school|college|university|madrasa)$/.test(t.amenity ?? '')) return BUILDING.school;
  if (/^(hospital|civic|public|government|government_office|office)$/.test(b) || /^(hospital|clinic|police|bank|post_office|townhall|courthouse)$/.test(t.amenity ?? '')) return BUILDING.civic;
  if (/^(hotel|apartments|commercial|retail|kiosk|supermarket)$/.test(b) || t.shop || t.tourism === 'hotel' || /^(marketplace|restaurant|cafe)$/.test(t.amenity ?? '')) return BUILDING.commercial;
  if (/^(industrial|warehouse|factory|hangar)$/.test(b)) return BUILDING.industrial;
  return area >= 150 ? BUILDING.pucca : BUILDING.house;
}

/** The smallest rectangle round a ring of ground points (one side along one of its edges): centre, length ≥ width, yaw of the length (world). */
function footprint(ring) {
  let best = null;
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const [ax, ay] = ring[i];
    const [bx, by] = ring[(i + 1) % n];
    const len = Math.hypot(bx - ax, by - ay);
    if (len < 0.5) continue;
    const ux = (bx - ax) / len;
    const uy = (by - ay) / len;
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (const [x, y] of ring) {
      const u = x * ux + y * uy;
      const v = -x * uy + y * ux;
      u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v);
    }
    const area = (u1 - u0) * (v1 - v0);
    if (!best || area < best.area) {
      const cu = (u0 + u1) / 2;
      const cv = (v0 + v1) / 2;
      best = { area, east: cu * ux - cv * uy, north: cu * uy + cv * ux, a: u1 - u0, b: v1 - v0, ux, uy };
    }
  }
  if (!best) return null;
  // the long side's direction, east and north, as the world's yaw (x is west, z north: a rotation about y)
  const [l, w, dx, dy] = best.a >= best.b ? [best.a, best.b, best.ux, best.uy] : [best.b, best.a, -best.uy, best.ux];
  return { east: best.east, north: best.north, l, w, yaw: Math.atan2(-dy, -dx) };
}

/** The shoelace area of a ring (m²). */
const ringArea = (ring) => Math.abs(ring.reduce((s, [x, y], i) => s + x * ring[(i + 1) % ring.length][1] - ring[(i + 1) % ring.length][0] * y, 0)) / 2;

/**
 * The buildings: OSM's footprints (with their kinds and names) and Microsoft's where OSM has none; a ninth of
 * the ordinary ones (by a hash of their id), every one OSM names or tags as more than a house; at their 1:3
 * places but real size, kept clear of each other (the important first) and off the water (buildings.bin).
 */
async function bakeBuildings(g, kind) {
  const east1 = g.east0 + g.width * SPACING;
  const north0 = g.north1 - g.height * SPACING;
  const kindAtGround = (e, n) => {
    const c = Math.floor((e - g.east0) / SPACING);
    const r = Math.floor((g.north1 - n) / SPACING);
    return c < 0 || r < 0 || c >= g.width || r >= g.height ? -1 : kind[r * g.width + c] & 0x7f;
  };
  const all = [];
  const seen = new Set();
  const take = (id, ring, tags) => {
    if (ring.length < 4) return;
    const area = ringArea(ring);
    if (area < 12 || area > 8000) return;
    const f = footprint(ring.slice(0, -1));
    if (!f || f.east < g.east0 || f.east > east1 || f.north < north0 || f.north > g.north1) return;
    if (kindAtGround(f.east, f.north) !== KIND.land) return;
    const k = buildingKind(tags, area);
    const named = !!(tags?.name || tags?.['name:en'] || tags?.['name:bn']);
    const important = named || k !== BUILDING.house && k !== BUILDING.pucca;
    // a fixed ninth of the ordinary ones, whatever order they come in
    const h = Math.imul(id ^ (id >>> 16), 0x45d9f3b) >>> 0;
    if (!important && h % BUILDING_SHARE !== 0) return;
    const levels = Math.min(20, Math.max(0, Math.round(parseFloat(tags?.['building:levels'] ?? '0')) || 0));
    all.push({ ...f, area, kind: k, levels, important, name: tags?.name ?? tags?.['name:bn'] ?? tags?.['name:en'] ?? null });
  };
  const osm = JSON.parse(await readFile(at('osm-buildings.json'), 'utf8')).elements;
  const cellKey = (e, n) => `${Math.round(e / 12)}:${Math.round(n / 12)}`;
  for (const e of osm) {
    if (e.type !== 'way' || !e.geometry) continue;
    const ring = e.geometry.map((p) => {
      const q = toGround(p.lat, p.lon);
      return [q.east, q.north];
    });
    const f = ring.reduce((s, [x, y]) => [s[0] + x / ring.length, s[1] + y / ring.length], [0, 0]);
    seen.add(cellKey(f[0], f[1]));
    take(e.id, ring, e.tags);
  }
  // Microsoft's, where no OSM building stands within a few metres
  const ms = (await import('node:zlib')).gunzipSync(await readFile(at('ms-buildings.gz'))).toString().split('\n');
  let msId = 1 << 30;
  for (const line of ms) {
    if (!line) continue;
    const c = JSON.parse(line).geometry.coordinates[0];
    const ring = c.map(([lon, lat]) => {
      const q = toGround(lat, lon);
      return [q.east, q.north];
    });
    const f = ring.reduce((s, [x, y]) => [s[0] + x / ring.length, s[1] + y / ring.length], [0, 0]);
    msId++;
    if (seen.has(cellKey(f[0], f[1]))) continue;
    take(msId, ring, null);
  }
  // the important first, then the big; each kept only clear of those already kept (on the 1:3 map, real size)
  all.sort((a, b) => Number(b.important) - Number(a.important) || b.area - a.area);
  const kept = [];
  const grid = new Map();
  const CELL = 16;
  for (const b of all) {
    const x = -b.east / MAP_SCALE;
    const z = b.north / MAP_SCALE;
    const r = 0.5 * Math.hypot(b.l, b.w) * 0.8;
    const ci = Math.floor(x / CELL);
    const cj = Math.floor(z / CELL);
    let clear = true;
    for (let i = ci - 2; i <= ci + 2 && clear; i++) {
      for (let j = cj - 2; j <= cj + 2 && clear; j++) {
        for (const o of grid.get(`${i}:${j}`) ?? []) if (Math.hypot(o.x - x, o.z - z) < o.r + r + 1) clear = false;
      }
    }
    if (!clear) continue;
    const key = `${ci}:${cj}`;
    if (!grid.has(key)) grid.set(key, []);
    grid.get(key).push({ x, z, r });
    kept.push({ ...b, x, z });
  }
  // x, z (world, float32); length, width (dm, uint16); yaw (centiradians, int16); kind, levels, important (uint8)
  const n = kept.length;
  const buf = Buffer.alloc(n * 17);
  kept.forEach((b, i) => {
    const o = i * 17;
    buf.writeFloatLE(b.x, o);
    buf.writeFloatLE(b.z, o + 4);
    buf.writeUInt16LE(Math.min(65535, Math.round(b.l * 10)), o + 8);
    buf.writeUInt16LE(Math.min(65535, Math.round(b.w * 10)), o + 10);
    buf.writeInt16LE(Math.round(b.yaw * 100), o + 12);
    buf.writeUInt8(b.kind, o + 14);
    buf.writeUInt8(b.levels, o + 15);
    buf.writeUInt8(b.important ? 1 : 0, o + 16);
  });
  await writeFile(`${OUT}buildings.bin`, deflateRawSync(buf));
  const names = kept.flatMap((b, i) => (b.name ? [{ i, name: b.name, kind: Object.keys(BUILDING).find((k) => BUILDING[k] === b.kind) }] : []));
  const count = {};
  for (const b of kept) {
    const name = Object.keys(BUILDING).find((k) => BUILDING[k] === b.kind);
    count[name] = (count[name] ?? 0) + 1;
  }
  return { count: n, candidates: all.length, kinds: count, names };
}

/**
 * Roads, rails, waterways, built structures in the water, power lines and the outlines of the industrial
 * sites, in ground decimetres ([east, north, east, north, …] about the origin), with power towers, cranes,
 * chimneys and wind turbines as points. Kept if any of a line's points lies in the grid.
 */
async function bakeVectors(g) {
  const load = async (theme) => JSON.parse(await readFile(at(`osm-${theme}.json`), 'utf8')).elements;
  const east1 = g.east0 + g.width * SPACING;
  const north0 = g.north1 - g.height * SPACING;
  const inGrid = (e, n) => e >= g.east0 && e <= east1 && n >= north0 && n <= g.north1;
  const lines = [];
  const towers = [];
  const add = (k, e, extra) => {
    if (e.type !== 'way' || !e.geometry?.length) return;
    const pts = [];
    let inside = false;
    for (const p of e.geometry) {
      const q = toGround(p.lat, p.lon);
      inside ||= inGrid(q.east, q.north);
      pts.push(Math.round(q.east * 10), Math.round(q.north * 10));
    }
    if (!inside) return;
    const name = e.tags.name ?? e.tags['name:bn'] ?? e.tags['name:en'];
    lines.push({ k, ...extra, ...(name ? { n: name } : {}), p: pts });
  };
  for (const e of await load('roads')) {
    if (e.tags?.highway) add('road', e, { t: e.tags.highway, ...(e.tags.bridge && e.tags.bridge !== 'no' ? { bridge: 1 } : {}) });
    else if (e.tags?.railway === 'rail') add('rail', e, {});
  }
  for (const e of await load('coast')) if (e.tags?.waterway) add('waterway', e, { t: e.tags.waterway });
  // the sites the scene builds on, as closed outlines: the power plant's fence line, its ash ponds, the port's
  // works and the substations (a way can be in both themes: kept once)
  const sites = new Set();
  const site = (e) => {
    const t = e.tags ?? {};
    const kind = t.power === 'plant' ? 'plant' : t.industrial === 'ash_pond' || t.substance === 'coal-ash' ? 'ash_pond' : t.industrial === 'port' ? 'port' : t.power === 'substation' ? 'substation' : null;
    if (!kind || e.type !== 'way' || sites.has(e.id)) return;
    sites.add(e.id);
    add('site', e, { t: kind, ...(t.voltage ? { v: +String(t.voltage).split(';')[0] } : {}) });
  };
  for (const e of await load('landuse')) site(e);
  // single things OSM marks as points: the cranes at the berths, chimneys, and wind turbines (with their
  // rating where OSM gives it; a node rated over 10 MW marks a whole wind farm, not a turbine)
  const nodes = [];
  const point = (e, extra) => {
    const q = toGround(e.lat, e.lon);
    if (inGrid(q.east, q.north)) nodes.push({ ...extra, p: [Math.round(q.east * 10), Math.round(q.north * 10)] });
  };
  for (const e of await load('infrastructure')) {
    const t = e.tags ?? {};
    site(e);
    if (e.type === 'node' && /^(crane|chimney)$/.test(t.man_made ?? '')) point(e, { t: t.man_made });
    if (e.type === 'node' && t['generator:method'] === 'wind_turbine') {
      const mw = /^([\d.]+)\s*MW$/.exec(t['generator:output:electricity'] ?? '');
      if (mw ? +mw[1] <= 10 : t['generator:type'] !== undefined) point(e, { t: 'wind_turbine', ...(mw ? { mw: +mw[1] } : {}) });
    }
    if (/^(pier|breakwater|groyne|dyke|quay)$/.test(t.man_made ?? '')) add('structure', e, { t: t.man_made });
    else if (t.embankment === 'yes') add('structure', e, { t: 'embankment' });
    else if (/^(line|minor_line)$/.test(t.power ?? '')) add('power', e, { t: t.power, ...(t.voltage ? { v: +String(t.voltage).split(';')[0] } : {}) });
    else if (t.power === 'tower' && e.type === 'node') {
      const q = toGround(e.lat, e.lon);
      if (inGrid(q.east, q.north)) towers.push(Math.round(q.east * 10), Math.round(q.north * 10));
    }
  }
  await writeFile(`${OUT}vectors.bin`, deflateRawSync(Buffer.from(JSON.stringify({ unit: 'ground decimetres about the origin', lines, towers, nodes }))));
  const count = {};
  for (const l of lines) count[l.k] = (count[l.k] ?? 0) + 1;
  return { ...count, towers: towers.length / 2, nodes: nodes.length };
}

/** The landmarks, each with the world point and the baked ground under it (public/geo/places.json). */
async function bakePlaces(g, height, kind, cover) {
  const nameOf = (table, v) => Object.keys(table).find((k) => table[k] === v);
  const out = PLACES.map((p) => {
    const q = toGround(p.lat, p.lon);
    const c = Math.floor((q.east - g.east0) / SPACING);
    const r = Math.floor((g.north1 - q.north) / SPACING);
    const i = r * g.width + c;
    const inside = c >= 0 && r >= 0 && c < g.width && r < g.height;
    return {
      ...p,
      world: { x: +(-q.east / MAP_SCALE).toFixed(1), z: +(q.north / MAP_SCALE).toFixed(1) },
      ...(inside ? { ground: +height[i].toFixed(1), kind: nameOf(KIND, kind[i] & 0x7f), cover: nameOf(COVER, cover[i]) } : {}),
    };
  });
  await writeFile(`${OUT}places.json`, JSON.stringify(out, null, 1));
  return out;
}

const RAD_DEG = Math.PI / 180;
const isSeasonal = (months) => months !== null && months >= 3 && months <= 9;

const terrain = await bakeTerrain();
const coverage = await bakeCover(terrain.grid, terrain.kind, terrain.ash);
Object.assign(terrain, await writeGround(terrain, coverage.cover));
const vectors = await bakeVectors(terrain.grid);
const buildings = await bakeBuildings(terrain.grid, terrain.kind);
await writeFile(`${OUT}buildings.json`, JSON.stringify({ names: buildings.names }, null, 1));
const places = await bakePlaces(terrain.grid, terrain.height, terrain.kind, coverage.cover);
const manifest = {
  made: new Date().toISOString().slice(0, 10),
  projection: { kind: 'transverse Mercator on the origin meridian, WGS84 (src/geo/project.ts)', origin: ORIGIN, mapScale: MAP_SCALE },
  grid: { ...terrain.grid, rows: 'north to south', columns: 'west to east', note: 'cell centre (c, r): east = east0 + (c + 0.5)·spacing, north = north1 − (r + 0.5)·spacing, ground metres' },
  layers: {
    terrain: { file: 'terrain.bin', encoding: 'deflate-raw', type: 'int16', unit: 'decimetre', datum: 'mean sea level (EGM2008)' },
    kind: { file: 'kind.bin', encoding: 'deflate-raw', type: 'uint8', codes: KIND, modelledBit: MODELLED },
    level: { file: 'level.bin', encoding: 'deflate-raw', type: 'int16', unit: 'decimetre', note: 'the surface of inland water (ponds, pans, tanks) as the DEM measured it; 0 elsewhere' },
    cover: {
      file: 'cover.bin',
      encoding: 'deflate-raw',
      type: 'uint8',
      codes: COVER,
      note: `WorldCover 2021, the commonest of nine 10 m samples per cell; sand where bare or tidal ground is brighter than ${SAND_BRIGHTNESS} in ${coverage.scene}; salt pans from OSM, and inland water wet 3–9 months a year (JRC seasonality)`,
      licence: 'ODbL (salt pans from OpenStreetMap), with CC BY 4.0 WorldCover',
    },
    vectors: { file: 'vectors.bin', encoding: 'deflate-raw', type: 'JSON', counts: vectors, licence: 'ODbL (OpenStreetMap)' },
    places: { file: 'places.json', note: 'landmarks with sources (scripts/geo/places.mjs)' },
    buildings: {
      file: 'buildings.bin',
      encoding: 'deflate-raw',
      record: 'x, z (world m, float32); length, width (dm, uint16); yaw (centiradians, int16); kind, levels (0: not mapped), important (uint8)',
      codes: BUILDING,
      count: buildings.count,
      names: 'buildings.json',
      note: `a ninth of the ordinary buildings (by a hash of their id) and every one OSM names or tags as more than a house, kept clear of each other on the 1:3 map; OSM's footprints, and Microsoft's where OSM has none`,
      licence: 'ODbL (OpenStreetMap; Microsoft Global ML Building Footprints)',
    },
    canopy: { file: 'canopy.bin', encoding: 'deflate-raw', type: 'uint8 × 2', fields: ['tree height, metres (90th percentile of canopy pixels ≥ 3 m)', 'tree cover, 0..255'], licence: 'CC BY 4.0 (Meta/WRI)' },
  },
  coverKm2: coverage.km2,
  tide: {
    source: "Cox's Bazar gauge fit (tide-coxs-bazar.json), UHSLC h136a",
    amplitudeScale: TIDE_SCALE,
    lowWater: terrain.lowWater,
    // the harmonic constants the scene predicts the tide from (src/env/tide.ts): amplitude m, Greenwich phase lag degrees
    constituents: JSON.parse(await readFile(at('tide-coxs-bazar.json'), 'utf8')).constituents,
  },
  areaKm2: terrain.km2,
  licence: 'each layer its own: terrain and kind CC BY-NC-SA 4.0 (from FABDEM V1-2), cover ODbL, canopy CC BY 4.0',
  attribution: [
    'FABDEM V1-2 (Hawker et al. 2022, University of Bristol / Fathom), CC BY-NC-SA 4.0',
    'DeltaDTM © Pronk et al. 2024, CC BY 4.0',
    'GEBCO Compilation Group (2025) GEBCO 2025 Grid (doi:10.5285/37c52e96-24ea-67ce-e063-7086abc05f29)',
    'Source: EC JRC/Google (Pekel et al. 2016)',
    '© ESA WorldCover project / Contains modified Copernicus Sentinel data (2021) processed by ESA WorldCover consortium',
    'Global Mangrove Watch v3.0 (Bunting et al. 2022), CC BY 4.0',
    'Murray et al. 2022, Global Intertidal Change, CC BY 4.0',
    "Tide: UHSLC research quality data, Cox's Bazar (h136a)",
    'High Resolution Canopy Height Maps by WRI and Meta (2023), CC BY 4.0',
    '© OpenStreetMap contributors, ODbL',
    'Microsoft Global ML Building Footprints, ODbL',
    'Contains modified Copernicus Sentinel data 2026',
  ],
};
await writeFile(`${OUT}manifest.json`, JSON.stringify(manifest, null, 2));
for (const p of places) console.log(p.id.padEnd(26), String(p.ground).padStart(6), (p.kind ?? '-').padEnd(9), p.cover ?? '-');
console.log(JSON.stringify({ buildings: { count: buildings.count, candidates: buildings.candidates, kinds: buildings.kinds } }));
console.log(JSON.stringify({ grid: terrain.grid, km2: terrain.km2, cover: coverage.km2, vectors, lowWater: terrain.lowWater, highest: terrain.highest, deepest: terrain.deepest }, null, 1));
