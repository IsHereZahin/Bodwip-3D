import { Vector3 } from 'three';
import { lerp, smoothstep } from '../core/mathx';
import { BIL, BRIDGE, JOURNEY, MOUNDS, SANKO, bankAt, bilPoint, bridgeToWorld, grandGhat, journeyAt, journeyFrame, saltPoint, shapePoint, terrainHeight, waterLevelAt } from '../world/geography';
import { sankoToWorld } from '../world/sites';
import { ghatPoint, type GhatSite } from '../world/ghatFlight';
import { BANYAN, CHAR, GRAVE_BANYAN, GRAVEYARD, HILLS, HUB_GHAT, KHEJUR_PATH, MOSQUE, SALT_FIELD, ZAMINDAR } from '../world/plan';
import { RAIL_LENGTH, TRAIN_SPEED, railAt } from '../world/railway';
import type { Scene } from './director';

// The places the map offers (ui/mapPanel.ts), each with its own short sequence of shots, played by the film's
// director in the viewer's own world (their season, hour and weather) and joined by its dissolves: the mosque
// seen first across its pond, then coming up the walk from its ghat as its dome rises; the zamindar house first
// from the river at the foot of its grand ghat, then up its walk to the house; the graveyard along its wall,
// then drawing back to its banyan with the mosque beyond; and so on, each as its place asks. The first shot
// puts the boat on her way short of the place by as much as the sequence lasts and a little more (at her own
// pace, and only under the sequence's first dissolve), so she has not passed it when the camera comes back to
// her: the viewer finds her coming up to it, and goes on with her.

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

/** A shot's even move that never comes to rest (the dissolves take it up and let it go moving). */
const ease = (u: number) => 0.2 * smoothstep(0, 1, u) + 0.8 * u;
/** The ground or the water under (x, z), whichever stands higher (m). */
const surface = (x: number, z: number) => {
  const w = waterLevelAt(x, z);
  const g = terrainHeight(x, z);
  return Number.isFinite(w) ? Math.max(g, w) : g;
};
/** A point `up` m over the ground or water at (x, z), into `out`. */
const over = (x: number, z: number, up: number, out: Vector3) => out.set(x, surface(x, z) + up, z);

/**
 * A shot gliding from (`p0`) to (`p1`), each `up` m over the ground or the water beneath it at that moment (so a
 * low shot over the water rides the season's level), looking from `l0` to `l1` (heights over the ground there).
 */
