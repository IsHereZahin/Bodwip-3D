import { BufferGeometry, DoubleSide, DynamicDrawUsage, Group, InstancedMesh, Matrix4, MeshStandardMaterial, Quaternion, Vector3 } from 'three';
import { LAYER_NO_REFLECT } from '../core/globals';
import { Rng } from '../core/rng';
import { MeshBuilder, mixRgb, rgb, scaleRgb, taperedTube, type RGB } from '../render/builder';
import { patchMaterial } from '../render/patch';
import { hyacinthLeafTexture } from '../render/textures';
import { windAt } from '../env/wind';
import type { BoatBody } from './boatPhysics';
import { PONDS, SALT_CREEK, WATER_LEVEL, inlandWaterAt, meanWaterLevelAt, pondReach, risenLevel, saltFarmAt, terrainHeight, waterLevelAt, waterwayAt } from './geography';
import { HERO_HULL, heroBeamAtWater, hullHalfWidthAt, type HullShape } from './hull';
import { wakeHeight } from './wake';
import { INLAND, SHELTERED, waveHeightSlope } from './waves';

// Water hyacinth (kochuripana), each plant its own floating body, held to its neighbours in loose mats by
// tangled roots; and fallen leaves. It floats on the still fresh water round the viewer (the khal, the bil, the
// ponds: `inlandWaterAt`), as deep as it floats in; in the khal it is set down only in the slack water along
// its banks, its middle being the boats' way. Each drifts a
// little downwind, bobs on the ripples, jostles its neighbours, runs aground and gathers along the banks, and
// is shouldered aside by a hull and stirred by a paddle's blade, then settles. Roots stretched too far let
// go, so a boat leaves a lane through a mat. Solved as position-based dynamics: stable at any frame rate.

/** What else floating plants meet: other boats' hulls (by shape, place and heading), and posts standing in the water. */
export interface DriftObstacles {
  hulls: readonly { shape: HullShape; x: number; z: number; heading: number }[];
  posts: readonly { x: number; z: number; r: number }[];
}

const NO_OBSTACLES: DriftObstacles = { hulls: [], posts: [] };
/** The ponds kept clean (the mosque's). */
const KEPT = PONDS.filter((p) => p.kept);
const UP = new Vector3(0, 1, 0);
const PLANTS = 720;
const LEAVES = 160;
const N = PLANTS + LEAVES;
/** Floating things are kept within this of the viewer (m); newcomers are set down within it. */
const REACH = 160;
/** They float only where the fresh water is at least this deep (m). */
const FLOATS = 0.25;
/** In the khals they are set down only within this of their banks (m), and within 0.4 of a narrow one's half: their middle is the boats' way. */
const EDGE = 3;
/** Frames a mat with no water to go to waits before it looks again. */
const RETRY = 45;
/** On still fresh water the ripples are this share of the open water's waves (as the water shader draws them: waves.ts surfaceShare). */
const RIPPLES = SHELTERED * INLAND;
/** Seconds for a plant (or a leaf) to come to the current's speed after a shove. */
const DRAG_TAU = [1.6, 0.8];
/** Drift downwind, m/s at full wind. */
/** How much of the wind's speed a plant (its leaves catch the air) and a loose leaf drift at. */
const WIND_DRIFT = [0.0125, 0.0075];
/** Roots let go when stretched past this many times their rest length. */
const SNAP = 2.2;
const CELL = 0.9;
const TABLE = 4096;
/**
 * The steepest the ground rises toward a floater (m a m, a bank's face with room to spare): one that floated
 * `clear` m over the ground where last measured cannot run aground before it has moved `clear / STEEPEST`.
 */
const STEEPEST = 3;
/**
 * Within this of the viewer (m) a floater is set on the waves every frame; farther off, where its bobbing of a
 * few millimetres is less than a pixel, every FAR_EVERY frames, each on its own.
 */
const NEAR = 40;
const FAR_EVERY = 4;
const HALF_LEN = HERO_HULL.len / 2;

const COLORS = {
  stalk: rgb('#9cc46a'),
  root: rgb('#160d10'),
  yellow: rgb('#d8b44a'),
  brown: rgb('#8a6438'),
  lilac: rgb('#c3a8ee'),
  violet: rgb('#5a2f9a'),
  eye: rgb('#f2cf3a'),
};
/** Petals and fallen leaves sample the texture's white corner; everything else its leaf. */
const WHITE_UV = 0.035;

