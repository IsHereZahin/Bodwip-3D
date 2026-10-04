import { fbm } from '../core/noise';
import { clamp, smoothstep } from '../core/mathx';

// Where land and water are. The terrain mesh, the water field and every placement read these,
// so the boat, the trees and the riverbed always agree.
// The world is Moheshkhali, off Cox's Bazar, scaled down about 1:5 along its length (heights kept near
// their own): the boat goes south down the Moheshkhali channel. On its right bank (west, +x) lies the
// island, the only hilly island in Bangladesh: a strip of villages along its east coast, Gorakghata with
// its jetty under Adinath hill, the forested hill range down its middle and east, its low tract of paddy
// and salt fields to the west cut off by the Kohelia (Matarbari and Dhalghata beyond it), and its beaches
// on the Bay; its north coast faces the Kutubdia channel, and across a canal off its south end lies
// crescent Sonadia, dunes and mangroves at the channel's mouth. On the left bank (east) is the mainland:
// villages and fields, the shapla bil, and toward the mouth the flats of Cox's Bazar with hills beyond.

/** World extent along the river (it flows toward −z). */
export const WORLD_Z0 = 460;
export const WORLD_Z1 = -4300;
/** Half extent across the river. */
export const WORLD_U = 2600;
/** The boat's journey; it loops through a mist fade at the end. */
export const JOURNEY_Z0 = 320;
export const JOURNEY_Z1 = -3920;
/** Downstream of COAST_Z0 the river country gives way to the coast: by COAST_Z1 the land is low, level salt flats. */
export const COAST_Z0 = -3280;
export const COAST_Z1 = -3600;

export function riverX(z: number): number {
  return 120 * Math.sin(z * 0.0021 + 0.5) + 55 * Math.sin(z * 0.0047 + 1.3) + 18 * Math.sin(z * 0.011 + 2.1);
}

/** d riverX / dz. */
export function riverSlope(z: number): number {
  return (
    120 * 0.0021 * Math.cos(z * 0.0021 + 0.5) +
    55 * 0.0047 * Math.cos(z * 0.0047 + 1.3) +
    18 * 0.011 * Math.cos(z * 0.011 + 2.1)
  );
}

/**
 * The river's reaches from upstream to downstream: [z, half-width, depth of its bed below the toe of the
 * banks]. It runs broad and shallow where the chars lie and pinches into short, deep narrows between them;
 * past the last char it stays narrow. Between rows it eases along a cosine.
 */
const REACHES: readonly (readonly [number, number, number])[] = [
  [460, 75, 4.5],
  [330, 80, 4.5],
  [220, 110, 3.2],
  [150, 135, 1.8],
  [-90, 135, 1.8],
  [-215, 48, 5.5],
  [-330, 140, 2.2],
  [-740, 145, 2.2],
  [-880, 42, 6],
  [-1010, 130, 2.6],
  [-1360, 135, 1.3],
  [-1500, 52, 5.5],
  [-1640, 145, 2.6],
  [-2080, 145, 2.0],
  [-2225, 100, 1.1],
  [-2370, 130, 2.0],
  [-2670, 125, 2.4],
  [-2800, 45, 5.5],
  [-3000, 42, 5.5],
  [-3150, 60, 5],
  // nearing the sea it opens out into a broad, slow estuary
  [-3330, 95, 4.5],
  [-3520, 170, 3.8],
  [-3800, 240, 3.4],
  [-4300, 300, 3.2],
];

function reach(z: number, column: 1 | 2): number {
  const R = REACHES;
  if (z >= R[0][0]) return R[0][column];
  for (let i = 1; i < R.length; i++) {
    if (z >= R[i][0]) {
      const t = (R[i - 1][0] - z) / (R[i - 1][0] - R[i][0]);
      const w = (1 - Math.cos(Math.PI * t)) / 2;
      return R[i - 1][column] + (R[i][column] - R[i - 1][column]) * w;
    }
  }
  return R[R.length - 1][column];
}

export function halfWidth(z: number): number {
  return reach(z, 1) + 3 * Math.sin(z * 0.0051 + 2.0);
}

/** How deep the bed lies below the toe of the banks (m): shallow in the broad reaches, deep in the narrows. */
export function riverDepth(z: number): number {
  return reach(z, 2);
}

/** Mid-river surface current (m/s): the same water runs faster where the river narrows. */
export function streamSpeed(z: number): number {
  return 0.85 * clamp(Math.sqrt(105 / halfWidth(z)), 0.75, 1.45);
}

/** Unit vector (x, z) pointing downstream. */
export function downstream(z: number): [number, number] {
  const s = riverSlope(z);
  const l = Math.hypot(s, 1);
  return [-s / l, -1 / l];
}

/**
 * A char: a sandbar island in the river, where kash grows. `u` is across the river from its centre line;
 * `peak` is how high its crown stands (a shoal under water has a negative one).
 */
export interface Char {
  z: number;
  u: number;
  halfLen: number;
  halfWid: number;
  peak?: number;
}

export const CHARS: readonly Char[] = [
  { z: 40, u: -50, halfLen: 130, halfWid: 24 },
  { z: -540, u: 52, halfLen: 200, halfWid: 30 },
  { z: -1190, u: -48, halfLen: 170, halfWid: 27 },
  { z: -1860, u: 44, halfLen: 220, halfWid: 31 },
  { z: -2520, u: -44, halfLen: 150, halfWid: 24 },
];

/** Sandbanks just under the surface in the broad reaches, where the water shows its bed; off the boat's way. */
export const SHOALS: readonly Char[] = [
  { z: 0, u: -105, halfLen: 60, halfWid: 15, peak: -0.35 },
  { z: -560, u: 108, halfLen: 70, halfWid: 14, peak: -0.35 },
  { z: -1250, u: 95, halfLen: 70, halfWid: 14, peak: -0.3 },
  { z: -2195, u: 50, halfLen: 80, halfWid: 18, peak: -0.3 },
  { z: -2265, u: -58, halfLen: 60, halfWid: 14, peak: -0.4 },
];

