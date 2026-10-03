import {
  BufferAttribute,
  BufferGeometry,
  CylinderGeometry,
  DynamicDrawUsage,
  Euler,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  Quaternion,
  Sphere,
  SphereGeometry,
  Vector3,
} from 'three';
import type { Material } from 'three';
import { G } from '../core/globals';
import { Rng } from '../core/rng';
import { windAt } from '../env/wind';
import { MeshBuilder, rgb, taperedTube } from '../render/builder';
import { currentAt } from './boatPhysics';
import { waveHeight } from './waves';

// A ভেসাল জাল (lift net): a square net hung by its corners from four bamboo arms, which cross at a hub
// hanging from the tip of a long bamboo lever. The lever turns on a pivot; whoever works it pulls (or
// presses) its butt down to lift the net and lets it back up to drop the net in. The lever is a rigid body
// on its pivot, turned by its own weight, the counterweight at its butt, the arms at its tip, the net's
// load and the fisherman's force. The arms' cross swings under the tip like a pendulum. The net is cloth:
// particles joined by strings that pull but never push, heavy in the air and nearly weightless in the
// water, dragged by the current below the surface and the wind above it, lying on the bed where it
// reaches it. What the strings hold (the net's weight, and how hard the water holds it as it comes up)
// goes back into the lever, and so to the fisherman, and on a boat to the boat.

const GRAVITY = 9.81;
/** Nylon in water: the share of its weight left once the water bears the rest. */
const WET_WEIGHT = 0.12;
/** The share of the net's area that is string (what the water and the wind push on), and its drag coefficient. */
const SOLIDITY = 0.08;
const CD = 1.2;
const RHO_WATER = 1000;
const RHO_AIR = 1.2;
/** The inner strings are this much longer than the square they span, so the net hangs as a bag. */
const BAG = 1.2;
const SUBSTEPS = 2;
const ITERATIONS = 8;
/**
 * The cross of arms hangs from the tip on a short lashing that also holds it square: it swings as a
 * stiffened pendulum, natural frequency (Hz), damping in air, how much stiffer than its weight alone the
 * lashing makes it, and how far it can tip (rad).
 */
const SWING = { f: 0.55, zeta: 0.3, lashing: 3, max: 0.25 };
/** A fish weighs about this much (kg). */
const FISH_MASS = 0.08;

export interface LiftNetSpec {
  /** From the pivot to the tip, and to the butt (m). */
  tip: number;
  butt: number;
  /** kg: the lever (spread along it), the arms and hub at its tip, the counterweight at its butt, the net. */
  leverMass: number;
  armsMass: number;
  counterMass: number;
  netMass: number;
  /** Half the side of the square between the net's corners; the corners this far below the hub; the hub this far below the tip. */
  half: number;
  drop: number;
  hang: number;
  /** Particles along each side of the net. */
  cells: number;
  /** The lever's travel (rad, + lifts the tip); stops hold it beyond. */
  min: number;
  max: number;
  /** Two poles crossed in an X with a bar across their butts (a boat's net), rather than one. */
  twin: boolean;
}

export interface LiftNetMaterials {
  wood: Material;
  net: Material;
  rope: Material;
  fish: Material;
}

const BAMBOO = rgb('#8c7c50');
const BAMBOO_DARK = rgb('#6e5f3a');
const SACK = rgb('#8a7350');
const CORD = rgb('#5a4a32');
const UP = new Vector3(0, 1, 0);
/** The corners' places round the hub, in the order of the net's corner particles. */
const CORNER_SIGNS: readonly (readonly [number, number])[] = [
  [-1, -1],
  [1, -1],
  [-1, 1],
  [1, 1],
];

const tmpA = new Vector3();
const tmpB = new Vector3();
const tmpQ = new Quaternion();
const air = { x: 0, z: 0 };
const flow = { x: 0, z: 0 };

