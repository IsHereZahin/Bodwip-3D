import { BoxGeometry, BufferGeometry, CylinderGeometry, DoubleSide, Group, LatheGeometry, Matrix4, Mesh, MeshStandardMaterial, Quaternion, SphereGeometry, Vector2, Vector3 } from 'three';
import { Rng } from '../core/rng';
import { MeshBuilder, card, mixRgb, rgb, scaleRgb, slab, taperedTube, type RGB } from '../render/builder';
import { patchMaterial } from '../render/patch';
import { brickTexture, leafClusterTexture, plasterTexture, tinTexture, weaveTexture } from '../render/textures';
import { MOUNDS, WATER_LEVEL, bankAt, shapePoint, terrainHeight, type Mound } from './geography';
import { Frame } from './houses';
import { TEA_STALL } from './plan';

// The village's landmarks, each built where the design sets it (world/plan.ts) on its own raised ground:
// - the zamindar house: two storeys of lime-plastered brick behind a colonnade on both floors, a balustrade
//   and a cornice, a pediment over its middle; green louvred shutters; the plaster stained by a hundred rains
//   and fallen away here and there to the brick; its parapet broken at one end, where a peepal has taken root;
//   a grand ghat down to the river between two little pavilions, a brick walk up to its steps, and the
//   family's temple, a terracotta char-chala, beside the lawn;
// - the mosque: a small whitewashed prayer hall with three pointed arches, a dome on its drum, slender
//   turrets at its corners with little domes, a parapet of merlons, and a walled forecourt;
// - the tea stall by the banyan: bamboo, mat and tin, a counter with its jars and kettle, a bunch of bananas
//   hung from the eave, benches in front.

/** The builders the landmarks are laid into, one per material. */
interface Parts {
  plaster: MeshBuilder;
  /** Fresh whitewash, kept up (the mosque). */
  white: MeshBuilder;
  brick: MeshBuilder;
  wood: MeshBuilder;
  tin: MeshBuilder;
  mat: MeshBuilder;
  bamboo: MeshBuilder;
  leaves: MeshBuilder;
}

const DARK: RGB = rgb('#16110c');
const LIME: RGB = rgb('#f6efe0');
const GREEN: RGB = rgb('#2f5e44');
const TERRACOTTA: RGB = rgb('#b0603e');

/** A geometry placed in a frame: at (x, y, z), turned `turn` more, scaled. */
function put(f: Frame, b: MeshBuilder, g: BufferGeometry, x: number, y: number, z: number, color: RGB, turn = 0, sx = 1, sy = 1, sz = 1): void {
  const p = f.p(x, y, z);
  const q = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), f.ry + turn);
  b.add(g, new Matrix4().compose(p, q, new Vector3(sx, sy, sz)), color);
}

/**
 * An arch's outline in a frame's wall plane: `w` wide, `h` from `y0` to its crown; semicircular, or pointed (two
 * arcs, each struck from a centre on the springing line, meeting at the crown). The points run from the left
 * foot up over the crown and down to the right foot.
 */
function archOutline(x: number, y0: number, w: number, h: number, pointed: boolean): Vector2[] {
  const r = w / 2;
  const H = pointed ? r * 1.25 : r;
  const ys = y0 + h - H;
  const pts = [new Vector2(x - r, y0)];
  const N = 8;
  if (!pointed) {
    for (let i = 0; i <= 2 * N; i++) {
      const a = Math.PI * (1 - i / (2 * N));
      pts.push(new Vector2(x + Math.cos(a) * r, ys + Math.sin(a) * r));
    }
  } else {
    // each arc's radius, so that it runs from its foot's springing to the crown above the middle
    const R = (r * r + H * H) / (2 * r);
    const crown = Math.acos((r - R) / R);
    for (let i = 0; i <= N; i++) {
      const a = Math.PI + (crown - Math.PI) * (i / N);
      pts.push(new Vector2(x - r + R + Math.cos(a) * R, ys + Math.sin(a) * R));
    }
    for (let i = 1; i <= N; i++) {
      const a = Math.PI - crown + (0 - (Math.PI - crown)) * (i / N);
      pts.push(new Vector2(x + r - R + Math.cos(a) * R, ys + Math.sin(a) * R));
    }
  }
  pts.push(new Vector2(x + r, y0));
  return pts;
}