export interface Village {
  z: number;
  side: 1 | -1;
  /** Distance of its centre inland from the bank. */
  inland: number;
  radius: number;
}

export const VILLAGES: readonly Village[] = [
  { z: 130, side: 1, inland: 40, radius: 75 },
  { z: -160, side: -1, inland: 35, radius: 70 },
  { z: -430, side: -1, inland: 55, radius: 85 },
  { z: -780, side: 1, inland: 38, radius: 80 },
  { z: -1060, side: 1, inland: 60, radius: 70 },
  { z: -1420, side: -1, inland: 36, radius: 85 },
  { z: -1720, side: 1, inland: 45, radius: 75 },
  { z: -2080, side: -1, inland: 40, radius: 80 },
  // Gorakghata, the island's town, below Adinath hill (its jetty in world/moheshkhali.ts)
  { z: -2440, side: 1, inland: 45, radius: 95 },
  { z: -2730, side: -1, inland: 38, radius: 75 },
  // the salt workers' village on the mainland's coast, and the fishermen's on Sonadia
  { z: -3640, side: -1, inland: 70, radius: 70 },
  { z: -3820, side: 1, inland: 560, radius: 55 },
];

export interface Point2 {
  x: number;
  z: number;
}

export const VILLAGE_CENTERS: readonly Point2[] = VILLAGES.map((v) => ({
  x: riverX(v.z) + v.side * (halfWidth(v.z) + 18 + v.inland),
  z: v.z,
}));

/** One pond per village: behind the houses on the mainland, beside them on the island (behind them rise its hills). */
export const PONDS: readonly (Point2 & { r: number })[] = VILLAGES.map((v, i) => ({
  x: VILLAGE_CENTERS[i].x + (v.side > 0 ? 0 : v.side * v.radius * 1.15),
  z: v.z + (v.side > 0 ? (i % 2 ? 1 : -1) * v.radius * 1.15 : i % 2 ? 22 : -22),
  r: 13 + (i % 3) * 2,
}));

const BANK_RUN = 16;

/** Half-width to this bank's water edge, wobbling so the banks are not ruled lines. */
export function edgeHalfWidth(z: number, side: number): number {
  return halfWidth(z) + (fbm(z * 0.012, side > 0 ? 3.3 : 7.9, 2, 5) - 0.5) * 12;
}

/** Normalised distance to the nearest village centre (1 = its radius). */
export function villageDistance(x: number, z: number): number {
  let best = 99;
  for (let i = 0; i < VILLAGES.length; i++) {
    const dz = z - VILLAGE_CENTERS[i].z;
    if (Math.abs(dz) > VILLAGES[i].radius * 3) continue;
    const d = Math.hypot(x - VILLAGE_CENTERS[i].x, dz) / VILLAGES[i].radius;
    if (d < best) best = d;
  }
  return best;
}

/** How far the coast has taken over from the river country at z: 0 upstream, 1 on the coastal flats. */
export function coastal(z: number): number {
  return smoothstep(COAST_Z0, COAST_Z1, z);
}

// ---------- Moheshkhali island (the right bank) ----------

/** The island's coasts: where its north coast meets the channel (z), its south coast across the canal from Sonadia (z), its west coast on the Bay (u). */
export const ISLAND = { northZ: 235, southZ: -3440, westU: 1950 } as const;
/** Sonadia: a crescent of dunes and mangroves off the island's south end (its circle's middle and radius, in z and u). */
export const SONADIA = { z: -3880, u: 880, r: 400 } as const;
/** Adinath hill (Mainak pahar) above Gorakghata: where its top is (z, u), how high, and the level ground the temple stands on. */
export const ADINATH = (() => {
  const z = -2290;
  return { z, u: edgeHalfWidth(z, 1) + 225, top: 46, flat: 15, radius: 105 };
})();
/**
 * Gorakghata's landmarks (built in world/moheshkhali.ts): the jetty reaching out into the channel from the
 * town's bank (where it leaves the bank, its length and width), the brick buildings along the bank road by
 * it (a strip of the bank: z from–to, how far inland), the stair up Adinath hill from the edge of the town to
 * the temple's terrace (from–to, world), and the Rakhine pagoda behind the town.
 */
export const GORAKGHATA = (() => {
  const z = -2468;
  const edge = edgeHalfWidth(z, 1);
  const at = (zz: number, inland: number) => ({ x: riverX(zz) + edgeHalfWidth(zz, 1) + inland, z: zz });
  return {
    jetty: { x: riverX(z) + edge + 4, z, length: 58, width: 3.2 },
    town: { z0: -2515, z1: -2440, inland0: 6, inland1: 34 },
    stair: { from: at(-2372, 128), to: at(ADINATH.z - 10, 214) },
    pagoda: { ...at(-2560, 125), r: 10 },
  };
})();

/** Cox's Bazar's buildings across the channel's mouth on the mainland: z from–to, u from–to (left of the channel). */
export const COXS_BAZAR = { z0: -4050, z1: -4290, u0: -420, u1: -1300 } as const;

/** The dry-fish yards (shutki): by Sonadia's fishing village, and on the mainland's point at the channel's mouth. */
export const SHUTKI_YARDS: readonly { x: number; z: number; ry: number; rows: number }[] = (() => {
  const i = VILLAGES.findIndex((v) => v.side > 0 && v.z < -3700);
  const mz = -3920;
  return [
    ...(i >= 0 ? [{ x: VILLAGE_CENTERS[i].x + 40, z: VILLAGE_CENTERS[i].z + 30, ry: 0.4, rows: 6 }] : []),
    { x: riverX(mz) - edgeHalfWidth(mz, -1) - 70, z: mz, ry: -0.3, rows: 7 },
  ];
})();

/** Adinath hill's top and its face toward the channel, kept open (grass and scrub) so the temple and its stair show from the water: trees keep off it. */
export function onTempleHill(x: number, z: number): boolean {
  const u = x - riverX(z);
  const d = Math.hypot(u - ADINATH.u, z - ADINATH.z);
  return d < ADINATH.flat + 30 || (d < ADINATH.radius && u < ADINATH.u + 10);
}

