import { Vector3 } from 'three';
import { angleDelta, clamp, lerp, smoothstep } from '../core/mathx';
import { sunDirectionOn } from '../env/astro';
import { makeSeasonState, seasonAt } from '../env/season';
import { plotCropAt } from '../world/crops';
import { FISHER_SITE } from '../world/fisher';
import { BIL, BRIDGE, HOMESTEAD_MOUNDS, JOURNEY, SANKO, WATER_LEVEL, bridgeToWorld, corridorDistance, journeyAt, journeyFrame, journeyHalfWidth, landUse, saltIntake, saltPoint, shapePoint, terrainHeight, waterLevelAt, waterRise, waterwayAt } from '../world/geography';
import { bloomRank } from '../world/leaves';
import { LILY_PONDS } from '../world/ponds';
import { SALT_FIELD, type Pt } from '../world/plan';
import { RAIL_LENGTH, TRAIN_SPEED, railAt } from '../world/railway';
import { roadLines } from '../world/roads';
import { gherStand, rakerStations } from '../world/saltworks';
import { groundAt } from '../world/terrain';
import { hasCrownDetail, kashStand, treeCrowns, type Crown } from '../world/vegetation';
import type { Ghat } from '../world/village';
import { bilPoint } from '../world/waterways';
import type { PetalWay, Scene, SceneWorld, Stage } from './director';

// The film tour: a year in the village round its young majhi, as a short film would tell it. A winter dawn
// rising over the misty khal, the date palms' sap dripping into its pots, the young majhi paddling down the river
// in the morning sun, the village's ghat, the road between its tal palms, the mustard and the salt field, the
// afternoon train; spring's blossom and a nor'wester; the rain coming on as he puts on his mathal, and the old
// bridge in the rain as he comes up the khal and out from under its arch (three shots); the salt field kept as a gher, the aman in the floods, the shapla bil; a pond, the kash, the majhi with his net, the
// reaping; and the evening on the water: a sunset seen whole, the moon rising, the night. What each caption
// names is what its shot looks at: the places are found from the village as it stands (the crops a season gives
// a field, the trees in flower, the homestead nearest the water), not guessed.
// Each scene sets its own season, hour and weather (director.ts); the sunrise, the sunset and the moonrise sweep
// their own time through them. The waters are narrow and their banks are wooded, so the low shots look along
// them, from the water; the sun and the moon are framed by placing the boat where her way runs toward them.

/** The sun's direction on `day`, `offset` hours from its setting (worked out ahead, before the scene sets that day). */
function sunFromSetting(day: number, offset: number): Vector3 {
  const dir = new Vector3();
  let up = 12;
  let down = 23.5;
  for (let i = 0; i < 30; i++) {
    const m = (up + down) / 2;
    if (sunDirectionOn(day, m, dir).y > 0) up = m;
    else down = m;
  }
  return sunDirectionOn(day, (up + down) / 2 + offset, dir);
}

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

/** A scene's cues (s into it) as they stand `at` s in, where a still starts: those past are gone, the rest that much nearer. */
const still = (cues: readonly number[], at: number) => cues.filter((t) => t >= at).map((t) => t - at);

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
const tmpC = new Vector3();

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

/** The tree in red flower the film looks at, and the point of the boat's way nearest it (`s`, `side`). */
export interface Blossom {
  s: number;
  side: 1 | -1;
  crown: Vector3;
  r: number;
  /** Its crown, if one stands there (none in flower by the water: a point by the bank). */
  tree: Crown | null;
}
let blossomPicked: Blossom | null = null;

/**
 * The tree in red flower whose petal the film follows down to the water: of the crowns spring has in flower
 * early (bloomRank, leaves.ts), the biggest whose crown reaches out over the water by the boat's way, the
 * khal's narrow water preferred (picked once, when the trees stand; main.ts gives it its fuller crown).
 */
