import {
  BufferGeometry,
  DoubleSide,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  MeshStandardMaterial,
  Quaternion,
  Vector3,
} from 'three';
import type { Material } from 'three';
import { G, LAYER_NO_REFLECT } from '../core/globals';
import { smoothstep } from '../core/mathx';
import { fbm } from '../core/noise';
import { Rng } from '../core/rng';
import { MeshBuilder, mixRgb, rgb, scaleRgb, type RGB } from '../render/builder';
import { CORRIDOR, CROP_REACH } from '../render/glsl';
import { patchMaterial } from '../render/patch';
import { WATER_LEVEL, corridorDistance, inGraveyard, onBridge, onLandmark, onMosqueGrounds, onRoad, onZamindarGrounds, roadNear, terrainHeight } from './geography';
import { ghatLocal } from './ghatFlight';
import { nearStone } from './stones';
import { groundLattice } from './terrain';
import type { Ghat, HutPlan } from './village';

// Grass you can walk through: dense blade clumps, wild flowers and pebbles, built only round the viewer,
// chunk by chunk as the view moves. Seen from the boat the banks are 100 m off and this costs nothing;
// in the free camera or the film's bank-side shots the ground is thick with it.
// One kind of clump all the way out (the user saw a sparser, lighter kind farther off as a second step and asked
// for it gone): full clumps out past both banks of the river from the boat, thinning away at the far edge, each
// clump at its own distance, so there is no line where the grass ends; from higher up the grass reaches less far
// (`groundReach`), and a chunk built late grows up out of the ground. Chunks in front of the
// camera are built first, within a few milliseconds a frame; the film builds its next shot's ahead (`warm`).

const CHUNK = 8;
/** How many views' wanted lists `warm` keeps (the film readies a shot by five points; the map jump by one). */
const WARM_VIEWS = 16;
/** A chunk's half-diagonal: how far its clumps stand from its middle at most. */
const CHUNK_REACH = CHUNK * 0.71;
/**
 * The grass's band (m, as `groundReach` measures, before the quality tier's share): fading in over `in`, out over
 * `out` (each clump a few metres sooner or later than the next, by `THIN`).
 */
const BANDS = [{ in: [-2, -1], out: [78, 100] }] as const;
/** How far each clump's own distance for thinning away wanders (m). */
const THIN = 14;
/** Milliseconds a frame may spend building chunks. */
const BUILD_MS = 2;
/** Seconds a chunk built late takes to grow up out of the ground. */
const GROW = 0.9;
/** Chunks kept built: those in view, and the film's next shot's, made ahead of it. */
const CACHE = 2600;
/** Candidate spacing for the clumps (m). */
const STEP = 0.4;
/** Lattice spacing for the cheap height and cover lookups inside a chunk. */
const LATTICE = 1.6;

/** The quality tier's share of the grass's reach, for the shaders' bands. */
const REACH = { value: 1 };

/** Shrinks a clump to its foot by its band at its distance (each its own), and while its chunk grows in. */
const fade = (lod: 0) => /* glsl */ `
{
  vec3 root = instanceMatrix[3].xyz;
  float d = groundReach(root) / uMeadowReach + (hash12(root.xz * 1.7) - 0.5) * ${THIN.toFixed(1)};
  transformed *= smoothstep(${BANDS[lod].in[0].toFixed(1)}, ${BANDS[lod].in[1].toFixed(1)}, d) * (1.0 - smoothstep(${BANDS[lod].out[0].toFixed(1)}, ${BANDS[lod].out[1].toFixed(1)}, d))
    * smoothstep(aBorn, aBorn + ${GROW.toFixed(2)}, uTime);
}`;
const FADE_PARS = 'attribute float aBorn;\nuniform float uMeadowReach;\n';

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

interface Layer {
  mesh: InstancedMesh;
  colors: InstancedBufferAttribute;
  /** When each clump's chunk was built (the shader clock), for growing in. */
  born: InstancedBufferAttribute;
  capacity: number;
}

/** One chunk's instances per layer: matrices (16 floats each) and colours (3 floats each). */
interface ChunkData {
  key: string;
  parts: { m: Float32Array; c: Float32Array; n: number }[];
  used: number;
  /** When it was built (the shader clock); long ago for those built out of sight. */
  born: number;
}

/** A chunk a view wants: its key (x, z, level of detail), its middle, and its distance. */
interface Want {
  key: string;
  x: number;
  z: number;
  d: number;
}

const LAYERS = ['grassNear', 'white', 'yellow', 'lilac'] as const;
type LayerName = (typeof LAYERS)[number];

