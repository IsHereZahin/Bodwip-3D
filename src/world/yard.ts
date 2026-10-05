import { DoubleSide, Group, LatheGeometry, Matrix4, Mesh, MeshStandardMaterial, SphereGeometry, Vector2, Vector3 } from 'three';
import { Rng } from '../core/rng';
import { MeshBuilder, card, mixRgb, rgb, scaleRgb, slab, taperedTube, type RGB } from '../render/builder';
import { patchMaterial } from '../render/patch';
import { leafClusterTexture } from '../render/textures';
import { HOMESTEAD_MOUNDS, nearBackwater, onRoad, shapePoint, terrainHeight, type Mound } from './geography';
import type { HutPlan } from './village';

// The life of a homestead's yard and its edges, a few things to each: the washing hung out on a line between
// two bamboo poles (a saree, a gamchha, a lungi); clay water pots (কলসি) by the kitchen; in some yards the
// tulsi on its little plastered stand (তুলসীমঞ্চ); a bottle-gourd trellis (লাউয়ের মাচা) of bamboo at the mound's
// edge, its vine spread over the top and its gourds hanging under it; a bamboo fence along the kitchen's side.
// Kept clear of the houses, the ways and the water.

const BAMBOO: RGB = rgb('#a39469');
/** What hangs on a line: a red-bordered saree, a green one, a checked gamchha's red, a blue lungi, a white cloth. */
const CLOTHS: RGB[] = [rgb('#b8323a'), rgb('#3f7a4a'), rgb('#c45a2a'), rgb('#3b4f8a'), rgb('#e8e2d4'), rgb('#d9a52a')];

/** Whether a point is clear of every house (with `margin` m round its walls). */
function clearOfHouses(huts: readonly HutPlan[], x: number, z: number, margin: number): boolean {
  for (const h of huts) {
    if (Math.abs(h.x - x) > 14 || Math.abs(h.z - z) > 14) continue;
    const dx = x - h.x;
    const dz = z - h.z;
    // in the house's frame (its door along +z)
    const lx = dx * Math.cos(h.ry) - dz * Math.sin(h.ry);
    const lz = dx * Math.sin(h.ry) + dz * Math.cos(h.ry);
    if (Math.abs(lx) < h.l / 2 + 0.8 + margin && lz > -h.w / 2 - 0.8 - margin && lz < h.w / 2 + 2.2 + margin) return false;
  }
  return true;
}

const ok = (huts: readonly HutPlan[], p: { x: number; z: number }, margin: number) =>
  clearOfHouses(huts, p.x, p.z, margin) && !onRoad(p.x, p.z, 1) && !nearBackwater(p.x, p.z, 3);

