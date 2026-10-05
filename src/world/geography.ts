import { smoothstep } from '../core/mathx';
import { fbm } from '../core/noise';
import { FeatureGrid, HOMESTEAD_MOUNDS, MOUNDS, PONDS, POND_BANK, local, pondReach, shapeDistance, shapePoint, type Mound, type Pond } from './layout';
import { BANYAN, FAR_GROVES, HILLS, MOUND, PLAIN, POND_LEVEL, POND_RISE, SALT_FIELD, TEA_STALL, WATER_LEVEL, WORLD } from './plan';
import { railGround, railShare } from './railway';
import { onRoad, roadCover, roadEdge, roadGround } from './roads';
import { BRIDGE, SANKO, bridgeDeck, bridgeEnds, bridgeFrame, bridgeSoffit, bridgeToWorld, onBridge, onSanko, sankoEnds, type Point2 } from './sites';
import {
  BIL,
  JOURNEY,
  KHAL,
  RIVER,
  SALT_CREEK,
  SIDE_KHAL,
  WATERWAYS,
  bilLocal,
  bilPoint,
  bilReach,
  charShare,
  journeyAt,
  journeyDistance,
  journeyFrame,
  journeyHalfWidth,
  riverLevee,
  waterwayAt,
} from './waterways';

// Where land and water are. The terrain mesh, the water and every placement read these, so the boat, the
// trees, the houses and the beds always agree.
//
// The ground is built from the village's design (world/plan.ts): the fields at one level with a low natural
// levee along the river, the homesteads' mounds and the landmarks' plinths raised above them, the brick road
// on its embankment, the ponds dug with their banks thrown up round them, and the river, the khal, the side
// khal and the bil cut in, their banks of mud (and on the inside of the river's bend a broad sandy char).
// x points west, z north; heights are metres, the water at WATER_LEVEL.

export { BIL, JOURNEY, WATER_LEVEL, bilLocal, bilPoint, bilReach, charShare, journeyAt, journeyFrame, journeyHalfWidth, onRoad, waterwayAt };
export { BRIDGE, SANKO, bridgeDeck, bridgeEnds, bridgeFrame, bridgeSoffit, bridgeToWorld, onBridge, onSanko, sankoEnds, type Point2 };
export { HOMESTEAD_MOUNDS, MOUNDS, PONDS, pondReach, shapePoint, type Mound, type Pond };

/** The designed area's extent: x from WORLD_X0 (east edge) to WORLD_X1 (west edge), z from WORLD_Z1 (south) to WORLD_Z0 (north). */
export const WORLD_X0 = WORLD.x0;
export const WORLD_X1 = WORLD.x1;
export const WORLD_Z0 = WORLD.z1;
export const WORLD_Z1 = WORLD.z0;

const MOUND_GRID = new FeatureGrid<Mound>();
for (const m of MOUNDS) MOUND_GRID.add(m, m.x, m.z, Math.max(m.hu, m.hv) + (m.top - PLAIN) / m.slope + 4);

/** A little unevenness on a mound's edge, so none is drawn with a template (m). */
const edgeWobble = (x: number, z: number) => (fbm(x * 0.06, z * 0.06, 2, 41) - 0.5) * 2.4;

/** The height the mounds hold the ground at (x, z) up to, or −∞ away from them. */
function moundGround(x: number, z: number): number {
  let h = -Infinity;
  for (const m of MOUND_GRID.at(x, z)) {
    const d = shapeDistance(m, x, z) + edgeWobble(x, z);
    // the yard is swept a little high in its middle, so the rain runs off it
    const crown = 0.12 * smoothstep(0, -Math.min(m.hu, m.hv), d);
    h = Math.max(h, d <= 0 ? m.top + crown : m.top - d * m.slope);
  }
  return h;
}

// ---------- the ponds ----------


const POND_GRID = new FeatureGrid<Pond>();
for (const p of PONDS) POND_GRID.add(p, p.x, p.z, Math.max(p.hu, p.hv) + POND_BANK.top + 4);