export function blossomTree(): Blossom {
  if (blossomPicked) return blossomPicked;
  let best: Blossom & { score: number } = { score: -Infinity, s: JOURNEY.turn + 200, side: 1, crown: new Vector3(), r: 4, tree: null };
  for (const c of treeCrowns()) {
    if (!c.blossom || !hasCrownDetail(c) || bloomRank(c.x, c.z) > 0.28 || Math.hypot(c.x - BRIDGE.x, c.z - BRIDGE.z) < 45) continue;
    const f = journeyFrame(c.x, c.z);
    if (!f || f.s < JOURNEY.opening + 60 || f.s > JOURNEY.head - 40) continue;
    const near = f.d - journeyHalfWidth(f.s);
    if (near > 15) continue;
    // a crown standing back from the bank lets its petals fall on the land
    const score = c.r - near * 0.25 - Math.max(0, near - 0.45 * c.r) * 1.5 + (f.s > JOURNEY.turn ? 1.5 : 0);
    if (score > best.score) best = { score, s: f.s, side: f.side, crown: new Vector3(c.x, c.y, c.z), r: c.r, tree: c };
  }
  if (!Number.isFinite(best.score)) {
    // none in flower near the water: the bank's trees where the way passes, looked up into all the same
    const p = journeyAt(best.s);
    const out = journeyHalfWidth(best.s) + 8;
    best.crown.set(p.x + Math.cos(p.heading) * out, 0, p.z - Math.sin(p.heading) * out);
    best.crown.y = terrainHeight(best.crown.x, best.crown.z) + 6;
  }
  blossomPicked = best;
  return best;
}

/** The petal's shot: how long it runs, and how far into it the petal lets go (s). */
const PETAL_SHOT = 23;
const PETAL_LETS_GO = 6;

/**
 * Where the petal's shot opens: low on the water near its far bank, upstream or down of where the petal comes
 * down, whichever has the low sun well to the side (so the petals glow but the sun stays out of the frame); and
 * what it looks at (the bank under the tree, the water before it filling the frame's foot).
 */
function petalOpening(petal: PetalWay, crown: Vector3, sun: Vector3, pos: Vector3, look: Vector3): void {
  const L = petal.to;
  const water = L.y;
  look.copy(L).lerp(crown, 0.35).setY(water + 2.6);
  const w = waterwayAt(L.x, L.z);
  if (!w) {
    pos.set(2 * L.x - crown.x, water + 1.9, 2 * L.z - crown.z);
    return;
  }
  const { way, s, side } = w;
  const sl = Math.hypot(sun.x, sun.z) || 1;
  let best = -Infinity;
  for (const dir of [1, -1]) {
    const at = s + 6 * dir;
    const p = way.beside(at, side, -(way.half(at) - 4));
    const vx = look.x - p.x;
    const vz = look.z - p.z;
    const score = -Math.abs((vx * sun.x + vz * sun.z) / ((Math.hypot(vx, vz) || 1) * sl) - 0.3);
    if (score > best) {
      best = score;
      pos.set(p.x, water + 1.9, p.z);
    }
  }
}

/** Moves `p` (level) out over the water of the waterway it is by, if it is less than `inset` m out from its bank. */
function overWater(p: Vector3, inset: number): Vector3 {
  const w = waterwayAt(p.x, p.z);
  if (!w || w.d <= w.half - inset) return p;
  const q = w.way.beside(w.s, w.side, w.half - inset);
  return p.set(q.x, p.y, q.z);
}

/**
 * The petal's shot at `tau` s after it lets go: from the opening (`petalOpening`) in toward it, rising over the
 * water to meet it as it comes out under the crown (level with it, it shows against the land beyond, not lost in
 * the red of the crown behind it), then following it down at an arm's length (its way without its swing, so it
 * swings in the frame) to just over the water to watch it touch, and drawing back a little as it floats off.
 */
