import { Vector3 } from 'three';
import { clamp, smoothstep } from '../core/mathx';
import type { SeasonState } from '../env/season';
import { BIL, BRIDGE, HOMESTEAD_MOUNDS, JOURNEY, PONDS, SANKO, WATER_LEVEL, grandGhat, journeyAt, journeyFrame, saltPoint, terrainHeight } from '../world/geography';
import { BANYAN, GRAVE_BANYAN, HILLS, HUB_GHAT, MOSQUE, SALT_FIELDS, TEA_STALL, ZAMINDAR } from '../world/plan';
import { kashStand } from '../world/vegetation';
import type { Ghat } from '../world/village';
import { FISHER_SITE } from '../world/fisher';
import type { Sightlines } from './sightlines';

// What the camera turns to by itself as the boat goes on her way (the user's direction): the village's sights,
// each described once (where it is, how big, what it is worth, the side it is best seen from, when it is worth
// seeing), and the stretch of her way where each is seen best, found from the village as it stands: sampled along
// her way for how near it is, how big it would stand in the frame, where it lies from her and whether the banks,
// the trees or the houses hide it. Where and how the camera shows it is composed as she goes (compose.ts).
//
// A new landmark is one more `add` in `findSights`: its stretch and its shots follow by themselves.

/** What the camera knows of the world now, for what a sight is worth: the season's look and how dark it is. */
export interface SightNow {
  season: SeasonState;
  /** 0 by day, 1 in the dark. */
  night: number;
}

/** A sight, as it is described. */
export interface SightSpec {
  /** What it is (for the debug list). */
  name: string;
  /** Its middle: what the frame holds (m). */
  x: number;
  z: number;
  /** Its middle's height over the ground there (m). */
  up: number;
  /** How big it is: the radius the frame should hold (m). */
  size: number;
  /** What it is worth (1 a passing homestead … 10 the crossings she goes under). */
  rank: number;
  /** A point on the side it is best seen from (its front: a ghat's water, the mosque's pond). */
  front?: { x: number; z: number };
  /** How far from her (m) it is still worth turning to; by default from its size. */
  reach?: number;
  /** What it is worth now (0..1): the kash only in plume, the lit mosque after dark. By default less after dark. */
  worth?: (now: SightNow) => number;
}

/** A sight placed along her way. */
export interface Sight extends Readonly<SightSpec> {
  /** Its middle (world). */
  at: Vector3;
  /** Where along her way (m) it is seen best. */
  s: number;
  /** How well it is seen there (0..1). */
  best: number;
  /** The stretch of her way (m along it) it is seen well from. */
  seen: { readonly from: number; readonly to: number };
  /**
   * Whether the camera shows it by itself now (`chooseShown`: not while another near it is worth more), and its part
   * of `seen` it is shown over: the camera is with it from `from` to `to`.
   */
  shown: boolean;
  from: number;
  to: number;
}

/** Along her way, how far apart (m) a sight is looked for, and from what heights over the water (m): low by her, and over the banks. */
const STEP = 6;
const EYES = [3.5, 11];
/** A sight's stretch: at least, at most (m), and how much of its best it keeps to. */
const LEAST = 20;
const MOST = 42;
const KEEP = 0.55;
/** The least of her way (m) between one sight's stretch and the next: there the camera shows her surroundings. */
const GAP = 24;
/** Over how much of her way (m) the camera eases to a sight and back. */
const EASE = 8;
/** Where along her way sights begin (m): past where she sets out again after the mist (rig.ts LOOP_FADE). */
const START = 6;
/** What a sight must be worth now to be shown by itself (0..1). */
const WORTHY = 0.35;
/** Half the camera's height of view (rad), for how big a sight would stand in the frame. */
const HALF_VIEW = 0.44;

/** What a sight is worth after dark, unless it says otherwise: little, the land being dark. */
const byDay = (now: SightNow) => 1 - 0.75 * now.night;

/** How much of the way to a sight (m before it) is its own: its mound, its own crown (a banyan), not in the way of it. */
export const ownReach = (spec: SightSpec) => spec.size * 0.9;

/** How well a sight at `at` (`size` m across its middle) is seen with her `s` m along her way (0..1). */
function seenFrom(spec: SightSpec, at: Vector3, s: number, lines: Sightlines, eye: Vector3, top: Vector3): number {
  const p = journeyAt(s);
  const d = Math.hypot(at.x - p.x, at.z - p.z);
  if (d > (spec.reach ?? clamp(spec.size * 8, 50, 260))) return 0;
  // how big it would stand in the frame: best about half its height, far less too small, a little less too big
  const f = Math.atan(spec.size / Math.max(d, 1)) / HALF_VIEW;
  const big = Math.exp(-((Math.log(f / 0.45) / (f < 0.45 ? 0.8 : 1.4)) ** 2));
  // where it lies from her: beside her or ahead is best, right ahead a little less (she hides it), behind her least
  const ang = Math.acos(clamp(((at.x - p.x) * Math.sin(p.heading) + (at.z - p.z) * Math.cos(p.heading)) / Math.max(d, 1), -1, 1));
  const aspect = (ang < 0.3 ? 0.75 : 1) * (1 - 0.7 * smoothstep(2.1, 2.9, ang));
  if (big * aspect < 0.05) return 0;
  top.copy(at).setY(at.y + spec.size * 0.4);
  let seen = 0;
  for (const h of EYES) {
    eye.set(p.x, WATER_LEVEL + h, p.z);
    seen = Math.max(seen, (lines.sees(eye, at, ownReach(spec)) + lines.sees(eye, top, ownReach(spec))) / 2);
  }
  return seen * big * aspect;
}

