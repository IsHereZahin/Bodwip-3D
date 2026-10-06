import { Vector3 } from 'three';
import { clamp, lerp, smoothstep } from '../core/mathx';
import { JOURNEY, journeyAt, terrainHeight, waterwayAt } from '../world/geography';
import type { Sightlines } from './sightlines';

// The opening flight (the user's direction): before the journey begins, a drone's descent from over the river
// ahead of the boat, looking back up it at her and the sunrise; down over the water, the village's bank beside it,
// to low over the open water ahead of her and to one side, where it turns a little to frame her coming on, her majhi
// and the morning behind her, and the follow camera takes over. About nine seconds (2026-10-07: the user found 22 s
// too long, and asked for 5 to 10): so it sets off nearer and lower than a long flight would, and ends ahead of her
// rather than going round behind her (that half-turn in so short a time would whip the picture round). The sun
// comes up as it comes down (rig/cinematic.ts `SUNRISE`).
//
// The high part is laid by keys in the way's own frame (along it, out from it), so it bends with the river. The
// last part goes round her by her bearing from the camera, eased from ahead of her to the follow camera's place:
// how fast the picture turns is how fast that bearing turns, so it can never whip round, and the camera keeps a
// few metres out from her way, over the open water, while she comes past. Over all of it lies a floor laid out as
// it sets off: well over the trees, the palms and the houses wherever they stand under or beside its path (where
// they stand is known: rig/sightlines.ts), risen to in good time and smoothly, so the camera never brushes a crown
// or catches on one and jumps clear.

/** The flight's length (s); its last `HANDOFF` s ease into the follow camera's pose. */
export const OPENING_SECONDS = 9;
export const HANDOFF = 2.5;
/** The share of the flight spent gathering speed (the round eases itself to rest). */
const SET_OFF = 0.15;

/**
 * The high part's keys: time (s); where the camera is: along the way from the boat (m, ahead +), out from the way
 * (m, toward the flight's side), height over the water (m); where it looks: along the way from the boat (m), how
 * high over the water (m), and how much it has turned to the boat (0..1). It sets off looking up the river to its
 * horizon, where the cinematic morning's sun rises (rig/cinematic.ts), and tilts down to her as it comes down.
 */
const KEYS: { t: number; a: number; c: number; h: number; look: number; up: number; boat: number }[] = [
  { t: 0, a: 130, c: 30, h: 56, look: 40, up: 30, boat: 0 },
  { t: 2.2, a: 85, c: 20, h: 34, look: 22, up: 12, boat: 0.3 },
  { t: 3.8, a: 52, c: 12, h: 17, look: 8, up: 0, boat: 0.7 },
];

/**
 * The round: from `from` s (flight time), when the camera is `ahead` m ahead of what the follow camera looks at
 * and `out` m out from her way (toward the follow camera's side) at `high` m over the water, the bearing turning
 * `rate` rad/s; out at `out` while she comes on, at `side` m over the water once it is beside her.
 */
const ROUND = { from: 5, ahead: 30, out: 8, high: 9, side: 4.5, rate: 0.1 };
/** By this bearing (from ahead of her) the round has come down to `ROUND.side`. */
const DOWN_BY = Math.PI / 3;

/**
 * Over land, or by a bank where the trees lean out over the water, the camera keeps this far over the ground (m):
 * over the tallest crowns and palms (where nothing says where they stand). Where it is known, it keeps `CLEAR` m
 * over what stands within `AROUND` m of it, and `OPEN` m over open ground (the bushes and the bananas are not known).
 */
const CANOPY = 26;
const CLEAR = 5;
const AROUND = 6;
const OPEN = 9;
/** Over the open water it may come down to this (m over the water): under the follow camera's place. */
const LOW = 1.5;
/** Inside the water's edge (m): the bank's trees reach out to the first, the water is open past the second. */
const REACH: readonly [number, number] = [2, 10];
/** The boat's usual way (m/s), for where she will be as the flight goes on. */
const CRUISE = 1.2;
/** The floor's samples a second, how far ahead it is risen to (s), and how far it is smoothed (s). */
const RATE = 20;
const AHEAD = 1.2;
const SMOOTH = 0.9;
/** Within this of the floor (m) the path's own height gives way to it softly. */
const BLEND = 3;