function petalPose(tau: number, petal: PetalWay, open: Vector3, openLook: Vector3, pos: Vector3, look: Vector3): void {
  const slow = petal.slowAt(tau, tmpA);
  const now = petal.at(tau, tmpB);
  const water = petal.to.y;
  // the way in: from the opening toward where it comes down
  let dx = open.x - petal.to.x;
  let dz = open.z - petal.to.z;
  const dl = Math.hypot(dx, dz) || 1;
  dx /= dl;
  dz /= dl;
  const end = PETAL_SHOT - PETAL_LETS_GO;
  const followY = tau < petal.fall ? clamp(slow.y - 0.15, water + 0.62, water + 5.5) : water + lerp(0.62, 0.75, smoothstep(petal.fall + 0.5, end, tau));
  // far enough off while it is above the camera not to look straight up at it; closing in as it nears the water
  const off = Math.max(lerp(2.4, 0.95, smoothstep(2, petal.fall - 0.3, tau)), (slow.y - followY) * 1.2) + 0.25 * smoothstep(petal.fall + 1, end, tau);
  const k = ease(smoothstep(-3, 7, tau));
  // (over the water, never over the bank it falls above)
  overWater(tmpC.set(slow.x + dx * off, followY, slow.z + dz * off), 1);
  pos.set(open.x + 0.08 * tau * dz, open.y, open.z - 0.08 * tau * dx).lerp(tmpC, k);
  look.copy(openLook).lerp(tmpC.copy(slow).lerp(now, 0.5), smoothstep(-0.5, 4.5, tau));
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
    // (journeyFrame's answer is reused: what is wanted of it is kept before it is asked again)
    const d = f.d;
    const s = f.s;
    const side = f.side as 1 | -1;
    // its front corner on the way's upstream side, where the palms stand
    const a = shapePoint(m, m.hu, m.hv);
    const b = shapePoint(m, m.hu, -m.hv);
    const sa = journeyFrame(a.x, a.z)?.s ?? s;
    const sb = journeyFrame(b.x, b.z)?.s ?? s;
    const c = sa < sb ? a : b;
    best = { d, s, side, corner: new Vector3(c.x, terrainHeight(c.x, c.z), c.z) };
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

/** The fisherman's world: an autumn afternoon, the low sun behind the camera, still air. */
const FISHER_WORLD: SceneWorld = { day: 300, hour: 16.3, weather: 'clear', wind: 0.3 };

/** The bridge's scene: the rains, an afternoon of drizzle (the majhi's mathal on). */
const BRIDGE_WORLD: SceneWorld = { day: 205, hour: 15.6, weather: 'rain', wind: 0.5, rain: [[0, 0.5], [1, 0.5]], wet: [[0, 0.96], [1, 0.96]] };

/** A point of the bridge's frame (`bx` along it, `bz` along the khal) `up` m above the khal's water. */
function onBridgeFrame(bx: number, bz: number, up: number, out: Vector3): Vector3 {
  const w = bridgeToWorld(bx, bz);
  return out.set(w.x, BRIDGE.water + up, w.z);
}

/**
 * The film's scenes; `ghats` are the village's (world/village.ts planGhats), the first its ghat below the banyan.
 *
 * Told as a cinematographer would tell a year in the village, in five movements: a winter morning (the sunrise
 * over the khal from the air, the date palms' sap, the young majhi, the village's ghat, the road out between its
 * tal palms, the mustard beside it, the salt field where the creek brings the sea's water, the afternoon train
 * across the mustard); the turning year (spring's red blossom, a nor'wester); the rains (the rain coming on the
 * khal, the old bridge in the rain, the salt field kept as a fish gher, the aman planted in the floods, the shapla
 * bil); autumn and the harvest (a pond, the kash, the majhi's net, the reaping); and the evening on the water to
 * the night. Each shot is chosen for its subject: wide where a place is set, low and close where a hand works,
 * rising where the land should open out; and runs as long as its story needs.
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
  // the low sun of the petal's afternoon, which its shot keeps to the side and ahead
  const PETAL_DAY = 75;
  const PETAL_HOUR = 16.3;
  const petalSun = sunDirectionOn(PETAL_DAY, PETAL_HOUR, new Vector3());
  // and its breeze, held blowing from the tree out over the water
  const petalWay = waterwayAt(blossom.crown.x, blossom.crown.z);
  const petalMid = petalWay ? petalWay.way.at(petalWay.s) : null;
  const petalWind = petalMid ? Math.atan2(petalMid.x - blossom.crown.x, petalMid.z - blossom.crown.z) : undefined;
  const storm = stormHome();
  const road = talRoad();
  // the kash where it stands thickest on the bank, and the boat 40 m short of it coming up the khal
  const kashSpot = kashStand() ?? journeyAt(JOURNEY.opening + 100);
  const kash = new Vector3(kashSpot.x, terrainHeight(kashSpot.x, kashSpot.z), kashSpot.z);
  const kashBoat = fractionAt(Math.max(0, (journeyFrame(kash.x, kash.z)?.s ?? JOURNEY.opening + 100) - 40));
  // the sunset's boat: where her way runs toward the low sun, as it stands as the scene opens
  const SUNSET_DAY = 300;
  const SUNSET_FROM = -0.55;
  const sunsetBoat = fractionAt(facing(sunFromSetting(SUNSET_DAY, SUNSET_FROM), 0.3));
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
  // where the creek's water is let into the salt field, and the man the salt scene comes down to
  const creekHead = saltIntake(SALT_FIELD).water;
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
      seconds: 18,
      // the sunrise seen whole: the blue before dawn, the glow along the horizon, the sun coming up out of the
      // mist at the khal's end behind the boat, and the morning's first light on the water and the fields
      world: { day: 14, hour: { at: 'sunrise', offset: -0.55 }, weather: 'clear', wind: 0.2, sweep: [[0, 0], [0.3, 0.3], [0.55, 0.5], [0.75, 0.64], [1, 0.9]] },
      journey: fractionAt(40),
      begin: (s) => s.birds(s.boatPos, s.boatCourse + Math.PI),
      // the establishing shot: down out of the sky over the misty khal and its fields onto the boat coming up it
      pose: (u, s, pos, look) => {
        onWay(alongOf(s.boatPos) + lerp(62, 22, u), 0, lerp(16, 3.2, ease(u)), pos);
        rel(s, 0, 0, lerp(0.4, 1.4, u), look);
      },
    },
    {
      caption: 'খেজুরের রস',
      seconds: 17,
      world: { day: 14, hour: { at: 'sunrise', offset: 0.45 }, weather: 'clear', wind: 0.15 },
      begin: (s) => s.sap(),
      // in the mist beside the field path, at the foot of a tapped date palm: up its zig-zag trunk to the pot
      // tied under the fresh cut, the sap dripping from the bamboo spout into it; then back and out across the
      // field until the row of palms with their pots stands in the morning mist, the low sun behind the camera
      pose: (u, s, pos, look) => {
        const k = s.sapTree;
        const out = tmpA.copy(k.out);
        const side = tmpB.set(out.z, 0, -out.x);
        if (u < 0.42) {
          const e = ease(u / 0.42);
          pos.copy(k.foot).addScaledVector(out, lerp(1.6, 0.95, e)).addScaledVector(side, 0.35).setY(lerp(k.foot.y + 0.5, k.mouth.y + 0.12, e));
          look.copy(k.foot).setY(lerp(k.foot.y + 3, k.mouth.y - 0.02, e)).addScaledVector(out, 0.2 * e);
        } else if (u < 0.72) {
          const e = ease((u - 0.42) / 0.3);
          // close over the pot's mouth, looking down into it: the drops falling from the spout into the sap
          pos.copy(k.mouth).addScaledVector(out, lerp(0.95, 0.36, e)).addScaledVector(side, lerp(0.35, 0.1, e)).setY(k.mouth.y + lerp(0.12, 0.55, e));
          look.copy(k.mouth).setY(k.mouth.y - 0.07).addScaledVector(out, -0.03);
        } else {
          const e = ease((u - 0.72) / 0.28);
          pos.copy(k.mouth).addScaledVector(out, lerp(0.55, 9, e)).addScaledVector(side, lerp(0.18, 5, e)).setY(lerp(k.mouth.y + 0.3, k.foot.y + 3.2, e));
          look.copy(k.mouth).setY(k.mouth.y - 0.03).lerp(a.copy(k.foot).setY(k.foot.y + 3.8).addScaledVector(side, -6), e);
        }
      },
    },
    {
      caption: 'মাঝি',
      seconds: 12,
      world: { day: 14, hour: { at: 'sunrise', offset: 0.75 }, weather: 'clear', wind: 0.25 },
      journey: fractionAt(150),
      // the young majhi: beside him on the water on his paddle's side as he paddles down the river, the low winter
      // sun in the south-east on his face, the camera drawing in a little; the blade dipping between
      pose: (u, s, pos, look) => {
        rel(s, lerp(-1.75, -2.2, u), lerp(2.6, 2.05, u), lerp(1.85, 1.9, u), pos);
        rel(s, -2.95, 0.25, 1.85, look).lerp(rel(s, 6, 0.5, 1.6, a), 0.1);
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
      // (a still that starts into the shot finds the train that far on its way)
      begin: (s, at) => s.train(trainFrom + TRAIN_SPEED * at, true),
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
      seconds: PETAL_SHOT,
      world: { day: PETAL_DAY, hour: PETAL_HOUR, weather: 'clear', wind: 0.35, windToward: petalWind },
      // a tree in red flower over the khal, its fallen petals on the bank and afloat below it, from across the
      // water; then in toward it as one petal lets go, following it down as it swings and tumbles in the breeze,
      // over the water as it touches with a ring, and drawing back as it floats off among the others. The lens
      // draws its focus from the tree to the petal as the camera comes in
      begin: (s, at) => s.dropPetal(at - PETAL_LETS_GO),
      pose: (u, s, pos, look) => {
        petalOpening(s.petal, blossom.crown, petalSun, a, b);
        petalPose(u * PETAL_SHOT - PETAL_LETS_GO, s.petal, a, b, pos, look);
      },
      focus: (u, s, eye) => {
        const tau = u * PETAL_SHOT - PETAL_LETS_GO;
        petalOpening(s.petal, blossom.crown, petalSun, a, b);
        return lerp(eye.distanceTo(b), eye.distanceTo(s.petal.at(tau, a)), smoothstep(0, 5, tau));
      },
    },
    {
      caption: 'কালবৈশাখী',
      seconds: 15,
      world: { day: 128, hour: 16.0, weather: 'storm', wind: 2.6, rain: [[0, 0.55], [0.3, 1], [1, 1]], wet: [[0, 0.15], [1, 0.75]] },
      // across the khal from a homestead in the squall: its palms and bamboo thrashing, the rain driving over the
      // water, lightning forking down beyond the trees
      // (the last early enough that its thunder, a few seconds behind it, is heard before the cut)
      begin: (s, at) => s.lightning(still([2.2, 6.4, 9.4], at)),
      pose: (u, _s, pos, look) => {
        onWay(storm.s + lerp(-26, -14, u), -storm.side * journeyHalfWidth(storm.s) * 0.55, 2.5, pos);
        look.copy(storm.corner).setY(storm.corner.y + lerp(3.6, 3, u));
      },
    },

    // ---------- the rains ----------
    // The monsoon told as it comes: the Asharh cloud gathering over the river and the wind rising before it, the
    // first drops, the rain coming on as the majhi puts on his mathal, then the Asharh downpour on the village's
    // ghat, the land darkening and the water standing in it; the steady rain on the bridge, easing over the gher
    // and the aman, and the bil glistening after it. Each scene takes the wet up where the last left it.
    {
      caption: 'আষাঢ়ের মেঘ',
      seconds: 13,
      world: { day: 176, hour: 15.2, weather: 'rain', wind: null, rain: [[0, 0], [0.72, 0], [1, 0.1]], wet: [[0, 0.04], [1, 0.05]] },
      journey: fractionAt(Math.max(60, JOURNEY.turn - 150)),
      // low over the river ahead of the boat as she comes on, bareheaded in the close air: the cloud heavy and dark
      // over the village, the wind getting up in the trees, a far flash in the cloud, and at the last the first drops
      begin: (s, at) => {
        s.bareheaded();
        s.lightning(still([8.6], at));
      },
      pose: (u, s, pos, look) => {
        rel(s, lerp(26, 19, ease(u)), lerp(4.5, 3.2, u), lerp(2.0, 2.8, u), pos);
        rel(s, 0, 0, 1.4, look).lerp(rel(s, -70, 0, 26, a), lerp(0.34, 0.28, u));
      },
    },
    {
      caption: 'বর্ষার খাল',
      seconds: 15,
      world: { day: 176, hour: 15.5, weather: 'rain', wind: null, rain: [[0, 0.1], [0.3, 0.22], [1, 0.5]], wet: [[0, 0.06], [1, 0.3]] },
      journey: fractionAt(JOURNEY.bridge + 220),
      // the rain comes on as the majhi paddles up the khal: beside him on the water, he rests his paddle, reaches
      // back for his mathal and puts it on, settles it, and paddles on, the rain hissing on the water round him
      begin: (s) => s.bareheaded(),
      pose: (u, s, pos, look) => {
        rel(s, lerp(-1.6, -2.1, u), lerp(-2.7, -2.2, u), lerp(1.8, 1.85, u), pos);
        rel(s, -3.0, 0.15, 1.8, look).lerp(rel(s, 5, 0.5, 1.4, a), 0.08);
      },
    },
    {
      caption: 'আষাঢ়ের ধারা',
      seconds: 22,
      // the Asharh downpour on the village's ghat: low across the water, the drops crowning and ringing it all over,
      // the banyan streaming, the steps and the paving darkening and the water standing on them as it goes on;
      // the boat comes through it, the majhi under his mathal; thunder in it, then it eases a little
      world: { day: 176, hour: 16.0, weather: 'rain', wind: null, rain: [[0, 0.5], [0.3, 0.92], [0.7, 1], [1, 0.82]], wet: [[0, 0.32], [0.45, 0.72], [1, 0.97]] },
      journey: fractionAt(Math.max(0, hubS - 22)),
      begin: (s, at) => s.lightning(still([7.5, 15.2], at)),
      pose: (u, _s, pos, look) => {
        if (!hub) {
          onWay(hubS + lerp(-18, -8, u), 0, lerp(1.0, 2.0, u), pos);
          onWay(hubS, 8, 1.5, look);
          return;
        }
        // from across the water, low over it, rising a little as it goes so the bank's wetting shows
        const ux = Math.sin(hub.up);
        const uz = Math.cos(hub.up);
        const along = lerp(-6, 3, ease(u));
        const out = Math.min(22, journeyHalfWidth(hubS) * 2 - 4);
        pos.set(hub.x - ux * out + uz * along, surface() + lerp(0.9, 2.1, ease(u)), hub.z - uz * out - ux * along);
        look.set(hub.x + ux * 3, surface() + lerp(1.2, 2.2, ease(u)), hub.z + uz * 3);
      },
    },
    // the old bridge, in the rain: the majhi coming up the khal toward its arch, and out from under it. Three shots,
    // cut as a film cuts within a scene; the cuts leave time out, each later shot putting the boat on where she
    // would be by then at her usual way
    {
      caption: 'পুরনো সেতু',
      seconds: 6.5,
      world: BRIDGE_WORLD,
      journey: fractionAt(JOURNEY.bridge - 28),
      // wide: low behind and beside the boat on the khal, the old bridge ahead
      pose: (u, _s, pos, look) => {
        onWay(JOURNEY.bridge - lerp(37, 33, u), 4.6, 1.5, pos);
        onBridgeFrame(-0.6, 0, BRIDGE.crown - 0.6, look);
      },
    },
    {
      caption: '',
      seconds: 4.5,
      shot: true,
      world: BRIDGE_WORLD,
      journey: fractionAt(JOURNEY.bridge - 14.8),
      // tracking with the boat, low over his left shoulder from behind: him paddling under his mathal, the bridge
      // ahead coming nearer
      pose: (u, s, pos, look) => {
        rel(s, lerp(-4.9, -5.1, u), -1.25, 2.05, pos);
        rel(s, 1.5, 0.3, 1.6, look).lerp(onBridgeFrame(-0.6, 0, BRIDGE.crown - 0.6, b), 0.2);
      },
    },
    {
      caption: '',
      seconds: 4.5,
      shot: true,
      world: BRIDGE_WORLD,
      journey: fractionAt(JOURNEY.bridge + 1.4),
      // low on the water up the khal: the boat coming out from under the arch toward the camera, and past it
      pose: (u, s, pos, look) => {
        onWay(JOURNEY.bridge + lerp(27, 24, u), 4.2, 1.0, pos);
        rel(s, 0, 0, 1.2, look).lerp(onBridgeFrame(0, 0, BRIDGE.crown - 1.5, b), 0.35);
      },
    },
    {
      caption: 'বর্ষার ঘের',
      seconds: 14,
      world: { day: 205, hour: 15.2, weather: 'drizzle', wind: 0.5, rain: [[0, 0.35], [1, 0.26]], wet: [[0, 0.95], [1, 0.93]] },
      // the salt field in the rains, kept as a fish gher: behind a man on its bund as he casts into the old
      // settling pond, the watchman's hut on its bamboo legs, the drizzle on the water
      begin: (s, at) => s.gherFisherman(0.6 + at),
      pose: (u, _s, pos, look) => {
        pos.set(gher.x, (gher.ground ?? 0) + lerp(1.9, 1.6, u), gher.z).addScaledVector(gherFwd, lerp(-5.5, -4, u)).addScaledVector(gherRight, lerp(3.4, 2.4, u));
        look.set(gher.x, (gher.ground ?? 0) + 0.8, gher.z).addScaledVector(gherFwd, lerp(3, 5, u));
      },
    },
    {
      caption: 'ডুবো মাঠে আমন',
      seconds: 13,
      world: { day: 210, hour: 12.5, weather: 'drizzle', wind: 0.5, rain: [[0, 0.24], [1, 0.12]], wet: [[0, 0.92], [1, 0.88]] },
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
      caption: 'বাঁশের সাঁকো',
      seconds: 14,
      world: { day: 230, hour: 8.6, weather: 'clear', wind: 0.3, rain: [[0, 0], [1, 0]], wet: [[0, 0.6], [1, 0.56]] },
      // the side khal on a late-rains morning, the water high: low on it past the high bamboo sanko, looking back
      // as the boat comes up to it and through under its middle span, the majhi standing at her stern clear under
      // the walkway, and on toward the camera, which draws back before her
      journey: fractionAt(JOURNEY.sanko - 10),
      pose: (u, s, pos, look) => {
        onWay(JOURNEY.sanko + lerp(13, 16, ease(u)), 1.5, lerp(1.0, 1.25, u), pos);
        rel(s, 0, 0, 1.3, look).lerp(a.set(SANKO.x, SANKO.water + SANKO.crown - 0.4, SANKO.z), lerp(0.4, 0.15, ease(u)));
      },
    },
    {
      caption: 'শাপলা বিল',
      seconds: 14,
      world: { day: 235, hour: 9.2, weather: 'clear', wind: 0.25, rain: [[0, 0], [1, 0]], wet: [[0, 0.72], [1, 0.66]] },
      // low over the lily rafts, drifting across the bil below the hills, the train going by beyond it
      begin: (s, at) => s.train(BIL_TRAIN - TRAIN_SPEED * (7 - at), true),
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
      // (her place known ahead, so the shot's places are built before its cut)
      journey: kashBoat,
      pose: (u, s, pos, look) => {
        pos.copy(kash);
        pos.y += lerp(1.5, 2.7, ease(u));
        rel(s, 0, 0, 1.0, look);
      },
    },
    {
      caption: 'জেলের জাল',
      seconds: 9.5,
      world: FISHER_WORLD,
      // the young majhi out with his net, in three shots as the cast goes (world/fisher.ts T, cued 0.4 s in). Wide,
      // from along the river with the low sun behind: the dinghy side on at her pole, him in her bow; he winds
      // round and casts, the net opening toward the far bank into a wide circle catching the light, falling flat,
      // its rim splashing all round and the rings running out from it
      journey: 0.15,
      begin: (s, at) => s.fisherman(0.4 + at),
      pose: (u, _s, pos, look) => {
        pos.copy(fisherAt).addScaledVector(left, 16).addScaledVector(fwd, lerp(0.5, 2.2, u)).setY(surface() + lerp(2.6, 2.3, u));
        look.lerpVectors(fisherAt, netFalls, 0.42).setY(surface() + 1.1);
      },
    },
    {
      caption: '',
      seconds: 9,
      shot: true,
      world: FISHER_WORLD,
      // nearer, abeam of her bow: the hauling, hand over hand, the net coming in under the water, stirring it
      pose: (u, _s, pos, look) => {
        pos.copy(fisherAt).addScaledVector(left, lerp(8.5, 7.6, u)).addScaledVector(fwd, lerp(2.6, 1.6, u)).setY(surface() + lerp(1.9, 1.7, u));
        look.copy(fisherAt).addScaledVector(fwd, lerp(3.2, 1.8, u)).setY(surface() + 0.9);
      },
    },
    {
      caption: '',
      seconds: 7,
      shot: true,
      world: FISHER_WORLD,
      // close at her bow: the bag drawn up out of the water, pouring, the fish in it; swung in and shaken out on the
      // boards
      pose: (u, _s, pos, look) => {
        pos.copy(fisherAt).addScaledVector(left, lerp(3.6, 3.2, u)).addScaledVector(fwd, lerp(2.4, 1.8, u)).setY(surface() + lerp(1.35, 1.5, u));
        look.copy(fisherAt).addScaledVector(fwd, lerp(1.0, 0.1, ease(u))).addScaledVector(left, lerp(0, 0.35, ease(u))).setY(surface() + lerp(1.0, 0.45, ease(u)));
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
      caption: 'সূর্যাস্ত',
      seconds: 18,
      // the sunset seen whole: the afternoon's gold, the sun sinking to the trees at the khal's end and reddening,
      // touching, gone; the sky deepening to crimson after it and the dusk coming on
      world: { day: SUNSET_DAY, hour: { at: 'sunset', offset: SUNSET_FROM }, weather: 'clear', wind: 0.15, sweep: [[0, 0], [0.35, 0.36], [0.6, 0.55], [0.8, 0.66], [1, 0.84]] },
      // behind the boat paddling up the khal toward the low sun, off to one side of her, drawing in slowly
      journey: sunsetBoat,
      begin: (s) => s.birds(s.boatPos, s.boatCourse),
      pose: (u, s, pos, look) => {
        onWay(alongOf(s.boatPos) - lerp(21, 14, ease(u)), 0, lerp(1.2, 0.95, u), pos);
        rel(s, 0, 0, lerp(1.4, 1.1, u), look);
      },
    },
    {
      caption: 'চাঁদ ওঠা',
      seconds: 16,
      // the moonrise: the evening sky over the bil, the full moon's rim over the trees, the moon clearing them
      // amber and paling as it climbs, its light coming onto the water
      world: { day: 300, moon: 14.8, hour: { at: 'moonrise', offset: -0.12 }, weather: 'clear', wind: 0.15, sweep: [[0, 0], [0.4, 0.2], [0.7, 0.38], [1, 0.6]] },
      // (far enough short of the journey's end that she is not taken back to its start in the mist mid-shot)
      journey: fractionAt(JOURNEY.head + 40),
      pose: (u, s, pos, look) => {
        const m = s.moonDir;
        const away = tmpA.set(m.x, 0, m.z).normalize();
        const aside = tmpB.set(away.z, 0, -away.x);
        overOpenWater(pos.copy(s.boatPos).addScaledVector(away, -lerp(17, 12, u)).addScaledVector(aside, lerp(3, 1.5, u)), s.boatPos).setY(surface() + 1.3);
        const toBoat = a.subVectors(rel(s, 0, 0, 1.2, look), pos).normalize();
        // toward where the moon is or is coming up, never down into the water before it is up
        b.set(m.x, Math.max(m.y, 0.05), m.z).normalize();
        look.copy(pos).addScaledVector(toBoat.lerp(b, 0.55).normalize(), 30);
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
