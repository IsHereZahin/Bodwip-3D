import { BoxGeometry, ConeGeometry, CylinderGeometry, DoubleSide, Group, LatheGeometry, Matrix4, Mesh, MeshStandardMaterial, Quaternion, SphereGeometry, Vector2, Vector3 } from 'three';
import type { BufferGeometry } from 'three';
import { Rng } from '../core/rng';
import { BUILDING, BUILDINGS, KIND, kindAt, type BuildingKind } from '../geo/data';
import { MeshBuilder, mixRgb, rgb, scaleRgb, type RGB } from '../render/builder';
import { patchMaterial } from '../render/patch';
import { plasterTexture, strawTexture, tinTexture } from '../render/textures';
import { nearBackwater, onBridge, onLandmark, terrainHeight } from './geography';
import { clearOfRoads } from './roads';

// The settlements' buildings, from the map's footprints (geo/data.ts BUILDINGS: OSM's and Microsoft's, a ninth
// of the ordinary ones as the land is a ninth, every one OSM names or tags), each at its 1:3 place and its real
// size and heading, moved clear of the roads it lines, left out where it would stand in water, on a landmark or
// on a steep slope. How each is built, by its kind:
// - houses: a raised mud plinth, walls of mud, brick or plaster, a do-chala roof of tin or thatch (the village
//   huts near the channel are world/village.ts's, more detailed);
// - pucca buildings: plastered blocks of one to four storeys (the hotels and flats of Cox's Bazar more), flat
//   roofs with parapets, rows of dark windows;
// - mosques with a dome and a minaret; temples with a spire; the Rakhine pagodas' white stupas; schools long and
//   low under tin; mills and stores as big tin sheds.
// Storeys, walls, roofs and colours are [মডেল] where OSM does not say: Microsoft's footprints carry no tags.

export interface BuildingPlan {
  x: number;
  /** The floor's height (the plinth's top); the plinth reaches down to `base`. */
  y: number;
  base: number;
  z: number;
  /** Rotation about y: the long side runs along (cos ry, −sin ry). */
  ry: number;
  l: number;
  w: number;
  kind: BuildingKind;
  /** Storeys OSM maps (0: not mapped). */
  levels: number;
}

/** Corner heights may differ by at most this (m) before a building is taken to stand on a slope it would not be built on. */
const MAX_FALL = 2.5;

/** The buildings to stand, from the map's footprints, deterministic. */
export function planBuildings(): BuildingPlan[] {
  const out: BuildingPlan[] = [];
  const B = BUILDINGS;
  for (let i = 0; i < B.count; i++) {
    const l = B.l[i];
    const w = B.w[i];
    const reach = 0.5 * Math.hypot(l, w);
    const { x, z } = clearOfRoads(B.x[i], B.z[i], reach * 0.85);
    if (kindAt(x, z) !== KIND.land || nearBackwater(x, z, reach * 0.7) || onLandmark(x, z, reach) || onBridge(x, z, reach)) continue;
    const ry = B.yaw[i];
    const c = Math.cos(ry);
    const s = Math.sin(ry);
    let lo = Infinity;
    let hi = -Infinity;
    for (const [a, b] of [
      [-1, -1],
      [1, -1],
      [-1, 1],
      [1, 1],
    ]) {
      const lx = (a * l) / 2;
      const lz = (b * w) / 2;
      const h = terrainHeight(x + lx * c + lz * s, z - lx * s + lz * c);
      lo = Math.min(lo, h);
      hi = Math.max(hi, h);
    }
    if (hi - lo > MAX_FALL) continue;
    out.push({ x, y: hi + 0.3, base: lo - 0.2, z, ry, l, w, kind: B.kind[i] as BuildingKind, levels: B.levels[i] });
  }
  return out;
}

// ---------- the parts ----------

type Sets = { walls: MeshBuilder; tin: MeshBuilder; thatch: MeshBuilder };

const UP = new Vector3(0, 1, 0);
const q = new Quaternion();
const m4 = new Matrix4();
const ONE = new Vector3(1, 1, 1);

