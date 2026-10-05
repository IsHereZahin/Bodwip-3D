import { Vector3 } from 'three';
import { angleDelta, lerp, smoothstep } from '../core/mathx';
import { makeSeasonState, seasonAt } from '../env/season';
import { plotCropAt } from '../world/crops';
import { FISHER_SITE } from '../world/fisher';
import { BIL, HOMESTEAD_MOUNDS, JOURNEY, WATER_LEVEL, corridorDistance, journeyAt, journeyFrame, journeyHalfWidth, saltPoint, shapePoint, terrainHeight, waterLevelAt, waterRise } from '../world/geography';
import { bloomRank } from '../world/leaves';
import { LILY_PONDS } from '../world/ponds';
import { RAIL_LENGTH, TRAIN_SPEED, railAt } from '../world/railway';
import { rakerStations } from '../world/saltworks';
import { groundAt } from '../world/terrain';
import { kashStand, treeCrowns } from '../world/vegetation';
import type { Ghat } from '../world/village';
import { bilPoint } from '../world/waterways';
import type { Scene, Stage } from './director';

// The film tour: a year and a day in the village, as a short documentary would show it. A winter dawn in mist
// and the boatman at sunrise, mustard in the fields, the village's ghat and the salt field at work; spring's
// blossom and a nor'wester; the monsoon's rain and its flooded fields; under the old bridge and out into the
// shapla bil, the train going by, a village pond and the kash of autumn; a fisherman casting his net and the
// golden harvest; and the evening on the water: sunset, moonrise and night. What each caption names is what
// its shot looks at: the places are found from the village as it stands (the crops a season gives a field,
// the trees in flower, the homestead nearest the water), not guessed.
// Each scene sets its own season, hour and weather (director.ts). The waters are narrow and their banks are
// wooded, so the low shots look along them, from the water; the sun and the moon are framed by placing the
// boat where her way runs toward them.

/** The journey's fraction at `s` m along the boat's way (for placing the boat). */
const fractionAt = (s: number) => s / JOURNEY.length;

/** The surface of the river, the khals and the bil this season (m): the shots' heights above the water are measured from it. */
const surface = () => WATER_LEVEL + waterRise();

/** A point `side` m to the left of the boat's way, `s` m along it, `up` m above the water. */
function onWay(s: number, side: number, up: number, out: Vector3): Vector3 {
  const p = journeyAt(s);
  return out.set(p.x + Math.cos(p.heading) * side, surface() + up, p.z - Math.sin(p.heading) * side);
}

const ease = (u: number) => smoothstep(0, 1, u);

/** Draws a camera placed out from the boat back toward her until it is over open water (not on the bank, nor in its trees). */
function overOpenWater(pos: Vector3, boat: Vector3): Vector3 {
  for (let k = 0; k < 12; k++) {
    if (waterLevelAt(pos.x, pos.z) - terrainHeight(pos.x, pos.z) > 0.3) break;
    pos.x += (boat.x - pos.x) * 0.15;
    pos.z += (boat.z - pos.z) * 0.15;
  }
  return pos;
}

/** How far along the boat's way a point is (m). */
const alongOf = (p: Vector3) => journeyFrame(p.x, p.z)?.s ?? 0;

const tmpA = new Vector3();
const tmpB = new Vector3();

/** A point relative to the boat: `a` m ahead, `s` m to her starboard (+x), `h` m above the water. */
function rel(stage: Stage, a: number, s: number, h: number, out: Vector3): Vector3 {
  const c = stage.boatCourse;
  return out
    .copy(stage.boatPos)
    .addScaledVector(tmpA.set(Math.sin(c), 0, Math.cos(c)), a)
    .addScaledVector(tmpB.set(Math.cos(c), 0, -Math.sin(c)), s)
    .setY(surface() + h);
}

/**
 * Where on the boat's way (m along it, short of the bil) it runs most nearly toward `dir` turned `aside` rad
 * off it, so a camera behind a boat there, looking along her way, has the sun or the moon in the frame off to
 * one side of her.
 */
function facing(dir: Vector3, aside: number): number {
  const bearing = Math.atan2(dir.x, dir.z);
  let best = 40;
  let err = Infinity;
  for (let s = 40; s < JOURNEY.head - 60; s += 4) {
    const h = journeyAt(s).heading;
    const e = Math.min(Math.abs(angleDelta(h, bearing - aside)), Math.abs(angleDelta(h, bearing + aside)));
    // and her way keeps on that way for a while, so the boat stays in the shot
    const on = Math.abs(angleDelta(h, journeyAt(s + 30).heading));
    if (e + on < err) (err = e + on), (best = s);
  }
  return best;
}

