import { BoxGeometry, BufferGeometry, Color, ConeGeometry, CylinderGeometry, DoubleSide, Group, InstancedMesh, LatheGeometry, Matrix4, Mesh, MeshStandardMaterial, PlaneGeometry, Quaternion, SphereGeometry, TorusGeometry, Vector2, Vector3 } from 'three';
import { G } from '../core/globals';
import { smoothstep } from '../core/mathx';
import { Rng } from '../core/rng';
import { MeshBuilder, card, mixRgb, rgb, scaleRgb, slab, taperedTube, type RGB } from '../render/builder';
import { patchMaterial } from '../render/patch';
import { brickTexture, glowTexture, inscriptionTexture, leafClusterTexture, plasterTexture, tinTexture, weaveTexture } from '../render/textures';
import { MOUNDS, PONDS, WATER_LEVEL, bankAt, pondReach, shapePoint, terrainHeight, type Mound, type Pond } from './geography';
import { Frame } from './houses';
import { TEA_STALL } from './plan';

// The village's landmarks, each built where the design sets it (world/plan.ts) on its own raised ground:
// - the zamindar house: two storeys of lime-plastered brick behind a colonnade on both floors, a balustrade
//   and a cornice, a pediment over its middle; green louvred shutters; the plaster stained by a hundred rains
//   and fallen away here and there to the brick; its parapet broken at one end, where a peepal has taken root;
//   a grand ghat down to the river between two little pavilions, a brick walk up to its steps, and the
//   family's temple, a terracotta char-chala, beside the lawn;
// - the mosque: a small whitewashed prayer hall with three pointed arches, a dome on its drum, slender
//   turrets at its corners with little domes, a parapet of merlons, and a walled forecourt; its graveyard on a
//   low rise beside it, the graves of every age among henna bushes inside a low wall and a bamboo fence;
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
  /** Where lamps hang (the mosque's), lit after dark. */
  lamps: Vector3[];
  /** Openings lit from within after dark (the mosque's doors and windows): dark by day. */
  glow: MeshBuilder;
  /** The lamps whose light falls on what is round them (world): where, how far (m), how strong. At most three (globals.ts uLamp0..2). */
  lights: { at: Vector3; reach: number; strength: number }[];
  /** Small glass lanterns (their glass's middle, world), and their frames' turn. */
  lanterns: { at: Vector3; ry: number }[];
  /** The mosque's inscription: its panel's middle (world), its frame's turn, and its size (m). */
  kalima: { at: Vector3; ry: number; w: number; h: number } | null;
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

/**
 * A dark opening under an arch on a wall at local z, with a raised frame round it; `leaves` closes the lower part
 * with two painted door leaves. A `lit` one glows after dark with the light of the room behind it.
 */
function arch(f: Frame, p: Parts, x: number, y0: number, z: number, w: number, h: number, pointed: boolean, frameColor: RGB, frame: MeshBuilder, leaves: RGB | null, lit = false): void {
  const pts = archOutline(x, y0, w, h, pointed);
  const n = f.n(0, 0, 1);
  // the opening: a fan from the foot's middle (the outline is convex); a lit one's glow runs along u from there
  // to its edge (glowTexture)
  const b = lit ? p.glow : p.wood;
  const c = b.vertexCount;
  b.vertex(f.p(x, y0, z + 0.012), n, 0, 0.5, DARK);
  for (const q of pts) b.vertex(f.p(q.x, q.y, z + 0.012), n, 1, 0.5, DARK);
  for (let i = 0; i < pts.length - 1; i++) b.tri(c, c + i + 2, c + i + 1);
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

// ---------- the graveyard ----------

const EARTH: RGB = rgb('#6f5238');
const SOD: RGB = rgb('#56623a');

/**
 * An earth grave: a long low heap, `len` × `wid` m, `h` high, rounded over its back; fresh earth, or (`age` 1)
 * sunk lower and grassed over. Long along the frame's z (north).
 */
function heap(f: Frame, b: MeshBuilder, x: number, z: number, len: number, wid: number, h: number, age: number, ground: (x: number, z: number) => number): void {
  const nx = 6;
  const nz = 8;
  const first = b.vertexCount;
  for (let j = 0; j <= nz; j++) {
    const v = (j / nz) * 2 - 1;
    for (let i = 0; i <= nx; i++) {
      const u = (i / nx) * 2 - 1;
      const lift = h * Math.max(0, 1 - u * u) ** 0.6 * Math.max(0, 1 - v ** 4) ** 0.5;
      const lx = x + (u * wid) / 2;
      const lz = z + (v * len) / 2;
      const p = f.p(lx, ground(lx, lz) + lift - 0.03, lz);
      // the slope's normal, roughly, for its shading
      const n = f.n(-u * h * 2.4 / wid, 1, -(v ** 3) * h * 3 / len);
      b.vertex(p, n, u, v, scaleRgb(mixRgb(EARTH, SOD, age * (0.6 + 0.4 * (1 - Math.abs(u)))), 0.9 + 0.1 * Math.sin(i * 2.3 + j)));
    }
  }
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
    const a = first + j * (nx + 1) + i;
    b.quad(a, a + nx + 1, a + nx + 2, a + 1);
  }
}

