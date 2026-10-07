import {
  BoxGeometry,
  CylinderGeometry,
  DoubleSide,
  Group,
  LatheGeometry,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  Quaternion,
  Vector2,
  Vector3,
} from 'three';
import type { BufferGeometry, Vector4 } from 'three';
import { LAYER_NO_REFLECT } from '../core/globals';
import { Rng } from '../core/rng';
import { MeshBuilder, mixRgb, rgb, scaleRgb, type RGB } from '../render/builder';
import { holdWhileHidden } from '../render/cull';
import { instanced, type Placement } from '../render/instancing';
import { patchMaterial } from '../render/patch';
import { weaveTexture } from '../render/textures';
import type { Outfit } from './boatman';
import { Fisher, type FisherPlace } from './fisher';
import type { Ripples } from './ripples';
import { SALT_CREEK, WATER_LEVEL, saltLocal, saltPoint, saltRains, terrainHeight, waterLevelAt } from './geography';
import { PLAIN, SALT_FIELD, SALT_FIELDS, type SaltFarm, type SaltTask } from './plan';
import { Feeder, Raker, Spader, Walker, Watcher, basketGeometry, type Drop } from './saltHands';

// The salt farms by where the boat sets out (world/plan.ts SALT_FIELDS; the user asked for salt being made, and
// for several farms, none alike). The ground of each, its pans dug into the fields and its embankment round
// them, is world/geography.ts's; its beds and brine are painted by the terrain (render/patch.ts), and the rains
// stand in its pans as real water. Here is what stands on it: the earth bunds between the beds, each its own
// height, so that the rains drown some and not others; the heaps of salt raked up along the crystallizers' bunds
// (white and drying while the salt season runs, gone to market in the rains), and where the carriers tip theirs;
// at the creek's farm a gola, the low thatched shed the salt is kept in, with an old heap under black sheeting
// beside it, the sluice where the creek's salt water is let in, and in the rains the watchman's hut; and the
// people at work, each farm its own (world/saltHands.ts): raking, carrying, looking the beds over, dressing a
// bed with the kodal and watching it done, and in the rains, when no salt can be made and the flooded farms are
// kept as fish and shrimp ghers as the coast's salt farmers do, casting the net over them and feeding them.

/** The gher's fisherman's clothes in the rains: a faded lungi, a dark sando. */
const GHER_OUTFIT: Outfit = { lungi: ['#3f4f5e', '#b7b2a2', '#1e2833'], vest: '#5a5650', gamchha: ['#9a7a2a', '#e8dfcc', '#4a3a12'], seed: 95 };

/** The creek's farm: its gola, its sluice, its gher's fisherman and its watchman's hut. */
const F = SALT_FIELD;
/** A bund's cross-section (m): its foot and its crown (its height is its own, the farm's `bunds`). */
const BUND = { foot: 0.8, crown: 0.36 };
const CLAY: RGB = rgb('#6f685d');
const CROWN: RGB = rgb('#857c70');
const RIME: RGB = rgb('#b9b6ae');
const UP = new Vector3(0, 1, 0);

/** Where a farm's sections start along its length (m from its u = 0 end). */
const pondEnd = (farm: SaltFarm) => farm.w * farm.pond;
const crystalStart = (farm: SaltFarm) => farm.w * farm.evaporation;
/** A farm's pans' floor (m). */
const floorOf = (farm: SaltFarm) => PLAIN - farm.dig;

/** A crystallizer bed's stage in the work (0..1: brine, crust forming, salt ready to rake, raked): render/patch.ts's own, cell by cell, farm by farm. */
export function saltStage(col: number, row: number, farm: SaltFarm = SALT_FIELD): number {
  const x = col * 0.618 + row * 0.29 + 0.11 + farm.seed;
  return x - Math.floor(x);
}

/**
 * Where a farm's rakers rake (its frame, m): in the beds where the salt stands ready, each in his own, a step in
 * from the bund at its near end, facing up the farm (+u), drawing the salt toward it.
 */
