import {
  BoxGeometry,
  CylinderGeometry,
  DoubleSide,
  Group,
  LatheGeometry,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  Quaternion,
  Vector2,
  Vector3,
} from 'three';
import type { BufferGeometry } from 'three';
import { LAYER_NO_REFLECT } from '../core/globals';
import { smoothstep } from '../core/mathx';
import { Rng } from '../core/rng';
import { windAt } from '../env/wind';
import { MeshBuilder, mixRgb, rgb, scaleRgb, type RGB } from '../render/builder';
import { instanced, type Placement } from '../render/instancing';
import { patchMaterial } from '../render/patch';
import { softSpotTexture, weaveTexture } from '../render/textures';
import { Boatman, type Outfit, type OarPose } from './boatman';
import { saltPoint, terrainHeight } from './geography';
import type { BodyDrive } from './paddle';
import { SALT_FIELD } from './plan';

// The salt field by where the boat sets out (world/plan.ts SALT_FIELD; the user asked for salt being made).
// The ground of it, the beds and the brine, is painted by the terrain (render/patch.ts). Here is what stands
// on it: the earth bunds between the beds and round the farm; the heaps of salt raked up along the
// crystallizers' bunds (white and drying while the salt season runs, gone to market in the rains); a gola,
// the low thatched shed the salt is kept in, with an old heap under black sheeting beside it; and the people
// at work: three men raking the crust that has formed on the black plastic into lines toward the bund, a
// basket or two by them. They are the boatman's body (human.ts) in their own lungis and gamchhas, each
// drawing a wooden board on a bamboo handle (ফাউড়া) through the salt toward his feet, lifting it and reaching
// out again. In the rains the farm lies flooded and nobody is there.

const F = SALT_FIELD;
/** A bund's cross-section (m): its foot, its crown, its height. */
const BUND = { foot: 0.8, crown: 0.36, height: 0.28 };
const CLAY: RGB = rgb('#6f685d');
const CROWN: RGB = rgb('#857c70');
const RIME: RGB = rgb('#b9b6ae');
const UP = new Vector3(0, 1, 0);

/** Where the farm's sections start along its length (m from its east end). */
const POND_END = F.w * F.pond;
const CRYSTAL_START = F.w * F.evaporation;

/** A crystallizer bed's stage in the work (0..1: brine, crust forming, salt ready to rake, raked): render/patch.ts's own, cell by cell. */
export function saltStage(col: number, row: number): number {
  const x = col * 0.618 + row * 0.29 + 0.11;
  return x - Math.floor(x);
}

/**
 * Where the men rake (the field's frame, m): in the beds nearest the river where the salt stands ready, each
 * in his own, a step in from the bund at its east end, facing up the field (+u), drawing the salt toward it.
 */
export function rakerStations(): { u: number; v: number }[] {
  const cols = Math.round((F.w - CRYSTAL_START) / F.crystalCell[0]);
  const stations: { u: number; v: number }[] = [];
  for (let row = 1; row <= 4 && stations.length < 3; row++) {
    for (let col = 0; col < cols && stations.length < 3; col++) {
      const stage = saltStage(col, row);
      if (stage > 0.6 && stage < 0.8) stations.push({ u: CRYSTAL_START + col * F.crystalCell[0] + 0.9, v: (row + 0.5) * F.crystalCell[1] });
    }
  }
  return stations;
}

/** The world's ground under a point of the field's frame. */
function groundAt(u: number, v: number): { x: number; y: number; z: number } {
  const p = saltPoint(u, v);
  return { x: p.x, y: terrainHeight(p.x, p.z), z: p.z };
}

