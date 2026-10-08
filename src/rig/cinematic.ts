import { Vector3 } from 'three';
import { DEG, angleDelta, clamp, lerp, smoothstep } from '../core/mathx';
import { moonDirectionOn, moonIllumination, sunDirectionOn } from '../env/astro';
import { SEASON_NAMES, SEASON_STARTS, makeSeasonState, seasonAt } from '../env/season';
import { JOURNEY, journeyAt } from '../world/geography';
import { OPENING_SECONDS, highView, openingSide } from './opening';

// The cinematic mode, the experience the site opens in (the user's direction, 2026-10-07; Live is Bangladesh's own
// date and hour). Its moment is the user's: dawn, the sun coming up the river in the drone's first seconds and the
// land lit within a few more, the morning brightening on to 8:05 as the drone goes round her; then the clock runs on
// as it does. What the system chooses is the day: every day of the year is weighed by what its season puts in the
// land, the water and the air on a morning, by where its sun comes up in the drone's view, and by the moon that could
// stand in its morning sky. She sets out on the best, and the year turns on from there as she goes (yearJourney.ts).

/**
 * Where the sunrise runs in the opening (s, its own time from `from` s into the flight): up to the lit stage over
 * `seconds`, through the drone's descent (rig/opening.ts), so the land is seen lighting up as it comes down (the
 * user's wish, 2026-10-07); and from `on`, the morning brightening on to its hour (`MORNING`) as the drone goes round
 * her, there at `until`, as the flight hands the camera over (the user's wish, 2026-10-08). The two ramps overlap, so
 * the sun never stops at the lit stage.
 */
export const SUNRISE = { from: 0.6, seconds: 8, on: 6, until: OPENING_SECONDS - 0.6 };
/** The hour the opening hands over at, and the clock runs on from: 8:05 in the morning (the user's), as the clock shows it. */
const MORNING = 8 + 5 / 60;
/** The season the site opens in (SEASON_NAMES' বসন্ত, spring: the user's, 2026-10-08). */
const SPRING = SEASON_NAMES.indexOf('বসন্ত');
/** The sun's elevation (°) the sunrise starts from: under the horizon, the land still dim, the sky beginning to glow (environment.ts LOOKS). */
const DAWN = -6;
/**
 * The lit stage's elevation (°), for a light mist to a winter fog: higher where the mist is thicker, so it has burnt
 * off enough to see the village (environment.ts `dawn`). Low, a soft gold (the user found 10–14° too bright), but
 * just past the sunrise's watch window (clock.ts WATCH, ≈6°), so the camera is not turned back to a sunrise it has
 * just seen.
 */
const LIT: readonly [number, number] = [7, 9];
/** Hours after the lit stage a moon that is not worth having stays under the horizon (no moonset over her bow). */
const MOON_DOWN = 2.5;
/** The drone's frame across (°, either side of its middle) at a landscape screen (rig.ts `fovFor`). */
const HALF_FRAME = 36;

/** A cinematic morning: its day of the year, the hours of its dawn, its lit stage and the opening's end (`morning`), and the moon's age. */
export interface Morning {
  day: number;
  dawn: number;
  lit: number;
  morning: number;
  moon: number;
}

/** A day as weighed: its score and what it is made of (for the debug hooks). */
export interface Weighed {
  day: number;
  score: number;
  terms: Record<string, number>;
}

/** The chosen morning, and the best days as weighed. */
export interface Plan extends Morning {
  ranked: Weighed[];
}

const tmp = new Vector3();
/** 1 at `at`, falling to 0 `width` either side. */
const bell = (x: number, at: number, width: number) => clamp(1 - Math.abs(x - at) / width, 0, 1);

/** The morning's hour (solar) on `day` when the sun stands `elev` degrees up. */
function hourAt(day: number, elev: number): number {
  let a = 2;
  let b = 12;
  for (let i = 0; i < 32; i++) {
    const m = (a + b) / 2;
    if (Math.asin(sunDirectionOn(day, m, tmp).y) / DEG < elev) a = m;
    else b = m;
  }
  return (a + b) / 2;
}

/**
 * The best moon for a morning: one standing low in the sky ahead of her after the sunrise, well lit and off to the
 * side of her way (never dead ahead of the majhi); its age and how good it is. With none worth having, a waxing
 * moon that is under the horizon all morning (none setting over her bow) and up into the evening; worth 0.
 */
