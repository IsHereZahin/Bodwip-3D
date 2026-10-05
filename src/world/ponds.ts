import { BufferGeometry, DoubleSide, Group, MeshStandardMaterial, Vector3 } from 'three';
import { LAYER_NO_REFLECT } from '../core/globals';
import { Rng } from '../core/rng';
import { MeshBuilder, mixRgb, rgb, type RGB } from '../render/builder';
import { instanced, type Placement } from '../render/instancing';
import { patchMaterial } from '../render/patch';
import { PONDS, pondReach, shapePoint, terrainHeight } from './geography';

// Shapla (water lilies) on the village's old ponds: notched pads lying flat in loose rafts toward the edges,
// and here and there a white or pink flower held just above the water, with clumps of reeds (nol-khagra)
// standing along their banks, swaying in the wind. The lilies lie on each pond's own water and are set only
// over beds that stay under water. (The floating hyacinth is world/drift.ts's.)

const UP = new Vector3(0, 1, 0);

/** The ponds shapla grows on: the old ones the design leaves to the lilies (a village's fish ponds are kept clear). */
export const LILY_PONDS = PONDS.filter((p) => p.lilies);

/** A round pad with the lily's notch, its rim turned up a little. */
function pad(): BufferGeometry {
  const b = new MeshBuilder();
  const N = 14;
  const notch = 0.35;
  const c = b.vertex(new Vector3(0, 0.004, 0), UP, 0.5, 0.5, rgb('#2c4f1a'));
  const ring: number[] = [];
  for (let k = 0; k <= N; k++) {
    const a = notch / 2 + (k / N) * (Math.PI * 2 - notch);
    const rim = 0.012 * (1 + 0.5 * Math.sin(k * 2.3));
    const col = mixRgb(rgb('#335e1d'), rgb('#4f7c2a'), (Math.sin(k * 1.7) + 1) / 2);
    ring.push(b.vertex(new Vector3(Math.cos(a), rim, Math.sin(a)), UP, 0, 0, col));
  }
  for (let k = 0; k < N; k++) b.tri(c, ring[k + 1], ring[k]);
  return b.build();
}

/** An open water lily: two rings of pointed petals round a golden centre. */
function lily(petal: RGB): BufferGeometry {
  const b = new MeshBuilder();
  const centre = b.vertex(new Vector3(0, 0.05, 0), UP, 0.5, 0.5, rgb('#f0c53a'));
  for (const [count, len, lift, phase] of [
    [10, 0.075, 0.55, 0],
    [8, 0.06, 1.0, 0.3],
  ] as const) {
    for (let k = 0; k < count; k++) {
      const a = (k / count) * Math.PI * 2 + phase;
      const out = new Vector3(Math.cos(a), lift, Math.sin(a)).normalize();
      const side = new Vector3(-Math.sin(a), 0, Math.cos(a)).multiplyScalar(0.016);
      const base = new Vector3(0, 0.03, 0);
      const tip = base.clone().addScaledVector(out, len);
      const mid = base.clone().addScaledVector(out, len * 0.45);
      const n = out.clone().add(UP).normalize();
      const p0 = b.vertex(mid.clone().add(side), n, 0, 0, petal);
      const p1 = b.vertex(tip, n, 0, 0, mixRgb(petal, [1, 1, 1], 0.2));
      const p2 = b.vertex(mid.clone().sub(side), n, 0, 0, petal);
      b.tri(centre, p0, p1);
      b.tri(centre, p1, p2);
    }
  }
  return b.build();
}

/** A clump of reeds: tall, thin, arching blades, green below and drying straw-coloured at the tips. */
function reeds(rng: Rng): BufferGeometry {
  const b = new MeshBuilder();
  const blades = 16;
  for (let k = 0; k < blades; k++) {
    const a = rng.range(0, Math.PI * 2);
    const h = rng.range(1.5, 2.7);
    const lean = rng.range(0.1, 0.4);
    const w = rng.range(0.025, 0.045);
    const root = new Vector3(Math.cos(a) * rng.range(0, 0.45), 0, Math.sin(a) * rng.range(0, 0.45));
    const out = new Vector3(Math.cos(a), 0, Math.sin(a));
    const side = new Vector3(-Math.sin(a), 0, Math.cos(a));
    const first = b.vertexCount;
    const N = 3;
    for (let i = 0; i <= N; i++) {
      const t = i / N;
      const p = root.clone().addScaledVector(UP, h * t).addScaledVector(out, lean * h * t * t);
      const col = mixRgb(rgb('#3d5a22'), rgb('#a8955a'), Math.max(0, t - 0.55) / 0.45);
      const half = w * (1 - t * 0.9);
      b.vertex(p.clone().addScaledVector(side, -half), out, 0, t, col);
      b.vertex(p.clone().addScaledVector(side, half), out, 1, t, col);
    }
    for (let i = 0; i < N; i++) b.quad(first + i * 2, first + i * 2 + 1, first + i * 2 + 3, first + i * 2 + 2);
    // a feathery plume on some
    if (k % 4 === 0) {
      const tip = root.clone().addScaledVector(UP, h * 1.02).addScaledVector(out, lean * h);
      const c = b.vertexCount;
      b.vertex(tip.clone().addScaledVector(side, -0.05), out, 0, 0, rgb('#b8a27a'));
      b.vertex(tip.clone().addScaledVector(side, 0.05), out, 1, 0, rgb('#b8a27a'));
      b.vertex(tip.clone().addScaledVector(UP, 0.32).addScaledVector(out, 0.08), out, 0.5, 1, rgb('#d2c09a'));
      b.tri(c, c + 1, c + 2);
    }
  }
  return b.build();
}

