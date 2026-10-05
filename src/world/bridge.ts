import { BufferGeometry, DoubleSide, Group, Mesh, MeshStandardMaterial, Vector2, Vector3 } from 'three';
import { Rng } from '../core/rng';
import { MeshBuilder, mixRgb, rgb, scaleRgb, slab, type RGB } from '../render/builder';
import { patchMaterial } from '../render/patch';
import { brickTexture, plasterTexture } from '../render/textures';
import { BRIDGE, bridgeDeck, bridgeSoffit, bridgeToWorld, terrainHeight } from './geography';
import type { FeaturedTree } from './vegetation';

// The old bridge over the khal through Bara Moheshkhali, on the boat's way up to the bil: a humped arch of
// thin Bengal brick, plastered in lime and washed ochre long ago, of the kind that carries a village footpath
// over a khal. One segmental arch spans the khal, its ring of brick voussoirs showing in the plaster;
// the deck humps over it between low parapets with a worn coping, easing down ramps to the banks, where
// the parapets end in squat pillars. Years of floods have left their line on it: the plaster dark and damp
// low down, mossy green at the water, the barrel's brick stained; ferns grow from its joints. It is part of
// the world like any other: it casts shadows and takes them, shows in the khal's mirror, darkens and
// shines in the rain, and the boat passes under it on her way into the bil.
// Built in the bridge's own frame (geography.ts → BRIDGE): x along it, z along the khal; heights are
// the world's.

const HALF_SPAN = BRIDGE.span / 2;
/** The parapets' inner faces, and the bridge's outer faces. */
const INNER = BRIDGE.width / 2;
const OUTER = INNER + BRIDGE.parapet;
/** Metres per repeat of the plaster and of the brick textures. */
const PLASTER_TILE = 3.4;
const BRICK_TILE = 0.6;
/** The arch's circle: its radius and the height of its centre. */
const RADIUS = (HALF_SPAN * HALF_SPAN + BRIDGE.rise * BRIDGE.rise) / (2 * BRIDGE.rise);
const CENTRE_Y = BRIDGE.springing + BRIDGE.rise - RADIUS;
/** Below the khal's bed, where the abutments' footings are. */
const FOOTING = -2.3;

const PLASTER: RGB = [1, 1, 1];
const DAMP: RGB = rgb('#6f6a58');
const MOSS: RGB = rgb('#4f5a2c');

/** The ground under a point of the bridge's frame, as a height above the khal's water (the frame's zero). */
function groundAt(bx: number, bz: number): number {
  const w = bridgeToWorld(bx, bz);
  return terrainHeight(w.x, w.z) - BRIDGE.water;
}

/** How the years show at height y on the walls: moss at the water, damp to the flood line, the wash above. */
function weather(y: number, base: RGB, rng: Rng): RGB {
  let c = mixRgb(base, DAMP, 1 - smooth(0.2, 1.4, y));
  c = mixRgb(c, MOSS, (1 - smooth(-0.3, 0.7, y)) * 0.7);
  return scaleRgb(c, 0.92 + 0.12 * rng.next());
}

