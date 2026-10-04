import { BoxGeometry, CylinderGeometry, Group, InstancedBufferAttribute, InstancedMesh, Matrix4, MeshStandardMaterial, Quaternion, Vector3, DynamicDrawUsage, BufferAttribute } from 'three';
import { G, LAYER_NO_REFLECT } from '../core/globals';
import { BUILDINGS, COVER, GRID_H, GRID_W, LAYERS, cellCentre, coverAt } from '../geo/data';
import { Rng } from '../core/rng';
import { MeshBuilder, rgb, type RGB } from '../render/builder';
import { patchMaterial } from '../render/patch';
import { onRoad, terrainHeight } from './geography';

// The red ghost crabs (লাল কাঁকড়া) of the sea beaches (GEOGRAPHY_PLAN.md §8.4): Ocypode macrocera, with a few
// O. ceratophthalmus, as far as the records go.
// - Where: burrows in the fine sand of the beaches facing the Bay, between the neap and the spring tides' high
//   water (≈0.8–1.8 m above mean sea level here), never on the salt pans, in the mud or inland. Density from the
//   Sundarbans' and Kuakata's counts: 2–10 burrows a square metre on an undisturbed beach (mean 3.6), far fewer
//   where people walk (Kuakata's protected beach had 19 times more) [মডেল: none counted here].
// - Burrow: an opening 2–7 cm across (most 3–5), the sand dug out of it heaped in a mound, most of them on its
//   seaward side.
// - Body: a carapace 2.4–3.4 cm across, red-brown to bright red; its legs spread about three times that.
// - Behaviour, each a small state machine: in its burrow → out at its mouth → foraging toward the water's edge
//   in short sideways dashes and pauses → fleeing back into a burrow at anyone's approach → hiding a while,
//   longer if it is disturbed again. Active by day and by night; in heavy rain they stay in; the tide's water
//   coming up the sand sends them up the beach or down their burrows. They run sideways, up to ≈2 m/s
//   (measured for O. ceratophthalmus).
// - How near a person may come before they run is not measured for any Ocypode: FLIGHT is a [মডেল] value.
// Only the burrows and crabs round the camera are made (in 8 m cells within REACH), so the beaches cost
// nothing seen from afar or from the channel.

/**
 * The band of beach their burrows lie in (m about MSL). Measured, it is between the neap and the spring tides'
 * high water (≈0.8–1.8 m here); but the DEM puts this coast's beach sand near mean sea level, below that, so
 * the whole beach the map has is taken [মডেল], and a burrow the tide covers keeps its crab in.
 */
const BAND = { low: -0.5, high: 2.5 };
/** Burrows a square metre on an undisturbed beach (the measured mean), and the share of them drawn (the rest, a few centimetres across, would not be told apart: the cost is kept down) [মডেল]. */
const DENSITY = 3.6;
const DRAWN = 0.25;
/** The share of burrows with a crab out and about. */
const ACTIVE = 0.12;
/** Cells (m) the beach is made in, and how far round the camera. */
const CELL = 8;
const REACH = 36;
/** Most burrows and crabs made at once. */
const MAX_BURROWS = 6000;
const MAX_CRABS = 400;
/** How near (m) someone low on the beach may come before a crab runs [মডেল]; the camera counts as someone below this height above the sand. */
const FLIGHT = 4;
const LOW = 3;
/** Running and foraging speeds (m/s). */
const RUN = 1.9;
const WALK = 0.45;

type State = 'in' | 'out' | 'forage' | 'flee';

interface Crab {
  x: number;
  z: number;
  /** Which way it faces (rad); it runs sideways to this. */
  facing: number;
  /** Its burrow. */
  hx: number;
  hz: number;
  state: State;
  /** Seconds left in this state (or this dash or pause). */
  timer: number;
  moving: boolean;
  tx: number;
  tz: number;
  speed: number;
  /** How often it has been disturbed lately (it hides longer each time). */
  scared: number;
  gait: number;
  size: number;
  slot: number;
}

