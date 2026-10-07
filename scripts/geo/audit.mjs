// P0 data audit (GEOGRAPHY_PLAN.md §12): compares the elevation sources, answers the open questions from
// OpenStreetMap, and cuts satellite crops of the key sites to look at. Reads only the cache; writes
// cache/audit/ (audit.json and PNG crops) and prints a summary.
//
//   node scripts/geo/audit.mjs
import { existsSync, readdirSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { gunzipSync, inflateSync } from 'node:zlib';
import { fromFile } from 'geotiff';
import proj4 from 'proj4';
import { BBOX, CACHE } from './config.mjs';
import { encodePng } from './lib/png.mjs';

proj4.defs('EPSG:32646', '+proj=utm +zone=46 +datum=WGS84 +units=m +no_defs');
const at = (name) => fileURLToPath(new URL(name, CACHE));
const OUT = at('audit/');
const report = {};

/** Metres between two WGS84 points. */
function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371008.8;
  const r = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * r) / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lon2 - lon1) * r) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// ---------- elevation: one sampler per source over its 1° tiles ----------

async function geotiffTile(file) {
  const image = await (await fromFile(at(file))).getImage();
  const [ox, oy] = image.getOrigin();
  const [rx, ry] = image.getResolution();
  const [data] = await image.readRasters();
  return { ox, oy, rx, ry, w: image.getWidth(), h: image.getHeight(), data, nodata: image.getGDALNoData() };
}

/** SRTM .hgt: 3601 × 3601 big-endian int16, rows from the north edge. */
async function hgtTile(file, lat0, lon0) {
  const raw = gunzipSync(await readFile(at(file)));
  const n = 3601;
  const data = new Int16Array(n * n);
  for (let i = 0; i < n * n; i++) data[i] = raw.readInt16BE(i * 2);
  return { ox: lon0 - 0.5 / 3600, oy: lat0 + 1 + 0.5 / 3600, rx: 1 / 3600, ry: -1 / 3600, w: n, h: n, data, nodata: -32768 };
}

function sampler(tiles) {
  return (lat, lon) => {
    for (const t of tiles) {
      const c = Math.floor((lon - t.ox) / t.rx);
      const r = Math.floor((lat - t.oy) / t.ry);
      if (c < 0 || r < 0 || c >= t.w || r >= t.h) continue;
      const v = t.data[r * t.w + c];
      return v === t.nodata || Number.isNaN(v) || v < -1000 ? null : v;
    }
    return null;
  };
}

