import { smoothstep } from '../core/mathx';
import { PLAIN, ROAD_RAISE, WATER_LEVEL } from './plan';
import { BRIDGE_SITE, SANKO_SITE } from './waterways';

// Where the two crossings stand, and their frames: the old brick bridge that carries the village road over
// the khal (world/bridge.ts) and the bamboo sanko that carries the field path over the side khal
// (world/sanko.ts). The roads end on them (world/roads.ts), the ground and the planting keep clear of them
// (geography.ts), and the camera eases under the arch (rig.ts).

export interface Point2 {
  x: number;
  z: number;
}

/**
 * The old bridge: a humped brick arch carrying the village road over the khal, built by the zamindars where
 * the khal narrows. Its frame: x along the bridge, across the khal; z along the khal; `angle` turns that frame
 * into the world's (as a rotation about y). Heights in the frame are above the khal's water (`water`, a world
 * height): world/bridge.ts sets the bridge there.
 */
export const BRIDGE = {
  x: BRIDGE_SITE.x,
  z: BRIDGE_SITE.z,
  angle: BRIDGE_SITE.heading,
  /** Clear span of the arch and the height it springs from (above the khal's water); its rise; the arch ring's depth. */
  span: 16,
  springing: 0.3,
  rise: 3.4,
  ring: 0.55,
  /** Between the parapets, and each parapet's thickness and height above the deck. */
  width: 3.4,
  parapet: 0.28,
  parapetHeight: 0.66,
  /** Half its length, ramps and all, and the height of the deck at its crown. */
  half: 22,
  crown: 4.6,
  /** The road's crest where the ramps come down onto it (above the water). */
  bank: PLAIN + ROAD_RAISE - WATER_LEVEL,
  /** The khal's water (world height). */
  water: WATER_LEVEL,
};

/** (x, z) in the bridge's frame: `x` along it, `z` along the khal. */
export function bridgeFrame(x: number, z: number): Point2 {
  const dx = x - BRIDGE.x;
  const dz = z - BRIDGE.z;
  const c = Math.cos(BRIDGE.angle);
  const s = Math.sin(BRIDGE.angle);
  return { x: dx * c - dz * s, z: dx * s + dz * c };
}

/** A point of the bridge's frame in the world. */
export function bridgeToWorld(bx: number, bz: number): Point2 {
  const c = Math.cos(BRIDGE.angle);
  const s = Math.sin(BRIDGE.angle);
  return { x: BRIDGE.x + bx * c + bz * s, z: BRIDGE.z - bx * s + bz * c };
}

/** Height of the arch's underside at `bx` along the bridge (−∞ beyond the span), above the khal's water. */
export function bridgeSoffit(bx: number): number {
  const half = BRIDGE.span / 2;
  if (Math.abs(bx) > half) return -Infinity;
  const r = (half * half + BRIDGE.rise * BRIDGE.rise) / (2 * BRIDGE.rise);
  return BRIDGE.springing + BRIDGE.rise - r + Math.sqrt(r * r - bx * bx);
}

/** Height of the bridge's walking surface at `bx` along it (above the khal's water): the hump of the arch, easing down the ramps to the road. */
export function bridgeDeck(bx: number): number {
  return BRIDGE.bank + (BRIDGE.crown - BRIDGE.bank) * (1 - smoothstep(0, BRIDGE.half, Math.abs(bx)));
}

/** True on the bridge's footprint, ramps and all (with `margin` m round it): nothing grows up through it. */
export function onBridge(x: number, z: number, margin = 0.4): boolean {
  const f = bridgeFrame(x, z);
  return Math.abs(f.x) < BRIDGE.half + margin && Math.abs(f.z) < BRIDGE.width / 2 + BRIDGE.parapet + margin;
}

/** The bridge's two ends, where the road meets its ramps: east and west. */
export function bridgeEnds(): { e: Point2; w: Point2 } {
  const a = bridgeToWorld(-BRIDGE.half, 0);
  const b = bridgeToWorld(BRIDGE.half, 0);
  // +x is west
  return a.x < b.x ? { e: a, w: b } : { e: b, w: a };
}

/**
 * The bamboo sanko carrying the field path over the side khal: its middle and the side khal's heading there
 * (it crosses square to it), `half` m from its middle to each landing, its walkway's height at the middle, the
 * clear way for boats under it, and the water (heights in its frame are above the water's mean level).
 *
 * The boat's way goes under it (waterways.ts JOURNEY_LINE). Her tallest is the boatman standing at her stern
 * under his mathal, ≈2.2 m over the water; the rains raise the water up to 0.85 m: so the walkway rises in a
 * high hump to `crown`, and its middle span (±`gap`) stands on no trestles, wide enough for her and the paddle's
 * reach. Long approaches keep the climb walkable, with bamboo rungs where it is steep.
 */
export const SANKO = {
  x: SANKO_SITE.x,
  z: SANKO_SITE.z,
  angle: SANKO_SITE.heading,
  half: SANKO_SITE.half + 7.5,
  crown: 3.7,
  gap: 2.8,
  /** The fields' level at its landings (where the walkway comes down to the path). */
  bank: PLAIN - WATER_LEVEL,
  water: WATER_LEVEL,
};

/** The sanko's walkway's height at `a` m along it from its middle, from `ends` at its landings (above the water's mean). */
export function sankoDeck(a: number, ends = SANKO.bank): number {
  const t = Math.min(1, Math.abs(a) / SANKO.half);
  return ends + (SANKO.crown - ends) * (1 - t * t);
}

/** (a, b) in the sanko's frame: `a` along it (across the side khal), `b` along the side khal (sankoToWorld's inverse). */
export function sankoFrame(x: number, z: number): { a: number; b: number } {
  const c = Math.cos(SANKO.angle);
  const s = Math.sin(SANKO.angle);
  const dx = x - SANKO.x;
  const dz = z - SANKO.z;
  return { a: dx * c - dz * s, b: dx * s + dz * c };
}

/** A point of the sanko's frame in the world: `a` along it (across the side khal), `b` along the side khal. */
export function sankoToWorld(a: number, b: number): Point2 {
  const c = Math.cos(SANKO.angle);
  const s = Math.sin(SANKO.angle);
  return { x: SANKO.x + a * c + b * s, z: SANKO.z - a * s + b * c };
}

/** The sanko's two landings, south and north. */
export function sankoEnds(): { s: Point2; n: Point2 } {
  const a = sankoToWorld(-SANKO.half, 0);
  const b = sankoToWorld(SANKO.half, 0);
  return a.z < b.z ? { s: a, n: b } : { s: b, n: a };
}

/** True on the sanko's footprint (with `margin` m round it). */
export function onSanko(x: number, z: number, margin = 0.4): boolean {
  const c = Math.cos(SANKO.angle);
  const s = Math.sin(SANKO.angle);
  const dx = x - SANKO.x;
  const dz = z - SANKO.z;
  return Math.abs(dx * c - dz * s) < SANKO.half + margin && Math.abs(dx * s + dz * c) < 0.8 + margin;
}