/** An earth bund from (u0, v0) to (u1, v1) in the field's frame: a low ridge, its crown worn pale, rimed white at its foot. */
function bund(b: MeshBuilder, u0: number, v0: number, u1: number, v1: number): void {
  const a = groundAt(u0, v0);
  const e = groundAt(u1, v1);
  const dx = e.x - a.x;
  const dz = e.z - a.z;
  const len = Math.hypot(dx, dz);
  if (len < 0.5) return;
  // across the bund, horizontally
  const cx = -dz / len;
  const cz = dx / len;
  const f = BUND.foot / 2;
  const c = BUND.crown / 2;
  const h = BUND.height;
  const at = (p: { x: number; y: number; z: number }, across: number, up: number) => new Vector3(p.x + cx * across, p.y + up, p.z + cz * across);
  const slope = Math.atan2(h, f - c);
  for (const side of [-1, 1]) {
    const n = new Vector3(cx * side * Math.sin(slope), Math.cos(slope), cz * side * Math.sin(slope));
    const s = b.vertexCount;
    b.vertex(at(a, side * f, -0.04), n, 0, 0, mixRgb(CLAY, RIME, 0.2));
    b.vertex(at(e, side * f, -0.04), n, 1, 0, mixRgb(CLAY, RIME, 0.2));
    b.vertex(at(e, side * c, h), n, 1, 1, CLAY);
    b.vertex(at(a, side * c, h), n, 0, 1, CLAY);
    if (side > 0) b.quad(s, s + 1, s + 2, s + 3);
    else b.quad(s, s + 3, s + 2, s + 1);
  }
  const s = b.vertexCount;
  b.vertex(at(a, -c, h), UP, 0, 0, CROWN);
  b.vertex(at(a, c, h), UP, 0, 1, CROWN);
  b.vertex(at(e, c, h), UP, 1, 1, CROWN);
  b.vertex(at(e, -c, h), UP, 1, 0, CROWN);
  b.quad(s, s + 1, s + 2, s + 3);
}

/** The lines the bunds run along, in the field's frame: [u0, v0, u1, v1] (render/patch.ts draws the same). */
function bundLines(): [number, number, number, number][] {
  const { w, d, rimInset: r } = F;
  // the bund round the farm, inside its feeder channel
  const lines: [number, number, number, number][] = [
    [r, r, w - r, r],
    [r, d - r, w - r, d - r],
    [r, r, r, d - r],
    [w - r, r, w - r, d - r],
  ];
  // the settling pond's bund, and the evaporation beds' and the crystallizers' between them
  lines.push([POND_END, r, POND_END, d - r], [CRYSTAL_START, r, CRYSTAL_START, d - r]);
  for (let u = POND_END + F.evapCell[0]; u < CRYSTAL_START - 1; u += F.evapCell[0]) lines.push([u, r, u, d - r]);
  for (let v = F.evapCell[1]; v < d - 1; v += F.evapCell[1]) lines.push([POND_END, v, CRYSTAL_START, v]);
  for (let u = CRYSTAL_START + F.crystalCell[0]; u < w - 1; u += F.crystalCell[0]) lines.push([u, r, u, d - r]);
  for (let v = F.crystalCell[1]; v < d - 1; v += F.crystalCell[1]) lines.push([CRYSTAL_START, v, w - r, v]);
  return lines;
}

/** A heap of salt: a rounded cone shovelled up, its sides a little uneven. */
function heap(): BufferGeometry {
  const g = new LatheGeometry(
    [
      [0, 0],
      [1.0, 0],
      [0.96, 0.1],
      [0.84, 0.3],
      [0.66, 0.52],
      [0.44, 0.72],
      [0.2, 0.86],
      [0, 0.9],
    ].map(([r, y]) => new Vector2(r, y)),
    28,
  );
  // lumps where each basketful was tipped on, more of them up its sides than at its foot or its top
  const pos = g.getAttribute('position');
  const p = new Vector3();
  for (let i = 0; i < pos.count; i++) {
    p.fromBufferAttribute(pos, i);
    const a = Math.atan2(p.z, p.x);
    const k = 1 + (0.06 * Math.sin(a * 3 + p.y * 4) + 0.04 * Math.sin(a * 7 - p.y * 9)) * Math.sin(Math.PI * Math.min(1, p.y / 0.9));
    pos.setXYZ(i, p.x * k, p.y, p.z * k);
  }
  g.computeVertexNormals();
  return g;
}

