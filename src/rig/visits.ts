import { Vector3 } from 'three';
import { lerp, smoothstep } from '../core/mathx';
import { BIL, BRIDGE, CREEK_GATE, JOURNEY, MOUNDS, SALT_CREEK, SANKO, bankAt, bilPoint, bridgeToWorld, grandGhat, journeyAt, journeyFrame, saltPoint, shapePoint, terrainHeight } from '../world/geography';
import { sankoToWorld } from '../world/sites';
import { ghatPoint, type GhatSite } from '../world/ghatFlight';
import { BANYAN, CHAR, GRAVE_BANYAN, GRAVEYARD, HILLS, HUB_GHAT, KHEJUR_PATH, MOSQUE, SALT_FIELD, ZAMINDAR } from '../world/plan';
import { RAIL_LENGTH, TRAIN_SPEED, railAt } from '../world/railway';
import type { Scene } from './director';
import type { Sightlines } from './sightlines';
import { surfaceAt, vantages, type Place, type Vantage } from './vantage';

// The places the map offers (ui/mapPanel.ts), each with its own short sequence of shots, played by the film's
// director in the viewer's own world (their season, hour and weather) and joined by its dissolves: the mosque
// seen first across its pond, then coming up the walk from its ghat as its dome rises; the zamindar house first
// from the river at the foot of its grand ghat, then up its walk to the house; the graveyard along its wall,
// then drawing back to its banyan with the mosque beyond; and so on, each as its place asks. Round those, two or
// three wide views of the place with the village round it, found for each place by itself (vantage.ts): the
// user asked (2026-10-07) for more views, quicker, and none too close. The first shot puts the boat on her way
// short of the place by as much as the sequence lasts and a little more (at her own pace, and only under the
// sequence's first dissolve), so she has not passed it when the camera comes back to her: the viewer finds her
// coming up to it, and goes on with her.

export type SpotIcon = 'mosque' | 'grave' | 'manor' | 'ghat' | 'bridge' | 'sanko' | 'lily' | 'kash' | 'salt' | 'hill' | 'train' | 'palm';
/** Where a place is: on the boat's way, in the village, out in the fields. */
export type SpotGroup = 'river' | 'village' | 'fields';

export interface Spot {
  id: string;
  name: string;
  /** A line about it, for the map. */
  note: string;
  icon: SpotIcon;
  group: SpotGroup;
  /** Where its marker stands on the map (world). */
  x: number;
  z: number;
  /** Its shots, the first with the boat's place (`journey`). */
  shots: Scene[];
}

/** The boat's usual way (m/s), and the seconds she is still short of the place as the camera comes back to her. */
const CRUISE = 1.2;
const LEAD = 12;
/** The dissolve back to the viewer's view (director.ts DISSOLVE). */
const BACK = 2.2;
/** A designed shot's length (s), a wide view's (s), and how long each shot after the first dissolves in over the one before (s). */
const SHOT = 7;
const VIEW = 6.5;
const CUT = 1.2;
/** A wide view's move: round the place (rad), in toward it (share of its distance), and up (m). */
const VIEW_TURN = 0.11;
const VIEW_IN = 0.06;
const VIEW_RISE = 1.2;

/** A shot's even move that never comes to rest (the dissolves take it up and let it go moving). */
const ease = (u: number) => 0.2 * smoothstep(0, 1, u) + 0.8 * u;
/** A point `up` m over the ground or water at (x, z), into `out`. */
const over = (x: number, z: number, up: number, out: Vector3) => out.set(x, surfaceAt(x, z) + up, z);

/**
 * A shot gliding from (`p0`) to (`p1`), each `up` m over the ground or the water beneath it at that moment (so a
 * low shot over the water rides the season's level), looking from `l0` to `l1` (heights over the ground there).
 */
function glide(seconds: number, p0: [number, number, number], p1: [number, number, number], l0: [number, number, number], l1: [number, number, number]): Scene {
  return {
    caption: '',
    seconds,
    pose: (u, _s, pos, look) => {
      const k = ease(u);
      over(lerp(p0[0], p1[0], k), lerp(p0[2], p1[2], k), lerp(p0[1], p1[1], k), pos);
      over(lerp(l0[0], l1[0], k), lerp(l0[2], l1[2], k), lerp(l0[1], l1[1], k), look);
    },
  };
}

/** The boat's way's nearest point to (x, z) (m along it). */
function nearestOnWay(x: number, z: number): number {
  const f = journeyFrame(x, z);
  if (f && f.d < 60) return f.s;
  let best = 0;
  let bd = Infinity;
  for (let s = 0; s <= JOURNEY.length; s += 5) {
    const p = journeyAt(s);
    const d = (p.x - x) ** 2 + (p.z - z) ** 2;
    if (d < bd) (bd = d), (best = s);
  }
  return best;
}

