import { Color } from 'three';
import { G } from '../core/globals';
import { smoothstep } from '../core/mathx';
import { compass } from './astro';

// The six seasons (ষড়ঋতু) of the Bangla year. A day of the year (0 = 1 January) gives every seasonal
// quantity by easing between six keys, one in the middle of each season: how much the land's runoff
// quickens the khal's drift, how silty the water is, how green or dusty the land, which crops stand in the paddy plots,
// which trees are in flower, whether the kash is in plume and the lilies in bloom, how cloudy and rainy
// and foggy it is, and the wind. The land, the water, the sky, the weather and the wind all read it, so a
// season is one state of the whole world rather than a change of paint.

/** Days in a year. */
export const YEAR = 365.2422;

export const SEASON_NAMES = ['গ্রীষ্ম', 'বর্ষা', 'শরৎ', 'হেমন্ত', 'শীত', 'বসন্ত'] as const;
/** First day of each season (day of the year): 1 Boishakh, 1 Asharh, 1 Bhadro, 1 Kartik, 1 Poush, 1 Falgun. */
export const SEASON_STARTS = [103, 165, 227, 288, 348, 43] as const;

/** The Bangla months and their first days (day of the year), from Boishakh (14 April). */
const MONTHS: readonly (readonly [string, number])[] = [
  ['বৈশাখ', 103],
  ['জ্যৈষ্ঠ', 134],
  ['আষাঢ়', 165],
  ['শ্রাবণ', 196],
  ['ভাদ্র', 227],
  ['আশ্বিন', 258],
  ['কার্তিক', 288],
  ['অগ্রহায়ণ', 318],
  ['পৌষ', 348],
  ['মাঘ', 13],
  ['ফাল্গুন', 43],
  ['চৈত্র', 73],
];

export interface SeasonState {
  /** Day of the year (0 = 1 January). */
  day: number;
  /** Which of SEASON_NAMES it is. */
  index: number;
  /** The land's runoff down the khal, against autumn's: in the rains its drift quickens (main.ts). */
  flow: number;
  /** The river's colour (its silt), as a multiplier on the light it sends back. */
  readonly silt: Color;
  /** Leafiness and dryness of the land, 0..1. */
  green: number;
  dry: number;
  /** Share of trees in red flower; kash in plume; lilies in bloom (0..1). */
  blossom: number;
  kash: number;
  lily: number;
  /** Shares of paddy plots: seedlings, green, golden, mustard (the rest stubble). */
  crops: [number, number, number, number];
  /** Share of other plots with water standing in them; how wet the soil is. */
  flood: number;
  soilWet: number;
  /** Mean cloud cover, mean rain, river fog, dust haze (0..1). */
  cloud: number;
  rain: number;
  fog: number;
  haze: number;
  /** The wind: mean strength, gustiness, and the way it blows toward (radians, x = sin, z = cos). */
  wind: number;
  gusts: number;
  windAngle: number;
  /** Strength of the sunlight, and its warmth (−1 cool .. 1 warm). */
  light: number;
  warm: number;
  /** Salt pans at work (dry, white with salt) rather than idle or flooded (0..1). */
  salt: number;
  /**
   * The Bay's swell reaching the coast (significant height outside the breakers, m): about half the open
   * sea's (Mansur et al. 2017: Dec–Feb 0.99 m, Mar–May 1.77, Jun–Aug 3.32, Sep–Nov 2.01) [মডেল].
   */
  swell: number;
}

interface Key extends Omit<SeasonState, 'day' | 'index' | 'silt'> {
  at: number;
  silt: string;
}

// the way the wind blows toward: the monsoon from the south-west, the winter wind from the north-east, the
// summer's southerlies, autumn's light easterlies (south lies down the river, see env/astro.ts)
const TOWARD_NE = compass(1, 1);
const TOWARD_SW = compass(-1, -1);
const TOWARD_N = compass(1, 0);
const TOWARD_W = compass(0.24, -0.97);