function smooth(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/**
 * A surface from a grid of points (rows[i][j]), wound so that with `flip` false the face looks along
 * (row i → i+1) × (column j → j+1). Normals come later, from the faces.
 */
function grid(b: MeshBuilder, rows: Vector3[][], uv: (p: Vector3, i: number, j: number) => [number, number], color: (p: Vector3) => RGB, flip = false): void {
  const start = b.vertexCount;
  const m = rows[0].length;
  const up = new Vector3(0, 1, 0);
  rows.forEach((row, i) =>
    row.forEach((p, j) => {
      const [u, v] = uv(p, i, j);
      b.vertex(p, up, u, v, color(p));
    }),
  );
  for (let i = 0; i + 1 < rows.length; i++) {
    for (let j = 0; j + 1 < m; j++) {
      const a = start + i * m + j;
      const c = a + m;
      if (flip) b.quad(a, a + 1, c + 1, c);
      else b.quad(a, c, c + 1, a + 1);
    }
  }
}

/** Samples along the bridge, with the arch's two springings doubled (the wall's foot steps down there). */
function stations(): number[] {
  const xs: number[] = [];
  for (let i = 0; i <= 120; i++) {
    const x = -BRIDGE.half + (i / 120) * BRIDGE.half * 2;
    if (Math.abs(Math.abs(x) - HALF_SPAN) > 1e-6) xs.push(x);
  }
  xs.push(-HALF_SPAN, -HALF_SPAN, HALF_SPAN, HALF_SPAN);
  return xs.sort((a, b) => a - b);
}

/** The plastered walls: the spandrels over the arch and the ramps' sides, each from its foot to the parapet's top. */
function walls(b: MeshBuilder, rng: Rng): void {
  const xs = stations();
  for (const side of [-1, 1]) {
    const z = side * OUTER;
    let seenSpringing = 0;
    const rows = xs.map((x) => {
      // at a springing the first sample keeps to the arch, the second steps down to the footing
      let inSpan = Math.abs(x) < HALF_SPAN;
      if (Math.abs(Math.abs(x) - HALF_SPAN) < 1e-6) inSpan = seenSpringing++ % 2 === (x < 0 ? 1 : 0);
      const top = bridgeDeck(x) + BRIDGE.parapetHeight;
      const foot = inSpan ? bridgeSoffit(Math.max(-HALF_SPAN, Math.min(HALF_SPAN, x))) : Math.min(groundAt(x, z) - 0.6, BRIDGE.springing - 0.1);
      // rows at fixed heights between foot and top, so the damp and the moss have somewhere to change
      const heights = [foot, -0.3, 0.3, 0.9, 1.6, 2.6, top - 0.25, top].map((h) => Math.min(top, Math.max(foot, h)));
      return heights.map((y) => new Vector3(x, y, z));
    });
    grid(
      b,
      rows,
      (p) => [(side * p.x) / PLASTER_TILE, p.y / PLASTER_TILE],
      (p) => weather(p.y, PLASTER, rng),
      side < 0,
    );
  }
}

/** The ring of brick voussoirs round the arch on each face, standing a finger's width proud of the plaster. */
function archRing(b: MeshBuilder, rng: Rng): void {
  const N = 40;
  const a0 = Math.asin(HALF_SPAN / RADIUS);
  for (const side of [-1, 1]) {
    const z = side * (OUTER + 0.015);
    const rows: Vector3[][] = [];
    for (let i = 0; i <= N; i++) {
      const a = -a0 + (i / N) * a0 * 2;
      const nx = Math.sin(a);
      const ny = Math.cos(a);
      rows.push([0, BRIDGE.ring].map((r) => new Vector3(nx * (RADIUS + r), CENTRE_Y + ny * (RADIUS + r), z)));
    }
    grid(
      b,
      rows,
      (_p, i, j) => [(j * BRIDGE.ring) / BRICK_TILE, (i / N) * a0 * 2 * RADIUS / BRICK_TILE],
      (p) => weather(p.y, [0.82, 0.78, 0.76], rng),
      side < 0,
    );
  }
}

/** The barrel under the arch: brick courses along the khal, darker and stained toward the springings. */
function barrel(b: MeshBuilder, rng: Rng): void {
  const N = 40;
  const a0 = Math.asin(HALF_SPAN / RADIUS);
  const rows: Vector3[][] = [];
  for (let i = 0; i <= N; i++) {
    const a = -a0 + (i / N) * a0 * 2;
    rows.push([-OUTER, 0, OUTER].map((z) => new Vector3(Math.sin(a) * RADIUS, CENTRE_Y + Math.cos(a) * RADIUS, z)));
  }
  grid(
    b,
    rows,
    (p, i) => [p.z / BRICK_TILE, (i / N) * a0 * 2 * RADIUS / BRICK_TILE],
    (p) => scaleRgb(weather(p.y, [1, 1, 1], rng), 0.78),
  );
}

/** The abutments' faces toward the water, from the springings down to their footings. */
function abutments(b: MeshBuilder, rng: Rng): void {
  for (const side of [-1, 1]) {
    const x = side * HALF_SPAN;
    const rows = [FOOTING, -0.6, 0, BRIDGE.springing].map((y) => [-OUTER, 0, OUTER].map((z) => new Vector3(x, y, z)));
    grid(
      b,
      rows,
      (p) => [p.z / BRICK_TILE, p.y / BRICK_TILE],
      (p) => weather(p.y, [0.85, 0.85, 0.85], rng),
      side > 0,
    );
  }
}

/** The parapets' inner faces, and the coping along their tops, worn grey and a little wider than the wall. */
function parapets(walls: MeshBuilder, coping: MeshBuilder, rng: Rng): void {
  const xs = stations().filter((x, i, all) => i === 0 || x !== all[i - 1]);
  for (const side of [-1, 1]) {
    const inner = xs.map((x) => [bridgeDeck(x) - 0.05, bridgeDeck(x) + BRIDGE.parapetHeight].map((y) => new Vector3(x, y, side * INNER)));
    grid(
      walls,
      inner,
      (p) => [(side * p.x) / PLASTER_TILE, p.y / PLASTER_TILE],
      () => scaleRgb([1, 1, 1], 0.9 + 0.1 * rng.next()),
      side > 0,
    );
    // the coping: its top and its two edges
    const top = xs.map((x) => {
      const y = bridgeDeck(x) + BRIDGE.parapetHeight + 0.07;
      return [side * (INNER - 0.05), side * (OUTER + 0.05)].map((z) => new Vector3(x, y, z));
    });
    grid(coping, top, (p) => [p.x / 1.2, p.z / 1.2], () => scaleRgb([1, 1, 1], 0.85 + 0.15 * rng.next()), side > 0);
    for (const [z, flip] of [
      [side * (INNER - 0.05), side > 0],
      [side * (OUTER + 0.05), side < 0],
    ] as const) {
      const edge = xs.map((x) => {
        const y = bridgeDeck(x) + BRIDGE.parapetHeight;
        return [y - 0.01, y + 0.07].map((yy) => new Vector3(x, yy, z));
      });
      grid(coping, edge, (p) => [p.x / 1.2, p.y / 1.2], () => [0.8, 0.8, 0.8], flip);
    }
  }
}

/** The deck: brick laid on edge across it, worn to bare earth down the middle where feet and bicycle wheels go. */
function deck(b: MeshBuilder): void {
  const xs = stations().filter((x, i, all) => i === 0 || x !== all[i - 1]);
  const zs = [-INNER, -0.9, -0.35, 0.35, 0.9, INNER];
  const rows = xs.map((x) => zs.map((z) => new Vector3(x, bridgeDeck(x), z)));
  const earth: RGB = rgb('#b79a74');
  grid(
    b,
    rows,
    (p) => [p.z / BRICK_TILE, p.x / BRICK_TILE],
    (p) => mixRgb([0.95, 0.95, 0.95], earth, smooth(0.9, 0.2, Math.abs(p.z)) * 0.6),
    true,
  );
}

/** Square pillars where the parapets end, each with a small cap. */
function pillars(b: MeshBuilder, rng: Rng): void {
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const cx = sx * (BRIDGE.half - 0.3);
      const cz = sz * (INNER + BRIDGE.parapet / 2);
      const base = Math.min(groundAt(cx, cz), bridgeDeck(cx)) - 0.3;
      const top = bridgeDeck(cx) + 0.95;
      const h = 0.27;
      // four sides, then the cap
      const corners = [
        [-h, -h],
        [h, -h],
        [h, h],
        [-h, h],
      ];
      for (let k = 0; k < 4; k++) {
        const [ax, az] = corners[k];
        const [bx, bz] = corners[(k + 1) % 4];
        const rows = [base, 0.5, 1.2, top].map((y) => [new Vector3(cx + ax, Math.max(base, y), cz + az), new Vector3(cx + bx, Math.max(base, y), cz + bz)]);
        grid(b, rows, (p, _i, j) => [j * 0.22 + k * 0.22, p.y / PLASTER_TILE], (p) => weather(p.y - base + 1.4, PLASTER, rng));
      }
      const capY = top + 0.08;
      const c = 0.33;
      const rows = [
        [new Vector3(cx - c, capY, cz - c), new Vector3(cx + c, capY, cz - c)],
        [new Vector3(cx - c, capY, cz + c), new Vector3(cx + c, capY, cz + c)],
      ];
      grid(b, rows, (p) => [p.x, p.z], () => [0.85, 0.85, 0.85]);
      for (let k = 0; k < 4; k++) {
        const [ax, az] = corners[k].map((v) => (v / h) * c);
        const [bx, bz] = corners[(k + 1) % 4].map((v) => (v / h) * c);
        const side = [top, capY].map((y) => [new Vector3(cx + ax, y, cz + az), new Vector3(cx + bx, y, cz + bz)]);
        grid(b, side, (p, _i, j) => [j * 0.3, p.y], () => [0.8, 0.8, 0.8]);
      }
    }
  }
}