/** Where along her way `spec` is seen best, and its stretch there; null if it is never seen from her way. */
function placeOnWay(spec: SightSpec, lines: Sightlines): Sight | null {
  const at = new Vector3(spec.x, terrainHeight(spec.x, spec.z) + spec.up, spec.z);
  const reach = spec.reach ?? clamp(spec.size * 8, 50, 260);
  // her way's nearest point to it, and the stretch of her way within its reach
  const f = journeyFrame(spec.x, spec.z);
  let near = f ? f.s : -1;
  if (near < 0) {
    let best = Infinity;
    for (let s = 0; s <= JOURNEY.length; s += 10) {
      const p = journeyAt(s);
      const d = Math.hypot(p.x - spec.x, p.z - spec.z);
      if (d < best) (best = d), (near = s);
    }
    if (best > reach) return null;
  }
  // (from where she sets out again after the mist, past its first metres)
  const first = Math.max(START, near - reach);
  const last = Math.min(JOURNEY.length - 50, near + reach);
  if (last <= first) return null;
  const eye = new Vector3();
  const top = new Vector3();
  const score: number[] = [];
  for (let s = first; s <= last; s += STEP) score.push(seenFrom(spec, at, s, lines, eye, top));
  let peak = 0;
  for (let i = 1; i < score.length; i++) if (score[i] > score[peak]) peak = i;
  if (score[peak] < 0.12) return null;
  // its stretch: as far either side of its best as it is still seen well, kept between LEAST and MOST
  let a = peak;
  let b = peak;
  while (a > 0 && score[a - 1] >= score[peak] * KEEP) a--;
  while (b < score.length - 1 && score[b + 1] >= score[peak] * KEEP) b++;
  const s = first + peak * STEP;
  let from = Math.max(first + a * STEP, s - MOST * 0.6);
  let to = Math.min(first + b * STEP, s + MOST * 0.4);
  const short = LEAST - (to - from);
  if (short > 0) (from -= short / 2), (to += short / 2);
  from = Math.max(from, START);
  to = Math.min(to, JOURNEY.length - 50);
  return { ...spec, at, s, best: score[peak], seen: { from, to }, shown: false, from, to };
}

/**
 * The village's sights, each placed along her way. Which are shown by themselves is chosen as she goes
 * (`chooseShown`); the rest are framed when they are in view (compose.ts).
 */
