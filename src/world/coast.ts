import { BoxGeometry, DoubleSide, Group, LatheGeometry, Matrix4, Mesh, MeshStandardMaterial, Quaternion, Vector2, Vector3 } from 'three';
import type { BufferGeometry } from 'three';
import { LAYER_NO_REFLECT } from '../core/globals';
import { Rng } from '../core/rng';
import { MeshBuilder, mixRgb, rgb, scaleRgb, type RGB } from '../render/builder';
import { instanced, type Placement } from '../render/instancing';
import { patchMaterial } from '../render/patch';
import { WORLD_U, WORLD_Z0, WORLD_Z1, riverX, saltPan, terrainHeight } from './geography';

// The salt works on Moheshkhali's low tract and the mainland's flats toward Cox's Bazar. The ground of each
// block is painted by the terrain (render/patch.ts):
// salt farms (a settling pond, evaporation beds, crystallizers on black plastic), shrimp ponds and barren
// mudflat. Here is what stands on it: the earth bunds between the beds and round every block; the heaps of
// salt raked up along the crystallizers' bunds (white and drying while the salt season runs, gone to market
// in the rains); and on the barren blocks the storage yards, the low thatched sheds (gola) the salt is kept
// in and the big heaps kept under black sheeting all year.

/**
 * The layout, as the terrain shader draws it: blocks in a frame turned in bands 300 m long; in a farm, the
 * settling pond up to POND of the block's length, evaporation beds up to EVAPORATION, then crystallizers.
 * Keep the two in step.
 */
const LAYOUT = { band: 300, w: 96, h: 60, pond: 0.22, evaporation: 0.5, evapCell: [8.96, 10], crystalCell: [8, 5], rimInset: 2.3 } as const;
const blockAngle = (z: number) => 0.12 + 0.2 * Math.sin(Math.floor(z / LAYOUT.band) * 2.3);
type BlockKind = 'farm' | 'pond' | 'flat';
function blockKind(bx: number, by: number): BlockKind {
  const k = Math.sin(bx * 3.1 + by * 1.3 + 0.7);
  return k > 0.6 ? 'flat' : k < -0.75 ? 'pond' : 'farm';
}

/** Where the salt works lie well inside (their edges fade into the coastal grass). */
const SOLID = 0.7;

/** A bund's cross-section (m): its foot, its crown, its height. */
const BUND = { foot: 0.8, crown: 0.36, height: 0.28 };
const CLAY: RGB = rgb('#6f685d');
const CROWN: RGB = rgb('#857c70');
const RIME: RGB = rgb('#b9b6ae');

