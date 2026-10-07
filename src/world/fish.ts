import { BufferAttribute, BufferGeometry, Color, DoubleSide, Group, InstancedBufferAttribute, InstancedMesh, Matrix4, MeshStandardMaterial, Quaternion, Vector3 } from 'three';
import { LAYER_NO_REFLECT } from '../core/globals';
import { angleDelta, clamp, smoothstep } from '../core/mathx';
import { Rng } from '../core/rng';
import { sendFirst } from '../render/instancing';
import { patchMaterial } from '../render/patch';
import { PONDS, pondReach, saltLocal, saltPoint, terrainHeight, waterLevelAt, type Pond } from './geography';
import { SALT_FIELDS, type SaltFarm } from './plan';
import type { Ripples } from './ripples';

// Fish in the waters round the camera, each swimming as fish do: a few beats of the tail and a glide, turning
// with the body (bent along its length into the turn), keeping with its school (close to its mates, along
// with them, never into them), wandering, turning back from the shallows and the banks, scattering from the
// boat. Small schools of puti cruise a little under the surface of the river and the khals; a rui or two keep
// deeper and slower. The ponds keep their own: rui, tilapia and sharputi; the pond the village keeps clean (the
// mosque's) many more (`KEPT_STOCK`): shoals of little sharputi near the top, schools of red tilapia and of
// golden and silver fish that drift apart to feed and gather again, tilapia alone, and a few big rui and katla
// keeping deep. The pond's fish rise now and then to sip at the surface. In the rains the salt farms, kept as
// ghers, have theirs: schools of little sharputi and puti in the shallow water over the drowned beds, turning
// back from the embankments, rising to sip.
// Now and then one leaps clear and falls back. What they do to the surface (a leap, a sip, a sharp turn just
// under it) rings the water (world/ripples.ts). Seen through the water they are dim shapes, as fish are (they
// go through patchMaterial, so the water tints them). Only round the camera, so they cost the same anywhere.

/** The open waters' schools and how many in each, and the big fish keeping deeper. */
const SCHOOLS = 7;
const PER_SCHOOL = 9;
const BIG = 3;
/** Fish stay this near the camera (m); a school farther off is moved to fresh water by it. */
const REACH = 45;
/** Ponds this near the camera have their fish (m). */
const POND_REACH = 70;
/** The least depth a fish keeps to (m). */
const DEEP = 0.45;
/** How near the boat comes before fish scatter (m). */
const SHY = 7;
/** Seconds between leaps, at least and at most. */
const LEAP_EVERY: [number, number] = [3, 10];

/** How fish of each kind look and swim: length (m), colours (back, belly), their pace (m/s cruising), how near the surface. */
interface Kind {
  length: [number, number];
  back: string[];
  belly: string;
  cruise: number;
  depth: [number, number];
}
const KINDS = {
  puti: { length: [0.11, 0.16], back: ['#4b5a52', '#56604f'], belly: '#d6d8cf', cruise: 0.35, depth: [0.15, 0.45] },
  rui: { length: [0.32, 0.45], back: ['#3a4640', '#454b3e'], belly: '#b9bcae', cruise: 0.22, depth: [0.5, 1.1] },
  tilapia: { length: [0.16, 0.24], back: ['#46504a', '#5a5f55'], belly: '#b8bab0', cruise: 0.22, depth: [0.2, 0.7] },
  // the kept pond's: little silver sharputi and puti near the top, red tilapia, golden and silver fish, and the
  // big rui and katla, olive-grey above
  shoal: { length: [0.07, 0.11], back: ['#c4c8c6', '#b9bdb4', '#cfc7b2'], belly: '#eceae2', cruise: 0.3, depth: [0.1, 0.35] },
  red: { length: [0.18, 0.27], back: ['#cf6a45', '#d97a4a', '#c55a3c', '#d88a5a'], belly: '#f0e0d4', cruise: 0.2, depth: [0.25, 0.7] },
  bright: { length: [0.15, 0.24], back: ['#d9a648', '#c9cdd0', '#e2dccf', '#b9b7a8'], belly: '#f0e6da', cruise: 0.22, depth: [0.2, 0.6] },
  big: { length: [0.5, 0.75], back: ['#55594e', '#4a5048', '#625e52'], belly: '#c2c2b4', cruise: 0.15, depth: [0.7, 1.4] },
} satisfies Record<string, Kind>;

