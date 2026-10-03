import { fbm } from '../core/noise';
import { clamp, smoothstep } from '../core/mathx';

// Where land and water are. The terrain mesh, the water field and every placement read these,
// so the boat, the trees and the riverbed always agree.

export const WATER_Y = 0;
/** World extent along the river (it flows toward −z). */
export const WORLD_Z0 = 460;
export const WORLD_Z1 = -3340;
/** Half extent across the river. */
export const WORLD_U = 2600;
/** The boat's journey; it loops through a mist fade at the end. */
export const JOURNEY_Z0 = 320;
export const JOURNEY_Z1 = -2960;

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
  [-3340, 70, 4.5],
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
  { z: 210, side: 1, inland: 40, radius: 75 },
  { z: -160, side: -1, inland: 35, radius: 70 },
  { z: -430, side: -1, inland: 55, radius: 85 },
  { z: -780, side: 1, inland: 38, radius: 80 },
  { z: -1060, side: 1, inland: 60, radius: 70 },
  { z: -1420, side: -1, inland: 36, radius: 85 },
  { z: -1720, side: 1, inland: 45, radius: 75 },
  { z: -2080, side: -1, inland: 40, radius: 80 },
  { z: -2380, side: 1, inland: 50, radius: 85 },
  { z: -2730, side: -1, inland: 38, radius: 75 },
];

export interface Point2 {
  x: number;
  z: number;
}

export const VILLAGE_CENTERS: readonly Point2[] = VILLAGES.map((v) => ({
  x: riverX(v.z) + v.side * (halfWidth(v.z) + 18 + v.inland),
  z: v.z,
}));

/** One pond per village, behind the houses. */
export const PONDS: readonly (Point2 & { r: number })[] = VILLAGES.map((v, i) => ({
  x: VILLAGE_CENTERS[i].x + v.side * v.radius * 1.15,
  z: v.z + (i % 2 ? 22 : -22),
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

/** Height of the floodplain (fields, village mounds) ignoring the river. */
export function landLevel(x: number, z: number): number {
  let h = 1.8 + (fbm(x * 0.003, z * 0.003, 3, 11) - 0.5) * 0.9;
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