/** How far either side the way's heading is taken across (m): see `wayAt`. */
const TANGENT = 12;

/**
 * The follow camera's place, where the flight ends: along the way from the boat (m), out from it (m, left +), over
 * the water (m); and how far along the way from her what it looks at is (m).
 */
export interface RestPlace {
  a: number;
  c: number;
  h: number;
  focus: number;
}

/**
 * The way's point `s` m along it, and its heading there taken across `TANGENT` m either side of it: the way's own
 * heading turns in steps at its points 2 m apart, and 60 m out from it each step would shake the camera aside.
 */
export function wayAt(s: number): { x: number; z: number; heading: number } {
  const p = journeyAt(clamp(s, 0, JOURNEY.length));
  const a = journeyAt(clamp(s - TANGENT, 0, JOURNEY.length));
  const b = journeyAt(clamp(s + TANGENT, 0, JOURNEY.length));
  p.heading = Math.atan2(b.x - a.x, b.z - a.z);
  return p;
}

/**
 * The keys' value `v(j)` at time `tau` (s), between keys `i` and `i + 1`, the last key's slope `end` (per second):
 * a cubic through them whose slope at each other key (per second) is its neighbours' difference over their time
 * apart (Catmull-Rom for keys unevenly spaced in time). Taken per key's step instead, the pace jumped at every key
 * where the steps differ in length.
 */
function curve(v: (j: number) => number, last: number, i: number, tau: number, end: number, time: (j: number) => number): number {
  const slope = (j: number) => {
    if (j === last) return end;
    const a = Math.max(0, j - 1);
    const b = Math.min(last, j + 1);
    return (v(b) - v(a)) / (time(b) - time(a));
  };
  const h = time(i + 1) - time(i);
  const u = clamp((tau - time(i)) / h, 0, 1);
  const u2 = u * u;
  const u3 = u2 * u;
  return (2 * u3 - 3 * u2 + 1) * v(i) + (u3 - 2 * u2 + u) * h * slope(i) + (3 * u2 - 2 * u3) * v(i + 1) + (u3 - u2) * h * slope(i + 1);
}

/**
 * Which side of the river the flight comes down over: the one whose bank lies lower under its path (the
 * village's, not the hills'), for a boat `along` m on her way.
 */
export function openingSide(along: number): number {
  let score = 0;
  for (const k of KEYS) {
    const p = wayAt(along + k.a);
    for (const side of [1, -1]) {
      const h = terrainHeight(p.x + Math.cos(p.heading) * k.c * side, p.z - Math.sin(p.heading) * k.c * side);
      score += side * h;
    }
  }
  return score > 0 ? -1 : 1;
}

/** The flight's own time at `t` s: gathering speed evenly over its first share, an even pace after. */
function flightTime(t: number): number {
  const x = clamp(t / OPENING_SECONDS, 0, 1);
  const v = 1 / (1 - SET_OFF / 2);
  return OPENING_SECONDS * (x < SET_OFF ? (v * x * x) / (2 * SET_OFF) : v * (x - SET_OFF / 2));
}

/** The bearing where the round begins (radians from ahead of what it looks at). */
const BEARING_FROM = Math.atan2(ROUND.out, ROUND.ahead);

/**
 * The round at flight time `tau`: the bearing of what the follow camera looks at (her bow) from the camera,
 * eased from where the high part leaves it (turning at `ROUND.rate`) to the follow camera's at `rest`, coming to
 * rest there; the camera out at `ROUND.out` while she comes past, drawn to the follow camera's place behind her.
 * Into `out`: along, out (toward the rest side), height.
 */
