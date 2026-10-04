import { Vector3 } from 'three';
import { G } from '../core/globals';
import { angleDelta, lerp } from '../core/mathx';
import { canopyAt, place } from '../geo/data';
import {
  ADINATH,
  BIL,
  BRIDGE,
  GORAKGHATA,
  JOURNEY_Z0,
  JOURNEY_Z1,
  PONDS,
  VILLAGES,
  bankAt,
  edgeHalfWidth,
  halfWidth,
  khalPoint,
  riverX,
  saltPan,
  terrainHeight,
  waterLevelAt,
} from '../world/geography';
import { stairAt } from '../world/moheshkhali';
import { PLANT } from '../world/plantSite';
import { berthPoint } from '../world/portSite';
import { onRoad } from '../world/roads';
import { groundAt } from '../world/terrain';
import { kashStretch } from '../world/vegetation';
import { GHATS } from '../world/village';
import type { Scene, Stage } from './director';

// The film tour: a year and a day on the Moheshkhali channel, as a short documentary would show it. A winter dawn in
// mist and the boatman at sunrise, mustard in the fields and a village ghat; spring's blossom and the
// narrows; summer's fishermen at their nets, a khal at golden hour and a nor'wester; the monsoon's rain and
// its flooded fields; under the old bridge into the shapla bil, a wetland and the kash of autumn; the golden harvest;
// Adinath hill over Gorakghata in the morning, the island's salt fields under its hills, Sonadia and the estuary in
// winter; and the evening on the river: sunset, moonrise and night.
// Each scene sets its own season, hour and weather (director.ts), so every part of the world is shown at
// its best, wherever the viewer's boat happens to be.

const UP = new Vector3(0, 1, 0);

/** The journey's fraction at z (for placing the boat). */
const journeyAt = (z: number) => (z - JOURNEY_Z0) / (JOURNEY_Z1 - JOURNEY_Z0);
/** Height above the water as it stands now. */
const onWater = (h: number) => G.uWaterLevel.value + h;
/** A point over the bridge's khal `d` m along it from the bridge, `side` m to its right, `up` m above its water. */
function onKhal(d: number, up: number, side: number, out: Vector3): Vector3 {
  const k = khalPoint(d);
  const level = waterLevelAt(k.x, k.z);
  return out.set(k.x + Math.cos(k.heading) * side, (Number.isFinite(level) ? level : BRIDGE.water) + up, k.z - Math.sin(k.heading) * side);
}
/** A point across the river at z: `u` from the centre line. */
const across = (z: number, u: number, y: number, out: Vector3) => out.set(riverX(z) + u, y, z);

const tmpA = new Vector3();
const tmpB = new Vector3();

/** Off to the side by this much (rad): where the sun or moon sits in a shot of it, beside the boat, not behind her. */
const ASIDE = 0.45;

/**
 * The bearing to look along so that a body in direction `dir` sits ASIDE off the middle of the frame,
 * turned toward the boat's way ahead (`course`), so the river ahead stays in the shot.
 */
function besideBearing(dir: Vector3, course: number): number {
  const bearing = Math.atan2(dir.x, dir.z);
  return bearing - Math.sign(angleDelta(course, bearing)) * ASIDE;
}

/** A point relative to the boat: `a` m ahead, `s` m to her starboard (+x), `h` m above the water. */
function rel(stage: Stage, a: number, s: number, h: number, out: Vector3): Vector3 {
  const c = stage.boatCourse;
  return out
    .copy(stage.boatPos)
    .addScaledVector(tmpA.set(Math.sin(c), 0, Math.cos(c)), a)
    .addScaledVector(tmpB.set(Math.cos(c), 0, -Math.sin(c)), s)
    .setY(onWater(h));
}

/**
 * A stretch of paddy fields to fly over: on `side`, as near `z0` along the channel as there is one, a 60 m run
 * parallel to it all in field plots (the fields lie behind the flats, the mangroves and the ghers, up to
 * 1.5 km inland). Returns its start, and its end downstream.
 */
function fieldRun(z0: number, side: 1 | -1): { from: Vector3; to: Vector3 } {
  for (let k = 0; k < 240; k++) {
    const z = z0 + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * 25;
    for (let inland = 70; inland <= 1500; inland += 16) {
      const at = (zz: number) => riverX(zz) + side * (edgeHalfWidth(zz, side) + inland);
      const ok = [0, 20, 40, 60].every((d) => groundAt(at(z - d), z - d).zone > 0.85);
      if (ok) return { from: new Vector3(at(z), 0, z), to: new Vector3(at(z - 60), 0, z - 60) };
    }
  }
  const z = z0 - 300;
  return { from: new Vector3(riverX(z) + side * 150, 0, z), to: new Vector3(riverX(z - 60) + side * 150, 0, z - 60) };
}

