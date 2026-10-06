import { BufferAttribute, DoubleSide, Euler, Group, Matrix4, Mesh, MeshStandardMaterial, Quaternion, Vector2, Vector3 } from 'three';
import { Rng } from '../core/rng';
import { MeshBuilder, mixRgb, rgb, scaleRgb, slab, taperedTube, type RGB } from '../render/builder';
import { patchMaterial } from '../render/patch';
import { brickTexture, plasterTexture, strawTexture, tinTexture, weaveTexture } from '../render/textures';
import { HOMESTEAD_MOUNDS, PONDS, WATER_LEVEL, bankAt, grandGhat, nearBackwater, onRoad, pondReach, shapePoint, terrainHeight, type Mound, type Pond } from './geography';
import { buildHouse, haystack, type HouseParts, type HouseStyle } from './houses';
import { ghatFlight, ghatPoint, groundOver, type GhatSite } from './ghatFlight';
import { HUB_GHAT, LOW_WATER, POND_RISE } from './plan';
import { buildHull, hullHalfWidthAt, hullStation, type HullShape } from './hull';
import { INLAND, SHELTERED, SHOAL_DEPTH, waveHeightGlsl, waveSlopeGlsl } from './waves';
import type { Waterway } from './waterways';

// The homesteads (বাড়ি): on each mound the houses stand round the swept yard (উঠান), the main house across
// its back with its veranda looking over it toward the way the homestead faces, one or two more along its
// sides facing in, the kitchen at a front corner and the cowshed at a back corner (world/houses.ts builds
// them); haystacks by the mound's foot. Where a homestead comes down to the river or the khal it has its own
// ghat: brick steps cut into the bank between stepped walls, or a bamboo platform on posts out over the
// water where the washing is done; a boat is tied up at some of them.

export interface HutPlan {
  x: number;
  y: number;
  z: number;
  ry: number;
  /** Length along local x, the room's depth along local z (its door looks along local +z). */
  l: number;
  w: number;
  kind: HouseStyle['kind'];
  style: HouseStyle;
}

/** Where a homestead (or the village) comes down to its water: its ghat's foot at the water's edge, the way up the bank, and the waterway. */
export interface Ghat {
  x: number;
  z: number;
  up: number;
  way: Waterway;
  s: number;
  side: 1 | -1;
  kind: 'brick' | 'bamboo';
}

/** Mud walls' washes: earth ochre and clay browns, a pale clay, now and then a lime wash. */
const MUD: RGB[] = [rgb('#a5805a'), rgb('#b38c62'), rgb('#9c7650'), rgb('#c2a27a'), rgb('#ad8a66'), rgb('#d6cdbd')];
/** Painted tin walls: green, red oxide, blue, and bare galvanised. */
const TIN: RGB[] = [rgb('#6b8a55'), rgb('#9a4a36'), rgb('#56789a'), rgb('#a9a8a0')];
/** Doors and shutters: teal, indigo, maroon, plain timber, green. */
const PAINT: RGB[] = [rgb('#2f6b6a'), rgb('#36578a'), rgb('#6e3424'), rgb('#4a3424'), rgb('#4f7a3a')];

/** A house's style, chosen once per house: most of mud under thatch or tin, some of painted tin. */
function styleFor(kind: HouseStyle['kind'], rng: Rng, main: boolean): HouseStyle {
  const paint = rng.pick(PAINT);
  if (kind === 'kitchen') return { kind, walls: 'mud', roof: 'thatch', wall: rng.pick(MUD.slice(0, 5)), paint, veranda: 0 };
  if (kind === 'shed') return { kind, walls: 'mud', roof: rng.next() < 0.75 ? 'thatch' : 'tin', wall: MUD[0], paint, veranda: 0 };
  const tinWalls = rng.next() < 0.3;
  return {
    kind,
    walls: tinWalls ? 'tin' : 'mud',
    roof: tinWalls || rng.next() < 0.45 ? 'tin' : 'thatch',
    wall: tinWalls ? rng.pick(TIN) : rng.pick(MUD),
    paint,
    veranda: main ? rng.range(1.5, 1.9) : rng.next() < 0.4 ? rng.range(1.1, 1.4) : 0,
  };
}