/** Ferns and grass rooted in the joints of the walls and along the parapets: little tufts of tapering fronds. */
function tufts(rng: Rng): BufferGeometry {
  const b = new MeshBuilder();
  const at: { p: Vector3; out: Vector3 }[] = [];
  // round the arch on both faces, low on the walls by the water, and along the coping
  for (let k = 0; k < 9; k++) {
    const a = rng.range(-0.95, 0.95) * Math.asin(HALF_SPAN / RADIUS);
    const side = rng.sign();
    const r = RADIUS + BRIDGE.ring + rng.range(0.05, 0.4);
    at.push({ p: new Vector3(Math.sin(a) * r, CENTRE_Y + Math.cos(a) * r, side * (OUTER + 0.02)), out: new Vector3(0, 0.3, side).normalize() });
  }
  for (let k = 0; k < 10; k++) {
    const x = rng.range(-BRIDGE.half + 2, BRIDGE.half - 2);
    const side = rng.sign();
    at.push({ p: new Vector3(x, bridgeDeck(x) + BRIDGE.parapetHeight + 0.07, side * rng.range(INNER, OUTER)), out: new Vector3(0, 1, side * 0.4).normalize() });
  }
  for (let k = 0; k < 8; k++) {
    const x = rng.sign() * rng.range(HALF_SPAN + 0.5, HALF_SPAN + 4);
    const side = rng.sign();
    at.push({ p: new Vector3(x, rng.range(0.4, 1.4), side * (OUTER + 0.02)), out: new Vector3(0, 0.4, side).normalize() });
  }
  const leaf: RGB = rgb('#4d6b2a');
  const tip: RGB = rgb('#8fa04a');
  for (const { p, out } of at) {
    const fronds = rng.int(5, 9);
    for (let f = 0; f < fronds; f++) {
      const dir = out.clone().add(new Vector3(rng.range(-0.8, 0.8), rng.range(-0.2, 0.6), rng.range(-0.8, 0.8))).normalize();
      const len = rng.range(0.12, 0.32);
      const side = new Vector3().crossVectors(dir, new Vector3(0, 1, 0));
      if (side.lengthSq() < 1e-4) side.set(1, 0, 0);
      side.normalize().multiplyScalar(0.018);
      const mid = p.clone().addScaledVector(dir, len * 0.5).add(new Vector3(0, -len * 0.08, 0));
      const end = p.clone().addScaledVector(dir, len).add(new Vector3(0, -len * 0.25, 0));
      const s = b.vertex(p.clone().sub(side), dir, 0, 0, leaf);
      b.vertex(p.clone().add(side), dir, 1, 0, leaf);
      b.vertex(mid.clone().add(side.clone().multiplyScalar(1.4)), dir, 1, 0.5, mixRgb(leaf, tip, 0.5));
      b.vertex(mid.clone().sub(side.clone().multiplyScalar(1.4)), dir, 0, 0.5, mixRgb(leaf, tip, 0.5));
      b.vertex(end, dir, 0.5, 1, tip);
      b.quad(s, s + 1, s + 2, s + 3);
      b.tri(s + 3, s + 2, s + 4);
    }
  }
  return b.build();
}

