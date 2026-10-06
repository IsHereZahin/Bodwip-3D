import { Vector3 } from 'three';
import { angleDelta, clamp, smoothstep } from '../core/mathx';
import { BRIDGE, SANKO, bridgeFrame, corridorDistance, sankoFrame, terrainHeight, waterLevelAt } from '../world/geography';
import { CORRIDOR } from '../render/glsl';
import type { LookAlong, Sightlines } from './sightlines';

// Where a place is seen from with the land round it (the user asked, 2026-10-07, for the map's places to be shown
// from a little farther off, so the village round each is seen, and in more views): the places round it on rings
// at a few distances and heights, each weighed by whether the place is seen past the banks, the trees and the
// houses, how big it stands (a third of the frame: room for what is round it), how deep the view runs past it,
// nothing close in front of the lens, and over the water rather than the land; the best few, well apart round
// it. Any place given (its middle, height and size) gets its own; the map's places take them (visits.ts).

/** A place to be seen: its middle (m), its middle's height over the ground there, and its radius (m). */
export interface Place {
  x: number;
  z: number;
  up: number;
  size: number;
}

/** A place the camera stands to see it from: over the ground or the water beneath it by `high` m, round it at `bearing` (rad from +z), `dist` m off. */
export interface Vantage {
  x: number;
  z: number;
  high: number;
  bearing: number;
  dist: number;
  score: number;
}

/** The rings: every 15°, at these many times its size (m, held to `NEAR`..`FARTHEST`), these heights over what is beneath (m). */
const STEPS = 24;
const RINGS = [4.5, 6.5, 9];
const HIGHS = [5, 11, 20];
const NEAREST = 28;
const FARTHEST = 260;
/** How far apart round the place two views stand at least (rad), and less so where too few are found that far apart. */
const APART = [0.95, 0.5, 0.2];
/** The frame's height of view (rad) the views are weighed for, its width's tangent, and how big the place should stand in it. */
const VIEW = (50 * Math.PI) / 180;
const WIDE = 0.83;
const SIZE = 0.35;
/** What standing over land rather than the water costs a view (share of its score). */
const ASHORE = 0.85;

/** The ground or the water under (x, z), whichever stands higher (m). */
export function surfaceAt(x: number, z: number): number {
  const w = waterLevelAt(x, z);
  const g = terrainHeight(x, z);
  return Number.isFinite(w) ? Math.max(g, w) : g;
}

/** The best `count` views of `place`, well apart round it, the best first. */
export function vantages(place: Place, lines: Sightlines, count: number): Vantage[] {
  const at = new Vector3(place.x, terrainHeight(place.x, place.z) + place.up, place.z);
  const top = at.clone().setY(at.y + place.size * 0.4);
  const spare = place.size * 0.9;
  const eye = new Vector3();
  const along: LookAlong = { depth: 0, water: 0, field: 0, backdrop: 0 };
  const found: Vantage[] = [];
  for (const ring of RINGS) {
    const dist = clamp(place.size * ring, NEAREST, FARTHEST);
    for (let i = 0; i < STEPS; i++) {
      const bearing = (i / STEPS) * Math.PI * 2;
      const x = place.x + Math.sin(bearing) * dist;
      const z = place.z + Math.cos(bearing) * dist;
      if (corridorDistance(x, z) > CORRIDOR.camera || nearCrossing(x, z)) continue;
      for (const high of HIGHS) {
        eye.set(x, surfaceAt(x, z) + high, z);
        if (!lines.standsClear(eye.x, eye.y, eye.z)) continue;
        const seen = (2 * lines.sees(eye, at, spare) + lines.sees(eye, top, spare)) / 3;
        if (seen < 0.4) continue;
        // looking at it: how big it stands, what lies past and beside it, nothing close in front
        const look = Math.atan2(at.x - eye.x, at.z - eye.z);
        const pitch = Math.atan2(at.y - eye.y, dist);
        const size = (2 * Math.atan(place.size / dist)) / VIEW;
        const big = Math.exp(-((Math.log(size / SIZE) / 0.7) ** 2));
        let deep = 0;
        for (const k of [-0.3, 0.3]) {
          const a = lines.look(eye, look + k * 2 * Math.atan(WIDE), 420, along);
          deep += (0.5 * smoothstep(dist * 0.8, dist * 2.5, a.depth) + 0.25 * Math.min(1, a.water * 2) + 0.25 * a.backdrop) / 2;
        }
        let clutter = lines.clutter(eye, look, pitch - 0.3, 24);
        for (const k of [-1, 1]) clutter = Math.max(clutter, lines.clutter(eye, look + k * 0.45, pitch - 0.2, 24));
        const height = 1 - 0.3 * Math.abs(high - 11) / 9;
        const score = seen * (0.45 * big + 0.3 * deep + 0.25 * height) * (1 - 0.7 * clutter) * (lines.overWater(x, z) ? 1 : ASHORE);
        found.push({ x, z, high, bearing, dist, score });
      }
    }
  }
  found.sort((a, b) => b.score - a.score);
  const chosen: Vantage[] = [];
  for (const apart of APART) {
    for (const v of found) {
      if (chosen.length >= count) break;
      if (chosen.every((c) => c !== v && Math.abs(angleDelta(c.bearing, v.bearing)) >= apart)) chosen.push(v);
    }
  }
  return chosen;
}

/** Whether (x, z) is over or right beside the old bridge or the sanko (a camera there would stand in them). */
function nearCrossing(x: number, z: number): boolean {
  const b = bridgeFrame(x, z);
  if (Math.abs(b.x) < BRIDGE.half + 3 && Math.abs(b.z) < BRIDGE.width / 2 + 4) return true;
  const s = sankoFrame(x, z);
  return Math.abs(s.a) < SANKO.half + 2 && Math.abs(s.b) < 4;
}