function smooth01(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/** The lever: one bamboo (with a counterweight of sacks under its butt), or two crossed with a bar for the hands. */
function leverGeometry(spec: LiftNetSpec): BufferGeometry {
  const { tip, butt } = spec;
  const b = new MeshBuilder();
  const bow = (p: Vector3, q: Vector3, lift: number) => p.clone().lerp(q, 0.5).add(new Vector3(0, lift, 0));
  if (spec.twin) {
    for (const s of [-1, 1]) {
      const p = new Vector3(s * 0.26, 0, -butt);
      const q = new Vector3(s * 0.05, 0, tip);
      taperedTube(b, [p, bow(p, q, 0.08), q], [0.055, 0.045, 0.032], 6, BAMBOO, 0.6);
    }
    taperedTube(b, [new Vector3(-0.38, 0.02, -butt + 0.06), new Vector3(0.38, 0.02, -butt + 0.06)], [0.032, 0.032], 6, BAMBOO_DARK);
  } else {
    const q = new Vector3(0, 0, tip);
    taperedTube(b, [new Vector3(0, 0, -butt), new Vector3(0, 0.05, 0), bow(new Vector3(), q, 0.12), q], [0.085, 0.075, 0.062, 0.045], 7, BAMBOO, 0.6);
    // lashings either side of the pivot and where the rope is tied
    for (const z of [-0.12, 0.12, -butt + 0.15]) taperedTube(b, [new Vector3(0, 0, z - 0.04), new Vector3(0, 0, z + 0.04)], [0.095, 0.095], 7, CORD);
  }
  if (spec.counterMass > 0) {
    const sack = new SphereGeometry(1, 9, 7);
    for (const [x, y, z, s] of [
      [0, -0.24, -butt + 0.32, 0.2],
      [0.1, -0.2, -butt + 0.6, 0.17],
      [-0.09, -0.22, -butt + 0.55, 0.16],
    ] as const) {
      b.add(sack, new Matrix4().makeTranslation(x, y, z).scale(new Vector3(s * 0.9, s, s * 1.2)), SACK);
    }
  }
  return b.build();
}

/** Four bamboos bowed down from the hub (the origin) to the net's corners, lashed at the hub. */
function armsGeometry(spec: LiftNetSpec): BufferGeometry {
  const b = new MeshBuilder();
  for (const [sx, sz] of CORNER_SIGNS) {
    const c = new Vector3(sx * spec.half, -spec.drop, sz * spec.half);
    const out = new Vector3(sx, 0, sz).normalize();
    const mid = c.clone().multiplyScalar(0.5).addScaledVector(out, spec.half * 0.12).add(new Vector3(0, spec.drop * 0.28, 0));
    const near = c.clone().multiplyScalar(0.18).add(new Vector3(0, spec.drop * 0.02, 0));
    taperedTube(b, [new Vector3(), near, mid, c], [0.045, 0.04, 0.032, 0.022], 5, BAMBOO, 0.6);
  }
  b.add(new SphereGeometry(0.09, 8, 6), new Matrix4().makeScale(1, 0.7, 1), CORD);
  return b.build();
}

export class LiftNet {
  readonly spec: LiftNetSpec;
  /** The lever's angle (rad, + tip up) and its rate. */
  theta: number;
  omega = 0;
  /** The fisherman's force on the butt (mount frame, N); whoever works the net sets it each frame. */
  readonly hand = new Vector3();
  /** The net's pull on the arms (world, N), smoothed. */
  readonly load = new Vector3();
  /** World points this frame. */
  readonly pivot = new Vector3();
  readonly tipAt = new Vector3();
  readonly buttAt = new Vector3();
  readonly hub = new Vector3();
  readonly corners = [new Vector3(), new Vector3(), new Vector3(), new Vector3()];
  /** The middle of the net's square (world), and the yaw its sides run along (the lever's). */
  readonly centre = new Vector3();
  yaw = 0;
  /** How hard the net's rim is cutting the surface now, and the water running out of it once it is up (≈ 0..1). */
  splash = 0;
  drip = 0;
  /** Share of the net under water. */
  wet = 1;
  /** Fish in the net; they show only out of the water. */
  catchCount = 0;
  /** The net was simulated this frame (near the camera), so floating plants can meet it. */
  simulated = false;

  /** In the mount's frame: the lever, turning about the mount's x axis. */
  readonly lever = new Group();
  /** In the world: the arms, the net, the hub's lashing, the fish. */
  readonly group = new Group();
  private readonly mount: Group;
  private readonly arms = new Group();
  private readonly hubCord: Mesh;
  private readonly netGeometry = new BufferGeometry();
  private readonly fish: InstancedMesh;
  private readonly bed: (x: number, z: number) => number;
  private readonly inertia: number;
  // the net's particles (world): positions, velocities, where each substep began, its extra weight (fish)
  private readonly n: number;
  private readonly count: number;
  private readonly px: Float32Array;
  private readonly py: Float32Array;
  private readonly pz: Float32Array;
  private readonly vx: Float32Array;
  private readonly vy: Float32Array;
  private readonly vz: Float32Array;
  private readonly sx: Float32Array;
  private readonly sy: Float32Array;
  private readonly sz: Float32Array;
  private readonly extra: Float32Array;
  private readonly inertial: Float32Array;
  private readonly lastWet: Float32Array;
  private readonly pinned: Uint8Array;
  private readonly links: Uint16Array;
  private readonly rest: Float32Array;
  private readonly pinIndex: readonly number[];
  private readonly bounds = new Sphere();
  // the arms' swing about their own x and z, and the tip's motion that drives it
  private swingX = 0;
  private swingZ = 0;
  private vSwingX = 0;
  private vSwingZ = 0;
  private readonly tipVel = new Vector3();
  private readonly lastTip = new Vector3();
  private readonly accel = new Vector3();
  private started = false;
  private readonly fishSlot: number[] = [];
  private readonly fishHop: number[] = [];
  private readonly fishVel: number[] = [];
  private readonly rng: Rng;
  // scratch
  private readonly mountQ = new Quaternion();
  private readonly mountInv = new Quaternion();
  private readonly yawQ = new Quaternion();
  private readonly yawInv = new Quaternion();
  private readonly armsQ = new Quaternion();
  private readonly gMount = new Vector3();
  private readonly loadMount = new Vector3();
  private readonly e = new Euler();
  private readonly m = new Matrix4();
  private readonly cornerFrom = [new Vector3(), new Vector3(), new Vector3(), new Vector3()];

  /**
   * `mount`: the pivot's frame (origin at the pivot, +z along the lever toward the tip, +y up); add it to the
   * scene, and `group` too. `bed(x, z)`: the riverbed's height round the net; `seed`: for the catch.
   */
  constructor(spec: LiftNetSpec, mount: Group, materials: LiftNetMaterials, bed: (x: number, z: number) => number, seed: number) {
    this.spec = spec;
    this.mount = mount;
    this.bed = bed;
    this.rng = new Rng(seed);
    this.theta = spec.min;
    const { tip, butt, leverMass, armsMass, counterMass, netMass } = spec;
    this.inertia = (leverMass * (tip ** 3 + butt ** 3)) / (3 * (tip + butt)) + counterMass * butt * butt + (armsMass + netMass) * tip * tip;

    // moving parts cast no shadow: the shadow map is redrawn only when the view moves on, and would hold
    // the lever where it was
    const leverMesh = new Mesh(leverGeometry(spec), materials.wood);
    leverMesh.receiveShadow = true;
    this.lever.add(leverMesh);
    mount.add(this.lever);
    const armsMesh = new Mesh(armsGeometry(spec), materials.wood);
    armsMesh.receiveShadow = true;
    this.arms.add(armsMesh);
    this.hubCord = new Mesh(new CylinderGeometry(0.012, 0.012, 1, 4, 1).translate(0, 0.5, 0), materials.rope);
    this.group.add(this.arms, this.hubCord);

    // ---- the net: an n × n grid; the rim is a rope from corner to corner, taut; the mesh inside is slack ----
    const n = (this.n = spec.cells);
    const count = (this.count = n * n);
    this.px = new Float32Array(count);
    this.py = new Float32Array(count);
    this.pz = new Float32Array(count);
    this.vx = new Float32Array(count);
    this.vy = new Float32Array(count);
    this.vz = new Float32Array(count);
    this.sx = new Float32Array(count);
    this.sy = new Float32Array(count);
    this.sz = new Float32Array(count);
    this.extra = new Float32Array(count);
    this.inertial = new Float32Array(count);
    this.lastWet = new Float32Array(count).fill(-99);
    const s0 = (2 * spec.half) / (n - 1);
    const links: number[] = [];
    const rest: number[] = [];
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        const i = r * n + c;
        if (c < n - 1) {
          links.push(i, i + 1);
          rest.push(r === 0 || r === n - 1 ? s0 : s0 * BAG);
        }
        if (r < n - 1) {
          links.push(i, i + n);
          rest.push(c === 0 || c === n - 1 ? s0 : s0 * BAG);
        }
      }
    }
    this.links = new Uint16Array(links);
    this.rest = new Float32Array(rest);
    this.pinIndex = [0, n - 1, (n - 1) * n, n * n - 1];
    this.pinned = new Uint8Array(count);
    for (const i of this.pinIndex) this.pinned[i] = 1;
    const g = this.netGeometry;
    const pos = new BufferAttribute(new Float32Array(count * 3), 3);
    pos.setUsage(DynamicDrawUsage);
    g.setAttribute('position', pos);
    g.setAttribute('normal', new BufferAttribute(new Float32Array(count * 3), 3));
    const uv = new Float32Array(count * 2);
    const repeat = spec.half * 0.9;
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) uv.set([(c / (n - 1)) * repeat, (r / (n - 1)) * repeat], (r * n + c) * 2);
    g.setAttribute('uv', new BufferAttribute(uv, 2));
    const idx: number[] = [];
    for (let r = 0; r < n - 1; r++) {
      for (let c = 0; c < n - 1; c++) {
        const a = r * n + c;
        idx.push(a, a + n, a + 1, a + 1, a + n, a + n + 1);
      }
    }
    g.setIndex(idx);
    g.boundingSphere = this.bounds;
    const netMesh = new Mesh(g, materials.net);
    netMesh.receiveShadow = true;
    this.group.add(netMesh);

    // ---- the catch: small silvery fish (puti, tengra) that flap in the bag once it is out ----
    const fishGeo = new SphereGeometry(1, 8, 5);
    fishGeo.scale(0.022, 0.04, 0.085);
    this.fish = new InstancedMesh(fishGeo, materials.fish, 8);
    this.fish.count = 0;
    this.fish.frustumCulled = false;
    this.group.add(this.fish);
  }

  /** Lever inertia about the pivot (kg·m²). */
  get moment(): number {
    return this.inertia;
  }

  /** How much one newton along `dir` (unit, mount frame) on the butt turns the lever (N·m per N, + lifts the tip). */
  handArm(dir: Vector3): number {
    return -this.spec.butt * (dir.y * Math.cos(this.theta) - dir.z * Math.sin(this.theta));
  }

  /** The turning moment on the lever (N·m, + lifts the tip) from its weights and the net's load (not the hand, not the stops). */
  passiveTorque(): number {
    const { tip, butt, leverMass, armsMass, counterMass } = this.spec;
    const c = Math.cos(this.theta);
    const s = Math.sin(this.theta);
    // a point r along the lever moves r·(0, cos θ, −sin θ) per radian
    const gd = this.gMount.y * c - this.gMount.z * s;
    const ld = this.loadMount.y * c - this.loadMount.z * s;
    return leverMass * ((tip - butt) / 2) * gd - counterMass * butt * gd + tip * (armsMass * gd + ld);
  }

  /**
   * The net's height under (x, z) (world), or null outside its square: read off the particles by where
   * they belong in the square round the hub (the bag draws them in a little, which this ignores).
   */
  heightAt(x: number, z: number): number | null {
    if (!this.started) return null;
    const { half } = this.spec;
    const dx = x - this.hub.x;
    const dz = z - this.hub.z;
    const c = Math.cos(this.yaw);
    const s = Math.sin(this.yaw);
    const lx = dx * c - dz * s;
    const lz = dx * s + dz * c;
    if (Math.abs(lx) >= half || Math.abs(lz) >= half) return null;
    const n = this.n;
    const fc = ((lx + half) / (2 * half)) * (n - 1);
    const fr = ((lz + half) / (2 * half)) * (n - 1);
    const c0 = Math.min(n - 2, Math.floor(fc));
    const r0 = Math.min(n - 2, Math.floor(fr));
    const u = fc - c0;
    const v = fr - r0;
    const i = r0 * n + c0;
    const py = this.py;
    const a = py[i] + (py[i + 1] - py[i]) * u;
    const b = py[i + n] + (py[i + n + 1] - py[i + n]) * u;
    return a + (b - a) * v;
  }

  /** Sets the lever at `theta`, still, with the net laid out afresh under its corners (a scene opening on it). */
  reset(theta: number): void {
    this.theta = theta;
    this.omega = 0;
    this.load.set(0, 0, 0);
    this.release();
    this.started = false;
  }

  /** Puts `k` fish in the net (as it comes up). */
  addCatch(k: number): void {
    this.extra.fill(0);
    this.fishSlot.length = 0;
    this.fishHop.length = 0;
    this.fishVel.length = 0;
    this.catchCount = Math.min(8, k);
    const n = this.n;
    for (let i = 0; i < this.catchCount; i++) {
      // in the middle of the bag, where the net is lowest
      const r = Math.round((n - 1) / 2 + this.rng.range(-n * 0.18, n * 0.18));
      const c = Math.round((n - 1) / 2 + this.rng.range(-n * 0.18, n * 0.18));
      const slot = r * n + c;
      this.fishSlot.push(slot);
      this.fishHop.push(0);
      this.fishVel.push(0);
      this.extra[slot] += FISH_MASS;
    }
  }

  /** Lets the catch go (the fish swim out as the net goes back in). */
  release(): void {
    this.catchCount = 0;
    this.extra.fill(0);
    this.fish.count = 0;
  }

  /** Steps the lever, the arms and the net. `time` drives the waves; with `full` false the net only follows its corners (far away). */
  update(dt: number, time: number, full: boolean): void {
    const h = Math.min(dt, 1 / 20);
    if (h <= 0) return;
    const { spec } = this;
    this.mount.updateWorldMatrix(true, false);
    this.mount.getWorldQuaternion(this.mountQ);
    this.mountInv.copy(this.mountQ).invert();
    this.gMount.set(0, -GRAVITY, 0).applyQuaternion(this.mountInv);
    this.loadMount.copy(this.load).applyQuaternion(this.mountInv);

    // ---- the lever on its pivot ----
    const steps = Math.max(1, Math.ceil(h * 120));
    const sh = h / steps;
    const I = this.inertia;
    // the water resists the arms and the net's rim where they are in it
    const inWater = this.cornersWet();
    const pull = this.hand.length();
    const arm = pull > 0 ? tmpA.copy(this.hand).divideScalar(pull) : tmpA.set(0, 0, 0);
    for (let k = 0; k < steps; k++) {
      let q = this.passiveTorque() + this.handArm(arm) * pull - I * (0.3 + 1.6 * inWater) * this.omega;
      if (this.theta < spec.min) q += I * (400 * (spec.min - this.theta) - 30 * Math.min(this.omega, 0));
      if (this.theta > spec.max) q += I * (400 * (spec.max - this.theta) - 30 * Math.max(this.omega, 0));
      this.omega += (q / I) * sh;
      this.theta += this.omega * sh;
    }
    this.lever.rotation.set(-this.theta, 0, 0);
    this.lever.updateMatrixWorld();

    // ---- the pivot, tip and butt; the hub under the tip ----
    this.mount.getWorldPosition(this.pivot);
    this.tipAt.set(0, 0, spec.tip).applyMatrix4(this.lever.matrixWorld);
    this.buttAt.set(0, 0, -spec.butt).applyMatrix4(this.lever.matrixWorld);
    const fwd = tmpA.set(0, 0, 1).applyQuaternion(this.mountQ);
    this.yaw = Math.atan2(fwd.x, fwd.z);
    this.yawQ.setFromAxisAngle(UP, this.yaw);
    this.yawInv.copy(this.yawQ).invert();
    if (!this.started) this.lastTip.copy(this.tipAt);
    const vel = tmpB.subVectors(this.tipAt, this.lastTip).divideScalar(h);
    this.accel.lerp(tmpA.subVectors(vel, this.tipVel).divideScalar(h), 1 - Math.exp(-h / 0.08));
    this.tipVel.copy(vel);
    this.lastTip.copy(this.tipAt);

    // the arms swing under the tip as a pendulum: left behind as it moves off, drawn after the net's drag
    const a = tmpA.copy(this.accel).applyQuaternion(this.yawInv);
    const lf = tmpB.copy(this.load).applyQuaternion(this.yawInv);
    const frame = (spec.armsMass + spec.netMass) * GRAVITY * SWING.lashing;
    const wantX = Math.max(-SWING.max, Math.min(SWING.max, a.z / GRAVITY - lf.z / frame));
    const wantZ = Math.max(-SWING.max, Math.min(SWING.max, -a.x / GRAVITY + lf.x / frame));
    const w = SWING.f * Math.PI * 2;
    const zeta = SWING.zeta + 0.9 * inWater;
    this.vSwingX += (w * w * (wantX - this.swingX) - 2 * zeta * w * this.vSwingX) * h;
    this.vSwingZ += (w * w * (wantZ - this.swingZ) - 2 * zeta * w * this.vSwingZ) * h;
    this.swingX += this.vSwingX * h;
    this.swingZ += this.vSwingZ * h;
    this.hub.copy(this.tipAt).addScaledVector(UP, -spec.hang);
    this.armsQ.copy(this.yawQ).multiply(tmpQ.setFromEuler(this.e.set(this.swingX, 0, this.swingZ)));
    this.arms.position.copy(this.hub);
    this.arms.quaternion.copy(this.armsQ);
    this.hubCord.position.copy(this.hub);
    this.hubCord.scale.set(1, spec.hang, 1);
    for (let k = 0; k < 4; k++) {
      this.cornerFrom[k].copy(this.corners[k]);
      const [cx, cz] = CORNER_SIGNS[k];
      this.corners[k].set(cx * spec.half, -spec.drop, cz * spec.half).applyQuaternion(this.armsQ).add(this.hub);
    }
    this.centre.copy(this.corners[0]).add(this.corners[3]).multiplyScalar(0.5);
    if (!this.started) {
      for (let k = 0; k < 4; k++) this.cornerFrom[k].copy(this.corners[k]);
      this.layNet();
      this.started = true;
    }
    // a tiny step (a still being set up) would turn the strings' corrections into huge forces
    this.simulated = full;
    if (full && h > 0.004) this.stepNet(h, time);
    else this.carryNet();
  }

  private cornersWet(): number {
    const level = G.uWaterLevel.value;
    let w = 0;
    for (const c of this.corners) if (c.y < level) w += 0.25;
    return w;
  }

  /** The net hanging slack under its corners, its belly sagging (or lying on the bed). */
  private layNet(): void {
    const n = this.n;
    const [c0, c1, c2, c3] = this.corners;
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        const a = r / (n - 1);
        const b = c / (n - 1);
        tmpA.copy(c0).lerp(c1, b).lerp(tmpB.copy(c2).lerp(c3, b), a);
        tmpA.y -= Math.sin(Math.PI * a) * Math.sin(Math.PI * b) * this.spec.half * 0.35;
        const i = r * n + c;
        this.px[i] = tmpA.x;
        this.py[i] = Math.max(tmpA.y, this.bed(tmpA.x, tmpA.z) + 0.04);
        this.pz[i] = tmpA.z;
      }
    }
    this.vx.fill(0);
    this.vy.fill(0);
    this.vz.fill(0);
  }

  /** Far away: the net moves with its corners, unsimulated. */
  private carryNet(): void {
    const d = tmpA.subVectors(this.corners[0], this.cornerFrom[0]).add(tmpB.subVectors(this.corners[3], this.cornerFrom[3])).multiplyScalar(0.5);
    for (let i = 0; i < this.count; i++) {
      this.px[i] += d.x;
      this.py[i] += d.y;
      this.pz[i] += d.z;
    }
    this.writeNet(false);
  }

  private stepNet(h: number, time: number): void {
    const { px, py, pz, vx, vy, vz, sx, sy, sz, count, links, rest, pinned, extra, inertial } = this;
    const mass = this.spec.netMass / count;
    // drag per particle, quadratic on its share of the string, with a little linear drag for slow creep
    const area = ((2 * this.spec.half * BAG) ** 2 * SOLIDITY) / count;
    const kWater = 0.5 * RHO_WATER * CD * area;
    const kAir = 0.5 * RHO_AIR * CD * area;
    // the water's surface, its current and the wind here (one sample: the net is small beside the waves)
    const surf = G.uWaterLevel.value + waveHeight(this.centre.x, this.centre.z, time);
    currentAt(this.centre.x, this.centre.z, flow);
    windAt(this.centre.x, this.centre.z, air);
    const sh = h / SUBSTEPS;
    let lx = 0;
    let ly = 0;
    let lz = 0;
    for (let s = 0; s < SUBSTEPS; s++) {
      const f = (s + 1) / SUBSTEPS;
      sx.set(px);
      sy.set(py);
      sz.set(pz);
      for (let i = 0; i < count; i++) {
        if (pinned[i]) continue;
        const under = smooth01(0.04, -0.04, py[i] - surf);
        // the fish weigh on the net only out of the water; the water bears most of the net's own weight
        const m = (inertial[i] = mass + extra[i] * (1 - under));
        vy[i] -= ((GRAVITY * (mass * (1 - (1 - WET_WEIGHT) * under) + extra[i] * (1 - under))) / m) * sh;
        // drag toward the moving water (slowed near the bank) or the air; implicit, so it never overshoots
        const mx = under * flow.x * 0.6 + (1 - under) * air.x;
        const mz = under * flow.z * 0.6 + (1 - under) * air.z;
        const rx = vx[i] - mx;
        const ry = vy[i];
        const rz = vz[i] - mz;
        const speed = Math.hypot(rx, ry, rz);
        const k = under * (kWater * speed + 0.4) + (1 - under) * kAir * speed;
        const keep = 1 / (1 + (sh * k) / m);
        vx[i] = rx * keep + mx;
        vy[i] = ry * keep;
        vz[i] = rz * keep + mz;
        px[i] += vx[i] * sh;
        py[i] += vy[i] * sh;
        pz[i] += vz[i] * sh;
      }
      // the corners go where the arms hold them
      for (let k = 0; k < 4; k++) {
        const i = this.pinIndex[k];
        tmpA.copy(this.cornerFrom[k]).lerp(this.corners[k], f);
        px[i] = tmpA.x;
        py[i] = tmpA.y;
        pz[i] = tmpA.z;
      }
      // strings pull, never push
      for (let it = 0; it < ITERATIONS; it++) {
        for (let l = 0; l < rest.length; l++) {
          const a = links[l * 2];
          const b = links[l * 2 + 1];
          const dx = px[b] - px[a];
          const dy = py[b] - py[a];
          const dz = pz[b] - pz[a];
          const d = Math.hypot(dx, dy, dz);
          if (d <= rest[l]) continue;
          const wa = 1 - pinned[a];
          const wb = 1 - pinned[b];
          const c = (d - rest[l]) / d / (wa + wb || 1);
          px[a] += dx * c * wa;
          py[a] += dy * c * wa;
          pz[a] += dz * c * wa;
          px[b] -= dx * c * wb;
          py[b] -= dy * c * wb;
          pz[b] -= dz * c * wb;
        }
      }
      // what the strings did to the free particles: between them it cancels, so the sum is what the arms
      // hold the net with; then the bed holds up what lies on it
      for (let i = 0; i < count; i++) {
        if (pinned[i]) continue;
        const nvx = (px[i] - sx[i]) / sh;
        const nvy = (py[i] - sy[i]) / sh;
        const nvz = (pz[i] - sz[i]) / sh;
        const m = inertial[i];
        lx -= (m * (nvx - vx[i])) / sh;
        ly -= (m * (nvy - vy[i])) / sh;
        lz -= (m * (nvz - vz[i])) / sh;
        const floor = this.bed(px[i], pz[i]) + 0.04;
        if (py[i] < floor) py[i] = floor;
        vx[i] = nvx;
        vy[i] = (py[i] - sy[i]) / sh;
        vz[i] = nvz;
      }
    }
    const kf = 1 - Math.exp(-h / 0.12);
    this.load.x += (lx / SUBSTEPS - this.load.x) * kf;
    this.load.y += (ly / SUBSTEPS - this.load.y) * kf;
    this.load.z += (lz / SUBSTEPS - this.load.z) * kf;

    // where it breaks the surface, and the water still running out of what has come up
    let wet = 0;
    let cutting = 0;
    let dripping = 0;
    for (let i = 0; i < count; i++) {
      const d = py[i] - surf;
      if (d < 0) {
        wet++;
        this.lastWet[i] = time;
      } else dripping += Math.exp(-(time - this.lastWet[i]) / 2.5);
      if (Math.abs(d) < 0.1) cutting += Math.abs(vy[i]);
    }
    this.wet = wet / count;
    this.splash += (Math.min(1.5, cutting / (this.n * 1.2)) - this.splash) * (1 - Math.exp(-h / 0.2));
    this.drip = Math.min(1, dripping / (count * 0.5));
    this.writeNet(true);
    this.placeFish(h, surf);
  }

  private writeNet(normals: boolean): void {
    const pos = this.netGeometry.getAttribute('position') as BufferAttribute;
    const arr = pos.array as Float32Array;
    for (let i = 0; i < this.count; i++) {
      arr[i * 3] = this.px[i];
      arr[i * 3 + 1] = this.py[i];
      arr[i * 3 + 2] = this.pz[i];
    }
    pos.needsUpdate = true;
    if (normals) this.netGeometry.computeVertexNormals();
    this.bounds.center.copy(this.hub);
    this.bounds.radius = this.spec.half * 1.7 + this.spec.drop;
  }

  /** The fish lie in the bag and flap once it is out of the water; under it they are free to swim off. */
  private placeFish(h: number, surf: number): void {
    let shown = 0;
    for (let k = 0; k < this.catchCount; k++) {
      const i = this.fishSlot[k];
      if (this.py[i] < surf + 0.05) continue;
      // now and then a flap throws it up off the mesh, twisting; it falls back
      this.fishVel[k] -= GRAVITY * h;
      this.fishHop[k] = Math.max(0, this.fishHop[k] + this.fishVel[k] * h);
      if (this.fishHop[k] === 0) {
        this.fishVel[k] = 0;
        if (this.rng.next() < h * 1.2) this.fishVel[k] = this.rng.range(0.7, 1.5);
      }
      const hop = this.fishHop[k];
      this.e.set(0, this.yaw + k * 1.7, Math.PI / 2 + hop * 14, 'YXZ');
      tmpA.set(this.px[i] + ((k % 3) - 1) * 0.07, this.py[i] + 0.03 + hop, this.pz[i] + ((k % 2) - 0.5) * 0.1);
      this.m.compose(tmpA, tmpQ.setFromEuler(this.e), tmpB.set(1, 1, 1));
      this.fish.setMatrixAt(shown++, this.m);
    }
    this.fish.count = shown;
    if (shown) this.fish.instanceMatrix.needsUpdate = true;
  }
}
