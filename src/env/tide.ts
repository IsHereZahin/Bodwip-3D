import { TIDE_BAKE } from '../geo/data';
import { FREQ, RAD, predictor } from '../geo/tide';
import { moonAgeOn } from './season';

// The tide in the Moheshkhali channel (GEOGRAPHY_PLAN.md §7.3): predicted from the Cox's Bazar gauge's
// harmonic constants (baked into geo/manifest.json), its tidal amplitudes scaled up to BIWTA's published
// spring range, with the seasonal mean sea level (Sa, Ssa) in it. The clock gives a day of the year and a
// solar hour; the tide is predicted for that moment of this year, moved by whole days so that the moon's age
// there is the one shown (a viewer's full moon brings spring tides, a half moon neaps).
//
// The current is modelled [মডেল] as following the rise and fall: strongest at half tide, slack at high and
// low water, flooding up the channel while the water rises and ebbing out while it falls.

/** The site's longitude (° E): solar time to UTC. */
const LONGITUDE = 91.95;
const DAY = 86400000;
const SYNODIC = 29.53;
/** The rate the water rises at its fastest in a mean spring tide (m/s): M2 and S2 together at M2's speed. */
const SPRING_RATE =
  (TIDE_BAKE.constituents.M2.H + TIDE_BAKE.constituents.S2.H) * TIDE_BAKE.amplitudeScale * FREQ.M2 * (RAD / 3600);
/** How far back the last high water is looked for (ms): a little over one tide. */
const HIGH_LOOKBACK = 13 * 3600000;

export class Tide {
  /** The sea's level now (m about mean sea level). */
  level = 0;
  /** How fast it is rising (m/s of real time; negative when falling). */
  rate = 0;
  /** The current as a share of a spring tide's strongest: positive ebbing (toward the sea), negative flooding. */
  flow = 0;
  /** The level of the last high water (m): the flats below it are still wet. */
  high = 0;
  private readonly at = predictor(TIDE_BAKE.constituents, TIDE_BAKE.amplitudeScale);
  private readonly year = new Date().getUTCFullYear();
  private highAt = Number.NaN;

  /** The moment (ms, UTC) the tide is predicted for, for a day of the year (fractional: solar time) and the moon's age shown. */
  instant(dayOfYear: number, moonAge: number): number {
    const utc = Date.UTC(this.year, 0, 1) + dayOfYear * DAY - (LONGITUDE / 15) * 3600000;
    let off = (moonAge - moonAgeOn(new Date(utc))) % SYNODIC;
    if (off > SYNODIC / 2) off -= SYNODIC;
    if (off < -SYNODIC / 2) off += SYNODIC;
    return utc + Math.round(off) * DAY;
  }

  update(dayOfYear: number, moonAge: number): void {
    const t = this.instant(dayOfYear, moonAge);
    this.level = this.at(t);
    this.rate = (this.at(t + 300000) - this.at(t - 300000)) / 600;
    this.flow = Math.max(-1.4, Math.min(1.4, -this.rate / SPRING_RATE));
    // the last high water, looked for every quarter hour (and again only once the tide has moved on)
    if (!(Math.abs(t - this.highAt) < 900000)) {
      this.highAt = t;
      let high = -Infinity;
      for (let s = t - HIGH_LOOKBACK; s <= t; s += 900000) high = Math.max(high, this.at(s));
      this.high = high;
    }
  }

  /** The level at a moment (ms, UTC), for the debug readout and the dock's next high and low water. */
  levelAt(time: number): number {
    return this.at(time);
  }
}