const KEYS: readonly Key[] = [
  // শীত (mid January): low clear water, mustard and boro seedbeds, dry pale land, morning fog, still air
  { at: 14, flow: 0.7, silt: '#727a5a', green: 0.55, dry: 0.55, blossom: 0, kash: 0, lily: 0.2, crops: [0.25, 0.1, 0, 0.35], flood: 0.25, soilWet: 0.2, cloud: 0.1, rain: 0, fog: 1, haze: 0.2, wind: 0.45, gusts: 0.35, windAngle: TOWARD_SW, light: 0.95, warm: -0.15, salt: 1, swell: 0.5 },
  // বসন্ত (mid March): lowest water, new leaves, shimul and palash in flower, green boro, dry breezes
  { at: 73, flow: 0.7, silt: '#7a7656', green: 0.78, dry: 0.45, blossom: 0.35, kash: 0, lily: 0.35, crops: [0.1, 0.65, 0.05, 0.05], flood: 0.4, soilWet: 0.25, cloud: 0.2, rain: 0.02, fog: 0.25, haze: 0.35, wind: 0.75, gusts: 0.6, windAngle: TOWARD_N, light: 1, warm: 0.05, salt: 1, swell: 0.75 },
  // গ্রীষ্ম (mid May): boro harvest, dust and heat haze, krishnachura, sudden squalls (kalboishakhi)
  { at: 134, flow: 0.8, silt: '#7e7050', green: 0.7, dry: 0.7, blossom: 0.25, kash: 0, lily: 0.55, crops: [0.1, 0.25, 0.45, 0], flood: 0.15, soilWet: 0.15, cloud: 0.35, rain: 0.12, fog: 0, haze: 0.6, wind: 0.95, gusts: 1, windAngle: TOWARD_N, light: 1.08, warm: 0.12, salt: 0.85, swell: 0.95 },
  // বর্ষা (mid July): the river high, fast and brown, aman seedlings in flooded plots, lilies everywhere, rain
  { at: 195, flow: 1.6, silt: '#8a6a40', green: 1, dry: 0, blossom: 0, kash: 0, lily: 1, crops: [0.55, 0.3, 0, 0], flood: 0.9, soilWet: 1, cloud: 0.85, rain: 0.55, fog: 0.1, haze: 0.3, wind: 1.1, gusts: 0.8, windAngle: TOWARD_NE, light: 0.65, warm: -0.05, salt: 0, swell: 1.6 },
  // শরৎ (mid September): white clouds in a blue sky, kash in plume on the chars, lush green aman
  { at: 257, flow: 1.2, silt: '#7d6a46', green: 0.95, dry: 0.1, blossom: 0, kash: 1, lily: 0.9, crops: [0.1, 0.85, 0, 0], flood: 0.45, soilWet: 0.55, cloud: 0.45, rain: 0.08, fog: 0.3, haze: 0.15, wind: 0.75, gusts: 0.5, windAngle: TOWARD_W, light: 1, warm: 0, salt: 0.2, swell: 1.1 },
  // হেমন্ত (mid November): golden aman and the harvest, mist in the mornings, the water falling
  { at: 318, flow: 0.95, silt: '#786a4c', green: 0.8, dry: 0.3, blossom: 0, kash: 0.45, lily: 0.55, crops: [0, 0.25, 0.6, 0], flood: 0.15, soilWet: 0.35, cloud: 0.2, rain: 0.02, fog: 0.6, haze: 0.2, wind: 0.55, gusts: 0.35, windAngle: TOWARD_SW, light: 0.98, warm: 0.06, salt: 0.7, swell: 0.75 },
];

const tmpA = new Color();
const tmpB = new Color();

/** The two keys either side of `day` (cyclically), and how far between them it lies, eased. */
function bracket(day: number): [Key, Key, number] {
  const d = ((day % YEAR) + YEAR) % YEAR;
  for (let i = 0; i < KEYS.length; i++) {
    const a = KEYS[i];
    const b = KEYS[(i + 1) % KEYS.length];
    const span = (b.at - a.at + YEAR) % YEAR;
    const into = (d - a.at + YEAR) % YEAR;
    if (into <= span) return [a, b, smoothstep(0, 1, into / span)];
  }
  return [KEYS[0], KEYS[0], 0];
}

