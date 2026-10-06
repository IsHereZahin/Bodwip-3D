import { BufferAttribute, DoubleSide, Euler, Group, Matrix4, Mesh, MeshStandardMaterial, Quaternion, Vector2, Vector3 } from 'three';
import { Rng } from '../core/rng';
import { MeshBuilder, mixRgb, rgb, scaleRgb, slab, taperedTube, type RGB } from '../render/builder';
import { patchMaterial } from '../render/patch';
import { brickTexture, plasterTexture, strawTexture, tinTexture, weaveTexture } from '../render/textures';
import { HOMESTEAD_MOUNDS, PONDS, WATER_LEVEL, bankAt, nearBackwater, onRoad, pondReach, shapePoint, terrainHeight, type Mound, type Pond } from './geography';
import { buildHouse, haystack, type HouseParts, type HouseStyle } from './houses';
import { HUB_GHAT } from './plan';
import { buildHull, type HullShape } from './hull';
import { SHELTERED, waveHeightGlsl, waveSlopeGlsl } from './waves';
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
 * Brick steps laid down the bank square to it, from a landing at its top into the water, each tread on the
 * bank's own slope (so the flight follows the bank as it steepens toward the water), between low walls that
 * run down with them; damp and dark where the water reaches.
 */
function brickGhat(b: MeshBuilder, g: { x: number; z: number; up: number }, rng: Rng, level = WATER_LEVEL, width = 2.4, reach = 8, seats = false): void {
  const ux = Math.sin(g.up);
  const uz = Math.cos(g.up);
  const cx = Math.cos(g.up);
  const cz = -Math.sin(g.up);
  const at = (d: number, s = 0) => ({ x: g.x + ux * d + cx * s, z: g.z + uz * d + cz * s });
  const tread = 0.42;
  const tone = (y: number) => scaleRgb(mixRgb(BRICK, DAMP, 1 - Math.min(1, Math.max(0, (y - level + 0.2) / 0.9))), rng.range(0.9, 1.05));
  // the treads, down from the top of the bank into the water: each at the highest ground under it
  const n = Math.round((reach + 1.4) / tread);
  for (let i = 0; i < n; i++) {
    const d = reach - i * tread;
    let y = -Infinity;
    for (const s of [-width / 2, 0, width / 2]) {
      const p = at(d, s);
      y = Math.max(y, terrainHeight(p.x, p.z));
    }
    y = Math.max(y + 0.06, level - 0.45);
    const p = at(d);
    slab(b, p.x, y - 0.4, p.z, width, 0.8, tread + 0.04, g.up, tone(y), 0.6);
    // the walls either side, a little above the treads
    for (const side of [-1, 1]) {
      const w = at(d, side * (width / 2 + 0.17));
      slab(b, w.x, y - 0.18, w.z, 0.34, 0.86, tread + 0.04, g.up, tone(y), 0.6);
    }
  }
  // the landing at the top, a little proud of the ground, its walls ending in two low pillars
  const top = at(reach + 1);
  const ty = terrainHeight(top.x, top.z);
  slab(b, top.x, ty - 0.12, top.z, width + 0.68, 0.36, 1.8, g.up, tone(ty), 0.6);
  for (const side of [-1, 1]) {
    const pz = at(reach + 0.2, side * (width / 2 + 0.17));
    slab(b, pz.x, ty + 0.2, pz.z, 0.42, 0.7, 0.42, g.up, tone(ty), 0.6);
    // the village's ghat has its rowak: a plastered bench each side at the top, where people sit by the water
    if (seats) {
      const r = at(reach + 0.4, side * (width / 2 + 1.5));
      slab(b, r.x, terrainHeight(r.x, r.z) + 0.22, r.z, 1.9, 0.7, 2.6, g.up, tone(ty + 1), 0.6);
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
  brickGhat(b, { x, z, up: Math.atan2(at.x - pond.x, at.z - pond.z) }, rng, pond.level, 1.8, 3.2);
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

/**
 * Where each boat tied up in the `afloat` builder lies: its vertices, its middle (for the waves under it), and
 * the water's level below which she sits on the mud (the bed under her keel: in the dry months the water draws
 * back from the banks and leaves the boats tied close in aground).
 */
interface Mooring {
  from: number;
  to: number;
  x: number;
  z: number;
  aground: number;
}

/** How far a moored boat's keel lies under the water (m): her hull's keel below her origin, less the origin's height over the water. */
const MOORED_DRAFT = 0.15;

/** Adds a moored boat's hull to `b` and notes where it lies. */
function moor(b: MeshBuilder, moorings: Mooring[], hull: MeshBuilder, m: Matrix4): void {
  const from = b.vertexCount;
  b.add(hull.build(), m, rgb('#3a2c20'));
  const x = m.elements[12];
  const z = m.elements[14];
  // sunk a few centimetres into the mud when the water has left her
  moorings.push({ from, to: b.vertexCount, x, z, aground: terrainHeight(x, z) + MOORED_DRAFT - 0.03 });
}

/** A small boat tied up beside a ghat, along the bank, close in (the water's middle stays open). */
function mooredBoat(b: MeshBuilder, moorings: Mooring[], g: Ghat, rng: Rng): void {
  const hull = new MeshBuilder();
  buildHull(hull, SMALL_BOAT, { tar: rgb('#2a2018'), top: rgb('#5a4a38') });
  const s = g.s + rng.sign() * rng.range(5, 7);
  const p = g.way.at(s);
  const e = g.way.beside(s, g.side, g.way.half(s) - 2.4);
  const m = new Matrix4().compose(
    new Vector3(e.x, 0.05, e.z),
    new Quaternion().setFromEuler(new Euler(rng.range(-0.04, 0.04), p.heading + rng.range(-0.15, 0.15), g.side * rng.range(0.02, 0.06))),
    new Vector3(1, 1, 1),
  );
  moor(b, moorings, hull, m);
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
    if (g.kind === 'brick') brickGhat(bricks, g, rng, WATER_LEVEL, i === 0 ? 5 : 2.4, 8, i === 0);
    else bambooGhat(bamboo, g, rng);
    if (i % 2 === 0) mooredBoat(afloat, moorings, g, rng);
    if (i === 0) mooredBoat(afloat, moorings, g, rng);
  });

  // the ponds' ghats
  for (const pond of PONDS) if (pond.ghat) pondGhat(bricks, pond, pond.ghat, rng);

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
  // moored boats float on the water, each rocking as one piece on the (sheltered) ripples under its middle
  const boats = afloat.build();
  const middles = new Float32Array(boats.getAttribute('position').count * 3);
  for (const m of moorings) for (let k = m.from; k < m.to; k++) middles.set([m.x, m.z, m.aground], k * 3);
  boats.setAttribute('aMoor', new BufferAttribute(middles, 3));
  const moored = new Mesh(
    boats,
    // (two-sided: her hull's inside is its back face, world/hull.ts)
    patchMaterial(new MeshStandardMaterial({ vertexColors: true, roughness: 0.85, side: DoubleSide }), {
      grime: 0.35,
      vertex: {
        key: 'moored',
        pars: `attribute vec3 aMoor;\n${waveHeightGlsl()}\n${waveSlopeGlsl()}\n`,
        code: `{
  // afloat on the season's water, or aground on the mud where it has drawn back from her
  float afloat = ${WATER_LEVEL.toFixed(2)} + uWaterRise + waveHeight(aMoor.xy) * ${SHELTERED.toFixed(2)};
  vec2 tilt = waveSlope(aMoor.xy) * ${SHELTERED.toFixed(2)} * smoothstep(aMoor.z, aMoor.z + 0.08, afloat);
  transformed.y += max(afloat, aMoor.z) + dot(tilt, transformed.xz - aMoor.xy);
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