/** Ground the landmarks stand on (with `margin` m round it): no huts, trees or tall grass there. */
export function onLandmark(x: number, z: number, margin = 0): boolean {
  const g = GORAKGHATA;
  const u = x - riverX(z);
  const inland = u - edgeHalfWidth(z, 1);
  if (z < g.town.z1 + margin && z > g.town.z0 - margin && inland > g.town.inland0 - 4 - margin && inland < g.town.inland1 + margin) return true;
  if (Math.hypot(x - g.pagoda.x, z - g.pagoda.z) < g.pagoda.r + margin) return true;
  for (const y of SHUTKI_YARDS) if (Math.hypot(x - y.x, z - y.z) < 14 + margin) return true;
  if (Math.hypot(u - ADINATH.u, z - ADINATH.z) < ADINATH.flat + 3 + margin) return true;
  // along the stair
  const sx = g.stair.to.x - g.stair.from.x;
  const sz = g.stair.to.z - g.stair.from.z;
  const t = Math.max(0, Math.min(1, ((x - g.stair.from.x) * sx + (z - g.stair.from.z) * sz) / (sx * sx + sz * sz)));
  return Math.hypot(x - g.stair.from.x - sx * t, z - g.stair.from.z - sz * t) < 2.6 + margin;
}

/** The Kohelia: a tidal river down the island's low west, from its head (z) to the sea. */
const KOHELIA = { head: -650, u: 1330 } as const;

/** The island's west coast (u) at z: it narrows toward its south end. */
export function islandWestCoast(z: number): number {
  return westCoastU(z);
}

/** The island's north coast (z) at u. */
export function islandNorthCoast(u: number): number {
  return ISLAND.northZ - 0.13 * Math.max(u - 150, 0) + 20 * Math.sin(u * 0.009);
}

function westCoastU(z: number): number {
  const taper = smoothstep(-2500, ISLAND.southZ, z);
  return ISLAND.westU + 130 * Math.sin(z * 0.0012 + 0.9) + 60 * Math.sin(z * 0.0037 + 2.1) - taper * 850;
}

/** How far inside the island (z, u) lies from its nearest coast on the sea (m; negative off it). */
export function islandCoast(z: number, u: number): number {
  const north = islandNorthCoast(u);
  const south = ISLAND.southZ + 0.08 * Math.max(u - 200, 0) + 15 * Math.sin(u * 0.011 + 1);
  return Math.min(north - z, westCoastU(z) - u, z - south);
}

/** The Kohelia's centre line (u) at z, its half-width there, and how far (z, u) is from it (+∞ above its head). */
function koheliaDistance(z: number, u: number): { d: number; hw: number } {
  if (z > KOHELIA.head + 30) return { d: Infinity, hw: 0 };
  const c = KOHELIA.u + 60 * Math.sin(z * 0.004 + 0.7) + 25 * Math.sin(z * 0.011 + 1.9);
  const hw = 5 + 22 * smoothstep(KOHELIA.head, ISLAND.southZ, z);
  return { d: Math.hypot(u - c, Math.max(0, z - KOHELIA.head)), hw };
}

/** The line along the top of the island's hills (u) at z. */
function hillCrestU(z: number): number {
  return edgeHalfWidth(z, 1) + 420 + 70 * Math.sin(z * 0.0013 + 0.8) + 30 * Math.sin(z * 0.0041 + 2.0);
}

/**
 * The island's hills: a range of steep, forested hills about 50–85 m high down its middle and along its east
 * coast, many knolls and saddles, ravines down their flanks, steeper toward the channel; they die away at its
 * north and south ends and give way to the khals that wind along their foot. Adinath hill stands apart by the
 * coast, its level top the temple's.
 */
export function hillHeight(x: number, z: number): number {
  const u = x - riverX(z);
  if (u < 100) return 0;
  const rise = smoothstep(ISLAND.northZ - 60, ISLAND.northZ - 420, z) * smoothstep(ISLAND.southZ + 60, ISLAND.southZ + 520, z);
  let h = 0;
  if (rise > 0) {
    const d = u - hillCrestU(z);
    const t = d < 0 ? -d / 220 : d / 560;
    if (t < 1) {
      const dome = 0.5 + 0.5 * Math.cos(Math.PI * t);
      const peak = 54 + 20 * Math.sin(z * 0.0029 + 1.7) + 12 * Math.sin(z * 0.0071 + 0.3);
      const massif = 0.45 + 0.75 * fbm(x * 0.0055, z * 0.0055, 3, 101);
      const ravine = Math.abs(fbm(x * 0.014, z * 0.014, 2, 103) * 2 - 1);
      h = rise * peak * dome * massif * (0.68 + 0.32 * Math.min(1, ravine * 2.2));
    }
  }
  const a = Math.hypot(u - ADINATH.u, z - ADINATH.z);
  if (a < ADINATH.radius) {
    const k = a < ADINATH.flat ? 1 : 0.5 + 0.5 * Math.cos((Math.PI * (a - ADINATH.flat)) / (ADINATH.radius - ADINATH.flat));
    h = Math.max(h, ADINATH.top * k);
  }
  // the creeks along their foot keep their valleys
  if (h > 0) {
    for (let i = 0; i < KHALS.length; i++) {
      const k = KHALS[i];
      if (k.side < 0 || z > Math.max(k.z0, k.z1) + 40 || z < Math.min(k.z0, k.z1) - 40) continue;
      const gap = Math.abs(u - khalLine(i, z));
      if (gap < 80) h *= smoothstep(18, 80, gap);
    }
  }
  return h;
}

/** How far inside Sonadia's crescent (z, u) lies (m; negative off it, −999 well clear): the circle with a bite out of its south-west side, opening onto the Bay. */
function sonadiaInside(z: number, u: number): number {
  const r1 = Math.hypot(z - SONADIA.z, u - SONADIA.u);
  if (r1 > SONADIA.r + 120) return -999;
  const r2 = Math.hypot(z - (SONADIA.z - 270), u - (SONADIA.u + 240));
  return Math.min(SONADIA.r - r1, r2 - SONADIA.r * 0.82);
}

