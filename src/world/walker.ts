import { CapsuleGeometry, DoubleSide, Group, LatheGeometry, Mesh, MeshStandardMaterial, Quaternion, SphereGeometry, Vector2, Vector3, Euler } from 'three';
import { windAt } from '../env/wind';
import { patchMaterial } from '../render/patch';
import { clothTexture } from '../render/textures';
import { ellipticLimb, limbGeometry } from './anatomy';
import {
  ANKLE,
  FOREARM,
  FOREARM_RINGS,
  HIP_HALF,
  NECK_BASE,
  PELVIS_HEIGHT,
  SHIN,
  SHOULDER,
  SKIN_TONE,
  SPINE,
  THIGH,
  THIGH_RADIUS,
  TRUNK,
  TRUNK_DEPTH,
  UPPER_ARM,
  aim,
  lungiFold,
  solveTwoBone,
} from './boatman';
import { ClothTube } from './cloth';
import { KNEE, footing, walled, type Footing } from './walkable';

// Someone on foot (GEOGRAPHY_PLAN.md §9): the viewer's walker, a villager in a checked lungi and a fatua,
// faceless and stylised like the boatmen and built from the same body (the same limbs, proportions and
// two-bone legs). He walks or runs where one can (world/walkable.ts): over the ground and the roads, onto
// the jetties' decks, up the temple's stair, over the old bridge, into the water no deeper than his knees,
// never through a wall or off a drop. His gait is procedural: each foot planted on the ground while it
// bears him and swung forward in an arc to land ahead, his hips rising and swaying over them, his arms
// swinging against his legs, his chest turning against his hips; standing, he settles onto both feet.
// Uphill he slows; wading, more so. His lungi and fatua are cloth (cloth.ts), swinging with his stride
// and stirring in the wind. He faces +z of his own frame, so his right is (−cos h, sin h) at heading h.

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

const LUNGI = ['#2e4f7a', '#d9d4c4', '#a8322a'] as const;
const FATUA = '#e6dcc6';

const UP = new Vector3(0, 1, 0);

interface Foot {
  /** Where it is (world), and where it left the ground. */
  pos: Vector3;
  from: Vector3;
  planted: boolean;
  holder: Group;
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
  private readonly feet: Foot[] = [];
  private readonly thighs: Mesh[] = [];
  private readonly shins: Mesh[] = [];
  private readonly knees: Mesh[] = [];
  private readonly upperArms: Mesh[] = [];
  private readonly sleeves: Mesh[] = [];
  private readonly forearms: Mesh[] = [];
  private readonly hands: Mesh[] = [];
  private readonly chest = new Group();
  private readonly neck: Mesh;
  private readonly head = new Group();
  private readonly lungi: ClothTube;
  private readonly fatua: ClothTube;
  private readonly hips = [new Vector3(), new Vector3()];
  private readonly kneePos = [new Vector3(), new Vector3()];
  private readonly ankles = [new Vector3(), new Vector3()];
  private readonly pelvis = new Vector3();
  private readonly fwd = new Vector3();
  private readonly right = new Vector3();
  private readonly wind = new Vector3();
  private readonly air = { x: 0, z: 0 };
  private readonly chestQ = new Quaternion();
  private readonly e = new Euler();
  private readonly v = new Vector3();
  private readonly v2 = new Vector3();
  private readonly v3 = new Vector3();

