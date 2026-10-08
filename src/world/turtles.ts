import { Color, Group, InstancedBufferAttribute, InstancedMesh, Matrix4, MeshStandardMaterial, Quaternion, SphereGeometry, Vector3 } from 'three';
import { LAYER_NO_REFLECT } from '../core/globals';
import { clamp, lerp, smoothstep } from '../core/mathx';
import { Rng } from '../core/rng';
import { MeshBuilder, mixRgb, rgb, scaleRgb, type RGB } from '../render/builder';
import { patchMaterial } from '../render/patch';
import { waterLevelAt } from './geography';
import type { Ripples } from './ripples';
import { khalRocks } from './stones';

// River turtles (কচ্ছপ: the flapshell and the roofed turtle of the khals) basking on the khal's rocks in the dry
// months' sun, a couple to a rock, shells drying pale, heads up, now and then turning to look about. When a
// boat comes near they walk to the rock's edge and slide off into the water with a ring, swim off under the
// surface (dim shapes, as fish are), come up once for a breath, and when the boat has gone swim back and
// climb out again. In the rains, at night or in the wet, none are out.

/** How near a boat comes before a turtle slides off its rock (m), and how far off it must be to come back. */
const SHY = 9;
const SAFE = 22;
/** A turtle's length (m), and how long it swims off before it turns back (s). */
const LENGTH: [number, number] = [0.3, 0.42];
const AWAY: [number, number] = [14, 30];

type State = 'bask' | 'edge' | 'slip' | 'swim' | 'back' | 'climb';

interface Turtle {
  rock: { x: number; z: number; r: number; top: number };
  /** Where it basks on its rock (its offset from the rock's middle) and the way it faces there. */
  spot: { dx: number; dz: number; yaw: number };
  state: State;
  t: number;
  p: Vector3;
  yaw: number;
  /** Its head's turn, and where it is going to. */
  look: number;
  lookTo: number;
  size: number;
  /** Where it swims off to. */
  away: Vector3;
  breathed: boolean;
  /** How dry its shell is (pale in the sun, dark wet). */
  dry: number;
}

/** A turtle 1 m long along +z (scaled per turtle): a domed, keeled shell with its scutes, the plastron, four legs and a tail; the head is its own. */
function turtleBody(): MeshBuilder {
  const b = new MeshBuilder();
  const shell: RGB = rgb('#4a4630');
  const rim: RGB = rgb('#2f2c1e');
  const N = 18;
  const M = 7;
  const first = b.vertexCount;
  for (let j = 0; j <= M; j++) {
    const e = (j / M) * (Math.PI / 2);
    for (let i = 0; i <= N; i++) {
      const a = (i / N) * Math.PI * 2;
      const x = Math.cos(a) * Math.cos(e) * 0.4;
      const z = Math.sin(a) * Math.cos(e) * 0.5;
      // a dome with a low keel down its back
      const y = Math.sin(e) * 0.2 + 0.03 * Math.exp(-((x / 0.08) ** 2)) * Math.sin(e);
      const n = new Vector3(x / 0.16, y / 0.04 + 0.2, z / 0.25).normalize();
      // the scutes: darker seams in a pattern over the dome
      const seam = Math.max(Math.abs(Math.sin(z * 18)), Math.abs(Math.sin(x * 14 + 0.6))) > 0.93 ? 0.6 : 1;
      b.vertex(new Vector3(x, 0.04 + y, z), n, 0, 0, scaleRgb(mixRgb(rim, shell, j / M), seam * (0.9 + 0.1 * Math.sin(a * 5))));
    }
  }
  for (let j = 0; j < M; j++) for (let i = 0; i < N; i++) {
    const a = first + j * (N + 1) + i;
    b.quad(a, a + N + 1, a + N + 2, a + 1);
  }
  // the plastron under it
  const sphere = new SphereGeometry(1, 10, 6);
  const at = (x: number, y: number, z: number, sx: number, sy: number, sz: number, c: RGB, ry = 0) =>
    b.add(sphere, new Matrix4().compose(new Vector3(x, y, z), new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), ry), new Vector3(sx, sy, sz)), c);
  at(0, 0.035, 0, 0.37, 0.03, 0.47, rgb('#a59a6a'));
  // its legs out to the sides as it rests, the tail behind
  const skin: RGB = rgb('#4c4a3a');
  for (const [x, z, ry] of [
    [0.36, 0.3, 0.7],
    [-0.36, 0.3, -0.7],
    [0.34, -0.3, 2.3],
    [-0.34, -0.3, -2.3],
  ] as const) at(x, 0.03, z, 0.09, 0.035, 0.16, skin, ry);
  at(0, 0.03, -0.52, 0.035, 0.025, 0.09, skin);
  return b;
}