/** A dark opening under an arch on a wall at local z, with a raised frame round it; `leaves` closes the lower part with two painted door leaves. */
function arch(f: Frame, p: Parts, x: number, y0: number, z: number, w: number, h: number, pointed: boolean, frameColor: RGB, frame: MeshBuilder, leaves: RGB | null): void {
  const pts = archOutline(x, y0, w, h, pointed);
  const n = f.n(0, 0, 1);
  // the opening: a fan from the foot's middle (the outline is convex)
  const c = p.wood.vertexCount;
  p.wood.vertex(f.p(x, y0, z + 0.012), n, 0, 0, DARK);
  for (const q of pts) p.wood.vertex(f.p(q.x, q.y, z + 0.012), n, 0, 0, DARK);
  for (let i = 0; i < pts.length - 1; i++) p.wood.tri(c, c + i + 2, c + i + 1);
  // its frame: a band round the arch, proud of the wall
  const s = frame.vertexCount;
  for (let i = 1; i < pts.length - 1; i++) {
    const q = pts[i];
    const prev = pts[i - 1];
    const next = pts[i + 1];
    const tx = next.x - prev.x;
    const ty = next.y - prev.y;
    const l = Math.hypot(tx, ty) || 1;
    const ox = (ty / l) * 0.16;
    const oy = (-tx / l) * 0.16;
    frame.vertex(f.p(q.x, q.y, z + 0.05), n, i / 6, 0, frameColor);
    frame.vertex(f.p(q.x - ox, q.y - oy, z + 0.05), n, i / 6, 0.2, frameColor);
  }
  const count = pts.length - 2;
  for (let i = 0; i < count - 1; i++) frame.quad(s + i * 2, s + i * 2 + 2, s + i * 2 + 3, s + i * 2 + 1);
  if (leaves) {
    const lh = Math.min(h * 0.62, 2.3);
    for (const side of [-1, 1]) f.box(p.wood, x + side * w / 4, y0 + lh / 2, z + 0.03, w / 2 - 0.03, lh, 0.05, leaves, 1);
  }
}

/** A round column with a square base and capital, from `y0` to `y1`. */
function column(f: Frame, b: MeshBuilder, x: number, z: number, y0: number, y1: number, r: number, color: RGB): void {
  const shaft = new CylinderGeometry(r * 0.88, r, y1 - y0 - 0.5, 10, 1);
  put(f, b, shaft, x, (y0 + y1) / 2, z, color);
  f.box(b, x, y0 + 0.14, z, r * 2.6, 0.28, r * 2.6, scaleRgb(color, 0.95), 1);
  f.box(b, x, y1 - 0.12, z, r * 2.5, 0.24, r * 2.5, scaleRgb(color, 1.02), 1);
}

/** A balustrade from x0 to x1 at local z: a plinth, turned balusters, a rail on top. */
function balustrade(f: Frame, b: MeshBuilder, x0: number, x1: number, z: number, y: number, h: number, color: RGB): void {
  f.box(b, (x0 + x1) / 2, y + 0.06, z, x1 - x0, 0.12, 0.26, color, 2);
  f.box(b, (x0 + x1) / 2, y + h - 0.06, z, x1 - x0, 0.12, 0.3, color, 2);
  const baluster = new CylinderGeometry(0.045, 0.07, h - 0.24, 6, 1);
  for (let x = x0 + 0.14; x < x1 - 0.1; x += 0.24) put(f, b, baluster, x, y + h / 2, z, scaleRgb(color, 0.97));
}

/** How the rains have marked lime plaster at height y over the ground: damp and moss at the foot, stains under the cornices. */
function weathered(base: RGB, y: number, top: number, rng: Rng): RGB {
  let c = mixRgb(base, rgb('#7d7866'), (1 - Math.min(1, Math.max(0, (y - 0.2) / 1.4))) * 0.8);
  c = mixRgb(c, rgb('#56603a'), (1 - Math.min(1, Math.max(0, y / 0.7))) * 0.45);
  c = mixRgb(c, rgb('#9a9282'), Math.max(0, (y - top + 2.5) / 2.5) * 0.25);
  return scaleRgb(c, rng.range(0.92, 1.05));
}

// ---------- the zamindar house ----------

