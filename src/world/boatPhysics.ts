import { Vector3 } from 'three';
import { angleDelta } from '../core/mathx';
import { downstream, halfWidth, riverX } from './geography';
import { HERO_HULL, hullHalfWidthAt } from './hull';
import { waveHeight } from './waves';

// The hero boat as a floating body. In the plane: mass and added mass, drag through the water (light
// fore and aft, heavy sideways, like a keel), the river's current, the oar's thrust and the boatman's
// steering. Out of it: heave, pitch and roll, each a damped spring toward the wave surface as the hull
// averages it (short chop cancels along a 9 m hull; long swell lifts it), plus the boatman's weight
// and his push on the oar. Angles are the group's Euler x (bow down +) and z (starboard up +).

/** Seconds per sculling cycle: the blade sweeps across astern and back. */
export const STROKE_SECONDS = 3.4;
/** Half-angle (radians) of the blade's sweep. */
export const SWEEP = 0.32;

const MEAN_THRUST = 130;
const SIDE_FORCE = 70;

export interface Scull {
  /** Oar's swing from its rest line (radians, + toward starboard at the blade). */
  sweep: number;
  /** Rate of swing, rad/s. */
  rate: number;
  /** Forward drive (N). */
  thrust: number;
  /** Sideways push at the stern (N, + to starboard). */
  side: number;
}

export const strokePhase = (t: number) => (((t / STROKE_SECONDS) % 1) + 1) % 1;

/**
 * One sculling cycle at phase 0..1. The blade drives on both sweeps, hardest mid-sweep where it moves
 * fastest; the water resisting it pushes the stern against the way the blade is moving.
 */
export function scull(phase: number, out: Scull): Scull {
  const a = phase * Math.PI * 2;
  const c = Math.cos(a);
  out.sweep = SWEEP * Math.sin(a);
  out.rate = SWEEP * c * ((Math.PI * 2) / STROKE_SECONDS);
  out.thrust = MEAN_THRUST * 2 * c * c;
  out.side = -SIDE_FORCE * c;
  return out;
}

/** Surface current (m/s): fastest mid-river, slack at the banks, as in the water shader's flow field. */
export function currentAt(x: number, z: number, out: { x: number; z: number }): { x: number; z: number } {
  const t = (x - riverX(z)) / halfWidth(z);
  const speed = 0.85 * Math.max(0, 1 - t * t);
  const [dx, dz] = downstream(z);
  out.x = dx * speed;
  out.z = dz * speed;
  return out;
}

const MASS = 380; // the boat ≈ 240 kg, the boatman 65, cargo 75
const SURGE_MASS = MASS * 1.05;
const SWAY_MASS = MASS * 1.9;
const YAW_INERTIA = 6200;
const DRAG = { lin: 20, quad: 45 }; // ≈ 130 N at 1.5 m/s through the water
const SWAY_DRAG = { lin: 450, quad: 900 };
const YAW_DAMP = 2600;
/** From the middle of the boat to where the oar works, m. */
const STERN_ARM = 3.5;
/** The boatman steers by angling the blade: a heading controller with a limit on what one man can do. */
const STEER = { kp: 1500, kd: 3000, max: 400 };
const GRAVITY = 9.81;
const MAN_MASS = 65;
/** Natural frequency (Hz) and damping ratio of each motion out of the plane. */
const HEAVE = { f: 1.3, zeta: 0.35 };
const PITCH = { f: 1.0, zeta: 0.3 };
const ROLL = { f: 0.6, zeta: 0.12 };
/** Moment (N·m) to heel the boat one radian, and to trim it one radian. */
const ROLL_STIFF = 3200;
const PITCH_STIFF = 200000;
/** Height above the deck of the oar handle the boatman pushes on, m. */
const PUSH_HEIGHT = 0.8;

/** Points along the waterline where the hull feels the water. */
const SAMPLES: { x: number; z: number }[] = [];
for (const s of [0.18, 0.34, 0.5, 0.66, 0.82]) {
  for (const side of [-1, 1]) {
    SAMPLES.push({ x: side * hullHalfWidthAt(HERO_HULL, s, 0) * 0.7, z: (s - 0.5) * HERO_HULL.len });
  }
}
const SUM_XX = SAMPLES.reduce((a, p) => a + p.x * p.x, 0);
const SUM_ZZ = SAMPLES.reduce((a, p) => a + p.z * p.z, 0);

export interface Crew {
  /** The boatman's centre of mass, offset from where it rests (boat frame, m). */
  x: number;
  z: number;
}

const tmp = { x: 0, z: 0 };
const stroke: Scull = { sweep: 0, rate: 0, thrust: 0, side: 0 };

function spring(x: number, v: number, target: number, f: number, zeta: number, dt: number): [number, number] {
  const w = f * Math.PI * 2;
  v += (w * w * (target - x) - 2 * zeta * w * v) * dt;
  return [x + v * dt, v];
}