/** Sonadia's ground at (z, u): low dunes inside the crescent, its beaches, and the sea round it (−99 well clear of it). */
function sonadiaHeight(z: number, u: number): number {
  const inside = sonadiaInside(z, u);
  if (inside < -900) return -99;
  if (inside < 0) return Math.max(-3.2, 0.45 + inside * 0.05);
  const dunes = 1.4 + 3 * fbm(z * 0.02, u * 0.02, 3, 111) * fbm(z * 0.006 + 4, u * 0.006, 2, 113);
  return 0.45 + (dunes - 0.45) * smoothstep(0, 70, inside);
}

/** The island's ground (u > 0): its low tract and coastal strip, its hills, the Kohelia, and its beaches down to the sea. */
function islandLevel(x: number, z: number, u: number, base: number): number {
  const coast = islandCoast(z, u);
  // the low tract lies a little above the monsoon's water, lower toward the west coast
  let h = base - 0.4 * smoothstep(500, 1300, u);
  h += hillHeight(x, z);
  const k = koheliaDistance(z, u);
  if (k.d < k.hw + 10) {
    const bed = -2.2 * (1 - smoothstep(0.3, 1, k.d / Math.max(k.hw, 1)));
    h = Math.min(h, k.d < k.hw ? bed : bed + (h - bed) * smoothstep(k.hw, k.hw + 10, k.d));
  }
  // its beaches on the Bay (and on the Kutubdia channel, and the canal to Sonadia), and the sea floor beyond
  if (coast < 90) {
    const beach = 0.4 + 0.3 * fbm(x * 0.02, z * 0.02, 2, 109);
    h = coast > 0 ? beach + (h - beach) * smoothstep(0, 90, coast) : Math.max(-3.2, beach + coast * 0.05);
  }
  return Math.max(h, sonadiaHeight(z, u));
}

/** How much of (x, z) is hill forest (0..1): the island's hills and the mainland's. */
export function forestCover(x: number, z: number): number {
  const u = x - riverX(z);
  return smoothstep(0.8, 5, u > 0 ? hillHeight(x, z) : mainlandHills(x, z, u));
}

/** How much of (x, z) is beach or dune sand (0..1): along the island's coasts on the sea, and all over Sonadia. */
export function sandCover(x: number, z: number): number {
  const u = x - riverX(z);
  if (u <= 0) return 0;
  const coast = islandCoast(z, u);
  const beach = coast > -60 ? smoothstep(70, 18, coast) : 0;
  return Math.max(beach, smoothstep(-25, 25, sonadiaInside(z, u)));
}

/**
 * Where mangroves grow (0..1): on the tidal mud along the channel toward its two mouths, along the Kohelia,
 * on the island's north shore and round Sonadia's inner side, a little above and below the water's reach.
 */
export function mangroveZone(x: number, z: number, h: number): number {
  const reach = smoothstep(-0.35, 0, h) * smoothstep(1.1, 0.5, h);
  if (reach <= 0) return 0;
  const u = x - riverX(z);
  const ends = Math.max(smoothstep(-200, 150, z), smoothstep(-3100, -3500, z));
  let near = 0;
  if (Math.abs(u) - edgeHalfWidth(z, u >= 0 ? 1 : -1) < 40) near = ends;
  if (u > 0) {
    const k = koheliaDistance(z, u);
    if (k.d < k.hw + 30) near = Math.max(near, 0.9);
    if (islandCoast(z, u) < 50 && z > ISLAND.northZ - 600) near = Math.max(near, 0.8);
    const s = sonadiaInside(z, u);
    if (s > -40 && s < 60 && z > SONADIA.z - 150) near = Math.max(near, 0.9);
  }
  return reach * near * (0.55 + 0.45 * fbm(x * 0.03, z * 0.03, 2, 117));
}

/**
 * The mainland's hills, far off on the left bank toward Cox's Bazar (0 elsewhere): a range, falling away again
 * before the world's east and south edges, where the ground ends and they would stand cut off like a wall.
 */
function mainlandHills(x: number, z: number, u: number): number {
  if (u > -1350) return 0;
  const across = smoothstep(-1350, -1850, u) * smoothstep(-WORLD_U, -WORLD_U + 380, u);
  const along = smoothstep(-800, -1700, z) * smoothstep(WORLD_Z1, WORLD_Z1 + 450, z);
  return across * along * (50 + 35 * fbm(x * 0.004, z * 0.004, 3, 107));
}

/** Height of the floodplain (fields, village mounds) ignoring the river. */
export function landLevel(x: number, z: number): number {
  let h = 1.8 + (fbm(x * 0.003, z * 0.003, 3, 11) - 0.5) * 0.9;
  const u = x - riverX(z);
  // toward the sea the mainland sinks to low, level flats, a little above the monsoon's water; the island has its own ground
  const c = u < 0 ? coastal(z) : 0;
  if (c > 0) h += (0.95 + (fbm(x * 0.01, z * 0.01, 2, 61) - 0.5) * 0.12 - h) * c;
  if (u > 0) h = islandLevel(x, z, u, h);
  else h += mainlandHills(x, z, u);
  // villages sit on raised mounds (bhita) above the monsoon floods
  h += 1.25 * smoothstep(1.5, 0.55, villageDistance(x, z));
  return h;
}

function barHeight(c: Char, z: number, u: number): number {
  const dz = (z - c.z) / c.halfLen;
  const du = (u - c.u) / c.halfWid;
  if (Math.abs(dz) > 1.4 || Math.abs(du) > 1.4) return -99;
  const wobble = 1 + (fbm(z * 0.02 + c.u, u * 0.03, 2, 9) - 0.5) * 0.6;
  const e = (dz * dz + du * du) * wobble;
  if (e >= 1) return -99;
  return -1.8 + ((c.peak ?? 0.95) + 1.8) * Math.sqrt(1 - e);
}