function zamindarHouse(p: Parts, m: Mound, rng: Rng): { front: Vector3; stepsAt: { x: number; z: number } } {
  const at = shapePoint(m, 3, 0);
  const y = terrainHeight(at.x, at.z) - 0.1;
  const f = new Frame(at.x, y, at.z, m.face);
  const L = 26;
  const D = 10;
  const V = 3.2;
  const plinth = 1.0;
  const storey = 4.2;
  const f2 = plinth + storey;
  const roof = plinth + storey * 2;
  const front = D / 2;
  const colZ = front + V - 0.35;
  const top = roof + 1;
  const tone = (yy: number) => weathered(LIME, yy, top, rng);
  // the plinth, with the grand steps up the middle
  f.box(p.plaster, 0, plinth / 2 - 0.2, V / 2, L + 1.2, plinth + 0.4, D + V + 1.2, tone(0.2), 3.4);
  for (let i = 0; i < 5; i++) {
    const h = plinth * (1 - i / 5);
    f.box(p.plaster, 0, h / 2 - 0.1, front + V + 0.6 + i * 0.42, 5.2 - i * 0.1, h + 0.2, 0.44, tone(0.1), 3.4);
  }
  // the body, both storeys
  for (const [y0, h] of [
    [plinth, storey],
    [f2, storey],
  ] as const) {
    f.box(p.plaster, 0, y0 + h / 2, 0, L, h, D, tone(y0 + h / 2), 3.4);
  }
  // the floor between the storeys and the roof, run out over the veranda, with their cornices
  f.box(p.plaster, 0, f2 - 0.18, V / 2, L + 0.6, 0.36, D + V + 0.2, tone(f2), 3.4);
  f.box(p.plaster, 0, f2 - 0.05, front + V + 0.05, L + 0.9, 0.3, 0.5, tone(f2 + 0.3), 3.4);
  f.box(p.plaster, 0, roof + 0.2, V / 2, L + 0.8, 0.4, D + V + 0.5, tone(roof), 3.4);
  f.box(p.plaster, 0, roof + 0.34, front + V + 0.2, L + 1.1, 0.3, 0.55, tone(roof + 0.3), 3.4);
  // the colonnade on both floors
  const bays = 8;
  const bay = (L - 1) / bays;
  for (let i = 0; i <= bays; i++) {
    const x = -L / 2 + 0.5 + i * bay;
    column(f, p.plaster, x, colZ, plinth, f2 - 0.36, 0.26, tone(2));
    column(f, p.plaster, x, colZ, f2, roof, 0.24, tone(f2 + 2));
  }
  // the upper veranda's balustrade between the columns, and the roof's along the front
  for (let i = 0; i < bays; i++) {
    const x0 = -L / 2 + 0.5 + i * bay + 0.3;
    balustrade(f, p.plaster, x0, x0 + bay - 0.6, colZ, f2, 0.95, tone(f2 + 0.5));
  }
  // the west end's parapet has fallen: a peepal grows where it was
  const broken = rng.sign();
  const brokenAt = broken * (L / 2 - 3);
  balustrade(f, p.plaster, broken > 0 ? -L / 2 : -L / 2 + 6, broken > 0 ? L / 2 - 6 : L / 2, front + V + 0.1, roof + 0.4, 1.0, tone(roof + 1));
  for (const side of [-1, 1]) f.box(p.plaster, side * (L / 2 + 0.25), roof + 0.9, V / 2, 0.3, 1.0, D + V, tone(roof + 1), 3.4);
  f.box(p.plaster, 0, roof + 0.9, -D / 2 - 0.2, L + 0.8, 1.0, 0.3, tone(roof + 1), 3.4);
  // the pediment over the middle three bays, with its round window
  {
    const w = bay * 3 + 0.8;
    const zf = front + V + 0.25;
    const n = f.n(0, 0, 1);
    const yb = roof + 0.5;
    const c = p.plaster.vertexCount;
    const col = tone(roof + 2);
    p.plaster.vertex(f.p(-w / 2, yb, zf), n, 0, 0, col);
    p.plaster.vertex(f.p(w / 2, yb, zf), n, w / 3.4, 0, col);
    p.plaster.vertex(f.p(0, yb + 2.2, zf), n, w / 6.8, 2.2 / 3.4, col);
    p.plaster.tri(c, c + 1, c + 2);
    for (const side of [-1, 1]) {
      const s = p.plaster.vertexCount;
      const ns = f.n(side * 2.2, w / 2, 0);
      p.plaster.vertex(f.p((side * w) / 2, yb, zf), ns, 0, 0, col);
      p.plaster.vertex(f.p(0, yb + 2.2, zf), ns, 1, 0, col);
      p.plaster.vertex(f.p(0, yb + 2.2, zf - 1.2), ns, 1, 1, col);
      p.plaster.vertex(f.p((side * w) / 2, yb, zf - 1.2), ns, 0, 1, col);
      if (side > 0) p.plaster.quad(s, s + 1, s + 2, s + 3);
      else p.plaster.quad(s, s + 3, s + 2, s + 1);
    }
    const win = new CylinderGeometry(0.42, 0.42, 0.05, 16).rotateX(Math.PI / 2);
    put(f, p.wood, win, 0, yb + 0.85, zf + 0.02, DARK);
  }
  // the facade behind the colonnade: arched doors below, tall shuttered doors above, green louvres
  for (let i = 0; i < bays; i++) {
    const x = -L / 2 + 0.5 + (i + 0.5) * bay;
    const main = i === bays / 2 - 1 || i === bays / 2;
    arch(f, p, x, plinth, front, main ? 1.7 : 1.3, main ? 3.2 : 2.9, false, tone(3), p.plaster, main ? rgb('#4a3424') : GREEN);
    f.box(p.wood, x, f2 + 1.35, front + 0.02, 1.2, 2.6, 0.04, DARK, 1);
    for (const s of [-1, 1]) f.box(p.wood, x + s * 0.31, f2 + 1.35, front + 0.05, 0.58, 2.5, 0.05, scaleRgb(GREEN, rng.range(0.85, 1.05)), 1);
    f.box(p.plaster, x, f2 + 2.85, front + 0.06, 1.5, 0.22, 0.12, tone(f2 + 3), 3.4);
  }
  // windows on the ends and the back, shuttered
  for (const side of [-1, 1]) {
    const ef = new Frame(at.x + side * (L / 2) * Math.cos(m.face), y, at.z - side * (L / 2) * Math.sin(m.face), m.face + (side * Math.PI) / 2);
    for (const [y0] of [[plinth + 0.9], [f2 + 0.9]]) {
      for (const zz of [-2.5, 2.5]) {
        ef.box(p.wood, zz, y0 + 1, 0.02, 1, 2, 0.04, DARK, 1);
        for (const s of [-1, 1]) ef.box(p.wood, zz + s * 0.26, y0 + 1, 0.05, 0.48, 1.9, 0.05, GREEN, 1);
      }
    }
  }
  // where the plaster has fallen away: patches of the brick under it, on the facade and the ends
  for (let k = 0; k < 26; k++) {
    const yy = rng.range(0.6, roof - 0.5);
    const w = rng.range(0.4, 1.6);
    const h = rng.range(0.3, 1.1);
    if (rng.next() < 0.6) f.box(p.brick, rng.range(-L / 2 + 1, L / 2 - 1), yy, front + 0.008, w, h, 0.02, scaleRgb(TERRACOTTA, rng.range(0.75, 0.95)), 0.6);
    else {
      const side = rng.sign();
      f.box(p.brick, side * (L / 2 + 0.008), yy, rng.range(-D / 2 + 0.5, D / 2 - 0.5), 0.02, h, w, scaleRgb(TERRACOTTA, rng.range(0.75, 0.95)), 0.6);
    }
  }
  // the peepal on the broken corner: roots down the wall, a young crown above the roof
  {
    const base = f.p(brokenAt, roof + 0.5, front + V - 0.6);
    for (let k = 0; k < 6; k++) {
      const a = rng.range(-0.8, 0.8);
      const pts = [base.clone(), f.p(brokenAt + Math.sin(a) * 0.6, roof - 0.6, front + V + 0.3), f.p(brokenAt + Math.sin(a) * 1.0, roof - rng.range(2, 4), front + V + 0.32)];
      taperedTube(p.bamboo, pts, [0.07, 0.04, 0.015], 4, rgb('#6e6458'), 1);
    }
    for (let k = 0; k < 4; k++) {
      const a = (k / 4) * Math.PI * 2;
      taperedTube(p.bamboo, [base.clone(), base.clone().add(new Vector3(Math.cos(a) * 1.4, 2.2, Math.sin(a) * 1.4))], [0.09, 0.03], 5, rgb('#7a6e60'), 1);
    }
    const up = new Vector3(0, 1, 0);
    for (let k = 0; k < 90; k++) {
      const a = rng.range(0, Math.PI * 2);
      const r = Math.sqrt(rng.next()) * 2.2;
      const q = base.clone().add(new Vector3(Math.cos(a) * r, 2.2 + rng.range(-0.6, 0.9), Math.sin(a) * r));
      const s = rng.range(0.5, 0.75);
      card(p.leaves, q, new Vector3(Math.cos(a + 1.2) * s, 0, Math.sin(a + 1.2) * s), new Vector3(0, s, 0), up, scaleRgb([1, 1, 1], rng.range(0.85, 1.1)));
    }
  }
  return { front: f.p(0, 0, front + V + 2.8), stepsAt: shapePoint(m, 3 + front + V + 2.8, 0) };
}