/** The pond whose water or bank (x, z) is on, and the signed distance from its dug edge; null away from them. */
function pondNear(x: number, z: number): { pond: Pond; d: number } | null {
  let best: { pond: Pond; d: number } | null = null;
  for (const p of POND_GRID.at(x, z)) {
    const d = shapeDistance(p, x, z);
    if (d < POND_BANK.top + 3.5 && (!best || d < best.d)) best = { pond: p, d };
  }
  return best;
}

/** The ground a pond leaves at (x, z), given the ground without it: its bank raised round it, its bowl dug in. */
function pondGround(x: number, z: number, ground: number): number {
  const n = pondNear(x, z);
  if (!n) return ground;
  const top = PLAIN + POND_BANK.above;
  if (n.d <= 0) return Math.max(n.pond.level - POND_BANK.depth, top + n.d * POND_BANK.inner);
  return Math.max(ground, top - Math.max(0, n.d - POND_BANK.top) * POND_BANK.slope);
}

// ---------- the waterways' banks ----------

/** How far under the water the bed lies at the water's edge (m): the bank rises from there. */
const EDGE_DEPTH = 0.12;

/** How the bank rises from the water to the land (m across): mud on the river and the khal, shorter on the narrow side khal. */
function bankWidth(way: (typeof WATERWAYS)[number], x: number, z: number): number {
  if (way === SIDE_KHAL) return 3;
  if (way === KHAL) return 5;
  // the salt creek's banks are the tide's mud, wide and low
  if (way === SALT_CREEK) return 9;
  // the river's char: on the inside of its broad bend the bank lies down into a long, low beach of sand
  return 7 + 30 * charShare(x, z);
}

/**
 * The ground a waterway leaves at (x, z), given the land beside it: its bed shoaling to its sides, then its
 * bank rising to the land; the land itself beyond the bank.
 */
function wayGround(x: number, z: number, land: number): number {
  let h = land;
  for (const way of WATERWAYS) {
    const f = way.frame(x, z);
    if (!f) continue;
    const half = way.half(f.s);
    const bank = bankWidth(way, x, z);
    if (f.d > half + bank) continue;
    let g: number;
    if (f.d < half) {
      const bed = WATER_LEVEL - way.depth(f.s);
      g = bed + (WATER_LEVEL - EDGE_DEPTH - bed) * smoothstep(0.3, 1, f.d / half);
    } else {
      // a mud slope from just under the water up to the land, steepest at the water (where the current cuts
      // it) and rounding over at the top; it is out of the water within a step of the edge, so no hollow
      // below the water's level lies beyond it
      const t = (f.d - half) / bank;
      g = WATER_LEVEL - EDGE_DEPTH + (land - WATER_LEVEL + EDGE_DEPTH) * (t * (2 - t));
    }
    h = Math.min(h, g);
  }
  return h;
}

/** How much of (x, z) is a waterway's bank (0..1): its mud slope and a grassy strip along its top; the fields keep off it. */
export function bankStrip(x: number, z: number): number {
  const w = waterwayAt(x, z);
  if (!w) return 0;
  const bank = bankWidth(w.way, x, z);
  return 1 - smoothstep(w.half + bank + 3, w.half + bank + 8, w.d);
}

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

/** The lane across the bil (m): its depth below the bil's mean water, its flat middle's half-width, and the width of its sides. */
const BIL_LANE = { depth: 1.5, half: 4, side: 14 };

/**
 * How deep the lane the boat's way keeps from the khal's mouth across the bil lies (m below the bil's mean
 * water; 0 off it): a beel keeps a deeper channel where its khal's water runs through it, and in the dry months
 * that is all the water left across its rim, so the boat still goes in. Only within the bil and its rim.
 */
function bilLane(x: number, z: number): number {
  if (!nearBil(x, z) || bilReach(x, z) > 1.45) return 0;
  return BIL_LANE.depth * smoothstep(BIL_LANE.half + BIL_LANE.side, BIL_LANE.half, journeyDistance(x, z));
}

/**
 * How much of (x, z) is the salt creek's flats (0..1): the tide's grey mud and salt-burnt grass either side of it,
 * where nothing is sown (the field crops keep off).
 */
export function creekFlats(x: number, z: number): number {
  const f = SALT_CREEK.frame(x, z);
  if (!f) return 0;
  return smoothstep(40, 14, f.d - SALT_CREEK.half(f.s));
}

