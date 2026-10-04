import {
  BoxGeometry,
  CylinderGeometry,
  DoubleSide,
  Group,
  LatheGeometry,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  Quaternion,
  TorusGeometry,
  Vector2,
  Vector3,
} from 'three';
import type { BufferGeometry, Material } from 'three';
import { G } from '../core/globals';
import { clamp } from '../core/mathx';
import { Rng } from '../core/rng';
import { windAt } from '../env/wind';
import { MeshBuilder, rgb, scaleRgb, taperedTube } from '../render/builder';
import { patchMaterial } from '../render/patch';
import { netTexture, plankTexture } from '../render/textures';
import { Boatman, type Hold, type Outfit } from './boatman';
import { downstream, edgeHalfWidth, halfWidth, riverLane, riverX, terrainHeight } from './geography';
import { buildHull, hullHalfWidthAt, hullStation, type HullShape } from './hull';
import { LiftNet, type LiftNetMaterials, type LiftNetSpec } from './liftNet';
import { makeBodyDrive, type BodyDrive } from './paddle';
import type { DriftObstacles } from './drift';
import type { NetRipples } from './water';
import { hullWaves, type HullWaves } from './waves';

// The fishermen and their ভেসাল জাল. On the bank, a man on a low bamboo machan hauls a rope hand over hand
// to bring down the butt of a long lever that rises on a tall A-frame at the water's edge, and the net
// comes up out of the river on its four arms; he holds it while the catch flaps in the bag, then lets the
// rope run back through his hands and the net sinks again. Out in the river a fishing boat lies at anchor
// by her stern with two poles crossed over her bow; her fisherman leans on the bar across their butts to
// lift her net. Each works the lever as a person would (a target, a limit to his strength, a rhythm),
// and the lever's physics answers: the net is heavy coming up through the water and light once it drains,
// the boat dips her bow under its load. In the dry months, when the water under the bank's net is too
// shallow, it stays hoisted and idle.

/**
 * The bank nets along the boat's way down the channel, clear of the villages and the jetties (also framed by
 * the film tour). Where the channel's fishermen really set theirs is not mapped: the plan's fishing step
 * places them again.
 */
export const LIFT_NETS: readonly { z: number; side: 1 | -1 }[] = [
  { z: 6100, side: -1 },
  { z: 4700, side: 1 },
  { z: 2300, side: -1 },
  { z: -700, side: 1 },
];

/** Where the fishing boats ride at anchor: near which z, and on which side of the river's lane they prefer. */
const NET_BOATS: readonly { z: number; prefer: 1 | -1 }[] = [
  { z: 5300, prefer: -1 },
  { z: 1600, prefer: 1 },
];

const SHORE: LiftNetSpec = {
  tip: 9.5,
  butt: 3.2,
  leverMass: 24,
  armsMass: 13,
  counterMass: 55,
  netMass: 6,
  half: 3.6,
  drop: 2.0,
  hang: 0.5,
  cells: 13,
  min: -0.5,
  max: 0.45,
  twin: false,
};

const BOAT_NET: LiftNetSpec = {
  tip: 7.6,
  butt: 2.3,
  leverMass: 18,
  armsMass: 7,
  counterMass: 18,
  netMass: 4,
  half: 2.5,
  drop: 1.0,
  hang: 0.3,
  cells: 11,
  // the poles rest on the crutch's stop with the net soaking (the boat rises and falls with the water, so
  // that angle hardly changes)
  min: -0.1,
  max: 0.4,
  twin: true,
};

/** How deep the net's corners go when it soaks, and how high they come when it is up (m, from the water). */
const SHORE_SOAK = 1.0;
const SHORE_CLEAR = 2.6;
const BOAT_SOAK = 0.9;
const BOAT_CLEAR = 1.5;
/** The highest the tide comes (a spring high water on the monsoon's mean sea level: env/tide.ts, ≈2.7 m); the machans stand clear of it. */
const HIGH_WATER = 2.7;
/** The rope's butt end is at about head height (above the deck) when the net is up. */
const BUTT_UP = 1.8;
/** Below this depth of water under it, a bank net is not worth setting. */
const FISHABLE_DEPTH = 1.4;
/** Strength: how hard he can haul a rope with his weight behind it, or lean on a bar (N). */
const HAUL_MAX = 520;
const PUSH_MAX = 600;
/** Lever control: stiffness (1/s²) and damping (1/s) on angle and rate. */
const KP = 2.25;
const KD = 2.4;
/** The lever's rate coming up (rad/s) while the net is in the water and once it is out, and going down. */
const RATE_WET = 0.05;
const RATE_DRY = 0.12;
const RATE_DOWN = -0.07;
const MAN_MASS = 62;
const GRAVITY = 9.81;
/** Distances (camera to net) for simulating the net, the fisherman, anything at all, and for drawing the fisherman. */
const NEAR_NET = 260;
const NEAR_MAN = 160;
const ACTIVE = 700;
const SHOW_MAN = 220;
/** Beyond this the nets and boats are lost in the haze: not drawn at all. */
const SHOW_NET = 1100;

const FISH_HULL: HullShape = { len: 6.8, beam: 0.74, keelMid: -0.24, keelRise: 0.6, sheerMid: 0.36, sheerRise: 0.75 };
/** Her floor: boards laid just above the waterline, so no river shows inside her. */
const BOAT_FLOOR = 0.03;
/** The boat's pivot (boat frame): on a crutch above her bow. */
const BOAT_PIVOT = new Vector3(0, 1.15, FISH_HULL.len / 2 - 0.75);
/** Rode from her stern to the anchor (m); her swing round it (Hz, damping); pitch and roll stiffness (N·m/rad). */
const RODE = 9;
const SWING = { f: 0.03, zeta: 0.5 };
/** How fast a moored boat swings round to lie the other way when the tide turns (rad/s). */
const TURN_RATE = 0.12;
const PITCH_STIFF = 228000;
const ROLL_STIFF = 4000;
const HEAVE = { f: 1.3, zeta: 0.35 };
const PITCH = { f: 1.0, zeta: 0.3 };
const ROLL = { f: 0.6, zeta: 0.15 };

