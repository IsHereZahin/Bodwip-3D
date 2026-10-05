import { Vector3 } from 'three';
import { angleDelta, lerp } from '../core/mathx';
import { BUILDINGS, canopyAt } from '../geo/data';
import { BIL, JOURNEY, KHAL_LEVEL, khalAt, khalFrame, khalHalfWidth, terrainHeight } from '../world/geography';
import { bilPoint } from '../world/khal';
import { LILY_PONDS } from '../world/ponds';
import { groundAt } from '../world/terrain';
import { kashStand } from '../world/vegetation';
import type { Ghat } from '../world/village';
import type { Scene, Stage } from './director';

// The film tour: a year and a day on the khal, as a short documentary would show it. A winter dawn in mist and
// the boatman at sunrise, mustard in the fields and a village ghat; spring's blossom and a nor'wester; the
// monsoon's rain and its flooded fields; under the old bridge and out into the shapla bil, a village pond and
// the kash of autumn; the golden harvest; and the evening on the khal: sunset, moonrise and night.
// Each scene sets its own season, hour and weather (director.ts). The khal is narrow and its banks are
// wooded, so the low shots look along it, from its water; the sun and the moon are framed by placing the
// boat where the khal runs toward them.

/** The journey's fraction at `s` m along the khal (for placing the boat). */
const journeyAt = (s: number) => s / JOURNEY.length;

/** A point `side` m to the left of the khal's middle (going up it), `s` m along it, `up` m above its water. */
function onKhal(s: number, side: number, up: number, out: Vector3): Vector3 {
  const p = khalAt(s);
  return out.set(p.x + Math.cos(p.heading) * side, KHAL_LEVEL + up, p.z - Math.sin(p.heading) * side);
}

/** How far along the khal a point is (m). */
const alongOf = (p: Vector3) => khalFrame(p.x, p.z)?.s ?? 0;

const tmpA = new Vector3();
const tmpB = new Vector3();

/** A point relative to the boat: `a` m ahead, `s` m to her starboard (+x), `h` m above the water. */
function rel(stage: Stage, a: number, s: number, h: number, out: Vector3): Vector3 {
  const c = stage.boatCourse;
  return out
    .copy(stage.boatPos)
    .addScaledVector(tmpA.set(Math.sin(c), 0, Math.cos(c)), a)
    .addScaledVector(tmpB.set(Math.cos(c), 0, -Math.sin(c)), s)
    .setY(KHAL_LEVEL + h);
}

/**
 * Where on the khal (m along it, from its start to its head) it runs most nearly toward `dir` turned `aside`
 * rad off it, so a camera behind a boat there, looking up the khal, has the sun or the moon in the frame off to
 * one side of her.
 */
function facing(dir: Vector3, aside: number): number {
  const bearing = Math.atan2(dir.x, dir.z);
  let best = 40;
  let err = Infinity;
  for (let s = 40; s < JOURNEY.head - 60; s += 4) {
    const h = khalAt(s).heading;
    const e = Math.min(Math.abs(angleDelta(h, bearing - aside)), Math.abs(angleDelta(h, bearing + aside)));
    // and the khal keeps on that way for a while, so the boat stays in the shot
    const on = Math.abs(angleDelta(h, khalAt(s + 30).heading));
    if (e + on < err) (err = e + on), (best = s);
  }
  return best;
}

/** How many buildings stand within `r` m of (x, z) (their footprints reaching in). */
function buildingsNear(x: number, z: number, r: number): number {
  let n = 0;
  for (let i = 0; i < BUILDINGS.count; i++) if (Math.hypot(BUILDINGS.x[i] - x, BUILDINGS.z[i] - z) < r + BUILDINGS.l[i] / 2) n++;
  return n;
}

/**
 * Where the paddy fields come down to the khal: within 400 m along it of `s0`, the bank (`s`, `side`) with the
 * most open plots (no trees over them) just beyond its levee, 12–70 m out, over 60 m of it, and the fewest
 * buildings round them (the film looks across them from the khal's water, the village's houses beyond).
 */
function fieldBank(s0: number): { s: number; side: 1 | -1 } {
  const at = (s: number, side: number, out: number) => {
    const p = khalAt(s);
    return { x: p.x + Math.cos(p.heading) * side * out, z: p.z - Math.sin(p.heading) * side * out };
  };
  let best = { score: -Infinity, s: s0, side: 1 as 1 | -1 };
  for (let s = Math.max(20, s0 - 400); s <= Math.min(JOURNEY.head - 60, s0 + 400); s += 10) {
    for (const side of [1, -1] as const) {
      let score = 0;
      for (const d of [0, 15, 30, 45, 60]) {
        for (let out = khalHalfWidth(s + d) + 12; out <= 70; out += 8) {
          const p = at(s + d, side, out);
          if (groundAt(p.x, p.z).zone > 0.85 && canopyAt(p.x, p.z).cover < 0.15) score++;
        }
      }
      const view = at(s + 40, side, 70);
      score -= 4 * buildingsNear(view.x, view.z, 90);
      if (score > best.score) best = { score, s, side };
    }
  }
  return best;
}

