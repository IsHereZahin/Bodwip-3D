import { Group, InstancedBufferAttribute, InstancedMesh, Matrix4, Mesh, Quaternion, Vector3, type Vector4 } from 'three';
import { G, LAYER_NO_REFLECT } from '../core/globals';
import { clamp, lerp, smoothstep } from '../core/mathx';
import { Rng } from '../core/rng';

import { WATER_LEVEL, meanWaterLevelAt, onLandmark, risenLevel, terrainHeight, waterRise, waterwayAt } from './geography';
import { PETAL_LENGTH, PETAL_TINTS, PETAL_WITHERED, bloomAt, petalGeometry, petalMaterial } from './leaves';
import type { Crown } from './vegetation';
import { INLAND, SHELTERED, waveHeight } from './waves';

// The petals the trees in red flower have let fall (world/leaves.ts lets them fall): lying thick under each crown
// near the camera, more the further the tree is into its flowering, the oldest browning; and afloat on the water
// below it, drifting off on the current until they sink. Each crown's are laid once, its own way: gathered in
// drifts where the most fell and thinning out past the crown's reach, some face down, overlapping, so no two
// trees' look alike. Laying thousands asks the ground for each, so a crown's are laid a little each frame from
// when it comes within reach (and ahead of a film's cut, `warm`), long before it is near enough to show them.
// And the film's one petal (HeroPetal), followed from its bough down to the water.

/** Crowns this near the camera show their fallen petals (m); from FULL on, fewer the farther, none at REACH. */
const REACH = 70;
const FULL = 38;
/** A crown's petals are let go once the camera is this far from it (and laid again if it comes back). */
const KEEP = 170;
/** Side of the cells the crowns are filed in (m). */
const CELL = 40;
/** Petals under a big crown (a rain tree's, 6.7 m across its reach) in full flower: a carpet, thickest in drifts. */
const PER_CROWN = 4800;
const MOST_LYING = 26000;
const MOST_AFLOAT = 2400;
/** Milliseconds a frame for laying petals. */
const LAY_MS = 1.5;
/** Seconds a petal floats before it sinks, waterlogged, drifting on the current meanwhile. */
const AFLOAT_LIFE: readonly [number, number] = [150, 320];
/** On still fresh water the ripples are this share of the open water's waves (as the water shader draws them: waves.ts surfaceShare). */
const RIPPLES = SHELTERED * INLAND;
/**
 * The camera moves this far, or the flowering or the water this much, before the lying petals are put out again
 * (and every so many seconds, sooner while a crown's are still being laid).
 */
const RELAY = { moved: 2, bloom: 0.002, rise: 0.01, seconds: 1, laying: 0.25 };
/** The hero boat's hull as the floating petals keep out of it: half her length, and her half-beam (m). */
const HULL = { half: 4.6, beam: 0.5 };
/**
 * Petals blown onto the water from a crown within `near` m of a waterway's edge gather in the slack water along
 * its bank, within `inset` m of the edge (most close in), along `along` × the crown's reach either way of it.
 */
const BANKED = { near: 9, per: 160, inset: 3.2, along: 1.1 };

/**
 * A crown's petals, laid a few at a time. Lying ones in the order of their rank (the share of the flowering at
 * which each has fallen), so those to show are the first so many: each's matrix, tint, rank and the ground under
 * it (a risen water covers it). Floating ones (AF numbers each): x, z, its water's mean level, the ground there,
 * its drift (x, z, m/s at the full current), life (s), phase, yaw, size, rank, tint.
 */
interface Carpet {
  readonly n: number;
  readonly lying: Float32Array;
  readonly tint: Float32Array;
  readonly rank: Float32Array;
  readonly ground: Float32Array;
  count: number;
  readonly afloat: number[];
  /** Petals tried so far (some fall where none can lie); done at `n`. */
  tried: number;
  readonly rng: Rng;
  readonly drifts: readonly { x: number; z: number; spread: number; weight: number }[];
  readonly total: number;
}
const AF = 12;
const A = { x: 0, z: 1, mean: 2, ground: 3, vx: 4, vz: 5, life: 6, phase: 7, yaw: 8, size: 9, rank: 10, tint: 11 } as const;

