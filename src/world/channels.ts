import { smoothstep } from '../core/mathx';
import { HILL_STREAM, SLUICE, WATER_LEVEL, type Pt } from './plan';
import { RIVER } from './waterways';

// The small channels cut into the land (geography.ts carves them, after the land and before the waterways): the
// hill stream's gully down the steep wooded hill's face to the river, stepped into ledges its water falls over;
// and the drain that takes the fields' water out to the river through the sluice in its levee. Plain shapes only:
// this module must not import geography.ts (which imports it).

/** A channel's line (a point every STEP m), its width and depth (m), whether its bed is stepped into ledges, and its box. */
export interface Channel {
  name: 'stream' | 'drain';
  pts: Pt[];
  width: number;
  depth: number;
  /** Its bed's ledges' height (m), or 0 for an even bed. */
  ledge: number;
  /** The least its bed may come down to (m): never below the river's water, or it would stand as a dark hollow. */
  floorMin: number;
  box: { x0: number; z0: number; x1: number; z1: number };
}

const STEP = 1;

function resample(points: readonly Pt[]): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i + 1 < points.length; i++) {
    const [ax, az] = points[i];
    const [bx, bz] = points[i + 1];
    const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / STEP));
    for (let k = 0; k < n; k++) out.push([ax + ((bx - ax) * k) / n, az + ((bz - az) * k) / n]);
  }
  out.push(points[points.length - 1]);
  return out;
}

function channel(name: Channel['name'], points: readonly Pt[], width: number, depth: number, ledge: number, floorMin: number): Channel {
  const pts = resample(points);
  const m = width / 2 + 2;
  const xs = pts.map((p) => p[0]);
  const zs = pts.map((p) => p[1]);
  return { name, pts, width, depth, ledge, floorMin, box: { x0: Math.min(...xs) - m, z0: Math.min(...zs) - m, x1: Math.max(...xs) + m, z1: Math.max(...zs) + m } };
}

/** The point of the river's north bank the drain runs out at, and the way out to the water (unit). */
function drainMouth(): { x: number; z: number; ox: number; oz: number } {
  const [x, z] = SLUICE.fields;
  const f = RIVER.frame(x, z);
  const s = f ? f.s : RIVER.line.nearestS(x, z);
  const side = f ? f.side : 1;
  const p = RIVER.beside(s, side, RIVER.half(s) + SLUICE.back);
  const w = RIVER.beside(s, side, 0);
  const l = Math.hypot(p.x - w.x, p.z - w.z) || 1;
  return { x: p.x, z: p.z, ox: (w.x - p.x) / l, oz: (w.z - p.z) / l };
}

/** Where the sluice stands: its headwall's middle on the river's bank, and the way it faces (toward the water, radians). */
export const SLUICE_SITE = (() => {
  const m = drainMouth();
  return { x: m.x, z: m.z, face: Math.atan2(m.ox, m.oz), out: { x: m.ox, z: m.oz } };
})();

/**
 * How far either side of the sluice's middle its outfall lies open `a` m out from the headwall toward the river
 * (m): the wing walls' line, flaring out (falls.ts builds them on it; geography's bund keeps its earth outside it).
 */
export function sluiceOutfall(a: number): number {
  return SLUICE.width / 2 + 1.1 + 0.45 * a;
}

export const CHANNELS: readonly Channel[] = [
  channel('stream', HILL_STREAM.points, HILL_STREAM.width, 0.75, 1.1, WATER_LEVEL + 0.15),
  // (its bed above the river's highest, so the fields' water always falls out into it, even in the rains)
  channel('drain', [SLUICE.fields, [SLUICE_SITE.x, SLUICE_SITE.z]], SLUICE.width, SLUICE.depth, 0, WATER_LEVEL + 1.0),
];

const hit = { ch: CHANNELS[0], d: 0, x: 0, z: 0, t: 0 };

/** The channel whose line (x, z) is nearest, within its width and a margin; its point there and how far along (0..1). The result is reused. */
export function channelAt(x: number, z: number, margin = 1.5): typeof hit | null {
  let best = Infinity;
  for (const c of CHANNELS) {
    const b = c.box;
    if (x < b.x0 || x > b.x1 || z < b.z0 || z > b.z1) continue;
    const pts = c.pts;
    for (let i = 0; i + 1 < pts.length; i++) {
      const [ax, az] = pts[i];
      const [bx, bz] = pts[i + 1];
      const dx = bx - ax;
      const dz = bz - az;
      const l2 = dx * dx + dz * dz || 1;
      const u = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2));
      const px = ax + dx * u;
      const pz = az + dz * u;
      const d = Math.hypot(x - px, z - pz);
      if (d < best && d < c.width / 2 + margin) {
        best = d;
        hit.ch = c;
        hit.d = d;
        hit.x = px;
        hit.z = pz;
        hit.t = (i + u) / (pts.length - 1);
      }
    }
  }
  return Number.isFinite(best) ? hit : null;
}

/**
 * The ground at a point `d` m from a channel's line, its land there `h` and on its line `centre`: cut down to the
 * channel's bed (stepped into ledges for the stream), its sides sloping up to the land.
 */
export function carve(c: Channel, d: number, h: number, centre: number): number {
  let bed = centre - c.depth;
  if (c.ledge > 0) {
    // flat treads and short steep risers, the water falling over each
    const k = bed / c.ledge;
    const base = Math.floor(k);
    bed = (base + smoothstep(0.8, 1, k - base)) * c.ledge;
  }
  bed = Math.max(bed, c.floorMin);
  const side = smoothstep(c.width / 2 - 0.5, c.width / 2 + 0.9, d);
  return Math.min(h, bed + (h - bed) * side);
}
