import { CylinderGeometry, Group, Matrix4, Mesh, MeshStandardMaterial, Vector2, Vector3, type BufferGeometry } from 'three';
import { smoothstep } from '../core/mathx';
import { SegmentIndex } from '../core/segmentIndex';
import { MeshBuilder, rgb, scaleRgb, type RGB } from '../render/builder';
import { patchMaterial } from '../render/patch';
import { trackTexture } from '../render/textures';
import type { TrainSound } from '../audio/soundscape';
import { BIL_SPEC, PLAIN, RAILWAY, RAILWAY_POINTS, type Pt } from './plan';

// The railway on the far side of the village from the river: a single line on its embankment across the
// fields north of the bil, and now and then the intercity train along it in Bangladesh Railway's green with
// its red and white bands, a cab car leading six coaches (after the user's own train in their history
// project), small and quiet in the distance: a part of the land the boat passes, never the subject.

/** Spacing of the line's points (m). */
const STEP = 4;
/** The rails' top above the embankment's crest (ballast and sleepers), and the gauge (broad, 1.676 m). */
const RAIL_TOP = 0.42;
const GAUGE = 1.676;

/** The line: a smooth curve through the design's points, every STEP m. */
const LINE = (() => {
  const P = RAILWAY_POINTS;
  const dense: Pt[] = [];
  const p = (i: number) => P[Math.max(0, Math.min(P.length - 1, i))];
  for (let i = 0; i < P.length - 1; i++) {
    for (let k = 0; k < 40; k++) {
      const t = k / 40;
      const f = (a: number, b: number, c: number, d: number) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t * t + (-a + 3 * b - 3 * c + d) * t * t * t);
      dense.push([f(p(i - 1)[0], p(i)[0], p(i + 1)[0], p(i + 2)[0]), f(p(i - 1)[1], p(i)[1], p(i + 1)[1], p(i + 2)[1])]);
    }
  }
  dense.push(P[P.length - 1]);
  const out: number[] = [dense[0][0], dense[0][1]];
  let carry = 0;
  for (let k = 0; k + 1 < dense.length; k++) {
    const [ax, az] = dense[k];
    const [bx, bz] = dense[k + 1];
    const len = Math.hypot(bx - ax, bz - az);
    let at = STEP - carry;
    while (at <= len) {
      out.push(ax + ((bx - ax) * at) / len, az + ((bz - az) * at) / len);
      at += STEP;
    }
    carry = len - (at - STEP);
  }
  return Float64Array.from(out);
})();
const COUNT = LINE.length / 2;
/** The line's length (m). */
export const RAIL_LENGTH = (COUNT - 1) * STEP;
/** The crest of the embankment: the rails' bed (m). */
const CREST = PLAIN + RAILWAY.raise;

/** A point of the line `s` m along it (from its east end), and its heading. */
export function railAt(s: number): { x: number; z: number; heading: number } {
  const f = Math.min(COUNT - 1.0001, Math.max(0, s / STEP));
  const i = Math.floor(f);
  const t = f - i;
  const ax = LINE[i * 2];
  const az = LINE[i * 2 + 1];
  const bx = LINE[i * 2 + 2];
  const bz = LINE[i * 2 + 3];
  return { x: ax + (bx - ax) * t, z: az + (bz - az) * t, heading: Math.atan2(bx - ax, bz - az) };
}

/** The line's point nearest (x, z), of its points 4 m apart: how far it is (m) and how far along the line (m). The result is reused. */
const nearestOut = { distance: 0, s: 0 };
export function railNearest(x: number, z: number): { distance: number; s: number } {
  let best = Infinity;
  let at = 0;
  for (let i = 0; i < COUNT; i++) {
    const d = (LINE[i * 2] - x) ** 2 + (LINE[i * 2 + 1] - z) ** 2;
    if (d < best) (best = d), (at = i);
  }
  nearestOut.distance = Math.sqrt(best);
  nearestOut.s = at * STEP;
  return nearestOut;
}

const INDEX = new SegmentIndex(48);
for (let i = 0; i < COUNT - 1; i++) INDEX.add(LINE[i * 2], LINE[i * 2 + 1], LINE[i * 2 + 2], LINE[i * 2 + 3], 0, RAILWAY.top / 2 + (RAILWAY.raise + 1) / RAILWAY.slope + 2);

