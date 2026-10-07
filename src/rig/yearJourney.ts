import { SEASON_STARTS, YEAR } from '../env/season';
import { JOURNEY } from '../world/geography';
import { sweepAt } from './director';

// The year the boat's journey turns through in the cinematic mode (the user's direction): she sets out on the day
// the cinematic morning was chosen for (cinematic.ts), and as she goes the year turns on in the calendar's order
// (গ্রীষ্ম → বর্ষা → শরৎ → হেমন্ত → শীত → বসন্ত, from that day's), a stretch of her way to each season, round to
// that day again where her way begins anew. Each season holds its look over most of its stretch, the days going on
// slowly round its middle, then the year turns through to the next over the rest of the stretch, as a time-lapse
// would show it. The seasons that tell the village best (the rains, Sharat's kash and clouds) have the longest
// stretches. The clock's hour runs on as it does. (Live holds today's own date instead: main.ts.)

/** Each season's share of the way (index as SEASON_NAMES: গ্রীষ্ম, বর্ষা, শরৎ, হেমন্ত, শীত, বসন্ত). */
const STRETCH = [0.8, 1.3, 1.15, 1.0, 1.0, 0.95];
/** The share of a season's stretch it holds its look; the rest turns the year on to the next. */
const HOLD = 0.68;
/** The share of a season's days the hold goes through, about its middle. */
const HOLD_DAYS = 0.3;

const seasonLength = (i: number) => (SEASON_STARTS[(i + 1) % 6] - SEASON_STARTS[i] + YEAR) % YEAR;

export class YearJourney {
  /** [share of the way past the opening, day of the year unwrapped from the one she sets out on] */
  private readonly keys: [number, number][] = [];
  /** Where on the way the year starts its round: the opening, where she sets out (a share of the way). */
  private readonly from: number;

  /** `today`: the day of the year (0 = 1 January) she sets out on (the cinematic morning's). */
  constructor(today: number) {
    this.from = JOURNEY.opening / JOURNEY.length;
    // today's season
    let first = 0;
    let into = YEAR;
    SEASON_STARTS.forEach((start, i) => {
      const d = (today - start + YEAR) % YEAR;
      if (d < into) (into = d), (first = i);
    });
    const total = STRETCH.reduce((a, b) => a + b, 0);
    let u = 0;
    // today's season holds from today on (as far as its hold's days reach before it ends)
    const len0 = seasonLength(first);
    this.keys.push([0, today]);
    u += (STRETCH[first] / total) * HOLD;
    this.keys.push([u, today + Math.max(0, Math.min(len0 * HOLD_DAYS, len0 - into - 3))]);
    u += (STRETCH[first] / total) * (1 - HOLD);
    // and the year on round, each season holding about its middle
    let day = today - into + len0;
    for (let k = 1; k < 6; k++) {
      const i = (first + k) % 6;
      const len = seasonLength(i);
      const span = STRETCH[i] / total;
      this.keys.push([u + span * 0.08, day + len * (0.5 - HOLD_DAYS / 2)]);
      this.keys.push([u + span * (0.08 + HOLD), day + len * (0.5 + HOLD_DAYS / 2)]);
      u += span;
      day += len;
    }
    // back round to today
    this.keys.push([1, today + YEAR]);
  }

  /** The day of the year (0 = 1 January, fractional) the land shows with the boat `s` m along her way. */
  dayAt(s: number): number {
    let u = s / JOURNEY.length - this.from;
    if (u < 0) u += 1;
    const d = sweepAt(this.keys, Math.min(1, u));
    return ((d % YEAR) + YEAR) % YEAR;
  }
}
