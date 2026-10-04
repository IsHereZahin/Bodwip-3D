import { G } from '../core/globals';
import { SegmentIndex } from '../core/segmentIndex';
import { clamp, smoothstep } from '../core/mathx';
import { fbm } from '../core/noise';
import { CHANNEL_POINTS, COVER, KIND, LINES, WORLD, canopyAt, coverAt, heightAt, inlandSurfaceAt, kindAt, place, type GeoLine } from '../geo/data';
import { MAP_SCALE } from '../geo/project';
import { onRoad, roadGround } from './roads';

// Where land and water are. The terrain mesh, the water and every placement read these, so the boat, the
// trees and the beds always agree.
//
// The world is the real Moheshkhali–Matarbari map at 1:3 (GEOGRAPHY_PLAN.md §5.1): the ground comes from the
// baked open data (geo/data.ts; DEMs, satellite water and land cover), heights and objects keep their real
// size. x points west, z north. The boat goes south down the Moheshkhali channel, the island (with its hills)
// on her right (west), the mainland on her left, to the mouth between Sonadia and Cox's Bazar.
//
// Much of the scene was first built along one river's centre line (riverX, halfWidth, …): those functions
// now answer for the real channel, from its baked middle (geo/channel.json), so the boat, the traffic, the
// floating plants and the nets keep working on it. Everything else asks the ground itself.
//
// There are two waters: the sea's, joined to the open Bay (the channel, the creeks, the flats and mangroves
// the tide covers), at the sea's level G.uWaterLevel; and inland water (ponds, salt pans, tanks, the bil and
// the old bridge's khal) at their own levels. `waterLevelAt` and `seaWaterAt` tell them apart.

/** The baked map's extent: x from WORLD_X0 (east edge) to WORLD_X1 (west edge), z from WORLD_Z1 (south) to WORLD_Z0 (north). */
export const WORLD_X0 = WORLD.x0;
export const WORLD_X1 = WORLD.x1;
export const WORLD_Z0 = WORLD.z1;
export const WORLD_Z1 = WORLD.z0;

export interface Point2 {
  x: number;
  z: number;
}

// ---------- the Moheshkhali channel ----------

const CH = CHANNEL_POINTS;
const CZ = Float64Array.from(CH, (p) => p[1]);
const CX = Float64Array.from(CH, (p) => p[0]);
/** Each bank's distance from the middle, smoothed over ±100 m so a creek mouth or a spit does not jolt it. */
const smoothWidth = (k: 2 | 3) =>
  Float64Array.from(CH, (_, i) => {
    let s = 0;
    let n = 0;
    for (let j = Math.max(0, i - 5); j <= Math.min(CH.length - 1, i + 5); j++) (s += CH[j][k]), n++;
    return Math.max(25, s / n);
  });
const CW = smoothWidth(2);
const CE = smoothWidth(3);
/** The channel's extent in z (it runs north–south: every point lies north of the one before). */
const CHANNEL_Z0 = CZ[0];
const CHANNEL_Z1 = CZ[CZ.length - 1];
/** The channel's ends in z, mouth (south) to head (north): placements laid along its banks keep within them. */
export const CHANNEL_SPAN = { south: CHANNEL_Z0, north: CHANNEL_Z1 } as const;

/** Interpolates a channel table at z (clamped to the channel's ends). */
function along(table: Float64Array, z: number): number {
  if (z <= CHANNEL_Z0) return table[0];
  if (z >= CHANNEL_Z1) return table[table.length - 1];
  let lo = 0;
  let hi = CZ.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (CZ[mid] <= z) lo = mid;
    else hi = mid;
  }
  const t = (z - CZ[lo]) / (CZ[hi] - CZ[lo]);
  return table[lo] + (table[hi] - table[lo]) * t;
}

/** The channel's middle (x) at z. */
export function riverX(z: number): number {
  return along(CX, z);
}

