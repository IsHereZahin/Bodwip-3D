import { smoothstep } from '../core/mathx';
import { LINES, NODES, place } from '../geo/data';
import { toWorld } from '../geo/project';

// The Matarbari power plant's ground and plan (GEOGRAPHY_PLAN.md §8.5), apart from its meshes
// (world/powerPlant.ts) so the ground (geography.ts terrainHeight), the roads and the planting can ask about it.
//
// The ground: OSM's site outline (way 1098932510) filled from ≈+1 m to ≈+10 m (CPGCBL; the DEMs predate the
// fill), its edges falling to the land round it as an embankment and to the port's basin as a stone revetment.
//
// The plan: the chimney (OSM node 14000705496), the coal yard (OSM's shed, way 1536927661: four storage sheds
// side by side, as Sentinel-2 shows them and the press counts them), the coal berth (OSM's pier, way 1239101124,
// with the two unloaders at OSM's cranes) and the 400 kV switchyard stand at their 1:3 places. The power block
// between the chimney and the switchyard (flue gas desulphurisation, precipitators, the two open boilers, the
// bunker bay, the turbine hall, the transformers) keeps its order from Sentinel-2 and Microsoft's footprints,
// west to east, but is built at real size (D1: things keep their size, the map shrinks), so it is packed tighter
// than it stands and reaches a little further east, the switchyard moved east with it [মডেল].

/** The platform's top (m about MSL): the fill's level. */
export const PLATFORM = 10;
/** How far its embankment reaches out from the outline (m). */
const SLOPE = 14;

/** A rectangle on the ground, world metres (x0 < x1, z0 < z1). */
export interface Rect {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
}

const OUTLINE: Float32Array = (() => {
  const near = place('matarbari-plant').world;
  let best: Float32Array | null = null;
  let bestD = Infinity;
  for (const l of LINES) {
    if (l.k !== 'site' || l.t !== 'plant') continue;
    const d = Math.hypot(l.points[0] - near.x, l.points[1] - near.z);
    if (d < bestD) (bestD = d), (best = l.points);
  }
  if (!best || bestD > 1500) throw new Error('geo/vectors.bin: no outline for the Matarbari plant');
  return best;
})();

/** Signed distance to the outline (m, negative inside) on a 4 m raster round it: the ground asks it everywhere. */
const RASTER = 4;
const FIELD = (() => {
  const p = OUTLINE;
  let x0 = Infinity;
  let x1 = -Infinity;
  let z0 = Infinity;
  let z1 = -Infinity;
  for (let k = 0; k < p.length; k += 2) {
    x0 = Math.min(x0, p[k]);
    x1 = Math.max(x1, p[k]);
    z0 = Math.min(z0, p[k + 1]);
    z1 = Math.max(z1, p[k + 1]);
  }
  const pad = SLOPE + 2 * RASTER;
  x0 -= pad;
  z0 -= pad;
  const w = Math.ceil((x1 + pad - x0) / RASTER) + 1;
  const h = Math.ceil((z1 + pad - z0) / RASTER) + 1;
  const d = new Float32Array(w * h);
  const n = p.length / 2;
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const x = x0 + i * RASTER;
      const z = z0 + j * RASTER;
      let best = Infinity;
      let inside = false;
      for (let a = 0, b = n - 1; a < n; b = a++) {
        const ax = p[a * 2];
        const az = p[a * 2 + 1];
        const bx = p[b * 2];
        const bz = p[b * 2 + 1];
        if (az > z !== bz > z && x < ((bx - ax) * (z - az)) / (bz - az) + ax) inside = !inside;
        const sx = bx - ax;
        const sz = bz - az;
        const t = Math.max(0, Math.min(1, ((x - ax) * sx + (z - az) * sz) / (sx * sx + sz * sz || 1)));
        best = Math.min(best, Math.hypot(x - ax - sx * t, z - az - sz * t));
      }
      d[j * w + i] = inside ? -best : best;
    }
  }
  return { x0, z0, w, h, d };
})();

/** Signed distance (m) from the plant's outline at (x, z), negative inside; Infinity well away from it. */
function siteDistance(x: number, z: number): number {
  const fx = (x - FIELD.x0) / RASTER;
  const fz = (z - FIELD.z0) / RASTER;
  if (fx < 0 || fz < 0 || fx >= FIELD.w - 1 || fz >= FIELD.h - 1) return Infinity;
  const i = Math.floor(fx);
  const j = Math.floor(fz);
  const tx = fx - i;
  const tz = fz - j;
  const k = j * FIELD.w + i;
  const d = FIELD.d;
  return (d[k] * (1 - tx) + d[k + 1] * tx) * (1 - tz) + (d[k + FIELD.w] * (1 - tx) + d[k + FIELD.w + 1] * tx) * tz;
}