export function findSights(ghats: readonly Ghat[], lines: Sightlines): Sight[] {
  const specs: SightSpec[] = [];
  const add = (spec: SightSpec) => specs.push(spec);
  // the water's side of a point on the bank: her way's nearest point
  const waterSide = (x: number, z: number) => {
    const f = journeyFrame(x, z);
    return f ? journeyAt(f.s) : undefined;
  };

  // the crossings she goes under
  add({ name: 'পুরোনো সেতু', x: BRIDGE.x, z: BRIDGE.z, up: 2.6, size: 12, rank: 10, worth: () => 1 });
  add({ name: 'বাঁশের সাঁকো', x: SANKO.x, z: SANKO.z, up: 2.6, size: 10, rank: 9, worth: () => 1 });
  // the landmarks: the zamindar house from the river, its grand ghat before it; the mosque across its pond, its
  // doors lit after dark; the banyan over the village's ghat; the graveyard's banyan
  const gg = grandGhat();
  if (gg) {
    const mx = (ZAMINDAR.x + gg.round.x) / 2;
    const mz = (ZAMINDAR.z + gg.round.z) / 2;
    add({ name: 'জমিদারবাড়ি', x: mx, z: mz, up: 5, size: Math.hypot(ZAMINDAR.x - gg.round.x, ZAMINDAR.z - gg.round.z) / 2 + 12, rank: 9, front: gg.site, reach: 260 });
  }
  add({ name: 'মসজিদ', x: MOSQUE.x, z: MOSQUE.z, up: 6, size: 14, rank: 9, front: MOSQUE.pond, reach: 200, worth: () => 1 });
  add({ name: 'বটতলার ঘাট', x: BANYAN.x, z: BANYAN.z, up: 8, size: 15, rank: 8, front: { x: HUB_GHAT[0], z: HUB_GHAT[1] }, worth: () => 1 });
  add({ name: 'চায়ের দোকান', x: TEA_STALL.x, z: TEA_STALL.z, up: 2, size: 6, rank: 5 });
  add({ name: 'কবরস্থানের বট', x: GRAVE_BANYAN.x, z: GRAVE_BANYAN.z, up: 8, size: 13, rank: 5, reach: 140 });
  // the hills by the water
  for (const h of HILLS) add({ name: 'পাহাড়', x: h.x, z: h.z, up: h.h * 0.45, size: Math.min(h.r * 0.5, 70), rank: 6, reach: 320 });
  // the bil opening out as she comes into it, its shapla in bloom
  add({ name: 'শাপলা বিল', x: BIL.x, z: BIL.z, up: 0.5, size: 110, rank: 8, worth: (n) => (0.6 + 0.4 * n.season.lily) * (1 - 0.6 * n.night) });
  // the kash in plume (Sharat), the fisherman at his net, the salt farms (salt in the dry months, a gher in the rains)
  const kash = kashStand();
  if (kash) add({ name: 'কাশবন', x: kash.x, z: kash.z, up: 1.5, size: 24, rank: 7, worth: (n) => smoothstep(0.25, 0.6, n.season.kash) * (1 - 0.7 * n.night) });
  add({ name: 'জেলের জাল', x: FISHER_SITE.x, z: FISHER_SITE.z, up: 1.2, size: 7, rank: 6 });
  for (const farm of SALT_FIELDS) {
    const c = saltPoint(farm.w / 2, farm.d / 2, farm);
    add({ name: 'লবণ মাঠ', x: c.x, z: c.z, up: 0.5, size: Math.max(farm.w, farm.d) / 2, rank: 6 });
  }
  // the ponds, the ghats and the homesteads on the banks, each seen from the water
  for (const p of PONDS) add({ name: 'পুকুর', x: p.x, z: p.z, up: 0.6, size: Math.max(p.r, 8), rank: 4 });
  for (const g of ghats) add({ name: 'ঘাট', x: g.x, z: g.z, up: 1.2, size: 5, rank: 3.5, front: waterSide(g.x, g.z), reach: 45 });
  for (const m of HOMESTEAD_MOUNDS) add({ name: 'বাড়ি', x: m.x, z: m.z, up: 3, size: Math.max(m.hu, m.hv), rank: 2.5, front: waterSide(m.x, m.z), reach: 80 });

  return specs
    .map((spec) => placeOnWay(spec, lines))
    .filter((s): s is Sight => s !== null)
    .sort((a, b) => a.s - b.s);
}

/**
 * Chooses which sights are shown by themselves, by what each is worth now (the kash in Sharat, the lit mosque
 * after dark): the most telling first, each over the part of its stretch the others leave free (`GAP` m clear of
 * theirs), if that is still long enough. `keep` (the one the camera is with) keeps its stretch, and none begins
 * behind her `along` m on her way (the camera would not ease into it).
 */
export function chooseShown(sights: readonly Sight[], now: SightNow, keep: Sight | null, along: number): void {
  const worth = new Map<Sight, number>();
  for (const s of sights) worth.set(s, s === keep ? Infinity : sightWorth(s, now) >= WORTHY ? s.rank * s.best * sightWorth(s, now) : 0);
  const order = sights.filter((s) => (worth.get(s) ?? 0) > 0).sort((a, b) => (worth.get(b) ?? 0) - (worth.get(a) ?? 0));
  for (const s of sights) if (s !== keep) s.shown = false;
  const taken: Sight[] = [];
  for (const c of order) {
    if (c === keep) {
      taken.push(c);
      continue;
    }
    // its stretch less what the others shown take, and what is already behind her: the longest piece left
    let pieces: [number, number][] = [[c.seen.from, c.seen.to]];
    const cut = (a: number, b: number) => {
      pieces = pieces.flatMap(([p, q]): [number, number][] => (b <= p || a >= q ? [[p, q]] : ([[p, Math.min(q, a)], [Math.max(p, b), q]] as [number, number][]).filter(([u, v]) => v > u)));
    };
    for (const o of taken) cut(o.from - GAP, o.to + GAP);
    if (c.seen.from < along + 2 && c.seen.to > along) cut(-Infinity, along + 2);
    let best: [number, number] | null = null;
    for (const p of pieces) if (!best || p[1] - p[0] > best[1] - best[0]) best = p;
    if (!best || best[1] - best[0] < LEAST) continue;
    c.shown = true;
    c.from = best[0];
    c.to = best[1];
    taken.push(c);
  }
}

/** How much the camera is with `sight` with her `along` m on her way (0..1): easing in, holding, easing out. */
export function sightWeight(sight: Sight, along: number): number {
  if (!sight.shown) return 0;
  return smoothstep(sight.from, sight.from + EASE, along) * (1 - smoothstep(sight.to - EASE, sight.to, along));
}

/** What `sight` is worth now (0..1). */
export function sightWorth(sight: Sight, now: SightNow): number {
  return (sight.worth ?? byDay)(now);
}
