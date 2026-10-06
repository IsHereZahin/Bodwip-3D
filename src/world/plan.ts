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

/**
 * The designed area (world m): x from X0 (east) to X1 (west), z from Z0 (south) to Z1 (north): the boat's way
 * from where she sets out to the bil, the village round it, the railway and the north hill's near slope, ≈2.15
 * × 1.65 km. Beyond it the land fades into the haze and only the hills of the backdrop stand on the horizon
 * (world/backdrop.ts): the user found the open fields beyond the village's own ground empty and unneeded.
 */
export const WORLD = { x0: -1500, x1: 650, z0: -350, z1: 1300 } as const;

// ---------- levels ----------

/**
 * The river, the khal and the bil stand at one level (m): they are one water. It is their mean: the season
 * raises them by up to ≈0.8 m in the rains and lowers them by ≈0.4 m in spring (env/season.ts `water`).
 */
export const WATER_LEVEL = 1.0;
/** The fields' level (m): the land stands this high over the water in the months the boat goes out. */
export const PLAIN = WATER_LEVEL + 1.4;
/** A homestead's mound (ভিটা) stands this far above the fields, out of the rains' floods (m). */
export const MOUND = 1.0;
/** The brick road's crest above the fields (m): an embankment, as village roads are. */
export const ROAD_RAISE = 0.7;
/** The ponds' water, a little above the river's (m): fed by the rain and the ground. */
export const POND_LEVEL = WATER_LEVEL + 0.55;
/** How much of the season's rise and fall the ponds take: rain-fed, they change less than the river. */
export const POND_RISE = 0.3;

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

/**
 * The tidal creek (খাঁড়ি) that brings the sea's salt water up to the salt field (SALT_FIELD) from the south, out
 * of the haze toward the coast, ending beside the field's settling pond, where a sluice lets the brine in. It is
 * not joined to the river, whose water is fresh: salt is made from the sea's. South to north.
 */
export const SALT_CREEK_POINTS: readonly Pt[] = [
  [-1345, -560],
  [-1300, -470],
  [-1335, -390],
  [-1290, -320],
  [-1312, -255],
  [-1272, -195],
  [-1294, -140],
  [-1266, -100],
  [-1259, -68],
];

/** The shapla bil: its middle, half its length (along the khal's way in) and half its width (m). */
export const BIL_SPEC = { x: 150, z: 815, halfLen: 185, halfWid: 120 } as const;

/** Where the boat sets out on the river (nearest point of it), and how far on into the bil she goes past where the khal opens into it (m). */
export const JOURNEY_FROM: Pt = [-1080, 18];
export const INTO_BIL = 150;

/** Where the scene opens: the boat on the river by the first para, its groves along the right bank and the bend ahead in the evening light. */
export const OPENING_NEAR: Pt = [-905, 30];

/**
 * The fisherman casting his net (world/fisher.ts): his dinghy tied to a bamboo pole on the river below where
 * the khal comes in, off the boat's way, on the south bank's side of the middle; near which point.
 */
export const FISHER_NEAR: Pt = [92, -14];

/**
 * The date palms tapped for their sap in winter (world/khejur.ts): a field path from the first para's riverside
 * path up through the fields to the village road, and a row of palms along its east side, `side` m off its line,
 * from and to shares of its length.
 */
export const KHEJUR_PATH: readonly Pt[] = [
  [-849, 59],
  [-851, 98],
  [-849, 140],
  [-845, 182],
  [-842, 222],
];
export const KHEJUR_ROW = { side: 2.6, from: 0.22, to: 0.93, count: 7 };

/** The old bridge carries the village road over the khal here (nearest point of the khal), and the bamboo sanko the field path over the side khal. */
export const BRIDGE_NEAR: Pt = [23, 262];
export const SANKO_NEAR: Pt = [150, 476];

/** The inside of the river's broad bend, opposite the zamindar house: a low sandy char where the kash grows. */
export const CHAR = { x: -455, z: 128, halfLen: 140, halfWid: 34, yaw: 0.22 } as const;