/** The houses of one homestead, laid round its yard in the mound's frame (u toward its face, v across). */
function homestead(m: Mound, rng: Rng, out: HutPlan[]): void {
  const put = (u: number, v: number, turn: number, l: number, w: number, kind: HouseStyle['kind'], main = false) => {
    const p = shapePoint(m, u, v);
    out.push({ x: p.x, y: terrainHeight(p.x, p.z) - 0.05, z: p.z, ry: m.face + turn, l, w, kind, style: styleFor(kind, rng, main) });
  };
  // the main house across the back of the yard, looking out over it from its veranda
  put(-m.hu * 0.52, rng.range(-1, 1), 0, rng.range(7.5, 9.5), rng.range(4.2, 4.8), 'house', true);
  // one or two houses along the yard's sides, facing in
  const sides = rng.next() < 0.55 ? [1, -1] : [rng.sign()];
  for (const side of sides) put(rng.range(-2.5, 0.5), side * m.hv * 0.5, (side * Math.PI) / 2, rng.range(5.8, 7.2), rng.range(3.6, 4.2), 'house');
  // the kitchen at a front corner, and the cowshed at a back corner
  const k = sides.length === 2 ? rng.sign() : -sides[0];
  put(m.hu * 0.42, k * m.hv * 0.55, (k * Math.PI) / 2, rng.range(3.2, 3.8), rng.range(2.8, 3.2), 'kitchen');
  put(-m.hu * 0.55, -k * m.hv * 0.64, (-k * Math.PI) / 2, rng.range(4.5, 5.5), rng.range(3, 3.4), 'shed');
}

/** The homesteads' houses, deterministic. */
export function planHuts(): HutPlan[] {
  const rng = new Rng(21);
  const huts: HutPlan[] = [];
  for (const m of HOMESTEAD_MOUNDS) homestead(m, rng, huts);
  return huts;
}

/** The ghats: the village's below the banyan first, then each homestead's that has one, at the water's edge of the nearest bank. */
export function planGhats(): Ghat[] {
  const rng = new Rng(23);
  const out: Ghat[] = [];
  const at = (x: number, z: number, kind: Ghat['kind']) => {
    const b = bankAt(x, z);
    if (b) out.push({ x: b.x, z: b.z, up: b.up, way: b.way, s: b.s, side: b.side, kind });
  };
  at(HUB_GHAT[0], HUB_GHAT[1], 'brick');
  // a homestead's ghat comes down from its front, straight to the water
  for (const m of HOMESTEAD_MOUNDS) {
    if (!m.home?.ghat) continue;
    const front = shapePoint(m, m.hu + 4, 0);
    at(front.x, front.z, rng.next() < 0.55 ? 'bamboo' : 'brick');
  }
  return out;
}

// ---------- the ghats ----------

const BRICK: RGB = rgb('#a0624a');
const DAMP: RGB = rgb('#5a4a3a');

/**
 * Brick steps down the bank square to it (ghatFlight.ts lays them: each the same rise, none under the ground),
 * from a landing at its top into the water, between low walls that step down with them and hold the bank back
 * where it stands higher; damp and dark where the water reaches. `low` is the lowest the water falls.
 */
