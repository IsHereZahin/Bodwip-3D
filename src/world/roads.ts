import { Group, Mesh, MeshStandardMaterial, Vector3 } from 'three';
import { LAYER_NO_REFLECT } from '../core/globals';
import { smoothstep } from '../core/mathx';
import { Rng } from '../core/rng';
import { SegmentIndex } from '../core/segmentIndex';
import { MeshBuilder, rgb, scaleRgb, type RGB } from '../render/builder';
import { patchMaterial } from '../render/patch';
import { ROAD_SURFACES, roadAtlas } from '../render/textures';
import { PLAIN, ROAD_RAISE, ROADS, type Pt, type RoadPoint, type RoadSpec } from './plan';
import { bridgeEnds, sankoEnds, type Point2 } from './sites';
import { KHAL, RIVER, riverLevee } from './waterways';

// The village's ways (world/plan.ts ROADS): the brick road (herringbone brick, HBB, as Bengal's village roads
// are laid) on its embankment a little above the fields, and the earth paths between the homesteads, the
// ghats and the fields, worn into the ground. Each runs as a smooth curve through its designed points. Where
// the road meets the khal the old bridge carries it (world/bridge.ts), and where the field path meets the side
// khal the bamboo sanko does: the way ends at each landing and goes on from the other, coming straight onto
// the crossing along its line.

type Surface = 'brick' | 'earth';

/** How far the brick road's embankment sides reach out from its edge (m). */
const SHOULDER = 2.5;
/** The surfaces are drawn this far above the ground they lie on (m), against z-fighting. */
const LIFT = 0.05;
/** Spacing of a way's points along it (m). */
const STEP = 2.5;
/** A way comes onto a crossing straight for this far (m). */
const APPROACH = 7;

/** One straight piece of a way: its ends, half-width, the brick road's crest at each end, surface, and distance along it at each end. */
interface Reach {
  ax: number;
  az: number;
  bx: number;
  bz: number;
  half: number;
  ca: number;
  cb: number;
  surface: Surface;
  va: number;
  vb: number;
}

/** Where a crossing's anchor is, and the point a way comes onto it from (out along the crossing's line). */
function anchor(a: Exclude<RoadPoint, Pt>): { at: Point2; out: Point2 } {
  const bridge = bridgeEnds();
  const sanko = sankoEnds();
  // each landing, and the crossing's other one
  const ends: Record<Exclude<RoadPoint, Pt>, [Point2, Point2]> = {
    'bridge-e': [bridge.e, bridge.w],
    'bridge-w': [bridge.w, bridge.e],
    'sanko-s': [sanko.s, sanko.n],
    'sanko-n': [sanko.n, sanko.s],
  };
  const [at, other] = ends[a];
  const len = Math.hypot(at.x - other.x, at.z - other.z);
  return { at, out: { x: at.x + ((at.x - other.x) / len) * APPROACH, z: at.z + ((at.z - other.z) / len) * APPROACH } };
}

/** A way's designed points split into the pieces either side of its crossings, each as plain points, coming straight onto them. */
function pieces(points: readonly RoadPoint[]): Pt[][] {
  const out: Pt[][] = [];
  let cur: Pt[] = [];
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (typeof p !== 'string') {
      cur.push(p);
      continue;
    }
    const a = anchor(p);
    const next = points[i + 1];
    if (typeof next === 'string' && next.split('-')[0] === p.split('-')[0]) {
      // arriving at a crossing: come straight onto it, end here, and go on from its far landing
      cur.push([a.out.x, a.out.z], [a.at.x, a.at.z]);
      out.push(cur);
      const b = anchor(next);
      cur = [
        [b.at.x, b.at.z],
        [b.out.x, b.out.z],
      ];
      i++;
    } else cur.push([a.at.x, a.at.z]);
  }
  if (cur.length > 1) out.push(cur);
  return out;
}

/** A smooth curve through `pts` (Catmull–Rom), as points every STEP m. */
function curve(pts: readonly Pt[]): Pt[] {
  const dense: Pt[] = [];
  const p = (i: number) => pts[Math.max(0, Math.min(pts.length - 1, i))];
  for (let i = 0; i < pts.length - 1; i++) {
    const [x0, z0] = p(i - 1);
    const [x1, z1] = p(i);
    const [x2, z2] = p(i + 1);
    const [x3, z3] = p(i + 2);
    const n = Math.max(2, Math.ceil(Math.hypot(x2 - x1, z2 - z1) / 0.8));
    for (let k = 0; k < n; k++) {
      const t = k / n;
      const f = (a: number, b: number, c: number, d: number) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t * t + (-a + 3 * b - 3 * c + d) * t * t * t);
      dense.push([f(x0, x1, x2, x3), f(z0, z1, z2, z3)]);
    }
  }
  dense.push(pts[pts.length - 1]);
  // resampled every STEP m along it, keeping both ends exactly
  const out: Pt[] = [dense[0]];
  let carry = 0;
  for (let k = 0; k + 1 < dense.length; k++) {
    const [ax, az] = dense[k];
    const [bx, bz] = dense[k + 1];
    const len = Math.hypot(bx - ax, bz - az);
    let at = STEP - carry;
    while (at <= len) {
      out.push([ax + ((bx - ax) * at) / len, az + ((bz - az) * at) / len]);
      at += STEP;
    }
    carry = len - (at - STEP);
  }
  const last = pts[pts.length - 1];
  if (Math.hypot(out[out.length - 1][0] - last[0], out[out.length - 1][1] - last[1]) > 0.3) out.push(last);
  else out[out.length - 1] = last;
  return out;
}