function roundAt(tau: number, rest: RestPlace, out: { a: number; c: number; h: number }): void {
  // (a follow camera right behind her would leave no bearing to end on: the hand-over takes up the last metre)
  const restOut = Math.max(Math.abs(rest.c), 1);
  const end = Math.atan2(restOut, rest.a - rest.focus);
  const d = OPENING_SECONDS - ROUND.from;
  const u = clamp((tau - ROUND.from) / d, 0, 1);
  const u2 = u * u;
  const u3 = u2 * u;
  const bearing = (2 * u3 - 3 * u2 + 1) * BEARING_FROM + (u3 - 2 * u2 + u) * ROUND.rate * d + (3 * u2 - 2 * u3) * end;
  // drawn to the follow camera's place: once past her, for a place behind her; on the way to it, for one ahead
  const behind = end > Math.PI / 2 ? smoothstep(Math.PI / 2, end, bearing) : smoothstep(BEARING_FROM, end, bearing);
  out.c = lerp(ROUND.out, restOut, behind);
  out.a = rest.focus + out.c / Math.tan(bearing);
  out.h = lerp(lerp(ROUND.high, ROUND.side, smoothstep(BEARING_FROM, DOWN_BY, bearing)), rest.h, behind);
}

const roundPlace = { a: 0, c: 0, h: 0 };

/** The path's own pose at flight time `tau`, before its floor: place (`pos`, its y the height over the water) and the look's keys. */
function pathAt(tau: number, along: number, side: number, rest: RestPlace, pos: Vector3): { look: number; up: number; boat: number } {
  const restSide = rest.c >= 0 ? 1 : -1;
  let a: number;
  let out: number;
  let h: number;
  let look = 0;
  let up = 0;
  let boat = 1;
  if (tau >= ROUND.from) {
    roundAt(tau, rest, roundPlace);
    a = roundPlace.a;
    out = roundPlace.c * restSide;
    h = roundPlace.h;
  } else {
    // the high keys, and where the round begins as their last, met at the round's own pace
    const last = KEYS.length;
    const time = (j: number) => (j === last ? ROUND.from : KEYS[j].t);
    const pace = (-ROUND.out * ROUND.rate) / Math.sin(BEARING_FROM) ** 2;
    let i = 0;
    while (i < last - 1 && time(i + 1) <= tau) i++;
    const key = (j: number, k: 'a' | 'h' | 'look' | 'up' | 'boat', at: number) => (j === last ? at : KEYS[j][k]);
    a = curve((j) => key(j, 'a', rest.focus + ROUND.ahead), last, i, tau, pace, time);
    h = curve((j) => key(j, 'h', ROUND.high), last, i, tau, 0, time);
    look = curve((j) => key(j, 'look', 0), last, i, tau, 0, time);
    // (the cubic dips a little under its last key on the way to the round's: never below the water)
    up = Math.max(0, curve((j) => key(j, 'up', 0), last, i, tau, 0, time));
    boat = curve((j) => key(j, 'boat', 1), last, i, tau, 0, time);
    out = curve((j) => (j === last ? ROUND.out * restSide : KEYS[j].c * side), last, i, tau, 0, time);
  }
  const p = wayAt(along + a);
  pos.set(p.x + Math.cos(p.heading) * out, h, p.z - Math.sin(p.heading) * out);
  return { look, up, boat };
}

/**
 * Where the flight looks `t` s in, while it is still between its first two keys (its view there does not depend on
 * where the follow camera rests), for a boat setting out `along` m on her way at her usual pace, the flight over
 * `side`: its bearing (rad, x = sin, z = cos) and pitch (rad). For framing what rises in its first seconds.
 */
export function highView(t: number, along: number, side: number): { bearing: number; pitch: number } {
  const at = Math.min(t, KEYS[1].t);
  const pos = new Vector3();
  const keys = pathAt(flightTime(at), along + CRUISE * at, side, { a: 0, c: 0, h: 0, focus: 0 }, pos);
  const q = wayAt(along + CRUISE * at + keys.look);
  const boat = wayAt(along + CRUISE * at);
  const k = clamp(keys.boat, 0, 1);
  const dx = lerp(q.x, boat.x, k) - pos.x;
  const dz = lerp(q.z, boat.z, k) - pos.z;
  return { bearing: Math.atan2(dx, dz), pitch: Math.atan2(lerp(keys.up, 0, k) - pos.y, Math.hypot(dx, dz)) };
}

