import { BufferAttribute, BufferGeometry, Color, DoubleSide, Group, InstancedBufferAttribute, InstancedMesh, Matrix4, MeshStandardMaterial, Quaternion, Vector3 } from 'three';
import { G, LAYER_NO_REFLECT } from '../core/globals';
import { clamp, smoothstep } from '../core/mathx';
import { glslHash12 } from '../core/noise';
import { Rng } from '../core/rng';
import { gustAt, windAt } from '../env/wind';
import { patchMaterial } from '../render/patch';
import { petalTexture } from '../render/textures';
import { terrainHeight, waterLevelAt, waterwayAt } from './geography';
import type { Crown } from './vegetation';

// Leaves and petals falling from the trees round the camera. In spring the trees in red flower (the
// shader's choice of them, `seasonal: 'tree'` in render/patch.ts, has its twin here) shed their petals, in the
// dry months the leaves go yellow and brown and drop, and at any time a few green ones. Each comes away on
// its own, falls at its own pace, tumbling and slipping from side to side as a leaf does, carried by the
// wind where it is (env/wind.ts): in a breeze they drift down and away, in a storm the trees are stripped and
// the leaves are driven sideways, some lifted again by the gusts. They lie where they land (afloat on water)
// for a while and wither away. Only the crowns near the camera shed, so this costs the same anywhere.

/** Most leaves in the air or lying at once. */
const MOST = 2200;
/** Crowns this near the camera shed leaves (m). */
const REACH = 70;
/** A leaf this far from the camera is let go (m). */
const LOSE = REACH + 35;
/** Seconds a leaf lies where it fell before it withers away. */
const LIE: [number, number] = [8, 22];
/** Seconds a petal or leaf floats on the water before it sinks or is gone: longer, so they gather and drift. */
const AFLOAT: [number, number] = [28, 60];
/** Side of the cells the crowns are filed in (m). */
const CELL = 40;

/** The petals' tints over their texture's scarlet: as it is, more orange, deeper, a little rosier. */
export const PETAL_TINTS: readonly (readonly [number, number, number])[] = [
  [1, 1, 1],
  [1.04, 1.24, 1.08],
  [0.86, 0.76, 0.76],
  [1, 0.9, 0.96],
];
/** A petal's tint once it has lain a few days, browning. */
export const PETAL_WITHERED: readonly [number, number, number] = [0.56, 0.42, 0.36];
/** How long a petal is (m): the krishnachura's are 5–7 cm. */
export const PETAL_LENGTH: readonly [number, number] = [0.055, 0.08];
const DRY = [new Color('#c9a23a'), new Color('#b07a2a'), new Color('#8a5a26'), new Color('#d6b54a')];
const GREEN = [new Color('#5d7a2c'), new Color('#6f8a34'), new Color('#4c6a26')];

/** A leaf: a pointed oval, 1 m long along +z, in the xz plane (its faces up and down); scaled down per leaf. */
function leafGeometry(): BufferGeometry {
  const pts: number[] = [];
  const n = 6;
  // the outline round from the stalk to the tip and back, as a fan from the middle
  const ring: [number, number][] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    ring.push([Math.sin(Math.PI * t) * 0.32 * (1 - 0.3 * t), -0.5 + t]);
  }
  for (let i = n - 1; i >= 1; i--) ring.push([-ring[i][0], ring[i][1]]);
  const pos: number[] = [0, 0.02, 0];
  for (const [x, z] of ring) pos.push(x, Math.abs(x) * 0.12, z);
  for (let i = 0; i < ring.length; i++) pts.push(0, 1 + i, 1 + ((i + 1) % ring.length));
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('normal', new BufferAttribute(new Float32Array(pos.length).map((_, k) => (k % 3 === 1 ? 1 : 0)), 3));
  g.setIndex(pts);
  return g;
}

