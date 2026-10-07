import { Vector3 } from 'three';
import { Rng } from '../core/rng';
import { MeshBuilder, mixRgb, rgb, scaleRgb, slab, type RGB } from '../render/builder';

// The village's houses as they are built: a house stands on its plinth (পোতা) of rammed earth plastered smooth
// with mud, raised out of the rains' floods, its front run out as an open veranda (দাওয়া) under the roof. Its
// walls are mud, washed in earth colours with a darker band where the floor's mud is wiped up them, or
// corrugated tin painted on a timber frame; a wooden door of two leaves in a frame, small windows with bars
// and shutters. The roof is the Bengal do-chala: two slopes whose ridge and eaves sag toward the ends, deep
// golden thatch with a thick, trimmed edge, or corrugated tin with a ridge cap; it runs out over the veranda
// on posts with a beam along their heads, and the gables under it are mud or a woven bamboo mat. The kitchen
// is a little thatched hut with its mud stove (চুলা); the cowshed (গোয়াল) is open on posts with a mat wall at
// its back and a manger.
// Everything is built straight into the village's builders, in world coordinates, through a house's frame.

/** What a house is made of and how it looks; a homestead's plan decides it (world/village.ts). */
export interface HouseStyle {
  kind: 'house' | 'kitchen' | 'shed';
  walls: 'mud' | 'tin';
  roof: 'thatch' | 'tin';
  /** The walls' wash (mud) or paint (tin). */
  wall: RGB;
  /** The door's and the shutters' paint. */
  paint: RGB;
  /** The veranda's depth (m; 0 for none). */
  veranda: number;
}

/** The builders a house is laid into, one per material (world/village.ts draws each in one call). */
export interface HouseParts {
  /** Mud and plaster: plinths, mud walls, gables, the stove. */
  mud: MeshBuilder;
  /** Wood: posts, beams, doors and frames, shutters, the manger. */
  wood: MeshBuilder;
  thatch: MeshBuilder;
  /** Corrugated tin: roofs and walls, tinted by their paint. */
  tin: MeshBuilder;
  /** Woven bamboo mat: gables, the cowshed's wall. */
  mat: MeshBuilder;
}

/** A house's frame: its centre on the ground, its yaw (its door looks along local +z). */
export class Frame {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly ry: number;
  private readonly c: number;
  private readonly s: number;

  constructor(x: number, y: number, z: number, ry: number) {
    this.x = x;
    this.y = y;
    this.z = z;
    this.ry = ry;
    this.c = Math.cos(ry);
    this.s = Math.sin(ry);
  }

  p(x: number, y: number, z: number): Vector3 {
    return new Vector3(this.x + x * this.c + z * this.s, this.y + y, this.z - x * this.s + z * this.c);
  }

  n(x: number, y: number, z: number): Vector3 {
    return new Vector3(x * this.c + z * this.s, y, -x * this.s + z * this.c).normalize();
  }

  /** A box in the frame (centre, size), turned `turn` more about y; faces carry metre UVs over `tile`. */
  box(b: MeshBuilder, x: number, y: number, z: number, sx: number, sy: number, sz: number, c: RGB, tile = 2, turn = 0): void {
    const w = this.p(x, y, z);
    slab(b, w.x, w.y, w.z, sx, sy, sz, this.ry + turn, c, tile);
  }
}

const MUD_PLINTH: RGB = rgb('#6e5236');
const MUD_BAND: RGB = rgb('#5a4130');
const TIMBER: RGB = rgb('#5b4632');
const DARK: RGB = rgb('#1c140e');
const CEMENT: RGB = rgb('#8c877c');