const MUD: RGB = rgb('#9c7b55');
const PLINTH: RGB = rgb('#7d6448');
const BRICK: RGB = rgb('#a5583e');
const WHITE: RGB = [1.08, 1.08, 1.1];
const WINDOW: RGB = rgb('#26272a');
const PASTELS = ['#e8d9a8', '#cfe0c4', '#e6c4b8', '#f0ece0', '#c8d8e0', '#e8cf9e', '#d6d0c4'].map((p) => rgb(p));

/** A point in a building's frame (`a` along its length, `d` across, `y` up) in the world. */
function framed(p: BuildingPlan, a: number, y: number, d: number): Vector3 {
  const c = Math.cos(p.ry);
  const s = Math.sin(p.ry);
  return new Vector3(p.x + a * c + d * s, y, p.z - a * s + d * c);
}

/** A box in a building's frame: centre (`a`, `y`, `d`), size along, up, across. UVs in metres over 3 m. */
function box(b: MeshBuilder, p: BuildingPlan, a: number, y: number, d: number, sa: number, sy: number, sd: number, c: RGB): void {
  const g = new BoxGeometry(sa, sy, sd);
  // the texture in metres on every face, so plaster keeps its scale
  const uv = g.getAttribute('uv');
  const n = g.getAttribute('normal');
  for (let i = 0; i < uv.count; i++) {
    const ax = Math.abs(n.getX(i));
    const ay = Math.abs(n.getY(i));
    const [su, sv] = ax > 0.5 ? [sd, sy] : ay > 0.5 ? [sa, sd] : [sa, sy];
    uv.setXY(i, (uv.getX(i) * su) / 3, (uv.getY(i) * sv) / 3);
  }
  b.add(g, m4.compose(framed(p, a, y, d), q.setFromAxisAngle(UP, p.ry), ONE), c);
}

/** A three geometry placed in a building's frame. */
function part(b: MeshBuilder, p: BuildingPlan, g: BufferGeometry, a: number, y: number, d: number, c: RGB): void {
  b.add(g, m4.compose(framed(p, a, y, d), q.setFromAxisAngle(UP, p.ry), ONE), c);
}

/** A do-chala roof over walls `l` × `w` topping at `top`: two slopes from the ridge to overhanging eaves, and its gables. */
function chala(s: Sets, p: BuildingPlan, l: number, w: number, top: number, rise: number, roof: 'tin' | 'thatch', gable: RGB): void {
  const b = roof === 'tin' ? s.tin : s.thatch;
  const over = roof === 'thatch' ? 0.6 : 0.45;
  const ea = l / 2 + over;
  const ed = w / 2 + over;
  const eave = top - 0.2;
  const ridge = top + rise;
  // older and newer sheets: each roof its own shade
  const tint: RGB = roof === 'tin' ? scaleRgb([1, 1, 1], 0.8 + 0.2 * ((((p.x * 7.3 + p.z * 3.1) % 1) + 1) % 1)) : [1, 1, 1];
  for (const side of [-1, 1]) {
    const k = b.vertexCount;
    // its normal leans out toward the eave
    const len = Math.hypot(rise, ed);
    const n = framed(p, 0, 0, side).sub(framed(p, 0, 0, 0)).multiplyScalar(rise / len).setY(ed / len);
    const slope = Math.hypot(rise + 0.2, ed);
    b.vertex(framed(p, -ea, ridge, 0), n, 0, 0, tint);
    b.vertex(framed(p, ea, ridge, 0), n, l / 2, 0, tint);
    b.vertex(framed(p, ea, eave, side * ed), n, l / 2, slope / 2, tint);
    b.vertex(framed(p, -ea, eave, side * ed), n, 0, slope / 2, tint);
    if (side > 0) b.quad(k, k + 3, k + 2, k + 1);
    else b.quad(k, k + 1, k + 2, k + 3);
  }
  // the gables, in the walls' colour, under the ridge at each end
  for (const end of [-1, 1]) {
    const k = s.walls.vertexCount;
    const n = framed(p, end, 0, 0).sub(framed(p, 0, 0, 0)).setY(0).normalize();
    s.walls.vertex(framed(p, (end * l) / 2, top, -w / 2), n, 0, 0, gable);
    s.walls.vertex(framed(p, (end * l) / 2, top, w / 2), n, w / 3, 0, gable);
    s.walls.vertex(framed(p, (end * l) / 2, ridge - 0.05, 0), n, w / 6, rise / 3, gable);
    if (end > 0) s.walls.tri(k, k + 2, k + 1);
    else s.walls.tri(k, k + 1, k + 2);
  }
}