/**
 * The salt field (লবণ মাঠ, the user's ask) on the river's south bank by where the boat sets out, behind the
 * river's embankment at the foot of the wooded hill: one farm (khola) worked in the dry months (env/season.ts
 * `salt`). Its middle, the way its length runs (yaw: along (sin, cos), here upriver, west), its length and
 * width (m), and the shares of its length (from its east end) given to the settling pond where the river's
 * water is let in, then the evaporation beds where the brine thickens; the rest is crystallizer beds lined
 * with black plastic, where the salt forms and is raked up. render/patch.ts paints it, world/saltworks.ts
 * builds what stands on it: keep the two in step.
 */
export const SALT_FIELD = {
  x: -1200,
  z: -52,
  yaw: 1.485,
  w: 96,
  d: 60,
  pond: 0.22,
  evaporation: 0.5,
  /** The evaporation beds' and the crystallizers' cells (m along, m across), and how far in from the edge its bund runs (inside the feeder channel). */
  evapCell: [8.96, 10],
  crystalCell: [8, 5],
  rimInset: 2.3,
} as const;

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
  /** Kept clean by the village (the mosque's): clear, no hyacinth, a few shapla, bright fish. */
  kept?: boolean;
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
export const TEA_STALL = { x: -97, z: 106, face: E + 0.5 } as const;

/** The zamindar house: its compound's middle, the way its front looks (over the river), and its compound's size (m). */
export const ZAMINDAR = { x: -440, z: 240, face: S + 0.35, w: 72, d: 54, pond: { x: -530, z: 262, yaw: 0.35, halfW: 20, halfD: 13 } as PondSpec } as const;

/** The mosque: its middle and the way its door looks (east: it faces the qibla, west, across its prayer hall); its pond before it. */
/** (its axis, out of its door toward its pond, runs along z = 212: the walk and the pond's ghat lie on it) */
export const MOSQUE = { x: 152, z: 212, face: E, w: 40, d: 34, pond: { x: 100, z: 206, yaw: 0, halfW: 17, halfD: 12, ghat: [117, 212], kept: true } as PondSpec } as const;

/**
 * The big old trees round the mosque's pond, on its banks, their crowns over its water and their shade on it: a
 * rain tree at one corner, three mangoes (one where a jackfruit might be), a coconut leaning out over the water.
 * Not evenly spaced, as trees left standing round a pond never are.
 */
export const MOSQUE_POND_TREES: readonly { kind: 'mango' | 'rain' | 'coconut'; x: number; z: number; s: number; ry: number }[] = [
  { kind: 'rain', x: 86, z: 221.5, s: 1.15, ry: 0.4 },
  { kind: 'mango', x: 110.5, z: 221, s: 1.2, ry: 2.2 },
  { kind: 'mango', x: 80.5, z: 192.5, s: 1.1, ry: 4.1 },
  { kind: 'mango', x: 105, z: 190.5, s: 0.95, ry: 1.3 },
  { kind: 'coconut', x: 80, z: 208, s: 1.05, ry: 1.6 },
];

/**
 * The mosque's graveyard (কবরস্থান): a low rise of its own just south of the mosque (a rounded rectangle as the
 * mounds are: `hu` m half along `face`, north here, `hv` across), its graves lying north to south; and the old
 * banyan standing at its west corner, the tree the mosque, its pond and its graveyard are known by across the
 * fields (no platform round it: the graveyard's is left as it grew).
 */
export const GRAVEYARD = { x: 156, z: 169, face: 0.06, hu: 10, hv: 13 } as const;
/**
 * The mosque's grounds: the village's common round the mosque, its pond and its graveyard, grass under old
 * trees rather than fields (a rounded rectangle like the mounds, its corners' radius `corner`).
 */
export const MOSQUE_GROUNDS = { x: 132, z: 192, face: 0, hu: 44, hv: 64, corner: 18 } as const;
export const GRAVE_BANYAN = { x: 181, z: 165, crown: 13 } as const;