export class BoatBody {
  /** Waterline origin in the world; y is the heave. */
  readonly pos = new Vector3();
  readonly vel = new Vector3();
  heading = Math.PI;
  /** The heading without the stern's wag from each stroke: where the boat is going. Cameras follow this. */
  course = Math.PI;
  yawRate = 0;
  /** Speed through the water, m/s. */
  speed = 0;
  rotX = 0;
  rotZ = 0;
  private vHeave = 0;
  private vRotX = 0;
  private vRotZ = 0;

  /** Puts the boat at (x, z) heading along `heading`, already cruising, the water calm under it. */
  place(x: number, z: number, heading: number): void {
    this.pos.set(x, 0, z);
    this.heading = this.course = heading;
    currentAt(x, z, tmp);
    const cruise = 1.49;
    this.vel.set(Math.sin(heading) * cruise + tmp.x, 0, Math.cos(heading) * cruise + tmp.z);
    this.yawRate = 0;
    this.speed = cruise;
    this.rotX = this.rotZ = 0;
    this.vHeave = this.vRotX = this.vRotZ = 0;
  }

  /**
   * Advances by `dt`. `t`: clock for the waves and the stroke; `target`: the point the boatman steers
   * for; `crew`: where his weight is; `wind`: the waves' strength.
   */
  step(dt: number, t: number, target: { x: number; z: number }, crew: Crew, wind: number): void {
    const n = Math.max(1, Math.ceil(dt / (1 / 120)));
    const h = dt / n;
    for (let i = 0; i < n; i++) this.substep(h, t - dt + (i + 1) * h, target, crew, wind);
    this.course += angleDelta(this.course, this.heading) * (1 - Math.exp(-dt / 1.2));
  }

  private substep(dt: number, t: number, target: { x: number; z: number }, crew: Crew, wind: number): void {
    scull(strokePhase(t), stroke);
    const fx = Math.sin(this.heading);
    const fz = Math.cos(this.heading);
    const sx = Math.cos(this.heading);
    const sz = -Math.sin(this.heading);

    // in the plane: drive, drag through the water (which is itself moving), and steering
    currentAt(this.pos.x, this.pos.z, tmp);
    const rx = this.vel.x - tmp.x;
    const rz = this.vel.z - tmp.z;
    const ur = rx * fx + rz * fz;
    const wr = rx * sx + rz * sz;
    this.speed = ur;
    const desired = Math.atan2(target.x - this.pos.x, target.z - this.pos.z);
    const err = angleDelta(this.heading, desired);
    const steer = Math.max(-STEER.max, Math.min(STEER.max, STEER.kp * err - STEER.kd * this.yawRate));
    const side = stroke.side - steer / STERN_ARM;
    const surge = (stroke.thrust - DRAG.lin * ur - DRAG.quad * ur * Math.abs(ur)) / SURGE_MASS;
    const sway = (side - SWAY_DRAG.lin * wr - SWAY_DRAG.quad * wr * Math.abs(wr)) / SWAY_MASS;
    this.vel.x += (fx * surge + sx * sway) * dt;
    this.vel.z += (fz * surge + sz * sway) * dt;
    this.pos.x += this.vel.x * dt;
    this.pos.z += this.vel.z * dt;
    // a push at the stern to starboard swings the bow to port
    this.yawRate += ((-side * STERN_ARM - YAW_DAMP * this.yawRate) / YAW_INERTIA) * dt;
    this.heading += this.yawRate * dt;

    // out of the plane: the wave surface as the hull averages it, a plane through the sample points
    let mean = 0;
    let sxh = 0;
    let szh = 0;
    for (const p of SAMPLES) {
      const wx = this.pos.x + sx * p.x + fx * p.z;
      const wz = this.pos.z + sz * p.x + fz * p.z;
      const hgt = waveHeight(wx, wz, t, wind);
      mean += hgt;
      sxh += hgt * p.x;
      szh += hgt * p.z;
    }
    mean /= SAMPLES.length;
    // local height = heave + x·rotZ − z·rotX, so the surface's slopes give the angles it would set
    let rollTarget = sxh / SUM_XX;
    let pitchTarget = -szh / SUM_ZZ;
    // the boatman's weight heels and trims her; his push on the oar rocks her with each sweep;
    // at speed the stern squats a little and the bow lifts
    rollTarget += (-MAN_MASS * GRAVITY * crew.x - stroke.side * PUSH_HEIGHT) / ROLL_STIFF;
    pitchTarget += (MAN_MASS * GRAVITY * crew.z) / PITCH_STIFF - 0.003 * ur * ur;
    [this.pos.y, this.vHeave] = spring(this.pos.y, this.vHeave, mean, HEAVE.f, HEAVE.zeta, dt);
    [this.rotX, this.vRotX] = spring(this.rotX, this.vRotX, pitchTarget, PITCH.f, PITCH.zeta, dt);
    [this.rotZ, this.vRotZ] = spring(this.rotZ, this.vRotZ, rollTarget, ROLL.f, ROLL.zeta, dt);
  }

  /** How fast she is rolling and pitching (rad/s), for things that swing aboard. */
  get rollRate(): number {
    return this.vRotZ;
  }

  get pitchRate(): number {
    return this.vRotX;
  }
}