export class PetalCarpet {
  readonly group = new Group();
  private readonly lying: InstancedMesh;
  private readonly afloat: InstancedMesh;
  private readonly lyingColor: InstancedBufferAttribute;
  private readonly afloatColor: InstancedBufferAttribute;
  private readonly cells = new Map<number, Crown[]>();
  private readonly carpets = new Map<Crown, Carpet>();
  /** The crowns near the camera now, with how many of their petals show (rank below it). */
  private near: { c: Crown; share: number }[] = [];
  private laidAt = new Vector3(Infinity, 0, 0);
  private laidBloom = -1;
  private laidRise = 0;
  private laidTime = -Infinity;
  private readonly m = new Matrix4();
  private readonly q = new Quaternion();
  private readonly turn = new Quaternion();
  private readonly p = new Vector3();
  private readonly s = new Vector3();
  private readonly normal = new Vector3();
  private readonly axis = new Vector3();
  private readonly up = new Vector3(0, 1, 0);

  constructor(crowns: readonly Crown[]) {
    for (const c of crowns) {
      if (!c.blossom) continue;
      const k = key(Math.floor(c.x / CELL), Math.floor(c.z / CELL));
      let list = this.cells.get(k);
      if (!list) this.cells.set(k, (list = []));
      list.push(c);
    }
    const make = (rows: number, cols: number, most: number, name: string) => {
      const mesh = new InstancedMesh(petalGeometry(rows, cols), petalMaterial(), most);
      mesh.name = name;
      mesh.count = 0;
      mesh.frustumCulled = false;
      mesh.castShadow = false;
      mesh.receiveShadow = true;
      mesh.layers.set(LAYER_NO_REFLECT);
      return mesh;
    };
    // lying flat they need little of their shape; afloat a few are seen close
    this.lying = make(3, 2, MOST_LYING, 'petals lying');
    this.afloat = make(5, 4, MOST_AFLOAT, 'petals afloat');
    this.lyingColor = new InstancedBufferAttribute(new Float32Array(MOST_LYING * 3), 3);
    this.afloatColor = new InstancedBufferAttribute(new Float32Array(MOST_AFLOAT * 3), 3);
    this.lying.instanceColor = this.lyingColor;
    this.afloat.instanceColor = this.afloatColor;
    this.group.name = 'petals';
    this.group.add(this.lying, this.afloat);
  }

  /**
   * Lays the petals round `eye` (again once it has moved, or the flowering or the water has changed), and floats
   * those on the water on for this moment (`t`: the shader clock); `boat`, `heading`: the hero's hull, which they
   * keep out of. `leftEye`: the camera of a shot dissolving away, whose petals stay till it has gone. `all`: lay
   * every near crown's now (a still).
   */
  update(t: number, eye: Vector3, boat: Vector3, heading: number, leftEye: Vector3 | null, all = false): void {
    const until = all ? Infinity : performance.now() + LAY_MS;
    const season = G.uSeasonA.value.z;
    const rise = waterRise();
    // out of the flowering none show, so none are laid (the film lays its spring shots' ahead, `warm`); as it
    // comes on, the few to show first are the first laid
    const flowering = season > 0.02;
    const laying = flowering && (this.layNear(eye, until) || (leftEye !== null && this.layNear(leftEye, until)));
    if (
      all ||
      this.laidAt.distanceTo(eye) > RELAY.moved ||
      Math.abs(season - this.laidBloom) > RELAY.bloom ||
      Math.abs(rise - this.laidRise) > RELAY.rise ||
      t - this.laidTime > (laying ? RELAY.laying : RELAY.seconds)
    ) {
      this.laidAt.copy(eye);
      this.laidBloom = season;
      this.laidRise = rise;
      this.laidTime = t;
      this.near = [];
      if (flowering) {
        const shares = new Map<Crown, number>();
        this.gather(eye, shares);
        if (leftEye) this.gather(leftEye, shares);
        for (const [c, share] of shares) this.near.push({ c, share });
      }
      this.layLying(rise);
      this.letGo(eye, leftEye);
    }
    this.floatOn(t, boat, heading);
  }

