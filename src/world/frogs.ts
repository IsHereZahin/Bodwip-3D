import { Color, Group, InstancedBufferAttribute, InstancedMesh, Matrix4, MeshStandardMaterial, Quaternion, SphereGeometry, Vector3 } from 'three';
import { LAYER_NO_REFLECT } from '../core/globals';
import { smoothstep } from '../core/mathx';
import { Rng } from '../core/rng';
import { MeshBuilder, rgb, scaleRgb, type RGB } from '../render/builder';
import { patchMaterial } from '../render/patch';
import { onRoad, risenLevel, shoreLevel, terrainHeight } from './geography';
import type { Ripples } from './ripples';

// Frogs (ব্যাঙ) at the waters' edges in the rains: olive skipper frogs and, now and then, a bullfrog (সোনা ব্যাঙ)
// gone bright yellow for the monsoon, sitting at the very edge of the water among the grass, breathing, turning
// a little; when someone comes near (the camera, the boat) each jumps into the water with a plop and a ring, and
// is gone. They sit only where the water meets the land round the camera, a little way off, and are found afresh
// as the camera goes on. The croaking after dark is the soundscape's (audio/soundscape.ts `frogs`).

/** Most frogs out at once, and where they are found round the camera (m). */
const MOST = 12;
const FIND: [number, number] = [9, 36];
/** How near someone comes before a frog jumps in (m). */
const SHY = 3.2;

interface Frog {
  p: Vector3;
  yaw: number;
  size: number;
  color: Color;
  state: 'sit' | 'jump' | 'gone';
  t: number;
  /** Where its jump lands (in the water), and how long and high it is. */
  to: Vector3;
  dur: number;
  height: number;
  breath: number;
}

/** A frog sitting, 1 m long along +z (scaled per frog): its body hunched, its head, eyes, folded hind legs. */
function frogSitting(legs: 'folded' | 'out'): MeshBuilder {
  const b = new MeshBuilder();
  const sphere = new SphereGeometry(1, 10, 7);
  const back: RGB = [1, 1, 1];
  const belly: RGB = rgb('#e6e0c4');
  const at = (x: number, y: number, z: number, sx: number, sy: number, sz: number, c: RGB, rx = 0, ry = 0) =>
    b.add(sphere, new Matrix4().compose(new Vector3(x, y, z), new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), ry).multiply(new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), rx)), new Vector3(sx, sy, sz)), c);
  // the body, sloping up to the head, a paler belly under it
  at(0, 0.2, -0.05, 0.3, 0.2, 0.38, back, -0.35);
  at(0, 0.12, -0.02, 0.27, 0.12, 0.33, belly, -0.3);
  at(0, 0.27, 0.27, 0.24, 0.15, 0.22, back, -0.15);
  // its eyes, standing up dark-gold on the top of its head
  for (const s of [-1, 1]) at(s * 0.13, 0.38, 0.3, 0.07, 0.065, 0.07, rgb('#4a3a14'));
  if (legs === 'folded') {
    // the hind legs folded beside it, the front legs propping it up
    for (const s of [-1, 1]) {
      at(s * 0.27, 0.1, -0.18, 0.12, 0.09, 0.3, scaleRgb(back, 0.92), 0, s * 0.35);
      at(s * 0.3, 0.05, 0.02, 0.1, 0.05, 0.22, scaleRgb(back, 0.85), 0, -s * 0.5);
      at(s * 0.17, 0.08, 0.32, 0.05, 0.1, 0.05, scaleRgb(back, 0.9));
    }
  } else {
    // stretched out behind in the leap, the front legs reaching forward
    for (const s of [-1, 1]) {
      at(s * 0.16, 0.18, -0.5, 0.07, 0.06, 0.38, scaleRgb(back, 0.92), 0.1, s * 0.15);
      at(s * 0.2, 0.16, -0.95, 0.06, 0.04, 0.22, scaleRgb(back, 0.85), 0.1, s * 0.1);
      at(s * 0.14, 0.18, 0.45, 0.04, 0.04, 0.16, scaleRgb(back, 0.9), -0.4);
    }
  }
  return b;
}

export class Frogs {
  readonly group = new Group();
  private readonly sitting: InstancedMesh;
  private readonly leaping: InstancedMesh;
  private readonly frogs: Frog[] = [];
  private readonly ripples: Ripples;
  private readonly rng = new Rng(707);
  private readonly m = new Matrix4();
  private readonly q = new Quaternion();
  private readonly q2 = new Quaternion();
  private readonly s = new Vector3();
  private readonly p = new Vector3();
  private readonly up = new Vector3(0, 1, 0);
  private readonly across = new Vector3(1, 0, 0);
  private look = 0;

  constructor(ripples: Ripples) {
    this.ripples = ripples;
    this.group.name = 'frogs';
    const make = (b: MeshBuilder, name: string) => {
      const mesh = new InstancedMesh(b.build(), patchMaterial(new MeshStandardMaterial({ vertexColors: true, roughness: 0.35 }), {}), MOST);
      mesh.name = name;
      mesh.castShadow = false;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      mesh.layers.set(LAYER_NO_REFLECT);
      mesh.count = 0;
      // (made now, so the material is compiled with it at load and not again when the first frog comes)
      mesh.instanceColor = new InstancedBufferAttribute(new Float32Array(MOST * 3), 3);
      this.group.add(mesh);
      return mesh;
    };
    this.sitting = make(frogSitting('folded'), 'frog');
    this.leaping = make(frogSitting('out'), 'frog-leaping');
  }