/** Two leaves of a wooden door in its frame, on a wall's face at z (local), `width` wide, `height` high, from y0. */
function door(f: Frame, wood: MeshBuilder, x: number, y0: number, z: number, width: number, height: number, paint: RGB, rng: Rng): void {
  // the dark of the doorway behind the leaves, the frame proud of the wall
  f.box(wood, x, y0 + height / 2, z + 0.01, width + 0.04, height, 0.03, DARK, 1);
  for (const side of [-1, 1]) f.box(wood, x + side * (width / 2 + 0.05), y0 + height / 2 + 0.05, z + 0.04, 0.1, height + 0.1, 0.07, TIMBER, 1);
  f.box(wood, x, y0 + height + 0.06, z + 0.04, width + 0.2, 0.12, 0.08, TIMBER, 1);
  // the leaves, one standing a hand open
  const open = rng.next() < 0.5 ? rng.range(0.2, 0.7) : 0;
  const leaf = width / 2 - 0.02;
  for (const side of [-1, 1]) {
    const turn = side < 0 ? 0 : -open;
    const hinge = x + side * width / 2;
    const cx = hinge - side * Math.cos(turn) * leaf / 2;
    const cz = z + 0.035 + (side > 0 ? Math.sin(open) * leaf / 2 : 0);
    f.box(wood, cx, y0 + height / 2, cz, leaf, height - 0.04, 0.04, scaleRgb(paint, rng.range(0.9, 1.05)), 1, turn);
    // a rail across each leaf, a little darker
    f.box(wood, cx, y0 + height * 0.55, cz + 0.02 * Math.cos(turn), leaf * 0.9, 0.08, 0.02, scaleRgb(paint, 0.75), 1, turn);
  }
}

/** A small window: its frame, the dark behind three iron bars, two shutters standing open. */
function window_(f: Frame, wood: MeshBuilder, x: number, y: number, z: number, paint: RGB, rng: Rng): void {
  const w = 0.62;
  const h = 0.62;
  f.box(wood, x, y, z + 0.01, w, h, 0.03, DARK, 1);
  for (const k of [-1, 0, 1]) f.box(wood, x + k * 0.16, y, z + 0.03, 0.025, h - 0.04, 0.025, rgb('#2a2622'), 1);
  for (const side of [-1, 1]) f.box(wood, x + side * (w / 2 + 0.04), y, z + 0.04, 0.07, h + 0.1, 0.06, TIMBER, 1);
  for (const side of [-1, 1]) f.box(wood, x, y + side * (h / 2 + 0.04), z + 0.04, w + 0.14, 0.07, 0.06, TIMBER, 1);
  // shutters folded back against the wall (or one of them half open)
  for (const side of [-1, 1]) {
    const turn = side * (rng.next() < 0.3 ? 0.9 : 1.45);
    const hinge = x + side * (w / 2 + 0.06);
    f.box(wood, hinge + side * Math.cos(turn) * 0.16, y, z + 0.07 + Math.sin(Math.abs(turn)) * 0.16, 0.32, h, 0.03, paint, 1, -turn);
  }
}

/**
 * A do-chala roof over [x0, x1] × [zBack, zFront] (local): two slopes from the ridge at `zRidge`, height
 * `ridge`, to their eaves at `eaveFront`/`eaveBack`; the ridge and eaves sag `droop` toward the ends (the
 * Bengal curve). Thatch gets a thick trimmed edge; tin a ridge cap. u along the ridge and v down the slope, in
 * metres over `tile`.
 */