const SHORE_OUTFIT: Outfit = { lungi: ['#3d5a3a', '#d8d2b8', '#22301f'], vest: '#bdb6a2', gamchha: ['#b8862a', '#efe6d6', '#6a4410'], seed: 81 };
const BOAT_OUTFIT: Outfit = { lungi: ['#6a2a2e', '#dcd2bc', '#3a1416'], vest: '#cfc8b6', gamchha: ['#2a6a5a', '#efe6d6', '#123a30'], seed: 91 };

const BAMBOO = rgb('#8c7c50');
const BAMBOO_OLD = rgb('#7a6c48');
const SPLIT = rgb('#a89468');
const CORD = rgb('#5a4a32');
const UP = new Vector3(0, 1, 0);
const tmpA = new Vector3();
const tmpB = new Vector3();
const air = { x: 0, z: 0 };

const ease = (x: number) => x * x * (3 - 2 * x);

/** Height of the riverbed and bank round a point, sampled once on a grid (the net asks for it at every particle). */
function bedSampler(cx: number, cz: number, radius: number): (x: number, z: number) => number {
  const n = Math.ceil(radius) * 2 + 1;
  const x0 = cx - Math.ceil(radius);
  const z0 = cz - Math.ceil(radius);
  const h = new Float32Array(n * n);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) h[j * n + i] = terrainHeight(x0 + i, z0 + j);
  return (x, z) => {
    const fx = x - x0;
    const fz = z - z0;
    if (fx < 0 || fz < 0 || fx >= n - 1 || fz >= n - 1) return terrainHeight(x, z);
    const i = Math.floor(fx);
    const j = Math.floor(fz);
    const u = fx - i;
    const v = fz - j;
    const a = h[j * n + i] + (h[j * n + i + 1] - h[j * n + i]) * u;
    const b = h[(j + 1) * n + i] + (h[(j + 1) * n + i + 1] - h[(j + 1) * n + i]) * u;
    return a + (b - a) * v;
  };
}

// ---------- the bank net's layout ----------

interface ShorePlan {
  /** Across the river toward the water (unit), and its yaw. */
  out: Vector3;
  yaw: number;
  pivot: Vector3;
  /** The middle of the fisherman's feet on the machan. */
  stance: Vector3;
  /** The middle of the net when it soaks (at the year's mean water). */
  centre: Vector3;
  /** The A-frame's poles, each from its foot (driven into the bed or bank) to its head: two legs and a brace. */
  poles: [Vector3, Vector3][];
}

function shorePlan(site: { z: number; side: 1 | -1 }): ShorePlan {
  const [dx, dz] = downstream(site.z);
  const out = new Vector3(site.side * dz, 0, -site.side * dx);
  const edge = new Vector3(riverX(site.z) + site.side * edgeHalfWidth(site.z, site.side), 0, site.z);
  const inland = (d: number) => edge.clone().addScaledVector(out, -d);
  // the A-frame stands where the bank meets the water; the butt swings over the machan behind it
  const pivot = inland(2);
  const stance = inland(2 + SHORE.butt + 0.55);
  stance.y = Math.max(terrainHeight(stance.x, stance.z), HIGH_WATER + 0.25) + 0.3;
  // the pivot is as high as puts the butt at head height when the net is up: with the tip then at
  // T = (clear + drop + hang) above the water, butt = P − butt·(T − P)/tip, solved for P
  const T = SHORE_CLEAR + SHORE.drop + SHORE.hang;
  const k = SHORE.butt / SHORE.tip;
  pivot.y = (stance.y + BUTT_UP + T * k) / (1 + k);
  const down = Math.asin(clamp((-SHORE_SOAK + SHORE.drop + SHORE.hang - pivot.y) / SHORE.tip, -0.9, 0.9));
  const centre = pivot.clone().addScaledVector(out, SHORE.tip * Math.cos(down)).setY(1.1);
  // the A-frame: two legs splayed across the lever, driven into the bed, and a brace back to the bank
  const side = new Vector3().crossVectors(UP, out).normalize();
  const at = (s: number, o: number, y: number) => pivot.clone().addScaledVector(side, s).addScaledVector(out, o).setY(y);
  const footed = (v: Vector3, sink: number) => v.setY(terrainHeight(v.x, v.z) - sink);
  const poles: [Vector3, Vector3][] = [
    [footed(at(-1.15, -0.35, 0), 0.4), at(-0.12, 0, pivot.y + 0.18)],
    [footed(at(1.15, -0.35, 0), 0.4), at(0.12, 0, pivot.y + 0.18)],
    [footed(at(0, -2.4, 0), 0.2), at(0, -0.1, pivot.y + 0.1)],
  ];
  return { out, yaw: Math.atan2(out.x, out.z), pivot, stance, centre, poles };
}

/** Centre of a bank net's square, out over the water (for the film tour). */
export function liftNetCenter(net: { z: number; side: 1 | -1 }): Vector3 {
  return shorePlan(net).centre;
}

/** Places to keep trees off: each bank net's machan and A-frame. */
export function fishingClearings(): { x: number; z: number; r: number }[] {
  return LIFT_NETS.flatMap((n) => {
    const p = shorePlan(n);
    return [
      { x: p.stance.x, z: p.stance.z, r: 3.5 },
      { x: p.pivot.x, z: p.pivot.z, r: 2.5 },
    ];
  });
}

