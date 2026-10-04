// Where a real place (WGS84 lat/lon) lies in the world, and back. The world is the real map at 1:3
// (GEOGRAPHY_PLAN.md §5.1): distances on the ground shrink three times, heights and objects keep their size.
// On the compact map (the user's compact tourism Moheshkhali) the ground is also drawn together where nobody
// looks: the places people come for keep the 1:3 map's scale, the rural and empty stretches between them are
// squeezed (`WARP`), and the far edges are cut off (`CROP`). One continuous world still: the warp only shrinks.
//
// The ground is mapped by a transverse Mercator projection centred on the origin's meridian (Krüger's
// series, Karney 2011): over the whole area (±25 km) its scale differs from 1 by less than 10 ppm, so a
// metre east is a metre wherever it is measured. The world keeps the scene's frame: +x west, +z north,
// y up (the river ran south down −z; `env/astro.ts` relies on it).
//
// The bake scripts import this file too (Node strips the types), so the data and the scene agree.

/** The map is drawn at 1:MAP_SCALE across the ground. */
export const MAP_SCALE = 3;

/** The world's origin: the landward end of Gorakghata jetty (OSM way 43107027). */
export const ORIGIN = { lat: 21.5182, lon: 91.9716 } as const;

export interface LatLon {
  lat: number;
  lon: number;
}

const RAD = Math.PI / 180;
// WGS84
const A = 6378137;
const F = 1 / 298.257223563;
const N = F / (2 - F);
const E = Math.sqrt(F * (2 - F));
/** Rectifying radius. */
const RECT = (A / (1 + N)) * (1 + N ** 2 / 4 + N ** 4 / 64);
const ALPHA = [
  N / 2 - (2 * N ** 2) / 3 + (5 * N ** 3) / 16 + (41 * N ** 4) / 180,
  (13 * N ** 2) / 48 - (3 * N ** 3) / 5 + (557 * N ** 4) / 1440,
  (61 * N ** 3) / 240 - (103 * N ** 4) / 140,
  (49561 * N ** 4) / 161280,
];
const BETA = [
  N / 2 - (2 * N ** 2) / 3 + (37 * N ** 3) / 96 - N ** 4 / 360,
  N ** 2 / 48 + N ** 3 / 15 - (437 * N ** 4) / 1440,
  (17 * N ** 3) / 480 - (37 * N ** 4) / 840,
  (4397 * N ** 4) / 161280,
];
const DELTA = [
  2 * N - (2 * N ** 2) / 3 - 2 * N ** 3 + (116 * N ** 4) / 45,
  (7 * N ** 2) / 3 - (8 * N ** 3) / 5 - (227 * N ** 4) / 45,
  (56 * N ** 3) / 15 - (136 * N ** 4) / 35,
  (4279 * N ** 4) / 630,
];

/** Transverse Mercator on a meridian (the origin's unless given): [east, north] in metres from the equator. */
function forward(lat: number, lon: number, lon0: number = ORIGIN.lon): [number, number] {
  const phi = lat * RAD;
  const dl = (lon - lon0) * RAD;
  const s = Math.sin(phi);
  const t = Math.sinh(Math.atanh(s) - E * Math.atanh(E * s));
  const xi = Math.atan2(t, Math.cos(dl));
  const eta = Math.atanh(Math.sin(dl) / Math.sqrt(1 + t * t));
  let east = eta;
  let north = xi;
  for (let j = 1; j <= 4; j++) {
    east += ALPHA[j - 1] * Math.cos(2 * j * xi) * Math.sinh(2 * j * eta);
    north += ALPHA[j - 1] * Math.sin(2 * j * xi) * Math.cosh(2 * j * eta);
  }
  return [RECT * east, RECT * north];
}

const NORTH0 = forward(ORIGIN.lat, ORIGIN.lon)[1];

// ---------- the compact map's warp ----------
//
// Each axis of the plain 1:3 world (x west, z north, its metres) is drawn at a scale that changes from stretch to
// stretch: 1 round the places people come for, less across the rural and empty ground between them. The scales
// ease from one to the next over EASE m, so slopes do not kink at the joins; the origin (Gorakghata jetty) stays.

/** Where each stretch begins (plain world m) and the scale it is drawn at, from −∞ upward. */
interface Axis {
  breaks: readonly number[];
  scales: readonly number[];
}
/** West–east: the far mainland, the channel and both its banks, the island's west lowland, its west coast with Matarbari's plant and port, the open Bay. */
const AXIS_X: Axis = { breaks: [-1300, 1600, 2750, 4300], scales: [0.35, 1, 0.4, 1, 0.3] };
/** South–north: Cox's Bazar, Gorakghata–Adinath–Sonadia, the island's rural middle and its hills, Matarbari, the north. */
const AXIS_Z: Axis = { breaks: [-1300, 1000, 5600, 7900], scales: [0.4, 1, 0.3, 1, 0.3] };
/** How far the scale takes to change from one stretch to the next (plain world m). */
const EASE = 200;
/** The plain world's extent the compact map keeps (plain world m); beyond it the map is cut off. */
export const CROP = { x0: -2600, x1: 5600, z0: -3600, z1: 8000 } as const;