  /** Lays what is not laid yet of the crowns that may flower round `at`, until `until` (performance.now()); true once all are. */
  warm(at: Vector3, until: number): boolean {
    return !this.layNear(at, until);
  }

  /** Lays more of the petals of the crowns within reach of `at` until `until`; true while some are still to lay. */
  private layNear(at: Vector3, until: number): boolean {
    const ci = Math.floor(at.x / CELL);
    const cj = Math.floor(at.z / CELL);
    const R = Math.ceil(REACH / CELL);
    for (let i = ci - R; i <= ci + R; i++) {
      for (let j = cj - R; j <= cj + R; j++) {
        for (const c of this.cells.get(key(i, j)) ?? []) {
          if (Math.hypot(c.x - at.x, c.z - at.z) - c.r > REACH) continue;
          const carpet = this.carpetOf(c);
          while (carpet.tried < carpet.n) {
            if ((carpet.tried & 63) === 0 && performance.now() > until) return true;
            this.layOne(c, carpet);
          }
        }
      }
    }
    return false;
  }

  /** The crowns in flower near `eye`, and the share of each's petals to show (the most any eye asks). */
  private gather(eye: Vector3, shares: Map<Crown, number>): void {
    const ci = Math.floor(eye.x / CELL);
    const cj = Math.floor(eye.z / CELL);
    const R = Math.ceil(REACH / CELL);
    for (let i = ci - R; i <= ci + R; i++) {
      for (let j = cj - R; j <= cj + R; j++) {
        for (const c of this.cells.get(key(i, j)) ?? []) {
          const d = Math.hypot(c.x - eye.x, c.z - eye.z) - c.r;
          if (d > REACH || !this.carpets.has(c)) continue;
          const share = bloomAt(c.x, c.z) * (1 - smoothstep(FULL, REACH, d));
          if (share > Math.max(0.002, shares.get(c) ?? 0)) shares.set(c, share);
        }
      }
    }
  }

  /** Lets the petals of crowns far behind go (they are laid again if the camera comes back). */
  private letGo(eye: Vector3, leftEye: Vector3 | null): void {
    for (const c of this.carpets.keys()) {
      const far = Math.min(Math.hypot(c.x - eye.x, c.z - eye.z), leftEye ? Math.hypot(c.x - leftEye.x, c.z - leftEye.z) : Infinity);
      if (far > KEEP) this.carpets.delete(c);
    }
  }

  private layLying(rise: number): void {
    const out = this.lying.instanceMatrix.array as Float32Array;
    const color = this.lyingColor.array as Float32Array;
    let n = 0;
    for (const { c, share } of this.near) {
      const k = this.carpets.get(c);
      if (!k) continue;
      for (let i = 0; i < k.count && k.rank[i] < share && n < MOST_LYING; i++) {
        // none where a risen water has come over the bank
        if (rise > 0 && k.ground[i] < WATER_LEVEL + rise) continue;
        for (let e = 0; e < 16; e++) out[n * 16 + e] = k.lying[i * 16 + e];
        // the first to fall are the oldest, browning
        const age = smoothstep(0.35, 1, 1 - k.rank[i] / share) * 0.85;
        for (let e = 0; e < 3; e++) color[n * 3 + e] = k.tint[i * 3 + e] * lerp(1, PETAL_WITHERED[e], age);
        n++;
      }
    }
    this.lying.count = n;
    this.lying.instanceMatrix.needsUpdate = true;
    this.lyingColor.needsUpdate = true;
  }