/** A washing line: two poles, a sagging line, cloths hung over it. */
function washingLine(bamboo: MeshBuilder, cloth: MeshBuilder, a: { x: number; z: number }, b: { x: number; z: number }, rng: Rng): void {
  const h = 2.1;
  const ya = terrainHeight(a.x, a.z);
  const yb = terrainHeight(b.x, b.z);
  taperedTube(bamboo, [new Vector3(a.x, ya - 0.2, a.z), new Vector3(a.x, ya + h, a.z)], [0.04, 0.035], 5, BAMBOO, 1.2);
  taperedTube(bamboo, [new Vector3(b.x, yb - 0.2, b.z), new Vector3(b.x, yb + h, b.z)], [0.04, 0.035], 5, BAMBOO, 1.2);
  const line = (t: number) => new Vector3(a.x + (b.x - a.x) * t, ya + h - 0.08 + (yb - ya) * t - 0.25 * Math.sin(Math.PI * t), a.z + (b.z - a.z) * t);
  const pts = Array.from({ length: 9 }, (_, i) => line(i / 8));
  taperedTube(bamboo, pts, pts.map(() => 0.008), 3, rgb('#d8d0bc'), 1);
  // the cloths, each folded over the line and hanging both sides of it
  const len = Math.hypot(b.x - a.x, b.z - a.z);
  const dir = new Vector3((b.x - a.x) / len, 0, (b.z - a.z) / len);
  const across = new Vector3(-dir.z, 0, dir.x);
  let t = rng.range(0.08, 0.15);
  while (t < 0.9) {
    const w = rng.range(0.6, 1.3) / len;
    if (t + w > 0.95) break;
    const color = scaleRgb(rng.pick(CLOTHS), rng.range(0.85, 1.05));
    const drop = rng.range(0.7, 1.1);
    const s = cloth.vertexCount;
    const N = 4;
    for (let i = 0; i <= N; i++) {
      const p = line(t + (w * i) / N);
      for (const [k, side] of [
        [0, -1],
        [1, 0],
        [2, 1],
      ] as const) {
        const y = side === 0 ? p.y : p.y - drop * (0.9 + 0.1 * Math.sin(i * 1.7 + t * 20));
        const q = new Vector3(p.x, y, p.z).addScaledVector(across, side * 0.035);
        cloth.vertex(q, across.clone().multiplyScalar(side || 1), (i / N) * 2, k / 2, mixRgb(color, scaleRgb(color, 0.7), side === 0 ? 0 : 0.3));
      }
    }
    for (let i = 0; i < N; i++) for (let k = 0; k < 2; k++) cloth.quad(s + i * 3 + k, s + (i + 1) * 3 + k, s + (i + 1) * 3 + k + 1, s + i * 3 + k + 1);
    t += w + rng.range(0.04, 0.12);
  }
}

/** Clay water pots by a wall: round-bellied, narrow-necked. */
function pots(clay: MeshBuilder, x: number, z: number, rng: Rng): void {
  const profile = [
    new Vector2(0.01, 0),
    new Vector2(0.12, 0.02),
    new Vector2(0.2, 0.12),
    new Vector2(0.22, 0.22),
    new Vector2(0.17, 0.34),
    new Vector2(0.08, 0.42),
    new Vector2(0.07, 0.47),
    new Vector2(0.1, 0.5),
  ];
  const geo = new LatheGeometry(profile, 12);
  const n = rng.int(2, 3);
  for (let i = 0; i < n; i++) {
    const px = x + rng.range(-0.5, 0.5);
    const pz = z + rng.range(-0.5, 0.5);
    const s = rng.range(0.85, 1.1);
    clay.add(geo, new Matrix4().makeScale(s, s, s).setPosition(px, terrainHeight(px, pz) - 0.02, pz), scaleRgb(rgb(i === 0 && rng.next() < 0.3 ? '#b8892e' : '#8a4a2c'), rng.range(0.85, 1.05)));
  }
}

/** The tulsi's stand: a little plastered pillar with its bowl, the holy basil bushy on top. */
function tulsi(clay: MeshBuilder, leaves: MeshBuilder, x: number, z: number, rng: Rng): void {
  const y = terrainHeight(x, z);
  slab(clay, x, y + 0.35, z, 0.55, 0.7, 0.55, rng.range(0, 1), rgb('#d8cfc0'), 1);
  slab(clay, x, y + 0.74, z, 0.68, 0.1, 0.68, 0, rgb('#c9bfae'), 1);
  for (let k = 0; k < 12; k++) {
    const a = rng.range(0, Math.PI * 2);
    const p = new Vector3(x + Math.cos(a) * rng.range(0, 0.2), y + 0.8 + rng.range(0.1, 0.55), z + Math.sin(a) * rng.range(0, 0.2));
    const right = new Vector3(Math.cos(a + 1.3), 0, Math.sin(a + 1.3)).multiplyScalar(0.18);
    card(leaves, p, right, new Vector3(0, 0.2, 0), new Vector3(0, 1, 0), scaleRgb([1, 1, 1], rng.range(0.7, 0.9)));
  }
}

