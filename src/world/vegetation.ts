import { BufferGeometry, DoubleSide, Group, Matrix4, MeshStandardMaterial, SphereGeometry, Vector2, Vector3 } from 'three';
import type { Texture } from 'three';
import { LAYER_NO_REFLECT } from '../core/globals';
import { smoothstep } from '../core/mathx';
import { fbm } from '../core/noise';
import { Rng } from '../core/rng';
import { MeshBuilder, card, rgb, scaleRgb, taperedTube, type RGB } from '../render/builder';
import { instanced, type Placement } from '../render/instancing';
import { patchMaterial } from '../render/patch';
import type { Surfaces } from '../render/surfaces';
import {
  bananaLeafTexture,
  grassTexture,
  kashTexture,
  leafClusterTexture,
  palmBarkTexture,
  needleTexture,
  palmFrondTexture,
} from '../render/textures';
import { COVER, GRID_H, GRID_W, KIND, LAYERS, LINES, canopyAt, cellCentre, kindAt, place } from '../geo/data';
import {
  BIL,
  CHANNEL_SPAN,
  GORAKGHATA,
  PONDS,
  VILLAGES,
  VILLAGE_CENTERS,
  WETLANDS,
  bankAt,
  bankInfo,
  bilDepth,
  bilReach,
  edgeHalfWidth,
  inlandWaterAt,
  nearBackwater,
  riverX,
  routeGap,
  mangroveZone,
  onBridge,
  onLandmark,
  onRoad,
  onTempleHill,
  saltPan,
  sandCover,
  terrainHeight,
} from './geography';
import type { HutPlan } from './village';

const UP = new Vector3(0, 1, 0);
const BARK = rgb('#4a3d30');
const WHITE: RGB = [1, 1, 1];

// ---------- geometry ----------

interface TreeParts {
  wood: BufferGeometry;
  leaves: BufferGeometry;
}

interface BroadleafOptions {
  height: number;
  trunkR: number;
  crown: number;
  /** Vertical squash of the crown (rain trees are wide umbrellas). */
  flat: number;
  lobes: number;
  cards: number;
  cardSize: number;
  tint: RGB;
  /** Trunk colour; near white when a bark texture supplies the colour. */
  bark: RGB;
  /** A cheap form for trees seen only from afar: a coarser trunk, two limbs. */
  simple?: boolean;
}

function randomUnit(rng: Rng, out: Vector3): Vector3 {
  const z = rng.range(-1, 1);
  const a = rng.range(0, Math.PI * 2);
  const r = Math.sqrt(1 - z * z);
  return out.set(r * Math.cos(a), z, r * Math.sin(a));
}

/** Trunk, a few limbs, and a crown made of leaf-cluster cards lit as one soft volume. */
function broadleaf(rng: Rng, o: BroadleafOptions): TreeParts {
  const wood = new MeshBuilder();
  const leaves = new MeshBuilder();
  const lean = new Vector3(rng.range(-0.5, 0.5), 0, rng.range(-0.5, 0.5));
  const pts: Vector3[] = [];
  const radii: number[] = [];
  const steps = o.simple ? 2 : 5;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    pts.push(new Vector3(lean.x * t * t, o.height * t, lean.z * t * t));
    radii.push(o.trunkR * (1 - 0.45 * t) * (i === 0 ? 1.3 : 1));
  }
  taperedTube(wood, pts, radii, o.simple ? 5 : 7, o.bark, 2);
  const top = pts[steps];
  const center = top.clone().add(new Vector3(0, o.crown * 0.5 * o.flat, 0));
  const lobes: { c: Vector3; r: number }[] = [];
  for (let i = 0; i < o.lobes; i++) {
    const a = rng.range(0, Math.PI * 2);
    const d = rng.range(0.15, 0.6) * o.crown;
    lobes.push({
      c: new Vector3(center.x + Math.cos(a) * d, center.y + rng.range(-0.2, 0.35) * o.crown * o.flat, center.z + Math.sin(a) * d),
      r: o.crown * rng.range(0.55, 0.8),
    });
  }
  for (const l of o.simple ? lobes.slice(0, 2) : lobes) {
    const mid = top.clone().lerp(l.c, 0.55);
    mid.y += 0.3;
    taperedTube(wood, [top.clone(), mid, l.c.clone().lerp(mid, 0.35)], [radii[steps] * 0.75, radii[steps] * 0.45, 0.05], o.simple ? 3 : 5, o.bark, 2);
  }
  const dir = new Vector3();
  const jitter = new Vector3();
  const per = Math.max(4, Math.round(o.cards / o.lobes));
  for (const l of lobes) {
    for (let k = 0; k < per; k++) {
      randomUnit(rng, dir);
      const rr = l.r * Math.cbrt(rng.range(0.2, 1));
      const p = l.c.clone().addScaledVector(dir, rr);
      p.y = l.c.y + (p.y - l.c.y) * o.flat;
      const n = p.clone().sub(l.c).normalize().multiplyScalar(0.6).add(p.clone().sub(center).normalize().multiplyScalar(0.4));
      n.y += 0.2;
      n.normalize();
      const facing = n.clone().add(randomUnit(rng, jitter).multiplyScalar(0.7)).normalize();
      const right = new Vector3().crossVectors(facing, Math.abs(facing.y) < 0.95 ? UP : new Vector3(1, 0, 0)).normalize();
      right.applyAxisAngle(facing, rng.range(0, Math.PI));
      const up = new Vector3().crossVectors(right, facing).normalize();
      const s = o.cardSize * rng.range(0.75, 1.2);
      // darker toward the bottom and the inside of the crown
      const ao = 0.42 + 0.58 * smoothstep(-l.r, l.r * 0.8, p.y - center.y) * (0.55 + 0.45 * (rr / l.r));
      card(leaves, p, right.multiplyScalar(s), up.multiplyScalar(s), n, scaleRgb(o.tint, ao * rng.range(0.85, 1.1)));
    }
  }
  return { wood: wood.build(), leaves: leaves.build() };
}

interface StripOptions {
  base: Vector3;
  az: number;
  elev: number;
  len: number;
  droop: number;
  halfWidth: number;
  /** Width profile along the strip, t in [0, 1]. */
  profile: (t: number) => number;
  fold: number;
  color: RGB;
}