  private floatOn(t: number, boat: Vector3, heading: number): void {
    const flow = G.uFlowScale.value;
    const bs = Math.sin(heading);
    const bc = Math.cos(heading);
    let n = 0;
    for (const { c, share } of this.near) {
      const a = this.carpets.get(c)?.afloat;
      if (!a) continue;
      for (let i = 0; i < a.length && n < MOST_AFLOAT; i += AF) {
        if (a[i + A.rank] >= share) continue;
        const level = risenLevel(a[i + A.mean]);
        // where the water has drawn back from it, none
        if (level < a[i + A.ground] + 0.02) continue;
        const life = a[i + A.life];
        const age = (((t / life + a[i + A.phase]) % 1) + 1) % 1;
        const x = a[i + A.x] + a[i + A.vx] * flow * age * life;
        const z = a[i + A.z] + a[i + A.vz] * flow * age * life;
        // none inside the hero's hull
        const along = (x - boat.x) * bs + (z - boat.z) * bc;
        const across = (x - boat.x) * bc - (z - boat.z) * bs;
        if (Math.abs(along) < HULL.half && Math.abs(across) < HULL.beam * Math.sqrt(1 - (along / HULL.half) ** 2) + 0.05) continue;
        // it settles on the water as it comes, and sinks at the last, darkening as it soaks
        const size = a[i + A.size] * smoothstep(0, 0.02, age) * (1 - smoothstep(0.85, 1, age));
        this.p.set(x, level + waveHeight(x, z, t, RIPPLES) + 0.004, z);
        // turning slowly as it goes
        this.q.setFromAxisAngle(this.up, a[i + A.yaw] + age * life * 0.02);
        this.m.compose(this.p, this.q, this.s.setScalar(size));
        this.afloat.setMatrixAt(n, this.m);
        const tint = PETAL_TINTS[a[i + A.tint]];
        const soak = 1 - 0.35 * age;
        this.afloatColor.setXYZ(n, tint[0] * soak, tint[1] * soak, tint[2] * soak);
        n++;
      }
    }
    this.afloat.count = n;
    this.afloat.instanceMatrix.needsUpdate = true;
    this.afloatColor.needsUpdate = true;
  }

  /** A crown's carpet, begun the first time it comes within reach (its floating petals along the bank laid at once). */
  private carpetOf(c: Crown): Carpet {
    let carpet = this.carpets.get(c);
    if (carpet) return carpet;
    const rng = new Rng(Math.floor(Math.abs(c.x * 13.7 + c.z * 7.3)) + 5);
    const n = Math.round(PER_CROWN * Math.min(1.4, (c.r / 6.7) ** 2));
    // drifts where most of them gathered: under the most flowered boughs, in a hollow, against a root
    const drifts = Array.from({ length: rng.int(5, 9) }, () => {
      const a = rng.range(0, Math.PI * 2);
      const d = Math.sqrt(rng.next()) * c.r * 0.95;
      return { x: c.x + Math.cos(a) * d, z: c.z + Math.sin(a) * d, spread: c.r * rng.range(0.06, 0.2), weight: rng.range(0.4, 1) };
    });
    carpet = {
      n,
      lying: new Float32Array(n * 16),
      tint: new Float32Array(n * 3),
      rank: new Float32Array(n),
      ground: new Float32Array(n),
      count: 0,
      afloat: [],
      tried: 0,
      rng,
      drifts,
      total: drifts.reduce((sum, d) => sum + d.weight, 0),
    };
    this.banked(c, rng, carpet.afloat);
    this.carpets.set(c, carpet);
    return carpet;
  }