function doChala(
  f: Frame,
  b: MeshBuilder,
  x0: number,
  x1: number,
  zBack: number,
  zFront: number,
  zRidge: number,
  ridge: number,
  eaveBack: number,
  eaveFront: number,
  droop: number,
  thick: number,
  tile: number,
  color: RGB,
): void {
  const A = 16;
  const S = 7;
  const sag = (a: number, t: number) => droop * (2 * a - 1) ** 2 * (0.45 + 0.55 * t);
  for (const [zEave, yEave, sign] of [
    [zFront, eaveFront, 1],
    [zBack, eaveBack, -1],
  ] as const) {
    const run = Math.abs(zEave - zRidge);
    const rise = ridge - yEave;
    const n = f.n(0, run, sign * rise);
    const start = b.vertexCount;
    for (let i = 0; i <= A; i++) {
      const a = i / A;
      const x = x0 + (x1 - x0) * a;
      for (let j = 0; j <= S; j++) {
        const t = j / S;
        // a slight belly in the slope, as thatch over bamboo rafters takes
        const y = ridge - rise * t - sag(a, t) - 0.08 * t * (1 - t);
        b.vertex(f.p(x, y, zRidge + (zEave - zRidge) * t), n, x / tile, (t * Math.hypot(run, rise)) / tile, color);
      }
    }
    for (let i = 0; i < A; i++) {
      for (let j = 0; j < S; j++) {
        const p0 = start + i * (S + 1) + j;
        const p1 = p0 + S + 1;
        if (sign > 0) b.quad(p0, p0 + 1, p1 + 1, p1);
        else b.quad(p0, p1, p1 + 1, p0 + 1);
      }
    }
    // the eave's edge: thick and trimmed square on thatch, a thin turned-down lip on tin
    const lip = b.vertexCount;
    const down = f.n(0, 0, sign);
    for (let i = 0; i <= A; i++) {
      const a = i / A;
      const x = x0 + (x1 - x0) * a;
      const y = yEave - sag(a, 1);
      b.vertex(f.p(x, y, zEave), down, x / tile, 0, color);
      b.vertex(f.p(x, y - thick, zEave - sign * thick * 0.4), down, x / tile, thick / tile, scaleRgb(color, 0.8));
    }
    for (let i = 0; i < A; i++) {
      if (sign > 0) b.quad(lip + i * 2, lip + i * 2 + 1, lip + i * 2 + 3, lip + i * 2 + 2);
      else b.quad(lip + i * 2, lip + i * 2 + 2, lip + i * 2 + 3, lip + i * 2 + 1);
    }
  }
  // the verges: the roof's thickness shown along its sloping ends
  for (const [x, a] of [
    [x0, 0],
    [x1, 1],
  ] as const) {
    const out = f.n(x === x0 ? -1 : 1, 0, 0);
    const v = b.vertexCount;
    for (const [zEave, yEave] of [
      [zBack, eaveBack],
      [zFront, eaveFront],
    ] as const) {
      for (const t of [1, 0]) {
        const z = zRidge + (zEave - zRidge) * t;
        const y = ridge - (ridge - yEave) * t - sag(a, t) - 0.08 * t * (1 - t);
        b.vertex(f.p(x, y, z), out, z / tile, 0, color);
        b.vertex(f.p(x, y - thick, z), out, z / tile, thick / tile, scaleRgb(color, 0.75));
      }
    }
    // back eave → ridge, ridge → front eave
    const q = (i: number) => v + i * 2;
    for (const [i, k] of [
      [0, 1],
      [2, 3],
    ]) {
      if (x === x0) b.quad(q(i), q(i) + 1, q(k) + 1, q(k));
      else b.quad(q(i), q(k), q(k) + 1, q(i) + 1);
    }
  }
}

/** The ridge's height for a roof over a span from `zBack` to `zFront` at a pitch (rise over run). */
function ridgeFor(zBack: number, zFront: number, eave: number, pitch: number): number {
  return eave + ((zFront - zBack) / 2) * pitch;
}