/** A gola: woven-bamboo walls under a low thatched roof, a doorway on its long side (facing its local +z). */
function shed(b: MeshBuilder, at: Vector3, yaw: number, rng: Rng): void {
  const q = new Quaternion().setFromAxisAngle(UP, yaw);
  const place = (x: number, y: number, z: number) => new Vector3(x, y, z).applyQuaternion(q).add(at);
  const L = 5.2;
  const W = 3.2;
  const wallH = 1.5;
  const wall = scaleRgb(rgb('#9a8466'), rng.range(0.85, 1.05));
  for (const [x, z, w, d] of [
    [0, -W / 2, L, 0.06],
    [0, W / 2, L, 0.06],
    [-L / 2, 0, 0.06, W],
    [L / 2, 0, 0.06, W],
  ] as const) {
    b.add(new BoxGeometry(w, wallH + 0.3, d), new Matrix4().compose(place(x, wallH / 2 - 0.15, z), q, new Vector3(1, 1, 1)), wall);
  }
  // the dark doorway
  b.add(new BoxGeometry(0.9, 1.25, 0.02), new Matrix4().compose(place(L * 0.15, 0.62, W / 2 + 0.04), q, new Vector3(1, 1, 1)), rgb('#1e1812'));
  // the roof: two thatched slopes meeting at a ridge, overhanging the walls
  const thatch = scaleRgb(rgb('#8a7448'), rng.range(0.85, 1.05));
  const ridge = wallH + 1.0;
  for (const s of [-1, 1]) {
    const first = b.vertexCount;
    const eave = s * (W / 2 + 0.45);
    const n = new Vector3(0, W / 2 + 0.45, s * 1.0).normalize().applyQuaternion(q);
    b.vertex(place(-L / 2 - 0.4, wallH - 0.15, eave), n, 0, 0, thatch);
    b.vertex(place(L / 2 + 0.4, wallH - 0.15, eave), n, 1, 0, thatch);
    b.vertex(place(L / 2 + 0.4, ridge, 0), n, 1, 1, scaleRgb(thatch, 0.85));
    b.vertex(place(-L / 2 - 0.4, ridge, 0), n, 0, 1, scaleRgb(thatch, 0.85));
    if (s > 0) b.quad(first, first + 1, first + 2, first + 3);
    else b.quad(first, first + 3, first + 2, first + 1);
  }
}

/** A round basket (টুকরি) of split bamboo, open at the top: its foot at the origin. */
function basket(): BufferGeometry {
  return new LatheGeometry(
    [
      [0.0, 0.0],
      [0.15, 0.0],
      [0.2, 0.06],
      [0.25, 0.17],
      [0.265, 0.2],
      [0.25, 0.2],
      [0.23, 0.17],
      [0.18, 0.06],
      [0.0, 0.03],
    ].map(([r, y]) => new Vector2(r, y)),
    14,
  );
}

// ---------- the people at work ----------

/** The raking: its period (s), how far ahead the board is drawn from and to (m), how high it is lifted to reach out again, the handle's length, and the hands' spacing on it. */
const RAKE = { period: 2.7, out: 1.85, in: 1.05, lift: 0.1, handle: 1.8, hands: 0.55, radius: 0.018 };
/** The share of a stroke spent drawing the board in along the ground (the rest lifts it and reaches out). */
const PULL = 0.62;

