import { smoothstep } from '../core/mathx';
import { fbm } from '../core/noise';
import { SegmentIndex } from '../core/segmentIndex';
import { BIL_SPEC, BRIDGE_NEAR, CHAR, INTO_BIL, JOURNEY_FROM, KHAL_POINTS, OPENING_NEAR, RIVER_POINTS, SANKO_NEAR, SIDE_KHAL_POINTS, WATER_LEVEL, WORLD, type Pt } from './plan';

// The village's waters (world/plan.ts): the small river, the khal leaving it northward, the side khal through
// the fields, and the shapla bil at the khal's head; and the boat's journey through them. Each waterway is a
// smooth line through its designed points with a width and a depth along it; the ground (geography.ts) cuts
// them in, the water (water.ts) floods them, and everything that stands by a bank asks where the bank is here.
// All of them are one water at one level (WATER_LEVEL).

export { WATER_LEVEL };

/** Spacing of the waterways' points (m). */
const STEP = 2;

/** A smooth line through `points` (Catmull–Rom, centripetal enough at these spacings), `per` samples to a span. */
function spline(points: readonly Pt[], per: number): number[] {
  const out: number[] = [];
  const p = (i: number) => points[Math.max(0, Math.min(points.length - 1, i))];
  for (let i = 0; i < points.length - 1; i++) {
    const [x0, z0] = p(i - 1);
    const [x1, z1] = p(i);
    const [x2, z2] = p(i + 1);
    const [x3, z3] = p(i + 2);
    for (let k = 0; k < per; k++) {
      const t = k / per;
      const t2 = t * t;
      const t3 = t2 * t;
      const f = (a: number, b: number, c: number, d: number) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      out.push(f(x0, x1, x2, x3), f(z0, z1, z2, z3));
    }
  }
  const last = points[points.length - 1];
  out.push(last[0], last[1]);
  return out;
}

/** Resamples a polyline (x, z pairs) every `step` m along it. */
function resample(pts: readonly number[], step: number): number[] {
  const out = [pts[0], pts[1]];
  let carry = 0;
  for (let k = 0; k + 3 < pts.length; k += 2) {
    const ax = pts[k];
    const az = pts[k + 1];
    const len = Math.hypot(pts[k + 2] - ax, pts[k + 3] - az);
    let at = step - carry;
    while (at <= len) {
      out.push(ax + ((pts[k + 2] - ax) * at) / len, az + ((pts[k + 3] - az) * at) / len);
      at += step;
    }
    carry = len - (at - step);
  }
  return out;
}

/** Moving average of a polyline's points over ±`k` points (the ends hold, the window shrinking toward them). */
function smoothLine(pts: number[], k: number): number[] {
  const n = pts.length / 2;
  const out = pts.slice();
  for (let i = 1; i < n - 1; i++) {
    const w = Math.min(k, i, n - 1 - i);
    let x = 0;
    let z = 0;
    for (let j = i - w; j <= i + w; j++) (x += pts[j * 2]), (z += pts[j * 2 + 1]);
    out[i * 2] = x / (2 * w + 1);
    out[i * 2 + 1] = z / (2 * w + 1);
  }
  return out;
}

/** Where a point lies from a line's middle: how far along it (m), how far from it (m), and on which side (+1 left going along it, −1 right). */
export interface LineFrame {
  s: number;
  d: number;
  side: 1 | -1;
}

/** A line of points every STEP m, with its nearest-point lookup out to `reach` m. */
class Line {
  readonly pts: Float64Array;
  readonly count: number;
  readonly length: number;
  private readonly index = new SegmentIndex(24);
  private readonly hit: LineFrame = { s: 0, d: 0, side: 1 };

  constructor(pts: readonly number[], reach: number) {
    this.pts = Float64Array.from(pts);
    this.count = pts.length / 2;
    this.length = (this.count - 1) * STEP;
    for (let i = 0; i < this.count - 1; i++) this.index.add(this.pts[i * 2], this.pts[i * 2 + 1], this.pts[i * 2 + 2], this.pts[i * 2 + 3], 0, reach);
  }

  /** The point `s` m along the line, and its heading there (radians: 0 north, π/2 toward +x, west). */
  at(s: number): { x: number; z: number; heading: number } {
    const P = this.pts;
    const f = Math.min(this.count - 1.0001, Math.max(0, s / STEP));
    const i = Math.floor(f);
    const t = f - i;
    const ax = P[i * 2];
    const az = P[i * 2 + 1];
    const bx = P[i * 2 + 2];
    const bz = P[i * 2 + 3];
    return { x: ax + (bx - ax) * t, z: az + (bz - az) * t, heading: Math.atan2(bx - ax, bz - az) };
  }