/** Wide brick steps from the water up the bank, flanked at the top by two little pavilions; a brick walk from them to the house. */
function grandGhat(p: Parts, m: Mound, house: { x: number; z: number }, rng: Rng): void {
  const ahead = shapePoint(m, m.hu + 16, 0);
  const b = bankAt(ahead.x, ahead.z);
  if (!b) return;
  const ux = Math.sin(b.up);
  const uz = Math.cos(b.up);
  const cx = Math.cos(b.up);
  const cz = -Math.sin(b.up);
  const at = (d: number, s = 0) => ({ x: b.x + ux * d + cx * s, z: b.z + uz * d + cz * s });
  const width = 8;
  const reach = 9;
  const tread = 0.45;
  const tone = (yy: number) => scaleRgb(mixRgb(LIME, rgb('#5a5444'), 1 - Math.min(1, Math.max(0, (yy - WATER_LEVEL + 0.2) / 1.2))), rng.range(0.9, 1.04));
  const n = Math.round((reach + 1.6) / tread);
  let topY = 0;
  for (let i = 0; i < n; i++) {
    const d = reach - i * tread;
    let yy = -Infinity;
    for (const s of [-width / 2, 0, width / 2]) {
      const q = at(d, s);
      yy = Math.max(yy, terrainHeight(q.x, q.z));
    }
    yy = Math.max(yy + 0.06, WATER_LEVEL - 0.5);
    if (i === 0) topY = yy;
    const q = at(d);
    slab(p.plaster, q.x, yy - 0.45, q.z, width, 0.9, tread + 0.04, b.up, tone(yy), 2);
    for (const side of [-1, 1]) {
      const w = at(d, side * (width / 2 + 0.3));
      slab(p.plaster, w.x, yy - 0.15, w.z, 0.6, 1.0, tread + 0.04, b.up, tone(yy + 0.2), 2);
    }
  }
  // the pavilions (chandni) at the top: four columns under a flat roof with its cornice
  const pf = new Frame(0, 0, 0, b.up);
  for (const side of [-1, 1]) {
    const c = at(reach + 1.6, side * (width / 2 + 1.6));
    const yy = terrainHeight(c.x, c.z);
    const f = new Frame(c.x, yy, c.z, b.up);
    f.box(p.plaster, 0, 0.3, 0, 3, 0.7, 3, tone(0.3), 2);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) column(f, p.plaster, sx * 1.15, sz * 1.15, 0.65, 3.4, 0.16, tone(2));
    f.box(p.plaster, 0, 3.55, 0, 3.4, 0.3, 3.4, tone(3.5), 2);
    f.box(p.plaster, 0, 3.8, 0, 2.8, 0.25, 2.8, tone(3.8), 2);
  }
  void pf;
  // a brick walk from the top of the steps to the house's
  const from = at(reach + 0.6);
  const len = Math.hypot(house.x - from.x, house.z - from.z);
  const yaw = Math.atan2(house.x - from.x, house.z - from.z);
  for (let d = 0; d < len; d += 1.2) {
    const q = { x: from.x + ((house.x - from.x) * d) / len, z: from.z + ((house.z - from.z) * d) / len };
    slab(p.brick, q.x, terrainHeight(q.x, q.z) - 0.06, q.z, 2.6, 0.2, 1.24, yaw, scaleRgb(TERRACOTTA, rng.range(0.78, 0.92)), 0.6);
  }
  void topY;
}

