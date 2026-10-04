import { CylinderGeometry, DoubleSide, Group, LatheGeometry, Matrix4, Mesh, MeshStandardMaterial, Quaternion, SphereGeometry, Vector2, Vector3 } from 'three';
import { Rng } from '../core/rng';
import { MeshBuilder, rgb, scaleRgb, slab, type RGB } from '../render/builder';
import { patchMaterial } from '../render/patch';
import { plasterTexture, strawTexture, tinTexture } from '../render/textures';
import { BEACON, type Beacon } from './beacons';
import {
  ADINATH,
  GORAKGHATA,
  LIGHTHOUSE,
  SHUTKI_YARDS,
  edgeHalfWidth,
  hillHeight,
  nearBackwater,
  onLandmark,
  riverX,
  saltPan,
  terrainHeight,
  villageDistance,
} from './geography';

// What makes the island Moheshkhali, and the mainland's shore across from it, built where geography.ts says:
// - Adinath temple on the level top of its hill above Gorakghata: a whitewashed Shiva temple with a curving
//   shikhara spire, a pillared porch facing the channel, two small shrines, a low wall round its terrace and
//   saffron flags, and the long stair that climbs to it from the edge of the town;
// - Gorakghata's jetty reaching out over the mud into the channel on concrete piles, railed, lamp-posted,
//   with a tin-roofed shed at its head where the boats come in (the town's buildings are the map's own:
//   world/buildings.ts);
// - the Rakhine pagoda behind the town, white and gold on its terraces;
// - betel-leaf gardens (pan baroj) on the lower slopes of the hills: long low enclosures of straw on bamboo
//   frames, the island's famous pan growing in their shade;
// - dry-fish yards (shutki) by the fishing villages at the channel's mouth: rows of bamboo racks hung with fish.
// All of it is static: it casts and takes shadows, shows in the water's mirror, and wets in the rain.

const UP = new Vector3(0, 1, 0);
const q = new Quaternion();
const mat4 = new Matrix4();
const ONE = new Vector3(1, 1, 1);

/** A part from a three geometry, placed and turned (yaw), in one colour. */
function part(b: MeshBuilder, g: ConstructorParameters<typeof Mesh>[0], x: number, y: number, z: number, ry: number, c: RGB): void {
  if (!g) return;
  b.add(g, mat4.compose(new Vector3(x, y, z), q.setFromAxisAngle(UP, ry), ONE), c);
}

/** A point in a frame at (x, z) turned by `ry`: `a` along its +x, `d` along its +z. */
function frame(x: number, z: number, ry: number): (a: number, d: number) => [number, number] {
  const cos = Math.cos(ry);
  const sin = Math.sin(ry);
  return (a, d) => [x + a * cos + d * sin, z - a * sin + d * cos];
}

interface Sets {
  white: MeshBuilder;
  paint: MeshBuilder;
  concrete: MeshBuilder;
  tin: MeshBuilder;
  straw: MeshBuilder;
  wood: MeshBuilder;
  gold: MeshBuilder;
}

const WHITE: RGB = [1.12, 1.12, 1.14];
const SAFFRON: RGB = rgb('#e07a1f');
const TEMPLE_RED: RGB = rgb('#9a2a1e');
const BAMBOO: RGB = rgb('#a88a58');

// ---------- Adinath temple ----------