/** Their lungis, sandos and gamchhas (each Outfit as boatman.ts's). */
const OUTFITS: readonly Outfit[] = [
  { lungi: ['#7a2f2a', '#d9cdb5', '#3e1512'], vest: '#cfc6b4', gamchha: ['#2f6a3a', '#e9e0cc', '#173a1f'], seed: 81 },
  { lungi: ['#3b3b3b', '#a8a8a0', '#1a1a1a'], vest: '#b7ad98', gamchha: ['#a8342a', '#efe6d6', '#5a1410'], seed: 83 },
  { lungi: ['#5a4a2a', '#c9b98f', '#2c2412'], vest: '#d8d2c2', gamchha: ['#284f86', '#e8e2d2', '#16244a'], seed: 85 },
];

/** A man raking salt: the boatman's body on his feet in a crystallizer bed, the rake's board and handle, his soft shadow. */
class Raker {
  readonly group = new Group();
  private readonly man: Boatman;
  private readonly board: Mesh;
  private readonly handle: Mesh;
  private readonly drive: BodyDrive = { twist: -0.15, bend: 0.4, lean: 0, crouch: 0.06, shift: 0 };
  private readonly pose: OarPose = {
    holds: [
      { at: new Vector3(), thumb: new Vector3() },
      { at: new Vector3(), thumb: new Vector3() },
    ],
  };
  private readonly tilt = { rotX: 0, rotZ: 0 };
  private readonly wind = new Vector3();
  private readonly gravity = new Vector3(0, -9.81, 0);
  private readonly air = { x: 0, z: 0 };
  private readonly at = new Vector3();
  private readonly hand = new Vector3();
  private readonly dir = new Vector3();
  private readonly offset: number;

  constructor(outfit: Outfit, offset: number, wood: MeshStandardMaterial, bamboo: MeshStandardMaterial) {
    this.offset = offset;
    this.man = new Boatman(new Vector3(0, 0, 0), [RAKE.radius, RAKE.radius], outfit);
    this.board = new Mesh(new BoxGeometry(0.56, 0.11, 0.03).translate(0, 0.055, 0), wood);
    this.handle = new Mesh(new CylinderGeometry(RAKE.radius, RAKE.radius * 1.1, RAKE.handle, 6).translate(0, RAKE.handle / 2, 0), bamboo);
    const shadow = new Mesh(
      new PlaneGeometry(0.95, 0.75).rotateX(-Math.PI / 2),
      new MeshBasicMaterial({ map: softSpotTexture(), transparent: true, depthWrite: false, color: '#000000', opacity: 0.5 }),
    );
    shadow.position.set(0, 0.03, 0.12);
    this.group.add(this.man.group, this.board, this.handle, shadow);
    // moving things stay out of the shadow map (it is not redrawn every frame), and out of the mirror
    this.group.traverse((o) => {
      o.castShadow = false;
      o.layers.set(LAYER_NO_REFLECT);
    });
  }

