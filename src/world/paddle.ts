import { Vector3 } from 'three';
import { smoothstep } from '../core/mathx';

// The boatman's বৈঠা: a long paddle worked over the boat's +x side from the stern platform. One stroke is
// a pull and a recovery. The blade goes in well ahead of him and is drawn back past his hip as he unwinds
// and sinks into it. It comes out with a little outward twist (which also keeps her straight) and is swung
// forward low over the water, turned edge-on to the air. The blade, his body, the boat's drive and the
// water's rings all read this one stroke, so they keep in step. Not every stroke is the same: each has a
// power (1 his steady stroke), which the boat chooses as it goes (see boatPhysics.ts); a strong stroke
// digs deeper, has him bend and sink further into it, and drives her harder.

/** Seconds per stroke. */
export const STROKE_SECONDS = 1.9;
/** The part of each stroke the blade is in the water, pulling. */
const PULL = 0.44;
/** From the cross-grip at the top of the shaft to the middle of the blade, m. */
export const PADDLE_REACH = 2.0;
export const BLADE_LENGTH = 0.56;
/** Where the blade's middle goes in and comes out along the boat, how far out from her centre line it
 * works, and how deep it goes (boat frame, m). */
const CATCH_Z = -1.75;
const EXIT_Z = -3.2;
const BLADE_X = 1.08;
const DEPTH = 0.3;
/** The mean drive (N) that holds her at cruising speed against the water's drag; it comes in pulses. */
export const MEAN_THRUST = 130;
/** Her speed through the water (m/s) at his steady stroke. */
export const CRUISE = 1.49;

export const strokePhase = (t: number) => (((t / STROKE_SECONDS) % 1) + 1) % 1;

/** 0 → 1, slow at both ends and fastest in the middle. */
const ease = (x: number) => x - Math.sin(2 * Math.PI * x) / (2 * Math.PI);

export interface PaddlePose {
  /** The middle of the blade (boat frame). */
  readonly blade: Vector3;
  /** Down the shaft, from the grip to the blade (unit). */
  readonly shaft: Vector3;
  /** Across the blade's face, which is also along the cross-grip (unit). */
  readonly across: Vector3;
  /** The top of the shaft, at the cross-grip. */
  readonly grip: Vector3;
  /** How much of the blade is in the water, 0..1. */
  wet: number;
}

export function makePaddlePose(): PaddlePose {
  return { blade: new Vector3(), shaft: new Vector3(), across: new Vector3(), grip: new Vector3(), wet: 0 };
}

const tmpA = new Vector3();
const tmpB = new Vector3();

/** The paddle at `phase` (0..1 through the stroke, the blade going in at 0), in a stroke of `power`. */
export function paddlePose(phase: number, out: PaddlePose, power = 1): PaddlePose {
  // a strong stroke digs deeper (it goes in and comes out where any other does, so strokes join up)
  const depth = DEPTH * (0.75 + 0.25 * power);
  let theta: number;
  let psi: number;
  let feather: number;
  if (phase < PULL) {
    // the pull: in ahead of him, back past his hip, deepest midway; a twist outward at the end
    const u = phase / PULL;
    const e = ease(u);
    const arc = Math.sin(Math.PI * u);
    out.blade.set(BLADE_X + 0.03 * arc + 0.08 * smoothstep(0.75, 1, u), -depth * Math.pow(arc, 0.7), CATCH_Z + (EXIT_Z - CATCH_Z) * e);
    theta = 0.35 - 0.65 * e;
    psi = 0.38 - 0.05 * arc + 0.07 * smoothstep(0.6, 1, u);
    feather = 0.6 * smoothstep(0.7, 1, u);
  } else {
    // the recovery: lifted out and swung forward wide and low, edge-on, squared again for the catch
    const v = (phase - PULL) / (1 - PULL);
    const e = ease(v);
    const arc = Math.sin(Math.PI * v);
    out.blade.set(BLADE_X + 0.08 * (1 - smoothstep(0.5, 1, v)) + 0.5 * arc, 0.32 * Math.pow(arc, 0.6), EXIT_Z + (CATCH_Z - EXIT_Z) * e);
    theta = -0.3 + 0.65 * e;
    psi = 0.45 + 0.35 * arc - 0.07 * smoothstep(0.5, 1, v);
    feather = 0.6 + (Math.PI / 2 - 0.6) * smoothstep(0, 0.25, v) - (Math.PI / 2) * smoothstep(0.7, 1, v);
  }
  // down the shaft: out over the side by psi, the blade ahead of the grip by theta
  const s = out.shaft.set(Math.sin(psi), -Math.cos(psi) * Math.cos(theta), Math.cos(psi) * Math.sin(theta));
  out.grip.copy(out.blade).addScaledVector(s, -PADDLE_REACH);
  // the face square to the stroke (its width across the boat), turned about the shaft by the feather
  const w0 = tmpA.set(0, 0, 1).cross(s).normalize();
  const w1 = tmpB.crossVectors(s, w0);
  out.across.copy(w0).multiplyScalar(Math.cos(feather)).addScaledVector(w1, Math.sin(feather));
  out.wet = smoothstep(0.2, -0.2, out.blade.y);
  return out;
}