/** The temple on Adinath hill's level top, its porch toward the channel (−x), and its terrace and wall. */
function temple(s: Sets, rng: Rng): void {
  const x0 = riverX(ADINATH.z) + ADINATH.u;
  const z0 = ADINATH.z;
  const y0 = terrainHeight(x0, z0) + 0.05;
  const ry = Math.PI / 2; // the frame's +x points toward −z: the porch (frame +z) faces the channel (world −x)
  const at = frame(x0, z0, ry);
  // the terrace, paved and whitewashed, and the low wall round it with a gap where the stair comes in
  const [tx, tz] = at(0, 0);
  slab(s.white, tx, y0 - 0.4, tz, 22, 1.0, 17, ry, scaleRgb(WHITE, 0.92));
  for (const [a, d, l, w] of [
    [0, -8.3, 22, 0.3],
    [-10.85, 0, 0.3, 16.6],
    [10.85, -3, 0.3, 10.6],
    [-5.5, 8.3, 11, 0.3],
    [7.5, 8.3, 7, 0.3],
  ] as const) {
    const [wx, wz] = at(a, d);
    slab(s.white, wx, y0 + 0.45, wz, l, 0.8, w, ry, WHITE);
  }
  // the temple as Banglapedia gives it: 10.5 m long, 9.75 m wide, 6 m high. The sanctum (6 m square) at the
  // back under its curving spire, tiers drawn in toward a ribbed amalaka, a kalash and a trident; the porch, as
  // wide as the temple, in front of it (how the length is shared between them is [মডেল])
  const SANCTUM = { d: -2.25, half: 3, wall: 2.8 };
  const [sx, sz] = at(0, SANCTUM.d);
  slab(s.white, sx, y0 + SANCTUM.wall / 2, sz, SANCTUM.half * 2, SANCTUM.wall, SANCTUM.half * 2, ry, WHITE);
  slab(s.white, sx, y0 + SANCTUM.wall + 0.15, sz, SANCTUM.half * 2 + 0.4, 0.3, SANCTUM.half * 2 + 0.4, ry, SAFFRON);
  // the rekha spire: thin courses drawn in along a curve that rises straight and bends in toward the top,
  // a rib down the middle of each face, a saffron band now and then; it tops out at 6 m
  const tiers = 9;
  const course = 0.35;
  for (let i = 0; i < tiers; i++) {
    const t = i / tiers;
    const half = 2.6 * Math.pow(Math.cos((t * Math.PI) / 2), 0.75) + 0.3;
    const y = y0 + SANCTUM.wall + 0.3 + i * course + course / 2;
    slab(s.white, sx, y, sz, half * 2, course, half * 2, ry, i % 4 === 3 ? scaleRgb(SAFFRON, 1.05) : WHITE);
    for (const [a, d, w, l] of [
      [0, half + 0.08, 0.9 * half, 0.16],
      [0, -half - 0.08, 0.9 * half, 0.16],
      [half + 0.08, 0, 0.16, 0.9 * half],
      [-half - 0.08, 0, 0.16, 0.9 * half],
    ] as const) {
      const [rx, rz] = at(a, SANCTUM.d + d);
      slab(s.white, rx, y, rz, w, course, l, ry, scaleRgb(WHITE, 0.96));
    }
  }
  const top = y0 + SANCTUM.wall + 0.3 + tiers * course;
  part(s.white, new LatheGeometry([[0, 0], [0.6, 0.05], [0.72, 0.16], [0.6, 0.3], [0, 0.34]].map(([r, y]) => new Vector2(r, y)), 16), sx, top, sz, 0, WHITE);
  part(s.gold, new LatheGeometry([[0, 0], [0.26, 0.06], [0.3, 0.24], [0.16, 0.44], [0.06, 0.5], [0.1, 0.58], [0, 0.68]].map(([r, y]) => new Vector2(r, y)), 12), sx, top + 0.34, sz, 0, [1, 1, 1]);
  part(s.gold, new CylinderGeometry(0.02, 0.02, 1.0, 6), sx, top + 1.5, sz, 0, [1, 1, 1]);
  for (const a of [-0.15, 0, 0.15]) {
    const [px, pz] = at(a, SANCTUM.d);
    part(s.gold, new CylinderGeometry(0.018, 0.01, a === 0 ? 0.36 : 0.26, 5), px, top + 2.1, pz, 0, [1, 1, 1]);
  }
  // the dark doorway, toward the porch
  const [dx, dz] = at(0, SANCTUM.d + SANCTUM.half + 0.02);
  slab(s.paint, dx, y0 + 1.1, dz, 1.1, 2.1, 0.06, ry, rgb('#2a1a12'));
  // the porch: as wide as the temple (9.75 m) and 4.5 m deep, a floor, pillars, a flat roof with a little
  // parapet and a saffron band round its eaves
  const PORCH = { d: SANCTUM.d + SANCTUM.half + 2.25, depth: 4.5, width: 9.75, roof: 3 };
  const [px, pz] = at(0, PORCH.d);
  slab(s.white, px, y0 + 0.15, pz, PORCH.width, 0.3, PORCH.depth, ry, WHITE);
  for (const [a, d] of [
    [-4.5, 2.0],
    [-1.6, 2.0],
    [1.6, 2.0],
    [4.5, 2.0],
    [-4.5, -1.9],
    [4.5, -1.9],
  ]) {
    const [cx, cz] = at(a, PORCH.d + d);
    part(s.white, new CylinderGeometry(0.17, 0.2, PORCH.roof - 0.3, 10), cx, y0 + 0.3 + (PORCH.roof - 0.3) / 2, cz, 0, WHITE);
  }
  slab(s.white, px, y0 + PORCH.roof + 0.15, pz, PORCH.width + 0.2, 0.35, PORCH.depth + 0.2, ry, WHITE);
  slab(s.paint, px, y0 + PORCH.roof - 0.08, pz, PORCH.width + 0.25, 0.12, PORCH.depth + 0.25, ry, SAFFRON);
  const [qx, qz] = at(0, PORCH.d + PORCH.depth / 2);
  slab(s.white, qx, y0 + PORCH.roof + 0.5, qz, PORCH.width + 0.2, 0.35, 0.2, ry, WHITE);
  // two small shrines at the terrace's corners
  for (const a of [-7.5, 7.5]) {
    const [cx, cz] = at(a, -4.5);
    slab(s.white, cx, y0 + 0.9, cz, 1.8, 1.8, 1.8, ry, WHITE);
    for (let i = 0; i < 4; i++) slab(s.white, cx, y0 + 1.95 + i * 0.36, cz, 1.9 - i * 0.42, 0.36, 1.9 - i * 0.42, ry, i === 3 ? SAFFRON : WHITE);
    part(s.gold, new SphereGeometry(0.12, 8, 6), cx, y0 + 3.45, cz, 0, [1, 1, 1]);
    const [ex, ez] = at(a, -3.6);
    slab(s.paint, ex, y0 + 0.75, ez, 0.6, 1.1, 0.04, ry, TEMPLE_RED);
  }
  // saffron flags on tall bamboo poles at the front corners, and a bell frame by the steps
  for (const a of [-9.8, 9.8]) {
    const [fx, fz] = at(a, 7.6);
    part(s.wood, new CylinderGeometry(0.05, 0.06, 7, 6), fx, y0 + 3.5, fz, 0, BAMBOO);
    const flag = new MeshBuilder();
    const base = new Vector3(fx, y0 + 6.9, fz);
    const n = new Vector3(0, 0, 1);
    const f0 = flag.vertex(base, n, 0, 0, SAFFRON);
    flag.vertex(base.clone().add(new Vector3(0, -0.8, 0)), n, 0, 1, SAFFRON);
    flag.vertex(base.clone().add(new Vector3(0, -0.4, 1.3 + rng.range(-0.1, 0.1))), n, 1, 0.5, scaleRgb(SAFFRON, 0.9));
    flag.tri(f0, f0 + 1, f0 + 2);
    flag.tri(f0, f0 + 2, f0 + 1);
    s.paint.add(flag.build(), new Matrix4(), [1, 1, 1]);
  }
  const [bx, bz] = at(3.5, 6.8);
  slab(s.wood, bx - 0.6, y0 + 1.1, bz, 0.12, 2.2, 0.12, ry, rgb('#5a3a24'));
  slab(s.wood, bx + 0.6, y0 + 1.1, bz, 0.12, 2.2, 0.12, ry, rgb('#5a3a24'));
  slab(s.wood, bx, y0 + 2.2, bz, 1.4, 0.12, 0.12, ry, rgb('#5a3a24'));
  part(s.gold, new LatheGeometry([[0, 0], [0.2, 0.02], [0.17, 0.25], [0.06, 0.32], [0, 0.34]].map(([r, y]) => new Vector2(r, y)), 10), bx, y0 + 1.75, bz, 0, [0.9, 0.85, 0.7]);
}