/** A house: a mud plinth, walls, a door, a do-chala roof of tin or thatch. */
function house(s: Sets, p: BuildingPlan, rng: Rng): void {
  const wallH = rng.range(2.2, 2.6);
  box(s.walls, p, 0, (p.base + p.y) / 2, 0, p.l + 0.6, p.y - p.base, p.w + 0.6, scaleRgb(PLINTH, rng.range(0.85, 1.1)));
  const r = rng.next();
  const wall = r < 0.55 ? scaleRgb(MUD, rng.range(0.85, 1.1)) : r < 0.75 ? scaleRgb(BRICK, rng.range(0.85, 1.05)) : rng.pick(PASTELS);
  box(s.walls, p, 0, p.y + wallH / 2, 0, p.l, wallH, p.w, wall);
  // the door on a long side, toward the yard
  box(s.walls, p, rng.range(-0.25, 0.25) * p.l, p.y + 0.95, p.w / 2 + 0.01, 0.9, 1.9, 0.04, WINDOW);
  chala(s, p, p.l, p.w, p.y + wallH, Math.min(1.8, p.w * 0.32), rng.next() < 0.7 ? 'tin' : 'thatch', wall);
}

/** A pucca block: storeys of plastered wall with rows of windows, a flat roof and a parapet round it. */
function pucca(s: Sets, p: BuildingPlan, rng: Rng, storeys: number, paint: RGB): void {
  const H = storeys * 3.1;
  box(s.walls, p, 0, (p.base + p.y) / 2, 0, p.l + 0.3, p.y - p.base, p.w + 0.3, scaleRgb(paint, 0.7));
  box(s.walls, p, 0, p.y + H / 2, 0, p.l, H, p.w, paint);
  // the roof's parapet
  const top = p.y + H;
  const c = scaleRgb(paint, 0.92);
  box(s.walls, p, 0, top + 0.45, p.w / 2 - 0.08, p.l, 0.9, 0.16, c);
  box(s.walls, p, 0, top + 0.45, -p.w / 2 + 0.08, p.l, 0.9, 0.16, c);
  box(s.walls, p, p.l / 2 - 0.08, top + 0.45, 0, 0.16, 0.9, p.w - 0.3, c);
  box(s.walls, p, -p.l / 2 + 0.08, top + 0.45, 0, 0.16, 0.9, p.w - 0.3, c);
  // windows: a dark band per storey along both long sides, with a ledge under it
  for (let f = 0; f < storeys; f++) {
    const y = p.y + f * 3.1 + 1.65;
    for (const side of [-1, 1]) {
      box(s.walls, p, 0, y, side * (p.w / 2 + 0.02), p.l * 0.82, 1.15, 0.04, mixRgb(paint, WINDOW, 0.8));
      box(s.walls, p, 0, y - 0.68, side * (p.w / 2 + 0.06), p.l * 0.86, 0.1, 0.12, scaleRgb(paint, 0.85));
    }
  }
  // a water tank or a stair head on some roofs
  if (rng.next() < 0.4) part(s.walls, p, new CylinderGeometry(0.6, 0.6, 1.1, 10), rng.range(-0.3, 0.3) * p.l, top + 0.55, rng.range(-0.2, 0.2) * p.w, rgb('#2a2a2a'));
}

