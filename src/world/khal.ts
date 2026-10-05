import { smoothstep } from '../core/mathx';
import { fbm } from '../core/noise';
import { SegmentIndex } from '../core/segmentIndex';
import { LINES, WORLD, heightAt, place } from '../geo/data';

// The khal the boat goes up: the canal OpenStreetMap draws winding through Bara Moheshkhali (the old bridge's
// khal), from a little below the bridge up to its head at the hills' feet, and on into the shapla bil the scene
// puts there. This is the whole journey, and the frame the rest of the world is laid out round.
//
// - Its middle is OSM's line, smoothed over a few tens of metres (OSM's own points wander by metres), and
//   carried from the khal's head into the bil along a gentle curve.
// - It has its real width, 12–22 m (the 1:3 map would draw it a third as wide, too narrow for the boat; OSM
//   has no widths: [মডেল]), narrowing under the bridge, widening where it opens into the bil.
// - Its water lies at one level from end to end and in the bil (a khal held by its sluice and fed by the hill
//   streams [মডেল]). The real ground rises ≈4 m along it toward the hills, so the plain round it is let down
//   (or built up, below the bridge) to lie a little above its water, easing back to the map's own ground a few
//   hundred metres away; the ponds, mounds and fields in that strip keep their heights relative to it.

/** Where the journey starts below the bridge (m down the khal from it), and how far it goes on into the bil past its middle. */
const START_BELOW = 170;
const INTO_BIL = 80;
/** Spacing of the khal's points (m). */
const STEP = 2;

/** OSM's canal under the old bridge, as world (x, z) pairs from its head (at the hills) toward its mouth. */
const CANAL = (() => {
  const p = place('arch-bridge').world;
  let best = Infinity;
  let line: Float32Array | null = null;
  for (const l of LINES) {
    if (l.k !== 'waterway') continue;
    for (let k = 0; k + 1 < l.points.length; k += 2) {
      const d = Math.hypot(l.points[k] - p.x, l.points[k + 1] - p.z);
      if (d < best) (best = d), (line = l.points);
    }
  }
  if (!line) throw new Error('khal: OSM has no waterway at the bridge');
  return line;
})();

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

const route = (() => {
  // OSM's line from the head (its first point) toward the mouth, every STEP m; the bridge's place along it
  const osm = resample(Array.from(CANAL), STEP);
  const bridge = place('arch-bridge').world;
  let at = 0;
  let near = Infinity;
  for (let i = 0; i < osm.length / 2; i++) {
    const d = Math.hypot(osm[i * 2] - bridge.x, osm[i * 2 + 1] - bridge.z);
    if (d < near) (near = d), (at = i);
  }
  // from below the bridge up to the head
  const first = Math.min(osm.length / 2 - 1, at + Math.round(START_BELOW / STEP));
  const up: number[] = [];
  for (let i = first; i >= 0; i--) up.push(osm[i * 2], osm[i * 2 + 1]);
  // on from the head into the bil: a curve along the khal's way at its head to the bil's middle, then straight on
  const hx = up[up.length - 2];
  const hz = up[up.length - 1];
  const px = up[up.length - 8];
  const pz = up[up.length - 7];
  const hl = Math.hypot(hx - px, hz - pz);
  const cx = hx + ((hx - px) / hl) * 70;
  const cz = hz + ((hz - pz) / hl) * 70;
  const bil = place('shapla-bil').world;
  const ext: number[] = [];
  for (let t = 0.02; t <= 1; t += 0.02) {
    const a = (1 - t) * (1 - t);
    const b = 2 * (1 - t) * t;
    const c = t * t;
    ext.push(a * hx + b * cx + c * bil.x, a * hz + b * cz + c * bil.z);
  }
  const ox = bil.x - cx;
  const oz = bil.z - cz;
  const ol = Math.hypot(ox, oz);
  for (let d = 10; d <= INTO_BIL; d += 10) ext.push(bil.x + (ox / ol) * d, bil.z + (oz / ol) * d);
  const smoothed = resample(smoothLine(smoothLine(resample([...up, ...ext], STEP), 10), 10), STEP);
  // the head: the point nearest OSM's last
  let head = 0;
  near = Infinity;
  for (let i = 0; i < smoothed.length / 2; i++) {
    const d = Math.hypot(smoothed[i * 2] - hx, smoothed[i * 2 + 1] - hz);
    if (d < near) (near = d), (head = i);
  }
  let bridgeAt = 0;
  near = Infinity;
  for (let i = 0; i < smoothed.length / 2; i++) {
    const d = Math.hypot(smoothed[i * 2] - bridge.x, smoothed[i * 2 + 1] - bridge.z);
    if (d < near) (near = d), (bridgeAt = i);
  }
  return { pts: Float64Array.from(smoothed), head: head * STEP, bridge: bridgeAt * STEP };
})();

