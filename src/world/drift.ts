import { BufferGeometry, DoubleSide, DynamicDrawUsage, Group, InstancedMesh, Matrix4, MeshStandardMaterial, Quaternion, Vector3 } from 'three';
import { LAYER_NO_REFLECT } from '../core/globals';
import { Rng } from '../core/rng';
import { MeshBuilder, mixRgb, rgb, scaleRgb, taperedTube, type RGB } from '../render/builder';
import { patchMaterial } from '../render/patch';
import { CHARS, charHeight, downstream, halfWidth, riverX, terrainHeight } from './geography';
import { HERO_HULL } from './hull';

// Things the river carries: mats of water hyacinth (kochuripana) with their lilac spikes, and fallen
// leaves. They ride the surface current, fastest mid-river and slack by the banks, turn slowly as
// they go, keep off the banks and the chars, and slide round the boat's hull as it passes.

const UP = new Vector3(0, 1, 0);
const MATS = 96;
const LEAVES = 170;
/** How far behind and ahead of the viewer (along the river) floating things are kept. */
const BEHIND = 140;
const AHEAD = 620;

/** A round, cupped leaf (water hyacinth). */
function cuppedLeaf(b: MeshBuilder, at: Vector3, facing: Vector3, r: number, color: RGB): void {
  const u = new Vector3().crossVectors(facing, Math.abs(facing.y) < 0.9 ? UP : new Vector3(1, 0, 0)).normalize();
  const v = new Vector3().crossVectors(facing, u).normalize();
  const c = b.vertex(at, facing, 0.5, 0.5, scaleRgb(color, 0.8));
  const N = 9;
  const ring: number[] = [];
  for (let k = 0; k < N; k++) {
    const a = (k / N) * Math.PI * 2;
    const p = at.clone().addScaledVector(u, Math.cos(a) * r).addScaledVector(v, Math.sin(a) * r * 0.9).addScaledVector(facing, r * 0.25);
    const n = facing.clone().addScaledVector(u, Math.cos(a) * 0.4).addScaledVector(v, Math.sin(a) * 0.4).normalize();
    ring.push(b.vertex(p, n, 0, 0, color));
  }
  for (let k = 0; k < N; k++) b.tri(c, ring[k], ring[(k + 1) % N]);
}

/** One water-hyacinth plant: swollen stalks fanning out, a glossy leaf on each, sometimes a flower spike. */
function rosette(b: MeshBuilder, at: Vector3, rng: Rng, flower: boolean): void {
  const n = rng.int(6, 9);
  const green = mixRgb(rgb('#2f6a1c'), rgb('#5c9a33'), rng.next());
  for (let k = 0; k < n; k++) {
    const az = (k / n) * Math.PI * 2 + rng.range(-0.3, 0.3);
    const out = new Vector3(Math.cos(az), 0, Math.sin(az));
    const len = rng.range(0.1, 0.22);
    const tip = at.clone().addScaledVector(out, len * 0.55).addScaledVector(UP, len * 0.85);
    const mid = at.clone().lerp(tip, 0.45).addScaledVector(out, 0.015);
    taperedTube(b, [at.clone(), mid, tip], [0.012, 0.024, 0.008], 4, rgb('#4f7f2a'), 1);
    const facing = out.clone().multiplyScalar(0.55).add(UP).normalize();
    cuppedLeaf(b, tip.clone().addScaledVector(facing, 0.01), facing, rng.range(0.06, 0.095), mixRgb(green, rgb('#7aae44'), rng.next() * 0.4));
  }
  if (flower) {
    const top = at.clone().addScaledVector(UP, rng.range(0.24, 0.32));
    taperedTube(b, [at.clone(), top], [0.01, 0.007], 4, rgb('#4f7f2a'), 1);
    const lilac = rgb('#b9a3e3');
    for (let k = 0; k < 9; k++) {
      const p = top.clone().add(new Vector3(rng.range(-0.035, 0.035), -k * 0.014, rng.range(-0.035, 0.035)));
      const face = new Vector3(rng.range(-1, 1), 0.5, rng.range(-1, 1)).normalize();
      const u = new Vector3().crossVectors(face, UP).normalize();
      const v = new Vector3().crossVectors(face, u).normalize();
      const c = b.vertex(p, face, 0.5, 0.5, rgb('#e8c43a'));
      for (let q = 0; q < 6; q++) {
        const a0 = (q / 6) * Math.PI * 2;
        const s = 0.022;
        const p0 = b.vertex(p.clone().addScaledVector(u, Math.cos(a0) * s).addScaledVector(v, Math.sin(a0) * s), face, 0, 0, lilac);
        const p1 = b.vertex(p.clone().addScaledVector(u, Math.cos(a0 + 0.9) * s * 0.4).addScaledVector(v, Math.sin(a0 + 0.9) * s * 0.4), face, 0, 0, lilac);
        b.tri(c, p0, p1);
      }
    }
  }
}