/** Where the plaster has fallen from the spandrels and the ramps' walls: patches of the brick under it, each its own size and place. */
function fallenPatches(b: MeshBuilder, rng: Rng): void {
  for (let k = 0; k < 12; k++) {
    const side = rng.sign();
    const x = rng.range(-BRIDGE.half + 3, BRIDGE.half - 3);
    const floor = Math.abs(x) < HALF_SPAN ? bridgeSoffit(x) + 0.35 : Math.max(groundAt(x, side * OUTER) + 0.3, 0.4);
    const ceil = bridgeDeck(x) - 0.25;
    if (ceil - floor < 0.6) continue;
    const w = rng.range(0.35, 0.9);
    const h = rng.range(0.22, 0.5);
    const y = rng.range(floor + h / 2, ceil - h / 2);
    slab(b, x, y, side * (OUTER + 0.004), w, h, 0.012, 0, scaleRgb(rgb('#8a5038'), rng.range(0.8, 1)), BRICK_TILE);
  }
}

/** Where random trees keep off (the bridge and its ramps). */
export const BRIDGE_CLEARING = { x: BRIDGE.x, z: BRIDGE.z, r: BRIDGE.half + 4 };

/**
 * The trees round the bridge, set where they frame it: a broad rain tree and a mango behind it on the
 * bil's side, their dark crowns behind whoever stands on it, leaning over the khal; a bamboo clump
 * and a date palm on the downstream side; bananas by the far ramp.
 */
