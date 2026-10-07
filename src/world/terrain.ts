import { BufferAttribute, BufferGeometry, Group, Mesh, MeshStandardMaterial, type Vector3 } from 'three';
import { smoothstep } from '../core/mathx';
import { fbm } from '../core/noise';
import { mixRgb, rgb, type RGB } from '../render/builder';
import { patchMaterial } from '../render/patch';
import type { GroundSet } from '../render/surfaces';
import { WORLD_X0, WORLD_X1, WORLD_Z0, WORLD_Z1, bankStrip, bilMarsh, landUse, shoreLevel, terrainHeight } from './geography';
import { roadCover } from './roads';

// The ground: the village's heights (geography.ts terrainHeight) and what covers it (geography.ts landUse),
// drawn as a quadtree of square patches round the camera, fine near it (≈2 m between vertices) and coarse far
// off. Each patch is a 64 × 64 grid with a skirt hanging from its edges, so where patches of different sizes
// meet no crack shows. Patches are built when first needed, a few milliseconds' worth a frame, and kept.

const COLORS = {
  bedDeep: rgb('#2a241a'),
  /** The shallow bed by the banks: gravel and small stones, seen through clear water. */
  gravel: rgb('#6b6253'),
  wetMud: rgb('#3d3226'),
  dryMud: rgb('#6e5c45'),
  sandWet: rgb('#8a7759'),
  sand: rgb('#c4b08c'),
  grassA: rgb('#4a6427'),
  grassB: rgb('#647b33'),
  grassDry: rgb('#857e48'),
  dust: rgb('#7d6849'),
  /** A homestead's yard: clay swept and plastered smooth with mud and cow dung, pale where the sun bakes it. */
  yard: rgb('#9a8262'),
  /** Under the homestead's trees: shaded grass and leaf litter. */
  grove: rgb('#3e5226'),
  /** The bil's wet meadow. */
  marsh: rgb('#5a6c38'),
  /** The salt field's grey clay (render/patch.ts paints its beds over it). */
  clay: rgb('#6f685d'),
  /** The salt creek's flats: grey-brown tidal mud, a salt-burnt grass on it. */
  flats: rgb('#6c6452'),
};

/**
 * What covers the ground at a point: the painted colour, the field zone (paddy plots as 0..1), and the
 * weights of the photo layers (grass, dirt, sand, and whether pebbles may gather here; mud takes whatever is
 * left). The terrain mesh and the near-field grass both read it, so grass grows where the ground is grassy.
 */
export interface Cover {
  color: RGB;
  zone: number;
  grass: number;
  dirt: number;
  sand: number;
  pebbles: number;
  /** How much of it is ground kept bare: a swept yard, a way's trodden earth (0..1); no grass grows there. */
  bare: number;
}

/** Each kind of ground's own colour, zone and layer weights before the local touches. */
interface ClassLook {
  color: RGB;
  zone: number;
  grass: number;
  dirt: number;
  sand: number;
  /** Kept bare (swept, trodden): no grass. */
  bare: number;
}

const LOOK: Record<'field' | 'yard' | 'mound' | 'verge' | 'sand' | 'marsh' | 'salt' | 'flats', ClassLook> = {
  field: { color: COLORS.grassA, zone: 1, grass: 0.75, dirt: 0.15, sand: 0, bare: 0 },
  // the yard is clay swept smooth: the fine sand layer's grain under its colour, little of the gravelly dirt or the cracked mud
  yard: { color: COLORS.yard, zone: 0, grass: 0.02, dirt: 0.08, sand: 0.6, bare: 1 },
  mound: { color: COLORS.grove, zone: 0, grass: 0.55, dirt: 0.3, sand: 0, bare: 0 },
  verge: { color: COLORS.grassB, zone: 0, grass: 0.9, dirt: 0.05, sand: 0, bare: 0 },
  sand: { color: COLORS.sand, zone: 0, grass: 0, dirt: 0, sand: 1, bare: 0 },
  marsh: { color: COLORS.marsh, zone: 0, grass: 0.85, dirt: 0, sand: 0, bare: 0 },
  // the salt field: its zone below 0 (render/patch.ts paints the beds, bunds and brine), kept bare
  salt: { color: COLORS.clay, zone: -1, grass: 0, dirt: 0.4, sand: 0.3, bare: 1 },
  // the creek's flats: mud with a thin, low, yellowed grass
  flats: { color: COLORS.flats, zone: 0, grass: 0.3, dirt: 0.55, sand: 0.1, bare: 0 },
};