const PTS = route.pts;
const COUNT = PTS.length / 2;

/** The journey along the khal (m from its start below the bridge): its length, and where the bridge and the khal's head are. */
export const JOURNEY = { length: (COUNT - 1) * STEP, bridge: route.bridge, head: route.head } as const;

/** A point on the khal's middle `s` m along it, and its heading there (radians: 0 north, toward +x at π/2). */
export function khalAt(s: number): { x: number; z: number; heading: number } {
  const f = Math.min(COUNT - 1.0001, Math.max(0, s / STEP));
  const i = Math.floor(f);
  const t = f - i;
  const ax = PTS[i * 2];
  const az = PTS[i * 2 + 1];
  const bx = PTS[i * 2 + 2];
  const bz = PTS[i * 2 + 3];
  return { x: ax + (bx - ax) * t, z: az + (bz - az) * t, heading: Math.atan2(bx - ax, bz - az) };
}

/** The khal's water level (m about MSL): the old bridge's ground a little above it, as every khal's fields are. */
export const KHAL_LEVEL = Math.round((heightAt(khalAt(route.bridge).x, khalAt(route.bridge).z) - 0.6) * 10) / 10;

/** The khal's slow drift down toward its sluice, in its middle (m/s) [মডেল]: the hill streams feeding it. */
export const KHAL_CURRENT = 0.07;

/** The khal's half-width at `s` (m): 7–11, narrowing to the bridge's arch, widening into the bil. */
export function khalHalfWidth(s: number): number {
  const wander = 9 + 1.6 * Math.sin(s / 95 + 0.7) + 1.4 * (fbm(s * 0.012, 3.3, 2, 11) - 0.5) * 2;
  const atBridge = smoothstep(42, 18, Math.abs(s - JOURNEY.bridge));
  const mouth = smoothstep(JOURNEY.head - 30, JOURNEY.head + 30, s);
  return wander + (6.2 - wander) * atBridge + (15 - wander) * mouth;
}

/** The khal's depth in its middle at `s` (m), scoured a little deeper under the bridge. */
export function khalDepth(s: number): number {
  return 1.5 + 0.35 * Math.sin(s / 140 + 1.9) + 0.4 * smoothstep(30, 8, Math.abs(s - JOURNEY.bridge));
}

// ---------- where a point lies from the khal ----------

const NEAR = 60;
const INDEX = new SegmentIndex(24);
for (let i = 0; i < COUNT - 1; i++) INDEX.add(PTS[i * 2], PTS[i * 2 + 1], PTS[i * 2 + 2], PTS[i * 2 + 3], 0, NEAR);

export interface KhalFrame {
  /** How far along the khal the nearest point of its middle is (m). */
  s: number;
  /** How far from its middle (m), and on which side: +1 to its left going up it, −1 to its right. */
  d: number;
  side: 1 | -1;
}

const frame: KhalFrame = { s: 0, d: 0, side: 1 };

/** Where (x, z) lies from the khal's middle, if within 60 m of it; null farther off. The result is reused. */
export function khalFrame(x: number, z: number): KhalFrame | null {
  const hit = INDEX.nearest(x, z);
  if (!hit) return null;
  const i = hit.index;
  const tx = PTS[i * 2 + 2] - PTS[i * 2];
  const tz = PTS[i * 2 + 3] - PTS[i * 2 + 1];
  frame.s = (i + hit.t) * STEP;
  frame.d = hit.d;
  // left of the way up: the tangent turned a quarter toward +x (west) when heading north
  frame.side = tz * (x - PTS[i * 2]) - tx * (z - PTS[i * 2 + 1]) >= 0 ? 1 : -1;
  return frame;
}

// ---------- the plain let down (or built up) round the khal ----------

/** The ground the strip round the khal is brought to: this far above the water (m). */
const PLAIN_ABOVE = 1.0;
/** Within this distance of the khal's middle the ground is fully brought to it; beyond the second, not at all (m). */
const FULL = 170;
const NONE = 430;
/** The corridor's field: a cell every CELL m over the world and a margin round it. */
const CELL = 5;
const MARGIN = 120;
const GX0 = WORLD.x0 - MARGIN;
const GZ0 = WORLD.z0 - MARGIN;
const GW = Math.ceil((WORLD.x1 - WORLD.x0 + 2 * MARGIN) / CELL) + 1;
const GH = Math.ceil((WORLD.z1 - WORLD.z0 + 2 * MARGIN) / CELL) + 1;