/** Dense grass and wild flowers round the viewer, rebuilt chunk by chunk as the view moves. */
export class Meadow {
  readonly group = new Group();
  /** Two sets of meshes (see `holdView`); `cur` is the one built for the camera. */
  private readonly sets: [Record<LayerName, Layer>, Record<LayerName, Layer>];
  private readonly views: [Group, Group] = [new Group(), new Group()];
  private cur = 0;
  private readonly cache = new Map<string, ChunkData>();
  private readonly huts: readonly HutPlan[];
  private readonly ghats: readonly Ghat[];
  private wanted: Want[] = [];
  /** The wanted lists of views being readied ahead (`warm`), by where they are. */
  private readonly warmWants = new Map<string, Want[]>();
  private centre = '';
  private reach = 1;
  private dirty = false;
  private frame = 0;

  constructor(huts: readonly HutPlan[], ghats: readonly Ghat[]) {
    this.group.name = 'meadow';
    this.huts = huts;
    this.ghats = ghats;
    const grassMat = (lod: 0) =>
      patchMaterial(new MeshStandardMaterial({ vertexColors: true, side: DoubleSide, roughness: 0.78 }), {
        seasonal: 'leaf',
        wind: 0.12,
        windHeight: 0.55,
        translucency: 1.7,
        foliage: true,
        vertex: { key: `meadow-grass-${lod}`, pars: FADE_PARS, code: fade(lod), uniforms: { uMeadowReach: REACH } },
      });
    const flowerMat = patchMaterial(new MeshStandardMaterial({ vertexColors: true, side: DoubleSide, roughness: 0.7 }), {
      wind: 0.1,
      windHeight: 0.4,
      translucency: 1.2,
      foliage: true,
      vertex: { key: 'meadow-flower', pars: FADE_PARS, code: fade(0), uniforms: { uMeadowReach: REACH } },
    });
    const make = (view: Group, shape: BufferGeometry, material: Material, capacity: number): Layer => {
      // each set its own copy: the birth times are per set
      const geometry = shape.clone();
      const born = new InstancedBufferAttribute(new Float32Array(capacity), 1);
      geometry.setAttribute('aBorn', born);
      const mesh = new InstancedMesh(geometry, material, capacity);
      mesh.count = 0;
      mesh.receiveShadow = true;
      mesh.castShadow = false;
      mesh.layers.set(LAYER_NO_REFLECT);
      const colors = new InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
      mesh.instanceColor = colors;
      view.add(mesh);
      return { mesh, colors, born, capacity };
    };
    const shapes = {
      grassNear: grassClump(1, 10, 3, 0.03),
      white: flowerClump(3, 'white'),
      yellow: flowerClump(4, 'yellow'),
      lilac: flowerClump(5, 'lilac'),
    };
    const near = grassMat(0);
    const set = (view: Group): Record<LayerName, Layer> => ({
      grassNear: make(view, shapes.grassNear, near, 32000),
      white: make(view, shapes.white, flowerMat, 1500),
      yellow: make(view, shapes.yellow, flowerMat, 1200),
      lilac: make(view, shapes.lilac, flowerMat, 1200),
    });
    this.sets = [set(this.views[0]), set(this.views[1])];
    this.views[1].visible = false;
    this.group.add(...this.views);
  }

  // ---- two views: the film's dissolves draw the shot being left (its grass as it stood) beneath the one coming in ----

  /** Keeps the grass as it stands for the shot being left, and builds the next one's into the other set. */
  holdView(): void {
    this.cur ^= 1;
    this.views[this.cur].visible = true;
    this.centre = '';
    this.dirty = true;
  }

  /** Shows the held set alone (`held`), or the current one alone. */
  showHeld(held: boolean): void {
    this.views[this.cur].visible = !held;
    this.views[this.cur ^ 1].visible = held;
  }

  /** The dissolve is over: only the current set is drawn. */
  releaseView(): void {
    this.views[this.cur].visible = true;
    this.views[this.cur ^ 1].visible = false;
  }


  /** How far the grass reaches, as a share of its bands (the lower quality tier keeps it closer). */
  setReach(k: number): void {
    this.reach = k;
    REACH.value = k;
    this.centre = '';
  }

  /** The chunks a view at `view` wants, nearest first. Seen from higher up they reach less far. */
  private wantedAt(view: Vector3): Want[] {
    const cx = Math.floor(view.x / CHUNK);
    const cz = Math.floor(view.z / CHUNK);
    const lift = Math.max(0, view.y - terrainHeight(view.x, view.z) - 3) * CROP_REACH.lift;
    // out to the band's end and the farthest a clump's own thinning may carry it
    const far = (BANDS[0].out[1] + THIN / 2) * this.reach;
    const R = Math.ceil((far + CHUNK_REACH) / CHUNK);
    const list: Want[] = [];
    for (let dz = -R; dz <= R; dz++) {
      for (let dx = -R; dx <= R; dx++) {
        const x = (cx + dx + 0.5) * CHUNK;
        const z = (cz + dz + 0.5) * CHUNK;
        const d = Math.hypot(x - view.x, z - view.z, lift);
        // nothing grown out where the land fades away
        if (d < far + CHUNK_REACH && corridorDistance(x, z) < CORRIDOR.crops) list.push({ key: `${cx + dx},${cz + dz},0`, x, z, d });
      }
    }
    return list.sort((a, b) => a.d - b.d);
  }