  /** Lays the carpet's next petal: where it fell, and lying there or afloat. */
  private layOne(c: Crown, k: Carpet): void {
    const rng = k.rng;
    const i = k.tried++;
    // its rank: the share of the flowering by which it has fallen (in order, so those showing are the first)
    const rank = (i + rng.next()) / k.n;
    let x: number;
    let z: number;
    const pick = rng.next();
    if (pick < 0.6) {
      // in a drift
      let w = rng.next() * k.total;
      const d = k.drifts.find((f) => (w -= f.weight) <= 0) ?? k.drifts[0];
      const r = d.spread * Math.sqrt(-2 * Math.log(Math.max(1e-6, rng.next())));
      const a = rng.range(0, Math.PI * 2);
      x = d.x + Math.cos(a) * r;
      z = d.z + Math.sin(a) * r;
    } else {
      // scattered under the crown, thinning past its reach; a few carried well beyond it
      const far = pick > 0.96;
      const r = far ? c.r * rng.range(1, 1.7) : c.r * 1.15 * Math.sqrt(rng.next());
      if (!far && rng.next() < smoothstep(0.7, 1.15, r / c.r) * 0.85) return;
      const a = rng.range(0, Math.PI * 2);
      x = c.x + Math.cos(a) * r;
      z = c.z + Math.sin(a) * r;
    }
    if (onLandmark(x, z)) return;
    const ground = terrainHeight(x, z);
    const mean = meanWaterLevelAt(x, z);
    if (mean > ground + 0.03) {
      floating(k.afloat, x, z, mean, ground, rng);
      return;
    }
    const size = rng.range(PETAL_LENGTH[0], PETAL_LENGTH[1]);
    const shade = rng.range(0.82, 1.08);
    const tint = PETAL_TINTS[rng.int(0, PETAL_TINTS.length - 1)];
    // on the slope of the ground, turned its own way, a little tilted where it curls or rests on another; some face down
    const e = 0.35;
    this.normal.set(ground - terrainHeight(x + e, z), e, ground - terrainHeight(x, z + e)).normalize();
    const q = this.q.setFromUnitVectors(this.up, this.normal);
    q.multiply(this.turn.setFromAxisAngle(this.up, rng.range(0, Math.PI * 2)));
    q.multiply(this.turn.setFromAxisAngle(this.axis.set(rng.range(-1, 1), 0, rng.range(-1, 1)).normalize(), rng.range(0, 0.22)));
    const down = rng.next() < 0.4;
    if (down) q.multiply(this.turn.setFromAxisAngle(this.axis.set(0, 0, 1), Math.PI));
    this.p.set(x, ground + 0.012 + (down ? 0.12 * size : 0), z);
    this.m.compose(this.p, q, this.s.setScalar(size));
    const j = k.count++;
    k.lying.set(this.m.elements, j * 16);
    for (let e3 = 0; e3 < 3; e3++) k.tint[j * 3 + e3] = tint[e3] * shade;
    k.rank[j] = rank;
    k.ground[j] = ground;
  }

  /** The petals a crown near a waterway has let fall on the water, gathered along its bank. */
  private banked(c: Crown, rng: Rng, afloat: number[]): void {
    const w = waterwayAt(c.x, c.z);
    if (!w || w.d - w.half > BANKED.near + c.r) return;
    const way = w.way;
    const s0 = w.s;
    const side = w.side;
    const n = Math.round(BANKED.per * Math.min(1.3, c.r / 6.7) * (1 - smoothstep(c.r, BANKED.near + c.r, w.d - w.half) * 0.7));
    for (let i = 0; i < n; i++) {
      // most below the crown's own stretch of bank, fewer farther along
      const g = Math.sqrt(-2 * Math.log(Math.max(1e-6, rng.next()))) * Math.cos(rng.range(0, Math.PI * 2));
      const s = s0 + g * c.r * BANKED.along * 0.6;
      const inset = 0.2 + BANKED.inset * rng.next() ** 2;
      const p = way.beside(s, side, way.half(s) - inset);
      const ground = terrainHeight(p.x, p.z);
      const mean = meanWaterLevelAt(p.x, p.z);
      if (!(mean > ground + 0.05)) continue;
      floating(afloat, p.x, p.z, mean, ground, rng);
    }
  }
}

/** Its floating petal at (x, z), drifting down the waterway at the current there (slower toward the banks). */
function floating(out: number[], x: number, z: number, mean: number, ground: number, rng: Rng): void {
  const w = waterwayAt(x, z);
  let vx = 0;
  let vz = 0;
  if (w && w.d < w.half) {
    const at = w.way.at(w.s);
    const speed = w.way.current * Math.max(0, 1 - (w.d / w.half) ** 2);
    vx = Math.sin(at.heading) * speed;
    vz = Math.cos(at.heading) * speed;
  }
  const size = rng.range(PETAL_LENGTH[0], PETAL_LENGTH[1]) * rng.range(0.82, 1.08);
  out.push(x, z, mean, ground, vx, vz, rng.range(AFLOAT_LIFE[0], AFLOAT_LIFE[1]), rng.next(), rng.range(0, Math.PI * 2), size, rng.next(), rng.int(0, PETAL_TINTS.length - 1));
}

function key(i: number, j: number): number {
  return (i + 4096) * 8192 + (j + 4096);
}