/** Salt pans to crane over: a run of 50 m all in pans, on `side`, as near `z0` along the channel as there is one. */
function saltRun(z0: number, side: 1 | -1): { from: Vector3; to: Vector3 } {
  for (let k = 0; k < 300; k++) {
    const z = z0 + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * 20;
    for (let inland = 60; inland <= 1500; inland += 20) {
      const at = (zz: number) => riverX(zz) + side * (edgeHalfWidth(zz, side) + inland);
      if ([0, 25, 50].every((d) => saltPan(at(z - d), z - d) > 0.95)) return { from: new Vector3(at(z), 0, z), to: new Vector3(at(z - 50), 0, z - 50) };
    }
  }
  const z = z0 - 100;
  return { from: new Vector3(riverX(z) + side * 300, 0, z), to: new Vector3(riverX(z - 50) + side * 300, 0, z - 50) };
}

/**
 * Over the ground along a run (above whatever grows there), looking ahead and a touch toward the river;
 * `back` flies it the other way (to keep the sun behind the camera).
 */
function glide(run: { from: Vector3; to: Vector3 }, side: 1 | -1, height: number, u: number, pos: Vector3, look: Vector3, back = false): void {
  const from = back ? run.to : run.from;
  const to = back ? run.from : run.to;
  pos.lerpVectors(from, to, u);
  pos.y = Math.max(terrainHeight(pos.x, pos.z), waterLevelAt(pos.x, pos.z)) + height;
  const dir = tmpA.subVectors(to, from).normalize();
  look.copy(pos).addScaledVector(dir, 45).addScaledVector(tmpB.set(-side, 0, 0), 14);
  look.y = pos.y - height * 0.7;
}

// places found once, at load (deterministic); the tour is re-authored for the real map later (plan's step L),
// these keep each scene on a real place meanwhile
const MUSTARD = fieldRun(4200, -1);
const FLOODED = fieldRun(2600, -1);
const HARVEST = fieldRun(1800, -1);
const SALT = saltRun(1200, 1);
/** A stretch of the island's bank under trees (the satellites' canopy) for spring's blossom, south from `z0`. */
const BLOSSOM_Z = (() => {
  for (let z = 2400; z > 0; z -= 10) if (canopyAt(riverX(z) + edgeHalfWidth(z, 1) + 18, z).cover > 0.5) return z;
  return 2400;
})();
const VILLAGE_GHAT = GHATS[Math.min(2, GHATS.length - 1)];
const STORM_VILLAGE = VILLAGES[Math.min(1, VILLAGES.length - 1)];
/** A village pond to walk round in the morning (in place of the made-up wetlands); the bil if there is none. */
const POND = PONDS[0] ?? { x: riverX(BIL.z) + BIL.u, z: BIL.z, r: BIL.halfWid, level: BIL.level };
const SONADIA_BEACH = place('sonadia-beach').world;
const TEMPLE = place('adinath-temple').world;
/** Gorakghata's jetty: its land end, the run out to its head, and the unit normal to its north side. */
const JETTY = (() => {
  const land = place('gorakghata-jetty-land').world;
  const head = place('gorakghata-jetty-head').world;
  const ax = head.x - land.x;
  const az = head.z - land.z;
  const len = Math.hypot(ax, az);
  return { land, ax, az, nx: az / len, nz: -ax / len };
})();

/**
 * A stand of kash on the channel's bank for the film: the first along the journey that runs at least 40 m on a
 * bank whose top is wide (10 m of it above the spring tides and off the roads, where vegetation.ts plants it), the
 * camera a few metres in from the edge.
 */
