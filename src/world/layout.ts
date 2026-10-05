import { BANYAN, HOMESTEADS, MOSQUE, MOUND, PLAIN, POND_LEVEL, ZAMINDAR, type HomePond, type HomesteadSpec, type PondSpec } from './plan';
import type { Point2 } from './sites';
import { WATERWAYS } from './waterways';

// Where the village's raised grounds and ponds lie, worked out once from the design (world/plan.ts): the
// homesteads' mounds (those by the water settled at their distance from its edge, facing it), the landmarks'
// plinths, and the ponds (a homestead's placed in its frame). The ground (geography.ts), the ways (roads.ts)
// and everything built on them read these.

// ---------- feature lookup ----------

/** A rounded rectangle on the ground, turned so its own +u looks along `face` (0 north, π/2 west). */
export interface Shape {
  x: number;
  z: number;
  face: number;
  /** Half its size along its face (u) and across it (v), and its corners' radius (m). */
  hu: number;
  hv: number;
  corner: number;
}

/** (x, z) in a shape's frame: u along its face, v across it (to its left looking along it, +x when it faces north). */
export function local(s: Shape, x: number, z: number): { u: number; v: number } {
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
export function shapeDistance(s: Shape, x: number, z: number): number {
  const { u, v } = local(s, x, z);
  const qu = Math.abs(u) - (s.hu - s.corner);
  const qv = Math.abs(v) - (s.hv - s.corner);
  return Math.hypot(Math.max(qu, 0), Math.max(qv, 0)) + Math.min(Math.max(qu, qv), 0) - s.corner;
}

/** Features filed by 40 m cells over the reach of their influence, for the ground's per-vertex questions. */
export class FeatureGrid<T> {
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
export const POND_BANK = { above: 0.3, top: 2.5, slope: 0.33, inner: 0.9, depth: 2.2 };

/** How far (x, z) is from a pond's middle measured in its own outline: below 1 is its water. */
export function pondReach(p: Pond, x: number, z: number): number {
  // the water's edge lies inside the dug outline by the bank's drop to it
  const inset = (PLAIN + POND_BANK.above - p.level) / POND_BANK.inner;
  const d = shapeDistance(p, x, z) + inset;
  return 1 + d / Math.max(4, Math.min(p.hu, p.hv));
}