/** d riverX / dz. */
export function riverSlope(z: number): number {
  return (riverX(z + 10) - riverX(z - 10)) / 20;
}

/** Distance from the middle to this bank's low-water line (side +1 west, the island's; −1 east, the mainland's). */
export function edgeHalfWidth(z: number, side: number): number {
  return along(side > 0 ? CW : CE, z);
}

export function halfWidth(z: number): number {
  return (edgeHalfWidth(z, 1) + edgeHalfWidth(z, -1)) / 2;
}

/** How deep the channel's bed lies below mean sea level in its middle at z (m). */
export function riverDepth(z: number): number {
  return Math.max(0, -heightAt(riverX(z), z));
}

/** Mid-channel surface current (m/s): the same water runs faster where the channel narrows. */
export function streamSpeed(z: number): number {
  return 0.85 * clamp(Math.sqrt(105 / halfWidth(z)), 0.75, 1.45);
}

/** Unit vector (x, z) pointing down the channel, toward the sea. */
export function downstream(z: number): [number, number] {
  const s = riverSlope(z);
  const l = Math.hypot(s, 1);
  return [-s / l, -1 / l];
}

export interface BankInfo {
  /** Offset from the channel's middle. */
  u: number;
  side: 1 | -1;
  /** Distance inland from the low-water line (negative in the channel). */
  inland: number;
}

export function bankInfo(x: number, z: number): BankInfo {
  const u = x - riverX(z);
  const side = u >= 0 ? 1 : -1;
  return { u, side, inland: Math.abs(u) - edgeHalfWidth(z, side) - 3 };
}

/** Bed deep enough for the boats at the lowest spring tides (m about MSL): ≈1.8 m below MSL, and a draught and a metre more. */
const LANE_BED = -3.1;

/**
 * The lane small boats keep (and the hero's), as an offset from the channel's middle at each of its points:
 * in from the island's low-water line to the first water deep enough at any tide (and a little beyond), so
 * the island's shore, villages and hills pass close by; where the channel is nowhere that deep, over its
 * deepest. Smoothed along the channel so the lane bends gently.
 */
const LANE = (() => {
  const raw = CH.map(([x, z, west, east]) => {
    let deepest = 0;
    let deepestH = Infinity;
    for (let u = west - 20; u > -east + 20; u -= 4) {
      const h = heightAt(x + u, z);
      if (h <= LANE_BED) return Math.max(-east + 20, u - 15);
      if (h < deepestH) (deepestH = h), (deepest = u);
    }
    return deepest;
  });
  return Float64Array.from(raw, (_, i) => {
    let s = 0;
    let n = 0;
    for (let j = Math.max(0, i - 6); j <= Math.min(raw.length - 1, i + 6); j++) (s += raw[j]), n++;
    return s / n;
  });
})();

export function riverLane(z: number): number {
  return along(LANE, z);
}

export function boatLane(z: number): number {
  return riverLane(z);
}

/**
 * The boat's journey: from the narrow north of the channel, past Shaplapur, Adinath hill and Gorakghata's
 * jetties, out toward the mouth by Sonadia; it loops through a mist fade at the end.
 */
export const JOURNEY_Z0 = Math.min(6800, CHANNEL_Z1 - 200);
export const JOURNEY_Z1 = Math.max(-1400, CHANNEL_Z0 + 200);

// ---------- the inland waters the scene adds: the shapla bil and the khal under the old bridge ----------

/**
 * The shapla bil (GEOGRAPHY_PLAN.md D3: placed where no real one was found). A rain-fed wetland on a valley
 * floor among Moheshkhali's hills, where the hill streams bring fresh water and the bowl of the valley (11.5 m,
 * 8 m below the ground round it in the DEM) holds it, far from the salt tide. `z`, `u` in the channel's frame
 * (u = x − riverX(z)), as world/bil.ts lays it out; `level` is its water's surface.
 */