/** The ground the bil leaves at (x, z): its bowl, then a low marshy rim rising slowly to the fields; the boat's lane through both. */
function bilGround(x: number, z: number, ground: number): number {
  if (!nearBil(x, z)) return ground;
  const e = bilReach(x, z);
  const lane = BIL.level - bilLane(x, z);
  if (e < 1) return Math.min(ground, BIL.level - bilDepth(x, z), lane);
  if (e < 1.45) return Math.min(ground, BIL.level - 0.04 + (ground - BIL.level + 0.04) * smoothstep(1, 1.45, e), lane);
  return ground;
}

/**
 * How far (x, z) lies outside the land the village keeps to (m): the boat's way and the bil's water, from which
 * the land runs `CORRIDOR.clear` m (glsl.ts) before it fades into the haze. The user asked for the land either side
 * of the waters cut to a third, nothing grown on the rest and nobody let out onto it.
 */
export function corridorDistance(x: number, z: number): number {
  const way = journeyDistance(x, z);
  if (Math.hypot(x - BIL.x, z - BIL.z) > BIL.halfLen + 600) return way;
  // the bil's reach is in its own half-sizes: about its narrower half-width a unit beyond its shore
  return Math.min(way, Math.max(0, bilReach(x, z) - 1) * BIL.halfWid);
}

/** Distance from (x, z) to the boat's way: the lilies and the floating plants leave it open. */
export function routeGap(x: number, z: number): number {
  return journeyFrame(x, z)?.d ?? Infinity;
}

// ---------- the salt field ----------

/** The salt field's floor (m): graded flat a little below the fields, so the brine stands in its beds. */
const SALT_LEVEL = PLAIN - 0.3;

/** (x, z) in the salt field's frame (m): `u` along its length from its east end, `v` across it from its north side. The result is reused. */
const saltAt = { u: 0, v: 0 };
export function saltLocal(x: number, z: number): { u: number; v: number } {
  const s = Math.sin(SALT_FIELD.yaw);
  const c = Math.cos(SALT_FIELD.yaw);
  const dx = x - SALT_FIELD.x;
  const dz = z - SALT_FIELD.z;
  saltAt.u = dx * s + dz * c + SALT_FIELD.w / 2;
  saltAt.v = dx * c - dz * s + SALT_FIELD.d / 2;
  return saltAt;
}

/** A point of the salt field's frame in the world. */
export function saltPoint(u: number, v: number): { x: number; z: number } {
  const s = Math.sin(SALT_FIELD.yaw);
  const c = Math.cos(SALT_FIELD.yaw);
  const a = u - SALT_FIELD.w / 2;
  const b = v - SALT_FIELD.d / 2;
  return { x: SALT_FIELD.x + a * s + b * c, z: SALT_FIELD.z + a * c - b * s };
}

/** How much of (x, z) is the salt field's ground (0..1): all of it inside its edge, none 3 m beyond. */
export function saltShare(x: number, z: number): number {
  const { u, v } = saltLocal(x, z);
  const d = Math.max(-u, u - SALT_FIELD.w, -v, v - SALT_FIELD.d);
  return smoothstep(3, 0, d);
}

// ---------- the ground ----------

/** The fields' gentle unevenness (m): no plain is quite flat. */
const unevenness = (x: number, z: number) => (fbm(x * 0.004, z * 0.004, 2, 7) - 0.5) * 0.24;

/**
 * How high the hills (plan.ts HILLS) stand over the plain at (x, z): each a lumpy dome, its outline wavering and
 * its top in shoulders and saddles rather than a smooth bell.
 */
export function hillHeight(x: number, z: number): number {
  let h = 0;
  for (const hill of HILLS) {
    const dx = x - hill.x;
    const dz = z - hill.z;
    if (Math.abs(dx) > hill.r * hill.stretch * 1.2 && Math.abs(dz) > hill.r * hill.stretch * 1.2) continue;
    const s = Math.sin(hill.yaw);
    const c = Math.cos(hill.yaw);
    const a = (dx * s + dz * c) / hill.stretch;
    const b = dx * c - dz * s;
    const d = (Math.hypot(a, b) / hill.r) * (0.85 + 0.3 * fbm(x * 0.006 + hill.x * 0.01, z * 0.006, 3, 51));
    if (d >= 1) continue;
    // a dome, or (steep) a low foot and then a steep climb to the top
    const dome = hill.steep !== undefined ? (1 - smoothstep(hill.steep, 1, d)) ** 1.5 : (1 - d * d) ** 2;
    h = Math.max(h, hill.h * dome * (0.72 + 0.56 * fbm(x * 0.014 + 3, z * 0.014, 3, 53)));
  }
  return h;
}