/** A low curb of whitewashed brick round a grave (`len` × `wid`), weathered grey, a gap where it has fallen (`broken`). */
function curb(f: Frame, b: MeshBuilder, x: number, z: number, len: number, wid: number, h: number, tone: RGB, broken: number, ground: (x: number, z: number) => number, rng: Rng): void {
  const t = 0.12;
  const side = (cx: number, cz: number, sx: number, sz: number) => {
    if (rng.next() < broken) return;
    f.box(b, cx, ground(cx, cz) + h / 2 - 0.04, cz, sx, h + 0.08, sz, scaleRgb(tone, rng.range(0.88, 1.04)), 1.5);
  };
  side(x - wid / 2, z, t, len + t);
  side(x + wid / 2, z, t, len + t);
  side(x, z - len / 2, wid, t);
  side(x, z + len / 2, wid, t);
}

/**
 * The mosque's graveyard (plan.ts GRAVEYARD) on its low rise: a dozen graves lying north to south in loose
 * rows, of every age (fresh earth fenced with split bamboo, grassed heaps, a few old ones curbed in whitewashed
 * brick, one with a small plain headstone, one sunk and broken), henna bushes among them, a low brick wall
 * toward the mosque and the path with a gap to come in by, and a bamboo fence round the rest, fallen in places.
 */
function graveyard(p: Parts, m: Mound, rng: Rng): void {
  const y0 = terrainHeight(m.x, m.z);
  const f = new Frame(m.x, y0, m.z, m.face);
  const ground = (x: number, z: number) => {
    const w = f.p(x, 0, z);
    return terrainHeight(w.x, w.z) - y0;
  };
  const W = m.hv - 1.5;
  const D = m.hu - 1.5;
  // the graves, row by row, each a little out of line
  const rows = [-D * 0.55, -D * 0.05, D * 0.45];
  let k = 0;
  for (const rz of rows) {
    let x = -W + rng.range(1.2, 2.6);
    while (x < W - 1.5) {
      const z = rz + rng.range(-0.6, 0.6);
      const len = rng.range(1.9, 2.3);
      const wid = rng.range(0.8, 1.0);
      const kind = k % 7;
      const sub = new Frame(f.p(x, 0, z).x, y0, f.p(x, 0, z).z, m.face + rng.range(-0.06, 0.06));
      const g = (lx: number, lz: number) => {
        const w = sub.p(lx, 0, lz);
        return terrainHeight(w.x, w.z) - y0;
      };
      if (kind === 0) {
        // a new one, its earth still bare, fenced with split bamboo
        heap(sub, p.wood, 0, 0, len, wid, 0.3, 0, g);
        const fw = wid + 0.4;
        const fl = len + 0.4;
        for (const [cx, cz] of [
          [-fw / 2, -fl / 2],
          [fw / 2, -fl / 2],
          [-fw / 2, fl / 2],
          [fw / 2, fl / 2],
        ]) sub.box(p.bamboo, cx, g(cx, cz) + 0.28, cz, 0.05, 0.6, 0.05, scaleRgb(rgb('#b49a62'), rng.range(0.85, 1.05)), 1);
        for (const y of [0.22, 0.48]) {
          sub.box(p.bamboo, -fw / 2, g(-fw / 2, 0) + y, 0, 0.035, 0.035, fl, rgb('#c2a86c'), 1);
          sub.box(p.bamboo, fw / 2, g(fw / 2, 0) + y, 0, 0.035, 0.035, fl, rgb('#c2a86c'), 1);
          sub.box(p.bamboo, 0, g(0, -fl / 2) + y, -fl / 2, fw, 0.035, 0.035, rgb('#bca468'), 1);
          sub.box(p.bamboo, 0, g(0, fl / 2) + y, fl / 2, fw, 0.035, 0.035, rgb('#bca468'), 1);
        }
      } else if (kind === 2 || kind === 5) {
        // an old one curbed in whitewashed brick, grassed inside; one with a small plain headstone at its head
        curb(sub, p.white, 0, 0, len, wid, 0.24, scaleRgb(rgb('#d8d2c2'), 0.82), 0, g, rng);
        heap(sub, p.wood, 0, 0, len - 0.15, wid - 0.15, 0.12, 1, g);
        if (kind === 2) sub.box(p.white, 0, g(0, len / 2 + 0.08) + 0.3, len / 2 + 0.08, 0.42, 0.62, 0.08, scaleRgb(rgb('#d4cebe'), 0.85), 1, rng.range(-0.08, 0.08));
      } else if (kind === 6) {
        // a very old one: its curb sunk and broken, the earth within flat
        curb(sub, p.white, 0, 0, len, wid, 0.1, scaleRgb(rgb('#bdb6a6'), 0.72), 0.45, g, rng);
      } else {
        // a heap grassed over, lower the older it is
        const age = rng.range(0.55, 1);
        heap(sub, p.wood, 0, 0, len, wid, 0.28 - 0.12 * age, age, g);
      }
      k++;
      x += wid + rng.range(1.0, 2.4) + (rng.next() < 0.2 ? 2.5 : 0);
    }
  }
  // henna bushes among the graves and at the corners, dark and small-leaved
  for (let b = 0; b < 7; b++) {
    const bx = rng.range(-W, W);
    const bz = rng.sign() * rng.range(D * 0.7, D) * (b < 4 ? 1 : rng.range(0.2, 1));
    const c = f.p(bx, ground(bx, bz) + 0.45, bz);
    for (let i = 0; i < 14; i++) {
      const a = rng.range(0, Math.PI * 2);
      const e = rng.range(0.1, 1.2);
      const r = rng.range(0.15, 0.5);
      const at = new Vector3(c.x + Math.cos(a) * Math.sin(e) * r, c.y + Math.cos(e) * r * 0.8, c.z + Math.sin(a) * Math.sin(e) * r);
      const n = at.clone().sub(c).normalize();
      const facing = n.clone().add(new Vector3(rng.range(-0.5, 0.5), rng.range(-0.3, 0.6), rng.range(-0.5, 0.5))).normalize();
      const right = new Vector3().crossVectors(facing, new Vector3(0, 1, 0)).normalize().multiplyScalar(0.34);
      const up = new Vector3().crossVectors(right, facing).normalize().multiplyScalar(0.34);
      card(p.leaves, at, right, up, n, scaleRgb([0.62, 0.68, 0.55], rng.range(0.7, 1)));
    }
  }
  // the low brick wall along its east (toward the path) and north (toward the mosque), with a gap to come in by;
  // a bamboo fence along the rest, its rails fallen here and there
  const wallH = 0.65;
  const edge = (from: [number, number], to: [number, number], brick: boolean, gapAt: number) => {
    const len = Math.hypot(to[0] - from[0], to[1] - from[1]);
    const steps = Math.max(1, Math.round(len / (brick ? 2 : 2.4)));
    const turn = Math.atan2(to[0] - from[0], to[1] - from[1]);
    for (let i = 0; i < steps; i++) {
      const t0 = i / steps;
      const t1 = (i + 1) / steps;
      const tm = (t0 + t1) / 2;
      if (Math.abs(tm - gapAt) < 0.06) continue;
      const cx = from[0] + (to[0] - from[0]) * tm;
      const cz = from[1] + (to[1] - from[1]) * tm;
      const seg = len / steps;
      if (brick) {
        // its plaster long gone in patches, a course or two lower where it has crumbled
        const h = wallH * (rng.next() < 0.15 ? rng.range(0.55, 0.8) : 1);
        f.box(p.brick, cx, ground(cx, cz) + h / 2 - 0.1, cz, 0.24, h + 0.2, seg + 0.02, scaleRgb(rgb('#c9a594'), rng.range(0.8, 1)), 1.5, turn);
      } else {
        f.box(p.bamboo, from[0] + (to[0] - from[0]) * t0, ground(cx, cz) + 0.5, from[1] + (to[1] - from[1]) * t0, 0.06, 1.1, 0.06, rgb('#a58e5c'), 1);
        for (const y of [0.35, 0.8]) if (rng.next() > 0.18) f.box(p.bamboo, cx, ground(cx, cz) + y, cz, 0.04, 0.04, seg, scaleRgb(rgb('#b8a06a'), rng.range(0.85, 1.05)), 1, turn);
      }
    }
  };
  const X = m.hv - 0.6;
  const Z = m.hu - 0.6;
  // (the frame's x is the shape's v: −x lies to the east, toward the path, when it faces north)
  edge([-X, -Z], [-X, Z], true, 0.45);
  edge([-X, Z], [X, Z], true, -1);
  edge([X, Z], [X, -Z], false, -1);
  edge([X, -Z], [-X, -Z], false, -1);
}

