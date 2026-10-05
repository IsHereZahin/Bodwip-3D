// The village as it was designed: one art-directed Bengali village round a small river, laid out by hand
// so that every part has its reason and every view from the boat is composed (the user's cinematic village,
// 2026-10-05: "beautiful rural Bangladesh + cinematic art direction + realistic environmental logic").
//
// The boat comes down the small river from the east into the evening light. On the outer bank of its one
// broad bend stands the old zamindar house over its bathing ghat, the kash char opposite on the bend's sandy
// inner side; homesteads line the north bank behind the riverside path. Where the khal leaves the river
// northward an old banyan shades the village's ghat and its tea stall, and the village road, brick on its
// embankment, turns from the river up the khal's bank to the old brick bridge (the zamindar's), crosses, and
// goes on west past the mosque and its pond. The boat turns up the khal, under the bridge, past a side khal
// with its bamboo sanko, into the shapla bil. Fields lie round all of it, and the far villages' groves close
// every horizon.
//
// Everything here is plain data in world metres (x west, z north, y up; env/astro.ts relies on the frame).
// The waterways are smoothed through their control points (world/waterways.ts); the ground is built from the
// rest (world/geography.ts). Nothing here is measured: it is all [নকশা].

/** A point on the ground (world m). */
export type Pt = readonly [number, number];

/** The designed area (world m): x from X0 (east) to X1 (west), z from Z0 (south) to Z1 (north). Beyond it the land fades into the haze. */
export const WORLD = { x0: -1500, x1: 1500, z0: -950, z1: 1400 } as const;

// ---------- levels ----------

/** The river, the khal and the bil stand at one level (m): they are one water. */
export const WATER_LEVEL = 1.0;
/** The fields' level (m): the land stands this high over the water in the months the boat goes out. */
export const PLAIN = WATER_LEVEL + 1.4;
/** A homestead's mound (ভিটা) stands this far above the fields, out of the rains' floods (m). */
export const MOUND = 1.0;
/** The brick road's crest above the fields (m): an embankment, as village roads are. */
export const ROAD_RAISE = 0.7;
/** The ponds' water, a little above the river's (m): fed by the rain and the ground. */
export const POND_LEVEL = WATER_LEVEL + 0.55;

// ---------- the waterways ----------

/** The small river, east to west (the way it flows and the boat goes), running on beyond the world both ways. */
export const RIVER_POINTS: readonly Pt[] = [
  [-1900, -60],
  [-1500, -20],
  [-1150, 10],
  [-900, 30],
  [-720, 60],
  [-580, 120],
  [-470, 168],
  [-360, 172],
  [-250, 128],
  [-140, 66],
  [-50, 24],
  [40, 0],
  [160, -30],
  [300, -85],
  [460, -150],
  [640, -190],
  [860, -180],
  [1100, -120],
  [1400, -70],
  [1900, -40],
];

/** The khal, from the river's middle northward to where it opens into the bil. */
export const KHAL_POINTS: readonly Pt[] = [
  [-10, 18],
  [-14, 50],
  [-16, 90],
  [-10, 140],
  [4, 190],
  [20, 240],
  [28, 290],
  [30, 340],
  [42, 390],
  [62, 440],
  [80, 490],
  [92, 540],
  [104, 590],
  [118, 640],
];

/** The side khal: from the khal westward through the fields, round to the bil's west side (a drain of the fields into the bil). */
export const SIDE_KHAL_POINTS: readonly Pt[] = [
  [58, 438],
  [100, 458],
  [150, 476],
  [200, 505],
  [238, 548],
  [262, 600],
  [268, 660],
  [262, 715],
  [252, 760],
];

/** The shapla bil: its middle, half its length (along the khal's way in) and half its width (m). */
export const BIL_SPEC = { x: 150, z: 815, halfLen: 185, halfWid: 120 } as const;

/** Where the boat sets out on the river (nearest point of it), and how far on into the bil she goes past where the khal opens into it (m). */
export const JOURNEY_FROM: Pt = [-1080, 18];
export const INTO_BIL = 150;

/** Where the scene opens: the boat on the river by the first para, its groves along the right bank and the bend ahead in the evening light. */
export const OPENING_NEAR: Pt = [-905, 30];