function brickGhat(b: MeshBuilder, g: GhatSite, rng: Rng, level = WATER_LEVEL, low = level - LOW_WATER, width = 2.4, reach = 8, seats = false): void {
  const wall = 0.34;
  const half = width / 2 + wall;
  const steps = ghatFlight(g, { width, wall, top: reach + 1.9, landing: 1.6, low }, terrainHeight);
  const tone = (y: number) => scaleRgb(mixRgb(BRICK, DAMP, 1 - Math.min(1, Math.max(0, (y - level + 0.2) / 0.9))), rng.range(0.9, 1.05));
  steps.forEach((st, i) => {
    const run = st.back - st.front;
    // the tread's block, down into the bank (or the bed) under it
    const under = groundOver(g, st.front, st.back, -width / 2, width / 2, terrainHeight);
    const bottom = Math.min(under.low, st.y) - 0.4;
    const mid = ghatPoint(g, (st.front + st.back) / 2);
    slab(b, mid.x, (st.y + bottom) / 2, mid.z, width, st.y - bottom, run + 0.02, g.up, tone(st.y), 0.6);
    // the walls either side, a little above the treads (level with the landing), up to the bank beside where it stands higher
    for (const side of [-1, 1]) {
      const s = side * (width / 2 + wall / 2);
      const beside = groundOver(g, st.front, st.back, side * (half + 0.3), side * (half + 0.3), terrainHeight).high;
      const top = Math.max(st.y + (i === 0 ? 0.08 : 0.25), beside + 0.06);
      const foot = Math.min(groundOver(g, st.front, st.back, s, s, terrainHeight).low, st.y) - 0.4;
      const w = ghatPoint(g, (st.front + st.back) / 2, s);
      slab(b, w.x, (top + foot) / 2, w.z, wall, top - foot, run + 0.02, g.up, tone(top - 0.2), 0.6);
    }
  });
  // two low pillars where the flight leaves the landing
  const land = steps[0];
  for (const side of [-1, 1]) {
    const pz = ghatPoint(g, land.front + 0.21, side * (width / 2 + wall / 2));
    slab(b, pz.x, land.y + 0.3, pz.z, 0.42, 0.6, 0.42, g.up, tone(land.y), 0.6);
    // the village's ghat has its rowak: a plastered bench each side of the landing, where people sit by the water
    if (seats) {
      const d = (land.front + land.back) / 2;
      const r = ghatPoint(g, d, side * (half + 1.05));
      const ground = groundOver(g, d - 1.3, d + 1.3, side * (half + 0.1), side * (half + 2), terrainHeight);
      const top = Math.max(land.y, ground.high) + 0.45;
      slab(b, r.x, (top + ground.low - 0.2) / 2, r.z, 1.9, top - ground.low + 0.2, 2.6, g.up, tone(land.y + 1), 0.6);
    }
  }
}

/** A pond's ghat: brick steps down its bank from the point on the rim the design gives, square to the bank. */
function pondGhat(b: MeshBuilder, pond: Pond, at: { x: number; z: number }, rng: Rng): void {
  // walk in from the rim toward the middle to the water's edge
  let x = at.x;
  let z = at.z;
  for (let k = 0; k < 60 && pondReach(pond, x, z) > 1; k++) {
    x += (pond.x - x) * 0.04;
    z += (pond.z - z) * 0.04;
  }
  brickGhat(b, { x, z, up: Math.atan2(at.x - pond.x, at.z - pond.z) }, rng, pond.level, pond.level - POND_RISE * LOW_WATER, 1.8, 3.2);
}

/**
 * A bamboo ghat: a short walkway of culms on posts from the bank out over the water, a little platform at its
 * end where the washing is beaten and the pots filled.
 */
function bambooGhat(b: MeshBuilder, g: Ghat, rng: Rng): void {
  const ux = Math.sin(g.up);
  const uz = Math.cos(g.up);
  const cx = Math.cos(g.up);
  const cz = -Math.sin(g.up);
  // above the rains' high water (env/season.ts): on tall legs in the dry months
  const deck = WATER_LEVEL + 1.0;
  const at = (d: number, s: number, y: number) => new Vector3(g.x + ux * d + cx * s, y, g.z + uz * d + cz * s);
  const tint = () => scaleRgb(rgb('#a39469'), rng.range(0.82, 1.05));
  const reach = rng.range(3.5, 5);
  // posts from the bed up past the deck, in pairs
  for (let d = 0.6; d >= -reach; d -= 1.6) {
    for (const s of [-0.55, 0.55]) {
      const bed = Math.min(terrainHeight(at(d, s, 0).x, at(d, s, 0).z), WATER_LEVEL) - 0.6;
      taperedTube(b, [at(d, s, bed), at(d + rng.range(-0.05, 0.05), s, deck + 0.35)], [0.05, 0.045], 5, tint(), 1.2);
    }
    taperedTube(b, [at(d, -0.6, deck - 0.06), at(d, 0.6, deck - 0.06)], [0.04, 0.04], 5, tint(), 1.2);
  }
  // the walkway: culms side by side from the bank's lip out to the end
  const land = 2.2;
  for (let k = -3; k <= 3; k++) {
    const s = k * 0.1;
    const y0 = Math.max(deck, terrainHeight(at(land, s, 0).x, at(land, s, 0).z) + 0.04);
    taperedTube(b, [at(land, s, y0), at(0.4, s, deck), at(-reach - 0.3, s, deck)], [0.045, 0.045, 0.045], 5, tint(), 1.2);
  }
  // the platform's cross slats at the end
  for (let d = -reach + 0.9; d >= -reach - 0.3; d -= 0.22) taperedTube(b, [at(d, -0.85, deck + 0.05), at(d, 0.85, deck + 0.05)], [0.035, 0.035], 4, tint(), 1.2);
}