export const BIL = (() => {
  const p = place('shapla-bil');
  const floor = heightAt(p.world.x, p.world.z);
  return { z: p.world.z, u: p.world.x - riverX(p.world.z), halfLen: 140, halfWid: 60, level: floor + 0.3 };
})();

/** How far (z, u) is from the bil's middle, measured in its own irregular outline (below 1 is water). */
export function bilReach(z: number, u: number): number {
  const dz = (z - BIL.z) / BIL.halfLen;
  const du = (u - BIL.u) / BIL.halfWid;
  const a = Math.atan2(du, dz);
  const outline = 1 + 0.12 * Math.sin(3 * a + 1.1) + 0.07 * Math.sin(5 * a + 2.4) + 0.12 * (fbm(z * 0.016, u * 0.016, 2, 77) - 0.5);
  return Math.hypot(dz, du) / outline;
}

function nearBil(z: number, u: number): boolean {
  return Math.abs(z - BIL.z) < BIL.halfLen * 1.55 && Math.abs(u - BIL.u) < BIL.halfWid * 1.6;
}

/** 1 on the bil's low, wet rim (just above its water), 0 elsewhere: wet meadow rather than bare ground. */
export function bilMarsh(z: number, u: number): number {
  if (!nearBil(z, u)) return 0;
  const e = bilReach(z, u);
  return smoothstep(0.98, 1.04, e) * smoothstep(1.5, 1.35, e);
}

/** Depth of the bil's water at (z, u): an undulating bed with a deeper hollow, shoaling to the reedy edge. */
export function bilDepth(z: number, u: number): number {
  const e = bilReach(z, u);
  if (e >= 1) return 0;
  const bed = 0.75 + 0.9 * fbm(z * 0.022 + 3, u * 0.022, 3, 81) + 0.6 * Math.exp(-(((z - BIL.z + 50) / 35) ** 2 + ((u - BIL.u + 15) / 22) ** 2));
  return bed * smoothstep(1, 0.72, e) + 0.04;
}

/** Distance from (x, z) to the boat's way through the bil: there is none. */
export function routeGap(_x: number, _z: number): number {
  return Infinity;
}

/**
 * The old bridge (world/bridge.ts, D3): a humped brick arch carrying a village path over a real khal, where
 * OpenStreetMap has a small road bridge over the canal that winds through Bara Moheshkhali to the channel by
 * Gorakghata. Its frame: x along the bridge, across the khal; z along the khal; `angle` turns that frame into
 * the world's (as a rotation about y). Heights in the frame are above the khal's water (`water`, a world
 * height): world/bridge.ts sets the bridge there.
 */
export const BRIDGE = (() => {
  const p = place('arch-bridge');
  // the canal OSM draws there: its direction at the crossing
  let best = Infinity;
  let dir = { x: 0, z: 1 };
  let line: GeoLine | null = null;
  for (const l of LINES) {
    if (l.k !== 'waterway') continue;
    const pts = l.points;
    for (let k = 0; k + 3 < pts.length; k += 2) {
      const d = Math.hypot(pts[k] - p.world.x, pts[k + 1] - p.world.z);
      if (d < best) {
        best = d;
        line = l;
        const len = Math.hypot(pts[k + 2] - pts[k], pts[k + 3] - pts[k + 1]) || 1;
        dir = { x: (pts[k + 2] - pts[k]) / len, z: (pts[k + 3] - pts[k + 1]) / len };
      }
    }
  }
  const ground = heightAt(p.world.x, p.world.z);
  return {
    x: p.world.x,
    z: p.world.z,
    angle: Math.atan2(dir.x, dir.z),
    /** OSM's line of the khal it crosses. */
    line,
    /** Clear span of the arch and the height it springs from (above the khal's water); its rise; the arch ring's depth. */
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
    bank: 0.6,
    /** The khal's water (world height): as every khal's, a little below the fields either side. */
    water: ground - 0.6,
  };
})();

/** (x, z) in the bridge's frame: `x` along it, `z` along the khal. */
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

