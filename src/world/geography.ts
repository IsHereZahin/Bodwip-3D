import { smoothstep } from '../core/mathx';
import { fbm } from '../core/noise';
import { SegmentIndex } from '../core/segmentIndex';
import { CELL, COVER, GRID_H, GRID_W, KIND, LINES, WORLD, cellAt, cellCentre, coverAt, inlandSurfaceAt, kindAt } from '../geo/data';
import { MAP_SCALE } from '../geo/project';
import { BIL, JOURNEY, KHAL_LEVEL, baseGround, bilLocal, bilReach, corridorDrop, khalAt, khalDepth, khalFrame, khalHalfWidth } from './khal';
import { onRoad, roadGround } from './roads';

// Where land and water are. The terrain mesh, the water and every placement read these, so the boat, the
// trees and the beds always agree.
//
// The world is a small window of the real Moheshkhali map at 1:3 (src/geo/project.ts): the khal winding
// through Bara Moheshkhali under the old bridge, the shapla bil at its head, and the village, fields, ponds
// and hills' feet round them. The ground comes from the baked open data (geo/data.ts), with the strip round
// the khal brought to lie a little above its water (world/khal.ts). Heights and objects keep their real size;
// x points west, z north.
//
// All the water is inland: the khal and the bil at one level (KHAL_LEVEL), the ponds and the small khals at
// their own. There is no sea in this world (the map's few tidal cells at its edge are ground).

export { BIL, JOURNEY, KHAL_LEVEL, bilReach, khalAt, khalFrame, khalHalfWidth };

/** The baked map's extent: x from WORLD_X0 (east edge) to WORLD_X1 (west edge), z from WORLD_Z1 (south) to WORLD_Z0 (north). */
export const WORLD_X0 = WORLD.x0;
export const WORLD_X1 = WORLD.x1;
export const WORLD_Z0 = WORLD.z1;
export const WORLD_Z1 = WORLD.z0;

export interface Point2 {
  x: number;
  z: number;
}

// ---------- the khal's banks ----------

/** The khal's banks: mud sloping from its water up over this many metres, to a low levee this far above it. */
const BANK = 5;
const LEVEE = 0.55;

// ---------- the shapla bil ----------

function nearBil(x: number, z: number): boolean {
  return Math.hypot(x - BIL.x, z - BIL.z) < BIL.halfLen * 1.65;
}

/** 1 on the bil's low, wet rim (just above its water), 0 elsewhere: wet meadow rather than bare ground. */
export function bilMarsh(x: number, z: number): number {
  if (!nearBil(x, z)) return 0;
  const e = bilReach(x, z);
  return smoothstep(0.98, 1.04, e) * smoothstep(1.5, 1.35, e);
}

/** Depth of the bil's water at (x, z): an undulating bed with a deeper hollow, shoaling to the reedy edge. */
export function bilDepth(x: number, z: number): number {
  const e = bilReach(x, z);
  if (e >= 1) return 0;
  const { a, c } = bilLocal(x, z);
  const bed = 0.75 + 0.9 * fbm(a * 0.022 + 3, c * 0.022, 3, 81) + 0.6 * Math.exp(-(((a + 50) / 35) ** 2 + ((c + 15) / 22) ** 2));
  return bed * smoothstep(1, 0.72, e) + 0.04;
}

/** Distance from (x, z) to the boat's way (the khal's middle, on into the bil): the lilies leave it open. */
export function routeGap(x: number, z: number): number {
  return khalFrame(x, z)?.d ?? Infinity;
}

// ---------- the old bridge ----------

/**
 * The old bridge (world/bridge.ts, D3): a humped brick arch carrying a village path over the khal, where
 * OpenStreetMap has a small road bridge over it. Its frame: x along the bridge, across the khal; z along the
 * khal; `angle` turns that frame into the world's (as a rotation about y). Heights in the frame are above the
 * khal's water (`water`, a world height): world/bridge.ts sets the bridge there.
 */
