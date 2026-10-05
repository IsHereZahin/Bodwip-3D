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
  palmFanTexture,
  kashTexture,
  leafClusterTexture,
  palmBarkTexture,
  palmFrondTexture,
} from '../render/textures';
import {
  BIL,
  HOMESTEAD_MOUNDS,
  MOUNDS,
  PONDS,
  WATER_LEVEL,
  WATERWAYS,
  bilDepth,
  bilPoint,
  bilReach,
  charShare,
  hillShare,
  inlandWaterAt,
  landUse,
  nearBackwater,
  onBridge,
  onLandmark,
  onRoad,
  pondReach,
  routeGap,
  shapePoint,
  terrainHeight,
  type Mound,
} from './geography';
import { BANYAN, FAR_GROVES, HILLS, WORLD } from './plan';
import { roadLines } from './roads';
import { KHAL, SIDE_KHAL, journeyDistance, type Waterway } from './waterways';
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

/**
 * A tal (palmyra), as the roads through the fields are lined with them: a straight dark trunk, thickest at its
 * foot and swelling a little two thirds up, and a round crown of stiff fan leaves on their stalks (each a card of
 * `palmFanTexture`), the youngest upright, the oldest hanging, a few dead ones brown below. `cheap`: fewer leaves,
 * a coarser trunk, for the far ones.
 */
function tal(rng: Rng, cheap = false): TreeParts {
  const wood = new MeshBuilder();
  const leaves = new MeshBuilder();
  const H = rng.range(9.5, 13);
  const leanAz = rng.range(0, Math.PI * 2);
  const lean = rng.range(0.05, 0.45);
  const pts: Vector3[] = [];
  const radii: number[] = [];
  const steps = cheap ? 4 : 9;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    pts.push(new Vector3(Math.cos(leanAz) * lean * t * t, H * t, Math.sin(leanAz) * lean * t * t));
    radii.push(0.3 * (1 - 0.25 * t + 0.12 * Math.exp(-(((t - 0.68) / 0.12) ** 2))) * (i === 0 ? 1.4 : 1));
  }
  taperedTube(wood, pts, radii, cheap ? 5 : 8, rgb('#c4bcb0'), 1.2);
  const top = pts[steps].clone().add(new Vector3(0, 0.3, 0));
  const n = cheap ? 18 : 36;
  const up = new Vector3(0, 1, 0);
  for (let i = 0; i < n + 4; i++) {
    const dead = i >= n;
    const az = rng.range(0, Math.PI * 2);
    // the crown a ball of them: upright in the middle, out to the sides, the oldest hanging; the dead ones lower
    const elev = dead ? rng.range(-1.35, -1.0) : Math.asin(rng.range(-0.55, 0.99));
    const dir = new Vector3(Math.cos(az) * Math.cos(elev), Math.sin(elev), Math.sin(az) * Math.cos(elev));
    const size = rng.range(1.35, 1.65) * (dead ? 0.85 : 1);
    const along = dir.clone().multiplyScalar(size * 1.05);
    // the fan faces out and a little up, turned about the stalk its own way
    const side = new Vector3().crossVectors(dir, up);
    if (side.lengthSq() < 1e-4) side.set(1, 0, 0);
    side.normalize().applyAxisAngle(dir, rng.range(-0.5, 0.5)).multiplyScalar(size * 1.05);
    const nrm = new Vector3().crossVectors(side, along).normalize().lerp(dir, 0.5).normalize();
    const base = top.clone().addScaledVector(dir, 0.2);
    card(leaves, base, side, along, nrm, dead ? rgb('#a88a58') : scaleRgb(WHITE, rng.range(0.85, 1.08)), true);
  }
  // taperedTube winds its triangles inward (CLAUDE.md): turned outward here, so the single-sided trunk shows
  // its near side, lit as it faces the sun
  const trunk = wood.build();
  const index = trunk.getIndex();
  if (index) {
    const a = index.array;
    for (let i = 0; i + 2 < a.length; i += 3) [a[i + 1], a[i + 2]] = [a[i + 2], a[i + 1]];
    index.needsUpdate = true;
  }
  return { wood: trunk, leaves: leaves.build() };
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

/**
 * A kash clump: its long leaves round the root (the texture's right half, in crossed cards) and above them its
 * flowering stems (the left half), each a slim card leaning its own way, so the plumes stand apart over the leaves.
 */