/** The A-frame and the machan, in the world, into `b`. */
function shoreStructure(b: MeshBuilder, p: ShorePlan, rng: Rng): void {
  const side = new Vector3().crossVectors(UP, p.out).normalize();
  const ground = (v: Vector3) => terrainHeight(v.x, v.z);
  const at = (base: Vector3, s: number, o: number, y: number) => base.clone().addScaledVector(side, s).addScaledVector(p.out, o).setY(y);
  // A-frame: its legs and brace (see shorePlan), an axle lashed at the legs' crossing
  const top = p.pivot.y;
  p.poles.forEach(([foot, head], i) => taperedTube(b, [foot, head], i < 2 ? [0.075, 0.06] : [0.06, 0.05], 6, BAMBOO_OLD, 0.6));
  taperedTube(b, [at(p.pivot, -0.42, 0, top - 0.11), at(p.pivot, 0.42, 0, top - 0.11)], [0.045, 0.045], 6, BAMBOO);
  taperedTube(b, [at(p.pivot, -0.16, 0, top - 0.11), at(p.pivot, 0.16, 0, top - 0.11)], [0.07, 0.07], 6, CORD);

  // the machan: four posts, two bearers, split-bamboo slats; he stands at its front edge
  const deck = p.stance.y;
  const middle = p.stance.clone().addScaledVector(p.out, -0.45);
  const q = new Quaternion().setFromAxisAngle(UP, p.yaw);
  for (const [s, o] of [
    [-0.8, -0.75],
    [0.8, -0.75],
    [-0.8, 0.75],
    [0.8, 0.75],
  ]) {
    const foot = at(middle, s, o, 0);
    foot.y = ground(foot) - 0.3;
    taperedTube(b, [foot, at(middle, s, o, deck + 0.08)], [0.05, 0.045], 5, BAMBOO_OLD);
  }
  for (const o of [-0.7, 0.7]) taperedTube(b, [at(middle, -0.9, o, deck - 0.06), at(middle, 0.9, o, deck - 0.06)], [0.04, 0.04], 5, BAMBOO);
  const slat = new BoxGeometry(1.75, 0.025, 0.15);
  for (let i = 0; i < 9; i++) {
    const c = at(middle, rng.range(-0.02, 0.02), -0.72 + i * 0.18, deck - 0.02);
    b.add(slat, new Matrix4().compose(c, q, new Vector3(1, 1, 1)), scaleRgb(SPLIT, rng.range(0.85, 1.05)));
  }
  // his khalui (fish basket) and the coiled tail of the rope
  const basket = new LatheGeometry(
    [
      [0.0, 0],
      [0.14, 0.01],
      [0.2, 0.12],
      [0.17, 0.3],
      [0.1, 0.36],
      [0.11, 0.4],
    ].map(([r, y]) => new Vector2(r, y)),
    12,
  );
  b.add(basket, new Matrix4().compose(at(p.stance, 0.62, -0.5, deck), q, new Vector3(1, 1, 1)), rgb('#8a7448'));
  const coil = new TorusGeometry(0.14, 0.018, 4, 14).rotateX(Math.PI / 2);
  for (let i = 0; i < 3; i++) b.add(coil, new Matrix4().makeTranslation(at(p.stance, -0.42 + i * 0.02, 0.05, deck + 0.02 + i * 0.03)), CORD);
}

// ---------- the fisherman's routine ----------

type Phase = 'soak' | 'haul' | 'hold' | 'lower';

/**
 * How a fisherman works a lift net: lets it soak a while, hauls it up (slowly while the water holds it,
 * faster once it drains), holds it while he looks over the catch, and lets it down again. He aims the lever
 * at an angle and a rate, as one does by feel, and his force is whatever that takes up to the limit of his
 * strength: the lever's physics decides how fast it actually comes.
 */
class Routine {
  phase: Phase = 'soak';
  force = 0;
  /** His force over his strength, 0..1. */
  effort = 0;
  /** He has run out of rope to pull and must change hands before he can haul on. */
  stalled = false;
  /** Last frame's lever arm for his force and the moment he aimed for (debug). */
  arm = 0;
  needed = 0;
  private timer: number;
  private target: number;
  private readonly rng: Rng;
  private readonly max: number;

  constructor(rng: Rng, max: number, start: number) {
    this.rng = rng;
    this.max = max;
    this.timer = rng.range(1, 14);
    this.target = start;
  }

  /** Soaking now, about to haul: the net is in the water and he will lift it in `delay` seconds. */
  haulSoon(down: number, delay: number): void {
    this.phase = 'soak';
    this.timer = delay;
    this.target = down;
  }

  /** `down`/`up`: the lever's angles for the net soaking and the net up; `dir`: his force's direction on the butt (unit, mount frame). */
  update(dt: number, net: LiftNet, down: number, up: number, dir: Vector3, fishable: boolean, plenty: number): void {
    this.timer -= dt;
    let rate = 0;
    switch (this.phase) {
      case 'soak':
        this.target = down;
        if (this.timer <= 0 || !fishable) {
          this.phase = 'haul';
          // more fish in the rains and after them
          if (fishable) net.addCatch(Math.round(this.rng.range(0, 3 + 5 * plenty)));
        }
        break;
      case 'haul':
        rate = this.stalled ? 0 : net.wet > 0.05 ? RATE_WET : RATE_DRY;
        this.target = Math.min(up, Math.max(this.target, net.theta - 0.04) + rate * dt);
        if (net.theta >= up - 0.015) {
          this.phase = 'hold';
          this.timer = this.rng.range(4, 8);
        }
        break;
      case 'hold':
        this.target = up;
        // a hoisted net in the dry months stays up
        if (this.timer <= 0 && fishable) this.phase = 'lower';
        break;
      case 'lower':
        rate = RATE_DOWN;
        this.target = Math.max(down, Math.min(this.target, net.theta + 0.04) + rate * dt);
        if (net.wet > 0.6) net.release();
        if (net.theta <= down + 0.015) {
          this.phase = 'soak';
          this.timer = this.rng.range(10, 24);
        }
        break;
    }
    const I = net.moment;
    const needed = -net.passiveTorque() + I * (KP * (this.target - net.theta) + KD * (rate - net.omega));
    const arm = (this.arm = net.handArm(dir));
    this.needed = needed;
    // soaking with the lever on its stop, he lets go of it
    const resting = this.phase === 'soak' && down <= net.spec.min + 0.03 && net.theta <= net.spec.min + 0.02;
    this.force = arm > 0.05 && !resting ? clamp(needed / arm, 0, this.max) : 0;
    this.effort = this.force / this.max;
    net.hand.copy(dir).multiplyScalar(this.force);
  }
}

/** The angle that puts the net's corners `rise` above the water (negative: below), for a pivot at `pivotY`. */
function angleFor(spec: LiftNetSpec, pivotY: number, rise: number): number {
  return Math.asin(clamp((G.uWaterLevel.value + rise + spec.drop + spec.hang - pivotY) / spec.tip, -0.95, 0.95));
}

function fisherman(stance: Vector3, radius: number, outfit: Outfit): Boatman {
  const man = new Boatman(stance, [radius, radius], outfit);
  man.group.name = 'fisherman';
  return man;
}

