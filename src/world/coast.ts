import { BoxGeometry, DoubleSide, Group, LatheGeometry, Matrix4, Mesh, MeshStandardMaterial, Quaternion, Vector2, Vector3 } from 'three';
import type { BufferGeometry } from 'three';
import { LAYER_NO_REFLECT } from '../core/globals';
import { Rng } from '../core/rng';
import { MeshBuilder, rgb, scaleRgb } from '../render/builder';
import { instanced, type Placement } from '../render/instancing';
import { patchMaterial } from '../render/patch';
import { COAST_Z0, WORLD_Z1, riverX, saltPan, terrainHeight } from './geography';

// The salt works on the coastal flats. The pans themselves are painted by the terrain (render/patch.ts):
// small square pans behind clay bunds, each at its stage of the work in the dry months. Here are the heaps
// raked up along the bunds (white and drying while the salt season runs, gone to market in the rains) and
// the older heaps kept under straw and black sheeting all year, and the low thatched sheds (gola) the salt
// is stored in.

/**
 * The pans' layout, as the terrain shader (render/patch.ts) draws it: turned in bands 300 m long, in blocks
 * (some fallow) of pans whose size changes from block to block. Keep the two in step.
 */
const PAN = { w: 16, h: 10, band: 300, blockW: 96, blockH: 60 };
const panAngle = (z: number) => 0.12 + 0.2 * Math.sin(Math.floor(z / PAN.band) * 2.3);

/** The nearest corner of a pan to (qx, qy) in the pans' turned frame, or null on a fallow block or at a block's edge. */
function panCorner(qx: number, qy: number): [number, number] | null {
  const bx = Math.floor(qx / PAN.blockW);
  const by = Math.floor(qy / PAN.blockH);
  if (Math.sin(bx * 3.1 + by * 1.3 + 0.7) >= 0.55) return null;
  const k = 0.8 + 0.4 * (0.5 + 0.5 * Math.sin(bx * 1.7 + by * 2.9));
  const w = PAN.w * k;
  const h = PAN.h * k;
  const lx = Math.round((qx - bx * PAN.blockW) / w) * w;
  const ly = Math.round((qy - by * PAN.blockH) / h) * h;
  // inside the block, clear of the channel round it
  if (lx < 3 || ly < 3 || lx > Math.floor(PAN.blockW / w) * w - 1 || ly > Math.floor(PAN.blockH / h) * h - 1) return null;
  return [bx * PAN.blockW + lx, by * PAN.blockH + ly];
}

/** A heap of salt: a rounded cone, raked smooth. */
function heap(): BufferGeometry {
  return new LatheGeometry(
    [
      [0, 0],
      [1.0, 0],
      [0.82, 0.36],
      [0.42, 0.74],
      [0, 0.9],
    ].map(([r, y]) => new Vector2(r, y)),
    9,
  );
}

/** A gola: woven-bamboo walls under a low thatched roof, a doorway on its long side. */
function shed(b: MeshBuilder, at: Vector3, yaw: number, rng: Rng): void {
  const q = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), yaw);
  const place = (x: number, y: number, z: number) => new Vector3(x, y, z).applyQuaternion(q).add(at);
  const L = rng.range(4, 6);
  const W = rng.range(2.6, 3.4);
  const wallH = 1.5;
  const wall = scaleRgb(rgb('#9a8466'), rng.range(0.85, 1.05));
  for (const [x, z, w, d] of [
    [0, -W / 2, L, 0.06],
    [0, W / 2, L, 0.06],
    [-L / 2, 0, 0.06, W],
    [L / 2, 0, 0.06, W],
  ] as const) {
    b.add(new BoxGeometry(w, wallH, d), new Matrix4().compose(place(x, wallH / 2, z), q, new Vector3(1, 1, 1)), wall);
  }
  // the dark doorway
  b.add(new BoxGeometry(0.9, 1.25, 0.02), new Matrix4().compose(place(L * 0.15, 0.62, W / 2 + 0.04), q, new Vector3(1, 1, 1)), rgb('#1e1812'));
  // the roof: two thatched slopes meeting at a ridge, overhanging the walls
  const thatch = scaleRgb(rgb('#8a7448'), rng.range(0.85, 1.05));
  const ridge = wallH + 1.0;
  for (const s of [-1, 1]) {
    const first = b.vertexCount;
    const eave = s * (W / 2 + 0.45);
    const n = new Vector3(0, W / 2 + 0.45, s * 1.0).normalize().applyQuaternion(q);
    b.vertex(place(-L / 2 - 0.4, wallH - 0.15, eave), n, 0, 0, thatch);
    b.vertex(place(L / 2 + 0.4, wallH - 0.15, eave), n, 1, 0, thatch);
    b.vertex(place(L / 2 + 0.4, ridge, 0), n, 1, 1, scaleRgb(thatch, 0.85));
    b.vertex(place(-L / 2 - 0.4, ridge, 0), n, 0, 1, scaleRgb(thatch, 0.85));
    if (s > 0) b.quad(first, first + 1, first + 2, first + 3);
    else b.quad(first, first + 3, first + 2, first + 1);
  }
}