/** The ground the embankment leaves at (x, z): its crest across its top, its sides falling to the land. */
export function railGround(x: number, z: number, ground: number): number {
  const hit = INDEX.nearest(x, z);
  if (!hit) return ground;
  const out = hit.d - RAILWAY.top / 2;
  return Math.max(ground, out <= 0 ? CREST : CREST - out * RAILWAY.slope);
}

/** How much of (x, z) is the embankment (0..1): grass on its sides, not field. */
export function railShare(x: number, z: number): number {
  const hit = INDEX.nearest(x, z);
  if (!hit) return 0;
  return 1 - smoothstep(RAILWAY.top / 2 + RAILWAY.raise / RAILWAY.slope, RAILWAY.top / 2 + RAILWAY.raise / RAILWAY.slope + 3, hit.d);
}

// ---------- the track ----------

/** The ballast's bed and its rails along the whole line, one mesh each. */
function track(): { bed: BufferGeometry; rails: BufferGeometry } {
  const bed = new MeshBuilder();
  const rails = new MeshBuilder();
  const up = new Vector3(0, 1, 0);
  const grey: RGB = [1, 1, 1];
  // the bed: a flat top over the sleepers with the ballast's shoulders sloping down either side
  const across = [-2.6, -1.6, 1.6, 2.6];
  const height = [-0.45, 0.28, 0.28, -0.45];
  let v = 0;
  const start = bed.vertexCount;
  for (let i = 0; i < COUNT; i++) {
    const x = LINE[i * 2];
    const z = LINE[i * 2 + 1];
    const p = railAt(i * STEP);
    const nx = Math.cos(p.heading);
    const nz = -Math.sin(p.heading);
    if (i > 0) v += STEP;
    across.forEach((a, k) => {
      const shoulder = k === 0 || k === 3;
      bed.vertex(new Vector3(x + nx * a, CREST + height[k], z + nz * a), up, shoulder ? (k === 0 ? 0 : 1) : (a + 1.6) / 3.2, v / 1.4, shoulder ? scaleRgb(grey, 0.8) : grey);
    });
  }
  for (let i = 0; i < COUNT - 1; i++) {
    for (let k = 0; k < 3; k++) {
      const a = start + i * 4 + k;
      bed.quad(a, a + 4, a + 5, a + 1);
    }
  }
  // the rails: a head and a web, each side, in pieces along the line
  const steel: RGB = rgb('#6b625a');
  for (let i = 0; i < COUNT - 1; i++) {
    const p = railAt(i * STEP);
    const q = railAt((i + 1) * STEP);
    for (const side of [-1, 1]) {
      const o = (side * GAUGE) / 2;
      const ax = p.x + Math.cos(p.heading) * o;
      const az = p.z - Math.sin(p.heading) * o;
      const bx = q.x + Math.cos(q.heading) * o;
      const bz = q.z - Math.sin(q.heading) * o;
      const s = rails.vertexCount;
      const n = new Vector3(Math.cos(p.heading) * side, 0.4, -Math.sin(p.heading) * side).normalize();
      rails.vertex(new Vector3(ax, CREST + RAIL_TOP - 0.16, az), n, 0, 0, steel);
      rails.vertex(new Vector3(bx, CREST + RAIL_TOP - 0.16, bz), n, 1, 0, steel);
      rails.vertex(new Vector3(bx, CREST + RAIL_TOP, bz), up, 1, 1, rgb('#a8a49c'));
      rails.vertex(new Vector3(ax, CREST + RAIL_TOP, az), up, 0, 1, rgb('#a8a49c'));
      if (side > 0) rails.quad(s, s + 1, s + 2, s + 3);
      else rails.quad(s, s + 3, s + 2, s + 1);
    }
  }
  return { bed: bed.build(), rails: rails.build() };
}

// ---------- the train ----------

