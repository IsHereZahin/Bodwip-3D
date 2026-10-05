import { BufferAttribute, BufferGeometry, DoubleSide, Group, InstancedBufferAttribute, InstancedMesh, Matrix4, MeshStandardMaterial, Quaternion, Vector3 } from 'three';
import { LAYER_NO_REFLECT } from '../core/globals';
import { Rng } from '../core/rng';
import { patchMaterial } from '../render/patch';
import { terrainHeight, waterLevelAt } from './geography';
import { FLAP, birdGeometry } from './life';
import type { Crown } from './vegetation';

// The village's small birds round the camera (mynas, bulbuls, sparrows): sitting on the tops of the trees or
// down on open ground, and every so often one flies off to another tree near by in the bounding flight small
// birds have, wings in bursts, and settles there. They sit still at night and in hard rain. Few, small and
// unhurried, so they are noticed rather than watched.

/** How many birds keep round the camera. */
const BIRDS = 24;
/** Perches are found within this of the camera (m); a bird farther off flies back in. */
const NEAR = 40;
const FAR = 85;
/** Seconds a bird sits, at least and at most. */
const SIT: [number, number] = [3, 14];
/** Flying speed (m/s). */
const SPEED: [number, number] = [6, 9];

/** A small bird sitting, its feet at the origin, facing +z: a plump body, a tail, a head. */
function perchedGeometry(): BufferGeometry {
  const P: number[] = [];
  const tri = (a: number[], b: number[], c: number[]) => P.push(...a, ...b, ...c);
  const top = [0, 0.11, 0.0];
  const breast = [0, 0.07, 0.06];
  const l = [-0.035, 0.07, -0.01];
  const r = [0.035, 0.07, -0.01];
  const under = [0, 0.03, -0.02];
  const rump = [0, 0.07, -0.08];
  const tail = [0, 0.03, -0.17];
  const head = [0, 0.15, 0.06];
  const beak = [0, 0.135, 0.11];
  for (const [a, b] of [
    [l, r],
    [r, l],
  ]) {
    tri(top, a, breast);
    tri(breast, a, under);
    tri(top, rump, a);
    tri(a, rump, under);
    tri(rump, tail, b);
    tri(top, breast, head);
    tri(head, breast, beak);
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(P), 3));
  g.computeVertexNormals();
  return g;
}

interface Bird {
  at: Vector3;
  to: Vector3;
  from: Vector3;
  heading: number;
  /** Seconds left sitting; while flying, how far along (0..1) and how long the flight takes. */
  sit: number;
  f: number;
  dur: number;
  flying: boolean;
  placed: boolean;
}

export class Songbirds {
  readonly group = new Group();
  private readonly sitting: InstancedMesh;
  private readonly flying: InstancedMesh;
  private readonly birds: Bird[] = [];
  private readonly crowns: readonly Crown[];
  private readonly rng = new Rng(63);

  constructor(crowns: readonly Crown[]) {
    this.crowns = crowns;
    this.group.name = 'songbirds';
    const color = '#2b2420';
    const sitMat = patchMaterial(new MeshStandardMaterial({ color, roughness: 0.85, side: DoubleSide }), {});
    const flyMat = patchMaterial(new MeshStandardMaterial({ color, roughness: 0.85, side: DoubleSide }), { vertex: FLAP });
    this.sitting = new InstancedMesh(perchedGeometry(), sitMat, BIRDS);
    const wings = birdGeometry(0.3, 0.17);
    const beat = new Float32Array(BIRDS * 2);
    for (let i = 0; i < BIRDS; i++) {
      beat[i * 2] = this.rng.range(0, 6.28);
      beat[i * 2 + 1] = this.rng.range(16, 22);
    }
    wings.setAttribute('aBird', new InstancedBufferAttribute(beat, 2));
    this.flying = new InstancedMesh(wings, flyMat, BIRDS);
    for (const mesh of [this.sitting, this.flying]) {
      mesh.frustumCulled = false;
      mesh.castShadow = false;
      mesh.layers.set(LAYER_NO_REFLECT);
      mesh.count = 0;
      this.group.add(mesh);
    }
    for (let i = 0; i < BIRDS; i++) {
      this.birds.push({ at: new Vector3(), to: new Vector3(), from: new Vector3(), heading: 0, sit: 0, f: 0, dur: 1, flying: false, placed: false });
    }
  }