/** The long stair up Adinath hill: steps cut into the slope, a whitewashed wall either side, a gate at its foot. */
function stair(s: Sets): void {
  const { from, to } = GORAKGHATA.stair;
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const run = Math.hypot(dx, dz);
  const ry = Math.atan2(dx, dz);
  const n = Math.ceil(run / 0.42);
  let last = -Infinity;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const x = from.x + dx * t;
    const z = from.z + dz * t;
    // each step at least level with the one below it, never sinking back
    const y = Math.max(terrainHeight(x, z) + 0.08, last);
    last = y;
    slab(s.white, x, y - 0.35, z, 2.4, 0.7, 0.48, ry, scaleRgb(WHITE, 0.82 + (i % 2) * 0.04), 1.5);
    for (const side of [-1, 1]) {
      const wx = x + Math.cos(ry) * side * 1.35;
      const wz = z - Math.sin(ry) * side * 1.35;
      slab(s.white, wx, y + 0.1, wz, 0.28, 1.0, 0.48, ry, WHITE, 1.5);
    }
  }
  // the gate at its foot: two pillars and a lintel, painted
  const y = terrainHeight(from.x, from.z);
  for (const side of [-1, 1]) {
    const gx = from.x + Math.cos(ry) * side * 1.7;
    const gz = from.z - Math.sin(ry) * side * 1.7;
    slab(s.white, gx, y + 1.5, gz, 0.6, 3.0, 0.6, ry, WHITE);
  }
  slab(s.paint, from.x, y + 3.15, from.z, 4.2, 0.45, 0.7, ry, SAFFRON);
}