/** A long leaf (palm frond, banana leaf) arching out and down, folded slightly along its rib. */
function leafStrip(b: MeshBuilder, o: StripOptions): void {
  const SEG = 7;
  const dir = new Vector3(Math.cos(o.az) * Math.cos(o.elev), Math.sin(o.elev), Math.sin(o.az) * Math.cos(o.elev));
  const side = new Vector3(-Math.sin(o.az), 0, Math.cos(o.az));
  const start = b.vertexCount;
  const at = (t: number) => o.base.clone().addScaledVector(dir, o.len * t).add(new Vector3(0, -o.droop * o.len * t * t, 0));
  for (let i = 0; i <= SEG; i++) {
    const t = i / SEG;
    const c = at(t);
    const tangent = at(Math.min(1, t + 0.05)).sub(at(Math.max(0, t - 0.05))).normalize();
    const normal = new Vector3().crossVectors(side, tangent).normalize();
    if (normal.y < 0) normal.negate();
    const w = o.halfWidth * o.profile(t) + 0.02;
    const lift = normal.clone().multiplyScalar(w * o.fold);
    const n = normal.clone().add(new Vector3(0, 0.4, 0)).normalize();
    b.vertex(c.clone().addScaledVector(side, -w).add(lift), n, t, 0, o.color);
    b.vertex(c, n, t, 0.5, o.color);
    b.vertex(c.clone().addScaledVector(side, w).add(lift), n, t, 1, o.color);
  }
  for (let i = 0; i < SEG; i++) {
    const a = start + i * 3;
    const n = a + 3;
    b.quad(a, n, n + 1, a + 1);
    b.quad(a + 1, n + 1, n + 2, a + 2);
  }
}

const frondProfile = (t: number) => Math.pow(Math.sin(Math.PI * Math.min(t * 1.1, 1)), 0.6) * (1 - 0.2 * t);
const bananaProfile = (t: number) => Math.pow(Math.sin(Math.PI * t), 0.45);

type PalmKind = 'coconut' | 'supari' | 'date';

/** `cheap`: for palms seen only from afar: a coarse trunk, no nuts, half the fronds. */
function palm(rng: Rng, kind: PalmKind, cheap = false): TreeParts {
  const wood = new MeshBuilder();
  const leaves = new MeshBuilder();
  const H = kind === 'supari' ? rng.range(12, 16) : kind === 'date' ? rng.range(5, 8) : rng.range(8.5, 12.5);
  const R = kind === 'supari' ? 0.12 : kind === 'date' ? 0.3 : 0.22;
  const leanAz = rng.range(0, Math.PI * 2);
  const lean = kind === 'coconut' ? rng.range(0.8, 2.8) : rng.range(0.1, 0.6);
  const pts: Vector3[] = [];
  const radii: number[] = [];
  const steps = cheap ? 4 : 10;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    pts.push(new Vector3(Math.cos(leanAz) * lean * Math.pow(t, 1.6), H * t, Math.sin(leanAz) * lean * Math.pow(t, 1.6)));
    radii.push(R * (1 - 0.3 * t) * (i === 0 ? 1.35 : 1));
  }
  taperedTube(wood, pts, radii, cheap ? 5 : 8, kind === 'date' ? rgb('#c9b8a0') : WHITE, 1.4);
  const top = pts[steps];
  if (kind === 'coconut' && !cheap) {
    const nut = new SphereGeometry(0.14, 5, 4);
    const m = new Matrix4();
    for (let k = 0; k < 7; k++) {
      const a = rng.range(0, Math.PI * 2);
      m.makeTranslation(top.x + Math.cos(a) * 0.25, top.y - 0.35 - rng.range(0, 0.3), top.z + Math.sin(a) * 0.25);
      wood.add(nut, m, k % 3 ? rgb('#3d4a1c') : rgb('#6a5226'));
    }
  }
  const N = Math.ceil((kind === 'supari' ? 9 : kind === 'date' ? 22 : 15) * (cheap ? 0.5 : 1));
  for (let i = 0; i < N; i++) {
    const old = kind !== 'supari' && i % 7 === 0;
    leafStrip(leaves, {
      base: top,
      az: (i / N) * Math.PI * 2 + rng.range(-0.25, 0.25),
      elev:
        kind === 'date'
          ? rng.range(-0.2, 1.1)
          : kind === 'supari'
            ? rng.range(-0.4, 0.8)
            : old
              ? rng.range(-1.1, -0.6)
              : rng.range(-0.6, 0.7),
      len: kind === 'supari' ? rng.range(2.2, 2.8) : kind === 'date' ? rng.range(2.2, 3) : rng.range(3.6, 4.8),
      droop: kind === 'date' ? rng.range(0.05, 0.15) : rng.range(0.25, 0.5),
      halfWidth: kind === 'date' ? 0.42 : 0.72,
      profile: frondProfile,
      fold: 0.35,
      color: old ? rgb('#c9a86a') : scaleRgb(WHITE, rng.range(0.85, 1.1)),
    });
  }
  return { wood: wood.build(), leaves: leaves.build() };
}

function banana(rng: Rng): TreeParts {
  const wood = new MeshBuilder();
  const leaves = new MeshBuilder();
  const h = rng.range(1.5, 2.3);
  taperedTube(wood, [new Vector3(0, 0, 0), new Vector3(0, h * 0.6, 0), new Vector3(0, h, 0)], [0.14, 0.12, 0.09], 7, rgb('#6f7a3a'), 1);
  const top = new Vector3(0, h, 0);
  const n = rng.int(6, 8);
  for (let i = 0; i < n; i++) {
    const old = i < 2;
    leafStrip(leaves, {
      base: top.clone().add(new Vector3(0, -rng.range(0, 0.3), 0)),
      az: rng.range(0, Math.PI * 2),
      elev: old ? rng.range(-1.0, -0.5) : rng.range(0.35, 1.25),
      len: rng.range(1.7, 2.5),
      droop: old ? 0.2 : rng.range(0.3, 0.6),
      halfWidth: 0.34,
      profile: bananaProfile,
      fold: 0.2,
      color: old ? rgb('#b89a5a') : scaleRgb(WHITE, rng.range(0.85, 1.1)),
    });
  }
  return { wood: wood.build(), leaves: leaves.build() };
}