export function buildSaltWorks(): Group {
  const group = new Group();
  group.name = 'saltworks';
  const rng = new Rng(97);
  const fresh: Placement[] = [];
  const covered: Placement[] = [];
  const sheds = new MeshBuilder();
  for (let k = 0, placed = 0; k < 9000 && placed < 260; k++) {
    // a random point on the flats, moved onto the nearest corner of the pans' bunds
    const z0 = rng.range(WORLD_Z1 + 40, COAST_Z0 - 120);
    const x0 = riverX(z0) + rng.sign() * rng.range(30, 700);
    const a = panAngle(z0);
    const c = Math.cos(a);
    const s = Math.sin(a);
    const corner = panCorner(c * x0 + s * z0, -s * x0 + c * z0);
    if (!corner) continue;
    const [qx, qy] = corner;
    const x = c * qx - s * qy;
    const z = s * qx + c * qy;
    if (Math.floor(z / PAN.band) !== Math.floor(z0 / PAN.band) || saltPan(x, z) < 0.75) continue;
    placed++;
    const y = terrainHeight(x, z) - 0.05;
    // a row of heaps along the bund, the year's salt; now and then an old heap kept covered
    const row = rng.int(1, 4);
    for (let i = 0; i < row; i++) {
      const along = (i - (row - 1) / 2) * 2.6;
      const p = { x: x + c * along, y, z: z + s * along, ry: rng.range(0, Math.PI * 2), s: rng.range(0.8, 1.5), sy: rng.range(0.8, 1.2) };
      (rng.next() < 0.12 ? covered : fresh).push(p);
    }
    if (rng.next() < 0.05) shed(sheds, new Vector3(x + c * 9, y, z + s * 9).setY(terrainHeight(x + c * 9, z + s * 9) - 0.05), a, rng);
  }
  // the fresh heaps rise through the salt season and are gone to market by the rains (G.uSeasonB.w)
  const seasonal = { key: 'salt-season', pars: '', code: 'transformed *= smoothstep(0.15, 0.55, uSeasonB.w);' };
  const saltMat = patchMaterial(new MeshStandardMaterial({ color: '#e9e7e1', roughness: 0.55 }), { grime: 0.08, vertex: seasonal });
  const coverMat = patchMaterial(new MeshStandardMaterial({ color: '#2a2622', roughness: 0.45 }), { grime: 0.3 });
  const geometry = heap();
  // inland, out of the river's mirror
  if (fresh.length) group.add(instanced(geometry, saltMat, fresh, { cast: true, layer: LAYER_NO_REFLECT }));
  if (covered.length) group.add(instanced(geometry, coverMat, covered, { cast: true, layer: LAYER_NO_REFLECT }));
  if (sheds.vertexCount) {
    const mesh = new Mesh(sheds.build(), patchMaterial(new MeshStandardMaterial({ vertexColors: true, roughness: 0.9, side: DoubleSide }), { grime: 0.35 }));
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  return group;
}
