import type { Vector3 } from 'three';
import { DEG, clamp } from '../core/mathx';

// Sun and moon over Moheshkhali (latitude 21.6° N, the island's middle). The sun's place on the ecliptic
// follows the day of the year (`setSunDay`), so summer days are long and the sun high, winter days short and
// the sun low, and sunrise and sunset move through the year. The moon walks the ecliptic about 12° a day
// ahead of the sun, so it rises roughly 50 minutes later each night and passes through its phases.

const LATITUDE = 21.6 * DEG;
const OBLIQUITY = 23.44 * DEG;
/** Days from one new moon to the next. */
export const SYNODIC_MONTH = 29.53;

const rightAscension = (lon: number) => Math.atan2(Math.cos(OBLIQUITY) * Math.sin(lon), Math.cos(lon));
const declination = (lon: number) => Math.asin(Math.sin(OBLIQUITY) * Math.sin(lon));

/** The sun's ecliptic longitude now, and its right ascension and declination from it. */
let sunLongitude = 0;
let sunRA = 0;
let sunDec = 0;

/** Puts the sun where it stands on a day of the year (0 = 1 January); the March equinox is about day 79. */
export function setSunDay(day: number): void {
  sunLongitude = ((day - 79) / 365.2422) * Math.PI * 2;
  sunRA = rightAscension(sunLongitude);
  sunDec = declination(sunLongitude);
}
setSunDay(257);

/** Hour angle of the sun at local solar `hour` (12 = noon). */
const sunHourAngle = (hour: number) => ((hour - 12) / 24) * Math.PI * 2;

// The compass: the river runs south to the Bay, as Bengal's rivers do, so south lies down it (−z), north
// up it (+z), west on the right of a boat going down it (+x) and east on her left (−x). The sun and the
// moon rise on her left and set on her right, lighting her from the side rather than glaring down the
// river ahead of her; at noon the sun stands high to the south, above the view.

/** A world direction (angle in the ground plane, x = sin, z = cos) from its compass parts toward north and east. */
export const compass = (north: number, east: number) => Math.atan2(-east, north);

/** World direction of a body at hour angle `H` and declination `dec`. */
function horizonDirection(H: number, dec: number, out: Vector3): Vector3 {
  const sinE = Math.sin(LATITUDE) * Math.sin(dec) + Math.cos(LATITUDE) * Math.cos(dec) * Math.cos(H);
  const elev = Math.asin(clamp(sinE, -1, 1));
  // azimuth from south, positive toward west (+x)
  const az = Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(LATITUDE) - Math.tan(dec) * Math.cos(LATITUDE));
  return out.set(Math.cos(elev) * Math.sin(az), Math.sin(elev), -Math.cos(elev) * Math.cos(az));
}

export function sunDirection(hour: number, out: Vector3): Vector3 {
  return horizonDirection(sunHourAngle(hour), sunDec, out);
}

/** The sun's direction on another `day` at `hour`, leaving the sun's own day as it is (for places worked out ahead). */
export function sunDirectionOn(day: number, hour: number, out: Vector3): Vector3 {
  return horizonDirection(sunHourAngle(hour), declination(((day - 79) / 365.2422) * Math.PI * 2), out);
}

/** `age` is days since new moon. The moon's small tilt off the ecliptic is ignored. */
export function moonDirection(hour: number, age: number, out: Vector3): Vector3 {
  const lon = sunLongitude + (age / SYNODIC_MONTH) * Math.PI * 2;
  const H = sunHourAngle(hour) - (rightAscension(lon) - sunRA);
  return horizonDirection(H, declination(lon), out);
}

/** Lit fraction of the moon's face: 0 at new moon, 1 at full. */
export function moonIllumination(age: number): number {
  return (1 - Math.cos((age / SYNODIC_MONTH) * Math.PI * 2)) / 2;
}