/** The family's temple: a terracotta char-chala on its plinth, three arches on its front, the roof's eaves curving down to its corners. */
function temple(p: Parts, m: Mound, rng: Rng): void {
  const at = shapePoint(m, 14, m.hv * 0.62);
  const y = terrainHeight(at.x, at.z) - 0.05;
  const f = new Frame(at.x, y, at.z, m.face);
  const S = 4.6;
  const plinth = 1.0;
  const wall = 3.0;
  const tone = () => scaleRgb(TERRACOTTA, rng.range(0.85, 1.05));
  f.box(p.brick, 0, plinth / 2, 0, S + 1.2, plinth, S + 1.2, tone(), 0.6);
  for (let i = 0; i < 3; i++) f.box(p.brick, 0, plinth * (1 - i / 3) / 2, S / 2 + 0.8 + i * 0.35, 2.2, plinth * (1 - i / 3), 0.36, tone(), 0.6);
  f.box(p.brick, 0, plinth + wall / 2, 0, S, wall, S, tone(), 0.6);
  for (let i = -1; i <= 1; i++) arch(f, p, i * 1.35, plinth, S / 2, 0.9, 2.0, false, scaleRgb(TERRACOTTA, 1.12), p.brick, null);
  // the curved cornice and the char-chala roof: four slopes rising to a point, their eaves sagging to the corners
  const eave = plinth + wall + 0.15;
  const apex = eave + 2.6;
  const half = S / 2 + 0.45;
  const droop = 0.42;
  const N = 8;
  const corners = [
    [-half, half],
    [half, half],
    [half, -half],
    [-half, -half],
  ];
  for (let k = 0; k < 4; k++) {
    const [ax, az] = corners[k];
    const [bx, bz] = corners[(k + 1) % 4];
    const c = p.brick.vertexCount;
    const n = f.n((ax + bx) / 2, half * 1.2, (az + bz) / 2);
    p.brick.vertex(f.p(0, apex, 0), n, 0.5, 2, tone());
    for (let i = 0; i <= N; i++) {
      const t = i / N;
      const x = ax + (bx - ax) * t;
      const z = az + (bz - az) * t;
      const e = eave + droop * (1 - (2 * t - 1) ** 2) * 0.6 - droop * (2 * t - 1) ** 2 * 0.4;
      p.brick.vertex(f.p(x, e, z), n, t * 3, 0, tone());
    }
    for (let i = 0; i < N; i++) p.brick.tri(c, c + i + 1, c + i + 2);
    // the eave's thickness
    const s = p.brick.vertexCount;
    const out = f.n((ax + bx) / 2, 0, (az + bz) / 2);
    for (let i = 0; i <= N; i++) {
      const t = i / N;
      const x = ax + (bx - ax) * t;
      const z = az + (bz - az) * t;
      const e = eave + droop * (1 - (2 * t - 1) ** 2) * 0.6 - droop * (2 * t - 1) ** 2 * 0.4;
      p.brick.vertex(f.p(x, e, z), out, t * 3, 0, tone());
      p.brick.vertex(f.p(x * 0.97, e - 0.28, z * 0.97), out, t * 3, 0.3, tone());
    }
    for (let i = 0; i < N; i++) p.brick.quad(s + i * 2, s + i * 2 + 1, s + i * 2 + 3, s + i * 2 + 2);
  }
  // the finial: a pot (kalash) on a disc
  const kalash = new LatheGeometry([new Vector2(0.01, 0), new Vector2(0.22, 0.05), new Vector2(0.26, 0.25), new Vector2(0.14, 0.45), new Vector2(0.08, 0.6), new Vector2(0.02, 0.85)], 10);
  put(f, p.brick, kalash, 0, apex - 0.05, 0, scaleRgb(TERRACOTTA, 1.1));
}