/** Height of the sandbars (chars and shoals) at (z, u), or −99 away from them. */
export function charHeight(z: number, u: number): number {
  let best = -99;
  for (const c of CHARS) best = Math.max(best, barHeight(c, z, u));
  for (const c of SHOALS) best = Math.max(best, barHeight(c, z, u));
  return best;
}

// ---------- backwaters: khals, the shapla bil and the channels that join it to the river ----------

/** A khal: a small canal leaving the river and running out behind the bank into the fields, where it peters out. */
export interface Khal {
  side: 1 | -1;
  /** Where it leaves the river, and where it ends (z). */
  z0: number;
  z1: number;
  /** How far beyond the river's edge at its mouth it runs once clear of the mouth (m). */
  inland: number;
  halfWidth: number;
  depth: number;
  seed: number;
}

/** Each leaves the river where it is narrow and runs out behind a broader reach, clear of the villages. */
export const KHALS: readonly Khal[] = [
  { side: -1, z0: 290, z1: 0, inland: 112, halfWidth: 5, depth: 1.3, seed: 1.3 },
  { side: 1, z0: -215, z1: -600, inland: 160, halfWidth: 5.5, depth: 1.4, seed: 2.9 },
  { side: 1, z0: -1500, z1: -1250, inland: 150, halfWidth: 5, depth: 1.3, seed: 5.7 },
  { side: -1, z0: -2860, z1: -3150, inland: 72, halfWidth: 4, depth: 1.1, seed: 7.2 },
  { side: 1, z0: -2950, z1: -3300, inland: 78, halfWidth: 3.5, depth: 1.0, seed: 8.8 },
];
/** Metres from the mouth over which a khal turns out of the river, and the width of its sloping banks. */
const KHAL_MOUTH = 110;
const KHAL_BANK = 5;
const KHAL_EDGE = KHALS.map((k) => edgeHalfWidth(k.z0, k.side));

/** Offset from the river's centre line of khal `i`'s centre line at z. */
function khalLine(i: number, z: number): number {
  const k = KHALS[i];
  const d = Math.abs(z - k.z0);
  const out = smoothstep(0, KHAL_MOUTH, d);
  const wobble = 9 * Math.sin(d * 0.017 + k.seed) + 4 * Math.sin(d * 0.043 + k.seed * 2.3);
  return k.side * (KHAL_EDGE[i] - 3 + (k.inland + 3) * out + wobble * out);
}

interface KhalSpot {
  /** Distance from the centre line, its half-width and depth there. */
  dist: number;
  hw: number;
  depth: number;
}

const khalSpot: KhalSpot = { dist: 0, hw: 0, depth: 0 };

/** The khal nearest (z, u) within reach of its banks, or null. */
function nearestKhal(z: number, u: number): KhalSpot | null {
  let found = false;
  let bestGap = Infinity;
  for (let i = 0; i < KHALS.length; i++) {
    const k = KHALS[i];
    if (Math.sign(u) !== k.side) continue;
    const dir = Math.sign(k.z1 - k.z0);
    const len = Math.abs(k.z1 - k.z0);
    // along it from the mouth: past its end it closes in a rounded tip; behind its mouth is the river
    const along = (z - k.z0) * dir;
    if (along < 0 || along > len + 20) continue;
    const a = Math.min(along, len);
    const zc = k.z0 + dir * a;
    const c = khalLine(i, zc);
    const slope = (khalLine(i, zc + 1) - khalLine(i, zc - 1)) / 2;
    const s = a / len;
    const dist = Math.hypot(Math.abs(u - c) / Math.sqrt(1 + slope * slope), Math.max(0, along - len));
    // a little flared at the mouth, narrowing and shoaling toward its end
    const hw = k.halfWidth * (1 + 0.7 * smoothstep(30, 0, a)) * (1 - 0.7 * smoothstep(0.65, 1, s));
    const gap = dist - hw;
    if (gap > KHAL_BANK || gap >= bestGap) continue;
    bestGap = gap;
    found = true;
    khalSpot.dist = dist;
    khalSpot.hw = hw;
    khalSpot.depth = k.depth * (1 - 0.8 * smoothstep(0.6, 1, s));
  }
  return found ? khalSpot : null;
}

/** Where khal `i` runs at `s` (0 its mouth .. 1 its end): the world point on its centre line, its heading and half-width. */
export function khalPoint(i: number, s: number): { x: number; z: number; heading: number; halfWidth: number } {
  const k = KHALS[i];
  const dir = Math.sign(k.z1 - k.z0);
  const z = k.z0 + (k.z1 - k.z0) * s;
  const x = riverX(z) + khalLine(i, z);
  const x2 = riverX(z + dir) + khalLine(i, z + dir);
  const a = Math.abs(z - k.z0);
  const hw = k.halfWidth * (1 + 0.7 * smoothstep(30, 0, a)) * (1 - 0.7 * smoothstep(0.65, 1, s));
  return { x, z, heading: Math.atan2(x2 - x, dir), halfWidth: hw };
}

/** The shapla bil: a broad, shallow wetland behind the left bank, joined to the river by a channel at each end. */
export const BIL = { z: -960, u: -290, halfLen: 280, halfWid: 115 } as const;

/** How far (z, u) is from the bil's middle, measured in its own irregular outline (below 1 is water). */
export function bilReach(z: number, u: number): number {
  const dz = (z - BIL.z) / BIL.halfLen;
  const du = (u - BIL.u) / BIL.halfWid;
  const a = Math.atan2(du, dz);
  const outline = 1 + 0.12 * Math.sin(3 * a + 1.1) + 0.07 * Math.sin(5 * a + 2.4) + 0.12 * (fbm(z * 0.008, u * 0.008, 2, 77) - 0.5);
  return Math.hypot(dz, du) / outline;
}

function nearBil(z: number, u: number): boolean {
  return Math.abs(z - BIL.z) < BIL.halfLen * 1.55 && Math.abs(u - BIL.u) < BIL.halfWid * 1.6;
}