/** Fewer crabs where people are many: by the buildings round a point (within a 300 m cell and its neighbours). */
const people = (() => {
  const grid = new Map<number, number>();
  const key = (i: number, j: number) => (i + 4096) * 8192 + (j + 4096);
  for (let i = 0; i < BUILDINGS.count; i++) {
    const k = key(Math.floor(BUILDINGS.x[i] / 300), Math.floor(BUILDINGS.z[i] / 300));
    grid.set(k, (grid.get(k) ?? 0) + 1);
  }
  return (x: number, z: number) => {
    const i = Math.floor(x / 300);
    const j = Math.floor(z / 300);
    let n = 0;
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) n += grid.get(key(i + a, j + b)) ?? 0;
    // [মডেল] from Kuakata's 19×: an undisturbed beach keeps all, a busy town's ≈5 %
    return 1 / (1 + n / 6);
  };
})();

/** The 64 m cells that hold any beach sand at all, found once: the crabs are only looked for there. */
const BEACH = (() => {
  const set = new Set<number>();
  for (let i = 0; i < GRID_W * GRID_H; i++) {
    if (LAYERS.cover[i] !== COVER.sand) continue;
    const h = LAYERS.terrain[i] / 10;
    if (h < BAND.low - 1 || h > BAND.high + 1.5) continue;
    const c = cellCentre(i % GRID_W, Math.floor(i / GRID_W));
    set.add(Math.floor(c.x / 64) * 100000 + Math.floor(c.z / 64));
  }
  return set;
})();
const nearBeach = (x: number, z: number) => {
  const i = Math.floor(x / 64);
  const j = Math.floor(z / 64);
  for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) if (BEACH.has((i + a) * 100000 + j + b)) return true;
  return false;
};

/** Whether a burrow could be dug at (x, z): beach sand in the band above the water. */
function habitat(x: number, z: number): boolean {
  if (coverAt(x, z) !== COVER.sand) return false;
  const h = terrainHeight(x, z);
  return h >= BAND.low && h <= BAND.high && !onRoad(x, z, 2);
}

/** A small deterministic hash of a cell and a draw, 0..1. */
const hash = (i: number, j: number, k: number) => ((Math.imul(i * 73856093 ^ j * 19349663 ^ k * 83492791, 0x45d9f3b) >>> 0) % 100000) / 100000;

const RED: RGB = rgb('#c2401c');
const LEG: RGB = rgb('#d0613a');
const CLAW: RGB = rgb('#e8d6c0');

/** A crab at unit size (1 = a 3 cm carapace), legs marked by aLeg (0 body, ±1..4 leg pairs) for the gait. */
function crabGeometry() {
  const b = new MeshBuilder();
  const m = new Matrix4();
  const q = new Quaternion();
  const one = new Vector3(1, 1, 1);
  const legs: number[] = [];
  /** Marks the vertices added since the last mark: 0 the body, ±1..4 a leg. */
  const mark = (v: number) => {
    while (legs.length < b.vertexCount) legs.push(v);
  };
  // the carapace: broad and squarish, raised on its legs; the eyes on their stalks
  b.add(new BoxGeometry(0.03, 0.012, 0.024), m.compose(new Vector3(0, 0.022, 0), q.identity(), one), RED);
  b.add(new BoxGeometry(0.004, 0.008, 0.004), m.compose(new Vector3(0.009, 0.031, 0.011), q.identity(), one), rgb('#2a1a12'));
  b.add(new BoxGeometry(0.004, 0.008, 0.004), m.compose(new Vector3(-0.009, 0.031, 0.011), q.identity(), one), rgb('#2a1a12'));
  // the claws, one larger, held in front
  b.add(new BoxGeometry(0.012, 0.008, 0.01), m.compose(new Vector3(0.011, 0.016, 0.017), q.identity(), one), CLAW);
  b.add(new BoxGeometry(0.008, 0.006, 0.007), m.compose(new Vector3(-0.01, 0.016, 0.015), q.identity(), one), CLAW);
  mark(0);
  // four legs a side, each splayed out and down to the sand
  for (const side of [-1, 1]) {
    for (let k = 0; k < 4; k++) {
      const z = 0.009 - k * 0.006;
      const reach = 0.04 - Math.abs(k - 1.5) * 0.004;
      const yaw = (k - 1.5) * 0.35 * side;
      q.setFromAxisAngle(new Vector3(0, 1, 0), yaw);
      const tilt = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), side * -0.55);
      b.add(new BoxGeometry(reach, 0.003, 0.003), m.compose(new Vector3(side * (0.013 + reach * 0.42), 0.012, z), q.clone().multiply(tilt), one), LEG);
      mark(side * (k + 1));
    }
  }
  // a soft dark patch under it, for its shadow on the sand
  const s = b.vertexCount;
  const up = new Vector3(0, 1, 0);
  const shade: RGB = [0.18, 0.15, 0.12];
  b.vertex(new Vector3(0, 0.001, 0), up, 0.5, 0.5, shade);
  for (let k = 0; k <= 10; k++) {
    const a = (k / 10) * Math.PI * 2;
    b.vertex(new Vector3(Math.cos(a) * 0.04, 0.001, Math.sin(a) * 0.032), up, 0, 0, shade);
  }
  for (let k = 0; k < 10; k++) b.tri(s, s + k + 2, s + k + 1);
  mark(0);
  const g = b.build();
  g.setAttribute('aLeg', new BufferAttribute(new Float32Array(legs), 1));
  return g;
}