/** How his body works the stroke. */
export interface BodyDrive {
  /** Chest turned toward the paddle's side (+) or away from it (−), rad. */
  twist: number;
  /** Forward bend of the trunk, rad. */
  bend: number;
  /** Lean out over the paddle's side, rad. */
  lean: number;
  /** How far his hips sink as his knees give, m. */
  crouch: number;
  /** His hips' shift toward the bow, m. */
  shift: number;
}

export function makeBodyDrive(): BodyDrive {
  return { twist: 0, bend: 0, lean: 0, crouch: 0, shift: 0 };
}

/**
 * His body at `phase` of a stroke of `power`. At the catch he is wound up away from the paddle and reaching
 * forward; through the pull he unwinds, sinks at the knees and leans out over the blade (the more, the
 * harder he pulls); on the recovery he straightens and winds up again for the next one.
 */
export function bodyDrive(phase: number, out: BodyDrive, power = 1): BodyDrive {
  const p = Math.max(0.6, Math.min(1.7, power));
  if (phase < PULL) {
    const u = phase / PULL;
    const e = ease(u);
    const arc = Math.sin(Math.PI * u);
    // power shows mid-stroke only (arc), so one stroke runs into the next whatever their powers
    out.twist = -0.35 + 0.65 * e;
    out.bend = 0.32 - 0.2 * e + 0.08 * (p - 1) * arc;
    out.lean = 0.12 + 0.1 * arc * p;
    out.crouch = 0.03 + 0.08 * arc * p;
    out.shift = 0.05 - 0.09 * e;
  } else {
    const v = (phase - PULL) / (1 - PULL);
    const e = ease(v);
    const arc = Math.sin(Math.PI * v);
    out.twist = 0.3 - 0.65 * e;
    out.bend = 0.12 + 0.2 * e;
    out.lean = 0.12 - 0.05 * arc;
    out.crouch = 0.03 * (1 - arc);
    out.shift = -0.04 + 0.09 * e;
  }
  return out;
}

/** What the paddle does to the boat at an instant. */
export interface PaddleForce {
  /** Drive along her (N, + toward the bow) and push across her (N, + to the paddle's side). */
  thrust: number;
  side: number;
  /** Where the blade works (boat frame), for the turning moment. */
  x: number;
  z: number;
}

const TABLE = 256;
/** Per sample of the stroke: thrust, side, x, z. */
const DRIVE = new Float32Array(TABLE * 4);

/**
 * The water resists the blade as it is drawn back through it, as the square of its speed and as much of it
 * as is wet; the boat takes the reaction. Scaled so a whole stroke averages MEAN_THRUST. Returns the mean
 * turning moment that pulling on one side gives her (N·m), which the boatman cancels as he goes.
 */
function buildDriveTable(): number {
  const a = makePaddlePose();
  const b = makePaddlePose();
  const dt = STROKE_SECONDS / TABLE;
  let sum = 0;
  for (let i = 0; i < TABLE; i++) {
    paddlePose(i / TABLE, a);
    paddlePose(((i + 1) % TABLE) / TABLE, b);
    const vz = (b.blade.z - a.blade.z) / dt;
    const vx = (b.blade.x - a.blade.x) / dt;
    DRIVE[i * 4] = a.wet * Math.max(0, -vz) ** 2;
    DRIVE[i * 4 + 1] = -a.wet * vx * Math.abs(vx);
    DRIVE[i * 4 + 2] = a.blade.x;
    DRIVE[i * 4 + 3] = a.blade.z;
    sum += DRIVE[i * 4];
  }
  const k = MEAN_THRUST / (sum / TABLE);
  let moment = 0;
  for (let i = 0; i < TABLE; i++) {
    DRIVE[i * 4] *= k;
    DRIVE[i * 4 + 1] *= k;
    moment += DRIVE[i * 4 + 3] * DRIVE[i * 4 + 1] - DRIVE[i * 4 + 2] * DRIVE[i * 4];
  }
  return moment / TABLE;
}

/** The paddle's mean turning moment (N·m, + turns the bow toward +x); negative, as it is worked on the +x side. */
export const PADDLE_MOMENT = buildDriveTable();

/** The paddle's drive at `phase` of a stroke of `power` (the blade drawn harder through the water). */
export function paddleForce(phase: number, out: PaddleForce, power = 1): PaddleForce {
  const f = phase * TABLE;
  const i = Math.floor(f) % TABLE;
  const j = (i + 1) % TABLE;
  const t = f - Math.floor(f);
  const mix = (k: number) => DRIVE[i * 4 + k] + (DRIVE[j * 4 + k] - DRIVE[i * 4 + k]) * t;
  out.thrust = mix(0) * power;
  out.side = mix(1) * power;
  out.x = mix(2);
  out.z = mix(3);
  return out;
}