/** 1 on the bil's low, wet rim (just above its water), 0 elsewhere: wet meadow rather than bare bank. */
export function bilMarsh(z: number, u: number): number {
  if (!nearBil(z, u)) return 0;
  const e = bilReach(z, u);
  return smoothstep(0.98, 1.04, e) * smoothstep(1.5, 1.35, e);
}

/** Depth of the bil's water at (z, u): an undulating bed with a deeper hollow, shoaling to the reedy edge. */
export function bilDepth(z: number, u: number): number {
  const e = bilReach(z, u);
  if (e >= 1) return 0;
  const bed = 0.75 + 0.9 * fbm(z * 0.011 + 3, u * 0.011, 3, 81) + 0.6 * Math.exp(-(((z + 1060) / 70) ** 2 + ((u + 320) / 45) ** 2));
  return bed * smoothstep(1, 0.72, e) + 0.04;
}

/**
 * The boat's way through the bil, [z, u]: from the river through a channel cut in the bank, among the lilies,
 * and back out to the river below the char. Her lane eases onto it upstream and off it downstream.
 */
const BIL_ROUTE: readonly (readonly [number, number])[] = [
  [-600, -110],
  [-640, -152],
  [-690, -205],
  [-745, -262],
  [-820, -300],
  [-900, -280],
  [-985, -318],
  [-1070, -290],
  [-1150, -262],
  [-1215, -220],
  [-1262, -160],
  [-1305, -112],
  [-1360, -105],
];
const ROUTE_IN = BIL_ROUTE[0][0];
const ROUTE_OUT = BIL_ROUTE[BIL_ROUTE.length - 1][0];
const ROUTE_BLEND = 120;
/** Half-width and depth of the channels the route runs in where it crosses land. */
const CHANNEL_HALF = 9;
const CHANNEL_DEPTH = 1.6;

/** Offset of the route from the river's centre line at z (within the route's span), along a Catmull-Rom curve. */
function routeU(z: number): number {
  const P = BIL_ROUTE;
  let i = 0;
  while (i < P.length - 2 && z < P[i + 1][0]) i++;
  const t = clamp((P[i][0] - z) / (P[i][0] - P[i + 1][0]), 0, 1);
  const p0 = P[Math.max(i - 1, 0)][1];
  const p1 = P[i][1];
  const p2 = P[i + 1][1];
  const p3 = P[Math.min(i + 2, P.length - 1)][1];
  const t2 = t * t;
  const t3 = t2 * t;
  return 0.5 * (2 * p1 + (p2 - p0) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (3 * p1 - p0 - 3 * p2 + p3) * t3);
}

/** Distance from (z, u) to the route's centre line, or +∞ beyond its span. */
function routeDistance(z: number, u: number): number {
  if (z > ROUTE_IN + 20 || z < ROUTE_OUT - 20) return Infinity;
  const zc = clamp(z, ROUTE_OUT, ROUTE_IN);
  const slope = (routeU(Math.min(ROUTE_IN, zc + 1)) - routeU(Math.max(ROUTE_OUT, zc - 1))) / 2;
  return Math.abs(u - routeU(zc)) / Math.sqrt(1 + slope * slope);
}

/** The span (z) of the boat's way through the bil, from where it leaves the river to where it rejoins it. */
export const BIL_ROUTE_SPAN = { z0: ROUTE_IN, z1: ROUTE_OUT } as const;

/** Offset from the river's centre line of the boat's way through the bil at z (clamped to its span). */
export function routeOffset(z: number): number {
  return routeU(clamp(z, ROUTE_OUT, ROUTE_IN));
}

/** Distance from (x, z) to the middle of the boat's way through the bil (+∞ away from it). */
export function routeGap(x: number, z: number): number {
  return routeDistance(z, x - riverX(z));
}

/**
 * The old bridge (world/bridge.ts) where the boat's way leaves the river for the bil: a humped brick arch
 * carrying the bank's footpath over the channel cut through the bank. Its frame: x along the bridge, across
 * the channel (the path's way); z along the channel, toward the bil (the way the boat goes under it);
 * `angle` turns that frame into the world's (as a rotation about y). Heights are the world's.
 */
export const BRIDGE = (() => {
  const z = -665;
  const x = riverX(z) + routeOffset(z);
  const ahead = { x: riverX(z - 2) + routeOffset(z - 2) - x, z: -2 };
  const angle = Math.atan2(ahead.x, ahead.z);
  return {
    x,
    z,
    angle,
    /** Clear span of the arch and the height it springs from (m); its rise; the arch ring's depth. */
    span: 16,
    springing: 0.3,
    rise: 3.4,
    ring: 0.55,
    /** Between the parapets, and each parapet's thickness and height above the deck. */
    width: 3,
    parapet: 0.28,
    parapetHeight: 0.66,
    /** Half its length, ramps and all, and the height of the deck at its crown. */
    half: 20,
    crown: 4.5,
    /** The bank's height where the ramps come down. */
    bank: 1.8,
  };
})();

/** (x, z) in the bridge's frame: `x` along it, `z` along the channel. */
export function bridgeFrame(x: number, z: number): { x: number; z: number } {
  const dx = x - BRIDGE.x;
  const dz = z - BRIDGE.z;
  const c = Math.cos(BRIDGE.angle);
  const s = Math.sin(BRIDGE.angle);
  return { x: dx * c - dz * s, z: dx * s + dz * c };
}

/** A point of the bridge's frame in the world. */
export function bridgeToWorld(bx: number, bz: number): { x: number; z: number } {
  const c = Math.cos(BRIDGE.angle);
  const s = Math.sin(BRIDGE.angle);
  return { x: BRIDGE.x + bx * c + bz * s, z: BRIDGE.z - bx * s + bz * c };
}

/** Height of the arch's underside at `bx` along the bridge (−∞ beyond the span). */
export function bridgeSoffit(bx: number): number {
  const half = BRIDGE.span / 2;
  if (Math.abs(bx) > half) return -Infinity;
  const r = (half * half + BRIDGE.rise * BRIDGE.rise) / (2 * BRIDGE.rise);
  return BRIDGE.springing + BRIDGE.rise - r + Math.sqrt(r * r - bx * bx);
}