/** Height of the arch's underside at `bx` along the bridge (−∞ beyond the span), above the khal's water. */
export function bridgeSoffit(bx: number): number {
  const half = BRIDGE.span / 2;
  if (Math.abs(bx) > half) return -Infinity;
  const r = (half * half + BRIDGE.rise * BRIDGE.rise) / (2 * BRIDGE.rise);
  return BRIDGE.springing + BRIDGE.rise - r + Math.sqrt(r * r - bx * bx);
}

/** Height of the bridge's walking surface at `bx` along it (above the khal's water): the hump of the arch, easing down the ramps to the bank. */
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

// ---------- the khals, streams and drains ----------

/**
 * OSM's waterways too narrow for the DEM and the satellites (most khals, the hill streams, the drains) are cut
 * into the ground at 1:3 of a typical width for their kind (OSM has no widths: [মডেল]), each with its water a
 * little below the land either side. Where the map already has water (the sea's, a pond's) nothing is cut:
 * they run into it.
 */
const WATERWAY_KINDS: Readonly<Record<string, { width: number; depth: number }>> = {
  river: { width: 30, depth: 2 },
  canal: { width: 15, depth: 1.5 },
  stream: { width: 8, depth: 0.8 },
  drain: { width: 4, depth: 0.6 },
  ditch: { width: 3, depth: 0.5 },
};
/** The khal under the old bridge, the canal through the town, ≈27 m across on the ground (its width is not mapped: [মডেল]). */
const BRIDGE_KHAL_HALF = 4.5;
/** A khal's water stands this far below the land along it (m); its banks slope up to the fields over this many metres. */
const FREEBOARD = 0.6;
const BANKS = 3;

/** One straight piece of a waterway: its ends, half-width and depth, and its water's level at each end. */
interface Reach {
  ax: number;
  az: number;
  bx: number;
  bz: number;
  half: number;
  depth: number;
  la: number;
  lb: number;
}

const REACHES: readonly Reach[] = LINES.flatMap((l) => {
  const kind = l.k === 'waterway' && l.t !== undefined ? WATERWAY_KINDS[l.t] : undefined;
  if (!kind) return [];
  const half = l === BRIDGE.line ? BRIDGE_KHAL_HALF : Math.max(1, kind.width / MAP_SCALE / 2);
  const p = l.points;
  const out: Reach[] = [];
  for (let k = 0; k + 3 < p.length; k += 2) {
    out.push({ ax: p[k], az: p[k + 1], bx: p[k + 2], bz: p[k + 3], half, depth: kind.depth, la: heightAt(p[k], p[k + 1]) - FREEBOARD, lb: heightAt(p[k + 2], p[k + 3]) - FREEBOARD });
  }
  return out;
});

/** The reaches filed by 32 m cells (the ground is asked about the khals at every vertex and every placement). */
const REACH_INDEX = new SegmentIndex(32);
for (const r of REACHES) REACH_INDEX.add(r.ax, r.az, r.bx, r.bz, r.half, BANKS);

/** The khal nearest (x, z), measured against its width: how far from its middle, its half-width, depth and water's level. */
const reachHit = { d: 0, half: 0, depth: 0, level: 0 };
function waterwayAt(x: number, z: number): typeof reachHit | null {
  const hit = REACH_INDEX.nearest(x, z);
  if (!hit) return null;
  const r = REACHES[hit.index];
  reachHit.d = hit.d;
  reachHit.half = r.half;
  reachHit.depth = r.depth;
  reachHit.level = r.la + (r.lb - r.la) * hit.t;
  return reachHit;
}

/**
 * Calls `mark` with every point (≈3 m apart) of every khal's water where it is cut into dry ground, and its
 * level there: world/water.ts paints them into its map of which water stands where.
 */