/** A gable under a roof's end at `x`: from the wall's top across [zBack, zFront] up to the roof's underside. */
function gable(f: Frame, b: MeshBuilder, x: number, zBack: number, zFront: number, top: number, zRidge: number, ridge: number, eaveBack: number, eaveFront: number, color: RGB, tile: number): void {
  const out = f.n(x > 0 ? 1 : -1, 0, 0);
  const under = (z: number) => (z < zRidge ? ridge - ((ridge - eaveBack) * (zRidge - z)) / (zRidge - (zBack - 0.0001)) : ridge - ((ridge - eaveFront) * (z - zRidge)) / Math.max(0.01, zFront - zRidge)) - 0.12;
  const c = b.vertexCount;
  b.vertex(f.p(x, top, zBack), out, zBack / tile, top / tile, color);
  b.vertex(f.p(x, top, zFront), out, zFront / tile, top / tile, color);
  b.vertex(f.p(x, under(zFront), zFront), out, zFront / tile, under(zFront) / tile, color);
  b.vertex(f.p(x, ridge - 0.12, zRidge), out, zRidge / tile, ridge / tile, color);
  b.vertex(f.p(x, under(zBack), zBack), out, zBack / tile, under(zBack) / tile, color);
  if (x > 0) {
    b.quad(c, c + 4, c + 3, c + 2);
    b.tri(c, c + 2, c + 1);
  } else {
    b.quad(c, c + 2, c + 3, c + 4);
    b.tri(c, c + 1, c + 2);
  }
}

/**
 * A house: its plinth with the veranda run out in front, its room's walls, door and windows, the veranda's
 * posts and beam, the do-chala roof over room and veranda, the gables. (x, y, z) is the plinth's foot in the
 * room's middle; the door looks along +z after turning by `ry`. `l` along the front, `w` the room's depth.
 */