/** Height of the bridge's walking surface at `bx` along it: the hump of the arch, easing down the ramps to the bank. */
export function bridgeDeck(bx: number): number {
  return BRIDGE.bank + (BRIDGE.crown - BRIDGE.bank) * (1 - smoothstep(0, BRIDGE.half, Math.abs(bx)));
}

/** True on the bridge's footprint, ramps and all (with `margin` m round it): nothing grows up through it. */
export function onBridge(x: number, z: number, margin = 0.4): boolean {
  const f = bridgeFrame(x, z);
  return Math.abs(f.x) < BRIDGE.half + margin && Math.abs(f.z) < BRIDGE.width / 2 + BRIDGE.parapet + margin;
}

/** How much of (x, z) is the footpath that crosses the bridge, running on along its line into the fields either side (0..1). */
export function bridgePath(x: number, z: number): number {
  const f = bridgeFrame(x, z);
  const ax = Math.abs(f.x);
  if (ax < BRIDGE.half - 1 || ax > BRIDGE.half + 60) return 0;
  // the path wanders a little where feet have worn it
  const off = f.z - 1.2 * Math.sin(f.x * 0.07) - 0.5 * Math.sin(f.x * 0.19 + 1.3);
  return smoothstep(1.3, 0.6, Math.abs(off)) * smoothstep(BRIDGE.half + 60, BRIDGE.half + 35, ax);
}

/** Ground in and beside the khals, the bil and its channels, or +∞ where none is near. */
function backwaterHeight(x: number, z: number, u: number): number {
  let h = Infinity;
  const k = nearestKhal(z, u);
  if (k) {
    if (k.dist < k.hw) h = -k.depth * smoothstep(1, 0.3, k.dist / k.hw);
    else {
      const b = (k.dist - k.hw) / KHAL_BANK;
      h = landLevel(x, z) * (1 - (1 - b) * (1 - b));
    }
  }
  if (nearBil(z, u)) {
    const e = bilReach(z, u);
    // the water, then a low marshy rim rising slowly to the fields
    if (e < 1) h = Math.min(h, -bilDepth(z, u));
    else if (e < 1.45) h = Math.min(h, -0.04 + (landLevel(x, z) + 0.04) * smoothstep(1, 1.45, e));
  }
  const d = routeDistance(z, u);
  if (d < CHANNEL_HALF + 6) {
    if (d < CHANNEL_HALF) h = Math.min(h, -CHANNEL_DEPTH * smoothstep(1, 0.4, d / CHANNEL_HALF));
    else {
      const b = (d - CHANNEL_HALF) / 6;
      h = Math.min(h, landLevel(x, z) * (1 - (1 - b) * (1 - b)));
    }
  }
  return h;
}

/**
 * True if (x, z) is within `margin` metres of water other than the main river: a khal, the bil or its
 * channels. Placements use it to keep houses and trees out of the backwaters.
 */
export function nearBackwater(x: number, z: number, margin: number): boolean {
  const u = x - riverX(z);
  const k = nearestKhal(z, u);
  if (k && k.dist - k.hw < margin) return true;
  if (nearBil(z, u) && bilReach(z, u) < 1 + margin / BIL.halfWid) return true;
  return routeDistance(z, u) < CHANNEL_HALF + margin;
}

/**
 * Small wetlands (জলা) out in the fields: shallow bowls a few dozen metres across that fill in the rains,
 * spreading over their marshy rims, and shrink to a pool in the dry months. Each is put near a wanted
 * place, as close to the river as it can be without crowding a village, a pond, a khal or the bil.
 */
export const WETLANDS: readonly (Point2 & { r: number })[] = findWetlands();

function findWetlands(): (Point2 & { r: number })[] {
  const wanted: readonly (readonly [number, number, number])[] = [
    [-60, 1, 46],
    [-700, -1, 52],
    [-1650, -1, 58],
    [-2470, 1, 44],
  ];
  const out: (Point2 & { r: number })[] = [];
  for (const [z0, prefer, r] of wanted) {
    let found: (Point2 & { r: number }) | null = null;
    search: for (const side of [prefer, -prefer]) {
      for (const dz of [0, 60, -60, 120, -120]) {
        for (let inland = r + 45; inland < r + 200; inland += 10) {
          const z = z0 + dz;
          const x = riverX(z) + side * (edgeHalfWidth(z, side) + inland);
          // inside the river's field (the water's depth is read from it) and clear of everything wet or built
          if (Math.abs(x) > 600 - r * 1.5) continue;
          if (side > 0 && hillHeight(x, z) > 0.3) continue;
          if (VILLAGES.some((v, i) => Math.hypot(x - VILLAGE_CENTERS[i].x, z - VILLAGE_CENTERS[i].z) < v.radius + r * 1.4 + 15)) continue;
          if (PONDS.some((p) => Math.hypot(x - p.x, z - p.z) < p.r + r * 1.4 + 10)) continue;
          if (nearBackwater(x, z, r * 1.4 + 12)) continue;
          found = { x, z, r };
          break search;
        }
      }
    }
    if (found) out.push(found);
  }
  return out;
}

/** A wetland's irregular outline: its radius in the direction `a`, as a share of `r`. */
function wetlandOutline(w: Point2, a: number): number {
  return 1 + 0.16 * Math.sin(3 * a + w.x * 0.01) + 0.09 * Math.sin(5 * a + w.z * 0.013) + 0.06 * Math.sin(8 * a + 1.3);
}

/** How far (x, z) is from a wetland's middle, measured in its own outline (below 1 is its bowl). */
export function wetlandReach(w: Point2 & { r: number }, x: number, z: number): number {
  const dx = x - w.x;
  const dz = z - w.z;
  return Math.hypot(dx, dz) / (w.r * wetlandOutline(w, Math.atan2(dz, dx)));
}

/** The point at reach `d` from a wetland's middle in the direction `a`. */
export function wetlandPoint(w: Point2 & { r: number }, a: number, d: number): Point2 {
  const k = d * w.r * wetlandOutline(w, a);
  return { x: w.x + Math.cos(a) * k, z: w.z + Math.sin(a) * k };
}