/**
 * The wooded hills (টিলা) that rise from the plain in a few places. An ellipse each, `stretch` times longer along
 * `yaw` (0 north), `h` m high. Most are rounded domes; a `steep` one (the user's reference: forested hills
 * standing right over the water) keeps a low foot out to its edge and then climbs steeply from `steep` of its
 * radius inward, so a strip of grassy bank lies between the water and the slope. Three stand right by the
 * waters: over the river's south bank where the boat sets out, out of the bil's north-east shore where the khal
 * comes into it, and behind the char's kash; the rest are on the horizons, faded into the haze.
 */
export const HILLS: readonly { x: number; z: number; r: number; h: number; stretch: number; yaw: number; steep?: number }[] = [
  { x: -900, z: -140, r: 150, h: 85, stretch: 1.6, yaw: 1.5, steep: 0.3 },
  { x: -22, z: 955, r: 115, h: 75, stretch: 1.3, yaw: 0.3, steep: 0.3 },
  { x: -470, z: -115, r: 130, h: 52, stretch: 1.5, yaw: 1.45, steep: 0.35 },
  { x: 520, z: -395, r: 190, h: 24, stretch: 1.45, yaw: 1.25 },
  { x: -420, z: 1340, r: 260, h: 36, stretch: 1.6, yaw: 1.4 },
  { x: -1330, z: 620, r: 220, h: 18, stretch: 1.3, yaw: 0.4 },
];

/**
 * Rocks standing up out of the khal's water (the user asked for some, with the boat going round them): `s` m
 * along the khal from its mouth, `c` m to the left of its middle going up it, `r` their half-width (m). Clear of
 * the bridge (s 250), the ghats (188, 336, 360, 550) and the side khal's mouth (430); the boat's way swerves
 * round each (waterways.ts `rockSwerve`). All on her right going up: the boatman paddles on his left, and the
 * blade must not reach a rock.
 */
/**
 * The hill stream (ছড়া): a spring high on the steep wooded hill over the river's south bank where the boat sets
 * out, its water tumbling down the hill's face in a gully over rock ledges, a fall of a metre or so off each, into
 * the river: full and white in the rains, a thread in the dry months. Its line from the spring down to the
 * river's edge, and its gully's width (m).
 */
export const HILL_STREAM: { points: readonly Pt[]; width: number } = {
  points: [
    [-868, -56],
    [-866, -44],
    [-862.5, -33],
    [-861, -22],
    [-858.5, -11],
    [-859.5, 1],
    [-860.5, 12],
    [-860, 22],
  ],
  // (wide enough for the ground's 2 m lattice to draw its gully)
  width: 4.6,
};

/**
 * The sluice (স্লুইস গেট) in the river's north levee where a drain from the fields runs out: a brick headwall over
 * its vent, an iron gate raised on a screw by a wheel, an apron down to the water. From the rains into autumn
 * the fields' water pours out through it into the river; in the dry months the gate is down and the drain dry.
 * The drain's start in the fields, its width and depth (m), and how far back from the river's edge the
 * headwall stands (m).
 */
export const SLUICE: { fields: Pt; width: number; depth: number; back: number } = { fields: [-576, 214], width: 3.4, depth: 0.7, back: 2.2 };

export const KHAL_ROCKS: readonly { s: number; c: number; r: number }[] = [
  { s: 110, c: -1.4, r: 1.0 },
  { s: 400, c: -1.2, r: 0.85 },
  { s: 495, c: -1.1, r: 1.1 },
];

/** The railway, east to west on its embankment north of the bil: the far side of the village from the river. */
export const RAILWAY_POINTS: readonly Pt[] = [
  [-1900, 1075],
  [-1000, 1098],
  [-200, 1122],
  [500, 1118],
  [1100, 1094],
  [1900, 1062],
];
/** Its embankment: the rails' bed this far above the fields, its top this wide, its sides falling 1 in 2. */
export const RAILWAY = { raise: 3.2, top: 6.5, slope: 0.5 } as const;

/** The far villages: groves on their mounds out toward every horizon (only trees, seen through the haze). */
export const FAR_GROVES: readonly { x: number; z: number; r: number }[] = [
  { x: -1250, z: 470, r: 120 },
  { x: -900, z: -250, r: 90 },
  { x: -300, z: -260, r: 80 },
  { x: 560, z: 520, r: 80 },
  { x: 460, z: 1180, r: 90 },
  { x: -430, z: 975, r: 120 },
  { x: -1000, z: 920, r: 120 },
  { x: -820, z: 720, r: 90 },
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
  /** Brick laid flat on the ground, as a path is, not raised on an embankment (the hub's paving down to its ghat). */
  flat?: boolean;
}

