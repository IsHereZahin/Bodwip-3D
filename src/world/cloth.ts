import { BufferAttribute, BufferGeometry, Mesh, Vector3 } from 'three';
import type { Material } from 'three';

// Cloth for the boatman. A tube hangs round his body (the lungi from his waist, the vest from his chest):
// each frame his body says where each ring of it should be, the tube adds its own folds, and its looser
// rows are particles on springs to that shape, so they lag behind his movement, swing, settle and flutter
// in the wind without sinking into him. A ribbon (the gamchha) lies over his shoulder and hangs free at
// both ends: a chain of particles (Verlet) under gravity and wind, held where it lies on him and kept out
// of his chest. Everything works in the space of the meshes' parent (the boat).

/** One ring of a tube: its centre, its two in-plane axes, and its half-widths along them. */
export interface Ring {
  c: Vector3;
  ax: Vector3;
  az: Vector3;
  a: number;
  b: number;
}

export interface TubeOptions {
  segments: number;
  rings: number;
  /** Fold depth (m, outward) and drop (m, downward) at a point; `t` runs 0..1 down the tube, `th` round it from +ax toward +az. */
  fold: (t: number, th: number) => { r: number; y: number };
  /** 0 (held to its shape) .. 1 (free to swing) for each row. */
  freedom: (t: number) => number;
  /** Shade for each row (the crease above a rolled waist, a doubled hem). */
  shade?: (t: number) => number;
  uRepeat: number;
  vRepeat: number;
}

/** How hard the wind pulls on cloth, per (m/s)², and how lively it is. */
const DRAG = 0.9;
const STIFF = 700;
const LOOSE = 90;
const ZETA = 0.3;

const tmp = new Vector3();
const up = new Vector3();
const target = new Vector3();
const p = new Vector3();
const ring: Ring = { c: new Vector3(), ax: new Vector3(), az: new Vector3(), a: 1, b: 1 };

export class ClothTube {
  readonly mesh: Mesh;
  private readonly S: number;
  private readonly R: number;
  private readonly geometry = new BufferGeometry();
  private readonly pos: Float32Array;
  private readonly vel: Float32Array;
  private readonly foldR: Float32Array;
  private readonly foldY: Float32Array;
  private readonly free: Float32Array;
  private started = false;

  constructor(material: Material, o: TubeOptions) {
    const S = (this.S = o.segments);
    const R = (this.R = o.rings);
    const count = (S + 1) * (R + 1);
    this.pos = new Float32Array(count * 3);
    this.vel = new Float32Array(count * 3);
    this.foldR = new Float32Array(count);
    this.foldY = new Float32Array(count);
    this.free = new Float32Array(R + 1);
    const uv = new Float32Array(count * 2);
    const color = new Float32Array(count * 3);
    const idx: number[] = [];
    for (let r = 0; r <= R; r++) {
      const t = r / R;
      this.free[r] = o.freedom(t);
      const shade = o.shade ? o.shade(t) : 1;
      for (let s = 0; s <= S; s++) {
        const i = r * (S + 1) + s;
        const f = o.fold(t, (s / S) * Math.PI * 2);
        this.foldR[i] = f.r;
        this.foldY[i] = f.y;
        uv[i * 2] = (s / S) * o.uRepeat;
        uv[i * 2 + 1] = 1 - t * o.vRepeat;
        color.fill(shade, i * 3, i * 3 + 3);
        if (r < R && s < S) {
          const below = i + S + 1;
          idx.push(i, i + 1, below, i + 1, below + 1, below);
        }
      }
    }
    const g = this.geometry;
    g.setAttribute('position', new BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new BufferAttribute(new Float32Array(count * 3), 3));
    g.setAttribute('uv', new BufferAttribute(uv, 2));
    g.setAttribute('color', new BufferAttribute(color, 3));
    g.setIndex(idx);
    this.mesh = new Mesh(g, material);
    this.mesh.frustumCulled = false;
  }

