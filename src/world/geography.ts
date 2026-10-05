import { smoothstep } from '../core/mathx';
import { fbm } from '../core/noise';
import { BANYAN, HOMESTEADS, MOSQUE, MOUND, PLAIN, POND_LEVEL, TEA_STALL, WATER_LEVEL, WORLD, ZAMINDAR, type HomePond, type HomesteadSpec, type PondSpec } from './plan';
import { onRoad, roadCover, roadEdge, roadGround } from './roads';
import { BRIDGE, SANKO, bridgeDeck, bridgeEnds, bridgeFrame, bridgeSoffit, bridgeToWorld, onBridge, onSanko, sankoEnds, type Point2 } from './sites';
import {
  BIL,
  JOURNEY,
  KHAL,
  RIVER,
  SIDE_KHAL,
  WATERWAYS,
  bilLocal,
  bilPoint,
  bilReach,
  charShare,
  journeyAt,
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

/** The designed area's extent: x from WORLD_X0 (east edge) to WORLD_X1 (west edge), z from WORLD_Z1 (south) to WORLD_Z0 (north). */
export const WORLD_X0 = WORLD.x0;
export const WORLD_X1 = WORLD.x1;
export const WORLD_Z0 = WORLD.z1;
export const WORLD_Z1 = WORLD.z0;

// ---------- feature lookup ----------

/** A rounded rectangle on the ground, turned so its own +u looks along `face` (0 north, π/2 west). */
interface Shape {
  x: number;
  z: number;
  face: number;
  /** Half its size along its face (u) and across it (v), and its corners' radius (m). */
  hu: number;
  hv: number;
  corner: number;
}

/** (x, z) in a shape's frame: u along its face, v across it (to its left looking along it, +x when it faces north). */
function local(s: Shape, x: number, z: number): { u: number; v: number } {
  const dx = x - s.x;
  const dz = z - s.z;
  const sf = Math.sin(s.face);
  const cf = Math.cos(s.face);
  return { u: dx * sf + dz * cf, v: dx * cf - dz * sf };
}

/** The world point at (u, v) in a shape's frame. */
export function shapePoint(s: Shape, u: number, v: number): Point2 {
  const sf = Math.sin(s.face);
  const cf = Math.cos(s.face);
  return { x: s.x + u * sf + v * cf, z: s.z + u * cf - v * sf };
}

/** Signed distance from a shape's edge (negative inside, m). */
function shapeDistance(s: Shape, x: number, z: number): number {
  const { u, v } = local(s, x, z);
  const qu = Math.abs(u) - (s.hu - s.corner);
  const qv = Math.abs(v) - (s.hv - s.corner);
  return Math.hypot(Math.max(qu, 0), Math.max(qv, 0)) + Math.min(Math.max(qu, qv), 0) - s.corner;
}

/** Features filed by 40 m cells over the reach of their influence, for the ground's per-vertex questions. */
class FeatureGrid<T> {
  private readonly cells = new Map<number, T[]>();
  private static readonly CELL = 40;
  private key(i: number, j: number): number {
    return (i + 4096) * 8192 + (j + 4096);
  }
  add(item: T, x: number, z: number, reach: number): void {
    const C = FeatureGrid.CELL;
    for (let i = Math.floor((x - reach) / C); i <= Math.floor((x + reach) / C); i++)
      for (let j = Math.floor((z - reach) / C); j <= Math.floor((z + reach) / C); j++) {
        const k = this.key(i, j);
        let list = this.cells.get(k);
        if (!list) this.cells.set(k, (list = []));
        list.push(item);
      }
  }
  at(x: number, z: number): readonly T[] {
    return this.cells.get(this.key(Math.floor(x / FeatureGrid.CELL), Math.floor(z / FeatureGrid.CELL))) ?? EMPTY;
  }
}
const EMPTY: readonly never[] = [];

// ---------- the mounds and plinths ----------

/** A raised piece of ground: a homestead's mound, a landmark's plinth; flat on top, sloping to the fields (rise over run). */
export interface Mound extends Shape {
  id: string;
  top: number;
  slope: number;
  /** The homestead it carries, if it is one. */
  home?: HomesteadSpec;
}

/**
 * Where a homestead stands and the way it faces: as designed, or for one by the water, its mound's front edge
 * `bank` m back from the nearest waterway's edge, facing it square.
 */
function settle(h: HomesteadSpec): { x: number; z: number; face: number } {
  if (h.bank === undefined) return { x: h.x, z: h.z, face: h.face ?? 0 };
  let best = { d: Infinity, x: h.x, z: h.z, face: 0 };
  for (const way of WATERWAYS) {
    const s = way.line.nearestS(h.x, h.z);
    const p = way.at(s);
    const d = Math.hypot(p.x - h.x, p.z - h.z);
    if (d >= best.d) continue;
    // out from the middle toward the homestead's side
    const side = Math.cos(p.heading) * (h.x - p.x) - Math.sin(p.heading) * (h.z - p.z) >= 0 ? 1 : -1;
    const nx = Math.cos(p.heading) * side;
    const nz = -Math.sin(p.heading) * side;
    const out = way.half(s) + h.bank + h.d / 2;
    best = { d, x: p.x + nx * out, z: p.z + nz * out, face: Math.atan2(-nx, -nz) };
  }
  return best;
}

const homeMound = (h: HomesteadSpec): Mound => {
  const at = settle(h);
  return { id: h.id, x: at.x, z: at.z, face: at.face, hu: h.d / 2, hv: h.w / 2, corner: 7, top: PLAIN + MOUND, slope: 0.36, home: h };
};

/** The homesteads' mounds, settled where they stand. */
const HOME_MOUNDS: readonly Mound[] = HOMESTEADS.map(homeMound);

/** Every mound: the homesteads', the zamindar house's compound, the mosque's plinth, the banyan's corner. */
export const MOUNDS: readonly Mound[] = [
  ...HOME_MOUNDS,
  { id: 'zamindar', x: ZAMINDAR.x, z: ZAMINDAR.z, face: ZAMINDAR.face, hu: ZAMINDAR.d / 2, hv: ZAMINDAR.w / 2, corner: 5, top: PLAIN + MOUND + 0.2, slope: 0.4 },
  { id: 'mosque', x: MOSQUE.x, z: MOSQUE.z, face: MOSQUE.face, hu: MOSQUE.d / 2, hv: MOSQUE.w / 2, corner: 3, top: PLAIN + 0.7, slope: 0.4 },
  { id: 'banyan', x: BANYAN.x - 6, z: BANYAN.z + 14, face: 0.6, hu: 26, hv: 22, corner: 12, top: PLAIN + 0.55, slope: 0.25 },
];

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

/** The homesteads' mounds (world/village.ts builds on them). */
export const HOMESTEAD_MOUNDS: readonly Mound[] = MOUNDS.filter((m) => m.home);

// ---------- the ponds ----------

/** A pond: its shape, its water's level, and whether lilies grow on it. */
export interface Pond extends Shape {
  level: number;
  lilies: boolean;
  /** Its steps' point on the rim, if it has a ghat. */
  ghat?: Point2;
  /** For world/ponds.ts and the film: its middle and roughly its radius. */
  r: number;
}

const pondOf = (p: PondSpec): Pond => ({
  x: p.x,
  z: p.z,
  face: p.yaw,
  hu: p.halfD,
  hv: p.halfW,
  corner: Math.min(p.halfW, p.halfD) * 0.5,
  level: POND_LEVEL,
  lilies: p.lilies === true,
  ghat: p.ghat ? { x: p.ghat[0], z: p.ghat[1] } : undefined,
  r: Math.sqrt(p.halfW * p.halfD),
});

/** A homestead's pond, placed in its frame; its steps on the side toward the homestead. */
function homePond(m: Mound, p: HomePond): Pond {
  const at = shapePoint(m, p.u, p.v);
  const toward = Math.hypot(m.x - at.x, m.z - at.z) || 1;
  const reach = Math.min(p.halfW, p.halfD) + 1.5;
  const ghat: [number, number] | undefined = p.ghat ? [at.x + ((m.x - at.x) / toward) * reach, at.z + ((m.z - at.z) / toward) * reach] : undefined;
  return pondOf({ x: at.x, z: at.z, yaw: m.face + p.yaw, halfW: p.halfW, halfD: p.halfD, lilies: p.lilies, ghat });
}

/** Every pond: the homesteads', the zamindar house's and the mosque's. */
export const PONDS: readonly Pond[] = [...HOME_MOUNDS.flatMap((m) => (m.home?.pond ? [homePond(m, m.home.pond)] : [])), pondOf(ZAMINDAR.pond), pondOf(MOSQUE.pond)];

/** A pond's bank: the earth thrown up round it stands this far above the fields, flat this wide, sloping away at 1 in 3; into the water at 1 in 1.1. */
const POND_BANK = { above: 0.3, top: 2.5, slope: 0.33, inner: 0.9, depth: 2.2 };
const POND_GRID = new FeatureGrid<Pond>();
for (const p of PONDS) POND_GRID.add(p, p.x, p.z, Math.max(p.hu, p.hv) + POND_BANK.top + 4);

/** How far (x, z) is from a pond's middle measured in its own outline: below 1 is its water. */
export function pondReach(p: Pond, x: number, z: number): number {
  // the water's edge lies inside the dug outline by the bank's drop to it
  const inset = (PLAIN + POND_BANK.above - p.level) / POND_BANK.inner;
  const d = shapeDistance(p, x, z) + inset;
  return 1 + d / Math.max(4, Math.min(p.hu, p.hv));
}

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

/** The ground the bil leaves at (x, z): its bowl, then a low marshy rim rising slowly to the fields. */
function bilGround(x: number, z: number, ground: number): number {
  if (!nearBil(x, z)) return ground;
  const e = bilReach(x, z);
  if (e < 1) return BIL.level - bilDepth(x, z);
  if (e < 1.45) return Math.min(ground, BIL.level - 0.04 + (ground - BIL.level + 0.04) * smoothstep(1, 1.45, e));
  return ground;
}

/** Distance from (x, z) to the boat's way: the lilies and the floating plants leave it open. */
export function routeGap(x: number, z: number): number {
  return journeyFrame(x, z)?.d ?? Infinity;
}

// ---------- the ground ----------

/** The fields' gentle unevenness (m): no plain is quite flat. */
const unevenness = (x: number, z: number) => (fbm(x * 0.004, z * 0.004, 2, 7) - 0.5) * 0.24;

/** The land before the waters are cut in: the fields, the levee, the mounds, the road's embankment, the ponds' banks. */
function landHeight(x: number, z: number): number {
  const char = charShare(x, z);
  let h = PLAIN + unevenness(x, z) * (1 - char) + riverLevee(x, z) - 0.6 * char;
  h = Math.max(h, moundGround(x, z));
  h = roadGround(x, z, h);
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

/** The surface of the water standing at (x, z): the river's, the khals' and the bil's, or a pond's; −∞ on dry ground. */
export function waterLevelAt(x: number, z: number): number {
  if (nearBil(x, z) && bilReach(x, z) < 1.05) return BIL.level;
  const w = waterwayAt(x, z);
  if (w && w.d < w.half + 1) return WATER_LEVEL;
  return pondSurface(x, z) ?? -Infinity;
}

/**
 * The level of the water whose bank (x, z) is on: a waterway's mud bank, the bil's rim, a pond's bank; the
 * water's own where (x, z) is under it; −∞ away from them. The ground's wet band reads it.
 */
export function shoreLevel(x: number, z: number): number {
  const here = waterLevelAt(x, z);
  if (Number.isFinite(here)) return here;
  if (bankStrip(x, z) > 0) return WATER_LEVEL;
  if (nearBil(x, z) && bilReach(x, z) < 1.5) return BIL.level;
  const n = pondNear(x, z);
  return n && n.d < POND_BANK.top ? n.pond.level : -Infinity;
}

/** Whether (x, z) holds water: the river, a khal, the bil or a pond. */
export function inlandWaterAt(x: number, z: number): boolean {
  if (nearBil(x, z) && bilReach(x, z) < 1) return true;
  const w = waterwayAt(x, z);
  if (w && w.d < w.half) return true;
  return pondSurface(x, z) !== null;
}

/** True if (x, z) is within `margin` metres of water: the river, a khal, the bil, a pond. */
export function nearBackwater(x: number, z: number, margin: number): boolean {
  const w = waterwayAt(x, z);
  if (w && w.d < w.half + margin) return true;
  if (nearBil(x, z) && bilReach(x, z) < 1 + margin / BIL.halfWid) return true;
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
  field: number;
}

const use: LandUse = { yard: 0, mound: 0, verge: 0, sand: 0, marsh: 0, field: 0 };

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
    } else yard = Math.max(yard, smoothstep(1, -3, d));
  }
  let verge = bankStrip(x, z);
  const n = pondNear(x, z);
  if (n) verge = Math.max(verge, smoothstep(POND_BANK.top + 3.5, POND_BANK.top + 1, n.d));
  verge = Math.max(verge, smoothstep(6, 1, roadEdge(x, z)), roadCover(x, z));
  const sand = charShare(x, z) * (1 - mound);
  const marsh = bilMarsh(x, z);
  use.yard = yard;
  use.mound = Math.max(0, mound - yard);
  use.verge = Math.max(0, verge * (1 - mound) - sand);
  use.sand = sand;
  use.marsh = marsh;
  use.field = Math.max(0, 1 - mound - use.verge - sand - marsh);
  return use;
}

// ---------- landmarks ----------

/** The landmarks' own ground (with `margin` m round it): no huts, trees or tall grass there. */
export function onLandmark(x: number, z: number, margin = 0): boolean {
  if (onBridge(x, z, margin + 1) || onSanko(x, z, margin + 0.5)) return true;
  if (Math.hypot(x - BANYAN.x, z - BANYAN.z) < 5 + margin) return true;
  if (Math.hypot(x - TEA_STALL.x, z - TEA_STALL.z) < 4 + margin) return true;
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

export { KHAL, RIVER, SIDE_KHAL, WATERWAYS };
