import type { Vector3 } from 'three';
import { DEG, clamp } from '../core/mathx';

// Sun and moon for a Bengal autumn (latitude 23.7° N). The sun keeps one declination, so every day
// has the same light. The moon walks the ecliptic about 12° a day ahead of it, so it rises roughly
// 50 minutes later each night and passes through its phases.

const LATITUDE = 23.7 * DEG;
const OBLIQUITY = 23.44 * DEG;
const SUN_DECLINATION = 8 * DEG;
/** Days from one new moon to the next. */
export const SYNODIC_MONTH = 29.53;
/** The sun's ecliptic longitude for that declination, on its way down to the autumn equinox. */
const SUN_LONGITUDE = Math.PI - Math.asin(Math.sin(SUN_DECLINATION) / Math.sin(OBLIQUITY));

const rightAscension = (lon: number) => Math.atan2(Math.cos(OBLIQUITY) * Math.sin(lon), Math.cos(lon));
const declination = (lon: number) => Math.asin(Math.sin(OBLIQUITY) * Math.sin(lon));
const SUN_RA = rightAscension(SUN_LONGITUDE);

/** Hour angle of the sun at local solar `hour` (12 = noon). */
const sunHourAngle = (hour: number) => ((hour - 12) / 24) * Math.PI * 2;

/** World direction of a body at hour angle `H` and declination `dec`. West lies ahead of the boat and a little to its right. */
function horizonDirection(H: number, dec: number, out: Vector3): Vector3 {
  const sinE = Math.sin(LATITUDE) * Math.sin(dec) + Math.cos(LATITUDE) * Math.cos(dec) * Math.cos(H);
  const elev = Math.asin(clamp(sinE, -1, 1));
  // azimuth from south, positive toward west
  const az = Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(LATITUDE) - Math.tan(dec) * Math.cos(LATITUDE));
  const theta = az - Math.PI / 2 + 20 * DEG;
  return out.set(Math.cos(elev) * Math.sin(theta), Math.sin(elev), -Math.cos(elev) * Math.cos(theta));
}

export function sunDirection(hour: number, out: Vector3): Vector3 {
  return horizonDirection(sunHourAngle(hour), SUN_DECLINATION, out);
}

/** `age` is days since new moon. The moon's small tilt off the ecliptic is ignored. */
export function moonDirection(hour: number, age: number, out: Vector3): Vector3 {
  const lon = SUN_LONGITUDE + (age / SYNODIC_MONTH) * Math.PI * 2;
  const H = sunHourAngle(hour) - (rightAscension(lon) - SUN_RA);
  return horizonDirection(H, declination(lon), out);
}

/** Lit fraction of the moon's face: 0 at new moon, 1 at full. */
export function moonIllumination(age: number): number {
  return (1 - Math.cos((age / SYNODIC_MONTH) * Math.PI * 2)) / 2;
}
