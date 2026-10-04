import { BufferAttribute, BufferGeometry, Group, Mesh, MeshStandardMaterial, type Vector3 } from 'three';
import { smoothstep } from '../core/mathx';
import { fbm } from '../core/noise';
import { COVER, GRID_H, GRID_W, LAYERS, TIDE_BAKE, fcol, frow } from '../geo/data';
import { mixRgb, rgb, type RGB } from '../render/builder';
import { patchMaterial } from '../render/patch';
import type { GroundSet } from '../render/surfaces';
import { WORLD_X0, WORLD_X1, WORLD_Z0, WORLD_Z1, bilMarsh, bridgePath, riverX, seaWaterAt, terrainHeight, villageDistance, waterLevelAt } from './geography';
import { plantCover } from './plantSite';
import { roadCover } from './roads';

// The ground: the baked map's heights (geography.ts terrainHeight) and covers (geo/data.ts), drawn as a
// quadtree of square patches round the camera, fine near it (≈2 m between vertices) and coarse far off. Each
// patch is a 64 × 64 grid with a skirt hanging from its edges, so where patches of different sizes meet no
// crack shows. Patches are built when first needed, a few milliseconds' worth a frame, and kept.

const COLORS = {
  bedDeep: rgb('#2a241a'),
  wetMud: rgb('#3d3226'),
  dryMud: rgb('#6e5c45'),
  sandWet: rgb('#8a7759'),
  sand: rgb('#c4b08c'),
  grassA: rgb('#4a6427'),
  grassB: rgb('#647b33'),
  grassDry: rgb('#857e48'),
  dust: rgb('#7d6849'),
  /** The hills under their forest: dark canopy greens, and the red earth where it shows through. */
  forest: rgb('#1f3317'),
  forestLight: rgb('#33502a'),
  laterite: rgb('#7a4a30'),
  /** Tidal mud where the mangroves stand. */
  tidalMud: rgb('#4a4236'),
  /** The salt pans' grey, salty clay. */
  saltClay: rgb('#8a8170'),
  coastGrass: rgb('#6d7442'),
  /** The power plant's platform: pale dredged sand, levelled and rolled; its embankment faced with stone. */
  fill: rgb('#b8a78b'),
  revetment: rgb('#837d72'),
};

/**
 * What covers the ground at a point: the painted colour, the field zone (paddy plots as 0..1, salt pans as
 * 0..−1), and the weights of the photo layers (grass, dirt, sand, and whether pebbles may gather here; mud
 * takes whatever is left). The terrain mesh and the near-field grass both read it, so grass grows where the
 * ground is grassy.
 */
export interface Cover {
  color: RGB;
  zone: number;
  grass: number;
  dirt: number;
  sand: number;
  pebbles: number;
}

/** Each cover class's own colour, zone and layer weights before the local touches. */
interface ClassLook {
  color: RGB;
  zone: number;
  grass: number;
  dirt: number;
  sand: number;
}

const LOOK: Record<number, ClassLook> = {
  [COVER.none]: { color: COLORS.grassA, zone: 0, grass: 0.8, dirt: 0.1, sand: 0 },
  [COVER.tree]: { color: COLORS.forestLight, zone: 0, grass: 0.45, dirt: 0.3, sand: 0 },
  [COVER.shrub]: { color: mixRgb(COLORS.grassB, COLORS.forestLight, 0.5), zone: 0, grass: 0.6, dirt: 0.25, sand: 0 },
  [COVER.grass]: { color: COLORS.grassB, zone: 0, grass: 0.9, dirt: 0.05, sand: 0 },
  [COVER.crop]: { color: COLORS.grassA, zone: 1, grass: 0.75, dirt: 0.15, sand: 0 },
  [COVER.built]: { color: COLORS.dust, zone: 0, grass: 0.15, dirt: 0.85, sand: 0 },
  [COVER.bare]: { color: COLORS.dryMud, zone: 0, grass: 0.05, dirt: 0.9, sand: 0.05 },
  [COVER.sand]: { color: COLORS.sand, zone: 0, grass: 0, dirt: 0, sand: 1 },
  [COVER.mud]: { color: COLORS.tidalMud, zone: 0, grass: 0, dirt: 0.1, sand: 0 },
  [COVER.marsh]: { color: mixRgb(COLORS.grassA, COLORS.coastGrass, 0.5), zone: 0, grass: 0.85, dirt: 0, sand: 0 },
  [COVER.mangrove]: { color: COLORS.tidalMud, zone: 0, grass: 0, dirt: 0.05, sand: 0 },
  [COVER.saltpan]: { color: COLORS.saltClay, zone: -1, grass: 0, dirt: 0.6, sand: 0 },
  [COVER.pond]: { color: COLORS.wetMud, zone: 0, grass: 0, dirt: 0, sand: 0 },
  [COVER.water]: { color: COLORS.wetMud, zone: 0, grass: 0, dirt: 0, sand: 0 },
};