/** The old bridge carries the village road over the khal here (nearest point of the khal), and the bamboo sanko the field path over the side khal. */
export const BRIDGE_NEAR: Pt = [23, 262];
export const SANKO_NEAR: Pt = [150, 476];

/** The inside of the river's broad bend, opposite the zamindar house: a low sandy char where the kash grows. */
export const CHAR = { x: -455, z: 128, halfLen: 140, halfWid: 34, yaw: 0.22 } as const;

// ---------- homesteads ----------

/**
 * A homestead (বাড়ি): its mound with the yard (উঠান) in the middle and the houses round it, its trees, its pond.
 * `face` is the way its main house looks (radians: 0 north, π/2 west, π south, −π/2 east), across the yard
 * toward the road or the path it is reached from; `w` its mound across that way, `d` along it (m).
 * `bank`: a homestead by the water stands with its mound's front edge this far back from the water's edge of
 * the nearest waterway and faces it (its x, z are then only roughly where it is, and `face` is ignored).
 * `ghat`: it comes down to its water by its own ghat. `pond`: its pond, placed in its own frame (u toward its
 * face, v to its left looking that way).
 */
export interface HomesteadSpec {
  id: string;
  x: number;
  z: number;
  face?: number;
  w: number;
  d: number;
  bank?: number;
  ghat?: boolean;
  pond?: HomePond;
}

/** A homestead's pond, in the homestead's frame; `ghat` gives it steps on the side toward the houses. */
export interface HomePond {
  u: number;
  v: number;
  yaw: number;
  halfW: number;
  halfD: number;
  lilies?: boolean;
  ghat?: boolean;
}

/**
 * A pond (পুকুর): dug, with the earth thrown up round it as its bank; a rounded rectangle turned by `yaw`
 * (half-sizes along its own x and z). `lilies` for an old pond left to the shapla, `ghat` the point on its rim
 * its steps come down at.
 */
export interface PondSpec {
  x: number;
  z: number;
  yaw: number;
  halfW: number;
  halfD: number;
  lilies?: boolean;
  ghat?: Pt;
}

const S = Math.PI;
const E = -Math.PI / 2;
const W = Math.PI / 2;

