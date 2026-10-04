import { CylinderGeometry, DoubleSide, Group, LatheGeometry, Matrix4, Mesh, MeshStandardMaterial, Quaternion, SphereGeometry, Vector2, Vector3 } from 'three';
import { Rng } from '../core/rng';
import { MeshBuilder, mixRgb, rgb, scaleRgb, type RGB } from '../render/builder';
import { patchMaterial } from '../render/patch';
import { plasterTexture, strawTexture, tinTexture } from '../render/textures';
import {
  ADINATH,
  COXS_BAZAR,
  GORAKGHATA,
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
//   with a tin-roofed shed at its head where the boats come in; the brick buildings of the bank road by it,
//   shops below and flat roofs above, and the town's mosque;
// - the Rakhine pagoda behind the town, white and gold on its terraces;
// - betel-leaf gardens (pan baroj) on the lower slopes of the hills: long low enclosures of straw on bamboo
//   frames, the island's famous pan growing in their shade;
// - dry-fish yards (shutki) by the fishing villages at the channel's mouth: rows of bamboo racks hung with fish;
// - and across the mouth on the mainland, the buildings of Cox's Bazar.
// All of it is static: it casts and takes shadows, shows in the water's mirror, and wets in the rain.

const UP = new Vector3(0, 1, 0);
const q = new Quaternion();
const mat4 = new Matrix4();
const ONE = new Vector3(1, 1, 1);

/** A box (centre, size, yaw) whose faces carry texture coordinates in metres over `tile`, so plaster and tin keep their scale on every face. */
function slab(b: MeshBuilder, cx: number, cy: number, cz: number, sx: number, sy: number, sz: number, ry: number, c: RGB, tile = 3): void {
  const cos = Math.cos(ry);
  const sin = Math.sin(ry);
  const P = (x: number, y: number, z: number) => new Vector3(cx + x * cos + z * sin, cy + y, cz - x * sin + z * cos);
  const N = (x: number, y: number, z: number) => new Vector3(x * cos + z * sin, y, -x * sin + z * cos);
  const hx = sx / 2;
  const hy = sy / 2;
  const hz = sz / 2;
  const face = (k: readonly (readonly [number, number, number])[], n: readonly [number, number, number], w: number, h: number) => {
    const nn = N(n[0], n[1], n[2]);
    const s = b.vertexCount;
    b.vertex(P(...k[0]), nn, 0, 0, c);
    b.vertex(P(...k[1]), nn, w / tile, 0, c);
    b.vertex(P(...k[2]), nn, w / tile, h / tile, c);
    b.vertex(P(...k[3]), nn, 0, h / tile, c);
    b.quad(s, s + 1, s + 2, s + 3);
  };
  face([[-hx, -hy, hz], [hx, -hy, hz], [hx, hy, hz], [-hx, hy, hz]], [0, 0, 1], sx, sy);
  face([[hx, -hy, -hz], [-hx, -hy, -hz], [-hx, hy, -hz], [hx, hy, -hz]], [0, 0, -1], sx, sy);
  face([[hx, -hy, hz], [hx, -hy, -hz], [hx, hy, -hz], [hx, hy, hz]], [1, 0, 0], sz, sy);
  face([[-hx, -hy, -hz], [-hx, -hy, hz], [-hx, hy, hz], [-hx, hy, -hz]], [-1, 0, 0], sz, sy);
  face([[-hx, hy, hz], [hx, hy, hz], [hx, hy, -hz], [-hx, hy, -hz]], [0, 1, 0], sx, sz);
  face([[-hx, -hy, -hz], [hx, -hy, -hz], [hx, -hy, hz], [-hx, -hy, hz]], [0, -1, 0], sx, sz);
}

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
  // the sanctum, and its curving spire: tiers drawn in toward a ribbed amalaka, a kalash and a trident
  const [sx, sz] = at(0, -2.5);
  slab(s.white, sx, y0 + 1.7, sz, 4.6, 3.4, 4.6, ry, WHITE);
  slab(s.white, sx, y0 + 3.5, sz, 5.0, 0.3, 5.0, ry, SAFFRON);
  // the rekha spire: thin courses drawn in along a curve that rises straight and bends in toward the top,
  // a rib down the middle of each face, a saffron band now and then
  const tiers = 22;
  const course = 0.33;
  for (let i = 0; i < tiers; i++) {
    const t = i / tiers;
    const half = 2.35 * Math.pow(Math.cos((t * Math.PI) / 2), 0.75) + 0.32;
    const y = y0 + 3.65 + i * course + course / 2;
    slab(s.white, sx, y, sz, half * 2, course, half * 2, ry, i % 7 === 6 ? scaleRgb(SAFFRON, 1.05) : WHITE);
    for (const [a, d, w, l] of [
      [0, half + 0.08, 0.9 * half, 0.16],
      [0, -half - 0.08, 0.9 * half, 0.16],
      [half + 0.08, 0, 0.16, 0.9 * half],
      [-half - 0.08, 0, 0.16, 0.9 * half],
    ] as const) {
      const [rx, rz] = at(a, -2.5 + d);
      slab(s.white, rx, y, rz, w, course, l, ry, scaleRgb(WHITE, 0.96));
    }
  }
  const top = y0 + 3.65 + tiers * course;
  part(s.white, new LatheGeometry([[0, 0], [0.75, 0.05], [0.9, 0.2], [0.75, 0.38], [0, 0.42]].map(([r, y]) => new Vector2(r, y)), 16), sx, top, sz, 0, WHITE);
  part(s.gold, new LatheGeometry([[0, 0], [0.32, 0.08], [0.38, 0.3], [0.2, 0.55], [0.08, 0.62], [0.12, 0.72], [0, 0.85]].map(([r, y]) => new Vector2(r, y)), 12), sx, top + 0.42, sz, 0, [1, 1, 1]);
  part(s.gold, new CylinderGeometry(0.025, 0.025, 1.3, 6), sx, top + 1.9, sz, 0, [1, 1, 1]);
  for (const a of [-0.18, 0, 0.18]) {
    const [px, pz] = at(a, -2.5);
    part(s.gold, new CylinderGeometry(0.02, 0.012, a === 0 ? 0.42 : 0.3, 5), px, top + 2.6, pz, 0, [1, 1, 1]);
  }
  // the dark doorway, toward the porch
  const [dx, dz] = at(0, -0.18);
  slab(s.paint, dx, y0 + 1.15, dz, 1.1, 2.2, 0.06, ry, rgb('#2a1a12'));
  // the porch: a floor, four pillars, a flat roof with a little parapet, a saffron band round its eaves
  const [px, pz] = at(0, 2.4);
  slab(s.white, px, y0 + 0.15, pz, 5.2, 0.3, 4.4, ry, WHITE);
  for (const [a, d] of [
    [-2.2, 0.6],
    [2.2, 0.6],
    [-2.2, 4.2],
    [2.2, 4.2],
  ]) {
    const [cx, cz] = at(a, d);
    part(s.white, new CylinderGeometry(0.17, 0.2, 2.7, 10), cx, y0 + 1.65, cz, 0, WHITE);
  }
  slab(s.white, px, y0 + 3.15, pz, 5.4, 0.35, 4.6, ry, WHITE);
  slab(s.paint, px, y0 + 2.92, pz, 5.45, 0.12, 4.65, ry, SAFFRON);
  slab(s.white, px, y0 + 3.5, pz, 5.4, 0.35, 0.2, ry, WHITE);
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

/** The jetty: out from the bank on concrete piles into the channel, railed and lit, a shed at its head. */
function jetty(s: Sets): void {
  const j = GORAKGHATA.jetty;
  const deckY = 2.45;
  // in the jetty's frame: `a` out from its landward end toward its head (OSM's line), `c` across it
  const ry = Math.atan2(j.toZ - j.z, -(j.toX - j.x));
  const at = frame(j.x, j.z, ry);
  const A = (a: number, c: number) => at(-a, c);
  const box = (b: MeshBuilder, a: number, y: number, c: number, along: number, h: number, across: number, col: RGB, tile?: number) => {
    const [x, z] = A(a, c);
    slab(b, x, y, z, along, h, across, ry, col, tile);
  };
  const post = (b: MeshBuilder, g: CylinderGeometry, a: number, y: number, c: number, col: RGB) => {
    const [x, z] = A(a, c);
    part(b, g, x, y, z, ry, col);
  };
  // from the top of the bank, 14 m inland of where OSM's line leaves it, to its head
  const start = -14;
  const end = j.length;
  const mid = (start + end) / 2;
  box(s.concrete, mid, deckY - 0.18, 0, end - start, 0.36, j.width, rgb('#b8b4aa'), 2);
  for (let a = start + 3; a < end; a += 5) {
    for (const side of [-1, 1]) {
      const [x, z] = A(a, side * 1.3);
      const bed = Math.min(terrainHeight(x, z), deckY - 1);
      const h = deckY - 0.36 - bed + 0.5;
      post(s.concrete, new CylinderGeometry(0.22, 0.24, h, 8), a, bed - 0.5 + h / 2, side * 1.3, rgb('#9e9a90'));
    }
    // a cross beam under the deck
    box(s.concrete, a, deckY - 0.55, 0, 0.35, 0.4, j.width + 0.3, rgb('#a29e94'), 2);
  }
  // railings: posts and two rails a side; lamp posts every so often
  for (let a = start + 1; a < end - 1; a += 2) {
    for (const side of [-1, 1]) box(s.paint, a, deckY + 0.5, side * (j.width / 2 - 0.06), 0.08, 1.0, 0.08, rgb('#d8d4c8'), 1);
  }
  for (const side of [-1, 1]) {
    for (const h of [0.55, 0.98]) box(s.paint, mid, deckY + h, side * (j.width / 2 - 0.06), end - start, 0.06, 0.07, rgb('#d8d4c8'), 1);
  }
  for (let a = start + 6; a < end; a += 15) {
    post(s.concrete, new CylinderGeometry(0.06, 0.08, 4.2, 6), a, deckY + 2.1, j.width / 2 + 0.15, rgb('#6a6a6a'));
    box(s.paint, a, deckY + 4.25, j.width / 2 - 0.3, 0.3, 0.14, 0.9, rgb('#e8e2c8'), 1);
  }
  // the head: a broader landing, a tin-roofed shed for those waiting for the boats, steps down to the water
  box(s.concrete, end + 3, deckY - 0.18, 0, 6.5, 0.36, 9, rgb('#b8b4aa'), 2);
  for (const [oa, oc] of [
    [5.2, -3.6],
    [0.8, -3.6],
    [5.2, 3.6],
    [0.8, 3.6],
  ]) {
    post(s.concrete, new CylinderGeometry(0.22, 0.24, 4, 8), end + oa, deckY - 2.2, oc, rgb('#9e9a90'));
    box(s.paint, end + oa, deckY + 1.3, oc, 0.14, 2.6, 0.14, rgb('#3e5a6a'), 1);
  }
  box(s.tin, end + 3, deckY + 2.68, 0, 5.6, 0.1, 8.4, rgb('#c8c2b8'), 2);
  for (let k = 0; k < 9; k++) box(s.concrete, end + 6.6, deckY - 0.3 - k * 0.32, -3, 0.9, 0.3, 2.4, rgb('#a8a49a'), 1);
}

/** The bank road's brick buildings by the jetty: shops below, flat roofs and parapets above, faded paint; and the mosque. */
function townBuildings(s: Sets, rng: Rng): void {
  const t = GORAKGHATA.town;
  const paints = ['#e8d9a8', '#cfe0c4', '#e6c4b8', '#f0ece0', '#c8d8e0', '#e8cf9e'].map((c) => rgb(c));
  let z = t.z1 - 2;
  while (z > t.z0 + 4) {
    const w = rng.range(5.5, 8.5);
    const zc = z - w / 2;
    const inland = t.inland0 + 4 + rng.range(0, 3);
    const depth = rng.range(7, 10);
    const x = riverX(zc) + edgeHalfWidth(zc, 1) + inland + depth / 2;
    const y = terrainHeight(x, zc);
    const floors = rng.int(2, 3);
    const c = rng.pick(paints);
    const H = floors * 3;
    // the building: walls, then a parapet round the roof; its face toward the channel (−x)
    slab(s.paint, x, y + H / 2 - 0.3, zc, depth, H + 0.6, w, 0, c, 3);
    slab(s.paint, x, y + H + 0.45, zc, depth + 0.1, 0.5, w + 0.1, 0, scaleRgb(c, 0.92), 3);
    for (let f = 0; f < floors; f++) {
      const fy = y + f * 3;
      if (f === 0) {
        // shop shutters, and an awning of tin over them
        slab(s.tin, x - depth / 2 - 0.03, fy + 1.3, zc, 0.06, 2.4, w * 0.8, 0, rgb('#8a8e94'), 2);
        slab(s.tin, x - depth / 2 - 0.9, fy + 2.75, zc, 1.8, 0.06, w * 0.9, 0, rgb('#7d8a8e'), 2);
        // a signboard, its colours only
        slab(s.paint, x - depth / 2 - 0.08, fy + 3.25, zc, 0.06, 0.6, w * 0.7, 0, rng.pick([rgb('#c43c2c'), rgb('#2a6a3e'), rgb('#2c4a8a'), rgb('#d8a020')]), 1);
      } else {
        for (let k = 0; k < Math.floor(w / 2.2); k++) {
          const wz = zc - w / 2 + 1.1 + k * 2.2;
          slab(s.paint, x - depth / 2 - 0.03, fy + 1.6, wz, 0.06, 1.3, 1.0, 0, rgb('#2c2a28'), 1);
          slab(s.paint, x - depth / 2 - 0.1, fy + 0.85, wz, 0.2, 0.1, 1.2, 0, scaleRgb(c, 0.85), 1);
        }
      }
    }
    // a water tank on some roofs
    if (rng.next() < 0.5) part(s.paint, new CylinderGeometry(0.6, 0.6, 1.1, 12), x + 1, y + H + 0.75, zc, 0, rgb('#2a2a2a'));
    z -= w + rng.range(0.5, 2.5);
  }
  // the mosque at the road's end: a prayer hall, a white dome, and a slender minaret
  const mz = t.z0 + 8;
  const mx = riverX(mz) + edgeHalfWidth(mz, 1) + t.inland1 - 8;
  const my = terrainHeight(mx, mz);
  slab(s.white, mx, my + 2.2, mz, 10, 4.4, 9, 0, WHITE);
  slab(s.paint, mx, my + 4.5, mz, 10.3, 0.3, 9.3, 0, rgb('#4a8a5a'));
  part(s.white, new SphereGeometry(2.6, 18, 10, 0, Math.PI * 2, 0, Math.PI / 2), mx, my + 4.6, mz, 0, WHITE);
  part(s.gold, new CylinderGeometry(0.03, 0.05, 1.2, 6), mx, my + 7.8, mz, 0, [1, 1, 1]);
  part(s.white, new CylinderGeometry(0.45, 0.55, 13, 10), mx - 3.5, my + 6.5, mz + 5.8, 0, WHITE);
  part(s.paint, new CylinderGeometry(0.7, 0.7, 0.3, 12), mx - 3.5, my + 10.5, mz + 5.8, 0, rgb('#4a8a5a'));
  part(s.white, new LatheGeometry([[0, 0], [0.55, 0], [0.5, 0.5], [0.2, 1.1], [0, 1.4]].map(([r, y]) => new Vector2(r, y)), 10), mx - 3.5, my + 13, mz + 5.8, 0, WHITE);
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

// ---------- Cox's Bazar ----------

/** The buildings of Cox's Bazar across the channel's mouth: blocks of four to eight storeys, pale paint, rows of windows. */
function coxsBazar(s: Sets, rng: Rng): void {
  const c = COXS_BAZAR;
  const paints = ['#f2efe6', '#e8e0c8', '#d8e4ea', '#efe0cc', '#e0e8d8'].map((p) => rgb(p));
  for (let k = 0; k < 40; k++) {
    const z = rng.range(c.z1 + 20, c.z0 - 10);
    const x = riverX(z) + rng.range(c.u1 + 40, c.u0 - 20);
    const y = terrainHeight(x, z);
    if (y < 0.5) continue;
    const floors = rng.int(4, 8);
    const H = floors * 3.1;
    const w = rng.range(10, 18);
    const d = rng.range(10, 16);
    const col = rng.pick(paints);
    slab(s.paint, x, y + H / 2, z, w, H, d, 0, col, 3);
    // bands of dark window along each floor, facing the channel and the sea
    for (let f = 0; f < floors; f++) {
      slab(s.paint, x - w / 2 - 0.02, y + f * 3.1 + 1.7, z, 0.05, 1.1, d * 0.8, 0, mixRgb(col, rgb('#30363c'), 0.75), 3);
      slab(s.paint, x, y + f * 3.1 + 1.7, z - d / 2 - 0.02, w * 0.8, 1.1, 0.05, 0, mixRgb(col, rgb('#30363c'), 0.75), 3);
    }
    slab(s.paint, x, y + H + 0.4, z, w + 0.2, 0.8, d + 0.2, 0, scaleRgb(col, 0.9), 3);
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
 * The landmarks, as groups: `seen` (Gorakghata's temple, jetty, town and pagoda, and Cox's Bazar, which show
 * from afar), and `near` (the betel gardens and dry-fish yards, small things left undrawn far off; see cull.ts).
 */
export function buildMoheshkhali(): { seen: Group; near: Group } {
  const seen = new Group();
  seen.name = 'moheshkhali';
  const near = new Group();
  near.name = 'moheshkhali-near';
  const rng = new Rng(523);
  const town = newSets();
  temple(town, rng);
  stair(town);
  jetty(town);
  townBuildings(town, rng);
  pagoda(town);
  const coxs = newSets();
  coxsBazar(coxs, rng);
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
  add(coxs, seen);
  for (const g of gardens.values()) add(g, near);
  for (const y of yards) add(y, near);
  return { seen, near };
}