// ---------- the mosque ----------

function mosque(p: Parts, m: Mound, rng: Rng): void {
  const at = shapePoint(m, -2, 0);
  const y = terrainHeight(at.x, at.z) - 0.05;
  const f = new Frame(at.x, y, at.z, m.face);
  const W = 10;
  const D = 7.5;
  const plinth = 0.8;
  const wall = 4.4;
  const top = plinth + wall;
  const white = (k = 1) => scaleRgb(rgb('#ece8dc'), k * rng.range(0.96, 1.02));
  // the plinth under the hall and its forecourt
  f.box(p.white, 0, plinth / 2 - 0.1, 2.5, W + 3, plinth + 0.2, D + 9, white(0.9), 3);
  // the prayer hall
  f.box(p.white, 0, plinth + wall / 2, 0, W, wall, D, white(), 3);
  // a green band under the parapet, and the parapet's merlons
  f.box(p.white, 0, top - 0.25, 0, W + 0.08, 0.18, D + 0.08, GREEN, 3);
  const merlon = new BoxGeometry(0.26, 0.42, 0.22);
  for (let x = -W / 2 + 0.3; x <= W / 2 - 0.3; x += 0.6) {
    for (const z of [-D / 2 + 0.11, D / 2 - 0.11]) put(f, p.white, merlon, x, top + 0.21, z, white());
  }
  for (let z = -D / 2 + 0.6; z <= D / 2 - 0.6; z += 0.6) for (const x of [-W / 2 + 0.11, W / 2 - 0.11]) put(f, p.white, merlon, x, top + 0.21, z, white(), Math.PI / 2);
  // the front: three pointed arches, the middle one wider, doors of green
  const front = D / 2;
  arch(f, p, 0, plinth, front, 1.6, 3.3, true, white(1.04), p.white, GREEN);
  for (const side of [-1, 1]) arch(f, p, side * 3.0, plinth, front, 1.2, 2.8, true, white(1.04), p.white, GREEN);
  // pointed windows on the sides
  for (const side of [-1, 1]) {
    const ef = new Frame(at.x + side * (W / 2) * Math.cos(m.face), y, at.z - side * (W / 2) * Math.sin(m.face), m.face + (side * Math.PI) / 2);
    for (const zz of [-1.8, 1.8]) arch(ef, p, zz, plinth + 1.1, 0, 0.8, 1.7, true, white(1.04), p.white, null);
  }
  // the dome on its drum, with a finial
  const drum = new CylinderGeometry(2.55, 2.6, 0.9, 16, 1);
  put(f, p.white, drum, 0, top + 0.45, 0, white());
  f.box(p.white, 0, top + 0.95, 0, 0.1, 0.1, 0.1, white());
  const prof: Vector2[] = [];
  for (let i = 0; i <= 12; i++) {
    const a = (i / 12) * (Math.PI / 2);
    // a little drawn up toward its crown, as Bengal's mosque domes are
    prof.push(new Vector2(Math.cos(a) * 2.6, Math.sin(a) * 2.6 * (1 + 0.18 * (i / 12) ** 2)));
  }
  const dome = new LatheGeometry(prof, 24);
  put(f, p.white, dome, 0, top + 0.9, 0, white(1.03));
  const spire = new CylinderGeometry(0.03, 0.07, 1.4, 6);
  put(f, p.wood, spire, 0, top + 0.9 + 3.07 + 0.7, 0, rgb('#b8a060'));
  put(f, p.wood, new SphereGeometry(0.16, 8, 6), 0, top + 0.9 + 3.1 + 0.35, 0, rgb('#b8a060'));
  // the turrets at its corners, each with its little dome
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const x = sx * (W / 2 + 0.05);
      const z = sz * (D / 2 + 0.05);
      put(f, p.white, new CylinderGeometry(0.32, 0.38, wall + 2.2, 8, 1), x, plinth + (wall + 2.2) / 2, z, white());
      for (const h of [top - 0.2, top + 1.2]) put(f, p.white, new CylinderGeometry(0.44, 0.44, 0.16, 8, 1), x, h, z, white(1.02));
      put(f, p.white, new SphereGeometry(0.36, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2), x, plinth + wall + 2.2, z, white(1.03));
      put(f, p.wood, new CylinderGeometry(0.015, 0.03, 0.5, 5), x, plinth + wall + 2.75, z, rgb('#b8a060'));
    }
  }
  // the forecourt's low wall, its gate open toward the pond
  const cz0 = front;
  const cz1 = front + 7.5;
  for (const side of [-1, 1]) f.box(p.white, side * (W / 2 + 1.2), plinth + 0.45, (cz0 + cz1) / 2, 0.25, 0.9, cz1 - cz0, white(0.97), 3);
  for (const side of [-1, 1]) {
    f.box(p.white, side * (W / 4 + 1.6), plinth + 0.45, cz1, W / 2 - 0.4, 0.9, 0.25, white(0.97), 3);
    f.box(p.white, side * 1.25, plinth + 0.75, cz1, 0.42, 1.5, 0.42, white(1.02), 3);
    put(f, p.white, new SphereGeometry(0.2, 8, 6), side * 1.25, plinth + 1.6, cz1, white(1.03));
  }
  // steps down from the gate
  for (let i = 0; i < 3; i++) f.box(p.white, 0, plinth * (1 - i / 3) / 2 - 0.05, cz1 + 0.5 + i * 0.35, 2.2, plinth * (1 - i / 3) + 0.1, 0.36, white(0.9), 3);
}