const blend: ClassLook = { color: [0, 0, 0], zone: 0, grass: 0, dirt: 0, sand: 0 };

/** The four cells round a point, their looks blended bilinearly, so class edges are soft rather than 10 m steps. */
function blendedLook(x: number, z: number): ClassLook {
  const fc = Math.min(GRID_W - 1.0001, Math.max(0, fcol(x)));
  const fr = Math.min(GRID_H - 1.0001, Math.max(0, frow(z)));
  const c = Math.floor(fc);
  const r = Math.floor(fr);
  const tx = fc - c;
  const ty = fr - r;
  const cells = LAYERS.cover;
  const i = r * GRID_W + c;
  const w = [(1 - tx) * (1 - ty), tx * (1 - ty), (1 - tx) * ty, tx * ty];
  const ids = [i, i + 1, i + GRID_W, i + GRID_W + 1];
  let r0 = 0;
  let g0 = 0;
  let b0 = 0;
  blend.zone = 0;
  blend.grass = 0;
  blend.dirt = 0;
  blend.sand = 0;
  for (let k = 0; k < 4; k++) {
    const look = LOOK[cells[ids[k]]] ?? LOOK[COVER.none];
    const wk = w[k];
    r0 += look.color[0] * wk;
    g0 += look.color[1] * wk;
    b0 += look.color[2] * wk;
    // a field or a pan is one or the other: the zone takes the cells' own sign
    blend.zone += look.zone * wk;
    blend.grass += look.grass * wk;
    blend.dirt += look.dirt * wk;
    blend.sand += look.sand * wk;
  }
  blend.color = [r0, g0, b0];
  return blend;
}