export function rakerStations(farm: SaltFarm = SALT_FIELD, count = 3): { u: number; v: number }[] {
  const start = crystalStart(farm);
  const [cu, cv] = farm.crystalCell;
  const cols = Math.round((farm.w - start) / cu);
  const rows = Math.round(farm.d / cv);
  const stations: { u: number; v: number }[] = [];
  for (let row = 1; row < rows - 1 && stations.length < count; row++) {
    for (let col = 0; col < cols && stations.length < count; col++) {
      const stage = saltStage(col, row, farm);
      if (stage > 0.6 && stage < 0.8) stations.push({ u: start + col * cu + 0.9, v: (row + 0.5) * cv });
    }
  }
  return stations;
}

/** The world's ground under a point of a farm's frame. */
function groundAt(u: number, v: number, farm: SaltFarm = SALT_FIELD): { x: number; y: number; z: number } {
  const p = saltPoint(u, v, farm);
  return { x: p.x, y: terrainHeight(p.x, p.z), z: p.z };
}

/** A farm's bunds between its beds, in its frame: [u0, v0, u1, v1, height over its floor] (render/patch.ts paints the same lines). */
function bundLines(farm: SaltFarm): [number, number, number, number, number][] {
  const { w, d, rimInset: r } = farm;
  const [lo, hi] = farm.bunds;
  const lines: [number, number, number, number, number][] = [];
  // each its own height, as they were built up and worn down; the pond's and the crystallizers' main bunds the highest
  const height = () => {
    const x = Math.sin((lines.length + 1) * 12.9898 + farm.seed * 78.233) * 43758.5453;
    return lo + (hi - lo) * (x - Math.floor(x));
  };
  const within = (a: number, top: number) => a > r + 0.5 && a < top - r - 0.5;
  lines.push([pondEnd(farm), r, pondEnd(farm), d - r, hi], [crystalStart(farm), r, crystalStart(farm), d - r, hi]);
  for (let u = pondEnd(farm) + farm.evapCell[0]; u < crystalStart(farm) - 1; u += farm.evapCell[0]) lines.push([u, r, u, d - r, height()]);
  for (let v = farm.evapCell[1]; v < d - 1; v += farm.evapCell[1]) if (within(v, d)) lines.push([pondEnd(farm), v, crystalStart(farm), v, height()]);
  for (let u = crystalStart(farm) + farm.crystalCell[0]; u < w - r - 0.5; u += farm.crystalCell[0]) lines.push([u, r, u, d - r, height()]);
  for (let v = farm.crystalCell[1]; v < d - 1; v += farm.crystalCell[1]) if (within(v, d)) lines.push([crystalStart(farm), v, w - r, v, height()]);
  return lines;
}

/** The height of a bund's crown at (u, v) of a farm's frame, if (u, v) is on one (else null). */
function crownAt(farm: SaltFarm, lines: readonly [number, number, number, number, number][], u: number, v: number): number | null {
  for (const [u0, v0, u1, v1, h] of lines) {
    const along = u0 === u1 ? v : u;
    const [a, b] = u0 === u1 ? [v0, v1] : [u0, u1];
    const off = u0 === u1 ? Math.abs(u - u0) : Math.abs(v - v0);
    if (off < BUND.crown / 2 + 0.05 && along >= Math.min(a, b) - 0.2 && along <= Math.max(a, b) + 0.2) return floorOf(farm) + h;
  }
  return null;
}

/** Where the creek's farm's gher fisherman stands in the rains: on its settling pond's bund, facing into it (world/fisher.ts FisherPlace). */
export function gherStand(): FisherPlace {
  const at = groundAt(pondEnd(F), F.d * 0.55);
  return {
    x: at.x,
    z: at.z,
    yaw: F.yaw + Math.PI,
    ground: floorOf(F) + F.bunds[1] - 0.02,
    // the rains' water standing over the pans
    water: saltRains(F),
    outfit: GHER_OUTFIT,
    // an older man, the gher's keeper, under his mathal
    who: 'majhi',
  };
}