export const BRIDGE = (() => {
  const p = khalAt(JOURNEY.bridge);
  return {
    x: p.x,
    z: p.z,
    angle: p.heading,
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
    bank: 0.9,
    /** The khal's water (world height). */
    water: KHAL_LEVEL,
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

// ---------- the small khals, streams and drains ----------

/**
 * OSM's other waterways (the small khals, the hill streams, the drains) are cut into the ground at 1:3 of a
 * typical width for their kind (OSM has no widths: [মডেল]), each with its water a little below the land either
 * side. Where the map already has water (a pond) nothing is cut: they run into it.
 */
const WATERWAY_KINDS: Readonly<Record<string, { width: number; depth: number }>> = {
  river: { width: 30, depth: 2 },
  canal: { width: 15, depth: 1.5 },
  stream: { width: 8, depth: 0.8 },
  drain: { width: 4, depth: 0.6 },
  ditch: { width: 3, depth: 0.5 },
};
/** A small khal's water stands this far below the land along it (m); its banks slope up to the fields over this many metres. */
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

/** The khal itself is drawn from world/khal.ts: OSM's line of it is left out here (all but where it runs on beyond the world's journey). */
const REACHES: readonly Reach[] = LINES.flatMap((l) => {
  const kind = l.k === 'waterway' && l.t !== undefined ? WATERWAY_KINDS[l.t] : undefined;
  if (!kind) return [];
  const half = Math.max(1, kind.width / MAP_SCALE / 2);
  const p = l.points;
  const out: Reach[] = [];
  for (let k = 0; k + 3 < p.length; k += 2) {
    // a piece the khal already carries is not cut again
    const f = khalFrame((p[k] + p[k + 2]) / 2, (p[k + 1] + p[k + 3]) / 2);
    if (f && f.d < 30) continue;
    out.push({ ax: p[k], az: p[k + 1], bx: p[k + 2], bz: p[k + 3], half, depth: kind.depth, la: baseGround(p[k], p[k + 1]) - FREEBOARD, lb: baseGround(p[k + 2], p[k + 3]) - FREEBOARD });
  }
  return out;
});

/** The reaches filed by 32 m cells (the ground is asked about the khals at every vertex and every placement). */
const REACH_INDEX = new SegmentIndex(32);
for (const r of REACHES) REACH_INDEX.add(r.ax, r.az, r.bx, r.bz, r.half, BANKS);

/** The small khal nearest (x, z), measured against its width: how far from its middle, its half-width, depth and water's level. */
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
 * Calls `mark` with every point (≈3 m apart) of the water of the khal, the bil's way in and every small khal
 * cut into dry ground, and its level there: world/water.ts paints them into its map of which water stands where.
 */
export function eachWaterwayPoint(mark: (x: number, z: number, level: number) => void): void {
  for (let s = 0; s <= JOURNEY.length; s += 2) {
    const p = khalAt(s);
    const half = khalHalfWidth(s) + 1;
    const nx = Math.cos(p.heading);
    const nz = -Math.sin(p.heading);
    for (let a = -half; a <= half + 1e-6; a += 2) mark(p.x + nx * a, p.z + nz * a, KHAL_LEVEL);
  }
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
        if (kindAt(x, z) !== KIND.inland) mark(x, z, r.la + (r.lb - r.la) * t);
      }
    }
  }
}

/** The ground the bil's and the small khals' carving leaves at (x, z), or +∞ where they do not reach. */
function carved(x: number, z: number, ground: number): number {
  let h = Infinity;
  if (nearBil(x, z)) {
    const e = bilReach(x, z);
    // the water, then a low marshy rim rising slowly to the fields
    if (e < 1) h = BIL.level - bilDepth(x, z);
    else if (e < 1.45) h = BIL.level - 0.04 + (ground - BIL.level + 0.04) * smoothstep(1, 1.45, e);
  }
  const w = waterwayAt(x, z);
  if (w && kindAt(x, z) !== KIND.inland) {
    // a bed shoaling to the sides, then banks rising to the fields
    const bed = w.level - w.depth;
    if (w.d < w.half) h = Math.min(h, bed + (w.level - 0.2 - bed) * smoothstep(0.4, 1, w.d / w.half));
    else h = Math.min(h, w.level - 0.2 + (ground - w.level + 0.2) * (1 - (1 - (w.d - w.half) / BANKS) ** 2));
  }
  return h;
}

// ---------- the ponds' banks ----------

/**
 * A dug pond's bank (পাড়): the earth thrown up round it stands this far above its water and runs flat this
 * wide, then slopes away to the fields (rise over run); into the water it falls at 1 in `inner` (m).
 */
const POND_BANK = { above: 0.4, top: 4, slope: 0.25, inner: 1 };
/** How many map cells round a pond its bank may reach. */
const BANK_CELLS = 2;

/** Each map cell's pond surface (m), NaN where it holds no pond; and 1 on the cells a pond's bank may reach. */
const { POND_LEVEL, NEAR_POND } = (() => {
  const level = new Float32Array(GRID_W * GRID_H).fill(Number.NaN);
  const near = new Uint8Array(GRID_W * GRID_H);
  for (let r = 0; r < GRID_H; r++) {
    for (let c = 0; c < GRID_W; c++) {
      const p = cellCentre(c, r);
      const s = pondSurface(p.x, p.z);
      if (s === null) continue;
      level[r * GRID_W + c] = s;
      for (let dr = -BANK_CELLS; dr <= BANK_CELLS; dr++)
        for (let dc = -BANK_CELLS; dc <= BANK_CELLS; dc++) {
          const rr = r + dr;
          const cc = c + dc;
          if (rr >= 0 && cc >= 0 && rr < GRID_H && cc < GRID_W) near[rr * GRID_W + cc] = 1;
        }
    }
  }
  return { POND_LEVEL: level, NEAR_POND: near };
})();