/** Bangladesh Railway's livery: green, with red and white bands; a pale roof; the dark of the frames. */
const LIVERY = { green: rgb('#2e6a3c'), red: rgb('#b23a2e'), white: rgb('#e6e2d6'), roof: rgb('#a7a49b'), dark: rgb('#2a2a26'), glass: rgb('#22302e') };
/** A car's length, the gap between cars, the cab's nose (m), and how many coaches follow the cab. */
const CAR = 20;
const GAP = 0.8;
const NOSE = 2.4;
const COACHES = 6;
/** Its wheels' radius (m, 0.92 m across) and how far each bogie's middle is from its car's (m). */
const WHEEL_R = 0.46;
const BOGIE_AT = CAR / 2 - 3.2;
/**
 * How it rocks on its springs as it runs (each car out of step with the next): its roll (rad) and bounce (m), and
 * how often (Hz).
 */
const SWAY = { roll: 0.008, rollHz: 0.85, bounce: 0.012, bounceHz: 1.3 };
/** Running speed (m/s, ≈ 60 km/h), and how often a train comes by (s); one comes each way in turn. */
export const TRAIN_SPEED = 16.5;
const SPEED = TRAIN_SPEED;
const EVERY = 300;
/** The rails' length (m): every wheel strikes each joint between them, the train's clatter (Bangladesh Railway's 13 m rails). */
const JOINT = 13;
/** Where along a car its wheelsets are, from its middle (m): two bogies, two axles each, as the bogies are drawn. */
const AXLES = [-7.8, -5.8, 5.8, 7.8];
/** Its engine's height over the rails (m), under the cab car's floor. */
const ENGINE_UP = 1.2;
/**
 * The whistle boards the driver sounds the horn at (m along the line), whichever way the train runs: every
 * `WHISTLE_EVERY` m along the line, as Bangladesh's drivers sound it before the crossings and halts of a country line
 * (the user missed it, 2026-10-08: once a run it was seldom heard), and 450 m short of the stretch nearest the
 * village (by the bil) coming either way.
 */
const WHISTLE_EVERY = 900;
/** How far ahead of the listener's place on the line the driver sounds the horn as he comes on toward it, and the least run between two soundings (m). */
const APPROACH = 350;
const HORN_APART = 150;
const WHISTLES = (() => {
  let near = 0;
  let best = Infinity;
  for (let s = 0; s <= RAIL_LENGTH; s += 10) {
    const p = railAt(s);
    const d = Math.hypot(p.x - BIL_SPEC.x, p.z - BIL_SPEC.z);
    if (d < best) (best = d), (near = s);
  }
  const boards: number[] = [];
  for (let s = WHISTLE_EVERY / 2; s < RAIL_LENGTH; s += WHISTLE_EVERY) boards.push(s);
  return { forward: [...boards, near - 450], back: [...boards, near + 450] };
})();

/** A car's cross-section (across, up): skirt, sides with a little tumblehome, a chamfered roof. */
const SECTION = [
  new Vector2(-1.35, 0.95),
  new Vector2(1.35, 0.95),
  new Vector2(1.42, 1.3),
  new Vector2(1.42, 3.35),
  new Vector2(1.15, 4),
  new Vector2(-1.15, 4),
  new Vector2(-1.42, 3.35),
  new Vector2(-1.42, 1.3),
];
const EDGE_COLORS = [LIVERY.dark, LIVERY.dark, LIVERY.green, LIVERY.roof, LIVERY.roof, LIVERY.roof, LIVERY.green, LIVERY.dark];