/**
 * The least height (m) over (x, z): well over the trees on land and by a bank, coming down over the open water; with
 * `lines`, over what stands there and round it, low wherever nothing does.
 */
function clearance(x: number, z: number, water: number, lines: Sightlines | null): number {
  const ground = Math.max(terrainHeight(x, z), water);
  const w = waterwayAt(x, z);
  const inside = w ? w.half - w.d : -Infinity;
  if (!lines) return lerp(ground + CANOPY, water + LOW, smoothstep(REACH[0], REACH[1], inside));
  let top = lines.top(x, z);
  for (let a = 0; a < 6; a++) top = Math.max(top, lines.top(x + Math.sin(a * 1.047) * AROUND, z + Math.cos(a * 1.047) * AROUND));
  const open = lerp(ground + OPEN, water + LOW, smoothstep(REACH[0], REACH[1], inside));
  return Math.max(open, top > ground + 0.5 ? top + CLEAR : -Infinity);
}

/**
 * The flight's floor, laid once as it sets off from a boat `along` m on her way (going on at her usual pace),
 * coming down over `side` and ending at `rest`, the water at `water`: at each moment the least height the camera
 * keeps, risen to a little ahead of what it clears and eased, so it lifts and settles smoothly.
 */
export function openingFloor(along: number, side: number, rest: RestPlace, water: number, lines: Sightlines | null = null): Float32Array {
  const n = Math.ceil(OPENING_SECONDS * RATE) + 1;
  const raw = new Float32Array(n);
  const pos = new Vector3();
  for (let i = 0; i < n; i++) {
    const t = i / RATE;
    pathAt(flightTime(t), along + CRUISE * t, side, rest, pos);
    raw[i] = clearance(pos.x, pos.z, water, lines);
  }
  // risen to ahead of what it clears, and held until past it (at least as far as it is eased, so the easing never
  // takes it under what it clears)
  const lifted = new Float32Array(n);
  const reach = Math.round(AHEAD * RATE);
  for (let i = 0; i < n; i++) {
    let m = -Infinity;
    for (let j = Math.max(0, i - reach); j <= Math.min(n - 1, i + reach); j++) m = Math.max(m, raw[j]);
    lifted[i] = m;
  }
  const floor = new Float32Array(n);
  const w = Math.round(SMOOTH * RATE);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    let count = 0;
    for (let j = Math.max(0, i - w); j <= Math.min(n - 1, i + w); j++) {
      const k = 1 - Math.abs(j - i) / (w + 1);
      sum += lifted[j] * k;
      count += k;
    }
    floor[i] = sum / count;
  }
  return floor;
}

/** The floor at `t` s (between its samples). */
function floorAt(floor: Float32Array, t: number): number {
  const f = clamp(t * RATE, 0, floor.length - 1.0001);
  const i = Math.floor(f);
  return floor[i] + (floor[i + 1] - floor[i]) * (f - i);
}

/**
 * The flight's camera at `t` s: its place (`pos`) and where it looks (`look`), for a boat `along` m on her way
 * (the follow camera's target there: `target`), the flight coming down over `side` (+1 left of her way) and
 * ending at `rest`, the water at `water`, kept over its `floor` (openingFloor).
 */
export function openingPose(t: number, along: number, side: number, rest: RestPlace, water: number, target: Vector3, floor: Float32Array, pos: Vector3, look: Vector3): void {
  const keys = pathAt(flightTime(t), along, side, rest, pos);
  // its own height over the water, or the floor where that is higher, the one taking over from the other softly
  // within BLEND of it (and the path untouched farther over it)
  const own = water + pos.y;
  const least = floorAt(floor, t);
  const near = Math.max(0, BLEND - Math.abs(own - least));
  pos.y = Math.max(own, least) + (near * near) / (4 * BLEND);
  const q = wayAt(along + keys.look);
  look.set(q.x, water, q.z).lerp(target, clamp(keys.boat, 0, 1));
  look.y = lerp(water + keys.up, target.y, clamp(keys.boat, 0, 1));
}