/** A burrow: its dark opening and the mound of sand dug out of it, heaped seaward (+z here). */
function burrowGeometry() {
  const b = new MeshBuilder();
  const m = new Matrix4();
  const q = new Quaternion();
  const up = new Vector3(0, 1, 0);
  const s = b.vertexCount;
  b.vertex(new Vector3(0, 0.004, 0), up, 0.5, 0.5, [0.05, 0.04, 0.03]);
  for (let k = 0; k <= 8; k++) {
    const a = (k / 8) * Math.PI * 2;
    b.vertex(new Vector3(Math.cos(a) * 0.022, 0.006, Math.sin(a) * 0.022), up, 0, 0, [0.22, 0.18, 0.13]);
  }
  for (let k = 0; k < 8; k++) b.tri(s, s + k + 2, s + k + 1);
  b.add(new CylinderGeometry(0.01, 0.045, 0.02, 7), m.compose(new Vector3(0, 0.008, 0.06), q.identity(), new Vector3(1.2, 1, 0.8)), rgb('#c8b48a'));
  return b.build();
}

export class Crabs {
  readonly group = new Group();
  private readonly bodies: InstancedMesh;
  private readonly burrows: InstancedMesh;
  private readonly gait: InstancedBufferAttribute;
  private crabs: Crab[] = [];
  private holes: { x: number; z: number }[] = [];
  /** The cells made now, by key. */
  private cellKey = '';
  private readonly m = new Matrix4();
  private readonly q = new Quaternion();
  private readonly p = new Vector3();
  private readonly s = new Vector3();
  private readonly up = new Vector3(0, 1, 0);
  private readonly rng = new Rng(131);

  constructor() {
    this.group.name = 'crabs';
    const body = crabGeometry();
    this.gait = new InstancedBufferAttribute(new Float32Array(MAX_CRABS * 2), 2);
    this.gait.setUsage(DynamicDrawUsage);
    body.setAttribute('aGait', this.gait);
    const material = patchMaterial(new MeshStandardMaterial({ vertexColors: true, roughness: 0.55 }), {
      vertex: {
        key: 'crab-gait',
        pars: 'attribute float aLeg;\nattribute vec2 aGait;\n',
        // each leg lifts and swings in turn, alternate pairs out of step, as fast as it runs
        code: `{
  if (abs(aLeg) > 0.5) {
    float ph = aGait.x + abs(aLeg) * 1.5708 + (aLeg > 0.0 ? 0.0 : 3.1416);
    float reach = clamp(abs(transformed.x) / 0.06, 0.0, 1.0);
    transformed.y += max(sin(ph), 0.0) * 0.008 * aGait.y * reach;
    transformed.z += cos(ph) * 0.006 * aGait.y * reach;
  }
}`,
      },
    });
    this.bodies = new InstancedMesh(body, material, MAX_CRABS);
    this.bodies.count = 0;
    this.bodies.frustumCulled = false;
    this.bodies.instanceMatrix.setUsage(DynamicDrawUsage);
    this.bodies.layers.set(LAYER_NO_REFLECT);
    this.burrows = new InstancedMesh(burrowGeometry(), patchMaterial(new MeshStandardMaterial({ vertexColors: true, roughness: 0.95 }), {}), MAX_BURROWS);
    this.burrows.count = 0;
    this.burrows.frustumCulled = false;
    this.burrows.layers.set(LAYER_NO_REFLECT);
    this.group.add(this.burrows, this.bodies);
  }