/** The kept pond's fish: what kind, how many, and whether they keep together as a school. */
const KEPT_STOCK: { kind: Kind; n: number; school: boolean }[] = [
  { kind: KINDS.shoal, n: 12, school: true },
  { kind: KINDS.shoal, n: 12, school: true },
  { kind: KINDS.red, n: 10, school: true },
  { kind: KINDS.bright, n: 8, school: true },
  { kind: KINDS.tilapia, n: 6, school: false },
  { kind: KINDS.big, n: 5, school: false },
];
/** The pond schools' numbers start here (the open waters' are 0 up), and the ghers' here. */
const POND_SCHOOL = 1000;
const GHER_SCHOOL = 2000;
/** A gher's schools in the rains, and how near the camera a gher has its fish (m, from its middle, past its half-length). */
const GHER_STOCK: { kind: Kind; n: number }[] = [
  { kind: KINDS.shoal, n: 10 },
  { kind: KINDS.shoal, n: 8 },
  { kind: KINDS.puti, n: 7 },
];
const GHER_REACH = 90;
/** Room for the open waters' fish, the kept pond's, the other ponds' near the camera, two ghers' and the leaps. */
const MOST = SCHOOLS * PER_SCHOOL + BIG + KEPT_STOCK.reduce((s, g) => s + g.n, 0) + 2 * GHER_STOCK.reduce((s, g) => s + g.n, 0) + 48;

/**
 * A fish 1 m long along +z (scaled down per fish), its head at z ½: a deep spindle body, its back darker than its
 * belly (white here: the colours are per fish), a dorsal fin and a forked tail. Its body is bent in the vertex
 * shader (`SWIM`), so it is cut finely along its length.
 */
