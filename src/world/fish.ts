import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Quaternion,
  RingGeometry,
  Vector3,
} from 'three';
import { LAYER_NO_REFLECT } from '../core/globals';
import { Rng } from '../core/rng';
import { patchMaterial } from '../render/patch';
import { terrainHeight, waterLevelAt } from './geography';

// Fish in the waters round the camera: small schools (puti and the like, a hand long) cruising a little under
// the surface where it is deep enough, turning this way and that, scattering from the boat; and now and then
// one leaps clear and falls back, its rings spreading on the water. Seen through the water they are dim shapes,
// as fish are (they go through patchMaterial, so the water tints them); the leaps and the rings are what the
// eye catches. Only round the camera, so they cost the same anywhere.

const SCHOOLS = 7;
const PER_SCHOOL = 9;
/** Schools stay this near the camera (m); one farther off is moved to fresh water by it. */
const REACH = 45;
/** The least depth of water a school keeps to (m). */
const DEEP = 0.6;
/** How near the boat comes before a school scatters (m). */
const SHY = 7;
/** Seconds between leaps, at least and at most. */
const LEAP_EVERY: [number, number] = [3, 10];
const RINGS = 24;

/** A fish 1 m long along +z (scaled down per fish): a spindle body, dark back and pale belly, and a forked tail. */
export function fishGeometry(): BufferGeometry {
  const pos: number[] = [];
  const col: number[] = [];
  const back = [0.16, 0.18, 0.12];
  const belly = [0.62, 0.62, 0.55];
  const ring = 6;
  const rows = 7;
  for (let i = 0; i <= rows; i++) {
    const t = i / rows;
    const z = 0.5 - t * 0.85;
    const r = Math.sin(Math.PI * Math.min(1, t * 1.05 + 0.04)) * 0.09;
    for (let k = 0; k < ring; k++) {
      const a = (k / ring) * Math.PI * 2;
      const y = Math.cos(a) * r * 1.25;
      pos.push(Math.sin(a) * r * 0.55, y, z);
      const c = y > 0 ? back : belly;
      col.push(...c);
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
  // the tail: a fork behind the body
  const tail = pos.length / 3;
  pos.push(0, 0, -0.33, 0, 0.12, -0.52, 0, -0.1, -0.5);
  col.push(...back, ...back, ...back);
  idx.push(tail, tail + 1, tail + 2);
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('color', new BufferAttribute(new Float32Array(col), 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

interface School {
  c: Vector3;
  heading: number;
  speed: number;
  depth: number;
  /** Where each fish keeps in the school, and its own beat. */
  offsets: Vector3[];
  beats: number[];
}

interface Leap {
  from: Vector3;
  dir: number;
  t: number;
  dur: number;
  height: number;
  length: number;
  splashed: boolean;
}

interface Ring {
  p: Vector3;
  t: number;
  size: number;
}

export class Fish {
  readonly group = new Group();
  private readonly fish: InstancedMesh;
  private readonly rings: InstancedMesh;
  private readonly ringShade: InstancedBufferAttribute;
  private readonly schools: School[] = [];
  private readonly leaps: Leap[] = [];
  private readonly ringList: Ring[] = [];
  private readonly rng = new Rng(77);
  private nextLeap = 4;

  constructor() {
    this.group.name = 'fish';
    const material = patchMaterial(new MeshStandardMaterial({ vertexColors: true, roughness: 0.45, metalness: 0.1, side: DoubleSide }), {});
    this.fish = new InstancedMesh(fishGeometry(), material, SCHOOLS * PER_SCHOOL + 2);
    this.fish.frustumCulled = false;
    this.fish.castShadow = false;
    this.fish.layers.set(LAYER_NO_REFLECT);
    this.fish.count = 0;
    // the rings a leap leaves: faint bright circles spreading and fading
    const ring = new RingGeometry(0.9, 1, 40, 1).rotateX(-Math.PI / 2);
    this.rings = new InstancedMesh(ring, new MeshBasicMaterial({ color: '#ffffff', transparent: true, depthWrite: false, blending: AdditiveBlending, side: DoubleSide }), RINGS);
    this.ringShade = new InstancedBufferAttribute(new Float32Array(RINGS * 3), 3);
    this.rings.instanceColor = this.ringShade;
    this.rings.frustumCulled = false;
    this.rings.layers.set(LAYER_NO_REFLECT);
    this.rings.count = 0;
    this.group.add(this.fish, this.rings);
    for (let i = 0; i < SCHOOLS; i++) {
      const offsets: Vector3[] = [];
      const beats: number[] = [];
      for (let k = 0; k < PER_SCHOOL; k++) {
        offsets.push(new Vector3(this.rng.range(-1.2, 1.2), this.rng.range(-0.08, 0.08), this.rng.range(-1.6, 1.6)));
        beats.push(this.rng.range(0, Math.PI * 2));
      }
      this.schools.push({ c: new Vector3(Number.NaN, 0, 0), heading: 0, speed: 0.4, depth: 0.3, offsets, beats });
    }
  }

  /** How deep the water is at (x, z) (m), or 0 on land. */
  private depthAt(x: number, z: number): number {
    return Math.max(0, waterLevelAt(x, z) - terrainHeight(x, z));
  }

  /** A fresh place for a school: water deep enough within reach of `eye`, or false if none was found. */
  private place(s: School, eye: Vector3): boolean {
    for (let k = 0; k < 12; k++) {
      const a = this.rng.range(0, Math.PI * 2);
      const d = this.rng.range(6, REACH * 0.85);
      const x = eye.x + Math.cos(a) * d;
      const z = eye.z + Math.sin(a) * d;
      if (this.depthAt(x, z) < DEEP + 0.3) continue;
      s.c.set(x, waterLevelAt(x, z), z);
      s.heading = this.rng.range(0, Math.PI * 2);
      s.speed = this.rng.range(0.25, 0.6);
      s.depth = this.rng.range(0.18, 0.45);
      return true;
    }
    return false;
  }

  update(dt: number, t: number, eye: Vector3, boat: Vector3): void {
    if (dt <= 0) return;
    const m = new Matrix4();
    const q = new Quaternion();
    const p = new Vector3();
    const scale = new Vector3();
    const up = new Vector3(0, 1, 0);
    let n = 0;
    for (const s of this.schools) {
      if (Number.isNaN(s.c.x) || Math.hypot(s.c.x - eye.x, s.c.z - eye.z) > REACH) {
        if (!this.place(s, eye)) continue;
      }
      // scatter from the boat; otherwise wander, turning back from the shallows
      const bd = Math.hypot(s.c.x - boat.x, s.c.z - boat.z);
      if (bd < SHY) {
        s.heading = Math.atan2(s.c.x - boat.x, s.c.z - boat.z);
        s.speed = 1.6;
      } else {
        s.heading += (Math.sin(t * 0.3 + s.depth * 40) * 0.25 + this.rng.range(-0.2, 0.2)) * dt;
        s.speed += (0.4 - s.speed) * (1 - Math.exp(-dt));
      }
      const ax = s.c.x + Math.sin(s.heading) * 3;
      const az = s.c.z + Math.cos(s.heading) * 3;
      if (this.depthAt(ax, az) < DEEP) s.heading += Math.PI * (0.6 + 0.4 * this.rng.next());
      s.c.x += Math.sin(s.heading) * s.speed * dt;
      s.c.z += Math.cos(s.heading) * s.speed * dt;
      s.c.y = waterLevelAt(s.c.x, s.c.z);
      const cos = Math.cos(s.heading);
      const sin = Math.sin(s.heading);
      s.offsets.forEach((o, k) => {
        const beat = s.beats[k];
        // each fish weaves a little about its place in the school, its body swaying as it swims
        const wx = o.x + Math.sin(t * 0.7 + beat) * 0.3;
        const wz = o.z + Math.sin(t * 0.5 + beat * 1.7) * 0.4;
        p.set(s.c.x + wx * cos + wz * sin, s.c.y - s.depth + o.y, s.c.z - wx * sin + wz * cos);
        q.setFromAxisAngle(up, s.heading + Math.sin(t * (6 + s.speed * 6) + beat) * 0.18);
        m.compose(p, q, scale.setScalar(0.13 + (k % 3) * 0.02));
        this.fish.setMatrixAt(n++, m);
      });
    }
    // now and then one leaps near the camera
    this.nextLeap -= dt;
    if (this.nextLeap <= 0) {
      this.nextLeap = this.rng.range(LEAP_EVERY[0], LEAP_EVERY[1]);
      const s = this.schools[this.rng.int(0, this.schools.length - 1)];
      if (!Number.isNaN(s.c.x) && Math.hypot(s.c.x - eye.x, s.c.z - eye.z) < 35) {
        this.leaps.push({ from: s.c.clone(), dir: s.heading + this.rng.range(-0.6, 0.6), t: 0, dur: this.rng.range(0.45, 0.7), height: this.rng.range(0.25, 0.5), length: this.rng.range(0.5, 1.0), splashed: false });
        this.ring(s.c, 0.6);
      }
    }
    for (let i = this.leaps.length - 1; i >= 0; i--) {
      const l = this.leaps[i];
      l.t += dt;
      const f = Math.min(1, l.t / l.dur);
      const y = l.from.y + 4 * l.height * f * (1 - f) - 0.1;
      p.set(l.from.x + Math.sin(l.dir) * l.length * f, y, l.from.z + Math.cos(l.dir) * l.length * f);
      // nose up as it rises, down as it falls
      const pitch = Math.atan2(4 * l.height * (1 - 2 * f), l.length);
      q.setFromAxisAngle(up, l.dir).multiply(new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), -pitch));
      m.compose(p, q, scale.setScalar(0.17));
      if (n < this.fish.instanceMatrix.count) this.fish.setMatrixAt(n++, m);
      if (f >= 1) {
        this.ring(p.setY(l.from.y), 1.1);
        this.leaps.splice(i, 1);
      }
    }
    this.fish.count = n;
    this.fish.instanceMatrix.needsUpdate = true;
    // the rings spread and fade
    let r = 0;
    for (let i = this.ringList.length - 1; i >= 0; i--) {
      const g = this.ringList[i];
      g.t += dt;
      const f = g.t / 2.2;
      if (f >= 1) {
        this.ringList.splice(i, 1);
        continue;
      }
      // the second ring follows the first a moment later
      if (f < 0) continue;
      m.compose(g.p, q.identity(), scale.set(0.15 + f * 1.6 * g.size, 1, 0.15 + f * 1.6 * g.size));
      this.rings.setMatrixAt(r, m);
      const a = 0.22 * (1 - f) * (1 - f);
      this.ringShade.setXYZ(r, a, a, a);
      r++;
    }
    this.rings.count = r;
    this.rings.instanceMatrix.needsUpdate = true;
    this.ringShade.needsUpdate = true;
  }

  /** Rings spreading from `at` on the water, `size` m across at their widest (a leap's, or a net's falling in). */
  ring(at: Vector3, size: number): void {
    if (this.ringList.length >= RINGS - 1) return;
    this.ringList.push({ p: at.clone().setY(at.y + 0.02), t: 0, size });
    this.ringList.push({ p: at.clone().setY(at.y + 0.02), t: -0.35, size: size * 0.7 });
  }
}