/** A mat of hyacinth: plants packed together, a metre or three across. */
function hyacinthMat(seed: number): BufferGeometry {
  const rng = new Rng(seed);
  const b = new MeshBuilder();
  const n = rng.int(8, 22);
  const r = 0.4 + n * 0.1;
  for (let i = 0; i < n; i++) {
    const a = rng.range(0, Math.PI * 2);
    const d = Math.sqrt(rng.next()) * r;
    rosette(b, new Vector3(Math.cos(a) * d, 0, Math.sin(a) * d * 0.7), rng, rng.next() < 0.25);
  }
  return b.build();
}

/** A fallen leaf, curled a little, yellowing. */
function floatingLeaf(): BufferGeometry {
  const b = new MeshBuilder();
  const N = 6;
  const left: number[] = [];
  const right: number[] = [];
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const w = Math.sin(Math.PI * t) * 0.045;
    const curl = Math.sin(Math.PI * t) * 0.01;
    const c = mixRgb(rgb('#8a7a2a'), rgb('#b58a3a'), t);
    left.push(b.vertex(new Vector3(-w, curl, (t - 0.5) * 0.16), UP, 0, t, c));
    right.push(b.vertex(new Vector3(w, curl, (t - 0.5) * 0.16), UP, 1, t, c));
  }
  for (let i = 0; i < N; i++) b.quad(left[i], right[i], right[i + 1], left[i + 1]);
  return b.build();
}

interface Floater {
  x: number;
  z: number;
  yaw: number;
  spin: number;
  scale: number;
  /** Radius it keeps from the hull. */
  r: number;
  phase: number;
  mesh: number;
  slot: number;
}

export interface Hull {
  pos: Vector3;
  heading: number;
}

const HALF_LEN = HERO_HULL.len / 2;

export class Drift {
  readonly group = new Group();
  private readonly meshes: InstancedMesh[] = [];
  private readonly items: Floater[] = [];
  private readonly rng = new Rng(404);
  private readonly m = new Matrix4();
  private readonly q = new Quaternion();
  private readonly p = new Vector3();
  private readonly s = new Vector3();
  private lastZ = Number.NaN;
  private vz = 0;

  constructor() {
    this.group.name = 'drift';
    const mat = patchMaterial(new MeshStandardMaterial({ vertexColors: true, roughness: 0.38, side: DoubleSide }), {
      translucency: 0.9,
      grime: 0.15,
    });
    const geometries = [hyacinthMat(1), hyacinthMat(2), hyacinthMat(3), floatingLeaf()];
    const counts = [MATS / 3, MATS / 3, MATS / 3, LEAVES].map(Math.round);
    geometries.forEach((g, i) => {
      const mesh = new InstancedMesh(g, mat, counts[i]);
      mesh.instanceMatrix.setUsage(DynamicDrawUsage);
      mesh.frustumCulled = false;
      mesh.receiveShadow = true;
      mesh.layers.set(LAYER_NO_REFLECT);
      this.meshes.push(mesh);
      this.group.add(mesh);
      for (let slot = 0; slot < counts[i]; slot++) {
        const leaf = i === 3;
        this.items.push({
          x: 0,
          z: Number.NaN,
          yaw: this.rng.range(0, Math.PI * 2),
          spin: this.rng.range(-0.08, 0.08),
          scale: leaf ? this.rng.range(0.8, 1.3) : this.rng.range(0.9, 1.5),
          r: leaf ? 0.08 : 1.4,
          phase: this.rng.range(0, 10),
          mesh: i,
          slot,
        });
      }
    });
  }