/** A car built along +z (its forward), centred on z = 0: its body lofted from the section, bands, doors, bogies; and its windows apart (they light at night). */
function car(cab: boolean): { body: BufferGeometry; windows: BufferGeometry; lamps: BufferGeometry | null } {
  const b = new MeshBuilder();
  const w = new MeshBuilder();
  const l = new MeshBuilder();
  const box = (bb: MeshBuilder, x: number, y: number, z: number, sx: number, sy: number, sz: number, c: RGB) => {
    const hx = sx / 2;
    const hy = sy / 2;
    const hz = sz / 2;
    const faces: [Vector3, [number, number, number][]][] = [
      [new Vector3(1, 0, 0), [[hx, -hy, hz], [hx, -hy, -hz], [hx, hy, -hz], [hx, hy, hz]]],
      [new Vector3(-1, 0, 0), [[-hx, -hy, -hz], [-hx, -hy, hz], [-hx, hy, hz], [-hx, hy, -hz]]],
      [new Vector3(0, 1, 0), [[-hx, hy, hz], [hx, hy, hz], [hx, hy, -hz], [-hx, hy, -hz]]],
      [new Vector3(0, -1, 0), [[-hx, -hy, -hz], [hx, -hy, -hz], [hx, -hy, hz], [-hx, -hy, hz]]],
      [new Vector3(0, 0, 1), [[-hx, -hy, hz], [hx, -hy, hz], [hx, hy, hz], [-hx, hy, hz]]],
      [new Vector3(0, 0, -1), [[hx, -hy, -hz], [-hx, -hy, -hz], [-hx, hy, -hz], [hx, hy, -hz]]],
    ];
    for (const [n, q] of faces) {
      const s = bb.vertexCount;
      for (const [px, py, pz] of q) bb.vertex(new Vector3(x + px, y + py, z + pz), n, 0, 0, c);
      bb.quad(s, s + 1, s + 2, s + 3);
    }
  };
  // the body: each edge of the section run the car's length, flat-shaded
  const zs = [-CAR / 2, CAR / 2];
  for (let e = 0; e < SECTION.length; e++) {
    const a = SECTION[e];
    const c = SECTION[(e + 1) % SECTION.length];
    // the section runs anticlockwise seen from +z: its outward normal is the edge turned clockwise
    const n = new Vector3(c.y - a.y, -(c.x - a.x), 0).normalize();
    const s = b.vertexCount;
    b.vertex(new Vector3(a.x, a.y, zs[0]), n, 0, 0, EDGE_COLORS[e]);
    b.vertex(new Vector3(c.x, c.y, zs[0]), n, 0, 0, EDGE_COLORS[e]);
    b.vertex(new Vector3(c.x, c.y, zs[1]), n, 0, 0, EDGE_COLORS[e]);
    b.vertex(new Vector3(a.x, a.y, zs[1]), n, 0, 0, EDGE_COLORS[e]);
    b.quad(s, s + 1, s + 2, s + 3);
  }
  // the ends, closed
  for (const [z, sign] of [
    [CAR / 2, 1],
    [-CAR / 2, -1],
  ] as const) {
    const n = new Vector3(0, 0, sign);
    const c = b.vertexCount;
    b.vertex(new Vector3(0, 2.4, z), n, 0, 0, LIVERY.green);
    for (const p of SECTION) b.vertex(new Vector3(p.x, p.y, z), n, 0, 0, LIVERY.green);
    for (let k = 0; k < SECTION.length; k++) {
      const i0 = c + 1 + k;
      const i1 = c + 1 + ((k + 1) % SECTION.length);
      if (sign > 0) b.tri(c, i0, i1);
      else b.tri(c, i1, i0);
    }
  }
  // the bands along both sides, standing just proud so they read as paint; a door near each end
  for (const side of [-1, 1]) {
    for (const [y, h, col] of [
      [3.24, 0.14, LIVERY.red],
      [3.12, 0.1, LIVERY.white],
      [2.07, 0.1, LIVERY.white],
      [1.94, 0.16, LIVERY.red],
    ] as const)
      box(b, side * 1.44, y, 0, 0.04, h, CAR, col);
    for (const z of [-CAR / 2 + 1.1, CAR / 2 - 1.1]) box(b, side * 1.435, 2.05, z, 0.03, 2.1, 0.9, scaleRgb(LIVERY.green, 0.7));
    // the windows: a row along each side (none over the cab's driving end)
    for (let k = 0; k < 11; k++) {
      const z = (k - 5) * 1.45;
      if (cab && z > CAR / 2 - 4) continue;
      // (dark glass by day, the sky in it; lit only after dark: they had shone yellow at noon)
      box(w, side * 1.445, 2.58, z, 0.05, 0.8, 1.1, rgb('#2b3739'));
    }
  }
  // the running gear (it had been a box at each end, the sky showing under the car between them, the user's note of
  // 2026-10-08): under each end a bogie, its two wheelsets on the rails (the broad gauge apart), side frames outside
  // them over their axle boxes, a bolster under the body; between the bogies the underframe, its tanks and boxes
  // hung beneath the floor
  const wheel = new CylinderGeometry(WHEEL_R, WHEEL_R, 0.12, 14).rotateZ(Math.PI / 2);
  const steel = scaleRgb(LIVERY.dark, 0.75);
  for (const zb of [-BOGIE_AT, BOGIE_AT]) {
    box(b, 0, 0.82, zb, 1.9, 0.26, 2.6, LIVERY.dark);
    for (const side of [-1, 1]) {
      box(b, side * 1.02, WHEEL_R + 0.04, zb, 0.12, 0.34, 2.9, LIVERY.dark);
      for (const dz of [-1, 1]) {
        b.add(wheel, new Matrix4().makeTranslation((side * GAUGE) / 2, WHEEL_R, zb + dz), steel);
        box(b, side * 1.02, WHEEL_R, zb + dz, 0.2, 0.22, 0.3, steel);
      }
    }
  }
  box(b, 0, 0.86, 0, 2.3, 0.18, 2 * BOGIE_AT - 3.2, LIVERY.dark);
  for (const [x, z, sx, sz] of [
    [-0.55, -2.2, 0.9, 2.6],
    [0.6, 1.6, 1.0, 3.4],
    [0, -4.6, 1.6, 0.9],
  ] as const)
    box(b, x, 0.6, z, sx, 0.42, sz, scaleRgb(LIVERY.dark, 0.9));
  // the cab's nose: the roof drops to a raked screen, a red apron with two lamps
  if (cab) {
    const rings = [0, 0.9, 1.7, NOSE].map((d) => {
      const f = d / NOSE;
      const narrow = 1 - 0.18 * f * f;
      const drop = 1.1 * f ** 1.6;
      return SECTION.map((p) => new Vector3(p.x * narrow, p.y > 3 ? p.y - drop : p.y, CAR / 2 + d));
    });
    const noseColors = [LIVERY.dark, LIVERY.red, LIVERY.green, LIVERY.glass, LIVERY.glass, LIVERY.glass, LIVERY.green, LIVERY.red];
    for (let r = 0; r < rings.length - 1; r++) {
      for (let e = 0; e < SECTION.length; e++) {
        const a0 = rings[r][e];
        const a1 = rings[r][(e + 1) % SECTION.length];
        const b0 = rings[r + 1][e];
        const b1 = rings[r + 1][(e + 1) % SECTION.length];
        const n = new Vector3().crossVectors(new Vector3().subVectors(a1, a0), new Vector3().subVectors(b0, a0)).normalize();
        const s = b.vertexCount;
        for (const v of [a0, a1, b1, b0]) b.vertex(v, n, 0, 0, noseColors[e]);
        b.quad(s, s + 1, s + 2, s + 3);
      }
    }
    // the face at the tip
    const tip = rings[rings.length - 1];
    const c = b.vertexCount;
    b.vertex(new Vector3(0, 2.2, CAR / 2 + NOSE), new Vector3(0, 0, 1), 0, 0, LIVERY.red);
    for (const p of tip) b.vertex(p, new Vector3(0, 0, 1), 0, 0, LIVERY.red);
    for (let k = 0; k < tip.length; k++) b.tri(c, c + 1 + k, c + 1 + ((k + 1) % tip.length));
    // its headlamps, lit day and night as the country's trains run
    for (const side of [-1, 1]) box(l, side * 0.7, 1.85, CAR / 2 + NOSE + 0.06, 0.42, 0.22, 0.06, rgb('#fff6e0'));
  }
  return { body: b.build(), windows: w.build(), lamps: cab ? l.build() : null };
}

