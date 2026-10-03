import { fbm } from '../core/noise';
import { smoothstep } from '../core/mathx';

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

export function halfWidth(z: number): number {
  return 118 + 30 * Math.sin(z * 0.0013 + 0.7) + 10 * Math.sin(z * 0.0051 + 2.0);
}

/** Unit vector (x, z) pointing downstream. */
export function downstream(z: number): [number, number] {
  const s = riverSlope(z);
  const l = Math.hypot(s, 1);
  return [-s / l, -1 / l];
}

/** A char: a sandbar island in the river, where kash grows. `u` is across the river from its centre line. */
export interface Char {
  z: number;
  u: number;
  halfLen: number;
  halfWid: number;
}

export const CHARS: readonly Char[] = [
  { z: 40, u: -50, halfLen: 130, halfWid: 24 },
  { z: -540, u: 52, halfLen: 200, halfWid: 30 },
  { z: -1190, u: -48, halfLen: 170, halfWid: 27 },
  { z: -1860, u: 44, halfLen: 220, halfWid: 31 },
  { z: -2520, u: -44, halfLen: 150, halfWid: 24 },
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

/** Height of the sandbars at (z, u), or −99 away from them. */
export function charHeight(z: number, u: number): number {
  let best = -99;
  for (const c of CHARS) {
    const dz = (z - c.z) / c.halfLen;
    const du = (u - c.u) / c.halfWid;
    if (Math.abs(dz) > 1.4 || Math.abs(du) > 1.4) continue;
    const wobble = 1 + (fbm(z * 0.02 + c.u, u * 0.03, 2, 9) - 0.5) * 0.6;
    const e = (dz * dz + du * du) * wobble;
    if (e < 1) best = Math.max(best, -1.8 + 2.75 * Math.sqrt(1 - e));
  }
  return best;
}

export function terrainHeight(x: number, z: number): number {
  const u = x - riverX(z);
  const side = u >= 0 ? 1 : -1;
  const au = Math.abs(u);
  const we = edgeHalfWidth(z, side);
  let h: number;
  if (au < we) {
    const t = au / we;
    h = -1.0 - 5.5 * (1 - t * t);
  } else {
    // eroded bank: steep near the top, as the river undercuts it
    const b = Math.min((au - we) / BANK_RUN, 1);
    const p = 1 - Math.pow(1 - b, 2.2);
    h = -1.0 + (landLevel(x, z) + 1.0) * p;
  }
  const ch = charHeight(z, u);
  if (ch > h) h = ch;
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

/** The boat's lateral offset: it keeps to the far side of each char. */
export function boatLane(z: number): number {
  let u = 10 * Math.sin(z * 0.004);
  for (const c of CHARS) {
    const d = (z - c.z) / (c.halfLen + 170);
    u += -Math.sign(c.u) * 44 * Math.exp(-d * d * 2.5);
  }
  return u;
}