  constructor() {
    this.group.name = 'walker';
    const skin = patchMaterial(new MeshStandardMaterial({ color: SKIN_TONE, roughness: 0.55 }), { translucency: 0.35 });
    const cloth = (colours: readonly [string, string, string], seed: number, knit = false) => {
      const t = clothTexture(colours[0], colours[1], colours[2], seed, knit);
      return patchMaterial(new MeshStandardMaterial({ map: t.map, normalMap: t.normal, normalScale: new Vector2(0.6, 0.6), vertexColors: true, roughness: 0.92, side: DoubleSide }), {
        grime: 0.15,
        translucency: 0.2,
      });
    };
    const lungiMat = cloth(LUNGI, 71);
    const fatuaMat = cloth([FATUA, FATUA, '#cfc3a8'], 72, true);
    const hair = new MeshStandardMaterial({ color: '#17110d', roughness: 0.75 });
    const g = this.group;
    for (let i = 0; i < 2; i++) {
      const foot = new Mesh(new CapsuleGeometry(0.042, 0.16, 4, 10), skin);
      foot.rotation.set(Math.PI / 2, 0, 0);
      foot.geometry.scale(1.15, 1, 0.62);
      foot.position.set(0, 0.026, 0.05);
      const holder = new Group();
      holder.add(foot);
      g.add(holder);
      this.feet.push({ pos: new Vector3(), from: new Vector3(), planted: true, holder });
      const thigh = new Mesh(limbGeometry(THIGH, THIGH_RADIUS.map(([, r]) => r)), skin);
      const shin = new Mesh(limbGeometry(SHIN, [0.05, 0.055, 0.05, 0.038, 0.032]), skin);
      const knee = new Mesh(new SphereGeometry(0.052, 10, 8), skin);
      g.add(thigh, shin, knee);
      this.thighs.push(thigh);
      this.shins.push(shin);
      this.knees.push(knee);
      const upper = new Mesh(limbGeometry(UPPER_ARM, [0.05, 0.048, 0.042, 0.038]), skin);
      const sleeve = new Mesh(limbGeometry(UPPER_ARM * 0.55, [0.068, 0.066, 0.064]), fatuaMat);
      const fore = new Mesh(ellipticLimb(FOREARM_RINGS), skin);
      const hand = new Mesh(new CapsuleGeometry(0.035, 0.07, 4, 8), skin);
      hand.geometry.scale(1, 1, 0.7);
      g.add(upper, sleeve, fore, hand);
      this.upperArms.push(upper);
      this.sleeves.push(sleeve);
      this.forearms.push(fore);
      this.hands.push(hand);
    }
    const trunk = new LatheGeometry(
      TRUNK.map(([r, y]) => new Vector2(r, y)),
      20,
    );
    trunk.scale(1, 1, TRUNK_DEPTH);
    this.chest.add(new Mesh(trunk, skin));
    g.add(this.chest);
    this.neck = new Mesh(limbGeometry(0.12, [0.05, 0.047, 0.046]), skin);
    g.add(this.neck);
    // a head without a face: the skull, short black hair, ears
    this.head.add(new Mesh(new SphereGeometry(0.1, 16, 12), skin));
    const cap = new Mesh(new SphereGeometry(0.104, 16, 10, 0, Math.PI * 2, 0, Math.PI * 0.55), hair);
    cap.position.set(0, 0.008, -0.006);
    cap.rotation.x = -0.25;
    this.head.add(cap);
    for (const side of [-1, 1]) {
      const ear = new Mesh(new SphereGeometry(0.022, 8, 6), skin);
      ear.scale.set(0.5, 1, 0.8);
      ear.position.set(side * 0.098, -0.005, -0.005);
      this.head.add(ear);
    }
    g.add(this.head);
    // his lungi from the waist to the ankles; his fatua from the shoulders to the hips
    this.lungi = new ClothTube(lungiMat, {
      segments: 32,
      rings: 9,
      fold: lungiFold,
      freedom: (t) => 0.8 * Math.max(0, (t - 0.15) / 0.85) ** 1.2,
      shade: (t) => (t < 0.06 ? 0.85 : t > 0.95 ? 0.88 : 1),
      uRepeat: 4,
      vRepeat: 2.2,
    });
    this.fatua = new ClothTube(fatuaMat, {
      segments: 28,
      rings: 7,
      fold: (t, th) => ({ r: (0.002 + 0.008 * t * t) * (0.6 * Math.sin(6 * th + 0.7) + 0.4 * Math.sin(11 * th + 2.3)), y: 0 }),
      freedom: (t) => 0.5 * t * t,
      uRepeat: 3,
      vRepeat: 1.4,
    });
    g.add(this.lungi.mesh, this.fatua.mesh);
    this.group.traverse((o) => {
      if ((o as Mesh).isMesh) {
        (o as Mesh).castShadow = false;
        (o as Mesh).receiveShadow = true;
      }
    });
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
    this.pose(0, 0, true);
  }