/**
 * A petal, `rows` × `cols` quads: 1 m long along +z from its narrow claw (z −½) to its round tip, its face up (+y),
 * cupped (its sides raised), its rim frilled and the blade a little curled; scaled down per petal. Mapped for
 * `petalTexture` (the claw at v 0).
 */
export function petalGeometry(rows: number, cols: number): BufferGeometry {
  const pos: number[] = [];
  const uv: number[] = [];
  const index: number[] = [];
  for (let i = 0; i <= rows; i++) {
    const t = i / rows;
    const along = clamp((t - 0.05) / 0.95, 0, 1);
    const half = 0.05 + 0.37 * Math.sin(Math.PI * along ** 0.8) ** 0.6 * smoothstep(0, 0.45, t);
    for (let j = 0; j <= cols; j++) {
      const s = (j / cols) * 2 - 1;
      const blade = smoothstep(0.25, 0.6, t);
      const y = 0.09 * s * s * smoothstep(0.1, 0.5, t) + 0.025 * Math.sin(t * 28 + s * 3) * s ** 4 * blade + 0.08 * (t - 0.3) ** 2;
      pos.push(s * half, y, t - 0.5);
      uv.push((s * half) / 0.84 + 0.5, t);
    }
  }
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) {
      const a = i * (cols + 1) + j;
      const c = a + cols + 1;
      index.push(a, c, a + 1, a + 1, c, c + 1);
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('uv', new BufferAttribute(new Float32Array(uv), 2));
  g.setIndex(index);
  g.computeVertexNormals();
  return g;
}

let petalMat: MeshStandardMaterial | null = null;

/** The petals' one material (falling, lying, afloat, the film's): its texture tinted per petal, the low sun glowing through it. */
export function petalMaterial(): MeshStandardMaterial {
  petalMat ??= patchMaterial(new MeshStandardMaterial({ map: petalTexture(), side: DoubleSide, roughness: 0.55 }), { translucency: 1.5 });
  return petalMat;
}

/** How far a tree at (x, z) is in red flower now, as the shader paints it (render/patch.ts, `ATM_SEASONAL == 2`). */
export function bloomAt(x: number, z: number): number {
  return smoothstep(0, 0.06, G.uSeasonA.value.z - bloomRank(x, z));
}

/** The share of the trees in flower at which one at (x, z) flowers (the shader's hash, its CPU twin): low ones flower first. */
export function bloomRank(x: number, z: number): number {
  return glslHash12(Math.floor(x * 0.37) + 3.1, Math.floor(z * 0.37) + 3.1);
}

interface Leaf {
  p: Vector3;
  v: Vector3;
  /** Tumbling: its axis, its turn so far, and how fast. */
  axis: Vector3;
  angle: number;
  spin: number;
  /** Its own slip from side to side: which way, how fast, how far, where in it. */
  slip: Vector3;
  slipW: number;
  slipA: number;
  phase: number;
  /** How fast it falls through still air (m/s), and its size (m). */
  sink: number;
  size: number;
  /** The ground or water under it, and where that was last asked. */
  floor: number;
  floorX: number;
  floorZ: number;
  afloat: boolean;
  /** Lying: seconds left before it withers; NaN while it falls. */
  lying: number;
  petal: boolean;
  yaw: number;
  rgb: [number, number, number];
}

export class FallingLeaves {
  /** The leaves and the petals, each their own mesh. */
  readonly group = new Group();
  private readonly mesh: InstancedMesh;
  private readonly petals: InstancedMesh;
  /** Scratch for each frame's posing (nothing is made there). */
  private readonly scratch = { m: new Matrix4(), q: new Quaternion(), turn: new Quaternion(), scale: new Vector3(), up: new Vector3(0, 1, 0) };
  private readonly leaves: Leaf[] = [];
  private readonly cells = new Map<number, Crown[]>();
  private readonly rng = new Rng(57);
  private readonly colors: InstancedBufferAttribute;
  private readonly petalColors: InstancedBufferAttribute;
  private readonly wind = { x: 0, z: 0 };

