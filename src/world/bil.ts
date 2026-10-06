import {
  BufferAttribute,
  BufferGeometry,
  ConeGeometry,
  CylinderGeometry,
  DoubleSide,
  DynamicDrawUsage,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  LatheGeometry,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  Quaternion,
  SphereGeometry,
  Vector2,
  Vector3,
  Vector4,
} from 'three';
import type { Material } from 'three';
import { LAYER_NO_REFLECT } from '../core/globals';
import { smoothstep } from '../core/mathx';
import { fbm } from '../core/noise';
import { Rng } from '../core/rng';
import { MeshBuilder, mixRgb, rgb, taperedTube, type RGB } from '../render/builder';
import { instanced, type Placement } from '../render/instancing';
import { patchMaterial, type PatchOptions } from '../render/patch';
import { lilyCarpetTexture } from '../render/textures';
import type { BoatBody } from './boatPhysics';
import { BIL, bilDepth, bilReach, routeGap, terrainHeight, waterRise } from './geography';
import { bilLocal, bilPoint } from './waterways';
import { HERO_HULL, heroBeamAtWater } from './hull';
import { INLAND, SHELTERED, SHOAL_DEPTH, waveHeightGlsl, waveSlopeGlsl } from './waves';

// The shapla bil: a broad, shallow wetland behind the left bank, its water still and glassy. Water lilies
// (white, pink and red shapla) grow in rafts across it, thickest in water between knee and chest deep;
// reeds stand along its edge, a stand of lotus holds its leaves up out of the water, and egrets wade in
// the shallows. Near the boat's way every lily is a plant of its own, rooted: its pad floats on a slack
// stem over its root, bobs on the sheltered swell and rocks in the breeze (on the GPU), and when the hull
// or the blade pushes through, the pads in the way are shoved aside, drift, and are drawn back over their
// roots by their stems. Farther off, rafts too many to grow one by one are painted on a mesh over the
// water. Egrets take off when the boat comes near and settle elsewhere along the edge.

const UP = new Vector3(0, 1, 0);
/** Rafts of lilies along the boat's way, the most plants they hold, and the spacing of pads in a raft (m). */
const RAFTS = 120;
const MAX_PLANTS = 18000;
const SPACING = 0.43;
/** How hard a pad is drawn back over its root beyond its stem's slack (1/s²), how it leans back within it, and the water's drag (s). */
const STEM = 9;
const RESTORE = 0.8;
const DRAG_TAU = 0.9;
/** Size of the grid cells the plants are filed in, m. */
const CELL = 6;
const HALF_LEN = HERO_HULL.len / 2;
/** How close the boat comes before an egret takes off (m), and how many egrets wade here. */
const FLUSH = 14;
const EGRETS = 6;

/** Kinds of plant, each its own instanced mesh. */
const PAD_A = 0;
const PAD_B = 1;
const WHITE = 2;
const PINK = 3;
const RED = 4;
const BUD = 5;
const KINDS = 6;

/** A floating pad: round with the lily's notch, its rim turned up a little. Radius 1. */
function padGeometry(dark: RGB, light: RGB): BufferGeometry {
  const b = new MeshBuilder();
  const N = 14;
  const notch = 0.32;
  const c = b.vertex(new Vector3(0, 0.006, 0), UP, 0.5, 0.5, dark);
  const ring: number[] = [];
  for (let k = 0; k <= N; k++) {
    const a = notch / 2 + (k / N) * (Math.PI * 2 - notch);
    const rim = 0.014 * (1 + 0.6 * Math.sin(k * 2.3));
    ring.push(b.vertex(new Vector3(Math.cos(a), rim, Math.sin(a)), UP, 0, 0, mixRgb(dark, light, (Math.sin(k * 1.7) + 1) / 2)));
  }
  for (let k = 0; k < N; k++) b.tri(c, ring[k + 1], ring[k]);
  return b.build();
}

/** An open shapla: three rings of pointed petals cupped round a crown of golden stamens. */
function flowerGeometry(petal: RGB, tip: RGB): BufferGeometry {
  const b = new MeshBuilder();
  b.add(new SphereGeometry(0.018, 8, 5), new Matrix4().makeTranslation(0, 0.045, 0).multiply(new Matrix4().makeScale(1, 0.55, 1)), rgb('#f2c037'));
  for (const [count, len, lift, width, phase, y0] of [
    [12, 0.085, 0.35, 0.02, 0, 0.022],
    [10, 0.075, 0.75, 0.019, 0.31, 0.028],
    [8, 0.06, 1.25, 0.017, 0.12, 0.034],
  ] as const) {
    for (let k = 0; k < count; k++) {
      const a = (k / count) * Math.PI * 2 + phase;
      const out = new Vector3(Math.cos(a), lift, Math.sin(a)).normalize();
      const side = new Vector3(-Math.sin(a), 0, Math.cos(a)).multiplyScalar(width);
      const base = new Vector3(0, y0, 0);
      const mid = base.clone().addScaledVector(out, len * 0.45);
      const end = base.clone().addScaledVector(out, len).add(new Vector3(0, len * 0.15, 0));
      const n = out.clone().add(UP).normalize();
      const p0 = b.vertex(base, n, 0.5, 0, petal);
      const p1 = b.vertex(mid.clone().add(side), n, 0, 0.5, petal);
      const p2 = b.vertex(end, n, 0.5, 1, tip);
      const p3 = b.vertex(mid.clone().sub(side), n, 1, 0.5, petal);
      b.tri(p0, p1, p2);
      b.tri(p0, p2, p3);
    }
  }
  return b.build();
}