/** How much of (x, z) is a hill's wooded ground (0..1). */
export function hillShare(x: number, z: number): number {
  return smoothstep(0.8, 3, hillHeight(x, z));
}

/**
 * How much of (x, z) is a far village's raised ground (0..1): each of `FAR_GROVES` stands on land a little above
 * the fields, an ellipse as its trees are planted (vegetation.ts), its edge wandering, so from the air its grove
 * reads as a village on its mound and not as trees standing in the paddy.
 */
export function groveShare(x: number, z: number): number {
  let share = 0;
  for (const g of FAR_GROVES) {
    const dx = (x - g.x) / 1.3;
    const dz = (z - g.z) / 0.8;
    if (Math.abs(dx) > g.r * 1.2 || Math.abs(dz) > g.r * 1.2) continue;
    const d = (Math.hypot(dx, dz) / g.r) * (0.85 + 0.3 * fbm(x * 0.012 + g.x * 0.01, z * 0.012, 2, 57));
    share = Math.max(share, smoothstep(1.08, 0.9, d));
  }
  return share;
}

/** The land before the waters are cut in: the fields, the levee, the hills, the mounds, the road's and the railway's embankments, the ponds' banks. */
function landHeight(x: number, z: number): number {
  const char = charShare(x, z);
  let h = PLAIN + unevenness(x, z) * (1 - char) + riverLevee(x, z) - 0.6 * char + hillHeight(x, z);
  h = Math.max(h, moundGround(x, z), PLAIN + MOUND * 0.8 * groveShare(x, z));
  const salt = saltShare(x, z);
  if (salt > 0) h += (SALT_LEVEL - h) * salt;
  h = roadGround(x, z, h);
  h = railGround(x, z, h);
  return pondGround(x, z, h);
}

/** Height of the ground at (x, z): the land, with the river, the khals and the bil cut in. */
export function terrainHeight(x: number, z: number): number {
  return bilGround(x, z, wayGround(x, z, landHeight(x, z)));
}

/** The surface of a pond's water over (x, z), or null where there is none. */
function pondSurface(x: number, z: number): number | null {
  for (const p of POND_GRID.at(x, z)) if (pondReach(p, x, z) < 1) return p.level;
  return null;
}

// ---------- the season's water ----------

let rise = 0;

/** Sets the season's rise of the waters above their mean level (m; main.ts, each frame, from env/season.ts `water`). */
export function setWaterRise(metres: number): void {
  rise = metres;
}

/** The season's rise of the river, the khals and the bil above their mean level (m; negative in the dry months). */
export function waterRise(): number {
  return rise;
}

/**
 * The surface of the water standing at (x, z) at its mean level: the river's, the khals' and the bil's, or a
 * pond's; −∞ on dry ground. The maps baked once (the water's level map, the ground's wet band) read this.
 */
export function meanWaterLevelAt(x: number, z: number): number {
  if (nearBil(x, z) && (bilReach(x, z) < 1.05 || bilLane(x, z) > 0.2)) return BIL.level;
  const w = waterwayAt(x, z);
  if (w && w.d < w.half + 1) return WATER_LEVEL;
  return pondSurface(x, z) ?? -Infinity;
}

/** Where a water whose mean level is `mean` stands this season: the waterways and the bil raised by all the rise, a pond by POND_RISE of it. */
export function risenLevel(mean: number): number {
  return mean + rise * (mean > (WATER_LEVEL + POND_LEVEL) / 2 ? POND_RISE : 1);
}

/** How far out from a waterway's water (m), or the bil's rim (its half-widths), a rising water can spill up the bank: the level map's reach (water.ts). */
const SPILL = { way: 40, bil: 1.6 };

