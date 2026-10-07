import { AdditiveBlending, BufferAttribute, BufferGeometry, DoubleSide, Mesh, ShaderMaterial, Vector3 } from 'three';
import type { PerspectiveCamera } from 'three';
import { G } from '../core/globals';
import { Rng } from '../core/rng';
import { GLSL_COMMON } from '../render/glsl';
import { terrainHeight } from './geography';

// Lightning in the storms (the weather sends the strikes, env/weather.ts): a jagged channel from the cloud base
// to the ground far off, branching as it comes down, each strike its own (midpoint displacement from a fresh
// seed); or a flash that stays in the cloud, now and then crawling sideways through it. A strike is a few
// strokes down the same channel a few hundredths of a second apart, each brightest at once and gone in a few
// tens of milliseconds, the faint stepped leader feeling its way down just before the first. While it lasts
// the cloud glows from within round it (G.uLightning, the sky shader) and the land takes a little of its
// light (env/environment.ts reads `light` through the weather): enough to feel, not a white-out. Thunder
// follows at the speed of sound.

/** How far off a strike falls (m): never close; in a shot, within its view. */
const DIST = { near: 650, far: 1700 };
/** The cloud base over the land (m). */
const CLOUD_BASE = [520, 820];
/** A channel's widths (m): its white-hot core within a soft glow, the glow being the ribbon drawn. */
const WIDTH = { main: 9, branch: 6 };

const VERT = /* glsl */ `
${GLSL_COMMON}
attribute vec3 aDir;
attribute float aSide;
attribute vec2 aBolt;
varying float vSide;
varying float vGlow;
varying float vDown;
varying vec3 vWorld;
uniform float uWide;
void main() {
  // a ribbon turned to face the eye along the channel, never narrower than a few pixels however far it is
  vec3 view = position - uCamPos;
  float far = length(view);
  vec3 across = normalize(cross(aDir, view / far));
  float wide = max(uWide, far * 0.006) * (aBolt.x > 0.75 ? 1.0 : 0.7);
  vec3 p = position + across * aSide * wide;
  vSide = aSide;
  vGlow = aBolt.x;
  vDown = aBolt.y;
  vWorld = p;
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}`;

const FRAG = /* glsl */ `
${GLSL_COMMON}
uniform float uBright;
uniform float uBranches;
uniform float uLeader;
varying float vSide;
varying float vGlow;
varying float vDown;
varying vec3 vWorld;
void main() {
  // the stepped leader, faint, only as far down as it has come (uLeader < 0 once it has struck)
  float b = uBright;
  if (uLeader >= 0.0) b = max(b, step(vDown, uLeader) * 0.12);
  // the branches die before the main channel does
  float strength = vGlow > 0.75 ? 1.0 : vGlow * uBranches;
  // its top lost in the cloud
  strength *= smoothstep(0.0, 0.08, vDown);
  float s = abs(vSide);
  float core = exp(-s * s * 14.0);
  float glow = exp(-s * s * 2.5) * 0.3;
  // far off and through the rain it is softened, never gone
  float atten = 0.5 + 0.5 * exp(-distance(vWorld, uCamPos) / 1600.0);
  vec3 col = (vec3(1.0, 0.98, 1.0) * core * 2.4 + vec3(0.62, 0.66, 1.0) * glow) * b * strength * atten;
  if (max(col.r, max(col.g, col.b)) < 0.002) discard;
  gl_FragColor = vec4(col, 1.0);
}`;

interface Pulse {
  at: number;
  a: number;
}

export class Lightning {
  readonly mesh: Mesh;
  /** The light the strike now showing throws on the land (0..1), for the weather to hand on. */
  light = 0;
  private readonly material: ShaderMaterial;
  private readonly rng = new Rng(2027);
  /** Seconds since the strike began (negative while the leader comes down), or Infinity when none. */
  private age = Infinity;
  private pulses: Pulse[] = [];
  private reach = 1;
  private readonly cloudDir = new Vector3(0, 1, 0);
  /** Strikes asked for by a shot, in seconds from now, in its view. */
  private due: number[] = [];

  constructor() {
    this.material = new ShaderMaterial({
      uniforms: { ...G, uBright: { value: 0 }, uBranches: { value: 1 }, uLeader: { value: -1 }, uWide: { value: WIDTH.main } },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      // a ribbon turned to the eye faces either way as the channel zigzags
      side: DoubleSide,
      blending: AdditiveBlending,
    });
    this.mesh = new Mesh(new BufferGeometry(), this.material);
    this.mesh.name = 'lightning';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 4;
    this.mesh.visible = false;
  }