/** A bud held just above the water: a pointed spindle of folded sepals, green flushed with red. */
function budGeometry(): BufferGeometry {
  const b = new MeshBuilder();
  const lathe = new LatheGeometry(
    [
      [0.001, 0],
      [0.016, 0.02],
      [0.022, 0.05],
      [0.018, 0.08],
      [0.006, 0.105],
      [0.001, 0.115],
    ].map(([r, y]) => new Vector2(r, y)),
    8,
  );
  b.add(lathe, new Matrix4(), rgb('#6a6a2c'));
  return b.build();
}

/** A clump of reeds: thin blades fanning up out of the water, a few carrying brown cattail heads. */
function reedClump(rng: Rng): BufferGeometry {
  const b = new MeshBuilder();
  const n = rng.int(10, 16);
  for (let i = 0; i < n; i++) {
    const a = rng.range(0, Math.PI * 2);
    const lean = rng.range(0.05, 0.3);
    const h = rng.range(1.1, 2.1);
    const w = rng.range(0.012, 0.022);
    const base = new Vector3(Math.cos(a) * rng.range(0, 0.25), -0.4, Math.sin(a) * rng.range(0, 0.25));
    const out = new Vector3(Math.cos(a), 0, Math.sin(a));
    const side = new Vector3(-Math.sin(a), 0, Math.cos(a));
    const start = b.vertexCount;
    for (let j = 0; j <= 3; j++) {
      const t = j / 3;
      const p = base.clone().addScaledVector(UP, h * t).addScaledVector(out, h * lean * t * t);
      const half = w * (1 - 0.9 * t);
      const col = mixRgb(rgb('#4d6b26'), rgb('#a39a4c'), t * t);
      const nrm = out.clone().add(UP).normalize();
      b.vertex(p.clone().addScaledVector(side, -half), nrm, 0, t, col);
      b.vertex(p.clone().addScaledVector(side, half), nrm, 1, t, col);
    }
    for (let j = 0; j < 3; j++) b.quad(start + j * 2, start + j * 2 + 1, start + j * 2 + 3, start + j * 2 + 2);
    if (rng.next() < 0.25) {
      // a stiff stalk with a cattail's brown head
      const top = base.clone().addScaledVector(UP, h * 0.95);
      b.add(new CylinderGeometry(0.004, 0.005, h * 0.95, 4), new Matrix4().makeTranslation(top.x, base.y + h * 0.475, top.z), rgb('#6b6a35'));
      b.add(new CylinderGeometry(0.016, 0.016, 0.16, 6), new Matrix4().makeTranslation(top.x, top.y - 0.12, top.z), rgb('#5a3b22'));
    }
  }
  return b.build();
}

/** A lotus leaf held up on its stalk: a shallow bowl, the stalk running down into the water. Radius 1. */
function lotusLeaf(): BufferGeometry {
  const b = new MeshBuilder();
  const N = 16;
  const c = b.vertex(new Vector3(0, 0, 0), UP, 0.5, 0.5, rgb('#45692a'));
  const ring: number[] = [];
  for (let k = 0; k <= N; k++) {
    const a = (k / N) * Math.PI * 2;
    ring.push(b.vertex(new Vector3(Math.cos(a), 0.28 + 0.05 * Math.sin(3 * a), Math.sin(a)), UP, 0, 0, mixRgb(rgb('#4f7a2f'), rgb('#6b8f3a'), (Math.sin(a * 2) + 1) / 2)));
  }
  for (let k = 0; k < N; k++) b.tri(c, ring[k + 1], ring[k]);
  b.add(new CylinderGeometry(0.03, 0.035, 2.0, 5), new Matrix4().makeTranslation(0, -1.0, 0), rgb('#556b30'));
  return b.build();
}

/** A lotus flower on its tall stalk: pink petals cupped upright round a seed pod. */
function lotusFlower(): BufferGeometry {
  const b = new MeshBuilder();
  const pink = rgb('#ef9cba');
  const deep = rgb('#c4497c');
  b.add(new CylinderGeometry(0.008, 0.01, 1.0, 5), new Matrix4().makeTranslation(0, -0.5, 0), rgb('#556b30'));
  b.add(new CylinderGeometry(0.022, 0.016, 0.03, 8), new Matrix4().makeTranslation(0, 0.035, 0), rgb('#c9c25a'));
  for (const [count, len, lift, phase] of [
    [8, 0.12, 1.6, 0],
    [6, 0.1, 2.4, 0.4],
  ] as const) {
    for (let k = 0; k < count; k++) {
      const a = (k / count) * Math.PI * 2 + phase;
      const out = new Vector3(Math.cos(a), lift, Math.sin(a)).normalize();
      const side = new Vector3(-Math.sin(a), 0, Math.cos(a)).multiplyScalar(0.032);
      const base = new Vector3(0, 0.01, 0);
      const mid = base.clone().addScaledVector(out, len * 0.5).addScaledVector(new Vector3(Math.cos(a), 0, Math.sin(a)), 0.015);
      const end = base.clone().addScaledVector(out, len);
      const n = new Vector3(Math.cos(a), 0.4, Math.sin(a)).normalize();
      const p0 = b.vertex(base, n, 0.5, 0, pink);
      const p1 = b.vertex(mid.clone().add(side), n, 0, 0.5, pink);
      const p2 = b.vertex(end, n, 0.5, 1, deep);
      const p3 = b.vertex(mid.clone().sub(side), n, 1, 0.5, pink);
      b.tri(p0, p1, p2);
      b.tri(p0, p2, p3);
    }
  }
  return b.build();
}

