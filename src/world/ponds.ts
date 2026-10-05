import { BufferGeometry, DoubleSide, Group, MeshStandardMaterial, Vector3 } from 'three';
import { LAYER_NO_REFLECT } from '../core/globals';
import { Rng } from '../core/rng';
import { MeshBuilder, mixRgb, rgb, type RGB } from '../render/builder';
import { instanced, type Placement } from '../render/instancing';
import { patchMaterial } from '../render/patch';
import { PONDS, WETLANDS, terrainHeight, wetlandPoint, wetlandReach } from './geography';

// Shapla (water lilies) on some of the village ponds and the small wetlands: notched pads lying flat in loose
// rafts toward the edges, and here and there a white or pink flower held just above the water. The
// wetlands also have reeds (nol-khagra) standing round their rims, swaying in the wind, and rafts of water
// hyacinth (kochuripana) afloat on their open water. The lilies lie on each pond's own water (its level in
// the map); the wetlands' hyacinth rides the season's. They are set only over beds that stay under water.

const UP = new Vector3(0, 1, 0);

/**
 * The ponds shapla grows on: about one in three (a village's fish ponds are kept clear, its old and fallow
 * ones lie under lilies) [মডেল], chosen once.
 */
export const LILY_PONDS = (() => {
  const rng = new Rng(52);
  return PONDS.filter(() => rng.next() < 0.35);
})();

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