/** A mosque: a white prayer hall, a dome on it, and a minaret at a corner. */
function mosque(s: Sets, p: BuildingPlan, rng: Rng): void {
  const storeys = Math.max(1, Math.min(2, p.levels || 1));
  pucca(s, p, rng, storeys, WHITE);
  const top = p.y + storeys * 3.1;
  const r = Math.min(p.l, p.w) * 0.32;
  part(s.walls, p, new SphereGeometry(r, 14, 7, 0, Math.PI * 2, 0, Math.PI / 2), 0, top, 0, WHITE);
  part(s.walls, p, new CylinderGeometry(0.04, 0.06, 1.2, 6), 0, top + r + 0.6, 0, rgb('#d4b048'));
  const ma = p.l / 2 - 0.8;
  const md = p.w / 2 - 0.8;
  const mh = storeys * 3.1 + 7;
  part(s.walls, p, new CylinderGeometry(0.45, 0.55, mh, 10), ma, p.y + mh / 2, md, WHITE);
  part(s.walls, p, new CylinderGeometry(0.7, 0.7, 0.3, 12), ma, p.y + mh - 1.5, md, rgb('#4a8a5a'));
  part(s.walls, p, new ConeGeometry(0.5, 1.4, 10), ma, p.y + mh + 0.7, md, rgb('#4a8a5a'));
}

/** A Hindu temple: a small shrine with a curving spire over its sanctum. */
function temple(s: Sets, p: BuildingPlan): void {
  const c = rgb('#e6d4b0');
  box(s.walls, p, 0, (p.base + p.y) / 2, 0, p.l + 0.6, p.y - p.base, p.w + 0.6, PLINTH);
  box(s.walls, p, 0, p.y + 1.6, 0, p.l, 3.2, p.w, c);
  const r = Math.min(p.l, p.w) * 0.42;
  const spire = new LatheGeometry(
    [
      [r, 0],
      [r * 0.92, r * 1.2],
      [r * 0.7, r * 2.1],
      [r * 0.35, r * 2.7],
      [0.12, r * 3],
      [0, r * 3.05],
    ].map(([x, y]) => new Vector2(x, y)),
    8,
  );
  part(s.walls, p, spire, 0, p.y + 3.2, 0, rgb('#f0e4c8'));
  part(s.walls, p, new CylinderGeometry(0.02, 0.03, 1.4, 5), 0, p.y + 3.2 + r * 3 + 0.7, 0, rgb('#e07a1f'));
}

/** A Rakhine pagoda: square white terraces, a bell-shaped stupa, a gilded finial. */
function pagoda(s: Sets, p: BuildingPlan): void {
  const r = Math.min(p.l, p.w) * 0.5;
  for (let i = 0; i < 3; i++) box(s.walls, p, 0, p.y + 0.35 + i * 0.7, 0, r * 2 * (1 - i * 0.22), 0.7, r * 2 * (1 - i * 0.22), WHITE);
  const bell = new LatheGeometry(
    [
      [r * 0.55, 0],
      [r * 0.58, r * 0.15],
      [r * 0.5, r * 0.7],
      [r * 0.3, r * 1.15],
      [r * 0.12, r * 1.45],
      [0, r * 1.75],
    ].map(([x, y]) => new Vector2(x, y)),
    12,
  );
  part(s.walls, p, bell, 0, p.y + 2.1, 0, WHITE);
  part(s.walls, p, new ConeGeometry(0.12, 1.6, 8), 0, p.y + 2.1 + r * 1.75 + 0.7, 0, rgb('#d4a83a'));
}