const blend: ClassLook = { color: [0, 0, 0], zone: 0, grass: 0, dirt: 0, sand: 0, bare: 0 };

/** The kinds of ground at a point (geography.ts landUse), their looks blended by their shares. */
function blendedLook(x: number, z: number): ClassLook {
  const u = landUse(x, z);
  const parts: [ClassLook, number][] = [
    [LOOK.field, u.field],
    [LOOK.yard, u.yard],
    [LOOK.mound, u.mound],
    [LOOK.verge, u.verge],
    [LOOK.sand, u.sand],
    [LOOK.marsh, u.marsh],
    [LOOK.salt, u.salt],
    [LOOK.flats, u.flats],
  ];
  let total = 0;
  for (const [, w] of parts) total += w;
  const k = 1 / Math.max(1e-4, total);
  let r = 0;
  let g = 0;
  let b = 0;
  blend.zone = 0;
  blend.grass = 0;
  blend.dirt = 0;
  blend.sand = 0;
  blend.bare = 0;
  for (const [look, w0] of parts) {
    const w = w0 * k;
    r += look.color[0] * w;
    g += look.color[1] * w;
    b += look.color[2] * w;
    blend.zone += look.zone * w;
    blend.grass += look.grass * w;
    blend.dirt += look.dirt * w;
    blend.sand += look.sand * w;
    blend.bare += look.bare * w;
  }
  blend.color = [r, g, b];
  return blend;
}

function cover(x: number, z: number, h: number): Cover {
  const look = blendedLook(x, z);
  // under water (below the khal's, the bil's or a pond's level): the bed, darker with depth; on a bank, the
  // level of its water (away from water none: far below, so the wet band and wet sand below stay off)
  const water = shoreLevel(x, z);
  const level = Number.isFinite(water) ? water : -1e4;
  if (h < level - 0.15) {
    // gravel and stones in the shallows along the banks, fading into silt as it deepens
    const shallow = smoothstep(-2.4, -0.4, h - level);
    const color = mixRgb(mixRgb(COLORS.bedDeep, COLORS.wetMud, smoothstep(-4, -0.15, h - level)), COLORS.gravel, shallow * 0.75);
    return { color, zone: 0, grass: 0, dirt: 0, sand: Math.max(look.sand, 0.25 * shallow), pebbles: 0.85 * shallow, bare: 0 };
  }
  let ground = look.color;
  // some variety: greener and drier patches, and on the hills red earth showing through the forest
  ground = mixRgb(ground, COLORS.grassB, (fbm(x * 0.012, z * 0.012, 2, 21) - 0.5) * 0.6 * look.grass);
  const dry = smoothstep(0.6, 0.8, fbm(x * 0.004, z * 0.004, 2, 33));
  ground = mixRgb(ground, COLORS.grassDry, dry * look.grass * 0.7);
  // the bil's low rim is wet meadow, grassy almost to the water
  const marsh = bilMarsh(x, z);
  // the strip the water wets: mud up the khal's bank and a pond's edge, darker toward the water (grass on the levee above)
  const wetBand = smoothstep(level + 0.6, level + 0.05, h) * (1 - marsh) * (1 - look.sand);
  ground = mixRgb(ground, mixRgb(COLORS.wetMud, COLORS.dryMud, smoothstep(level, level + 0.6, h)), wetBand);
  if (look.sand > 0) ground = mixRgb(ground, mixRgb(COLORS.sandWet, COLORS.sand, smoothstep(level + 0.1, level + 1.2, h)), look.sand);
  // the ways: trodden earth under the paths and down the road's embankment (the surfaces are world/roads.ts's)
  const road = roadCover(x, z);
  ground = mixRgb(ground, COLORS.dust, road * 0.55);
  const dirt = Math.min(1, look.dirt + dry * 0.35 * look.grass + road);
  const top = 1 - wetBand;
  return {
    color: ground,
    // paddy plots only on their own ground above the water, off the ways and off the waters' banks
    zone: look.zone * top * (1 - road) * (1 - bankStrip(x, z)),
    grass: Math.max(0, look.grass * top * (1 - dirt) * (1 - road) + marsh * 0.8),
    dirt: dirt * top * (1 - look.sand),
    sand: look.sand,
    pebbles: 0,
    bare: Math.min(1, Math.max(look.bare, road)),
  };
}