  /** Where (x, z) lies from the line, if within its reach; null farther off. The result is reused. */
  frame(x: number, z: number): LineFrame | null {
    const hit = this.index.nearest(x, z);
    if (!hit) return null;
    const P = this.pts;
    const i = hit.index;
    const tx = P[i * 2 + 2] - P[i * 2];
    const tz = P[i * 2 + 3] - P[i * 2 + 1];
    this.hit.s = (i + hit.t) * STEP;
    this.hit.d = hit.d;
    // left going along it: the tangent turned a quarter toward +x when heading north
    this.hit.side = tz * (x - P[i * 2]) - tx * (z - P[i * 2 + 1]) >= 0 ? 1 : -1;
    return this.hit;
  }

  /** How far along the line its point nearest (x, z) is (m), searching every point (for setting things up, not per frame). */
  nearestS(x: number, z: number): number {
    let best = Infinity;
    let at = 0;
    for (let i = 0; i < this.count; i++) {
      const d = Math.hypot(this.pts[i * 2] - x, this.pts[i * 2 + 1] - z);
      if (d < best) (best = d), (at = i);
    }
    return at * STEP;
  }
}

/**
 * A waterway: a smooth line through its designed points, its half-width and its depth along it, and its
 * current in its middle (m/s, positive along increasing s).
 */
export class Waterway {
  readonly name: string;
  readonly line: Line;
  readonly current: number;
  private readonly halfs: Float32Array;
  private readonly depths: Float32Array;

  constructor(name: string, points: readonly Pt[], reach: number, current: number, profile: (line: Line) => { half: (s: number) => number; depth: (s: number) => number }) {
    this.name = name;
    this.line = new Line(resample(smoothLine(resample(spline(points, 24), STEP), 4), STEP), reach);
    this.current = current;
    const { half, depth } = profile(this.line);
    this.halfs = Float32Array.from({ length: this.line.count }, (_, i) => half(i * STEP));
    this.depths = Float32Array.from({ length: this.line.count }, (_, i) => depth(i * STEP));
  }

  get length(): number {
    return this.line.length;
  }

  at(s: number): { x: number; z: number; heading: number } {
    return this.line.at(s);
  }

  frame(x: number, z: number): LineFrame | null {
    return this.line.frame(x, z);
  }

  private sample(a: Float32Array, s: number): number {
    const f = Math.min(a.length - 1.0001, Math.max(0, s / STEP));
    const i = Math.floor(f);
    return a[i] + (a[i + 1] - a[i]) * (f - i);
  }

  /** Half the width of its water `s` m along it (m). */
  half(s: number): number {
    return this.sample(this.halfs, s);
  }

  /** Its depth in the middle `s` m along it (m). */
  depth(s: number): number {
    return this.sample(this.depths, s);
  }

  /** The point `out` m from its middle on `side` (+1 left going along it), `s` m along it. */
  beside(s: number, side: number, out: number): { x: number; z: number } {
    const p = this.line.at(s);
    return { x: p.x + Math.cos(p.heading) * out * side, z: p.z - Math.sin(p.heading) * out * side };
  }
}

/** Wobble along a waterway (±1), so its banks are not drawn with a ruler. */
const wander = (s: number, seed: number) => (fbm(s * 0.011, seed * 1.37, 2, seed) - 0.5) * 2;

/** The small river: ≈30 m across, 3 m deep in its middle, flowing west at a walking pace's tenth. */
export const RIVER = new Waterway('river', RIVER_POINTS, 90, 0.22, () => ({
  half: (s) => 15 + 2.2 * Math.sin(s / 190 + 1.1) + 1.4 * wander(s, 3),
  depth: (s) => 3.0 + 0.5 * Math.sin(s / 260 + 0.4),
}));