async function elevation() {
  const dems = {};
  const pair = (id) => [`${id}-N21E091.tif`, `${id}-N21E092.tif`].filter((f) => existsSync(at(f)));
  for (const id of ['copernicus', 'fabdem', 'deltadtm']) {
    const files = pair(id);
    if (files.length) dems[id] = sampler(await Promise.all(files.map(geotiffTile)));
  }
  if (existsSync(at('srtm-N21E091.gz'))) dems.srtm = sampler([await hgtTile('srtm-N21E091.gz', 21, 91), ...(existsSync(at('srtm-N21E092.gz')) ? [await hgtTile('srtm-N21E092.gz', 21, 92)] : [])]);

  // the highest ground near a point, in each source (DEM cells ≈30 m; search every ≈1″)
  const peak = (dem, lat, lon, radius) => {
    let best = { h: -Infinity, lat, lon };
    const d = radius / 111000;
    for (let y = lat - d; y <= lat + d; y += 1 / 3600)
      for (let x = lon - d; x <= lon + d; x += 1 / 3600) {
        const h = dem(y, x);
        if (h !== null && h > best.h && haversine(lat, lon, y, x) <= radius) best = { h, lat: y, lon: x };
      }
    return { h: +best.h.toFixed(1), lat: +best.lat.toFixed(5), lon: +best.lon.toFixed(5) };
  };
  const sites = {
    'Adinath temple (21.5281, 91.9748), 300 m': [21.528118, 91.974811, 300],
    'SRTM high point (21.600, 91.955), 500 m': [21.6, 91.955, 500],
    'ridge (21.630, 91.953), 500 m': [21.63, 91.953, 500],
    'Matarbari plant (21.7010, 91.8821), 400 m': [21.701, 91.8821, 400],
  };
  const out = {};
  for (const [name, [lat, lon, r]] of Object.entries(sites)) out[name] = Object.fromEntries(Object.entries(dems).map(([id, dem]) => [id, peak(dem, lat, lon, r)]));

  // the hills' highest points, cell by cell (0.02°) over the island's hill range
  const hills = {};
  for (const [id, dem] of Object.entries(dems)) {
    const tops = [];
    for (let la = 21.5; la < 21.74; la += 0.02)
      for (let lo = 91.88; lo < 92.0; lo += 0.02) {
        let best = { h: -Infinity };
        for (let y = la; y < la + 0.02; y += 1 / 3600)
          for (let x = lo; x < lo + 0.02; x += 1 / 3600) {
            const h = dem(y, x);
            if (h !== null && h > best.h) best = { h, lat: y, lon: x };
          }
        if (best.h > 20) tops.push({ h: +best.h.toFixed(1), lat: +best.lat.toFixed(4), lon: +best.lon.toFixed(4) });
      }
    hills[id] = tops.sort((a, b) => b.h - a.h).slice(0, 6);
  }

  // where each source has data, over a coarse grid of the area (DeltaDTM covers only low coastal land)
  const coverage = {};
  for (const [id, dem] of Object.entries(dems)) {
    let n = 0;
    let have = 0;
    for (let y = BBOX.south; y < BBOX.north; y += 0.005)
      for (let x = BBOX.west; x < BBOX.east; x += 0.005) {
        n++;
        if (dem(y, x) !== null) have++;
      }
    coverage[id] = +(have / n).toFixed(3);
  }

  // canopy: the DSM (Copernicus) minus bare earth (FABDEM) on the hills, where forest stands
  let canopy = null;
  if (dems.copernicus && dems.fabdem) {
    const diffs = [];
    for (let y = 21.52; y < 21.72; y += 0.002)
      for (let x = 91.9; x < 91.99; x += 0.002) {
        const a = dems.copernicus(y, x);
        const b = dems.fabdem(y, x);
        if (a !== null && b !== null && b > 15) diffs.push(a - b);
      }
    diffs.sort((a, b) => a - b);
    const q = (p) => +diffs[Math.floor(p * (diffs.length - 1))].toFixed(1);
    canopy = { samples: diffs.length, median: q(0.5), p90: q(0.9), max: q(1) };
  }
  report.elevation = { sources: Object.keys(dems), sites: out, hills, coverage, copernicusMinusFabdemOnHills: canopy };
}

// ---------- land cover: sand, tidal ground, mangroves ----------

/** A cached window (EPSG:4326) as a lookup by lat/lon. */
async function windowGrid(id) {
  const meta = JSON.parse(await readFile(at(`${id}.json`), 'utf8'));
  const bin = await readFile(at(`${id}.bin`));
  const data = new Uint8Array(bin.buffer, bin.byteOffset, meta.width * meta.height);
  const [x0, y0, x1, y1] = meta.bbox;
  return { meta, data, at: (lat, lon) => data[Math.floor(((y1 - lat) / (y1 - y0)) * meta.height) * meta.width + Math.floor(((lon - x0) / (x1 - x0)) * meta.width)] };
}

const REGIONS = {
  'Sonadia': [21.47, 21.51, 91.85, 91.9],
  'Moheshkhali west coast': [21.52, 21.66, 91.83, 91.89],
  'Matarbari & Dhalghata west coast': [21.64, 21.78, 91.82, 91.87],
  "Cox's Bazar north": [21.4, 21.46, 91.94, 92.0],
  'Channel east of the island': [21.5, 21.72, 91.96, 92.02],
};
const WORLDCOVER = { 10: 'tree', 20: 'shrub', 30: 'grass', 40: 'crop', 50: 'built', 60: 'bare/sand', 80: 'water', 90: 'wetland', 95: 'mangrove' };