export const HOMESTEADS: readonly HomesteadSpec[] = [
  // the para on the north bank where she sets out: a row along the river behind the bank, a second behind it
  { id: 'a1', x: -940, z: 60, w: 34, d: 28, bank: 11, ghat: true, pond: { u: -26, v: 24, yaw: 0.1, halfW: 13, halfD: 9 } },
  { id: 'a2', x: -875, z: 70, w: 30, d: 26, bank: 14 },
  { id: 'a3', x: -805, z: 78, w: 34, d: 28, bank: 11, ghat: true, pond: { u: -30, v: -22, yaw: 0.15, halfW: 15, halfD: 11, ghat: true } },
  { id: 'a4', x: -738, z: 94, w: 30, d: 26, bank: 15 },
  { id: 'a5', x: -668, z: 122, w: 32, d: 26, bank: 11, ghat: true, pond: { u: -28, v: 24, yaw: -0.3, halfW: 13, halfD: 10, lilies: true } },
  { id: 'a6', x: -905, z: 168, face: S, w: 32, d: 26 },
  { id: 'a7', x: -760, z: 196, face: S + 0.2, w: 30, d: 24 },
  // the riverside para between the zamindar house and the banyan
  { id: 'b1', x: -352, z: 196, w: 34, d: 28, bank: 11, ghat: true },
  { id: 'b2', x: -292, z: 176, w: 32, d: 26, bank: 14, pond: { u: -30, v: 12, yaw: 0.3, halfW: 13, halfD: 9, ghat: true } },
  { id: 'b3', x: -230, z: 142, w: 34, d: 28, bank: 11, ghat: true },
  { id: 'b4', x: -170, z: 106, w: 30, d: 26, bank: 15 },
  { id: 'b5', x: -114, z: 82, w: 30, d: 24, bank: 11, ghat: true },
  // north of the road
  { id: 'b6', x: -410, z: 382, face: S, w: 34, d: 28 },
  { id: 'b7', x: -335, z: 386, face: S, w: 36, d: 30, pond: { u: 48, v: 0, yaw: 0, halfW: 14, halfD: 9, lilies: true } },
  { id: 'b8', x: -256, z: 364, face: S + 0.1, w: 32, d: 26 },
  { id: 'b9', x: -184, z: 340, face: S, w: 34, d: 28, pond: { u: 34, v: -50, yaw: 0.4, halfW: 13, halfD: 10, ghat: true } },
  { id: 'b10', x: -560, z: 400, face: S + 0.2, w: 34, d: 28 },
  // along the khal's east bank, the road behind them
  { id: 'c1', x: -30, z: 216, w: 32, d: 26, bank: 13, ghat: true },
  { id: 'c2', x: -26, z: 300, w: 30, d: 26, bank: 15 },
  { id: 'c3', x: -12, z: 384, w: 34, d: 28, bank: 12, ghat: true },
  { id: 'c4', x: 18, z: 470, w: 32, d: 26, bank: 16, pond: { u: -36, v: 0, yaw: 0.2, halfW: 14, halfD: 10, lilies: true } },
  { id: 'c5', x: 60, z: 560, w: 32, d: 26, bank: 11, ghat: true },
  // west of the khal: by the river, round the mosque, by the road and the side khal
  { id: 'm1', x: 126, z: -10, w: 36, d: 28, bank: 11, ghat: true },
  { id: 'm2', x: 196, z: 128, face: S + 0.15, w: 30, d: 24 },
  { id: 'm3', x: 268, z: 154, face: S, w: 34, d: 28, pond: { u: 24, v: -62, yaw: -0.2, halfW: 14, halfD: 10, lilies: true } },
  { id: 'm4', x: 52, z: 344, w: 30, d: 26, bank: 11, ghat: true },
  { id: 'm5', x: 152, z: 402, face: S, w: 32, d: 26 },
  { id: 'm6', x: 282, z: 362, face: S, w: 36, d: 30, pond: { u: 0, v: 60, yaw: 0.15, halfW: 13, halfD: 10, ghat: true } },
  // by the bil
  { id: 'k1', x: 336, z: 690, face: E, w: 32, d: 26 },
  { id: 'k2', x: -64, z: 770, face: W, w: 30, d: 24 },
  { id: 'k3', x: 300, z: 980, face: S + 0.4, w: 32, d: 26 },
  // the south bank, across the river from the village
  { id: 's1', x: -640, z: 80, w: 34, d: 28, bank: 13, ghat: true, pond: { u: -32, v: 30, yaw: 0.2, halfW: 14, halfD: 10 } },
  { id: 's2', x: -258, z: 108, w: 32, d: 26, bank: 12 },
  { id: 's3', x: -150, z: 48, w: 30, d: 24, bank: 16 },
  { id: 's4', x: -88, z: 12, w: 34, d: 28, bank: 11, ghat: true, pond: { u: -30, v: 34, yaw: 0, halfW: 13, halfD: 10, lilies: true } },
  { id: 's5', x: 330, z: -110, w: 34, d: 28, bank: 18 },
  { id: 's6', x: 150, z: -50, w: 32, d: 26, bank: 12 },
  // down the river past the confluence
  { id: 'd1', x: 522, z: -150, w: 34, d: 28, bank: 11, ghat: true },
  { id: 'd2', x: 430, z: -122, w: 30, d: 24, bank: 14 },
];

// ---------- landmarks ----------

/** The old banyan at the corner of the river and the khal, its brick platform round the trunk, the village's ghat below it and the tea stall by the road. */
export const BANYAN = { x: -46, z: 72, crown: 15 } as const;
export const HUB_GHAT: Pt = [-62, 40];
export const TEA_STALL = { x: -84, z: 104, face: W - 0.4 } as const;

/** The zamindar house: its compound's middle, the way its front looks (over the river), and its compound's size (m). */
export const ZAMINDAR = { x: -440, z: 240, face: S + 0.35, w: 72, d: 54, pond: { x: -530, z: 262, yaw: 0.35, halfW: 20, halfD: 13 } as PondSpec } as const;

/** The mosque: its middle and the way its door looks (east: it faces the qibla, west, across its prayer hall); its pond before it. */
export const MOSQUE = { x: 152, z: 212, face: E, w: 26, d: 24, pond: { x: 100, z: 206, yaw: 0, halfW: 17, halfD: 12, ghat: [116, 206] } as PondSpec } as const;