/** A leaf blade: rounded, cupped, its rim curling up; drawn as a disc on the leaf texture. */
function blade(b: MeshBuilder, at: Vector3, facing: Vector3, r: number, color: RGB): void {
  const u = new Vector3().crossVectors(facing, Math.abs(facing.y) < 0.95 ? UP : new Vector3(1, 0, 0)).normalize();
  const v = new Vector3().crossVectors(facing, u).normalize();
  const c = b.vertex(at.clone().addScaledVector(facing, -r * 0.12), facing, 0.5, 0.5, color);
  const RIM = 14;
  const rim: number[] = [];
  for (let k = 0; k < RIM; k++) {
    const t = (k / RIM) * Math.PI * 2;
    // a little longer than wide, a blunt point at the tip
    const rr = r * (1 + 0.12 * Math.max(0, Math.sin(t)));
    const p = at.clone().addScaledVector(u, Math.cos(t) * rr * 0.92).addScaledVector(v, Math.sin(t) * rr).addScaledVector(facing, r * 0.18);
    const n = facing.clone().addScaledVector(u, Math.cos(t) * 0.45).addScaledVector(v, Math.sin(t) * 0.45).normalize();
    rim.push(b.vertex(p, n, 0.5 + Math.cos(t) * 0.45, 0.5 + Math.sin(t) * 0.45, color));
  }
  for (let k = 0; k < RIM; k++) b.tri(c, rim[k], rim[(k + 1) % RIM]);
}

type Variant = 'plant' | 'flowering' | 'yellowing';

/**
 * One water-hyacinth plant: swollen spongy stalks fanning out (the floats), a glossy leaf on each, the
 * outer leaves lying back and the inner ones upright, dark roots hanging below; sometimes a flower spike.
 */
function plantGeometry(seed: number, variant: Variant): BufferGeometry {
  const rng = new Rng(seed);
  const b = new MeshBuilder();
  const n = rng.int(6, 10);
  for (let k = 0; k < n; k++) {
    const az = (k / n) * Math.PI * 2 + rng.range(-0.3, 0.3);
    const out = new Vector3(Math.cos(az), 0, Math.sin(az));
    const outer = k < n * 0.6;
    const dying = variant === 'yellowing' && k < 3;
    const len = outer ? rng.range(0.13, 0.22) : rng.range(0.16, 0.26);
    const base = out.clone().multiplyScalar(0.02);
    const tip = base.clone().addScaledVector(out, len * (outer ? 0.75 : 0.35)).addScaledVector(UP, len * (outer ? 0.55 : 1.0));
    const mid = base.clone().lerp(tip, 0.4).addScaledVector(out, 0.02);
    taperedTube(b, [base, mid, tip], [0.016, dying ? 0.02 : 0.032, 0.008], 5, dying ? COLORS.brown : COLORS.stalk, 1);
    const facing = out.clone().multiplyScalar(outer ? 0.75 : 0.35).add(UP).normalize();
    const color = dying ? mixRgb(COLORS.yellow, COLORS.brown, rng.next()) : scaleRgb([1, 1, 1], rng.range(0.85, 1.12));
    const r = (outer ? rng.range(0.055, 0.08) : rng.range(0.065, 0.095)) * (dying ? 0.85 : 1);
    blade(b, tip.clone().addScaledVector(facing, 0.01), facing, r, color);
  }
  // roots: a dark tangle hanging under the water; seen through the shallows it grounds the plant
  const roots = b.vertexCount;
  const R = 8;
  for (let j = 0; j <= 3; j++) {
    const t = j / 3;
    const rad = 0.1 * Math.sin(Math.PI * Math.min(1, 0.2 + t * 0.85)) + 0.02;
    for (let k = 0; k <= R; k++) {
      const a = (k / R) * Math.PI * 2;
      b.vertex(new Vector3(Math.cos(a) * rad, -0.01 - t * 0.22, Math.sin(a) * rad), new Vector3(Math.cos(a), -0.3, Math.sin(a)).normalize(), 0.5, 0.95, COLORS.root);
    }
  }
  for (let j = 0; j < 3; j++) {
    for (let k = 0; k < R; k++) {
      const a = roots + j * (R + 1) + k;
      b.quad(a, a + 1, a + R + 2, a + R + 1);
    }
  }
  if (variant === 'flowering') {
    const top = new Vector3(0, rng.range(0.3, 0.38), 0);
    taperedTube(b, [new Vector3(0, 0, 0), top], [0.011, 0.007], 5, COLORS.stalk, 1);
    for (let k = 0; k < 9; k++) {
      const p = top.clone().add(new Vector3(rng.range(-0.035, 0.035), -k * 0.016, rng.range(-0.035, 0.035)));
      const face = new Vector3(rng.range(-1, 1), 0.6, rng.range(-1, 1)).normalize();
      const u = new Vector3().crossVectors(face, UP).normalize();
      const v = new Vector3().crossVectors(face, u).normalize();
      const centre = b.vertex(p, face, WHITE_UV, 1 - WHITE_UV, COLORS.eye);
      for (let q = 0; q < 6; q++) {
        const a0 = (q / 6) * Math.PI * 2;
        // the upper petal carries a violet patch round the yellow eye
        const col = q === 1 ? COLORS.violet : COLORS.lilac;
        const s = 0.024;
        const p0 = b.vertex(p.clone().addScaledVector(u, Math.cos(a0 - 0.45) * s).addScaledVector(v, Math.sin(a0 - 0.45) * s), face, WHITE_UV, 1 - WHITE_UV, col);
        const p1 = b.vertex(p.clone().addScaledVector(u, Math.cos(a0 + 0.45) * s).addScaledVector(v, Math.sin(a0 + 0.45) * s), face, WHITE_UV, 1 - WHITE_UV, col);
        b.tri(centre, p0, p1);
      }
    }
  }
  return b.build();
}