  /**
   * `shape(t, out)` gives the ring at `t` (0 top .. 1 bottom) where his body puts it; `wind`: the air
   * moving past the cloth (m/s); `time` drives the flutter; `collide(p)`, if given, pushes a point out of
   * his limbs.
   */
  update(dt: number, time: number, shape: (t: number, out: Ring) => Ring, wind: Vector3, collide?: (p: Vector3) => void): void {
    const { S, R, pos, vel } = this;
    const h = Math.min(dt, 1 / 30);
    const gust = wind.length() * DRAG;
    for (let r = 0; r <= R; r++) {
      shape(r / R, ring);
      up.crossVectors(ring.az, ring.ax).normalize();
      const free = this.free[r];
      const k = STIFF * (1 - free) + LOOSE * free;
      const c = 2 * ZETA * Math.sqrt(k);
      const push = gust * free;
      for (let s = 0; s <= S; s++) {
        const i = r * (S + 1) + s;
        const th = (s / S) * Math.PI * 2;
        const fr = this.foldR[i];
        target
          .copy(ring.c)
          .addScaledVector(ring.ax, Math.cos(th) * (ring.a + fr))
          .addScaledVector(ring.az, Math.sin(th) * (ring.b + fr))
          .addScaledVector(up, -this.foldY[i]);
        if (!this.started || free <= 0 || h <= 0) {
          if (collide) collide(target);
          target.toArray(pos, i * 3);
          vel.fill(0, i * 3, i * 3 + 3);
          continue;
        }
        p.fromArray(pos, i * 3);
        tmp.fromArray(vel, i * 3);
        // a damped spring back to where his body puts it; the wind pushes and ripples it
        const flutter = 0.55 + 0.45 * Math.sin(th * 3 + time * 8.3 + r * 1.7) * Math.sin(time * 2.9 + th * 5);
        tmp.x += (k * (target.x - p.x) - c * tmp.x + wind.x * push * flutter) * h;
        tmp.y += (k * (target.y - p.y) - c * tmp.y + wind.y * push * flutter) * h;
        tmp.z += (k * (target.z - p.z) - c * tmp.z + wind.z * push * flutter) * h;
        tmp.toArray(vel, i * 3);
        p.addScaledVector(tmp, h);
        // never into his body: stay outside an ellipse a little inside the ring
        tmp.subVectors(p, ring.c);
        const u = tmp.dot(ring.ax) / ring.a;
        const w = tmp.dot(ring.az) / ring.b;
        const e = Math.hypot(u, w);
        if (e < 0.93 && e > 1e-4) {
          const out = 0.93 / e - 1;
          p.addScaledVector(ring.ax, u * ring.a * out).addScaledVector(ring.az, w * ring.b * out);
        }
        if (collide) collide(p);
        p.toArray(pos, i * 3);
      }
    }
    this.started = true;
    const g = this.geometry;
    (g.getAttribute('position') as BufferAttribute).needsUpdate = true;
    g.computeVertexNormals();
    // the seam's two columns share one normal, so it doesn't show
    const n = g.getAttribute('normal') as BufferAttribute;
    for (let r = 0; r <= R; r++) {
      const a = r * (S + 1);
      const b = a + S;
      tmp.set(n.getX(a) + n.getX(b), n.getY(a) + n.getY(b), n.getZ(a) + n.getZ(b)).normalize();
      n.setXYZ(a, tmp.x, tmp.y, tmp.z);
      n.setXYZ(b, tmp.x, tmp.y, tmp.z);
    }
  }
}

const side = new Vector3();
const tan = new Vector3();
const out = new Vector3();

/** A strip of cloth, held at some of its particles (`pins`) and hanging free from them elsewhere. */
export class ClothRibbon {
  readonly mesh: Mesh;
  private readonly n: number;
  private readonly seg: number;
  private readonly half: Float32Array;
  private readonly pinned: boolean[];
  private readonly p: Vector3[];
  private readonly prev: Vector3[];
  private readonly normal: Vector3[];
  private readonly geometry = new BufferGeometry();
  private readonly pos: Float32Array;
  private started = false;

  /**
   * `count` particles `segment` apart, `width` wide (or as wide at each particle as `width(i)` says: a ওড়না
   * gathered narrow over a shoulder and falling open); `uWidth`/`vLength` how much texture it shows.
   */
  constructor(material: Material, count: number, segment: number, width: number | ((i: number) => number), pins: readonly number[], uWidth: number, vLength: number) {
    this.n = count;
    this.seg = segment;
    this.half = Float32Array.from({ length: count }, (_, i) => (typeof width === 'number' ? width : width(i)) / 2);
    this.pinned = Array.from({ length: count }, (_, i) => pins.includes(i));
    this.p = Array.from({ length: count }, () => new Vector3());
    this.prev = Array.from({ length: count }, () => new Vector3());
    this.normal = Array.from({ length: count }, () => new Vector3(0, 1, 0));
    this.pos = new Float32Array(count * 2 * 3);
    const uv = new Float32Array(count * 2 * 2);
    const color = new Float32Array(count * 2 * 3);
    const idx: number[] = [];
    for (let i = 0; i < count; i++) {
      const v = 1 - (i / (count - 1)) * vLength;
      uv.set([0, v, uWidth, v], i * 4);
      // the woven border at each end of a gamchha, a little darker
      const shade = i < 1 || i > count - 2 ? 0.72 : 1;
      color.fill(shade, i * 6, i * 6 + 6);
      if (i < count - 1) {
        const a = i * 2;
        idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
      }
    }
    const g = this.geometry;
    g.setAttribute('position', new BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new BufferAttribute(new Float32Array(count * 2 * 3), 3));
    g.setAttribute('uv', new BufferAttribute(uv, 2));
    g.setAttribute('color', new BufferAttribute(color, 3));
    g.setIndex(idx);
    this.mesh = new Mesh(g, material);
    this.mesh.frustumCulled = false;
  }