/** The quadtree's corner (its root's least x and z), and the size it spans (m). */
function rootSquare(): { x0: number; z0: number; s: number } {
  // the map and a margin of sea floor round it (heights fade to the deep there)
  const size = Math.max(WORLD_X1 - WORLD_X0, WORLD_Z0 - WORLD_Z1) + 800;
  let s = LEAF;
  while (s < size) s *= 2;
  return { x0: (WORLD_X0 + WORLD_X1) / 2 - s / 2, z0: (WORLD_Z0 + WORLD_Z1) / 2 - s / 2, s };
}

/**
 * The ground as the finest patches draw it at (x, z) (their lattice's heights, interpolated): what lies on the
 * ground near the camera rests on this, not on `terrainHeight`, where the ground is cut finer than the lattice
 * (a narrow stream's gully would otherwise bury what lies in it).
 */
export function meshGround(x: number, z: number): number {
  const root = ROOT;
  const step = LEAF / N;
  const fx = (x - root.x0) / step;
  const fz = (z - root.z0) / step;
  const i = Math.floor(fx);
  const j = Math.floor(fz);
  const tx = fx - i;
  const tz = fz - j;
  const at = (a: number, b: number) => terrainHeight(root.x0 + a * step, root.z0 + b * step);
  const h00 = at(i, j);
  const h01 = at(i, j + 1);
  const a = h00 + (at(i + 1, j) - h00) * tx;
  const b = h01 + (at(i + 1, j + 1) - h01) * tx;
  return a + (b - a) * tz;
}

/** Ground cover at a point of the world (see `Cover`), with the terrain height there. */
export function groundAt(x: number, z: number): Cover & { h: number } {
  const h = terrainHeight(x, z);
  return { ...cover(x, z, h), h };
}

/**
 * Height and cover inside a square (`size` m from (x0, z0)), interpolated from a lattice `step` m apart: the
 * full lookups are costly, and things built near the camera chunk by chunk (the meadow, the crops) need
 * thousands of them.
 */
export function groundLattice(x0: number, z0: number, size: number, step: number): (x: number, z: number) => Cover & { h: number } {
  const n = Math.round(size / step) + 1;
  const pts: (Cover & { h: number })[] = [];
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) pts.push(groundAt(x0 + i * step, z0 + j * step));
  const lerpCover = (a: Cover & { h: number }, b: Cover & { h: number }, t: number) => ({
    color: a.color,
    h: a.h + (b.h - a.h) * t,
    zone: a.zone + (b.zone - a.zone) * t,
    grass: a.grass + (b.grass - a.grass) * t,
    dirt: a.dirt + (b.dirt - a.dirt) * t,
    sand: a.sand + (b.sand - a.sand) * t,
    pebbles: a.pebbles + (b.pebbles - a.pebbles) * t,
    bare: a.bare + (b.bare - a.bare) * t,
  });
  return (x, z) => {
    const fx = Math.min(Math.max((x - x0) / step, 0), n - 1.001);
    const fz = Math.min(Math.max((z - z0) / step, 0), n - 1.001);
    const i = Math.floor(fx);
    const j = Math.floor(fz);
    const tx = fx - i;
    const tz = fz - j;
    const a = lerpCover(pts[j * n + i], pts[j * n + i + 1], tx);
    const b = lerpCover(pts[(j + 1) * n + i], pts[(j + 1) * n + i + 1], tx);
    return lerpCover(a, b, tz);
  };
}

// ---------- the quadtree of patches ----------