/** Aims a +y unit cylinder from `a` to `b`. */
function span(mesh: Mesh, a: Vector3, b: Vector3): void {
  const d = tmpA.subVectors(b, a);
  const len = d.length();
  mesh.visible = len > 1e-3;
  if (!mesh.visible) return;
  mesh.position.copy(a);
  mesh.quaternion.setFromUnitVectors(UP, d.divideScalar(len));
  mesh.scale.set(1, len, 1);
}

// ---------- a bank net ----------

interface RopeHand {
  grip: boolean;
  /** Along the rope from its butt end, while gripping. */
  d: number;
  /** Progress of a reach up the rope (0..1), and where it started. */
  t: number;
  from: Vector3;
  at: Vector3;
}

/** In front of his belly: where he draws the rope down to (station frame). */
const PULL_POINT = new Vector3(0, 0.92, 0.24);
/** The highest he grips the rope, above the deck. */
const GRIP_TOP = 1.95;

class ShoreNet {
  readonly net: LiftNet;
  readonly plan: ShorePlan;
  readonly routine: Routine;
  readonly man: Boatman;
  private readonly mount = new Group();
  private readonly station = new Group();
  private readonly stationInv = new Matrix4();
  private readonly yawInv = new Quaternion();
  private readonly rope: Mesh[] = [];
  private readonly hands: RopeHand[];
  private readonly holds: [Hold, Hold] = [
    { at: new Vector3(), thumb: new Vector3() },
    { at: new Vector3(), thumb: new Vector3() },
  ];
  private readonly drive: BodyDrive = makeBodyDrive();
  private readonly dir = new Vector3(0, -1, 0);
  private readonly butt = new Vector3();
  private readonly u = new Vector3();
  private readonly wind = new Vector3();
  private readonly gravity = new Vector3(0, -GRAVITY, 0);
  private readonly fishable: () => boolean;

  constructor(site: { z: number; side: 1 | -1 }, group: Group, materials: LiftNetMaterials, seed: number) {
    const p = (this.plan = shorePlan(site));
    this.mount.position.copy(p.pivot);
    this.mount.rotation.y = p.yaw;
    this.station.position.copy(p.stance);
    this.station.rotation.y = p.yaw;
    group.add(this.mount, this.station);
    this.station.updateMatrixWorld();
    this.stationInv.copy(this.station.matrixWorld).invert();
    this.yawInv.setFromAxisAngle(UP, -p.yaw);
    const bed = bedSampler(p.centre.x, p.centre.z, SHORE.half * 1.6 + 4);
    this.net = new LiftNet(SHORE, this.mount, materials, bed, seed);
    this.net.theta = angleFor(SHORE, p.pivot.y, -SHORE_SOAK);
    group.add(this.net.group);
    // set out the arms and the net where the lever puts them
    this.net.update(1 / 60, 0, false);
    const rng = new Rng(seed + 1);
    this.routine = new Routine(rng, HAUL_MAX, this.net.theta);
    this.fishable = () => G.uWaterLevel.value - bed(p.centre.x, p.centre.z) > FISHABLE_DEPTH;
    this.man = fisherman(new Vector3(), 0.012, SHORE_OUTFIT);
    this.station.add(this.man.group);
    for (let i = 0; i < 4; i++) {
      const m = new Mesh(new CylinderGeometry(0.011, 0.011, 1, 4, 1).translate(0, 0.5, 0), materials.rope);
      this.rope.push(m);
      this.station.add(m);
    }
    this.hands = [0.62, 0.3].map((e) => ({ grip: true, d: 0, t: 0, from: new Vector3(), at: new Vector3(0, 0.92 + e * 0.8, 0.3) }));
  }

  /** The net set soaking afresh, to be hauled in `delay` seconds. */
  haulSoon(delay: number): void {
    const down = angleFor(SHORE, this.plan.pivot.y, -SHORE_SOAK);
    this.net.reset(down);
    this.routine.haulSoon(down, delay);
  }

  update(dt: number, t: number, camera: Vector3): void {
    const d = camera.distanceTo(this.plan.centre);
    this.net.group.visible = this.mount.visible = d < SHOW_NET;
    this.man.group.visible = this.station.visible = d < SHOW_MAN;
    if (d > ACTIVE) {
      this.net.simulated = false;
      return;
    }
    const { net, routine } = this;
    const down = angleFor(SHORE, this.plan.pivot.y, -SHORE_SOAK);
    const up = angleFor(SHORE, this.plan.pivot.y, SHORE_CLEAR);
    routine.update(dt, net, down, up, this.dir, this.fishable(), G.uSeasonB.value.y);
    net.update(dt, t, d < NEAR_NET);
    if (d > NEAR_MAN) return;

    // the rope: from the butt end (station frame) down toward his belly
    this.butt.copy(net.buttAt).applyMatrix4(this.stationInv);
    const u = this.u.subVectors(PULL_POINT, this.butt);
    const length = u.length();
    u.divideScalar(length);
    if (routine.phase === 'haul') this.haul(dt, length);
    else this.slide(dt, length);
    // his pull runs down the rope from the butt toward the lower hand that grips
    let low = -1;
    this.hands.forEach((h, i) => {
      if (h.grip && (low < 0 || h.d > this.hands[low].d)) low = i;
    });
    if (low >= 0) this.dir.subVectors(this.hands[low].at, this.butt).normalize();
    this.hands.forEach((h, i) => {
      this.holds[i].at.copy(h.at);
      this.holds[i].thumb.copy(u).negate();
    });

    // his body: sitting back into the pull, hips back, turning with the hand that pulls; rising to reach up
    const e = routine.effort;
    const reach = Math.max(...this.hands.map((h) => clamp((h.at.y - 1.45) / 0.5, 0, 1)));
    const pulling = low >= 0 ? (low === 0 ? -1 : 1) : 0;
    this.drive.crouch = 0.03 + 0.13 * e - 0.03 * reach;
    this.drive.bend = -0.06 - 0.24 * e + 0.05 * reach;
    this.drive.shift = -0.04 - 0.07 * e;
    this.drive.twist = (routine.phase === 'haul' ? 0.16 : 0.05) * pulling * e;
    this.drive.lean = 0;
    windAt(this.plan.stance.x, this.plan.stance.z, air);
    this.wind.set(air.x, 0, air.z).applyQuaternion(this.yawInv);
    this.man.update(dt, t, this.drive, { holds: this.holds }, { rotX: 0, rotZ: 0 }, this.wind, this.gravity);

    // the rope: butt, through his hands, its tail sagging to the coil on the deck
    const pts = [this.butt.clone()];
    const gripping = this.hands.filter((h) => h.grip).sort((a, b) => a.d - b.d);
    for (const h of gripping) pts.push(h.at.clone());
    const last = pts[pts.length - 1];
    const coil = tmpB.set(-0.42, 0.08, 0.05);
    pts.push(last.clone().lerp(coil, 0.5).add(new Vector3(0.05, -0.2, 0.05)), coil.clone());
    for (let i = 0; i < this.rope.length; i++) {
      if (i < pts.length - 1) span(this.rope[i], pts[i], pts[i + 1]);
      else this.rope[i].visible = false;
    }
  }