/**
 * Where the boat's way passes most of a crop in a season (`crop` numbered as crops.ts plotCropAt: 0 seedlings,
 * 2 ripe rice, 3 mustard): the bank (`s` along the way, `side`) where the field begins `edge` m out from the way
 * with that crop filling a fan of it 6–60 m beyond. The film stands on the field's edge there and looks across.
 */
function cropField(crop: number, day: number): { s: number; side: 1 | -1; edge: number } {
  const crops = seasonAt(day, makeSeasonState()).crops;
  let best = { score: -Infinity, s: JOURNEY.bridge + 160, side: 1 as 1 | -1, edge: 30 };
  for (let s = 60; s <= JOURNEY.head - 80; s += 16) {
    const p = journeyAt(s);
    for (const side of [1, -1] as const) {
      const nx = Math.cos(p.heading) * side;
      const nz = -Math.sin(p.heading) * side;
      // the field's edge: the first field ground out past the water and the bank's grass
      let edge = -1;
      for (let d = journeyHalfWidth(s); d < journeyHalfWidth(s) + 34; d += 1.5) {
        if (groundAt(p.x + nx * d, p.z + nz * d).zone > 0.6) {
          edge = d + 2;
          break;
        }
      }
      if (edge < 0 || corridorDistance(p.x + nx * edge, p.z + nz * edge) > 150) continue;
      let score = 0;
      for (const along of [-24, -12, 0, 12, 24]) {
        const q = journeyAt(s + along);
        for (const out of [6, 16, 28, 42, 58]) {
          const x = q.x + Math.cos(q.heading) * side * (edge + out);
          const z = q.z - Math.sin(q.heading) * side * (edge + out);
          if (groundAt(x, z).zone > 0.8 && plotCropAt(x, z, crops) === crop) score += out < 30 ? 1.5 : 1;
        }
      }
      if (score > best.score) best = { score, s, side, edge };
    }
  }
  return best;
}

/**
 * On the edge of a field by the boat's way (`cropField`): drifting along it at `height` m over the ground and
 * looking out across it, turned `turn` rad along the way (toward where she is going).
 */
function overField(f: { s: number; side: 1 | -1; edge: number }, u: number, height: number, turn: number, pos: Vector3, look: Vector3): void {
  const p = journeyAt(f.s + lerp(-6, 6, u));
  const nx = Math.cos(p.heading) * f.side;
  const nz = -Math.sin(p.heading) * f.side;
  const x = p.x + nx * f.edge;
  const z = p.z + nz * f.edge;
  pos.set(x, terrainHeight(x, z) + height, z);
  const lx = x + (nx * Math.cos(turn) + Math.sin(p.heading) * Math.sin(turn)) * 45;
  const lz = z + (nz * Math.cos(turn) + Math.cos(p.heading) * Math.sin(turn)) * 45;
  look.set(lx, terrainHeight(lx, lz) + 0.4, lz);
}

/**
 * Where spring's red blossom crowds a bank nearest the boat's way: the stretch (`s`, `side`) with the most
 * crowns in flower within 30 m of the water, and their middle (`at`, at crown height).
 */
function blossomBank(): { s: number; side: 1 | -1; at: Vector3 } {
  // each crown in flower once spring has its share of them out (bloomRank, leaves.ts), placed on the way once
  const placed = treeCrowns().flatMap((c) => {
    if (!c.blossom || bloomRank(c.x, c.z) > 0.28) return [];
    const f = journeyFrame(c.x, c.z);
    if (!f || f.s < JOURNEY.opening + 60 || f.s > JOURNEY.head - 40) return [];
    const near = f.d - journeyHalfWidth(f.s);
    return near < 30 ? [{ s: f.s, side: f.side as 1 | -1, near, c }] : [];
  });
  let best = { score: -1, s: JOURNEY.bridge + 120, side: 1 as 1 | -1, at: new Vector3() };
  for (let s = JOURNEY.opening + 60; s < JOURNEY.head - 40; s += 8) {
    for (const side of [1, -1] as const) {
      const here = placed.filter((p) => p.side === side && Math.abs(p.s - s) < 28);
      const score = here.reduce((a, p) => a + 1 / (1 + p.near / 12), 0);
      if (score > best.score) {
        const at = new Vector3();
        for (const p of here) at.add(tmpA.set(p.c.x, p.c.y, p.c.z));
        best = { score, s, side, at: here.length ? at.divideScalar(here.length) : at };
      }
    }
  }
  return best;
}

