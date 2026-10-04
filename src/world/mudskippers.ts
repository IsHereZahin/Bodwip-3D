import { DynamicDrawUsage, Group, InstancedMesh, LatheGeometry, Matrix4, MeshStandardMaterial, Quaternion, SphereGeometry, Vector2, Vector3 } from 'three';
import { G, LAYER_NO_REFLECT } from '../core/globals';
import { COVER, GRID_H, GRID_W, KIND, LAYERS, cellCentre, coverAt, kindAt } from '../geo/data';
import { Rng } from '../core/rng';
import { MeshBuilder, rgb } from '../render/builder';
import { patchMaterial } from '../render/patch';
import { terrainHeight } from './geography';

// The mudskippers of the mangroves' mud (Boleophthalmus boddarti, and Periophthalmus with it, as on the
// Bay's mangrove coasts): fish a hand long that live out on the mud the tide leaves bare, by day.
// - Where: the sea's mud and mangrove ground, out of the water and no more than a little above it (the wet
//   mud of the falling and the rising tide); none under water, none at night (they keep to their burrows then).
// - Behaviour, each a small state machine: resting on the mud, crawling a little on their pectoral fins,
//   skipping (a flick of the tail throws them a hand or two across the mud), and at anyone's approach skipping
//   away down to the water and gone. How many to a square metre is [মডেল] (none counted here); how near one may
//   come before they skip is [মডেল] too.
// Only those round the camera are made (in 8 m cells within REACH), as with the crabs.

/** Mudskippers a square metre on good mud, and the share of them drawn. [মডেল] */
const DENSITY = 0.5;
const DRAWN = 0.3;
const CELL = 8;
const REACH = 30;
const MAX = 300;
/** They keep to mud at most this high above the water (m): higher it has dried. */
const WET = 1.2;
/** How near someone low may come before they skip away (m), and what counts as low (m over the mud). */
const FLIGHT = 3;
const LOW = 3;
/** A skip: how far (m), how high (m), how long (s). */
const SKIP = { far: [0.15, 0.5], high: [0.04, 0.12], time: 0.28 } as const;

type State = 'rest' | 'crawl' | 'skip' | 'gone';

interface Skipper {
  x: number;
  z: number;
  heading: number;
  state: State;
  timer: number;
  /** A skip or crawl: from where, to where, how far along (0..1). */
  fx: number;
  fz: number;
  tx: number;
  tz: number;
  t: number;
  /** How long this skip or crawl takes (s). */
  dur: number;
  high: number;
  /** Skips left before it reaches the water, when fleeing. */
  fleeing: number;
  size: number;
}

/** A hash of a cell and a draw, 0..1. */
const hash = (i: number, j: number, k: number) => ((Math.imul(i * 73856093 ^ j * 19349663 ^ k * 83492791, 0x45d9f3b) >>> 0) % 100000) / 100000;

/** Whether mudskippers live at (x, z): the sea's mud or mangrove ground. */
function habitat(x: number, z: number): boolean {
  const k = kindAt(x, z);
  if (k !== KIND.tidal && k !== KIND.mangrove) return false;
  const c = coverAt(x, z);
  return c === COVER.mud || c === COVER.mangrove;
}

/** The 64 m cells that hold any of their mud, found once. */
const MUD = (() => {
  const set = new Set<number>();
  for (let i = 0; i < GRID_W * GRID_H; i++) {
    const k = LAYERS.kind[i] & 0x7f;
    if (k !== KIND.tidal && k !== KIND.mangrove) continue;
    if (LAYERS.cover[i] !== COVER.mud && LAYERS.cover[i] !== COVER.mangrove) continue;
    const c = cellCentre(i % GRID_W, Math.floor(i / GRID_W));
    set.add(Math.floor(c.x / 64) * 100000 + Math.floor(c.z / 64));
  }
  return set;
})();
const nearMud = (x: number, z: number) => {
  const i = Math.floor(x / 64);
  const j = Math.floor(z / 64);
  for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) if (MUD.has((i + a) * 100000 + j + b)) return true;
  return false;
};