/**
 * The surface of the water standing at (x, z) this season: the mean raised or lowered by the season's rise
 * (GLSL waterLevels does the same), and in the rains the risen water out over the banks' foot and the bil's
 * low rim; −∞ on dry ground. In the dry months it may lie below the ground where the water has drawn back.
 */
export function waterLevelAt(x: number, z: number): number {
  const mean = meanWaterLevelAt(x, z);
  if (Number.isFinite(mean)) return risenLevel(mean);
  if (rise <= 0) return mean;
  const top = WATER_LEVEL + rise;
  const w = waterwayAt(x, z);
  const near = (w !== null && w.d < w.half + SPILL.way) || (nearBil(x, z) && bilReach(x, z) < SPILL.bil);
  return near && terrainHeight(x, z) < top ? top : -Infinity;
}

/**
 * The level of the water whose bank (x, z) is on: a waterway's mud bank, the bil's rim, a pond's bank; the
 * water's own where (x, z) is under it; −∞ away from them. The ground's wet band reads it.
 */
export function shoreLevel(x: number, z: number): number {
  const here = meanWaterLevelAt(x, z);
  if (Number.isFinite(here)) return here;
  if (bankStrip(x, z) > 0) return WATER_LEVEL;
  if (nearBil(x, z) && bilReach(x, z) < 1.5) return BIL.level;
  const n = pondNear(x, z);
  return n && n.d < POND_BANK.top ? n.pond.level : -Infinity;
}

/** Whether (x, z) holds water: the river, a khal, the bil or a pond. */
export function inlandWaterAt(x: number, z: number): boolean {
  if (nearBil(x, z) && (bilReach(x, z) < 1 || bilLane(x, z) > 0.3)) return true;
  const w = waterwayAt(x, z);
  if (w && w.d < w.half) return true;
  return pondSurface(x, z) !== null;
}

/** True if (x, z) is within `margin` metres of water: the river, a khal, the bil, a pond. */
export function nearBackwater(x: number, z: number, margin: number): boolean {
  const w = waterwayAt(x, z);
  if (w && w.d < w.half + margin) return true;
  if (nearBil(x, z) && (bilReach(x, z) < 1 + margin / BIL.halfWid || bilLane(x, z) > 0)) return true;
  const n = pondNear(x, z);
  return n !== null && pondReach(n.pond, x, z) < 1 + margin / Math.max(4, Math.min(n.pond.hu, n.pond.hv));
}

/** Calls `mark` with every point (≈2 m apart) of the waterways' water and its level: world/water.ts paints them into its map of which water stands where. */
export function eachWaterwayPoint(mark: (x: number, z: number, level: number) => void): void {
  for (const way of WATERWAYS) {
    for (let s = 0; s <= way.length; s += 2) {
      const p = way.at(s);
      const half = way.half(s) + 1;
      const nx = Math.cos(p.heading);
      const nz = -Math.sin(p.heading);
      for (let a = -half; a <= half + 1e-6; a += 2) mark(p.x + nx * a, p.z + nz * a, WATER_LEVEL);
    }
  }
}

// ---------- what covers the ground ----------

/**
 * What the ground at (x, z) is, for its painting and what grows on it (0..1 each): `yard` a homestead's swept
 * earth or a landmark's trodden ground, `mound` the rest of a mound's top and its slope (the homestead's
 * garden and grove), `verge` the grass along the banks, the ponds and the road, `sand` the char, `marsh` the
 * bil's rim. The rest is field.
 */
export interface LandUse {
  yard: number;
  mound: number;
  verge: number;
  sand: number;
  marsh: number;
  /** The salt field's beds and bunds. */
  salt: number;
  /** The salt creek's mud flats. */
  flats: number;
  field: number;
}

const use: LandUse = { yard: 0, mound: 0, verge: 0, sand: 0, marsh: 0, salt: 0, flats: 0, field: 0 };