// ---------- the boats tied up ----------

const SMALL_BOAT: HullShape = { len: 6, beam: 0.62, keelMid: -0.2, keelRise: 0.6, sheerMid: 0.32, sheerRise: 0.7 };
/** The zamindar house's own boat: longer and broader, her strake painted. */
const ZAMINDAR_BOAT: HullShape = { len: 7.6, beam: 0.8, keelMid: -0.26, keelRise: 0.75, sheerMid: 0.42, sheerRise: 0.95 };

/**
 * A boat tied up in the `afloat` builder: her vertices; her middle (the waves under it) and the height below
 * which she sits on the mud (the bed under her keel: in the dry months the water draws back from the banks and
 * leaves the boats tied close in aground); her stem, where her line is made fast and about which she swings on
 * it; and her line's vertices, from the post it is tied to (fixed) to her stem (riding with her).
 */
interface Mooring {
  from: number;
  to: number;
  x: number;
  z: number;
  aground: number;
  stem: { x: number; z: number };
  line: { from: number; to: number; post: { x: number; z: number } };
}

/** A post a boat's line is tied to: where it is planted, its top and the height the line is made fast at (m), its radius. */
interface Post {
  x: number;
  z: number;
  top: number;
  tie: number;
  r: number;
  color: RGB;
}

/** How far a moored boat's keel lies under the water (m). */
const MOORED_DRAFT = 0.15;
/** Her line: hemp, hanging this slack between the post and her stem (m for each m of it). */
const LINE: RGB = rgb('#8c7a56');
const SLACK = 0.06;

/**
 * A boat lying at (x, z) along `heading`, tied up to `post`: a thwart or two across her and a bamboo pole along
 * her, her line from her stem (whichever end lies toward the post) to the post's top, the post planted in the
 * bank or the shallows (into `posts`, which stay put).
 */
function tieUp(afloat: MeshBuilder, posts: MeshBuilder, moorings: Mooring[], shape: HullShape, colors: { tar: RGB; top: RGB; band?: RGB }, x: number, z: number, heading: number, post: Post, rng: Rng): void {
  // her stem toward her post
  if (Math.sin(heading) * (post.x - x) + Math.cos(heading) * (post.z - z) < 0) heading += Math.PI;
  const boat = new MeshBuilder();
  buildHull(boat, shape, colors);
  const plank = scaleRgb(colors.top, 1.15);
  let rest = 0;
  for (const s of [0.32, 0.5, 0.68]) {
    const y = hullStation(shape, s).sheer - 0.09;
    const half = hullHalfWidthAt(shape, s, y) - 0.01;
    slab(boat, 0, y, (s - 0.5) * shape.len, half * 2, 0.035, 0.2, 0, plank, 1);
    rest = Math.max(rest, y + 0.04);
  }
  taperedTube(boat, [new Vector3(0.14, rest, -shape.len * 0.36), new Vector3(-0.08, rest + 0.02, shape.len * 0.38)], [0.028, 0.022], 5, rgb('#a39469'), 1.2);
  const stem = new Vector3(0, hullStation(shape, 0.95).sheer - 0.14, 0.45 * shape.len);
  // her frame: her keel MOORED_DRAFT under the water's surface (as the vertex shader lifts her onto it), lying a little untrue
  const m = new Matrix4().compose(
    new Vector3(x, -MOORED_DRAFT - shape.keelMid, z),
    new Quaternion().setFromEuler(new Euler(rng.range(-0.03, 0.03), heading, rng.range(-0.04, 0.04), 'YXZ')),
    new Vector3(1, 1, 1),
  );
  const from = afloat.vertexCount;
  afloat.add(boat.build(), m, 'own');
  const to = afloat.vertexCount;
  stem.applyMatrix4(m);
  // the post, planted deep, leaning a little
  const ground = terrainHeight(post.x, post.z);
  const lean = { x: rng.range(-0.06, 0.06), z: rng.range(-0.06, 0.06) };
  taperedTube(posts, [new Vector3(post.x, ground - 0.6, post.z), new Vector3(post.x + lean.x, post.top, post.z + lean.z)], [post.r, post.r * 0.85], 6, post.color, 1.2);
  // the line, from the post (where it stays) to her stem (riding with her as she lifts on the water: the shader
  // lifts each of its points by its share of the way to her), hanging slack between
  const k = (post.tie - ground + 0.6) / (post.top - ground + 0.6);
  const tie = new Vector3(post.x + lean.x * k, post.tie, post.z + lean.z * k);
  const length = Math.hypot(stem.x - tie.x, stem.z - tie.z) + 0.5;
  const pts: Vector3[] = [];
  for (let i = 0; i <= 8; i++) {
    const t = i / 8;
    pts.push(new Vector3(tie.x + (stem.x - tie.x) * t, tie.y + (stem.y - tie.y) * t - SLACK * length * 4 * t * (1 - t), tie.z + (stem.z - tie.z) * t));
  }
  const lineFrom = afloat.vertexCount;
  taperedTube(afloat, pts, pts.map(() => 0.013), 5, LINE, 0.3);
  // and its turns round the post
  for (let i = 0; i < 3; i++) taperedTube(posts, ring(new Vector3(tie.x, tie.y - 0.05 + i * 0.035, tie.z), post.r + 0.012), Array(9).fill(0.012), 4, LINE, 0.3);
  moorings.push({ from, to, x, z, aground: terrainHeight(x, z) + MOORED_DRAFT - 0.03, stem: { x: stem.x, z: stem.z }, line: { from: lineFrom, to: afloat.vertexCount, post: { x: tie.x, z: tie.z } } });
}