  /**
   * Hand over hand: the hand that grips lower draws the rope down with it (fixed to the rope, so it moves
   * as the butt does); when it reaches his belly the other hand, already up, takes the rope and the lower
   * one lets go and reaches up above it.
   */
  private haul(dt: number, length: number): void {
    const { u, butt, hands } = this;
    const top = butt.y > GRIP_TOP ? (GRIP_TOP - butt.y) / u.y : 0.15;
    const dTop = clamp(top, 0.15, Math.max(0.15, length - 0.45));
    this.routine.stalled = false;
    const gripping = hands.filter((h) => h.grip);
    for (const h of hands) {
      if (h.grip) {
        h.at.copy(butt).addScaledVector(u, h.d);
        if (length - h.d < 0.2) {
          if (gripping.length === 2) {
            // the other hand has the rope: let go and reach up above it
            h.grip = false;
            h.t = 0;
            h.from.copy(h.at);
            gripping.splice(gripping.indexOf(h), 1);
          } else this.routine.stalled = true;
        }
      } else {
        h.t = Math.min(1, h.t + dt / 0.5);
        const goal = tmpA.copy(butt).addScaledVector(u, dTop);
        const k = ease(h.t);
        h.at.copy(h.from).lerp(goal, k);
        // up and round, clear of the rope and the other hand
        h.at.x += (hands.indexOf(h) === 0 ? -0.09 : 0.09) * Math.sin(Math.PI * k);
        h.at.z -= 0.08 * Math.sin(Math.PI * k);
        if (h.t >= 1) {
          h.grip = true;
          h.d = dTop;
        }
      }
    }
  }

  /** Holding or letting the rope run: his hands stay where they are on him and the rope slides through them. */
  private slide(dt: number, length: number): void {
    const k = 1 - Math.exp(-dt / 0.25);
    this.hands.forEach((h, i) => {
      const e = Math.min(i === 0 ? 0.62 : 0.3, length - 0.1);
      const goal = tmpA.copy(PULL_POINT).addScaledVector(this.u, -e);
      h.at.lerp(goal, h.grip ? k : Math.max(k, 0.2));
      h.grip = true;
      h.d = Math.max(0.1, h.at.distanceTo(this.butt));
    });
  }
}

// ---------- a fishing boat at anchor ----------

/** A small boat lying to an anchor by her stern: she swings slowly about it with the wind, and rides the waves. */
class Mooring {
  readonly pos = new Vector3();
  heading = 0;
  rotX = 0;
  rotZ = 0;
  private readonly anchor: { x: number; z: number };
  private swing = 0;
  private vSwing = 0;
  private heave = 0;
  private vHeave = 0;
  /** The sea's level at her last update: she rises and falls with the tide as it is. */
  private level: number;
  /** Which way she lies from her anchor: 0 down the channel (the ebb carries her), π up it (the flood). */
  private lie: number;
  private vPitch = 0;
  private vRoll = 0;
  private readonly waves: HullWaves = { heave: 0, along: 0, across: 0 };

  constructor(anchor: { x: number; z: number }) {
    this.anchor = anchor;
    this.lie = G.uFlowScale.value < 0 ? Math.PI : 0;
    this.place(0);
    this.heave = this.level = G.uWaterLevel.value;
  }

  private place(t: number): void {
    const [dx, dz] = downstream(this.anchor.z);
    const a = this.lie + this.swing + 0.05 * Math.sin(t * 0.047 + this.anchor.z);
    const c = Math.cos(a);
    const s = Math.sin(a);
    const ox = dx * c + dz * s;
    const oz = -dx * s + dz * c;
    const r = RODE + FISH_HULL.len / 2;
    this.pos.set(this.anchor.x + ox * r, this.pos.y, this.anchor.z + oz * r);
    this.heading = Math.atan2(ox, oz);
  }

  /** `pitchMoment` (N·m, bow down +) and `rollMoment` (N·m, +x side up +) from what is aboard. */
  update(dt: number, t: number, pitchMoment: number, rollMoment: number): void {
    const h = Math.min(dt, 1 / 20);
    // the wind across her pushes her round the anchor; the rode and the water bring her back
    const [dx, dz] = downstream(this.anchor.z);
    windAt(this.pos.x, this.pos.z, air);
    const across = air.x * dz - air.z * dx;
    const w = SWING.f * Math.PI * 2;
    this.vSwing += (-w * w * this.swing - 2 * SWING.zeta * w * this.vSwing + 0.0018 * across) * h;
    this.swing += this.vSwing * h;
    // the current carries her to lie downstream of her anchor, so she swings round as the tide turns
    const want = G.uFlowScale.value < 0 ? Math.PI : 0;
    this.lie += clamp(want - this.lie, -TURN_RATE * h, TURN_RATE * h);
    this.place(t);
    // she floats on the waves as her waterline feels them (see hullWaves)
    const under = hullWaves(this.pos.x, this.pos.z, this.heading, FISH_HULL.len * 0.8, FISH_HULL.beam * 1.7, t, 1, this.waves);
    this.heave += G.uWaterLevel.value - this.level;
    this.level = G.uWaterLevel.value;
    const level = G.uWaterLevel.value + under.heave;
    const pitch = -under.along + pitchMoment / PITCH_STIFF;
    const roll = under.across + rollMoment / ROLL_STIFF;
    const springTo = (x: number, v: number, to: number, p: { f: number; zeta: number }) => {
      const wn = p.f * Math.PI * 2;
      return v + (wn * wn * (to - x) - 2 * p.zeta * wn * v) * h;
    };
    this.vHeave = springTo(this.heave, this.vHeave, level, HEAVE);
    this.heave += this.vHeave * h;
    this.vPitch = springTo(this.rotX, this.vPitch, pitch, PITCH);
    this.rotX += this.vPitch * h;
    this.vRoll = springTo(this.rotZ, this.vRoll, roll, ROLL);
    this.rotZ += this.vRoll * h;
    this.pos.y = this.heave;
  }
}