/** One axis's warp as a table every STEP m over [MIN, MAX] (plain): forward by interpolation, back by search. */
const STEP = 5;
const MIN = -12000;
const MAX = 16000;
function axisWarp(a: Axis): { fwd: (v: number) => number; inv: (v: number) => number } {
  const scaleAt = (v: number) => {
    let s = a.scales[0];
    a.breaks.forEach((b, i) => {
      const t = Math.min(1, Math.max(0, (v - b + EASE / 2) / EASE));
      s += (a.scales[i + 1] - a.scales[i]) * t * t * (3 - 2 * t);
    });
    return s;
  };
  const n = Math.round((MAX - MIN) / STEP) + 1;
  const table = new Float64Array(n);
  for (let i = 1; i < n; i++) table[i] = table[i - 1] + (scaleAt(MIN + (i - 0.5) * STEP)) * STEP;
  // the origin stays where it is
  const zero = table[Math.round(-MIN / STEP)];
  for (let i = 0; i < n; i++) table[i] -= zero;
  const fwd = (v: number) => {
    const f = (Math.min(MAX, Math.max(MIN, v)) - MIN) / STEP;
    const i = Math.min(n - 2, Math.floor(f));
    return table[i] + (table[i + 1] - table[i]) * (f - i);
  };
  const inv = (w: number) => {
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (table[mid] <= w) lo = mid;
      else hi = mid;
    }
    const t = (w - table[lo]) / Math.max(1e-9, table[hi] - table[lo]);
    return MIN + (lo + Math.min(1, Math.max(0, t))) * STEP;
  };
  return { fwd, inv };
}
const WARP_X = axisWarp(AXIS_X);
const WARP_Z = axisWarp(AXIS_Z);

/** A point of the plain 1:3 world, where it lies on the compact map (what was laid out on the plain map keeps its place). */
export function plain(x: number, z: number): { x: number; z: number } {
  return { x: WARP_X.fwd(x), z: WARP_Z.fwd(z) };
}

/** A plain 1:3 world north (z), on the compact map (the warp's axes are separate). */
export function plainZ(z: number): number {
  return WARP_Z.fwd(z);
}

/** How much the compact map shrinks the ground round (x, z) of its own (1 where it keeps the 1:3 scale), per axis. */
export function squeeze(x: number, z: number): { x: number; z: number } {
  const px = WARP_X.inv(x);
  const pz = WARP_Z.inv(z);
  return { x: (WARP_X.fwd(px + 1) - WARP_X.fwd(px - 1)) / 2, z: (WARP_Z.fwd(pz + 1) - WARP_Z.fwd(pz - 1)) / 2 };
}

/** Plain ground metres (east, north) to the compact map's, and back. */
const warpGround = (east: number, north: number) => ({ east: -WARP_X.fwd(-east / MAP_SCALE) * MAP_SCALE, north: WARP_Z.fwd(north / MAP_SCALE) * MAP_SCALE });
const unwarpGround = (east: number, north: number) => ({ east: -WARP_X.inv(-east / MAP_SCALE) * MAP_SCALE, north: WARP_Z.inv(north / MAP_SCALE) * MAP_SCALE });

/** The compact map's extent in its ground metres (east from the origin, north from it). */
export const CROP_GROUND = (() => {
  const a = warpGround(-CROP.x1 * MAP_SCALE, CROP.z0 * MAP_SCALE);
  const b = warpGround(-CROP.x0 * MAP_SCALE, CROP.z1 * MAP_SCALE);
  return { east0: a.east, east1: b.east, north0: a.north, north1: b.north };
})();

/** Metres east and north of the origin, on the compact map's ground (not shrunk by MAP_SCALE). */
export function toGround(lat: number, lon: number): { east: number; north: number } {
  const [east, north] = forward(lat, lon);
  return warpGround(east, north - NORTH0);
}

/** The real place at `east`, `north` metres from the origin on the compact map's ground. */
export function fromGround(warpedEast: number, warpedNorth: number): LatLon {
  const { east, north } = unwarpGround(warpedEast, warpedNorth);
  const xi = (north + NORTH0) / RECT;
  const eta = east / RECT;
  let xi1 = xi;
  let eta1 = eta;
  for (let j = 1; j <= 4; j++) {
    xi1 -= BETA[j - 1] * Math.sin(2 * j * xi) * Math.cosh(2 * j * eta);
    eta1 -= BETA[j - 1] * Math.cos(2 * j * xi) * Math.sinh(2 * j * eta);
  }
  const chi = Math.asin(Math.sin(xi1) / Math.cosh(eta1));
  let phi = chi;
  for (let j = 1; j <= 4; j++) phi += DELTA[j - 1] * Math.sin(2 * j * chi);
  return { lat: phi / RAD, lon: ORIGIN.lon + Math.atan2(Math.sinh(eta1), Math.cos(xi1)) / RAD };
}

/** Where a real place lies in the world (x west, z north, metres of the world). */
export function toWorld(lat: number, lon: number): { x: number; z: number } {
  const g = toGround(lat, lon);
  return { x: -g.east / MAP_SCALE, z: g.north / MAP_SCALE };
}

/** The real place under a point of the world. */
export function toLatLon(x: number, z: number): LatLon {
  return fromGround(-x * MAP_SCALE, z * MAP_SCALE);
}

/** UTM (WGS84, northern hemisphere) for a real place: its zone and easting and northing in metres (the GIS readout). */
export function toUtm(lat: number, lon: number): { zone: number; east: number; north: number } {
  const zone = Math.floor((lon + 180) / 6) + 1;
  const [east, north] = forward(lat, lon, zone * 6 - 183);
  const K0 = 0.9996;
  return { zone, east: 500000 + K0 * east, north: K0 * north };
}