/** An egret standing, its origin at its feet and facing +z: legs, body, tail. The neck is separate, for feeding. */
function egretBody(): BufferGeometry {
  const b = new MeshBuilder();
  const white = rgb('#f4f2ec');
  const dark = rgb('#1c1b18');
  for (const x of [-0.028, 0.028]) b.add(new CylinderGeometry(0.0055, 0.0065, 0.5, 5), new Matrix4().makeTranslation(x, 0.25, -0.01), dark);
  const egg = new SphereGeometry(1, 12, 9);
  b.add(egg, new Matrix4().makeTranslation(0, 0.57, -0.02).multiply(new Matrix4().makeRotationX(-0.35)).multiply(new Matrix4().makeScale(0.07, 0.072, 0.17)), white);
  b.add(egg, new Matrix4().makeTranslation(0, 0.5, -0.2).multiply(new Matrix4().makeRotationX(0.5)).multiply(new Matrix4().makeScale(0.045, 0.02, 0.1)), white);
  return b.build();
}

/** The neck's S and the head with its dagger bill, rising from the base of the neck (its origin). */
function egretNeck(): BufferGeometry {
  const b = new MeshBuilder();
  const white = rgb('#f4f2ec');
  taperedTube(b, [new Vector3(0, 0, 0), new Vector3(0, 0.1, 0.03), new Vector3(0, 0.2, -0.01), new Vector3(0, 0.27, 0.04)], [0.024, 0.018, 0.015, 0.014], 6, white, 1);
  b.add(new SphereGeometry(0.026, 8, 6), new Matrix4().makeTranslation(0, 0.285, 0.055), white);
  b.add(new ConeGeometry(0.011, 0.11, 6), new Matrix4().makeTranslation(0, 0.28, 0.13).multiply(new Matrix4().makeRotationX(Math.PI / 2)), rgb('#d8a52a'));
  return b.build();
}

/** One wing spread along +x from the shoulder, swept back toward its tip. */
function egretWing(): BufferGeometry {
  const b = new MeshBuilder();
  const white = rgb('#f6f4ee');
  const a = b.vertex(new Vector3(0, 0, 0.1), UP, 0, 0, white);
  const c = b.vertex(new Vector3(0.62, 0, -0.04), UP, 1, 0, white);
  const d = b.vertex(new Vector3(0.58, 0, -0.13), UP, 1, 1, white);
  const e = b.vertex(new Vector3(0, 0, -0.11), UP, 0, 1, white);
  b.quad(a, c, d, e);
  return b.build();
}

/** Where an egret may wade: a point in the shallows at the bil's edge (y is the bed, where its feet are). */
interface Spot {
  x: number;
  y: number;
  z: number;
  busy: boolean;
}

/** An egret: feeding where it stands, and flying off along the edge when the boat comes near. */
class Egret {
  readonly group = new Group();
  private readonly neck = new Group();
  private readonly wings: Mesh[] = [];
  private spot: Spot;
  private next: Spot;
  private flying = false;
  private readonly from = new Vector3();
  private readonly to = new Vector3();
  private t = 0;
  private duration = 1;
  private peck = 0;
  private peckIn: number;
  private yaw: number;

  constructor(body: BufferGeometry, neck: BufferGeometry, wing: BufferGeometry, material: Material, spot: Spot, rng: Rng) {
    this.spot = this.next = spot;
    spot.busy = true;
    this.peckIn = rng.range(1, 6);
    this.yaw = rng.range(0, Math.PI * 2);
    this.group.add(new Mesh(body, material));
    this.neck.position.set(0, 0.6, 0.11);
    this.neck.add(new Mesh(neck, material));
    this.group.add(this.neck);
    for (const side of [1, -1]) {
      const w = new Mesh(wing, material);
      w.position.set(side * 0.05, 0.62, 0);
      w.scale.x = side;
      w.visible = false;
      this.wings.push(w);
      this.group.add(w);
    }
    this.group.position.set(spot.x, spot.y, spot.z);
    this.group.rotation.y = this.yaw;
  }

  update(dt: number, t: number, boat: Vector3, boatSpeed: number, spots: Spot[], rng: Rng): void {
    if (!this.flying) {
      // feeding: every few seconds the neck dips to the water and comes up again, and it turns a little
      this.peckIn -= dt;
      if (this.peckIn <= 0) {
        this.peck = 1.2;
        this.peckIn = rng.range(3, 8);
        this.yaw += rng.range(-0.6, 0.6);
      }
      const dip = this.peck > 0 ? Math.sin(Math.PI * (1 - this.peck / 1.2)) : 0;
      this.peck = Math.max(0, this.peck - dt);
      this.neck.rotation.x = 1.1 * dip;
      this.group.rotation.set(0, this.yaw, 0);
      if (boatSpeed > 0.3 && Math.hypot(boat.x - this.spot.x, boat.z - this.spot.z) < FLUSH) this.takeOff(boat, spots, rng);
      return;
    }
    // flying: up and along to its next spot, neck drawn in, legs trailing, wings beating, gliding in to land
    this.t = Math.min(1, this.t + dt / this.duration);
    const u = this.t;
    const s = u * u * (3 - 2 * u);
    this.group.position.lerpVectors(this.from, this.to, s);
    this.group.position.y += Math.sin(Math.PI * u) * (3 + this.from.distanceTo(this.to) * 0.04);
    this.group.rotation.set(0.9 * Math.sin(Math.PI * Math.min(1, u * 1.15)), Math.atan2(this.to.x - this.from.x, this.to.z - this.from.z), 0, 'YXZ');
    this.neck.rotation.x = -0.6;
    const beat = u < 0.82 ? 0.15 + 0.75 * Math.sin(t * Math.PI * 2 * 3) : 0.35;
    this.wings[0].rotation.z = beat;
    this.wings[1].rotation.z = -beat;
    if (u >= 1) {
      this.flying = false;
      this.spot = this.next;
      this.yaw = this.group.rotation.y;
      this.group.position.set(this.spot.x, this.spot.y, this.spot.z);
      for (const w of this.wings) w.visible = false;
    }
  }