/** The train: its cars as meshes moved along the line each frame; between runs it is out of sight beyond the world's ends. */
export class Train {
  readonly group = new Group();
  private readonly cars: Mesh[] = [];
  private readonly lit: MeshStandardMaterial;
  /** Seconds added to the clock, so a film scene can have the train where it wants it. */
  private offset = 0;
  /** Where its nose is as last moved (m along the line, out beyond its ends as a run begins and ends), which way it runs, and whether it is on a run. */
  private nose = 0;
  private dir = 1;
  private running = false;
  /** Its nose and each wheelset's place along the line when its sounds were last asked for (m), to find what they passed since. */
  private noseWas = NaN;
  /** Where its nose was when the horn last sounded (m along the line). */
  private hornedAt = -Infinity;
  private readonly axlesWere: number[] = [];
  private readonly sound: TrainSound & { engine: Vector3; bogies: Vector3[] } = {
    engine: new Vector3(),
    bogies: Array.from({ length: (COACHES + 1) * 2 }, () => new Vector3()),
    joints: [],
    horn: null,
  };

  constructor() {
    this.group.name = 'train';
    const body = patchMaterial(new MeshStandardMaterial({ vertexColors: true, roughness: 0.45, metalness: 0.1 }), { grime: 0.25 });
    // its windows: glass, glossy enough to take the sky by day, their lights coming on after dark (`update`)
    this.lit = new MeshStandardMaterial({ vertexColors: true, roughness: 0.18, metalness: 0.3, emissive: '#ffd890', emissiveIntensity: 0 });
    const lamp = patchMaterial(new MeshStandardMaterial({ vertexColors: true, emissive: '#fff2d0', emissiveIntensity: 1.6 }), {});
    const cab = car(true);
    const coach = car(false);
    for (let i = 0; i <= COACHES; i++) {
      const parts = i === 0 ? cab : coach;
      const g = new Group();
      const m = new Mesh(parts.body, body);
      const w = new Mesh(parts.windows, patchMaterial(this.lit, {}));
      // it moves: a shadow left behind by a map not redrawn each frame would show where it was
      m.castShadow = false;
      m.receiveShadow = true;
      g.add(m, w);
      if (parts.lamps) g.add(new Mesh(parts.lamps, lamp));
      this.group.add(g);
      this.cars.push(m);
    }
  }