/** Its head and neck, along +z from the shell's front. */
function turtleHead(): MeshBuilder {
  const b = new MeshBuilder();
  const sphere = new SphereGeometry(1, 10, 7);
  const skin: RGB = rgb('#57553f');
  b.add(sphere, new Matrix4().compose(new Vector3(0, 0.06, 0.08), new Quaternion(), new Vector3(0.06, 0.05, 0.12)), skin);
  b.add(sphere, new Matrix4().compose(new Vector3(0, 0.08, 0.19), new Quaternion(), new Vector3(0.065, 0.055, 0.085)), scaleRgb(skin, 1.08));
  // a pale streak along its jaw, as the roofed turtles have
  b.add(sphere, new Matrix4().compose(new Vector3(0, 0.055, 0.2), new Quaternion(), new Vector3(0.05, 0.02, 0.07)), rgb('#c9b97a'));
  return b;
}

export class Turtles {
  readonly group = new Group();
  private readonly bodies: InstancedMesh;
  private readonly heads: InstancedMesh;
  private readonly turtles: Turtle[] = [];
  private readonly ripples: Ripples;
  private readonly rng = new Rng(509);
  private readonly m = new Matrix4();
  private readonly q = new Quaternion();
  private readonly q2 = new Quaternion();
  private readonly q3 = new Quaternion();
  private readonly tint = new Color();
  private readonly s = new Vector3();
  private readonly p = new Vector3();
  private readonly up = new Vector3(0, 1, 0);
  private readonly across = new Vector3(1, 0, 0);

  constructor(ripples: Ripples) {
    this.ripples = ripples;
    this.group.name = 'turtles';
    const rocks = khalRocks();
    for (const r of rocks) {
      const top = r.top;
      const n = this.rng.int(1, 2);
      for (let k = 0; k < n; k++) {
        const a = this.rng.range(0, Math.PI * 2);
        const d = this.rng.range(0.05, 0.3) * r.r;
        const yaw = this.rng.range(0, Math.PI * 2);
        this.turtles.push({
          rock: { x: r.x, z: r.z, r: r.r, top },
          spot: { dx: Math.cos(a) * d, dz: Math.sin(a) * d, yaw },
          state: 'bask',
          t: this.rng.range(0, 10),
          p: new Vector3(r.x + Math.cos(a) * d, top, r.z + Math.sin(a) * d),
          yaw,
          look: 0,
          lookTo: 0,
          size: this.rng.range(LENGTH[0], LENGTH[1]),
          away: new Vector3(),
          breathed: false,
          dry: 1,
        });
      }
    }
    const make = (b: MeshBuilder, name: string) => {
      const mesh = new InstancedMesh(b.build(), patchMaterial(new MeshStandardMaterial({ vertexColors: true, roughness: 0.55 }), { grime: 0.2 }), this.turtles.length);
      mesh.name = name;
      mesh.castShadow = false;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      mesh.layers.set(LAYER_NO_REFLECT);
      mesh.count = 0;
      // (made now, so the material is compiled with it at load)
      mesh.instanceColor = new InstancedBufferAttribute(new Float32Array(Math.max(1, this.turtles.length) * 3).fill(1), 3);
      this.group.add(mesh);
      return mesh;
    };
    this.bodies = make(turtleBody(), 'turtle');
    this.heads = make(turtleHead(), 'turtle-head');
  }