/** A clump of culms arching outward, leaves along their upper half. */
function bamboo(rng: Rng): TreeParts {
  const wood = new MeshBuilder();
  const leaves = new MeshBuilder();
  const n = rng.int(18, 26);
  const dir = new Vector3();
  for (let i = 0; i < n; i++) {
    const a = rng.range(0, Math.PI * 2);
    const base = new Vector3(Math.cos(a) * rng.range(0, 1.2), 0, Math.sin(a) * rng.range(0, 1.2));
    const out = new Vector3(Math.cos(a), 0, Math.sin(a));
    const h = rng.range(8.5, 13);
    const bend = rng.range(0.15, 0.5);
    const pts: Vector3[] = [];
    for (let k = 0; k <= 6; k++) {
      const t = k / 6;
      pts.push(base.clone().addScaledVector(out, Math.pow(t, 1.8) * h * bend).add(new Vector3(0, h * t * (1 - 0.15 * t * bend), 0)));
    }
    taperedTube(wood, pts, [0.06, 0.055, 0.05, 0.045, 0.04, 0.03, 0.02], 5, rgb('#8a9446'), 1);
    for (let k = 0; k < 7; k++) {
      const t = rng.range(0.45, 1);
      const idx = Math.min(5, Math.floor(t * 6));
      const p = pts[idx].clone().lerp(pts[idx + 1], t * 6 - idx);
      const nrm = out.clone().add(new Vector3(0, 0.5, 0)).normalize();
      const facing = nrm.clone().add(randomUnit(rng, dir).multiplyScalar(0.8)).normalize();
      const right = new Vector3().crossVectors(facing, UP).normalize().multiplyScalar(rng.range(0.6, 0.9));
      const up = new Vector3().crossVectors(right, facing).normalize().multiplyScalar(rng.range(0.6, 0.9));
      card(leaves, p, right, up, nrm, scaleRgb(WHITE, rng.range(0.75, 1.05)));
    }
  }
  return { wood: wood.build(), leaves: leaves.build() };
}

/** Joba (hibiscus) by the houses: a few stems, a rounded bush of glossy leaves, red flowers on its skin. */
function hibiscus(rng: Rng): TreeParts {
  const stems = new MeshBuilder();
  const leaves = new MeshBuilder();
  const h = rng.range(1.0, 1.6);
  const r = rng.range(0.55, 0.85);
  const center = new Vector3(0, h * 0.62, 0);
  for (let i = 0; i < 4; i++) {
    const a = rng.range(0, Math.PI * 2);
    const top = center.clone().add(new Vector3(Math.cos(a) * r * 0.5, rng.range(-0.1, 0.25), Math.sin(a) * r * 0.5));
    taperedTube(stems, [new Vector3(Math.cos(a) * 0.05, 0, Math.sin(a) * 0.05), top], [0.025, 0.012], 4, rgb('#5a4630'), 1);
  }
  const dir = new Vector3();
  for (let k = 0; k < 26; k++) {
    randomUnit(rng, dir);
    dir.y = Math.abs(dir.y) * 0.8 - 0.1;
    dir.normalize();
    const p = center.clone().addScaledVector(dir, r * Math.cbrt(rng.range(0.35, 1))).setY(center.y + dir.y * r * 0.75);
    const facing = dir.clone().add(randomUnit(rng, new Vector3()).multiplyScalar(0.6)).normalize();
    const right = new Vector3().crossVectors(facing, Math.abs(facing.y) < 0.95 ? UP : new Vector3(1, 0, 0)).normalize();
    const up = new Vector3().crossVectors(right, facing).normalize();
    const s = rng.range(0.32, 0.45);
    card(leaves, p, right.multiplyScalar(s), up.multiplyScalar(s), dir.clone().add(UP).normalize(), scaleRgb(WHITE, rng.range(0.8, 1.05)));
  }
  // flowers sit on the outside of the bush, facing out and up
  const red = rgb('#c4161c');
  const flowers = rng.int(16, 24);
  for (let k = 0; k < flowers; k++) {
    randomUnit(rng, dir);
    dir.y = Math.abs(dir.y) * 0.7;
    dir.normalize();
    const at = center.clone().addScaledVector(dir, r * 1.02).setY(center.y + dir.y * r * 0.8);
    const face = dir.clone().add(new Vector3(0, 0.5, 0)).normalize();
    const u = new Vector3().crossVectors(face, UP).normalize();
    const v = new Vector3().crossVectors(face, u).normalize();
    const c = stems.vertex(at, face, 0.5, 0.5, rgb('#7a0a10'));
    const rim = (ang: number, s: number) =>
      at.clone().addScaledVector(u, Math.cos(ang) * s).addScaledVector(v, Math.sin(ang) * s).addScaledVector(face, s * 0.25);
    for (let q = 0; q < 5; q++) {
      const a0 = (q / 5) * Math.PI * 2;
      const p0 = stems.vertex(rim(a0 - 0.55, 0.085), face, 0, 0, red);
      const p1 = stems.vertex(rim(a0, 0.11), face, 0, 0, scaleRgb(red, 1.15));
      const p2 = stems.vertex(rim(a0 + 0.55, 0.085), face, 0, 0, red);
      stems.tri(c, p0, p1);
      stems.tri(c, p1, p2);
    }
    // the long staminal column with its yellow tip
    taperedTube(stems, [at.clone(), at.clone().addScaledVector(face, 0.08)], [0.005, 0.004], 3, rgb('#f2c230'), 1);
  }
  return { wood: stems.build(), leaves: leaves.build() };
}

/** Upright cards rooted at the origin: kash plumes or grass blades. */
function tuft(rng: Rng, count: [number, number], height: [number, number], width: number, plumeWiden: number): BufferGeometry {
  const b = new MeshBuilder();
  const n = rng.int(count[0], count[1]);
  for (let i = 0; i < n; i++) {
    const base = new Vector3(rng.range(-0.35, 0.35), 0, rng.range(-0.35, 0.35));
    const h = rng.range(height[0], height[1]);
    const la = rng.range(0, Math.PI * 2);
    const lean = new Vector3(Math.cos(la), 0, Math.sin(la)).multiplyScalar(rng.range(0.1, 0.45) * h * 0.25);
    const yaw = rng.range(0, Math.PI);
    const right = new Vector3(Math.cos(yaw), 0, Math.sin(yaw)).multiplyScalar(width);
    const top = base.clone().add(new Vector3(0, h, 0)).add(lean);
    const nrm = new Vector3(-Math.sin(yaw) * 0.5, 1, Math.cos(yaw) * 0.5).normalize();
    const c = scaleRgb(WHITE, rng.range(0.85, 1.08));
    const s = b.vertexCount;
    b.vertex(base.clone().sub(right), nrm, 0, 0, c);
    b.vertex(base.clone().add(right), nrm, 1, 0, c);
    b.vertex(top.clone().addScaledVector(right, plumeWiden), nrm, 1, 1, c);
    b.vertex(top.clone().addScaledVector(right, -plumeWiden), nrm, 0, 1, c);
    b.quad(s, s + 1, s + 2, s + 3);
  }
  return b.build();
}

