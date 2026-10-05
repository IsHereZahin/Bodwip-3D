import { Group, Mesh, MeshStandardMaterial, Vector3 } from 'three';
import { LAYER_NO_REFLECT } from '../core/globals';
import { smoothstep } from '../core/mathx';
import { Rng } from '../core/rng';
import { SegmentIndex } from '../core/segmentIndex';
import { KIND, LINES, kindAt } from '../geo/data';
import { MeshBuilder, rgb, scaleRgb, type RGB } from '../render/builder';
import { patchMaterial } from '../render/patch';
import { ROAD_SURFACES, roadAtlas } from '../render/textures';
import { JOURNEY, baseGround, bilReach, khalAt, khalFrame, khalHalfWidth } from './khal';

// The roads OpenStreetMap draws (geo/vectors.bin): on the 1:3 map at their real width (GEOGRAPHY_PLAN.md
// §5.1), each with a crest a little above the land (the coast's roads run on low embankments, the highways
// on high ones: [মডেল], OSM has no heights) that the ground is levelled to (geography.ts terrainHeight), and a
// surface by its kind: the highways and the main roads in bitumen, the village roads in herringbone brick
// (HBB), the tracks and paths bare earth [মডেল: OSM's surface tags are not baked]. Where OSM marks a bridge
// the ground is left as it is and a deck crosses it. Where a road crosses the khal it does so on a deck too
// (OSM does not always mark it); a road running beside the khal is moved out onto its levee; at the old bridge
// the arch carries the path (world/bridge.ts), and the bil's ground (world/khal.ts) has no roads.

type Surface = 'asphalt' | 'brick' | 'earth';

/** By OSM's highway tag: width (m, real), how high the crest stands over the land (m), and the surface. */
const ROAD_KINDS: Readonly<Record<string, { width: number; raise: number; surface: Surface }>> = {
  trunk: { width: 7.3, raise: 1, surface: 'asphalt' },
  trunk_link: { width: 5.5, raise: 0.8, surface: 'asphalt' },
  primary: { width: 7, raise: 1, surface: 'asphalt' },
  secondary: { width: 5.5, raise: 0.8, surface: 'asphalt' },
  secondary_link: { width: 5, raise: 0.8, surface: 'asphalt' },
  tertiary: { width: 4.5, raise: 0.6, surface: 'asphalt' },
  unclassified: { width: 3.7, raise: 0.5, surface: 'brick' },
  road: { width: 3.5, raise: 0.4, surface: 'brick' },
  residential: { width: 3, raise: 0.3, surface: 'brick' },
  living_street: { width: 3, raise: 0.2, surface: 'brick' },
  service: { width: 3, raise: 0.2, surface: 'brick' },
  pedestrian: { width: 3, raise: 0.1, surface: 'brick' },
  steps: { width: 1.5, raise: 0, surface: 'brick' },
  track: { width: 2.5, raise: 0.2, surface: 'earth' },
  footway: { width: 1.5, raise: 0, surface: 'earth' },
  path: { width: 1.2, raise: 0, surface: 'earth' },
};
/** How far the embankment's sides reach out from the carriageway's edge (m). */
const SHOULDER = 2.5;
/** How far beyond its shoulders a road is still found (m): a building's corner may reach that far. */
const NEAR = 6;
/** The surface drawn this far above the levelled ground (m), against z-fighting. */
const LIFT = 0.05;

/** One straight piece of a road: its ends, half-width, crest at each end, surface, and whether it is a bridge. */
interface RoadReach {
  ax: number;
  az: number;
  bx: number;
  bz: number;
  half: number;
  ca: number;
  cb: number;
  surface: Surface;
  bridge: boolean;
  /** Distance along its road at each end (m), for the surface's texture. */
  va: number;
  vb: number;
}

/**
 * The crests along a road's points: the land under each, smoothed over its neighbours (the DEM's 30 m cells
 * are noisy), raised; where a point stands in water (a creek the road crosses unmarked), the land either side.
 */
