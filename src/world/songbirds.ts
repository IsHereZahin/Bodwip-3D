import { BufferAttribute, BufferGeometry, DoubleSide, DynamicDrawUsage, Group, InstancedBufferAttribute, InstancedMesh, Matrix4, MeshStandardMaterial, Quaternion, Vector3 } from 'three';
import { LAYER_NO_REFLECT } from '../core/globals';
import { smoothstep } from '../core/mathx';
import { Rng } from '../core/rng';
import { placementMatrix } from '../render/instancing';
import { patchMaterial } from '../render/patch';
import { terrainHeight, waterLevelAt } from './geography';
import { FLAP, birdGeometry } from './life';
import type { Crown } from './vegetation';

// The village's small birds round the camera (mynas, bulbuls, sparrows): sitting on the leaves at the tops of the
// trees, swaying with them in the wind, or down on open ground, and every so often one flies off to another tree
// near by in the bounding flight small birds have, wings in bursts, and settles there; no two on one spot. They
// sit still at night and in hard rain. Few, small and unhurried, so they are noticed rather than watched.

/** How many birds keep round the camera. */
const BIRDS = 24;
/** Perches are found within this of the camera (m); a bird farther off flies back in. */
const NEAR = 40;
const FAR = 85;
/** Seconds a bird sits, at least and at most. */
const SIT: [number, number] = [3, 14];
/** Flying speed (m/s). */
const SPEED: [number, number] = [6, 9];
/** The trees are found by the squares of ground they stand in, this wide (m). */
const CELL = 40;
const cellKey = (i: number, j: number) => (i + 4096) * 8192 + j + 4096;

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
  /** Where it sits (on a crown, where the tree holds it at rest: the shader sways it with the tree). */
  at: Vector3;
  /** Its flight's ends. */
  from: Vector3;
  to: Vector3;
  /** The crown and the top of its leaves it sits on (null: on the ground), and those it is flying to. */
  crown: Crown | null;
  top: number;
  next: Crown | null;
  nextTop: number;
  heading: number;
  /** Seconds left sitting; while flying, how far along (0..1) and how long the flight takes. */
  sit: number;
  f: number;
  dur: number;
  flying: boolean;
  placed: boolean;
}

/** Each bird's share of the sway of the tree it is on, per instance (patch.ts `swayWith`). */
class TreeSway {
  private readonly at = new InstancedBufferAttribute(new Float32Array(BIRDS * 3), 3);
  private readonly root = new InstancedBufferAttribute(new Float32Array(BIRDS * 3), 3);
  private readonly sway = new InstancedBufferAttribute(new Float32Array(BIRDS * 2), 2);

  constructor(geometry: BufferGeometry) {
    for (const [name, a] of [
      ['aSwayAt', this.at],
      ['aSwayRoot', this.root],
      ['aSway', this.sway],
    ] as const) {
      a.setUsage(DynamicDrawUsage);
      geometry.setAttribute(name, a);
    }
  }

  /** Instance `i` sways as top `top` of `crown` does, by `share` of it (none on the ground). */
  set(i: number, crown: Crown | null, top: number, share: number): void {
    if (!crown || share <= 0) {
      this.sway.setXY(i, 0, 1);
      return;
    }
    const { place, tops, wind, windHeight } = crown.perch;
    this.at.setXYZ(i, tops[top].x, tops[top].y, tops[top].z);
    this.root.setXYZ(i, place.x, place.y, place.z);
    this.sway.setXY(i, wind * share, windHeight);
  }

  changed(): void {
    this.at.needsUpdate = true;
    this.root.needsUpdate = true;
    this.sway.needsUpdate = true;
  }
}

export class Songbirds {
  readonly group = new Group();
  private readonly sitting: InstancedMesh;
  private readonly flying: InstancedMesh;
  private readonly sittingSway: TreeSway;
  private readonly flyingSway: TreeSway;
  /** Scratch for each frame's posing (nothing is made there). */
  private readonly scratch = { m: new Matrix4(), place: new Matrix4(), q: new Quaternion(), one: new Vector3(1, 1, 1), up: new Vector3(0, 1, 0), p: new Vector3() };
  private readonly birds: Bird[] = [];
  /** The crowns, by the square of ground they stand in (`CELL`), and those found near the camera. */
  private readonly cells = new Map<number, Crown[]>();
  private readonly found: Crown[] = [];
  private readonly rng = new Rng(63);

  constructor(crowns: readonly Crown[]) {
    this.group.name = 'songbirds';
    const color = '#2b2420';
    const sitMat = patchMaterial(new MeshStandardMaterial({ color, roughness: 0.85, side: DoubleSide }), { swayWith: true });
    const flyMat = patchMaterial(new MeshStandardMaterial({ color, roughness: 0.85, side: DoubleSide }), { vertex: FLAP, swayWith: true });
    const perched = perchedGeometry();
    this.sittingSway = new TreeSway(perched);
    this.sitting = new InstancedMesh(perched, sitMat, BIRDS);
    const wings = birdGeometry(0.3, 0.17);
    const beat = new Float32Array(BIRDS * 2);
    for (let i = 0; i < BIRDS; i++) {
      beat[i * 2] = this.rng.range(0, 6.28);
      beat[i * 2 + 1] = this.rng.range(16, 22);
    }
    wings.setAttribute('aBird', new InstancedBufferAttribute(beat, 2));
    this.flyingSway = new TreeSway(wings);
    this.flying = new InstancedMesh(wings, flyMat, BIRDS);
    for (const mesh of [this.sitting, this.flying]) {
      mesh.frustumCulled = false;
      mesh.castShadow = false;
      mesh.layers.set(LAYER_NO_REFLECT);
      mesh.count = 0;
      this.group.add(mesh);
    }
    for (let i = 0; i < BIRDS; i++) {
      this.birds.push({ at: new Vector3(), from: new Vector3(), to: new Vector3(), crown: null, top: 0, next: null, nextTop: 0, heading: 0, sit: 0, f: 0, dur: 1, flying: false, placed: false });
    }
    for (const c of crowns) {
      if (!c.perch.tops.length) continue;
      const k = cellKey(Math.floor(c.x / CELL), Math.floor(c.z / CELL));
      let list = this.cells.get(k);
      if (!list) this.cells.set(k, (list = []));
      list.push(c);
    }
  }