/** Where to anchor near `z`: deep water to one side of the river's lane, off the chars and shoals. */
function anchorNear(z: number, prefer: 1 | -1): { x: number; z: number } {
  const lane = riverLane(z);
  const deep = (x: number, zz: number) => terrainHeight(x, zz) < -2.4;
  for (const sign of [prefer, -prefer]) {
    for (let off = 26; off < 90; off += 2) {
      const u = lane + sign * off;
      if (Math.abs(u) > halfWidth(z) - 14) break;
      const x = riverX(z) + u;
      // the boat and her net lie downstream of the anchor
      if (deep(x, z) && deep(x, z - 12) && deep(x, z - 24)) return { x, z };
    }
  }
  return { x: riverX(z) + lane + prefer * 26, z };
}

function boatGeometry(): { hull: BufferGeometry; fit: BufferGeometry } {
  const hull = new MeshBuilder();
  buildHull(hull, FISH_HULL, { tar: rgb('#30241a'), top: rgb('#7a6448'), wet: true });
  const b = new MeshBuilder();
  const zAt = (s: number) => (s - 0.5) * FISH_HULL.len;
  const wood = rgb('#6e5a40');
  // floorboards from end to end of where the water would be, each following the hull's width
  const BOARDS = 4;
  for (let k = 0; k < BOARDS; k++) {
    const first = b.vertexCount;
    const steps = 16;
    const tint = scaleRgb(wood, 0.88 + k * 0.04);
    for (let i = 0; i <= steps; i++) {
      const s = 0.1 + (0.8 * i) / steps;
      const w = hullHalfWidthAt(FISH_HULL, s, BOAT_FLOOR) * 0.97;
      const x0 = -w + (2 * w * k) / BOARDS + 0.008;
      const x1 = -w + (2 * w * (k + 1)) / BOARDS - 0.008;
      b.vertex(new Vector3(x0, BOAT_FLOOR, zAt(s)), UP, zAt(s) * 0.45, k * 0.25, tint);
      b.vertex(new Vector3(x1, BOAT_FLOOR, zAt(s)), UP, zAt(s) * 0.45, k * 0.25 + 0.06, tint);
    }
    for (let i = 0; i < steps; i++) b.quad(first + i * 2, first + i * 2 + 2, first + i * 2 + 3, first + i * 2 + 1);
  }
  // thwarts
  for (const s of [0.28, 0.72]) {
    const { sheer } = hullStation(FISH_HULL, s);
    const w = hullHalfWidthAt(FISH_HULL, s, sheer - 0.07) * 0.98;
    b.add(new BoxGeometry(w * 2, 0.04, 0.15), new Matrix4().makeTranslation(0, sheer - 0.07, zAt(s)), wood);
  }
  // the crutch the lever turns on: two posts from the gunwales up to the pivot, an axle across
  const sBow = 0.5 + BOAT_PIVOT.z / FISH_HULL.len;
  const { sheer } = hullStation(FISH_HULL, sBow);
  const hw = hullHalfWidthAt(FISH_HULL, sBow, sheer - 0.02);
  for (const s of [-1, 1]) taperedTube(b, [new Vector3(s * hw, sheer - 0.05, BOAT_PIVOT.z - 0.1), new Vector3(s * 0.12, BOAT_PIVOT.y + 0.12, BOAT_PIVOT.z)], [0.045, 0.04], 5, BAMBOO_OLD);
  taperedTube(b, [new Vector3(-0.4, BOAT_PIVOT.y - 0.07, BOAT_PIVOT.z), new Vector3(0.4, BOAT_PIVOT.y - 0.07, BOAT_PIVOT.z)], [0.035, 0.035], 6, BAMBOO);
  // a little chhoi over the stern, where the catch and his things are kept dry
  const roof = new CylinderGeometry(0.6, 0.6, 1.4, 10, 1, true, -Math.PI / 2, Math.PI);
  roof.rotateX(-Math.PI / 2);
  b.add(roof, new Matrix4().makeTranslation(0, 0.45, zAt(0.22)), rgb('#6a5a3c'));
  // a clay pot and a basket by his feet; the anchor's rope over the stern
  const pot = new LatheGeometry(
    [
      [0, 0],
      [0.12, 0.03],
      [0.16, 0.13],
      [0.12, 0.24],
      [0.075, 0.27],
      [0.085, 0.3],
    ].map(([r, y]) => new Vector2(r, y)),
    12,
  );
  b.add(pot, new Matrix4().makeTranslation(0.28, BOAT_FLOOR, zAt(0.36)), rgb('#9a5a3a'));
  b.add(pot, new Matrix4().makeTranslation(-0.25, BOAT_FLOOR, zAt(0.4)).scale(new Vector3(1.2, 1.1, 1.2)), rgb('#8a7448'));
  const stern = new Vector3(0, hullStation(FISH_HULL, 0.02).sheer - 0.1, zAt(0.02));
  taperedTube(b, [stern, stern.clone().add(new Vector3(0, -0.5, -1.2)), stern.clone().add(new Vector3(0, -1.6, -3.4))], [0.014, 0.014, 0.014], 4, CORD);
  return { hull: hull.build(), fit: b.build() };
}