export function eachWaterwayPoint(mark: (x: number, z: number, level: number) => void): void {
  for (const r of REACHES) {
    const len = Math.hypot(r.bx - r.ax, r.bz - r.az);
    if (len < 1e-3) continue;
    const ux = (r.bx - r.ax) / len;
    const uz = (r.bz - r.az) / len;
    const steps = Math.ceil(len / 3);
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      for (let a = -r.half; a <= r.half + 1e-6; a += Math.max(1, r.half)) {
        const x = r.ax + (r.bx - r.ax) * t - uz * a;
        const z = r.az + (r.bz - r.az) * t + ux * a;
        if (kindAt(x, z) === KIND.land) mark(x, z, r.la + (r.lb - r.la) * t);
      }
    }
  }
}

/** A point on the bridge's khal `d` m along it from the bridge (either way), and the khal's heading there. */
export function khalPoint(d: number): { x: number; z: number; heading: number } {
  const p = BRIDGE.line?.points;
  if (!p) return { ...bridgeToWorld(0, d), heading: BRIDGE.angle };
  // the bridge's place along the line, then walk from it
  let at = 0;
  let best = Infinity;
  let run = 0;
  for (let k = 0; k + 3 < p.length; k += 2) {
    const sx = p[k + 2] - p[k];
    const sz = p[k + 3] - p[k + 1];
    const len = Math.hypot(sx, sz);
    const t = clamp(((BRIDGE.x - p[k]) * sx + (BRIDGE.z - p[k + 1]) * sz) / (len * len || 1), 0, 1);
    const e = Math.hypot(BRIDGE.x - p[k] - sx * t, BRIDGE.z - p[k + 1] - sz * t);
    if (e < best) (best = e), (at = run + t * len);
    run += len;
  }
  let want = clamp(at + d, 0, run);
  for (let k = 0; k + 3 < p.length; k += 2) {
    const sx = p[k + 2] - p[k];
    const sz = p[k + 3] - p[k + 1];
    const len = Math.hypot(sx, sz);
    if (want <= len || k + 5 >= p.length) {
      const t = len > 0 ? Math.min(1, want / len) : 0;
      return { x: p[k] + sx * t, z: p[k + 1] + sz * t, heading: Math.atan2(sx, sz) };
    }
    want -= len;
  }
  return { x: BRIDGE.x, z: BRIDGE.z, heading: BRIDGE.angle };
}

/** The ground the bil's and the khals' carving leaves at (x, z), or +∞ where they do not reach. */
function carved(x: number, z: number, ground: number): number {
  let h = Infinity;
  const u = x - riverX(z);
  if (nearBil(z, u)) {
    const e = bilReach(z, u);
    // the water, then a low marshy rim rising slowly to the fields
    if (e < 1) h = BIL.level - bilDepth(z, u);
    else if (e < 1.45) h = Math.min(ground, BIL.level - 0.04 + (ground - BIL.level + 0.04) * smoothstep(1, 1.45, e));
  }
  const w = waterwayAt(x, z);
  if (w && kindAt(x, z) === KIND.land) {
    // a bed shoaling to the sides, then banks rising to the fields
    const bed = w.level - w.depth;
    if (w.d < w.half) h = Math.min(h, bed + (w.level - 0.2 - bed) * smoothstep(0.4, 1, w.d / w.half));
    else h = Math.min(h, w.level - 0.2 + (ground - w.level + 0.2) * (1 - (1 - (w.d - w.half) / BANKS) ** 2));
  }
  return h;
}

// ---------- the ground ----------

/** The temple's terrace: the ground levelled round Adinath temple (its centre, radius, height). */
const TEMPLE = (() => {
  const p = place('adinath-temple');
  return { x: p.world.x, z: p.world.z, r: 9, y: heightAt(p.world.x, p.world.z) };
})();

