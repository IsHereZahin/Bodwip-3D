import { DoubleSide, Group, Mesh, MeshStandardMaterial, Vector3 } from 'three';
import { Rng } from '../core/rng';
import { MeshBuilder, rgb, scaleRgb, taperedTube, type RGB } from '../render/builder';
import { patchMaterial } from '../render/patch';
import { SANKO, sankoDeck, sankoToWorld } from './sites';
import { terrainHeight } from './geography';

// The bamboo sanko (সাঁকো) that carries the field path over the side khal: the footbridge every village
// throws over its khals, built high over this one because boats go up it to the bil. Three culms lashed side by
// side make the walkway, climbing from each bank to a high hump over the water, with short rungs lashed across
// it where the climb is steep; under it, pairs of poles crossed in an X are driven into the bed every couple of
// metres and lashed where they cross to a short crossbar the walkway rests on, but none in the middle span,
// the boats' way (sites.ts SANKO.gap): there the walkway is doubled underneath and braced from the trestles
// either side. One long culm on posts is the handrail. Weathered to a grey gold, greener where the newest culms
// were put in after the last rains.

/** Between the trestles (m), and their poles' and the walkway's radius. */
const BAY = 2.4;
const POLE = 0.045;
const CULM = 0.05;
/** The handrail's height over the walkway (m), on the downstream side. */
const RAIL = 0.95;

const OLD: RGB = rgb('#9c8d68');
const NEW: RGB = rgb('#a3a06a');

export function buildSanko(): Group {
  const rng = new Rng(901);
  const b = new MeshBuilder();
  const world = (a: number, side: number, y: number) => {
    const p = sankoToWorld(a, side);
    return new Vector3(p.x, SANKO.water + y, p.z);
  };
  const groundAt = (a: number, side: number) => {
    const p = sankoToWorld(a, side);
    return terrainHeight(p.x, p.z) - SANKO.water;
  };
  const ends = Math.max(groundAt(-SANKO.half, 0), groundAt(SANKO.half, 0)) + 0.06;
  const tint = () => scaleRgb(rng.next() < 0.25 ? NEW : OLD, rng.range(0.85, 1.08));

  // the walkway: three culms side by side, each a little bowed between the trestles
  for (const side of [-0.11, 0, 0.11]) {
    const pts: Vector3[] = [];
    const radii: number[] = [];
    for (let a = -SANKO.half - 0.6; a <= SANKO.half + 0.6 + 1e-6; a += 0.6) {
      const sag = 0.02 * Math.sin(((a + SANKO.half) / BAY) * Math.PI) ** 2;
      pts.push(world(a, side, sankoDeck(a, ends) - sag));
      radii.push(CULM * rng.range(0.9, 1.1));
    }
    taperedTube(b, pts, radii, 6, tint(), 1.2);
  }

  // rungs across the walkway where it climbs steeply, for the feet
  for (let a = -SANKO.half + 0.5; a <= SANKO.half - 0.5; a += 0.45) {
    const slope = Math.abs(sankoDeck(a + 0.05, ends) - sankoDeck(a - 0.05, ends)) / 0.1;
    if (slope < 0.18) continue;
    const y = sankoDeck(a, ends) + CULM * 0.9;
    taperedTube(b, [world(a, -0.2, y), world(a, 0.2, y)], [0.025, 0.025], 5, tint(), 1);
  }

  // the trestles: an X of poles from the bed (or the bank) to just over the walkway, a crossbar under it,
  // and on the downstream side a post up to the handrail; from the banks out to the boats' way either side
  const rail: Vector3[] = [];
  const stations: number[] = [];
  for (let a = SANKO.gap; a <= SANKO.half - 0.4 + 1e-6; a += BAY) stations.push(-a, a);
  stations.sort((p, q) => p - q);
  for (const a of stations) {
    const y = sankoDeck(a, ends);
    const foot = Math.min(groundAt(a, -0.55), groundAt(a, 0.55)) - 0.3;
    for (const s of [-1, 1]) {
      taperedTube(b, [world(a + rng.range(-0.05, 0.05), -0.62 * s, foot), world(a, 0.42 * s, y + 0.22)], [POLE * 1.1, POLE * 0.8], 5, tint(), 1.2);
    }
    taperedTube(b, [world(a, -0.4, y - CULM - 0.03), world(a, 0.4, y - CULM - 0.03)], [POLE, POLE], 5, tint(), 1.2);
    // the lashings where the poles cross: a darker wrap of jute
    taperedTube(b, [world(a, 0, y - 0.07), world(a, 0, y + 0.02)], [0.06, 0.06], 6, rgb('#5a4630'), 1);
    taperedTube(b, [world(a, 0.42, y - 0.05), world(a, 0.44, y + RAIL)], [POLE * 0.85, POLE * 0.7], 5, tint(), 1.2);
    rail.push(world(a, 0.44, y + RAIL - 0.02));
    // the middle span's
    if (Math.abs(a + SANKO.gap) < 1e-6) rail.push(world(0, 0.44, sankoDeck(0, ends) + RAIL - 0.02));
  }
  // the boats' way: the walkway doubled under the middle span, braced up to it from the trestles either side
  // (nothing of them lower than the trestles' crossbars), and a post on it for the handrail at the middle
  taperedTube(b, [world(-SANKO.gap, 0, sankoDeck(SANKO.gap, ends) - 0.11), world(0, 0, sankoDeck(0, ends) - 0.11), world(SANKO.gap, 0, sankoDeck(SANKO.gap, ends) - 0.11)], [CULM, CULM * 1.1, CULM], 6, tint(), 1.2);
  for (const s of [-1, 1]) {
    for (const side of [-0.3, 0.3]) {
      taperedTube(b, [world(s * SANKO.gap, side, sankoDeck(SANKO.gap, ends) - 0.55), world(s * 0.9, side * 0.4, sankoDeck(0.9, ends) - 0.1)], [POLE * 0.9, POLE * 0.8], 5, tint(), 1.2);
    }
  }
  taperedTube(b, [world(0, 0.42, sankoDeck(0, ends) - 0.05), world(0, 0.44, sankoDeck(0, ends) + RAIL)], [POLE * 0.85, POLE * 0.7], 5, tint(), 1.2);
  // the handrail, one long culm along the posts' tops
  if (rail.length > 1) taperedTube(b, rail, rail.map(() => 0.04), 6, tint(), 1.2);

  const material = patchMaterial(new MeshStandardMaterial({ vertexColors: true, roughness: 0.7, side: DoubleSide }), { grime: 0.45 });
  const mesh = new Mesh(b.build(), material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  const group = new Group();
  group.name = 'sanko';
  group.add(mesh);
  return group;
}
