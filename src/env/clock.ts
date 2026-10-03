import { Vector3 } from 'three';
import { lerp, smoothstep } from '../core/mathx';
import { SYNODIC_MONTH, moonDirection, setSunDay, sunDirection } from './astro';
import { YEAR } from './season';

export type SkyEventKind = 'sunrise' | 'sunset' | 'moonrise' | 'moonset';

export interface SkyEvent {
  kind: SkyEventKind;
  /** Days since the start; see `Clock.time`. */
  time: number;
}

/** Playback speeds the controls step through. */
export const SPEEDS: readonly number[] = [1, 4, 16, 64];

/** Hours of sky time per real second, away from every sunrise, sunset, moonrise and moonset. */
const BASE_RATE = 0.1;
/** Hours over which the clock eases into and out of a linger. */
const RAMP = 0.25;

interface Linger {
  from: number;
  to: number;
  rate: number;
}

/**
 * Where the clock slows, in hours from each event, and how fast it runs there. Golden hour keeps the
 * longest stay. A rise lingers mostly after it and a set mostly before, while the body climbs clear
 * of, or sinks to, the tree line.
 */
const LINGER: Record<SkyEventKind, readonly Linger[]> = {
  sunset: [
    { from: -0.8, to: 0.15, rate: 0.0032 },
    { from: 0.15, to: 1.1, rate: 0.01 },
  ],
  sunrise: [{ from: -0.8, to: 0.6, rate: 0.007 }],
  moonrise: [{ from: -0.15, to: 0.55, rate: 0.008 }],
  moonset: [{ from: -0.55, to: 0.15, rate: 0.008 }],
};

/** The stretch around each event, in hours, when the camera may turn to watch it. */
const WATCH: Record<SkyEventKind, readonly [number, number]> = {
  sunrise: [-0.35, 0.45],
  sunset: [-0.45, 0.3],
  moonrise: [-0.1, 0.5],
  moonset: [-0.5, 0.1],
};

const HOUR = 1 / 24;
const SCAN_STEP = 1 / 288;
const tmp = new Vector3();

const hourOf = (time: number) => (((time % 1) + 1) % 1) * 24;

/** Times in [from, to] where `height` changes sign, refined by bisection. */
function crossings(from: number, to: number, height: (time: number) => number, rise: SkyEventKind, set: SkyEventKind, out: SkyEvent[]): void {
  let t0 = from;
  let up0 = height(t0) > 0;
  for (let t1 = from + SCAN_STEP; t1 <= to; t1 += SCAN_STEP) {
    const up1 = height(t1) > 0;
    if (up1 !== up0) {
      let a = t0;
      let b = t1;
      for (let i = 0; i < 16; i++) {
        const m = (a + b) / 2;
        if ((height(m) > 0) === up0) a = m;
        else b = m;
      }
      out.push({ kind: up1 ? rise : set, time: (a + b) / 2 });
    }
    t0 = t1;
    up0 = up1;
  }
}

/**
 * Sky time. It runs quickly through the middle of the day and the night and slows around every
 * sunrise, sunset, moonrise and moonset, so each one can be watched. The moon's age advances with
 * the days, so each night it rises later and fuller or thinner.
 */
export class Clock {
  /** Days since the start. The fraction is local solar time: 0.5 is noon. */
  time: number;
  playing = true;
  speed = SPEEDS[0];
  /** Extra speed while T is held. */
  boost = 1;
  /** Moon's age (days since new moon) at time 0. */
  private moonEpoch: number;
  /** Day of the year (0 = 1 January) at time 0. */
  private yearEpoch: number;
  private cache: SkyEvent[] = [];
  private cacheDay = Number.NaN;
  private cacheCount = 0;

  /** `yearDay`: the day of the year (0 = 1 January) the clock starts on. */
  constructor(hour: number, moonAge: number, yearDay: number) {
    this.time = hour * HOUR;
    this.moonEpoch = moonAge - this.time;
    this.yearEpoch = Math.floor(yearDay) - Math.floor(this.time);
    setSunDay(this.dayOfYear);
  }

  /** Day of the year now (0 = 1 January), fractional; the seasons and the sun's path follow it. */
  get dayOfYear(): number {
    return (((this.yearEpoch + this.time) % YEAR) + YEAR) % YEAR;
  }