  /** Has the train's nose `s` m along the line at the clock `t`, running toward increasing s if `forward` (for the film). */
  place(t: number, s: number, forward: boolean): void {
    const length = RAIL_LENGTH + 300;
    const into = (forward ? s + 150 : length - 150 - s) / SPEED;
    // the nearest run going the right way (they alternate)
    let run = Math.floor((t + this.offset) / EVERY);
    if ((run % 2 === 0) !== forward) run++;
    this.offset = run * EVERY + into - t;
  }

  /** Moves the train along for the clock `t` (s), and lights its windows by `night` (0..1). */
  update(t: number, night: number): void {
    const time = t + this.offset;
    const run = Math.floor(time / EVERY);
    const into = time - run * EVERY;
    const forward = run % 2 === 0;
    const length = RAIL_LENGTH + 300;
    const head = into * SPEED;
    const visible = head < length + (CAR + GAP) * (COACHES + 1);
    this.group.visible = visible;
    this.running = visible;
    if (!visible) return;
    // the nose's distance along the line from its starting end, 150 m out beyond it
    const nose = forward ? head - 150 : length - 150 - head;
    const dir = forward ? 1 : -1;
    this.nose = nose;
    this.dir = dir;
    this.cars.forEach((m, i) => {
      const s = nose - dir * (CAR / 2 + (i === 0 ? NOSE : 0) + i * (CAR + GAP));
      const p = railAt(Math.min(RAIL_LENGTH, Math.max(0, s)));
      const g = m.parent as Group;
      // (each car rocking on its springs as it runs, out of step with the next: it had run stiff as a model)
      const k = i * 1.7;
      const bounce = SWAY.bounce * Math.sin(time * 2 * Math.PI * SWAY.bounceHz + k * 1.3);
      g.position.set(p.x, CREST + RAIL_TOP + bounce, p.z);
      g.rotation.set(0, p.heading + (forward ? 0 : Math.PI), SWAY.roll * Math.sin(time * 2 * Math.PI * SWAY.rollHz + k), 'YXZ');
      g.visible = s > -40 && s < RAIL_LENGTH + 40;
    });
    this.lit.emissiveIntensity = 1.3 * night;
  }