/** The khal: ≈14 m across, its mouth flaring where it meets the river, narrowing under the old bridge, widening into the bil; it drains slowly toward the river. */
export const KHAL = new Waterway('khal', KHAL_POINTS, 60, -0.06, (line) => {
  const bridge = line.nearestS(BRIDGE_NEAR[0], BRIDGE_NEAR[1]);
  return {
    half: (s) => {
      const base = 7 + 0.9 * Math.sin(s / 85 + 0.7) + 0.8 * wander(s, 11);
      const mouth = 1 - smoothstep(10, 70, s);
      const atBridge = smoothstep(40, 16, Math.abs(s - bridge));
      const bil = smoothstep(line.length - 70, line.length, s);
      return base + (16 - base) * mouth + (6 - base) * atBridge + (16 - base) * bil;
    },
    depth: (s) => 1.6 + 0.25 * Math.sin(s / 120 + 1.9) + 0.4 * smoothstep(28, 8, Math.abs(s - bridge)) + 0.8 * (1 - smoothstep(0, 60, s)),
  };
});

/** The side khal: a narrow drain through the fields to the bil, ≈7 m across and knee to waist deep; still. */
export const SIDE_KHAL = new Waterway('side khal', SIDE_KHAL_POINTS, 30, 0, (line) => ({
  half: (s) => 3.4 + 0.5 * wander(s, 17) + 2.2 * (1 - smoothstep(0, 24, s)) + 2.5 * smoothstep(line.length - 40, line.length, s),
  depth: () => 0.9,
}));

export const WATERWAYS: readonly Waterway[] = [RIVER, KHAL, SIDE_KHAL];

/** How much of (x, z) lies on the river's sandy char, on the inside of its broad bend opposite the zamindar house (0..1). */
export function charShare(x: number, z: number): number {
  const s = Math.sin(CHAR.yaw);
  const c = Math.cos(CHAR.yaw);
  const dx = x - CHAR.x;
  const dz = z - CHAR.z;
  const a = (dx * c - dz * s) / CHAR.halfLen;
  const b = (dx * s + dz * c) / CHAR.halfWid;
  return smoothstep(1.15, 0.75, Math.hypot(a, b));
}

/** The river's low natural levee: the land stands this much higher close to it, where the homesteads and the road are (m). */
export function riverLevee(x: number, z: number): number {
  const f = RIVER.frame(x, z);
  if (!f) return 0;
  return 0.35 * smoothstep(RIVER.half(f.s) + 90, RIVER.half(f.s) + 24, f.d) * (1 - charShare(x, z));
}

export interface WaterwayHit {
  way: Waterway;
  s: number;
  d: number;
  side: 1 | -1;
  half: number;
}

const wayHit: WaterwayHit = { way: RIVER, s: 0, d: 0, side: 1, half: 0 };

/**
 * The waterway whose water (x, z) is nearest, measured from its bank (d − half), if any is within its reach;
 * null away from them all. The result is reused by the next call.
 */
export function waterwayAt(x: number, z: number): WaterwayHit | null {
  let best = Infinity;
  let found = false;
  for (const way of WATERWAYS) {
    const f = way.frame(x, z);
    if (!f) continue;
    const half = way.half(f.s);
    if (f.d - half >= best) continue;
    best = f.d - half;
    wayHit.way = way;
    wayHit.s = f.s;
    wayHit.d = f.d;
    wayHit.side = f.side;
    wayHit.half = half;
    found = true;
  }
  return found ? wayHit : null;
}

// ---------- the shapla bil ----------

/**
 * The shapla bil at the khal's head: its middle, the way the khal comes in (its long axis), its half-length and
 * half-width (m), and its water (the khal's).
 */
export const BIL = (() => {
  const end = KHAL.at(KHAL.length);
  return { x: BIL_SPEC.x, z: BIL_SPEC.z, angle: end.heading, halfLen: BIL_SPEC.halfLen, halfWid: BIL_SPEC.halfWid, level: WATER_LEVEL };
})();

/** (x, z) in the bil's own frame: along its long axis (the way the khal comes in) and across it. */
export function bilLocal(x: number, z: number): { a: number; c: number } {
  const dx = x - BIL.x;
  const dz = z - BIL.z;
  const s = Math.sin(BIL.angle);
  const k = Math.cos(BIL.angle);
  return { a: dx * s + dz * k, c: dx * k - dz * s };
}

/** The world point at `a` along the bil's long axis and `c` across it from its middle (bilLocal's inverse). */
export function bilPoint(a: number, c: number): { x: number; z: number } {
  const s = Math.sin(BIL.angle);
  const k = Math.cos(BIL.angle);
  return { x: BIL.x + a * s + c * k, z: BIL.z + a * k - c * s };
}