/** How much of (x, z) is each kind of ground (see LandUse). The result is reused. */
export function landUse(x: number, z: number): LandUse {
  let yard = 0;
  let mound = 0;
  for (const m of MOUND_GRID.at(x, z)) {
    const d = shapeDistance(m, x, z) + edgeWobble(x, z) * 0.5;
    // the mound and its slope, then a few metres of garden at its foot
    mound = Math.max(mound, smoothstep(5, 0, d));
    if (m.home) {
      // the yard: the middle of the mound, swept bare
      const { u, v } = local(m, x, z);
      const yu = m.hu * 0.42;
      const yv = m.hv * 0.42;
      const k = Math.hypot(Math.max(0, Math.abs(u - m.hu * 0.08) - yu), Math.max(0, Math.abs(v) - yv));
      yard = Math.max(yard, smoothstep(2.5, 0.5, k));
    } else if (m.id === 'banyan') {
      // the hub's ground is trodden bare round the banyan's platform and in front of the tea stall
      yard = Math.max(yard, smoothstep(13, 6, Math.hypot(x - BANYAN.x, z - BANYAN.z)), smoothstep(7, 3, Math.hypot(x - TEA_STALL.x, z - TEA_STALL.z)));
    }
  }
  let verge = bankStrip(x, z);
  const n = pondNear(x, z);
  if (n) verge = Math.max(verge, smoothstep(POND_BANK.top + 3.5, POND_BANK.top + 1, n.d));
  verge = Math.max(verge, smoothstep(6, 1, roadEdge(x, z)), roadCover(x, z));
  verge = Math.max(verge, railShare(x, z));
  // the hills are forest: the grove's floor under their trees
  mound = Math.max(mound, hillShare(x, z), groveShare(x, z));
  const sand = charShare(x, z) * (1 - mound);
  const marsh = bilMarsh(x, z);
  const salt = saltShare(x, z);
  const flats = creekFlats(x, z) * (1 - salt);
  use.yard = yard;
  use.mound = Math.max(0, mound - yard);
  use.verge = Math.max(0, verge * (1 - mound) - sand - salt - flats);
  use.sand = sand;
  use.marsh = marsh;
  use.salt = salt;
  use.flats = flats;
  use.field = Math.max(0, 1 - mound - use.verge - sand - marsh - salt - flats);
  return use;
}

// ---------- landmarks ----------

/** The landmarks' own ground (with `margin` m round it): no huts, trees or tall grass there. */
export function onLandmark(x: number, z: number, margin = 0): boolean {
  if (onBridge(x, z, margin + 1) || onSanko(x, z, margin + 0.5)) return true;
  if (Math.hypot(x - BANYAN.x, z - BANYAN.z) < 5 + margin) return true;
  if (Math.hypot(x - TEA_STALL.x, z - TEA_STALL.z) < 4 + margin) return true;
  // the salt field: its beds and bunds are worked ground
  const salt = saltLocal(x, z);
  if (Math.max(-salt.u, salt.u - SALT_FIELD.w, -salt.v, salt.v - SALT_FIELD.d) < margin) return true;
  for (const m of MOUNDS) if (!m.home && m.id !== 'banyan' && shapeDistance(m, x, z) < margin - 4) return true;
  return false;
}

/** Where a homestead comes down to its water: snapped to the nearest bank of the river or a khal, `s` along it and the side it is on. */
export interface BankSpot {
  x: number;
  z: number;
  /** The waterway, how far along it, and the side (+1 left going along it). */
  way: (typeof WATERWAYS)[number];
  s: number;
  side: 1 | -1;
  /** The way up the bank, away from the water (radians, as headings). */
  up: number;
}

/** The bank nearest (x, z): the water's edge there, on the nearest waterway. */
export function bankAt(x: number, z: number): BankSpot | null {
  let best: BankSpot | null = null;
  let near = Infinity;
  for (const way of WATERWAYS) {
    const s = way.line.nearestS(x, z);
    const p = way.at(s);
    const d = Math.hypot(p.x - x, p.z - z);
    if (d > 80 || d >= near) continue;
    near = d;
    // which side of the middle the point is on, and the edge of the water on that side
    const side = Math.cos(p.heading) * (x - p.x) - Math.sin(p.heading) * (z - p.z) >= 0 ? 1 : -1;
    const half = way.half(s);
    const e = way.beside(s, side, half);
    best = { x: e.x, z: e.z, way, s, side, up: Math.atan2(Math.cos(p.heading) * side, -Math.sin(p.heading) * side) };
  }
  return best;
}

export { KHAL, RIVER, SALT_CREEK, SIDE_KHAL, WATERWAYS };
