// The baked map (public/geo/, made by scripts/geo/bake.mjs) loaded before anything is built: this module
// awaits its files at the top level, so everything that imports it (world/geography.ts and through it the
// whole scene) can ask about the ground synchronously. ≈2 MB, deflated.
//
// The grid is 30 m on the ground, 10 m in the 1:3 world. Rows run north to south, columns west to east;
// in the world x points west and z north (src/geo/project.ts), so a column further east lies at smaller x.

import { MAP_SCALE } from './project';
import type { Constituent } from './tide';

/** What a cell of ground is (bake.mjs KIND). */
export const KIND = { land: 0, mangrove: 1, tidal: 2, sea: 3, inland: 4 } as const;
export type Kind = (typeof KIND)[keyof typeof KIND];
/** What covers it (bake.mjs COVER). */
export const COVER = { none: 0, tree: 1, shrub: 2, grass: 3, crop: 4, built: 5, bare: 6, sand: 7, mud: 8, marsh: 9, mangrove: 10, saltpan: 11, pond: 12, water: 13 } as const;
export type Cover = (typeof COVER)[keyof typeof COVER];
/** What a building is (bake.mjs BUILDING). */
export const BUILDING = { house: 0, pucca: 1, mosque: 2, temple: 3, pagoda: 4, school: 5, civic: 6, commercial: 7, industrial: 8 } as const;
export type BuildingKind = (typeof BUILDING)[keyof typeof BUILDING];
const MODELLED = 0x80;

interface Manifest {
  grid: { spacing: number; east0: number; north1: number; width: number; height: number };
  layers: Record<string, { file: string; codes?: Record<string, number> }>;
  tide: { amplitudeScale: number; lowWater: number; constituents: Record<string, Constituent> };
  attribution: string[];
}

export interface Place {
  id: string;
  name: string;
  lat: number;
  lon: number;
  source: string;
  confidence: 'high' | 'medium' | 'low' | 'model';
  /** Where it lies in the world. */
  world: { x: number; z: number };
}

/** A line from OpenStreetMap in world metres: x, z pairs (a site's outline closes on its first point). */
export interface GeoLine {
  k: 'road' | 'rail' | 'waterway' | 'structure' | 'power' | 'site';
  /** The OSM tag value: highway=…, waterway=…, man_made=…, power=…; a site's kind (plant, ash_pond, port, substation). */
  t?: string;
  n?: string;
  bridge?: 1;
  /** Volts, for power lines and substations. */
  v?: number;
  points: Float32Array;
}

const base = new URL('geo/', document.baseURI);

async function json<T>(file: string): Promise<T> {
  const res = await fetch(new URL(file, base));
  if (!res.ok) throw new Error(`geo/${file}: ${res.status}`);
  return (await res.json()) as T;
}