// ---------- the mosque ----------

/** The kalima over the mosque's door (calligraphy, plan.ts KALIMA_FONT). */
const KALIMA = 'لَا إِلٰهَ إِلَّا اللَّهُ مُحَمَّدٌ رَسُولُ اللَّهِ';

/**
 * The mosque's layout along its axis (its frame: z out of its front, east, toward its pond; x across it), m:
 * the mihrab behind the hall, the hall, the verandah before it, the forecourt and its gate, the steps down.
 */
const MQ = {
  plinth: 0.9,
  /** The hall's half-width, its back and front, and its walls' height over the plinth. */
  hw: 5.5,
  back: -4.25,
  front: 4.25,
  wall: 4.6,
  /** The verandah's front and its roof's underside. */
  veranda: 7.45,
  porch: 3.9,
  /** The forecourt's gate, and how far its steps run out (5 steps). */
  gate: 13.5,
  steps: 5,
  tread: 0.36,
  /** The forecourt's half-width. */
  cw: 6.5,
} as const;

/** Where the mosque's frame stands (its origin) and the foot of its steps (world), for the walk to its pond. */
export function mosqueAxis(): { x: number; z: number; face: number; foot: number } {
  const m = MOUNDS.find((k) => k.id === 'mosque');
  if (!m) return { x: 0, z: 0, face: 0, foot: 0 };
  const at = shapePoint(m, -2, 0);
  return { x: at.x, z: at.z, face: m.face, foot: MQ.gate + MQ.steps * MQ.tread };
}

/**
 * An open arcade's spandrel and soffit over an opening from `x0` to `x1` at local z (`depth` deep): the wall
 * between the pointed arch and the beam over it at `top`, both faces, and the arch's underside.
 */
function arcade(f: Frame, b: MeshBuilder, x0: number, x1: number, spring: number, rise: number, top: number, z: number, depth: number, color: RGB): void {
  const pts = archOutline((x0 + x1) / 2, spring, x1 - x0, rise, true);
  for (const [face, dz] of [
    [1, depth / 2],
    [-1, -depth / 2],
  ] as const) {
    const n = f.n(0, 0, face);
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i];
      const c = pts[i + 1];
      const q = b.vertexCount;
      b.vertex(f.p(a.x, a.y, z + dz), n, a.x, a.y, color);
      b.vertex(f.p(c.x, c.y, z + dz), n, c.x, c.y, color);
      b.vertex(f.p(c.x, top, z + dz), n, c.x, top, color);
      b.vertex(f.p(a.x, top, z + dz), n, a.x, top, color);
      if (face > 0) b.quad(q, q + 1, q + 2, q + 3);
      else b.quad(q, q + 3, q + 2, q + 1);
    }
  }
  // the arch's underside, a little darker
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i];
    const c = pts[i + 1];
    const mx = (a.x + c.x) / 2 - (x0 + x1) / 2;
    const n = f.n(-mx, -(Math.max(a.y, c.y) - spring), 0);
    const q = b.vertexCount;
    b.vertex(f.p(a.x, a.y, z - depth / 2), n, 0, 0, scaleRgb(color, 0.86));
    b.vertex(f.p(c.x, c.y, z - depth / 2), n, 1, 0, scaleRgb(color, 0.86));
    b.vertex(f.p(c.x, c.y, z + depth / 2), n, 1, 1, scaleRgb(color, 0.86));
    b.vertex(f.p(a.x, a.y, z + depth / 2), n, 0, 1, scaleRgb(color, 0.86));
    b.quad(q, q + 3, q + 2, q + 1);
  }
}

