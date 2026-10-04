import {
  BufferGeometry,
  DoubleSide,
  Group,
  IcosahedronGeometry,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  MeshStandardMaterial,
  Quaternion,
  Vector3,
} from 'three';
import type { Material } from 'three';
import { LAYER_NO_REFLECT } from '../core/globals';
import { smoothstep } from '../core/mathx';
import { fbm, valueNoise } from '../core/noise';
import { Rng } from '../core/rng';
import { MeshBuilder, mixRgb, rgb, scaleRgb, type RGB } from '../render/builder';
import { patchMaterial } from '../render/patch';
import { COVER, KIND, coverAt, kindAt } from '../geo/data';
import { exposureAt } from './exposure';
import { bankInfo, onBridge, onLandmark } from './geography';
import { groundLattice } from './terrain';
import { GHATS, type HutPlan } from './village';

// Grass you can walk through: dense blade clumps, wild flowers and pebbles, built only round the viewer,
// chunk by chunk as the view moves. Seen from the boat the banks are 100 m off and this costs nothing;
// in the free camera or the film's bank-side shots the ground is thick with it.

const CHUNK = 12;
/** Chunks whose centre is nearer than this get the full blade clumps; the rest a lighter clump. */
const NEAR = 26;
const FAR = 56;
const BUILD_PER_FRAME = 2;
const CACHE = 180;
/** Candidate spacing in metres for the near and far clumps. */
const STEP = [0.4, 0.9] as const;
/** Lattice spacing for the cheap height and cover lookups inside a chunk. */
const LATTICE = 1.5;

const UP = new Vector3(0, 1, 0);

/** A tuft of curved, tapering blades: dark at the root, sun-bleached at the tip. */
function grassClump(seed: number, blades: number, segments: number, width: number): BufferGeometry {
  const rng = new Rng(seed);
  const b = new MeshBuilder();
  const root = rgb('#16220b');
  const mid = rgb('#3d5a1b');
  const tip = rgb('#a9b053');
  const dryTip = rgb('#b89c5c');
  const p = new Vector3();
  const n = new Vector3();
  const tangent = new Vector3();
  for (let i = 0; i < blades; i++) {
    const a = rng.range(0, Math.PI * 2);
    const r = Math.sqrt(rng.next()) * 0.22;
    const base = new Vector3(Math.cos(a) * r, 0, Math.sin(a) * r);
    const h = rng.range(0.3, 0.66);
    const w = rng.range(0.6, 1) * width;
    const az = a + rng.range(-0.7, 0.7);
    const dir = new Vector3(Math.cos(az), 0, Math.sin(az));
    const side = new Vector3(-dir.z, 0, dir.x).applyAxisAngle(UP, rng.range(-0.35, 0.35));
    const bend = rng.range(0.15, 0.6);
    const top = rng.next() < 0.14 ? dryTip : tip;
    const start = b.vertexCount;
    for (let s = 0; s <= segments; s++) {
      const t = s / segments;
      p.copy(base).addScaledVector(dir, bend * h * t * t).addScaledVector(UP, h * t * (1 - 0.3 * bend * t));
      tangent.copy(dir).multiplyScalar(2 * bend * h * t).addScaledVector(UP, h * (1 - 0.6 * bend * t)).normalize();
      // a soft normal, half the blade's face and half the sky, so a tuft shades as one volume
      n.crossVectors(side, tangent).normalize().lerp(UP, 0.55).normalize();
      const c = t < 0.5 ? mixRgb(root, mid, t * 2) : mixRgb(mid, top, (t - 0.5) * 2);
      if (s === segments) b.vertex(p, n, 0.5, 1, c);
      else {
        const half = w * Math.pow(1 - t, 0.8);
        b.vertex(p.clone().addScaledVector(side, -half), n, 0, t, c);
        b.vertex(p.clone().addScaledVector(side, half), n, 1, t, c);
      }
    }
    for (let s = 0; s < segments - 1; s++) {
      const k = start + s * 2;
      b.quad(k, k + 1, k + 3, k + 2);
    }
    const last = start + (segments - 1) * 2;
    b.tri(last, last + 1, last + 2);
  }
  return b.build();
}