/**
 * The height a pond's bank holds the ground at (x, z) up to, or −∞ away from the ponds: measured from the edge of
 * the pond's cells, outward over its bank and inward down into its water. The map's ground beside a pond is
 * often a little lower than the pond's measured surface; without the bank its water would stand above it.
 */
function pondBank(x: number, z: number): number {
  const e = pondEdge(x, z);
  if (!e) return -Infinity;
  const top = e.level + POND_BANK.above;
  return e.inside ? top - e.d / POND_BANK.inner : top - Math.max(0, e.d - POND_BANK.top) * POND_BANK.slope;
}

/** How far (x, z) is from the edge of a pond's cells within BANK_CELLS of it, whether inside it, and the pond's level; null away from them. */
const edge = { inside: false, d: 0, level: 0 };
function pondEdge(x: number, z: number): typeof edge | null {
  const i = cellAt(x, z);
  if (!NEAR_POND[i]) return null;
  const c0 = i % GRID_W;
  const r0 = Math.floor(i / GRID_W);
  const inside = !Number.isNaN(POND_LEVEL[i]);
  let best = Infinity;
  let level = inside ? POND_LEVEL[i] : Number.NaN;
  for (let dr = -BANK_CELLS; dr <= BANK_CELLS; dr++) {
    for (let dc = -BANK_CELLS; dc <= BANK_CELLS; dc++) {
      const r = r0 + dr;
      const c = c0 + dc;
      if (r < 0 || c < 0 || r >= GRID_H || c >= GRID_W) continue;
      const j = r * GRID_W + c;
      // inside a pond: the nearest dry cell; outside: the nearest pond cell
      if (Number.isNaN(POND_LEVEL[j]) !== inside) continue;
      const p = cellCentre(c, r);
      const d = Math.hypot(Math.max(0, Math.abs(x - p.x) - CELL / 2), Math.max(0, Math.abs(z - p.z) - CELL / 2));
      if (d < best) {
        best = d;
        if (!inside) level = POND_LEVEL[j];
      }
    }
  }
  if (!Number.isFinite(best)) return null;
  edge.inside = inside;
  edge.d = best;
  edge.level = level;
  return edge;
}

// ---------- the ground ----------

/**
 * Height of the ground at (x, z): the baked map brought down round the khal (world/khal.ts), with the roads'
 * embankments, the ponds' banks, the khal cut in (its bed shoaling to the sides, a mud bank up to a low levee
 * along it), the bil's bowl and the small khals.
 */
export function terrainHeight(x: number, z: number): number {
  let h = Math.max(roadGround(x, z, baseGround(x, z)), pondBank(x, z));
  const f = khalFrame(x, z);
  if (f) {
    const half = khalHalfWidth(f.s);
    // no ground beside the khal lies lower than its levee
    const lip = Math.max(h, KHAL_LEVEL + LEVEE * smoothstep(half + BANK + 18, half + BANK + 6, f.d));
    if (f.d < half) {
      const bed = KHAL_LEVEL - khalDepth(f.s);
      h = bed + (KHAL_LEVEL - 0.25 - bed) * smoothstep(0.35, 1, f.d / half);
    } else h = KHAL_LEVEL - 0.25 + (lip - KHAL_LEVEL + 0.25) * smoothstep(half, half + BANK, f.d);
  }
  return Math.min(h, carved(x, z, h));
}

/** True within `margin` m of a road's carriageway (world/roads.ts): huts, trees and crops keep off them. */
export { onRoad };

/**
 * The surface of a pond's water at (x, z) as the map measured it, brought down with the ground round it; null
 * where there is none. The map's water cells along the khal's own course are the khal's (drawn from
 * world/khal.ts, a little to one side of OSM's line where that wanders), not ponds.
 */
function pondSurface(x: number, z: number): number | null {
  const s = inlandSurfaceAt(x, z);
  if (s === null) return null;
  const f = khalFrame(x, z);
  if (f && f.d < khalHalfWidth(f.s) + 25) return null;
  return s - corridorDrop(x, z);
}

/**
 * The surface of the water standing at (x, z): the khal's and the bil's, a pond's, or a small khal's own level;
 * −∞ on dry ground.
 */