  /** `viewZ`: where the viewer is along the river; `hull`: the boat the floaters part round. */
  update(dt: number, t: number, viewZ: number, hull: Hull): void {
    // which way the river moves past the viewer decides where new floaters come into view; a jump
    // (a film cut, the journey looping, a still being set up) scatters them afresh round the new spot
    const jumped = Number.isNaN(this.lastZ) || Math.abs(viewZ - this.lastZ) > 60;
    if (jumped) this.vz = 0;
    else if (dt > 0) this.vz += ((viewZ - this.lastZ) / dt - this.vz) * Math.min(1, dt * 2);
    this.lastZ = viewZ;
    const fw = { x: Math.sin(hull.heading), z: Math.cos(hull.heading) };
    const rt = { x: Math.cos(hull.heading), z: -Math.sin(hull.heading) };
    for (const f of this.items) {
      if (jumped || f.z > viewZ + BEHIND || f.z < viewZ - AHEAD) this.spawn(f, viewZ, jumped);
      // the surface current: fastest mid-river, slack by the banks (as in the water's flow field)
      const cx = riverX(f.z);
      const u = (f.x - cx) / halfWidth(f.z);
      const speed = 0.05 + 0.8 * Math.max(0, 1 - u * u);
      const [dx, dz] = downstream(f.z);
      f.x += dx * speed * dt;
      f.z += dz * speed * dt;
      f.yaw += f.spin * dt;
      // eddies by the bank and round the chars turn them back toward open water
      if (terrainHeight(f.x, f.z) > -0.35) f.x += (cx - f.x) * Math.min(1, dt * 0.5);
      // slide round the hull rather than through it
      const bx = f.x - hull.pos.x;
      const bz = f.z - hull.pos.z;
      const along = bx * fw.x + bz * fw.z;
      const across = bx * rt.x + bz * rt.z;
      const s = along / HALF_LEN;
      if (Math.abs(s) < 1.2) {
        const beam = 0.82 * Math.sqrt(Math.max(0, 1 - Math.min(1, s * s))) + 0.05 + f.r * f.scale * 0.5;
        if (Math.abs(across) < beam) {
          const a = (across < 0 ? -1 : 1) * beam;
          f.x = hull.pos.x + fw.x * along + rt.x * a;
          f.z = hull.pos.z + fw.z * along + rt.z * a;
        }
      }
      const bob = 0.015 * Math.sin(t * 1.3 + f.phase);
      this.q.setFromAxisAngle(UP, f.yaw);
      this.m.compose(this.p.set(f.x, 0.005 + bob, f.z), this.q, this.s.setScalar(f.scale));
      this.meshes[f.mesh].setMatrixAt(f.slot, this.m);
    }
    for (const mesh of this.meshes) mesh.instanceMatrix.needsUpdate = true;
  }

  /** Puts a floater where the river will bring it into view (or anywhere in the window, at the start). */
  private spawn(f: Floater, viewZ: number, anywhere: boolean): void {
    // the current runs toward −z at under a metre a second; the boat outpaces it, a still viewer does not
    const comesFromAhead = this.vz < -0.8;
    for (let tries = 0; tries < 12; tries++) {
      const z = anywhere
        ? viewZ + this.rng.range(-AHEAD, BEHIND)
        : comesFromAhead
          ? viewZ - this.rng.range(AHEAD * 0.45, AHEAD * 0.98)
          : viewZ + this.rng.range(BEHIND * 0.5, BEHIND * 0.95);
      const hw = halfWidth(z);
      const u = this.rng.sign() * hw * this.rng.range(0.03, 0.88);
      if (charHeight(z, u) > -0.8 || CHARS.some((c) => Math.abs(z - c.z) < c.halfLen && Math.abs(u - c.u) < c.halfWid + 6)) continue;
      f.z = z;
      f.x = riverX(z) + u;
      return;
    }
    f.z = viewZ - AHEAD * 0.5;
    f.x = riverX(f.z);
  }
}