function kashTuft(rng: Rng): BufferGeometry {
  const b = new MeshBuilder();
  const card = (base: Vector3, h: number, halfW: number, yaw: number, lean: Vector3, u0: number, shade: number, widen: number) => {
    const right = new Vector3(Math.cos(yaw), 0, Math.sin(yaw)).multiplyScalar(halfW);
    const top = base.clone().add(new Vector3(0, h, 0)).add(lean);
    const nrm = new Vector3(-Math.sin(yaw) * 0.5, 1, Math.cos(yaw) * 0.5).normalize();
    const c = scaleRgb(WHITE, shade);
    const s = b.vertexCount;
    b.vertex(base.clone().sub(right), nrm, u0, 0, c);
    b.vertex(base.clone().add(right), nrm, u0 + 0.5, 0, c);
    b.vertex(top.clone().addScaledVector(right, widen), nrm, u0 + 0.5, 1, c);
    b.vertex(top.clone().addScaledVector(right, -widen), nrm, u0, 1, c);
    b.quad(s, s + 1, s + 2, s + 3);
  };
  const leaves = rng.int(4, 6);
  for (let i = 0; i < leaves; i++) {
    const base = new Vector3(rng.range(-0.25, 0.25), 0, rng.range(-0.25, 0.25));
    card(base, rng.range(1.1, 1.7), 0.42, (i / leaves) * Math.PI + rng.range(-0.3, 0.3), new Vector3(), 0.5, rng.range(0.8, 1.05), 1.5);
  }
  const stems = rng.int(9, 15);
  for (let i = 0; i < stems; i++) {
    const base = new Vector3(rng.range(-0.3, 0.3), 0, rng.range(-0.3, 0.3));
    const h = rng.range(1.9, 2.7);
    const la = rng.range(0, Math.PI * 2);
    const lean = new Vector3(Math.cos(la), 0, Math.sin(la)).multiplyScalar(rng.range(0.05, 0.3) * h * 0.25);
    card(base, h, 0.22, rng.range(0, Math.PI), lean, 0, rng.range(0.82, 1), 1);
  }
  return b.build();
}

// ---------- placement ----------

/** Kash stands only this far above the water (m): where the bank stays dry. */
const KASH_ABOVE = 0.4;

/** Whether the bank on `side` of a khal `s` m along it is in one of the stretches kash grows along. */
function kashStretch(way: Waterway, s: number, side: 1 | -1): boolean {
  return fbm(s * 0.012, side * 9.3 + way.length * 0.001, 2, 62) >= 0.58;
}

/** Where the kash stands thickest (set when the vegetation is built): the film's kash scene stands in it. */
let thickestKash: { x: number; z: number } | null = null;

/** A broadleaf tree's crown: its middle (world), its reach, and whether it is one of those that flower red in spring. */
export interface Crown {
  x: number;
  y: number;
  z: number;
  r: number;
  blossom: boolean;
}
/** Every broadleaf crown (set when the vegetation is built), the banyan's among them: the falling leaves come from them (world/leaves.ts). */
const CROWNS: Crown[] = [];
export function treeCrowns(): readonly Crown[] {
  return CROWNS;
}
/** The crowns filed in 40 m cells, for `overCrowns`. */
const CROWN_CELLS = new Map<number, Crown[]>();
const crownCell = (i: number, j: number) => (i + 4096) * 8192 + (j + 4096);

/**
 * The height a camera at (x, z) must be above to pass over every crown there (with `margin` m to spare), or
 * -Infinity where no crown is: the film's flights keep above it.
 */
