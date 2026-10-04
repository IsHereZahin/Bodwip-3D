import { BRIDGE, bridgeDeck, bridgeFrame, onBridge, terrainHeight, waterLevelAt } from './geography';
import { jettyDecks, stairAt, type Deck } from './moheshkhali';

// Where someone on foot can stand, and how high (GEOGRAPHY_PLAN.md §9): the ground (the roads lie on it,
// levelled to their crests), the jetties' decks and their heads, the stair up to Adinath temple, the old
// bridge's deck; into the water no deeper than the knee; never through a building's walls.

/** The deepest water one wades (m): to the knee. */
export const KNEE = 0.45;

export interface Footing {
  /** What the foot stands on (m about MSL). */
  y: number;
  /** How deep the water there is (m), 0 on dry ground. */
  depth: number;
}

let decks: Deck[] | null = null;

/** The deck under (x, z), if any (the highest, where two overlap). */
function deckAt(x: number, z: number): number | null {
  decks ??= jettyDecks();
  let top: number | null = null;
  for (const d of decks) {
    const dx = x - d.x;
    const dz = z - d.z;
    if (Math.abs(dx * d.ux + dz * d.uz) > d.half || Math.abs(-dx * d.uz + dz * d.ux) > d.wide - 0.25) continue;
    top = top === null ? d.top : Math.max(top, d.top);
  }
  return top;
}

/** What a foot at (x, z) stands on, and the water over it. */
export function footing(x: number, z: number, out: Footing = { y: 0, depth: 0 }): Footing {
  let y = terrainHeight(x, z);
  const deck = deckAt(x, z);
  if (deck !== null) y = Math.max(y, deck);
  const stair = stairAt(x, z);
  if (stair !== null) y = Math.max(y, stair);
  if (onBridge(x, z, -0.2)) y = Math.max(y, BRIDGE.water + bridgeDeck(bridgeFrame(x, z).x));
  out.y = y;
  const water = waterLevelAt(x, z);
  out.depth = Number.isFinite(water) ? Math.max(0, water - y) : 0;
  return out;
}

// ---------- walls ----------

/** A building's footprint: its middle, length along `ry` and width. */
export interface Footprint {
  x: number;
  z: number;
  ry: number;
  l: number;
  w: number;
}

const CELL = 24;
const walls = new Map<string, Footprint[]>();

/** The buildings one cannot walk through (the huts and the map's buildings as they stand). */
export function setWalls(list: readonly Footprint[]): void {
  walls.clear();
  for (const f of list) {
    const r = 0.5 * Math.hypot(f.l, f.w);
    for (let i = Math.floor((f.x - r) / CELL); i <= Math.floor((f.x + r) / CELL); i++) {
      for (let j = Math.floor((f.z - r) / CELL); j <= Math.floor((f.z + r) / CELL); j++) {
        const key = `${i}:${j}`;
        let cell = walls.get(key);
        if (!cell) walls.set(key, (cell = []));
        cell.push(f);
      }
    }
  }
}

/** Whether a body `r` m round at (x, z) runs into a building's walls. */
export function walled(x: number, z: number, r: number): boolean {
  const cell = walls.get(`${Math.floor(x / CELL)}:${Math.floor(z / CELL)}`);
  if (!cell) return false;
  for (const f of cell) {
    const c = Math.cos(f.ry);
    const s = Math.sin(f.ry);
    const dx = x - f.x;
    const dz = z - f.z;
    // in the building's frame: along its length (cos ry, −sin ry), across it (sin ry, cos ry)
    const a = Math.abs(dx * c - dz * s) - f.l / 2;
    const b = Math.abs(dx * s + dz * c) - f.w / 2;
    if (Math.hypot(Math.max(a, 0), Math.max(b, 0)) < r) return true;
  }
  return false;
}