/** How far (x, z) is from the bil's middle, measured in its own irregular outline (below 1 is water). */
export function bilReach(x: number, z: number): number {
  const { a, c } = bilLocal(x, z);
  const da = a / BIL.halfLen;
  const dc = c / BIL.halfWid;
  const ang = Math.atan2(dc, da);
  const outline = 1 + 0.12 * Math.sin(3 * ang + 1.1) + 0.07 * Math.sin(5 * ang + 2.4) + 0.12 * (fbm(a * 0.016, c * 0.016, 2, 77) - 0.5);
  return Math.hypot(da, dc) / outline;
}

// ---------- the journey ----------

/**
 * The boat's way: down the river from where she sets out, round the banyan's corner into the khal (swinging
 * wide of it), up the khal under the old bridge, and on into the bil. A line of its own, so she and the
 * cameras follow one smooth course whatever the waters' own lines do at the confluence.
 */
const JOURNEY_LINE = (() => {
  const from = RIVER.line.nearestS(JOURNEY_FROM[0], JOURNEY_FROM[1]);
  const mouth = KHAL.at(0);
  const turn = RIVER.line.nearestS(mouth.x, mouth.z);
  const pts: number[] = [];
  // down the river to a little short of the confluence
  const leave = turn - 26;
  for (let s = from; s <= leave; s += STEP) {
    const p = RIVER.at(s);
    pts.push(p.x, p.z);
  }
  // round into the khal: a curve from the river's way to the khal's, a little way up it
  const a = RIVER.at(leave);
  const enter = 44;
  const b = KHAL.at(enter);
  const k = 30;
  const c1 = { x: a.x + Math.sin(a.heading) * k, z: a.z + Math.cos(a.heading) * k };
  const c2 = { x: b.x - Math.sin(b.heading) * k, z: b.z - Math.cos(b.heading) * k };
  for (let t = 0.05; t < 1; t += 0.05) {
    const u = 1 - t;
    pts.push(u * u * u * a.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * b.x, u * u * u * a.z + 3 * u * u * t * c1.z + 3 * u * t * t * c2.z + t * t * t * b.z);
  }
  // up the khal to its head
  for (let s = enter; s <= KHAL.length; s += STEP) {
    const p = KHAL.at(s);
    pts.push(p.x, p.z);
  }
  // and on into the bil, easing from the khal's heading toward the bil's middle line
  const head = KHAL.at(KHAL.length);
  for (let d = STEP; d <= INTO_BIL; d += STEP) {
    const t = d / INTO_BIL;
    const along = { x: head.x + Math.sin(head.heading) * d, z: head.z + Math.cos(head.heading) * d };
    const mid = bilPoint(-BIL.halfLen + d * 1.1, 0);
    pts.push(along.x + (mid.x - along.x) * t * 0.5, along.z + (mid.z - along.z) * t * 0.5);
  }
  return new Line(resample(smoothLine(resample(pts, STEP), 5), STEP), 60);
})();

/**
 * The journey (m along the boat's way): its length; where the scene opens, where she leaves the river for the
 * khal, passes under the old bridge and comes out into the bil.
 */
export const JOURNEY = (() => {
  const near = (p: { x: number; z: number }) => JOURNEY_LINE.nearestS(p.x, p.z);
  const bridge = KHAL.line.nearestS(BRIDGE_NEAR[0], BRIDGE_NEAR[1]);
  return {
    length: JOURNEY_LINE.length,
    opening: near({ x: OPENING_NEAR[0], z: OPENING_NEAR[1] }),
    turn: near(KHAL.at(10)),
    bridge: near(KHAL.at(bridge)),
    head: near(KHAL.at(KHAL.length)),
  };
})();

/** A point on the boat's way `s` m along it, and its heading there. */
export function journeyAt(s: number): { x: number; z: number; heading: number } {
  return JOURNEY_LINE.at(s);
}

/** Where (x, z) lies from the boat's way, if within 60 m of it; null farther off. The result is reused. */
export function journeyFrame(x: number, z: number): LineFrame | null {
  return JOURNEY_LINE.frame(x, z);
}