async function landcover() {
  if (!existsSync(at('worldcover-2021.bin'))) return;
  const wc = await windowGrid('worldcover-2021');
  const occ = existsSync(at('jrc-occurrence.bin')) ? await windowGrid('jrc-occurrence') : null;
  const out = {};
  const step = 0.0001; // ≈11 m, about one WorldCover cell
  const cellHa = (step * 110574 * step * 111320 * Math.cos(21.6 * Math.PI / 180)) / 1e4;
  for (const [name, [s, n, w, e]] of Object.entries(REGIONS)) {
    const classes = {};
    let tidal = 0;
    for (let y = s; y < n; y += step)
      for (let x = w; x < e; x += step) {
        const c = WORLDCOVER[wc.at(y, x)] ?? 'other';
        classes[c] = (classes[c] ?? 0) + cellHa;
        // ground wet only part of the time (5–95 % of observations): tidal flats and seasonal water
        const o = occ?.at(y, x);
        if (o !== undefined && o >= 5 && o <= 95) tidal += cellHa;
      }
    out[name] = { ha: Object.fromEntries(Object.entries(classes).map(([k, v]) => [k, Math.round(v)])), sometimesWetHa: Math.round(tidal) };
  }
  // mangroves by Global Mangrove Watch (2020) against WorldCover's class, over the whole area
  let gmwHa = null;
  const gmwFiles = ['gmw-N22E091.tif', 'gmw-N22E092.tif'].filter((f) => existsSync(at(f)));
  if (gmwFiles.length) {
    const tiles = await Promise.all(gmwFiles.map(geotiffTile));
    const gmw = sampler(tiles);
    let n = 0;
    for (let y = BBOX.south; y < BBOX.north; y += 0.0005) for (let x = BBOX.west; x < BBOX.east; x += 0.0005) if (gmw(y, x) === 1) n++;
    gmwHa = Math.round((n * 0.0005 * 110574 * 0.0005 * 111320 * Math.cos(21.6 * Math.PI / 180)) / 1e4);
  }
  let wcMangroveHa = 0;
  for (let y = BBOX.south; y < BBOX.north; y += 0.0005) for (let x = BBOX.west; x < BBOX.east; x += 0.0005) if (wc.at(y, x) === 95) wcMangroveHa++;
  wcMangroveHa = Math.round((wcMangroveHa * 0.0005 * 110574 * 0.0005 * 111320 * Math.cos(21.6 * Math.PI / 180)) / 1e4);
  report.landcover = { regions: out, mangroveHa: { gmw2020: gmwHa, worldcover2021: wcMangroveHa } };
}

// ---------- trees: where they stand and how tall (Meta/WRI canopy height) ----------

async function canopy() {
  if (!existsSync(at('canopy-meta.bin'))) return;
  const meta = JSON.parse(await readFile(at('canopy-meta.json'), 'utf8'));
  const data = await readFile(at('canopy-meta.bin'));
  const [x0, y0, x1, y1] = meta.bbox;
  const R = 6378137;
  const chm = (lat, lon) => {
    const x = (lon * Math.PI * R) / 180;
    const y = R * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
    const c = Math.floor(((x - x0) / (x1 - x0)) * meta.width);
    const r = Math.floor(((y1 - y) / (y1 - y0)) * meta.height);
    return c < 0 || r < 0 || c >= meta.width || r >= meta.height ? null : data[r * meta.width + c];
  };
  const regions = {
    'island hills': [21.52, 21.72, 91.92, 91.99],
    'Gorakghata to Adinath': [21.515, 21.532, 91.955, 91.978],
    'west coast mangroves': [21.55, 21.65, 91.85, 91.88],
    Sonadia: [21.47, 21.51, 91.85, 91.9],
    'Matarbari villages': [21.715, 21.76, 91.87, 91.93],
  };
  const out = {};
  for (const [name, [s, n, w, e]] of Object.entries(regions)) {
    const trees = [];
    let all = 0;
    for (let y = s; y < n; y += 0.00005)
      for (let x = w; x < e; x += 0.00005) {
        const h = chm(y, x);
        if (h === null) continue;
        all++;
        if (h >= 3) trees.push(h);
      }
    trees.sort((a, b) => a - b);
    const q = (p) => (trees.length ? trees[Math.floor(p * (trees.length - 1))] : null);
    out[name] = { treeCover: +(trees.length / all).toFixed(2), heightM: { p25: q(0.25), median: q(0.5), p90: q(0.9), max: q(1) } };
  }
  report.canopy = out;
}

