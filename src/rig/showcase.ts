import { Vector3 } from 'three';
import { smoothstep } from '../core/mathx';
import { BIL, HOMESTEAD_MOUNDS, JOURNEY, PONDS, inlandWaterAt, journeyAt, journeyFrame, terrainHeight, waterwayAt } from '../world/geography';
import { BANYAN, GRAVE_BANYAN, MOSQUE, TEA_STALL, ZAMINDAR } from '../world/plan';
import { groundAt } from '../world/terrain';
import { kashStand } from '../world/vegetation';
import type { Ghat } from '../world/village';
import { FISHER_SITE } from '../world/fisher';

// What the camera turns to as the boat goes on her way, left to itself (the user's direction): never a
// scripted shot and never away from her. Behind her and to the side away from it, a little higher and farther
// than her follow view, it turns slowly to a ghat, a homestead, a pond, the mosque or the zamindar house on the
// bank, rises to look out across the fields or the bil, or looks on ahead past her to the old bridge or the sanko
// she is coming to; she stays in the foreground, going on, and the viewer may take the camera at any moment.
// Each sight is a stretch of her way; the camera eases in over its first few metres and back out over its last,
// so nothing jumps.

/**
 * How the camera shows a sight: `bank` past her at something on the bank, `land` from a little higher out across
 * the land or the bil, `ahead` past her to a crossing she is coming to.
 */
export type SightKind = 'bank' | 'land' | 'ahead';

export interface Sight {
  /** Where on her way it is seen best (m along it), and its side of the way (+1 left of her). */
  s: number;
  side: number;
  /** What is looked at. */
  at: Vector3;
  kind: SightKind;
  /** Its stretch of her way (m along it): the camera is with it from `from` to `to`, easing in and out. */
  from: number;
  to: number;
}

/** Each kind's stretch of her way about the sight (m before it, m after it). */
const STRETCH: Record<SightKind, [number, number]> = { bank: [24, 14], land: [20, 22], ahead: [42, 3] };
/** Over how much of her way (m) the camera eases in and out. */
const EASE = 8;
/** The least of her way (m) between one sight and the next, so she is followed between them. */
const SPACING = 80;

/**
 * The sights along her way, found from the village as it stands: the crossings, the landmarks by the water,
 * the ghats and the homesteads on the banks, the kash, the fisherman, and open fields; the most telling first
 * where two would crowd each other.
 */
export function findSights(ghats: readonly Ghat[]): Sight[] {
  const found: (Sight & { rank: number })[] = [];
  // (`early`: seen from this far back along her way, where something far off across the land comes into view)
  const add = (x: number, z: number, up: number, kind: SightKind, rank: number, reach: number, early = 0) => {
    const f = journeyFrame(x, z);
    if (!f || f.d > reach) return;
    const s = f.s - early;
    if (s < JOURNEY.opening + 30 || s > JOURNEY.length - 60) return;
    const [before, after] = STRETCH[kind];
    found.push({ s, side: f.side, at: new Vector3(x, terrainHeight(x, z) + up, z), kind, from: s - before, to: s + after, rank });
  };
  // the crossings: watched from beyond as she comes through
  for (const s of [JOURNEY.bridge, JOURNEY.sanko]) {
    const p = journeyAt(s);
    found.push({ s, side: 1, at: new Vector3(p.x, 0, p.z), kind: 'ahead', from: s - STRETCH.ahead[0], to: s + STRETCH.ahead[1], rank: 10 });
  }
  add(BANYAN.x, BANYAN.z, 8, 'bank', 8, 60);
  add(TEA_STALL.x, TEA_STALL.z, 2, 'bank', 7, 60);
  // the mosque across the fields, before the bridge
  add(MOSQUE.x, MOSQUE.z, 6, 'land', 7, 170, 90);
  add(ZAMINDAR.x, ZAMINDAR.z, 8, 'land', 6, 240);
  add(GRAVE_BANYAN.x, GRAVE_BANYAN.z, 8, 'bank', 5, 120);
  // the bil opening out ahead of her as she comes into it from the khal
  {
    const s = JOURNEY.head;
    found.push({ s, side: 1, at: new Vector3(BIL.x, BIL.level + 0.5, BIL.z), kind: 'land', from: s - STRETCH.land[0], to: s + STRETCH.land[1], rank: 9 });
  }
  for (const pond of PONDS) add(pond.x, pond.z, 0.5, 'bank', 4, 60);
  const kash = kashStand();
  if (kash) add(kash.x, kash.z, 1.5, 'bank', 6, 50);
  add(FISHER_SITE.x, FISHER_SITE.z, 1.2, 'bank', 6, 50);
  for (const g of ghats) add(g.x, g.z, 1.5, 'bank', 5, 40);
  for (const m of HOMESTEAD_MOUNDS) add(m.x, m.z, 3, 'bank', 4, 70);
  // open fields beside her way: both 45 m and 75 m out are in the paddy (or the mustard), on one side
  for (let s = JOURNEY.opening + 60; s < JOURNEY.length - 80; s += 36) {
    const p = journeyAt(s);
    for (const side of [1, -1]) {
      const out = (d: number) => groundAt(p.x + Math.cos(p.heading) * d * side, p.z - Math.sin(p.heading) * d * side);
      if (out(45).zone > 0.8 && out(75).zone > 0.8) {
        const x = p.x + Math.cos(p.heading) * 60 * side;
        const z = p.z - Math.sin(p.heading) * 60 * side;
        found.push({ s, side, at: new Vector3(x, terrainHeight(x, z) + 1, z), kind: 'land', from: s - STRETCH.land[0], to: s + STRETCH.land[1], rank: 2 });
        break;
      }
    }
  }
  // the most telling first, none crowding another
  found.sort((a, b) => b.rank - a.rank);
  const chosen: Sight[] = [];
  for (const c of found) if (chosen.every((o) => Math.abs(o.s - c.s) >= SPACING)) chosen.push(c);
  return chosen.sort((a, b) => a.s - b.s);
}

