// Where a real place (WGS84 lat/lon) lies in the world, and back. The world is the real map at 1:3
// (GEOGRAPHY_PLAN.md §5.1): distances on the ground shrink three times, heights and objects keep their size.
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

/** Metres east and north of the origin, on the ground (not shrunk). */
export function toGround(lat: number, lon: number): { east: number; north: number } {
  const [east, north] = forward(lat, lon);
  return { east, north: north - NORTH0 };
}

/** The real place at `east`, `north` metres from the origin. */
export function fromGround(east: number, north: number): LatLon {
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