function morningMoon(day: number, hour: number, course: number): { age: number; worth: number } {
  let best = { age: 0, worth: 0 };
  // a waning moon is the one still up in the morning
  for (let age = 13; age <= 22; age += 0.25) {
    moonDirectionOn(day, hour, age, tmp);
    const elev = Math.asin(tmp.y) / DEG;
    const off = Math.abs(angleDelta(course, Math.atan2(tmp.x, tmp.z))) / DEG;
    const worth = moonIllumination(age) * bell(elev, 16, 12) * smoothstep(12, 26, off) * smoothstep(75, 55, off);
    if (worth > best.worth) best = { age, worth };
  }
  if (best.worth > 0) return best;
  // the fullest such moon, from a little short of full down to the first quarter
  for (let age = 10; age > 6; age -= 0.25) {
    let up = -90;
    for (let h = 0; h <= MOON_DOWN; h += 0.25) up = Math.max(up, Math.asin(moonDirectionOn(day, hour + h, age, tmp).y) / DEG);
    if (up < -2) return { age, worth: 0 };
  }
  return { age: 7.4, worth: 0 };
}

/** The cinematic morning on `day`: its dawn, its lit stage by the season's mist, and its moon. */
export function morningOn(day: number): Morning {
  const season = seasonAt(day, makeSeasonState());
  const lit = hourAt(day, lerp(LIT[0], LIT[1], smoothstep(0.3, 1, season.fog)));
  return { day, dawn: hourAt(day, DAWN), lit, morning: Math.max(lit, MORNING), moon: morningMoon(day, lit, journeyAt(JOURNEY.opening).heading).age };
}

/**
 * Weighs every day of spring (বসন্ত, 1 Falgun to the end of Chaitra: the user's, 2026-10-08, the site opens in it)
 * for the opening's morning and returns the best. Each term is what the eye would
 * see in it, at the opening: the land (green, the paddy ripe or the mustard out, the kash, the blossom, the lilies;
 * dust and dry land against it), the water (full to the banks is the better mirror), the air (a veil of mist on the
 * river, never a fog that drowns the sunrise's colour; dust haze against it), the sky (a few clouds to catch the
 * dawn; rain against it), the sunrise in the drone's frame (in it and off to one side, never dead ahead), and a
 * morning moon beside her way.
 */
export function planCinematic(): Plan {
  const along = JOURNEY.opening;
  const view = highView(SUNRISE.from + SUNRISE.seconds / 2, along, openingSide(along));
  const course = journeyAt(along).heading;
  const season = makeSeasonState();
  const weighed: Weighed[] = [];
  for (let day = SEASON_STARTS[SPRING]; day < SEASON_STARTS[(SPRING + 1) % SEASON_STARTS.length]; day++) {
    const s = seasonAt(day, season);
    const lit = hourAt(day, lerp(LIT[0], LIT[1], smoothstep(0.3, 1, s.fog)));
    const rise = hourAt(day, 0);
    const off = Math.abs(angleDelta(view.bearing, Math.atan2(sunDirectionOn(day, rise, tmp).x, tmp.z))) / DEG;
    const terms = {
      land: 0.45 * s.green + 0.6 * s.crops[2] + 0.45 * s.crops[3] + 0.2 * s.crops[1] + 0.55 * s.kash + 0.45 * s.blossom + 0.3 * s.lily - 0.45 * s.dry,
      water: 0.3 * smoothstep(-0.4, 0.8, s.water),
      mist: 0.35 * bell(s.fog, 0.35, 0.4) - 0.5 * s.haze,
      sky: 0.2 * smoothstep(0.05, 0.25, s.cloud) - 1.2 * s.rain,
      sunrise: 0.8 * smoothstep(4, 14, off) * smoothstep(HALF_FRAME, HALF_FRAME - 10, off),
      moon: 0.25 * morningMoon(day, lit, course).worth,
    };
    weighed.push({ day, score: Object.values(terms).reduce((a, b) => a + b, 0), terms });
  }
  weighed.sort((a, b) => b.score - a.score);
  return { ...morningOn(weighed[0].day), ranked: weighed.slice(0, 12) };
}