type FlowerKind = 'white' | 'yellow' | 'lilac';

/** A few stems with leaves and small five-petalled heads: ghashphul, a yellow weed flower, or kolmi by the water. */
function flowerClump(seed: number, kind: FlowerKind): BufferGeometry {
  const rng = new Rng(seed);
  const b = new MeshBuilder();
  const stemC = rgb('#3b5320');
  const petal = kind === 'white' ? rgb('#f2f0e6') : kind === 'yellow' ? rgb('#f0c22a') : rgb('#d9a6d8');
  const eye = kind === 'lilac' ? rgb('#7a2f6e') : rgb('#e0a91c');
  const heads = kind === 'white' ? 6 : kind === 'yellow' ? 3 : 2;
  const size = kind === 'white' ? 0.022 : kind === 'yellow' ? 0.03 : 0.045;
  const p = new Vector3();
  for (let i = 0; i < heads; i++) {
    const a = rng.range(0, Math.PI * 2);
    const base = new Vector3(Math.cos(a), 0, Math.sin(a)).multiplyScalar(rng.range(0, 0.12));
    const h = rng.range(0.22, 0.42) * (kind === 'lilac' ? 0.7 : 1);
    const lean = new Vector3(rng.range(-0.06, 0.06), 0, rng.range(-0.06, 0.06));
    const head = base.clone().add(lean).setY(h);
    // the stem: a thin ribbon
    const side = new Vector3(0.006, 0, 0);
    const s0 = b.vertex(base.clone().sub(side), UP, 0, 0, stemC);
    b.vertex(base.clone().add(side), UP, 1, 0, stemC);
    b.vertex(head.clone().add(side), UP, 1, 1, stemC);
    b.vertex(head.clone().sub(side), UP, 0, 1, stemC);
    b.quad(s0, s0 + 1, s0 + 2, s0 + 3);
    // the head faces the sky, tilted a little
    const face = new Vector3(rng.range(-0.4, 0.4), 1, rng.range(-0.4, 0.4)).normalize();
    const u = new Vector3().crossVectors(face, new Vector3(1, 0, 0)).normalize();
    const v = new Vector3().crossVectors(face, u).normalize();
    const c = b.vertex(head, face, 0.5, 0.5, eye);
    for (let k = 0; k < 5; k++) {
      const a0 = (k / 5) * Math.PI * 2;
      const a1 = a0 + 0.55;
      const a2 = a0 + 1.0;
      const at = (ang: number, r: number) =>
        p.copy(head).addScaledVector(u, Math.cos(ang) * r).addScaledVector(v, Math.sin(ang) * r).clone();
      const q0 = b.vertex(at(a0, size * 0.25), face, 0, 0, petal);
      const q1 = b.vertex(at(a1, size), face, 1, 0, petal);
      const q2 = b.vertex(at(a2, size * 0.25), face, 1, 1, petal);
      b.tri(c, q0, q1);
      b.tri(c, q1, q2);
    }
    // a pair of leaves low on the stem
    for (const sgn of [-1, 1]) {
      const at = base.clone().setY(h * 0.3).addScaledVector(lean, 0.3);
      const out = new Vector3(Math.cos(a + sgn), 0.35, Math.sin(a + sgn)).normalize().multiplyScalar(0.07);
      const across = new Vector3(-out.z, 0, out.x).normalize().multiplyScalar(0.012);
      const l0 = b.vertex(at, UP, 0, 0, stemC);
      b.vertex(at.clone().addScaledVector(out, 0.5).add(across), UP, 1, 0, stemC);
      b.vertex(at.clone().add(out), UP, 1, 1, stemC);
      b.vertex(at.clone().addScaledVector(out, 0.5).sub(across), UP, 0, 1, stemC);
      b.quad(l0, l0 + 1, l0 + 2, l0 + 3);
    }
  }
  return b.build();
}