  constructor(crowns: readonly Crown[]) {
    for (const c of crowns) {
      const k = this.key(Math.floor(c.x / CELL), Math.floor(c.z / CELL));
      let list = this.cells.get(k);
      if (!list) this.cells.set(k, (list = []));
      list.push(c);
    }
    const material = patchMaterial(new MeshStandardMaterial({ side: DoubleSide, roughness: 0.75 }), { translucency: 1.6, foliage: true });
    this.mesh = new InstancedMesh(leafGeometry(), material, MOST);
    this.mesh.name = 'leaves';
    this.colors = new InstancedBufferAttribute(new Float32Array(MOST * 3), 3);
    this.mesh.instanceColor = this.colors;
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = true;
    this.mesh.layers.set(LAYER_NO_REFLECT);
    this.petals = new InstancedMesh(petalGeometry(5, 4), petalMaterial(), MOST);
    this.petals.name = 'petals';
    this.petalColors = new InstancedBufferAttribute(new Float32Array(MOST * 3), 3);
    this.petals.instanceColor = this.petalColors;
    this.petals.count = 0;
    this.petals.frustumCulled = false;
    this.petals.castShadow = false;
    this.petals.receiveShadow = true;
    this.petals.layers.set(LAYER_NO_REFLECT);
    this.group.name = 'leaves';
    this.group.add(this.mesh, this.petals);
  }

  /** Debug: where the first few leaves are and whether they lie, for checking them. */
  sample(n = 6): { p: number[]; lying: boolean }[] {
    return this.leaves.slice(0, n).map((l) => ({ p: l.p.toArray().map((v) => Math.round(v * 10) / 10), lying: !Number.isNaN(l.lying) }));
  }

  private key(i: number, j: number): number {
    return (i + 4096) * 8192 + (j + 4096);
  }

  /**
   * Sheds, carries and lays the leaves round `eye` for `dt` seconds (`t`: the shader clock). `keepFar`: those far
   * from `eye` are not let go yet (the film is still showing the shot they fall in, as it dissolves away).
   */
  update(dt: number, t: number, eye: Vector3, keepFar = false): void {
    if (dt <= 0) return;
    this.shed(dt, eye);
    const { m, q, turn, scale, up } = this.scratch;
    const gust = G.uWind.value.z;
    let n = 0;
    let leafN = 0;
    let petalN = 0;
    for (let i = 0; i < this.leaves.length; i++) {
      const l = this.leaves[i];
      if (!this.step(l, dt, t, gust) || (!keepFar && Math.hypot(l.p.x - eye.x, l.p.z - eye.z) > LOSE)) continue;
      this.leaves[n++] = l;
      // falling it tumbles; lying it rests flat, turned its own way, withering away at the last
      if (Number.isNaN(l.lying)) q.setFromAxisAngle(l.axis, l.angle);
      else q.setFromAxisAngle(up, l.yaw);
      if (Number.isNaN(l.lying)) q.multiply(turn.setFromAxisAngle(up, l.yaw));
      const fade = Number.isNaN(l.lying) ? 1 : Math.min(1, l.lying);
      m.compose(l.p, q, scale.setScalar(l.size * fade));
      if (l.petal) {
        this.petals.setMatrixAt(petalN, m);
        this.petalColors.setXYZ(petalN++, l.rgb[0], l.rgb[1], l.rgb[2]);
      } else {
        this.mesh.setMatrixAt(leafN, m);
        this.colors.setXYZ(leafN++, l.rgb[0], l.rgb[1], l.rgb[2]);
      }
    }
    this.leaves.length = n;
    this.mesh.count = leafN;
    this.petals.count = petalN;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.petals.instanceMatrix.needsUpdate = true;
    this.colors.needsUpdate = true;
    this.petalColors.needsUpdate = true;
  }