/** The homestead nearest the boat's way, for the storm: its trees (palms and bamboo at its front corners) right over the water. */
function stormHome(): { s: number; side: 1 | -1; corner: Vector3 } {
  let best = { d: Infinity, s: JOURNEY.opening + 200, side: 1 as 1 | -1, corner: new Vector3() };
  for (const m of HOMESTEAD_MOUNDS) {
    const f = journeyFrame(m.x, m.z);
    if (!f || f.s < JOURNEY.opening + 80 || f.s > JOURNEY.bridge - 60 || f.d >= best.d) continue;
    const s = f.s;
    const side = f.side as 1 | -1;
    // its front corner on the way's upstream side, where the palms stand
    const a = shapePoint(m, m.hu, m.hv);
    const b = shapePoint(m, m.hu, -m.hv);
    const sa = journeyFrame(a.x, a.z)?.s ?? s;
    const sb = journeyFrame(b.x, b.z)?.s ?? s;
    const c = sa < sb ? a : b;
    best = { d: f.d, s, side, corner: new Vector3(c.x, terrainHeight(c.x, c.z), c.z) };
  }
  return best;
}

// places found once, at load (deterministic)
/** A village pond for a morning: the widest with lilies within 200 m of the boat's way; the bil if there is none. */
const POND = LILY_PONDS.filter((p) => (journeyFrame(p.x, p.z)?.d ?? Infinity) < 200).sort((a, b) => b.r - a.r)[0] ?? { x: BIL.x, z: BIL.z, r: BIL.halfWid, level: BIL.level };

/** Where along the railway the bil's shot looks across at it, from the middle of its drift (`railAt` s). */
const BIL_TRAIN = (() => {
  const eye = bilPoint(-BIL.halfLen * 0.55, -BIL.halfWid * 0.3);
  const want = Math.atan2(BIL.x - eye.x, BIL.z - eye.z);
  let best = 0;
  let err = Infinity;
  for (let s = 0; s <= RAIL_LENGTH; s += 4) {
    const r = railAt(s);
    const e = Math.abs(angleDelta(Math.atan2(r.x - eye.x, r.z - eye.z), want));
    if (e < err) (err = e), (best = s);
  }
  return best;
})();

/** Where along the railway the train scene stands beside it (west of the bil, across an open field of mustard in winter, no tree between). */
const TRAIN_AT = (() => {
  let best = 0;
  for (let s = 0; s <= RAIL_LENGTH; s += 4) if (Math.abs(railAt(s).x - 330) < Math.abs(railAt(best).x - 330)) best = s;
  return best;
})();
/** How far east of the camera the train's nose is as that scene opens (m): it comes into view and passes by its middle. */
const TRAIN_LEAD = 60;

/** Where the men rake in the salt field (its frame), for its scene. */
const SALT_MEN = rakerStations();

