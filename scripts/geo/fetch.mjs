// Fetches the open data for the area into scripts/geo/cache/ (GEOGRAPHY_PLAN.md §6), and records each
// file's source, licence, size, checksum and date in cache/manifest.json.
//
//   node scripts/geo/fetch.mjs                 everything not yet in the cache
//   node scripts/geo/fetch.mjs fabdem osm      only sources whose id starts with one of these
//   node scripts/geo/fetch.mjs --force …       fetch again even if cached
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BBOX, CACHE, OSM_THEMES, SENTINEL, SOURCES } from './config.mjs';
import { get } from './lib/http.mjs';
import { encodePng } from './lib/png.mjs';
import { bboxIn, readWindow, saveWindow } from './lib/raster.mjs';
import { listZip, readZipMember } from './lib/zip.mjs';

const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter', 'https://maps.mail.ru/osm/tools/overpass/api/interpreter'];

const args = process.argv.slice(2);
const force = args.includes('--force');
const wanted = args.filter((a) => !a.startsWith('--'));
const want = (id) => wanted.length === 0 || wanted.some((w) => id.startsWith(w));

const dir = fileURLToPath(CACHE);
const at = (name) => fileURLToPath(new URL(name, CACHE));
const manifestPath = at('manifest.json');
const readManifest = async () => (existsSync(manifestPath) ? JSON.parse(await readFile(manifestPath, 'utf8')) : {});
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

// read just before writing, so two runs fetching different sources side by side keep each other's entries
async function record(id, entry) {
  const manifest = await readManifest();
  manifest[id] = { ...entry, fetched: new Date().toISOString() };
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
}

/** A cached file with no manifest entry (its run's entry was overwritten) gets one rebuilt from the file. */
async function recordCached(id, file, entry) {
  if ((await readManifest())[id]) return;
  const bytes = await readFile(at(file));
  await record(id, { ...entry, file, bytes: bytes.length, sha256: sha256(bytes), rebuilt: true });
}

