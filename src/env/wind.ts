import { G } from '../core/globals';

// One wind for the whole world. It blows from a direction and at a strength the season and the weather
// set, and it comes in gusts: fronts of stronger air that roll downwind across the land and the water, so
// a gust bends the kash on the bank, darkens the river with ripples and heels the boat as it passes over
// them, one after the other. The shaders read it through G.uWind and G.uGust (`windGust` in glsl.ts);
// everything on the CPU (the boat, cloth, nets, floating plants) reads the same field from here.

/** Metres per second that a strength of 1 stands for (a fresh breeze). */
export const WIND_MS = 4;

/** How quickly gust fronts roll downwind, per unit of strength (in their phase units per second). */
const FRONT_SPEED = 0.5;
const FRONT_SPEED_PER = 0.35;

export interface WindSetting {
  /** Mean strength (1 is a fresh breeze, about WIND_MS m/s; 2.5 a storm). */
  strength: number;
  /** How gusty: 0 steady, 1 wildly gusting. */
  gusts: number;
  /** The way it blows toward, radians in the ground plane (x = sin, z = cos). */
  angle: number;
}

/**
 * The wind's state, eased toward what the season and the weather (or the viewer) ask for. `update` writes
 * G.uWind (x, z direction toward which it blows; strength; gustiness) and G.uGust (front phase).
 */
export class Wind {
  /** Held strength chosen by the viewer, or null to follow the season and the weather. */
  override: number | null = null;
  strength = 0.75;
  gusts = 0.5;
  angle = Math.atan2(0.55, -0.83);
  private phase = 0;

  update(dt: number, t: number, want: WindSetting): void {
    // the air changes its mind slowly: a minute or so to swing round or freshen
    const k = 1 - Math.exp(-dt / 25);
    let target = want.strength * (1 + 0.25 * Math.sin(t * 0.05) + 0.1 * Math.sin(t * 0.23));
    if (this.override !== null) target = this.override;
    this.strength += (target - this.strength) * (this.override !== null ? 1 - Math.exp(-dt / 2) : k);
    this.gusts += (want.gusts - this.gusts) * k;
    let d = want.angle + 0.18 * Math.sin(t * 0.013) - this.angle;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    this.angle += d * k;
    this.phase += dt * (FRONT_SPEED + FRONT_SPEED_PER * this.strength);
    G.uWind.value.set(Math.sin(this.angle), Math.cos(this.angle), this.strength, this.gusts);
    G.uGust.value.set(this.phase, 0);
  }
}

/** The gusts' factor on the mean wind at (x, z) now: 1 on average, more under a front. Twin of `windGust` (glsl.ts). */
export function gustAt(x: number, z: number): number {
  const w = G.uWind.value;
  const along = x * w.x + z * w.y;
  const across = -x * w.y + z * w.x;
  const front = along * 0.045 - G.uGust.value.x;
  const g = 0.62 * Math.sin(front) + 0.38 * Math.sin(front * 2.3 + across * 0.031 + 1.7);
  return Math.max(0, 1 + w.w * g);
}

/** The air's velocity at (x, z) now, m/s (world x, z). */
export function windAt(x: number, z: number, out: { x: number; z: number }): { x: number; z: number } {
  const w = G.uWind.value;
  const speed = w.z * gustAt(x, z) * WIND_MS;
  out.x = w.x * speed;
  out.z = w.y * speed;
  return out;
}