/** A mudskipper a hand long, nose toward +z: a stout head with its eyes on top, a tapering body, its fins. */
function skipperGeometry() {
  const b = new MeshBuilder();
  const m = new Matrix4();
  const q = new Quaternion();
  // grey-brown, paler than the mud they sit on (and glossy wet), the belly pale
  const back = rgb('#6a6248');
  const flank = rgb('#9a8d6c');
  const belly = rgb('#cfc4a4');
  const fin = rgb('#7c6f52');
  // the body: a lathe along its length, laid on its belly
  const profile = [
    [0.0, -0.065],
    [0.006, -0.06],
    [0.011, -0.03],
    [0.016, 0.0],
    [0.018, 0.025],
    [0.016, 0.045],
    [0.009, 0.06],
    [0.0, 0.064],
  ].map(([r, y]) => new Vector2(r, y));
  const body = new LatheGeometry(profile, 10);
  body.rotateX(Math.PI / 2);
  body.scale(1, 0.85, 1);
  b.add(body, m.makeTranslation(0, 0.015, 0), flank);
  // a darker back and a pale belly, as slices over it
  const top = new SphereGeometry(1, 8, 4, 0, Math.PI * 2, 0, Math.PI / 3);
  b.add(top, m.compose(new Vector3(0, 0.021, 0.005), q.identity(), new Vector3(0.015, 0.008, 0.05)), back);
  const under = new SphereGeometry(1, 8, 4, 0, Math.PI * 2, (Math.PI * 2) / 3, Math.PI / 3);
  b.add(under, m.compose(new Vector3(0, 0.01, 0.01), q.identity(), new Vector3(0.014, 0.006, 0.045)), belly);
  // the eyes, raised on top of the head
  for (const sx of [-1, 1]) b.add(new SphereGeometry(0.0055, 7, 5), m.makeTranslation(sx * 0.0055, 0.03, 0.04), rgb('#1c1a16'));
  // the fins: the pectorals braced on the mud, two dorsals and the tail's fan
  const fan = (cx: number, cy: number, cz: number, ax: Vector3, ay: Vector3, w: number, h: number) => {
    const n = new Vector3().crossVectors(ax, ay).normalize();
    const c = b.vertex(new Vector3(cx, cy, cz), n, 0.5, 0.5, fin);
    const ring = Array.from({ length: 7 }, (_, k) => {
      const a = (k / 6) * Math.PI;
      return b.vertex(new Vector3(cx, cy, cz).addScaledVector(ax, Math.cos(a) * w).addScaledVector(ay, Math.sin(a) * h), n, 0, 0, fin);
    });
    for (let k = 0; k < 6; k++) b.tri(c, ring[k], ring[k + 1]);
  };
  for (const sx of [-1, 1]) fan(sx * 0.014, 0.008, 0.022, new Vector3(0, 0, 1), new Vector3(sx, -0.6, 0).normalize(), 0.012, 0.016);
  fan(0, 0.024, 0.0, new Vector3(0, 0, 1), new Vector3(0, 1, 0), 0.012, 0.014);
  fan(0, 0.021, -0.03, new Vector3(0, 0, 1), new Vector3(0, 1, 0), 0.022, 0.008);
  fan(0, 0.012, -0.062, new Vector3(0, 1, 0), new Vector3(0, 0, -1), 0.012, 0.018);
  return b.build();
}

export class Mudskippers {
  readonly group = new Group();
  private readonly mesh: InstancedMesh;
  private fish: Skipper[] = [];
  private cellKey = '';
  private readonly rng = new Rng(173);
  private readonly m = new Matrix4();
  private readonly q = new Quaternion();
  private readonly p = new Vector3();
  private readonly s = new Vector3();
  private readonly up = new Vector3(0, 1, 0);
  private readonly side = new Vector3(1, 0, 0);

  constructor() {
    this.group.name = 'mudskippers';
    const material = patchMaterial(new MeshStandardMaterial({ vertexColors: true, roughness: 0.4 }), { grime: 0.3 });
    this.mesh = new InstancedMesh(skipperGeometry(), material, MAX);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    this.mesh.layers.set(LAYER_NO_REFLECT);
    this.group.add(this.mesh);
  }

  /** Makes the mudskippers in the cells round (x, z), when the camera has moved into new ones. */
  private populate(x: number, z: number): void {
    const ci = Math.floor(x / CELL);
    const cj = Math.floor(z / CELL);
    const key = `${ci}:${cj}`;
    if (key === this.cellKey) return;
    this.cellKey = key;
    const fish: Skipper[] = [];
    const R = Math.ceil(REACH / CELL);
    for (let i = ci - R; i <= ci + R; i++) {
      for (let j = cj - R; j <= cj + R; j++) {
        const cx = (i + 0.5) * CELL;
        const cz = (j + 0.5) * CELL;
        if (Math.hypot(cx - x, cz - z) > REACH + CELL || !habitat(cx, cz)) continue;
        const n = Math.round(CELL * CELL * DENSITY * DRAWN);
        for (let k = 0; k < n && fish.length < MAX; k++) {
          const fx = i * CELL + hash(i, j, k * 2) * CELL;
          const fz = j * CELL + hash(i, j, k * 2 + 1) * CELL;
          if (!habitat(fx, fz)) continue;
          fish.push({ x: fx, z: fz, heading: hash(i, j, k + 901) * Math.PI * 2, state: 'rest', timer: hash(i, j, k + 501) * 6, fx, fz, tx: fx, tz: fz, t: 0, dur: 1, high: 0, fleeing: 0, size: 0.75 + 0.6 * hash(i, j, k + 301) });
        }
      }
    }
    this.fish = fish;
  }