/** Quads along a patch's side. */
const N = 64;
/** A patch's heights per side (one sample of border round its vertices, for the normals), its vertices, and its skirt's. */
const S = N + 3;
const V = (N + 1) * (N + 1);
const SKIRT = 4 * (N + 1);
/** The smallest patch (m): ≈2 m between vertices. */
const LEAF = 128;
const ROOT = rootSquare();
/** A patch splits while the camera is nearer its centre than this many times its size. */
const SPLIT = 1.5;
/** Most patch-building time spent in one frame (ms) once running; the first frame builds all it needs. */
const BUDGET_MS = 6;
/** Patches kept built beyond those in view, oldest dropped first. */
const KEEP = 500;

interface Node {
  key: string;
  x: number;
  z: number;
  size: number;
}

/**
 * One patch's geometry: a 64 × 64 grid of the ground plus a skirt round it, normals from a ring of neighbours.
 * Built a row at a time (`next`: a row of heights, then a row of vertices), so a frame can stop between rows and go
 * on in the next: a whole patch is 10-20 ms of work here, and several times that on a phone. (A plain object, not a
 * generator: the engine left a generator's loops unoptimized, and the load's ground took twice as long.)
 */
class PatchRows {
  private readonly step: number;
  private readonly x0: number;
  private readonly z0: number;
  /** Heights with a one-sample border for the normals: S × S. */
  private readonly hs: Float32Array;
  private readonly pos: Float32Array;
  private readonly nrm: Float32Array;
  private readonly col: Float32Array;
  private readonly zone: Float32Array;
  private readonly splat: Float32Array;
  private readonly pool: Float32Array;
  private readonly covers: Cover[] = [];
  private readonly normals: [number, number, number][] = [];
  private readonly holding: number[] = [];
  /** Rows done: first the heights' S, then the vertices' N + 1. */
  private row = 0;

  constructor(n: Node) {
    this.step = n.size / N;
    this.x0 = n.x - n.size / 2;
    this.z0 = n.z - n.size / 2;
    this.hs = new Float32Array(S * S);
    const all = V + SKIRT;
    this.pos = new Float32Array(all * 3);
    this.nrm = new Float32Array(all * 3);
    this.col = new Float32Array(all * 3);
    this.zone = new Float32Array(all);
    this.splat = new Float32Array(all * 4);
    this.pool = new Float32Array(all);
  }

  /** Builds the next row: the geometry once the last is done, else null. */
  next(): BufferGeometry | null {
    if (this.row < S) {
      this.heights(this.row++);
      return null;
    }
    const j = this.row++ - S;
    this.vertices(j);
    return j === N ? this.finish() : null;
  }

  private heights(j: number): void {
    const { hs, step, x0, z0 } = this;
    for (let i = 0; i < S; i++) hs[j * S + i] = terrainHeight(x0 + (i - 1) * step, z0 + (j - 1) * step);
  }

  private write(k: number, x: number, y: number, z: number, nx: number, ny: number, nz: number, c: Cover, holds: number): void {
    this.pos.set([x, y, z], k * 3);
    this.nrm.set([nx, ny, nz], k * 3);
    this.col.set(c.color, k * 3);
    this.zone[k] = c.zone;
    this.splat.set([c.grass, c.dirt, c.sand, c.pebbles], k * 4);
    this.pool[k] = holds;
  }

  private vertices(j: number): void {
    const { hs, step, x0, z0 } = this;
    for (let i = 0; i <= N; i++) {
      const x = x0 + i * step;
      const z = z0 + j * step;
      const h = hs[(j + 1) * S + i + 1];
      // normal from the neighbours' heights (x along i, z along j)
      const dx = (hs[(j + 1) * S + i + 2] - hs[(j + 1) * S + i]) / (2 * step);
      const dz = (hs[(j + 2) * S + i + 1] - hs[j * S + i + 1]) / (2 * step);
      const l = Math.hypot(dx, 1, dz);
      const c = cover(x, z, h);
      this.covers.push(c);
      this.normals.push([-dx / l, 1 / l, -dz / l]);
      // how readily rain stands here: on trodden earth and swept yards (packed hard), in a hollow below its
      // neighbours, never on a slope it runs off; the paddy holds its own water (the plots' in render/patch.ts)
      const hollow = (hs[(j + 1) * S + i] + hs[(j + 1) * S + i + 2] + hs[j * S + i + 1] + hs[(j + 2) * S + i + 1]) / 4 - h;
      const holds = Math.min(1, c.bare * 0.7 + Math.max(0, hollow) * 5) * (1 - smoothstep(0.04, 0.16, Math.hypot(dx, dz))) * (c.zone > 0 ? 0.3 : 1);
      this.holding.push(holds);
      this.write(j * (N + 1) + i, x, h, z, -dx / l, 1 / l, -dz / l, c, holds);
    }
  }