/** The film's petal: a little longer than most (m), so it reads from across the water. */
const HERO_LENGTH = 0.072;
/** Its path is worked out at this many steps a second. */
const PATH_RATE = 60;
/** Seconds it takes to come down from its bough to the water: about half a metre a second, as a petal falls. */
const HERO_FALL = 9.5;
/** Its swing from side to side as it falls: radians a second, and how far (m). */
const SWING = { rate: (Math.PI * 2) / 1.45, reach: 0.17 };
/** How far into the water from the bank it may come down (m), and how far the air carries it on the way (m). */
const INTO: readonly [number, number] = [2.6, 4.2];
const CARRIED: readonly [number, number] = [0.6, 9.5];

/**
 * The film's petal: one let go from the lower edge of a crown in flower over the water, carried down the wind
 * as a petal falls (swinging from side to side, tipping up at each end of its swing, turning, twice tumbling
 * over), slowing and levelling out as it nears the water, touching it with a train of fine ripples (the water
 * shader's `uTouch`), and floating off on the current. Its whole way is worked out when it is aimed, so the film's
 * camera can follow it (`at`, `slowAt`) and a still shows where it is, and its ripples, at any moment of the shot.
 */
export class HeroPetal {
  readonly mesh: Mesh;
  /** Where it leaves its bough, and where it comes down on the water (once aimed). */
  readonly from = new Vector3();
  readonly to = new Vector3();
  /** Seconds from its bough to the water. */
  fall = HERO_FALL;
  /** Its way down: per step, its place and its turn (x y z, qx qy qz qw). */
  private path = new Float32Array(7);
  private steps = 1;
  /** Afloat: the mean level of the water it came down on, how it drifts (m/s), and its turn as it touched. */
  private mean = 0;
  private readonly drift = new Vector3();
  private landYaw = 0;
  /** The shader clock at the moment it leaves its bough; NaN until cued. */
  private start = Number.NaN;
  /** The water's `uTouch`, which it sets as it comes down. */
  private readonly touch: Vector4;
  private readonly crown = new Vector3();
  private reach = 4;
  private readonly q = new Quaternion();
  private readonly q2 = new Quaternion();
  private readonly v = new Vector3();
  private readonly axis = new Vector3();

  constructor(touch: Vector4) {
    this.touch = touch;
    this.mesh = new Mesh(petalGeometry(12, 8), petalMaterial());
    this.mesh.name = 'petal';
    this.mesh.scale.setScalar(HERO_LENGTH);
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = true;
    this.mesh.visible = false;
  }

  /**
   * Picks its bough in the crown whose middle is `crown` (reach `reach`) and works out its way down to the water
   * by it, with the wind as it blows now: a bough on the crown's lower edge from which the wind carries it a
   * metre or three out over the water.
   */
  aim(crown: Vector3, reach: number): void {
    this.crown.copy(crown);
    this.reach = reach;
    const w = waterwayAt(crown.x, crown.z);
    if (!w) return;
    const mid = w.way.at(w.s);
    // toward the water's middle from the crown's side of it, and how far from the crown its bank is
    const ux = -Math.cos(mid.heading) * w.side;
    const uz = Math.sin(mid.heading) * w.side;
    const bank = w.d - w.half;
    const half = w.half;
    const wind = G.uWind.value;
    const wl = Math.hypot(wind.x, wind.y) || 1;
    const wx = wind.x / wl;
    const wz = wind.y / wl;
    let best = -Infinity;
    for (let into = INTO[0]; into <= Math.min(INTO[1], half); into += 0.4) {
      for (let carried = CARRIED[0]; carried <= CARRIED[1]; carried += 0.2) {
        const lx = crown.x + ux * (bank + into);
        const lz = crown.z + uz * (bank + into);
        const sx = lx - wx * carried;
        const sz = lz - wz * carried;
        const out = Math.hypot(sx - crown.x, sz - crown.z) / reach;
        if (out > 0.88 || out < 0.35) continue;
        // from the crown's outer edge, over the water if it can be, carried no farther than it must be
        const over = meanWaterLevelAt(sx, sz) > terrainHeight(sx, sz) ? 1 : 0;
        const score = -Math.abs(out - 0.75) * 2 - Math.max(0, carried - 2.5) * 0.3 + over;
        if (score > best) {
          best = score;
          this.from.set(sx, 0, sz);
          this.to.set(lx, 0, lz);
        }
      }
    }
    if (!Number.isFinite(best)) {
      // the wind blows in off the water: it slips out from under the crown's edge in the lee all the same
      this.from.set(crown.x + ux * 0.78 * reach, 0, crown.z + uz * 0.78 * reach);
      this.to.set(crown.x + ux * (bank + 1.8), 0, crown.z + uz * (bank + 1.8));
    }
    this.from.y = crown.y - 0.12 * reach;
    this.mean = meanWaterLevelAt(this.to.x, this.to.z);
    if (!Number.isFinite(this.mean)) this.mean = WATER_LEVEL;
    this.to.y = risenLevel(this.mean);
    this.build(wx, wz);
  }