  /** For a still: each where it would be by now (on its rock if they are out and no boat is near, else in the water). */
  settle(boat: Vector3, out: boolean): void {
    for (const u of this.turtles) {
      const near = Math.hypot(boat.x - u.rock.x, boat.z - u.rock.z) < SHY;
      u.state = out && !near ? 'bask' : 'swim';
      u.t = out && !near ? 0 : 3;
      u.dry = 1;
      if (u.state === 'swim') u.away.set(u.rock.x + 6, 0, u.rock.z);
    }
  }

  /**
   * Moves them on `dt` s: `boat` where the boat is; `out` whether the season, the hour and the weather bring
   * them out to bask (else they stay in the water, unseen).
   */
  update(dt: number, boat: Vector3, out: boolean): void {
    if (dt <= 0) return;
    let n = 0;
    for (const u of this.turtles) {
      const r = u.rock;
      const boatNear = Math.hypot(boat.x - r.x, boat.z - r.z);
      u.t += dt;
      const level = waterLevelAt(r.x, r.z);
      if (!Number.isFinite(level)) continue;
      // a rock the risen water has all but covered has none on it
      const dryTop = r.top - level > 0.25;
      switch (u.state) {
        case 'bask': {
          u.p.set(r.x + u.spot.dx, r.top, r.z + u.spot.dz);
          u.yaw = u.spot.yaw;
          u.dry = Math.min(1, u.dry + dt / 60);
          // it looks about now and then
          if (this.rng.next() < dt * 0.25) u.lookTo = this.rng.range(-0.6, 0.6);
          if (!out || !dryTop || boatNear < SHY) {
            u.state = 'edge';
            u.t = 0;
          }
          break;
        }
        case 'edge': {
          // turning to the water away from the boat and walking to the rock's edge
          const off = Math.atan2(r.x - boat.x, r.z - boat.z) + (out ? 0 : this.rng.range(-1, 1));
          const toYaw = off;
          u.yaw += clamp(Math.atan2(Math.sin(toYaw - u.yaw), Math.cos(toYaw - u.yaw)), -2 * dt, 2 * dt);
          const go = smoothstep(0.5, 1.6, u.t);
          u.p.set(r.x + u.spot.dx + Math.sin(u.yaw) * r.r * 0.75 * go, r.top - 0.1 * go, r.z + u.spot.dz + Math.cos(u.yaw) * r.r * 0.75 * go);
          if (u.t > 1.6) {
            u.state = 'slip';
            u.t = 0;
          }
          break;
        }
        case 'slip': {
          // down the rock's side into the water, nose first
          const f = smoothstep(0, 0.6, u.t);
          u.p.y = lerp(r.top - 0.1, level - 0.25, f);
          u.p.x += Math.sin(u.yaw) * dt * 0.5;
          u.p.z += Math.cos(u.yaw) * dt * 0.5;
          if (u.t >= 0.35 && u.t - dt < 0.35) this.ripples.drop(u.p.x, u.p.z, 0.22, 0.014);
          if (u.t > 0.6) {
            u.state = 'swim';
            u.t = 0;
            u.dry = 0;
            u.breathed = false;
            const d = this.rng.range(5, 9);
            u.away.set(u.p.x + Math.sin(u.yaw) * d, level - 0.5, u.p.z + Math.cos(u.yaw) * d);
          }
          break;
        }
        case 'swim':
        case 'back': {
          // off under the surface, and when the boat has gone, back to its rock
          const to = u.state === 'swim' ? u.away : this.p.set(r.x + Math.sin(u.yaw + Math.PI) * r.r * 0.9, level - 0.35, r.z + Math.cos(u.yaw + Math.PI) * r.r * 0.9);
          const dx = to.x - u.p.x;
          const dz = to.z - u.p.z;
          const d = Math.hypot(dx, dz);
          if (d > 0.2) {
            const want = Math.atan2(dx, dz);
            u.yaw += clamp(Math.atan2(Math.sin(want - u.yaw), Math.cos(want - u.yaw)), -1.5 * dt, 1.5 * dt);
            u.p.x += Math.sin(u.yaw) * Math.min(d, 0.35 * dt * 3);
            u.p.z += Math.cos(u.yaw) * Math.min(d, 0.35 * dt * 3);
          }
          // up once for a breath, its head just breaking the surface
          const breath = u.state === 'swim' && u.t > 5 && u.t < 7.5;
          u.p.y = breath ? lerp(u.p.y, level - 0.08, 1 - Math.exp(-dt * 3)) : lerp(u.p.y, level - 0.5, 1 - Math.exp(-dt * 1.5));
          if (breath && !u.breathed && u.p.y > level - 0.1) {
            u.breathed = true;
            this.ripples.drop(u.p.x + Math.sin(u.yaw) * u.size * 0.6, u.p.z + Math.cos(u.yaw) * u.size * 0.6, 0.08, 0.004);
          }
          if (u.state === 'swim' && u.t > AWAY[0] + (u.size * 1000) % (AWAY[1] - AWAY[0]) && boatNear > SAFE && out && dryTop) {
            u.state = 'back';
            u.t = 0;
          }
          if (u.state === 'back' && d < 0.3) {
            u.state = 'climb';
            u.t = 0;
            this.ripples.drop(u.p.x, u.p.z, 0.18, -0.006);
          }
          if (u.state === 'back' && (boatNear < SHY || !out)) {
            u.state = 'swim';
            u.t = 0;
          }
          break;
        }
        case 'climb': {
          // up out of the water onto its rock, and round to bask
          const f = smoothstep(0, 2.2, u.t);
          u.p.set(lerp(r.x + Math.sin(u.yaw + Math.PI) * r.r * 0.9, r.x + u.spot.dx, f), lerp(level - 0.15, r.top, smoothstep(0, 1.4, u.t)), lerp(r.z + Math.cos(u.yaw + Math.PI) * r.r * 0.9, r.z + u.spot.dz, f));
          if (u.t > 2.4) {
            u.state = 'bask';
            u.t = 0;
          }
          if (boatNear < SHY) {
            u.state = 'edge';
            u.t = 0;
          }
          break;
        }
      }
      u.look += (u.lookTo - u.look) * (1 - Math.exp(-dt * 2));
      // nose down as it goes in and climbs, level otherwise
      const pitch = u.state === 'slip' ? 0.6 : u.state === 'climb' ? -0.5 * (1 - smoothstep(0.6, 2, u.t)) : 0;
      this.q.setFromAxisAngle(this.up, u.yaw).multiply(this.q2.setFromAxisAngle(this.across, pitch));
      this.m.compose(u.p, this.q, this.s.setScalar(u.size));
      this.bodies.setMatrixAt(n, this.m);
      // its head out in front, turned to look, drawn in under its shell when it goes
      const reach = u.state === 'bask' || u.state === 'climb' ? 1 : 0.7;
      this.p.set(0, 0.02, 0.48 * reach).applyQuaternion(this.q).multiplyScalar(u.size).add(u.p);
      this.q2.setFromAxisAngle(this.up, u.yaw + u.look).multiply(this.q3.setFromAxisAngle(this.across, u.state === 'bask' ? -0.25 : 0));
      this.m.compose(this.p, this.q2, this.s.setScalar(u.size));
      this.heads.setMatrixAt(n, this.m);
      // a basking shell dries pale; wet it is dark
      const c = 0.75 + 0.7 * u.dry;
      this.bodies.setColorAt(n, this.tint.setRGB(c * 1.04, c, c * 0.94));
      n++;
    }
    this.bodies.count = this.heads.count = n;
    this.bodies.instanceMatrix.needsUpdate = true;
    this.heads.instanceMatrix.needsUpdate = true;
    if (this.bodies.instanceColor) this.bodies.instanceColor.needsUpdate = true;
  }
}