/** Points round a level circle (a rope's turn round a post). */
function ring(c: Vector3, r: number): Vector3[] {
  return Array.from({ length: 9 }, (_, i) => new Vector3(c.x + Math.cos((i / 8) * Math.PI * 2) * r, c.y, c.z + Math.sin((i / 8) * Math.PI * 2) * r));
}

/** A small boat tied up beside a ghat, along the bank, close in (the water's middle stays open), her line to a bamboo stake on the bank. */
function mooredBoat(afloat: MeshBuilder, posts: MeshBuilder, moorings: Mooring[], g: Ghat, rng: Rng): void {
  const away = rng.sign();
  const s = g.s + away * rng.range(5, 7);
  const p = g.way.at(s);
  const e = g.way.beside(s, g.side, g.way.half(s) - 2.4);
  // the stake on the bank by her end toward the ghat
  const st = g.way.beside(s - away * (SMALL_BOAT.len / 2 + 0.4), g.side, g.way.half(s) + 0.7);
  const ground = terrainHeight(st.x, st.z);
  const post: Post = { x: st.x, z: st.z, top: ground + 1.1, tie: ground + 0.7, r: 0.035, color: rgb('#a39469') };
  tieUp(afloat, posts, moorings, SMALL_BOAT, { tar: rgb('#2a2018'), top: rgb('#5a4a38') }, e.x, e.z, p.heading + rng.range(-0.12, 0.12), post, rng);
}

/**
 * The zamindar house's boat: alongside the bank just downstream of the grand ghat, lying to the current on her
 * line, her stem upstream to a sal post in the shallows by the ghat's wall.
 */
function zamindarBoat(afloat: MeshBuilder, posts: MeshBuilder, moorings: Mooring[], rng: Rng): void {
  const gg = grandGhat();
  const b = gg ? bankAt(gg.site.x, gg.site.z) : null;
  if (!gg || !b) return;
  const down = Math.sign(b.way.current) || 1;
  const s = b.s + down * (gg.half + 1.4 + ZAMINDAR_BOAT.len / 2);
  const e = b.way.beside(s, b.side, b.way.half(s) - 2.3);
  const at = b.way.beside(b.s + down * (gg.half + 0.45), b.side, b.way.half(b.s) - 0.5);
  const post: Post = { x: at.x, z: at.z, top: WATER_LEVEL + 1.75, tie: WATER_LEVEL + 1.15, r: 0.075, color: rgb('#4e3e2c') };
  tieUp(afloat, posts, moorings, ZAMINDAR_BOAT, { tar: rgb('#2a2018'), top: rgb('#6b5842'), band: rgb('#3e6474') }, e.x, e.z, b.way.at(s).heading, post, rng);
}