  /**
   * A place at the very edge of the water round `eye`, a little way off, or null if none was found this time: a
   * point on a bank, walked down its slope to where the water (as the season has it) laps.
   */
  private edge(eye: Vector3): Vector3 | null {
    for (let k = 0; k < 6; k++) {
      const a = this.rng.range(0, Math.PI * 2);
      const d = this.rng.range(FIND[0], FIND[1]);
      let x = eye.x + Math.cos(a) * d;
      let z = eye.z + Math.sin(a) * d;
      const mean = shoreLevel(x, z);
      if (!Number.isFinite(mean)) continue;
      const level = risenLevel(mean);
      for (let step = 0; step < 16; step++) {
        const h = terrainHeight(x, z);
        const above = h - level;
        if (above < -0.01) break;
        if (above < 0.12) return onRoad(x, z, 0.5) ? null : new Vector3(x, h, z);
        // down the bank toward the water
        const e = 0.3;
        const gx = terrainHeight(x + e, z) - h;
        const gz = terrainHeight(x, z + e) - h;
        const g = Math.hypot(gx, gz);
        if (g < 1e-4) break;
        const go = Math.min(0.6, above * 0.8 / (g / e));
        x -= (gx / g) * go;
        z -= (gz / g) * go;
      }
    }
    return null;
  }

  /** For a still: as many out as the season brings, at once. */
  settle(eye: Vector3, out: number): void {
    const want = Math.round(MOST * smoothstep(0.05, 0.6, out));
    for (let k = 0; k < 40 && this.frogs.length < want; k++) this.find(eye);
  }

  private find(eye: Vector3): void {
    const p = this.edge(eye);
    if (!p) return;
    const yellow = this.rng.next() < 0.18;
    const color = yellow ? new Color('#c9b52c') : new Color(this.rng.pick(['#6b7036', '#5d6a33', '#76713e', '#4f5a2c']));
    this.frogs.push({
      p,
      yaw: this.rng.range(0, Math.PI * 2),
      size: yellow ? 0.15 : this.rng.range(0.07, 0.1),
      color: color.multiplyScalar(this.rng.range(0.85, 1.05)),
      state: 'sit',
      t: 0,
      to: new Vector3(),
      dur: 0.4,
      height: 0.2,
      breath: this.rng.range(0, 6.28),
    });
  }

  /**
   * Moves them on `dt` s round `eye` (the camera), shy of it and of `boat`; `out` how much the season and the
   * hour bring them out (0 none: the dry months).
   */
  update(dt: number, eye: Vector3, boat: Vector3, out: number): void {
    if (dt <= 0) return;
    const want = Math.round(MOST * smoothstep(0.05, 0.6, out));
    // a few found afresh each second where there are fewer than the season wants
    if (this.frogs.length < want && this.rng.next() < dt * 6) this.find(eye);
    this.look += dt;
    let ns = 0;
    let nl = 0;
    for (let i = this.frogs.length - 1; i >= 0; i--) {
      const f = this.frogs[i];
      f.t += dt;
      const far = Math.hypot(f.p.x - eye.x, f.p.z - eye.z);
      if (far > FIND[1] * 1.4 || (f.state === 'sit' && this.frogs.length > want && this.rng.next() < dt * 0.2)) {
        this.frogs.splice(i, 1);
        continue;
      }
      if (f.state === 'sit') {
        // someone near: off it goes, a long jump out into the water
        if (far < SHY || Math.hypot(f.p.x - boat.x, f.p.z - boat.z) < SHY + 2.5) {
          f.state = 'jump';
          f.t = 0;
          const away = Math.atan2(f.p.x - eye.x, f.p.z - eye.z) + this.rng.range(-0.5, 0.5);
          const len = this.rng.range(0.5, 1.0);
          f.to.set(f.p.x + Math.sin(away) * len, f.p.y - 0.08, f.p.z + Math.cos(away) * len);
          f.yaw = away;
          f.dur = 0.34 + 0.28 * len;
          f.height = 0.06 + 0.22 * len;
        } else if (this.rng.next() < dt * 0.05) f.yaw += this.rng.range(-0.6, 0.6);
        // breathing: its throat and flanks pumping
        const b = 1 + 0.04 * Math.sin(this.look * 5.5 + f.breath);
        this.q.setFromAxisAngle(this.up, f.yaw);
        this.m.compose(f.p, this.q, this.s.set(f.size, f.size * b, f.size));
        this.sitting.setMatrixAt(ns, this.m);
        this.sitting.setColorAt(ns++, f.color);
      } else if (f.state === 'jump') {
        const u = Math.min(1, f.t / f.dur);
        this.p.lerpVectors(f.p, f.to, u);
        this.p.y += 4 * f.height * u * (1 - u);
        const pitch = Math.atan2(4 * f.height * (1 - 2 * u), Math.hypot(f.to.x - f.p.x, f.to.z - f.p.z));
        this.q.setFromAxisAngle(this.up, f.yaw).multiply(this.q2.setFromAxisAngle(this.across, -pitch));
        this.m.compose(this.p, this.q, this.s.setScalar(f.size));
        this.leaping.setMatrixAt(nl, this.m);
        this.leaping.setColorAt(nl++, f.color);
        if (u >= 1) {
          this.ripples.drop(f.to.x, f.to.z, 0.1, 0.008);
          f.state = 'gone';
          f.t = 0;
        }
      } else if (f.t > 1) this.frogs.splice(i, 1);
    }
    this.sitting.count = ns;
    this.leaping.count = nl;
    this.sitting.instanceMatrix.needsUpdate = true;
    this.leaping.instanceMatrix.needsUpdate = true;
    if (this.sitting.instanceColor) this.sitting.instanceColor.needsUpdate = true;
    if (this.leaping.instanceColor) this.leaping.instanceColor.needsUpdate = true;
  }
}