/** A fallen leaf, curled a little, yellowing. */
function leafGeometry(): BufferGeometry {
  const b = new MeshBuilder();
  const SEG = 6;
  const left: number[] = [];
  const right: number[] = [];
  for (let i = 0; i <= SEG; i++) {
    const t = i / SEG;
    const w = Math.sin(Math.PI * t) * 0.045;
    const curl = Math.sin(Math.PI * t) * 0.01;
    const c = mixRgb(COLORS.yellow, COLORS.brown, t);
    left.push(b.vertex(new Vector3(-w, curl, (t - 0.5) * 0.16), UP, WHITE_UV, 1 - WHITE_UV, c));
    right.push(b.vertex(new Vector3(w, curl, (t - 0.5) * 0.16), UP, WHITE_UV, 1 - WHITE_UV, c));
  }
  for (let i = 0; i < SEG; i++) b.quad(left[i], right[i], right[i + 1], left[i + 1]);
  return b.build();
}

interface Mat {
  members: number[];
  links: { a: number; b: number; rest: number; alive: boolean }[];
}

export class Drift {
  readonly group = new Group();
  private readonly meshes: InstancedMesh[] = [];
  private readonly rng = new Rng(404);
  // one entry per floating thing: plants first, then leaves
  private readonly px = new Float32Array(N);
  private readonly pz = new Float32Array(N);
  private readonly ox = new Float32Array(N);
  private readonly oz = new Float32Array(N);
  private readonly vx = new Float32Array(N);
  private readonly vz = new Float32Array(N);
  private readonly yaw = new Float32Array(N);
  private readonly spin = new Float32Array(N);
  /** The mean level of the water each floats on (still fresh water keeps its own), found when it is set down; the season raises it (risenLevel). */
  private readonly levelOf = new Float32Array(N);
  private readonly radius = new Float32Array(N);
  /** Where each was last measured against the ground, and the ground there (the aground check). */
  private readonly groundX = new Float32Array(N).fill(Number.NaN);
  private readonly groundZ = new Float32Array(N).fill(Number.NaN);
  private readonly ground = new Float32Array(N);
  /** Held up by a net that rose under it, and how high above the water. */
  private readonly scale = new Float32Array(N);
  private readonly meshOf = new Uint8Array(N);
  private readonly slot = new Uint16Array(N);
  private readonly mats: Mat[] = [];
  // spatial hash
  private readonly head = new Int32Array(TABLE);
  private readonly next = new Int32Array(N);
  private readonly m = new Matrix4();
  private readonly q = new Quaternion();
  private readonly qt = new Quaternion();
  private readonly p = new Vector3();
  private readonly s = new Vector3();
  private readonly axis = new Vector3();
  private readonly air = { x: 0, z: 0 };
  private readonly slope = { x: 0, z: 0 };
  private lastX = Number.NaN;
  private lastZ = Number.NaN;
  private frame = 0;

