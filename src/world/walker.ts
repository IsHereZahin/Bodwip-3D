import { DoubleSide, Euler, Group, MeshStandardMaterial, Quaternion, Vector2, Vector3 } from 'three';
import { windAt } from '../env/wind';
import { patchMaterial } from '../render/patch';
import { clothTexture } from '../render/textures';
import { lungiFold, solveTwoBone } from './boatman';
import { ClothTube } from './cloth';
import { Human, enclosing, type Grip } from './human';
import { KNEE, footing, walled, type Footing } from './walkable';

// Someone on foot (GEOGRAPHY_PLAN.md §9): the viewer's walker, a young villager in a long checked lungi and
// a fatua, a person as games make one (human.ts), like the boatmen. He walks or runs where one can
// (world/walkable.ts): over the ground and the roads, onto the jetties' decks, up the temple's stair, over the
// old bridge, into the water no deeper than his knees, never through a wall or off a drop. His gait is
// procedural: each foot planted on the ground while it bears him and swung forward in an arc to land ahead
// (heel first, pushing off from the toes), his hips rising and swaying over them, his arms swinging against
// his legs, his chest turning against his hips; standing, he settles onto both feet. Uphill he slows; wading,
// more so. His fatua is fitted to him; his lungi is cloth (cloth.ts), swinging with his stride and stirring
// in the wind. He faces +z of his own frame, so his right is (−cos h, sin h) at heading h.

const WALK = 1.35;
const RUN = 3.1;
/** Cycle length (m, two steps) walking and running, and the share of it each foot bears him. */
const STRIDE = { walk: 1.3, run: 2.3 };
const DUTY = { walk: 0.62, run: 0.42 };
/** How fast he turns (rad/s), and gathers or loses speed (m/s²). */
const TURN = 2.2;
const ACCEL = 3.2;
/** His body's radius against walls, and the most he steps up or down at once (m). */
const BODY = 0.28;
const STEP = 0.55;
/** How far his feet stand apart, and turn out. */
const STANCE = 0.11;
const TOE_OUT = 0.12;
/** His hands' loose fists: the radius they close round. */
const FIST = 0.016;
/** The lungi's top round his waist, from spine05's head, and its ease over the skin there. */
const LUNGI_TOP = 0.055;
const LUNGI_EASE = 0.012;

const LUNGI = ['#2e4f7a', '#d9d4c4', '#a8322a'] as const;
const FATUA = '#e6dcc6';

const UP = new Vector3(0, 1, 0);

interface Foot {
  /** Where it is (world), and where it left the ground. */
  pos: Vector3;
  from: Vector3;
  planted: boolean;
}

interface Arm {
  side: number;
  grip: Grip;
  shoulder: Vector3;
  hold: Vector3;
  wrist: Vector3;
  barQ: Quaternion;
  elbowAt: Vector3;
  roll: Vector3;
}

export interface WalkInput {
  /** Forward (+1) or back (−1). */
  forward: number;
  /** Turn left (+1) or right (−1). */
  turn: number;
  run: boolean;
}

const ground: Footing = { y: 0, depth: 0 };

export class Walker {
  readonly group = new Group();
  readonly body: Human;
  x = 0;
  z = 0;
  /** What he stands on (m about MSL). */
  y = 0;
  heading = 0;
  /** His speed along his heading (m/s; back is negative). */
  speed = 0;
  /** The water over his feet (m): for the splash of his steps and the crabs that keep away. */
  wading = 0;
  private phase = 0;
  private time = 0;
  private readonly feet: Foot[] = [];
  private readonly arms: Arm[] = [];
  private readonly lungi: ClothTube;
  /** The lungi's top ring round his waist (pelvis frame): middle front to back, half-width, half-depth. */
  private readonly waist: { zc: number; a: number; b: number };
  private readonly hips = [new Vector3(), new Vector3()];
  private readonly kneePos = [new Vector3(), new Vector3()];
  private readonly ankles = [new Vector3(), new Vector3()];
  private readonly pelvis = new Vector3();
  private readonly pelvisQ = new Quaternion();
  private readonly chestQ = new Quaternion();
  private readonly headQ = new Quaternion();
  private readonly fwd = new Vector3();
  private readonly right = new Vector3();
  private readonly wind = new Vector3();
  private readonly air = { x: 0, z: 0 };
  private readonly look = new Vector3();
  private readonly e = new Euler();
  private readonly v = new Vector3();
  private readonly v2 = new Vector3();
  private readonly v3 = new Vector3();
  private readonly end = new Vector3();
  private posed = false;