  /**
   * Where its sounds come from now (audio/soundscape.ts `train`): the engine under the cab car, every bogie (the
   * wheels' rolling on the rails), each rail joint a wheel has struck since it was last asked and how long ago, and
   * the horn if the driver sounded it since: at a whistle board, or as it comes on toward the listener at `ear`
   * (within `APPROACH` m of the line's point nearest them; the user's wish, 2026-10-08). Null between its runs.
   */
  acoustics(ear: { x: number; z: number }): TrainSound | null {
    const out = this.sound;
    out.joints.length = 0;
    out.horn = null;
    if (!this.running) {
      this.noseWas = Number.NaN;
      this.axlesWere.length = 0;
      return null;
    }
    const { nose, dir } = this;
    // (a jump, a film's cut or the next run: nothing struck or sounded on the way)
    const going = Number.isFinite(this.noseWas) && Math.abs(nose - this.noseWas) < 30;
    let axle = 0;
    for (let i = 0; i <= COACHES; i++) {
      const middle = nose - dir * (CAR / 2 + (i === 0 ? NOSE : 0) + i * (CAR + GAP));
      for (const along of AXLES) {
        const s = middle + along;
        const was = this.axlesWere[axle];
        this.axlesWere[axle++] = s;
        if (!going || was === undefined) continue;
        // each joint passed since, struck as long ago as the wheel has taken to come on from it
        const from = s > was ? Math.floor(was / JOINT) + 1 : Math.ceil(s / JOINT);
        const to = s > was ? Math.floor(s / JOINT) : Math.ceil(was / JOINT) - 1;
        for (let j = from; j <= to; j++) {
          const at = j * JOINT;
          if (at < 0 || at > RAIL_LENGTH) continue;
          const p = railAt(at);
          out.joints.push({ x: p.x, y: CREST + RAIL_TOP, z: p.z, ago: Math.abs(s - at) / SPEED });
        }
      }
      for (const [k, along] of [-6.8, 6.8].entries()) {
        const p = railAt(Math.min(RAIL_LENGTH, Math.max(0, middle + along)));
        out.bogies[i * 2 + k].set(p.x, CREST + RAIL_TOP, p.z);
      }
      if (i === 0) {
        const p = railAt(Math.min(RAIL_LENGTH, Math.max(0, middle)));
        out.engine.set(p.x, CREST + RAIL_TOP + ENGINE_UP, p.z);
      }
    }
    if (going) {
      const passed = (at: number) => (dir > 0 ? this.noseWas < at && at <= nose : nose <= at && at < this.noseWas);
      // (not again within a few seconds of the last: a board just before the listener's place)
      const blow = (at: number) => {
        if (!passed(at) || Math.abs(nose - this.hornedAt) < HORN_APART) return;
        out.horn = Math.abs(nose - at) / SPEED;
        this.hornedAt = nose;
      };
      for (const board of dir > 0 ? WHISTLES.forward : WHISTLES.back) blow(board);
      blow(railNearest(ear.x, ear.z).s - dir * APPROACH);
    }
    this.noseWas = nose;
    return out;
  }
}

/** The railway's track, one mesh for its bed and one for its rails. */
export function buildRailway(): Group {
  const group = new Group();
  group.name = 'railway';
  const { bed, rails } = track();
  const bedMesh = new Mesh(bed, patchMaterial(new MeshStandardMaterial({ map: trackTexture(), vertexColors: true, roughness: 0.95 }), { grime: 0.4 }));
  bedMesh.receiveShadow = true;
  const railMesh = new Mesh(rails, patchMaterial(new MeshStandardMaterial({ vertexColors: true, roughness: 0.4, metalness: 0.4 }), {}));
  group.add(bedMesh, railMesh);
  // a concrete post with its number every 500 m, the line's kilometre marks
  const post = new CylinderGeometry(0.08, 0.1, 1.2, 6);
  const posts = new MeshBuilder();
  for (let s = 250; s < RAIL_LENGTH; s += 500) {
    const p = railAt(s);
    const x = p.x + Math.cos(p.heading) * 3.4;
    const z = p.z - Math.sin(p.heading) * 3.4;
    posts.add(post, new Matrix4().makeTranslation(x, CREST + 0.2, z), rgb('#d8d4c8'));
  }
  group.add(new Mesh(posts.build(), patchMaterial(new MeshStandardMaterial({ vertexColors: true, roughness: 0.9 }), {})));
  return group;
}