/** A bottle-gourd trellis: four posts, culms laid across their heads, the vine spread over it, gourds hanging below. */
function macha(bamboo: MeshBuilder, leaves: MeshBuilder, gourds: MeshBuilder, m: Mound, u: number, v: number, rng: Rng): void {
  const L = rng.range(3, 4.2);
  const W = rng.range(2.2, 3);
  const h = rng.range(1.7, 1.95);
  const corner = (du: number, dv: number) => shapePoint(m, u + du, v + dv);
  const ys: number[] = [];
  for (const du of [-L / 2, L / 2]) {
    for (const dv of [-W / 2, W / 2]) {
      const p = corner(du, dv);
      const y = terrainHeight(p.x, p.z);
      ys.push(y);
      taperedTube(bamboo, [new Vector3(p.x, y - 0.2, p.z), new Vector3(p.x, y + h, p.z)], [0.045, 0.04], 5, BAMBOO, 1.2);
    }
  }
  const top = Math.max(...ys) + h;
  for (let k = 0; k <= 5; k++) {
    const dv = -W / 2 + (W * k) / 5;
    const a = corner(-L / 2 - 0.2, dv);
    const b = corner(L / 2 + 0.2, dv);
    taperedTube(bamboo, [new Vector3(a.x, top, a.z), new Vector3(b.x, top, b.z)], [0.025, 0.025], 4, BAMBOO, 1.2);
  }
  // the vine: leaf cards spread over the top, thinning to its edges, a few trailing down a post
  const up = new Vector3(0, 1, 0);
  for (let k = 0; k < 70; k++) {
    const du = rng.range(-L / 2, L / 2) * 1.05;
    const dv = rng.range(-W / 2, W / 2) * 1.05;
    const p = corner(du, dv);
    const a = rng.range(0, Math.PI * 2);
    const s = rng.range(0.35, 0.55);
    card(leaves, new Vector3(p.x, top + 0.06 + rng.range(-0.04, 0.12), p.z), new Vector3(Math.cos(a) * s, rng.range(-0.08, 0.08), Math.sin(a) * s), new Vector3(-Math.sin(a) * s, 0.05, Math.cos(a) * s), up, scaleRgb([1, 1, 1], rng.range(0.75, 1)));
  }
  // the gourds, pale green and long, hanging through the culms
  const gourd = new SphereGeometry(1, 8, 6);
  const n = rng.int(3, 6);
  for (let k = 0; k < n; k++) {
    const p = corner(rng.range(-L / 2, L / 2) * 0.8, rng.range(-W / 2, W / 2) * 0.8);
    const len = rng.range(0.28, 0.4);
    gourds.add(gourd, new Matrix4().makeScale(0.11, len, 0.11).setPosition(p.x, top - len - 0.05, p.z), scaleRgb(rgb('#9db86a'), rng.range(0.85, 1.05)));
  }
}

/** A bamboo fence: posts, two rails, split culms set close side by side. */
function fence(bamboo: MeshBuilder, a: { x: number; z: number }, b: { x: number; z: number }, rng: Rng): void {
  const len = Math.hypot(b.x - a.x, b.z - a.z);
  const at = (t: number) => ({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t });
  const h = 1.15;
  for (let d = 0; d <= len; d += 0.16) {
    const p = at(d / len);
    const y = terrainHeight(p.x, p.z);
    const top = y + h + rng.range(-0.08, 0.06);
    taperedTube(bamboo, [new Vector3(p.x, y - 0.15, p.z), new Vector3(p.x + rng.range(-0.02, 0.02), top, p.z + rng.range(-0.02, 0.02))], [0.022, 0.018], 3, scaleRgb(BAMBOO, rng.range(0.8, 1.05)), 1.2);
  }
  for (const k of [0.3, 0.85]) {
    const pts: Vector3[] = [];
    for (let d = 0; d <= len; d += 1.5) {
      const p = at(d / len);
      pts.push(new Vector3(p.x, terrainHeight(p.x, p.z) + h * k, p.z));
    }
    if (pts.length > 1) taperedTube(bamboo, pts, pts.map(() => 0.03), 4, scaleRgb(BAMBOO, 0.85), 1.2);
  }
}