/**
 * The wide views of `place`, found the first time one is posed (a place's few take a few tens of ms; the map's
 * twelve at load would hold the loading up): `count` of them, the best first.
 */
function viewsOf(place: Place, lines: Sightlines, count: number): () => Vantage[] {
  let found: Vantage[] | null = null;
  return () => (found ??= vantages(place, lines, count));
}

/**
 * The `i`th wide view of `place`: a slow arc round it (`turn`'s way), a little nearer and higher as it goes, looking
 * at its middle. Should fewer views have been found, an earlier one from its other side of the arc; should none,
 * from high over it.
 */
function viewShot(place: Place, views: () => Vantage[], i: number, turn: number, lines: Sightlines): Scene {
  const look: [number, number, number] = [place.x, terrainHeight(place.x, place.z) + place.up * 0.8 - surfaceAt(place.x, place.z), place.z];
  let path: { a: [number, number, number]; b: [number, number, number] } | null = null;
  const lay = (): { a: [number, number, number]; b: [number, number, number] } => {
    const found = views();
    const v = found.length ? found[i % found.length] : { x: place.x, z: place.z - 60, high: 25, bearing: Math.PI, dist: 60, score: 0 };
    const t = found.length > i ? turn : -turn;
    const a = v.bearing + t;
    const r = v.dist * (1 - VIEW_IN);
    const x = place.x + Math.sin(a) * r;
    const z = place.z + Math.cos(a) * r;
    // (where the end of the arc would stand among the trees, it only draws in)
    const ends = lines.standsClear(x, surfaceAt(x, z) + v.high + VIEW_RISE, z);
    return { a: [v.x, v.high, v.z], b: ends ? [x, v.high + VIEW_RISE, z] : [lerp(v.x, place.x, VIEW_IN), v.high + VIEW_RISE, lerp(v.z, place.z, VIEW_IN)] };
  };
  return {
    caption: '',
    seconds: VIEW,
    pose: (u, _s, pos, out) => {
      const { a, b } = (path ??= lay());
      const k = ease(u);
      over(lerp(a[0], b[0], k), lerp(a[2], b[2], k), lerp(a[1], b[1], k), pos);
      over(look[0], look[2], look[1], out);
    },
  };
}

/**
 * A place: its own shots with wide views of it round them (`before` of them first, `after` last), the first
 * putting the boat where she will still be short of it when they end (of `sync`, the part of it on her way her
 * shots show from the water: the zamindar's ghat, not its house set back).
 */
function spot(
  id: string,
  name: string,
  note: string,
  icon: SpotIcon,
  group: SpotGroup,
  at: { x: number; z: number },
  place: Place,
  own: Scene[],
  lines: Sightlines,
  sync: { x: number; z: number } = at,
  before = 1,
  after = 2,
): Spot {
  const views = viewsOf(place, lines, before + after);
  const shots = [...Array.from({ length: before }, (_, i) => viewShot(place, views, i, VIEW_TURN, lines)), ...own, ...Array.from({ length: after }, (_, i) => viewShot(place, views, before + i, i % 2 ? VIEW_TURN : -VIEW_TURN, lines))];
  const seconds = shots.reduce((t, s) => t + s.seconds, 0) + BACK;
  const s = nearestOnWay(sync.x, sync.z);
  shots.forEach((shot, i) => {
    shot.caption = i === 0 ? name : '';
    if (i > 0) shot.dissolve = CUT;
  });
  shots[0].journey = Math.max(0, s - (seconds + LEAD) * CRUISE) / JOURNEY.length;
  return { id, name, note, icon, group, x: at.x, z: at.z, shots };
}

/** A point of a ghat's frame as [x, up, z]. */
const gp = (g: GhatSite, d: number, s: number, up: number): [number, number, number] => {
  const p = ghatPoint(g, d, s);
  return [p.x, up, p.z];
};
/** A point of the bridge's (or the sanko's) frame as [x, up, z]: `across` it, `along` the water under it. */
const bp = (across: number, along: number, up: number): [number, number, number] => {
  const p = bridgeToWorld(across, along);
  return [p.x, up, p.z];
};
const sp = (across: number, along: number, up: number): [number, number, number] => {
  const p = sankoToWorld(across, along);
  return [p.x, up, p.z];
};
const lp = (a: number, c: number, up: number): [number, number, number] => {
  const p = bilPoint(a, c);
  return [p.x, up, p.z];
};
const fp = (u: number, v: number, up: number): [number, number, number] => {
  const p = saltPoint(u, v);
  return [p.x, up, p.z];
};