export function fishGeometry(): BufferGeometry {
  const pos: number[] = [];
  const col: number[] = [];
  const ring = 8;
  const rows = 12;
  const shade = (y: number, r: number) => 0.55 + 0.45 * smoothstep(r, -r, y);
  for (let i = 0; i <= rows; i++) {
    const t = i / rows;
    const z = 0.5 - t * 0.84;
    const r = Math.sin(Math.PI * Math.min(1, t * 1.02 + 0.03)) ** 0.8 * 0.1 * (1 - 0.35 * t);
    for (let k = 0; k < ring; k++) {
      const a = (k / ring) * Math.PI * 2;
      const y = Math.cos(a) * r * 1.3;
      pos.push(Math.sin(a) * r * 0.5, y, z);
      const c = shade(y, r);
      col.push(c, c, c);
    }
  }
  const idx: number[] = [];
  for (let i = 0; i < rows; i++) {
    for (let k = 0; k < ring; k++) {
      const a = i * ring + k;
      const b = i * ring + ((k + 1) % ring);
      idx.push(a, a + ring, b, b, a + ring, b + ring);
    }
  }
  const fin = (pts: number[], c: number) => {
    const base = pos.length / 3;
    pos.push(...pts);
    for (let k = 0; k < pts.length / 3; k++) col.push(c, c, c);
    idx.push(base, base + 1, base + 2);
  };
  // the tail's fork, and the dorsal fin along the back
  fin([0, 0, -0.3, 0, 0.15, -0.5, 0, 0.0, -0.42], 0.6);
  fin([0, 0, -0.3, 0, 0.0, -0.42, 0, -0.14, -0.5], 0.6);
  fin([0, 0.12, 0.12, 0, 0.19, -0.02, 0, 0.09, -0.14], 0.55);
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('color', new BufferAttribute(new Float32Array(col), 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/**
 * The swimming body, in the vertex shader: the body swings from side to side in a wave running back along it,
 * hardly at the head and most at the tail (`aSwim.x` the wave's phase, `.y` how far, as a share of the length),
 * and bends along its length into a turn (`.z`).
 */
const SWIM = {
  key: 'fish-swim',
  pars: 'attribute vec4 aSwim;\n',
  code: /* glsl */ `
  {
    float s = clamp((0.5 - transformed.z) / 1.0, 0.0, 1.0);
    transformed.x += aSwim.y * (0.05 + 0.95 * s * s) * sin(5.7 * s - aSwim.x) + aSwim.z * s * s;
  }`,
};

interface Swimmer {
  kind: Kind;
  p: Vector3;
  heading: number;
  speed: number;
  /** How fast it turns now (rad/s), and the way it wants to go. */
  turn: number;
  goal: number;
  /** Beating its tail till `burst`, then gliding till `glide` (s on the clock). */
  burst: number;
  glide: number;
  /** Its tail's beat so far (rad). */
  beat: number;
  depth: number;
  size: number;
  color: Color;
  /** Its school (its index), or −1 alone; in a pond, which. */
  school: number;
  pond: Pond | null;
  /** In a salt farm's gher, which. */
  farm: SaltFarm | null;
  /** When it next looks ahead for shallows, and when it next rises to sip the surface (s). */
  look: number;
  sip: number;
  /** Where its school wanders (the open waters' schools share one). */
  wander: number;
}

interface Leap {
  from: Vector3;
  dir: number;
  t: number;
  dur: number;
  height: number;
  length: number;
}

export class Fish {
  readonly group = new Group();
  private readonly mesh: InstancedMesh;
  private readonly swim: InstancedBufferAttribute;
  private readonly colors: InstancedBufferAttribute;
  private readonly swimmers: Swimmer[] = [];
  /** The open waters' schools: where each is, and whether it is in the water (NaN: to be placed). */
  private readonly schools: { c: Vector3; heading: number }[] = [];
  /** The ponds whose fish are out now, and the ghers'. */
  private readonly stocked = new Set<Pond>();
  private readonly ghers = new Set<SaltFarm>();
  private readonly leaps: Leap[] = [];
  private readonly rng = new Rng(77);
  private readonly ripples: Ripples;
  private nextLeap = 4;
  private clock = 0;
  // scratch for posing each frame
  private readonly m = new Matrix4();
  private readonly q = new Quaternion();
  private readonly qPitch = new Quaternion();
  private readonly p = new Vector3();
  private readonly scale = new Vector3();
  private static readonly UP = new Vector3(0, 1, 0);
  private static readonly ACROSS = new Vector3(1, 0, 0);

  constructor(ripples: Ripples) {
    this.ripples = ripples;
    this.group.name = 'fish';
    const geometry = fishGeometry();
    this.swim = new InstancedBufferAttribute(new Float32Array(MOST * 4), 4);
    geometry.setAttribute('aSwim', this.swim);
    // (the sky's light reaches them only diffusely through the water: with the sky's reflection on them they
    // swam as blue streaks)
    const material = patchMaterial(new MeshStandardMaterial({ vertexColors: true, roughness: 0.62, metalness: 0, envMapIntensity: 0.15, side: DoubleSide }), { vertex: SWIM });
    this.mesh = new InstancedMesh(geometry, material, MOST);
    this.colors = new InstancedBufferAttribute(new Float32Array(MOST * 3), 3);
    this.mesh.instanceColor = this.colors;
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.layers.set(LAYER_NO_REFLECT);
    this.mesh.count = 0;
    this.group.add(this.mesh);
    for (let i = 0; i < SCHOOLS; i++) {
      this.schools.push({ c: new Vector3(Number.NaN, 0, 0), heading: 0 });
      for (let k = 0; k < PER_SCHOOL; k++) this.swimmers.push(this.spawn(KINDS.puti, i, null));
    }
    for (let k = 0; k < BIG; k++) this.swimmers.push(this.spawn(KINDS.rui, -1, null));
  }

  private spawn(kind: Kind, school: number, pond: Pond | null, farm: SaltFarm | null = null): Swimmer {
    const r = this.rng;
    return {
      kind,
      p: new Vector3(Number.NaN, 0, 0),
      heading: r.range(0, Math.PI * 2),
      speed: kind.cruise,
      turn: 0,
      goal: Number.NaN,
      burst: 0,
      glide: 0,
      beat: r.range(0, Math.PI * 2),
      depth: r.range(kind.depth[0], kind.depth[1]),
      size: r.range(kind.length[0], kind.length[1]),
      color: new Color(r.pick(kind.back)).multiplyScalar(r.range(0.9, 1.1)),
      school,
      pond,
      farm,
      look: 0,
      sip: r.range(6, 30),
      wander: r.range(0, 100),
    };
  }

  /** How deep the water is at (x, z) (m), or 0 on land. */
  private depthAt(x: number, z: number): number {
    const level = waterLevelAt(x, z);
    return Number.isFinite(level) ? Math.max(0, level - terrainHeight(x, z)) : 0;
  }

  /** A place for an open-water school: water deep enough within reach of `eye` (and not a pond), or false. */
  private placeSchool(i: number, eye: Vector3): boolean {
    const s = this.schools[i];
    for (let k = 0; k < 12; k++) {
      const a = this.rng.range(0, Math.PI * 2);
      const d = this.rng.range(6, REACH * 0.85);
      const x = eye.x + Math.cos(a) * d;
      const z = eye.z + Math.sin(a) * d;
      if (this.depthAt(x, z) < DEEP + 0.4 || PONDS.some((p) => pondReach(p, x, z) < 1.3)) continue;
      s.c.set(x, waterLevelAt(x, z), z);
      s.heading = this.rng.range(0, Math.PI * 2);
      for (const f of this.swimmers) {
        if (f.school !== i) continue;
        f.p.set(x + this.rng.range(-1.2, 1.2), 0, z + this.rng.range(-1.2, 1.2));
        f.heading = s.heading + this.rng.range(-0.3, 0.3);
      }
      return true;
    }
    return false;
  }

  /** The ponds within reach of `eye` have their fish; those left behind lose theirs. */
  private stock(eye: Vector3): void {
    for (const pond of PONDS) {
      const near = Math.hypot(pond.x - eye.x, pond.z - eye.z) < POND_REACH;
      if (near === this.stocked.has(pond)) continue;
      if (!near) {
        this.stocked.delete(pond);
        for (let i = this.swimmers.length - 1; i >= 0; i--) if (this.swimmers[i].pond === pond) this.swimmers.splice(i, 1);
        continue;
      }
      this.stocked.add(pond);
      if (pond.kept) {
        for (const [i, g] of KEPT_STOCK.entries()) {
          // a school starts together, about one place, and wanders as one (each a little its own way)
          const at = this.pondPlace(pond, 0.45);
          const wander = this.rng.range(0, 100);
          for (let k = 0; k < g.n; k++) {
            const f = this.spawn(g.kind, g.school ? POND_SCHOOL + i : -1, pond);
            if (g.school) {
              f.p.set(at.x + this.rng.range(-0.8, 0.8), 0, at.z + this.rng.range(-0.8, 0.8));
              f.wander = wander + this.rng.range(-0.3, 0.3);
            } else f.p.copy(this.pondPlace(pond, 0.5));
            this.swimmers.push(f);
          }
        }
        continue;
      }
      const n = Math.round(clamp(pond.r * 0.5, 3, 7));
      for (let k = 0; k < n; k++) {
        const f = this.spawn(k % 3 === 0 ? KINDS.rui : KINDS.tilapia, -1, pond);
        f.p.copy(this.pondPlace(pond, 0.5));
        this.swimmers.push(f);
      }
    }
  }

  /**
   * The salt farms' ghers within reach of `eye` have their fish while the rains stand in them (a hand's breadth
   * over the beds at least); those left behind, or drained for the salt work, lose theirs.
   */
  private stockGhers(eye: Vector3): void {
    SALT_FIELDS.forEach((farm, fi) => {
      const middle = saltPoint(farm.w * 0.5, farm.d * 0.5, farm);
      const flooded = waterLevelAt(middle.x, middle.z) - terrainHeight(middle.x, middle.z) > 0.12;
      const near = flooded && Math.hypot(farm.x - eye.x, farm.z - eye.z) < GHER_REACH + farm.w / 2;
      if (near === this.ghers.has(farm)) return;
      if (!near) {
        this.ghers.delete(farm);
        for (let i = this.swimmers.length - 1; i >= 0; i--) if (this.swimmers[i].farm === farm) this.swimmers.splice(i, 1);
        return;
      }
      this.ghers.add(farm);
      GHER_STOCK.forEach((g, i) => {
        // each school about one place over the beds, well in from the embankment
        const m = farm.rimInset + 3;
        const at = saltPoint(this.rng.range(m, farm.w - m), this.rng.range(m, farm.d - m), farm);
        const wander = this.rng.range(0, 100);
        for (let k = 0; k < g.n; k++) {
          const f = this.spawn(g.kind, GHER_SCHOOL + fi * 8 + i, null, farm);
          f.p.set(at.x + this.rng.range(-0.8, 0.8), 0, at.z + this.rng.range(-0.8, 0.8));
          f.wander = wander + this.rng.range(-0.3, 0.3);
          f.depth = Math.min(f.depth, 0.16);
          this.swimmers.push(f);
        }
      });
    });
  }

  /** Somewhere in `pond` within `share` of its reach from its middle (a fresh vector). */
  private pondPlace(pond: Pond, share: number): Vector3 {
    const a = this.rng.range(0, Math.PI * 2);
    const d = this.rng.range(0, share) * pond.r;
    return new Vector3(pond.x + Math.cos(a) * d, 0, pond.z + Math.sin(a) * d);
  }

  update(dt: number, t: number, eye: Vector3, boat: Vector3): void {
    if (dt <= 0) return;
    this.clock += dt;
    this.stock(eye);
    this.stockGhers(eye);
    for (let i = 0; i < this.schools.length; i++) {
      const s = this.schools[i];
      if (Number.isNaN(s.c.x) || Math.hypot(s.c.x - eye.x, s.c.z - eye.z) > REACH) {
        if (!this.placeSchool(i, eye)) s.c.x = Number.NaN;
      }
    }
    // each school's middle and way, for its fish to keep with
    const mid = new Map<number, { x: number; z: number; hx: number; hz: number; n: number }>();
    for (const f of this.swimmers) {
      if (f.school < 0 || Number.isNaN(f.p.x)) continue;
      const e = mid.get(f.school) ?? { x: 0, z: 0, hx: 0, hz: 0, n: 0 };
      e.x += f.p.x;
      e.z += f.p.z;
      e.hx += Math.sin(f.heading);
      e.hz += Math.cos(f.heading);
      e.n++;
      mid.set(f.school, e);
    }
    let n = 0;
    for (const f of this.swimmers) {
      if (n >= MOST) break;
      if (f.school >= 0 && f.school < POND_SCHOOL && Number.isNaN(this.schools[f.school].c.x)) continue;
      if (Number.isNaN(f.p.x)) {
        // a big fish alone: somewhere deep near the camera
        if (f.school >= 0) continue;
        const a = this.rng.range(0, Math.PI * 2);
        const d = this.rng.range(8, REACH * 0.8);
        const x = eye.x + Math.cos(a) * d;
        const z = eye.z + Math.sin(a) * d;
        if (this.depthAt(x, z) < 1.2 || PONDS.some((p) => pondReach(p, x, z) < 1.3)) continue;
        f.p.set(x, 0, z);
      }
      if (!f.pond && !f.farm && Math.hypot(f.p.x - eye.x, f.p.z - eye.z) > REACH * 1.2) {
        f.p.x = Number.NaN;
        continue;
      }
      this.steer(f, dt, t, boat, mid.get(f.school));
      const level = waterLevelAt(f.p.x, f.p.z);
      // stranded (the season's water drawn back from under it): placed afresh (−∞ would reach the GPU as NaN)
      if (!Number.isFinite(level)) {
        f.p.x = Number.NaN;
        continue;
      }
      const room = Math.max(0.08, level - terrainHeight(f.p.x, f.p.z) - 0.12);
      // rising to sip the surface now and then (the pond's fish), each sip a little ring
      let depth = Math.min(f.depth, room);
      if (f.pond || f.farm) {
        const s = this.clock - f.sip;
        if (s > 0) {
          depth *= 1 - Math.sin(Math.PI * Math.min(1, s / 1.6)) * 0.9;
          if (s > 0.8 && s - dt <= 0.8) this.ripples.drop(f.p.x + Math.sin(f.heading) * f.size * 0.5, f.p.z + Math.cos(f.heading) * f.size * 0.5, 0.06, 0.002);
          if (s > 1.6) f.sip = this.clock + this.rng.range(8, 35);
        }
      }
      f.p.y = level - depth;
      this.q.setFromAxisAngle(Fish.UP, f.heading);
      this.m.compose(f.p, this.q, this.scale.setScalar(f.size));
      this.mesh.setMatrixAt(n, this.m);
      // its tail beats faster in a burst; its body bends into the turn
      const thrust = this.clock < f.burst ? 1 : 0.15;
      f.beat += dt * Math.PI * 2 * (1.1 + 2.6 * thrust) * Math.sqrt(0.2 / f.size);
      this.swim.setXYZW(n, f.beat, 0.06 + 0.05 * thrust, clamp(-f.turn * 0.12, -0.18, 0.18), 0);
      this.colors.setXYZ(n, f.color.r, f.color.g, f.color.b);
      n++;
    }
    n = this.leap(dt, eye, n);
    this.mesh.count = n;
    sendFirst(n, this.mesh.instanceMatrix, this.swim, this.colors);
  }

  /** Where a fish goes this frame: its school, its wandering, the shallows and the banks, the boat. */
  private steer(f: Swimmer, dt: number, t: number, boat: Vector3, school?: { x: number; z: number; hx: number; hz: number; n: number }): void {
    // a few beats of the tail, then a glide
    if (this.clock > f.glide) {
      f.burst = this.clock + this.rng.range(0.6, 1.5);
      f.glide = f.burst + this.rng.range(1.0, 3.2);
    }
    const thrust = this.clock < f.burst ? 1 : 0;
    let gx = Math.sin(f.wander + t * 0.13) * 0.6 + Math.sin(f.wander * 1.7 + t * 0.31) * 0.4;
    let gz = Math.cos(f.wander * 0.7 + t * 0.11) * 0.6 + Math.cos(f.wander * 2.3 + t * 0.27) * 0.4;
    // with its school: toward its middle and along its way (a pond's schools drift apart to feed now and then,
    // and gather again)
    if (school && school.n > 1) {
      const together = f.pond || f.farm ? 0.3 + 0.7 * smoothstep(-0.4, 0.4, Math.sin(t * 0.045 + f.school * 2.1)) : 1;
      gx += ((school.x / school.n - f.p.x) * 0.22 + (school.hx / school.n) * 0.4) * 2 * together;
      gz += ((school.z / school.n - f.p.z) * 0.22 + (school.hz / school.n) * 0.4) * 2 * together;
    }
    // never into its neighbours
    for (const o of this.swimmers) {
      if (o === f || o.school !== f.school || f.school < 0) continue;
      const dx = f.p.x - o.p.x;
      const dz = f.p.z - o.p.z;
      const d2 = dx * dx + dz * dz;
      const near = (f.size + o.size) * 1.2;
      if (d2 > 1e-6 && d2 < near * near) {
        gx += (dx / Math.sqrt(d2)) * 2.4;
        gz += (dz / Math.sqrt(d2)) * 2.4;
      }
    }
    // in a pond: back toward its middle as it nears the bank
    if (f.pond) {
      const reach = pondReach(f.pond, f.p.x, f.p.z);
      const back = smoothstep(0.55, 0.85, reach) * 4;
      gx += ((f.pond.x - f.p.x) / f.pond.r) * back;
      gz += ((f.pond.z - f.p.z) / f.pond.r) * back;
    } else if (f.farm) {
      // in a gher: back toward the farm's middle as it nears the embankment
      const farm = f.farm;
      const { u, v } = saltLocal(f.p.x, f.p.z, farm);
      const edge = Math.min(u, farm.w - u, v, farm.d - v);
      const back = smoothstep(farm.rimInset + 3, farm.rimInset + 1, edge) * 4;
      const r = Math.max(farm.w, farm.d) / 2;
      gx += ((farm.x - f.p.x) / r) * back * 2;
      gz += ((farm.z - f.p.z) / r) * back * 2;
    } else if (this.clock > f.look) {
      // looking ahead now and then for the shallows, and turning toward the deeper side
      f.look = this.clock + this.rng.range(0.2, 0.35);
      const ahead = 0.6 + 1.5 * f.speed;
      const fx = f.p.x + Math.sin(f.heading) * ahead;
      const fz = f.p.z + Math.cos(f.heading) * ahead;
      if (this.depthAt(fx, fz) < DEEP + f.depth * 0.5) {
        const side = this.depthAt(f.p.x + Math.sin(f.heading + 1.2) * ahead, f.p.z + Math.cos(f.heading + 1.2) * ahead) > this.depthAt(f.p.x + Math.sin(f.heading - 1.2) * ahead, f.p.z + Math.cos(f.heading - 1.2) * ahead) ? 1 : -1;
        f.goal = f.heading + side * 2.2;
        f.burst = this.clock + 0.5;
      } else f.goal = Number.NaN;
    }
    // scattering from the boat, darting off fast
    const bx = f.p.x - boat.x;
    const bz = f.p.z - boat.z;
    const bd = Math.hypot(bx, bz);
    let fleeing = false;
    if (!f.pond && bd < SHY) {
      gx += (bx / bd) * 8;
      gz += (bz / bd) * 8;
      fleeing = true;
      if (this.clock > f.burst) {
        f.burst = this.clock + 0.8;
        f.glide = f.burst + 0.6;
      }
    }
    let want = Math.atan2(gx, gz);
    if (!Number.isNaN(f.goal) && !fleeing) want = f.goal;
    // turning: toward where it wants to go, quicker when slow, through its own turning's momentum
    const most = 0.9 + 1.0 * (1 - Math.min(1, f.speed / 0.35)) + (fleeing ? 2 : 0);
    const target = clamp(angleDelta(f.heading, want) * 1.4, -most, most);
    f.turn += clamp(target - f.turn, -2.5 * dt, 2.5 * dt) * (fleeing ? 3 : 1);
    f.heading += f.turn * dt;
    // the tail drives it on, the water slows it, turning slows it more
    const drive = thrust * f.kind.cruise * (fleeing ? 7 : 2.4);
    f.speed += (drive - 1.2 * f.speed - Math.abs(f.turn) * 0.12 * f.speed) * dt;
    f.speed = Math.max(0.02, f.speed);
    f.p.x += Math.sin(f.heading) * f.speed * dt;
    f.p.z += Math.cos(f.heading) * f.speed * dt;
    // a sharp turn just under the surface swirls it
    if (f.depth < 0.22 && Math.abs(f.turn) > 1.6 && this.rng.next() < dt * 3) this.ripples.drop(f.p.x - Math.sin(f.heading) * f.size * 0.4, f.p.z - Math.cos(f.heading) * f.size * 0.4, 0.08, 0.0015);
  }

  /** Now and then a fish leaps near the camera: up, over and back in, ringing the water as it goes and comes. */
  private leap(dt: number, eye: Vector3, n: number): number {
    this.nextLeap -= dt;
    if (this.nextLeap <= 0) {
      this.nextLeap = this.rng.range(LEAP_EVERY[0], LEAP_EVERY[1]);
      const s = this.schools[this.rng.int(0, this.schools.length - 1)];
      if (!Number.isNaN(s.c.x) && Math.hypot(s.c.x - eye.x, s.c.z - eye.z) < 35) {
        const f = this.swimmers.find((o) => o.kind === KINDS.puti && !Number.isNaN(o.p.x) && Math.hypot(o.p.x - eye.x, o.p.z - eye.z) < 35);
        if (f) {
          const level = waterLevelAt(f.p.x, f.p.z);
          if (Number.isFinite(level)) {
            this.leaps.push({ from: new Vector3(f.p.x, level, f.p.z), dir: f.heading + this.rng.range(-0.6, 0.6), t: 0, dur: this.rng.range(0.45, 0.7), height: this.rng.range(0.25, 0.5), length: this.rng.range(0.5, 1.0) });
            this.ripples.drop(f.p.x, f.p.z, 0.12, 0.01);
          }
        }
      }
    }
    const { m, q, p, scale } = this;
    for (let i = this.leaps.length - 1; i >= 0; i--) {
      const l = this.leaps[i];
      l.t += dt;
      const f = Math.min(1, l.t / l.dur);
      const y = l.from.y + 4 * l.height * f * (1 - f) - 0.1;
      p.set(l.from.x + Math.sin(l.dir) * l.length * f, y, l.from.z + Math.cos(l.dir) * l.length * f);
      // nose up as it rises, down as it falls, its tail flicking
      const pitch = Math.atan2(4 * l.height * (1 - 2 * f), l.length);
      q.setFromAxisAngle(Fish.UP, l.dir).multiply(this.qPitch.setFromAxisAngle(Fish.ACROSS, -pitch));
      m.compose(p, q, scale.setScalar(0.17));
      if (n < MOST) {
        this.mesh.setMatrixAt(n, m);
        this.swim.setXYZW(n, l.t * 40, 0.12, 0, 0);
        this.colors.setXYZ(n, 0.75, 0.78, 0.74);
        n++;
      }
      if (f >= 1) {
        this.ripples.drop(p.x, p.z, 0.16, 0.014);
        this.leaps.splice(i, 1);
      }
    }
    return n;
  }
}