  /** Poses him `t` s into the work: where the board is in its stroke, his hands on the handle, his body over it. */
  update(dt: number, t: number): void {
    const cycle = t / RAKE.period + this.offset;
    const phase = cycle - Math.floor(cycle);
    // each stroke a little to one side of the last, so the bed is raked across its width
    const sweep = 0.22 * Math.sin(Math.floor(cycle) * 1.7 + this.offset * 9);
    let reach: number;
    let lift: number;
    if (phase < PULL) {
      reach = RAKE.out + (RAKE.in - RAKE.out) * smoothstep(0, 1, phase / PULL);
      lift = 0;
    } else {
      const k = (phase - PULL) / (1 - PULL);
      reach = RAKE.in + (RAKE.out - RAKE.in) * smoothstep(0, 1, k);
      lift = RAKE.lift * Math.sin(Math.PI * k);
    }
    // how far out the board is (1 reaching, 0 drawn in): he bends and leans into the reach
    const f = (reach - RAKE.in) / (RAKE.out - RAKE.in);
    this.at.set(sweep, 0.02 + lift, reach);
    // his right hand by his right hip, coming in and up as the board comes to him
    this.hand.set(-0.24, 0.98 - 0.2 * f, 0.3 + 0.25 * f);
    this.dir.subVectors(this.hand, this.at);
    const along = Math.min(this.dir.length(), RAKE.handle - 0.08);
    this.dir.normalize();
    const [right, left] = this.pose.holds;
    right.at.copy(this.at).addScaledVector(this.dir, along);
    right.thumb.copy(this.dir);
    left.at.copy(right.at).addScaledVector(this.dir, -RAKE.hands);
    left.thumb.copy(this.dir);
    this.board.position.copy(this.at);
    this.handle.position.copy(this.at).addScaledVector(UP, 0.06);
    this.handle.quaternion.setFromUnitVectors(UP, this.dir);
    this.drive.bend = 0.3 + 0.32 * f;
    this.drive.crouch = 0.04 + 0.05 * f;
    this.drive.shift = -0.02 + 0.12 * f;
    // the wind past him, in his own frame
    const g = this.group;
    windAt(g.position.x, g.position.z, this.air);
    const c = Math.cos(g.rotation.y);
    const s = Math.sin(g.rotation.y);
    this.wind.set(this.air.x * c - this.air.z * s, 0, this.air.x * s + this.air.z * c);
    this.man.update(dt, t, this.drive, this.pose, this.tilt, this.wind, this.gravity);
  }
}

/** The salt field's people at work: hidden out of the salt season, and posed only while the camera is near enough to see them. */
export class SaltWorks {
  readonly group = new Group();
  /** Where each man stands (world), for the film's shot of them. */
  readonly workers: readonly { x: number; y: number; z: number; yaw: number }[];
  private readonly people = new Group();
  private readonly rakers: Raker[] = [];