/** The film's scenes; `ghats` are the village's (world/village.ts planGhats), the first its ghat below the banyan. */
export function tourScenes(ghats: readonly Ghat[]): Scene[] {
  // per-scene choices made as each scene opens
  const a = new Vector3();
  // the places the scenes are shot at, found once the village stands (the crowns are the vegetation's)
  const mustard = cropField(3, 20);
  const aman = cropField(0, 205);
  const ripe = cropField(2, 318);
  const blossom = blossomBank();
  const storm = stormHome();
  // the village's ghat below the banyan: where it meets the water, the way up its steps, and where the boat passes it
  const hub = ghats[0];
  const hubS = hub ? (journeyFrame(hub.x, hub.z)?.s ?? JOURNEY.turn) : JOURNEY.turn;
  // the fisherman: where his net falls, ahead of his dinghy's bow, and his left (toward the low western sun)
  const fwd = new Vector3(Math.sin(FISHER_SITE.yaw), 0, Math.cos(FISHER_SITE.yaw));
  const left = new Vector3(fwd.z, 0, -fwd.x);
  const netFalls = new Vector3(FISHER_SITE.x, 0, FISHER_SITE.z).addScaledVector(fwd, 6.1);
  const fisherAt = new Vector3(FISHER_SITE.x, 0, FISHER_SITE.z).addScaledVector(fwd, 1);

  return [
    {
      caption: 'শীতের ভোর',
      seconds: 15,
      world: { day: 14, hour: { at: 'sunrise', offset: 0 }, weather: 'clear', wind: 0.2 },
      journey: fractionAt(40),
      begin: (s) => s.birds(s.boatPos, s.boatCourse + Math.PI),
      // down out of the sky over the misty khal onto the boat coming up it
      pose: (u, s, pos, look) => {
        onWay(alongOf(s.boatPos) + lerp(60, 22, u), 0, lerp(16, 3.2, ease(u)), pos);
        rel(s, 0, 0, lerp(0.4, 1.4, u), look);
      },
    },
    {
      caption: 'মাঝি',
      seconds: 12,
      world: { day: 14, hour: { at: 'sunrise', offset: 0.08 }, weather: 'clear', wind: 0.2 },
      // close beside the boatman as he paddles
      pose: (u, s, pos, look) => {
        rel(s, -7, lerp(2.6, -0.8, u), 1.6, pos);
        rel(s, -2.8, 0, 1.55, look).lerp(rel(s, 12, 0, 2, a), 0.2);
      },
    },
    {
      caption: 'সরিষার মাঠ',
      seconds: 12,
      world: { day: 20, hour: 8.6, weather: 'clear', wind: 0.5 },
      // on the edge of a field yellow with mustard in flower, drifting along it at the height of the flowers'
      // tops, the morning sun across them
      pose: (u, _s, pos, look) => overField(mustard, u, 1.35, 0.35, pos, look),
    },
    {
      caption: 'গ্রামের ঘাট',
      seconds: 13,
      world: { day: 28, hour: 9.4, weather: 'clear', wind: 0.35 },
      journey: fractionAt(Math.max(0, hubS - 14)),
      // out on the water before the village's ghat below the banyan, its wide steps and benches, the tea stall
      // beside it, the boat paddling past between
      pose: (u, _s, pos, look) => {
        if (!hub) {
          onWay(hubS + lerp(-20, -6, u), 0, 1.8, pos);
          onWay(hubS, 8, 1.5, look);
          return;
        }
        const ux = Math.sin(hub.up);
        const uz = Math.cos(hub.up);
        const along = lerp(-8, 5, u);
        pos.set(hub.x - ux * 19 + uz * along, surface() + 1.7, hub.z - uz * 19 - ux * along);
        look.set(hub.x + ux * 4, surface() + 2.6, hub.z + uz * 4);
      },
    },
    {
      caption: 'লবণ মাঠ',
      seconds: 13,
      world: { day: 34, hour: 9.6, weather: 'clear', wind: 0.4 },
      // in the salt field by the river where the journey starts, the morning sun behind the camera: drifting
      // along the beds toward a man raking the crust to his heap, two more at work beyond, the gola under the
      // wooded hill
      pose: (u, _s, pos, look) => {
        const man = SALT_MEN[1] ?? SALT_MEN[0];
        const p = saltPoint(man.u - lerp(5.2, 3.6, u), man.v - lerp(5.5, 2.8, u));
        pos.set(p.x, terrainHeight(p.x, p.z) + lerp(1.9, 1.6, u), p.z);
        const q = saltPoint(man.u + lerp(1, 2.5, u), man.v + 0.4);
        look.set(q.x, terrainHeight(q.x, q.z) + 0.9, q.z);
      },
    },
    {
      caption: 'বসন্তের রং',
      seconds: 12,
      world: { day: 75, hour: 16.3, weather: 'clear', wind: 0.6 },
      // low on the water along the bank where the trees stand in red flower, their petals coming down
      pose: (u, _s, pos, look) => {
        const s = blossom.s + lerp(-30, -14, u);
        onWay(s, blossom.side * journeyHalfWidth(s) * 0.35, 1.9, pos);
        look.copy(blossom.at).setY(blossom.at.y - 3);
      },
    },
    {
      caption: 'কালবৈশাখী',
      seconds: 12,
      world: { day: 128, hour: 16.0, weather: 'storm', wind: 2.6 },
      // across the khal from a homestead in the squall: its palms and bamboo thrashing, the rain driving over
      // the water between
      pose: (u, _s, pos, look) => {
        onWay(storm.s + lerp(-26, -14, u), -storm.side * journeyHalfWidth(storm.s) * 0.55, 2.5, pos);
        look.copy(storm.corner).setY(storm.corner.y + lerp(3.2, 2.6, u));
      },
    },
    {
      caption: 'বর্ষার খাল',
      seconds: 13,
      world: { day: 195, hour: 11.0, weather: 'rain', wind: null },
      journey: fractionAt(JOURNEY.bridge + 220),
      // ahead of the boat in the rain, low over the khal, as she comes on
      pose: (u, s, pos, look) => {
        rel(s, lerp(15, 10, u), lerp(-3, -2.2, u), 1.5, pos);
        rel(s, -1, 0, 1.1, look);
      },
    },
    {
      caption: 'ডুবো মাঠে আমন',
      seconds: 12,
      world: { day: 205, hour: 12.5, weather: 'drizzle', wind: 0.5 },
      // low over plots of young aman standing in the rains' water, their rows going away into the drizzle
      pose: (u, _s, pos, look) => overField(aman, u, 1.1, 0.2, pos, look),
    },
    {
      caption: 'সেতুর নিচে',
      seconds: 16,
      world: { day: 268, hour: { at: 'sunset', offset: -0.7 }, weather: 'clear', wind: 0.55 },
      journey: fractionAt(JOURNEY.bridge - 20),
      // low behind the boat as she goes under the old bridge, the girl with her umbrella above
      pose: (u, s, pos, look) => {
        const at = alongOf(s.boatPos);
        onWay(at - lerp(12, 9, u), 0, lerp(1.9, 1.5, u), pos);
        onWay(at + 10, 0, 2.2, look).lerp(rel(s, 0, 0, 1.3, a), 0.4);
      },
    },
    {
      caption: 'শাপলা বিল',
      seconds: 14,
      world: { day: 235, hour: 9.2, weather: 'clear', wind: 0.25 },
      // the train comes by on its embankment beyond the bil as the shot reaches its middle
      begin: (s) => s.train(BIL_TRAIN - TRAIN_SPEED * 7, true),
      // low over the lily rafts, drifting across the bil below the hills
      pose: (u, _s, pos, look) => {
        const p = bilPoint(lerp(-BIL.halfLen * 0.7, -BIL.halfLen * 0.4, u), -BIL.halfWid * 0.3);
        pos.set(p.x, surface() + lerp(5, 3.2, u), p.z);
        look.set(BIL.x, surface() + 0.2, BIL.z);
      },
    },
    {
      caption: 'ট্রেন যাচ্ছে',
      seconds: 14,
      world: { day: 40, hour: 16.2, weather: 'clear', wind: 0.3 },
      // from the fields beside the line, the intercity coming up from the east and going by on its embankment,
      // the camera turning with it
      begin: (s) => s.train(TRAIN_AT - TRAIN_LEAD, true),
      pose: (u, _s, pos, look) => {
        const t = u * 14;
        const p = railAt(TRAIN_AT);
        // south of the line (her left, going west), a little way out in the fields, drifting along it
        const along = lerp(-6, 6, u);
        const x = p.x + Math.cos(p.heading) * 30 + Math.sin(p.heading) * along;
        const z = p.z - Math.sin(p.heading) * 30 + Math.cos(p.heading) * along;
        pos.set(x, terrainHeight(x, z) + 1.6, z);
        // on the middle of the train as it comes and goes, never turned more than so far either way
        const mid = Math.max(TRAIN_AT - 55, Math.min(TRAIN_AT + 55, TRAIN_AT - TRAIN_LEAD + TRAIN_SPEED * t - 70));
        const q = railAt(mid);
        look.set(q.x, terrainHeight(q.x, q.z) + 2.6, q.z);
      },
    },
    {
      caption: 'পুকুরপাড়',
      seconds: 12,
      world: { day: 250, hour: 8.3, weather: 'clear', wind: 0.6 },
      // round a village pond's rim in the morning, over its lilies
      pose: (u, _s, pos, look) => {
        const angle = lerp(1.3, 1.65, u);
        const px = POND.x + Math.cos(angle) * POND.r * 1.1;
        const pz = POND.z + Math.sin(angle) * POND.r * 1.1;
        pos.set(px, Math.max(terrainHeight(px, pz), POND.level) + 1.2, pz);
        look.set(POND.x - Math.cos(angle) * POND.r * 0.8, POND.level + 0.7, POND.z - Math.sin(angle) * POND.r * 0.8);
      },
    },
    {
      caption: 'কাশবন',
      seconds: 12,
      world: { day: 262, hour: 16.4, weather: 'clear', wind: 0.9 },
      // up through the kash where it stands thickest on the bank, its plumes tossing, to the boat coming up the khal
      begin: (s) => {
        const k = kashStand() ?? journeyAt(JOURNEY.opening + 100);
        a.set(k.x, terrainHeight(k.x, k.z), k.z);
        s.placeBoat(fractionAt(Math.max(0, (journeyFrame(k.x, k.z)?.s ?? JOURNEY.opening + 100) - 40)));
      },
      pose: (u, s, pos, look) => {
        pos.copy(a);
        pos.y += lerp(1.5, 2.7, ease(u));
        rel(s, 0, 0, 1.0, look);
      },
    },
    {
      caption: 'জেলের জাল',
      seconds: 14,
      world: { day: 300, hour: 16.3, weather: 'clear', wind: 0.3 },
      // over the shoulder of a fisherman in his dinghy, the low sun behind: he winds round and casts, and the net
      // opens toward the far bank into a wide circle catching the light, falls, sinks; he hauls it in hand over
      // hand and lifts it out
      journey: 0.15,
      begin: (s) => s.fisherman(0.4),
      pose: (u, _s, pos, look) => {
        pos.copy(fisherAt).addScaledVector(left, lerp(6.5, 5, u)).addScaledVector(fwd, lerp(-4.5, -3.2, u)).setY(surface() + lerp(2.5, 2.1, u));
        look.lerpVectors(fisherAt, netFalls, lerp(0.5, 0.65, u)).setY(surface() + 1.3);
      },
    },
    {
      caption: 'হেমন্তের ধান',
      seconds: 12,
      world: { day: 318, hour: 15.6, weather: 'clear', wind: 0.5 },
      // on the edge of a field of ripe aman, golden in the afternoon, its heads nodding in the breeze
      pose: (u, _s, pos, look) => overField(ripe, u, 1.5, 0.45, pos, look),
    },
    {
      caption: 'সূর্যাস্ত',
      seconds: 14,
      world: { day: 290, hour: { at: 'sunset', offset: -0.04 }, weather: 'clear', wind: 0.15 },
      // behind the boat paddling up the khal toward the low sun, off to one side of her
      begin: (s) => {
        s.placeBoat(fractionAt(facing(s.sunDir, 0.3)));
        s.birds(s.boatPos, s.boatCourse);
      },
      pose: (u, s, pos, look) => {
        onWay(alongOf(s.boatPos) - lerp(19, 14, u), 0, 1.0, pos);
        rel(s, 0, 0, 1.2, look);
      },
    },
    {
      caption: 'চাঁদ ওঠা',
      seconds: 14,
      world: { day: 290, moon: 14.8, hour: { at: 'moonrise', offset: 0.35 }, weather: 'clear', wind: 0.15 },
      // out in the bil, where nothing stands between the boat and the rising moon: low behind her, the full moon
      // off to one side of her lantern
      // (far enough short of the journey's end that she is not taken back to its start in the mist mid-shot)
      journey: fractionAt(JOURNEY.head + 40),
      pose: (u, s, pos, look) => {
        const m = s.moonDir;
        const away = tmpA.set(m.x, 0, m.z).normalize();
        const aside = tmpB.set(away.z, 0, -away.x);
        overOpenWater(pos.copy(s.boatPos).addScaledVector(away, -lerp(17, 12, u)).addScaledVector(aside, lerp(3, 1.5, u)), s.boatPos).setY(surface() + 1.3);
        const toBoat = a.subVectors(rel(s, 0, 0, 1.2, look), pos).normalize();
        look.copy(pos).addScaledVector(toBoat.lerp(m, 0.55).normalize(), 30);
      },
    },
    {
      caption: 'রাতের বিল',
      seconds: 15,
      world: { day: 290, moon: 14.8, hour: { at: 'moonrise', offset: 1.5 }, weather: 'clear', wind: 0.15 },
      journey: fractionAt(JOURNEY.head + 55),
      // night: drawing slowly back from the boat's lantern over the lilies, the moon well up beyond her and its
      // light lying on the water between
      pose: (u, s, pos, look) => {
        const m = s.moonDir;
        const away = tmpA.set(m.x, 0, m.z).normalize();
        const aside = tmpB.set(away.z, 0, -away.x);
        overOpenWater(pos.copy(s.boatPos).addScaledVector(away, -lerp(13, 17, u)).addScaledVector(aside, lerp(4, 5.5, u)), s.boatPos).setY(surface() + lerp(1.8, 2.6, u));
        rel(s, 0, 0, 1.0, look).lerp(a.copy(pos).addScaledVector(m, 40), 0.28);
      },
    },
  ];
}