async function inflated(file: string): Promise<ArrayBuffer> {
  const res = await fetch(new URL(file, base));
  if (!res.ok || !res.body) throw new Error(`geo/${file}: ${res.status}`);
  return new Response(res.body.pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer();
}

async function load() {
  const manifest = await json<Manifest>('manifest.json');
  for (const [name, codes] of [
    ['kind', KIND],
    ['cover', COVER],
    ['buildings', BUILDING],
  ] as const) {
    const baked = manifest.layers[name].codes ?? {};
    for (const [k, v] of Object.entries(codes)) if (baked[k] !== v) throw new Error(`geo/manifest.json: ${name} code ${k} is ${baked[k]}, the scene expects ${v}`);
  }
  const [terrain, kind, level, cover, canopy, vectors, channel, places, buildings] = await Promise.all([
    inflated(manifest.layers.terrain.file),
    inflated(manifest.layers.kind.file),
    inflated(manifest.layers.level.file),
    inflated(manifest.layers.cover.file),
    inflated(manifest.layers.canopy.file),
    inflated(manifest.layers.vectors.file),
    json<{ points: [number, number, number, number][] }>(manifest.layers.channel.file),
    json<(Omit<Place, 'world'> & { world: { x: number; z: number } })[]>(manifest.layers.places.file),
    inflated(manifest.layers.buildings.file),
  ]);
  return {
    manifest,
    terrain: new Int16Array(terrain),
    kind: new Uint8Array(kind),
    level: new Int16Array(level),
    cover: new Uint8Array(cover),
    canopy: new Uint8Array(canopy),
    vectors: JSON.parse(new TextDecoder().decode(vectors)) as {
      lines: { k: GeoLine['k']; t?: string; n?: string; bridge?: 1; v?: number; p: number[] }[];
      towers: number[];
      nodes: { t: 'crane' | 'chimney' | 'wind_turbine'; mw?: number; p: [number, number] }[];
    },
    channel: channel.points,
    places,
    buildings: new DataView(buildings),
  };
}

let data: Awaited<ReturnType<typeof load>>;
try {
  data = await load();
} catch (err) {
  // nothing can be built without the map: say so where the loader is
  const box = document.getElementById('err');
  if (box) {
    box.textContent = 'দুঃখিত, মানচিত্রের ডেটা লোড করা গেল না। পাতাটি আবার লোড করে দেখুন।';
    box.hidden = false;
  }
  throw err;
}

const G = data.manifest.grid;
/** Grid cells across and down, and world metres per cell. */
export const GRID_W = G.width;
export const GRID_H = G.height;
export const CELL = G.spacing / MAP_SCALE;

/** The baked area in the world: x from x0 (east edge) to x1 (west edge), z from z0 (south) to z1 (north). */
export const WORLD = {
  x0: -(G.east0 + G.width * G.spacing) / MAP_SCALE,
  x1: -G.east0 / MAP_SCALE,
  z0: (G.north1 - G.height * G.spacing) / MAP_SCALE,
  z1: G.north1 / MAP_SCALE,
} as const;

/** Fractional cell column of a world x, cell centres at whole numbers. */
export function fcol(x: number): number {
  return (-x * MAP_SCALE - G.east0) / G.spacing - 0.5;
}
/** Fractional cell row of a world z, cell centres at whole numbers. */
export function frow(z: number): number {
  return (G.north1 - z * MAP_SCALE) / G.spacing - 0.5;
}

/** The world point at the centre of a cell. */
export function cellCentre(c: number, r: number): { x: number; z: number } {
  return { x: -(G.east0 + (c + 0.5) * G.spacing) / MAP_SCALE, z: (G.north1 - (r + 0.5) * G.spacing) / MAP_SCALE };
}

/**
 * The cell index under a world point. Off the map the nearest edge cell answers: the map's edges cut through
 * the sea in the west and the mainland in the east, and each carries on as it is beyond them.
 */
export function cellAt(x: number, z: number): number {
  const c = Math.min(G.width - 1, Math.max(0, Math.round(fcol(x))));
  const r = Math.min(G.height - 1, Math.max(0, Math.round(frow(z))));
  return r * G.width + c;
}

/** Whether a world point lies on the baked map. */
export function onMap(x: number, z: number): boolean {
  const c = fcol(x);
  const r = frow(z);
  return c >= -0.5 && r >= -0.5 && c <= G.width - 0.5 && r <= G.height - 0.5;
}

const { terrain, kind, level, cover, canopy } = data;

/** The baked ground's height (m about mean sea level), bilinear between cell centres; the edge's beyond the map. */
export function heightAt(x: number, z: number): number {
  const fc = Math.min(G.width - 1.0001, Math.max(0, fcol(x)));
  const fr = Math.min(G.height - 1.0001, Math.max(0, frow(z)));
  const c = Math.floor(fc);
  const r = Math.floor(fr);
  const tx = fc - c;
  const ty = fr - r;
  const i = r * G.width + c;
  const a = terrain[i] * (1 - tx) + terrain[i + 1] * tx;
  const b = terrain[i + G.width] * (1 - tx) + terrain[i + G.width + 1] * tx;
  return (a * (1 - ty) + b * ty) / 10;
}

/** What the ground is at a world point (nearest cell). */
export function kindAt(x: number, z: number): Kind {
  return (kind[cellAt(x, z)] & ~MODELLED) as Kind;
}

/** Whether the height here was modelled (tidal flats, mangrove floors, water beds) rather than measured. */
export function modelledAt(x: number, z: number): boolean {
  return (kind[cellAt(x, z)] & MODELLED) !== 0;
}

/** What covers the ground at a world point. */
export function coverAt(x: number, z: number): Cover {
  return cover[cellAt(x, z)] as Cover;
}

/** Trees at a world point: how tall (m, 90th percentile) and how much of the ground they cover (0..1). */
export function canopyAt(x: number, z: number): { height: number; cover: number } {
  const i = cellAt(x, z);
  return { height: canopy[i * 2], cover: canopy[i * 2 + 1] / 255 };
}

/** The surface of inland water at a world point (m), as the DEM measured it, or null where there is none. */
export function inlandSurfaceAt(x: number, z: number): number | null {
  const i = cellAt(x, z);
  return (kind[i] & ~MODELLED) !== KIND.inland ? null : level[i] / 10;
}

/** The raw layers, for code that walks the grid itself (cell index = row · GRID_W + column). */
export const LAYERS = { terrain, kind, level, cover, canopy } as const;

/** Mean low water at the satellite's passes (m, about MSL), how much the gauge's tide was scaled up, and its harmonic constants. */
export const TIDE_BAKE = data.manifest.tide;

/** The Moheshkhali channel's middle, mouth to Badarkhali, every 20 m of the world: [x, z, west half-width, east half-width]. */
export const CHANNEL_POINTS: readonly (readonly [number, number, number, number])[] = data.channel;

/** The landmarks (scripts/geo/places.mjs), with their world points. */
export const PLACES: readonly Place[] = data.places.map((p) => ({ ...p, world: p.world }));

export function place(id: string): Place {
  const p = PLACES.find((q) => q.id === id);
  if (!p) throw new Error(`no place ${id} in geo/places.json`);
  return p;
}

/** OpenStreetMap's lines in world metres (baked in ground decimetres about the origin). */
export const LINES: readonly GeoLine[] = data.vectors.lines.map((l) => {
  const points = new Float32Array(l.p.length);
  for (let k = 0; k < l.p.length; k += 2) {
    points[k] = -l.p[k] / 10 / MAP_SCALE;
    points[k + 1] = l.p[k + 1] / 10 / MAP_SCALE;
  }
  return { k: l.k, t: l.t, n: l.n, bridge: l.bridge, v: l.v, points };
});

/** Power towers, world x, z pairs. */
export const TOWERS: Float32Array = Float32Array.from(data.vectors.towers, (v, k) => (k % 2 === 0 ? -v : v) / 10 / MAP_SCALE);

/** Single things OSM marks as points (the cranes at the berths, chimneys, wind turbines with their rating), at their world points. */
export const NODES: readonly { t: 'crane' | 'chimney' | 'wind_turbine'; mw?: number; x: number; z: number }[] = data.vectors.nodes.map((n) => ({
  t: n.t,
  mw: n.mw,
  x: -n.p[0] / 10 / MAP_SCALE,
  z: n.p[1] / 10 / MAP_SCALE,
}));

/** The data sources to credit (manifest.attribution). */
export const ATTRIBUTION: readonly string[] = data.manifest.attribution;

/**
 * The buildings on the map (bake.mjs bakeBuildings: a ninth of the real ones, every important one), at their
 * 1:3 places and real size: centre, length along `yaw` (a rotation about y: the long side's direction is
 * (cos yaw, −sin yaw)), width, kind, mapped storeys (0: not mapped), and whether OSM names or tags it.
 */
export const BUILDINGS = (() => {
  const v = data.buildings;
  const n = v.byteLength / 17;
  const out = { count: n, x: new Float32Array(n), z: new Float32Array(n), l: new Float32Array(n), w: new Float32Array(n), yaw: new Float32Array(n), kind: new Uint8Array(n), levels: new Uint8Array(n), important: new Uint8Array(n) };
  for (let i = 0; i < n; i++) {
    const o = i * 17;
    out.x[i] = v.getFloat32(o, true);
    out.z[i] = v.getFloat32(o + 4, true);
    out.l[i] = v.getUint16(o + 8, true) / 10;
    out.w[i] = v.getUint16(o + 10, true) / 10;
    out.yaw[i] = v.getInt16(o + 12, true) / 100;
    out.kind[i] = v.getUint8(o + 14);
    out.levels[i] = v.getUint8(o + 15);
    out.important[i] = v.getUint8(o + 16);
  }
  return out;
})();