  /** The crowns within `reach` of `eye`. */
  private near(eye: Vector3, reach: number): Crown[] {
    const out = this.found;
    out.length = 0;
    for (let i = Math.floor((eye.x - reach) / CELL); i <= Math.floor((eye.x + reach) / CELL); i++) {
      for (let j = Math.floor((eye.z - reach) / CELL); j <= Math.floor((eye.z + reach) / CELL); j++) {
        const list = this.cells.get(cellKey(i, j));
        if (list) for (const c of list) if (Math.hypot(c.x - eye.x, c.z - eye.z) <= reach) out.push(c);
      }
    }
    return out;
  }

  /** Whether a bird sits on top `top` of `crown`, or is flying to it. */
  private taken(crown: Crown, top: number): boolean {
    return this.birds.some((o) => (o.crown === crown && o.top === top) || (o.flying && o.next === crown && o.nextTop === top));
  }

  /**
   * Where `b` goes next near `eye` (`next`, `nextTop` and `to`): the top of a tree's crown no other bird has, or
   * now and then open ground; false if there is none.
   */
  private choose(eye: Vector3, b: Bird): boolean {
    if (this.rng.next() < 0.3) {
      for (let k = 0; k < 6; k++) {
        const a = this.rng.range(0, Math.PI * 2);
        const d = this.rng.range(8, NEAR);
        const x = eye.x + Math.cos(a) * d;
        const z = eye.z + Math.sin(a) * d;
        const g = terrainHeight(x, z);
        if (waterLevelAt(x, z) > g - 0.2) continue;
        b.next = null;
        b.to.set(x, g, z);
        return true;
      }
    }
    // a tree near by; with none, one further off
    let crowns = this.near(eye, NEAR);
    if (!crowns.length) crowns = this.near(eye, FAR);
    for (let k = 0; k < 10 && crowns.length; k++) {
      const c = crowns[this.rng.int(0, crowns.length - 1)];
      const top = this.rng.int(0, c.perch.tops.length - 1);
      if (this.taken(c, top)) continue;
      b.next = c;
      b.nextTop = top;
      b.to.copy(c.perch.tops[top]).applyMatrix4(placementMatrix(c.perch.place, this.scratch.place));
      return true;
    }
    return false;
  }

  /** `b` comes to rest where it was going. */
  private settle(b: Bird): void {
    b.crown = b.next;
    b.top = b.nextTop;
    b.at.copy(b.to);
  }

  /** `still`: night or hard rain, when they keep to their perches. */
  update(dt: number, t: number, eye: Vector3, still: boolean): void {
    if (!this.cells.size) return;
    const { m, q, one, up, p } = this.scratch;
    let ns = 0;
    let nf = 0;
    for (const b of this.birds) {
      if (!b.placed) {
        // the first time: sitting already somewhere near
        if (!this.choose(eye, b)) continue;
        this.settle(b);
        b.placed = true;
        b.sit = this.rng.range(0, SIT[1]);
        b.heading = this.rng.range(0, Math.PI * 2);
      }
      if (!b.flying) {
        b.sit -= dt;
        const far = Math.hypot(b.at.x - eye.x, b.at.z - eye.z) > FAR;
        if ((b.sit <= 0 || far) && !still && this.choose(eye, b)) {
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
        this.flying.setMatrixAt(nf, m);
        // off its perch as the tree sways it, onto the next as that one sways, on its own wings between
        if (b.f < 0.5) this.flyingSway.set(nf, b.crown, b.top, 1 - smoothstep(0, 0.4, b.f));
        else this.flyingSway.set(nf, b.next, b.nextTop, smoothstep(0.6, 1, b.f));
        nf++;
        if (b.f >= 1) {
          b.flying = false;
          this.settle(b);
          b.sit = this.rng.range(SIT[0], SIT[1]);
        }
        continue;
      }
      // sitting it turns its head about now and then (the whole bird, at this size)
      q.setFromAxisAngle(up, b.heading + Math.sin(t * 0.4 + b.sit) * 0.6);
      m.compose(b.at, q, one);
      this.sitting.setMatrixAt(ns, m);
      this.sittingSway.set(ns, b.crown, b.top, 1);
      ns++;
    }
    this.sitting.count = ns;
    this.flying.count = nf;
    this.sitting.instanceMatrix.needsUpdate = true;
    this.flying.instanceMatrix.needsUpdate = true;
    this.sittingSway.changed();
    this.flyingSway.changed();
  }
}