// ---------- Gorakghata ----------

/** The decks stand clear of the highest tide (≈2.7 m: env/tide.ts) [মডেল: their heights are not published]. */
const DECK = 3.3;

interface JettySpec {
  /** Landward end and head (world), its length (m) between them, and its deck's width (m, real). */
  x: number;
  z: number;
  toX: number;
  toZ: number;
  length: number;
  width: number;
  /** How far it is set to the side of that line (m; + to its left, north for Gorakghata's). */
  offset: number;
  /** A shed for those waiting at a broad head, or a T-shaped head across it. */
  head: 'shed' | 'tee';
}

/** A jetty: out from the bank over the mud on concrete piles into the channel, railed and lit, with its head. */
function jetty(s: Sets, j: JettySpec): void {
  // in the jetty's frame: `a` out from its landward end toward its head (OSM's line), `c` across it
  const ry = Math.atan2(j.toZ - j.z, -(j.toX - j.x));
  const at = frame(j.x, j.z, ry);
  const A = (a: number, c: number) => at(-a, c + j.offset);
  const box = (b: MeshBuilder, a: number, y: number, c: number, along: number, h: number, across: number, col: RGB, tile?: number) => {
    const [x, z] = A(a, c);
    slab(b, x, y, z, along, h, across, ry, col, tile);
  };
  /** A pile from the deck down into the mud at (a, c). */
  const pile = (a: number, c: number, r: number) => {
    const [x, z] = A(a, c);
    const bed = Math.min(terrainHeight(x, z), DECK - 1);
    const h = DECK - 0.36 - bed + 0.8;
    part(s.concrete, new CylinderGeometry(r, r * 1.08, h, 8), x, bed - 0.8 + h / 2, z, ry, rgb('#9e9a90'));
  };
  const post = (b: MeshBuilder, g: CylinderGeometry, a: number, y: number, c: number, col: RGB) => {
    const [x, z] = A(a, c);
    part(b, g, x, y, z, ry, col);
  };
  // from the top of the bank, 14 m inland of where OSM's line leaves it, to its head
  const start = -14;
  const end = j.length;
  const mid = (start + end) / 2;
  const half = j.width / 2;
  box(s.concrete, mid, DECK - 0.18, 0, end - start, 0.36, j.width, rgb('#b8b4aa'), 2);
  for (let a = start + 3; a < end; a += 5) {
    for (const side of [-1, 1]) pile(a, side * (half - 1.7), 0.22);
    // a cross beam under the deck
    box(s.concrete, a, DECK - 0.55, 0, 0.35, 0.4, j.width + 0.3, rgb('#a29e94'), 2);
  }
  // railings: posts and two rails a side; lamp posts every so often
  for (let a = start + 1; a < end - 1; a += 2) {
    for (const side of [-1, 1]) box(s.paint, a, DECK + 0.5, side * (half - 0.06), 0.08, 1.0, 0.08, rgb('#d8d4c8'), 1);
  }
  for (const side of [-1, 1]) {
    for (const h of [0.55, 0.98]) box(s.paint, mid, DECK + h, side * (half - 0.06), end - start, 0.06, 0.07, rgb('#d8d4c8'), 1);
  }
  for (let a = start + 6; a < end; a += 15) {
    post(s.concrete, new CylinderGeometry(0.06, 0.08, 4.2, 6), a, DECK + 2.1, half + 0.15, rgb('#6a6a6a'));
    box(s.paint, a, DECK + 4.25, half - 0.3, 0.3, 0.14, 0.9, rgb('#e8e2c8'), 1);
  }
  if (j.head === 'shed') {
    // a broader landing, a tin-roofed shed for those waiting for the boats, steps down toward the water
    box(s.concrete, end + 3, DECK - 0.18, 0, 6.5, 0.36, 9, rgb('#b8b4aa'), 2);
    for (const [oa, oc] of [
      [5.2, -3.6],
      [0.8, -3.6],
      [5.2, 3.6],
      [0.8, 3.6],
    ]) {
      pile(end + oa, oc, 0.22);
      box(s.paint, end + oa, DECK + 1.3, oc, 0.14, 2.6, 0.14, rgb('#3e5a6a'), 1);
    }
    box(s.tin, end + 3, DECK + 2.68, 0, 5.6, 0.1, 8.4, rgb('#c8c2b8'), 2);
  } else {
    // a T: a landing across the head, piled, where the boats lie alongside
    box(s.concrete, end + 2.5, DECK - 0.18, 0, 5, 0.36, 30, rgb('#b8b4aa'), 2);
    for (let c = -14; c <= 14; c += 4) for (const oa of [0.6, 4.4]) pile(end + oa, c, 0.24);
    for (const side of [-1, 1]) box(s.paint, end + 4.9, DECK + 0.55, side * 8, 0.07, 0.06, 13, rgb('#d8d4c8'), 1);
  }
  // steps down the head toward the water: at low tide they end over the mud, and the boats wait out in the channel
  for (let k = 0; k < 10; k++) box(s.concrete, end + 6.6, DECK - 0.3 - k * 0.32, -3, 0.9, 0.3, 2.4, rgb('#a8a49a'), 1);
}