/** The far villages: groves on their mounds out toward every horizon (only trees, seen through the haze). */
export const FAR_GROVES: readonly { x: number; z: number; r: number }[] = [
  { x: -1250, z: 470, r: 120 },
  { x: -1080, z: -480, r: 110 },
  { x: -560, z: -650, r: 130 },
  { x: 180, z: -720, r: 120 },
  { x: 860, z: -640, r: 140 },
  { x: 1280, z: -260, r: 110 },
  { x: 1250, z: 480, r: 130 },
  { x: 820, z: 930, r: 140 },
  { x: 300, z: 1230, r: 120 },
  { x: -420, z: 1120, r: 140 },
  { x: -1000, z: 920, r: 120 },
  { x: -820, z: 720, r: 90 },
  { x: 680, z: 560, r: 100 },
  { x: -1300, z: 60, r: 90 },
];

// ---------- roads and paths ----------

/** A way someone walks or rides: the village's brick road (HBB, on its embankment) or an earth path. Anchors: the bridge's and the sanko's ends. */
export type RoadPoint = Pt | 'bridge-e' | 'bridge-w' | 'sanko-s' | 'sanko-n';
export interface RoadSpec {
  kind: 'brick' | 'earth';
  width: number;
  /** Its designed points; or, for a path along a bank, `along`: from near one point to near another, `offset` m back from the water's edge, on their side of it. */
  points?: readonly RoadPoint[];
  along?: { way: 'river' | 'khal'; from: Pt; to: Pt; offset: number };
}

export const ROADS: readonly RoadSpec[] = [
  // the village road: along the river's north levee behind the homesteads, to the banyan, up the khal's bank,
  // over the old bridge and on west past the mosque
  {
    kind: 'brick',
    width: 3.2,
    points: [
      [-1900, 250],
      [-1300, 246],
      [-950, 226],
      [-760, 224],
      [-620, 252],
      [-520, 300],
      [-400, 310],
      [-300, 292],
      [-215, 252],
      [-150, 214],
      [-100, 158],
      [-72, 118],
      [-66, 150],
      [-64, 196],
      [-44, 240],
      'bridge-e',
      'bridge-w',
      [90, 268],
      [160, 262],
      [240, 274],
      [400, 298],
      [600, 318],
      [850, 332],
      [1200, 344],
      [1900, 360],
    ],
  },
  // the riverside path from the banyan's ghat to the zamindar house, along the bank's top past the homesteads' fronts
  { kind: 'earth', width: 1.5, along: { way: 'river', from: [-70, 60], to: [-395, 205], offset: 7.5 } },
  // and on the bank where she sets out, past the first para's fronts
  { kind: 'earth', width: 1.4, along: { way: 'river', from: [-990, 50], to: [-600, 140], offset: 7.5 } },
  // up to the homesteads north of the road
  { kind: 'earth', width: 1.3, points: [[-306, 294], [-318, 330], [-330, 364]] },
  { kind: 'earth', width: 1.3, points: [[-206, 248], [-196, 290], [-184, 318]] },
  { kind: 'earth', width: 1.3, points: [[-520, 302], [-548, 350], [-558, 384]] },
  // the khal's east bank: from the road north past the homesteads toward the bil
  { kind: 'earth', width: 1.3, points: [[-46, 246], [-60, 300], [-62, 360], [-56, 430], [-30, 500], [8, 548], [30, 562]] },
  // west of the khal: to the mosque past its pond, and to the homesteads off the road
  { kind: 'earth', width: 1.5, points: [[126, 40], [124, 100], [124, 160], [130, 214], [136, 262]] },
  { kind: 'earth', width: 1.3, points: [[266, 166], [262, 220], [262, 276]] },
  { kind: 'earth', width: 1.3, points: [[282, 346], [278, 312], [276, 286]] },
  // the field path north over the side khal by the bamboo sanko, to the homestead by the bil
  { kind: 'earth', width: 1.2, points: [[152, 263], [150, 330], [150, 384], [146, 430], 'sanko-s', 'sanko-n', [166, 530], [210, 600], [262, 650], [314, 688]] },
  // the south bank's field path between its homesteads
  { kind: 'earth', width: 1.3, points: [[-760, 30], [-700, 18], [-640, 14], [-560, 54], [-460, 70], [-360, 72], [-268, 56], [-180, 0], [-110, -34]] },
  { kind: 'earth', width: 1.2, points: [[-640, 14], [-652, 60]] },
];
