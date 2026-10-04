import { Vector3 } from 'three';
import { G } from '../core/globals';
import { angleDelta, smoothstep } from '../core/mathx';
import { windAt } from '../env/wind';
import { downstream, halfWidth, riverX, streamSpeed } from './geography';
import { HERO_HULL, heroBeamAtWater } from './hull';
import { CRUISE, PADDLE_MOMENT, STROKE_SECONDS, paddleForce, strokePhase, type PaddleForce } from './paddle';
import { SHELTERED, hullWaves, type HullWaves } from './waves';

// The hero boat as a floating body. In the plane: mass and added mass, drag through the water (light
// fore and aft, heavy sideways, like a keel), the river's current, the paddle's pulses of drive from one
// side, and the boatman's steering. Out of it: heave, pitch and roll, each a damped spring toward the wave
// surface as the hull averages it (short chop cancels along a 9 m hull; long swell lifts it), plus the
// boatman's weight as he leans into each stroke. Angles are the group's Euler x (bow down +) and z
// (starboard up +). He rows on his own stroke clock: told to rest, he finishes the stroke he is in and
// holds the paddle up at the end of its recovery, ready for the next catch; tied up, a line holds her.

/**
 * Surface current (m/s): fastest mid-river and through the narrows, slack at the banks and in the
 * backwaters, and as the season has it (full and fast in the rains), as in the water shader's flow field.
 */