  constructor() {
    this.group.name = 'walker';
    const cloth = (colours: readonly [string, string, string], seed: number, knit = false) => {
      const t = clothTexture(colours[0], colours[1], colours[2], seed, knit);
      return { t, m: patchMaterial(new MeshStandardMaterial({ map: t.map, normalMap: t.normal, normalScale: new Vector2(0.6, 0.6), vertexColors: true, roughness: 0.92, side: DoubleSide }), { grime: 0.15, translucency: 0.2 }) };
    };
    const lungi = cloth(LUNGI, 71);
    // the fatua's weave over the body's own layout, a few repeats across the chest
    const fatua = cloth([FATUA, FATUA, '#cfc3a8'], 72, true);
    fatua.t.map.repeat.set(14, 14);
    fatua.t.normal.repeat.set(14, 14);
    (fatua.m as MeshStandardMaterial).normalScale.set(0.35, 0.35);
    const body = (this.body = new Human('pathik', { fatua: fatua.m }));
    this.group.add(body.group);
    for (let i = 0; i < 2; i++) {
      this.feet.push({ pos: new Vector3(), from: new Vector3(), planted: true });
      const side = i === 0 ? -1 : 1;
      this.arms.push({
        side,
        grip: body.grip(side, FIST),
        shoulder: new Vector3(),
        hold: new Vector3(),
        wrist: new Vector3(),
        barQ: new Quaternion(),
        elbowAt: new Vector3(),
        roll: new Vector3(0, -1, 0),
      });
    }
    const w = enclosing(body.data.sections.pelvis, LUNGI_TOP);
    this.waist = { zc: w.zc, a: w.a + LUNGI_EASE, b: w.b + LUNGI_EASE };
    // his lungi from the waist to the ankles
    this.lungi = new ClothTube(lungi.m, {
      segments: 32,
      rings: 9,
      fold: lungiFold,
      freedom: (t) => 0.8 * Math.max(0, (t - 0.15) / 0.85) ** 1.2,
      shade: (t) => (t < 0.06 ? 0.85 : t > 0.95 ? 0.88 : 1),
      uRepeat: 4,
      vRepeat: 2.2,
    });
    this.lungi.mesh.castShadow = false;
    this.lungi.mesh.receiveShadow = true;
    this.group.add(this.lungi.mesh);
  }

  /** Puts him at (x, z) facing `heading`, standing. */
  place(x: number, z: number, heading: number): void {
    this.x = x;
    this.z = z;
    this.heading = heading;
    this.speed = 0;
    this.phase = 0;
    this.y = footing(x, z, ground).y;
    this.frame();
    this.feet.forEach((f, i) => {
      const side = i === 0 ? -1 : 1;
      f.pos.set(x - this.right.x * side * STANCE, 0, z - this.right.z * side * STANCE);
      f.pos.y = footing(f.pos.x, f.pos.z, ground).y;
      f.from.copy(f.pos);
      f.planted = true;
    });
    this.posed = false;
    this.pose(0, this.time, true);
  }

  /** Whether he could stand at (x, z): ground under him, not too deep, no wall. */
  canStand(x: number, z: number): boolean {
    const f = footing(x, z, ground);
    return f.depth <= KNEE && !walled(x, z, BODY);
  }

