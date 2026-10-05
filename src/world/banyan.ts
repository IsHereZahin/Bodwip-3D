import { DoubleSide, Group, Mesh, MeshStandardMaterial, Vector2, Vector3 } from 'three';
import { Rng } from '../core/rng';
import { MeshBuilder, card, mixRgb, rgb, scaleRgb, slab, taperedTube, type RGB } from '../render/builder';
import { patchMaterial } from '../render/patch';
import type { Surfaces } from '../render/surfaces';
import { leafClusterTexture, plasterTexture } from '../render/textures';
import { terrainHeight } from './geography';
import { BANYAN } from './plan';

// The old banyan (বটগাছ) at the corner of the river and the khal, the village's meeting place: a trunk grown
// from many fused stems, great limbs spreading level far out over the ground and the water, roots let down
// from them in curtains, a few grown thick into pillars of their own, and a low dome of dark glossy leaves
// thirty metres across. Round its foot the village has built a plastered brick platform (বাঁধানো বটতলা) in
// two steps where people sit; its shade is the hub's.

/** The crown's middle height and its half-spread and half-height (m). */
const CROWN = { y: 9.5, r: BANYAN.crown, h: 6.5 };
const BARK: RGB = rgb('#8a8072');

/** Points along a gently curving limb from `a` to `b`, sagging `sag` m in its middle. */
function limb(a: Vector3, b: Vector3, sag: number, n = 6): Vector3[] {
  const out: Vector3[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    out.push(a.clone().lerp(b, t).add(new Vector3(0, -sag * Math.sin(Math.PI * t) + 0.6 * Math.sin(Math.PI * t * 0.5), 0)));
  }
  return out;
}

