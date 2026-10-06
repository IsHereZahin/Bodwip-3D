// A flight of ghat steps down a bank into the water, laid out once for all who need it: village.ts and
// landmarks.ts build the village's, the homesteads', the ponds' and the zamindar's from it, and geography.ts
// keeps the grass, the trees and the stones off the zamindar's. Every step rises the same and none is steeper
// than a stair can be, and every tread stands clear of the ground under it and of all the ground below it
// toward the water: where the bank is steep the flight stands out of it on its own masonry, where it is gentle
// the treads lengthen into landings, and the ground never comes up over a step. (Laid on the bank's own
// slope, the old flights' steps rose unevenly, some not at all, and the bank's shoulder stood up through
// them, grass and all.) It takes the ground as a parameter, so geography.ts can import it.

/** Where a ghat comes down to its water: its foot at the water's edge, and the way up the bank (radians, as headings). */
export interface GhatSite {
  x: number;
  z: number;
  up: number;
}

/** A tread: its top (m), and where it runs, from its edge toward the water to its back (m up the bank from the foot). */
export interface GhatStep {
  y: number;
  front: number;
  back: number;
}

export interface GhatSpec {
  /** Between its walls, and the walls' thickness (m). */
  width: number;
  wall: number;
  /** How far up the bank from the foot the landing's back lies, and the landing's least depth (m). */
  top: number;
  landing: number;
  /** The lowest the water falls (m): the flight runs on a step or two below it. */
  low: number;
}

/** What every step rises, the shortest tread, and how far each stands clear of the ground (m): the drawn ground is its lattice's, a few centimetres off the true one. */
const RISE = 0.17;
const RUN = 0.36;
const CLEAR = 0.08;
/** How finely the bank is read along the flight, and how far out into the water (m). */
const SCAN = 0.1;
const OUT = 14;

/** A point of a ghat's frame: `d` m up the bank from its foot, `s` m across it. */
export function ghatPoint(g: GhatSite, d: number, s = 0): { x: number; z: number } {
  return { x: g.x + Math.sin(g.up) * d + Math.cos(g.up) * s, z: g.z + Math.cos(g.up) * d - Math.sin(g.up) * s };
}

/** (x, z) in a ghat's frame: how far up the bank from its foot, and across it. */
export function ghatLocal(g: GhatSite, x: number, z: number): { d: number; s: number } {
  const dx = x - g.x;
  const dz = z - g.z;
  return { d: dx * Math.sin(g.up) + dz * Math.cos(g.up), s: dx * Math.cos(g.up) - dz * Math.sin(g.up) };
}

/** The steps of a ghat at `g`, from the landing at the top of the bank down into the water. */
export function ghatFlight(g: GhatSite, spec: GhatSpec, ground: (x: number, z: number) => number): GhatStep[] {
  const half = spec.width / 2 + spec.wall;
  const lanes = Math.max(2, Math.ceil((half * 2) / 0.8));
  // the highest the ground stands across the flight (its walls' too) at d up the bank
  const across = (d: number) => {
    let h = -Infinity;
    for (let k = 0; k <= lanes; k++) {
      const p = ghatPoint(g, d, -half + (k / lanes) * half * 2);
      h = Math.max(h, ground(p.x, p.z));
    }
    return h;
  };
  const n = Math.ceil((spec.top + OUT) / SCAN) + 1;
  const dAt = (k: number) => -OUT + k * SCAN;
  const heights = Array.from({ length: n }, (_, k) => across(dAt(k)));
  // from the deepest of the bed in front of the foot (beyond it the bottom may rise again to a far bank: a
  // pond's), the most the ground stands anywhere from there up to d: what a tread reaching to d must clear
  let deepest = 0;
  for (let k = 0; dAt(k) <= 0; k++) if (heights[k] < heights[deepest]) deepest = k;
  const envelope = new Float32Array(n);
  let most = -Infinity;
  for (let k = deepest; k < n; k++) envelope[k] = most = Math.max(most, heights[k]);
  /** The furthest up the bank a tread at height y can reach with the ground under it; null where the bed is too high for it. */
  const reach = (y: number) => {
    let k = n - 1;
    while (k >= deepest && envelope[k] > y - CLEAR) k--;
    return k < deepest ? null : dAt(k);
  };
  const steps: GhatStep[] = [{ y: envelope[n - 1] + CLEAR, back: spec.top, front: 0 }];
  for (;;) {
    const step = steps[steps.length - 1];
    const next = step.y - RISE;
    const least = steps.length === 1 ? spec.landing : RUN;
    const to = reach(next);
    if (to === null || next < spec.low - RISE || steps.length > 120) {
      step.front = step.back - least;
      break;
    }
    step.front = Math.min(step.back - least, to);
    steps.push({ y: next, back: step.front, front: step.front - RUN });
  }
  return steps;
}

/** The lowest and the highest the ground lies over a patch of a ghat's frame (d from `d0` to `d1`, s from `s0` to `s1`), from nine samples. */
export function groundOver(g: GhatSite, d0: number, d1: number, s0: number, s1: number, ground: (x: number, z: number) => number): { low: number; high: number } {
  let low = Infinity;
  let high = -Infinity;
  for (const d of [d0, (d0 + d1) / 2, d1]) {
    for (const s of [s0, (s0 + s1) / 2, s1]) {
      const p = ghatPoint(g, d, s);
      const h = ground(p.x, p.z);
      low = Math.min(low, h);
      high = Math.max(high, h);
    }
  }
  return { low, high };
}