/** Height of the ground at (x, z): the baked map, with the temple's terrace, the roads' embankments, the bil's bowl and the khals. */
export function terrainHeight(x: number, z: number): number {
  let h = heightAt(x, z);
  const t = Math.hypot(x - TEMPLE.x, z - TEMPLE.z);
  if (t < TEMPLE.r * 2.2) h += (TEMPLE.y - h) * smoothstep(TEMPLE.r * 2.2, TEMPLE.r, t);
  h = roadGround(x, z, h);
  return Math.min(h, carved(x, z, h));
}

/** True within `margin` m of a road's carriageway (world/roads.ts): huts, trees and crops keep off them. */
export { onRoad };

/** The ground of the fields and village mounds at (x, z): the same ground (the map has no separate floodplain). */
export function landLevel(x: number, z: number): number {
  return terrainHeight(x, z);
}

/**
 * The surface of the water standing at (x, z): the sea's (the tide's) where the ground is the sea's (its
 * water, flats and mangroves), an inland water's own level in a pond, a gher, the bil or the khal; −∞ on dry
 * ground (a field below high water behind its bund stays dry).
 */
export function waterLevelAt(x: number, z: number): number {
  const u = x - riverX(z);
  if (nearBil(z, u) && bilReach(z, u) < 1.05) return BIL.level;
  const w = waterwayAt(x, z);
  if (w && w.d < w.half + 1 && kindAt(x, z) === KIND.land) return w.level;
  const inland = inlandSurfaceAt(x, z);
  if (inland !== null) return inland;
  return seaWaterAt(x, z) ? G.uWaterLevel.value : -Infinity;
}

/** Whether (x, z) belongs to the sea's water (or the flats and mangroves it floods), rather than inland water or dry land. */
export function seaWaterAt(x: number, z: number): boolean {
  const k = kindAt(x, z);
  return k === KIND.sea || k === KIND.tidal || k === KIND.mangrove;
}

/** Whether (x, z) holds inland water: a pond, a gher, a tank, the bil or a khal. */
export function inlandWaterAt(x: number, z: number): boolean {
  const u = x - riverX(z);
  if (nearBil(z, u) && bilReach(z, u) < 1) return true;
  const k = kindAt(x, z);
  if (k === KIND.inland) return true;
  const w = waterwayAt(x, z);
  return w !== null && w.d < w.half && k === KIND.land;
}

/** How much of (x, z) is hill forest (0..1): trees on ground well above the plain. */
export function forestCover(x: number, z: number): number {
  const c = coverAt(x, z);
  if (c !== COVER.tree && c !== COVER.shrub) return 0;
  return smoothstep(4, 12, heightAt(x, z)) * (0.4 + 0.6 * canopyAt(x, z).cover);
}

/** How much of (x, z) is beach or dune sand (0..1). */
export function sandCover(x: number, z: number): number {
  return coverAt(x, z) === COVER.sand ? 1 : 0;
}

/** Where mangroves grow (0..1): the map's mangrove forest (Global Mangrove Watch, WorldCover). */
export function mangroveZone(x: number, z: number, _h: number): number {
  return kindAt(x, z) === KIND.mangrove || coverAt(x, z) === COVER.mangrove ? 1 : 0;
}

/** Salt pans at (x, z) (0..1): OSM's pans and the inland water wet only through the rains (bake.mjs). */
export function saltPan(x: number, z: number): number {
  return coverAt(x, z) === COVER.saltpan ? 1 : 0;
}

/** How high above the plain (x, z) rises (m): the hills, where huts and fields do not go. */
export function hillHeight(x: number, z: number): number {
  return Math.max(0, heightAt(x, z) - 6);
}

/**
 * True if (x, z) is within `margin` metres of water other than the channel's open water (a creek, a pond,
 * a pan, the bil, the khal) — or of the channel itself, which placements keep clear of anyway.
 */
export function nearBackwater(x: number, z: number, margin: number): boolean {
  const steps = Math.max(1, Math.ceil(margin / 5));
  for (let i = -steps; i <= steps; i++) {
    for (let j = -steps; j <= steps; j++) {
      const px = x + (i * margin) / steps;
      const pz = z + (j * margin) / steps;
      if (i * i + j * j > steps * steps) continue;
      if (inlandWaterAt(px, pz)) return true;
      const k = kindAt(px, pz);
      if (k === KIND.sea || k === KIND.tidal) return true;
    }
  }
  return false;
}