  /** One step for the mudskippers round the camera: `threats` are where people (or a boat) are. */
  update(dt: number, camera: Vector3, threats: readonly Vector3[]): void {
    if (!nearMud(camera.x, camera.z) || camera.y - terrainHeight(camera.x, camera.z) > 50) {
      this.mesh.count = 0;
      this.cellKey = '';
      return;
    }
    this.populate(camera.x, camera.z);
    const h = Math.min(dt, 1 / 20);
    const level = G.uWaterLevel.value;
    // by night they keep to their burrows
    const night = G.uNight.value > 0.6;
    const lowCamera = camera.y - terrainHeight(camera.x, camera.z) < LOW;
    let shown = 0;
    for (const f of this.fish) {
      const ground = terrainHeight(f.x, f.z);
      const bare = ground > level + 0.02 && ground < level + WET;
      if (night || !bare) {
        // under the water or in for the night: gone, back on the mud a while after it is bare again
        f.state = 'gone';
        f.timer = 2 + this.rng.next() * 6;
        continue;
      }
      f.timer -= h;
      // someone near: skip away, down toward the water
      let threat: Vector3 | null = null;
      for (const p of threats) if (Math.hypot(p.x - f.x, p.z - f.z) < FLIGHT) threat = p;
      if (!threat && lowCamera && Math.hypot(camera.x - f.x, camera.z - f.z) < FLIGHT) threat = camera;
      if (threat && f.state !== 'skip' && f.fleeing === 0) {
        f.fleeing = 2 + Math.floor(this.rng.next() * 3);
        f.heading = Math.atan2(f.x - threat.x, f.z - threat.z) + (this.rng.next() - 0.5) * 0.8;
        f.timer = 0;
      }
      switch (f.state) {
        case 'gone':
          if (f.timer <= 0) {
            f.state = 'rest';
            f.timer = 1 + this.rng.next() * 4;
          }
          break;
        case 'rest':
          if (f.fleeing > 0) this.skip(f, true);
          else if (f.timer <= 0) {
            const r = this.rng.next();
            if (r < 0.35) this.skip(f, false);
            else if (r < 0.8) {
              // a little crawl on the pectorals, turning as it goes
              f.heading += (this.rng.next() - 0.5) * 1.2;
              const d = 0.05 + this.rng.next() * 0.15;
              this.moveTo(f, f.x + Math.sin(f.heading) * d, f.z + Math.cos(f.heading) * d, 0);
              f.state = 'crawl';
              f.dur = d / 0.08;
            } else f.timer = 1 + this.rng.next() * 5;
          }
          break;
        case 'crawl':
        case 'skip': {
          f.t = Math.min(1, f.t + h / f.dur);
          f.x = f.fx + (f.tx - f.fx) * f.t;
          f.z = f.fz + (f.tz - f.fz) * f.t;
          if (f.t >= 1) {
            f.state = 'rest';
            f.timer = 0.5 + this.rng.next() * 3;
            if (f.fleeing > 0) {
              f.fleeing--;
              f.timer = 0.05;
              // into the water at last: gone
              if (f.fleeing === 0 || terrainHeight(f.x, f.z) < level + 0.05) {
                f.fleeing = 0;
                f.state = 'gone';
                f.timer = 8 + this.rng.next() * 12;
                continue;
              }
            }
          }
          break;
        }
      }
      // on the mud, nose a little up while it skips
      const lift = f.state === 'skip' ? Math.sin(Math.PI * f.t) * f.high : 0;
      this.q.setFromAxisAngle(this.up, f.heading);
      if (lift > 0) this.q.multiply(new Quaternion().setFromAxisAngle(this.side, -0.4 * Math.cos(Math.PI * f.t)));
      this.m.compose(this.p.set(f.x, terrainHeight(f.x, f.z) + lift, f.z), this.q, this.s.setScalar(f.size));
      this.mesh.setMatrixAt(shown, this.m);
      shown++;
    }
    this.mesh.count = shown;
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  /** A skip: a flick of the tail throws it a hand or two on, downhill toward the water when fleeing. */
  private skip(f: Skipper, fleeing: boolean): void {
    if (fleeing) {
      // toward the water: down the mud's slope, away from the threat
      const dx = terrainHeight(f.x + 0.5, f.z) - terrainHeight(f.x - 0.5, f.z);
      const dz = terrainHeight(f.x, f.z + 0.5) - terrainHeight(f.x, f.z - 0.5);
      const down = Math.atan2(-dx, -dz);
      f.heading = f.heading + Math.atan2(Math.sin(down - f.heading), Math.cos(down - f.heading)) * 0.5;
    } else f.heading += (this.rng.next() - 0.5) * 2;
    const d = SKIP.far[0] + this.rng.next() * (SKIP.far[1] - SKIP.far[0]) * (fleeing ? 1.4 : 1);
    this.moveTo(f, f.x + Math.sin(f.heading) * d, f.z + Math.cos(f.heading) * d, SKIP.high[0] + this.rng.next() * (SKIP.high[1] - SKIP.high[0]));
    f.state = 'skip';
    f.dur = SKIP.time;
  }

  private moveTo(f: Skipper, x: number, z: number, high: number): void {
    f.fx = f.x;
    f.fz = f.z;
    // only over their mud
    if (!habitat(x, z)) {
      x = f.x;
      z = f.z;
    }
    f.tx = x;
    f.tz = z;
    f.t = 0;
    f.high = high;
  }

  /** How many are made and how many out on the mud, for the debug readout. */
  get counts(): { made: number; out: number } {
    return { made: this.fish.length, out: this.mesh.count };
  }
}