export function waterLevelAt(x: number, z: number): number {
  if (nearBil(x, z) && bilReach(x, z) < 1.05) return BIL.level;
  const f = khalFrame(x, z);
  if (f && f.d < khalHalfWidth(f.s) + 1) return KHAL_LEVEL;
  const w = waterwayAt(x, z);
  if (w && w.d < w.half + 1 && kindAt(x, z) !== KIND.inland) return w.level;
  return pondSurface(x, z) ?? -Infinity;
}

/**
 * The level of the water whose bank (x, z) is on: the khal's mud bank and levee, the bil's rim, a pond's bank, a
 * small khal's banks; the water's own where (x, z) is under it; −∞ away from them. The ground's wet band reads it.
 */
export function shoreLevel(x: number, z: number): number {
  const here = waterLevelAt(x, z);
  if (Number.isFinite(here)) return here;
  if (khalBank(x, z) > 0) return KHAL_LEVEL;
  if (nearBil(x, z) && bilReach(x, z) < 1.5) return BIL.level;
  const w = waterwayAt(x, z);
  if (w && w.d < w.half + BANKS + 2 && kindAt(x, z) !== KIND.inland) return w.level;
  return pondEdge(x, z)?.level ?? -Infinity;
}

/**
 * How much of (x, z) is the khal's bank (0..1): its mud slope and the levee's top along it, with a grassy strip
 * beyond; the fields' plots keep off it.
 */
export function khalBank(x: number, z: number): number {
  const f = khalFrame(x, z);
  if (!f) return 0;
  const half = khalHalfWidth(f.s);
  return 1 - smoothstep(half + BANK + 4, half + BANK + 9, f.d);
}

/** Whether (x, z) holds water: the khal, the bil, a pond or a small khal. */
export function inlandWaterAt(x: number, z: number): boolean {
  if (nearBil(x, z) && bilReach(x, z) < 1) return true;
  const f = khalFrame(x, z);
  if (f && f.d < khalHalfWidth(f.s)) return true;
  if (pondSurface(x, z) !== null) return true;
  const w = waterwayAt(x, z);
  return w !== null && w.d < w.half;
}

/** Where mangroves grow (0..1): the map's few keora and baen by the lower khal (Global Mangrove Watch, WorldCover). */
export function mangroveZone(x: number, z: number, _h: number): number {
  return kindAt(x, z) === KIND.mangrove || coverAt(x, z) === COVER.mangrove ? 1 : 0;
}

/** True if (x, z) is within `margin` metres of water: the khal, the bil, a pond, a small khal. */
export function nearBackwater(x: number, z: number, margin: number): boolean {
  const steps = Math.max(1, Math.ceil(margin / 5));
  for (let i = -steps; i <= steps; i++) {
    for (let j = -steps; j <= steps; j++) {
      if (i * i + j * j > steps * steps) continue;
      if (inlandWaterAt(x + (i * margin) / steps, z + (j * margin) / steps)) return true;
    }
  }
  return false;
}

// ---------- the ponds ----------

/**
 * The ponds within reach of the khal (world/ponds.ts floats lilies on them): the map's inland water, one pond
 * for each 60 m, its middle where most of its cells are, its level brought down with the ground round it.
 */
export const PONDS: readonly (Point2 & { r: number; level: number })[] = (() => {
  const out: (Point2 & { r: number; level: number })[] = [];
  for (let z = WORLD.z0 + 5; z < WORLD.z1; z += 10) {
    for (let x = WORLD.x0 + 5; x < WORLD.x1; x += 10) {
      if (coverAt(x, z) !== COVER.pond || inlandSurfaceAt(x, z) === null) continue;
      if (nearBil(x, z) && bilReach(x, z) < 1.4) continue;
      const f = khalFrame(x, z);
      if (f && f.d < khalHalfWidth(f.s) + 12) continue;
      if (out.some((p) => Math.hypot(p.x - x, p.z - z) < 60)) continue;
      // its size: how far the pond reaches from here
      let r = 4;
      while (r < 40 && coverAt(x + r, z) === COVER.pond && coverAt(x - r, z) === COVER.pond && coverAt(x, z + r) === COVER.pond) r += 2;
      const level = pondSurface(x, z);
      if (level !== null) out.push({ x, z, r: Math.max(6, r), level });
    }
  }
  return out;
})();

/** The small seasonal wetlands: none are made up. Kept for world/ponds.ts. */
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

/** Ground the scene's own landmark stands on (with `margin` m round it): the old bridge. No huts, trees or tall grass there. */
export function onLandmark(x: number, z: number, margin = 0): boolean {
  return onBridge(x, z, margin + 1);
}