/** The ground at (x, z) given the map's `h`: the platform on the site, its embankment easing down round it. */
export function plantGround(x: number, z: number, h: number): number {
  const d = siteDistance(x, z);
  if (d >= SLOPE) return h;
  return h + Math.max(0, PLATFORM - h) * smoothstep(SLOPE, 0, d);
}

/** How the site covers (x, z): `top` the fill's level ground (0..1), `bank` its embankment's stone and earth. */
export function plantCover(x: number, z: number): { top: number; bank: number } {
  const d = siteDistance(x, z);
  if (d >= SLOPE) return { top: 0, bank: 0 };
  const top = smoothstep(1.5, -1.5, d);
  return { top, bank: (1 - top) * smoothstep(SLOPE, SLOPE * 0.6, d) };
}

/** True on the plant's ground (its outline, and `margin` m beyond: its embankment reaches SLOPE). */
export function onPlant(x: number, z: number, margin = 0): boolean {
  return siteDistance(x, z) < margin;
}

/** The site's outline: world x, z pairs, closing on its first point. */
export function plantOutline(): Float32Array {
  return OUTLINE;
}

/** A rectangle from two lat/lon corners. */
const rectLL = (lat0: number, lon0: number, lat1: number, lon1: number): Rect => {
  const a = toWorld(lat0, lon0);
  const b = toWorld(lat1, lon1);
  return { x0: Math.min(a.x, b.x), x1: Math.max(a.x, b.x), z0: Math.min(a.z, b.z), z1: Math.max(a.z, b.z) };
};

/**
 * Where the plant's parts stand. The block's frame: `a` metres east of the chimney (world −x), `d` north (+z).
 * Sizes are real (m) where they fit, else as noted in powerPlant.ts.
 */
export const PLANT = (() => {
  const stackPlace = place('matarbari-stack').world;
  const stack = NODES.filter((n) => n.t === 'chimney').reduce(
    (best, n) => (Math.hypot(n.x - stackPlace.x, n.z - stackPlace.z) < Math.hypot(best.x - stackPlace.x, best.z - stackPlace.z) ? n : best),
    { t: 'chimney' as const, x: stackPlace.x, z: stackPlace.z },
  );
  const berthPlace = place('matarbari-coal-berth').world;
  const cranes = NODES.filter((n) => n.t === 'crane' && Math.hypot(n.x - berthPlace.x, n.z - berthPlace.z) < 150)
    .map((n) => ({ x: n.x, z: n.z }))
    .sort((p, q) => p.z - q.z);
  /** A point of the block's frame in the world. */
  const at = (a: number, d: number) => ({ x: stack.x - a, z: stack.z + d });
  const yard = rectLL(21.6991, 91.87767, 21.70259, 91.8825);
  const berth = rectLL(21.69966, 91.87591, 21.70239, 91.87675);
  return {
    at,
    stack: { x: stack.x, z: stack.z, height: 275, base: 12, top: 7.5 },
    /** Wet flue gas desulphurisation absorbers, one a unit, beside the chimney. */
    fgd: { a: 26, d: 24, r: 8, height: 38 },
    /** Electrostatic precipitators: a box a unit on its hoppers (along a, along d, height). */
    esp: { a: 56, d: 26, la: 30, ld: 34, height: 33 },
    /** The two boilers, open steel structures (IHI, once-through): footprint, height to the roof. */
    boiler: { a: 98, d: 27, size: 40, height: 92 },
    bunker: { a: 124, la: 12, ld: 108, height: 50 },
    turbine: { a: 145, la: 30, ld: 130, height: 34 },
    transformer: { a: 166, d: 27 },
    /** The switchyard east of the turbine hall (OSM's is 124 × 66 m: here its 400 kV bays in less). */
    switchyard: { a0: 177, a1: 216, d0: -30, d1: 30, gantry: 22 },
    yard,
    /** Four storage sheds side by side along the yard, west to east. */
    sheds: 4,
    berth,
    cranes,
    /** The transfer towers the coal passes on its way: off the yard's north-west corner, and at its east end. */
    towers: {
      berth: { x: yard.x1 - 30, z: yard.z1 + 11, height: 26 },
      yard: { x: yard.x0 - 18, z: yard.z1 + 11, height: 26 },
    },
    /** The whole power block, for keeping roads and buildings off it. */
    block: { x0: stack.x - 216, x1: stack.x + 12, z0: stack.z - 66, z1: stack.z + 66 } as Rect,
  };
})();

/** The ground the plant's own parts stand on (with `pad` m round it): roads and the map's buildings keep off it. */
export function plantReserved(x: number, z: number, pad = 0): boolean {
  for (const r of RESERVED) if (x >= r.x0 - pad && x <= r.x1 + pad && z >= r.z0 - pad && z <= r.z1 + pad) return true;
  return false;
}

const RESERVED: readonly Rect[] = [PLANT.block, PLANT.yard];