export function overCrowns(x: number, z: number, margin = 1.5): number {
  let top = -Infinity;
  const i0 = Math.floor(x / 40);
  const j0 = Math.floor(z / 40);
  for (let i = i0 - 1; i <= i0 + 1; i++) {
    for (let j = j0 - 1; j <= j0 + 1; j++) {
      for (const c of CROWN_CELLS.get(crownCell(i, j)) ?? []) {
        // a dome over the crown's top, reaching down to nothing a few metres beyond its edge, so the height to
        // keep above rises and falls smoothly as a camera comes over it
        const R = c.r + margin + 4;
        const d2 = (c.x - x) ** 2 + (c.z - z) ** 2;
        if (d2 >= R * R) continue;
        top = Math.max(top, (c.y + 0.85 * c.r + margin) * Math.sqrt(1 - d2 / (R * R)));
      }
    }
  }
  return top;
}
export function kashStand(): { x: number; z: number } | null {
  return thickestKash;
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

/** Dry ground at least `minInland` m back from any water's edge, off the bil's rim, the char, the ways and the landmarks. */
function onDryLand(x: number, z: number, minInland: number): boolean {
  if (nearBackwater(x, z, minInland)) return false;
  if (bilReach(x, z) < 1.3) return false;
  const h = terrainHeight(x, z);
  if (h < WATER_LEVEL + 0.3 || onLandmark(x, z, 3) || onRoad(x, z, 1.5)) return false;
  for (const p of PONDS) if (Math.abs(p.x - x) < 40 && pondReach(p, x, z) < 1.35) return false;
  return true;
}

function at(x: number, z: number, rng: Rng, s: number, sink = 0.15): Placement {
  return { x, y: terrainHeight(x, z) - sink, z, ry: rng.range(0, Math.PI * 2), s };
}

// ---------- assembly ----------

/** `bark`: the photo bark for broadleaf trunks; without it they keep a painted brown. */
/** `clear`: other places to keep trees off (x, z and a radius), such as the old bridge's clearing. */
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
  // a house keeps trunks clear of its walls and eaves; crowns may hang over its roof, as they do
  for (const h of huts) occ.add(h.x, h.z, Math.max(h.w, h.l) * 0.5 + 1.2);
  for (const c of clear) occ.add(c.x, c.z, c.r);

  const tex = {
    mango: leafClusterTexture(11, ['#2a4319', '#35521f', '#426026', '#4f6e2b', '#5f7d31'], { count: 150, len: [0.08, 0.14], width: 0.4 }),
    rain: leafClusterTexture(12, ['#33501c', '#3f5f22', '#4e7029', '#5d7f2f', '#6c8a36'], { count: 210, len: [0.045, 0.085], width: 0.5 }),
    bamboo: leafClusterTexture(13, ['#4e6a24', '#5f7d2b', '#6f8c33', '#7f983c'], { count: 70, len: [0.18, 0.3], width: 0.16 }),
    hibiscus: leafClusterTexture(19, ['#1d3812', '#264818', '#30571d', '#3b6624'], { count: 80, len: [0.12, 0.18], width: 0.6 }),
    frond: palmFrondTexture(14),
    fan: palmFanTexture(21),
    banana: bananaLeafTexture(15),
    kash: kashTexture(16),
    grass: grassTexture(17),
    bark: palmBarkTexture(18),
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
    fan: leafMat({ map: tex.fan }, 0.14, 14),
    banana: leafMat({ map: tex.banana }, 0.12, 3),
    hibiscus: leafMat(tex.hibiscus, 0.06, 1.5, 0.5),
    kash: patchMaterial(
      new MeshStandardMaterial({ map: tex.kash, vertexColors: true, alphaTest: 0.42, alphaToCoverage: true, side: DoubleSide, roughness: 0.85 }),
      { wind: 0.35, windHeight: 2.2, translucency: 2.2, foliage: true, seasonal: 'kash' },
    ),
    grass: leafMat({ map: tex.grass }, 0.15, 0.8),
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
  // akashmoni (Acacia auriculiformis), among the commonest trees of Bengal's homesteads and roadsides: an
  // upright trunk, a dense rounded crown
  const akashmoni = variants(2, (r) =>
    broadleaf(r, { height: r.range(3.5, 5), trunkR: 0.24, crown: r.range(3.2, 4.2), flat: 1.0, lobes: 6, cards: 90, cardSize: 1.0, tint: rgb('#d4dcc0'), bark: barkTint }),
  );
  const coconut = variants(1, (r) => palm(r, 'coconut'));
  const supari = variants(1, (r) => palm(r, 'supari'));
  const date = variants(1, (r) => palm(r, 'date'));
  // the same palms, cheap, for those far inland
  const coconutFar = variants(1, (r) => palm(r, 'coconut', true));
  const supariFar = variants(1, (r) => palm(r, 'supari', true));
  const dateFar = variants(1, (r) => palm(r, 'date', true));
  const bananas = variants(1, banana);
  const tals = variants(3, (r) => tal(r));
  const bamboos = variants(1, bamboo);
  const kash = variants(3, kashTuft);
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
    akashmoni: bucket(akashmoni, mats.akashmoni),
    tal: bucket(tals, mats.fan, palmWood),
  };
  // where each broadleaf's crown sits over its foot (as `broadleaf` builds them, at their middling size), for the falling leaves
  const crownOf = new Map<Bucket, { y: number; r: number }>([
    [B.mango, { y: 5.2, r: 4.1 }],
    [B.rain, { y: 6.8, r: 6.7 }],
    [B.akashmoni, { y: 6.4, r: 3.7 }],
    [B.far, { y: 6.5, r: 5.5 }],
  ]);
  const put = (b: Bucket, p: Placement) => {
    b.items[rng.int(0, b.items.length - 1)].push(p);
    const c = crownOf.get(b);
    // all of these take the spring's red flower where the shader gives it (`seasonal: 'tree'`)
    if (c) CROWNS.push({ x: p.x, y: p.y + c.y * p.s, z: p.z, r: c.r * p.s, blossom: true });
  };
  for (const f of featured) put(B[f.kind], { x: f.x, y: terrainHeight(f.x, f.z) - 0.15, z: f.z, ry: f.ry, s: f.s });

  // the homesteads' joba bushes by the houses: one or two beside a house, by the door or the yard
  for (const h of huts) {
    if (h.kind === 'shed' || rng.next() < 0.45) continue;
    const a = rng.range(0, Math.PI * 2);
    const d = Math.max(h.l, h.w) * 0.5 + rng.range(1.2, 2.4);
    const x = h.x + Math.cos(a) * d;
    const z = h.z + Math.sin(a) * d;
    // clear of every hut's walls (the huts' own clearance rings are meant for trees, not bushes)
    if (!onDryLand(x, z, 3) || landUse(x, z).yard > 0.5 || huts.some((o) => Math.abs(o.x - x) < 12 && Math.hypot(o.x - x, o.z - z) < Math.max(o.l, o.w) * 0.5 + 0.8)) continue;
    put(B.joba, at(x, z, rng, rng.range(0.85, 1.2), 0.05));
  }

  /** Puts a tree of `kind` at (x, z) if the ground is free and dry, keeping `r` m round it; returns whether it did. */
  const plant = (b: Bucket, x: number, z: number, r: number, scale: number, minInland = 2): boolean => {
    if (!onDryLand(x, z, minInland) || !occ.free(x, z, r)) return false;
    occ.add(x, z, r);
    put(b, at(x, z, rng, scale));
    return true;
  };

  // each homestead's grove round its yard (the trees a family plants for fruit, timber and shade): bamboo and
  // mango at the back, betel-nut palms in rows along the sides, bananas by the kitchen, coconuts leaning out
  // at the front corners over the water or the path; the front stays open to the yard
  for (const m of HOMESTEAD_MOUNDS) homesteadGrove(m);
  function homesteadGrove(m: Mound): void {
    const along = (u: number, v: number) => shapePoint(m, u, v);
    // the back: bamboo at its corners, big fruit and timber trees along it, two deep
    const corner = rng.sign();
    for (const c of rng.next() < 0.5 ? [corner, -corner] : [corner]) {
      const bamboo = along(-m.hu - rng.range(0, 3), c * (m.hv - rng.range(0, 4)));
      plant(B.bamboo, bamboo.x, bamboo.z, 3, rng.range(0.85, 1.15));
    }
    for (const back of [rng.range(-2, 1), rng.range(4, 8)]) {
      for (let v = -m.hv + 2; v <= m.hv - 2; v += rng.range(4.5, 6.5)) {
        const p = along(-m.hu - back, v + rng.range(-1, 1));
        const r = rng.next();
        plant(r < 0.4 ? B.mango : r < 0.55 ? B.akashmoni : r < 0.68 ? B.rain : r < 0.8 ? B.supari : r < 0.9 ? B.banana : B.coconut, p.x, p.z, 1.8, rng.range(0.8, 1.15));
      }
    }
    // the sides: betel-nut palms in a loose row, a banana clump or two, and beyond them the garden's trees
    for (const side of [-1, 1]) {
      for (let u = -m.hu + 4; u <= m.hu - 3; u += rng.range(2.8, 4)) {
        const p = along(u, side * (m.hv + rng.range(-0.5, 2)));
        plant(rng.next() < 0.7 ? B.supari : B.banana, p.x, p.z, 1.2, rng.range(0.85, 1.15));
      }
      for (let u = -m.hu + 2; u <= m.hu - 6; u += rng.range(6, 9)) {
        const p = along(u, side * (m.hv + rng.range(4, 8)));
        const r = rng.next();
        plant(r < 0.45 ? B.mango : r < 0.6 ? B.bamboo : r < 0.8 ? B.akashmoni : B.banana, p.x, p.z, 2, rng.range(0.8, 1.15));
      }
    }
    for (let k = 0; k < 2; k++) {
      const p = along(rng.range(0, m.hu), rng.sign() * (m.hv - rng.range(1, 3)));
      for (let n = 0; n < 3; n++) plant(B.banana, p.x + rng.range(-1.5, 1.5), p.z + rng.range(-1.5, 1.5), 1, rng.range(0.8, 1.1));
    }
    // the front corners: coconuts leaning out, and a date palm
    for (const side of [-1, 1]) {
      const p = along(m.hu + rng.range(-1, 2), side * (m.hv - rng.range(0, 3)));
      plant(rng.next() < 0.75 ? B.coconut : B.date, p.x, p.z, 2, rng.range(0.85, 1.15), 1);
    }
  }

  // the old trees of the zamindar's compound round its back and sides (its lawn and its ghat stay open to the
  // river), a bel by the temple; coconuts flanking the mosque's forecourt and a big tree behind its hall
  for (const m of MOUNDS) {
    if (m.id === 'zamindar') {
      for (let v = -m.hv - 2; v <= m.hv + 2; v += rng.range(7, 10)) {
        const p = shapePoint(m, -m.hu - rng.range(1, 6), v);
        plant(rng.next() < 0.5 ? B.rain : B.mango, p.x, p.z, 4, rng.range(1.0, 1.3));
      }
      for (const side of [-1, 1]) {
        for (let u = -m.hu + 4; u <= m.hu * 0.2; u += rng.range(8, 11)) {
          const p = shapePoint(m, u, side * (m.hv + rng.range(1, 5)));
          const r = rng.next();
          plant(r < 0.35 ? B.mango : r < 0.6 ? B.coconut : r < 0.8 ? B.rain : B.date, p.x, p.z, 3, rng.range(0.95, 1.25));
        }
      }
      const bel = shapePoint(m, 9, m.hv * 0.62 + 6);
      plant(B.akashmoni, bel.x, bel.z, 3, 0.9);
    } else if (m.id === 'mosque') {
      for (const side of [-1, 1]) {
        const p = shapePoint(m, m.hu + 3, side * 7.5);
        plant(B.coconut, p.x, p.z, 2, rng.range(0.95, 1.1), 1);
      }
      const back = shapePoint(m, -m.hu - 4, rng.range(-4, 4));
      plant(B.rain, back.x, back.z, 5, 1.25);
      for (const side of [-1, 1]) {
        const p = shapePoint(m, -m.hu * 0.4, side * (m.hv + 3));
        plant(rng.next() < 0.5 ? B.mango : B.akashmoni, p.x, p.z, 3, rng.range(0.9, 1.15));
      }
    }
  }

  // the gaps between neighbouring homesteads of a para fill with trees: the village reads as one grove
  for (let i = 0; i < HOMESTEAD_MOUNDS.length; i++) {
    for (let j = i + 1; j < HOMESTEAD_MOUNDS.length; j++) {
      const a = HOMESTEAD_MOUNDS[i];
      const b = HOMESTEAD_MOUNDS[j];
      const d = Math.hypot(a.x - b.x, a.z - b.z);
      if (d > 95) continue;
      const n = Math.round(d / 9);
      for (let k = 0; k < n; k++) {
        const t = rng.range(0.25, 0.75);
        const x = a.x + (b.x - a.x) * t + rng.range(-12, 12);
        const z = a.z + (b.z - a.z) * t + rng.range(-12, 12);
        if (landUse(x, z).yard > 0.2) continue;
        const r = rng.next();
        plant(r < 0.3 ? B.mango : r < 0.45 ? B.rain : r < 0.6 ? B.bamboo : r < 0.8 ? B.supari : r < 0.9 ? B.akashmoni : B.banana, x, z, r < 0.6 ? 3 : 1.5, rng.range(0.85, 1.2));
      }
    }
  }

  // the old trees along the river's and the khals' banks, on the levee's top: a rain tree, a mango, a palm
  // leaning out over the water; thicker where the homesteads are, few along the fields, none on the char
  for (const way of WATERWAYS) {
    const step = way === SIDE_KHAL ? 26 : 16;
    for (let s = 0; s < way.length; s += step * rng.range(0.7, 1.3)) {
      for (const side of [-1, 1] as const) {
        const out = way.half(s) + (way === SIDE_KHAL ? 4 : 8) + rng.range(0, 6);
        const p = way.beside(s, side, out);
        if (Math.abs(p.x) > WORLD.x1 || p.z < WORLD.z0 || p.z > WORLD.z1 || charShare(p.x, p.z) > 0.2) continue;
        const homes = HOMESTEAD_MOUNDS.some((m) => Math.hypot(m.x - p.x, m.z - p.z) < 70);
        if (rng.next() > (homes ? 0.75 : 0.22)) continue;
        const r = rng.next();
        const tree = r < 0.3 ? B.rain : r < 0.5 ? B.mango : r < 0.68 ? B.coconut : r < 0.8 ? B.date : r < 0.9 ? B.akashmoni : B.bamboo;
        plant(tree, p.x, p.z, tree === B.rain ? 4.5 : 3, rng.range(0.85, 1.25), 1.5);
      }
    }
  }

  // the brick road under its trees: through the village a row each side of rain trees and akashmoni (as the
  // roads are planted), gaps where houses, ponds or the bridge come up to it; out where it crosses open fields,
  // close rows of tal palms both sides, the way Bengal's field roads are lined with them
  const openField = (x: number, z: number, nx: number, nz: number) =>
    [16, 30].every((d) => landUse(x + nx * d, z + nz * d).field > 0.75 && landUse(x - nx * d, z - nz * d).field > 0.75);
  for (const line of roadLines()) {
    if (!line.raised) continue;
    const pts = line.points;
    // tal every 7 m or so, one row's palms between the other's; the other trees farther apart
    for (let k = 0; k + 1 < pts.length; k++) {
      const [ax, az] = pts[k];
      const [bx, bz] = pts[k + 1];
      const len = Math.hypot(bx - ax, bz - az) || 1;
      const nx = (bz - az) / len;
      const nz = -(bx - ax) / len;
      const open = openField(ax, az, nx, nz);
      if (!open && k % 5) continue;
      for (const side of [-1, 1]) {
        if (open) {
          // every 2.5 m point is a place; each side takes every third, the two sides out of step
          if ((k + (side > 0 ? 0 : 1)) % 3) continue;
          const off = line.half + 1.7 + rng.range(0, 0.5);
          const x = ax + nx * off * side + rng.range(-0.4, 0.4);
          const z = az + nz * off * side + rng.range(-0.4, 0.4);
          if (onBridge(x, z, 18) || rng.next() < 0.06) continue;
          plant(B.tal, x, z, 1.6, rng.range(0.85, 1.12), 2);
          continue;
        }
        if (rng.next() < 0.3) continue;
        const off = line.half + 3.2 + rng.range(0, 1.5);
        const x = ax + nx * off * side;
        const z = az + nz * off * side;
        if (onBridge(x, z, 18)) continue;
        plant(rng.next() < 0.6 ? B.rain : B.akashmoni, x, z, 3.5, rng.range(0.9, 1.2), 2);
      }
    }
  }

  // out in the fields: now and then a lone palm on a bund or a big old tree standing over the paddy, a few
  // hundred metres apart, thicker near the water than out toward the horizon
  for (let k = 0; k < 420; k++) {
    const x = rng.range(WORLD.x0, WORLD.x1);
    const z = rng.range(WORLD.z0, WORLD.z1);
    const near = journeyDistance(x, z) < 300;
    if (!near && rng.next() < 0.6) continue;
    if (landUse(x, z).field < 0.9) continue;
    const r = rng.next();
    plant(r < 0.45 ? (near ? B.date : B.dateFar) : r < 0.75 ? (near ? B.coconut : B.coconutFar) : near ? B.rain : B.far, x, z, 28, rng.range(0.85, 1.2));
  }

  // the hills' forest: crowns close over their slopes and tops; those the boat's way sees drawn in full, the
  // rest cheap crowns that read the same through the haze
  for (const hill of HILLS) {
    const s = Math.sin(hill.yaw);
    const c = Math.cos(hill.yaw);
    // the hill the boat's way sees close is planted thick; those on the horizon with fewer, larger crowns that
    // close over them the same through the haze
    const seen = journeyDistance(hill.x, hill.z) < 700;
    const n = Math.round((Math.PI * hill.r * hill.r * hill.stretch) / (seen ? 115 : 230));
    for (let k = 0; k < n; k++) {
      const a = rng.range(0, Math.PI * 2);
      const d = Math.sqrt(rng.next()) * hill.r;
      const la = Math.cos(a) * d * hill.stretch;
      const lb = Math.sin(a) * d;
      const x = hill.x + la * s + lb * c;
      const z = hill.z + la * c - lb * s;
      if (hillShare(x, z) < 0.5) continue;
      const near = journeyDistance(x, z) < 450;
      const r = rng.next();
      const tree = near ? (r < 0.35 ? B.rain : r < 0.6 ? B.mango : r < 0.8 ? B.akashmoni : r < 0.9 ? B.date : B.bamboo) : r < 0.8 ? B.far : r < 0.9 ? B.dateFar : B.coconutFar;
      plant(tree, x, z, near ? 3.2 : seen ? 4 : 6, near ? rng.range(1.0, 1.35) : seen ? rng.range(1.35, 1.7) : rng.range(1.8, 2.3));
    }
  }

  // round the bil: groves standing back from its marshy rim, and hijol trees out in its shallows
  for (let k = 0; k < 260; k++) {
    const a = rng.range(0, Math.PI * 2);
    const e = rng.range(1.5, 1.9);
    const { x, z } = bilPoint(Math.cos(a) * BIL.halfLen * e, Math.sin(a) * BIL.halfWid * e);
    if (fbm(z * 0.01, x * 0.01, 2, 23) < 0.42 || !onDryLand(x, z, 20) || !occ.free(x, z, 3.5)) continue;
    occ.add(x, z, 3.5);
    const r = rng.next();
    put(r < 0.4 ? B.mango : r < 0.6 ? B.rain : r < 0.85 ? B.date : B.coconut, at(x, z, rng, rng.range(0.85, 1.2)));
  }
  for (let k = 0, placed = 0; k < 400 && placed < 9; k++) {
    const { x, z } = bilPoint(rng.range(-1, 1) * BIL.halfLen, rng.range(-1.2, 1.2) * BIL.halfWid);
    const e = bilReach(x, z);
    const depth = bilDepth(x, z);
    if (e < 0.88 || e > 0.98 || depth < 0.1 || depth > 0.45 || routeGap(x, z) < 15 || !occ.free(x, z, 6)) continue;
    occ.add(x, z, 6);
    // their trunks stand in the water
    put(B.mango, at(x, z, rng, rng.range(0.7, 0.95), 0.05));
    placed++;
  }

  // the far villages: groves on their mounds toward every horizon, cheap crowns that read the same through the haze
  for (const g of FAR_GROVES) {
    const n = Math.round((g.r * g.r) / 40);
    for (let k = 0; k < n; k++) {
      const a = rng.range(0, Math.PI * 2);
      const d = Math.sqrt(rng.next()) * g.r;
      const x = g.x + Math.cos(a) * d * 1.3;
      const z = g.z + Math.sin(a) * d * 0.8;
      if (inlandWaterAt(x, z) || !occ.free(x, z, 2.5)) continue;
      occ.add(x, z, 2.5);
      const r = rng.next();
      put(r < 0.62 ? B.far : r < 0.8 ? B.supariFar : r < 0.92 ? B.coconutFar : B.dateFar, { x, y: terrainHeight(x, z) - 0.2, z, ry: rng.range(0, Math.PI * 2), s: rng.range(0.9, 1.35) });
    }
  }

  // the trees near the boat's way and by the water show in the water's mirror; those far off on the plain are
  // left out of it (from the water they stand behind the banks' own trees)
  const mirrored = (p: Placement) => journeyDistance(p.x, p.z) < 260 || nearBackwater(p.x, p.z, 12);
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

  // kash: thick over the river's sandy char on the inside of its bend, and in stretches along the khals'
  // open banks where they stay dry (not below the homesteads' trees, on the ways or at the crossings); the
  // season keeps its plumes to the autumn
  const kashItems: Placement[][] = kash.map(() => []);
  const tuftAt = (x: number, z: number) => {
    const h = terrainHeight(x, z);
    // on the char's sand it stands almost to the water; on a mud bank only where the bank stays dry
    if (h < WATER_LEVEL + (charShare(x, z) > 0.5 ? 0.12 : KASH_ABOVE) || !onDryLand(x, z, 0) || !occ.free(x, z, 0.5)) return;
    kashItems[rng.int(0, kash.length - 1)].push({ x, y: h - 0.05, z, ry: rng.range(0, Math.PI * 2), s: rng.range(0.75, 1.1) });
  };
  // on the char a kashbon: drifts of it standing thick, with open sand and grass between
  const charGrass: { x: number; z: number }[] = [];
  for (let k = 0; k < 26000; k++) {
    const x = rng.range(-640, -270);
    const z = rng.range(60, 190);
    const c = charShare(x, z);
    if (c < 0.15) continue;
    const drift = smoothstep(0.36, 0.6, fbm(x * 0.025, z * 0.025, 2, 63));
    if (rng.next() < c * (0.12 + 0.88 * drift)) tuftAt(x, z);
    else if (rng.next() < 0.35 * c) charGrass.push({ x, z });
  }
  for (const way of [KHAL, SIDE_KHAL]) {
    for (const side of [-1, 1] as const) {
      for (let s = 30; s < way.length - 30; s += 2.8) {
        if (!kashStretch(way, s, side)) continue;
        for (let k = 0; k < 3; k++) {
          const p = way.beside(s + rng.range(-1.4, 1.4), side, way.half(s) + 5 + rng.range(0.5, 8));
          if (HOMESTEAD_MOUNDS.some((m) => Math.hypot(m.x - p.x, m.z - p.z) < 40) || MOUNDS.some((m) => !m.home && Math.hypot(m.x - p.x, m.z - p.z) < 45)) continue;
          tuftAt(p.x, p.z);
        }
      }
    }
  }
  kash.forEach((g, i) => kashItems[i].length && group.add(instanced(g, mats.kash, kashItems[i], { receive: true })));
  const tufts = kashItems.flat();
  let most = 0;
  for (let i = 0; i < tufts.length; i += 7) {
    const a = tufts[i];
    let n = 0;
    for (const b of tufts) if (Math.abs(a.x - b.x) < 7 && Math.hypot(a.x - b.x, a.z - b.z) < 7) n++;
    if (n > most) (most = n), (thickestKash = { x: a.x, z: a.z });
  }

  // grass tufts along the waters' banks: thickest along the lip of the bank, where it shows from the boat
  const grassItems: Placement[][] = grass.map(() => []);
  for (const way of WATERWAYS) {
    for (const side of [-1, 1] as const) {
      for (let s = 0; s < way.length; s += 1.3) {
        const p0 = way.at(s);
        if (Math.abs(p0.x - (WORLD.x0 + WORLD.x1) / 2) > 1300 || journeyDistance(p0.x, p0.z) > 500) continue;
        for (const inland of [rng.range(0.3, 3), rng.range(2, 12)]) {
          const { x, z } = way.beside(s, side, way.half(s) + (way === SIDE_KHAL ? 3 : way === KHAL ? 5 : 7) + inland);
          if (!onDryLand(x, z, 0) || rng.next() < 0.3 || charShare(x, z) > 0.3) continue;
          grassItems[rng.int(0, grass.length - 1)].push(at(x, z, rng, rng.range(0.8, 1.35), 0.05));
        }
      }
    }
  }
  // and the char's own between its kash, clear of the water's edge
  for (const { x, z } of charGrass) {
    if (terrainHeight(x, z) > WATER_LEVEL + 0.2) grassItems[rng.int(0, grass.length - 1)].push(at(x, z, rng, rng.range(0.7, 1.2), 0.05));
  }
  grass.forEach(
    (g, i) => grassItems[i].length && group.add(instanced(g, mats.grass, grassItems[i], { layer: LAYER_NO_REFLECT, receive: true })),
  );

  // the banyan's crown too (world/banyan.ts builds it), and every crown filed for `overCrowns`
  CROWNS.push({ x: BANYAN.x, y: terrainHeight(BANYAN.x, BANYAN.z) + 11, z: BANYAN.z, r: BANYAN.crown, blossom: false });
  for (const c of CROWNS) {
    const k = crownCell(Math.floor(c.x / 40), Math.floor(c.z / 40));
    let list = CROWN_CELLS.get(k);
    if (!list) CROWN_CELLS.set(k, (list = []));
    list.push(c);
  }

  return group;
}