  /**
   * The wading spots have moved with the water: keep standing if this one is still a spot, else fly to the
   * nearest free one (or, with `jump`, be standing there already).
   */
  reclaim(spots: Spot[], jump: boolean): void {
    const same = spots.find((s) => !s.busy && Math.hypot(s.x - this.spot.x, s.z - this.spot.z) < 3);
    const free = spots.filter((s) => !s.busy);
    free.sort((a, b) => Math.hypot(a.x - this.spot.x, a.z - this.spot.z) - Math.hypot(b.x - this.spot.x, b.z - this.spot.z));
    const near = same ?? (jump ? free[0] : undefined);
    if (near) {
      this.spot = this.next = near;
      near.busy = true;
      if (jump) this.land();
      else if (!this.flying) this.group.position.set(near.x, near.y, near.z);
      return;
    }
    if (free.length) this.flyTo(free[0]);
  }

  /** Standing on its spot at once (out of any flight). */
  private land(): void {
    this.flying = false;
    this.group.position.set(this.spot.x, this.spot.y, this.spot.z);
    for (const w of this.wings) w.visible = false;
  }

  /** Off to somewhere along the edge well away from the boat. */
  private takeOff(boat: Vector3, spots: Spot[], rng: Rng): void {
    const free = spots.filter((s) => !s.busy && Math.hypot(boat.x - s.x, boat.z - s.z) > 60);
    if (!free.length) return;
    this.flyTo(free[rng.int(0, free.length - 1)]);
  }

  private flyTo(next: Spot): void {
    this.next = next;
    this.spot.busy = false;
    this.next.busy = true;
    this.from.copy(this.group.position);
    this.to.set(this.next.x, this.next.y, this.next.z);
    this.duration = Math.max(4, this.from.distanceTo(this.to) / 5.5);
    this.t = 0;
    this.flying = true;
    for (const w of this.wings) w.visible = true;
  }
}

/** How thickly the painted rafts cover (x, z): patchy, in water deep enough, clear of the boat's way. */
function carpetCover(x: number, z: number): number {
  const e = bilReach(x, z);
  if (e > 0.99) return 0;
  const { a, c } = bilLocal(x, z);
  return (
    smoothstep(0.38, 0.52, fbm(a * 0.028 + 5, c * 0.028, 3, 91)) *
    smoothstep(0.2, 0.45, bilDepth(x, z)) *
    smoothstep(0.985, 0.9, e) *
    smoothstep(9, 16, routeGap(x, z))
  );
}

