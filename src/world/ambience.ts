import type { Vector3 } from 'three';
import { place } from '../geo/data';
import { G } from '../core/globals';
import { swellBreaking } from './waves';

// How loud the places round the listener are, for the soundscape: the surf breaking on the beaches (the same
// breakers the water draws: waves.ts `swellBreaking`), and Gorakghata's bazaar by day. Sampled a few times a
// second on rings round the camera, each source fading with its distance.

/** The rings the surf is listened for on (m), and how many points on each. */
const RINGS = [15, 45, 110, 240];
const POINTS = 12;
/** A breaker this far off (m) sounds half as loud as one at the camera. */
const SURF_HALF = 70;
/** The bazaar: its middle, how far its murmur carries (m), and the hours it is busy (solar). */
const BAZAAR = place('gorakghata-town').world;
const BAZAAR_REACH = 260;
const BAZAAR_HOURS = { open: 7, close: 21.5 };
/** Seconds between samplings. */
const EVERY = 0.4;

export interface Ambience {
  /** The surf, 0..1: how hard the swell breaks near the camera, and how high it is. */
  surf: number;
  /** The bazaar's murmur, 0..1. */
  market: number;
}

let wait = 0;
const now: Ambience = { surf: 0, market: 0 };

/** The ambience at `eye` at solar hour `hour`, refreshed every EVERY seconds. */
export function ambienceAt(eye: Vector3, hour: number, dt: number): Ambience {
  wait -= dt;
  if (wait > 0) return now;
  wait = EVERY;
  // the surf: the loudest breaker heard, by its strength, the swell's height and its distance
  let surf = 0;
  const swell = G.uSwell.value.w;
  if (swell > 0.05) {
    for (const r of RINGS) {
      const near = 1 / (1 + (r / SURF_HALF) ** 2);
      if (near * Math.min(1, swell) <= surf) continue;
      for (let k = 0; k < POINTS; k++) {
        const a = ((k + (r % 2) * 0.5) / POINTS) * Math.PI * 2;
        const b = swellBreaking(eye.x + Math.sin(a) * r, eye.z + Math.cos(a) * r);
        if (b > 0) surf = Math.max(surf, b * near * Math.min(1, swell));
      }
    }
  }
  now.surf = surf;
  // the bazaar: by day, near the town, softer the higher the camera is
  const d = Math.hypot(eye.x - BAZAAR.x, eye.z - BAZAAR.z);
  const open = hour > BAZAAR_HOURS.open && hour < BAZAAR_HOURS.close ? 1 : 0;
  now.market = open * Math.max(0, 1 - d / BAZAAR_REACH) ** 1.5 / (1 + Math.max(0, eye.y - 10) / 40);
  return now;
}