// ---------- placement ----------

/** The stretch of the channel the bank plantings run along, head to mouth. */
const BANKS = { z0: CHANNEL_SPAN.north, z1: CHANNEL_SPAN.south };
/** Kash stands only above this (m): beyond the spring tides' reach. */
const KASH_ABOVE = 1.9;

/** Whether the bank on `side` of the channel at `z` is in one of the stretches kash grows along (the film finds them too). */
export function kashStretch(z: number, side: 1 | -1): boolean {
  return fbm(z * 0.01, side * 9.3, 2, 62) >= 0.55;
}

interface Spot {
  x: number;
  z: number;
  r: number;
}

/** Where things already stand, in a spatial hash (thousands of trees are placed against it). */
class Occupancy {
  private static readonly CELL = 10;
  private readonly cells = new Map<number, Spot[]>();
  private widest = 0;
  private key(i: number, j: number): number {
    return (i + 4096) * 8192 + (j + 4096);
  }
  add(x: number, z: number, r: number): void {
    const k = this.key(Math.floor(x / Occupancy.CELL), Math.floor(z / Occupancy.CELL));
    let list = this.cells.get(k);
    if (!list) this.cells.set(k, (list = []));
    list.push({ x, z, r });
    this.widest = Math.max(this.widest, r);
  }
  free(x: number, z: number, r: number): boolean {
    const reach = Math.ceil((r + this.widest) / Occupancy.CELL);
    const ci = Math.floor(x / Occupancy.CELL);
    const cj = Math.floor(z / Occupancy.CELL);
    for (let i = ci - reach; i <= ci + reach; i++) {
      for (let j = cj - reach; j <= cj + reach; j++) {
        const list = this.cells.get(this.key(i, j));
        if (!list) continue;
        for (const s of list) if (Math.hypot(s.x - x, s.z - z) < s.r + r) return false;
      }
    }
    return true;
  }
}

/** A tree set by hand: which kind, where, its yaw and scale. */
export interface FeaturedTree {
  kind: 'mango' | 'rain' | 'coconut' | 'supari' | 'date' | 'banana' | 'bamboo';
  x: number;
  z: number;
  ry: number;
  s: number;
}

function onDryLand(x: number, z: number, minInland: number): boolean {
  const info = bankInfo(x, z);
  if (info.inland < minInland) return false;
  for (const p of PONDS) if (Math.hypot(x - p.x, z - p.z) < p.r * 1.35) return false;
  for (const w of WETLANDS) if (Math.hypot(x - w.x, z - w.z) < w.r * 1.5) return false;
  // nothing grows on the salt pans, nor (but the mangroves and casuarinas, set apart) at the sea's edge
  if (saltPan(x, z) > 0.2) return false;
  if (sandCover(x, z) > 0.4) return false;
  const h = terrainHeight(x, z);
  if (h < 0.3 || mangroveZone(x, z, h) > 0.3 || onLandmark(x, z, 3) || onTempleHill(x, z) || onRoad(x, z, 1.5)) return false;
  return !nearBackwater(x, z, 3);
}

function at(x: number, z: number, rng: Rng, s: number, sink = 0.15): Placement {
  return { x, y: terrainHeight(x, z) - sink, z, ry: rng.range(0, Math.PI * 2), s };
}

// ---------- assembly ----------