/** The banyan, its roots and its platform. */
export function buildBanyan(bark: Surfaces['bark']): Group {
  const rng = new Rng(404);
  // built about the trunk's foot, so the wind bends it from there (patch.ts sways by height in the mesh)
  const X = BANYAN.x;
  const Z = BANYAN.z;
  const Y = terrainHeight(X, Z) - 0.2;
  const x0 = 0;
  const z0 = 0;
  const y0 = 0;
  const groundAt = (x: number, z: number) => terrainHeight(X + x, Z + z) - Y;
  const wood = new MeshBuilder();
  const leaves = new MeshBuilder();
  const stone = new MeshBuilder();
  const at = (x: number, y: number, z: number) => new Vector3(x, y, z);

  // the trunk: fused stems round a core, flaring at the foot
  const stems = 7;
  for (let i = 0; i < stems; i++) {
    const a = (i / stems) * Math.PI * 2 + rng.range(-0.2, 0.2);
    const r = rng.range(0.55, 0.85);
    const lean = rng.range(0.1, 0.4);
    const pts = [0, 1, 2.2, 3.4, 4.4].map((h, k) => at(Math.cos(a) * (r * (1.6 - k * 0.15) + lean * k * 0.2), h, Math.sin(a) * (r * (1.6 - k * 0.15) + lean * k * 0.2)));
    taperedTube(wood, pts, [0.75, 0.6, 0.52, 0.48, 0.42].map((v) => v * rng.range(0.85, 1.1)), 9, scaleRgb(BARK, rng.range(0.85, 1.05)), 2.5);
  }
  // the great limbs, spreading level, each dividing toward its end
  const limbs = 8;
  const tips: Vector3[] = [];
  for (let i = 0; i < limbs; i++) {
    const a = (i / limbs) * Math.PI * 2 + rng.range(-0.25, 0.25);
    const reach = CROWN.r * rng.range(0.7, 0.95);
    const rise = rng.range(5.5, 8.5);
    const base = at(Math.cos(a) * 0.6, 4.2, Math.sin(a) * 0.6);
    const end = at(Math.cos(a) * reach, rise, Math.sin(a) * reach);
    const pts = limb(base, end, rng.range(0.4, 1.4));
    taperedTube(wood, pts, pts.map((_, k) => 0.48 * (1 - (k / pts.length) * 0.75)), 8, scaleRgb(BARK, rng.range(0.8, 1)), 2.5);
    for (let k = 0; k < 3; k++) {
      const from = pts[3 + k];
      const b = a + rng.range(-0.9, 0.9);
      const to = from.clone().add(new Vector3(Math.cos(b) * rng.range(3, 6), rng.range(1.5, 3.5), Math.sin(b) * rng.range(3, 6)));
      const sub = limb(from, to, 0.3, 4);
      taperedTube(wood, sub, sub.map((_, j) => 0.2 * (1 - j / 5)), 6, BARK, 2);
      tips.push(to);
    }
    // roots let down from the limb: a curtain of thin ones, and here and there one grown into a pillar
    for (let k = 1; k < pts.length - 1; k++) {
      const p = pts[k];
      const d = Math.hypot(p.x - x0, p.z - z0);
      if (d < 3) continue;
      const n = rng.int(2, 5);
      for (let j = 0; j < n; j++) {
        const top = p.clone().add(new Vector3(rng.range(-0.6, 0.6), -0.2, rng.range(-0.6, 0.6)));
        const ground = groundAt(top.x, top.z);
        const pillar = d > 5 && rng.next() < 0.12;
        const reach = pillar ? 1 : rng.next() < 0.45 ? rng.range(0.4, 0.8) : 1;
        const foot = top.clone().setY(top.y - (top.y - ground + 0.3) * reach);
        const wob = (t: number) => new Vector3(Math.sin(t * 7 + j) * 0.08, 0, Math.cos(t * 5 + k) * 0.08);
        const line = [0, 0.33, 0.66, 1].map((t) => top.clone().lerp(foot, t).add(wob(t)));
        const r = pillar ? rng.range(0.22, 0.38) : rng.range(0.025, 0.06);
        taperedTube(wood, line, line.map((_, q) => r * (pillar ? 1 + q * 0.12 : 1 - q * 0.3)), pillar ? 7 : 4, scaleRgb(BARK, rng.range(0.85, 1.1)), 2);
      }
    }
  }

  // the crown: a low dome of leaf clusters, densest at its skin, lit as one soft volume
  const dir = new Vector3();
  const up = new Vector3(0, 1, 0);
  for (let k = 0; k < 1500; k++) {
    // a point in the dome's shell, a little more of them toward the tips of the limbs
    const tip = k % 3 === 0 ? rng.pick(tips) : null;
    let p: Vector3;
    if (tip) p = tip.clone().add(new Vector3(rng.range(-2.5, 2.5), rng.range(-1, 1.6), rng.range(-2.5, 2.5)));
    else {
      const a = rng.range(0, Math.PI * 2);
      const e = Math.acos(rng.range(0.05, 1));
      const shell = rng.range(0.7, 1.02);
      p = at(Math.cos(a) * Math.sin(e) * CROWN.r * shell, CROWN.y + Math.cos(e) * CROWN.h * shell - 1.5, Math.sin(a) * Math.sin(e) * CROWN.r * shell);
    }
    const n = dir.set(p.x - x0, (p.y - y0 - CROWN.y + 2) * 1.8, p.z - z0).normalize().clone();
    const facing = n.clone().add(new Vector3(rng.range(-0.7, 0.7), rng.range(-0.5, 0.7), rng.range(-0.7, 0.7))).normalize();
    const right = new Vector3().crossVectors(facing, Math.abs(facing.y) < 0.95 ? up : new Vector3(1, 0, 0)).normalize();
    const vup = new Vector3().crossVectors(right, facing).normalize();
    const s = rng.range(1.1, 1.6);
    // darker underneath and inside
    const ao = 0.45 + 0.55 * Math.min(1, Math.max(0, (p.y - y0 - CROWN.y + 4) / 8));
    card(leaves, p, right.multiplyScalar(s), vup.multiplyScalar(s), n, scaleRgb([1, 1, 1], ao * rng.range(0.85, 1.08)));
  }

  // the platform round its foot: two plastered brick steps, worn, the lower one wider
  const plaster: RGB = rgb('#cfc4ae');
  for (const [r, h] of [
    [4.6, 0.35],
    [3.6, 0.7],
  ] as const) {
    const sides = 10;
    for (let i = 0; i < sides; i++) {
      const a = ((i + 0.5) / sides) * Math.PI * 2;
      const len = 2 * r * Math.tan(Math.PI / sides);
      const cx = x0 + Math.cos(a) * (r - 0.3);
      const cz = z0 + Math.sin(a) * (r - 0.3);
      slab(stone, cx, y0 + h / 2 - 0.1, cz, len + 0.05, h + 0.2, 0.62, Math.PI / 2 - a, scaleRgb(mixRgb(plaster, rgb('#9a8f7c'), rng.next() * 0.4), rng.range(0.92, 1.04)), 1.5);
    }
    // the platform's top, a disc of beaten clay and plaster inside the rim
    const c = stone.vertexCount;
    stone.vertex(new Vector3(x0, y0 + h + 0.005, z0), up, 0, 0, scaleRgb(plaster, 0.85));
    for (let i = 0; i <= sides; i++) {
      const a = (i / sides) * Math.PI * 2;
      stone.vertex(new Vector3(x0 + Math.cos(a) * r, y0 + h + 0.005, z0 + Math.sin(a) * r), up, Math.cos(a), Math.sin(a), scaleRgb(plaster, 0.85));
    }
    for (let i = 0; i < sides; i++) stone.tri(c, c + i + 2, c + i + 1);
  }

  const group = new Group();
  group.name = 'banyan';
  const leafTex = leafClusterTexture(405, ['#1d3312', '#253f16', '#2f4d1b', '#3a5c21', '#47692a'], { count: 120, len: [0.1, 0.16], width: 0.55 });
  const woodMat = patchMaterial(
    new MeshStandardMaterial({ map: bark?.color ?? null, normalMap: bark?.normal ?? null, vertexColors: true, roughness: 0.9, side: DoubleSide }),
    { grime: 0.35, wind: 0.2, windHeight: 14 },
  );
  const leafMat = patchMaterial(
    new MeshStandardMaterial({ map: leafTex.map, normalMap: leafTex.normal, normalScale: new Vector2(0.9, 0.9), vertexColors: true, alphaTest: 0.42, alphaToCoverage: true, side: DoubleSide, roughness: 0.6 }),
    { wind: 0.2, windHeight: 14, translucency: 1, foliage: true, seasonal: 'leaf' },
  );
  const plasterSet = plasterTexture(406, { fallen: false });
  const stoneMat = patchMaterial(new MeshStandardMaterial({ map: plasterSet.map, normalMap: plasterSet.normal, vertexColors: true, roughness: 0.92 }), { grime: 0.45 });
  for (const [b, m] of [
    [wood, woodMat],
    [leaves, leafMat],
    [stone, stoneMat],
  ] as const) {
    const mesh = new Mesh(b.build(), m);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  group.position.set(X, Y, Z);
  group.updateMatrixWorld(true);
  return group;
}

/** Where the banyan's trunk and its platform stand, for the planting and the grass to keep clear. */
export const BANYAN_CLEARING = { x: BANYAN.x, z: BANYAN.z, r: 5 };