/** A mesh over the bil whose painted pads show where `carpetCover` says; its colours' alpha carries the cover. */
function carpetGeometry(): BufferGeometry {
  const STEP = 3;
  // a grid along the bil's long axis (j) and across it (i)
  const a0 = -BIL.halfLen * 1.35;
  const c0 = -BIL.halfWid * 1.4;
  const nz = Math.ceil((BIL.halfLen * 2.7) / STEP) + 1;
  const nu = Math.ceil((BIL.halfWid * 2.8) / STEP) + 1;
  const pos = new Float32Array(nz * nu * 3);
  const uv = new Float32Array(nz * nu * 2);
  const col = new Float32Array(nz * nu * 4);
  const nrm = new Float32Array(nz * nu * 3);
  const bed = new Float32Array(nz * nu);
  const cover = new Float32Array(nz * nu);
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nu; i++) {
      const { x, z } = bilPoint(a0 + j * STEP, c0 + i * STEP);
      const k = j * nu + i;
      cover[k] = carpetCover(x, z);
      bed[k] = bilDepth(x, z);
      pos.set([x, 0.022, z], k * 3);
      uv.set([x / 6, z / 6], k * 2);
      col.set([1, 1, 1, cover[k]], k * 4);
      nrm.set([0, 1, 0], k * 3);
    }
  }
  const idx: number[] = [];
  for (let j = 0; j < nz - 1; j++) {
    for (let i = 0; i < nu - 1; i++) {
      const a = j * nu + i;
      const c = a + nu;
      if (Math.max(cover[a], cover[a + 1], cover[c], cover[c + 1]) < 0.05) continue;
      idx.push(a, c, a + 1, a + 1, c, c + 1);
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(pos, 3));
  g.setAttribute('normal', new BufferAttribute(nrm, 3));
  g.setAttribute('uv', new BufferAttribute(uv, 2));
  g.setAttribute('color', new BufferAttribute(col, 4));
  g.setAttribute('aBed', new BufferAttribute(bed, 1));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

/**
 * The lilies' life on the GPU: they float on the bil's water (BIL.level, raised or lowered by the season's
 * uWaterRise), and are not there where their bed lies too shallow (stranded where the water has drawn back); flowers open only in their months (G.uSeasonB.x); they ride the
 * bil's sheltered swell and the boat's wash spreading from her, and rock in the breeze.
 */
function lilyMotion(wash: Vector4, perVertex: boolean, flower = false): NonNullable<PatchOptions['vertex']> {
  // the waves as the bil's surface is drawn round them (waves.ts surfaceShare: still water, inland water's
  // share, dying out on the shallows)
  const s = (SHELTERED * INLAND).toFixed(4);
  return {
    key: perVertex ? 'lily-carpet' : flower ? 'lily-flower' : 'lily-plant',
    uniforms: { uWash: { value: wash } },
    pars: `uniform vec4 uWash;\nattribute float aBed;\n${waveHeightGlsl()}\n${waveSlopeGlsl()}\n`,
    code: /* glsl */ `
{
  #ifdef USE_INSTANCING
  mat4 lilyM = modelMatrix * instanceMatrix;
  #else
  mat4 lilyM = modelMatrix;
  #endif
  vec3 lilyOff = (lilyM * vec4(transformed, 0.0)).xyz;
  // each plant moves as one, about its own middle; the painted rafts bend with the water at every vertex
  vec3 lilyAt = ${perVertex ? '(lilyM * vec4(transformed, 1.0)).xyz' : '(lilyM * vec4(0.0, 0.0, 0.0, 1.0)).xyz'};
  ${perVertex ? 'lilyOff = vec3(0.0);' : ''}
  float lilyScale = length(lilyM[0].xyz);
  float lilyBed = aBed + uWaterRise;
  float lilyShare = ${s} * smoothstep(0.0, ${SHOAL_DEPTH.toFixed(2)}, lilyBed);
  vec2 toWash = lilyAt.xz - uWash.xy;
  float wd = length(toWash);
  float wa = 0.025 * min(uWash.z / 1.5, 1.2) * exp(-wd / 4.0);
  float wph = wd * 2.4 - uTime * 4.2;
  vec2 tilt = waveSlope(lilyAt.xz) * lilyShare + toWash / max(wd, 0.001) * wa * (2.4 * cos(wph) - 0.25 * sin(wph));
  tilt += uWind.xy * (0.02 * uWind.z) * sin(uTime * 1.7 + dot(lilyAt.xz, vec2(0.61, 0.37)));
  float lift = waveHeight(lilyAt.xz) * lilyShare + wa * sin(wph) + dot(tilt, lilyOff.xz);
  transformed.y += (lift + ${BIL.level.toFixed(3)} + uWaterRise) / lilyScale;
  ${
    perVertex
      ? '#ifdef USE_COLOR_ALPHA\n  vColor.a *= smoothstep(0.05, 0.2, lilyBed);\n  #endif'
      : `transformed *= smoothstep(0.03, 0.1, lilyBed)${flower ? ' * smoothstep(-0.05, 0.05, uSeasonB.x - hash12(floor(lilyAt.xz * 3.0)))' : ''};`
  }
}`,
  };
}

/** The bil's lilies, reeds, lotus and egrets, and the lilies' give as the boat goes through. */
export class Bil {
  readonly group = new Group();
  /** The hero boat for the shaders: x, z, speed through the water. */
  private readonly wash = new Vector4(0, 0, 0, 0);
  private readonly meshes: InstancedMesh[] = [];
  private readonly ax: Float32Array;
  private readonly az: Float32Array;
  private readonly px: Float32Array;
  private readonly pz: Float32Array;
  private readonly vx: Float32Array;
  private readonly vz: Float32Array;
  private readonly y0: Float32Array;
  private readonly yaw: Float32Array;
  private readonly scale: Float32Array;
  private readonly radius: Float32Array;
  private readonly slack: Float32Array;
  private readonly meshOf: Uint8Array;
  private readonly slot: Uint32Array;
  private readonly awake: Uint8Array;
  private readonly awakeList: number[] = [];
  private readonly cells = new Map<number, number[]>();
  private readonly lo: number[] = [];
  private readonly hi: number[] = [];
  private readonly spots: Spot[] = [];
  /** The water's rise the spots were found at. */
  private spotsRise = 0;
  private readonly egrets: Egret[] = [];
  private readonly rng = new Rng(404);
  private readonly m = new Matrix4();
  private readonly q = new Quaternion();
  private readonly p = new Vector3();
  private readonly sv = new Vector3();

  constructor() {
    this.group.name = 'bil';
    const rng = new Rng(77);
    const leafMat = patchMaterial(new MeshStandardMaterial({ vertexColors: true, roughness: 0.32, side: DoubleSide }), {
      grime: 0.25,
      vertex: lilyMotion(this.wash, false),
    });
    const flowerMat = patchMaterial(new MeshStandardMaterial({ vertexColors: true, roughness: 0.6, side: DoubleSide }), {
      translucency: 1.4,
      vertex: lilyMotion(this.wash, false, true),
    });

    // ---- the plants near the boat's way, one by one ----
    const xs: number[] = [];
    const zs: number[] = [];
    const kinds: number[] = [];
    const sizes: number[] = [];
    const slacks: number[] = [];
    const add = (x: number, z: number, kind: number, s: number, slack: number) => {
      xs.push(x);
      zs.push(z);
      kinds.push(kind);
      sizes.push(s);
      slacks.push(slack);
    };
    const flowerKind = () => {
      const r = rng.next();
      return r < 0.55 ? WHITE : r < 0.8 ? PINK : RED;
    };
    for (let r = 0; r < RAFTS && xs.length < MAX_PLANTS; r++) {
      // a raft's middle: anywhere out on the open water
      let cx = 0;
      let cz = 0;
      let found = false;
      for (let tries = 0; tries < 30 && !found; tries++) {
        const { x, z } = bilPoint(rng.range(-0.95, 0.95) * BIL.halfLen, rng.range(-0.95, 0.95) * BIL.halfWid);
        const d = bilDepth(x, z);
        if (bilReach(x, z) < 0.93 && d > 0.35 && d < 2.1 && routeGap(x, z) > 2.5) {
          cx = x;
          cz = z;
          found = true;
        }
      }
      if (!found) continue;
      // grown out from its middle, pads packed in a sunflower spiral, younger and smaller toward its rim
      const R = rng.range(2.2, 4.6);
      const count = Math.min(MAX_PLANTS - xs.length, Math.round(((Math.PI * R * R) / (SPACING * SPACING)) * rng.range(0.75, 1)));
      const turn = rng.range(0, Math.PI * 2);
      const stretch = rng.range(0.6, 1);
      for (let k = 0; k < count; k++) {
        const rr = R * Math.sqrt((k + 0.5) / count);
        const a = k * 2.39996 + turn;
        const x = cx + Math.cos(a) * rr + rng.range(-0.12, 0.12);
        const z = cz + Math.sin(a) * rr * stretch + rng.range(-0.12, 0.12);
        if (bilReach(x, z) > 0.985 || bilDepth(x, z) < 0.12) continue;
        // thinner along the boat's way, where boats have kept a lane open
        const g = routeGap(x, z);
        if (g < 1.4 || (g < 4.5 && rng.next() > smoothstep(1.4, 4.5, g))) continue;
        const roll = rng.next();
        if (roll < 0.07) add(x, z, flowerKind(), rng.range(1.0, 1.35), rng.range(0.12, 0.2));
        else if (roll < 0.1) add(x, z, BUD, rng.range(0.9, 1.3), rng.range(0.12, 0.2));
        else add(x, z, rng.next() < 0.5 ? PAD_A : PAD_B, rng.range(0.11, 0.21) * (1 - 0.25 * (rr / R)), rng.range(0.3, 0.55));
      }
    }
    // flowers and buds held up out of the painted rafts farther off
    for (let k = 0; k < 2400; k++) {
      const { x, z } = bilPoint(rng.range(-1, 1) * BIL.halfLen, rng.range(-1.3, 1.3) * BIL.halfWid);
      if (carpetCover(x, z) < 0.7 || rng.next() < 0.6) continue;
      if (rng.next() < 0.8) add(x, z, flowerKind(), rng.range(1.0, 1.35), 0.15);
      else add(x, z, BUD, rng.range(0.9, 1.3), 0.15);
    }

    // filed by z, so the plants about the boat sit together in each mesh's buffer
    const order = xs.map((_, i) => i).sort((a, b) => zs[a] - zs[b]);
    const n = order.length;
    this.ax = new Float32Array(n);
    this.az = new Float32Array(n);
    this.px = new Float32Array(n);
    this.pz = new Float32Array(n);
    this.vx = new Float32Array(n);
    this.vz = new Float32Array(n);
    this.y0 = new Float32Array(n);
    this.yaw = new Float32Array(n);
    this.scale = new Float32Array(n);
    this.radius = new Float32Array(n);
    this.slack = new Float32Array(n);
    this.meshOf = new Uint8Array(n);
    this.slot = new Uint32Array(n);
    this.awake = new Uint8Array(n);
    const counts = new Array<number>(KINDS).fill(0);
    const beds: number[][] = Array.from({ length: KINDS }, () => []);
    order.forEach((src, i) => {
      const kind = kinds[src];
      this.ax[i] = this.px[i] = xs[src];
      this.az[i] = this.pz[i] = zs[src];
      this.meshOf[i] = kind;
      this.slot[i] = counts[kind]++;
      beds[kind].push(bilDepth(xs[src], zs[src]));
      this.scale[i] = sizes[src];
      this.slack[i] = slacks[src];
      const pad = kind === PAD_A || kind === PAD_B;
      this.radius[i] = pad ? sizes[src] : 0.09;
      this.y0[i] = pad ? 0.03 : kind === BUD ? 0.04 : 0.035;
      this.yaw[i] = rng.range(0, Math.PI * 2);
      const key = cellKey(xs[src], zs[src]);
      let list = this.cells.get(key);
      if (!list) this.cells.set(key, (list = []));
      list.push(i);
    });
    const geometries = [
      padGeometry(rgb('#2b4c19'), rgb('#4f7c2a')),
      padGeometry(rgb('#35511b'), rgb('#6b7f30')),
      flowerGeometry(rgb('#f4f1ea'), rgb('#fbf8f0')),
      flowerGeometry(rgb('#e98aa8'), rgb('#f3b7c9')),
      flowerGeometry(rgb('#c2324a'), rgb('#e0566a')),
      budGeometry(),
    ];
    for (let k = 0; k < KINDS; k++) {
      geometries[k].setAttribute('aBed', new InstancedBufferAttribute(new Float32Array(beds[k].length ? beds[k] : [0]), 1));
      const mesh = new InstancedMesh(geometries[k], k <= PAD_B || k === BUD ? leafMat : flowerMat, Math.max(1, counts[k]));
      mesh.count = counts[k];
      mesh.instanceMatrix.setUsage(DynamicDrawUsage);
      mesh.layers.set(LAYER_NO_REFLECT);
      mesh.receiveShadow = true;
      this.meshes.push(mesh);
      this.lo.push(Infinity);
      this.hi.push(-1);
      this.group.add(mesh);
    }
    for (let i = 0; i < n; i++) this.write(i);
    for (const mesh of this.meshes) {
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
    }
    this.lo.fill(Infinity);
    this.hi.fill(-1);

    // ---- the painted rafts beyond ----
    const carpet = new Mesh(
      carpetGeometry(),
      patchMaterial(
        new MeshStandardMaterial({ map: lilyCarpetTexture(93), vertexColors: true, alphaTest: 0.5, alphaToCoverage: true, roughness: 0.34, side: DoubleSide }),
        { grime: 0.2, vertex: lilyMotion(this.wash, true) },
      ),
    );
    carpet.layers.set(LAYER_NO_REFLECT);
    carpet.receiveShadow = true;
    this.group.add(carpet);

    // ---- reeds along the edge, a stand of lotus ----
    const reedShapes = [0, 1, 2].map((i) => reedClump(new Rng(500 + i)));
    const reeds: Placement[][] = reedShapes.map(() => []);
    for (let k = 0; k < 9000 && reeds.reduce((a, l) => a + l.length, 0) < 420; k++) {
      const la = rng.range(-1.1, 1.1) * BIL.halfLen;
      const lc = rng.range(-1.4, 1.4) * BIL.halfWid;
      const { x, z } = bilPoint(la, lc);
      const e = bilReach(x, z);
      if (e < 0.88 || e > 1.03 || fbm(la * 0.02, lc * 0.02, 2, 97) < 0.45) continue;
      if (routeGap(x, z) < 12) continue;
      reeds[rng.int(0, reeds.length - 1)].push({ x, y: BIL.level - bilDepth(x, z) * 0.5, z, ry: rng.range(0, Math.PI * 2), s: rng.range(0.8, 1.2) });
    }
    const reedMat = patchMaterial(new MeshStandardMaterial({ vertexColors: true, roughness: 0.7, side: DoubleSide }), {
      wind: 0.12,
      windHeight: 1.8,
      translucency: 0.8,
    });
    reedShapes.forEach((g, i) => reeds[i].length && this.group.add(instanced(g, reedMat, reeds[i], { receive: true })));

    const leaves: Placement[] = [];
    const blooms: Placement[] = [];
    // the lotus stand to one side of the boat's way, a little in from where the khal comes in
    for (let k = 0; k < 900 && leaves.length < 160; k++) {
      const { x, z } = bilPoint(-40 + rng.range(-1, 1) * 16, -42 + rng.range(-1, 1) * 11);
      const d = bilDepth(x, z);
      if (d < 0.4 || bilReach(x, z) > 0.95) continue;
      if (routeGap(x, z) < 14) continue;
      if (rng.next() < 0.13) blooms.push({ x, y: BIL.level + rng.range(0.6, 0.95), z, ry: rng.range(0, Math.PI * 2), s: rng.range(0.9, 1.2) });
      else leaves.push({ x, y: BIL.level + rng.range(0.12, 0.6), z, ry: rng.range(0, Math.PI * 2), s: rng.range(0.24, 0.4), tx: rng.range(-0.25, 0.25), tz: rng.range(-0.25, 0.25) });
    }
    // the lotus's stalks grow with the water: its leaves and flowers stand as high above it in every season
    const lotusMat = patchMaterial(new MeshStandardMaterial({ vertexColors: true, roughness: 0.45, side: DoubleSide }), {
      wind: 0.06,
      windHeight: 0.6,
      translucency: 1.1,
      vertex: {
        key: 'lotus-rise',
        pars: '',
        code: `transformed.y += uWaterRise / length((modelMatrix * instanceMatrix)[0].xyz);`,
      },
    });
    if (leaves.length) this.group.add(instanced(lotusLeaf(), lotusMat, leaves, { receive: true }));
    if (blooms.length) this.group.add(instanced(lotusFlower(), lotusMat, blooms, { receive: true }));

    // ---- egrets wading in the shallows ----
    this.findSpots(true);
    const egretMat = patchMaterial(new MeshStandardMaterial({ vertexColors: true, roughness: 0.75, side: DoubleSide }), { translucency: 0.6 });
    const body = egretBody();
    const neck = egretNeck();
    const wing = egretWing();
    const free = [...this.spots];
    for (let k = 0; k < EGRETS && free.length; k++) {
      const spot = free.splice(rng.int(0, free.length - 1), 1)[0];
      const egret = new Egret(body, neck, wing, egretMat, spot, rng);
      this.egrets.push(egret);
      this.group.add(egret.group);
    }
  }

  /**
   * Where an egret can wade: points round the edge where the water is between ankle and knee deep, at this
   * season's level (out over the drowned rim in the rains, in on the bil's bed in spring). `jump`: the water
   * moved all at once (a new season shown), so the egrets are put on their spots rather than flying there.
   */
  private findSpots(jump: boolean): void {
    for (const s of this.spots) s.busy = false;
    this.spots.length = 0;
    this.spotsRise = waterRise();
    const level = BIL.level + this.spotsRise;
    const rng = new Rng(91);
    for (let k = 0; k < 160 && this.spots.length < 18; k++) {
      const a = rng.range(0, Math.PI * 2);
      const da = Math.cos(a) * BIL.halfLen;
      const dc = Math.sin(a) * BIL.halfWid;
      const rim = bilPoint(da, dc);
      const edge = bilReach(rim.x, rim.z);
      for (let e = 1.6; e > 0.5; e -= 0.03) {
        const { x, z } = bilPoint((da * e) / edge, (dc * e) / edge);
        const bed = terrainHeight(x, z);
        const deep = level - bed;
        if (deep < 0.06 || deep > 0.32) continue;
        if (routeGap(x, z) >= 8) this.spots.push({ x, y: bed, z, busy: false });
        break;
      }
    }
    for (const egret of this.egrets) egret.reclaim(this.spots, jump);
  }

  /** `blade` and `bladeWet`: the paddle's blade (world) and how much of it is in the water. */
  update(dt: number, t: number, boat: BoatBody, blade: Vector3, bladeWet: number): void {
    this.wash.set(boat.pos.x, boat.pos.z, Math.max(0, boat.speed), 0);
    // the water has risen or fallen enough to move the shallows: the egrets find them again
    const moved = Math.abs(waterRise() - this.spotsRise);
    if (moved > 0.05) this.findSpots(moved > 0.2);
    const h = Math.min(dt, 1 / 30);
    const near = bilReach(boat.pos.x, boat.pos.z) < 1.15;
    if (h > 0 && (near || this.awakeList.length)) this.simulate(h, boat, blade, bladeWet > 0.3, near);
    for (const egret of this.egrets) egret.update(dt, t, boat.pos, boat.speed, this.spots, this.rng);
  }

  private simulate(h: number, boat: BoatBody, blade: Vector3, bladeIn: boolean, near: boolean): void {
    const { px, pz, vx, vz, ax, az } = this;
    if (near) {
      // wake the plants about her hull and her blade
      this.wakeAround(boat.pos.x, boat.pos.z, HALF_LEN + 3);
      if (bladeIn) this.wakeAround(blade.x, blade.z, 1.2);
    }
    const fx = Math.sin(boat.heading);
    const fz = Math.cos(boat.heading);
    const sx = Math.cos(boat.heading);
    const sz = -Math.sin(boat.heading);
    const damp = Math.exp(-h / DRAG_TAU);
    const speed = Math.max(0, boat.speed);
    const list = this.awakeList;
    for (let n = list.length - 1; n >= 0; n--) {
      const i = list[n];
      // the stem: slack over its root, pulling back beyond its length; the water's drag calms it all
      const dx = px[i] - ax[i];
      const dz = pz[i] - az[i];
      const d = Math.hypot(dx, dz);
      let fxs = -dx * RESTORE;
      let fzs = -dz * RESTORE;
      if (d > this.slack[i]) {
        const k = (STEM * (d - this.slack[i])) / d;
        fxs -= dx * k;
        fzs -= dz * k;
      }
      vx[i] = vx[i] * damp + fxs * h;
      vz[i] = vz[i] * damp + fzs * h;
      const ox = px[i];
      const oz = pz[i];
      let x = ox + vx[i] * h;
      let z = oz + vz[i] * h;
      const r = this.radius[i];
      let shove = 0;
      // her hull: whatever is inside her waterline is pushed out sideways and slides along her flank,
      // and her bow wave carries what is close a little farther
      const bx = x - boat.pos.x;
      const bz = z - boat.pos.z;
      const along = bx * fx + bz * fz;
      if (Math.abs(along) < HALF_LEN) {
        let across = bx * sx + bz * sz;
        const beam = heroBeamAtWater(along / HERO_HULL.len + 0.5) + r * 0.8;
        const out = Math.abs(across) - beam;
        if (out < 0) {
          const to = across < 0 ? -beam : beam;
          shove = Math.abs(to - across);
          across = to;
        } else if (out < 2) {
          const push = speed * 0.5 * h * (1 - out / 2);
          across += across < 0 ? -push : push;
          shove = push;
        }
        x = boat.pos.x + fx * along + sx * across;
        z = boat.pos.z + fz * along + sz * across;
      }
      // the blade drawn through the water
      if (bladeIn) {
        const dbx = x - blade.x;
        const dbz = z - blade.z;
        const db = Math.hypot(dbx, dbz);
        const reach = 0.3 + r;
        if (db < reach && db > 1e-6) {
          x = blade.x + (dbx / db) * reach;
          z = blade.z + (dbz / db) * reach;
          shove += reach - db;
        }
      }
      // a shove becomes motion, which the drag then calms; it also turns a pad a little on its stem
      vx[i] = (x - ox) / h;
      vz[i] = (z - oz) / h;
      this.yaw[i] += shove * (i % 2 ? 0.9 : -0.9);
      px[i] = x;
      pz[i] = z;
      // settled over its root after she has gone by: it sleeps
      if (d < 0.015 && Math.hypot(vx[i], vz[i]) < 0.02 && Math.hypot(x - boat.pos.x, z - boat.pos.z) > HALF_LEN + 4) {
        px[i] = ax[i];
        pz[i] = az[i];
        vx[i] = vz[i] = 0;
        this.awake[i] = 0;
        list[n] = list[list.length - 1];
        list.pop();
      }
      this.write(i);
    }
    for (let k = 0; k < KINDS; k++) {
      if (this.hi[k] < this.lo[k]) continue;
      const attr = this.meshes[k].instanceMatrix;
      attr.clearUpdateRanges();
      attr.addUpdateRange(this.lo[k] * 16, (this.hi[k] - this.lo[k] + 1) * 16);
      attr.needsUpdate = true;
      this.lo[k] = Infinity;
      this.hi[k] = -1;
    }
  }

  private wakeAround(x: number, z: number, r: number): void {
    for (let cx = Math.floor((x - r) / CELL); cx <= Math.floor((x + r) / CELL); cx++) {
      for (let cz = Math.floor((z - r) / CELL); cz <= Math.floor((z + r) / CELL); cz++) {
        const list = this.cells.get(cx * 100003 + cz);
        if (!list) continue;
        for (const i of list) {
          if (this.awake[i] || Math.hypot(this.px[i] - x, this.pz[i] - z) > r) continue;
          this.awake[i] = 1;
          this.awakeList.push(i);
        }
      }
    }
  }

  private write(i: number): void {
    const k = this.meshOf[i];
    const s = this.slot[i];
    this.q.setFromAxisAngle(UP, this.yaw[i]);
    this.m.compose(this.p.set(this.px[i], this.y0[i], this.pz[i]), this.q, this.sv.setScalar(this.scale[i]));
    this.meshes[k].setMatrixAt(s, this.m);
    if (s < this.lo[k]) this.lo[k] = s;
    if (s > this.hi[k]) this.hi[k] = s;
  }
}

function cellKey(x: number, z: number): number {
  return Math.floor(x / CELL) * 100003 + Math.floor(z / CELL);
}