/**
 * Beach morning glory (Ipomoea pes-caprae), the creeper of the Bay's dunes: runners lying on the sand, a
 * leathery two-lobed leaf every hand's breadth along them, now and then a pink funnel of a flower.
 */
function creeperClump(seed: number): BufferGeometry {
  const rng = new Rng(seed);
  const b = new MeshBuilder();
  const runnerC = rgb('#5a4a2c');
  const leafC = rgb('#2f5a24');
  const leafLight = rgb('#4f7a2e');
  const flowerC = rgb('#c4529a');
  const throatC = rgb('#6e1f4f');
  const runners = rng.int(3, 5);
  for (let r = 0; r < runners; r++) {
    let a = rng.range(0, Math.PI * 2);
    const len = rng.range(0.6, 1.2);
    const p = new Vector3(0, 0.02, 0);
    for (let s = 0; s < len; s += 0.12) {
      a += rng.range(-0.25, 0.25);
      const dir = new Vector3(Math.cos(a), 0, Math.sin(a));
      const next = p.clone().addScaledVector(dir, 0.12);
      // the runner: a thin ribbon on the sand
      const side = new Vector3(-dir.z, 0, dir.x).multiplyScalar(0.006);
      const r0 = b.vertex(p.clone().sub(side), UP, 0, 0, runnerC);
      b.vertex(p.clone().add(side), UP, 1, 0, runnerC);
      b.vertex(next.clone().add(side), UP, 1, 1, runnerC);
      b.vertex(next.clone().sub(side), UP, 0, 1, runnerC);
      b.quad(r0, r0 + 1, r0 + 2, r0 + 3);
      // a leaf on its stalk, raised off the sand, folded a little along its midrib, notched at the tip
      const off = new Vector3(-dir.z, 0, dir.x).multiplyScalar(rng.next() < 0.5 ? -1 : 1);
      const base = next.clone().addScaledVector(off, 0.03).setY(rng.range(0.04, 0.09));
      const size = rng.range(0.045, 0.07);
      const up = new Vector3(rng.range(-0.3, 0.3), 1, rng.range(-0.3, 0.3)).normalize();
      const u = off.clone().addScaledVector(dir, 0.4).normalize();
      const v = new Vector3().crossVectors(up, u).normalize();
      const col = mixRgb(leafC, leafLight, rng.next());
      const c = b.vertex(base.clone().addScaledVector(u, size), up, 0.5, 0.5, col);
      const ring = [0, 0.9, 1.7, 2.6, 3.3, 3.9, 4.6, 5.4].map((t) => {
        const ang = (t / 6.28) * Math.PI * 2;
        const rr = size * (1 - 0.35 * Math.max(0, Math.cos(ang)) ** 8);
        return b.vertex(base.clone().addScaledVector(u, size + Math.cos(ang) * rr).addScaledVector(v, Math.sin(ang) * rr).addScaledVector(up, 0.01 * Math.abs(Math.sin(ang))), up, 0, 0, col);
      });
      for (let k = 0; k < ring.length; k++) b.tri(c, ring[k], ring[(k + 1) % ring.length]);
      // now and then a flower: a pink funnel facing the sky
      if (rng.next() < 0.12) {
        const f = next.clone().addScaledVector(off, -0.04).setY(0.1);
        const fc = b.vertex(f.clone().setY(0.06), UP, 0.5, 0.5, throatC);
        const lip = Array.from({ length: 6 }, (_, k) => {
          const ang = (k / 6) * Math.PI * 2;
          return b.vertex(f.clone().add(new Vector3(Math.cos(ang) * 0.035, 0, Math.sin(ang) * 0.035)), UP, 0, 0, flowerC);
        });
        for (let k = 0; k < 6; k++) b.tri(fc, lip[k], lip[(k + 1) % 6]);
      }
      p.copy(next);
    }
  }
  return b.build();
}