// ---------- OpenStreetMap: the open questions ----------

function loadOsm(theme) {
  const p = at(`osm-${theme}.json`);
  return existsSync(p) ? readFile(p, 'utf8').then((t) => JSON.parse(t).elements) : Promise.resolve([]);
}
const centre = (e) => {
  if (e.type === 'node') return [e.lat, e.lon];
  if (e.center) return [e.center.lat, e.center.lon];
  const pts = e.geometry ?? e.members?.flatMap((m) => m.geometry ?? []) ?? [];
  if (!pts.length) return e.bounds ? [(e.bounds.minlat + e.bounds.maxlat) / 2, (e.bounds.minlon + e.bounds.maxlon) / 2] : [NaN, NaN];
  return [pts.reduce((a, p) => a + p.lat, 0) / pts.length, pts.reduce((a, p) => a + p.lon, 0) / pts.length];
};
const length = (e) => (e.geometry ?? []).reduce((a, p, i, g) => (i ? a + haversine(g[i - 1].lat, g[i - 1].lon, p.lat, p.lon) : 0), 0);
/** Area of a closed way (m², equirectangular about its centre: fine for small shapes). */
function area(e) {
  const g = e.geometry;
  if (!g || g.length < 4) return 0;
  const [lat0] = centre(e);
  const kx = 111320 * Math.cos((lat0 * Math.PI) / 180);
  let s = 0;
  for (let i = 1; i < g.length; i++) s += (g[i - 1].lon * kx) * (g[i].lat * 110574) - (g[i].lon * kx) * (g[i - 1].lat * 110574);
  return Math.abs(s / 2);
}
const brief = (e, extra = {}) => {
  const [lat, lon] = centre(e);
  return { id: `${e.type}/${e.id}`, name: e.tags?.name ?? e.tags?.['name:en'] ?? e.tags?.['name:bn'], lat: +lat.toFixed(5), lon: +lon.toFixed(5), ...extra };
};
/** Moheshkhali island's rough box (OSM relation 12849717), Sonadia included. */
const onIsland = ([lat, lon]) => lat > 21.47 && lat < 21.745 && lon > 91.84 && lon < 91.995;