/** The bed of a wetland at reach `d`: an uneven bowl (so its shore wanders at every level), then a marshy rim rising to the fields. */
function wetlandHeight(d: number, land: number, x: number, z: number): number {
  if (d < 1) return -1.0 + 0.9 * d * d + 0.45 * (fbm(x * 0.045, z * 0.045, 2, 67) - 0.5) * (1 - d * d);
  return -0.1 + (land + 0.1) * smoothstep(1, 1.55, d);
}

/** 1 on a wetland's low, wet rim, 0 elsewhere (wet meadow rather than bare ground). */
export function wetlandMarsh(x: number, z: number): number {
  let m = 0;
  for (const w of WETLANDS) {
    if (Math.abs(z - w.z) > w.r * 2.3) continue;
    const d = wetlandReach(w, x, z);
    m = Math.max(m, smoothstep(0.85, 1.0, d) * smoothstep(1.7, 1.45, d));
  }
  return m;
}

/**
 * Salt pans at (x, z) (0..1): on the island's low tract west of its hills (more of it toward the south, all of
 * Matarbari and Dhalghata beyond the Kohelia) and on the mainland's coastal flats toward Cox's Bazar; back
 * from the banks and the beaches, clear of the villages, the backwaters and the hills.
 */
export function saltPan(x: number, z: number): number {
  const u = x - riverX(z);
  const side = u >= 0 ? 1 : -1;
  const inland = Math.abs(u) - edgeHalfWidth(z, side);
  if (inland < 8 || nearBackwater(x, z, 6)) return 0;
  const clear = smoothstep(10, 24, inland) * smoothstep(1.25, 1.8, villageDistance(x, z));
  if (onLandmark(x, z, 8)) return 0;
  if (side < 0) {
    // not under the town
    const c = COXS_BAZAR;
    if (z < c.z0 + 30 && z > c.z1 - 30 && u < c.u0 + 30 && u > c.u1 - 30) return 0;
    return worked(coastal(z) * clear * smoothstep(1100, 800, inland));
  }
  const k = koheliaDistance(z, u);
  if (k.d < k.hw + 12) return 0;
  const low = 1 - smoothstep(0.4, 2.2, hillHeight(x, z));
  const ashore = smoothstep(40, 120, islandCoast(z, u));
  // the tract (the west lowland south of the Kohelia's head, and everything beyond the Kohelia) ends along a
  // wandering line, and over a short way
  const wander = 70 * Math.sin(u * 0.009 + 1.3) + 30 * Math.sin(z * 0.013 + 0.4);
  const south = smoothstep(-1150, -1230, z + wander) * smoothstep(740, 800, u + wander * 0.6);
  const beyond = smoothstep(KOHELIA.u - 70, KOHELIA.u - 20, u + wander * 0.4);
  return worked(clear * low * ashore * Math.max(south, beyond));
}

/** A pan is worked or it is not: a long fade would draw the pans faint through the grass round the tract. */
function worked(v: number): number {
  return smoothstep(0.3, 0.7, v);
}

export function terrainHeight(x: number, z: number): number {
  const u = x - riverX(z);
  const side = u >= 0 ? 1 : -1;
  const au = Math.abs(u);
  const we = edgeHalfWidth(z, side);
  let h: number;
  if (au < we) {
    const t = au / we;
    h = -1.0 - riverDepth(z) * (1 - t * t);
  } else {
    // eroded bank: steep near the top, as the river undercuts it
    const b = Math.min((au - we) / BANK_RUN, 1);
    const p = 1 - Math.pow(1 - b, 2.2);
    h = -1.0 + (landLevel(x, z) + 1.0) * p;
  }
  const ch = charHeight(z, u);
  if (ch > h) h = ch;
  h = Math.min(h, backwaterHeight(x, z, u));
  for (const p of PONDS) {
    if (Math.abs(z - p.z) > p.r * 1.3) continue;
    const d = Math.hypot(x - p.x, z - p.z) / p.r;
    if (d < 1.3) h = Math.min(h, -1.2 + (h + 1.2) * smoothstep(0.7, 1.3, d));
  }
  for (const w of WETLANDS) {
    if (Math.abs(z - w.z) > w.r * 2.1) continue;
    const d = wetlandReach(w, x, z);
    if (d < 1.55) h = Math.min(h, wetlandHeight(d, h, x, z));
  }
  return h;
}

export interface BankInfo {
  /** Across-river offset from the centre line. */
  u: number;
  side: 1 | -1;
  /** Distance inland from the water edge (negative in the river). */
  inland: number;
}

export function bankInfo(x: number, z: number): BankInfo {
  const u = x - riverX(z);
  const side = u >= 0 ? 1 : -1;
  return { u, side, inland: Math.abs(u) - edgeHalfWidth(z, side) - 3 };
}

/** The river's own lane: the far side of each char, kept off the banks through the narrows. River traffic keeps to it. */
export function riverLane(z: number): number {
  let u = 10 * Math.sin(z * 0.004);
  for (const c of CHARS) {
    const d = (z - c.z) / (c.halfLen + 170);
    u += -Math.sign(c.u) * 44 * Math.exp(-d * d * 2.5);
  }
  const room = halfWidth(z) - 16;
  return room * Math.tanh(u / room);
}

/** The hero boat's lateral offset: the river's lane, except where she turns off through the bil and back. */
export function boatLane(z: number): number {
  const river = riverLane(z);
  if (z > ROUTE_IN + ROUTE_BLEND || z < ROUTE_OUT - ROUTE_BLEND) return river;
  const route = routeU(clamp(z, ROUTE_OUT, ROUTE_IN));
  const w = z > ROUTE_IN ? smoothstep(ROUTE_IN + ROUTE_BLEND, ROUTE_IN, z) : z < ROUTE_OUT ? smoothstep(ROUTE_OUT - ROUTE_BLEND, ROUTE_OUT, z) : 1;
  return river + (route - river) * w;
}