/** The yards' things, for every homestead. */
export function buildYards(huts: readonly HutPlan[]): Group {
  const rng = new Rng(71);
  const bamboo = new MeshBuilder();
  const cloth = new MeshBuilder();
  const clay = new MeshBuilder();
  const leaves = new MeshBuilder();
  const gourds = new MeshBuilder();
  for (const m of HOMESTEAD_MOUNDS) {
    const kitchen = huts.find((h) => h.kind === 'kitchen' && Math.hypot(h.x - m.x, h.z - m.z) < m.hu + m.hv);
    const k = kitchen ? Math.sign((kitchen.x - m.x) * Math.cos(m.face) - (kitchen.z - m.z) * Math.sin(m.face)) || 1 : 1;
    // the washing line across the yard's side away from the kitchen
    if (rng.next() < 0.75) {
      const v = -k * m.hv * rng.range(0.18, 0.28);
      const a = shapePoint(m, -m.hu * 0.15, v);
      const b = shapePoint(m, m.hu * 0.32, v + rng.range(-1, 1));
      if (ok(huts, a, 0) && ok(huts, b, 0)) washingLine(bamboo, cloth, a, b, rng);
    }
    // water pots by the kitchen's wall, toward the yard
    if (kitchen) {
      const toward = { x: kitchen.x + (m.x - kitchen.x) * 0.22, z: kitchen.z + (m.z - kitchen.z) * 0.22 };
      if (clearOfHouses(huts, toward.x, toward.z, -0.6)) pots(clay, toward.x, toward.z, rng);
    }
    // the tulsi's stand in the middle of some yards
    if (rng.next() < 0.35) {
      const p = shapePoint(m, m.hu * 0.08, rng.range(-1, 1));
      if (ok(huts, p, 0.5)) tulsi(clay, leaves, p.x, p.z, rng);
    }
    // a gourd trellis at the mound's edge on the kitchen's side
    if (rng.next() < 0.5) {
      const u = rng.range(-0.1, 0.35) * m.hu;
      const v = k * (m.hv + 1.5);
      const p = shapePoint(m, u, v);
      if (ok(huts, p, 1.5)) macha(bamboo, leaves, gourds, m, u, v, rng);
    }
    // a bamboo fence along the kitchen's side of the mound
    if (rng.next() < 0.55) {
      const a = shapePoint(m, -m.hu * 0.45, k * (m.hv + 0.3));
      const b = shapePoint(m, m.hu * 0.65, k * (m.hv + 0.3));
      if (ok(huts, a, 0) && ok(huts, b, 0)) fence(bamboo, a, b, rng);
    }
  }
  const group = new Group();
  group.name = 'yards';
  const vine = leafClusterTexture(72, ['#2c4a1c', '#3a5d22', '#4a7029', '#5a8232'], { count: 60, len: [0.16, 0.24], width: 0.85 });
  const add = (b: MeshBuilder, mat: MeshStandardMaterial, cast = true) => {
    if (!b.vertexCount) return;
    const mesh = new Mesh(b.build(), mat);
    mesh.castShadow = cast;
    mesh.receiveShadow = true;
    group.add(mesh);
  };
  // the culms are tubes wound inward (render/builder.ts): drawn from both sides
  add(bamboo, patchMaterial(new MeshStandardMaterial({ vertexColors: true, roughness: 0.7, side: DoubleSide }), { grime: 0.4 }));
  add(cloth, patchMaterial(new MeshStandardMaterial({ vertexColors: true, roughness: 0.9, side: DoubleSide }), { translucency: 0.8, grime: 0.15 }));
  add(clay, patchMaterial(new MeshStandardMaterial({ vertexColors: true, roughness: 0.85 }), { grime: 0.3 }));
  add(gourds, patchMaterial(new MeshStandardMaterial({ vertexColors: true, roughness: 0.55 }), { grime: 0.2 }));
  add(
    leaves,
    patchMaterial(
      new MeshStandardMaterial({ map: vine.map, normalMap: vine.normal, vertexColors: true, alphaTest: 0.42, alphaToCoverage: true, side: DoubleSide, roughness: 0.75 }),
      { translucency: 1, foliage: true, seasonal: 'leaf', wind: 0.05, windHeight: 4 },
    ),
  );
  return group;
}