  private finish(): BufferGeometry {
    const { pos, normals, covers, holding } = this;
    // the skirt: each edge vertex again, hung below so a coarser neighbour's edge cannot show a gap
    const drop = this.step * 2 + 1;
    const edge: number[] = [];
    for (let i = 0; i <= N; i++) edge.push(i);
    for (let j = 0; j <= N; j++) edge.push(j * (N + 1) + N);
    for (let i = N; i >= 0; i--) edge.push(N * (N + 1) + i);
    for (let j = N; j >= 0; j--) edge.push(j * (N + 1));
    edge.forEach((v, k) => {
      const n3 = normals[v];
      this.write(V + k, pos[v * 3], pos[v * 3 + 1] - drop, pos[v * 3 + 2], n3[0], n3[1], n3[2], covers[v], holding[v]);
    });
    const idx = new Uint32Array(N * N * 6 + edge.length * 6);
    let q = 0;
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const a = j * (N + 1) + i;
        const b = a + 1;
        const d = a + N + 1;
        const e = d + 1;
        idx[q++] = a;
        idx[q++] = d;
        idx[q++] = b;
        idx[q++] = b;
        idx[q++] = d;
        idx[q++] = e;
      }
    }
    for (let k = 0; k + 1 < edge.length; k++) {
      const a = edge[k];
      const b = edge[k + 1];
      const sa = V + k;
      const sb = V + k + 1;
      // wound to face outward (the edge runs round the patch anticlockwise seen from above): a gap shows
      // from outside the patch, where the neighbour is
      idx[q++] = a;
      idx[q++] = b;
      idx[q++] = sa;
      idx[q++] = b;
      idx[q++] = sb;
      idx[q++] = sa;
    }
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(pos, 3));
    g.setAttribute('normal', new BufferAttribute(this.nrm, 3));
    g.setAttribute('color', new BufferAttribute(this.col, 3));
    g.setAttribute('aZone', new BufferAttribute(this.zone, 1));
    g.setAttribute('aSplat', new BufferAttribute(this.splat, 4));
    g.setAttribute('aPool', new BufferAttribute(this.pool, 1));
    g.setIndex(new BufferAttribute(idx.subarray(0, q), 1));
    g.computeBoundingSphere();
    return g;
  }
}

/** Frames a patch begun but no longer asked for is kept half-built before it is let go. */
const ABANDON = 120;

export class Terrain {
  readonly group = new Group();
  private readonly material: MeshStandardMaterial;
  private readonly built = new Map<string, Mesh>();
  private readonly lastUsed = new Map<string, number>();
  /** Patches being built a few rows a frame, and the frame each was last asked for. */
  private readonly building = new Map<string, { rows: PatchRows; asked: number }>();
  private frame = 0;
  private readonly root: Node;

  /** `ground`: the photo layers; without them the terrain keeps its painted colours. */
  constructor(ground: GroundSet | null) {
    this.group.name = 'terrain';
    // it and its patches lie where their vertices say: their matrices are never remade
    this.group.matrixAutoUpdate = false;
    this.material = patchMaterial(new MeshStandardMaterial({ vertexColors: true, roughness: 0.94, metalness: 0 }), {
      terrain: true,
      splat: ground ?? undefined,
    });
    this.root = { key: '', x: (WORLD_X0 + WORLD_X1) / 2, z: (WORLD_Z0 + WORLD_Z1) / 2, size: ROOT.s };
  }