/** Gorakghata's two jetties side by side, and the Adinath jetty below the temple. */
function jetties(): JettySpec[] {
  const g = GORAKGHATA;
  return [
    { ...g.jetty, offset: 0, head: 'shed' },
    { ...g.jetty, width: g.newJetty.width, offset: g.newJetty.offset, head: 'shed' },
    { ...g.adinathJetty, offset: 0, head: 'tee' },
  ];
}

/** A flat deck one can walk on: its middle, the way it runs (unit), its half-length and half-width (m), its top. */
export interface Deck {
  x: number;
  z: number;
  ux: number;
  uz: number;
  half: number;
  wide: number;
  top: number;
}

/** The jetties' decks and their heads' landings, as built, for walking on them (world/walkable.ts). */
export function jettyDecks(): Deck[] {
  const out: Deck[] = [];
  for (const j of jetties()) {
    const ry = Math.atan2(j.toZ - j.z, -(j.toX - j.x));
    const at = frame(j.x, j.z, ry);
    const A = (a: number, c: number) => at(-a, c + j.offset);
    // the frame's −a runs out toward the head
    const [x0, z0] = A(0, 0);
    const [x1, z1] = A(1, 0);
    const ux = x1 - x0;
    const uz = z1 - z0;
    const deck = (a0: number, a1: number, wide: number) => {
      const [cx, cz] = A((a0 + a1) / 2, 0);
      out.push({ x: cx, z: cz, ux, uz, half: (a1 - a0) / 2, wide, top: DECK });
    };
    deck(-14, j.length, j.width / 2);
    if (j.head === 'shed') deck(j.length - 0.25, j.length + 6.25, 4.5);
    else deck(j.length, j.length + 5, 15);
  }
  return out;
}

/** The stair up to the temple as built: the height of its tread at (x, z), or null off it. */
export function stairAt(x: number, z: number): number | null {
  const s = STAIR_STEPS();
  const dx = x - s.from.x;
  const dz = z - s.from.z;
  const t = (dx * s.ux + dz * s.uz) / s.run;
  if (t < -0.02 || t > 1.02) return null;
  if (Math.abs(-dx * s.uz + dz * s.ux) > 1.2) return null;
  const i = Math.max(0, Math.min(s.heights.length - 1, Math.round(t * (s.heights.length - 1))));
  return s.heights[i];
}