// ---------- assembly ----------

export function buildVillages(huts: readonly HutPlan[], ghats: readonly Ghat[]): Group {
  const rng = new Rng(33);
  const parts: HouseParts = { mud: new MeshBuilder(), wood: new MeshBuilder(), thatch: new MeshBuilder(), tin: new MeshBuilder(), mat: new MeshBuilder() };
  const bricks = new MeshBuilder();
  const bamboo = new MeshBuilder();
  const hay = new MeshBuilder();
  /** Boats tied up at the ghats: they ride the water and its ripples. */
  const afloat = new MeshBuilder();
  const moorings: Mooring[] = [];

  for (const h of huts) buildHouse(parts, h.x, h.y, h.z, h.ry, h.l, h.w, h.style, rng);

  // a haystack or two by most homesteads, at the foot of the mound's back corner, clear of the houses, the ways and the water
  for (const m of HOMESTEAD_MOUNDS) {
    if (rng.next() < 0.25) continue;
    const stacks = rng.next() < 0.4 ? 2 : 1;
    for (let n = 0, k = 0; n < stacks && k < 8; k++) {
      const p = shapePoint(m, -m.hu * rng.range(0.2, 0.8), rng.sign() * (m.hv + rng.range(1.5, 4)));
      if (nearBackwater(p.x, p.z, 6) || onRoad(p.x, p.z, 2.5) || huts.some((o) => Math.hypot(o.x - p.x, o.z - p.z) < 6)) continue;
      haystack(hay, parts.wood, p.x, terrainHeight(p.x, p.z) - 0.1, p.z, rng);
      n++;
    }
  }
  // the ghats, a boat tied up at every other one and a second at the village's
  ghats.forEach((g, i) => {
    if (g.kind === 'brick') brickGhat(bricks, g, rng, WATER_LEVEL, WATER_LEVEL - LOW_WATER, i === 0 ? 5 : 2.4, 8, i === 0);
    else bambooGhat(bamboo, g, rng);
    if (i % 2 === 0) mooredBoat(afloat, bamboo, moorings, g, rng);
    if (i === 0) mooredBoat(afloat, bamboo, moorings, g, rng);
  });
  zamindarBoat(afloat, bamboo, moorings, rng);

  // the ponds' ghats
  // (the mosque's pond has its own, built with the mosque: landmarks.ts mosqueGhat)
  for (const pond of PONDS) if (pond.ghat && !pond.kept) pondGhat(bricks, pond, pond.ghat, rng);

  const group = new Group();
  group.name = 'villages';
  const plaster = plasterTexture(44, { fallen: false });
  const brick = brickTexture(45);
  const textured = (set: { map: ReturnType<typeof plasterTexture>['map']; normal: ReturnType<typeof plasterTexture>['normal'] }, roughness: number, grime: number) =>
    patchMaterial(new MeshStandardMaterial({ map: set.map, normalMap: set.normal, normalScale: new Vector2(0.7, 0.7), vertexColors: true, roughness }), { grime });
  const add = (b: MeshBuilder, mat: MeshStandardMaterial, cast = true) => {
    if (!b.vertexCount) return;
    const mesh = new Mesh(b.build(), mat);
    mesh.castShadow = cast;
    mesh.receiveShadow = true;
    group.add(mesh);
  };
  add(parts.mud, textured(plaster, 0.95, 0.4));
  add(parts.wood, patchMaterial(new MeshStandardMaterial({ vertexColors: true, roughness: 0.8 }), { grime: 0.35 }));
  add(parts.thatch, patchMaterial(new MeshStandardMaterial({ map: strawTexture(41), vertexColors: true, roughness: 0.95, side: DoubleSide }), { grime: 0.3, translucency: 0.35 }));
  // galvanised and painted tin: only a little metallic (with no environment map to reflect, a metal reads black)
  add(parts.tin, patchMaterial(new MeshStandardMaterial({ map: tinTexture(42), vertexColors: true, roughness: 0.55, metalness: 0.15, side: DoubleSide }), { grime: 0.5 }));
  add(parts.mat, patchMaterial(new MeshStandardMaterial({ map: weaveTexture(46), vertexColors: true, roughness: 0.9, side: DoubleSide }), { grime: 0.3 }));
  add(bricks, textured(brick, 0.9, 0.35));
  // the culms are tubes wound inward (render/builder.ts): drawn from both sides
  add(bamboo, patchMaterial(new MeshStandardMaterial({ vertexColors: true, roughness: 0.7, side: DoubleSide }), { grime: 0.45 }));
  add(hay, patchMaterial(new MeshStandardMaterial({ map: strawTexture(43), vertexColors: true, roughness: 0.95 }), { grime: 0.25 }));
  // moored boats float on the water, each rocking as one piece on the (sheltered) ripples under its middle and
  // swinging slowly on her line about her stem; each point of a line rides with her by its share of the way
  // from its post to her (aMoor.w: 1 on the boat)
  const boats = afloat.build();
  const position = boats.getAttribute('position');
  const moor = new Float32Array(position.count * 4);
  const pivot = new Float32Array(position.count * 2);
  for (const m of moorings) {
    for (let k = m.from; k < m.to; k++) {
      moor.set([m.x, m.z, m.aground, 1], k * 4);
      pivot.set([m.stem.x, m.stem.z], k * 2);
    }
    const { post } = m.line;
    const lx = m.stem.x - post.x;
    const lz = m.stem.z - post.z;
    for (let k = m.line.from; k < m.line.to; k++) {
      const t = Math.min(1, Math.max(0, ((position.getX(k) - post.x) * lx + (position.getZ(k) - post.z) * lz) / (lx * lx + lz * lz)));
      moor.set([m.x, m.z, m.aground, t], k * 4);
      pivot.set([m.stem.x, m.stem.z], k * 2);
    }
  }
  boats.setAttribute('aMoor', new BufferAttribute(moor, 4));
  boats.setAttribute('aPivot', new BufferAttribute(pivot, 2));
  const moored = new Mesh(
    boats,
    // (two-sided: her hull's inside is its back face, world/hull.ts)
    patchMaterial(new MeshStandardMaterial({ vertexColors: true, roughness: 0.85, side: DoubleSide }), {
      grime: 0.35,
      vertex: {
        key: 'moored',
        pars: `attribute vec4 aMoor;\nattribute vec2 aPivot;\n${waveHeightGlsl()}\n${waveSlopeGlsl()}\n`,
        code: `{
  // afloat on the season's water, or aground on the mud where it has drawn back from her; on the waves as the
  // slack water by the bank is drawn round her (waves.ts surfaceShare: dying out as the bed comes up under her),
  // with a breath of her own bob so she never lies dead still
  float moorPhase = dot(aMoor.xy, vec2(0.37, 0.61));
  float still = ${WATER_LEVEL.toFixed(2)} + uWaterRise;
  float share = ${(SHELTERED * INLAND).toFixed(4)} * smoothstep(0.0, ${SHOAL_DEPTH.toFixed(2)}, still - aMoor.z + ${(MOORED_DRAFT - 0.03).toFixed(2)});
  float afloat = still + waveHeight(aMoor.xy) * share + 0.005 * sin(uTime * 0.9 + moorPhase);
  float lifted = smoothstep(aMoor.z, aMoor.z + 0.08, afloat);
  vec2 tilt = waveSlope(aMoor.xy) * share * lifted;
  // she swings slowly on her line about her stem, the more as the wind blows; aground, she lies still
  float swing = (0.035 * sin(uTime * 0.16 + moorPhase) + 0.015 * sin(uTime * 0.43 + moorPhase * 1.7)) * (0.6 + 0.5 * uWind.z) * lifted * aMoor.w;
  vec2 fromStem = transformed.xz - aPivot;
  transformed.xz = aPivot + vec2(cos(swing) * fromStem.x + sin(swing) * fromStem.y, cos(swing) * fromStem.y - sin(swing) * fromStem.x);
  transformed.y += aMoor.w * (max(afloat, aMoor.z) + dot(tilt, transformed.xz - aMoor.xy));
}`,
      },
    }),
  );
  // (no shadow: the shadow pass would draw the hulls where they are built, not lifted onto the water, and things
  // that move cast none, the shadow map not being redrawn every frame)
  moored.receiveShadow = true;
  group.add(moored);
  return group;
}