async function download(url) {
  const res = await get(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

const zipIndex = new Map();
async function zipMember(url, name) {
  if (!zipIndex.has(url)) zipIndex.set(url, await listZip(url));
  const entry = zipIndex.get(url).find((e) => e.name === name);
  if (!entry) throw new Error(`${name} is not in ${url}`);
  return readZipMember(url, entry);
}

async function fetchSource(s) {
  const ext = s.kind === 'window' ? '' : s.kind === 'zip' ? '.tif' : extname(new URL(s.url).pathname) || '.bin';
  const path = at(s.id + ext);
  const file = s.kind === 'window' ? `${s.id}.bin` : s.id + ext;
  if (!force && existsSync(at(file))) {
    await recordCached(s.id, file, { url: s.url, member: s.member, licence: s.licence });
    return console.log(`= ${s.id} (cached)`);
  }
  const t0 = Date.now();
  if (s.kind === 'window') {
    const bbox = bboxIn(s.crs, BBOX);
    const window = await readWindow(s.url, bbox, s.res);
    const meta = await saveWindow(path, window, { source: s.url, crs: s.crs, bbox });
    const bytes = await readFile(`${path}.bin`);
    await record(s.id, { url: s.url, licence: s.licence, file: `${s.id}.bin`, bytes: bytes.length, sha256: sha256(bytes), size: [meta.width, meta.height] });
  } else {
    const bytes = s.kind === 'zip' ? await zipMember(s.url, s.member) : await download(s.url);
    await writeFile(path, bytes);
    await record(s.id, { url: s.url, member: s.member, licence: s.licence, file: s.id + ext, bytes: bytes.length, sha256: sha256(bytes) });
  }
  console.log(`+ ${s.id} (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
}

async function overpass(query) {
  let last;
  for (const endpoint of OVERPASS) {
    try {
      const res = await get(endpoint, { method: 'POST', body: 'data=' + encodeURIComponent(query), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }, 3);
      const text = await res.text();
      if (res.ok && text.startsWith('{')) return text;
      last = new Error(`${endpoint}: ${res.status} ${text.slice(0, 120)}`);
    } catch (err) {
      last = err;
    }
  }
  throw last;
}

async function fetchOsm(theme) {
  const id = `osm-${theme}`;
  const path = at(`${id}.json`);
  if (!force && existsSync(path)) {
    await recordCached(id, `${id}.json`, { url: "Overpass API", licence: "ODbL (© OpenStreetMap contributors)" });
    return console.log(`= ${id} (cached)`);
  }
  const b = BBOX;
  const query = `[out:json][timeout:600][maxsize:1073741824][bbox:${b.south},${b.west},${b.north},${b.east}];(${OSM_THEMES[theme]});out geom;`;
  const text = await overpass(query);
  const json = JSON.parse(text);
  await writeFile(path, text);
  await record(id, { url: 'Overpass API', query, licence: 'ODbL (© OpenStreetMap contributors)', file: `${id}.json`, bytes: Buffer.byteLength(text), sha256: sha256(text), elements: json.elements.length, osmBase: json.osm3s?.timestamp_osm_base });
  console.log(`+ ${id}: ${json.elements.length} elements`);
}

/** The latest clear date that covers the whole area, mosaicked from its MGRS tiles into one true-colour image. */
async function fetchSentinel() {
  const res = await get(SENTINEL.stac, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      collections: [SENTINEL.collection],
      bbox: [BBOX.west, BBOX.south, BBOX.east, BBOX.north],
      datetime: `${SENTINEL.from}T00:00:00Z/${SENTINEL.to}T00:00:00Z`,
      query: { 'eo:cloud_cover': { lt: SENTINEL.maxCloud } },
      limit: 200,
    }),
  });
  const items = (await res.json()).features ?? [];
  const byDate = new Map();
  for (const it of items) {
    const day = it.properties.datetime.slice(0, 10);
    if (!byDate.has(day)) byDate.set(day, new Map());
    byDate.get(day).set(it.properties['grid:code'], it);
  }
  const most = Math.max(0, ...[...byDate.values()].map((m) => m.size));
  const day = [...byDate.keys()].filter((d) => byDate.get(d).size === most).sort().pop();
  if (!day) throw new Error('no clear Sentinel-2 scene found');
  const id = `sentinel-${day}`;
  if (!force && existsSync(at(`${id}.png`))) {
    await recordCached(id, `${id}.png`, { url: SENTINEL.stac, licence: "Copernicus Sentinel data (free; for checking only, not shipped)" });
    return console.log(`= ${id} (cached)`);
  }
  const crs = 'EPSG:32646';
  const bbox = bboxIn(crs, BBOX).map((v) => Math.round(v / 10) * 10);
  let mosaic = null;
  const tiles = [];
  for (const [code, it] of byDate.get(day)) {
    const w = await readWindow(it.assets.visual.href, bbox, 10);
    mosaic ??= { width: w.width, height: w.height, rgb: new Uint8Array(w.width * w.height * 3) };
    for (let i = 0; i < w.width * w.height; i++) {
      const r = w.bands[0][i];
      const g = w.bands[1][i];
      const bl = w.bands[2][i];
      if (r + g + bl === 0 || mosaic.rgb[i * 3] + mosaic.rgb[i * 3 + 1] + mosaic.rgb[i * 3 + 2] > 0) continue;
      mosaic.rgb[i * 3] = r;
      mosaic.rgb[i * 3 + 1] = g;
      mosaic.rgb[i * 3 + 2] = bl;
    }
    tiles.push({ code, id: it.id, datetime: it.properties.datetime, cloud: it.properties['eo:cloud_cover'] });
  }
  const png = encodePng(mosaic.rgb, mosaic.width, mosaic.height, 3);
  await writeFile(at(`${id}.png`), png);
  const meta = { crs, bbox, res: 10, width: mosaic.width, height: mosaic.height, tiles };
  await writeFile(at(`${id}.json`), JSON.stringify(meta, null, 2));
  await record(id, { url: SENTINEL.stac, licence: 'Copernicus Sentinel data (free; for checking only, not shipped)', file: `${id}.png`, bytes: png.length, sha256: sha256(png), tiles });
  console.log(`+ ${id}: ${tiles.length} tiles, ${mosaic.width}×${mosaic.height}`);
}

await mkdir(dir, { recursive: true });
const failures = [];
const attempt = async (id, job) => {
  try {
    await job();
  } catch (err) {
    failures.push(id);
    // undici hides the network error (reset, timeout, DNS) in `cause`
    const cause = err.cause ? ` (${err.cause.code ?? err.cause.message})` : '';
    console.error(`! ${id}: ${err.message}${cause}`);
  }
};
for (const s of SOURCES) if (want(s.id)) await attempt(s.id, () => fetchSource(s));
for (const theme of Object.keys(OSM_THEMES)) if (want(`osm-${theme}`)) await attempt(`osm-${theme}`, () => fetchOsm(theme));
if (want('sentinel')) await attempt('sentinel', fetchSentinel);
if (failures.length) {
  console.error(`failed: ${failures.join(', ')}`);
  process.exitCode = 1;
}