  constructor() {
    this.group.name = 'drift';
    const mat = patchMaterial(
      new MeshStandardMaterial({ map: hyacinthLeafTexture(31), vertexColors: true, roughness: 0.32, side: DoubleSide }),
      { translucency: 0.9, grime: 0.12 },
    );
    const variants: { geometry: BufferGeometry; share: number }[] = [
      { geometry: plantGeometry(1, 'plant'), share: 0.26 },
      { geometry: plantGeometry(2, 'plant'), share: 0.26 },
      { geometry: plantGeometry(3, 'plant'), share: 0.24 },
      { geometry: plantGeometry(4, 'flowering'), share: 0.12 },
      { geometry: plantGeometry(5, 'yellowing'), share: 0.12 },
    ];
    const counts = variants.map((v) => Math.round(v.share * PLANTS));
    counts[0] += PLANTS - counts.reduce((a, c) => a + c, 0);
    const kinds = [...variants.map((v, i) => ({ geometry: v.geometry, count: counts[i] })), { geometry: leafGeometry(), count: LEAVES }];
    let i = 0;
    kinds.forEach((kind, k) => {
      const im = new InstancedMesh(kind.geometry, mat, kind.count);
      im.instanceMatrix.setUsage(DynamicDrawUsage);
      im.frustumCulled = false;
      im.receiveShadow = true;
      im.layers.set(LAYER_NO_REFLECT);
      this.meshes.push(im);
      this.group.add(im);
      for (let s = 0; s < kind.count; s++, i++) {
        const leaf = k === kinds.length - 1;
        this.meshOf[i] = k;
        this.slot[i] = s;
        this.scale[i] = leaf ? this.rng.range(0.8, 1.3) : this.rng.range(0.85, 1.25);
        this.radius[i] = leaf ? 0.07 : 0.2 * this.scale[i];
        this.yaw[i] = this.rng.range(0, Math.PI * 2);
      }
    });
    // shuffle which kind of plant each body draws as, so every mat mixes them
    for (let k = PLANTS - 1; k > 0; k--) {
      const j = this.rng.int(0, k);
      const [mk, sk, rk, ck] = [this.meshOf[k], this.slot[k], this.radius[k], this.scale[k]];
      this.meshOf[k] = this.meshOf[j];
      this.slot[k] = this.slot[j];
      this.radius[k] = this.radius[j];
      this.scale[k] = this.scale[j];
      this.meshOf[j] = mk;
      this.slot[j] = sk;
      this.radius[j] = rk;
      this.scale[j] = ck;
    }
    // the plants grow in mats of a few to a score; the leaves float alone
    for (let k = 0; k < PLANTS; ) {
      const n = Math.min(PLANTS - k, this.rng.int(4, 20));
      this.mats.push({ members: Array.from({ length: n }, (_, j) => k + j), links: [] });
      k += n;
    }
    this.pz.fill(Number.NaN);
  }

  /**
   * `viewZ`: where the viewer is along the river; `boat`: the hull that parts them; `blade`: the paddle's
   * blade (world); `obstacles`: the other boats, posts and nets.
   */
  update(dt: number, t: number, view: Vector3, boat: BoatBody, blade: Vector3, obstacles: DriftObstacles = NO_OBSTACLES): void {
    this.frame++;
    // a jump (a film cut, the journey looping, a still being set up) scatters everything afresh round the new spot
    const jumped = Number.isNaN(this.lastX) || Math.hypot(view.x - this.lastX, view.z - this.lastZ) > 60;
    this.lastX = view.x;
    this.lastZ = view.z;
    this.recycle(view.x, view.z, jumped);
    const h = Math.min(dt, 0.05);
    if (h > 0) this.simulate(h, boat, blade, obstacles);
    this.draw(t, boat, view, jumped);
  }

  /** Pushes floater `i` out sideways from a hull's waterline, so it slides along her flank. */
  private keepOutOfHull(i: number, shape: HullShape, x: number, z: number, heading: number): void {
    const fx = Math.sin(heading);
    const fz = Math.cos(heading);
    const bx = this.px[i] - x;
    const bz = this.pz[i] - z;
    const along = bx * fx + bz * fz;
    if (Math.abs(along) >= shape.len / 2) return;
    const across = bx * fz - bz * fx;
    const beam = hullHalfWidthAt(shape, along / shape.len + 0.5, 0) + this.radius[i] * 0.7;
    if (Math.abs(across) >= beam) return;
    const a = across < 0 ? -beam : beam;
    this.px[i] = x + fx * along + fz * a;
    this.pz[i] = z + fz * along - fx * a;
  }