export function buildHouse(parts: HouseParts, x: number, y: number, z: number, ry: number, l: number, w: number, style: HouseStyle, rng: Rng): void {
  const f = new Frame(x, y, z, ry);
  const small = style.kind !== 'house';
  const plinth = style.kind === 'shed' ? 0.25 : small ? 0.4 : rng.range(0.5, 0.65);
  const wallH = style.kind === 'shed' ? 1.9 : small ? rng.range(1.8, 2.0) : rng.range(2.15, 2.4);
  const ver = style.veranda;
  const front = w / 2;
  const back = -w / 2;
  const over = style.roof === 'thatch' ? 0.75 : 0.5;
  const top = plinth + wallH;
  // the plinth: rammed earth under a mud house, a cement skin under a tin one; the veranda's part in front
  const plinthColor = style.walls === 'tin' ? CEMENT : scaleRgb(MUD_PLINTH, rng.range(0.92, 1.08));
  f.box(parts.mud, 0, plinth / 2 - 0.1, ver / 2, l + 0.7, plinth + 0.2, w + ver + 0.6, plinthColor, 1.6);
  if (ver > 0 || style.kind === 'house') f.box(parts.mud, rng.range(-l * 0.15, l * 0.15), plinth / 4 - 0.05, front + ver + 0.55, 1.3, plinth / 2 + 0.1, 0.5, scaleRgb(plinthColor, 0.95), 1.6);

  // the walls (the cowshed has only its back, a woven mat)
  const wallColor = scaleRgb(style.wall, rng.range(0.93, 1.06));
  if (style.kind === 'shed') {
    f.box(parts.mat, 0, plinth + wallH * 0.45, back + 0.05, l, wallH * 0.9, 0.06, rgb('#c8b892'), 1.2);
  } else {
    const t = style.walls === 'tin' ? 0.08 : 0.3;
    const b = style.walls === 'tin' ? parts.tin : parts.mud;
    const tile = style.walls === 'tin' ? 2.4 : 2;
    f.box(b, 0, plinth + wallH / 2, back + t / 2, l, wallH, t, wallColor, tile);
    f.box(b, 0, plinth + wallH / 2, front - t / 2, l, wallH, t, wallColor, tile);
    for (const side of [-1, 1]) f.box(b, side * (l / 2 - t / 2), plinth + wallH / 2, 0, t, wallH, w - 2 * t, wallColor, tile);
    if (style.walls === 'mud') {
      // the darker band where the floor's mud is wiped up the walls
      const band = 0.38;
      f.box(parts.mud, 0, plinth + band / 2, front + 0.005, l + 0.02, band, 0.02, MUD_BAND, 2);
      f.box(parts.mud, 0, plinth + band / 2, back - 0.005, l + 0.02, band, 0.02, MUD_BAND, 2);
      for (const side of [-1, 1]) f.box(parts.mud, side * (l / 2 + 0.005), plinth + band / 2, 0, 0.02, band, w, MUD_BAND, 2);
    } else {
      // a tin house's timber frame shows at its corners and along its sill
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) f.box(parts.wood, sx * (l / 2 - 0.02), plinth + wallH / 2, sz * (w / 2 - 0.02), 0.1, wallH, 0.1, TIMBER, 1);
      f.box(parts.wood, 0, plinth + 0.06, front + 0.01, l, 0.12, 0.06, TIMBER, 1);
    }
    // the door and the windows on the front
    const doorX = small ? 0 : rng.range(-l * 0.18, l * 0.18);
    door(f, parts.wood, doorX, plinth, front, small ? 0.8 : 0.95, small ? 1.6 : 1.85, style.paint, rng);
    if (style.kind === 'house') {
      for (const wx of [doorX - 1.7, doorX + 1.7]) if (Math.abs(wx) < l / 2 - 0.7) window_(f, parts.wood, wx, plinth + 1.35, front, style.paint, rng);
      // and one on each end
      for (const side of [-1, 1]) {
        const wf = new Frame(x + side * (l / 2) * Math.cos(ry), y, z - side * (l / 2) * Math.sin(ry), ry + (side * Math.PI) / 2);
        if (rng.next() < 0.6) window_(wf, parts.wood, 0, plinth + 1.35, 0, style.paint, rng);
      }
    }
  }
  if (style.kind === 'kitchen') {
    // the mud stove (চুলা) by the door, its mouth blackened, a pot on it
    f.box(parts.mud, l * 0.28, plinth + 0.18, front + 0.45, 0.7, 0.36, 0.55, rgb('#5c4632'), 1);
    f.box(parts.mud, l * 0.28, plinth + 0.2, front + 0.73, 0.28, 0.18, 0.02, DARK, 1);
  }
  if (style.kind === 'shed') {
    // the manger along the back
    f.box(parts.wood, 0, plinth + 0.35, back + 0.55, l * 0.8, 0.3, 0.5, rgb('#4a3a2a'), 1);
  }

  // the roof: over the room and the veranda, its ridge over the middle of the whole, on posts in front
  const zBack = back - over;
  const zFront = front + ver + over;
  const eave = ver > 0 ? top - 0.25 : top + 0.1;
  const pitch = style.roof === 'thatch' ? rng.range(0.85, 1.0) : rng.range(0.42, 0.55);
  const zRidge = (zBack + zFront) / 2;
  const ridge = ridgeFor(zBack, zFront, eave, pitch);
  // the slopes' eaves are where the roof line, run through the walls' top at their faces, reaches the overhang
  const slopeBack = (ridge - eave) / (zRidge - zBack);
  const slopeFront = (ridge - eave) / (zFront - zRidge);
  const droop = style.roof === 'thatch' ? rng.range(0.28, 0.42) : 0.05;
  const xOver = style.roof === 'thatch' ? 0.65 : 0.4;
  const roofColor = style.roof === 'thatch' ? scaleRgb([1, 1, 1], rng.range(0.82, 1.05)) : mixRgb([1, 1, 1], style.kind === 'house' && rng.next() < 0.18 ? style.paint : [1, 1, 1], 0.5);
  doChala(f, style.roof === 'thatch' ? parts.thatch : parts.tin, -l / 2 - xOver, l / 2 + xOver, zBack, zFront, zRidge, ridge, eave, eave, droop, style.roof === 'thatch' ? 0.28 : 0.04, style.roof === 'thatch' ? 1.6 : 2.4, roofColor);
  // the ridge cap on tin
  if (style.roof === 'tin') f.box(parts.tin, 0, ridge + 0.03, zRidge, l + 2 * xOver, 0.06, 0.32, scaleRgb(roofColor, 0.85), 2.4);
  // the veranda's posts, standing on stones, and the beam along their heads
  if (ver > 0) {
    const n = l > 7 ? 4 : 3;
    const zp = front + ver - 0.18;
    const headY = eave - 0.05;
    for (let i = 0; i < n; i++) {
      const px = -l / 2 + 0.25 + ((l - 0.5) * i) / (n - 1);
      f.box(parts.wood, px, plinth + (headY - plinth) / 2, zp, 0.13, headY - plinth, 0.13, scaleRgb(TIMBER, rng.range(0.85, 1.1)), 1);
      f.box(parts.mud, px, plinth + 0.06, zp, 0.24, 0.12, 0.24, rgb('#7d7468'), 1);
    }
    f.box(parts.wood, 0, headY + 0.06, zp, l, 0.14, 0.14, TIMBER, 1);
  }
  if (style.kind === 'shed') {
    // the cowshed stands on posts at its corners and along its front
    for (const sx of [-1, 0, 1]) for (const sz of [-1, 1]) f.box(parts.wood, sx * (l / 2 - 0.1), plinth + (eave - plinth) / 2, sz * (w / 2 - 0.1), 0.12, eave - plinth, 0.12, TIMBER, 1);
  }
  // the gables over the room's ends: mud on a mud house, a woven mat under thatch, tin on a tin house
  if (style.kind !== 'shed') {
    const gb = style.walls === 'tin' ? parts.tin : style.roof === 'thatch' ? parts.mat : parts.mud;
    const gc = style.walls === 'tin' ? wallColor : style.roof === 'thatch' ? rgb('#c8b892') : wallColor;
    for (const side of [-1, 1]) {
      const gx = side * (l / 2 + 0.005);
      const under = (zz: number) => (zz < zRidge ? ridge - slopeBack * (zRidge - zz) : ridge - slopeFront * (zz - zRidge));
      gable(f, gb, gx, back, front, top, zRidge, ridge, under(back), under(front), gc, style.walls === 'tin' ? 2.4 : 2);
    }
  }
}

