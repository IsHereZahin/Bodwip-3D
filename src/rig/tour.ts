import { Vector3 } from 'three';
import { angleDelta, lerp, smoothstep } from '../core/mathx';
import { makeSeasonState, seasonAt } from '../env/season';
import { plotCropAt } from '../world/crops';
import { FISHER_SITE } from '../world/fisher';
import { BIL, BRIDGE, HOMESTEAD_MOUNDS, JOURNEY, SALT_CREEK, WATER_LEVEL, corridorDistance, journeyAt, journeyFrame, journeyHalfWidth, landUse, saltPoint, shapePoint, terrainHeight, waterLevelAt, waterRise } from '../world/geography';
import { bloomRank } from '../world/leaves';
import { LILY_PONDS } from '../world/ponds';
import { SALT_FIELD, type Pt } from '../world/plan';
import { RAIL_LENGTH, TRAIN_SPEED, railAt } from '../world/railway';
import { roadLines } from '../world/roads';
import { gherStand, rakerStations } from '../world/saltworks';
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

/**
 * A place `dist` m out from the boat over open water, as near to the way `dir` (unit, level) as there is one:
 * turned a little either side till the whole way out to it is water.
 */
function openWaterOut(boat: Vector3, dir: Vector3, dist: number, out: Vector3): Vector3 {
  for (const turn of [0, 0.25, -0.25, 0.5, -0.5, 0.8, -0.8, 1.1, -1.1]) {
    const c = Math.cos(turn);
    const s = Math.sin(turn);
    const x = dir.x * c + dir.z * s;
    const z = -dir.x * s + dir.z * c;
    let open = true;
    for (const f of [0.4, 0.7, 1, 1.25]) {
      const px = boat.x + x * dist * f;
      const pz = boat.z + z * dist * f;
      if (waterLevelAt(px, pz) - terrainHeight(px, pz) < 0.3) {
        open = false;
        break;
      }
    }
    if (open) return out.set(boat.x + x * dist, boat.y, boat.z + z * dist);
  }
  return out.set(boat.x + dir.x * dist, boat.y, boat.z + dir.z * dist);
}

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
export function cropField(crop: number, day: number): { s: number; side: 1 | -1; edge: number } {
  const key = `${crop}@${day}`;
  const known = FIELDS_FOUND.get(key);
  if (known) return known;
  const found = findCropField(crop, day);
  FIELDS_FOUND.set(key, found);
  return found;
}
const FIELDS_FOUND = new Map<string, { s: number; side: 1 | -1; edge: number }>();