/** Low over the khal by the fields' bank, drifting up it and looking across the plots beyond the levee. */
function acrossFields(bank: { s: number; side: 1 | -1 }, height: number, u: number, pos: Vector3, look: Vector3): void {
  onKhal(bank.s + lerp(0, 18, u), -bank.side * 2, height, pos);
  onKhal(bank.s + 40, bank.side * (khalHalfWidth(bank.s + 40) + 35), 0.6, look);
}

// places found once, at load (deterministic)
/** The fields the film comes back to through the year: mustard in winter, the aman planted in the rains' water, ripe in Hemanta. */
const FIELDS = fieldBank(JOURNEY.bridge + 160);
/** A stretch of the khal's bank under trees (the satellites' canopy) for spring's blossom. */
const BLOSSOM = (() => {
  for (let s = JOURNEY.bridge + 60; s < JOURNEY.head - 60; s += 6) {
    for (const side of [1, -1] as const) {
      const p = khalAt(s);
      const out = khalHalfWidth(s) + 14;
      if (canopyAt(p.x + Math.cos(p.heading) * side * out, p.z - Math.sin(p.heading) * side * out).cover > 0.5) return { s, side };
    }
  }
  return { s: JOURNEY.bridge + 120, side: 1 as const };
})();
/** A village pond for a morning: the widest with lilies within 200 m of the khal; the bil if there is none. */
const POND = LILY_PONDS.filter((p) => (khalFrame(p.x, p.z)?.d ?? Infinity) < 200).sort((a, b) => b.r - a.r)[0] ?? { x: BIL.x, z: BIL.z, r: BIL.halfWid, level: BIL.level };