/** A haystack (খড়ের পালা): straw built up round a pole into a rounded cone, the pole's tip standing out of it. */
export function haystack(straw: MeshBuilder, wood: MeshBuilder, x: number, y: number, z: number, rng: Rng): void {
  const r = rng.range(1.4, 2.0);
  const h = rng.range(3.0, 3.8);
  const N = 14;
  const rows = [
    [0, r * 0.92],
    [0.12, r * 1.04],
    [0.32, r * 1.08],
    [0.55, r * 0.96],
    [0.75, r * 0.72],
    [0.9, r * 0.38],
    [1.0, 0.04],
  ] as const;
  const start = straw.vertexCount;
  rows.forEach(([t, rr], j) => {
    for (let i = 0; i <= N; i++) {
      const a = (i / N) * Math.PI * 2;
      const wob = 1 + 0.05 * Math.sin(a * 3 + x) + 0.04 * Math.sin(a * 5 + z);
      const p = new Vector3(x + Math.cos(a) * rr * wob, y + t * h, z + Math.sin(a) * rr * wob);
      const n = new Vector3(Math.cos(a), 0.6 - t * 0.2 + (j > 4 ? 0.6 : 0), Math.sin(a)).normalize();
      straw.vertex(p, n, (i / N) * 6, t * 3, scaleRgb([1, 1, 1], 0.9 + 0.1 * Math.sin(a * 2)));
    }
  });
  for (let j = 0; j < rows.length - 1; j++) {
    for (let i = 0; i < N; i++) {
      const a = start + j * (N + 1) + i;
      const b = a + N + 1;
      straw.quad(a, b, b + 1, a + 1);
    }
  }
  // the pole's tip, with a pot upturned on it against the rain
  slab(wood, x, y + h + 0.35, z, 0.08, 0.8, 0.08, 0, rgb('#6a5a3e'), 1);
  slab(wood, x, y + h + 0.78, z, 0.22, 0.16, 0.22, 0, rgb('#7a4a30'), 1);
}