function findCropField(crop: number, day: number): { s: number; side: 1 | -1; edge: number } {
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
 * The tree in red flower to stand under: of the crowns spring has in flower (bloomRank, leaves.ts), the biggest
 * within a few metres of the water by the boat's way, the khal's narrow water preferred. Where its crown is,
 * and the point of the way nearest it (`s`, `side`).
 */
function blossomTree(): { s: number; side: 1 | -1; crown: Vector3; r: number } {
  let best = { score: -Infinity, s: JOURNEY.turn + 200, side: 1 as 1 | -1, crown: new Vector3(), r: 4 };
  for (const c of treeCrowns()) {
    if (!c.blossom || bloomRank(c.x, c.z) > 0.28 || Math.hypot(c.x - BRIDGE.x, c.z - BRIDGE.z) < 45) continue;
    const f = journeyFrame(c.x, c.z);
    if (!f || f.s < JOURNEY.opening + 60 || f.s > JOURNEY.head - 40) continue;
    const near = f.d - journeyHalfWidth(f.s);
    if (near > 15) continue;
    const score = c.r - near * 0.25 + (f.s > JOURNEY.turn ? 1.5 : 0);
    if (score > best.score) best = { score, s: f.s, side: f.side as 1 | -1, crown: new Vector3(c.x, c.y, c.z), r: c.r };
  }
  if (!Number.isFinite(best.score)) {
    // none in flower near the water: the bank's trees where the way passes, looked up into all the same
    const p = journeyAt(best.s);
    const out = journeyHalfWidth(best.s) + 8;
    best.crown.set(p.x + Math.cos(p.heading) * out, 0, p.z - Math.sin(p.heading) * out);
    best.crown.y = terrainHeight(best.crown.x, best.crown.z) + 6;
  }
  return best;
}

/**
 * The village road where it crosses open fields between its rows of tal (vegetation.ts plants them where the
 * fields lie open both sides of it): the longest such stretch near the boat's way, as its points (m, 2.5 m apart).
 */
function talRoad(): Pt[] {
  const open = (x: number, z: number, nx: number, nz: number) =>
    [16, 30].every((d) => landUse(x + nx * d, z + nz * d).field > 0.75 && landUse(x - nx * d, z - nz * d).field > 0.75);
  let best: Pt[] = [];
  for (const line of roadLines()) {
    if (!line.raised) continue;
    let run: Pt[] = [];
    const pts = line.points;
    for (let k = 0; k + 1 < pts.length; k++) {
      const [ax, az] = pts[k];
      const [bx, bz] = pts[k + 1];
      const len = Math.hypot(bx - ax, bz - az) || 1;
      if (open(ax, az, (bz - az) / len, -(bx - ax) / len) && corridorDistance(ax, az) < 190) run.push(pts[k]);
      else run = [];
      if (run.length > best.length) best = [...run];
    }
  }
  return best;
}

/** A point `k` (fractional) of a run of road points, and the road's heading there. */
function alongRoad(pts: readonly Pt[], k: number): { x: number; z: number; heading: number } {
  const i = Math.max(0, Math.min(pts.length - 2, Math.floor(k)));
  const f = Math.min(1, Math.max(0, k - i));
  const [ax, az] = pts[i];
  const [bx, bz] = pts[i + 1];
  return { x: ax + (bx - ax) * f, z: az + (bz - az) * f, heading: Math.atan2(bx - ax, bz - az) };
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

/** Where the men rake in the salt field (its frame), for its scene. */
const SALT_MEN = rakerStations();

/** How high (rad) the night's last shot looks toward the moon's bearing. */
const NIGHT_LIFT = 0.38;

/**
 * The film's scenes; `ghats` are the village's (world/village.ts planGhats), the first its ghat below the banyan.
 *
 * Told as a cinematographer would tell a year in the village, in five movements: a winter morning (dawn over the
 * khal from the air, the boatman, the village's ghat, the road out between its tal palms, the mustard beside it,
 * the salt field where the creek brings the sea's water, the afternoon train across the mustard); the turning
 * year (spring's red blossom, a nor'wester); the rains (the khal in the rain, the salt field kept as a fish gher,
 * the aman planted in the floods, the shapla bil); autumn and the harvest (a pond, the kash, the fisherman's net,
 * the reaping); and the evening on the water to the night. Each shot is chosen for its subject: wide where a
 * place is set, low and close where a hand works, rising where the land should open out; and runs as long as its
 * story needs.
 */
export function tourScenes(ghats: readonly Ghat[]): Scene[] {
  // per-scene choices made as each scene opens
  const a = new Vector3();
  const b = new Vector3();
  // the places the scenes are shot at, found once the village stands (the crowns are the vegetation's)
  const mustard = cropField(3, 16);
  const aman = cropField(0, 210);
  const ripe = cropField(2, 318);
  const blossom = blossomTree();
  const storm = stormHome();
  const road = talRoad();
  // the village's ghat below the banyan: where it meets the water, the way up its steps, and where the boat passes it
  const hub = ghats[0];
  const hubS = hub ? (journeyFrame(hub.x, hub.z)?.s ?? JOURNEY.turn) : JOURNEY.turn;
  // the fisherman: where his net falls, ahead of his dinghy's bow, and his left (toward the low western sun)
  const fwd = new Vector3(Math.sin(FISHER_SITE.yaw), 0, Math.cos(FISHER_SITE.yaw));
  const left = new Vector3(fwd.z, 0, -fwd.x);
  const netFalls = new Vector3(FISHER_SITE.x, 0, FISHER_SITE.z).addScaledVector(fwd, 6.1);
  const fisherAt = new Vector3(FISHER_SITE.x, 0, FISHER_SITE.z).addScaledVector(fwd, 1);
  // the gher's fisherman in the rains, on his bund, facing into the old settling pond
  const gher = gherStand();
  const gherFwd = new Vector3(Math.sin(gher.yaw), 0, Math.cos(gher.yaw));
  const gherRight = new Vector3(-gherFwd.z, 0, gherFwd.x);
  // the salt creek's head at the sluice, and the man the salt scene comes down to
  const creekHead = SALT_CREEK.at(SALT_CREEK.length);
  const saltMan = SALT_MEN[1] ?? SALT_MEN[0];
  const fieldMiddle = saltPoint(SALT_FIELD.w * 0.45, SALT_FIELD.d * 0.5);
  // the reapers' field: its edge, the way out across it and along it
  const reapP = journeyAt(ripe.s);
  const reapOut = new Vector3(Math.cos(reapP.heading) * ripe.side, 0, -Math.sin(reapP.heading) * ripe.side);
  const reapAlong = new Vector3(Math.sin(reapP.heading), 0, Math.cos(reapP.heading));
  const reapEdge = new Vector3(reapP.x, 0, reapP.z).addScaledVector(reapOut, ripe.edge);
  // the train: where the shot stands beside the line, and how long the train takes to come to it
  const TRAIN_SHOT = 22;
  const trainFrom = TRAIN_AT - TRAIN_SPEED * 10;
  const line = railAt(TRAIN_AT);
  const south = new Vector3(Math.cos(line.heading), 0, -Math.sin(line.heading));
  const westward = new Vector3(Math.sin(line.heading), 0, Math.cos(line.heading));

  return [
    // ---------- a winter morning ----------
    {
      caption: 'শীতের ভোর',
      seconds: 16,
      world: { day: 14, hour: { at: 'sunrise', offset: 0 }, weather: 'clear', wind: 0.2 },
      journey: fractionAt(40),
      begin: (s) => s.birds(s.boatPos, s.boatCourse + Math.PI),
      // the establishing shot: down out of the sky over the misty khal and its fields onto the boat coming up it
      pose: (u, s, pos, look) => {
        onWay(alongOf(s.boatPos) + lerp(60, 22, u), 0, lerp(16, 3.2, ease(u)), pos);
        rel(s, 0, 0, lerp(0.4, 1.4, u), look);
      },
    },
    {
      caption: 'মাঝি',
      seconds: 11,
      world: { day: 14, hour: { at: 'sunrise', offset: 0.08 }, weather: 'clear', wind: 0.2 },
      // close beside the boatman as he paddles, the low sun through the mist behind him
      pose: (u, s, pos, look) => {
        rel(s, -7, lerp(2.6, -0.8, u), 1.6, pos);
        rel(s, -2.8, 0, 1.55, look).lerp(rel(s, 12, 0, 2, a), 0.2);
      },
    },
    {
      caption: 'গ্রামের ঘাট',
      seconds: 13,
      world: { day: 16, hour: 8.3, weather: 'clear', wind: 0.3 },
      journey: fractionAt(Math.max(0, hubS - 14)),
      // the village's heart from the water: the ghat's wide steps under the banyan, the tea stall beside, the
      // boat paddling past between, the camera tracking slowly along the bank
      pose: (u, _s, pos, look) => {
        if (!hub) {
          onWay(hubS + lerp(-20, -6, u), 0, 1.8, pos);
          onWay(hubS, 8, 1.5, look);
          return;
        }
        const ux = Math.sin(hub.up);
        const uz = Math.cos(hub.up);
        // from across the water, so the boat passes well in front of the steps, not over the lens
        const along = lerp(-8, 5, u);
        const out = Math.min(26, journeyHalfWidth(hubS) * 2 - 3);
        pos.set(hub.x - ux * out + uz * along, surface() + 2.0, hub.z - uz * out - ux * along);
        look.set(hub.x + ux * 4, surface() + 2.4, hub.z + uz * 4);
      },
    },
    {
      caption: 'গ্রামের পথ',
      seconds: 12,
      world: { day: 16, hour: 8.7, weather: 'clear', wind: 0.3 },
      // up from the water, the village road out across the fields between its rows of tal, walked at eye height
      // into the morning haze
      pose: (u, _s, pos, look) => {
        if (road.length < 10) {
          overField(mustard, u, 1.6, 0.9, pos, look);
          return;
        }
        const k = lerp(2, Math.min(9, road.length - 8), u);
        const p = alongRoad(road, k);
        pos.set(p.x + Math.cos(p.heading) * 0.7, terrainHeight(p.x, p.z) + 1.7, p.z - Math.sin(p.heading) * 0.7);
        const q = alongRoad(road, k + 16);
        look.set(q.x, terrainHeight(q.x, q.z) + 1.6, q.z);
      },
    },
    {
      caption: 'সরিষার মাঠ',
      seconds: 11,
      world: { day: 16, hour: 9.1, weather: 'clear', wind: 0.5 },
      // beside the road the fields yellow with mustard: drifting along a field's edge at the height of the flowers
      pose: (u, _s, pos, look) => overField(mustard, u, 1.35, 0.35, pos, look),
    },
    {
      caption: 'লবণ মাঠ',
      seconds: 16,
      world: { day: 16, hour: 10.4, weather: 'clear', wind: 0.4 },
      // from over the salt creek where it comes in from the coast, past its sluice and across the beds, down to
      // a man raking the crust to his heap, two more at work beyond, the gola under the wooded hill
      pose: (u, _s, pos, look) => {
        const k = ease(u);
        const p = saltPoint(saltMan.u - 3.6, saltMan.v - 2.8);
        a.set(creekHead.x - 16, 0, creekHead.z - 10);
        pos.set(lerp(a.x, p.x, k), lerp(surface() + 13, terrainHeight(p.x, p.z) + 1.7, Math.pow(k, 0.8)), lerp(a.z, p.z, k));
        const q = saltPoint(saltMan.u + 2, saltMan.v + 0.4);
        b.set(q.x, terrainHeight(q.x, q.z) + 0.9, q.z);
        look.set(fieldMiddle.x, terrainHeight(fieldMiddle.x, fieldMiddle.z), fieldMiddle.z).lerp(b, smoothstep(0.15, 0.85, u));
      },
    },
    {
      caption: 'ট্রেন যাচ্ছে',
      seconds: TRAIN_SHOT,
      world: { day: 16, hour: 15.8, weather: 'clear', wind: 0.3 },
      // in the mustard beside the line: the intercity far off, coming on, going by close with the camera turning
      // with it, then up and back over the fields as it goes away west along its embankment
      begin: (s) => s.train(trainFrom, true),
      pose: (u, _s, pos, look) => {
        const t = u * TRAIN_SHOT;
        const nose = trainFrom + TRAIN_SPEED * t;
        const rise = ease(smoothstep(15, TRAIN_SHOT, t));
        const x = line.x + south.x * lerp(30, 46, rise) + westward.x * lerp(-4, 24, smoothstep(10, TRAIN_SHOT, t));
        const z = line.z + south.z * lerp(30, 46, rise) + westward.z * lerp(-4, 24, smoothstep(10, TRAIN_SHOT, t));
        pos.set(x, terrainHeight(x, z) + lerp(1.5, 17, rise), z);
        // first the nose coming on, then the middle of the train as it passes, never turned too far either way
        const watch = lerp(Math.min(nose - 8, TRAIN_AT + 20), nose - 75, smoothstep(9, 13, t));
        const r = railAt(Math.max(TRAIN_AT - 160, Math.min(TRAIN_AT + 240, watch)));
        look.set(r.x, terrainHeight(r.x, r.z) + lerp(2.6, 1, rise), r.z);
      },
    },

    // ---------- the turning year ----------
    {
      caption: 'বসন্তের রং',
      seconds: 14,
      world: { day: 75, hour: 16.3, weather: 'clear', wind: 0.75 },
      // on the water under a tree in red flower: up into its crown against the sky, its petals coming down past
      // the lens, then down with them to the water where they float away on the current
      pose: (u, _s, pos, look) => {
        const s = blossom.s + lerp(-4, 2, u);
        onWay(s, blossom.side * journeyHalfWidth(s) * 0.45, lerp(1.3, 1.7, u), pos);
        a.copy(blossom.crown).setY(blossom.crown.y + 0.5);
        // down to the water of the khal ahead, where the fallen petals float off on the current
        onWay(s + 9, blossom.side * journeyHalfWidth(s) * 0.2, 0, b);
        look.copy(a).lerp(b, smoothstep(0.35, 1, u) * 0.8);
      },
    },
    {
      caption: 'কালবৈশাখী',
      seconds: 15,
      world: { day: 128, hour: 16.0, weather: 'storm', wind: 2.6 },
      // across the khal from a homestead in the squall: its palms and bamboo thrashing, the rain driving over the
      // water, lightning forking down beyond the trees
      begin: (s) => s.lightning([2.2, 6.6, 11.4]),
      pose: (u, _s, pos, look) => {
        onWay(storm.s + lerp(-26, -14, u), -storm.side * journeyHalfWidth(storm.s) * 0.55, 2.5, pos);
        look.copy(storm.corner).setY(storm.corner.y + lerp(3.6, 3, u));
      },
    },

    // ---------- the rains ----------
    {
      caption: 'বর্ষার খাল',
      seconds: 12,
      world: { day: 195, hour: 11.0, weather: 'rain', wind: null },
      journey: fractionAt(JOURNEY.bridge + 220),
      // ahead of the boat in the rain, low over the khal, as she comes on
      pose: (u, s, pos, look) => {
        rel(s, lerp(15, 10, u), lerp(-3, -2.2, u), 1.5, pos);
        rel(s, -1, 0, 1.1, look);
      },
    },
    {
      caption: 'বর্ষার ঘের',
      seconds: 14,
      world: { day: 205, hour: 15.2, weather: 'drizzle', wind: 0.5 },
      // the salt field in the rains, kept as a fish gher: behind a man on its bund as he casts into the old
      // settling pond, the watchman's hut on its bamboo legs, the drizzle on the water
      begin: (s) => s.gherFisherman(0.6),
      pose: (u, _s, pos, look) => {
        pos.set(gher.x, (gher.ground ?? 0) + lerp(1.9, 1.6, u), gher.z).addScaledVector(gherFwd, lerp(-5.5, -4, u)).addScaledVector(gherRight, lerp(3.4, 2.4, u));
        look.set(gher.x, (gher.ground ?? 0) + 0.8, gher.z).addScaledVector(gherFwd, lerp(3, 5, u));
      },
    },
    {
      caption: 'ডুবো মাঠে আমন',
      seconds: 13,
      world: { day: 210, hour: 12.5, weather: 'drizzle', wind: 0.5 },
      // low over the young aman standing in the rains' water, then up until the flooded plots lie spread below,
      // mirroring the sky between their bunds
      pose: (u, _s, pos, look) => {
        overField(aman, u, 1.1, 0.2, pos, look);
        const k = ease(smoothstep(0.3, 1, u));
        pos.y += k * 6.5;
        look.y -= k * 1.5;
      },
    },
    {
      caption: 'শাপলা বিল',
      seconds: 14,
      world: { day: 235, hour: 9.2, weather: 'clear', wind: 0.25 },
      // low over the lily rafts, drifting across the bil below the hills, the train going by beyond it
      begin: (s) => s.train(BIL_TRAIN - TRAIN_SPEED * 7, true),
      pose: (u, _s, pos, look) => {
        const p = bilPoint(lerp(-BIL.halfLen * 0.7, -BIL.halfLen * 0.4, u), -BIL.halfWid * 0.3);
        pos.set(p.x, surface() + lerp(5, 3.2, u), p.z);
        look.set(BIL.x, surface() + 0.2, BIL.z);
      },
    },

    // ---------- autumn and the harvest ----------
    {
      caption: 'পুকুরপাড়',
      seconds: 11,
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
      seconds: 16,
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
      seconds: 14,
      world: { day: 318, hour: 15.6, weather: 'clear', wind: 0.5 },
      // the harvest: low on the field's edge in the golden rice, the reapers bent to it with their sickles, the
      // sheaves on the bund, the camera drifting toward them
      pose: (u, _s, pos, look) => {
        pos.copy(reapEdge).addScaledVector(reapAlong, lerp(0.6, 2.2, u)).addScaledVector(reapOut, -0.5);
        pos.y = terrainHeight(pos.x, pos.z) + lerp(1.25, 1.1, u);
        look.copy(reapEdge).addScaledVector(reapAlong, 7.5).addScaledVector(reapOut, 1.6);
        look.y = terrainHeight(look.x, look.z) + 0.75;
      },
    },

    // ---------- evening and night on the water ----------
    {
      caption: 'সেতুর নিচে',
      seconds: 16,
      world: { day: 300, hour: { at: 'sunset', offset: -0.7 }, weather: 'clear', wind: 0.4 },
      journey: fractionAt(JOURNEY.bridge - 20),
      // low behind the boat as she goes under the old bridge in the evening light, the girl with her umbrella above
      pose: (u, s, pos, look) => {
        const at = alongOf(s.boatPos);
        onWay(at - lerp(12, 9, u), 0, lerp(1.9, 1.5, u), pos);
        onWay(at + 10, 0, 2.2, look).lerp(rel(s, 0, 0, 1.3, a), 0.4);
      },
    },
    {
      caption: 'সূর্যাস্ত',
      seconds: 14,
      world: { day: 300, hour: { at: 'sunset', offset: -0.04 }, weather: 'clear', wind: 0.15 },
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
      world: { day: 300, moon: 14.8, hour: { at: 'moonrise', offset: 0.35 }, weather: 'clear', wind: 0.15 },
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
      seconds: 16,
      world: { day: 300, moon: 14.8, hour: { at: 'moonrise', offset: 1.5 }, weather: 'clear', wind: 0.15, pace: 0.15 },
      journey: fractionAt(JOURNEY.head + 55),
      // night: drawing slowly back from the boat's lantern over the lilies, the moon well up beyond her and its
      // light lying on the water between
      pose: (u, s, pos, look) => {
        const m = s.moonDir;
        const away = tmpA.set(m.x, 0, m.z).normalize();
        const aside = tmpB.set(away.z, 0, -away.x);
        // back from her away from the moon, turned as little as it must be to stay over the open bil
        const back = b.copy(away).negate().addScaledVector(aside, 0.3).normalize();
        openWaterOut(s.boatPos, back, lerp(13, 17, u), pos).setY(surface() + lerp(1.8, 2.6, u));
        // toward the moon's bearing at a set height (about the moon's own at the cut), not the moon itself: a
        // camera following the climbing moon tipped up until the boat slid out of the frame's foot
        const sky = a.copy(away).multiplyScalar(Math.cos(NIGHT_LIFT)).setY(Math.sin(NIGHT_LIFT));
        rel(s, 0, 0, 1.0, look).lerp(sky.multiplyScalar(40).add(pos), 0.28);
      },
    },
  ];
}