export function buildPondLife(): Group {
  const group = new Group();
  group.name = 'ponds';
  const rng = new Rng(51);
  const pads: Placement[] = [];
  const white: Placement[] = [];
  const pink: Placement[] = [];
  // the old ponds (dug deep: water all year almost to their edges)
  // (`bed`: how far under the water's surface a bed must lie for lilies)
  for (const p of LILY_PONDS) {
    // rafts of pads, each grown out from a point toward the edge of the open water
    const rafts = rng.int(3, 5);
    for (let r = 0; r < rafts; r++) {
      const at = shapePoint(p, rng.range(-0.75, 0.75) * p.hu, rng.range(-0.75, 0.75) * p.hv);
      const n = rng.int(26, 44);
      for (let i = 0; i < n; i++) {
        const d = Math.sqrt(rng.next()) * rng.range(2.5, 5.5);
        const b = rng.range(0, Math.PI * 2);
        const x = at.x + Math.cos(b) * d;
        const z = at.z + Math.sin(b) * d;
        if (pondReach(p, x, z) > 0.92 || terrainHeight(x, z) > p.level - 0.25) continue;
        const s = rng.range(0.2, 0.36);
        pads.push({ x, y: p.level + 0.01, z, ry: rng.range(0, Math.PI * 2), s, tx: rng.range(-0.03, 0.03), tz: rng.range(-0.03, 0.03) });
        if (rng.next() < 0.2) {
          (rng.next() < 0.6 ? white : pink).push({ x: x + rng.range(-0.1, 0.1), y: p.level + 0.02, z: z + rng.range(-0.1, 0.1), ry: rng.range(0, 6.28), s: rng.range(1.3, 1.8) });
        }
      }
    }
  }
  const leafMat = patchMaterial(new MeshStandardMaterial({ vertexColors: true, roughness: 0.32, side: DoubleSide }), { grime: 0.25 });
  const flowerMat = patchMaterial(new MeshStandardMaterial({ vertexColors: true, roughness: 0.6, side: DoubleSide }), {
    translucency: 1.4,
  });
  const add = (g: BufferGeometry, mat: MeshStandardMaterial, items: Placement[]) => {
    if (!items.length) return;
    const mesh = instanced(g, mat, items, { receive: true, layer: LAYER_NO_REFLECT });
    group.add(mesh);
  };
  add(pad(), leafMat, pads);
  add(lily(rgb('#f4f1ea')), flowerMat, white);
  add(lily(rgb('#e88aa8')), flowerMat, pink);

  // reeds in clumps along the old ponds' banks, at the water's edge, thick in places and none in others
  const reedSpots: Placement[] = [];
  for (const p of LILY_PONDS) {
    for (let k = 0; k < 60; k++) {
      const a = rng.range(0, Math.PI * 2);
      if (Math.sin(a * 3 + p.x) + Math.sin(a * 5 + p.z) < 0.3) continue;
      const e = shapePoint(p, Math.cos(a) * p.hu * 1.25, Math.sin(a) * p.hv * 1.25);
      // walk in from the dug edge to the water's edge
      let x = e.x;
      let z = e.z;
      for (let t = 0; t < 12 && pondReach(p, x, z) > 1.02; t++) {
        x += (p.x - x) * 0.08;
        z += (p.z - z) * 0.08;
      }
      reedSpots.push({ x, y: terrainHeight(x, z) - 0.05, z, ry: rng.range(0, Math.PI * 2), s: rng.range(0.7, 1.1) });
    }
  }
  const reedMat = patchMaterial(new MeshStandardMaterial({ vertexColors: true, roughness: 0.8, side: DoubleSide }), {
    wind: 0.5,
    windHeight: 2.2,
    translucency: 1,
    seasonal: 'leaf',
  });
  // small, and off the boat's waters: their reflections are not worth drawing
  if (reedSpots.length) group.add(instanced(reeds(new Rng(57)), reedMat, reedSpots, { receive: true, layer: LAYER_NO_REFLECT }));
  return group;
}