class NetBoat {
  readonly net: LiftNet;
  readonly routine: Routine;
  readonly man: Boatman;
  readonly body: Mooring;
  readonly boat = new Group();
  private readonly mount = new Group();
  private readonly inverse = new Quaternion();
  private readonly holds: [Hold, Hold] = [
    { at: new Vector3(), thumb: new Vector3(1, 0, 0) },
    { at: new Vector3(), thumb: new Vector3(-1, 0, 0) },
  ];
  private readonly drive: BodyDrive = makeBodyDrive();
  private readonly dir = new Vector3(0, -1, 0);
  private readonly wind = new Vector3();
  private readonly gravity = new Vector3();
  private readonly stance: Vector3;
  private readonly rest: number;

  constructor(near: { z: number; prefer: 1 | -1 }, group: Group, materials: LiftNetMaterials, hullMat: Material, woodMat: Material, seed: number) {
    const anchor = anchorNear(near.z, near.prefer);
    this.body = new Mooring(anchor);
    const { hull, fit } = boatGeometry();
    const hullMesh = new Mesh(hull, hullMat);
    const fitMesh = new Mesh(fit, woodMat);
    // she moves, so casts no shadow (see LiftNet)
    hullMesh.receiveShadow = fitMesh.receiveShadow = true;
    this.boat.add(hullMesh, fitMesh);
    this.boat.name = 'fishing-boat';
    this.mount.position.copy(BOAT_PIVOT);
    this.boat.add(this.mount);
    group.add(this.boat);
    this.placeBoat();
    // the net reaches out ahead of her bow, down the current from the anchor: down the channel on the ebb, up
    // it on the flood, so the bed is sampled all round the anchor
    const reach = RODE + FISH_HULL.len + BOAT_NET.tip;
    const bed = bedSampler(anchor.x, anchor.z, reach + 10);
    this.net = new LiftNet(BOAT_NET, this.mount, materials, bed, seed);
    this.net.theta = angleFor(BOAT_NET, G.uWaterLevel.value + BOAT_PIVOT.y, -BOAT_SOAK);
    group.add(this.net.group);
    this.net.update(1 / 60, 0, false);
    this.routine = new Routine(new Rng(seed + 1), PUSH_MAX, this.net.theta);
    this.stance = new Vector3(0, BOAT_FLOOR + 0.0125, BOAT_PIVOT.z - BOAT_NET.butt - 0.6);
    this.man = fisherman(this.stance, 0.034, BOAT_OUTFIT);
    this.boat.add(this.man.group);
    this.rest = this.moment(this.net.theta, -BOAT_NET.netMass * 0.12 * GRAVITY, 0);
  }

  private placeBoat(): void {
    const b = this.body;
    this.boat.position.copy(b.pos);
    this.boat.rotation.set(b.rotX, b.heading, b.rotZ, 'YXZ');
  }

  /** What the lever and the man do to her trim: the moment of their weights and the net's pull about her middle (N·m, bow down +). */
  private moment(theta: number, loadY: number, crewZ: number): number {
    const { tip, butt, leverMass, armsMass, counterMass } = BOAT_NET;
    const c = Math.cos(theta);
    const z = BOAT_PIVOT.z;
    const weights = leverMass * (z + ((tip - butt) / 2) * c) + armsMass * (z + tip * c) + counterMass * (z - butt * c);
    return GRAVITY * weights - loadY * (z + tip * c) + MAN_MASS * GRAVITY * (this.stance.z + crewZ);
  }

  /** The net set soaking afresh, to be hauled in `delay` seconds. */
  haulSoon(delay: number): void {
    const down = angleFor(BOAT_NET, this.mount.getWorldPosition(tmpA).y, -BOAT_SOAK);
    this.net.reset(down);
    this.routine.haulSoon(down, delay);
  }

  /** Where he stands (world). */
  manAt(out: Vector3): Vector3 {
    return this.boat.localToWorld(out.copy(this.stance));
  }

  update(dt: number, t: number, camera: Vector3): void {
    const d = camera.distanceTo(this.body.pos);
    this.boat.visible = this.net.group.visible = d < SHOW_NET;
    this.man.group.visible = d < SHOW_MAN;
    const { net, routine, body } = this;
    // she floats wherever she is (so she is at the river's level when the view arrives); the man's weight
    // and the net's load trim her
    const pitch = this.moment(net.theta, net.load.y, this.man.crew.z) - this.rest;
    body.update(dt, t, pitch, -this.man.crew.x * MAN_MASS * GRAVITY);
    this.placeBoat();
    if (d > ACTIVE) {
      net.simulated = false;
      return;
    }
    this.boat.updateMatrixWorld();
    const pivotY = this.mount.getWorldPosition(tmpA).y;
    const down = angleFor(BOAT_NET, pivotY, -BOAT_SOAK);
    const up = angleFor(BOAT_NET, pivotY, BOAT_CLEAR);
    routine.update(dt, net, down, up, this.dir, true, G.uSeasonB.value.y);
    net.update(dt, t, d < NEAR_NET);
    if (d > NEAR_MAN) return;

    // his hands on the bar across the butts: he leans on it, sinking at the knees as it goes down
    const th = net.theta;
    const zb = -BOAT_NET.butt + 0.06;
    const bar = tmpB.set(0, 0.02 * Math.cos(th) + zb * Math.sin(th), -0.02 * Math.sin(th) + zb * Math.cos(th)).add(BOAT_PIVOT);
    this.holds[0].at.set(bar.x - 0.21, bar.y, bar.z);
    this.holds[1].at.set(bar.x + 0.21, bar.y, bar.z);
    const low = clamp((bar.y - BOAT_FLOOR - 0.7) / 0.7, 0, 1);
    const e = routine.effort;
    this.drive.crouch = 0.05 + 0.26 * (1 - low);
    this.drive.bend = 0.18 + 0.32 * (1 - low) + 0.12 * e;
    this.drive.shift = 0.05 * (1 - low);
    this.drive.twist = 0;
    this.drive.lean = 0;
    this.inverse.copy(this.boat.quaternion).invert();
    windAt(body.pos.x, body.pos.z, air);
    this.wind.set(air.x, 0, air.z).applyQuaternion(this.inverse);
    this.gravity.set(0, -GRAVITY, 0).applyQuaternion(this.inverse);
    this.man.update(dt, t, this.drive, { holds: this.holds }, body, this.wind, this.gravity);
  }
}

// ---------- all of them ----------