  /** Works out its way down from `from` to `to`, and how it drifts afloat. */
  private build(wx: number, wz: number): void {
    const rng = new Rng(Math.floor(Math.abs(this.from.x * 3.1 + this.from.z * 5.7)) + 3);
    const phase0 = rng.range(0, Math.PI * 2);
    const swing0 = rng.range(0, Math.PI * 2);
    const yaw0 = rng.range(0, Math.PI * 2);
    const top = this.from.y;
    const water = this.to.y;
    // its height step by step: it sinks fastest at the bottom of each swing, slowly as it tips up at the ends,
    // and settles slowly near the water; its pace found so it comes down in HERO_FALL seconds
    let sink = (top - water) / HERO_FALL;
    let ys: number[] = [];
    for (let pass = 0; pass < 4; pass++) {
      ys = [top];
      let y = top;
      for (let k = 0; y > water && k < PATH_RATE * 40; k++) {
        const phi = SWING.rate * (k / PATH_RATE) + phase0;
        const near = smoothstep(0.8, 0, y - water);
        y -= (sink * (1 + 0.5 * Math.cos(2 * phi)) * (1 - 0.62 * near)) / PATH_RATE;
        ys.push(Math.max(y, water));
      }
      sink *= (ys.length - 1) / PATH_RATE / HERO_FALL;
    }
    this.steps = ys.length;
    this.fall = (ys.length - 1) / PATH_RATE;
    const F = this.fall;
    this.path = new Float32Array(this.steps * 7);
    const up = new Vector3(0, 1, 0);
    const long = new Vector3(0, 0, 1);
    const perp = new Vector3();
    const q = new Quaternion();
    const turn = new Quaternion();
    for (let k = 0; k < this.steps; k++) {
      const tau = k / PATH_RATE;
      const y = ys[k];
      const near = smoothstep(0.8, 0, y - water);
      const phi = SWING.rate * tau + phase0;
      // carried out by the air, slowly at first under the crown, then with the breeze
      const f = clamp(tau / F, 0, 1);
      const carried = 0.35 * f + 0.65 * f * f * (3 - 2 * f);
      const psi = swing0 + 0.3 * tau;
      const reach = SWING.reach * (1 - 0.8 * near) * Math.sin(phi);
      const x = lerp(this.from.x, this.to.x, carried) + Math.cos(psi) * reach;
      const z = lerp(this.from.z, this.to.z, carried) + Math.sin(psi) * reach;
      // turning slowly; tipping up at each end of its swing; tumbling over twice high up; flat as it comes down
      const yaw = yaw0 + 0.55 * tau + 0.45 * Math.sin(0.8 * tau + 1);
      const tip = 0.7 * Math.sin(phi) * (1 - 0.9 * near);
      const tumble = Math.PI * 2 * (smoothstep(0.2 * F, 0.29 * F, tau) + smoothstep(0.52 * F, 0.61 * F, tau));
      perp.set(-Math.sin(psi), 0, Math.cos(psi));
      q.setFromAxisAngle(perp, tip).multiply(turn.setFromAxisAngle(up, yaw)).multiply(turn.setFromAxisAngle(long, tumble));
      this.path.set([x, y, z, q.x, q.y, q.z, q.w], k * 7);
      if (k === this.steps - 1) this.landYaw = yaw;
    }
    const last = (this.steps - 1) * 7;
    this.to.set(this.path[last], water, this.path[last + 2]);
    // afloat it goes with the current where it came down, and a breath of the wind
    const w = waterwayAt(this.to.x, this.to.z);
    this.drift.set(wx * 0.02, 0, wz * 0.02);
    if (w && w.d < w.half) {
      const at = w.way.at(w.s);
      const speed = w.way.current * G.uFlowScale.value * Math.max(0, 1 - (w.d / w.half) ** 2);
      this.drift.x += Math.sin(at.heading) * speed;
      this.drift.z += Math.cos(at.heading) * speed;
    }
  }