/** A Bengal dome on its drum at local (x, z): the drum's height, the dome's radius, its lotus collar and its finial with a crescent. */
function bengalDome(f: Frame, p: Parts, x: number, z: number, y: number, r: number, drumH: number, white: (k?: number) => RGB, rng: Rng): void {
  // the octagonal drum, small arched niches round it
  put(f, p.white, new CylinderGeometry(r * 0.98, r, drumH, 8, 1), x, y + drumH / 2, z, white(0.98));
  for (let k = 0; k < 8 && r > 1.5; k++) {
    const a = ((k + 0.5) / 8) * Math.PI * 2;
    arch(faceFrame(f, x, z, a, r * 0.93), p, 0, y + drumH * 0.2, 0.02, 0.34, drumH * 0.6, true, white(1.04), p.white, null);
  }
  put(f, p.white, new CylinderGeometry(r * 1.04, r * 1.04, 0.12, 16, 1), x, y + drumH, z, white(1.02));
  // the dome, swelling a little above its base and drawn up to its crown, as Bengal's are
  const prof: Vector2[] = [];
  for (let i = 0; i <= 14; i++) {
    const t = i / 14;
    const a = t * (Math.PI / 2);
    prof.push(new Vector2(Math.cos(a) * r * (1 + 0.06 * Math.sin(t * Math.PI)), Math.sin(a) * r * (1.05 + 0.25 * t * t)));
  }
  put(f, p.white, new LatheGeometry(prof, 28), x, y + drumH + 0.06, z, white(1.03));
  // the lotus collar where it starts, and the finial: a kalash of stacked bulbs, its spike, the crescent
  const crown = y + drumH + r * 1.3;
  const gold: RGB = rgb('#b89a52');
  for (let k = 0; k < 12; k++) {
    const a = (k / 12) * Math.PI * 2;
    put(f, p.white, new SphereGeometry(r * 0.13, 6, 4), x + Math.sin(a) * r * 0.98, y + drumH + 0.12, z + Math.cos(a) * r * 0.98, white(1.05));
  }
  put(f, p.white, new SphereGeometry(r * 0.12, 8, 6), x, crown + r * 0.06, z, white(1.04));
  put(f, p.wood, new SphereGeometry(r * 0.07, 8, 6), x, crown + r * 0.2, z, gold);
  put(f, p.wood, new CylinderGeometry(0.015, 0.035, r * 0.45, 6), x, crown + r * 0.45, z, gold);
  const moon = new TorusGeometry(r * 0.08, r * 0.018, 5, 12, Math.PI * 1.35).rotateZ(-Math.PI * 0.18);
  put(f, p.wood, moon, x, crown + r * 0.72, z, gold);
  void rng;
}

/** A slender octagonal turret at local (x, z) from `y0` up `h`: rings round it, a little domed cupola. */
function turret(f: Frame, p: Parts, x: number, z: number, y0: number, h: number, r: number, white: (k?: number) => RGB): void {
  put(f, p.white, new CylinderGeometry(r * 0.85, r, h, 8, 1), x, y0 + h / 2, z, white());
  for (const t of [0.35, 0.72, 1]) put(f, p.white, new CylinderGeometry(r * 1.28, r * 1.28, 0.14, 8, 1), x, y0 + h * t, z, t === 1 ? GREEN : white(1.03));
  put(f, p.white, new CylinderGeometry(r * 0.9, r * 0.9, r * 1.1, 8, 1), x, y0 + h + r * 0.55, z, white(1.01));
  put(f, p.white, new SphereGeometry(r * 1.0, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2), x, y0 + h + r * 1.1, z, white(1.04));
  put(f, p.wood, new CylinderGeometry(0.012, 0.03, r * 1.4, 5), x, y0 + h + r * 2.6, z, rgb('#b89a52'));
}