// ---------- the tea stall ----------

function teaStall(p: Parts, rng: Rng): void {
  const y = terrainHeight(TEA_STALL.x, TEA_STALL.z) - 0.05;
  const f = new Frame(TEA_STALL.x, y, TEA_STALL.z, TEA_STALL.face);
  const W = 3.4;
  const D = 2.4;
  const bamboo = rgb('#a39469');
  const pole = (x: number, z: number, h: number) => taperedTube(p.bamboo, [f.p(x, -0.2, z), f.p(x, h, z)], [0.055, 0.05], 6, scaleRgb(bamboo, rng.range(0.85, 1.05)), 1.2);
  // the posts: the front ones taller, two more out front under the awning
  for (const sx of [-1, 1]) {
    pole(sx * W / 2, D / 2, 2.55);
    pole(sx * W / 2, -D / 2, 2.05);
    pole(sx * W / 2, D / 2 + 1.3, 2.15);
  }
  // the floor, a little raised, and the mat walls at the back and sides
  f.box(p.wood, 0, 0.12, 0, W, 0.24, D, rgb('#5a4632'), 1);
  f.box(p.mat, 0, 1.15, -D / 2 + 0.02, W, 1.9, 0.04, rgb('#c8b892'), 1.2);
  for (const sx of [-1, 1]) f.box(p.mat, sx * (W / 2 - 0.02), 1.15, 0, 0.04, 1.9, D, rgb('#c8b892'), 1.2);
  // the tin roof, high at the front and down to the back, run out over the benches
  const n = f.n(0, 1, 0.2);
  const s = p.tin.vertexCount;
  const corners: [number, number, number][] = [
    [-W / 2 - 0.3, 2.0, -D / 2 - 0.3],
    [W / 2 + 0.3, 2.0, -D / 2 - 0.3],
    [W / 2 + 0.3, 2.6, D / 2],
    [-W / 2 - 0.3, 2.6, D / 2],
  ];
  for (const [x, yy, z] of corners) p.tin.vertex(f.p(x, yy, z), n, x / 2.4, z / 2.4, rgb('#b4b2a8'));
  p.tin.quad(s, s + 3, s + 2, s + 1);
  const a = p.tin.vertexCount;
  const awning: [number, number, number][] = [
    [-W / 2 - 0.3, 2.6, D / 2],
    [W / 2 + 0.3, 2.6, D / 2],
    [W / 2 + 0.3, 2.25, D / 2 + 1.5],
    [-W / 2 - 0.3, 2.25, D / 2 + 1.5],
  ];
  for (const [x, yy, z] of awning) p.tin.vertex(f.p(x, yy, z), f.n(0, 1, 0.25), x / 2.4, z / 2.4, rgb('#a8a69c'));
  p.tin.quad(a, a + 3, a + 2, a + 1);
  // the counter across the front, its jars, the clay stove and the kettle
  f.box(p.wood, 0, 0.62, D / 2 - 0.3, W - 0.3, 0.95, 0.5, rgb('#6a5038'), 1);
  f.box(p.wood, 0, 1.1, D / 2 - 0.3, W - 0.2, 0.05, 0.6, rgb('#7a5e42'), 1);
  const jar = new CylinderGeometry(0.11, 0.11, 0.3, 10);
  for (let i = 0; i < 4; i++) put(f, p.wood, jar, -1.1 + i * 0.32, 1.28, D / 2 - 0.35, mixRgb(rgb('#c8d4cc'), rgb('#d8a84a'), (i % 2) * 0.6));
  f.box(p.plaster, 1.1, 1.25, D / 2 - 0.35, 0.45, 0.25, 0.4, rgb('#5c4632'), 1);
  put(f, p.wood, new CylinderGeometry(0.11, 0.14, 0.22, 10), 1.1, 1.48, D / 2 - 0.35, rgb('#6a6a66'));
  put(f, p.wood, new CylinderGeometry(0.015, 0.025, 0.2, 5), 1.25, 1.52, D / 2 - 0.35, rgb('#6a6a66'), 0.8);
  // a bunch of bananas hung from the eave
  const hand = new SphereGeometry(1, 6, 4);
  const hx = -W / 2 + 0.25;
  for (let k = 0; k < 9; k++) {
    const yy = 2.2 - (k % 3) * 0.12;
    put(f, p.wood, hand, hx + Math.cos(k * 2.1) * 0.12, yy - 0.15, D / 2 + 0.15 + Math.sin(k * 2.1) * 0.12, mixRgb(rgb('#b8b040'), rgb('#7a8a30'), (k % 3) * 0.3), 0, 0.05, 0.13, 0.05);
  }
  taperedTube(p.bamboo, [f.p(hx, 2.55, D / 2 + 0.15), f.p(hx, 2.2, D / 2 + 0.15)], [0.008, 0.008], 3, rgb('#5a4630'), 1);
  // benches: one along the front under the awning, one at the side
  const bench = (x: number, z: number, turn: number, len: number) => {
    f.box(p.wood, x, 0.45, z, len, 0.07, 0.34, rgb('#6a5038'), 1, turn);
    for (const s of [-1, 1]) {
      const lx = x + Math.cos(turn) * s * (len / 2 - 0.15);
      const lz = z - Math.sin(turn) * s * (len / 2 - 0.15);
      f.box(p.wood, lx, 0.21, lz, 0.07, 0.42, 0.3, rgb('#4a3826'), 1, turn);
    }
  };
  bench(0, D / 2 + 1.0, 0, 2.6);
  bench(W / 2 + 0.9, 0.2, Math.PI / 2, 1.8);
}