let stairSteps: { from: { x: number; z: number }; ux: number; uz: number; run: number; heights: number[] } | null = null;
/** The stair's steps, each at least level with the one below it (stair() builds the same). */
function STAIR_STEPS(): { from: { x: number; z: number }; ux: number; uz: number; run: number; heights: number[] } {
  if (stairSteps) return stairSteps;
  const { from, to } = GORAKGHATA.stair;
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const run = Math.hypot(dx, dz);
  const n = Math.ceil(run / 0.42);
  const heights: number[] = [];
  let last = -Infinity;
  for (let i = 0; i <= n; i++) {
    const y = Math.max(terrainHeight(from.x + (dx * i) / n, from.z + (dz * i) / n) + 0.08, last);
    heights.push(y);
    last = y;
  }
  stairSteps = { from, ux: dx / run, uz: dz / run, run, heights };
  return stairSteps;
}

/** The Rakhine pagoda: three square terraces, a bell-shaped stupa, its spire of rings, a golden hti. */
function pagoda(s: Sets): void {
  const p = GORAKGHATA.pagoda;
  const y = terrainHeight(p.x, p.z);
  for (let i = 0; i < 3; i++) slab(s.white, p.x, y + 0.45 + i * 0.9, p.z, 9 - i * 2.2, 0.9, 9 - i * 2.2, 0.3, WHITE);
  part(
    s.white,
    new LatheGeometry([[0, 0], [2.0, 0], [2.1, 0.3], [1.8, 1.4], [1.3, 2.4], [0.8, 3.1], [0.5, 3.4], [0, 3.5]].map(([r, y2]) => new Vector2(r, y2)), 20),
    p.x,
    y + 2.7,
    p.z,
    0,
    WHITE,
  );
  for (let i = 0; i < 6; i++) part(s.white, new CylinderGeometry(0.45 - i * 0.06, 0.5 - i * 0.06, 0.32, 14), p.x, y + 6.3 + i * 0.36, p.z, 0, WHITE);
  part(s.gold, new LatheGeometry([[0, 0], [0.22, 0.05], [0.16, 0.6], [0.05, 1.5], [0, 1.9]].map(([r, y2]) => new Vector2(r, y2)), 10), p.x, y + 8.4, p.z, 0, [1, 1, 1]);
  part(s.gold, new CylinderGeometry(0.35, 0.05, 0.4, 10), p.x, y + 9.2, p.z, 0, [1, 1, 1]);
}

// ---------- the island's pan and fish ----------

/** Betel-leaf gardens on the hills' lower slopes: long, low enclosures of straw on bamboo, the pan vines in their shade. */
function betelGardens(sets: Map<number, Sets>, rng: Rng): void {
  let placed = 0;
  for (let k = 0; k < 4000 && placed < 16; k++) {
    // along the island's hills, from Gorakghata north past Shaplapur
    const z = rng.range(-200, 3600);
    const x = riverX(z) + edgeHalfWidth(z, 1) + rng.range(110, 950);
    const hh = hillHeight(x, z);
    if (hh < 0.6 || hh > 7 || villageDistance(x, z) < 1.4 || nearBackwater(x, z, 10) || onLandmark(x, z, 12) || saltPan(x, z) > 0.1) continue;
    const l = rng.range(16, 24);
    const w = rng.range(7, 9);
    const ry = rng.range(-0.2, 0.2);
    // set into the slope: on its lowest corner, walls reaching down to the ground everywhere
    let y = Infinity;
    for (const [a, d] of [
      [-1, -1],
      [1, -1],
      [-1, 1],
      [1, 1],
    ]) {
      const [cx, cz] = frame(x, z, ry)(a * w * 0.5, d * l * 0.5);
      y = Math.min(y, terrainHeight(cx, cz));
    }
    const top = terrainHeight(x, z) + 2.2;
    const h = top - y;
    // gardens near each other share their meshes (cells of 500 m), so the far ones can be left undrawn
    const key = Math.floor(z / 500) * 64 + Math.floor(x / 500);
    let s = sets.get(key);
    if (!s) sets.set(key, (s = newSets()));
    slab(s.straw, x, y + h / 2 - 0.2, z, w, h + 0.4, l, ry, rgb('#b09060'), 1.6);
    slab(s.straw, x, top + 0.25, z, w + 0.6, 0.15, l + 0.6, ry, rgb('#9c8050'), 1.6);
    // bamboo corner posts showing through the straw
    for (const [a, d] of [
      [-1, -1],
      [1, -1],
      [-1, 1],
      [1, 1],
    ]) {
      const [cx, cz] = frame(x, z, ry)(a * (w * 0.5 + 0.05), d * (l * 0.5 + 0.05));
      part(s.wood, new CylinderGeometry(0.06, 0.07, h + 0.6, 6), cx, y + h / 2, cz, 0, BAMBOO);
    }
    placed++;
  }
}