function mosque(p: Parts, m: Mound, rng: Rng): void {
  const at = shapePoint(m, -2, 0);
  const y0 = terrainHeight(at.x, at.z) - 0.05;
  const f = new Frame(at.x, y0, at.z, m.face);
  const white = (k = 1) => scaleRgb(rgb('#ece8dc'), k * rng.range(0.96, 1.02));
  const P = MQ.plinth;
  const top = P + MQ.wall;
  const D = MQ.front - MQ.back;
  const midZ = (MQ.front + MQ.back) / 2;
  // the plinth under the hall, the verandah and the forecourt: plastered, a darker band at its foot, a coping
  f.box(p.white, 0, P / 2 - 0.25, (MQ.back - 1.2 + MQ.gate) / 2, MQ.cw * 2, P + 0.5, MQ.gate - MQ.back + 1.2, white(0.9), 3);
  f.box(p.white, 0, 0.12, (MQ.back - 1.2 + MQ.gate) / 2, MQ.cw * 2 + 0.08, 0.3, MQ.gate - MQ.back + 1.28, scaleRgb(rgb('#a39a88'), 0.95), 3);
  // the verandah's and the forecourt's floor: red tiles, worn
  f.box(p.brick, 0, P + 0.01, (MQ.front + MQ.gate) / 2, MQ.cw * 2 - 0.5, 0.04, MQ.gate - MQ.front - 0.3, scaleRgb(rgb('#b58a72'), 0.95), 1);

  // ---- the prayer hall ----
  f.box(p.white, 0, P + MQ.wall / 2, midZ, MQ.hw * 2, MQ.wall, D, white(), 3);
  // pilasters at its corners and a cornice, a green band and a parapet of merlons along its top
  for (const sx of [-1, 1]) for (const sz of [MQ.back, MQ.front]) f.box(p.white, sx * (MQ.hw + 0.02), P + MQ.wall / 2, sz, 0.5, MQ.wall, 0.5, white(1.02), 3);
  f.box(p.white, 0, top - 0.32, midZ, MQ.hw * 2 + 0.22, 0.16, D + 0.22, white(1.03), 3);
  f.box(p.white, 0, top - 0.15, midZ, MQ.hw * 2 + 0.1, 0.16, D + 0.1, GREEN, 3);
  const merlon = new BoxGeometry(0.24, 0.42, 0.2);
  for (let x = -MQ.hw + 0.3; x <= MQ.hw - 0.3; x += 0.55) for (const z of [MQ.back + 0.1, MQ.front - 0.1]) put(f, p.white, merlon, x, top + 0.21, z, white());
  for (let z = MQ.back + 0.55; z <= MQ.front - 0.5; z += 0.55) for (const x of [-MQ.hw + 0.1, MQ.hw - 0.1]) put(f, p.white, merlon, x, top + 0.21, z, white(), Math.PI / 2);
  // its front: three doors in pointed arches, the middle one wider and standing open (its green leaves folded
  // back against the wall), the others shut; after dark the hall's light shows through them
  arch(f, p, 0, P, MQ.front, 1.5, 3.2, true, white(1.05), p.white, null, true);
  for (const side of [-1, 1]) f.box(p.wood, side * 1.12, P + 0.99, MQ.front + 0.05, 0.7, 1.98, 0.05, GREEN, 1);
  for (const side of [-1, 1]) arch(f, p, side * 3.1, P, MQ.front, 1.1, 2.7, true, white(1.05), p.white, GREEN, true);
  // its sides: three arched windows each, green shutters, a recessed panel round each
  for (const side of [-1, 1]) {
    const w = f.p(side * MQ.hw, 0, 0);
    const ef = new Frame(w.x, y0, w.z, m.face + (side * Math.PI) / 2);
    for (const zz of [-2.7, 0, 2.7]) {
      ef.box(p.white, zz - midZ * side, P + 2.35, -0.01, 1.5, 2.9, 0.06, white(0.92), 2);
      arch(ef, p, zz - midZ * side, P + 1.0, 0.03, 0.85, 1.9, true, white(1.05), p.white, rng.next() < 0.5 ? GREEN : null, true);
    }
  }
  // the mihrab's niche standing out of its back wall (toward the qibla), with its own small dome
  const mihrab = new CylinderGeometry(1.0, 1.0, MQ.wall - 0.7, 8, 1, false, Math.PI / 2, Math.PI);
  put(f, p.white, mihrab, 0, P + (MQ.wall - 0.7) / 2, MQ.back, white(0.98));
  put(f, p.white, new SphereGeometry(1.0, 12, 6, Math.PI / 2, Math.PI, 0, Math.PI / 2), 0, P + MQ.wall - 0.7, MQ.back, white(1.03));
  // the domes: a large one over its middle on an arcaded drum, a smaller one either side
  bengalDome(f, p, 0, midZ, top, 2.35, 0.95, white, rng);
  for (const side of [-1, 1]) bengalDome(f, p, side * 3.75, midZ, top, 1.25, 0.45, white, rng);
  // turrets at its four corners
  for (const sx of [-1, 1]) for (const sz of [MQ.back, MQ.front]) turret(f, p, sx * (MQ.hw + 0.05), sz, P, MQ.wall + 1.6, 0.3, white);

  // ---- the verandah before it: an arcade of three pointed arches on piers, a flat roof with its parapet ----
  const vz = (MQ.front + MQ.veranda) / 2;
  const roof = P + MQ.porch;
  const piers = [-MQ.hw, -1.9, 1.9, MQ.hw];
  for (const x of piers) f.box(p.white, x, P + MQ.porch / 2, MQ.veranda - 0.25, 0.62, MQ.porch, 0.55, white(1.02), 3);
  for (let i = 0; i + 1 < piers.length; i++) {
    const x0 = piers[i] + 0.31;
    const x1 = piers[i + 1] - 0.31;
    arcade(f, p.white, x0, x1, P + 2.35, 1.25 + 0.15 * (i === 1 ? 1 : 0), roof, MQ.veranda - 0.25, 0.5, white(1.04));
  }
  // the beam and the roof slab over it, a green band, merlons along its front
  f.box(p.white, 0, roof + 0.2, vz, MQ.hw * 2 + 0.3, 0.4, MQ.veranda - MQ.front + 0.3, white(1.02), 3);
  f.box(p.white, 0, roof + 0.44, MQ.veranda + 0.02, MQ.hw * 2 + 0.34, 0.12, 0.3, GREEN, 3);
  for (let x = -MQ.hw + 0.25; x <= MQ.hw - 0.25; x += 0.55) put(f, p.white, merlon, x, roof + 0.71, MQ.veranda - 0.05, white());
  for (const sx of [-1, 1]) for (let z = MQ.front + 0.4; z < MQ.veranda; z += 0.55) put(f, p.white, merlon, sx * (MQ.hw + 0.05), roof + 0.71, z, white(), Math.PI / 2);
  // a turret on each of its front corners, lower than the hall's
  for (const sx of [-1, 1]) turret(f, p, sx * (MQ.hw + 0.15), MQ.veranda, P, MQ.porch + 1.1, 0.26, white);
  // a lamp hung in its middle arch, and one either side of the door
  p.lamps.push(f.p(0, P + 2.25, vz + 0.6), f.p(-1.05, P + 2.6, MQ.front + 0.12), f.p(1.05, P + 2.6, MQ.front + 0.12));
  // the light: the hall's, spilling out of its open door onto the verandah, and the verandah lamp's, softer
  p.lights.push({ at: f.p(0, P + 2.0, MQ.front - 0.5), reach: 8, strength: 2 }, { at: f.p(0, P + 2.15, vz + 0.6), reach: 6.5, strength: 1.2 });
  // the kalima on the panel over the middle arch
  p.kalima = { at: f.p(0, P + 3.73, MQ.veranda + 0.02), ry: f.ry, w: 3.0, h: 0.42 };

  // ---- the forecourt: a low wall round it, its gate on the axis, steps down to the walk ----
  const cz0 = MQ.veranda;
  const cz1 = MQ.gate;
  for (const side of [-1, 1]) f.box(p.white, side * MQ.cw, P + 0.42, (cz0 + cz1) / 2, 0.24, 0.84, cz1 - cz0, white(0.97), 3);
  for (const side of [-1, 1]) f.box(p.white, side * (MQ.cw / 2 + 0.7), P + 0.42, cz1, MQ.cw - 1.4, 0.84, 0.24, white(0.97), 3);
  // a green coping along it
  for (const side of [-1, 1]) f.box(p.white, side * MQ.cw, P + 0.88, (cz0 + cz1) / 2, 0.3, 0.08, cz1 - cz0, GREEN, 3);
  for (const side of [-1, 1]) {
    // the gate's piers, each with its little domed top and a lamp on it
    f.box(p.white, side * 1.45, P + 0.85, cz1, 0.5, 1.7, 0.5, white(1.02), 3);
    f.box(p.white, side * 1.45, P + 1.74, cz1, 0.6, 0.1, 0.6, GREEN, 3);
    put(f, p.white, new SphereGeometry(0.22, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2), side * 1.45, P + 1.79, cz1, white(1.04));
    p.lamps.push(f.p(side * 1.45, P + 2.1, cz1));
  }
  // the steps down, as wide as the gate, between low cheek walls
  for (let i = 0; i < MQ.steps; i++) {
    const h = P * (1 - i / MQ.steps);
    f.box(p.white, 0, h / 2 - 0.2, cz1 + 0.2 + (i + 0.5) * MQ.tread, 2.6, h + 0.4, MQ.tread + 0.02, white(0.88 + 0.03 * (i % 2)), 3);
  }
  for (const side of [-1, 1]) f.box(p.white, side * 1.45, P / 2 - 0.1, cz1 + 0.2 + (MQ.steps * MQ.tread) / 2, 0.3, P + 0.2, MQ.steps * MQ.tread, white(0.95), 3);

  // ---- the minaret the azan is called from, at the forecourt's corner: a square base with its door, two
  // tapering octagonal stages, each with slit windows and a balcony, and an open kiosk with its little dome ----
  const mx = MQ.cw - 0.4;
  const mz = MQ.gate - 0.6;
  const base = 1.8;
  // (its base stands on the ground: it takes in the forecourt wall's corner and runs past the plinth's edge)
  f.box(p.white, mx, (P + base - 0.25) / 2, mz, 1.5, P + base + 0.25, 1.5, white(0.95), 3);
  f.box(p.white, mx, P + base + 0.06, mz, 1.62, 0.12, 1.62, GREEN, 3);
  arch(faceFrame(f, mx, mz, -Math.PI / 2, 0.75), p, 0, P, 0.012, 0.7, 1.45, true, white(1.05), p.white, GREEN);
  const railPost = new BoxGeometry(0.05, 0.5, 0.05);
  const horn = new CylinderGeometry(0.16, 0.05, 0.38, 8, 1).rotateX(Math.PI / 2 + 0.25);
  let y = P + base + 0.12;
  const stages = [
    { h: 4.2, r0: 0.56, r1: 0.5 },
    { h: 2.8, r0: 0.45, r1: 0.4 },
  ];
  for (const [i, st] of stages.entries()) {
    put(f, p.white, new CylinderGeometry(st.r1, st.r0, st.h, 8, 1), mx, y + st.h / 2, mz, white());
    for (let k = i; k < 8; k += 2) {
      const a = ((k + 0.5) / 8) * Math.PI * 2;
      arch(faceFrame(f, mx, mz, a, ((st.r0 + st.r1) / 2) * Math.cos(Math.PI / 8)), p, 0, y + st.h * 0.45, 0.012, 0.18, 0.75, true, white(1.04), p.white, null);
    }
    y += st.h;
    // the balcony on its corbel: its floor, a railing of posts, a green rail
    const br = st.r1 + 0.36;
    put(f, p.white, new CylinderGeometry(br, st.r1, 0.32, 8, 1), mx, y + 0.16, mz, white(1.02));
    put(f, p.white, new CylinderGeometry(br + 0.04, br + 0.04, 0.08, 16, 1), mx, y + 0.36, mz, white(1.04));
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * Math.PI * 2;
      put(f, p.white, railPost, mx + Math.sin(a) * br, y + 0.65, mz + Math.cos(a) * br, white(1.02));
    }
    put(f, p.white, new TorusGeometry(br, 0.03, 4, 24).rotateX(Math.PI / 2), mx, y + 0.9, mz, GREEN);
    // the loudspeakers under the upper balcony, turned out over the village
    if (i === stages.length - 1) for (const turn of [0, Math.PI / 2]) put(f, p.tin, horn, mx + Math.sin(turn) * (st.r1 + 0.2), y - 0.25, mz + Math.cos(turn) * (st.r1 + 0.2), rgb('#8a8a86'), turn);
    y += 0.4;
  }
  // the kiosk: slender columns, a green band, a little Bengal dome with its finial, a lamp inside
  const kr = 0.34;
  for (let k = 0; k < 8; k++) {
    const a = ((k + 0.5) / 8) * Math.PI * 2;
    put(f, p.white, new CylinderGeometry(0.04, 0.045, 1.05, 6), mx + Math.sin(a) * kr, y + 0.52, mz + Math.cos(a) * kr, white(1.03));
  }
  put(f, p.white, new CylinderGeometry(kr + 0.1, kr + 0.1, 0.14, 8, 1), mx, y + 1.1, mz, GREEN);
  bengalDome(f, p, mx, mz, y + 1.17, 0.42, 0.12, white, rng);
  p.lamps.push(f.p(mx, y + 0.7, mz));
}