export const ROADS: readonly RoadSpec[] = [
  // the village road: along the river's north levee behind the homesteads, to the banyan, up the khal's bank,
  // over the old bridge and on west past the mosque
  {
    kind: 'brick',
    // as wide as the old bridge's deck between its parapets, so the road runs onto it without a step
    width: 3.4,
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
      [-152, 208],
      [-108, 154],
      [-84, 124],
      [-66, 130],
      [-58, 166],
      [-58, 204],
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
  // the hub's paving: from the road's bend, round under the banyan's crown clear of its platform, and down
  // the ghat's own line onto its landing
  { kind: 'brick', width: 2.6, flat: true, points: [[-84, 122], [-74, 100], [-66, 80], [-58, 62], [-55.5, 55], [-57.6, 49.5]] },
  // the riverside path from the banyan's ghat to the zamindar house, along the bank's top past the homesteads' fronts
  { kind: 'earth', width: 1.5, along: { way: 'river', from: [-70, 60], to: [-395, 205], offset: 7.5 } },
  // down the river past the confluence, a path along each bank's top joining the homesteads there
  { kind: 'earth', width: 1.3, along: { way: 'river', from: [70, 30], to: [600, -140], offset: 7.5 } },
  { kind: 'earth', width: 1.2, along: { way: 'river', from: [60, -60], to: [520, -230], offset: 7.5 } },
  // and on the bank where she sets out, past the first para's fronts
  { kind: 'earth', width: 1.4, along: { way: 'river', from: [-990, 50], to: [-600, 140], offset: 7.5 } },
  // the field path from it up past the date palms to the village road
  { kind: 'earth', width: 1.1, points: [...KHEJUR_PATH] },
  // up to the homesteads north of the road
  { kind: 'earth', width: 1.3, points: [[-306, 294], [-318, 330], [-330, 364]] },
  { kind: 'earth', width: 1.3, points: [[-206, 248], [-196, 290], [-184, 318]] },
  { kind: 'earth', width: 1.3, points: [[-520, 302], [-548, 350], [-558, 384]] },
  // the khal's east bank: from the road north past the homesteads toward the bil
  { kind: 'earth', width: 1.3, points: [[-46, 246], [-60, 300], [-62, 360], [-56, 430], [-30, 500], [8, 548], [30, 562]] },
  // west of the khal: the way to the mosque from the river path and from the road, past the mosque's front
  // between it and its pond, and a brick walk on the mosque's axis from the foot of its steps to the pond's ghat
  // (for the ablutions), crossing the path
  { kind: 'earth', width: 1.8, points: [[126, 40], [124, 100], [124, 160], [129, 212], [136, 262]] },
  { kind: 'brick', width: 2.2, flat: true, points: [[138.8, 212], [130, 212], [119.4, 212]] },
  { kind: 'earth', width: 1.3, points: [[266, 166], [262, 220], [262, 276]] },
  { kind: 'earth', width: 1.3, points: [[282, 346], [278, 312], [276, 286]] },
  // the field path north over the side khal by the bamboo sanko, to the homestead by the bil
  { kind: 'earth', width: 1.2, points: [[152, 263], [150, 330], [150, 384], [146, 430], 'sanko-s', 'sanko-n', [166, 530], [210, 600], [262, 650], [314, 688]] },
  // the south bank's field path between its homesteads
  { kind: 'earth', width: 1.3, points: [[-760, 30], [-700, 18], [-640, 14], [-560, 54], [-460, 70], [-360, 72], [-268, 56], [-180, 0], [-110, -34]] },
  { kind: 'earth', width: 1.2, points: [[-640, 14], [-652, 60]] },
  // out across the char through its kash to the river's edge, where the boats put in to cut it and graze the cattle
  { kind: 'earth', width: 1.2, points: [[-460, 70], [-458, 100], [-454, 126], [-450, 151]] },
];