function crests(p: Float32Array, raise: number): Float32Array {
  const n = p.length / 2;
  const land = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = p[i * 2];
    const z = p[i * 2 + 1];
    land[i] = kindAt(x, z) !== KIND.inland ? baseGround(x, z) : Number.NaN;
  }
  // fill the points in water from the nearest land along the road (or a little above the high tides if none)
  for (let i = 0; i < n; i++) {
    if (!Number.isNaN(land[i])) continue;
    let a = i - 1;
    let b = i + 1;
    while (a >= 0 && Number.isNaN(land[a])) a--;
    while (b < n && Number.isNaN(land[b])) b++;
    const ha = a >= 0 ? land[a] : Number.NaN;
    const hb = b < n ? land[b] : Number.NaN;
    land[i] = Number.isNaN(ha) ? (Number.isNaN(hb) ? 3 : hb) : Number.isNaN(hb) ? ha : Math.max(ha, hb);
  }
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    let k = 0;
    for (let j = Math.max(0, i - 2); j <= Math.min(n - 1, i + 2); j++) (s += land[j]), k++;
    out[i] = s / k + raise;
  }
  return out;
}

/** A road beside the khal keeps its edge this far out from the khal's water (m): over the mud bank, on the levee's top (geography.ts BANK). */
const BANK_TOP = 6.5;

/**
 * A road's points with the stretches that run along the khal moved out onto its levee: the khal is drawn at its
 * real width, wider than the 1:3 map would draw it, and OSM's roads beside it would stand in its water. Where a
 * road crosses the khal (its points go from one side to the other) the crossing is left where it is, for a
 * deck. Near the khal the points are first set every 4 m, so a pushed road follows the bank's bends.
 */
function besideTheKhal(p: Float32Array, half: number): Float32Array {
  const pts: number[] = [];
  for (let k = 0; k + 1 < p.length; k += 2) {
    pts.push(p[k], p[k + 1]);
    if (k + 3 >= p.length) break;
    const near = khalFrame(p[k], p[k + 1]) !== null || khalFrame(p[k + 2], p[k + 3]) !== null;
    const len = Math.hypot(p[k + 2] - p[k], p[k + 3] - p[k + 1]);
    const n = near ? Math.floor(len / 4) : 0;
    for (let i = 1; i <= n; i++) pts.push(p[k] + ((p[k + 2] - p[k]) * i) / (n + 1), p[k + 1] + ((p[k + 3] - p[k + 1]) * i) / (n + 1));
  }
  const count = pts.length / 2;
  const frames = Array.from({ length: count }, (_, i) => {
    const f = khalFrame(pts[i * 2], pts[i * 2 + 1]);
    return f ? { s: f.s, d: f.d, side: f.side, need: khalHalfWidth(f.s) + BANK_TOP + half } : null;
  });
  const wet = (i: number) => frames[i] !== null && frames[i]!.d < frames[i]!.need;
  // each run of points too near the khal: a short one from one bank to the other is a crossing, left for a
  // deck; anything else (a road along the khal, OSM's line wandering from one side of the khal's to the
  // other) goes onto the bank it came in on
  for (let a = 0; a < count; a++) {
    if (!wet(a)) continue;
    let b = a;
    let run = 0;
    while (b + 1 < count && wet(b + 1)) {
      run += Math.hypot(pts[b * 2 + 2] - pts[b * 2], pts[b * 2 + 3] - pts[b * 2 + 1]);
      b++;
    }
    const enter = frames[a]!;
    const leave = frames[b]!;
    const crosses = enter.side !== leave.side && run < 2.5 * Math.max(enter.need, leave.need);
    if (!crosses) {
      for (let i = a; i <= b; i++) {
        const c = khalAt(frames[i]!.s);
        const need = frames[i]!.need;
        pts[i * 2] = c.x + Math.cos(c.heading) * enter.side * need;
        pts[i * 2 + 1] = c.z - Math.sin(c.heading) * enter.side * need;
      }
    }
    a = b;
  }
  return Float32Array.from(pts);
}

const REACHES: RoadReach[] = [];
/** Where each road's points start in REACHES, and how many, for the joints between its pieces. */
const ROADS: { first: number; count: number }[] = [];
for (const l of LINES) {
  const kind = l.k === 'road' && l.t !== undefined ? ROAD_KINDS[l.t] : undefined;
  if (!kind || l.points.length < 4) continue;
  const p = besideTheKhal(l.points, kind.width / 2);
  const c = crests(p, kind.raise);
  let first = REACHES.length;
  let v = 0;
  for (let k = 0; k + 3 < p.length; k += 2) {
    const len = Math.hypot(p[k + 2] - p[k], p[k + 3] - p[k + 1]);
    const cross = crossing(p[k], p[k + 1], p[k + 2], p[k + 3]);
    if (cross === 'gone') {
      // the road breaks here: its pieces either side are roads of their own
      if (REACHES.length > first) ROADS.push({ first, count: REACHES.length - first });
      first = REACHES.length;
      v += len;
      continue;
    }
    REACHES.push({ ax: p[k], az: p[k + 1], bx: p[k + 2], bz: p[k + 3], half: kind.width / 2, ca: c[k / 2], cb: c[k / 2 + 1], surface: kind.surface, bridge: l.bridge === 1 || cross === 'deck', va: v, vb: v + len });
    v += len;
  }
  if (REACHES.length > first) ROADS.push({ first, count: REACHES.length - first });
}