/** A frame on the face of a round or many-sided body standing at local (x, z): `r` out toward `a` (radians from +z), facing out. */
function faceFrame(f: Frame, x: number, z: number, a: number, r: number): Frame {
  const at = f.p(x + Math.sin(a) * r, 0, z + Math.cos(a) * r);
  return new Frame(at.x, f.y, at.z, f.ry + a);
}

/**
 * The mosque's ghat (বাঁধানো ঘাট) at its pond, on its axis: a landing on the bank's top with a plastered bench
 * either side, broad brick steps down into the water past its lowest, low walls along them; kept clean, no
 * grass on it.
 */
function mosqueGhat(p: Parts, pond: Pond, axis: { x: number; z: number; face: number }, rng: Rng): void {
  // on the pond's rim where the axis meets it, facing the water (east, toward the pond's middle)
  const ux = Math.sin(axis.face);
  const uz = Math.cos(axis.face);
  let x = axis.x;
  let z = axis.z;
  // (to where its bank's top ends and the slope down to the water begins)
  for (let k = 0; k < 400 && pondReach(pond, x, z) > 1 + 1.15 / Math.max(4, Math.min(pond.hu, pond.hv)); k++) {
    x += ux * 0.25;
    z += uz * 0.25;
  }
  const land = Math.max(terrainHeight(x, z), terrainHeight(x - ux * 1.5, z - uz * 1.5));
  const f = new Frame(x, 0, z, axis.face);
  const W = 3.6;
  // gentler than the bank's slope, so every step stands clear of it
  const rise = 0.17;
  const low = pond.level - 0.45;
  const n = Math.ceil((land - low) / rise);
  const run = 0.4;
  const plaster: RGB = scaleRgb(rgb('#d6cfbe'), 0.9);
  // the landing on the bank's top, and a bench either side of it
  f.box(p.white, 0, land - 0.4, -1.2, W + 2.2, 0.9, 2.6, plaster, 2);
  for (const s of [-1, 1]) {
    f.box(p.white, s * (W / 2 + 0.75), land + 0.25, -1.4, 0.8, 0.5, 2.1, scaleRgb(plaster, 1.03), 2);
    f.box(p.white, s * (W / 2 + 0.75), land + 0.52, -1.4, 0.92, 0.06, 2.2, scaleRgb(plaster, 0.95), 2);
  }
  // the steps, each a solid block down into the bank, wet and greening toward the water
  for (let i = 0; i < n; i++) {
    const y = land - (i + 1) * rise;
    const zc = 0.1 + (i + 0.5) * run;
    const wx = f.p(0, 0, zc);
    const bed = terrainHeight(wx.x, wx.z);
    const depth = y + rise - Math.min(bed, y) + 0.6;
    const wet = smoothstep(pond.level + 0.5, pond.level - 0.2, y);
    f.box(p.brick, 0, y + rise - depth / 2, zc, W, depth, run + 0.02, scaleRgb(mixRgb(rgb('#a8705a'), rgb('#4e5a3a'), wet * 0.6), rng.range(0.9, 1.04)), 1.5);
  }
  // low walls along its sides, stepping down with it
  for (const s of [-1, 1]) {
    for (let i = 0; i < n; i += 2) {
      const y = land - (i + 1) * rise;
      const zc = 0.1 + (i + 1) * run;
      f.box(p.white, s * (W / 2 + 0.15), y + 0.25, zc, 0.3, 1.1, run * 2 + 0.02, scaleRgb(plaster, rng.range(0.92, 1)), 2);
    }
  }
  // a lamp on a short pillar at the head of the steps: after dark its light falls softly on the steps, the bank
  // and the water. A little iron lantern: its base, its corner posts round the glass, its roof and knob
  const lx = W / 2 + 0.15;
  f.box(p.white, lx, land + 0.55, 0, 0.36, 1.2, 0.36, scaleRgb(plaster, 1.02), 2);
  f.box(p.white, lx, land + 1.19, 0, 0.44, 0.08, 0.44, scaleRgb(plaster, 0.95), 2);
  const iron = rgb('#2e2b27');
  const ly = land + 1.23;
  f.box(p.tin, lx, ly + 0.02, 0, 0.22, 0.04, 0.22, iron, 1);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) f.box(p.tin, lx + sx * 0.095, ly + 0.17, sz * 0.095, 0.02, 0.27, 0.02, iron, 1);
  put(f, p.tin, new ConeGeometry(0.17, 0.12, 4).rotateY(Math.PI / 4), lx, ly + 0.36, 0, iron);
  put(f, p.tin, new SphereGeometry(0.025, 6, 4), lx, ly + 0.44, 0, iron);
  p.lanterns.push({ at: f.p(lx, ly + 0.17, 0), ry: f.ry });
  p.lights.push({ at: f.p(lx, ly + 0.17, 0.12), reach: 8, strength: 2 });
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
    lamps: [],
    glow: new MeshBuilder(),
    lights: [],
    lanterns: [],
    kalima: null,
  };
  const zm = MOUNDS.find((m) => m.id === 'zamindar');
  if (zm) {
    const house = zamindarHouse(p, zm, rng);
    grandGhat(p, zm, house.stepsAt, rng);
    temple(p, zm, rng);
  }
  const mm = MOUNDS.find((m) => m.id === 'mosque');
  if (mm) mosque(p, mm, rng);
  const kept = PONDS.find((k) => k.kept);
  if (mm && kept) mosqueGhat(p, kept, mosqueAxis(), rng);
  const gm = MOUNDS.find((m) => m.id === 'graveyard');
  if (gm) graveyard(p, gm, rng);
  teaStall(p, rng);

  const group = new Group();
  group.name = 'landmarks';
  const plaster = plasterTexture(811, { fallen: false });
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
  // the kalima over the mosque's door
  if (p.kalima) {
    const k = p.kalima;
    const panel = new Mesh(new PlaneGeometry(k.w, k.h), patchMaterial(new MeshStandardMaterial({ map: inscriptionTexture(KALIMA), roughness: 0.6 }), {}));
    panel.position.copy(k.at);
    panel.rotation.y = k.ry;
    panel.receiveShadow = true;
    panel.name = 'kalima';
    group.add(panel);
  }
  // the mosque's lamps: bulbs glowing warm after dark
  if (p.lamps.length) {
    const bulbs = new InstancedMesh(new SphereGeometry(0.07, 8, 6), BULB, p.lamps.length);
    p.lamps.forEach((at, i) => bulbs.setMatrixAt(i, new Matrix4().makeTranslation(at.x, at.y, at.z)));
    bulbs.name = 'mosque lamps';
    group.add(bulbs);
  }
  // its doors and windows, lit from within after dark, and the lanterns' glass
  if (p.glow.vertexCount) {
    GLOW.emissiveMap = glowTexture();
    const lit = new Mesh(p.glow.build(), GLOW);
    lit.receiveShadow = true;
    lit.name = 'lit openings';
    group.add(lit);
  }
  for (const l of p.lanterns) {
    const glass = new Mesh(new BoxGeometry(0.17, 0.25, 0.17), GLASS);
    glass.position.copy(l.at);
    glass.rotation.y = l.ry;
    glass.name = 'lantern';
    group.add(glass);
  }
  // where the lamps' light falls from (its colour is set as it darkens: lampsGlow)
  LIGHTS.length = 0;
  p.lights.slice(0, LAMP_SLOTS.length).forEach((l, i) => {
    LAMP_SLOTS[i].at.value.set(l.at.x, l.at.y, l.at.z, l.reach);
    LIGHTS.push(l.strength);
  });
  return group;
}