  /**
   * `pin(i, p, n)` puts a held particle where it lies on him, with the surface's normal there;
   * `outward(p, out)` says which way is away from his body at a free particle (the ribbon lies flat to
   * it); `keepOut(p)` pushes a point out of his body. `wind` (m/s) and `gravity` are in the same space.
   */
  update(
    dt: number,
    time: number,
    pin: (i: number, p: Vector3, n: Vector3) => void,
    outward: (p: Vector3, out: Vector3) => void,
    keepOut: (p: Vector3) => void,
    wind: Vector3,
    gravity: Vector3,
  ): void {
    const { p, prev, n, seg, pinned } = this;
    for (let i = 0; i < n; i++) {
      if (!pinned[i]) continue;
      pin(i, p[i], this.normal[i]);
      prev[i].copy(p[i]);
    }
    if (!this.started) {
      // first frame: each free end hangs straight down from where it is held
      const down = tmp.copy(gravity).normalize();
      for (let i = 0; i < n; i++) {
        if (pinned[i]) continue;
        let k = i;
        while (k >= 0 && !pinned[k]) k--;
        if (k < 0) {
          k = i;
          while (k < n - 1 && !pinned[k]) k++;
        }
        p[i].copy(p[k]).addScaledVector(down, Math.abs(i - k) * seg);
        prev[i].copy(p[i]);
      }
      this.started = true;
    }
    const h = Math.min(dt, 1 / 30);
    if (h > 0) {
      const gust = wind.length() * DRAG * (0.65 + 0.35 * Math.sin(time * 3.1) * Math.sin(time * 1.3 + 0.7));
      for (let i = 0; i < n; i++) {
        if (pinned[i]) continue;
        // carry on as it was moving (a little damped), then gravity and the wind
        tmp.subVectors(p[i], prev[i]).multiplyScalar(0.982);
        prev[i].copy(p[i]);
        const ripple = 1 + 0.6 * Math.sin(time * 11 + i * 1.3);
        p[i].add(tmp).addScaledVector(gravity, h * h).addScaledVector(wind, h * h * gust * ripple);
      }
      for (let iter = 0; iter < 6; iter++) {
        for (let i = 0; i < n - 1; i++) {
          const a = p[i];
          const b = p[i + 1];
          if (pinned[i] && pinned[i + 1]) continue;
          tmp.subVectors(b, a);
          const d = tmp.length();
          if (d < 1e-6) continue;
          const diff = (d - seg) / d;
          if (pinned[i]) b.addScaledVector(tmp, -diff);
          else if (pinned[i + 1]) a.addScaledVector(tmp, diff);
          else {
            a.addScaledVector(tmp, diff * 0.5);
            b.addScaledVector(tmp, -diff * 0.5);
          }
        }
        for (let i = 0; i < n; i++) if (!pinned[i]) keepOut(p[i]);
      }
    }
    // the ribbon: across the strip, flat to his body
    for (let i = 0; i < n; i++) {
      tan.subVectors(p[Math.min(i + 1, n - 1)], p[Math.max(i - 1, 0)]).normalize();
      if (pinned[i]) out.copy(this.normal[i]);
      else outward(p[i], out);
      side.crossVectors(tan, out).normalize();
      tmp.copy(p[i]).addScaledVector(side, -this.half[i]).toArray(this.pos, i * 6);
      tmp.copy(p[i]).addScaledVector(side, this.half[i]).toArray(this.pos, i * 6 + 3);
    }
    (this.geometry.getAttribute('position') as BufferAttribute).needsUpdate = true;
    this.geometry.computeVertexNormals();
  }
}