/**
 * What a piece of road from a to b meets: the bil's ground or the old bridge's crossing ('gone': left out, the
 * arch carries the path), the khal elsewhere ('deck': it crosses on a deck), or nothing.
 */
function crossing(ax: number, az: number, bx: number, bz: number): 'gone' | 'deck' | null {
  const arch = khalAt(JOURNEY.bridge);
  const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / 2));
  let deck = false;
  for (let i = 0; i <= n; i++) {
    const x = ax + ((bx - ax) * i) / n;
    const z = az + ((bz - az) * i) / n;
    if (bilReach(x, z) < 1.2) return 'gone';
    const f = khalFrame(x, z);
    if (f && f.d < khalHalfWidth(f.s) + 3) {
      if (Math.hypot(x - arch.x, z - arch.z) < 30) return 'gone';
      deck = true;
    }
  }
  return deck ? 'deck' : null;
}

const INDEX = new SegmentIndex(32);
for (const r of REACHES) INDEX.add(r.ax, r.az, r.bx, r.bz, r.half, 0.3 + SHOULDER + NEAR);

/**
 * The ground the roads leave at (x, z): a road's crest across its carriageway, its embankment's sides (or a
 * cutting's) easing down (or up) to the land beside it; the land itself away from them and under bridges.
 */
export function roadGround(x: number, z: number, ground: number): number {
  const hit = INDEX.nearest(x, z);
  if (!hit) return ground;
  const r = REACHES[hit.index];
  if (r.bridge) return ground;
  const crest = r.ca + (r.cb - r.ca) * hit.t;
  if (hit.d <= r.half + 0.3) return crest;
  return crest + (ground - crest) * smoothstep(r.half + 0.3, r.half + 0.3 + SHOULDER, hit.d);
}

/** How much of (x, z) is road (1 on the carriageway, easing to 0 across its shoulders); 0 under bridges. */
export function roadCover(x: number, z: number): number {
  const hit = INDEX.nearest(x, z);
  if (!hit || REACHES[hit.index].bridge) return 0;
  const r = REACHES[hit.index];
  return 1 - smoothstep(r.half, r.half + SHOULDER, hit.d);
}

/** True within `margin` m of a road's carriageway or a bridge (margin up to its shoulders' reach). */
export function onRoad(x: number, z: number, margin = 0): boolean {
  const hit = INDEX.nearest(x, z);
  return hit !== null && hit.d < REACHES[hit.index].half + margin;
}

/**
 * (x, z) moved clear of the roads by `r` (a building's reach from its middle) and a little more: pushed straight
 * out from the nearest road's middle line, a few times over where roads meet. On the 1:3 map the houses that
 * line a road stand a third as far from it as they do, so most of them need it.
 */
export function clearOfRoads(x: number, z: number, r: number): { x: number; z: number } {
  for (let k = 0; k < 4; k++) {
    const hit = INDEX.nearest(x, z);
    if (!hit) break;
    const road = REACHES[hit.index];
    const need = road.half + r + 0.6;
    if (hit.d >= need) break;
    const px = road.ax + (road.bx - road.ax) * hit.t;
    const pz = road.az + (road.bz - road.az) * hit.t;
    // off the line to its side (or, if right on it, to its right)
    let dx = x - px;
    let dz = z - pz;
    if (Math.hypot(dx, dz) < 1e-3) (dx = road.bz - road.az), (dz = -(road.bx - road.ax));
    const len = Math.hypot(dx, dz) || 1;
    x = px + (dx / len) * need;
    z = pz + (dz / len) * need;
  }
  return { x, z };
}

// ---------- the meshes ----------