/** A river pebble: a lumpy, flattened ball. */
function pebble(seed: number): BufferGeometry {
  const g = new IcosahedronGeometry(1, 1);
  const pos = g.getAttribute('position');
  const v = new Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const k = 0.8 + 0.4 * valueNoise(v.x * 1.7 + seed, v.z * 1.7 + v.y, seed);
    v.multiplyScalar(k);
    v.y *= 0.55;
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  g.computeVertexNormals();
  const b = new MeshBuilder();
  b.add(g, new Matrix4(), rgb('#8a8174'));
  return b.build();
}

interface Layer {
  mesh: InstancedMesh;
  colors: InstancedBufferAttribute;
  capacity: number;
}

/** One chunk's instances per layer: matrices (16 floats each) and colours (3 floats each). */
interface ChunkData {
  key: string;
  parts: { m: Float32Array; c: Float32Array; n: number }[];
  used: number;
}

const LAYERS = ['grassNear', 'grassFar', 'white', 'yellow', 'lilac', 'pebbles', 'creeper'] as const;
/** The creeper grows above the tide's reach within this of a beach open to the Bay (m), on sandy ground. */
const DUNE_REACH = 60;
const DUNE_ABOVE = 0.3;
type LayerName = (typeof LAYERS)[number];

/** Dense grass, flowers and pebbles round the viewer, rebuilt chunk by chunk as the view moves. */
export class Meadow {
  readonly group = new Group();
  private readonly layers: Record<LayerName, Layer>;
  private readonly cache = new Map<string, ChunkData>();
  private readonly huts: readonly HutPlan[];
  private wanted: string[] = [];
  private centre = '';
  private reach = 1;
  private dirty = false;
  private frame = 0;

  constructor(huts: readonly HutPlan[]) {
    this.group.name = 'meadow';
    this.huts = huts;
    const grassMat = patchMaterial(new MeshStandardMaterial({ vertexColors: true, side: DoubleSide, roughness: 0.78 }), {
      seasonal: 'leaf',
      wind: 0.12,
      windHeight: 0.55,
      translucency: 1.7,
      foliage: true,
    });
    const flowerMat = patchMaterial(new MeshStandardMaterial({ vertexColors: true, side: DoubleSide, roughness: 0.7 }), {
      wind: 0.1,
      windHeight: 0.4,
      translucency: 1.2,
      foliage: true,
    });
    const stoneMat = patchMaterial(new MeshStandardMaterial({ vertexColors: true, roughness: 0.62 }), { grime: 0.8 });
    const make = (geometry: BufferGeometry, material: Material, capacity: number): Layer => {
      const mesh = new InstancedMesh(geometry, material, capacity);
      mesh.count = 0;
      mesh.receiveShadow = true;
      mesh.castShadow = false;
      mesh.layers.set(LAYER_NO_REFLECT);
      const colors = new InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
      mesh.instanceColor = colors;
      this.group.add(mesh);
      return { mesh, colors, capacity };
    };
    this.layers = {
      grassNear: make(grassClump(1, 10, 3, 0.03), grassMat, 20000),
      grassFar: make(grassClump(2, 4, 2, 0.055), grassMat, 12000),
      white: make(flowerClump(3, 'white'), flowerMat, 1500),
      yellow: make(flowerClump(4, 'yellow'), flowerMat, 1200),
      lilac: make(flowerClump(5, 'lilac'), flowerMat, 1200),
      pebbles: make(pebble(6), stoneMat, 3000),
      creeper: make(creeperClump(7), flowerMat, 4000),
    };
  }

  /** How far the grass reaches, as a share of NEAR and FAR (the lower quality tier keeps it closer). */
  setReach(k: number): void {
    this.reach = k;
    this.centre = '';
  }

