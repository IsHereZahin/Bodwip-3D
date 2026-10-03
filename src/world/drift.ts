import { BufferGeometry, DoubleSide, DynamicDrawUsage, Group, InstancedMesh, Matrix4, MeshStandardMaterial, Quaternion, Vector3 } from 'three';
import { G, LAYER_NO_REFLECT } from '../core/globals';
import { Rng } from '../core/rng';
import { MeshBuilder, mixRgb, rgb, scaleRgb, taperedTube, type RGB } from '../render/builder';
import { patchMaterial } from '../render/patch';
import { hyacinthLeafTexture } from '../render/textures';
import { currentAt, type BoatBody } from './boatPhysics';
import { CHARS, charHeight, halfWidth, riverX, terrainHeight } from './geography';
import { HERO_HULL, hullHalfWidthAt } from './hull';
import { waveHeight, waveSlope } from './waves';

// What the river carries: water hyacinth (kochuripana), each plant its own floating body, held to its
// neighbours in loose mats by tangled roots; and fallen leaves. Each is dragged toward the local current
// (and a touch downwind), bobs and tilts on the shared waves, turns with the current's shear, jostles its
// neighbours, runs aground and gathers along the banks, and is shouldered aside by the boat's hull and
// stirred by the paddle's blade, then eases back to the current's pace. Roots stretched too far let go, so
// the boat leaves a lane through a mat. Solved as position-based dynamics: stable at any frame rate.