/** Roads are drawn in cells of this size (m), so those out of view, or far off, are left undrawn. */
const CELL = 1300;
/** Each surface's third of the atlas, inset a little so its neighbour does not bleed in. */
const atlasU = (surface: Surface, u: number) => (ROAD_SURFACES.indexOf(surface) + 0.04 + 0.92 * u) / ROAD_SURFACES.length;

/** Each surface's tint over its texture: the brick dulled by the dust that lies on it. */
const SURFACE_TINT: Record<Surface, RGB> = {
  asphalt: rgb('#d6d4d0'),
  brick: rgb('#c9bcae'),
  earth: rgb('#e6ddd2'),
};
const CONCRETE: RGB = rgb('#a9a69e');

/** The roads' surfaces and their bridges' decks and parapets, in cells; pass the group to cullBeyond. */
export function buildRoads(): Group {
  const group = new Group();
  group.name = 'roads';
  const rng = new Rng(61);
  const cells = new Map<string, MeshBuilder>();
  const builderFor = (kind: 'road' | 'concrete', x: number, z: number) => {
    const key = `${kind}:${Math.floor(x / CELL)}:${Math.floor(z / CELL)}`;
    let b = cells.get(key);
    if (!b) cells.set(key, (b = new MeshBuilder()));
    return b;
  };
  const up = new Vector3(0, 1, 0);
  const at = (x: number, y: number, z: number) => new Vector3(x, y, z);

  for (const road of ROADS) {
    for (let k = road.first; k < road.first + road.count; k++) {
      const r = REACHES[k];
      const len = Math.hypot(r.bx - r.ax, r.bz - r.az);
      if (len < 0.05) continue;
      // across the road, to its right
      const nx = (r.bz - r.az) / len;
      const nz = -(r.bx - r.ax) / len;
      const mx = (r.ax + r.bx) / 2;
      const mz = (r.az + r.bz) / 2;
      const b = builderFor('road', mx, mz);
      const ya = r.ca + LIFT;
      const yb = r.cb + LIFT;
      // a little variety piece by piece: newer and older stretches
      const c = scaleRgb(SURFACE_TINT[r.surface], rng.range(0.88, 1.06));
      const s = b.vertexCount;
      b.vertex(at(r.ax - nx * r.half, ya, r.az - nz * r.half), up, atlasU(r.surface, 0), r.va / 3, c);
      b.vertex(at(r.ax + nx * r.half, ya, r.az + nz * r.half), up, atlasU(r.surface, 1), r.va / 3, c);
      b.vertex(at(r.bx + nx * r.half, yb, r.bz + nz * r.half), up, atlasU(r.surface, 1), r.vb / 3, c);
      b.vertex(at(r.bx - nx * r.half, yb, r.bz - nz * r.half), up, atlasU(r.surface, 0), r.vb / 3, c);
      b.quad(s, s + 3, s + 2, s + 1);
      // the joint with the next piece: a disc at the bend, so its outside is not left open
      if (k + 1 < road.first + road.count) {
        const j = b.vertexCount;
        b.vertex(at(r.bx, yb - 0.002, r.bz), up, atlasU(r.surface, 0.5), r.vb / 3, c);
        const N = 8;
        for (let i = 0; i <= N; i++) {
          const a = (i / N) * Math.PI * 2;
          b.vertex(at(r.bx + Math.cos(a) * r.half, yb - 0.002, r.bz + Math.sin(a) * r.half), up, atlasU(r.surface, 0.5 + 0.5 * Math.cos(a)), r.vb / 3 + 0.3 * Math.sin(a), c);
        }
        for (let i = 0; i < N; i++) b.tri(j, j + i + 2, j + i + 1);
      }
      if (r.bridge) bridgeDeck(builderFor('concrete', mx, mz), r, nx, nz);
    }
  }

  const materials: Record<'road' | 'concrete', MeshStandardMaterial> = {
    road: roadMaterial(),
    concrete: patchMaterial(new MeshStandardMaterial({ vertexColors: true, roughness: 0.9 }), { grime: 0.5 }),
  };
  for (const [key, b] of cells) {
    if (!b.vertexCount) continue;
    const kind = key.split(':')[0] as 'road' | 'concrete';
    const mesh = new Mesh(b.build(), materials[kind]);
    mesh.receiveShadow = true;
    mesh.castShadow = kind === 'concrete';
    // flat on the ground: not worth drawing again in the water's mirror
    if (kind !== 'concrete') mesh.layers.set(LAYER_NO_REFLECT);
    mesh.name = 'road';
    group.add(mesh);
  }
  return group;
}