  private simulate(h: number, boat: BoatBody, blade: Vector3, obstacles: DriftObstacles): void {
    const { px, pz, ox, oz, vx, vz } = this;
    // forces: the current's drag and the wind's push, then a step forward
    for (let i = 0; i < N; i++) {
      if (Number.isNaN(pz[i])) continue;
      const leaf = i >= PLANTS ? 1 : 0;
      // still water: only the wind moves them, and they come to rest from a shove
      const k = 1 - Math.exp(-h / DRAG_TAU[leaf]);
      windAt(px[i], pz[i], this.air);
      vx[i] += (this.air.x * WIND_DRIFT[leaf] - vx[i]) * k;
      vz[i] += (this.air.z * WIND_DRIFT[leaf] - vz[i]) * k;
      this.spin[i] *= Math.exp(-h * 0.5);
      ox[i] = px[i];
      oz[i] = pz[i];
      px[i] += vx[i] * h;
      pz[i] += vz[i] * h;
    }

    // constraints: roots, neighbours, the hull, the blade
    const fx = Math.sin(boat.heading);
    const fz = Math.cos(boat.heading);
    const sx = Math.cos(boat.heading);
    const sz = -Math.sin(boat.heading);
    for (let iter = 0; iter < 2; iter++) {
      for (const mat of this.mats) {
        for (const l of mat.links) {
          if (!l.alive) continue;
          const dx = px[l.b] - px[l.a];
          const dz = pz[l.b] - pz[l.a];
          const d = Math.hypot(dx, dz);
          if (d > l.rest * SNAP) {
            l.alive = false;
            continue;
          }
          // tangled roots only pull: a mat can bunch up, but not drift apart
          if (d <= l.rest) continue;
          const c = ((d - l.rest) / d) * 0.5 * 0.35;
          px[l.a] += dx * c;
          pz[l.a] += dz * c;
          px[l.b] -= dx * c;
          pz[l.b] -= dz * c;
        }
      }
      this.collide();
      for (let i = 0; i < N; i++) {
        // the hull: anything inside her waterline is pushed out sideways, so it slides along her flank
        const bx = px[i] - boat.pos.x;
        const bz = pz[i] - boat.pos.z;
        const along = bx * fx + bz * fz;
        if (Math.abs(along) < HALF_LEN) {
          const across = bx * sx + bz * sz;
          const beam = heroBeamAtWater(along / HERO_HULL.len + 0.5) + this.radius[i] * 0.7;
          if (Math.abs(across) < beam) {
            const a = across < 0 ? -beam : beam;
            px[i] = boat.pos.x + fx * along + sx * a;
            pz[i] = boat.pos.z + fz * along + sz * a;
          }
        }
        // other boats' hulls, and posts standing in the water
        for (const hull of obstacles.hulls) this.keepOutOfHull(i, hull.shape, hull.x, hull.z, hull.heading);
        for (const post of obstacles.posts) {
          const dx = px[i] - post.x;
          const dz = pz[i] - post.z;
          const d = Math.hypot(dx, dz);
          const r = post.r + this.radius[i] * 0.7;
          if (d < r && d > 1e-6) {
            px[i] = post.x + (dx / d) * r;
            pz[i] = post.z + (dz / d) * r;
          }
        }
        // the blade drawn through the water shoves what it meets (not while it is swung through the air)
        const dbx = px[i] - blade.x;
        const dbz = pz[i] - blade.z;
        const db = Math.hypot(dbx, dbz);
        const reach = 0.32 + this.radius[i];
        if (blade.y < 0.05 && db < reach && db > 1e-6) {
          px[i] = blade.x + (dbx / db) * reach;
          pz[i] = blade.z + (dbz / db) * reach;
        }
      }
    }
    // aground: a staggered quarter each frame (the terrain lookup is not cheap) is stopped where it was, so
    // floaters collect along the banks the way they do
    for (let i = this.frame % 4; i < N; i += 4) {
      if (Number.isNaN(pz[i])) continue;
      const top = risenLevel(this.levelOf[i]) - 0.08;
      // (well afloat where last measured, and not moved far enough since to have reached a bank)
      if (top - this.ground[i] > Math.hypot(px[i] - this.groundX[i], pz[i] - this.groundZ[i]) * STEEPEST) continue;
      this.groundX[i] = px[i];
      this.groundZ[i] = pz[i];
      this.ground[i] = terrainHeight(px[i], pz[i]);
      if (this.ground[i] > top) {
        px[i] = ox[i];
        pz[i] = oz[i];
      }
    }
    // velocities from where everything ended up: a shove becomes motion, which the drag then calms
    for (let i = 0; i < N; i++) {
      if (Number.isNaN(pz[i])) continue;
      vx[i] = (px[i] - ox[i]) / h;
      vz[i] = (pz[i] - oz[i]) / h;
      this.yaw[i] += this.spin[i] * h;
    }
  }