/** A water-hyacinth rosette: glossy, rounded leaves on swollen stalks standing up out of the water, and a lilac spike. */
function hyacinth(): BufferGeometry {
  const b = new MeshBuilder();
  const leaves = 7;
  for (let k = 0; k < leaves; k++) {
    const a = (k / leaves) * Math.PI * 2 + (k % 2) * 0.3;
    const out = new Vector3(Math.cos(a), 0, Math.sin(a));
    const side = new Vector3(-Math.sin(a), 0, Math.cos(a));
    const stalk = 0.12 + (k % 3) * 0.04;
    const base = out.clone().multiplyScalar(0.05).addScaledVector(UP, stalk);
    const n = out.clone().multiplyScalar(0.6).addScaledVector(UP, 0.8).normalize();
    const col = mixRgb(rgb('#2f6a20'), rgb('#4f8a2c'), (k % 3) / 2);
    const c = b.vertex(base, n, 0.5, 0.5, col);
    const ring: number[] = [];
    const R = 0.075;
    for (let i = 0; i <= 8; i++) {
      const t = (i / 8) * Math.PI * 2;
      const p = base
        .clone()
        .addScaledVector(side, Math.cos(t) * R)
        .addScaledVector(out, (Math.sin(t) + 1) * R * 0.9)
        .addScaledVector(UP, (Math.sin(t) + 1) * R * 0.7);
      ring.push(b.vertex(p, n, 0, 0, col));
    }
    for (let i = 0; i < 8; i++) b.tri(c, ring[i], ring[i + 1]);
    // the spongy stalk
    const s0 = b.vertex(out.clone().multiplyScalar(0.01), side, 0, 0, rgb('#5a8a3a'));
    const s1 = b.vertex(out.clone().multiplyScalar(0.01).addScaledVector(side, 0.025), side, 0, 0, rgb('#5a8a3a'));
    const s2 = b.vertex(base, side, 0, 0, rgb('#4a7a2e'));
    b.tri(s0, s1, s2);
  }
  // the flower spike
  for (let k = 0; k < 6; k++) {
    const y = 0.26 + k * 0.035;
    const a = k * 2.1;
    const c = new Vector3(Math.cos(a) * 0.025, y, Math.sin(a) * 0.025);
    const i0 = b.vertex(c.clone().add(new Vector3(-0.03, 0, 0)), UP, 0, 0, rgb('#b79ad8'));
    const i1 = b.vertex(c.clone().add(new Vector3(0.03, 0, 0)), UP, 0, 0, rgb('#b79ad8'));
    const i2 = b.vertex(c.clone().add(new Vector3(0, 0.035, 0.01)), UP, 0, 0, rgb('#d8c8f0'));
    b.tri(i0, i1, i2);
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
  // the ponds (dug deep: water all year almost to their edges) and the small wetlands (shallow: only their
  // middles stay wet through the dry months)
  // (`bed`: how far under the water's surface a bed must lie for lilies)
  const waters = [
    ...LILY_PONDS.map((p) => ({ ...p, reach: 0.8, rafts: rng.int(3, 4), bed: 0.25, inside: (x: number, z: number) => Math.hypot(x - p.x, z - p.z) < p.r * 0.92 })),
    ...WETLANDS.map((w) => ({ ...w, level: 0, reach: 0.5, rafts: rng.int(6, 8), bed: 0.75, inside: (x: number, z: number) => wetlandReach(w, x, z) < 0.9 })),
  ];
  for (const p of waters) {
    // rafts of pads, each grown out from a point toward the edge of the open water
    for (let r = 0; r < p.rafts; r++) {
      const a = rng.range(0, Math.PI * 2);
      const cx = p.x + Math.cos(a) * p.r * rng.range(0.45, 1) * p.reach;
      const cz = p.z + Math.sin(a) * p.r * rng.range(0.45, 1) * p.reach;
      const n = rng.int(26, 44);
      for (let i = 0; i < n; i++) {
        const d = Math.sqrt(rng.next()) * rng.range(2.5, 5.5);
        const b = rng.range(0, Math.PI * 2);
        const x = cx + Math.cos(b) * d;
        const z = cz + Math.sin(b) * d;
        if (!p.inside(x, z) || terrainHeight(x, z) > p.level - p.bed) continue;
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
  // the wetlands' hyacinth floats on their water, which rises and falls with the season's
  const afloat = { key: 'afloat', pars: '', code: 'transformed.y += uWaterLevel / length(instanceMatrix[0].xyz);' };
  const add = (g: BufferGeometry, mat: MeshStandardMaterial, items: Placement[]) => {
    if (!items.length) return;
    const mesh = instanced(g, mat, items, { receive: true, layer: LAYER_NO_REFLECT });
    group.add(mesh);
  };
  add(pad(), leafMat, pads);
  add(lily(rgb('#f4f1ea')), flowerMat, white);
  add(lily(rgb('#e88aa8')), flowerMat, pink);

  // the wetlands' reeds round their rims (rooted: in the rains they stand in the water) and hyacinth afloat
  const reedSpots: Placement[] = [];
  const hyacinthSpots: Placement[] = [];
  for (const w of WETLANDS) {
    // in beds round the rim, thick in places and thin in others
    for (let k = 0; k < 220; k++) {
      const a = rng.range(0, Math.PI * 2);
      if (Math.sin(a * 4 + w.x) + Math.sin(a * 7 + w.z) < -0.6) continue;
      const { x, z } = wetlandPoint(w, a, rng.range(0.8, 1.3));
      reedSpots.push({ x, y: terrainHeight(x, z) - 0.05, z, ry: rng.range(0, Math.PI * 2), s: rng.range(0.75, 1.2) });
    }
    for (let r = 0; r < 4; r++) {
      const a = rng.range(0, Math.PI * 2);
      const cx = w.x + Math.cos(a) * w.r * rng.range(0.2, 0.45);
      const cz = w.z + Math.sin(a) * w.r * rng.range(0.2, 0.45);
      for (let i = 0; i < 26; i++) {
        const d = Math.sqrt(rng.next()) * 2.4;
        const b = rng.range(0, Math.PI * 2);
        const x = cx + Math.cos(b) * d;
        const z = cz + Math.sin(b) * d;
        if (terrainHeight(x, z) > -0.75) continue;
        hyacinthSpots.push({ x, y: 0, z, ry: rng.range(0, Math.PI * 2), s: rng.range(0.8, 1.25) });
      }
    }
  }
  const reedMat = patchMaterial(new MeshStandardMaterial({ vertexColors: true, roughness: 0.8, side: DoubleSide }), {
    wind: 0.5,
    windHeight: 2.2,
    translucency: 1,
    seasonal: 'leaf',
  });
  const hyacinthMat = patchMaterial(new MeshStandardMaterial({ vertexColors: true, roughness: 0.35, side: DoubleSide }), {
    translucency: 0.8,
    vertex: afloat,
  });
  // out in the fields their reflections are not worth drawing
  if (reedSpots.length) group.add(instanced(reeds(new Rng(57)), reedMat, reedSpots, { receive: true, layer: LAYER_NO_REFLECT }));
  add(hyacinth(), hyacinthMat, hyacinthSpots);
  return group;
}