/**
 * How high the map's own plain stands beside the khal at each of its points: the median of the ground 25–60 m
 * out on both sides (clear of the water), smoothed over ±80 m along it.
 */
const PLAIN = (() => {
  const raw = new Float64Array(COUNT);
  const around: number[] = [];
  for (let i = 0; i < COUNT; i++) {
    const p = khalAt(i * STEP);
    const nx = Math.cos(p.heading);
    const nz = -Math.sin(p.heading);
    around.length = 0;
    for (const d of [25, 35, 45, 60]) for (const side of [1, -1]) around.push(heightAt(p.x + nx * d * side, p.z + nz * d * side));
    around.sort((a, b) => a - b);
    raw[i] = (around[3] + around[4]) / 2;
  }
  const out = new Float64Array(COUNT);
  const k = Math.round(80 / STEP);
  for (let i = 0; i < COUNT; i++) {
    let sum = 0;
    let n = 0;
    for (let j = Math.max(0, i - k); j <= Math.min(COUNT - 1, i + k); j++) (sum += raw[j]), n++;
    out[i] = sum / n;
  }
  return out;
})();

/** Each cell's distance from the khal's middle (m), on the corridor's field. */
const DIST = new Float32Array(GW * GH).fill(Infinity);

/** How far the ground is let down at each cell of the corridor's field (m; negative where it is built up). */
const DROP = (() => {
  // each cell's nearest point of the khal, carried out from the khal's own cells (two chamfer passes)
  const seed = new Int32Array(GW * GH).fill(-1);
  const dist = DIST;
  const cellX = (c: number) => GX0 + c * CELL;
  const cellZ = (r: number) => GZ0 + r * CELL;
  for (let i = 0; i < COUNT; i++) {
    const c = Math.round((PTS[i * 2] - GX0) / CELL);
    const r = Math.round((PTS[i * 2 + 1] - GZ0) / CELL);
    if (c < 0 || r < 0 || c >= GW || r >= GH) continue;
    const j = r * GW + c;
    const d = Math.hypot(cellX(c) - PTS[i * 2], cellZ(r) - PTS[i * 2 + 1]);
    if (d < dist[j]) (dist[j] = d), (seed[j] = i);
  }
  const relax = (j: number, from: number, c: number, r: number) => {
    const k = seed[from];
    if (k < 0) return;
    const d = Math.hypot(cellX(c) - PTS[k * 2], cellZ(r) - PTS[k * 2 + 1]);
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
  const target = KHAL_LEVEL + PLAIN_ABOVE;
  const out = new Float32Array(GW * GH);
  for (let j = 0; j < GW * GH; j++) if (seed[j] >= 0) out[j] = (PLAIN[seed[j]] - target) * smoothstep(NONE, FULL, dist[j]);
  return out;
})();

/** How far the ground at (x, z) is let down from the map's (m; negative where it is built up below the bridge). */
export function corridorDrop(x: number, z: number): number {
  const fc = Math.min(GW - 1.0001, Math.max(0, (x - GX0) / CELL));
  const fr = Math.min(GH - 1.0001, Math.max(0, (z - GZ0) / CELL));
  const c = Math.floor(fc);
  const r = Math.floor(fr);
  const tx = fc - c;
  const ty = fr - r;
  const j = r * GW + c;
  const a = DROP[j] * (1 - tx) + DROP[j + 1] * tx;
  const b = DROP[j + GW] * (1 - tx) + DROP[j + GW + 1] * tx;
  return a * (1 - ty) + b * ty;
}

/** How far (x, z) is from the khal's middle (m, to about a metre; anywhere on the world). */
export function khalDistance(x: number, z: number): number {
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

/** The map's ground at (x, z) with the strip round the khal brought down to it: before the khal, the bil, the khals and the roads are cut in. */
export function baseGround(x: number, z: number): number {
  return heightAt(x, z) - corridorDrop(x, z);
}

/**
 * The shapla bil at the khal's head (GEOGRAPHY_PLAN.md D3: where no real one was found): a rain-fed wetland on
 * the low ground below the hills, the khal running into it. Its middle, the way the khal comes in (its long
 * axis), its half-length and half-width (m); its water is the khal's.
 */
export const BIL = (() => {
  const p = place('shapla-bil').world;
  const along = khalAt(JOURNEY.length - INTO_BIL);
  return { x: p.x, z: p.z, angle: along.heading, halfLen: 150, halfWid: 78, level: KHAL_LEVEL };
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