// ---------- settlements and landmarks ----------

export interface Village {
  z: number;
  side: 1 | -1;
  /** Distance of its centre inland from the bank. */
  inland: number;
  radius: number;
}

/**
 * The villages along the channel the scene builds its huts, ghats and groves round (world/village.ts): real
 * settlements by the channel (GEOGRAPHY_PLAN.md §4), each set back from its bank. The real houses, from the
 * building footprints, come later (plan's settlements step).
 */
const VILLAGE_PLACES: readonly { id: string; radius: number }[] = [
  { id: 'shaplapur', radius: 85 },
  { id: 'chhota-moheshkhali', radius: 80 },
  { id: 'bara-moheshkhali', radius: 80 },
  { id: 'gorakghata-town', radius: 95 },
];

export const VILLAGES: readonly Village[] = VILLAGE_PLACES.flatMap(({ id, radius }) => {
  const p = place(id).world;
  const info = bankInfo(p.x, p.z);
  // a village far inland is pulled to the nearest stretch of bank it lies behind
  return info.inland > 900 ? [] : [{ z: p.z, side: info.side, inland: clamp(info.inland, 40, 260), radius }];
});

export const VILLAGE_CENTERS: readonly Point2[] = VILLAGES.map((v) => ({
  x: riverX(v.z) + v.side * (edgeHalfWidth(v.z, v.side) + 18 + v.inland),
  z: v.z,
}));

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

/** The ponds by the villages (world/ponds.ts floats lilies on them): the map's small inland waters near them. */
export const PONDS: readonly (Point2 & { r: number; level: number })[] = (() => {
  const out: (Point2 & { r: number; level: number })[] = [];
  for (const c of VILLAGE_CENTERS) {
    // the inland water nearest the village centre, on a 5 m search round it
    let best: { x: number; z: number; d: number } | null = null;
    for (let dx = -250; dx <= 250; dx += 5) {
      for (let dz = -250; dz <= 250; dz += 5) {
        const x = c.x + dx;
        const z = c.z + dz;
        if (coverAt(x, z) !== COVER.pond) continue;
        const d = Math.hypot(dx, dz);
        if (!best || d < best.d) best = { x, z, d };
      }
    }
    if (!best) continue;
    // its size: how far the pond reaches from there (a few cells)
    let r = 4;
    while (r < 40 && coverAt(best.x + r, best.z) === COVER.pond && coverAt(best.x - r, best.z) === COVER.pond && coverAt(best.x, best.z + r) === COVER.pond) r += 2;
    const level = inlandSurfaceAt(best.x, best.z);
    if (level !== null) out.push({ x: best.x, z: best.z, r: Math.max(6, r), level });
  }
  return out;
})();

/** The small seasonal wetlands: real ones come with the land-use step; none are made up now. */
export const WETLANDS: readonly (Point2 & { r: number })[] = [];

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

/** 1 on a wetland's low, wet rim, 0 elsewhere. */
export function wetlandMarsh(x: number, z: number): number {
  let m = 0;
  for (const w of WETLANDS) {
    if (Math.abs(z - w.z) > w.r * 2.3) continue;
    const d = wetlandReach(w, x, z);
    m = Math.max(m, smoothstep(0.85, 1.0, d) * smoothstep(1.7, 1.45, d));
  }
  return m;
}

/** Adinath hill's temple: where it stands (z, u in the channel's frame), the terrace's height, its flat and the hill round it. */
export const ADINATH = { z: TEMPLE.z, u: TEMPLE.x - riverX(TEMPLE.z), top: TEMPLE.y, flat: TEMPLE.r, radius: 40 } as const;