  /** Debug: a strike in the view now, held `age` s into it (for stills). */
  strikeNow(camera: PerspectiveCamera, age: number): { points: number; nan: number; minY: number; maxY: number; dist: number } {
    const dist = this.strike(camera, true);
    this.age = age;
    const p = this.mesh.geometry.getAttribute('position');
    let nan = 0;
    let minY = Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < (p?.count ?? 0); i++) {
      const y = p.getY(i);
      if (!Number.isFinite(y) || !Number.isFinite(p.getX(i))) nan++;
      else {
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }
    }
    return { points: p?.count ?? 0, nan, minY, maxY, dist };
  }

  /** Strikes at these many seconds from now, each within the camera's view (for a shot of the storm). */
  schedule(seconds: readonly number[]): void {
    this.due = [...seconds].sort((a, b) => a - b);
  }

  /**
   * Lets the season's weather strike (`struck`), and the strikes a shot asked for; moves the one showing on.
   * Returns how far off a strike just fell (m), for its thunder, or null.
   */
  update(dt: number, camera: PerspectiveCamera, struck: boolean, inView: boolean): number | null {
    let fell: number | null = null;
    for (let i = 0; i < this.due.length; i++) this.due[i] -= dt;
    if (this.due.length && this.due[0] <= 0) {
      this.due.shift();
      fell = this.strike(camera, true);
    } else if (struck) fell = this.strike(camera, inView);
    this.age += dt;
    // the strokes: each brightest at once, gone in a few hundredths of a second
    let b = 0;
    for (const p of this.pulses) if (this.age >= p.at) b += p.a * Math.exp(-(this.age - p.at) / 0.035);
    const u = this.material.uniforms;
    u.uBright.value = b > 0.01 ? Math.min(b, 1.4) : 0;
    u.uBranches.value = Math.exp(-Math.max(this.age, 0) / 0.09);
    // the leader: down from the cloud in the 40 ms before the first stroke
    u.uLeader.value = this.age < 0 ? (this.age + 0.04) / 0.04 : -1;
    const showing = this.age < 0 || b > 0.01;
    this.mesh.visible = showing && this.mesh.geometry.getAttribute('position') !== undefined;
    // its light: on the cloud round it, and a little on the land
    this.light = Math.min(1, b) * this.reach;
    G.uLightning.value.set(this.cloudDir.x, this.cloudDir.y, this.cloudDir.z, this.light);
    return fell;
  }

  /** A new strike, somewhere off in the storm (in the camera's view if `inView`): its channel built, its strokes timed. Returns its distance. */
  private strike(camera: PerspectiveCamera, inView: boolean): number {
    const rng = this.rng;
    const eye = camera.position;
    // which way: within the view (most of the width of the frame), or anywhere round
    const look = camera.getWorldDirection(new Vector3());
    const ahead = Math.atan2(look.x, look.z);
    const halfWide = Math.atan(Math.tan((camera.fov * Math.PI) / 360) * camera.aspect);
    const bearing = inView ? ahead + rng.range(-0.75, 0.75) * halfWide : rng.range(0, Math.PI * 2);
    const dist = rng.range(DIST.near, DIST.far);
    const gx = eye.x + Math.sin(bearing) * dist;
    const gz = eye.z + Math.cos(bearing) * dist;
    const ground = new Vector3(gx, terrainHeight(gx, gz), gz);
    const base = rng.range(CLOUD_BASE[0], CLOUD_BASE[1]);
    // a third stay in the cloud, half of those crawling through it
    const inCloud = rng.next() < 0.33;
    const channels: { pts: Vector3[]; glow: number }[] = [];
    if (inCloud) {
      if (rng.next() < 0.5) {
        const a = ground.clone().setY(base + rng.range(30, 120));
        const sideways = new Vector3(Math.cos(bearing), 0, -Math.sin(bearing)).multiplyScalar(rng.range(250, 500) * rng.sign());
        this.channel(a, a.clone().add(sideways).add(new Vector3(0, rng.range(-60, 40), 0)), 0.55, 2, channels);
      }
    } else {
      const top = ground.clone().add(new Vector3(rng.range(-120, 120), base - ground.y, rng.range(-120, 120)));
      this.channel(top, ground, 1, 3, channels);
    }
    this.build(channels);
    // the strokes down the channel: one to four, a few hundredths of a second apart, fading
    const strokes = inCloud ? 1 + rng.int(0, 1) : 1 + rng.int(0, 3);
    this.pulses = [];
    let at = 0;
    for (let k = 0; k < strokes; k++) {
      this.pulses.push({ at, a: k === 0 ? 1 : rng.range(0.4, 0.85) });
      at += rng.range(0.04, 0.12);
    }
    this.age = inCloud ? 0 : -0.04;
    // how much of its light reaches here: nearer is brighter, a flash in the cloud dimmer
    this.reach = (0.35 + 0.65 * (1 - (dist - DIST.near) / (DIST.far - DIST.near))) * (inCloud ? 0.55 : 1);
    this.cloudDir.set(gx - eye.x, base - eye.y, gz - eye.z).normalize();
    this.material.uniforms.uWide.value = WIDTH.main * (0.7 + 0.6 * (dist / DIST.far));
    return dist;
  }

  /**
   * A channel from `a` to `b` by midpoint displacement (jagged at every scale, kinked more sideways than in
   * height), with branches leaving it now and then, slanting down and away, shorter and fainter, to `depth`.
   */
  private channel(a: Vector3, b: Vector3, glow: number, depth: number, out: { pts: Vector3[]; glow: number }[]): void {
    const rng = this.rng;
    let pts = [a.clone(), b.clone()];
    let rough = a.distanceTo(b) * 0.16;
    for (let level = 0; level < 7; level++) {
      const next: Vector3[] = [pts[0]];
      for (let i = 0; i < pts.length - 1; i++) {
        const mid = pts[i].clone().lerp(pts[i + 1], 0.5 + rng.range(-0.08, 0.08));
        mid.x += rng.range(-1, 1) * rough;
        mid.z += rng.range(-1, 1) * rough;
        mid.y += rng.range(-0.35, 0.35) * rough;
        next.push(mid, pts[i + 1]);
      }
      pts = next;
      rough *= 0.52;
    }
    out.push({ pts, glow });
    if (depth <= 1) return;
    // branches from the upper two thirds of this channel
    const n = pts.length;
    for (let i = 4; i < n * 0.7; i++) {
      if (rng.next() > (glow >= 1 ? 0.05 : 0.03)) continue;
      const from = pts[i];
      const along = pts[Math.min(n - 1, i + 3)].clone().sub(from).normalize();
      const away = new Vector3(rng.range(-1, 1), 0, rng.range(-1, 1)).normalize();
      const len = from.distanceTo(pts[n - 1]) * rng.range(0.12, 0.38);
      const dir = along.multiplyScalar(0.55).addScaledVector(away, rng.range(0.5, 0.9)).normalize();
      dir.y = -Math.abs(dir.y) - 0.25;
      this.channel(from, from.clone().addScaledVector(dir.normalize(), len), glow * rng.range(0.35, 0.6), depth - 1, out);
    }
  }

  /** The channels as ribbons: two vertices to a point, turned to the eye in the shader. */
  private build(channels: { pts: Vector3[]; glow: number }[]): void {
    const pos: number[] = [];
    const dir: number[] = [];
    const side: number[] = [];
    const bolt: number[] = [];
    const idx: number[] = [];
    const tip = channels.length ? channels[0].pts : [];
    const topY = tip.length ? tip[0].y : 1;
    const span = tip.length ? Math.max(1, tip[0].y - tip[tip.length - 1].y) : 1;
    for (const c of channels) {
      const start = pos.length / 3;
      const n = c.pts.length;
      for (let i = 0; i < n; i++) {
        const p = c.pts[i];
        const d = c.pts[Math.min(n - 1, i + 1)].clone().sub(c.pts[Math.max(0, i - 1)]).normalize();
        // fading out toward a branch's tip
        const g = c.glow < 0.75 ? c.glow * (1 - (i / n) * 0.7) : c.glow;
        const down = Math.min(1, Math.max(0, (topY - p.y) / span));
        for (const s of [-1, 1]) {
          pos.push(p.x, p.y, p.z);
          dir.push(d.x, d.y, d.z);
          side.push(s);
          bolt.push(g, down);
        }
        if (i < n - 1) {
          const k = start + i * 2;
          idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2);
        }
      }
    }
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
    g.setAttribute('aDir', new BufferAttribute(new Float32Array(dir), 3));
    g.setAttribute('aSide', new BufferAttribute(new Float32Array(side), 1));
    g.setAttribute('aBolt', new BufferAttribute(new Float32Array(bolt), 2));
    g.setIndex(idx);
    this.mesh.geometry.dispose();
    this.mesh.geometry = g;
  }
}