/** The places the map offers, each with its own shots, in the order of the boat's journey. */
export function mapSpots(lines: Sightlines): Spot[] {
  const spots: Spot[] = [];

  // the salt farms, where she sets out, and their water: from high over the river, its sluice gate, the creek
  // coming up past the farms and the farms behind their embankments, all one water; along a bund between the
  // beds; up over all of them; and beside the creek, its golpata, the farms' intakes, on to the gate and the river
  {
    const c = saltPoint(SALT_FIELD.w / 2, SALT_FIELD.d / 2);
    // the gate's way out to the river (north), and across it toward the creek's farm (west)
    const out = { x: Math.sin(CREEK_GATE.heading), z: Math.cos(CREEK_GATE.heading) };
    const west = { x: out.z, z: -out.x };
    const fromGate = (ahead: number, aside: number, up: number): [number, number, number] => [CREEK_GATE.x + out.x * ahead + west.x * aside, up, CREEK_GATE.z + out.z * ahead + west.z * aside];
    // `back` m up the creek from the gate, `aside` m off its middle toward the creek's farm (clear of its golpata)
    const onCreek = (back: number, up: number, aside = 0): [number, number, number] => {
      const p = SALT_CREEK.beside(CREEK_GATE.s - back, 1, aside);
      return [p.x, up, p.z];
    };
    spots.push(
      spot(
        'salt',
        'লবণ মাঠ',
        'নদীর দক্ষিণ পাড়ে লবণ মাঠ, খাঁড়ি দিয়ে নদীর সাথে জোড়া: শুকনো মাসে লবণ তোলা, বর্ষায় মাছের ঘের',
        'salt',
        'fields',
        c,
        { x: c.x, z: c.z, up: 0.5, size: Math.max(SALT_FIELD.w, SALT_FIELD.d) / 2 },
        [
          glide(SHOT, fromGate(78, 34, 30), fromGate(64, 22, 36), fp(10, 30, 0), fp(20, 30, 0)),
          glide(SHOT, fp(40, 24.5, 3.5), fp(60, 26, 3.6), fp(92, 30, 0.6), fp(96, 34, 0.7)),
          glide(SHOT, fp(40, -8, 5), fp(32, -24, 20), fp(48, 30, 0), fp(52, 40, 0)),
          glide(SHOT, onCreek(165, 14, 20), onCreek(125, 12, 17), onCreek(40, 0.5), fromGate(25, 0, 1)),
        ],
        lines,
        c,
        0,
        0,
      ),
    );
  }

  // the hill over the river where she sets out: from over the river a way on down it, looking back up it,
  // rising as a kite rises, the hill standing whole over its bank and the river under it (it lines her way's
  // first few hundred metres: from beside it, it is a wall)
  {
    const h = HILLS[0];
    const s = nearestOnWay(h.x, h.z);
    const p0 = journeyAt(Math.min(JOURNEY.length, s + 330));
    const p1 = journeyAt(Math.min(JOURNEY.length, s + 290));
    const q0 = journeyAt(Math.min(JOURNEY.length, s + 520));
    const q1 = journeyAt(Math.min(JOURNEY.length, s + 470));
    // (it is too big for views found round it within the land the village keeps: they all stood under it, a wall of
    // trees; its own shots are from down the river, the river leading to it, and from farther and higher)
    spots.push(
      spot('hill', 'নদীর ধারের পাহাড়', 'নদীর গা ঘেঁষে খাড়া বনঢাকা টিলা', 'hill', 'river', h, { x: h.x, z: h.z, up: h.h * 0.45, size: Math.min(h.r * 0.5, 70) }, [
        glide(8, [p0.x, 6, p0.z], [p1.x, 24, p1.z], [h.x, 26, h.z], [h.x, 20, h.z]),
        glide(SHOT, [q0.x, 30, q0.z], [q1.x, 34, q1.z], [h.x, 30, h.z], [h.x, 28, h.z]),
      ], lines, h, 0, 0),
    );
  }

  // the kash char: over its plumes looking across the river to the zamindar house, then up over the char
  spots.push(
    spot('kash', 'চরের কাশবন', 'নদীর বাঁকের বালুচরে কাশবন, শরতে সাদা', 'kash', 'river', CHAR, { x: CHAR.x, z: CHAR.z, up: 1.5, size: 40 }, [
      glide(SHOT, [-474, 3, 108], [-464, 3.4, 118], [-446, 4, 232], [-444, 5, 232]),
      glide(SHOT, [-462, 4, 120], [-474, 15, 100], [-452, 0, 165], [-450, 0, 172]),
    ], lines),
  );

  // the zamindar house: first from the river off the foot of its grand ghat, looking up its steps to the pavilions
  // and the house; then up over its landing, rising to see the house's front with its lawn
  {
    const gg = grandGhat();
    if (gg) {
      const site = gg.site;
      const mound = MOUNDS.find((m) => m.id === 'zamindar');
      const house = mound ? shapePoint(mound, 11.2, 0) : ZAMINDAR;
      const mid = { x: (house.x + gg.round.x) / 2, z: (house.z + gg.round.z) / 2 };
      spots.push(
        spot('zamindar', 'জমিদারবাড়ি', 'পুরোনো জমিদারবাড়ি, নদীতে নেমে যাওয়া বড় ঘাট আর দুই চাঁদনি', 'manor', 'river', ZAMINDAR, { x: mid.x, z: mid.z, up: 5, size: Math.hypot(house.x - gg.round.x, house.z - gg.round.z) / 2 + 12 }, [
          glide(SHOT, gp(site, -40, -9, 2.6), gp(site, -27, -3, 3), gp(site, 8, 0, 2), gp(site, 12, 0, 3.4)),
          glide(SHOT, gp(site, -2, 2, 5), gp(site, 6, 0, 10), [house.x, 5, house.z], [house.x, 7.5, house.z]),
        ], lines, site),
      );
    }
  }

  // the village's ghat below the banyan: from the water up its steps, then round the banyan from outside its crown
  {
    const b = bankAt(HUB_GHAT[0], HUB_GHAT[1]);
    if (b) {
      const site: GhatSite = { x: b.x, z: b.z, up: b.up };
      spots.push(
        spot('ghat', 'বটতলার ঘাট', 'গ্রামের ঘাট, পাশে বুড়ো বটগাছ আর চায়ের দোকান', 'ghat', 'village', BANYAN, { x: BANYAN.x, z: BANYAN.z, up: 8, size: 18 }, [
          glide(SHOT, gp(site, -32, 7, 2.6), gp(site, -21, 3, 2.8), gp(site, 9, 0, 2.5), gp(site, 12, 0, 3.5)),
          {
            caption: '',
            seconds: SHOT,
            // round the old tree from outside its crown, its roots hanging to the ground, its platform
            pose: (u, _s, pos, look) => {
              const a = 2.3 + ease(u) * 0.6;
              over(BANYAN.x + Math.sin(a) * 31, BANYAN.z + Math.cos(a) * 31, 4 + 2 * u, pos);
              over(BANYAN.x, BANYAN.z, 5.5 + 1.5 * u, look);
            },
          },
        ], lines),
      );
    }
  }

  // the old bridge: on the khal coming up to its arch, then from the bank to see its hump whole
  spots.push(
    // (its banks are thick with trees: the views from them are found among the trees, not set)
    spot('bridge', 'পুরোনো সেতু', 'খালের ওপর জমিদারদের বানানো পুরোনো ইটের খিলান', 'bridge', 'river', BRIDGE, { x: BRIDGE.x, z: BRIDGE.z, up: 2.6, size: 14 }, [
      glide(SHOT, bp(0.5, -58, 2.2), bp(0.3, -36, 2), bp(0, 0, 3), bp(0, 4, 3)),
    ], lines, BRIDGE, 1, 1),
  );

  // the mosque: first over its kept pond, its front across the water; then from the pond's ghat up its walk, rising
  // as the dome and the minaret come up over the trees
  {
    const front = MOSQUE.x - 6;
    spots.push(
      spot('mosque', 'মসজিদ', 'গ্রামের সাদা মসজিদ, সামনে তার পরিষ্কার পুকুর আর বাঁধানো ঘাট', 'mosque', 'village', MOSQUE, { x: MOSQUE.x, z: MOSQUE.z, up: 6, size: 16 }, [
        glide(SHOT, [86, 2.4, 207], [100, 2.8, 210], [front, 4, MOSQUE.z], [front, 5, MOSQUE.z]),
        glide(SHOT, [110, 3.2, 212.5], [122, 9, 211], [front + 2, 5, MOSQUE.z], [MOSQUE.x + 2, 9, MOSQUE.z]),
      ], lines, MOSQUE, 1, 1),
    );
  }

  // the graveyard: along its low wall, the graves inside under the henna, then back and up to its banyan with the
  // mosque beyond
  spots.push(
    spot('graves', 'কবরস্থান', 'মসজিদের পাশে মেহেদি গাছের ছায়ায় পুরোনো কবরস্থান আর বটগাছ', 'grave', 'village', GRAVEYARD, { x: GRAVEYARD.x + 8, z: GRAVEYARD.z, up: 3, size: 18 }, [
      glide(SHOT, [GRAVEYARD.x - 20, 2.6, GRAVEYARD.z - 12], [GRAVEYARD.x - 20, 3, GRAVEYARD.z + 6], [GRAVE_BANYAN.x, 4, GRAVE_BANYAN.z], [GRAVE_BANYAN.x, 6, GRAVE_BANYAN.z + 4]),
      glide(SHOT, [150, 3, 144], [146, 11, 136], [160, 2, 176], [158, 4, 186]),
    ], lines),
  );

  // the bamboo sanko: on the side khal coming up under it, then from the bank to see it climb over the water
  spots.push(
    // (its bamboo is thin: its views stand nearer than its length would have them)
    spot('sanko', 'বাঁশের সাঁকো', 'শাখা খালের ওপর উঁচু বাঁশের সাঁকো, নৌকা যায় নিচ দিয়ে', 'sanko', 'river', SANKO, { x: SANKO.x, z: SANKO.z, up: 2.6, size: 6 }, [
      glide(SHOT, sp(0.2, -48, 2), sp(0.1, -28, 1.8), sp(0, 0, 3.4), sp(0, 3, 3.6)),
      glide(SHOT, sp(-24, 12, 4), sp(-19, 6, 4.4), sp(0, 0, 2.6), sp(1, 0, 2.6)),
    ], lines),
  );

  // the date palms along the field path: beside its row, from across the path, their pots on the cut in winter
  {
    const [p0, p1] = [KHEJUR_PATH[1], KHEJUR_PATH[3]];
    const mid = { x: (p0[0] + p1[0]) / 2, z: (p0[1] + p1[1]) / 2 };
    spots.push(
      spot('palms', 'খেজুর গাছের সারি', 'মাঠের পথের ধারে খেজুর গাছ, শীতে রসের হাঁড়ি', 'palm', 'fields', mid, { x: mid.x, z: mid.z, up: 4, size: 24 }, [
        glide(8, [p0[0] + 10, 3, p0[1]], [p1[0] + 10, 3.4, p1[1]], [p1[0] - 2.6, 4.5, p1[1] + 10], [KHEJUR_PATH[4][0] - 2.6, 5, KHEJUR_PATH[4][1] + 4]),
      ], lines, mid, 1, 3),
    );
  }

  // the railway: beside the line in the fields as the intercity comes by
  {
    let at = 0;
    for (let s = 0; s <= RAIL_LENGTH; s += 4) if (Math.abs(railAt(s).x - 330) < Math.abs(railAt(at).x - 330)) at = s;
    const line = railAt(at);
    const south = new Vector3(Math.cos(line.heading), 0, -Math.sin(line.heading));
    const west = new Vector3(Math.sin(line.heading), 0, Math.cos(line.heading));
    const from = at - TRAIN_SPEED * 5;
    const seconds = 12;
    const train: Scene = {
      caption: '',
      seconds,
      begin: (s, t) => s.train(from + TRAIN_SPEED * t, true),
      pose: (u, _s, pos, look) => {
        const t = u * seconds;
        const x = line.x + south.x * 32 + west.x * lerp(-6, 10, ease(u));
        const z = line.z + south.z * 32 + west.z * lerp(-6, 10, ease(u));
        over(x, z, 3, pos);
        const r = railAt(Math.max(at - 120, Math.min(at + 160, from + TRAIN_SPEED * t - 30)));
        over(r.x, r.z, 2.4, look);
      },
    };
    // (the train's own shot first, then one wide view as it runs on into the distance: more would show the fields empty)
    spots.push(spot('rail', 'রেললাইন', 'বিলের উত্তরে বাঁধের ওপর রেললাইন, আন্তঃনগর ট্রেন', 'train', 'fields', line, { x: line.x, z: line.z, up: 3, size: 30 }, [train], lines, line, 0, 1));
  }

  // the shapla bil: low over the lilies, then rising over the whole of it
  spots.push(
    spot('bil', 'শাপলা বিল', 'যাত্রার শেষে শাপলা আর পদ্মে ভরা বিল', 'lily', 'river', BIL, { x: BIL.x, z: BIL.z, up: 0.5, size: 110 }, [
      glide(SHOT, lp(-130, -32, 1.8), lp(-96, -24, 2), lp(-20, -15, 1.4), lp(0, -12, 1.4)),
      glide(SHOT, lp(-70, -20, 3), lp(-60, -32, 18), lp(20, 10, 0), lp(40, 14, 0)),
    ], lines),
  );

  return spots;
}