function roadMaterial(): MeshStandardMaterial {
  const m = new MeshStandardMaterial({
    map: roadAtlas(),
    vertexColors: true,
    roughness: 0.9,
    // drawn over the levelled ground it lies on
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  return patchMaterial(m, { grime: 0.3 });
}

/** A bridge's deck under the road surface, its edges, and a low parapet either side, along one piece of road. */
function bridgeDeck(b: MeshBuilder, r: RoadReach, nx: number, nz: number): void {
  const DECK = 0.55;
  const RAIL = 0.75;
  const RAIL_W = 0.18;
  const ya = r.ca + LIFT - 0.01;
  const yb = r.cb + LIFT - 0.01;
  for (const side of [-1, 1]) {
    // the deck's edge, facing out
    const ox = nx * side;
    const oz = nz * side;
    const n = new Vector3(ox, 0, oz);
    const e = r.half + RAIL_W;
    const s = b.vertexCount;
    b.vertex(new Vector3(r.ax + ox * e, ya - DECK, r.az + oz * e), n, 0, 0, CONCRETE);
    b.vertex(new Vector3(r.bx + ox * e, yb - DECK, r.bz + oz * e), n, 1, 0, CONCRETE);
    b.vertex(new Vector3(r.bx + ox * e, yb + RAIL, r.bz + oz * e), n, 1, 1, scaleRgb(CONCRETE, 1.05));
    b.vertex(new Vector3(r.ax + ox * e, ya + RAIL, r.az + oz * e), n, 0, 1, scaleRgb(CONCRETE, 1.05));
    if (side > 0) b.quad(s, s + 3, s + 2, s + 1);
    else b.quad(s, s + 1, s + 2, s + 3);
    // the parapet's inner face and its top
    const i = r.half;
    const t = b.vertexCount;
    const nIn = new Vector3(-ox, 0, -oz);
    b.vertex(new Vector3(r.ax + ox * i, ya, r.az + oz * i), nIn, 0, 0, CONCRETE);
    b.vertex(new Vector3(r.bx + ox * i, yb, r.bz + oz * i), nIn, 1, 0, CONCRETE);
    b.vertex(new Vector3(r.bx + ox * i, yb + RAIL, r.bz + oz * i), nIn, 1, 1, CONCRETE);
    b.vertex(new Vector3(r.ax + ox * i, ya + RAIL, r.az + oz * i), nIn, 0, 1, CONCRETE);
    if (side > 0) b.quad(t, t + 1, t + 2, t + 3);
    else b.quad(t, t + 3, t + 2, t + 1);
    const u = b.vertexCount;
    const top = new Vector3(0, 1, 0);
    b.vertex(new Vector3(r.ax + ox * i, ya + RAIL, r.az + oz * i), top, 0, 0, scaleRgb(CONCRETE, 1.1));
    b.vertex(new Vector3(r.bx + ox * i, yb + RAIL, r.bz + oz * i), top, 1, 0, scaleRgb(CONCRETE, 1.1));
    b.vertex(new Vector3(r.bx + ox * e, yb + RAIL, r.bz + oz * e), top, 1, 1, scaleRgb(CONCRETE, 1.1));
    b.vertex(new Vector3(r.ax + ox * e, ya + RAIL, r.az + oz * e), top, 0, 1, scaleRgb(CONCRETE, 1.1));
    if (side > 0) b.quad(u, u + 1, u + 2, u + 3);
    else b.quad(u, u + 3, u + 2, u + 1);
  }
  // the deck's underside
  const s = b.vertexCount;
  const down = new Vector3(0, -1, 0);
  const e = r.half + RAIL_W;
  b.vertex(new Vector3(r.ax - nx * e, ya - DECK, r.az - nz * e), down, 0, 0, scaleRgb(CONCRETE, 0.7));
  b.vertex(new Vector3(r.ax + nx * e, ya - DECK, r.az + nz * e), down, 1, 0, scaleRgb(CONCRETE, 0.7));
  b.vertex(new Vector3(r.bx + nx * e, yb - DECK, r.bz + nz * e), down, 1, 1, scaleRgb(CONCRETE, 0.7));
  b.vertex(new Vector3(r.bx - nx * e, yb - DECK, r.bz - nz * e), down, 0, 1, scaleRgb(CONCRETE, 0.7));
  b.quad(s, s + 1, s + 2, s + 3);
}