  /** Builds the chunks a view at `view` will want, until `until` (performance.now()), without showing them: the film readies its next shot. True once all are built. */
  warm(view: Vector3, until: number): boolean {
    if (performance.now() > until) return false;
    // the film asks after the same few points frame after frame: their lists are worked out once
    const key = `${Math.round(view.x)},${Math.round(view.y)},${Math.round(view.z)},${this.reach}`;
    let wants = this.warmWants.get(key);
    if (!wants) {
      if (this.warmWants.size >= WARM_VIEWS) this.warmWants.clear();
      this.warmWants.set(key, (wants = this.wantedAt(view)));
    }
    for (const w of wants) {
      const chunk = this.cache.get(w.key);
      if (chunk) {
        chunk.used = this.frame;
        continue;
      }
      if (performance.now() > until) return false;
      // out of sight as it is built: it stands grown when the camera comes
      this.cache.set(w.key, this.build(w.key, true));
    }
    return true;
  }

  /**
   * Call every frame with the camera's position and which way it looks. `all` builds every missing chunk now,
   * grown (for stills); otherwise a few milliseconds' worth, those in front of the camera and the nearest first.
   */
  update(view: Vector3, all = false, forward?: Vector3): void {
    this.frame++;
    const lift = Math.max(0, view.y - terrainHeight(view.x, view.z) - 3);
    const centre = `${Math.floor(view.x / CHUNK)},${Math.floor(view.z / CHUNK)},${Math.round(lift / 3)}`;
    if (centre !== this.centre) {
      this.centre = centre;
      this.wanted = this.wantedAt(view);
      this.dirty = true;
    }
    const start = performance.now();
    for (const ahead of [true, false]) {
      for (const w of this.wanted) {
        if (this.cache.has(w.key)) continue;
        if (!all && performance.now() - start > BUILD_MS) break;
        // first those ahead of the camera (or right by it), then the rest
        if (ahead && forward && w.d > 10 && (w.x - view.x) * forward.x + (w.z - view.z) * forward.z < 0) continue;
        this.cache.set(w.key, this.build(w.key, all));
        this.dirty = true;
      }
    }
    if (this.dirty) this.upload();
  }

  private upload(): void {
    this.dirty = false;
    const offsets: Record<string, number> = {};
    for (const name of LAYERS) offsets[name] = 0;
    for (const w of this.wanted) {
      const chunk = this.cache.get(w.key);
      if (!chunk) continue;
      chunk.used = this.frame;
      LAYERS.forEach((name, i) => {
        const part = chunk.parts[i];
        const layer = this.sets[this.cur][name];
        const at = offsets[name];
        const n = Math.min(part.n, layer.capacity - at);
        if (n <= 0) return;
        (layer.mesh.instanceMatrix.array as Float32Array).set(part.m.subarray(0, n * 16), at * 16);
        (layer.colors.array as Float32Array).set(part.c.subarray(0, n * 3), at * 3);
        (layer.born.array as Float32Array).fill(chunk.born, at, at + n);
        offsets[name] = at + n;
      });
    }
    for (const name of LAYERS) {
      const { mesh, colors, born } = this.sets[this.cur][name];
      mesh.count = offsets[name];
      mesh.instanceMatrix.needsUpdate = true;
      colors.needsUpdate = true;
      born.needsUpdate = true;
      if (mesh.count) mesh.computeBoundingSphere();
    }
    // forget the chunks not seen for a while
    if (this.cache.size > CACHE) {
      const old = [...this.cache.values()].sort((a, b) => a.used - b.used);
      for (const c of old.slice(0, this.cache.size - CACHE)) this.cache.delete(c.key);
    }
  }