  /** Lets it go `at` seconds ago (negative: so long before it leaves its bough), aimed afresh with the wind now. */
  cue(t: number, at: number): void {
    this.aim(this.crown, this.reach);
    this.start = t - at;
  }

  /** Where it is `tau` seconds after leaving its bough, and how it is turned (still on its bough before, afloat after). */
  at(tau: number, out: Vector3, turn?: Quaternion): Vector3 {
    if (tau > this.fall) {
      const s = tau - this.fall;
      out.copy(this.to).addScaledVector(this.drift, s);
      out.y = risenLevel(this.mean);
      turn?.setFromAxisAngle(this.axis.set(0, 1, 0), this.landYaw + 0.06 * s);
      return out;
    }
    const f = clamp(tau, 0, this.fall) * PATH_RATE;
    const k = Math.min(this.steps - 2, Math.floor(f));
    if (k < 0) {
      // (a path of one step: not aimed yet)
      out.set(this.path[0], this.path[1], this.path[2]);
      return out;
    }
    const e = f - k;
    const a = k * 7;
    const b = a + 7;
    const P = this.path;
    out.set(lerp(P[a], P[b], e), lerp(P[a + 1], P[b + 1], e), lerp(P[a + 2], P[b + 2], e));
    if (turn) turn.set(P[a + 3], P[a + 4], P[a + 5], P[a + 6]).slerp(this.q2.set(P[b + 3], P[b + 4], P[b + 5], P[b + 6]), e);
    return out;
  }

  /** Its way without its swing (where a camera following it keeps it), at `tau`. */
  slowAt(tau: number, out: Vector3): Vector3 {
    if (tau <= 0 || tau >= this.fall) return this.at(tau, out);
    const f = tau / this.fall;
    const carried = 0.35 * f + 0.65 * f * f * (3 - 2 * f);
    const y = this.at(tau, this.v).y;
    return out.set(lerp(this.from.x, this.to.x, carried), y, lerp(this.from.z, this.to.z, carried));
  }

  /**
   * Puts it where it is now (`t`: the shader clock); `eye`: the camera, beyond whose sight it is let be (and
   * `leftEye`, a shot's dissolving away).
   */
  update(t: number, eye: Vector3, leftEye: Vector3 | null): void {
    if (Number.isNaN(this.start)) return;
    const tau = t - this.start;
    const m = this.mesh;
    this.at(tau, m.position, m.quaternion);
    if (tau < 0) {
      // trembling on its bough in the breeze, about to go
      m.quaternion.multiply(this.q.setFromAxisAngle(this.axis.set(1, 0, 0), 0.14 * Math.sin(t * 9.3) * (0.5 + 0.5 * Math.sin(t * 2.1))));
    } else if (tau > this.fall) {
      // on the water it rides the ripples, dipping as it touches and bobbing back
      const s = tau - this.fall;
      m.position.y += waveHeight(m.position.x, m.position.z, t, RIPPLES) + 0.004 - 0.006 * Math.exp(-2.5 * s) * Math.cos(9 * s);
    }
    // the ripples it makes as it touches, for their few seconds
    if (tau >= this.fall && tau < this.fall + 5) this.touch.set(this.to.x, this.to.z, tau - this.fall, 1);
    else this.touch.w = 0;
    m.visible = tau < this.fall + 150 && Math.min(m.position.distanceTo(eye), leftEye ? m.position.distanceTo(leftEye) : Infinity) < 150;
  }
}