  update(dt: number, time: number, input: WalkInput): void {
    this.time = time;
    // turning and gathering speed toward what is asked
    this.heading += input.turn * TURN * dt * (input.run ? 0.8 : 1);
    const top = input.run ? RUN : WALK;
    const want = input.forward > 0 ? top * input.forward : input.forward < 0 ? -0.6 * WALK : 0;
    this.speed += Math.max(-ACCEL * dt, Math.min(ACCEL * dt, want - this.speed));
    this.frame();
    // the next step: blocked by a wall, deep water or a drop; slower uphill and in the water
    if (Math.abs(this.speed) > 0.01) {
      const step = this.speed * dt;
      const nx = this.x + this.fwd.x * step;
      const nz = this.z + this.fwd.z * step;
      const here = this.y;
      const next = footing(nx, nz, ground);
      const rise = next.y - here;
      if (next.depth > KNEE || Math.abs(rise) > STEP || walled(nx, nz, BODY)) this.speed = 0;
      else {
        const slope = rise / Math.max(Math.abs(step), 1e-3);
        const drag = (1 - Math.min(0.6, Math.max(0, slope) * 1.6)) * (1 - 0.5 * Math.min(1, next.depth / KNEE));
        this.x += this.fwd.x * step * drag;
        this.z += this.fwd.z * step * drag;
        this.speed *= 0.97 + 0.03 * drag;
      }
    }
    const f = footing(this.x, this.z, ground);
    this.y = f.y;
    this.wading = f.depth;
    this.pose(dt, time, false);
  }

  /** His forward and right directions at his heading. */
  private frame(): void {
    this.fwd.set(Math.sin(this.heading), 0, Math.cos(this.heading));
    this.right.set(-Math.cos(this.heading), 0, Math.sin(this.heading));
  }