  /** Makes the burrows and their crabs in the cells round (x, z), when the camera has moved into new ones. */
  private populate(x: number, z: number): void {
    const ci = Math.floor(x / CELL);
    const cj = Math.floor(z / CELL);
    const key = `${ci}:${cj}`;
    if (key === this.cellKey) return;
    this.cellKey = key;
    const holes: { x: number; z: number; seaward: number }[] = [];
    const crabs: Crab[] = [];
    const R = Math.ceil(REACH / CELL);
    for (let i = ci - R; i <= ci + R; i++) {
      for (let j = cj - R; j <= cj + R; j++) {
        const cx = (i + 0.5) * CELL;
        const cz = (j + 0.5) * CELL;
        if (Math.hypot(cx - x, cz - z) > REACH + CELL || !habitat(cx, cz) && !habitat(cx - CELL / 3, cz) && !habitat(cx + CELL / 3, cz)) continue;
        const n = Math.round(CELL * CELL * DENSITY * DRAWN * people(cx, cz));
        for (let k = 0; k < n && holes.length < MAX_BURROWS; k++) {
          const hx = i * CELL + hash(i, j, k * 2) * CELL;
          const hz = j * CELL + hash(i, j, k * 2 + 1) * CELL;
          if (!habitat(hx, hz)) continue;
          // the mound on the seaward side: down the beach's slope
          const dx = terrainHeight(hx + 0.5, hz) - terrainHeight(hx - 0.5, hz);
          const dz = terrainHeight(hx, hz + 0.5) - terrainHeight(hx, hz - 0.5);
          holes.push({ x: hx, z: hz, seaward: Math.atan2(-dx, -dz) });
          if (crabs.length < MAX_CRABS && hash(i, j, k + 7001) < ACTIVE) {
            crabs.push({ x: hx, z: hz, facing: hash(i, j, k + 9001) * Math.PI * 2, hx, hz, state: 'in', timer: hash(i, j, k + 5001) * 20, moving: false, tx: hx, tz: hz, speed: 0, scared: 0, gait: 0, size: 0.8 + 0.35 * hash(i, j, k + 3001), slot: crabs.length });
          }
        }
      }
    }
    // the crabs already out keep where they are, if their burrow is still among these
    this.holes = holes;
    this.crabs = crabs;
    holes.forEach((h, i) => {
      this.q.setFromAxisAngle(this.up, h.seaward);
      const s = 0.8 + 0.6 * hash(Math.floor(h.x * 10), Math.floor(h.z * 10), 3);
      this.m.compose(this.p.set(h.x, terrainHeight(h.x, h.z), h.z), this.q, this.s.set(s, s, s));
      this.burrows.setMatrixAt(i, this.m);
    });
    this.burrows.count = holes.length;
    this.burrows.instanceMatrix.needsUpdate = true;
  }