  /** Call every frame with the camera's position. `all` builds every missing chunk now (for stills). */
  update(view: Vector3, all = false): void {
    this.frame++;
    const cx = Math.floor(view.x / CHUNK);
    const cz = Math.floor(view.z / CHUNK);
    const centre = `${cx},${cz}`;
    if (centre !== this.centre) {
      this.centre = centre;
      const far = FAR * this.reach;
      const near = NEAR * this.reach;
      const R = Math.ceil(far / CHUNK);
      const list: { key: string; d: number }[] = [];
      for (let dz = -R; dz <= R; dz++) {
        for (let dx = -R; dx <= R; dx++) {
          const x = (cx + dx + 0.5) * CHUNK;
          const z = (cz + dz + 0.5) * CHUNK;
          const d = Math.hypot(x - view.x, z - view.z);
          if (d > far) continue;
          list.push({ key: `${cx + dx},${cz + dz},${d < near ? 0 : 1}`, d });
        }
      }
      list.sort((a, b) => a.d - b.d);
      this.wanted = list.map((l) => l.key);
      this.dirty = true;
    }
    // build a few missing chunks, nearest first
    let built = 0;
    for (const key of this.wanted) {
      if (built >= BUILD_PER_FRAME && !all) break;
      if (this.cache.has(key)) continue;
      this.cache.set(key, this.build(key));
      built++;
      this.dirty = true;
    }
    if (this.dirty) this.upload();
  }

  private upload(): void {
    this.dirty = false;
    const offsets: Record<string, number> = {};
    for (const name of LAYERS) offsets[name] = 0;
    for (const key of this.wanted) {
      const chunk = this.cache.get(key);
      if (!chunk) continue;
      chunk.used = this.frame;
      LAYERS.forEach((name, i) => {
        const part = chunk.parts[i];
        const layer = this.layers[name];
        const at = offsets[name];
        const n = Math.min(part.n, layer.capacity - at);
        if (n <= 0) return;
        (layer.mesh.instanceMatrix.array as Float32Array).set(part.m.subarray(0, n * 16), at * 16);
        (layer.colors.array as Float32Array).set(part.c.subarray(0, n * 3), at * 3);
        offsets[name] = at + n;
      });
    }
    for (const name of LAYERS) {
      const { mesh, colors } = this.layers[name];
      mesh.count = offsets[name];
      mesh.instanceMatrix.needsUpdate = true;
      colors.needsUpdate = true;
      if (mesh.count) mesh.computeBoundingSphere();
    }
    // forget the chunks not seen for a while
    if (this.cache.size > CACHE) {
      const old = [...this.cache.values()].sort((a, b) => a.used - b.used);
      for (const c of old.slice(0, this.cache.size - CACHE)) this.cache.delete(c.key);
    }
  }