  /** Moves to the same hour on another day of the year (the moon goes on with its own count). */
  setDayOfYear(day: number): void {
    this.yearEpoch = Math.floor(day) - this.day;
    setSunDay(this.dayOfYear);
    this.cacheDay = Number.NaN;
  }

  get day(): number {
    return Math.floor(this.time);
  }

  /** Local solar hour, 0..24. */
  get hour(): number {
    return (this.time - this.day) * 24;
  }

  get moonAge(): number {
    return this.ageAt(this.time);
  }

  /** Changes whenever the day's events do (a new day, or a new moon phase). */
  get revision(): number {
    this.events();
    return this.cacheCount;
  }

  setHour(hour: number): void {
    this.time = this.day + Math.min(Math.max(hour, 0), 24 - 1e-6) * HOUR;
  }

  setMoonAge(age: number): void {
    this.moonEpoch = age - this.time;
    this.cacheDay = Number.NaN;
  }

  /** Moves to just inside the start of an event's watch window, and plays. */
  jumpTo(ev: SkyEvent): void {
    this.time = ev.time + WATCH[ev.kind][0] * HOUR + 1e-6;
    this.playing = true;
  }

  advance(dt: number): void {
    if (this.playing) this.time += dt * this.speed * this.boost * this.rate() * HOUR;
  }

  /** Hours of sky time per real second, now. */
  rate(): number {
    let r = BASE_RATE;
    for (const ev of this.events()) {
      const h = (this.time - ev.time) * 24;
      for (const l of LINGER[ev.kind]) {
        const w = smoothstep(l.from - RAMP, l.from, h) * (1 - smoothstep(l.to, l.to + RAMP, h));
        if (w > 0) r = Math.min(r, lerp(BASE_RATE, l.rate, w));
      }
    }
    return r;
  }

  /** Every event from the start of yesterday to the end of tomorrow, in time order. */
  events(): readonly SkyEvent[] {
    const day = this.day;
    if (day !== this.cacheDay) {
      // the sun's path for today (it moves too little within a day to matter)
      setSunDay(this.dayOfYear);
      const out: SkyEvent[] = [];
      crossings(day - 1, day + 2, (t) => sunDirection(hourOf(t), tmp).y, 'sunrise', 'sunset', out);
      crossings(day - 1, day + 2, (t) => moonDirection(hourOf(t), this.ageAt(t), tmp).y, 'moonrise', 'moonset', out);
      this.cache = out.sort((a, b) => a.time - b.time);
      this.cacheDay = day;
      this.cacheCount++;
    }
    return this.cache;
  }

  /** Today's events. */
  today(): SkyEvent[] {
    const day = this.day;
    return this.events().filter((e) => e.time >= day && e.time < day + 1);
  }

  /** The hours of today when the moon is above the horizon, as [from, to] spans. */
  moonSpans(): [number, number][] {
    const day = this.day;
    const spans: [number, number][] = [];
    let from = moonDirection(0, this.ageAt(day), tmp).y > 0 ? 0 : -1;
    for (const ev of this.today()) {
      const h = (ev.time - day) * 24;
      if (ev.kind === 'moonrise') from = h;
      else if (ev.kind === 'moonset' && from >= 0) {
        spans.push([from, h]);
        from = -1;
      }
    }
    if (from >= 0) spans.push([from, 24]);
    return spans;
  }

  /** The next event whose watch window has not yet begun. */
  next(): SkyEvent | undefined {
    return this.events().find((e) => e.time + WATCH[e.kind][0] * HOUR > this.time + 1e-4);
  }

  /** Whether now lies in this event's watch window. */
  watching(ev: SkyEvent): boolean {
    const h = (this.time - ev.time) * 24;
    return h >= WATCH[ev.kind][0] && h <= WATCH[ev.kind][1];
  }

  /** The event whose watch window holds now, if any (the earlier one where two overlap). */
  watchable(): SkyEvent | undefined {
    return this.events().find((e) => this.watching(e));
  }

  private ageAt(time: number): number {
    return (((this.moonEpoch + time) % SYNODIC_MONTH) + SYNODIC_MONTH) % SYNODIC_MONTH;
  }
}