function glide(caption: string, seconds: number, p0: [number, number, number], p1: [number, number, number], l0: [number, number, number], l1: [number, number, number]): Scene {
  return {
    caption,
    seconds,
    pose: (u, _s, pos, look) => {
      const k = ease(u);
      const x = lerp(p0[0], p1[0], k);
      const z = lerp(p0[2], p1[2], k);
      over(x, z, lerp(p0[1], p1[1], k), pos);
      const lx = lerp(l0[0], l1[0], k);
      const lz = lerp(l0[2], l1[2], k);
      over(lx, lz, lerp(l0[1], l1[1], k), look);
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
 * A place: its shots, the first putting the boat where she will still be short of it when they end (of `sync`,
 * the part of it on her way her shots show from the water: the zamindar's ghat, not its house set back).
 */
function spot(id: string, name: string, note: string, icon: SpotIcon, group: SpotGroup, at: { x: number; z: number }, shots: Scene[], sync = at): Spot {
  const seconds = shots.reduce((t, s) => t + s.seconds, 0) + BACK;
  const s = nearestOnWay(sync.x, sync.z);
  shots[0].caption = name;
  shots[0].journey = Math.max(0, s - (seconds + LEAD) * CRUISE) / JOURNEY.length;
  for (const shot of shots.slice(1)) shot.caption = '';
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
export function mapSpots(): Spot[] {
  const spots: Spot[] = [];

  // the salt farms, where she sets out: along a bund between the beds at a man's eye, then up over all of them
  spots.push(
    spot('salt', 'লবণ মাঠ', 'নদীর দক্ষিণ পাড়ে কয়েকটি লবণ মাঠ: শুকনো মাসে লবণ তোলা, বর্ষায় মাছের ঘের', 'salt', 'fields', saltPoint(SALT_FIELD.w / 2, SALT_FIELD.d / 2), [
      glide('', 11, fp(50, 24.5, 1.75), fp(70, 26, 1.7), fp(92, 30, 0.6), fp(96, 34, 0.7)),
      glide('', 11, fp(40, -8, 3), fp(30, -26, 22), fp(48, 30, 0), fp(52, 40, 0)),
    ]),
  );

  // the hill over the river where she sets out: from over the river a way on down it, looking back up it,
  // rising as a kite rises, the hill standing whole over its bank and the river under it (it lines her way's
  // first few hundred metres: from beside it, it is a wall)
  {
    const h = HILLS[0];
    const s = nearestOnWay(h.x, h.z);
    const p0 = journeyAt(Math.min(JOURNEY.length, s + 330));
    const p1 = journeyAt(Math.min(JOURNEY.length, s + 270));
    spots.push(
      spot('hill', 'নদীর ধারের পাহাড়', 'নদীর গা ঘেঁষে খাড়া বনঢাকা টিলা', 'hill', 'river', h, [
        glide('', 14, [p0.x, 5, p0.z], [p1.x, 24, p1.z], [h.x, 26, h.z], [h.x, 20, h.z]),
      ]),
    );
  }

  // the kash char: low among its plumes looking across the river to the zamindar house, then up over the char
  spots.push(
    spot('kash', 'চরের কাশবন', 'নদীর বাঁকের বালুচরে কাশবন, শরতে সাদা', 'kash', 'river', CHAR, [
      glide('', 11, [-470, 1.3, 112], [-458, 1.4, 124], [-446, 4, 232], [-444, 5, 232]),
      glide('', 10, [-460, 2, 122], [-472, 14, 102], [-452, 0, 165], [-450, 0, 172]),
    ]),
  );

  // the zamindar house: first from the river at the foot of its grand ghat, looking up its steps to the pavilions;
  // then up its walk from the landing, rising to the house's front
  {
    const gg = grandGhat();
    if (gg) {
      const site = gg.site;
      const mound = MOUNDS.find((m) => m.id === 'zamindar');
      const house = mound ? shapePoint(mound, 11.2, 0) : ZAMINDAR;
      spots.push(
        spot('zamindar', 'জমিদারবাড়ি', 'পুরোনো জমিদারবাড়ি, নদীতে নেমে যাওয়া বড় ঘাট আর দুই চাঁদনি', 'manor', 'river', ZAMINDAR, [
          glide('', 11, gp(site, -22, -6, 1.3), gp(site, -9, -1.5, 1.1), gp(site, 8, 0, 1.6), gp(site, 10, 0, 2.6)),
          glide('', 12, gp(site, 12.5, 1, 1.8), [-449.6, 4.5, 213.1], [house.x, 5, house.z], [house.x, 9.5, house.z]),
        ], site),
      );
    }
  }

  // the village's ghat below the banyan: from the water up its steps, then under the banyan's crown round its trunk
  {
    const b = bankAt(HUB_GHAT[0], HUB_GHAT[1]);
    if (b) {
      const site: GhatSite = { x: b.x, z: b.z, up: b.up };
      spots.push(
        spot('ghat', 'বটতলার ঘাট', 'গ্রামের ঘাট, পাশে বুড়ো বটগাছ আর চায়ের দোকান', 'ghat', 'village', BANYAN, [
          glide('', 10, gp(site, -18, 5, 1.4), gp(site, -8, 1.5, 1.2), gp(site, 9, 0, 2), gp(site, 12, 0, 3)),
          {
            caption: '',
            seconds: 11,
            // round the old tree from just outside its crown, its roots hanging to the ground, its platform
            pose: (u, _s, pos, look) => {
              const a = 2.3 + ease(u) * 0.8;
              over(BANYAN.x + Math.sin(a) * 23, BANYAN.z + Math.cos(a) * 23, 2.4 + 1.2 * u, pos);
              over(BANYAN.x, BANYAN.z, 5 + 1.5 * u, look);
            },
          },
        ]),
      );
    }
  }

  // the old bridge: low on the khal coming up to its arch, then from the bank to see its hump whole
  spots.push(
    spot('bridge', 'পুরোনো সেতু', 'খালের ওপর জমিদারদের বানানো পুরোনো ইটের খিলান', 'bridge', 'river', BRIDGE, [
      glide('', 10, bp(0.5, -42, 1.2), bp(0.3, -17, 1.0), bp(0, 0, 3), bp(0, 4, 3)),
      glide('', 10, bp(-24, 16, 2.2), bp(-18, 23, 2.6), bp(0, 0, 2.5), bp(2, 0, 2.5)),
    ]),
  );

  // the mosque: first over its kept pond, its front across the water; then up the walk from its ghat as the
  // dome and the minaret rise
  {
    const front = MOSQUE.x - 6;
    spots.push(
      spot('mosque', 'মসজিদ', 'গ্রামের সাদা মসজিদ, সামনে তার পরিষ্কার পুকুর আর বাঁধানো ঘাট', 'mosque', 'village', MOSQUE, [
        glide('', 11, [88, 1.0, 207], [104, 1.3, 211], [front, 4, MOSQUE.z], [front, 5, MOSQUE.z]),
        glide('', 11, [120, 1.7, 212.5], [136, 5.5, 210.5], [front + 2, 5, MOSQUE.z], [MOSQUE.x + 2, 9.5, MOSQUE.z]),
      ]),
    );
  }

  // the graveyard: along its low wall, the graves inside under the henna, then back and up to its banyan with the
  // mosque beyond
  spots.push(
    spot('graves', 'কবরস্থান', 'মসজিদের পাশে মেহেদি গাছের ছায়ায় পুরোনো কবরস্থান আর বটগাছ', 'grave', 'village', GRAVEYARD, [
      glide('', 11, [GRAVEYARD.x - 15, 1.5, GRAVEYARD.z - 10], [GRAVEYARD.x - 15, 1.6, GRAVEYARD.z + 7], [GRAVE_BANYAN.x, 4, GRAVE_BANYAN.z], [GRAVE_BANYAN.x, 6, GRAVE_BANYAN.z + 4]),
      glide('', 11, [150, 2, 146], [146, 10, 138], [160, 2, 176], [158, 4, 186]),
    ]),
  );

  // the bamboo sanko: low on the side khal coming up under it, then from the bank to see it climb over the water
  spots.push(
    spot('sanko', 'বাঁশের সাঁকো', 'শাখা খালের ওপর উঁচু বাঁশের সাঁকো, নৌকা যায় নিচ দিয়ে', 'sanko', 'river', SANKO, [
      glide('', 10, sp(0.2, -34, 1.1), sp(0.1, -12, 1.0), sp(0, 0, 3.4), sp(0, 3, 3.6)),
      glide('', 10, sp(-19, 9, 2.4), sp(-15, 4, 2.8), sp(0, 0, 2.6), sp(1, 0, 2.6)),
    ]),
  );

  // the date palms along the field path: beside its row at a walker's height, from across the path, their pots on the cut in winter
  {
    const [p0, p1] = [KHEJUR_PATH[1], KHEJUR_PATH[3]];
    spots.push(
      spot('palms', 'খেজুর গাছের সারি', 'মাঠের পথের ধারে খেজুর গাছ, শীতে রসের হাঁড়ি', 'palm', 'fields', { x: (p0[0] + p1[0]) / 2, z: (p0[1] + p1[1]) / 2 }, [
        glide('', 12, [p0[0] + 8, 1.8, p0[1]], [p1[0] + 8, 2.1, p1[1]], [p1[0] - 2.6, 4.5, p1[1] + 10], [KHEJUR_PATH[4][0] - 2.6, 5, KHEJUR_PATH[4][1] + 4]),
      ]),
    );
  }

  // the railway: beside the line in the fields as the intercity comes by
  {
    let at = 0;
    for (let s = 0; s <= RAIL_LENGTH; s += 4) if (Math.abs(railAt(s).x - 330) < Math.abs(railAt(at).x - 330)) at = s;
    const line = railAt(at);
    const south = new Vector3(Math.cos(line.heading), 0, -Math.sin(line.heading));
    const west = new Vector3(Math.sin(line.heading), 0, Math.cos(line.heading));
    const from = at - TRAIN_SPEED * 6;
    const seconds = 15;
    const train: Scene = {
      caption: '',
      seconds,
      begin: (s, t) => s.train(from + TRAIN_SPEED * t, true),
      pose: (u, _s, pos, look) => {
        const t = u * seconds;
        const x = line.x + south.x * 26 + west.x * lerp(-6, 10, ease(u));
        const z = line.z + south.z * 26 + west.z * lerp(-6, 10, ease(u));
        over(x, z, 1.7, pos);
        const r = railAt(Math.max(at - 120, Math.min(at + 160, from + TRAIN_SPEED * t - 30)));
        over(r.x, r.z, 2.4, look);
      },
    };
    spots.push(spot('rail', 'রেললাইন', 'বিলের উত্তরে বাঁধের ওপর রেললাইন, আন্তঃনগর ট্রেন', 'train', 'fields', line, [train]));
  }

  // the shapla bil: low over the lilies, then rising over the whole of it
  spots.push(
    spot('bil', 'শাপলা বিল', 'যাত্রার শেষে শাপলা আর পদ্মে ভরা বিল', 'lily', 'river', BIL, [
      glide('', 11, lp(-120, -30, 0.9), lp(-82, -22, 0.9), lp(-20, -15, 1.4), lp(0, -12, 1.4)),
      glide('', 11, lp(-70, -20, 2), lp(-60, -32, 16), lp(20, 10, 0), lp(40, 14, 0)),
    ]),
  );

  return spots;
}