  /**
   * One step for the crabs round the camera: `threats` are where people (or a low camera, a boat at the beach)
   * stand; `rain` how hard it rains (0..1).
   */
  update(dt: number, camera: Vector3, threats: readonly Vector3[], rain: number): void {
    if (!nearBeach(camera.x, camera.z) || camera.y - terrainHeight(camera.x, camera.z) > 60) {
      this.bodies.count = 0;
      this.burrows.count = 0;
      this.cellKey = '';
      return;
    }
    this.populate(camera.x, camera.z);
    const h = Math.min(dt, 1 / 20);
    const level = G.uWaterLevel.value;
    // who is near: the threats, and the camera itself when it is down on the beach
    const near = (c: Crab) => {
      for (const p of threats) if (Math.hypot(p.x - c.x, p.z - c.z) < FLIGHT) return p;
      if (camera.y - terrainHeight(camera.x, camera.z) < LOW && Math.hypot(camera.x - c.x, camera.z - c.z) < FLIGHT) return camera;
      return null;
    };
    let shown = 0;
    for (const c of this.crabs) {
      c.timer -= h;
      const threat = c.state === 'in' ? null : near(c);
      // the water coming up the sand, or someone near: back to its burrow at a run
      const wet = terrainHeight(c.x, c.z) < level + 0.05;
      if ((threat || wet) && c.state !== 'flee' && c.state !== 'in') {
        c.state = 'flee';
        c.scared = Math.min(5, c.scared + 1);
        c.tx = c.hx;
        c.tz = c.hz;
        c.speed = RUN;
        c.moving = true;
      }
      switch (c.state) {
        case 'in':
          if (c.timer <= 0) {
            // heavy rain keeps them in, and so does anyone close by, or the tide over the burrow
            if (rain > 0.5 || near(c) || terrainHeight(c.hx, c.hz) < level + 0.05) c.timer = 4 + this.rng.next() * 6;
            else {
              c.state = 'out';
              c.timer = 1 + this.rng.next() * 3;
              c.scared = Math.max(0, c.scared - 1);
            }
          }
          break;
        case 'out':
          if (c.timer <= 0) {
            c.state = 'forage';
            c.timer = 0;
          }
          break;
        case 'forage':
          if (c.timer <= 0) {
            if (c.moving) {
              // a pause, to pick at the sand
              c.moving = false;
              c.timer = 0.5 + this.rng.next() * 2;
            } else {
              // a short dash, toward the water's edge (down the slope) and along it, never far from home
              const dx = terrainHeight(c.x + 0.5, c.z) - terrainHeight(c.x - 0.5, c.z);
              const dz = terrainHeight(c.x, c.z + 0.5) - terrainHeight(c.x, c.z - 0.5);
              const down = Math.atan2(-dx, -dz) + (this.rng.next() - 0.5) * 2.2;
              const d = 0.3 + this.rng.next() * 1.2;
              let tx = c.x + Math.sin(down) * d;
              let tz = c.z + Math.cos(down) * d;
              const fromHome = Math.hypot(tx - c.hx, tz - c.hz);
              if (fromHome > 6) {
                tx = c.hx + ((tx - c.hx) / fromHome) * 6;
                tz = c.hz + ((tz - c.hz) / fromHome) * 6;
              }
              // not into the water
              if (terrainHeight(tx, tz) < level + 0.1) {
                tx = c.x;
                tz = c.z;
              }
              c.tx = tx;
              c.tz = tz;
              c.speed = WALK * (0.6 + this.rng.next() * 0.8);
              c.moving = true;
              c.timer = 0.3 + this.rng.next() * 0.8;
              // and home again after a while
              if (this.rng.next() < 0.06) {
                c.state = 'flee';
                c.tx = c.hx;
                c.tz = c.hz;
                c.speed = WALK;
              }
            }
          }
          break;
        case 'flee':
          if (Math.hypot(c.tx - c.x, c.tz - c.z) < 0.03) {
            c.state = 'in';
            c.moving = false;
            // the more it is disturbed, the longer it stays in
            c.timer = (5 + this.rng.next() * 10) * (1 + c.scared);
          }
          break;
      }
      if (c.moving) {
        const dx = c.tx - c.x;
        const dz = c.tz - c.z;
        const d = Math.hypot(dx, dz);
        const step = Math.min(d, c.speed * h);
        if (d > 1e-4) {
          c.x += (dx / d) * step;
          c.z += (dz / d) * step;
          // it runs sideways: its body turns side-on to the way it goes, whichever side is nearer
          const way = Math.atan2(dx, dz);
          const want = Math.abs(((way + Math.PI / 2 - c.facing + Math.PI * 3) % (Math.PI * 2)) - Math.PI) < Math.PI / 2 ? way + Math.PI / 2 : way - Math.PI / 2;
          c.facing += Math.atan2(Math.sin(want - c.facing), Math.cos(want - c.facing)) * Math.min(1, h * 12);
          c.gait += step * 90;
        }
        if (d < 0.02) c.moving = false;
      }
      if (c.state === 'in') continue;
      this.q.setFromAxisAngle(this.up, c.facing);
      const s = c.size * 1.0;
      this.m.compose(this.p.set(c.x, terrainHeight(c.x, c.z), c.z), this.q, this.s.set(s, s, s));
      this.bodies.setMatrixAt(shown, this.m);
      this.gait.setXY(shown, c.gait, c.moving ? Math.min(1.5, c.speed / WALK) : 0);
      shown++;
    }
    this.bodies.count = shown;
    this.bodies.instanceMatrix.needsUpdate = true;
    this.gait.needsUpdate = true;
  }

  /** How many burrows and crabs are made, and how many crabs are out, for the debug readout. */
  get counts(): { burrows: number; crabs: number; out: number } {
    return { burrows: this.holes.length, crabs: this.crabs.length, out: this.bodies.count };
  }
}