/** A dry-fish yard: rows of bamboo racks, the fish hung in lines along their rails. */
function shutkiYard(s: Sets, rng: Rng, x0: number, z0: number, ry: number, rows: number): void {
  const at = frame(x0, z0, ry);
  const fish = rgb('#b8b2a2');
  for (let r = 0; r < rows; r++) {
    const d = (r - (rows - 1) / 2) * 3.2;
    const [cx, cz] = at(0, d);
    const y = terrainHeight(cx, cz);
    for (let a = -4; a <= 4; a += 2) {
      const [px, pz] = at(a, d);
      part(s.wood, new CylinderGeometry(0.04, 0.05, 1.7, 5), px, y + 0.8, pz, 0, BAMBOO);
    }
    for (const hgt of [0.9, 1.5]) {
      slab(s.wood, cx, y + hgt, cz, 8.4, 0.05, 0.05, ry, BAMBOO, 1);
      // the fish, hung head down in a row along the rail
      for (let a = -4; a < 4; a += 0.16) {
        const [fx, fz] = at(a + rng.range(-0.03, 0.03), d);
        slab(s.paint, fx, y + hgt - 0.17, fz, 0.035, 0.3, 0.006, ry, scaleRgb(fish, rng.range(0.8, 1.1)), 1);
      }
    }
  }
}

const newSets = (): Sets => ({
  white: new MeshBuilder(),
  paint: new MeshBuilder(),
  concrete: new MeshBuilder(),
  tin: new MeshBuilder(),
  straw: new MeshBuilder(),
  wood: new MeshBuilder(),
  gold: new MeshBuilder(),
});

/**
 * The landmarks, as groups: `seen` (Adinath temple and its stair, Gorakghata's jetty and the pagoda, which show
 * from afar), and `near` (the betel gardens and dry-fish yards, small things left undrawn far off; see cull.ts).
 */
/**
 * Cox's Bazar's lighthouse, the new one (≈2023, Rowlett's Lighthouse Directory): a 34 m octagonal concrete tower
 * in red and white bands with its watch room, gallery and lantern, on the top of its ridge (the light 74 m over
 * the sea), a walkway across to a three-storey block beside it [মডেল: which side, and the block's size]. Its
 * light, a white flash every 15 s, goes into `lights`.
 */