export class Fishing {
  readonly group = new Group();
  private readonly shores: ShoreNet[] = [];
  private readonly boats: NetBoat[] = [];
  private readonly order: { net: LiftNet; d: number }[] = [];
  private readonly hulls: { shape: typeof FISH_HULL; x: number; z: number; heading: number }[] = [];
  private readonly posts: { x: number; z: number; r: number }[] = [];
  private readonly nearNets: LiftNet[] = [];

  constructor() {
    this.group.name = 'fishing';
    const wood = patchMaterial(new MeshStandardMaterial({ vertexColors: true, roughness: 0.85 }), { grime: 0.35 });
    const materials: LiftNetMaterials = {
      wood,
      net: patchMaterial(new MeshStandardMaterial({ map: netTexture(), alphaTest: 0.35, alphaToCoverage: true, side: DoubleSide, roughness: 0.9 }), {}),
      rope: patchMaterial(new MeshStandardMaterial({ color: '#6a5a40', roughness: 0.9 }), {}),
      fish: patchMaterial(new MeshStandardMaterial({ color: '#c3cace', metalness: 0.55, roughness: 0.3 }), {}),
    };
    const hullMat = patchMaterial(new MeshStandardMaterial({ map: plankTexture(63), vertexColors: true, roughness: 0.85, side: DoubleSide }), { grime: 0.3 });
    const rng = new Rng(55);
    const structure = new MeshBuilder();
    LIFT_NETS.forEach((site, i) => {
      const s = new ShoreNet(site, this.group, materials, 300 + i * 17);
      shoreStructure(structure, s.plan, rng);
      this.shores.push(s);
    });
    const frames = new Mesh(structure.build(), wood);
    frames.castShadow = true;
    frames.receiveShadow = true;
    this.group.add(frames);
    NET_BOATS.forEach((near, i) => this.boats.push(new NetBoat(near, this.group, materials, hullMat, wood, 500 + i * 23)));
  }

  update(dt: number, t: number, camera: Vector3, ripples: NetRipples): void {
    for (const s of this.shores) s.update(dt, t, camera);
    for (const b of this.boats) b.update(dt, t, camera);
    // the two nets nearest the camera ring the water
    this.order.length = 0;
    for (const s of this.shores) this.order.push({ net: s.net, d: camera.distanceTo(s.net.centre) });
    for (const b of this.boats) this.order.push({ net: b.net, d: camera.distanceTo(b.net.centre) });
    this.order.sort((x, y) => x.d - y.d);
    for (let k = 0; k < 2; k++) {
      const o = this.order[k];
      if (!o || o.d > NEAR_NET) {
        ripples.b[k].set(0, 0, 0, 0);
        continue;
      }
      ripples.a[k].set(o.net.centre.x, o.net.centre.z, o.net.spec.half, o.net.yaw);
      ripples.b[k].set(o.net.splash, o.net.drip, 0, 0);
    }
  }

  /**
   * What floating plants must keep out of now: the anchored boats' hulls, the A-frames' poles where the
   * water stands round them, and the nets simulated this frame (see Drift).
   */
  obstacles(): DriftObstacles {
    this.hulls.length = 0;
    for (const b of this.boats) this.hulls.push({ shape: FISH_HULL, x: b.body.pos.x, z: b.body.pos.z, heading: b.body.heading });
    this.posts.length = 0;
    const level = G.uWaterLevel.value;
    for (const s of this.shores) {
      for (const [foot, head] of s.plan.poles) {
        if (foot.y >= level) continue;
        const t = (level - foot.y) / (head.y - foot.y);
        this.posts.push({ x: foot.x + (head.x - foot.x) * t, z: foot.z + (head.z - foot.z) * t, r: 0.08 });
      }
    }
    this.nearNets.length = 0;
    for (const s of this.shores) if (s.net.simulated) this.nearNets.push(s.net);
    for (const b of this.boats) if (b.net.simulated) this.nearNets.push(b.net);
    return { hulls: this.hulls, posts: this.posts, nets: this.nearNets };
  }

  /** Asks a fisherman (a bank net's, or a fishing boat's) to let his net soak a moment and then haul it. */
  haul(kind: 'bank' | 'boat', index: number): void {
    if (kind === 'bank') this.shores[index]?.haulSoon(1.5);
    else this.boats[index]?.haulSoon(1.5);
  }

  /** Where a net is (its middle, at the water), where its fisherman works it, and the way out from him to it (unit, level). */
  view(kind: 'bank' | 'boat', index: number): { centre: Vector3; man: Vector3; out: Vector3 } {
    if (kind === 'bank') {
      const s = this.shores[index] ?? this.shores[0];
      return { centre: s.plan.centre.clone().setY(G.uWaterLevel.value), man: s.plan.stance.clone(), out: s.plan.out.clone() };
    }
    const b = this.boats[index] ?? this.boats[0];
    const man = b.manAt(new Vector3());
    const centre = b.net.centre.clone().setY(G.uWaterLevel.value);
    const out = centre.clone().sub(man).setY(0).normalize();
    return { centre, man, out };
  }

  /** Each net's state (debug). */
  state(): Record<string, number | string | boolean>[] {
    const r = (v: number, k = 100) => Math.round(v * k) / k;
    const row = (kind: string, net: LiftNet, routine: Routine) => ({
      kind,
      x: r(net.centre.x, 10),
      z: r(net.centre.z, 10),
      phase: routine.phase,
      theta: r(net.theta, 1000),
      force: Math.round(routine.force),
      load: Math.round(net.load.y),
      wet: r(net.wet),
      fish: net.catchCount,
      arm: r(routine.arm),
      needed: Math.round(routine.needed),
      stalled: routine.stalled,
      passive: Math.round(net.passiveTorque()),
      omega: r(net.omega, 1000),
    });
    return [
      ...this.shores.map((s) => ({ ...row('bank', s.net, s.routine), mx: r(s.plan.stance.x), my: r(s.plan.stance.y), mz: r(s.plan.stance.z), yaw: r(s.plan.yaw) })),
      ...this.boats.map((b) => ({ ...row('boat', b.net, b.routine), pitch: r(b.body.rotX, 10000), mx: r(b.body.pos.x), my: r(b.body.pos.y), mz: r(b.body.pos.z), yaw: r(b.body.heading) })),
    ];
  }
}