export function bridgeTrees(): FeaturedTree[] {
  const at = (kind: FeaturedTree['kind'], bx: number, bz: number, s: number, ry: number): FeaturedTree => ({ kind, ...bridgeToWorld(bx, bz), s, ry });
  return [
    at('rain', 12.5, 8.5, 1.1, 0.6),
    at('mango', -13.5, 7.5, 1.15, 2.1),
    at('bamboo', -15.5, -6.5, 1.05, 0.4),
    at('date', -21.5, -8.5, 1.0, 1.3),
    at('banana', 17.5, -5.5, 1.0, 0.2),
    at('banana', 19, -3.8, 0.9, 2.6),
  ];
}

export function buildBridge(): Group {
  const group = new Group();
  group.name = 'bridge';
  const rng = new Rng(311);
  // no fallen patches in the texture: repeated every tile they stood in rows along the walls like black
  // marks; the brick shows instead through a few patches placed one by one (fallenPatches)
  const plaster = plasterTexture(312, { fallen: false });
  const brick = brickTexture(313);
  const mat = (set: { map: Texture2; normal: Texture2 }, color: string, roughness: number, grime: number) =>
    patchMaterial(
      new MeshStandardMaterial({ map: set.map, normalMap: set.normal, normalScale: new Vector2(0.8, 0.8), color, vertexColors: true, roughness }),
      { grime },
    );
  const plasterMat = mat(plaster, '#ffffff', 0.93, 0.3);
  const brickMat = mat(brick, '#ffffff', 0.88, 0.25);
  const copingMat = mat(plaster, '#a7a196', 0.9, 0.4);

  const plasterB = new MeshBuilder();
  walls(plasterB, rng);
  pillars(plasterB, rng);
  const brickB = new MeshBuilder();
  fallenPatches(brickB, rng);
  archRing(brickB, rng);
  barrel(brickB, rng);
  abutments(brickB, rng);
  const deckB = new MeshBuilder();
  deck(deckB);
  const copingB = new MeshBuilder();
  parapets(plasterB, copingB, rng);

  const add = (b: MeshBuilder, m: MeshStandardMaterial) => {
    const g = b.build();
    g.computeVertexNormals();
    const mesh = new Mesh(g, m);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  };
  add(plasterB, plasterMat);
  add(brickB, brickMat);
  add(deckB, brickMat);
  add(copingB, copingMat);
  const fern = new Mesh(
    tufts(rng),
    patchMaterial(new MeshStandardMaterial({ vertexColors: true, side: DoubleSide, roughness: 0.8 }), { wind: 0.05, windHeight: 0.3, translucency: 1.2, foliage: true, seasonal: 'leaf' }),
  );
  group.add(fern);

  group.position.set(BRIDGE.x, BRIDGE.water, BRIDGE.z);
  group.rotation.y = BRIDGE.angle;
  group.updateMatrixWorld(true);
  return group;
}

type Texture2 = ReturnType<typeof brickTexture>['map'];