function cover(x: number, z: number, h: number): Cover {
  const look = blendedLook(x, z);
  // under water (the sea's below its low water, whatever the tide; a pond's below its level): the bed, darker
  // with depth (the flats between the tides keep their mud and sand)
  const water = seaWaterAt(x, z) ? TIDE_BAKE.lowWater : waterLevelAt(x, z);
  // (dry ground has none: far below, so the wet band and wet sand below stay off)
  const level = Number.isFinite(water) ? water : -1e4;
  if (h < level - 0.15) {
    const color = mixRgb(COLORS.bedDeep, COLORS.wetMud, smoothstep(-4, -0.15, h - level));
    return { color, zone: 0, grass: 0, dirt: 0, sand: look.sand, pebbles: 0 };
  }
  let ground = look.color;
  const site = plantCover(x, z);
  const plant = site.top + site.bank;
  // some variety: greener and drier patches, and on the hills red earth showing through the forest
  ground = mixRgb(ground, COLORS.grassB, (fbm(x * 0.012, z * 0.012, 2, 21) - 0.5) * 0.6 * look.grass);
  const dry = smoothstep(0.6, 0.8, fbm(x * 0.004, z * 0.004, 2, 33));
  ground = mixRgb(ground, COLORS.grassDry, dry * look.grass * 0.7);
  if (h > 10) {
    const canopy = mixRgb(COLORS.forest, COLORS.forestLight, fbm(x * 0.02, z * 0.02, 2, 121));
    const bare = smoothstep(0.72, 0.85, fbm(x * 0.03 + 9, z * 0.03, 2, 123));
    ground = mixRgb(ground, mixRgb(canopy, COLORS.laterite, bare * 0.8), smoothstep(10, 18, h) * (1 - look.sand) * (1 - plant));
  }
  // the power plant's platform, kept bare, and the stone down its sides
  if (plant > 0) {
    ground = mixRgb(ground, mixRgb(COLORS.fill, COLORS.dust, (fbm(x * 0.05, z * 0.05, 2, 41) - 0.5) * 0.8), site.top);
    ground = mixRgb(ground, COLORS.revetment, site.bank);
  }
  // round the houses the ground is trodden bare; the footpath over the old bridge is worn to earth
  const yard = smoothstep(1.0, 0.35, villageDistance(x, z));
  const path = bridgePath(x, z);
  ground = mixRgb(ground, COLORS.dust, Math.max(yard * 0.6, path * 0.85));
  // the bil's low rim is wet meadow, grassy almost to the water
  const marsh = bilMarsh(z, x - riverX(z));
  // the strip the water wets: mud, darker toward the water's edge (beaches keep their sand)
  const wetBand = smoothstep(level + 0.9, level + 0.05, h) * (1 - marsh) * (1 - look.sand);
  ground = mixRgb(ground, mixRgb(COLORS.wetMud, COLORS.dryMud, smoothstep(level, level + 0.9, h)), wetBand);
  if (look.sand > 0) ground = mixRgb(ground, mixRgb(COLORS.sandWet, COLORS.sand, smoothstep(level + 0.1, level + 1.2, h)), look.sand);
  // the roads' shoulders: trodden earth down the embankment (the surface itself is world/roads.ts's)
  const road = roadCover(x, z);
  ground = mixRgb(ground, COLORS.dust, road * 0.4);
  const dirt = Math.min(1, look.dirt + yard * 0.9 + path + dry * 0.35 * look.grass + road);
  const top = 1 - wetBand;
  const wild = 1 - plant;
  return {
    color: ground,
    // paddy plots and salt pans only on their own ground above the water, and off the roads and the plant
    zone: look.zone * top * (1 - road) * wild,
    grass: Math.max(0, look.grass * top * (1 - dirt) * (1 - road) + marsh * 0.8) * wild,
    dirt: dirt * top * (1 - look.sand) * wild + site.top * 0.55 + site.bank * 0.7,
    sand: look.sand * wild + site.top * 0.45,
    pebbles: site.bank,
  };
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
/** The smallest patch (m): ≈2 m between vertices. */
const LEAF = 128;
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

/** One patch's geometry: a 64 × 64 grid of the ground plus a skirt round it, normals from a ring of neighbours. */
function patchGeometry(n: Node): BufferGeometry {
  const step = n.size / N;
  const x0 = n.x - n.size / 2;
  const z0 = n.z - n.size / 2;
  const S = N + 3; // heights with a one-sample border for the normals
  const hs = new Float32Array(S * S);
  for (let j = 0; j < S; j++) for (let i = 0; i < S; i++) hs[j * S + i] = terrainHeight(x0 + (i - 1) * step, z0 + (j - 1) * step);
  const V = (N + 1) * (N + 1);
  const skirt = 4 * (N + 1);
  const pos = new Float32Array((V + skirt) * 3);
  const nrm = new Float32Array((V + skirt) * 3);
  const col = new Float32Array((V + skirt) * 3);
  const zone = new Float32Array(V + skirt);
  const splat = new Float32Array((V + skirt) * 4);
  const write = (k: number, x: number, y: number, z: number, nx: number, ny: number, nz: number, c: Cover) => {
    pos.set([x, y, z], k * 3);
    nrm.set([nx, ny, nz], k * 3);
    col.set(c.color, k * 3);
    zone[k] = c.zone;
    splat.set([c.grass, c.dirt, c.sand, c.pebbles], k * 4);
  };
  const covers: Cover[] = [];
  const normals: [number, number, number][] = [];
  for (let j = 0; j <= N; j++) {
    for (let i = 0; i <= N; i++) {
      const x = x0 + i * step;
      const z = z0 + j * step;
      const h = hs[(j + 1) * S + i + 1];
      // normal from the neighbours' heights (x along i, z along j)
      const dx = (hs[(j + 1) * S + i + 2] - hs[(j + 1) * S + i]) / (2 * step);
      const dz = (hs[(j + 2) * S + i + 1] - hs[j * S + i + 1]) / (2 * step);
      const l = Math.hypot(dx, 1, dz);
      const c = cover(x, z, h);
      covers.push(c);
      normals.push([-dx / l, 1 / l, -dz / l]);
      write(j * (N + 1) + i, x, h, z, -dx / l, 1 / l, -dz / l, c);
    }
  }
  // the skirt: each edge vertex again, hung below so a coarser neighbour's edge cannot show a gap
  const drop = step * 2 + 1;
  const edge: number[] = [];
  for (let i = 0; i <= N; i++) edge.push(i);
  for (let j = 0; j <= N; j++) edge.push(j * (N + 1) + N);
  for (let i = N; i >= 0; i--) edge.push(N * (N + 1) + i);
  for (let j = N; j >= 0; j--) edge.push(j * (N + 1));
  edge.forEach((v, k) => {
    const n3 = normals[v];
    write(V + k, pos[v * 3], pos[v * 3 + 1] - drop, pos[v * 3 + 2], n3[0], n3[1], n3[2], covers[v]);
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
  g.setAttribute('normal', new BufferAttribute(nrm, 3));
  g.setAttribute('color', new BufferAttribute(col, 3));
  g.setAttribute('aZone', new BufferAttribute(zone, 1));
  g.setAttribute('aSplat', new BufferAttribute(splat, 4));
  g.setIndex(new BufferAttribute(idx.subarray(0, q), 1));
  g.computeBoundingSphere();
  return g;
}

export class Terrain {
  readonly group = new Group();
  private readonly material: MeshStandardMaterial;
  private readonly built = new Map<string, Mesh>();
  private readonly lastUsed = new Map<string, number>();
  private frame = 0;
  private readonly root: Node;

  /** `ground`: the photo layers; without them the terrain keeps its painted colours. */
  constructor(ground: GroundSet | null) {
    this.group.name = 'terrain';
    this.material = patchMaterial(new MeshStandardMaterial({ vertexColors: true, roughness: 0.94, metalness: 0 }), {
      terrain: true,
      splat: ground ?? undefined,
    });
    // the map and a margin of sea floor round it (heights fade to the deep there)
    const size = Math.max(WORLD_X1 - WORLD_X0, WORLD_Z0 - WORLD_Z1) + 800;
    let s = LEAF;
    while (s < size) s *= 2;
    this.root = { key: '', x: (WORLD_X0 + WORLD_X1) / 2, z: (WORLD_Z0 + WORLD_Z1) / 2, size: s };
  }

  /** Shows the patches the camera needs, building those not yet made; `all` builds every one now (for stills and the first frame). */
  update(eye: Vector3, all = false): void {
    this.frame++;
    const want: Node[] = [];
    this.select(this.root, eye, want);
    const start = performance.now();
    const show = new Set<Mesh>();
    for (const n of want) {
      let mesh = this.built.get(n.key);
      if (!mesh && (all || performance.now() - start < BUDGET_MS)) mesh = this.build(n);
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
          show.add(this.build(this.root));
          break;
        }
      }
    }
    for (const mesh of this.built.values()) mesh.visible = show.has(mesh);
    this.evict();
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

  private build(n: Node): Mesh {
    const mesh = new Mesh(patchGeometry(n), this.material);
    mesh.receiveShadow = true;
    mesh.name = 'terrain';
    this.built.set(n.key, mesh);
    this.group.add(mesh);
    return mesh;
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