const KASH = (() => {
  const top = (h: number) => h >= 1.9 && h <= 3.5;
  for (let z = JOURNEY_Z0 - 400; z > JOURNEY_Z1 + 400; z -= 10) {
    for (const side of [1, -1] as const) {
      if (![0, 10, 20, 30, 40].every((d) => kashStretch(z - d, side))) continue;
      const bank = bankAt(z, side, 1.9);
      if (!bank || bank.d <= 0 || bank.d > halfWidth(z) * 2) continue;
      const ux = (bank.x - riverX(z)) / bank.d;
      const uz = (bank.z - z) / bank.d;
      let wide = 0;
      for (let d = 0; d < 14; d++) {
        const x = bank.x + ux * d;
        const zz = bank.z + uz * d;
        if (top(terrainHeight(x, zz)) && !onRoad(x, zz, 1.5)) wide++;
      }
      if (wide < 10) continue;
      const x = bank.x + ux * 4;
      const zz = bank.z + uz * 4;
      return { x, y: terrainHeight(x, zz), z: zz, ux, uz };
    }
  }
  return { x: riverX(0), y: G.uWaterLevel.value, z: 0, ux: 1, uz: 0 };
})();
const SONADIA = place('sonadia').world;

export function tourScenes(): Scene[] {
  // per-scene choices made as each scene opens
  const a = new Vector3();
  const b = new Vector3();
  const c = new Vector3();
  let bearing = 0;

  return [
    {
      caption: 'শীতের ভোর',
      seconds: 15,
      world: { day: 14, hour: { at: 'sunrise', offset: 0 }, weather: 'clear', wind: 0.2 },
      journey: journeyAt(60),
      begin: (s) => s.birds(s.boatPos, s.boatCourse + Math.PI),
      // down out of the sky over the misty river onto the boat coming down it, the sunrise behind her
      pose: (u, s, pos, look) => {
        rel(s, lerp(170, 26, u), lerp(42, 13, u), lerp(52, 6, u), pos);
        look.lerpVectors(rel(s, -260, 0, 14, a), rel(s, 0, 0, 1.4, b), Math.pow(u, 0.8));
      },
    },
    {
      caption: 'মাঝি',
      seconds: 12,
      world: { day: 14, hour: { at: 'sunrise', offset: 0.08 }, weather: 'clear', wind: 0.2 },
      // close beside the boatman as he paddles, the low sun behind him
      pose: (u, s, pos, look) => {
        rel(s, -7, lerp(3.6, -0.8, u), 1.6, pos);
        rel(s, -2.8, 0, 1.55, look).lerp(rel(s, 12, 0, 2, a), 0.2);
      },
    },
    {
      caption: 'সরিষার মাঠ',
      seconds: 12,
      world: { day: 20, hour: 8.6, weather: 'clear', wind: 0.5 },
      pose: (u, _s, pos, look) => glide(MUSTARD, 1, 7, u, pos, look),
    },
    {
      caption: 'গ্রামের ঘাট',
      seconds: 12,
      world: { day: 28, hour: 9.4, weather: 'clear', wind: 0.35 },
      // along the water past the village's ghat, its boats tied up below the houses
      pose: (u, _s, pos, look) => {
        const g = VILLAGE_GHAT;
        const z = g.z + lerp(28, -12, u);
        across(z, g.side * (edgeHalfWidth(z, g.side) - 24), onWater(2.3), pos);
        across(g.z, g.side * (edgeHalfWidth(g.z, g.side) + 8), onWater(3), look);
      },
    },
    {
      caption: 'বসন্তের রং',
      seconds: 11,
      world: { day: 75, hour: 16.3, weather: 'clear', wind: 0.5 },
      // down the bank under its trees in flower, from the water
      pose: (u, _s, pos, look) => {
        const z = lerp(BLOSSOM_Z + 20, BLOSSOM_Z - 25, u);
        across(z, edgeHalfWidth(z, 1) - 20, onWater(2.2), pos);
        across(z - 50, edgeHalfWidth(z - 50, 1) + 18, onWater(6), look);
      },
    },
    {
      caption: 'আদিনাথের সিঁড়ি',
      seconds: 13,
      // Falgun, the month of the temple's Shivaratri fair
      world: { day: 62, hour: 7.6, weather: 'clear', wind: 0.3 },
      // from beside the long stair on the hill's lower flank (the stair climbs across the slope), rising with it
      // toward the temple at its top
      pose: (u, _s, pos, look) => {
        const { from, to } = GORAKGHATA.stair;
        const dx = to.x - from.x;
        const dz = to.z - from.z;
        const run = Math.hypot(dx, dz);
        const t = lerp(0.2, 0.45, u);
        const x = from.x + dx * t - (dz / run) * 28;
        const z = from.z + dz * t + (dx / run) * 28;
        pos.set(x, terrainHeight(x, z) + lerp(5, 9, u), z);
        // between the stair's upper flight and the temple's spire over it
        const sx = from.x + dx * 0.75;
        const sz = from.z + dz * 0.75;
        look.set(sx, stairAt(sx, sz) ?? terrainHeight(sx, sz), sz);
        look.lerp(tmpB.set(TEMPLE.x, terrainHeight(TEMPLE.x, TEMPLE.z) + 10, TEMPLE.z), 0.4);
      },
    },
    {
      caption: 'সরু জলপথ',
      seconds: 12,
      world: { day: 110, hour: 10.5, weather: 'clear', wind: 0.6 },
      // high over the khal by Bara Moheshkhali winding through the fields, drifting along it toward the old bridge
      pose: (u, _s, pos, look) => {
        onKhal(lerp(-150, -90, u), lerp(34, 24, u), 22, pos);
        onKhal(lerp(-60, 0, u), 0, 0, look);
      },
    },
    {
      caption: 'ভেসাল জাল',
      seconds: 15,
      // a first-quarter moon brings high water to this hour (env/tide.ts), so the bank net soaks deep
      world: { day: 134, hour: 16.4, moon: 7, weather: 'clear', wind: 0.5 },
      begin: (s) => {
        s.haul('bank', 0);
        const n = s.net('bank', 0);
        a.copy(n.centre);
        b.copy(n.man);
        c.copy(n.out);
      },
      // from the water off the bank: the net coming up out of the river, the fisherman hauling on his machan
      pose: (u, _s, pos, look) => {
        const sideways = tmpA.crossVectors(UP, c).normalize();
        pos.copy(a).addScaledVector(c, lerp(9, 6, u)).addScaledVector(sideways, lerp(12, 8, u)).setY(onWater(2.4));
        look.lerpVectors(a, b, 0.62).setY(onWater(2.6));
      },
    },
    {
      caption: 'জেলে নৌকা',
      seconds: 13,
      world: { day: 140, hour: 17.0, weather: 'clear', wind: 0.4 },
      begin: (s) => {
        s.haul('boat', 0);
        const n = s.net('boat', 0);
        a.copy(n.centre);
        b.copy(n.man);
        c.copy(n.out);
      },
      // low on the water beside the fishing boat as she lifts her net from the river
      pose: (u, _s, pos, look) => {
        const sideways = tmpA.crossVectors(UP, c).normalize();
        const mid = tmpB.lerpVectors(a, b, 0.5);
        pos.copy(mid).addScaledVector(sideways, 15).addScaledVector(c, lerp(-4, 3, u)).setY(onWater(1.6));
        look.copy(mid).setY(onWater(1.4));
      },
    },
    {
      caption: 'খাল',
      seconds: 13,
      world: { day: 150, hour: 17.5, weather: 'clear', wind: 0.3 },
      // gliding up the khal between its banks, the old bridge ahead
      pose: (u, _s, pos, look) => {
        onKhal(lerp(110, 70, u), 1.7, 0, pos);
        onKhal(lerp(40, 0, u), 1.3, 0, look);
      },
    },
    {
      caption: 'কালবৈশাখী',
      seconds: 12,
      world: { day: 128, hour: 16.0, weather: 'storm', wind: 2.6 },
      // the squall over a village: trees thrashing, rain driving, the river white-capped
      pose: (u, _s, pos, look) => {
        const v = STORM_VILLAGE;
        const z = lerp(v.z + 40, v.z + 10, u);
        across(z, v.side * (edgeHalfWidth(z, v.side) - 34), onWater(2.4), pos);
        across(v.z - 20, v.side * (edgeHalfWidth(v.z, v.side) + 22), onWater(6), look);
      },
    },
    {
      caption: 'বর্ষার নদী',
      seconds: 13,
      world: { day: 195, hour: 11.0, weather: 'rain', wind: null },
      journey: 0.47,
      // round the boat in the rain as she rides the swell
      pose: (u, s, pos, look) => {
        rel(s, lerp(-9, -2, u), lerp(-8.5, -9.5, u), 1.5, pos);
        rel(s, 1, 0, 1.1, look);
      },
    },
    {
      caption: 'ডুবো মাঠে আমন',
      seconds: 11,
      world: { day: 205, hour: 12.5, weather: 'drizzle', wind: 0.5 },
      pose: (u, _s, pos, look) => glide(FLOODED, -1, 4, u, pos, look),
    },
    {
      caption: 'সেতুর নিচে',
      seconds: 16,
      world: { day: 268, hour: { at: 'sunset', offset: -0.7 }, weather: 'clear', wind: 0.55 },
      // low on the khal, gliding up to the old bridge and under it, the girl with her umbrella above, the
      // evening sun over the camera's shoulder
      pose: (u, _s, pos, look) => {
        onKhal(lerp(-26, -4, u), lerp(2.2, 1.5, u), lerp(1.6, 0.6, u), pos);
        onKhal(lerp(4, 20, u), lerp(3.6, 2.4, u), 0, look);
      },
    },
    {
      caption: 'শাপলা বিল',
      seconds: 14,
      world: { day: 235, hour: 9.2, weather: 'clear', wind: 0.25 },
      // low over the lily rafts, drifting across the bil in its valley among the hills
      pose: (u, _s, pos, look) => {
        const z = BIL.z + lerp(-BIL.halfLen * 0.7, -BIL.halfLen * 0.4, u);
        pos.set(riverX(z) + BIL.u - BIL.halfWid * 0.3, BIL.level + lerp(5, 3.2, u), z);
        look.set(riverX(BIL.z) + BIL.u, BIL.level + 0.2, BIL.z);
      },
    },
    {
      caption: 'জলাভূমি',
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
      caption: 'চরের কাশবন',
      seconds: 12,
      world: { day: 262, hour: 16.4, weather: 'clear', wind: 0.9 },
      journey: journeyAt(KASH.z + 150),
      // among the kash on the bank's top, its plumes tossing, the boat coming down the channel
      pose: (u, s, pos, look) => {
        const along = lerp(0, -6, u);
        pos.set(KASH.x - KASH.uz * along, KASH.y + 1.7, KASH.z + KASH.ux * along);
        look.lerpVectors(across(KASH.z + 90, 0, onWater(1.4), a), rel(s, 0, 0, 1.2, b), 0.85);
      },
    },
    {
      caption: 'হেমন্তের ধান',
      seconds: 12,
      world: { day: 318, hour: 15.4, weather: 'clear', wind: 0.5 },
      pose: (u, _s, pos, look) => glide(HARVEST, -1, 6, u, pos, look, true),
    },
    {
      caption: 'আদিনাথ পাহাড়',
      seconds: 15,
      world: { day: 300, hour: { at: 'sunrise', offset: 0.7 }, weather: 'clear', wind: 0.3 },
      // early on the channel, the morning sun behind the camera: Gorakghata's jetty and town on the shore, the
      // forested hills behind, and on the top of its hill the white spire of Adinath temple; drifting slowly in
      pose: (u, _s, pos, look) => {
        const z = lerp(GORAKGHATA.jetty.z + 70, GORAKGHATA.jetty.z + 30, u);
        across(z, edgeHalfWidth(z, 1) - lerp(150, 120, u), onWater(2.4), pos);
        across(ADINATH.z, ADINATH.u - 12, lerp(44, 48, u), look);
      },
    },
    {
      caption: 'গোরকঘাটা জেটি',
      seconds: 13,
      // a last-quarter moon brings the afternoon's high water (env/tide.ts), so the jetty stands in the channel
      world: { day: 305, hour: 16.9, moon: 22, weather: 'clear', wind: 0.4 },
      // low over the water beside the long jetty, gliding in along it from beyond its head toward the town, into
      // the low sun
      pose: (u, _s, pos, look) => {
        const t = lerp(1.1, 0.75, u);
        pos.set(JETTY.land.x + JETTY.ax * t + JETTY.nx * 22, onWater(4.5), JETTY.land.z + JETTY.az * t + JETTY.nz * 22);
        look.set(JETTY.land.x + JETTY.ax * 0.35, onWater(2.5), JETTY.land.z + JETTY.az * 0.35);
      },
    },
    {
      caption: 'লবণ মাঠ',
      seconds: 14,
      world: { day: 25, hour: 12.5, weather: 'clear', wind: 0.5 },
      // a crane down over the salt pans: brine, black sheets, white crust, the heaps along the bunds
      pose: (u, _s, pos, look) => {
        pos.lerpVectors(SALT.from, SALT.to, u * 0.5);
        pos.y = Math.max(terrainHeight(pos.x, pos.z), waterLevelAt(pos.x, pos.z)) + lerp(18, 9, u);
        const dir = tmpA.subVectors(SALT.to, SALT.from).normalize();
        look.copy(pos).addScaledVector(dir, 70);
        look.y = terrainHeight(look.x, look.z);
      },
    },
    {
      caption: 'সোনাদিয়া',
      seconds: 13,
      world: { day: 20, hour: { at: 'sunset', offset: -0.9 }, weather: 'clear', wind: 0.6 },
      // a long glide in from the Bay (south-west of it) onto Sonadia's beach: its dunes and casuarinas, the
      // mangroves on its inner shore beyond
      pose: (u, _s, pos, look) => {
        const d = lerp(260, 140, u);
        pos.set(SONADIA_BEACH.x + d * 0.7, onWater(lerp(32, 20, u)), SONADIA_BEACH.z - d * 0.7);
        look.set(SONADIA.x, onWater(2), SONADIA.z);
      },
    },
    {
      caption: 'মাতারবাড়ী বন্দর',
      seconds: 14,
      world: { day: 22, hour: 14.8, weather: 'clear', wind: 0.4 },
      begin: (s) => s.ship('berthing', 0.25),
      // from the basin's water off the container quay: the ship eased in alongside by her tugs, under the cranes
      pose: (u, s, pos, look) => {
        const at = berthPoint('container', lerp(0.35, 0.55, u), -170);
        pos.set(at.x, onWater(16), at.z);
        const f = s.shipFocus;
        look.set(f.x, onWater(12), f.z);
      },
    },
    {
      caption: 'মোহনা',
      seconds: 12,
      world: { day: 25, hour: { at: 'sunset', offset: -0.45 }, weather: 'clear', wind: 0.6 },
      journey: 0.93,
      // the river opening into the estuary, the boat small on it, the salt flats low on the banks
      pose: (u, s, pos, look) => {
        rel(s, lerp(-34, -14, u), 30, 3, pos);
        rel(s, 25, -10, 1.5, look);
      },
    },
    {
      caption: 'সূর্যাস্ত',
      seconds: 14,
      world: { day: 290, hour: { at: 'sunset', offset: -0.04 }, weather: 'clear', wind: 0.15 },
      journey: journeyAt(60),
      begin: (s) => {
        // look toward the sun with it off to one side of the frame, the boat on its path of light
        bearing = besideBearing(s.sunDir, s.boatCourse);
        s.birds(s.boatPos, s.boatCourse);
      },
      pose: (u, s, pos, look) => {
        const a = bearing + lerp(0.1, -0.1, u);
        pos.copy(s.boatPos).addScaledVector(tmpA.set(Math.sin(a), 0, Math.cos(a)), -lerp(19, 14, u)).setY(onWater(1.0));
        look.copy(s.boatPos).setY(onWater(1.2));
      },
    },
    {
      caption: 'মাতারবাড়ী বিদ্যুৎকেন্দ্র',
      seconds: 13,
      world: { day: 290, hour: { at: 'sunset', offset: 0.35 }, weather: 'clear', wind: 0.4 },
      // the plant from out on the port's water at dusk: the tall chimney, its plume drifting, the lights coming on
      pose: (u, _s, pos, look) => {
        const a = lerp(1.0, 1.3, u);
        pos.set(PLANT.stack.x + Math.sin(a) * 900, onWater(28), PLANT.stack.z + Math.cos(a) * 900);
        look.set(PLANT.stack.x, 105, PLANT.stack.z);
      },
    },
    {
      caption: 'চাঁদ ওঠা',
      seconds: 14,
      world: { day: 290, moon: 14.8, hour: { at: 'moonrise', offset: 0.2 }, weather: 'clear', wind: 0.15 },
      // low behind the boat, the full moon rising over the river off to one side of her lantern
      begin: (s) => {
        bearing = besideBearing(s.moonDir, s.boatCourse);
      },
      pose: (u, s, pos, look) => {
        const m = s.moonDir;
        const flat = tmpA.set(Math.sin(bearing), 0, Math.cos(bearing));
        const sideways = tmpB.crossVectors(UP, flat).normalize();
        pos.copy(s.boatPos).addScaledVector(flat, -lerp(18, 13, u)).addScaledVector(sideways, lerp(4, 1.5, u)).setY(onWater(1.3));
        look.copy(s.boatPos).addScaledVector(flat, 40).setY(onWater(1.3 + 40 * Math.tan(Math.asin(Math.max(m.y, 0))) * 0.8));
      },
    },
    {
      caption: 'রাতের নদী',
      seconds: 15,
      world: { day: 290, moon: 14.8, hour: { at: 'moonrise', offset: 0.4 }, weather: 'clear', wind: 0.15 },
      // up and away from the lantern over the river in the last of the light, the moon on the water
      pose: (u, s, pos, look) => {
        rel(s, lerp(-12, -60, u), lerp(4, 22, u), lerp(3, 28, u), pos);
        rel(s, lerp(3, 50, u), 0, 1, look);
      },
    },
  ];
}