/** `bark`: the photo bark for broadleaf trunks; without it they keep a painted brown. */
/** `clear`: other places to keep trees off (x, z and a radius), such as the fishermen's platforms. */
/** `featured`: trees set by hand where a scene wants them (round the old bridge), placed whatever the rest do. */
export function buildVegetation(
  huts: readonly HutPlan[],
  bark: Surfaces['bark'],
  clear: readonly { x: number; z: number; r: number }[] = [],
  featured: readonly FeaturedTree[] = [],
): Group {
  const rng = new Rng(7);
  const group = new Group();
  group.name = 'vegetation';
  const occ = new Occupancy();
  for (const h of huts) occ.add(h.x, h.z, Math.max(h.w, h.l) * 0.75 + 1.5);
  for (const c of clear) occ.add(c.x, c.z, c.r);

  const tex = {
    mango: leafClusterTexture(11, ['#2a4319', '#35521f', '#426026', '#4f6e2b', '#5f7d31'], { count: 150, len: [0.08, 0.14], width: 0.4 }),
    rain: leafClusterTexture(12, ['#33501c', '#3f5f22', '#4e7029', '#5d7f2f', '#6c8a36'], { count: 210, len: [0.045, 0.085], width: 0.5 }),
    bamboo: leafClusterTexture(13, ['#4e6a24', '#5f7d2b', '#6f8c33', '#7f983c'], { count: 70, len: [0.18, 0.3], width: 0.16 }),
    hibiscus: leafClusterTexture(19, ['#1d3812', '#264818', '#30571d', '#3b6624'], { count: 80, len: [0.12, 0.18], width: 0.6 }),
    frond: palmFrondTexture(14),
    banana: bananaLeafTexture(15),
    kash: kashTexture(16),
    grass: grassTexture(17),
    bark: palmBarkTexture(18),
    // the mangroves' small, leathery leaves, greyed with salt; the casuarina's needles
    mangrove: leafClusterTexture(20, ['#4a6338', '#566f42', '#62794a', '#6e8454', '#7b8f5e'], { count: 190, len: [0.05, 0.09], width: 0.45 }),
    needles: needleTexture(21),
    // akashmoni's narrow, sickle-shaped phyllodes, a dull olive green
    akashmoni: leafClusterTexture(22, ['#46552a', '#526131', '#5f6e38', '#6c7a40', '#7a8648'], { count: 170, len: [0.1, 0.17], width: 0.22 }),
  };

  const leafMat = (set: { map: Texture; normal?: Texture }, wind = 0.22, windHeight = 10, roughness = 0.78, seasonal: 'leaf' | 'tree' = 'leaf') =>
    patchMaterial(
      new MeshStandardMaterial({
        map: set.map,
        normalMap: set.normal ?? null,
        normalScale: new Vector2(0.9, 0.9),
        vertexColors: true,
        alphaTest: 0.42,
        alphaToCoverage: true,
        side: DoubleSide,
        roughness,
      }),
      { wind, windHeight, translucency: 1, foliage: true, seasonal },
    );
  // trunks, stems and culms bend with the same wind as the leaves they carry, so a crown never leaves its tree
  const woodMat = patchMaterial(
    new MeshStandardMaterial({ map: bark?.color ?? null, normalMap: bark?.normal ?? null, vertexColors: true, roughness: 0.92 }),
    { grime: bark ? 0.2 : 0.5, wind: 0.3, windHeight: 6 },
  );
  const culmMat = patchMaterial(new MeshStandardMaterial({ vertexColors: true, roughness: 0.6 }), { grime: 0.4, wind: 0.45, windHeight: 12 });
  const flowerMat = patchMaterial(new MeshStandardMaterial({ vertexColors: true, roughness: 0.6, side: DoubleSide }), {
    translucency: 1.2,
    wind: 0.05,
    windHeight: 1.5,
  });
  // the photo bark brings its own colour; tint it toward the dark grey of mango bark
  const barkTint = bark ? rgb('#b4aa9c') : BARK;
  const palmWood = patchMaterial(new MeshStandardMaterial({ map: tex.bark, vertexColors: true, roughness: 0.9 }), {
    grime: 0.3,
    wind: 0.2,
    windHeight: 12,
  });
  const mats = {
    // crowns move a hand's breadth in a breeze and a good half metre in a storm (see the wind in patch.ts)
    mango: leafMat(tex.mango, 0.3, 6, 0.78, 'tree'),
    rain: leafMat(tex.rain, 0.3, 6, 0.78, 'tree'),
    bamboo: leafMat(tex.bamboo, 0.45, 12),
    frond: leafMat({ map: tex.frond }, 0.2, 12),
    banana: leafMat({ map: tex.banana }, 0.12, 3),
    hibiscus: leafMat(tex.hibiscus, 0.06, 1.5, 0.5),
    kash: patchMaterial(
      new MeshStandardMaterial({ map: tex.kash, vertexColors: true, alphaTest: 0.42, alphaToCoverage: true, side: DoubleSide, roughness: 0.85 }),
      { wind: 0.35, windHeight: 2.2, translucency: 2.2, foliage: true, seasonal: 'kash' },
    ),
    grass: leafMat({ map: tex.grass }, 0.15, 0.8),
    mangrove: leafMat(tex.mangrove, 0.22, 5),
    needles: leafMat({ map: tex.needles }, 0.4, 14),
    akashmoni: leafMat(tex.akashmoni, 0.3, 6, 0.8, 'tree'),
  };

  // a shape or two per species (each is a draw call in every slab it stands in); instances vary them by yaw and scale
  const variants = <T>(n: number, make: (r: Rng) => T): T[] => Array.from({ length: n }, (_, i) => make(new Rng(100 + i * 31)));
  const mango = variants(2, (r) =>
    broadleaf(r, { height: r.range(2.6, 3.6), trunkR: 0.3, crown: r.range(3.6, 4.6), flat: 0.85, lobes: 6, cards: 125, cardSize: 1.1, tint: WHITE, bark: barkTint }),
  );
  const rainTree = variants(2, (r) =>
    broadleaf(r, { height: r.range(4.5, 5.5), trunkR: 0.42, crown: r.range(6, 7.5), flat: 0.45, lobes: 8, cards: 190, cardSize: 1.35, tint: rgb('#e8f0d8'), bark: barkTint }),
  );
  const farTree = variants(1, (r) =>
    broadleaf(r, { height: 4, trunkR: 0.4, crown: 5.5, flat: 0.75, lobes: 4, cards: 34, cardSize: 2.6, tint: rgb('#c8d0b8'), bark: barkTint, simple: true }),
  );
  const joba = variants(2, hibiscus);
  // the hills' forest crowns: few, large cards, so a slope seen edge-on is not dozens of layers of leaves deep
  const hillTree = variants(1, (r) =>
    broadleaf(r, { height: r.range(3.5, 5), trunkR: 0.35, crown: r.range(5, 6.5), flat: 0.75, lobes: 4, cards: 16, cardSize: 3.6, tint: rgb('#c4ccb4'), bark: barkTint, simple: true }),
  );
  // keora: slender, its crown loose and drooping; baen: low and spreading, dense to the mud
  const keora = variants(1, (r) =>
    broadleaf(r, { height: r.range(4.2, 6), trunkR: 0.22, crown: r.range(2.8, 3.5), flat: 1.25, lobes: 5, cards: 70, cardSize: 1.0, tint: rgb('#d8e2cc'), bark: barkTint, simple: true }),
  );
  const baen = variants(1, (r) =>
    broadleaf(r, { height: r.range(1.2, 1.8), trunkR: 0.17, crown: r.range(2.3, 3.0), flat: 0.72, lobes: 5, cards: 62, cardSize: 0.95, tint: rgb('#c8d4b6'), bark: barkTint, simple: true }),
  );
  // casuarina (jhau), planted in belts behind the beaches: tall, its feathery crown a narrow spire
  // akashmoni (Acacia auriculiformis), among the commonest trees of Moheshkhali's homesteads and planted over its
  // hills (GEOGRAPHY_PLAN.md §8.1–8.2): an upright trunk, a dense rounded crown
  const akashmoni = variants(2, (r) =>
    broadleaf(r, { height: r.range(3.5, 5), trunkR: 0.24, crown: r.range(3.2, 4.2), flat: 1.0, lobes: 6, cards: 90, cardSize: 1.0, tint: rgb('#d4dcc0'), bark: barkTint }),
  );
  const jhau = variants(1, (r) =>
    broadleaf(r, { height: r.range(6.5, 9), trunkR: 0.2, crown: r.range(1.9, 2.4), flat: 2.1, lobes: 6, cards: 72, cardSize: 1.3, tint: WHITE, bark: barkTint }),
  );
  const coconut = variants(1, (r) => palm(r, 'coconut'));
  const supari = variants(1, (r) => palm(r, 'supari'));
  const date = variants(1, (r) => palm(r, 'date'));
  // the same palms, cheap, for those far inland
  const coconutFar = variants(1, (r) => palm(r, 'coconut', true));
  const supariFar = variants(1, (r) => palm(r, 'supari', true));
  const dateFar = variants(1, (r) => palm(r, 'date', true));
  const bananas = variants(1, banana);
  const bamboos = variants(1, bamboo);
  const kash = variants(3, (r) => tuft(r, [8, 13], [1.5, 2.5], 0.17, 1.6));
  const grass = variants(3, (r) => tuft(r, [7, 10], [0.4, 0.8], 0.24, 1.2));

  type Bucket = { parts: TreeParts[]; wood: MeshStandardMaterial; leaves: MeshStandardMaterial; items: Placement[][] };
  const bucket = (parts: TreeParts[], leaves: MeshStandardMaterial, wood = woodMat): Bucket => ({
    parts,
    wood,
    leaves,
    items: parts.map(() => []),
  });
  const B = {
    mango: bucket(mango, mats.mango),
    rain: bucket(rainTree, mats.rain),
    far: bucket(farTree, mats.mango),
    coconut: bucket(coconut, mats.frond, palmWood),
    supari: bucket(supari, mats.frond, palmWood),
    date: bucket(date, mats.frond, palmWood),
    coconutFar: bucket(coconutFar, mats.frond, palmWood),
    supariFar: bucket(supariFar, mats.frond, palmWood),
    dateFar: bucket(dateFar, mats.frond, palmWood),
    banana: bucket(bananas, mats.banana),
    bamboo: bucket(bamboos, mats.bamboo, culmMat),
    joba: bucket(joba, mats.hibiscus, flowerMat),
    hill: bucket(hillTree, mats.mango),
    keora: bucket(keora, mats.mangrove),
    baen: bucket(baen, mats.mangrove),
    jhau: bucket(jhau, mats.needles),
    akashmoni: bucket(akashmoni, mats.akashmoni),
  };
  const put = (b: Bucket, p: Placement) => b.items[rng.int(0, b.items.length - 1)].push(p);
  for (const f of featured) put(B[f.kind], { x: f.x, y: terrainHeight(f.x, f.z) - 0.15, z: f.z, ry: f.ry, s: f.s });

  // the houses' joba bushes by the villages on the channel: one or two beside a hut, by the door or the yard
  VILLAGES.forEach((v, i) => {
    const c = VILLAGE_CENTERS[i];
    for (const h of huts) {
      if (Math.hypot(h.x - c.x, h.z - c.z) > v.radius * 1.3 || rng.next() < 0.45) continue;
      const a = rng.range(0, Math.PI * 2);
      const d = Math.max(h.l, h.w) * 0.5 + rng.range(1.2, 2.4);
      const x = h.x + Math.cos(a) * d;
      const z = h.z + Math.sin(a) * d;
      // clear of every hut's walls (the huts' own clearance rings are meant for trees, not bushes)
      if (!onDryLand(x, z, 3) || huts.some((o) => Math.abs(o.x - x) < 12 && Math.hypot(o.x - x, o.z - z) < Math.max(o.l, o.w) * 0.5 + 0.8)) continue;
      put(B.joba, at(x, z, rng, rng.range(0.85, 1.2), 0.05));
    }
  });

  // round the bil: groves standing back from its marshy rim, and hijol trees out in its shallows
  for (let k = 0; k < 260; k++) {
    const a = rng.range(0, Math.PI * 2);
    const e = rng.range(1.5, 1.9);
    const z = BIL.z + Math.cos(a) * BIL.halfLen * e;
    const x = riverX(z) + BIL.u + Math.sin(a) * BIL.halfWid * e;
    if (fbm(z * 0.01, x * 0.01, 2, 23) < 0.42 || !onDryLand(x, z, 20) || !occ.free(x, z, 3.5)) continue;
    occ.add(x, z, 3.5);
    const r = rng.next();
    put(r < 0.4 ? B.mango : r < 0.6 ? B.rain : r < 0.85 ? B.date : B.coconut, at(x, z, rng, rng.range(0.85, 1.2)));
  }
  for (let k = 0, placed = 0; k < 400 && placed < 9; k++) {
    const z = BIL.z + rng.range(-1, 1) * BIL.halfLen;
    const u = BIL.u + rng.range(-1.2, 1.2) * BIL.halfWid;
    const e = bilReach(z, u);
    const depth = bilDepth(z, u);
    const x = riverX(z) + u;
    if (e < 0.88 || e > 0.98 || depth < 0.1 || depth > 0.45 || routeGap(x, z) < 15 || !occ.free(x, z, 6)) continue;
    occ.add(x, z, 6);
    // their trunks stand in the water
    put(B.mango, at(x, z, rng, rng.range(0.7, 0.95), 0.05));
    placed++;
  }

  // Trees where the satellites see them (Meta/WRI canopy heights, 30 m cells on the ground), cell by cell: on
  // the 1:3 map one tree to a 10 m cell of full cover, so about a ninth of the real ones as the land is a ninth
  // (GEOGRAPHY_PLAN.md §5.1), each as tall as the canopy there. What grows depends on where [মডেল: the canopy
  // map has no species]: round the houses the homestead's mango and jackfruit, coconut and supari, banana and
  // bamboo; keora and baen in the mangrove forest; the hills' forest on high ground; rain trees, mango and date
  // palms along the fields and roads.
  const home = new Set<number>();
  const HOME = 30;
  const homeKey = (i: number, j: number) => (i + 4096) * 8192 + (j + 4096);
  for (const h of huts) home.add(homeKey(Math.floor(h.x / HOME), Math.floor(h.z / HOME)));
  const nearHome = (x: number, z: number) => {
    const i = Math.floor(x / HOME);
    const j = Math.floor(z / HOME);
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) if (home.has(homeKey(i + a, j + b))) return true;
    return false;
  };
  /** Each kind's height at scale 1 (m), to size it to the canopy's. */
  const NOMINAL = new Map<Bucket, number>([
    [B.coconutFar, 12],
    [B.supariFar, 10],
    [B.dateFar, 7],
    [B.mango, 8],
    [B.rain, 11],
    [B.far, 9],
    [B.hill, 9],
    [B.coconut, 12],
    [B.supari, 10],
    [B.date, 7],
    [B.banana, 3.5],
    [B.bamboo, 10],
    [B.akashmoni, 10],
    [B.keora, 7],
    [B.baen, 3.5],
  ]);
  const hash = (i: number, k: number) => ((Math.imul(i ^ (k * 0x9e3779b1), 0x45d9f3b) >>> 0) % 100000) / 100000;
  for (let i = 0; i < GRID_W * GRID_H; i++) {
    const cover = LAYERS.canopy[i * 2 + 1] / 255;
    if (cover < 0.15 || hash(i, 1) > cover) continue;
    const kind = LAYERS.kind[i] & 0x7f;
    const covered = LAYERS.cover[i];
    const mangrove = kind === KIND.mangrove || covered === COVER.mangrove;
    if ((kind !== KIND.land && !mangrove) || covered === COVER.saltpan) continue;
    const c = cellCentre(i % GRID_W, Math.floor(i / GRID_W));
    const x = c.x + (hash(i, 2) - 0.5) * 8;
    const z = c.z + (hash(i, 3) - 0.5) * 8;
    if (inlandWaterAt(x, z) || onRoad(x, z, 1.5) || onLandmark(x, z, 3) || onTempleHill(x, z) || onBridge(x, z, 1) || !occ.free(x, z, 1.2)) continue;
    const h = terrainHeight(x, z);
    if (!mangrove && h < 0.3) continue;
    const r = hash(i, 4);
    // the trees the channel looks at are drawn in full; those farther inland are cheap crowns that read the
    // same at a distance (the palms are cheap anyway)
    const seen = bankInfo(x, z).inland < 500;
    const home = nearHome(x, z);
    let tree: Bucket;
    // the mangroves: fewer than the cells, as the forest's crowns crowd into one another
    if (mangrove) {
      if (hash(i, 9) > 0.6) continue;
      tree = h < 0.4 ? B.baen : r < 0.5 ? B.keora : B.baen;
    }
    // (the homestead's mix as Baul et al. 2021 found it here: mango, akashmoni and coconut the commonest)
    else if (home && seen) tree = r < 0.24 ? B.mango : r < 0.38 ? B.akashmoni : r < 0.52 ? B.coconut : r < 0.66 ? B.supari : r < 0.75 ? B.banana : r < 0.82 ? B.bamboo : r < 0.9 ? B.rain : B.date;
    else if (home) {
      if (hash(i, 10) > 0.7) continue;
      tree = r < 0.45 ? B.far : r < 0.65 ? B.supariFar : r < 0.8 ? B.coconutFar : r < 0.9 ? B.banana : B.dateFar;
    }
    // the hills' forest: big, cheap crowns, a quarter as many as the cells (scaled up below to close the canopy)
    else if (h > 8) {
      if (hash(i, 8) > 0.25) continue;
      // (planted akashmoni on the slopes the channel sees)
      tree = seen && r < 0.06 ? B.rain : seen && r < 0.1 ? B.mango : seen && r < 0.25 ? B.akashmoni : B.hill;
    }
    // the lone trees along the fields and roads: fewer of them stand out of the fields than the canopy's cells
    else if (hash(i, 7) > 0.4) continue;
    else if (seen) tree = r < 0.35 ? B.far : r < 0.5 ? B.rain : r < 0.7 ? B.mango : r < 0.8 ? B.akashmoni : r < 0.93 ? B.date : B.coconut;
    else tree = r < 0.75 ? B.far : r < 0.9 ? B.dateFar : B.coconutFar;
    const canopyHeight = Math.max(3, LAYERS.canopy[i * 2]);
    const s = Math.min(1.5, Math.max(0.6, canopyHeight / (NOMINAL.get(tree) ?? 8))) * (0.9 + 0.2 * hash(i, 5)) * (tree === B.hill ? 1.4 : 1);
    put(tree, { x, y: h - (mangrove ? 0.1 : 0.2), z, ry: hash(i, 6) * Math.PI * 2, s });
  }

  // casuarina belts on the sand above the spring tides' reach (the beaches' backs and dunes on the island,
  // Sonadia and the Cox's Bazar shore), cell by cell where the map has sand
  const jhauAt = (x: number, z: number) => {
    const h = terrainHeight(x, z);
    if (h < 2.2 || saltPan(x, z) > 0.2 || onLandmark(x, z, 3) || onRoad(x, z, 1.5) || !occ.free(x, z, 2.2)) return;
    occ.add(x, z, 2.2);
    put(B.jhau, { x, y: h - 0.15, z, ry: rng.range(0, Math.PI * 2), s: rng.range(0.85, 1.2) });
  };
  for (let i = 0; i < GRID_W * GRID_H; i++) {
    if (LAYERS.cover[i] !== COVER.sand || rng.next() > 0.3) continue;
    const c = cellCentre(i % GRID_W, Math.floor(i / GRID_W));
    jhauAt(c.x + rng.range(-4, 4), c.z + rng.range(-4, 4));
  }

  // the two ways up to Adinath temple (D9): the Dighi Road from the town, and the roads from the Adinath jetty;
  // trees close along both sides wherever the canopy map has trees beside them (the homestead's and the hills'
  // kinds), so the way runs under them. The jetties' own approaches (the long road up from the Adinath jetty
  // toward Mainak hill, and the way into the town from Gorakghata's) are green on both sides all along: a
  // roadside row each side, as Bangladesh's roads are planted, the canopy map's gaps or not.
  const temple = place('adinath-temple').world;
  const landing = place('adinath-jetty-land').world;
  const gorakLanding = place('gorakghata-jetty-land').world;
  const APPROACH = [
    { at: landing, reach: 700 },
    { at: gorakLanding, reach: 400 },
  ];
  for (const l of LINES) {
    if (l.k !== 'road') continue;
    const p = l.points;
    let near = l.n === 'Dhighi Road';
    for (let k = 0; k < p.length && !near; k += 2)
      near = Math.hypot(p[k] - temple.x, p[k + 1] - temple.z) < 70 || APPROACH.some((a) => Math.hypot(p[k] - a.at.x, p[k + 1] - a.at.z) < 70);
    if (!near) continue;
    for (let k = 0; k + 3 < p.length; k += 2) {
      const len = Math.hypot(p[k + 2] - p[k], p[k + 3] - p[k + 1]);
      if (len < 1e-3) continue;
      for (let d = 0; d < len; d += rng.range(5, 8)) {
        const t = d / len;
        const cx = p[k] + (p[k + 2] - p[k]) * t;
        const cz = p[k + 1] + (p[k + 3] - p[k + 1]) * t;
        const approach = APPROACH.some((a) => Math.hypot(cx - a.at.x, cz - a.at.z) < a.reach);
        for (const side of approach ? [-1, 1] : [rng.sign()]) {
          const off = rng.range(3.5, 6.5);
          const x = cx + ((p[k + 3] - p[k + 1]) / len) * side * off;
          const z = cz - ((p[k + 2] - p[k]) / len) * side * off;
          if ((!approach && canopyAt(x, z).cover < 0.05) || !onDryLand(x, z, 3) || !occ.free(x, z, 2.5)) continue;
          occ.add(x, z, 2.5);
          const r = rng.next();
          put(r < 0.3 ? B.akashmoni : r < 0.55 ? B.mango : r < 0.7 ? B.coconut : r < 0.85 ? B.rain : r < 0.95 ? B.supari : B.date, at(x, z, rng, rng.range(0.9, 1.2)));
        }
      }
    }
  }

  // the mangroves the jetties cross: keora and baen on the tidal mud both sides of Gorakghata's pair and of the
  // Adinath jetty, from near the shore most of the way out; the last stretch to each head stays open water for
  // the boats, and the jetties' own line stays clear (onLandmark)
  const g = GORAKGHATA;
  for (const j of [
    { ...g.jetty, clear: g.jetty.width + g.newJetty.offset + g.newJetty.width / 2 + 3 },
    { ...g.adinathJetty, clear: g.adinathJetty.width + 3 },
  ]) {
    const ux = (j.toX - j.x) / j.length;
    const uz = (j.toZ - j.z) / j.length;
    for (let d = j.length * 0.06; d < j.length * 0.82; d += rng.range(3.5, 5.5)) {
      for (const side of [-1, 1]) {
        for (let k = 0; k < 3; k++) {
          const off = j.clear + rng.range(0, 48) * (k === 0 ? 0.35 : 1);
          const x = j.x + ux * d - uz * side * off + rng.range(-1.5, 1.5);
          const z = j.z + uz * d + ux * side * off + rng.range(-1.5, 1.5);
          const h = terrainHeight(x, z);
          // on the mud between mean sea level's reach and the spring tides' (≈ −1 m to +2.6 m), the sea's ground
          const kind = kindAt(x, z);
          if (h < -1 || h > 2.6 || (kind !== KIND.tidal && kind !== KIND.mangrove) || onLandmark(x, z, 2) || !occ.free(x, z, 2.2)) continue;
          // in clumps, as they colonise the mud
          if (fbm(x * 0.03, z * 0.03, 2, 77) < 0.38) continue;
          occ.add(x, z, 2.2);
          put(rng.next() < 0.65 ? B.keora : B.baen, { x, y: h - 0.1, z, ry: rng.range(0, Math.PI * 2), s: rng.range(0.8, 1.25) });
        }
      }
    }
  }

  // the trees by the water and on the hills show in the water's mirror; those far inland on the plain are left
  // out of it (from any water they stand behind the banks' own trees)
  const mirrored = (p: Placement) => p.y > 8 || bankInfo(p.x, p.z).inland < 600;
  for (const [name, b] of Object.entries(B)) {
    b.parts.forEach((parts, i) => {
      const items = b.items[i];
      for (const [list, layer] of [
        [items.filter(mirrored), undefined],
        [items.filter((p) => !mirrored(p)), LAYER_NO_REFLECT],
      ] as const) {
        if (!list.length) continue;
        // in slabs 900 m along z, so fewer stand in view
        const wood = instanced(parts.wood, b.wood, list, { cast: true, chunk: 900, layer });
        const leaves = instanced(parts.leaves, b.leaves, list, { cast: true, chunk: 900, layer });
        wood.name = `${name}-wood`;
        leaves.name = `${name}-leaves`;
        group.add(wood, leaves);
      }
    });
  }

  // kash in stretches along the bank's top, on the real shore just above the spring tides' reach (≈1.8 m), where
  // the bank stays dry; not on the roads, the salt pans or the landmarks
  const kashItems: Placement[][] = kash.map(() => []);
  for (const side of [-1, 1] as const) {
    for (let z = BANKS.z0; z > BANKS.z1; z -= 2.8) {
      if (!kashStretch(z, side)) continue;
      const bank = bankAt(z, side, KASH_ABOVE);
      if (!bank || bank.d <= 0) continue;
      const ux = (bank.x - riverX(z)) / bank.d;
      const uz = (bank.z - z) / bank.d;
      for (let k = 0; k < 4; k++) {
        const d = rng.range(0.5, 12);
        const jitter = rng.range(-1.4, 1.4);
        const x = bank.x + ux * d - uz * jitter;
        const zz = bank.z + uz * d + ux * jitter;
        const h = terrainHeight(x, zz);
        if (h < KASH_ABOVE || h > 3.5 || !onDryLand(x, zz, 0)) continue;
        kashItems[rng.int(0, kash.length - 1)].push({ x, y: h - 0.05, z: zz, ry: rng.range(0, Math.PI * 2), s: rng.range(0.75, 1.1) });
      }
    }
  }
  kash.forEach((g, i) => kashItems[i].length && group.add(instanced(g, mats.kash, kashItems[i], { receive: true })));

  // grass tufts on the bank tops and round the villages
  const grassItems: Placement[][] = grass.map(() => []);
  for (const side of [-1, 1] as const) {
    for (let z = BANKS.z0; z > BANKS.z1; z -= 1.1) {
      // thickest along the lip of the bank, where it shows from the river
      for (const inland of [rng.range(0.5, 4), rng.range(2, 18)]) {
        const x = riverX(z) + side * (edgeHalfWidth(z, side) + 3 + inland);
        if (!onDryLand(x, z, 0) || rng.next() < 0.3) continue;
        grassItems[rng.int(0, grass.length - 1)].push(at(x, z, rng, rng.range(0.8, 1.35), 0.05));
      }
    }
  }
  grass.forEach(
    (g, i) => grassItems[i].length && group.add(instanced(g, mats.grass, grassItems[i], { layer: LAYER_NO_REFLECT, receive: true })),
  );

  return group;
}