  /** A perch near `eye`: the top of a tree's crown, or now and then open ground; false if none is near. */
  private perch(eye: Vector3, out: Vector3): boolean {
    if (this.rng.next() < 0.3) {
      for (let k = 0; k < 6; k++) {
        const a = this.rng.range(0, Math.PI * 2);
        const d = this.rng.range(8, NEAR);
        const x = eye.x + Math.cos(a) * d;
        const z = eye.z + Math.sin(a) * d;
        const g = terrainHeight(x, z);
        if (waterLevelAt(x, z) > g - 0.2) continue;
        out.set(x, g, z);
        return true;
      }
    }
    for (let k = 0; k < 10; k++) {
      const c = this.crowns[this.rng.int(0, this.crowns.length - 1)];
      if (Math.abs(c.x - eye.x) > NEAR || Math.abs(c.z - eye.z) > NEAR) continue;
      const a = this.rng.range(0, Math.PI * 2);
      const d = this.rng.range(0, c.r * 0.45);
      out.set(c.x + Math.cos(a) * d, c.y + c.r * 0.72, c.z + Math.sin(a) * d);
      return true;
    }
    // no tree near by: search the whole list for the nearest crown
    let best: Crown | null = null;
    let bd = Infinity;
    for (const c of this.crowns) {
      const d = Math.hypot(c.x - eye.x, c.z - eye.z);
      if (d < bd) (bd = d), (best = c);
    }
    if (!best || bd > FAR) return false;
    out.set(best.x, best.y + best.r * 0.72, best.z);
    return true;
  }

  /** `still`: night or hard rain, when they keep to their perches. */
  update(dt: number, t: number, eye: Vector3, still: boolean): void {
    if (!this.crowns.length) return;
    const m = new Matrix4();
    const q = new Quaternion();
    const one = new Vector3(1, 1, 1);
    const up = new Vector3(0, 1, 0);
    const p = new Vector3();
    let ns = 0;
    let nf = 0;
    for (const b of this.birds) {
      if (!b.placed) {
        // the first time: sitting already somewhere near
        if (!this.perch(eye, b.at)) continue;
        b.placed = true;
        b.sit = this.rng.range(0, SIT[1]);
        b.heading = this.rng.range(0, Math.PI * 2);
      }
      if (!b.flying) {
        b.sit -= dt;
        const far = Math.hypot(b.at.x - eye.x, b.at.z - eye.z) > FAR;
        if ((b.sit <= 0 || far) && !still && this.perch(eye, b.to)) {
          b.from.copy(b.at);
          b.flying = true;
          b.f = 0;
          b.dur = Math.max(0.8, b.from.distanceTo(b.to) / this.rng.range(SPEED[0], SPEED[1]));
          b.heading = Math.atan2(b.to.x - b.from.x, b.to.z - b.from.z);
        }
      }
      if (b.flying) {
        b.f = Math.min(1, b.f + dt / b.dur);
        const d = b.from.distanceTo(b.to);
        // a bounding flight: up from the perch, along in dips, down onto the next
        p.lerpVectors(b.from, b.to, b.f);
        p.y += 4 * Math.min(6, d * 0.15) * b.f * (1 - b.f) + Math.sin(b.f * Math.PI * Math.max(1, Math.round(d / 6))) * 0.35;
        q.setFromAxisAngle(up, b.heading);
        m.compose(p, q, one);
        this.flying.setMatrixAt(nf++, m);
        if (b.f >= 1) {
          b.flying = false;
          b.at.copy(b.to);
          b.sit = this.rng.range(SIT[0], SIT[1]);
        }
        continue;
      }
      // sitting it turns its head about now and then (the whole bird, at this size)
      q.setFromAxisAngle(up, b.heading + Math.sin(t * 0.4 + b.sit) * 0.6);
      m.compose(b.at, q, one);
      this.sitting.setMatrixAt(ns++, m);
    }
    this.sitting.count = ns;
    this.flying.count = nf;
    this.sitting.instanceMatrix.needsUpdate = true;
    this.flying.instanceMatrix.needsUpdate = true;
  }
}