  /**
   * Neighbours keep apart (they may overlap a little, as leaves interleave), found through a spatial hash. Those
   * waiting for water (NaN) are left out: they would all hash to one cell, and every one of them be measured
   * against every other each frame.
   */
  private collide(): void {
    const { px, pz, head, next, radius } = this;
    const cell = (cx: number, cz: number) => ((Math.imul(cx, 73856093) ^ Math.imul(cz, 19349663)) >>> 0) & (TABLE - 1);
    head.fill(-1);
    for (let i = 0; i < N; i++) {
      if (Number.isNaN(pz[i])) continue;
      const c = cell(Math.floor(px[i] / CELL), Math.floor(pz[i] / CELL));
      next[i] = head[c];
      head[c] = i;
    }
    for (let i = 0; i < N; i++) {
      if (Number.isNaN(pz[i])) continue;
      const cx = Math.floor(px[i] / CELL);
      const cz = Math.floor(pz[i] / CELL);
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          for (let j = head[cell(cx + dx, cz + dz)]; j >= 0; j = next[j]) {
            if (j <= i) continue;
            const ddx = px[j] - px[i];
            const ddz = pz[j] - pz[i];
            const min = (radius[i] + radius[j]) * 0.82;
            const d2 = ddx * ddx + ddz * ddz;
            if (d2 >= min * min || d2 < 1e-10) continue;
            const d = Math.sqrt(d2);
            const c = ((min - d) / d) * 0.5;
            px[i] -= ddx * c;
            pz[i] -= ddz * c;
            px[j] += ddx * c;
            pz[j] += ddz * c;
          }
        }
      }
    }
  }

  /**
   * Sets down afresh the mats and leaves that have left the round about the viewer. Those that found no water
   * look again every RETRY frames, each on its own frame of them (where there is little water most of them wait,
   * and all of them looking in the same frame stalled it).
   */
  private recycle(vx: number, vz: number, jumped: boolean): void {
    const gone = (i: number) => Number.isNaN(this.pz[i]) || Math.hypot(this.px[i] - vx, this.pz[i] - vz) > REACH + 20;
    const due = (k: number) => (this.frame + k) % RETRY === 0;
    this.mats.forEach((mat, k) => {
      const parked = Number.isNaN(this.pz[mat.members[0]]);
      if (jumped || (mat.members.every(gone) && (!parked || due(k)))) this.spawnMat(mat, vx, vz);
    });
    for (let i = PLANTS; i < N; i++) {
      if (!jumped && (!gone(i) || (Number.isNaN(this.pz[i]) && !due(i)))) continue;
      const at = this.spot(vx, vz);
      this.px[i] = at ? at[0] : Number.NaN;
      this.pz[i] = at ? at[1] : Number.NaN;
      if (at) this.levelOf[i] = meanWaterLevelAt(at[0], at[1]);
      this.vx[i] = 0;
      this.vz[i] = 0;
    }
  }

  /** Still fresh water deep enough to float on, somewhere round the viewer; null if none was found. */
  private spot(vx: number, vz: number): [number, number] | null {
    for (let tries = 0; tries < 16; tries++) {
      const a = this.rng.range(0, Math.PI * 2);
      const r = REACH * Math.sqrt(this.rng.next());
      const x = vx + Math.cos(a) * r;
      const z = vz + Math.sin(a) * r;
      if (!inlandWaterAt(x, z) || waterLevelAt(x, z) - terrainHeight(x, z) < FLOATS) continue;
      // in the khal (and on its way across the bil) they gather in the slack water along the banks, out of the
      // boats' way; none in the salt creek, whose water is the sea's
      const w = waterwayAt(x, z);
      if (w && (w.d < w.half - Math.min(EDGE, w.half * 0.4) || w.way === SALT_CREEK)) continue;
      // none on the pond the village keeps clean, nor in the salt farms' brine
      if (KEPT.some((p) => pondReach(p, x, z) < 1.3) || saltFarmAt(x, z, 2)) continue;
      return [x, z];
    }
    return null;
  }

  /** Debug: moves the next `count` mats to (x, z) and round it, for watching the boat meet them. */
  placeMats(x: number, z: number, count: number): void {
    for (let k = 0; k < count && k < this.mats.length; k++) this.spawnMat(this.mats[k], x, z, [x + (k % 2) * 2.5, z - k * 3.5]);
  }

  /** A fresh mat: its plants packed in a blob (sunflower spacing), each tied by its roots to its neighbours. */
  private spawnMat(mat: Mat, vx: number, vz: number, at?: [number, number]): void {
    const spot = at ?? this.spot(vx, vz);
    mat.links = [];
    if (!spot) {
      // no fresh water near: the mat waits, out of sight, and looks again a while later
      for (const i of mat.members) {
        this.px[i] = Number.NaN;
        this.pz[i] = Number.NaN;
      }
      return;
    }
    const [cx, cz] = spot;
    const level = meanWaterLevelAt(cx, cz);
    const turn = this.rng.range(0, Math.PI * 2);
    const stretch = this.rng.range(0.6, 1);
    mat.members.forEach((i, k) => {
      const r = 0.34 * Math.sqrt(k + 0.5);
      const a = k * 2.39996 + turn;
      this.px[i] = cx + Math.cos(a) * r + this.rng.range(-0.05, 0.05);
      this.pz[i] = cz + Math.sin(a) * r * stretch + this.rng.range(-0.05, 0.05);
      this.levelOf[i] = Number.isFinite(level) ? level : WATER_LEVEL;
      this.vx[i] = 0;
      this.vz[i] = 0;
    });
    mat.links = [];
    for (let x = 0; x < mat.members.length; x++) {
      for (let y = x + 1; y < mat.members.length; y++) {
        const a = mat.members[x];
        const b = mat.members[y];
        const d = Math.hypot(this.px[b] - this.px[a], this.pz[b] - this.pz[a]);
        if (d < (this.radius[a] + this.radius[b]) * 1.5) mat.links.push({ a, b, rest: d, alive: true });
      }
    }
  }

  /**
   * Sets each floater on the shared waves (and on the water the boat pushes aside), tilted with the surface;
   * `all`: every one now (after a jump, they are all somewhere new).
   */
  private draw(t: number, boat: BoatBody, view: Vector3, all: boolean): void {
    const ch = Math.cos(boat.heading);
    const sh = Math.sin(boat.heading);
    for (let i = 0; i < N; i++) {
      const x = this.px[i];
      const z = this.pz[i];
      if (Number.isNaN(z)) {
        // waiting for water: out of sight
        this.m.makeScale(0, 0, 0);
        this.meshes[this.meshOf[i]].setMatrixAt(this.slot[i], this.m);
        continue;
      }
      if (!all && (i + this.frame) % FAR_EVERY !== 0 && Math.abs(x - view.x) + Math.abs(z - view.z) > NEAR) continue;
      // on its water's ripples
      let y = risenLevel(this.levelOf[i]) + waveHeightSlope(x, z, t, this.slope, RIPPLES);
      const bx = x - boat.pos.x;
      const bz = z - boat.pos.z;
      if (Math.abs(bx) + Math.abs(bz) < 150) y += wakeHeight(bx * ch - bz * sh, bx * sh + bz * ch, boat.speed);
      const sl = Math.hypot(this.slope.x, this.slope.z);
      this.q.setFromAxisAngle(UP, this.yaw[i]);
      if (sl > 1e-5) {
        // the turn that takes 'up' to the surface's normal (−dh/dx, 1, −dh/dz)
        this.axis.set(-this.slope.z, 0, this.slope.x).normalize();
        this.qt.setFromAxisAngle(this.axis, Math.atan(sl));
        this.q.premultiply(this.qt);
      }
      this.m.compose(this.p.set(x, y + 0.004, z), this.q, this.s.setScalar(this.scale[i]));
      this.meshes[this.meshOf[i]].setMatrixAt(this.slot[i], this.m);
    }
    for (const mesh of this.meshes) mesh.instanceMatrix.needsUpdate = true;
  }
}