/** The film's scenes; `ghats` are the village's (world/village.ts planGhats). */
export function tourScenes(ghats: readonly Ghat[]): Scene[] {
  // per-scene choices made as each scene opens
  const a = new Vector3();
  const ghat = ghats[Math.min(1, ghats.length - 1)] ?? { s: JOURNEY.bridge + 90, side: 1 as const };
  const stormGhat = ghats[Math.min(2, ghats.length - 1)] ?? ghat;

  return [
    {
      caption: 'শীতের ভোর',
      seconds: 15,
      world: { day: 14, hour: { at: 'sunrise', offset: 0 }, weather: 'clear', wind: 0.2 },
      journey: journeyAt(40),
      begin: (s) => s.birds(s.boatPos, s.boatCourse + Math.PI),
      // down out of the sky over the misty khal onto the boat coming up it
      pose: (u, s, pos, look) => {
        onKhal(alongOf(s.boatPos) + lerp(70, 22, u), 0, lerp(30, 3.2, u), pos);
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
      pose: (u, _s, pos, look) => acrossFields(FIELDS, 2.6, u, pos, look),
    },
    {
      caption: 'গ্রামের ঘাট',
      seconds: 12,
      world: { day: 28, hour: 9.4, weather: 'clear', wind: 0.35 },
      // low on the khal gliding past a homestead's ghat, its steps down to the water
      pose: (u, _s, pos, look) => {
        onKhal(ghat.s + lerp(-30, -8, u), -ghat.side * 2.5, 1.9, pos);
        onKhal(ghat.s, ghat.side * (khalHalfWidth(ghat.s) + 6), 1.8, look);
      },
    },
    {
      caption: 'বসন্তের রং',
      seconds: 11,
      world: { day: 75, hour: 16.3, weather: 'clear', wind: 0.5 },
      // up the khal under its bank's trees in flower
      pose: (u, _s, pos, look) => {
        const s = lerp(BLOSSOM.s - 30, BLOSSOM.s - 5, u);
        onKhal(s, -BLOSSOM.side * 2, 2.2, pos);
        onKhal(s + 45, BLOSSOM.side * (khalHalfWidth(s + 45) + 10), 6, look);
      },
    },
    {
      caption: 'কালবৈশাখী',
      seconds: 12,
      world: { day: 128, hour: 16.0, weather: 'storm', wind: 2.6 },
      // the squall over the village: trees thrashing, rain driving across the khal
      pose: (u, _s, pos, look) => {
        onKhal(stormGhat.s + lerp(-34, -18, u), -stormGhat.side * 2, 2.4, pos);
        onKhal(stormGhat.s + 10, stormGhat.side * (khalHalfWidth(stormGhat.s) + 20), 6, look);
      },
    },
    {
      caption: 'বর্ষার খাল',
      seconds: 13,
      world: { day: 195, hour: 11.0, weather: 'rain', wind: null },
      journey: journeyAt(JOURNEY.bridge + 220),
      // ahead of the boat in the rain, low over the khal, as she comes on
      pose: (u, s, pos, look) => {
        rel(s, lerp(12, 6, u), lerp(-2.5, -1.5, u), 1.4, pos);
        rel(s, -1, 0, 1.2, look);
      },
    },
    {
      caption: 'ডুবো মাঠে আমন',
      seconds: 11,
      world: { day: 205, hour: 12.5, weather: 'drizzle', wind: 0.5 },
      pose: (u, _s, pos, look) => acrossFields(FIELDS, 3.4, u, pos, look),
    },
    {
      caption: 'সেতুর নিচে',
      seconds: 16,
      world: { day: 268, hour: { at: 'sunset', offset: -0.7 }, weather: 'clear', wind: 0.55 },
      journey: journeyAt(JOURNEY.bridge - 20),
      // low behind the boat as she goes under the old bridge, the girl with her umbrella above
      pose: (u, s, pos, look) => {
        const at = alongOf(s.boatPos);
        onKhal(at - lerp(12, 9, u), 0, lerp(1.9, 1.5, u), pos);
        onKhal(at + 10, 0, 2.2, look).lerp(rel(s, 0, 0, 1.3, a), 0.4);
      },
    },
    {
      caption: 'শাপলা বিল',
      seconds: 14,
      world: { day: 235, hour: 9.2, weather: 'clear', wind: 0.25 },
      // low over the lily rafts, drifting across the bil below the hills
      pose: (u, _s, pos, look) => {
        const p = bilPoint(lerp(-BIL.halfLen * 0.7, -BIL.halfLen * 0.4, u), -BIL.halfWid * 0.3);
        pos.set(p.x, BIL.level + lerp(5, 3.2, u), p.z);
        look.set(BIL.x, BIL.level + 0.2, BIL.z);
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
      // among the kash where it stands thickest on the bank, its plumes tossing, the boat coming up the khal
      begin: (s) => {
        const k = kashStand() ?? khalAt(JOURNEY.bridge + 100);
        a.set(k.x, terrainHeight(k.x, k.z) + 1.5, k.z);
        s.placeBoat(journeyAt(Math.max(0, (khalFrame(k.x, k.z)?.s ?? JOURNEY.bridge + 100) - 40)));
      },
      pose: (u, s, pos, look) => {
        pos.copy(a);
        pos.y += lerp(0, 0.3, u);
        rel(s, 0, 0, 1.0, look);
      },
    },
    {
      caption: 'হেমন্তের ধান',
      seconds: 12,
      world: { day: 318, hour: 15.4, weather: 'clear', wind: 0.5 },
      pose: (u, _s, pos, look) => acrossFields(FIELDS, 4.2, u, pos, look),
    },
    {
      caption: 'সূর্যাস্ত',
      seconds: 14,
      world: { day: 290, hour: { at: 'sunset', offset: -0.04 }, weather: 'clear', wind: 0.15 },
      // behind the boat paddling up the khal toward the low sun, off to one side of her
      begin: (s) => {
        s.placeBoat(journeyAt(facing(s.sunDir, 0.3)));
        s.birds(s.boatPos, s.boatCourse);
      },
      pose: (u, s, pos, look) => {
        onKhal(alongOf(s.boatPos) - lerp(19, 14, u), 0, 1.0, pos);
        rel(s, 0, 0, 1.2, look);
      },
    },
    {
      caption: 'চাঁদ ওঠা',
      seconds: 14,
      world: { day: 290, moon: 14.8, hour: { at: 'moonrise', offset: 0.35 }, weather: 'clear', wind: 0.15 },
      // out in the bil, where nothing stands between the boat and the rising moon: low behind her, the full moon
      // off to one side of her lantern
      journey: journeyAt(JOURNEY.head + 120),
      pose: (u, s, pos, look) => {
        const m = s.moonDir;
        const away = tmpA.set(m.x, 0, m.z).normalize();
        const aside = tmpB.set(away.z, 0, -away.x);
        pos.copy(s.boatPos).addScaledVector(away, -lerp(17, 12, u)).addScaledVector(aside, lerp(3, 1.5, u)).setY(KHAL_LEVEL + 1.3);
        const toBoat = a.subVectors(rel(s, 0, 0, 1.2, look), pos).normalize();
        look.copy(pos).addScaledVector(toBoat.lerp(m, 0.55).normalize(), 30);
      },
    },
    {
      caption: 'রাতের বিল',
      seconds: 15,
      world: { day: 290, moon: 14.8, hour: { at: 'moonrise', offset: 0.4 }, weather: 'clear', wind: 0.15 },
      // up and away from the lantern over the bil, the moon on the water
      pose: (u, s, pos, look) => {
        rel(s, lerp(-12, -50, u), lerp(0, 16, u * u), lerp(2.5, 30, u), pos);
        rel(s, lerp(3, 50, u), 0, 1, look);
      },
    },
  ];
}