  private build(key: string): ChunkData {
    const [cx, cz, lod] = key.split(',').map(Number);
    const x0 = cx * CHUNK;
    const z0 = cz * CHUNK;
    const rng = new Rng((Math.imul(cx, 73856093) ^ Math.imul(cz, 19349663) ^ (lod * 83492791)) >>> 0);
    const out = LAYERS.map(() => ({ list: [] as number[], col: [] as number[] }));
    const lattice = groundLattice(x0, z0, CHUNK, LATTICE);
    const huts = this.huts.filter((h) => Math.abs(h.x - x0 - CHUNK / 2) < CHUNK && Math.abs(h.z - z0 - CHUNK / 2) < CHUNK);
    const ghats = GHATS.filter((g) => Math.abs(g.z - z0 - CHUNK / 2) < CHUNK);
    const m = new Matrix4();
    const q = new Quaternion();
    const pos = new Vector3();
    const scl = new Vector3();
    const tilt = new Vector3();
    const push = (layer: number, x: number, y: number, z: number, s: number, sy: number, color: RGB, lean = 0.12) => {
      q.setFromAxisAngle(tilt.set(rng.range(-1, 1), 0, rng.range(-1, 1)).normalize(), rng.range(0, lean));
      q.multiply(new Quaternion().setFromAxisAngle(UP, rng.range(0, Math.PI * 2)));
      m.compose(pos.set(x, y, z), q, scl.set(s, s * sy, s));
      out[layer].list.push(...m.elements);
      out[layer].col.push(color[0], color[1], color[2]);
    };
    // a dune behind a beach open to the Bay: the creeper covers the sand there, and the grass thins
    const dune = nearOpenBeach(x0 + CHUNK / 2, z0 + CHUNK / 2);
    const step = STEP[lod];
    const n = Math.round(CHUNK / step);
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const x = x0 + (i + rng.next()) * step;
        const z = z0 + (j + rng.next()) * step;
        const g = lattice(x, z);
        if (g.h < 0.18) {
          // pebbles lie along the waterline where the bank allows them
          if (lod === 0 && g.h > -0.3 && g.pebbles > 0.5 && rng.next() < 0.18 && valueNoise(x * 0.4, z * 0.4, 13) > 0.55) {
            push(5, x, g.h - 0.01, z, rng.range(0.04, 0.16), rng.range(0.7, 1.2), scaleRgb(mixRgb(rgb('#6f675c'), rgb('#a49a8a'), rng.next()), 1), 0.4);
          }
          continue;
        }
        if (huts.some((h) => Math.hypot(h.x - x, h.z - z) < Math.max(h.l, h.w) * 0.6 + 0.4)) continue;
        if (onBridge(x, z) || onLandmark(x, z)) continue;
        if (ghats.some((gh) => Math.abs(gh.z - z) < 3.2 && bankInfo(x, z).side === gh.side && bankInfo(x, z).inland < 21)) continue;
        // grass where the ground is grassy, in drifts, thinning on trodden earth and in the paddy
        const drift = smoothstep(0.28, 0.62, fbm(x * 0.07, z * 0.07, 2, 91));
        // on the dunes the creeper lies over most of the sand, the grass in thin tussocks between
        const onDune = dune && g.h > DUNE_ABOVE && kindAt(x, z) === KIND.land;
        if (onDune) {
          if (rng.next() < (0.45 + 0.4 * g.sand) * (0.5 + 0.5 * drift)) {
            push(6, x, g.h - 0.01, z, rng.range(0.9, 1.4), 1, scaleRgb([1, 1, 1], rng.range(0.85, 1.1)), 0.05);
            continue;
          }
          if (rng.next() > 0.3) continue;
        }
        // none in the paddy plots (zone > 0) or the salt pans (zone < 0)
        const density = (g.grass * (0.45 + 0.55 * drift) + g.dirt * 0.12 * drift) * (1 - Math.abs(g.zone));
        if (rng.next() > density) continue;
        const lush = fbm(x * 0.03 + 7, z * 0.03, 2, 92);
        const dry = Math.min(1, g.dirt * 1.4 + smoothstep(0.62, 0.8, lush) * 0.5);
        const tint = mixRgb(scaleRgb([1, 1, 1], rng.range(0.82, 1.12)), [1.25, 1.05, 0.7], dry * rng.range(0.4, 1));
        push(lod, x, g.h - 0.02, z, rng.range(0.75, 1.25), rng.range(0.8, 1.15) * (0.75 + lush * 0.9), tint);
        // wild flowers: kolmi near the water, ghashphul and yellow weeds elsewhere
        if (lod === 0 && rng.next() < 0.07 * drift) {
          const wet = g.h < 0.9;
          const kind = wet && rng.next() < 0.6 ? 4 : rng.next() < 0.65 ? 2 : 3;
          push(kind, x + rng.range(-0.15, 0.15), g.h - 0.02, z + rng.range(-0.15, 0.15), rng.range(0.8, 1.2), 1, [1, 1, 1], 0.2);
        }
      }
    }
    return {
      key,
      used: this.frame,
      parts: out.map((o) => ({ m: new Float32Array(o.list), c: new Float32Array(o.col), n: o.col.length / 3 })),
    };
  }

}

/** Whether a beach of sand open to the Bay lies within DUNE_REACH of (x, z): sampled on a 10 m grid round it. */
function nearOpenBeach(x: number, z: number): boolean {
  for (let dz = -DUNE_REACH; dz <= DUNE_REACH; dz += 10) {
    for (let dx = -DUNE_REACH; dx <= DUNE_REACH; dx += 10) {
      const px = x + dx;
      const pz = z + dz;
      if (coverAt(px, pz) === COVER.sand && kindAt(px, pz) === KIND.tidal && exposureAt(px, pz) > 0.2) return true;
    }
  }
  return false;
}