/** An earth bund from (x0, z0) to (x1, z1) standing at height y: a low ridge, its crown worn pale, rimed white at its foot. */
function bund(b: MeshBuilder, x0: number, z0: number, x1: number, z1: number, y: number): void {
  const dx = x1 - x0;
  const dz = z1 - z0;
  const len = Math.hypot(dx, dz);
  if (len < 0.5) return;
  const ax = dx / len;
  const az = dz / len;
  // across the bund, horizontally
  const cx = -az;
  const cz = ax;
  const f = BUND.foot / 2;
  const c = BUND.crown / 2;
  const h = BUND.height;
  const at = (x: number, z: number, across: number, up: number) => new Vector3(x + cx * across, y + up, z + cz * across);
  const slope = Math.atan2(h, f - c);
  for (const side of [-1, 1]) {
    const n = new Vector3(cx * side * Math.sin(slope), Math.cos(slope), cz * side * Math.sin(slope));
    const s = b.vertexCount;
    b.vertex(at(x0, z0, side * f, -0.04), n, 0, 0, mixRgb(CLAY, RIME, 0.2));
    b.vertex(at(x1, z1, side * f, -0.04), n, 1, 0, mixRgb(CLAY, RIME, 0.2));
    b.vertex(at(x1, z1, side * c, h), n, 1, 1, CLAY);
    b.vertex(at(x0, z0, side * c, h), n, 0, 1, CLAY);
    if (side > 0) b.quad(s, s + 1, s + 2, s + 3);
    else b.quad(s, s + 3, s + 2, s + 1);
  }
  const up = new Vector3(0, 1, 0);
  const s = b.vertexCount;
  b.vertex(at(x0, z0, -c, h), up, 0, 0, CROWN);
  b.vertex(at(x0, z0, c, h), up, 0, 1, CROWN);
  b.vertex(at(x1, z1, c, h), up, 1, 1, CROWN);
  b.vertex(at(x1, z1, -c, h), up, 1, 0, CROWN);
  b.quad(s, s + 1, s + 2, s + 3);
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

/** The lines a block's bunds run along, in its own frame (qx along its length, qy across): [x0, y0, x1, y1]. */
function bundLines(kind: BlockKind): [number, number, number, number][] {
  const { w, h, rimInset: r } = LAYOUT;
  // the bund round the block, inside its feeder channel
  const lines: [number, number, number, number][] = [
    [r, r, w - r, r],
    [r, h - r, w - r, h - r],
    [r, r, r, h - r],
    [w - r, r, w - r, h - r],
  ];
  if (kind !== 'farm') return lines;
  const e0 = w * LAYOUT.pond;
  const c0 = w * LAYOUT.evaporation;
  // the settling pond's bund, and the evaporation beds' and crystallizers' between them
  lines.push([e0, r, e0, h - r], [c0, r, c0, h - r]);
  for (let x = e0 + LAYOUT.evapCell[0]; x < c0 - 1; x += LAYOUT.evapCell[0]) lines.push([x, r, x, h - r]);
  for (let y = LAYOUT.evapCell[1]; y < h - 1; y += LAYOUT.evapCell[1]) lines.push([e0, y, c0, y]);
  for (let x = c0 + LAYOUT.crystalCell[0]; x < w - 1; x += LAYOUT.crystalCell[0]) lines.push([x, r, x, h - r]);
  for (let y = LAYOUT.crystalCell[1]; y < h - 1; y += LAYOUT.crystalCell[1]) lines.push([c0, y, w - r, y]);
  return lines;
}

export function buildSaltWorks(): Group {
  const group = new Group();
  group.name = 'saltworks';
  const rng = new Rng(97);
  const fresh: Placement[] = [];
  const covered: Placement[] = [];
  const sheds = new MeshBuilder();
  // the bunds, in cells of the coast so those out of view, or far off, are left undrawn
  const slabs = new Map<number, MeshBuilder>();
  const slabOf = (x: number, z: number) => {
    const k = Math.floor(z / 300) * 64 + Math.floor(x / 400);
    let b = slabs.get(k);
    if (!b) slabs.set(k, (b = new MeshBuilder()));
    return b;
  };
  const z0 = WORLD_Z1;
  const z1 = WORLD_Z0;
  for (let band = Math.floor(z0 / LAYOUT.band); band <= Math.floor(z1 / LAYOUT.band); band++) {
    const a = blockAngle(band * LAYOUT.band);
    const c = Math.cos(a);
    const s = Math.sin(a);
    const toWorld = (qx: number, qy: number): [number, number] => [c * qx - s * qy, s * qx + c * qy];
    const inBand = (z: number) => Math.floor(z / LAYOUT.band) === band;
    // the blocks that can touch this band of the coast
    const xs = [riverX(band * LAYOUT.band) - WORLD_U, riverX(band * LAYOUT.band) + WORLD_U];
    const zs = [band * LAYOUT.band, (band + 1) * LAYOUT.band];
    const qxs = xs.flatMap((x) => zs.map((z) => c * x + s * z));
    const qys = xs.flatMap((x) => zs.map((z) => -s * x + c * z));
    for (let bx = Math.floor(Math.min(...qxs) / LAYOUT.w); bx <= Math.floor(Math.max(...qxs) / LAYOUT.w); bx++) {
      for (let by = Math.floor(Math.min(...qys) / LAYOUT.h); by <= Math.floor(Math.max(...qys) / LAYOUT.h); by++) {
        const kind = blockKind(bx, by);
        const ox = bx * LAYOUT.w;
        const oy = by * LAYOUT.h;
        const [mx, mz] = toWorld(ox + LAYOUT.w / 2, oy + LAYOUT.h / 2);
        if (!inBand(mz) || saltPan(mx, mz) < 0.3) continue;
        // bunds, in pieces (so each follows the level ground closely enough); on a block at the works' edge,
        // only the pieces where the works lie solid (most blocks lie wholly inside)
        const corners = [
          [0, 0],
          [LAYOUT.w, 0],
          [0, LAYOUT.h],
          [LAYOUT.w, LAYOUT.h],
        ].map(([qx, qy]) => toWorld(ox + qx, oy + qy));
        const solid = corners.every(([x, z]) => inBand(z) && saltPan(x, z) > SOLID);
        for (const [x0, y0, x1, y1] of bundLines(kind)) {
          const steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / (solid ? 24 : 8)));
          for (let k = 0; k < steps; k++) {
            const [ax, az] = toWorld(ox + x0 + ((x1 - x0) * k) / steps, oy + y0 + ((y1 - y0) * k) / steps);
            const [bx2, bz2] = toWorld(ox + x0 + ((x1 - x0) * (k + 1)) / steps, oy + y0 + ((y1 - y0) * (k + 1)) / steps);
            const mxk = (ax + bx2) / 2;
            const mzk = (az + bz2) / 2;
            if (!solid && !(inBand(mzk) && saltPan(mxk, mzk) > SOLID)) continue;
            bund(slabOf(ax, az), ax, az, bx2, bz2, terrainHeight(mxk, mzk));
          }
        }
        if (kind === 'farm') {
          // the year's salt, raked up along the crystallizers' bunds in rows of heaps; now and then an old heap kept covered
          for (let k = 0; k < 10; k++) {
            if (rng.next() < 0.3) continue;
            const col = rng.int(0, 5);
            const row = rng.int(1, 11);
            const qx = ox + LAYOUT.w * LAYOUT.evaporation + (col + 0.5) * LAYOUT.crystalCell[0];
            const qy = oy + row * LAYOUT.crystalCell[1];
            const n = rng.int(1, 3);
            for (let i = 0; i < n; i++) {
              const [x, z] = toWorld(qx + (i - (n - 1) / 2) * 2.4, qy);
              if (!inBand(z) || saltPan(x, z) < SOLID) continue;
              const p = { x, y: terrainHeight(x, z) + BUND.height - 0.08, z, ry: rng.range(0, Math.PI * 2), s: rng.range(0.6, 0.95), sy: rng.range(0.9, 1.25) };
              (rng.next() < 0.1 ? covered : fresh).push(p);
            }
          }
        } else if (kind === 'flat' && rng.next() < 0.55) {
          // a storage yard on the barren ground: a gola or two, and the big heaps kept under black sheeting
          const n = rng.int(1, 2);
          for (let i = 0; i < n; i++) {
            const [x, z] = toWorld(ox + LAYOUT.w * rng.range(0.25, 0.75), oy + LAYOUT.h * rng.range(0.3, 0.7));
            if (!inBand(z) || saltPan(x, z) < SOLID) continue;
            shed(sheds, new Vector3(x, terrainHeight(x, z) - 0.05, z), -a + (rng.next() < 0.5 ? 0 : Math.PI / 2), rng);
            for (let k = rng.int(1, 3); k > 0; k--) {
              const hx = x + rng.range(-12, 12);
              const hz = z + rng.range(-12, 12);
              if (saltPan(hx, hz) < SOLID) continue;
              covered.push({ x: hx, y: terrainHeight(hx, hz) - 0.05, z: hz, ry: rng.range(0, Math.PI * 2), s: rng.range(1.6, 2.6), sy: rng.range(0.7, 0.95) });
            }
          }
        }
      }
    }
  }
  const bundMat = patchMaterial(new MeshStandardMaterial({ vertexColors: true, roughness: 0.95 }), { grime: 0.45 });
  for (const b of slabs.values()) {
    if (!b.vertexCount) continue;
    const mesh = new Mesh(b.build(), bundMat);
    mesh.receiveShadow = true;
    // inland, out of the river's mirror
    mesh.layers.set(LAYER_NO_REFLECT);
    group.add(mesh);
  }
  // the fresh heaps rise through the salt season and are gone to market by the rains (G.uSeasonB.w)
  const seasonal = { key: 'salt-season', pars: '', code: 'transformed *= smoothstep(0.15, 0.55, uSeasonB.w);' };
  const saltMat = patchMaterial(new MeshStandardMaterial({ color: '#e9e7e1', roughness: 0.55 }), { grime: 0.08, vertex: seasonal });
  const coverMat = patchMaterial(new MeshStandardMaterial({ color: '#2a2622', roughness: 0.45 }), { grime: 0.3 });
  const geometry = heap();
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