/** A school: one long storey of plastered wall with a row of windows, under a low tin roof. */
function school(s: Sets, p: BuildingPlan, rng: Rng): void {
  const paint = rng.pick([rgb('#d9c48a'), rgb('#c8d8e0'), rgb('#e6c4b8')]);
  box(s.walls, p, 0, (p.base + p.y) / 2, 0, p.l + 0.6, p.y - p.base, p.w + 0.6, PLINTH);
  box(s.walls, p, 0, p.y + 1.55, 0, p.l, 3.1, p.w, paint);
  for (const side of [-1, 1]) box(s.walls, p, 0, p.y + 1.7, side * (p.w / 2 + 0.02), p.l * 0.85, 1.2, 0.04, mixRgb(paint, WINDOW, 0.75));
  chala(s, p, p.l, p.w, p.y + 3.1, Math.min(1.5, p.w * 0.22), 'tin', paint);
}

/** A mill or a store: a big shed of tin on low walls. */
function shed(s: Sets, p: BuildingPlan): void {
  const c = rgb('#b4b0a6');
  box(s.walls, p, 0, (p.base + p.y) / 2, 0, p.l + 0.3, p.y - p.base, p.w + 0.3, scaleRgb(c, 0.7));
  box(s.walls, p, 0, p.y + 2.4, 0, p.l, 4.8, p.w, c);
  chala(s, p, p.l, p.w, p.y + 4.8, Math.min(2.5, p.w * 0.15), 'tin', c);
}

/** Storeys for a pucca building OSM does not count: by its kind and its size [মডেল]. */
function storeysOf(p: BuildingPlan, rng: Rng): number {
  if (p.levels > 0) return Math.min(12, p.levels);
  const area = p.l * p.w;
  if (p.kind === BUILDING.commercial) return rng.int(area > 400 ? 4 : 2, area > 400 ? 8 : 4);
  if (p.kind === BUILDING.civic) return rng.int(2, 3);
  return area > 300 ? rng.int(2, 4) : rng.int(1, 2);
}

/** Buildings are drawn in cells of this size (m), so those out of view, or far off, are left undrawn. */
const CELL = 1300;

/** The buildings' meshes, in cells: pass the group to cullBeyond. */
export function buildBuildings(plans: readonly BuildingPlan[]): Group {
  const group = new Group();
  group.name = 'buildings';
  const cells = new Map<string, Sets>();
  for (const p of plans) {
    const key = `${Math.floor(p.x / CELL)}:${Math.floor(p.z / CELL)}`;
    let s = cells.get(key);
    if (!s) cells.set(key, (s = { walls: new MeshBuilder(), tin: new MeshBuilder(), thatch: new MeshBuilder() }));
    // each building's own choices, the same every time
    const rng = new Rng(Math.floor(p.x * 13.7) ^ Math.floor(p.z * 7.1));
    switch (p.kind) {
      case BUILDING.house:
        house(s, p, rng);
        break;
      case BUILDING.mosque:
        mosque(s, p, rng);
        break;
      case BUILDING.temple:
        temple(s, p);
        break;
      case BUILDING.pagoda:
        pagoda(s, p);
        break;
      case BUILDING.school:
        school(s, p, rng);
        break;
      case BUILDING.industrial:
        shed(s, p);
        break;
      default:
        pucca(s, p, rng, storeysOf(p, rng), rng.pick(PASTELS));
    }
  }
  const plaster = plasterTexture(81);
  const materials = {
    walls: patchMaterial(new MeshStandardMaterial({ map: plaster.map, normalMap: plaster.normal, vertexColors: true, roughness: 0.92 }), { grime: 0.45 }),
    tin: patchMaterial(new MeshStandardMaterial({ map: tinTexture(82), vertexColors: true, roughness: 0.5, metalness: 0.5, side: DoubleSide }), { grime: 0.25 }),
    thatch: patchMaterial(new MeshStandardMaterial({ map: strawTexture(83), vertexColors: true, roughness: 0.95, side: DoubleSide }), { grime: 0.3, translucency: 0.3 }),
  };
  for (const s of cells.values()) {
    for (const k of ['walls', 'tin', 'thatch'] as const) {
      if (!s[k].vertexCount) continue;
      const mesh = new Mesh(s[k].build(), materials[k]);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.name = 'building';
      group.add(mesh);
    }
  }
  return group;
}
