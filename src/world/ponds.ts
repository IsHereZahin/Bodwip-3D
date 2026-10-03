import { BufferGeometry, DoubleSide, Group, MeshStandardMaterial, Vector3 } from 'three';
import { LAYER_NO_REFLECT } from '../core/globals';
import { Rng } from '../core/rng';
import { MeshBuilder, mixRgb, rgb, type RGB } from '../render/builder';
import { instanced, type Placement } from '../render/instancing';
import { patchMaterial } from '../render/patch';
import { PONDS, terrainHeight } from './geography';

// Shapla (water lilies) on the village ponds: notched pads lying flat in loose rafts toward the edges,
// and here and there a white or pink flower held just above the water.

const UP = new Vector3(0, 1, 0);

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

export function buildPondLife(): Group {
  const group = new Group();
  group.name = 'ponds';
  const rng = new Rng(51);
  const pads: Placement[] = [];
  const white: Placement[] = [];
  const pink: Placement[] = [];
  for (const p of PONDS) {
    // two or three rafts of pads, each grown out from a point near the edge
    const rafts = rng.int(3, 4);
    for (let r = 0; r < rafts; r++) {
      const a = rng.range(0, Math.PI * 2);
      const cx = p.x + Math.cos(a) * p.r * rng.range(0.45, 0.8);
      const cz = p.z + Math.sin(a) * p.r * rng.range(0.45, 0.8);
      const n = rng.int(26, 44);
      for (let i = 0; i < n; i++) {
        const d = Math.sqrt(rng.next()) * rng.range(2.5, 5.5);
        const b = rng.range(0, Math.PI * 2);
        const x = cx + Math.cos(b) * d;
        const z = cz + Math.sin(b) * d;
        if (Math.hypot(x - p.x, z - p.z) > p.r * 0.92 || terrainHeight(x, z) > -0.25) continue;
        const s = rng.range(0.2, 0.36);
        pads.push({ x, y: 0.01, z, ry: rng.range(0, Math.PI * 2), s, tx: rng.range(-0.03, 0.03), tz: rng.range(-0.03, 0.03) });
        if (rng.next() < 0.2) {
          (rng.next() < 0.6 ? white : pink).push({ x: x + rng.range(-0.1, 0.1), y: 0.02, z: z + rng.range(-0.1, 0.1), ry: rng.range(0, 6.28), s: rng.range(1.3, 1.8) });
        }
      }
    }
  }
  const leafMat = patchMaterial(new MeshStandardMaterial({ vertexColors: true, roughness: 0.32, side: DoubleSide }), { grime: 0.25 });
  const flowerMat = patchMaterial(new MeshStandardMaterial({ vertexColors: true, roughness: 0.6, side: DoubleSide }), { translucency: 1.4 });
  const add = (g: BufferGeometry, mat: MeshStandardMaterial, items: Placement[]) => {
    if (!items.length) return;
    const mesh = instanced(g, mat, items, { receive: true, layer: LAYER_NO_REFLECT });
    group.add(mesh);
  };
  add(pad(), leafMat, pads);
  add(lily(rgb('#f4f1ea')), flowerMat, white);
  add(lily(rgb('#e88aa8')), flowerMat, pink);
  return group;
}