  /** The crowns near the camera let go of new leaves, by the season and the wind. */
  private shed(dt: number, eye: Vector3): void {
    const season = G.uSeasonA.value;
    const wind = G.uWind.value.z;
    // a storm strips the trees: many times the leaves, petals by the handful
    const storm = 1 + 12 * Math.max(0, wind - 0.9) ** 2;
    const dry = 0.06 + 0.2 * season.y;
    const ci = Math.floor(eye.x / CELL);
    const cj = Math.floor(eye.z / CELL);
    const R = Math.ceil(REACH / CELL);
    for (let i = ci - R; i <= ci + R; i++) {
      for (let j = cj - R; j <= cj + R; j++) {
        const list = this.cells.get(this.key(i, j));
        if (!list) continue;
        for (const c of list) {
          if (Math.abs(c.x - eye.x) > REACH || Math.abs(c.z - eye.z) > REACH) continue;
          const bloom = c.blossom && season.z > 0.02 ? bloomAt(c.x, c.z) : 0;
          // the bigger the crown, the more it sheds; those by the camera the most, where a leaf shows
          const size = (c.r / 4) ** 2 * (1 + 2 * (1 - smoothstep(10, 40, Math.hypot(c.x - eye.x, c.z - eye.z))));
          // petals let go in the gusts as they pass over the crown, a few between them, so they come in flurries
          const gust = gustAt(c.x, c.z);
          const petals = bloom * 7 * size * storm * (0.3 + 0.7 * gust * gust);
          const leaves = dry * size * storm;
          for (let k = Math.floor(petals * dt + this.rng.next()); k > 0; k--) this.fromCrown(c, true, season.y);
          for (let k = Math.floor(leaves * dt + this.rng.next()); k > 0; k--) this.fromCrown(c, false, season.y);
        }
      }
    }
    // in a gale the air is full of leaves torn from trees upwind, driven past the camera
    const torn = 45 * Math.max(0, wind - 1.2);
    const w = G.uWind.value;
    for (let k = Math.floor(torn * dt + this.rng.next()); k > 0; k--) {
      const back = this.rng.range(6, 32);
      const side = this.rng.range(-22, 22);
      const x = eye.x - w.x * back - w.y * side;
      const z = eye.z - w.y * back + w.x * side;
      this.spawn(x, this.floorAt(x, z).y + this.rng.range(0.8, 11), z, false, season.y);
    }
  }

  /** A leaf (or petal) comes away from somewhere in a crown, its lower and outer parts most. */
  private fromCrown(c: Crown, petal: boolean, dryness: number): void {
    const r = this.rng;
    const a = r.range(0, Math.PI * 2);
    const d = Math.sqrt(r.next()) * c.r * 0.9;
    this.spawn(c.x + Math.cos(a) * d, c.y + r.range(-0.6, 0.2) * c.r * 0.7, c.z + Math.sin(a) * d, petal, dryness);
  }

  private spawn(x: number, y: number, z: number, petal: boolean, dryness: number): void {
    if (this.leaves.length >= MOST) return;
    const r = this.rng;
    const pick = (list: Color[]) => list[r.int(0, list.length - 1)];
    const tint = PETAL_TINTS[r.int(0, PETAL_TINTS.length - 1)];
    const color = petal ? new Color(tint[0], tint[1], tint[2]) : r.next() < 0.3 + 0.6 * dryness ? pick(DRY) : pick(GREEN);
    const shade = r.range(0.8, 1.1);
    const slipAt = r.range(0, Math.PI * 2);
    const floor = this.floorAt(x, z);
    const leaf: Leaf = {
      p: new Vector3(x, y, z),
      v: new Vector3(),
      axis: new Vector3(r.range(-1, 1), r.range(-0.4, 0.4), r.range(-1, 1)).normalize(),
      angle: r.range(0, Math.PI * 2),
      spin: r.range(1.5, 7) * r.sign(),
      slip: new Vector3(Math.cos(slipAt), 0, Math.sin(slipAt)),
      slipW: r.range(1.8, 4.2),
      slipA: r.range(0.25, 0.9),
      phase: r.range(0, Math.PI * 2),
      sink: petal ? r.range(0.35, 0.75) : r.range(0.7, 1.5),
      size: petal ? r.range(PETAL_LENGTH[0], PETAL_LENGTH[1]) : r.range(0.08, 0.14),
      floor: floor.y,
      floorX: x,
      floorZ: z,
      afloat: floor.water,
      lying: Number.NaN,
      petal,
      yaw: r.range(0, Math.PI * 2),
      rgb: [color.r * shade, color.g * shade, color.b * shade],
    };
    this.leaves.push(leaf);
  }