  /** The gait, the legs, the body, the arms and the cloth for this frame. */
  private pose(dt: number, time: number, settle: boolean): void {
    const body = this.body;
    const { dims } = body;
    const speed = Math.abs(this.speed);
    const runK = Math.min(1, Math.max(0, (speed - WALK) / (RUN - WALK)));
    const L = STRIDE.walk + (STRIDE.run - STRIDE.walk) * runK;
    const duty = DUTY.walk + (DUTY.run - DUTY.walk) * runK;
    const moving = speed > 0.05;
    if (moving) this.phase = (this.phase + (speed * dt) / L) % 1;
    const dir = Math.sign(this.speed) || 1;
    // the feet: planted while they bear him, swung forward to land ahead of the hip
    this.feet.forEach((foot, i) => {
      const side = i === 0 ? -1 : 1;
      const lateral = this.v.set(-this.right.x * side * STANCE, 0, -this.right.z * side * STANCE);
      if (!moving || settle) {
        // standing: each foot steps back under its hip if it has strayed
        const homeX = this.x + lateral.x;
        const homeZ = this.z + lateral.z;
        const off = Math.hypot(foot.pos.x - homeX, foot.pos.z - homeZ);
        if (settle || off > 0.02) {
          const k = settle ? 1 : Math.min(1, dt * 6);
          foot.pos.x += (homeX - foot.pos.x) * k;
          foot.pos.z += (homeZ - foot.pos.z) * k;
        }
        foot.pos.y = footing(foot.pos.x, foot.pos.z, ground).y;
        foot.planted = true;
        return;
      }
      const p = (this.phase + 0.5 * i) % 1;
      if (p < duty) {
        foot.planted = true;
      } else {
        if (foot.planted) foot.from.copy(foot.pos);
        foot.planted = false;
        const u = (p - duty) / (1 - duty);
        const ahead = ((1 - u) * (1 - duty) * L + (duty * L) / 2) * dir;
        const tx = this.x + this.fwd.x * ahead + lateral.x;
        const tz = this.z + this.fwd.z * ahead + lateral.z;
        const ty = footing(tx, tz, ground).y;
        const e = u * u * (3 - 2 * u);
        foot.pos.x = foot.from.x + (tx - foot.from.x) * e;
        foot.pos.z = foot.from.z + (tz - foot.from.z) * e;
        foot.pos.y = foot.from.y + (ty - foot.from.y) * e + Math.sin(Math.PI * u) * (0.1 + 0.08 * runK);
      }
    });
    // the hips over the feet: highest mid-stance, dipping as weight passes from one foot to the other, the
    // hip of the swinging leg dropping a little
    const groundMean = (this.feet[0].planted ? this.feet[0].pos.y : this.y) * 0.5 + (this.feet[1].planted ? this.feet[1].pos.y : this.y) * 0.5;
    const bob = moving ? 0.022 * Math.cos(4 * Math.PI * (this.phase - duty / 2)) - 0.02 * runK : 0;
    const hipSway = moving ? 0.03 * Math.sin(2 * Math.PI * this.phase) : 0;
    this.pelvis.set(this.x - this.right.x * hipSway, Math.min(groundMean, this.y) + (dims.pelvis - 0.02) * (0.98 - 0.04 * runK) + bob, this.z - this.right.z * hipSway);
    const twist = moving ? 0.1 * Math.sin(2 * Math.PI * this.phase) * Math.min(1, speed / WALK) : 0;
    const drop = moving ? 0.05 * Math.sin(2 * Math.PI * this.phase) * Math.min(1, speed / WALK) : 0;
    this.pelvisQ.setFromEuler(this.e.set(0.03, this.heading + twist, drop, 'YXZ'));
    // the chest above, leaning into his pace and turning against his hips
    const lean = 0.04 + 0.05 * Math.min(1, speed / WALK) + 0.08 * runK;
    this.chestQ.setFromEuler(this.e.set(lean, this.heading - twist * 1.4, -drop * 0.5, 'YXZ'));
    body.setTrunk(this.pelvis, this.pelvisQ, this.chestQ);

    // the legs: from each hip joint to the ankle above its foot, the knee bending forward; the foot rolls from
    // the heel at landing to the toes as it leaves the ground
    for (let i = 0; i < 2; i++) {
      const side = i === 0 ? -1 : 1;
      const hip = body.hip(side, this.hips[i]);
      const foot = this.feet[i];
      this.ankles[i].copy(foot.pos).setY(foot.pos.y + dims.ankle);
      const pole = this.v3.copy(hip).addScaledVector(this.fwd, 1).setY(hip.y - 0.4);
      solveTwoBone(hip, this.ankles[i], dims.thigh, dims.shin, pole, this.kneePos[i], this.end);
      const p = (this.phase + 0.5 * i) % 1;
      const swing = moving && p >= duty ? (p - duty) / (1 - duty) : 0;
      const pitch = moving ? 0.5 * Math.sin(Math.PI * swing) - (swing < 0.2 && swing > 0 ? 0.4 : 0) : 0;
      body.setLeg(side, this.kneePos[i], this.end, this.heading + side * TOE_OUT, pitch);
      this.ankles[i].copy(this.end);
    }

    // the arms: hung from the shoulders, swinging against the legs, the elbows a little bent, the hands loosely closed
    for (const arm of this.arms) {
      const i = arm.side < 0 ? 0 : 1;
      const shoulder = body.shoulder(arm.side, arm.shoulder);
      const legP = (this.phase + 0.5 * i) % 1;
      const swing = moving ? -0.32 * Math.sin(2 * Math.PI * legP) * Math.min(1.4, speed / WALK) : 0;
      const down = this.v2.set(0, -1, 0).applyAxisAngle(this.right, swing);
      down.addScaledVector(this.right, -arm.side * 0.08).normalize();
      const elbow = this.v3.copy(shoulder).addScaledVector(down, dims.upperArm);
      const bend = this.v.set(0, -1, 0).applyAxisAngle(this.right, swing - 0.35 - 0.6 * runK);
      // the fist a hand's breadth on from the wrist, the thumb forward
      arm.hold.copy(elbow).addScaledVector(bend, dims.foreArm + 0.075);
      if (!this.posed) arm.elbowAt.copy(elbow);
      const thumb = this.end.crossVectors(this.right, bend).normalize();
      body.holdBar(arm.side, arm.grip, arm.hold, thumb, arm.elbowAt, arm.roll, arm.barQ, arm.wrist);
      const pole = this.v2.copy(shoulder).addScaledVector(this.fwd, -0.5).addScaledVector(UP, -0.4);
      solveTwoBone(shoulder, arm.wrist, dims.upperArm, dims.foreArm, pole, arm.elbowAt, this.end);
      body.setHand(arm.grip, arm.hold, arm.barQ);
      body.setArm(arm.side, arm.elbowAt);
    }
    this.posed = true;

    // the head, looking where he goes
    this.headQ.setFromEuler(this.e.set(0.06, this.heading, 0, 'YXZ'));
    this.look.copy(body.head).addScaledVector(this.fwd, 12).addScaledVector(UP, -0.8);
    body.setHead(this.headQ, this.look, time);

    // the lungi, a beat behind him and stirred by the air past him
    windAt(this.x, this.z, this.air);
    this.wind.set(this.air.x - this.fwd.x * this.speed, 0, this.air.z - this.fwd.z * this.speed);
    const dtc = settle ? 1 / 30 : dt;
    const pelvis = this.pelvis;
    const right = this.right;
    const fwd = this.fwd;
    const waist = this.waist;
    const thigh = body.data.sections.thigh;
    const legAt = (i: number, y: number, out: Vector3) => {
      // the point of leg i at height y: along the thigh above the knee, along the shin below it
      const hip = this.hips[i];
      const knee = this.kneePos[i];
      const ankle = this.ankles[i];
      if (y >= knee.y) return out.lerpVectors(knee, hip, Math.min(1, (y - knee.y) / Math.max(1e-3, hip.y - knee.y)));
      return out.lerpVectors(ankle, knee, Math.max(0, (y - ankle.y) / Math.max(1e-3, knee.y - ankle.y)));
    };
    const a = new Vector3();
    const b = new Vector3();
    this.lungi.update(
      dtc,
      time,
      (t, out) => {
        const y = pelvis.y + LUNGI_TOP - t * (dims.pelvis - 0.04);
        legAt(0, y, a);
        legAt(1, y, b);
        const k = Math.min(1, Math.max(0, (t - 0.15) / 0.5));
        const zc = waist.zc * (1 - k);
        out.c.set(pelvis.x + ((a.x + b.x) / 2 - pelvis.x) * k + fwd.x * zc, y, pelvis.z + ((a.z + b.z) / 2 - pelvis.z) * k + fwd.z * zc);
        const spread = Math.abs((a.x - b.x) * fwd.x + (a.z - b.z) * fwd.z);
        out.ax.copy(right).negate();
        out.az.copy(fwd);
        out.a = Math.max(waist.a, thigh[0] * 0.8 + 0.1) + 0.04 * t;
        out.b = waist.b + 0.02 * t + 0.5 * spread * k;
        return out;
      },
      this.wind,
      (p) => this.offLegs(p),
    );
    body.commit();
  }

  /** Pushes a point of the lungi out of his legs. */
  private offLegs(p: Vector3): void {
    const { thigh, shin } = this.body.data.sections;
    for (let i = 0; i < 2; i++) {
      pushOut(p, this.hips[i], this.kneePos[i], thigh[5] * 0.85 + 0.012);
      pushOut(p, this.kneePos[i], this.ankles[i], shin[3] + 0.01);
    }
  }
}

const seg = new Vector3();
const rel = new Vector3();
/** Moves `p` out of the capsule from `a` to `b` of radius `r`. */
function pushOut(p: Vector3, a: Vector3, b: Vector3, r: number): void {
  seg.subVectors(b, a);
  const len2 = seg.lengthSq();
  const t = len2 > 0 ? Math.max(0, Math.min(1, rel.subVectors(p, a).dot(seg) / len2)) : 0;
  rel.copy(a).addScaledVector(seg, t);
  const d = p.distanceTo(rel);
  if (d < r && d > 1e-5) p.sub(rel).multiplyScalar(r / d).add(rel);
}
