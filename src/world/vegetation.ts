import { BufferGeometry, DoubleSide, Group, Matrix4, Mesh, MeshStandardMaterial, SphereGeometry, Vector2, Vector3 } from 'three';
import type { Texture } from 'three';
import { LAYER_NO_REFLECT } from '../core/globals';
import { smoothstep } from '../core/mathx';
import { fbm, valueNoise } from '../core/noise';
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
  palmFrondTexture,
} from '../render/textures';
import {
  BIL,
  CHARS,
  KHALS,
  PONDS,
  VILLAGES,
  VILLAGE_CENTERS,
  WORLD_Z0,
  WORLD_Z1,
  bankInfo,
  bilDepth,
  bilReach,
  charHeight,
  edgeHalfWidth,
  khalPoint,
  landLevel,
  nearBackwater,
  riverX,
  routeGap,
  terrainHeight,
  villageDistance,
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
  for (let i = 0; i <= 5; i++) {
    const t = i / 5;
    pts.push(new Vector3(lean.x * t * t, o.height * t, lean.z * t * t));
    radii.push(o.trunkR * (1 - 0.45 * t) * (i === 0 ? 1.3 : 1));
  }
  taperedTube(wood, pts, radii, 7, o.bark, 2);
  const top = pts[5];
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
  for (const l of lobes) {
    const mid = top.clone().lerp(l.c, 0.55);
    mid.y += 0.3;
    taperedTube(wood, [top.clone(), mid, l.c.clone().lerp(mid, 0.35)], [radii[5] * 0.75, radii[5] * 0.45, 0.05], 5, o.bark, 2);
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

function palm(rng: Rng, kind: PalmKind): TreeParts {
  const wood = new MeshBuilder();
  const leaves = new MeshBuilder();
  const H = kind === 'supari' ? rng.range(12, 16) : kind === 'date' ? rng.range(5, 8) : rng.range(8.5, 12.5);
  const R = kind === 'supari' ? 0.12 : kind === 'date' ? 0.3 : 0.22;
  const leanAz = rng.range(0, Math.PI * 2);
  const lean = kind === 'coconut' ? rng.range(0.8, 2.8) : rng.range(0.1, 0.6);
  const pts: Vector3[] = [];
  const radii: number[] = [];
  for (let i = 0; i <= 10; i++) {
    const t = i / 10;
    pts.push(new Vector3(Math.cos(leanAz) * lean * Math.pow(t, 1.6), H * t, Math.sin(leanAz) * lean * Math.pow(t, 1.6)));
    radii.push(R * (1 - 0.3 * t) * (i === 0 ? 1.35 : 1));
  }
  taperedTube(wood, pts, radii, 8, kind === 'date' ? rgb('#c9b8a0') : WHITE, 1.4);
  const top = pts[10];
  if (kind === 'coconut') {
    const nut = new SphereGeometry(0.14, 5, 4);
    const m = new Matrix4();
    for (let k = 0; k < 7; k++) {
      const a = rng.range(0, Math.PI * 2);
      m.makeTranslation(top.x + Math.cos(a) * 0.25, top.y - 0.35 - rng.range(0, 0.3), top.z + Math.sin(a) * 0.25);
      wood.add(nut, m, k % 3 ? rgb('#3d4a1c') : rgb('#6a5226'));
    }
  }
  const N = kind === 'supari' ? 9 : kind === 'date' ? 22 : 15;
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

/** The far tree line on the horizon: a strip whose top edge is the bumpy silhouette of village groves. */
function treeLine(side: 1 | -1, offset: number, seed: number): BufferGeometry {
  const b = new MeshBuilder();
  const n = new Vector3();
  let prev = -1;
  for (let z = WORLD_Z0 + 200; z >= WORLD_Z1 - 400; z -= 8) {
    const x = riverX(z) + side * (edgeHalfWidth(z, side) + offset);
    const h = 7 + 9 * fbm(z * 0.012, seed, 3, seed) + 4 * valueNoise(z * 0.12, seed * 3.1, seed);
    n.set(-side, 0.7, 0).normalize();
    const lo = b.vertex(new Vector3(x, 0.5, z), n, 0, 0, rgb('#12180a'));
    b.vertex(new Vector3(x, landLevel(x, z) + h, z), n, 0, 1, rgb('#2c3a16'));
    if (prev >= 0) b.quad(prev, lo, lo + 1, prev + 1);
    prev = lo;
  }
  return b.build();
}

// ---------- placement ----------

interface Spot {
  x: number;
  z: number;
  r: number;
}

class Occupancy {
  private readonly spots: Spot[] = [];
  add(x: number, z: number, r: number): void {
    this.spots.push({ x, z, r });
  }
  free(x: number, z: number, r: number): boolean {
    for (const s of this.spots) if (Math.abs(s.z - z) < s.r + r && Math.hypot(s.x - x, s.z - z) < s.r + r) return false;
    return true;
  }
}

function onDryLand(x: number, z: number, minInland: number): boolean {
  const info = bankInfo(x, z);
  if (info.inland < minInland) return false;
  for (const p of PONDS) if (Math.hypot(x - p.x, z - p.z) < p.r * 1.35) return false;
  return !nearBackwater(x, z, 3);
}

function at(x: number, z: number, rng: Rng, s: number, sink = 0.15): Placement {
  return { x, y: terrainHeight(x, z) - sink, z, ry: rng.range(0, Math.PI * 2), s };
}

// ---------- assembly ----------

/** `bark`: the photo bark for broadleaf trunks; without it they keep a painted brown. */
export function buildVegetation(huts: readonly HutPlan[], bark: Surfaces['bark']): Group {
  const rng = new Rng(7);
  const group = new Group();
  group.name = 'vegetation';
  const occ = new Occupancy();
  for (const h of huts) occ.add(h.x, h.z, Math.max(h.w, h.l) * 0.75 + 1.5);

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
  };

  const leafMat = (set: { map: Texture; normal?: Texture }, wind = 0.22, windHeight = 10, roughness = 0.78) =>
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
      { wind, windHeight, translucency: 1, foliage: true },
    );
  const woodMat = patchMaterial(
    new MeshStandardMaterial({ map: bark?.color ?? null, normalMap: bark?.normal ?? null, vertexColors: true, roughness: 0.92 }),
    { grime: bark ? 0.2 : 0.5 },
  );
  const culmMat = patchMaterial(new MeshStandardMaterial({ vertexColors: true, roughness: 0.6 }), { grime: 0.4 });
  const flowerMat = patchMaterial(new MeshStandardMaterial({ vertexColors: true, roughness: 0.6, side: DoubleSide }), {
    translucency: 1.2,
    wind: 0.05,
    windHeight: 1.5,
  });
  // the photo bark brings its own colour; tint it toward the dark grey of mango bark
  const barkTint = bark ? rgb('#b4aa9c') : BARK;
  const palmWood = patchMaterial(new MeshStandardMaterial({ map: tex.bark, vertexColors: true, roughness: 0.9 }), {
    grime: 0.3,
    wind: 0.14,
    windHeight: 14,
  });
  const mats = {
    mango: leafMat(tex.mango),
    rain: leafMat(tex.rain),
    bamboo: leafMat(tex.bamboo, 0.45, 12),
    frond: leafMat({ map: tex.frond }, 0.14, 14),
    banana: leafMat({ map: tex.banana }, 0.12, 3),
    hibiscus: leafMat(tex.hibiscus, 0.06, 1.5, 0.5),
    kash: patchMaterial(
      new MeshStandardMaterial({ map: tex.kash, vertexColors: true, alphaTest: 0.42, alphaToCoverage: true, side: DoubleSide, roughness: 0.85 }),
      { wind: 0.35, windHeight: 2.2, translucency: 2.2, foliage: true },
    ),
    grass: leafMat({ map: tex.grass }, 0.15, 0.8),
  };

  // a few shapes per species; instances vary them further by yaw and scale
  const variants = <T>(n: number, make: (r: Rng) => T): T[] => Array.from({ length: n }, (_, i) => make(new Rng(100 + i * 31)));
  const mango = variants(3, (r) =>
    broadleaf(r, { height: r.range(2.6, 3.6), trunkR: 0.3, crown: r.range(3.6, 4.6), flat: 0.85, lobes: 6, cards: 125, cardSize: 1.1, tint: WHITE, bark: barkTint }),
  );
  const rainTree = variants(3, (r) =>
    broadleaf(r, { height: r.range(4.5, 5.5), trunkR: 0.42, crown: r.range(6, 7.5), flat: 0.45, lobes: 8, cards: 190, cardSize: 1.35, tint: rgb('#e8f0d8'), bark: barkTint }),
  );
  const farTree = variants(2, (r) =>
    broadleaf(r, { height: 4, trunkR: 0.4, crown: 5.5, flat: 0.75, lobes: 4, cards: 34, cardSize: 2.6, tint: rgb('#c8d0b8'), bark: barkTint }),
  );
  const joba = variants(3, hibiscus);
  const coconut = variants(3, (r) => palm(r, 'coconut'));
  const supari = variants(3, (r) => palm(r, 'supari'));
  const date = variants(2, (r) => palm(r, 'date'));
  const bananas = variants(3, banana);
  const bamboos = variants(2, bamboo);
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
    banana: bucket(bananas, mats.banana),
    bamboo: bucket(bamboos, mats.bamboo, culmMat),
    joba: bucket(joba, mats.hibiscus, flowerMat),
  };
  const put = (b: Bucket, p: Placement) => b.items[rng.int(0, b.items.length - 1)].push(p);

  // villages: groves of mango and jackfruit, coconut and supari palms by the houses, bananas, bamboo at the back
  VILLAGES.forEach((v, i) => {
    const c = VILLAGE_CENTERS[i];
    const tryPlace = (b: Bucket, count: number, rMin: number, rMax: number, gap: number, scale: [number, number]) => {
      for (let k = 0, tries = 0; k < count && tries < count * 12; tries++) {
        const a = rng.range(0, Math.PI * 2);
        const d = v.radius * Math.sqrt(rng.range(rMin * rMin, rMax * rMax));
        const x = c.x + Math.cos(a) * d;
        const z = c.z + Math.sin(a) * d;
        if (!onDryLand(x, z, 4) || !occ.free(x, z, gap)) continue;
        occ.add(x, z, gap * 0.6);
        put(b, at(x, z, rng, rng.range(scale[0], scale[1])));
        k++;
      }
    };
    tryPlace(B.mango, 24, 0.2, 1.25, 4.5, [0.8, 1.25]);
    tryPlace(B.rain, 3, 0.5, 1.3, 9, [0.9, 1.2]);
    tryPlace(B.coconut, 10, 0.3, 1.2, 2.5, [0.9, 1.15]);
    tryPlace(B.supari, 12, 0.1, 0.9, 1.6, [0.85, 1.15]);
    tryPlace(B.banana, 12, 0.05, 0.8, 1.6, [0.8, 1.2]);
    // a joba bush or two beside the houses, by the door or at the edge of the yard
    for (const h of huts) {
      if (Math.hypot(h.x - c.x, h.z - c.z) > v.radius * 1.3 || rng.next() < 0.45) continue;
      const a = rng.range(0, Math.PI * 2);
      const d = Math.max(h.l, h.w) * 0.5 + rng.range(1.2, 2.4);
      const x = h.x + Math.cos(a) * d;
      const z = h.z + Math.sin(a) * d;
      // clear of every hut's walls (the huts' own clearance rings are meant for trees, not bushes)
      if (!onDryLand(x, z, 3) || huts.some((o) => Math.hypot(o.x - x, o.z - z) < Math.max(o.l, o.w) * 0.5 + 0.8)) continue;
      put(B.joba, at(x, z, rng, rng.range(0.85, 1.2), 0.05));
    }
    // bamboo groves sit at the landward edge of the village
    for (let k = 0; k < 2; k++) {
      const x = c.x + v.side * v.radius * rng.range(0.8, 1.05);
      const z = c.z + rng.range(-0.6, 0.6) * v.radius;
      if (onDryLand(x, z, 10) && occ.free(x, z, 3)) {
        occ.add(x, z, 3);
        put(B.bamboo, at(x, z, rng, rng.range(0.9, 1.15)));
      }
    }
  });

  // trees along both banks, thinning and thickening with a slow noise
  for (const side of [-1, 1] as const) {
    for (let z = WORLD_Z0; z > WORLD_Z1; z -= rng.range(8, 16)) {
      if (fbm(z * 0.006, side * 4.1, 2, 3) < 0.45) continue;
      const inland = rng.range(4, 26);
      const x = riverX(z) + side * (edgeHalfWidth(z, side) + 3 + inland);
      if (villageDistance(x, z) < 1.3 || !onDryLand(x, z, 3) || !occ.free(x, z, 3)) continue;
      occ.add(x, z, 3);
      const r = rng.next();
      put(r < 0.35 ? B.rain : r < 0.7 ? B.mango : r < 0.9 ? B.coconut : B.supari, at(x, z, rng, rng.range(0.85, 1.2)));
    }
  }

  // palms, bananas and the odd bamboo clump along the khals' banks, as along any village canal
  KHALS.forEach((_, k) => {
    for (let s = 0.08; s < 0.95; s += rng.range(0.025, 0.05)) {
      const c = khalPoint(k, s);
      if (fbm(c.z * 0.02, k * 3.7, 2, 15) < 0.4) continue;
      const side = rng.sign();
      const off = c.halfWidth + rng.range(4, 9);
      const x = c.x + Math.cos(c.heading) * side * off;
      const z = c.z - Math.sin(c.heading) * side * off;
      if (villageDistance(x, z) < 1.2 || !onDryLand(x, z, 6) || !occ.free(x, z, 2.5)) continue;
      occ.add(x, z, 2.5);
      const r = rng.next();
      put(r < 0.3 ? B.coconut : r < 0.55 ? B.supari : r < 0.75 ? B.date : r < 0.92 ? B.banana : B.bamboo, at(x, z, rng, rng.range(0.85, 1.15)));
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

  // lone date palms and supari along the field bunds
  for (let k = 0; k < 160; k++) {
    const side = rng.sign();
    const z = rng.range(WORLD_Z1, WORLD_Z0);
    const x = riverX(z) + side * (edgeHalfWidth(z, side) + rng.range(60, 700));
    if (villageDistance(x, z) < 1.4 || !onDryLand(x, z, 30)) continue;
    put(rng.next() < 0.6 ? B.date : B.supari, at(x, z, rng, rng.range(0.85, 1.15)));
  }

  // distant groves: big, cheap trees that build the horizon's dark band
  for (const side of [-1, 1] as const) {
    for (let z = WORLD_Z0 + 100; z > WORLD_Z1 - 100; z -= rng.range(5, 9)) {
      for (const band of [rng.range(260, 420), rng.range(480, 700)]) {
        if (fbm(z * 0.004 + band * 0.01, side * 2.7, 2, 8) < 0.42) continue;
        const x = riverX(z) + side * (edgeHalfWidth(z, side) + band);
        if (!onDryLand(x, z, 30)) continue;
        put(B.far, at(x, z, rng, rng.range(1.2, 1.9), 0.4));
      }
    }
  }

  for (const b of Object.values(B)) {
    b.parts.forEach((parts, i) => {
      const items = b.items[i];
      if (!items.length) return;
      group.add(instanced(parts.wood, b.wood, items, { cast: true }));
      group.add(instanced(parts.leaves, b.leaves, items, { cast: true }));
    });
  }

  // kash on the chars and on low stretches of bank
  const kashItems: Placement[][] = kash.map(() => []);
  for (const c of CHARS) {
    for (let dz = -c.halfLen; dz <= c.halfLen; dz += 2.4) {
      for (let du = -c.halfWid; du <= c.halfWid; du += 2.4) {
        const z = c.z + dz + rng.range(-1.1, 1.1);
        const u = c.u + du + rng.range(-1.1, 1.1);
        const h = charHeight(z, u);
        if (h < 0.22 || h > 1.0) continue;
        if (fbm(z * 0.03, u * 0.05 + c.z, 2, 61) < 0.3) continue;
        const x = riverX(z) + u;
        kashItems[rng.int(0, kash.length - 1)].push({ x, y: h - 0.05, z, ry: rng.range(0, Math.PI * 2), s: rng.range(0.8, 1.2) });
      }
    }
  }
  for (const side of [-1, 1] as const) {
    for (let z = WORLD_Z0; z > WORLD_Z1; z -= 2.8) {
      if (fbm(z * 0.01, side * 9.3, 2, 62) < 0.55) continue;
      const we = edgeHalfWidth(z, side);
      for (let k = 0; k < 2; k++) {
        const x = riverX(z) + side * (we + rng.range(2.5, 7));
        const h = terrainHeight(x, z);
        if (h < 0.25 || h > 1.6) continue;
        kashItems[rng.int(0, kash.length - 1)].push({ x, y: h - 0.05, z, ry: rng.range(0, Math.PI * 2), s: rng.range(0.75, 1.1) });
      }
    }
  }
  kash.forEach((g, i) => kashItems[i].length && group.add(instanced(g, mats.kash, kashItems[i], { receive: true })));

  // grass tufts on the bank tops and round the villages
  const grassItems: Placement[][] = grass.map(() => []);
  for (const side of [-1, 1] as const) {
    for (let z = WORLD_Z0; z > WORLD_Z1; z -= 1.1) {
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

  // horizon tree lines
  const lineMat = patchMaterial(new MeshStandardMaterial({ vertexColors: true, roughness: 1, side: DoubleSide }), {});
  for (const side of [-1, 1] as const) {
    group.add(new Mesh(treeLine(side, 820, side > 0 ? 3 : 5), lineMat));
    group.add(new Mesh(treeLine(side, 1250, side > 0 ? 7 : 9), lineMat));
  }

  return group;
}