export function currentAt(x: number, z: number, out: { x: number; z: number }): { x: number; z: number } {
  const t = (x - riverX(z)) / halfWidth(z);
  const speed = streamSpeed(z) * Math.max(0, 1 - t * t) * G.uFlowScale.value;
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
/** From the middle of the boat to where his steering acts, m. */
const STERN_ARM = 3.5;
/** The boatman steers with the blade's twist and his weight: a heading controller with a limit on what one man can do. */
const STEER = { kp: 1500, kd: 3000, max: 400 };
const GRAVITY = 9.81;
const MAN_MASS = 65;
/** Natural frequency (Hz) and damping ratio of each motion out of the plane. */
const HEAVE = { f: 1.3, zeta: 0.35 };
const PITCH = { f: 1.0, zeta: 0.3 };
// roll is damped more than a bare hull would be: the boatman balancing and his blade in the water steady her
const ROLL = { f: 0.6, zeta: 0.2 };
/** Moment (N·m) to heel the boat one radian, and to trim it one radian. */
const ROLL_STIFF = 3200;
const PITCH_STIFF = 200000;
/** Height above her roll axis at which the blade's sideways push reaches her (through his hands and feet), m. */
const PUSH_HEIGHT = 0.8;
/**
 * The wind on her: the area she shows it side-on (hull, chhoi and boatman) and end-on (m²), and the height of
 * its centre above her roll axis (m). Air at 1.2 kg/m³ with a drag coefficient about 1.
 */
const WINDAGE = { side: 7.5, end: 2.2, height: 0.9, k: 0.5 * 1.2 };

/** Her waterline, where the water bears her up: its length and its breadth amidships (m). */
const WATERLINE = { len: HERO_HULL.len * 0.8, beam: heroBeamAtWater(0.5) * 2 };

export interface Crew {
  /** The boatman's centre of mass, offset from where it rests (boat frame, m). */
  x: number;
  z: number;
}

/** A fixed hash of a stroke's number, 0..1, so a replayed stretch of the journey paddles the same. */
const strokeHash = (n: number, k: number) => {
  const x = Math.sin(n * 12.9898 + k * 78.233) * 43758.5453;
  return x - Math.floor(x);
};

/**
 * How hard he pulls stroke `n` when she has been going `speed` through the water (over the last stroke):
 * harder when she has lost way (into a head wind, over waves; in a gale with all he has), easier when she
 * is running fast, a little different every stroke, and now and then a strong one or two to drive her on,
 * as a boatman does.
 */
function strokePower(n: number, speed: number): number {
  let p = 1 + 1.8 * (CRUISE - speed);
  p *= 0.9 + 0.2 * strokeHash(n, 1);
  if (strokeHash(n, 2) < 0.18 || strokeHash(n - 1, 2) < 0.08) p *= 1.4;
  return Math.max(0.65, Math.min(MAX_POWER, p));
}
/** The hardest he can pull, against his steady stroke. */
const MAX_POWER = 2.2;
/** The most the wind and waves heel her (rad): past a point he throws his weight to windward and her flare bites. */
const MAX_HEEL = 0.24;

/** Where in the stroke he rests the paddle when not rowing: near the end of the recovery, blade forward and clear. */
const REST_PHASE = 0.93;
/** A mooring line: how hard it pulls her back to her place (N/m), and its damping (N·s/m). */
const MOOR = { k: 140, c: 420 };

const tmp = { x: 0, z: 0 };
const air = { x: 0, z: 0 };
const stroke: PaddleForce = { thrust: 0, side: 0, x: 0, z: 0 };

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
  /** The stroke he is on (its number since the clock began), and how hard he is pulling it (1: his steady stroke). */
  strokeIndex = -1;
  power = 1;
  /** Her speed through the water averaged over about a stroke, which is what he judges his pull by. */
  meanSpeed = CRUISE;
  /** His own stroke clock (s): it runs while he rows (the paddle, his body and the thrust all read it). */
  strokeTime = 0;
  /** Whether he rows; resting, he holds the paddle up at the end of a recovery. */
  rowing = true;
  /** Where a line holds her (and the way she lies there), or null when she is free. */
  moor: { x: number; z: number; heading: number } | null = null;
  private vHeave = 0;
  /** The sea's level when she last moved: she rises and falls with the tide as it is, the spring only rides the waves. */
  private level = Number.NaN;
  /** The wind's push across her now (N, + to starboard), for her heel. */
  private windSide = 0;
  private readonly waves: HullWaves = { heave: 0, along: 0, across: 0 };
  private vRotX = 0;
  private vRotZ = 0;

  /** Puts the boat at (x, z) heading along `heading`, already cruising, the water calm under it. */
  place(x: number, z: number, heading: number): void {
    this.pos.set(x, G.uWaterLevel.value, z);
    this.level = G.uWaterLevel.value;
    this.heading = this.course = heading;
    currentAt(x, z, tmp);
    const cruise = CRUISE;
    this.vel.set(Math.sin(heading) * cruise + tmp.x, 0, Math.cos(heading) * cruise + tmp.z);
    this.yawRate = 0;
    this.speed = cruise;
    this.meanSpeed = cruise;
    this.strokeIndex = -1;
    this.rotX = this.rotZ = 0;
    this.vHeave = this.vRotX = this.vRotZ = 0;
  }

  /**
   * Advances by `dt`. `t`: clock for the waves and the stroke; `target`: the point the boatman steers
   * for; `crew`: where his weight is. The waves are the shared sea's (waves.ts).
   */
  step(dt: number, t: number, target: { x: number; z: number }, crew: Crew): void {
    const n = Math.max(1, Math.ceil(dt / (1 / 120)));
    const h = dt / n;
    for (let i = 0; i < n; i++) this.substep(h, t - dt + (i + 1) * h, target, crew);
    this.course += angleDelta(this.course, this.heading) * (1 - Math.exp(-dt / 1.2));
  }

  private substep(dt: number, t: number, target: { x: number; z: number }, crew: Crew): void {
    // his stroke clock runs while he rows, or until he has brought the paddle up to rest
    if (this.rowing || Math.abs(strokePhase(this.strokeTime) - REST_PHASE) > 0.01) this.strokeTime += dt;
    // at each catch he settles how hard to pull this stroke
    const n = Math.floor(this.strokeTime / STROKE_SECONDS);
    if (n !== this.strokeIndex) {
      this.strokeIndex = n;
      this.power = strokePower(n, this.meanSpeed);
    }
    paddleForce(strokePhase(this.strokeTime), stroke, this.power);
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
    this.meanSpeed += (ur - this.meanSpeed) * (1 - Math.exp(-dt / STROKE_SECONDS));
    // tied up, she lies the way her line holds her; else he steers for the target
    const desired = this.moor ? this.moor.heading : Math.atan2(target.x - this.pos.x, target.z - this.pos.z);
    const err = angleDelta(this.heading, desired);
    const helm = Math.max(-STEER.max, Math.min(STEER.max, STEER.kp * err - STEER.kd * this.yawRate));
    // the wind on her (the air past her, less her own way through it), mostly on her side; it pushes her
    // off her line, which the helm takes back, and heels her
    windAt(this.pos.x, this.pos.z, air);
    const ax = air.x - this.vel.x;
    const az = air.z - this.vel.z;
    const au = ax * fx + az * fz;
    const aw = ax * sx + az * sz;
    const windSurge = WINDAGE.k * WINDAGE.end * au * Math.abs(au);
    this.windSide = WINDAGE.k * WINDAGE.side * aw * Math.abs(aw);
    // the helm acts as a push across the stern; the paddle drives in pulses, and pushes a little across
    let side = stroke.side + this.windSide - helm / STERN_ARM;
    let pull = 0;
    if (this.moor) {
      // the line: a pull back toward her place, along her and across her
      const mx = MOOR.k * (this.moor.x - this.pos.x) - MOOR.c * this.vel.x;
      const mz = MOOR.k * (this.moor.z - this.pos.z) - MOOR.c * this.vel.z;
      pull = mx * fx + mz * fz;
      side += mx * sx + mz * sz;
    }
    const surge = (stroke.thrust + pull + windSurge - DRAG.lin * ur - DRAG.quad * ur * Math.abs(ur)) / SURGE_MASS;
    const sway = (side - SWAY_DRAG.lin * wr - SWAY_DRAG.quad * wr * Math.abs(wr)) / SWAY_MASS;
    this.vel.x += (fx * surge + sx * sway) * dt;
    this.vel.z += (fz * surge + sz * sway) * dt;
    this.pos.x += this.vel.x * dt;
    this.pos.z += this.vel.z * dt;
    // pulled on one side, the blade swings her bow away from it with each stroke; the twist he gives it
    // at the end of the stroke takes that out on average (so she wags a little), and the helm does the rest
    const turn = stroke.z * stroke.side - stroke.x * stroke.thrust - PADDLE_MOMENT * this.power + helm;
    this.yawRate += ((turn - YAW_DAMP * this.yawRate) / YAW_INERTIA) * dt;
    this.heading += this.yawRate * dt;

    // out of the plane: the waves as her waterline feels them, averaged over it, so short chop largely
    // cancels under her and the long swell lifts and tilts her whole (the water's shelter as the shader
    // has it: still water carries a share of the river's waves)
    const shelter = SHELTERED + (1 - SHELTERED) * smoothstep(0, 0.2, Math.hypot(tmp.x, tmp.z));
    const w = hullWaves(this.pos.x, this.pos.z, this.heading, WATERLINE.len, WATERLINE.beam, t, shelter, this.waves);
    const mean = w.heave;
    // local height = heave + x·rotZ − z·rotX, so the surface's slopes give the angles it would set
    let rollTarget = w.across;
    let pitchTarget = -w.along;
    // the boatman's weight heels and trims her as he leans out into each stroke; the blade's sideways
    // push rocks her a little; at speed the stern squats and the bow lifts
    rollTarget += (-MAN_MASS * GRAVITY * crew.x - stroke.side * PUSH_HEIGHT - this.windSide * WINDAGE.height) / ROLL_STIFF;
    rollTarget = MAX_HEEL * Math.tanh(rollTarget / MAX_HEEL);
    pitchTarget += (MAN_MASS * GRAVITY * crew.z) / PITCH_STIFF - 0.003 * ur * ur;
    // she floats on the tide's water, riding the waves on it (a jump of the level, as a film scene sets its
    // hour, carries her with it rather than leaving her to fall or float up through it)
    if (Number.isFinite(this.level)) this.pos.y += G.uWaterLevel.value - this.level;
    this.level = G.uWaterLevel.value;
    [this.pos.y, this.vHeave] = spring(this.pos.y, this.vHeave, G.uWaterLevel.value + mean, HEAVE.f, HEAVE.zeta, dt);
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