// ---------- assembly ----------

export function buildLandmarks(): Group {
  const rng = new Rng(808);
  const p: Parts = {
    plaster: new MeshBuilder(),
    white: new MeshBuilder(),
    brick: new MeshBuilder(),
    wood: new MeshBuilder(),
    tin: new MeshBuilder(),
    mat: new MeshBuilder(),
    bamboo: new MeshBuilder(),
    leaves: new MeshBuilder(),
  };
  const zm = MOUNDS.find((m) => m.id === 'zamindar');
  if (zm) {
    const house = zamindarHouse(p, zm, rng);
    grandGhat(p, zm, house.stepsAt, rng);
    temple(p, zm, rng);
  }
  const mm = MOUNDS.find((m) => m.id === 'mosque');
  if (mm) mosque(p, mm, rng);
  teaStall(p, rng);

  const group = new Group();
  group.name = 'landmarks';
  const plaster = plasterTexture(811);
  const brick = brickTexture(812);
  const peepal = leafClusterTexture(813, ['#2e5a1c', '#3b6b22', '#4b7d2a', '#5c8f34'], { count: 90, len: [0.12, 0.2], width: 0.6 });
  const add = (b: MeshBuilder, mat: MeshStandardMaterial) => {
    if (!b.vertexCount) return;
    const g = b.build();
    const mesh = new Mesh(g, mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  };
  add(p.plaster, patchMaterial(new MeshStandardMaterial({ map: plaster.map, normalMap: plaster.normal, normalScale: new Vector2(0.8, 0.8), vertexColors: true, roughness: 0.92 }), { grime: 0.45 }));
  const lime = plasterTexture(816, { white: true, fallen: false });
  add(p.white, patchMaterial(new MeshStandardMaterial({ map: lime.map, normalMap: lime.normal, normalScale: new Vector2(0.5, 0.5), vertexColors: true, roughness: 0.9 }), { grime: 0.2 }));
  add(p.brick, patchMaterial(new MeshStandardMaterial({ map: brick.map, normalMap: brick.normal, normalScale: new Vector2(0.8, 0.8), vertexColors: true, roughness: 0.88 }), { grime: 0.35 }));
  add(p.wood, patchMaterial(new MeshStandardMaterial({ vertexColors: true, roughness: 0.75 }), { grime: 0.3 }));
  add(p.tin, patchMaterial(new MeshStandardMaterial({ map: tinTexture(814), vertexColors: true, roughness: 0.55, metalness: 0.15, side: DoubleSide }), { grime: 0.5 }));
  add(p.mat, patchMaterial(new MeshStandardMaterial({ map: weaveTexture(815), vertexColors: true, roughness: 0.9 }), { grime: 0.3 }));
  add(p.bamboo, patchMaterial(new MeshStandardMaterial({ vertexColors: true, roughness: 0.7, side: DoubleSide }), { grime: 0.4 }));
  add(
    p.leaves,
    patchMaterial(
      new MeshStandardMaterial({ map: peepal.map, normalMap: peepal.normal, vertexColors: true, alphaTest: 0.42, alphaToCoverage: true, side: DoubleSide, roughness: 0.7 }),
      { translucency: 1, foliage: true, seasonal: 'leaf', wind: 0.08, windHeight: 4 },
    ),
  );
  return group;
}