function lighthouse(s: Sets, lights: Beacon[]): void {
  const { x, z } = LIGHTHOUSE;
  const y = terrainHeight(x, z) - 0.5;
  const H = 34;
  const RED: RGB = rgb('#b3261e');
  const SHAFT = H - 6;
  const BANDS = 8;
  const radius = (h: number) => 3.1 - (0.9 * h) / SHAFT;
  for (let i = 0; i < BANDS; i++) {
    const h0 = (SHAFT * i) / BANDS;
    const h1 = (SHAFT * (i + 1)) / BANDS;
    part(s.paint, new CylinderGeometry(radius(h1), radius(h0), h1 - h0, 8), x, y + (h0 + h1) / 2, z, Math.PI / 8, i % 2 ? RED : WHITE);
  }
  // the watch room, the gallery round it with its railing, the lantern's glass, its dome and vent
  part(s.paint, new CylinderGeometry(2.2, 2.2, 2.6, 8), x, y + SHAFT + 1.3, z, Math.PI / 8, WHITE);
  part(s.concrete, new CylinderGeometry(3.1, 3.0, 0.3, 8), x, y + SHAFT + 2.75, z, Math.PI / 8, WHITE);
  for (let k = 0; k < 16; k++) {
    const a = (k / 16) * Math.PI * 2;
    part(s.concrete, new CylinderGeometry(0.04, 0.04, 1.0, 4), x + Math.cos(a) * 2.95, y + SHAFT + 3.4, z + Math.sin(a) * 2.95, 0, WHITE);
  }
  part(s.concrete, new CylinderGeometry(2.97, 2.97, 0.06, 16), x, y + SHAFT + 3.9, z, 0, WHITE);
  // the lantern: glass between eight thin mullions (left open, so its light shows through), the lamp inside
  for (let k = 0; k < 8; k++) {
    const a = ((k + 0.5) / 8) * Math.PI * 2;
    part(s.concrete, new CylinderGeometry(0.06, 0.06, 2.4, 4), x + Math.cos(a) * 1.5, y + SHAFT + 4.1, z + Math.sin(a) * 1.5, 0, rgb('#3a3f42'));
  }
  part(s.concrete, new SphereGeometry(0.35, 8, 6), x, y + SHAFT + 4.1, z, 0, rgb('#e8e2c8'));
  part(s.paint, new SphereGeometry(1.6, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2), x, y + SHAFT + 5.3, z, 0, RED);
  part(s.paint, new CylinderGeometry(0.15, 0.25, 0.9, 6), x, y + SHAFT + 7.1, z, 0, RED);
  // the three-storey block beside it and the walkway across at its second floor
  const bx = x - 12;
  slab(s.white, bx, y + 5.4, z, 9, 10.8, 12, 0, WHITE);
  slab(s.concrete, bx, y + 10.9, z, 9.4, 0.25, 12.4, 0, WHITE);
  slab(s.concrete, x - 5.4, y + 7.4, z, 5.2, 0.3, 1.8, 0, WHITE);
  lights.push({ x, y: y + SHAFT + 4.1, z, kind: BEACON.lighthouse });
}

export function buildMoheshkhali(): { seen: Group; near: Group; lights: Beacon[] } {
  const seen = new Group();
  seen.name = 'moheshkhali';
  const near = new Group();
  near.name = 'moheshkhali-near';
  const rng = new Rng(523);
  const town = newSets();
  temple(town, rng);
  stair(town);
  for (const j of jetties()) jetty(town, j);
  pagoda(town);
  const lights: Beacon[] = [];
  lighthouse(town, lights);
  const gardens = new Map<number, Sets>();
  betelGardens(gardens, rng);
  const yards = SHUTKI_YARDS.map((y) => {
    const s = newSets();
    shutkiYard(s, rng, y.x, y.z, y.ry, y.rows);
    return s;
  });

  const plaster = plasterTexture(531);
  const plasterMat = (tint: string, roughness: number) =>
    patchMaterial(new MeshStandardMaterial({ map: plaster.map, normalMap: plaster.normal, color: tint, vertexColors: true, roughness }), { grime: 0.3 });
  const mats: Record<keyof Sets, MeshStandardMaterial> = {
    white: plasterMat('#ffffff', 0.9),
    paint: plasterMat('#ffffff', 0.85),
    concrete: plasterMat('#b0aca4', 0.9),
    tin: patchMaterial(new MeshStandardMaterial({ map: tinTexture(532), vertexColors: true, roughness: 0.5, metalness: 0.4, side: DoubleSide }), { grime: 0.4 }),
    straw: patchMaterial(new MeshStandardMaterial({ map: strawTexture(533), vertexColors: true, roughness: 0.95 }), { grime: 0.25 }),
    wood: patchMaterial(new MeshStandardMaterial({ vertexColors: true, roughness: 0.8 }), { grime: 0.3 }),
    gold: patchMaterial(new MeshStandardMaterial({ color: '#c9a23a', vertexColors: true, roughness: 0.35, metalness: 0.7 }), {}),
  };
  const add = (s: Sets, into: Group) => {
    for (const key of Object.keys(s) as (keyof Sets)[]) {
      if (!s[key].vertexCount) continue;
      const mesh = new Mesh(s[key].build(), mats[key]);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      into.add(mesh);
    }
  };
  add(town, seen);
  for (const g of gardens.values()) add(g, near);
  for (const y of yards) add(y, near);
  return { seen, near, lights };
}