/** How much the camera is with `sight` with her `along` m on her way (0..1): easing in, holding, easing out. */
export function sightWeight(sight: Sight, along: number): number {
  return smoothstep(sight.from, sight.from + EASE, along) * (1 - smoothstep(sight.to - EASE, sight.to, along));
}

/** Whether a camera at (x, z) is over the water. */
function overWater(x: number, z: number): boolean {
  if (inlandWaterAt(x, z)) return true;
  const w = waterwayAt(x, z);
  return w !== null && w.d < w.half;
}

/**
 * The camera's place (`pos`) and what it looks at (`look`) for `sight`, the boat at `boat` on `course` `along` m
 * on her way, the follow camera's target `target`, the water at `water`: behind her and away from the sight,
 * turned toward it past her, so she stays in the foreground.
 */
export function sightPose(sight: Sight, boat: Vector3, course: number, _along: number, target: Vector3, water: number, pos: Vector3, look: Vector3): void {
  const fx = Math.sin(course);
  const fz = Math.cos(course);
  // toward the sight from her
  let ux = sight.at.x - boat.x;
  let uz = sight.at.z - boat.z;
  const d = Math.hypot(ux, uz) || 1;
  ux /= d;
  uz /= d;
  // back from her: mostly away from the sight, partly behind her, so she is between the camera and it
  const lean = sight.kind === 'ahead' ? 0.9 : 0.45;
  let bx = -(ux * (1 - lean) + fx * lean);
  let bz = -(uz * (1 - lean) + fz * lean);
  const b = Math.hypot(bx, bz) || 1;
  bx /= b;
  bz /= b;
  const far = sight.kind === 'land' ? 15 : sight.kind === 'ahead' ? 12.5 : 11;
  const high = sight.kind === 'land' ? 7.5 : sight.kind === 'ahead' ? 2.6 : 3.4;
  // drawn in toward her while it would stand over the bank, so it stays over her water
  let out = far;
  for (; out > 4; out -= 0.5) {
    pos.set(boat.x + bx * out, 0, boat.z + bz * out);
    if (overWater(pos.x, pos.z)) break;
  }
  pos.y = water + high;
  // past her to the sight: she low in the frame, it beyond her
  look.lerpVectors(target, sight.at, sight.kind === 'ahead' ? 0.6 : 0.55);
  // never into the bank
  pos.y = Math.max(pos.y, terrainHeight(pos.x, pos.z) + 1.4);
}