  constructor() {
    const rng = new Rng(611);
    this.group.name = 'saltworks';

    // the bunds
    const bunds = new MeshBuilder();
    for (const [u0, v0, u1, v1] of bundLines()) {
      // in pieces, so each follows the ground closely
      const n = Math.max(1, Math.ceil(Math.hypot(u1 - u0, v1 - v0) / 8));
      for (let k = 0; k < n; k++) bund(bunds, u0 + ((u1 - u0) * k) / n, v0 + ((v1 - v0) * k) / n, u0 + ((u1 - u0) * (k + 1)) / n, v0 + ((v1 - v0) * (k + 1)) / n);
    }
    const bundMesh = new Mesh(bunds.build(), patchMaterial(new MeshStandardMaterial({ vertexColors: true, roughness: 0.95 }), { grime: 0.45 }));
    bundMesh.receiveShadow = true;
    this.group.add(bundMesh);

    // the crystallizers: who rakes which bed (salt ready on it), and the heaps along the bunds of the beds
    // raked and being raked, on the bund at the end the men draw the salt toward
    const cols = Math.round((F.w - CRYSTAL_START) / F.crystalCell[0]);
    const rows = Math.round(F.d / F.crystalCell[1]);
    const fresh: Placement[] = [];
    const stations = rakerStations();
    for (let row = 1; row < rows - 1; row++) {
      for (let col = 0; col < cols; col++) {
        const stage = saltStage(col, row);
        if (stage < 0.6) continue;
        const u0 = CRYSTAL_START + col * F.crystalCell[0];
        const vMid = (row + 0.5) * F.crystalCell[1];
        // where a man rakes, a heap beside him on the bund at his back (his basket on the other side)
        const worked = stations.some((st) => Math.abs(st.u - u0 - 0.9) < 0.01 && Math.abs(st.v - vMid) < 0.01);
        const spots = worked ? [1.8] : stage >= 0.85 ? [-0.95, 0.95] : [0];
        for (const dv of spots) {
          const g = groundAt(u0, vMid + dv + rng.range(-0.15, 0.15));
          fresh.push({ x: g.x, y: g.y + BUND.height - 0.08, z: g.z, ry: rng.range(0, Math.PI * 2), s: rng.range(0.55, 0.8), sy: rng.range(0.9, 1.25) });
        }
      }
    }
    // the fresh heaps rise through the salt season and are gone to market by the rains (G.uSeasonB.w)
    const seasonal = { key: 'salt-season', pars: '', code: 'transformed *= smoothstep(0.15, 0.55, uSeasonB.w);' };
    const saltMat = patchMaterial(new MeshStandardMaterial({ color: '#e9e7e1', roughness: 0.55 }), { grime: 0.08, vertex: seasonal });
    if (fresh.length) this.group.add(instanced(heap(), saltMat, fresh, { cast: true, receive: true, layer: LAYER_NO_REFLECT }));

    // the gola at the field's far corner, by the hill, its door toward the beds, and the year's old heap
    // kept under black sheeting beside it
    const corner = groundAt(F.w - 7, F.d + 4.5);
    const yaw = F.yaw + Math.PI;
    const shedB = new MeshBuilder();
    shed(shedB, new Vector3(corner.x, corner.y, corner.z), yaw, rng);
    const shedMesh = new Mesh(shedB.build(), patchMaterial(new MeshStandardMaterial({ vertexColors: true, roughness: 0.92, side: DoubleSide }), { grime: 0.4 }));
    shedMesh.castShadow = true;
    shedMesh.receiveShadow = true;
    this.group.add(shedMesh);
    const kept = groundAt(F.w - 15, F.d + 4.2);
    const covered = new Mesh(heap(), patchMaterial(new MeshStandardMaterial({ color: '#1b1c1f', roughness: 0.4 }), { grime: 0.2 }));
    covered.position.set(kept.x, kept.y - 0.05, kept.z);
    covered.scale.set(2.3, 1.5, 2.0);
    covered.rotation.y = yaw;
    covered.castShadow = true;
    covered.receiveShadow = true;
    this.group.add(covered);

    // the men, and a basket or two by each, on the bund behind him
    const wood = patchMaterial(new MeshStandardMaterial({ color: '#6b5236', roughness: 0.85 }), { grime: 0.3 });
    const bamboo = patchMaterial(new MeshStandardMaterial({ color: '#a39469', roughness: 0.7 }), { grime: 0.3 });
    const weave = weaveTexture(57);
    weave.repeat.set(6, 2);
    const basketMat = patchMaterial(new MeshStandardMaterial({ map: weave, color: '#cdb78a', roughness: 0.9, side: DoubleSide }), { grime: 0.3 });
    const basketGeo = basket();
    const workers: { x: number; y: number; z: number; yaw: number }[] = [];
    stations.forEach((st, i) => {
      const g = groundAt(st.u, st.v);
      const r = new Raker(OUTFITS[i % OUTFITS.length], i * 0.37, wood, bamboo);
      r.group.position.set(g.x, g.y, g.z);
      r.group.rotation.y = F.yaw;
      this.people.add(r.group);
      this.rakers.push(r);
      workers.push({ x: g.x, y: g.y, z: g.z, yaw: F.yaw });
      const b = groundAt(st.u - 0.9, st.v - 1.5);
      const m = new Mesh(basketGeo, basketMat);
      m.position.set(b.x, b.y + BUND.height - 0.02, b.z);
      m.rotation.y = rng.range(0, Math.PI * 2);
      m.layers.set(LAYER_NO_REFLECT);
      this.people.add(m);
    });
    this.workers = workers;
    this.group.add(this.people);
  }

  /** `eye`: the camera; `salt`: the season's salt work (env/season.ts). */
  update(dt: number, t: number, eye: Vector3, salt: number): void {
    const working = salt > 0.5;
    this.people.visible = working;
    if (!working || Math.hypot(eye.x - F.x, eye.z - F.z) > 320) return;
    for (const r of this.rakers) r.update(dt, t);
  }
}