/** The brick road's crest along its points: the land under it (the fields and the river's levee) raised, smoothed along it. */
function crests(pts: readonly Pt[]): Float32Array {
  const land = pts.map(([x, z]) => PLAIN + riverLevee(x, z) + ROAD_RAISE);
  const out = new Float32Array(pts.length);
  for (let i = 0; i < pts.length; i++) {
    let s = 0;
    let k = 0;
    for (let j = Math.max(0, i - 6); j <= Math.min(pts.length - 1, i + 6); j++) (s += land[j]), k++;
    out[i] = s / k;
  }
  return out;
}

/** A path along a waterway's bank: its points between the two it is laid from, `offset` m back from the water's edge, on their side. */
function alongBank(a: NonNullable<RoadSpec['along']>): Pt[] {
  const way = a.way === 'river' ? RIVER : KHAL;
  const s0 = way.line.nearestS(a.from[0], a.from[1]);
  const s1 = way.line.nearestS(a.to[0], a.to[1]);
  const p = way.at(s0);
  const side = Math.cos(p.heading) * (a.from[0] - p.x) - Math.sin(p.heading) * (a.from[1] - p.z) >= 0 ? 1 : -1;
  const out: Pt[] = [];
  const step = s1 > s0 ? 6 : -6;
  for (let s = s0; step > 0 ? s <= s1 : s >= s1; s += step) {
    const e = way.beside(s, side, way.half(s) + a.offset);
    out.push([e.x, e.z]);
  }
  return out;
}

const REACHES: Reach[] = [];
/** Each piece's run of REACHES, for the joints between them. */
const PIECES: { first: number; count: number }[] = [];
for (const road of ROADS) {
  const half = road.width / 2;
  for (const piece of road.along ? [alongBank(road.along)] : pieces(road.points ?? [])) {
    const pts = curve(piece);
    const c = road.kind === 'brick' ? crests(pts) : null;
    const first = REACHES.length;
    let v = 0;
    for (let k = 0; k + 1 < pts.length; k++) {
      const [ax, az] = pts[k];
      const [bx, bz] = pts[k + 1];
      const len = Math.hypot(bx - ax, bz - az);
      REACHES.push({ ax, az, bx, bz, half, ca: c ? c[k] : Number.NaN, cb: c ? c[k + 1] : Number.NaN, surface: road.kind, va: v, vb: v + len });
      v += len;
    }
    PIECES.push({ first, count: REACHES.length - first });
  }
}

/** Every way's pieces, and the brick road's alone (its embankment and its verges). */
const ALL = new SegmentIndex(32);
const BRICK = new SegmentIndex(32);
const BRICK_OF: number[] = [];
REACHES.forEach((r, i) => {
  ALL.add(r.ax, r.az, r.bx, r.bz, r.half, 8);
  if (r.surface === 'brick') {
    BRICK.add(r.ax, r.az, r.bx, r.bz, r.half, SHOULDER + 8);
    BRICK_OF.push(i);
  }
});

/**
 * The ground the brick road leaves at (x, z): its crest across its carriageway, its embankment's sides easing
 * down (or a cutting's up) to the land beside it. The earth paths lie on the ground as it is.
 */
export function roadGround(x: number, z: number, ground: number): number {
  const hit = BRICK.nearest(x, z);
  if (!hit) return ground;
  const r = REACHES[BRICK_OF[hit.index]];
  const crest = r.ca + (r.cb - r.ca) * hit.t;
  if (hit.d <= r.half + 0.3) return crest;
  return crest + (ground - crest) * smoothstep(r.half + 0.3, r.half + 0.3 + SHOULDER, hit.d);
}

/** How much of (x, z) is a way's trodden ground (1 on it, easing to 0 across the brick road's shoulders or a path's worn edge). */
export function roadCover(x: number, z: number): number {
  const hit = ALL.nearest(x, z);
  if (!hit) return 0;
  const r = REACHES[hit.index];
  return 1 - smoothstep(r.half, r.half + (r.surface === 'brick' ? SHOULDER : 0.7), hit.d);
}

/** How far (x, z) is from the brick road's edge (m; ∞ away from it): its verges are grass, not field. */
export function roadEdge(x: number, z: number): number {
  const hit = BRICK.nearest(x, z);
  return hit ? hit.d - REACHES[BRICK_OF[hit.index]].half : Infinity;
}

/** True within `margin` m of a way (its carriageway or its path). */
export function onRoad(x: number, z: number, margin = 0): boolean {
  const hit = ALL.nearest(x, z);
  return hit !== null && hit.d < REACHES[hit.index].half + margin;
}