  /** Whether he could stand at (x, z): ground under him, not too deep, no wall. */
  canStand(x: number, z: number): boolean {
    const f = footing(x, z, ground);
    return f.depth <= KNEE && !walled(x, z, BODY);
  }

  update(dt: number, time: number, input: WalkInput): void {
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
    // the hips over the feet: highest mid-stance, dipping as weight passes from one foot to the other
    const groundMean = (this.feet[0].planted ? this.feet[0].pos.y : this.y) * 0.5 + (this.feet[1].planted ? this.feet[1].pos.y : this.y) * 0.5;
    const bob = moving ? 0.022 * Math.cos(4 * Math.PI * (this.phase - duty / 2)) - 0.02 * runK : 0;
    const hipSway = moving ? 0.03 * Math.sin(2 * Math.PI * this.phase) : 0;
    this.pelvis.set(this.x - this.right.x * hipSway, Math.min(groundMean, this.y) + PELVIS_HEIGHT * (0.98 - 0.04 * runK) + bob, this.z - this.right.z * hipSway);
    const twist = moving ? 0.1 * Math.sin(2 * Math.PI * this.phase) * Math.min(1, speed / WALK) : 0;
    // the legs: from each hip joint to the ankle above its foot, the knee bending forward
    for (let i = 0; i < 2; i++) {
      const side = i === 0 ? -1 : 1;
      const yawed = this.v2.copy(this.right).applyAxisAngle(UP, twist);
      this.hips[i].copy(this.pelvis).addScaledVector(yawed, -side * HIP_HALF);
      const foot = this.feet[i];
      this.ankles[i].copy(foot.pos).setY(foot.pos.y + ANKLE);
      const pole = this.v3.copy(this.hips[i]).addScaledVector(this.fwd, 1).setY(this.hips[i].y - 0.4);
      solveTwoBone(this.hips[i], this.ankles[i], THIGH, SHIN, pole, this.kneePos[i], this.ankles[i]);
      aim(this.thighs[i], this.hips[i], this.kneePos[i]);
      aim(this.shins[i], this.kneePos[i], this.ankles[i]);
      this.knees[i].position.copy(this.kneePos[i]);
      const p = (this.phase + 0.5 * i) % 1;
      const swing = moving && p >= duty ? (p - duty) / (1 - duty) : 0;
      foot.holder.position.copy(foot.pos);
      foot.holder.rotation.set(moving ? -0.5 * Math.sin(Math.PI * swing) + (swing < 0.2 && swing > 0 ? 0.4 : 0) : 0, this.heading + side * TOE_OUT, 0, 'YXZ');
    }
    // the chest above, leaning into his pace and turning against his hips
    const lean = 0.04 + 0.05 * Math.min(1, speed / WALK) + 0.08 * runK;
    this.chestQ.setFromEuler(this.e.set(lean, this.heading - twist * 1.4, 0, 'YXZ'));
    this.chest.position.copy(this.pelvis).addScaledVector(UP, SPINE);
    this.chest.quaternion.copy(this.chestQ);
    this.chest.updateMatrixWorld();
    const chestPoint = (x: number, y: number, z: number, out: Vector3) => out.set(x, y, z).applyMatrix4(this.chest.matrixWorld);
    // the arms: hung from the shoulders, swinging against the legs, the elbows a little bent
    for (let i = 0; i < 2; i++) {
      const side = i === 0 ? -1 : 1;
      // his left shoulder is at +x of his own frame (he faces +z, his right is −x)
      const shoulder = chestPoint(-side * SHOULDER.x, SHOULDER.y, SHOULDER.z, this.v.set(0, 0, 0)).clone();
      const legP = (this.phase + 0.5 * i) % 1;
      const swing = moving ? -0.32 * Math.sin(2 * Math.PI * legP) * Math.min(1.4, speed / WALK) : 0;
      const down = this.v2.set(0, -1, 0).applyAxisAngle(this.right, swing);
      down.addScaledVector(this.right, side * 0.08).normalize();
      const elbow = shoulder.clone().addScaledVector(down, UPPER_ARM);
      const bend = this.v3.set(0, -1, 0).applyAxisAngle(this.right, swing - 0.35 - 0.6 * runK);
      const wrist = elbow.clone().addScaledVector(bend, FOREARM);
      aim(this.upperArms[i], shoulder, elbow);
      aim(this.sleeves[i], shoulder, shoulder.clone().addScaledVector(down, UPPER_ARM * 0.55));
      aim(this.forearms[i], elbow, wrist);
      aim(this.hands[i], wrist, wrist.clone().addScaledVector(bend, 0.1));
      this.hands[i].position.addScaledVector(bend, 0.05);
    }
    // the neck and the head on it, looking where he goes
    const neckBase = chestPoint(NECK_BASE.x, NECK_BASE.y, NECK_BASE.z, new Vector3());
    const neckTop = neckBase.clone().add(new Vector3(0, 0.11, 0)).addScaledVector(this.fwd, 0.015);
    aim(this.neck, neckBase, neckTop);
    this.head.position.copy(neckTop).add(new Vector3(0, 0.1, 0));
    this.head.rotation.set(0, this.heading, 0, 'YXZ');

    // the cloth, a beat behind him and stirred by the air past him
    windAt(this.x, this.z, this.air);
    this.wind.set(this.air.x - this.fwd.x * this.speed, 0, this.air.z - this.fwd.z * this.speed);
    const dtc = settle ? 1 / 30 : dt;
    const pelvis = this.pelvis;
    const right = this.right;
    const fwd = this.fwd;
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
        const y = pelvis.y + 0.07 - t * (PELVIS_HEIGHT - 0.05);
        legAt(0, y, a);
        legAt(1, y, b);
        const k = Math.min(1, Math.max(0, (t - 0.15) / 0.5));
        out.c.set(pelvis.x + ((a.x + b.x) / 2 - pelvis.x) * k, y, pelvis.z + ((a.z + b.z) / 2 - pelvis.z) * k);
        const spread = Math.abs((a.x - b.x) * fwd.x + (a.z - b.z) * fwd.z);
        out.ax.copy(right).negate();
        out.az.copy(fwd);
        out.a = 0.16 + 0.05 * t;
        out.b = 0.112 + 0.03 * t + 0.5 * spread * k;
        return out;
      },
      this.wind,
      (p) => this.offLegs(p),
    );
    this.fatua.update(
      dtc,
      time,
      (t, out) => {
        const h = 0.43 - t * 0.5;
        const r = trunkRadius(Math.max(0, h)) + 0.018;
        chestPoint(0, h, 0.005, out.c);
        out.ax.set(1, 0, 0).applyQuaternion(this.chestQ);
        out.az.set(0, 0, 1).applyQuaternion(this.chestQ);
        out.a = r + 0.01 * t;
        out.b = r * TRUNK_DEPTH + 0.02 + 0.012 * t;
        return out;
      },
      this.wind,
    );
  }

  /** Pushes a point of the lungi out of his legs. */
  private offLegs(p: Vector3): void {
    for (let i = 0; i < 2; i++) {
      pushOut(p, this.hips[i], this.kneePos[i], 0.095);
      pushOut(p, this.kneePos[i], this.ankles[i], 0.072);
    }
  }
}

/** The trunk's radius at a height above the chest's base. */
function trunkRadius(y: number): number {
  for (let i = 1; i < TRUNK.length; i++) {
    const [r0, y0] = TRUNK[i - 1];
    const [r1, y1] = TRUNK[i];
    if (y <= y1) return r0 + ((r1 - r0) * Math.max(0, y - y0)) / (y1 - y0);
  }
  return TRUNK[TRUNK.length - 1][0];
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