/**
 * Gorakghata's landmarks (world/moheshkhali.ts): the old jetty from its landward end out over the mangrove flat
 * to its head on the channel (OSM way 43107027, 6 m wide) and the new one beside it (LGED's, 7.3 m wide; on
 * which side is not mapped: [মডেল] its north), the Adinath jetty with its T-shaped head (OSM way 43106847), the
 * stair up to the temple from the Adinath jetty's landward end, and the pagoda (its place is not known: D3,
 * kept behind the town). The town's buildings are the map's own.
 */
export const GORAKGHATA = (() => {
  const land = place('gorakghata-jetty-land').world;
  const head = place('gorakghata-jetty-head').world;
  const town = place('gorakghata-town').world;
  const adinathLand = place('adinath-jetty-land').world;
  const at = (zz: number, inland: number) => ({ x: riverX(zz) + edgeHalfWidth(zz, 1) + inland, z: zz });
  const townInland = bankInfo(town.x, town.z).inland;
  return {
    jetty: { x: land.x, z: land.z, toX: head.x, toZ: head.z, length: Math.hypot(head.x - land.x, head.z - land.z), width: 6 },
    /** The new jetty: along the old one, this far to its north (m), its own width between. */
    newJetty: { offset: 8.4, width: 7.3 },
    adinathJetty: (() => {
      const h = place('adinath-jetty-head').world;
      return { x: adinathLand.x, z: adinathLand.z, toX: h.x, toZ: h.z, length: Math.hypot(h.x - adinathLand.x, h.z - adinathLand.z), width: 4.5 };
    })(),
    stair: { from: { x: adinathLand.x, z: adinathLand.z }, to: { x: TEMPLE.x, z: TEMPLE.z - TEMPLE.r * 0.8 } },
    pagoda: { ...at(town.z - 80, townInland + 70), r: 10 },
  };
})();

/** The dry-fish yards: Nazirartek at Cox's Bazar (OSM's shutki market). */
export const SHUTKI_YARDS: readonly { x: number; z: number; ry: number; rows: number }[] = (() => {
  const n = place('nazirartek').world;
  return [{ x: n.x, z: n.z, ry: -0.3, rows: 7 }];
})();

/** The temple's terrace, kept clear of trees so the temple stands visible. */
export function onTempleHill(x: number, z: number): boolean {
  return Math.hypot(x - TEMPLE.x, z - TEMPLE.z) < TEMPLE.r + 6;
}

/** Ground the landmarks stand on (with `margin` m round it): no huts, trees or tall grass there. */
export function onLandmark(x: number, z: number, margin = 0): boolean {
  const g = GORAKGHATA;
  if (Math.hypot(x - g.pagoda.x, z - g.pagoda.z) < g.pagoda.r + margin) return true;
  for (const y of SHUTKI_YARDS) if (Math.hypot(x - y.x, z - y.z) < 14 + margin) return true;
  if (Math.hypot(x - TEMPLE.x, z - TEMPLE.z) < TEMPLE.r + 3 + margin) return true;
  // along the jetty and the stair
  const nearSegment = (a: Point2, b: Point2, w: number) => {
    const sx = b.x - a.x;
    const sz = b.z - a.z;
    const t = Math.max(0, Math.min(1, ((x - a.x) * sx + (z - a.z) * sz) / (sx * sx + sz * sz)));
    return Math.hypot(x - a.x - sx * t, z - a.z - sz * t) < w + margin;
  };
  if (nearSegment({ x: g.jetty.x, z: g.jetty.z }, { x: g.jetty.toX, z: g.jetty.toZ }, g.jetty.width + g.newJetty.offset + g.newJetty.width / 2)) return true;
  if (nearSegment({ x: g.adinathJetty.x, z: g.adinathJetty.z }, { x: g.adinathJetty.toX, z: g.adinathJetty.toZ }, g.adinathJetty.width)) return true;
  return nearSegment(g.stair.from, g.stair.to, 2.6);
}