/** How far the boat's way is from the nearer bank of the water it runs through, `s` m along it (m); wide in the bil. */
export const journeyHalfWidth = (() => {
  const halfs = Float32Array.from({ length: JOURNEY_LINE.count }, (_, i) => {
    const p = JOURNEY_LINE.at(i * STEP);
    if (bilReach(p.x, p.z) < 0.95) return BIL.halfWid;
    const w = waterwayAt(p.x, p.z);
    return w ? Math.max(4, w.half - w.d) : 4;
  });
  return (s: number) => {
    const f = Math.min(halfs.length - 1.0001, Math.max(0, s / STEP));
    const i = Math.floor(f);
    return halfs[i] + (halfs[i + 1] - halfs[i]) * (f - i);
  };
})();

/** Where the old bridge and the bamboo sanko stand: the khal's and the side khal's point and heading there. */
export const BRIDGE_SITE = KHAL.at(KHAL.line.nearestS(BRIDGE_NEAR[0], BRIDGE_NEAR[1]));
export const SANKO_SITE = (() => {
  const s = SIDE_KHAL.line.nearestS(SANKO_NEAR[0], SANKO_NEAR[1]);
  return { ...SIDE_KHAL.at(s), s, half: SIDE_KHAL.half(s) };
})();

// ---------- how far from the boat's way ----------

/** The distance field's cells (m) and the margin it reaches beyond the world. */
const CELL = 5;
const MARGIN = 150;
const GX0 = WORLD.x0 - MARGIN;
const GZ0 = WORLD.z0 - MARGIN;
const GW = Math.ceil((WORLD.x1 - WORLD.x0 + 2 * MARGIN) / CELL) + 1;
const GH = Math.ceil((WORLD.z1 - WORLD.z0 + 2 * MARGIN) / CELL) + 1;

/** Each cell's distance from the boat's way (m), carried out from its points by two chamfer passes. */
const DIST = (() => {
  const P = JOURNEY_LINE.pts;
  const n = JOURNEY_LINE.count;
  const seed = new Int32Array(GW * GH).fill(-1);
  const dist = new Float32Array(GW * GH).fill(Infinity);
  const cellX = (c: number) => GX0 + c * CELL;
  const cellZ = (r: number) => GZ0 + r * CELL;
  for (let i = 0; i < n; i++) {
    const c = Math.round((P[i * 2] - GX0) / CELL);
    const r = Math.round((P[i * 2 + 1] - GZ0) / CELL);
    if (c < 0 || r < 0 || c >= GW || r >= GH) continue;
    const j = r * GW + c;
    const d = Math.hypot(cellX(c) - P[i * 2], cellZ(r) - P[i * 2 + 1]);
    if (d < dist[j]) (dist[j] = d), (seed[j] = i);
  }
  const relax = (j: number, from: number, c: number, r: number) => {
    const k = seed[from];
    if (k < 0) return;
    const d = Math.hypot(cellX(c) - P[k * 2], cellZ(r) - P[k * 2 + 1]);
    if (d < dist[j]) (dist[j] = d), (seed[j] = k);
  };
  for (let pass = 0; pass < 2; pass++) {
    for (let r = 0; r < GH; r++)
      for (let c = 0; c < GW; c++) {
        const j = r * GW + c;
        if (c > 0) relax(j, j - 1, c, r);
        if (r > 0) {
          relax(j, j - GW, c, r);
          if (c > 0) relax(j, j - GW - 1, c, r);
          if (c < GW - 1) relax(j, j - GW + 1, c, r);
        }
      }
    for (let r = GH - 1; r >= 0; r--)
      for (let c = GW - 1; c >= 0; c--) {
        const j = r * GW + c;
        if (c < GW - 1) relax(j, j + 1, c, r);
        if (r < GH - 1) {
          relax(j, j + GW, c, r);
          if (c < GW - 1) relax(j, j + GW + 1, c, r);
          if (c > 0) relax(j, j + GW - 1, c, r);
        }
      }
  }
  return dist;
})();

/** How far (x, z) is from the boat's way (m, to about a metre; anywhere on the world). */
export function journeyDistance(x: number, z: number): number {
  const fc = Math.min(GW - 1.0001, Math.max(0, (x - GX0) / CELL));
  const fr = Math.min(GH - 1.0001, Math.max(0, (z - GZ0) / CELL));
  const c = Math.floor(fc);
  const r = Math.floor(fr);
  const tx = fc - c;
  const ty = fr - r;
  const j = r * GW + c;
  const a = DIST[j] * (1 - tx) + DIST[j + 1] * tx;
  const b = DIST[j + GW] * (1 - tx) + DIST[j + GW + 1] * tx;
  return a * (1 - ty) + b * ty;
}