  /** The ground or the water at (x, z), whichever is higher. */
  private floorAt(x: number, z: number): { y: number; water: boolean } {
    const g = terrainHeight(x, z);
    const w = waterLevelAt(x, z);
    return w > g ? { y: w, water: true } : { y: g, water: false };
  }

  /** Moves a leaf on; false when it is gone. */
  private step(l: Leaf, dt: number, t: number, strength: number): boolean {
    windAt(l.p.x, l.p.z, this.wind);
    if (!Number.isNaN(l.lying)) {
      l.lying -= dt;
      // afloat it drifts a little with the wind; on the ground a storm sends it skittering on
      const k = l.afloat ? 0.06 : Math.max(0, strength - 1.4) * 0.35;
      l.p.x += this.wind.x * k * dt;
      l.p.z += this.wind.z * k * dt;
      // afloat it rides the water down with the current, and turns slowly as it goes
      if (l.afloat) {
        const w = waterwayAt(l.p.x, l.p.z);
        if (w && w.d < w.half) {
          const p = w.way.at(w.s);
          const speed = w.way.current * G.uFlowScale.value * Math.max(0, 1 - (w.d / w.half) ** 2);
          l.p.x += Math.sin(p.heading) * speed * dt;
          l.p.z += Math.cos(p.heading) * speed * dt;
        }
        l.yaw += dt * 0.08 * Math.sin(l.phase);
      }
      return l.lying > 0;
    }
    // the air carries it: its sideways way comes to the wind's quickly, plus its own slip from side to side
    const slip = Math.cos(t * l.slipW + l.phase) * l.slipA * l.slipW;
    const kx = 1 - Math.exp(-dt / 0.5);
    l.v.x += (this.wind.x + l.slip.x * slip - l.v.x) * kx;
    l.v.z += (this.wind.z + l.slip.z * slip - l.v.z) * kx;
    // it sinks at its own pace, a little faster at the bottom of each slip; in a storm the gusts lift it again
    const lift = Math.max(0, strength - 1.2) * (Math.sin(t * 0.9 + l.phase * 3.0) * 0.6 + 0.15) * 1.6;
    const sink = -l.sink * (0.75 + 0.5 * Math.abs(Math.sin(t * l.slipW + l.phase))) + lift;
    l.v.y += (sink - l.v.y) * (1 - Math.exp(-dt / 0.35));
    l.p.addScaledVector(l.v, dt);
    l.angle += l.spin * dt;
    // what lies under it, asked again once it has drifted a few metres
    if (Math.abs(l.p.x - l.floorX) + Math.abs(l.p.z - l.floorZ) > 3) {
      const f = this.floorAt(l.p.x, l.p.z);
      l.floor = f.y;
      l.afloat = f.water;
      l.floorX = l.p.x;
      l.floorZ = l.p.z;
    }
    if (l.p.y <= l.floor + 0.02) {
      l.p.y = l.floor + (l.afloat ? 0.005 : 0.02);
      l.lying = l.afloat ? this.rng.range(AFLOAT[0], AFLOAT[1]) : this.rng.range(LIE[0], LIE[1]);
    }
    return true;
  }
}