/** An earth bund from (u0, v0) to (u1, v1) of a farm's frame, `h` over its floor: a low ridge, its crown worn pale, rimed white at its foot. */
function bund(b: MeshBuilder, farm: SaltFarm, u0: number, v0: number, u1: number, v1: number, h: number): void {
  const a = groundAt(u0, v0, farm);
  const e = groundAt(u1, v1, farm);
  const dx = e.x - a.x;
  const dz = e.z - a.z;
  const len = Math.hypot(dx, dz);
  if (len < 0.5) return;
  // across the bund, horizontally
  const cx = -dz / len;
  const cz = dx / len;
  const f = BUND.foot / 2;
  const c = BUND.crown / 2;
  const top = floorOf(farm) + h;
  const at = (p: { x: number; y: number; z: number }, across: number, y: number) => new Vector3(p.x + cx * across, y, p.z + cz * across);
  const slope = Math.atan2(h, f - c);
  // an old farm's bunds have grass in their crowns
  const crown = farm.grassy ? mixRgb(CROWN, rgb('#5e6a3a'), 0.6) : CROWN;
  for (const side of [-1, 1]) {
    const n = new Vector3(cx * side * Math.sin(slope), Math.cos(slope), cz * side * Math.sin(slope));
    const s = b.vertexCount;
    b.vertex(at(a, side * f, a.y - 0.06), n, 0, 0, mixRgb(CLAY, RIME, 0.2));
    b.vertex(at(e, side * f, e.y - 0.06), n, 1, 0, mixRgb(CLAY, RIME, 0.2));
    b.vertex(at(e, side * c, top), n, 1, 1, CLAY);
    b.vertex(at(a, side * c, top), n, 0, 1, CLAY);
    if (side > 0) b.quad(s, s + 1, s + 2, s + 3);
    else b.quad(s, s + 3, s + 2, s + 1);
  }
  const s = b.vertexCount;
  b.vertex(at(a, -c, top), UP, 0, 0, crown);
  b.vertex(at(a, c, top), UP, 0, 1, crown);
  b.vertex(at(e, c, top), UP, 1, 1, crown);
  b.vertex(at(e, -c, top), UP, 1, 0, crown);
  b.quad(s, s + 1, s + 2, s + 3);
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

// ---------- the people ----------

/** Their lungis, sandos and gamchhas (each Outfit as boatman.ts's), every man his own. */
const OUTFITS: readonly Outfit[] = [
  { lungi: ['#7a2f2a', '#d9cdb5', '#3e1512'], vest: '#cfc6b4', gamchha: ['#2f6a3a', '#e9e0cc', '#173a1f'], seed: 81 },
  { lungi: ['#3b3b3b', '#a8a8a0', '#1a1a1a'], vest: '#b7ad98', gamchha: ['#a8342a', '#efe6d6', '#5a1410'], seed: 83 },
  { lungi: ['#5a4a2a', '#c9b98f', '#2c2412'], vest: '#d8d2c2', gamchha: ['#284f86', '#e8e2d2', '#16244a'], seed: 85 },
  { lungi: ['#2d4f6e', '#c6c0ae', '#16283a'], vest: '#c2b9a2', gamchha: ['#7a5a1e', '#ebe2cc', '#3a2a0c'], seed: 87 },
  { lungi: ['#5e2e4e', '#d2c4b2', '#2e1426'], vest: '#d4ccb8', gamchha: ['#356a5a', '#e6e0d0', '#1a3a30'], seed: 89 },
  { lungi: ['#4a5a2a', '#cfc8a8', '#232c12'], vest: '#bdb39c', gamchha: ['#9a3a5a', '#eee4d6', '#4a1426'], seed: 91 },
];

/** What any of them is to the farm: posed each frame while he can be seen. */
interface Worker {
  readonly group: Group;
  update(dt: number, t: number): void;
}

/** A farm's people: those at the salt work and those of the gher in the rains, and where the farm is. */
interface Crew {
  x: number;
  z: number;
  salt: Group;
  rains: Group;
  saltHands: Worker[];
  rainHands: Worker[];
}

/** People are posed within this distance of their farm (m), and drawn within the second. */
const POSED = 250;
const DRAWN = 300;

/** A fixed hash, 0..1. */
const hash = (a: number, b: number) => {
  const x = Math.sin(a * 12.9898 + b * 78.233) * 43758.5453;
  return x - Math.floor(x);
};

/** The salt farms' bunds, heaps and sheds, and their people at work: hidden out of their season, and posed only while the camera is near enough to see them. */
export class SaltWorks {
  readonly group = new Group();
  /** Where each of the creek's farm's rakers stands (world), for the film's shot of them. */
  readonly workers: readonly { x: number; y: number; z: number; yaw: number }[];
  private readonly crews: Crew[] = [];
  private readonly gherFisher: Fisher;
  private hut = new Mesh();

  constructor(ripples: Ripples) {
    const rng = new Rng(611);
    this.group.name = 'saltworks';
    this.buildSluice(rng);
    this.buildHut();
    this.gherFisher = new Fisher(ripples, gherStand());
    this.gherFisher.group.visible = false;
    this.group.add(this.gherFisher.group);
    // a hand or a handful of feed meets the water only where water stands
    const drop: Drop = (x, z, radius, strength) => {
      const level = waterLevelAt(x, z);
      if (Number.isFinite(level) && level > terrainHeight(x, z) + 0.02) ripples.drop(x, z, radius, strength);
    };

    const wood = patchMaterial(new MeshStandardMaterial({ color: '#6b5236', roughness: 0.85 }), { grime: 0.3 });
    const bamboo = patchMaterial(new MeshStandardMaterial({ color: '#a39469', roughness: 0.7 }), { grime: 0.3 });
    const iron = patchMaterial(new MeshStandardMaterial({ color: '#4c4a46', roughness: 0.45, metalness: 0.4 }), { grime: 0.4 });
    const clay = patchMaterial(new MeshStandardMaterial({ color: '#9a5a3a', roughness: 0.8 }), { grime: 0.3 });
    const weave = weaveTexture(57);
    weave.repeat.set(6, 2);
    const basketMat = patchMaterial(new MeshStandardMaterial({ map: weave, color: '#cdb78a', roughness: 0.9, side: DoubleSide }), { grime: 0.3 });
    const basketGeo = basketGeometry();
    // the salt, the raked heaps' and what a carrier brings: rising through the salt season, gone to market by the rains (G.uSeasonB.w)
    const seasonal = { key: 'salt-season', pars: '', code: 'transformed *= smoothstep(0.15, 0.55, uSeasonB.w);' };
    const saltMat = patchMaterial(new MeshStandardMaterial({ color: '#e9e7e1', roughness: 0.55 }), { grime: 0.08, vertex: seasonal });
    const carried = patchMaterial(new MeshStandardMaterial({ color: '#e9e7e1', roughness: 0.55 }), { grime: 0.08 });

    const bunds = new MeshBuilder();
    const fresh: Placement[] = [];
    const workers: { x: number; y: number; z: number; yaw: number }[] = [];
    SALT_FIELDS.forEach((farm, fi) => {
      const lines = bundLines(farm);
      for (const [u0, v0, u1, v1, h] of lines) {
        // in pieces, so each follows the ground closely
        const n = Math.max(1, Math.ceil(Math.hypot(u1 - u0, v1 - v0) / 8));
        for (let k = 0; k < n; k++) bund(bunds, farm, u0 + ((u1 - u0) * k) / n, v0 + ((v1 - v0) * k) / n, u0 + ((u1 - u0) * (k + 1)) / n, v0 + ((v1 - v0) * (k + 1)) / n, h);
      }
      const crest = (u: number, v: number) => crownAt(farm, lines, u, v) ?? groundAt(u, v, farm).y;

      // the crystallizers: who rakes which bed (salt ready on it), and the heaps along the bunds of the beds raked
      // and being raked, on the bund at the end the men draw the salt toward
      const rake = farm.work.find((t): t is Extract<SaltTask, { do: 'rake' }> => t.do === 'rake');
      const stations = rake ? rakerStations(farm, rake.count) : [];
      const start = crystalStart(farm);
      const [cu, cv] = farm.crystalCell;
      const cols = Math.round((farm.w - start) / cu);
      const rows = Math.round(farm.d / cv);
      for (let row = 1; row < rows - 1; row++) {
        for (let col = 0; col < cols; col++) {
          const stage = saltStage(col, row, farm);
          if (stage < 0.6) continue;
          const u0 = start + col * cu;
          const vMid = (row + 0.5) * cv;
          // where a man rakes, a heap beside him on the bund at his back (his basket on the other side)
          const worked = stations.some((st) => Math.abs(st.u - u0 - 0.9) < 0.01 && Math.abs(st.v - vMid) < 0.01);
          const spots = worked ? [1.8] : stage >= 0.85 ? [-0.95, 0.95] : [0];
          for (const dv of spots) {
            const v = vMid + dv + rng.range(-0.15, 0.15);
            const g = groundAt(u0, v, farm);
            fresh.push({ x: g.x, y: crest(u0, v) - 0.08, z: g.z, ry: rng.range(0, Math.PI * 2), s: rng.range(0.55, 0.8), sy: rng.range(0.9, 1.25) });
          }
        }
      }

      // the people, each at his own task, at his own pace, in his own clothes
      const crew: Crew = { x: farm.x, z: farm.z, salt: new Group(), rains: new Group(), saltHands: [], rainHands: [] };
      let k = 0;
      const next = () => {
        k++;
        return { outfit: OUTFITS[(fi * 2 + k) % OUTFITS.length], pace: 0.86 + 0.28 * hash(fi, k), offset: 3.7 * k + 1.9 * fi };
      };
      const add = (w: Worker, when: SaltTask['when']) => {
        (when === 'salt' ? crew.salt : crew.rains).add(w.group);
        (when === 'salt' ? crew.saltHands : crew.rainHands).push(w);
      };
      /** A way along the bunds (its frame's points) as world points a metre apart on their crowns, and how far along it each of its points is. */
      const way = (path: readonly (readonly [number, number])[]) => {
        const pts: Vector3[] = [];
        const stops: number[] = [0];
        let along = 0;
        for (let i = 0; i + 1 < path.length; i++) {
          const [u0, v0] = path[i];
          const [u1, v1] = path[i + 1];
          const n = Math.max(1, Math.ceil(Math.hypot(u1 - u0, v1 - v0)));
          for (let j = i === 0 ? 0 : 1; j <= n; j++) {
            const u = u0 + ((u1 - u0) * j) / n;
            const v = v0 + ((v1 - v0) * j) / n;
            const p = saltPoint(u, v, farm);
            const at = new Vector3(p.x, crest(u, v), p.z);
            if (pts.length) along += at.distanceTo(pts[pts.length - 1]);
            pts.push(at);
          }
          stops.push(along);
        }
        return { pts, stops };
      };
      const spadeAt: Vector3[] = [];
      for (const task of farm.work) {
        if (task.do === 'spade') {
          const g = groundAt(task.at[0], task.at[1], farm);
          spadeAt.push(new Vector3(g.x, g.y, g.z));
        }
      }
      for (const task of farm.work) {
        switch (task.do) {
          case 'rake':
            stations.forEach((st, i) => {
              const { outfit, pace, offset } = next();
              const g = groundAt(st.u, st.v, farm);
              const r = new Raker(outfit, task.who ?? (i === 1 ? 'tarun' : 'majhi'), pace, offset, wood, bamboo);
              r.group.position.set(g.x, g.y, g.z);
              r.group.rotation.y = farm.yaw;
              add(r, 'salt');
              if (fi === 0) workers.push({ x: g.x, y: g.y, z: g.z, yaw: farm.yaw });
              // his basket on the bund behind him
              const b = groundAt(st.u - 0.9, st.v - 1.5, farm);
              const m = new Mesh(basketGeo, basketMat);
              m.position.set(b.x, crest(st.u - 0.9, st.v - 1.5) - 0.02, b.z);
              m.rotation.y = rng.range(0, Math.PI * 2);
              m.layers.set(LAYER_NO_REFLECT);
              crew.salt.add(m);
            });
            break;
          case 'carry': {
            const { outfit, pace, offset } = next();
            const { pts, stops } = way(task.path);
            add(new Walker(outfit, 'tarun', pts, [0, stops[stops.length - 1]], true, pace, offset, null, basketMat, carried), 'salt');
            // the heap he tips his salt on at the end of his way
            const end = pts[pts.length - 1];
            const before = pts[Math.max(0, pts.length - 3)];
            const dx = end.x - before.x;
            const dz = end.z - before.z;
            const l = Math.hypot(dx, dz) || 1;
            const hx = end.x + (dx / l) * 1.3;
            const hz = end.z + (dz / l) * 1.3;
            fresh.push({ x: hx, y: terrainHeight(hx, hz) - 0.06, z: hz, ry: rng.range(0, Math.PI * 2), s: 1.15, sy: 1.25 });
            break;
          }
          case 'inspect': {
            const { outfit, pace, offset } = next();
            const { pts, stops } = way(task.path);
            add(new Walker(outfit, task.who ?? 'majhi', pts, stops, false, pace, offset, drop, null, null), task.when);
            break;
          }
          case 'spade': {
            const { outfit, pace, offset } = next();
            const g = groundAt(task.at[0], task.at[1], farm);
            const s = new Spader(outfit, k % 2 ? 'tarun' : 'majhi', pace, offset, wood, iron);
            s.group.position.set(g.x, g.y, g.z);
            s.group.rotation.y = farm.yaw + task.facing;
            add(s, 'salt');
            break;
          }
          case 'watch': {
            const { outfit, pace, offset } = next();
            const p = saltPoint(task.at[0], task.at[1], farm);
            const at = new Vector3(p.x, crest(task.at[0], task.at[1]), p.z);
            const yaw = farm.yaw + task.facing;
            // what he watches, in his own frame: the men at the bed, their heads
            const seen = (spadeAt[0] ?? at.clone().add(new Vector3(Math.sin(yaw) * 4, 0, Math.cos(yaw) * 4))).clone().add(new Vector3(0, 1.1, 0)).sub(at).applyAxisAngle(UP, -yaw);
            const w = new Watcher(outfit, 'majhi', seen, pace, offset);
            w.group.position.copy(at);
            w.group.rotation.y = yaw;
            add(w, 'salt');
            break;
          }
          case 'feed': {
            const { outfit, pace, offset } = next();
            const p = saltPoint(task.at[0], task.at[1], farm);
            const f = new Feeder(outfit, 'majhi', pace, offset, drop, clay);
            f.group.position.set(p.x, crest(task.at[0], task.at[1]), p.z);
            f.group.rotation.y = farm.yaw + task.facing;
            add(f, 'rains');
            break;
          }
          case 'net':
            // the creek's farm's gher fisherman (world/fisher.ts), above
            break;
        }
      }
      crew.salt.visible = crew.rains.visible = false;
      // a crew not drawn is not posed either (update): its people's matrices wait as they stood
      holdWhileHidden(crew.salt);
      holdWhileHidden(crew.rains);
      this.group.add(crew.salt, crew.rains);
      this.crews.push(crew);
    });
    this.workers = workers;

    const bundMesh = new Mesh(bunds.build(), patchMaterial(new MeshStandardMaterial({ vertexColors: true, roughness: 0.95 }), { grime: 0.45 }));
    bundMesh.receiveShadow = true;
    this.group.add(bundMesh);
    if (fresh.length) this.group.add(instanced(heap(), saltMat, fresh, { cast: true, receive: true, layer: LAYER_NO_REFLECT }));

    // the gola at the creek's farm's far corner, by the hill, its door toward the beds, and the year's old heap
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
  }

  /** The water's uniforms for the gher fisherman's net (world/water.ts `nets`). */
  bindWater(a: Vector4, b: Vector4): void {
    this.gherFisher.bindWater(a, b);
  }

  /** Puts the gher's fisherman `at` s into his cast. */
  cueGher(at: number): void {
    this.gherFisher.cue(at);
  }

  /**
   * `eye`: the camera (and `also`, a shot's still dissolving away, or null); `salt`: the season's salt work
   * (env/season.ts): salt made in the dry months, fish kept in the rains.
   */
  update(dt: number, t: number, eye: Vector3, salt: number, also: Vector3 | null = null): void {
    const working = salt > 0.5;
    const gher = salt < 0.25;
    this.gherFisher.group.visible = gher;
    if (!gher) this.gherFisher.stillWater();
    this.hut.visible = gher;
    const within = (p: Vector3 | null, x: number, z: number, r: number) => p !== null && Math.hypot(p.x - x, p.z - z) < r;
    for (const crew of this.crews) {
      const drawn = within(eye, crew.x, crew.z, DRAWN) || within(also, crew.x, crew.z, DRAWN);
      crew.salt.visible = working && drawn;
      crew.rains.visible = gher && drawn;
      if (!within(eye, crew.x, crew.z, POSED) && !within(also, crew.x, crew.z, POSED)) continue;
      if (working) for (const w of crew.saltHands) w.update(dt, t);
      if (gher) for (const w of crew.rainHands) w.update(dt, t);
    }
    if (gher && (within(eye, F.x, F.z, POSED) || within(also, F.x, F.z, POSED))) this.gherFisher.update(dt, t, eye, also);
  }

  /**
   * The sluice where the creek's salt water is let in: a culvert of planks through the creek's bank at its head,
   * its gate raised in grooves between two posts, a plank across its top to walk on; and an open trough of planks
   * from it to the field's edge, a little water in it.
   */
  private buildSluice(rng: Rng): void {
    const end = SALT_CREEK.at(SALT_CREEK.length);
    const f = saltLocal(end.x, end.z);
    const edge = saltPoint(0.4, f.v);
    const dx = edge.x - end.x;
    const dz = edge.z - end.z;
    const len = Math.hypot(dx, dz);
    const yaw = Math.atan2(dx, dz);
    const q = new Quaternion().setFromAxisAngle(UP, yaw);
    const ux = dx / len;
    const uz = dz / len;
    const half = SALT_CREEK.half(SALT_CREEK.length);
    const wood = new MeshBuilder();
    const plank = (along: number, across: number, y: number, w: number, h: number, d: number, c: RGB) => {
      const x = end.x + ux * along + uz * across;
      const z = end.z + uz * along - ux * across;
      wood.add(new BoxGeometry(w, h, d), new Matrix4().compose(new Vector3(x, y, z), q, new Vector3(1, 1, 1)), scaleRgb(c, rng.range(0.85, 1.05)));
    };
    const timber = rgb('#5b4a36');
    const wet = rgb('#3c3226');
    // the culvert: from just in the water up through the bank
    const c0 = half - 0.4;
    const c1 = half + 3.2;
    const floorAt = (a: number) => {
      const x = end.x + ux * a;
      const z = end.z + uz * a;
      return terrainHeight(x, z);
    };
    for (const side of [-1, 1]) {
      for (let a = c0; a < c1; a += 0.9) {
        const g = Math.min(floorAt(a), WATER_LEVEL + 0.3);
        plank(a + 0.45, side * 0.5, g + 0.55, 0.08, 1.3, 0.92, a < half + 0.6 ? wet : timber);
      }
    }
    // the gate between its posts at the water's end, raised a hand's breadth
    const gy = WATER_LEVEL + 0.4;
    for (const side of [-1, 1]) plank(c0 + 0.2, side * 0.62, gy + 0.4, 0.14, 2.0, 0.14, timber);
    plank(c0 + 0.2, 0, gy + 0.25, 1.0, 0.9, 0.06, wet);
    plank(c0 + 0.2, 0, gy + 1.35, 1.4, 0.1, 0.16, timber);
    // a plank across the top to walk on
    plank(half + 1.4, 0, floorAt(half + 1.4) + 1.25, 2.2, 0.06, 0.5, timber);
    // the trough on to the field
    const t0 = c1;
    const t1 = len;
    const n = Math.max(1, Math.ceil((t1 - t0) / 1.5));
    for (let k = 0; k < n; k++) {
      const a = t0 + ((k + 0.5) * (t1 - t0)) / n;
      const g = floorAt(a);
      const l = (t1 - t0) / n + 0.05;
      plank(a, 0, g + 0.04, 0.7, 0.05, l, timber);
      for (const side of [-1, 1]) plank(a, side * 0.33, g + 0.2, 0.05, 0.32, l, timber);
    }
    const mesh = new Mesh(wood.build(), patchMaterial(new MeshStandardMaterial({ vertexColors: true, roughness: 0.85 }), { grime: 0.5, wetline: true }));
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.group.add(mesh);
    // the brine in the trough: a dark glossy strip
    const water = new MeshBuilder();
    for (let k = 0; k < n; k++) {
      const a = t0 + ((k + 0.5) * (t1 - t0)) / n;
      const x = end.x + ux * a;
      const z = end.z + uz * a;
      water.add(new BoxGeometry(0.58, 0.02, (t1 - t0) / n + 0.05), new Matrix4().compose(new Vector3(x, floorAt(a) + 0.12, z), q, new Vector3(1, 1, 1)), rgb('#2c3734'));
    }
    this.group.add(new Mesh(water.build(), patchMaterial(new MeshStandardMaterial({ vertexColors: true, roughness: 0.08 }), {})));
  }

  /** The gher's watchman's hut (টং ঘর): a mat-walled room on bamboo legs at the farm's corner, a thatched roof, a ladder. */
  private buildHut(): void {
    const at = groundAt(-5, F.d + 3);
    const yaw = F.yaw - Math.PI / 2;
    const q = new Quaternion().setFromAxisAngle(UP, yaw);
    const place = (x: number, y: number, z: number) => new Vector3(x, y, z).applyQuaternion(q).add(new Vector3(at.x, at.y, at.z));
    const b = new MeshBuilder();
    const bamboo = rgb('#a39469');
    const legs = 1.6;
    for (const [x, z] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) b.add(new CylinderGeometry(0.06, 0.07, legs + 0.3, 6), new Matrix4().compose(place(x * 1.0, (legs + 0.3) / 2 - 0.3, z * 0.9), q, new Vector3(1, 1, 1)), bamboo);
    b.add(new BoxGeometry(2.3, 0.08, 2.1), new Matrix4().compose(place(0, legs, 0), q, new Vector3(1, 1, 1)), rgb('#8a7a58'));
    const mat = rgb('#9c8662');
    b.add(new BoxGeometry(2.2, 1.3, 0.05), new Matrix4().compose(place(0, legs + 0.65, -1.0), q, new Vector3(1, 1, 1)), mat);
    for (const x of [-1.08, 1.08]) b.add(new BoxGeometry(0.05, 1.3, 2.0), new Matrix4().compose(place(x, legs + 0.65, 0), q, new Vector3(1, 1, 1)), mat);
    // the roof: two thatched slopes
    const thatch = rgb('#8a7448');
    for (const s of [-1, 1]) {
      const first = b.vertexCount;
      const n = new Vector3(s * 0.6, 1, 0).normalize().applyQuaternion(q);
      b.vertex(place(s * 1.5, legs + 1.25, -1.35), n, 0, 0, thatch);
      b.vertex(place(s * 1.5, legs + 1.25, 1.35), n, 1, 0, thatch);
      b.vertex(place(0, legs + 2.05, 1.35), n, 1, 1, scaleRgb(thatch, 0.85));
      b.vertex(place(0, legs + 2.05, -1.35), n, 0, 1, scaleRgb(thatch, 0.85));
      if (s > 0) b.quad(first, first + 1, first + 2, first + 3);
      else b.quad(first, first + 3, first + 2, first + 1);
    }
    // the ladder at its open front
    for (const x of [-0.25, 0.25]) b.add(new CylinderGeometry(0.03, 0.03, 2.0, 5), new Matrix4().compose(place(x, legs / 2, 1.45), new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0).applyQuaternion(q), -0.32).multiply(q), new Vector3(1, 1, 1)), bamboo);
    this.hut = new Mesh(b.build(), patchMaterial(new MeshStandardMaterial({ vertexColors: true, roughness: 0.9, side: DoubleSide }), { grime: 0.4 }));
    this.hut.castShadow = true;
    this.hut.receiveShadow = true;
    this.hut.visible = false;
    this.group.add(this.hut);
  }
}