async function osm() {
  const themes = ['coast', 'landuse', 'roads', 'buildings', 'places', 'infrastructure'];
  const all = Object.fromEntries(await Promise.all(themes.map(async (t) => [t, await loadOsm(t)])));
  const every = Object.values(all).flat();
  const tagged = (k, re) => every.filter((e) => e.tags && e.tags[k] !== undefined && (!re || re.test(e.tags[k])));
  const named = (re) => every.filter((e) => e.tags && Object.entries(e.tags).some(([k, v]) => k.startsWith('name') && re.test(v)));
  const uniq = (list) => [...new Map(list.map((e) => [`${e.type}/${e.id}`, e])).values()];

  report.osm = {
    elements: Object.fromEntries(themes.map((t) => [t, all[t].length])),
    buildingsOnIsland: all.buildings.filter((e) => onIsland(centre(e))).length,
    buddhist: uniq(tagged('religion', /buddhist/)).map((e) => brief(e, { tags: e.tags.amenity ?? e.tags.building })),
    hindu: uniq(tagged('religion', /hindu/)).filter((e) => onIsland(centre(e))).map((e) => brief(e)),
    dykes: (() => {
      const d = uniq([...tagged('man_made', /^dyke$/), ...tagged('embankment', /^yes$/)]);
      return { ways: d.length, km: +(d.reduce((a, e) => a + length(e), 0) / 1000).toFixed(1), onIsland: d.filter((e) => onIsland(centre(e))).length };
    })(),
    piers: uniq(tagged('man_made', /^(pier|jetty|quay|breakwater|groyne)$/)).map((e) => brief(e, { kind: e.tags.man_made, m: Math.round(length(e)) })),
    ghats: uniq(named(/ghat|ঘাট|jetty|জেটি/i)).map((e) => brief(e, { tags: e.tags.amenity ?? e.tags.man_made ?? e.tags.highway })),
    dryFish: uniq(named(/shutki|শুঁটকি|শুটকি|dry ?fish/i)).map((e) => brief(e)),
    betel: uniq([...named(/betel|পান বরজ|বরজ|paan/i), ...tagged('crop', /betel/)]).map((e) => brief(e)),
    beaches: uniq(tagged('natural', /^beach$/)).map((e) => brief(e, { ha: +(area(e) / 1e4).toFixed(1) })),
    saltPonds: (() => {
      const s = uniq(tagged('landuse', /^salt_pond$/));
      return { count: s.length, ha: +(s.reduce((a, e) => a + area(e), 0) / 1e4).toFixed(0), items: s.map((e) => brief(e, { ha: +(area(e) / 1e4).toFixed(1) })) };
    })(),
    // freshwater on the island for the shapla bil: the biggest still waters (not the sea's creeks)
    stillWater: uniq(all.coast.filter((e) => e.tags?.natural === 'water' && !/^(river|stream|canal|tidal_channel|oxbow)$/.test(e.tags.water ?? '') && e.type === 'way'))
      .filter((e) => onIsland(centre(e)))
      .map((e) => brief(e, { water: e.tags.water, ha: +(area(e) / 1e4).toFixed(2) }))
      .sort((a, b) => b.ha - a.ha)
      .slice(0, 15),
    wetlands: uniq(tagged('wetland')).map((e) => brief(e, { wetland: e.tags.wetland, ha: +(area(e) / 1e4).toFixed(1) })),
    // small bridges on the island: a real crossing of a khal for the old arch bridge
    smallBridges: uniq(all.roads.filter((e) => e.tags?.bridge && e.tags.bridge !== 'no'))
      .map((e) => brief(e, { highway: e.tags.highway, m: Math.round(length(e)) }))
      .filter((b) => onIsland([b.lat, b.lon]) && b.m >= 8 && b.m <= 60),
    waterways: Object.entries(
      uniq(tagged('waterway')).reduce((a, e) => ((a[e.tags.waterway] = (a[e.tags.waterway] ?? 0) + 1), a), {}),
    ),
    namedWaterways: uniq(tagged('waterway')).filter((e) => e.tags.name).map((e) => brief(e, { waterway: e.tags.waterway, km: +(length(e) / 1000).toFixed(1) })),
    power: {
      plants: uniq(tagged('power', /^plant$/)).map((e) => brief(e)),
      lines: uniq(tagged('power', /^(line|minor_line)$/)).map((e) => brief(e, { voltage: e.tags.voltage, km: +(length(e) / 1000).toFixed(1) })),
      towers: tagged('power', /^tower$/).length,
      chimneys: uniq(tagged('man_made', /^chimney$/)).map((e) => brief(e, { height: e.tags.height })),
    },
    storage: uniq(tagged('man_made', /^(silo|storage_tank|bunker_silo)$/)).map((e) => brief(e, { kind: e.tags.man_made, content: e.tags.content })),
    construction: uniq([...tagged('landuse', /^construction$/), ...tagged('construction')]).map((e) => brief(e, { ha: +(area(e) / 1e4).toFixed(0) })),
    villages: uniq(tagged('place', /^(town|village|hamlet|suburb|neighbourhood|isolated_dwelling)$/))
      .filter((e) => onIsland(centre(e)))
      .map((e) => brief(e, { place: e.tags.place })),
  };
}

// ---------- satellite crops of the key sites ----------