/** The ways' points, for laying things along them (trees along the road): each piece's points every STEP m, with its surface. */
export function roadLines(): { surface: Surface; half: number; points: Pt[] }[] {
  return PIECES.map((p) => {
    const pts: Pt[] = [];
    for (let k = p.first; k < p.first + p.count; k++) pts.push([REACHES[k].ax, REACHES[k].az]);
    const last = REACHES[p.first + p.count - 1];
    pts.push([last.bx, last.bz]);
    return { surface: REACHES[p.first].surface, half: REACHES[p.first].half, points: pts };
  });
}

// ---------- the meshes ----------

/** Ways are drawn in cells of this size (m), so those out of view, or far off, are left undrawn. */
const CELL = 1300;
/** Each surface's third of the atlas, inset a little so its neighbour does not bleed in. */
const atlasU = (surface: Surface, u: number) => (ROAD_SURFACES.indexOf(surface) + 0.04 + 0.92 * u) / ROAD_SURFACES.length;

/** Each surface's tint over its texture: the brick dulled by the dust that lies on it. */
const SURFACE_TINT: Record<Surface, RGB> = {
  brick: rgb('#c9bcae'),
  earth: rgb('#e6ddd2'),
};

/**
 * The ways' surfaces, in cells; pass the group to cullBeyond. The brick road lies on its crest; the earth
 * paths are laid over `ground` (the terrain's height), a little above it.
 */
export function buildRoads(ground: (x: number, z: number) => number): Group {
  const group = new Group();
  group.name = 'roads';
  const rng = new Rng(61);
  const cells = new Map<string, MeshBuilder>();
  const builderFor = (x: number, z: number) => {
    const key = `${Math.floor(x / CELL)}:${Math.floor(z / CELL)}`;
    let b = cells.get(key);
    if (!b) cells.set(key, (b = new MeshBuilder()));
    return b;
  };
  const up = new Vector3(0, 1, 0);
  const at = new Vector3();

  for (const piece of PIECES) {
    for (let k = piece.first; k < piece.first + piece.count; k++) {
      const r = REACHES[k];
      const len = Math.hypot(r.bx - r.ax, r.bz - r.az);
      if (len < 0.05) continue;
      // across the way, to its right
      const nx = (r.bz - r.az) / len;
      const nz = -(r.bx - r.ax) / len;
      const b = builderFor((r.ax + r.bx) / 2, (r.az + r.bz) / 2);
      // a little variety piece by piece: newer and older stretches, fresher and more trodden earth
      const c = scaleRgb(SURFACE_TINT[r.surface], rng.range(0.9, 1.05));
      const height = (t: number, across: number) => {
        const x = r.ax + (r.bx - r.ax) * t + nx * across;
        const z = r.az + (r.bz - r.az) * t + nz * across;
        return r.surface === 'brick' ? r.ca + (r.cb - r.ca) * t + LIFT : ground(x, z) + LIFT * 0.7;
      };
      // brick lies flat on its crest; a path is laid over the ground in short steps, three points across
      const along = r.surface === 'brick' ? 1 : Math.max(1, Math.round(len / 1.25));
      const across = r.surface === 'brick' ? [-1, 1] : [-1, 0, 1];
      const s = b.vertexCount;
      for (let i = 0; i <= along; i++) {
        const t = i / along;
        for (const a of across) {
          const x = r.ax + (r.bx - r.ax) * t + nx * r.half * a;
          const z = r.az + (r.bz - r.az) * t + nz * r.half * a;
          b.vertex(at.set(x, height(t, r.half * a), z), up, atlasU(r.surface, (a + 1) / 2), (r.va + (r.vb - r.va) * t) / 3, c);
        }
      }
      const w = across.length;
      for (let i = 0; i < along; i++) for (let j = 0; j + 1 < w; j++) b.quad(s + i * w + j, s + (i + 1) * w + j, s + (i + 1) * w + j + 1, s + i * w + j + 1);
      // the joint with the next piece: a disc at the bend, so its outside is not left open
      if (k + 1 < piece.first + piece.count) {
        const y = height(1, 0) - 0.002;
        const j0 = b.vertexCount;
        b.vertex(at.set(r.bx, y, r.bz), up, atlasU(r.surface, 0.5), r.vb / 3, c);
        const N = 8;
        for (let i = 0; i <= N; i++) {
          const a = (i / N) * Math.PI * 2;
          const x = r.bx + Math.cos(a) * r.half;
          const z = r.bz + Math.sin(a) * r.half;
          b.vertex(at.set(x, r.surface === 'brick' ? y : ground(x, z) + LIFT * 0.7 - 0.002, z), up, atlasU(r.surface, 0.5 + 0.5 * Math.cos(a)), r.vb / 3 + 0.3 * Math.sin(a), c);
        }
        for (let i = 0; i < N; i++) b.tri(j0, j0 + i + 2, j0 + i + 1);
      }
    }
  }

  const material = roadMaterial();
  for (const b of cells.values()) {
    if (!b.vertexCount) continue;
    const mesh = new Mesh(b.build(), material);
    mesh.receiveShadow = true;
    // flat on the ground: not worth drawing again in the water's mirror
    mesh.layers.set(LAYER_NO_REFLECT);
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