  /** `grown`: built out of sight (or for a still), so it stands at once; else it grows in from now. */
  private build(key: string, grown = false): ChunkData {
    const [cx, cz, lod] = key.split(',').map(Number);
    const x0 = cx * CHUNK;
    const z0 = cz * CHUNK;
    const rng = new Rng((Math.imul(cx, 73856093) ^ Math.imul(cz, 19349663) ^ (lod * 83492791)) >>> 0);
    const out = LAYERS.map(() => ({ list: [] as number[], col: [] as number[] }));
    const lattice = groundLattice(x0, z0, CHUNK, LATTICE);
    const huts = this.huts.filter((h) => Math.abs(h.x - x0 - CHUNK / 2) < CHUNK && Math.abs(h.z - z0 - CHUNK / 2) < CHUNK);
    const ghats = this.ghats.filter((g) => Math.abs(g.x - x0 - CHUNK / 2) < CHUNK && Math.abs(g.z - z0 - CHUNK / 2) < CHUNK);
    const m = new Matrix4();
    const q = new Quaternion();
    const pos = new Vector3();
    const scl = new Vector3();
    const tilt = new Vector3();
    const spin = new Quaternion();
    const push = (layer: number, x: number, y: number, z: number, s: number, sy: number, color: RGB, lean = 0.12) => {
      q.setFromAxisAngle(tilt.set(rng.range(-1, 1), 0, rng.range(-1, 1)).normalize(), rng.range(0, lean));
      q.multiply(spin.setFromAxisAngle(UP, rng.range(0, Math.PI * 2)));
      m.compose(pos.set(x, y, z), q, scl.set(s, s * sy, s));
      out[layer].list.push(...m.elements);
      out[layer].col.push(color[0], color[1], color[2]);
    };
    const step = STEP;
    const n = Math.round(CHUNK / step);
    // a chunk no way comes near asks nothing of each clump (the ways' index is the dearest question here)
    const nearWay = roadNear(x0 + CHUNK / 2, z0 + CHUNK / 2, CHUNK_REACH + 0.25);
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const x = x0 + (i + rng.next()) * step;
        const z = z0 + (j + rng.next()) * step;
        const g = lattice(x, z);
        // none in the khal's or the bil's water, nor on the mud just above it
        if (g.h < WATER_LEVEL + 0.25) continue;
        if (huts.some((h) => Math.hypot(h.x - x, h.z - z) < Math.max(h.l, h.w) * 0.6 + 0.4)) continue;
        // (the graveyard's grass is let grow among its graves; the mosque's grounds and the zamindar's lawn are kept short)
        const graves = inGraveyard(x, z);
        const short = graves || onMosqueGrounds(x, z) || onZamindarGrounds(x, z);
        if (onBridge(x, z) || (onLandmark(x, z) && !graves) || nearStone(x, z, 0.05)) continue;
        // nothing grows on a road, a footpath or the bridge's worn way: they stay trodden and clear (the
        // lattice is too coarse to see a footpath's metre, so each is asked here)
        if (nearWay && onRoad(x, z, 0.25)) continue;
        // the ghats' steps, their landings and benches, and the trodden ground round them
        if (ghats.some((gh) => Math.hypot(gh.x - x, gh.z - z) < 9 || onGhatGround(gh, x, z))) continue;
        // grass where the ground is grassy, in drifts, thinning on trodden earth and in the paddy
        const drift = smoothstep(0.28, 0.62, fbm(x * 0.07, z * 0.07, 2, 91));
        // none in the paddy plots (zone > 0)
        const density = (g.grass * (0.45 + 0.55 * drift) + g.dirt * 0.12 * drift) * (1 - Math.abs(g.zone)) * (1 - g.bare) * (short ? 0.75 : 1);
        if (rng.next() > density) continue;
        const lush = fbm(x * 0.03 + 7, z * 0.03, 2, 92);
        const dry = Math.min(1, g.dirt * 1.4 + smoothstep(0.62, 0.8, lush) * 0.5);
        const tint = mixRgb(scaleRgb([1, 1, 1], rng.range(0.82, 1.12)), [1.25, 1.05, 0.7], dry * rng.range(0.4, 1));
        push(lod, x, g.h - 0.02, z, rng.range(0.75, 1.25), rng.range(0.8, 1.15) * (0.75 + lush * 0.9) * (short ? 0.42 : 1), tint);
        // wild flowers: kolmi near the water, ghashphul and yellow weeds elsewhere
        if (rng.next() < 0.07 * drift) {
          const wet = g.h < WATER_LEVEL + 0.9;
          const kind = wet && rng.next() < 0.6 ? 3 : rng.next() < 0.65 ? 1 : 2;
          push(kind, x + rng.range(-0.15, 0.15), g.h - 0.02, z + rng.range(-0.15, 0.15), rng.range(0.8, 1.2), 1, [1, 1, 1], 0.2);
        }
      }
    }
    return {
      key,
      used: this.frame,
      born: grown ? -1e4 : G.uTime.value,
      parts: out.map((o) => ({ m: new Float32Array(o.list), c: new Float32Array(o.col), n: o.col.length / 3 })),
    };
  }

}

/** Up a ghat's bank from its foot past its landing, and across it to its benches (village.ts brickGhat: its landing's back is 9.9 m up). */
function onGhatGround(g: Ghat, x: number, z: number): boolean {
  const { d, s } = ghatLocal(g, x, z);
  return d > -1 && d < 11.4 && Math.abs(s) < 5;
}