const UP = new Vector3(0, 1, 0);
const PLANTS = 720;
const LEAVES = 160;
const N = PLANTS + LEAVES;
/** Floating things are kept this far behind and ahead of the viewer along the river (m). */
const BEHIND = 140;
const AHEAD = 620;
/** Seconds for a plant (or a leaf) to come to the current's speed after a shove. */
const DRAG_TAU = [1.6, 0.8];
/** Drift downwind, m/s at full wind. */
const WIND_DRIFT = [0.05, 0.03];
const WIND_DIR = { x: 0.55, z: -0.83 };
/** Roots let go when stretched past this many times their rest length. */
const SNAP = 2.2;
const CELL = 0.9;
const TABLE = 4096;
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
  private readonly radius = new Float32Array(N);
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
  private readonly cur = { x: 0, z: 0 };
  private readonly slope = { x: 0, z: 0 };
  private lastZ = Number.NaN;
  private viewSpeed = 0;
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

  /** `viewZ`: where the viewer is along the river; `boat`: the hull that parts them; `blade`: the paddle's blade (world). */
  update(dt: number, t: number, viewZ: number, boat: BoatBody, blade: Vector3): void {
    this.frame++;
    // which way the river moves past the viewer decides where newcomers drift in from; a jump (a film
    // cut, the journey looping, a still being set up) scatters everything afresh round the new spot
    const jumped = Number.isNaN(this.lastZ) || Math.abs(viewZ - this.lastZ) > 60;
    if (jumped) this.viewSpeed = 0;
    else if (dt > 0) this.viewSpeed += ((viewZ - this.lastZ) / dt - this.viewSpeed) * Math.min(1, dt * 2);
    this.lastZ = viewZ;
    this.recycle(viewZ, jumped);
    const h = Math.min(dt, 0.05);
    if (h > 0) this.simulate(h, boat, blade);
    this.draw(t, boat);
  }

  private simulate(h: number, boat: BoatBody, blade: Vector3): void {
    const { px, pz, ox, oz, vx, vz } = this;
    const wind = G.uWind.value.z;
    // forces: the current's drag and the wind's push, then a step forward
    for (let i = 0; i < N; i++) {
      const leaf = i >= PLANTS ? 1 : 0;
      currentAt(px[i], pz[i], this.cur);
      const k = 1 - Math.exp(-h / DRAG_TAU[leaf]);
      vx[i] += (this.cur.x + WIND_DIR.x * WIND_DRIFT[leaf] * wind - vx[i]) * k;
      vz[i] += (this.cur.z + WIND_DIR.z * WIND_DRIFT[leaf] * wind - vz[i]) * k;
      // the current runs faster mid-river than at the edge: that shear turns what floats in it
      const hw = halfWidth(pz[i]);
      const u = (px[i] - riverX(pz[i])) / hw;
      this.spin[i] += ((0.85 * u) / hw - this.spin[i]) * Math.min(1, h * 0.5);
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
          const beam = hullHalfWidthAt(HERO_HULL, along / HERO_HULL.len + 0.5, 0) + this.radius[i] * 0.7;
          if (Math.abs(across) < beam) {
            const a = across < 0 ? -beam : beam;
            px[i] = boat.pos.x + fx * along + sx * a;
            pz[i] = boat.pos.z + fz * along + sz * a;
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
    // aground: a staggered quarter each frame (the terrain lookup is not cheap) is nudged back toward
    // open water and stopped there, so floaters collect along the banks the way they do
    for (let i = this.frame % 4; i < N; i += 4) {
      if (terrainHeight(px[i], pz[i]) > -0.12) {
        px[i] += Math.sign(riverX(pz[i]) - px[i]) * 0.08;
        ox[i] = px[i];
        oz[i] = pz[i];
      }
    }
    // velocities from where everything ended up: a shove becomes motion, which the drag then calms
    for (let i = 0; i < N; i++) {
      vx[i] = (px[i] - ox[i]) / h;
      vz[i] = (pz[i] - oz[i]) / h;
      this.yaw[i] += this.spin[i] * h;
    }
  }

  /** Neighbours keep apart (they may overlap a little, as leaves interleave), found through a spatial hash. */
  private collide(): void {
    const { px, pz, head, next, radius } = this;
    const cell = (cx: number, cz: number) => ((Math.imul(cx, 73856093) ^ Math.imul(cz, 19349663)) >>> 0) & (TABLE - 1);
    head.fill(-1);
    for (let i = 0; i < N; i++) {
      const c = cell(Math.floor(px[i] / CELL), Math.floor(pz[i] / CELL));
      next[i] = head[c];
      head[c] = i;
    }
    for (let i = 0; i < N; i++) {
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

  /** Respawns mats and leaves that have left the window round the viewer. */
  private recycle(viewZ: number, jumped: boolean): void {
    const gone = (z: number) => Number.isNaN(z) || z > viewZ + BEHIND || z < viewZ - AHEAD;
    for (const mat of this.mats) {
      if (jumped || mat.members.every((i) => gone(this.pz[i]))) this.spawnMat(mat, viewZ, jumped);
    }
    for (let i = PLANTS; i < N; i++) {
      if (!jumped && !gone(this.pz[i])) continue;
      const [x, z] = this.spot(viewZ, jumped);
      this.px[i] = x;
      this.pz[i] = z;
      currentAt(x, z, this.cur);
      this.vx[i] = this.cur.x;
      this.vz[i] = this.cur.z;
    }
  }

  /** Open water where the river will bring a floater into view (or anywhere in the window, after a jump). */
  private spot(viewZ: number, anywhere: boolean): [number, number] {
    // the current runs toward −z under a metre a second: the boat outpaces it, a still viewer does not
    const fromAhead = this.viewSpeed < -0.8;
    for (let tries = 0; tries < 12; tries++) {
      const z = anywhere
        ? viewZ + this.rng.range(-AHEAD, BEHIND)
        : fromAhead
          ? viewZ - this.rng.range(AHEAD * 0.45, AHEAD * 0.98)
          : viewZ + this.rng.range(BEHIND * 0.5, BEHIND * 0.95);
      const u = this.rng.sign() * halfWidth(z) * this.rng.range(0.03, 0.85);
      if (charHeight(z, u) > -0.8 || CHARS.some((c) => Math.abs(z - c.z) < c.halfLen && Math.abs(u - c.u) < c.halfWid + 6)) continue;
      return [riverX(z) + u, z];
    }
    const z = viewZ - AHEAD * 0.5;
    return [riverX(z), z];
  }

  /** Debug: moves the next `count` mats to (x, z) and round it, for watching the boat meet them. */
  placeMats(x: number, z: number, count: number): void {
    for (let k = 0; k < count && k < this.mats.length; k++) this.spawnMat(this.mats[k], 0, false, [x + (k % 2) * 2.5, z - k * 3.5]);
  }

  /** A fresh mat: its plants packed in a blob (sunflower spacing), each tied by its roots to its neighbours. */
  private spawnMat(mat: Mat, viewZ: number, anywhere: boolean, at?: [number, number]): void {
    const [cx, cz] = at ?? this.spot(viewZ, anywhere);
    const turn = this.rng.range(0, Math.PI * 2);
    const stretch = this.rng.range(0.6, 1);
    currentAt(cx, cz, this.cur);
    mat.members.forEach((i, k) => {
      const r = 0.34 * Math.sqrt(k + 0.5);
      const a = k * 2.39996 + turn;
      this.px[i] = cx + Math.cos(a) * r + this.rng.range(-0.05, 0.05);
      this.pz[i] = cz + Math.sin(a) * r * stretch + this.rng.range(-0.05, 0.05);
      this.vx[i] = this.cur.x;
      this.vz[i] = this.cur.z;
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

  /** Sets each floater on the shared waves (and in the boat's wash near her), tilted with the surface. */
  private draw(t: number, boat: BoatBody): void {
    const wind = G.uWind.value.z;
    const wash = Math.min(1, Math.max(0, boat.speed / 2));
    for (let i = 0; i < N; i++) {
      const x = this.px[i];
      const z = this.pz[i];
      let y = waveHeight(x, z, t, wind);
      const d = Math.hypot(x - boat.pos.x, z - boat.pos.z);
      if (d < 25) y += 0.03 * wash * Math.exp(-d / 5) * Math.sin(d * 2.4 - t * 4.2);
      waveSlope(x, z, t, wind, this.slope);
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