export function makeSeasonState(): SeasonState {
  return {
    day: 0,
    index: 0,
    flow: 1,
    silt: new Color(),
    green: 1,
    dry: 0,
    blossom: 0,
    kash: 0,
    lily: 0,
    crops: [0, 0, 0, 0],
    flood: 0,
    soilWet: 0,
    cloud: 0,
    rain: 0,
    fog: 0,
    haze: 0,
    wind: 1,
    gusts: 0.5,
    windAngle: TOWARD_W,
    light: 1,
    warm: 0,
    salt: 0,
    swell: 0.8,
  };
}

type Scalar = Exclude<keyof Key, 'at' | 'silt' | 'crops' | 'windAngle'>;
const SCALARS: readonly Scalar[] = ['flow', 'green', 'dry', 'blossom', 'kash', 'lily', 'flood', 'soilWet', 'cloud', 'rain', 'fog', 'haze', 'wind', 'gusts', 'light', 'warm', 'salt', 'swell'];

/** The season on `day` (day of the year, fractional). */
export function seasonAt(day: number, out: SeasonState): SeasonState {
  const [a, b, t] = bracket(day);
  out.day = ((day % YEAR) + YEAR) % YEAR;
  out.index = seasonIndex(out.day);
  for (const k of SCALARS) out[k] = a[k] + (b[k] - a[k]) * t;
  for (let i = 0; i < 4; i++) out.crops[i] = a.crops[i] + (b.crops[i] - a.crops[i]) * t;
  let d = b.windAngle - a.windAngle;
  d = Math.atan2(Math.sin(d), Math.cos(d));
  out.windAngle = a.windAngle + d * t;
  out.silt.copy(tmpA.set(a.silt)).lerp(tmpB.set(b.silt), t);
  return out;
}

/** Writes the season's land into the shared uniforms (the khal's current comes from its runoff, in main.ts). */
export function applySeason(s: SeasonState): void {
  G.uSeasonA.value.set(s.green, s.dry, s.blossom, s.kash);
  G.uSeasonB.value.set(s.lily, s.flood, s.soilWet, s.salt);
  G.uCrops.value.set(s.crops[0], s.crops[1], s.crops[2], s.crops[3]);
}

/** Which season (index into SEASON_NAMES) a day of the year falls in. */
export function seasonIndex(day: number): number {
  const d = ((day % YEAR) + YEAR) % YEAR;
  let best = 0;
  let bestInto = Infinity;
  SEASON_STARTS.forEach((start, i) => {
    const into = (d - start + YEAR) % YEAR;
    if (into < bestInto) {
      bestInto = into;
      best = i;
    }
  });
  return best;
}

/** The middle of a season, as a day of the year. */
export function seasonMiddle(index: number): number {
  return (SEASON_STARTS[index] + 30) % YEAR;
}

/** The Bangla date of a day of the year: the month's name and the day of the month (1-based). */
export function banglaDate(day: number): { month: string; date: number } {
  const d = ((day % YEAR) + YEAR) % YEAR;
  let best = MONTHS[0];
  let bestInto = Infinity;
  for (const m of MONTHS) {
    const into = (d - m[1] + YEAR) % YEAR;
    if (into < bestInto) {
      bestInto = into;
      best = m;
    }
  }
  return { month: best[0], date: Math.floor(bestInto) + 1 };
}

/** Day of the year (0 = 1 January) of a calendar date, with the time of day as a fraction. */
export function dayOfYear(date: Date): number {
  const start = new Date(date.getFullYear(), 0, 1);
  return (date.getTime() - start.getTime()) / 86400000;
}

/** The moon's age (days since new moon) on a date, from a known new moon (6 January 2000, 18:14 UTC). */
export function moonAgeOn(date: Date): number {
  const days = (date.getTime() - Date.UTC(2000, 0, 6, 18, 14)) / 86400000;
  return ((days % 29.53) + 29.53) % 29.53;
}
