import { fbm } from '../core/noise';
import { clamp, smoothstep } from '../core/mathx';

// Where land and water are. The terrain mesh, the water field and every placement read these,
// so the boat, the trees and the riverbed always agree.

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
  // the salt workers' villages on the coast
  { z: -3640, side: -1, inland: 70, radius: 70 },
  { z: -3980, side: 1, inland: 90, radius: 65 },
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

/** How far the coast has taken over from the river country at z: 0 upstream, 1 on the coastal flats. */
export function coastal(z: number): number {
  return smoothstep(COAST_Z0, COAST_Z1, z);
}

/** Height of the floodplain (fields, village mounds) ignoring the river. */
export function landLevel(x: number, z: number): number {
  let h = 1.8 + (fbm(x * 0.003, z * 0.003, 3, 11) - 0.5) * 0.9;
  // toward the sea the land sinks to low, level flats, a little above the monsoon's water
  const c = coastal(z);
  if (c > 0) h += (0.95 + (fbm(x * 0.01, z * 0.01, 2, 61) - 0.5) * 0.12 - h) * c;
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

/** Salt pans at (x, z): on the low coastal flats, back from the bank and clear of the villages and backwaters (0..1). */
export function saltPan(x: number, z: number): number {
  const c = coastal(z);
  if (c <= 0) return 0;
  const u = x - riverX(z);
  const side = u >= 0 ? 1 : -1;
  const inland = Math.abs(u) - edgeHalfWidth(z, side);
  if (inland < 8 || nearBackwater(x, z, 6)) return 0;
  return c * smoothstep(10, 24, inland) * smoothstep(1.25, 1.8, villageDistance(x, z)) * smoothstep(1100, 800, inland);
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