/** Decodes the cached Sentinel mosaic (our own encodePng output: 8-bit RGB, filter 0 on every row). */
async function loadMosaic() {
  const name = readdirSync(fileURLToPath(CACHE)).filter((f) => /^sentinel-.*\.png$/.test(f)).sort().pop();
  if (!name) return null;
  const meta = JSON.parse(await readFile(at(name.replace('.png', '.json')), 'utf8'));
  const png = await readFile(at(name));
  const idat = [];
  for (let p = 8; p < png.length; ) {
    const len = png.readUInt32BE(p);
    if (png.toString('latin1', p + 4, p + 8) === 'IDAT') idat.push(png.subarray(p + 8, p + 8 + len));
    p += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = meta.width * 3;
  const rgb = new Uint8Array(meta.width * meta.height * 3);
  for (let y = 0; y < meta.height; y++) raw.copy(rgb, y * stride, y * (stride + 1) + 1, (y + 1) * (stride + 1));
  return { name, meta, rgb };
}

/** A square crop `size` m across round a point, enlarged `zoom` times, brightened for murky coastal scenes. */
function crop(m, lat, lon, size, zoom) {
  const [e, n] = proj4('EPSG:4326', 'EPSG:32646', [lon, lat]);
  const half = size / 2 / m.meta.res;
  const cx = (e - m.meta.bbox[0]) / m.meta.res;
  const cy = (m.meta.bbox[3] - n) / m.meta.res;
  const w = Math.round(half * 2);
  const out = new Uint8Array(w * zoom * w * zoom * 3);
  for (let y = 0; y < w * zoom; y++)
    for (let x = 0; x < w * zoom; x++) {
      const sx = Math.floor(cx - half + x / zoom);
      const sy = Math.floor(cy - half + y / zoom);
      if (sx < 0 || sy < 0 || sx >= m.meta.width || sy >= m.meta.height) continue;
      for (let k = 0; k < 3; k++) out[(y * w * zoom + x) * 3 + k] = Math.min(255, m.rgb[(sy * m.meta.width + sx) * 3 + k] * 1.6);
    }
  return encodePng(out, w * zoom, w * zoom, 3);
}

async function satellite() {
  const m = await loadMosaic();
  if (!m) return (report.satellite = 'no Sentinel mosaic cached');
  const sites = {
    gorakghata: [21.5195, 91.973, 2400, 3],
    adinath: [21.527, 91.974, 1400, 4],
    plant: [21.701, 91.882, 3000, 2],
    coalyard: [21.7, 91.876, 1200, 4],
    port: [21.692, 91.858, 4500, 2],
    sonadia: [21.487, 91.882, 6000, 1],
    westcoast: [21.6, 91.865, 8000, 1],
    matarbariWest: [21.715, 91.855, 6000, 1],
    kastura: [21.446, 91.974, 3000, 2],
    fsru: [21.585, 91.83, 7000, 1],
    channelNorth: [21.65, 91.985, 6000, 1],
    // candidates for the shapla bil and the old arch bridge (GEOGRAPHY_PLAN.md D3), and real features found in the data
    bilHoanak: [21.6035, 91.911, 1200, 4],
    bilShaplapur: [21.6, 91.99, 1600, 3],
    pondMatarbari: [21.73, 91.917, 1600, 3],
    bridgeDhighiRoad: [21.5235, 91.9658, 600, 6],
    bridgeBaraMoheshkhali: [21.5313, 91.9579, 600, 6],
    windFarm: [21.508, 92.004, 2000, 3],
    nazirartek: [21.425, 91.98, 2000, 3],
    northEnd: [21.795, 91.905, 3000, 2],
  };
  for (const [name, [lat, lon, size, zoom]] of Object.entries(sites)) await writeFile(`${OUT}${name}.png`, crop(m, lat, lon, size, zoom));
  // the whole area, one pixel per 40 m
  const step = 4;
  const w = Math.floor(m.meta.width / step);
  const h = Math.floor(m.meta.height / step);
  const small = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let k = 0; k < 3; k++) small[(y * w + x) * 3 + k] = Math.min(255, m.rgb[((y * step) * m.meta.width + x * step) * 3 + k] * 1.6);
  await writeFile(`${OUT}overview.png`, encodePng(small, w, h, 3));
  report.satellite = { scene: m.name, tiles: m.meta.tiles, crops: Object.keys(sites) };
}

await mkdir(OUT, { recursive: true });
await elevation();
await landcover();
await canopy();
await osm();
await satellite();
await writeFile(`${OUT}audit.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, (k, v) => (Array.isArray(v) && v.length > 25 ? [...v.slice(0, 25), `… ${v.length - 25} more`] : v), 1));