  /** Shows the patches the camera needs, building those not yet made; `all` builds every one now (for stills and the first frame). */
  update(eye: Vector3, all = false): void {
    this.frame++;
    const want: Node[] = [];
    this.select(this.root, eye, want);
    const until = all ? Infinity : performance.now() + BUDGET_MS;
    const show = new Set<Mesh>();
    for (const n of want) {
      let mesh = this.built.get(n.key);
      if (!mesh && performance.now() < until) mesh = this.advance(n, until);
      if (mesh) {
        show.add(mesh);
        this.lastUsed.set(n.key, this.frame);
        continue;
      }
      // not built yet: its nearest built ancestor stands in for it
      for (let key = n.key.slice(0, -1); ; key = key.slice(0, -1)) {
        const parent = this.built.get(key);
        if (parent) {
          show.add(parent);
          this.lastUsed.set(key, this.frame);
          break;
        }
        if (key === '') {
          show.add(this.advance(this.root, Infinity) as Mesh);
          break;
        }
      }
    }
    for (const mesh of this.built.values()) mesh.visible = show.has(mesh);
    for (const [key, job] of this.building) if (this.frame - job.asked > ABANDON) this.building.delete(key);
    this.evict();
  }

  /**
   * Builds the patches a camera at `eye` will need, until `until` (performance.now()), without showing them:
   * the film readies its next shot. True once all are built.
   */
  warm(eye: Vector3, until: number): boolean {
    const want: Node[] = [];
    this.select(this.root, eye, want);
    for (const n of want) {
      if (!this.built.has(n.key)) {
        if (performance.now() > until) return false;
        const mesh = this.advance(n, until);
        if (!mesh) return false;
        mesh.visible = false;
      }
      this.lastUsed.set(n.key, this.frame);
    }
    return true;
  }

  private select(n: Node, eye: Vector3, out: Node[]): void {
    const d = Math.hypot(eye.x - n.x, eye.z - n.z, Math.max(0, eye.y - 20));
    if (n.size <= LEAF || d > n.size * SPLIT) {
      // patches wholly off the map's margin of sea floor are not drawn
      if (n.x + n.size / 2 < WORLD_X0 - 800 || n.x - n.size / 2 > WORLD_X1 + 800 || n.z + n.size / 2 < WORLD_Z1 - 800 || n.z - n.size / 2 > WORLD_Z0 + 800) return;
      out.push(n);
      return;
    }
    const q = n.size / 4;
    let k = 0;
    for (const [dx, dz] of [
      [-1, -1],
      [1, -1],
      [-1, 1],
      [1, 1],
    ]) {
      this.select({ key: n.key + k++, x: n.x + dx * q, z: n.z + dz * q, size: n.size / 2 }, eye, out);
    }
  }

  /**
   * Builds more of `n`'s patch, row by row, until `until` (performance.now(); at least a row); its mesh once it is
   * done, else undefined (it goes on from there the next time it is asked for).
   */
  private advance(n: Node, until: number): Mesh | undefined {
    let job = this.building.get(n.key);
    if (!job) this.building.set(n.key, (job = { rows: new PatchRows(n), asked: this.frame }));
    job.asked = this.frame;
    do {
      const geometry = job.rows.next();
      if (geometry) {
        this.building.delete(n.key);
        const mesh = new Mesh(geometry, this.material);
        mesh.receiveShadow = true;
        mesh.name = 'terrain';
        mesh.matrixAutoUpdate = false;
        this.built.set(n.key, mesh);
        this.group.add(mesh);
        return mesh;
      }
    } while (performance.now() < until);
    return undefined;
  }

  /** Drops the patches unused longest once more than KEEP are built. */
  private evict(): void {
    if (this.built.size <= KEEP) return;
    const old = [...this.lastUsed.entries()].sort((a, b) => a[1] - b[1]);
    for (const [key, used] of old) {
      if (this.built.size <= KEEP || used === this.frame || key === '') break;
      const mesh = this.built.get(key);
      if (!mesh) continue;
      this.group.remove(mesh);
      mesh.geometry.dispose();
      this.built.delete(key);
      this.lastUsed.delete(key);
    }
  }
}