/** The mosque's bulbs, its lit doors and windows (dark by day: their glow runs along `glowTexture`), the lanterns' glass. */
const BULB = patchMaterial(new MeshStandardMaterial({ color: '#fff2d6', emissive: new Color('#ffc888'), emissiveIntensity: 0, roughness: 0.4 }), {});
const GLOW = patchMaterial(new MeshStandardMaterial({ vertexColors: true, roughness: 0.9, emissive: new Color('#ffffff'), emissiveIntensity: 0 }), {});
const GLASS = patchMaterial(new MeshStandardMaterial({ color: '#e8c89a', emissive: new Color('#ffb366'), emissiveIntensity: 0, roughness: 0.2 }), {});
/** What glows after dark, for the film's dissolves to keep each shot's own (main.ts worldLook). */
export const NIGHT_GLOWS: readonly MeshStandardMaterial[] = [BULB, GLOW, GLASS];

/** The lamps' light (globals.ts uLamp0..2): where each is is set at build; its colour, a warm white, as it darkens. */
const LAMP_SLOTS = [
  { at: G.uLamp0, color: G.uLampColor0 },
  { at: G.uLamp1, color: G.uLampColor1 },
  { at: G.uLamp2, color: G.uLampColor2 },
];
const LIGHTS: number[] = [];
const LAMP_LIGHT = new Color('#ffcb95');

/** The mosque's and its ghat's lamps lit as it darkens (`night` 0..1): a soft, warm glow, never harsh. */
export function lampsGlow(night: number): void {
  const on = smoothstep(0.15, 0.7, night);
  BULB.emissiveIntensity = 2.5 * on;
  GLOW.emissiveIntensity = 0.85 * on;
  GLASS.emissiveIntensity = 1.3 * on;
  LIGHTS.forEach((s, i) => LAMP_SLOTS[i].color.value.copy(LAMP_LIGHT).multiplyScalar(s * on));
}
