import {
  AddEquation,
  BufferAttribute,
  BufferGeometry,
  Color,
  CustomBlending,
  DataTexture,
  DataUtils,
  HalfFloatType,
  LinearFilter,
  LinearMipmapLinearFilter,
  Matrix4,
  Mesh,
  OneFactor,
  OneMinusSrcAlphaFactor,
  RGBAFormat,
  RepeatWrapping,
  ShaderMaterial,
  Vector4,
} from 'three';
import type { Texture } from 'three';
import { G, LAYER_WATER } from '../core/globals';
import { periodicNoise } from '../core/noise';
import { EDGE_MARGIN, GLSL_COMMON } from '../render/glsl';
import { HERO_HULL, HERO_SINK, hullWaterlineGlsl } from './hull';
import { shipWakeGlsl, wakeGlsl } from './wake';
import { OPEN_SEA, SHELTERED, swellGlsl, waveHeightLodGlsl, waveSlopeLodGlsl } from './waves';
import { WATER_LEVEL, WORLD_X0, WORLD_X1, WORLD_Z0, WORLD_Z1, eachWaterwayPoint, inlandWaterAt, meanWaterLevelAt, terrainHeight, waterLevelAt, waterRise, waterwayAt } from './geography';
import { WORLD } from './plan';

/** A field's rectangle in the world (x0, z0 its corner with the least x and z; sx, sz its extent) and its texels. */
interface FieldRect {
  x0: number;
  z0: number;
  sx: number;
  sz: number;
  w: number;
  h: number;
}

/** The wide field over the whole world and the margin the waters run on into, ≈8 m a texel. */
const FIELD_WIDE: FieldRect = {
  x0: WORLD_X0 - EDGE_MARGIN,
  z0: WORLD_Z1 - EDGE_MARGIN,
  sx: WORLD_X1 - WORLD_X0 + 2 * EDGE_MARGIN,
  sz: WORLD_Z0 - WORLD_Z1 + 2 * EDGE_MARGIN,
  w: 420,
  h: 360,
};
/**
 * The fine field round the camera: 1 km square at 4 m a texel, so the creeks and the khal have their own
 * depth. Rebuilt round the camera once it strays `drift` m from the middle, `ms` milliseconds of it a frame (a
 * whole one is ≈0.5 s of work: a fixed 24 rows a frame cost ≈50 ms a frame for a dozen frames after every cut).
 */
const FINE = { size: 1024, texels: 256, drift: 300, ms: 2 };

/** Tiling ripple normals, generated once. */
function rippleNormals(maxAnisotropy: number): DataTexture {
  const N = 256;
  const h = new Float32Array(N * N);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const u = x / N;
      const v = y / N;
      const ridged = 1 - Math.abs(periodicNoise(u * 8, v * 8, 8, 1) * 2 - 1);
      h[y * N + x] =
        ridged * 0.45 +
        periodicNoise(u * 16, v * 16, 16, 2) * 0.3 +
        periodicNoise(u * 32, v * 32, 32, 3) * 0.16 +
        periodicNoise(u * 64, v * 64, 64, 4) * 0.08;
    }
  }
  const data = new Uint8Array(N * N * 4);
  const k = 7;
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const dx = h[y * N + ((x + 1) % N)] - h[y * N + ((x + N - 1) % N)];
      const dy = h[((y + 1) % N) * N + x] - h[((y + N - 1) % N) * N + x];
      const nx = -dx * k;
      const ny = -dy * k;
      const l = Math.hypot(nx, ny, 1);
      const i = (y * N + x) * 4;
      data[i] = Math.round((nx / l * 0.5 + 0.5) * 255);
      data[i + 1] = Math.round((ny / l * 0.5 + 0.5) * 255);
      data[i + 2] = Math.round((1 / l * 0.5 + 0.5) * 255);
      data[i + 3] = 255;
    }
  }
  const t = new DataTexture(data, N, N);
  t.wrapS = t.wrapT = RepeatWrapping;
  t.minFilter = LinearMipmapLinearFilter;
  t.magFilter = LinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = maxAnisotropy;
  t.needsUpdate = true;
  return t;
}

/**
 * r: the bed's height, gb: the surface current (m/s), a: how open the water is to the wind and the swell (0
 * everywhere here: all the water is inland and sheltered). Lets the water know its depth, its flow and its
 * shelter anywhere. Fills rows [from, to) of `data`.
 */
function fillField(o: FieldRect, data: Uint16Array, from: number, to: number): void {
  for (let j = from; j < to; j++) {
    const z = o.z0 + ((j + 0.5) / o.h) * o.sz;
    for (let i = 0; i < o.w; i++) {
      const x = o.x0 + ((i + 0.5) / o.w) * o.sx;
      const h = terrainHeight(x, z);
      // the river and the khal drift down their lengths, fastest in their middles
      let fx = 0;
      let fz = 0;
      const w = waterwayAt(x, z);
      if (w && w.d < w.half) {
        const t = w.d / w.half;
        const speed = w.way.current * Math.max(0, 1 - t * t);
        const p = w.way.at(w.s);
        fx = Math.sin(p.heading) * speed;
        fz = Math.cos(p.heading) * speed;
      }
      const k = (j * o.w + i) * 4;
      data[k] = DataUtils.toHalfFloat(Math.max(-40, Math.min(40, h)));
      data[k + 1] = DataUtils.toHalfFloat(fx);
      data[k + 2] = DataUtils.toHalfFloat(fz);
      data[k + 3] = 0;
    }
  }
}

function fieldTexture(o: FieldRect, filled = true): { texture: DataTexture; bounds: Vector4 } {
  const data = new Uint16Array(o.w * o.h * 4);
  if (filled) fillField(o, data, 0, o.h);
  const texture = new DataTexture(data, o.w, o.h, RGBAFormat, HalfFloatType);
  texture.minFilter = texture.magFilter = LinearFilter;
  texture.needsUpdate = true;
  return { texture, bounds: new Vector4(o.x0, o.z0, 1 / o.sx, 1 / o.sz) };
}

/** A field being filled, a few rows at a time. */
interface Filling {
  rect: FieldRect;
  data: Uint16Array;
  row: number;
}

/**
 * The fine field follows the camera: once it strays from the field's middle a new one is filled round it a
 * little each frame (no hitch), then swapped in whole; beyond the fine field the wide one stands in meanwhile.
 * The film readies the field where its next shot opens ahead of the cut (`warm`), and the camera takes it up
 * when it gets there. Two textures take turns: the one readied ahead is uploaded to the GPU before the cut, so
 * the cut's frame only switches to it.
 */
class FineField {
  /** The water's `tField`: the texture of the field in use. */
  readonly uniform: { value: DataTexture };
  readonly bounds: Vector4;
  private readonly textures: [DataTexture, DataTexture];
  private rect: FieldRect;
  private next: Filling | null = null;
  private ahead: Filling | null = null;
  /** The filling the spare texture already holds, uploaded (the one readied ahead); null if none. */
  private spareHolds: Filling | null = null;
  private readonly upload: (texture: Texture) => void;

  constructor(x: number, z: number, upload: (texture: Texture) => void) {
    this.rect = FineField.around(x, z);
    const f = fieldTexture(this.rect);
    this.textures = [f.texture, fieldTexture(this.rect, false).texture];
    this.uniform = { value: f.texture };
    this.bounds = f.bounds;
    this.upload = upload;
  }

  private get spare(): DataTexture {
    return this.textures[this.uniform.value === this.textures[0] ? 1 : 0];
  }

  /** Puts a filled field's data in the spare texture (uploaded now if `now`, else when it is first drawn). */
  private stage(f: Filling, now: boolean): void {
    const spare = this.spare;
    (spare.image.data as Uint16Array).set(f.data);
    spare.needsUpdate = true;
    if (now) this.upload(spare);
    this.spareHolds = f;
  }

  /** Shows a filled field: the spare texture, holding it already or given it now. */
  private show(f: Filling): void {
    if (this.spareHolds !== f) this.stage(f, false);
    this.uniform.value = this.spare;
    this.spareHolds = null;
    this.bounds.set(f.rect.x0, f.rect.z0, 1 / f.rect.sx, 1 / f.rect.sz);
    this.rect = f.rect;
  }

  private static around(x: number, z: number): FieldRect {
    // snapped to whole texels, so a rebuilt field samples the ground at the same points as before
    const step = FINE.size / FINE.texels;
    return { x0: Math.round((x - FINE.size / 2) / step) * step, z0: Math.round((z - FINE.size / 2) / step) * step, sx: FINE.size, sz: FINE.size, w: FINE.texels, h: FINE.texels };
  }

  /** How far (x, z) is from a field's middle (m, the larger of the two ways). */
  private static off(rect: FieldRect, x: number, z: number): number {
    return Math.max(Math.abs(x - rect.x0 - FINE.size / 2), Math.abs(z - rect.z0 - FINE.size / 2));
  }

  private static start(x: number, z: number): Filling {
    return { rect: FineField.around(x, z), data: new Uint16Array(FINE.texels * FINE.texels * 4), row: 0 };
  }

  /** Fills rows of `f` until `until` (performance.now()), one at least; true once it is whole. */
  private static fill(f: Filling, until: number): boolean {
    do {
      fillField(f.rect, f.data, f.row, f.row + 1);
      f.row++;
    } while (f.row < f.rect.h && performance.now() < until);
    return f.row >= f.rect.h;
  }

  /** Follows the camera at (x, z); `now` rebuilds round it at once (stills, jumps). */
  update(x: number, z: number, now = false): void {
    // the camera has come where a field was being readied: it is the one to follow now
    if (this.ahead && FineField.off(this.ahead.rect, x, z) < FINE.drift) {
      this.next = this.ahead;
      this.ahead = null;
    }
    if (!this.next) {
      if (FineField.off(this.rect, x, z) < (now ? 8 : FINE.drift)) return;
      this.next = FineField.start(x, z);
    }
    const n = this.next;
    if (n.row < n.rect.h && !FineField.fill(n, now ? Infinity : performance.now() + FINE.ms)) return;
    this.show(n);
    this.next = null;
  }

  /** Readies the field round (x, z) until `until` (performance.now()), to be taken up when the camera comes; true once ready. */
  warm(x: number, z: number, until: number): boolean {
    if (FineField.off(this.rect, x, z) < FINE.drift) return true;
    if (!this.ahead || FineField.off(this.ahead.rect, x, z) > 8) this.ahead = FineField.start(x, z);
    const a = this.ahead;
    if (a.row < a.rect.h && !(performance.now() < until && FineField.fill(a, until))) return false;
    // ready: into the spare texture and onto the GPU now, while only one shot is drawn (it would be the cut's frame)
    if (this.spareHolds !== a) this.stage(a, true);
    return true;
  }
}

/** The level map's cells (m), and how many of them round water carry its level on (see levelTexture), over ground no lower than this under it (m): the bil's marshy rim. */
const LEVEL_CELL = 6;
const LEVEL_SPREAD = 8;
const SPREAD_BELOW = 0.15;
/** The level map covers the world and `EDGE_MARGIN` round it, so the river runs on into the haze. */
const LEVEL_AREA = { x0: WORLD.x0 - EDGE_MARGIN, x1: WORLD.x1 + EDGE_MARGIN, z0: WORLD.z0 - EDGE_MARGIN, z1: WORLD.z1 + EDGE_MARGIN };
const LEVEL_W = Math.ceil((LEVEL_AREA.x1 - LEVEL_AREA.x0) / LEVEL_CELL);
const LEVEL_H = Math.ceil((LEVEL_AREA.z1 - LEVEL_AREA.z0) / LEVEL_CELL);

/**
 * Which water stands where, over the world in LEVEL_CELL cells: r the surface of the water there at its mean
 * level (the river's, a khal's, the bil's or a pond's; the season's rise is GLSL waterLevels' to add); g 1 where the water is the sea's (none here); b 1 where it is water; a how
 * open it is to a sea's swell (none here). Round the water r carries the nearest water's level on for
 * LEVEL_SPREAD cells, so the water grid's vertices beside a pond stand at its level and the pond's edge is cut
 * by the ground, not by the grid; farther off r lies well under the ground.
 */
function levelTexture(): { texture: DataTexture; map: Vector4 } {
  const n = LEVEL_W * LEVEL_H;
  const surface = new Float32Array(n).fill(-20);
  const inland = new Uint8Array(n);
  const centre = (i: number) => ({ x: LEVEL_AREA.x1 - ((i % LEVEL_W) + 0.5) * LEVEL_CELL, z: LEVEL_AREA.z1 - (Math.floor(i / LEVEL_W) + 0.5) * LEVEL_CELL });
  for (let i = 0; i < n; i++) {
    const c = centre(i);
    if (!inlandWaterAt(c.x, c.z)) continue;
    inland[i] = 1;
    surface[i] = meanWaterLevelAt(c.x, c.z);
  }
  // the waterways' own points, so the narrow side khal has its cells wherever it runs (geography.ts)
  const mark = (x: number, z: number, level: number) => {
    const c = Math.floor((LEVEL_AREA.x1 - x) / LEVEL_CELL);
    const r = Math.floor((LEVEL_AREA.z1 - z) / LEVEL_CELL);
    if (c < 0 || r < 0 || c >= LEVEL_W || r >= LEVEL_H) return;
    const i = r * LEVEL_W + c;
    surface[i] = level;
    inland[i] = 1;
  };
  eachWaterwayPoint(mark);
  // carry each water's level outward, ring by ring (the nearest water's, as a breadth-first search), over
  // ground that stands above it only: on lower ground beyond a pond's bank its water would stand in the air
  const above = (j: number, level: number) => {
    const c = centre(j);
    return terrainHeight(c.x, c.z) > level - SPREAD_BELOW;
  };
  const reached = new Uint8Array(n);
  let ring: number[] = [];
  for (let i = 0; i < n; i++) if (inland[i]) (reached[i] = 1), ring.push(i);
  for (let step = 0; step < LEVEL_SPREAD && ring.length; step++) {
    const next: number[] = [];
    for (const i of ring) {
      const c = i % LEVEL_W;
      for (const j of [c > 0 ? i - 1 : -1, c < LEVEL_W - 1 ? i + 1 : -1, i - LEVEL_W, i + LEVEL_W]) {
        if (j < 0 || j >= n || reached[j] || !above(j, surface[i])) continue;
        reached[j] = 1;
        surface[j] = surface[i];
        next.push(j);
      }
    }
    ring = next;
  }
  const data = new Uint16Array(n * 4);
  const zero = DataUtils.toHalfFloat(0);
  for (let i = 0; i < n; i++) {
    data[i * 4] = DataUtils.toHalfFloat(surface[i]);
    data[i * 4 + 1] = zero;
    data[i * 4 + 2] = DataUtils.toHalfFloat(inland[i]);
    data[i * 4 + 3] = zero;
  }
  const texture = new DataTexture(data, LEVEL_W, LEVEL_H, RGBAFormat, HalfFloatType);
  texture.minFilter = texture.magFilter = LinearFilter;
  texture.needsUpdate = true;
  // u runs west to east (x falling), v north to south (z falling)
  return { texture, map: new Vector4(LEVEL_AREA.x1, LEVEL_AREA.z1, 1 / (LEVEL_AREA.x1 - LEVEL_AREA.x0), 1 / (LEVEL_AREA.z1 - LEVEL_AREA.z0)) };
}

/**
 * The level the mirror pass reflects about for an eye over (x, z): that of the water nearest it, looking out
 * in rings to 240 m; the khal's when there is none.
 */
function mirrorLevelAt(x: number, z: number): number {
  for (const r of [0, 25, 60, 120, 240]) {
    const n = r ? 12 : 1;
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2;
      const px = x + Math.cos(a) * r;
      const pz = z + Math.sin(a) * r;
      if (inlandWaterAt(px, pz)) return waterLevelAt(px, pz);
    }
  }
  return WATER_LEVEL + waterRise();
}

/** GLSL: the water field at p, from the fine one round the camera or the wide one beyond it (the levels are GLSL_COMMON's waterLevels). */
const FIELD_GLSL = /* glsl */ `
vec4 waterField(vec2 p) {
  vec2 f = (p - uField.xy) * uField.zw;
  vec4 fine = texture2D(tField, f);
  vec4 wide = texture2D(tFieldWide, (p - uFieldWide.xy) * uFieldWide.zw);
  vec2 edge = min(f, 1.0 - f);
  return min(edge.x, edge.y) > 0.01 ? fine : wide;
}`;

/** Angular segments of the water's grid; its vertices lie this share of their distance from the camera apart. */
const GRID_SEGMENTS = 256;
const GRID_SPACING = (Math.PI * 2) / GRID_SEGMENTS;
/** Out to here (m) the grid is fine enough to carry waves; beyond, its rings widen fast to the world's edge. */
const GRID_WAVES = 300;
const GRID_FAR = 6000;
/** The water's extent (x0, z0, x1, z1): the map and the open Bay round it, on to the horizon. */
const WATER_BOUNDS = new Vector4(WORLD_X0 - 6000, WORLD_Z1 - 6000, WORLD_X1 + 6000, WORLD_Z0 + 6000);

/**
 * The water's mesh: rings round the camera, each a little wider than the last, so its vertices lie about as
 * far apart as a pixel's worth of distance needs (centimetres under the camera, metres far off). The vertex
 * shader moves it with the camera; nothing is snapped, so each wave is drawn only where the vertices lie
 * close enough to draw it, and the surface does not shimmer as the camera moves.
 */
function waterGrid(): BufferGeometry {
  const radii: number[] = [];
  let r = 0.6;
  while (r < GRID_WAVES) {
    radii.push(r);
    r *= 1 + GRID_SPACING;
  }
  while (r < GRID_FAR) {
    radii.push(r);
    r *= 1.25;
  }
  radii.push(r);
  const n = GRID_SEGMENTS;
  const pos = new Float32Array((1 + radii.length * n) * 3);
  radii.forEach((radius, i) => {
    for (let j = 0; j < n; j++) {
      const a = (j / n) * Math.PI * 2;
      const k = (1 + i * n + j) * 3;
      pos[k] = Math.cos(a) * radius;
      pos[k + 2] = Math.sin(a) * radius;
    }
  });
  const index: number[] = [];
  // a fan under the camera, then a band of quads between each ring and the next (wound to face up)
  for (let j = 0; j < n; j++) index.push(0, 1 + ((j + 1) % n), 1 + j);
  for (let i = 0; i + 1 < radii.length; i++) {
    for (let j = 0; j < n; j++) {
      const a = 1 + i * n + j;
      const b = 1 + i * n + ((j + 1) % n);
      index.push(a, b, b + n, a, b + n, a + n);
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(pos, 3));
  g.setIndex(index);
  return g;
}

/** The three nearest moving ships (world/ships.ts): x, z, heading, speed; and their waterline's half-length and half-beam. */
const SHIP_UNIFORMS = /* glsl */ `
uniform vec4 uShip0;
uniform vec4 uShip1;
uniform vec4 uShip2;
uniform vec4 uShipSize0;
uniform vec4 uShipSize1;
uniform vec4 uShipSize2;`;

/** A ship's waves at a point of the water, in her frame (needs shipWake, wake.ts). */
const SHIP_WAVES = /* glsl */ `
float shipWaves(vec2 p, vec4 ship, vec4 size, float spacing) {
  if (ship.w < 0.05) return 0.0;
  vec2 d = p - ship.xy;
  if (abs(d.x) + abs(d.y) > 1800.0) return 0.0;
  vec2 q = vec2(dot(d, vec2(cos(ship.z), -sin(ship.z))), dot(d, vec2(sin(ship.z), cos(ship.z))));
  return shipWake(q, ship.w, size.xy, spacing);
}`;

const VERT = /* glsl */ `
${GLSL_COMMON}
uniform sampler2D tField;
uniform vec4 uField;
uniform sampler2D tFieldWide;
uniform vec4 uFieldWide;
uniform vec4 uBoat;
uniform vec4 uOar;
uniform vec4 uBounds;
uniform float uInland;
${SHIP_UNIFORMS}
varying vec3 vWorld;
varying float vWave;
${FIELD_GLSL}
${waveHeightLodGlsl()}
${wakeGlsl()}
${shipWakeGlsl()}
${SHIP_WAVES}
${swellGlsl()}
// how far above the sea's level the swash's sheet runs up the beach now (m): the broken swell's run-up (about
// half its height at the shore), rising as each crest comes in and draining back between them
float swashRun(vec2 p, float open) {
  float s = swellHeight(p) / max(uSwell.w, 1e-3);
  return 0.6 * uSwell.w * min(open * 2.0, 1.0) * pow(smoothstep(-0.3, 1.0, s), 0.7);
}
void main() {
  // the grid round the camera, laid on the world and kept to the water's extent
  vec2 local = position.xz;
  float spacing = max(length(local), 0.6) * ${GRID_SPACING.toFixed(5)};
  vec2 xz = clamp(uCamPos.xz + local, uBounds.xy, uBounds.zw);
  vec4 fld = waterField(xz);
  // the sea's water stands at the sea's level; inland water (ponds, pans, the bil) at its own
  float level = uInland > 0.5 ? waterLevels(xz).r : uWaterLevel;
  float depth = max(level - fld.r, 0.0);
  // still water carries a share of the open water's waves, and they die out on the shallows by the shore;
  // a pond's are only ripples
  float running = max(smoothstep(0.0, 0.2, length(fld.gb) * abs(uFlowScale)), fld.a);
  float shoal = smoothstep(0.0, 0.6, depth);
  float h = waveHeightLod(xz, spacing) * mix(${SHELTERED.toFixed(2)}, 1.0, running) * shoal * (uInland > 0.5 ? 0.15 : 1.0);
  // toward the open Bay the wind's waves stand higher, and the swell rolls in, rising over the shallows
  if (uInland < 0.5) {
    float open = seaExposure(xz);
    h *= 1.0 + ${OPEN_SEA.toFixed(2)} * open;
    // the swell lifts the grid only where its vertices lie close enough to draw it (its shortest wave is ≈90 m;
    // farther off, sampled too coarsely, it would ring round the camera): its slopes shade the water beyond
    h += swellHeight(xz) * swellFactor(open, depth) * smoothstep(40.0, 18.0, spacing);
    // the swash: a thin sheet running up the beach's face over the surf's last metre of depth (drawn only where
    // the grid is fine enough for a band a few metres wide)
    if (open > 0.05) h += swashRun(xz, open) * (1.0 - smoothstep(0.0, 1.2, level - fld.r)) * smoothstep(6.0, 2.5, spacing);
  }
  vWave = h;
  // the water the boat pushes aside
  vec2 bd = xz - uBoat.xy;
  if (abs(bd.x) + abs(bd.y) < 150.0) {
    vec2 q = vec2(dot(bd, vec2(cos(uBoat.z), -sin(uBoat.z))), dot(bd, vec2(sin(uBoat.z), cos(uBoat.z))));
    h += boatWake(q, uBoat.w, uOar, spacing) * shoal;
  }
  // the big ships' own waves (world/ships.ts: the three nearest moving hulls)
  if (uInland < 0.5) h += (shipWaves(xz, uShip0, uShipSize0, spacing) + shipWaves(xz, uShip1, uShipSize1, spacing) + shipWaves(xz, uShip2, uShipSize2, spacing)) * shoal;
  vWorld = vec3(xz.x, level + h, xz.y);
  gl_Position = projectionMatrix * viewMatrix * vec4(vWorld, 1.0);
}
`;

const FRAG = /* glsl */ `
${GLSL_COMMON}
uniform sampler2D tRefl;
uniform mat4 uTexMatrix;
uniform sampler2D tNormal;
uniform sampler2D tField;
uniform vec4 uField;
uniform sampler2D tFieldWide;
uniform vec4 uFieldWide;
uniform vec4 uBoat;      // x, z, heading, speed through the water
uniform vec4 uOar;       // the paddle's blade in the boat's frame (x across, z along), how hard it pulls, how deep it is (0..1)
uniform vec4 uSwirl;     // where the blade last came out (world x, z), seconds since, how hard it had pulled
${SHIP_UNIFORMS}
uniform vec4 uNetA0;     // the river fisherman's cast net (world/fisher.ts): the middle of what it covers (x, z), its reach, seconds since it struck
uniform vec4 uNetB0;     // ... the strike's strength, how hard it is being hauled through, how much water is running off it, the cast's seed
uniform vec4 uNetA1;     // the gher fisherman's
uniform vec4 uNetB1;
uniform vec4 uTouch;     // a light thing come down on the water (the film's petal, world/petals.ts): x, z, seconds since, how hard
uniform vec3 uAmb;
uniform float uInland;
varying vec3 vWorld;
varying float vWave;

${FIELD_GLSL}
${hullWaterlineGlsl(HERO_HULL, HERO_SINK)}
${waveSlopeLodGlsl()}
${wakeGlsl()}
${shipWakeGlsl()}
${SHIP_WAVES}
${swellGlsl()}

// a big ship: the slopes of her waves for the shading, white water breaking at her stem and along her sides
// when she has way on, and the wash of her screw astern (separate uniforms rather than an array: ANGLE)
void shipShade(vec2 p, vec4 ship, vec4 size, float shoal, inout vec2 slope, inout float foam) {
  if (ship.w < 0.05) return;
  vec2 d = p - ship.xy;
  if (abs(d.x) + abs(d.y) > 1500.0) return;
  vec2 rt = vec2(cos(ship.z), -sin(ship.z));
  vec2 fw = vec2(sin(ship.z), cos(ship.z));
  vec2 q = vec2(dot(d, rt), dot(d, fw));
  float e = 0.5;
  float hc = shipWake(q, ship.w, size.xy, 0.0);
  vec2 g = vec2(shipWake(q + vec2(e, 0.0), ship.w, size.xy, 0.0) - hc, shipWake(q + vec2(0.0, e), ship.w, size.xy, 0.0) - hc) / e;
  slope += (rt * g.x + fw * g.y) * shoal;
  float hl = size.x;
  float beam = size.y;
  float way = smoothstep(1.0, 3.5, ship.w);
  float sy = (q.y - hl * 1.04) / (0.05 * hl);
  float stem = exp(-sy * sy) * smoothstep(beam * 1.3, beam * 0.5, abs(q.x));
  float sides = smoothstep(beam * 1.25, beam * 1.02, abs(q.x)) * step(abs(q.y), hl * 1.05);
  float aft = -hl - q.y;
  float wash = aft > 0.0 ? smoothstep(beam * (1.0 + aft * 0.003), beam * 0.15, abs(q.x)) * exp(-aft / (5.0 * hl)) : 0.0;
  float n = vnoise(q * 0.3 + vec2(0.0, uTime * 0.5));
  foam += (stem * 0.9 + sides * 0.3) * way * smoothstep(0.3, 0.7, n) + wash * smoothstep(0.35, 0.8, n) * 0.55 * smoothstep(0.3, 1.5, ship.w);
}

vec2 ripple(vec2 uv) { return texture2D(tNormal, uv).xy * 2.0 - 1.0; }

// rings spreading from raindrops: in each cell of two offset grids a drop lands now and then, and its
// ring widens and fades (squared by hand: pow() of a negative base is undefined in GLSL)
// a cast net (world/fisher.ts) and the water it stirs, all from where the net is and what it is doing:
// - struck: its weighted rim hits all round at once, white for a moment where each weight goes in (each its own
//   splash, so the ring is uneven), sending a train of ripples out over the open water and another in under the
//   mesh; the twine dimples the surface inside as it sinks;
// - hauled: the rim drawn in under the surface stirs the water round it, more as he heaves;
// - lifted: the water pouring and dripping off the bag patters the surface under it.
void netRings(vec4 na, vec4 nb, vec2 p, inout vec2 slope, inout float foam) {
  if (na.z <= 0.0) return;
  vec2 o = p - na.xy;
  float r = length(o);
  if (r > na.z + 7.0) return;
  vec2 dir = o / max(r, 1e-3);
  float d = r - na.z;
  float age = na.w;
  float uneven = 0.55 + 0.9 * vnoise(vec2(atan(o.y, o.x) * 6.0 + nb.w, nb.w * 1.7));
  if (age < 7.0) {
    float decay = exp(-age * 0.5) * uneven;
    float fo = d - age * 0.6;
    float fi = d + age * 0.45;
    slope += dir * cos(fo * 10.0) * exp(-fo * fo * 2.5) * 0.4 * decay;
    if (d < 0.0) slope -= dir * cos(fi * 10.0) * exp(-fi * fi * 3.0) * 0.3 * decay * smoothstep(0.0, 0.6, r);
    foam += exp(-d * d * 45.0) * nb.x * uneven * smoothstep(0.35, 0.7, vnoise(p * 6.5 + nb.w));
    if (d < 0.0) slope += (vec2(vnoise(p * 5.0 + age), vnoise(p * 5.0 + 17.0 - age)) - 0.5) * 0.35 * exp(-age * 0.7);
  }
  if (nb.y > 0.01) slope += dir * cos(d * 9.0 - uTime * 6.5) * exp(-abs(d) * 1.3) * 0.22 * nb.y;
  if (nb.z > 0.01 && r < na.z + 0.3) slope += rainRipples(p * 1.6 + nb.w, nb.z).xy * 0.8 * smoothstep(na.z + 0.3, na.z * 0.5, r);
}

// ---- the boat: fine rings for the shading (her bow wave, wake and the blade's push are boatWake's) ----
float boatRipples(vec2 q, float spd) {
  float L = ${(HERO_HULL.len / 2).toFixed(3)};
  // the hull rocking on the waves sends little rings off her sides, livelier with way on
  float s = clamp(q.y / L, -0.92, 0.92);
  float hb = 0.82 * sqrt(max(1.0 - s * s, 0.0)) + 0.05;
  float dd = length(vec2(max(abs(q.x) - hb, 0.0), q.y - s * L));
  float h = 0.4 * exp(-dd * 0.55) * sin(dd * 5.0 - uTime * 3.4) * (0.35 + 0.65 * spd);
  // rings spreading from where the blade pulls, only while it is in the water
  float ro = length(q - uOar.xy);
  h += 0.12 * min(uOar.z, 4.0) * uOar.w * exp(-ro * 0.6) * sin(ro * 7.0 - uTime * 6.0);
  return h;
}

void main() {
  vec3 wp = vWorld;
  vec3 toCam = uCamPos - wp;
  float dist = length(toCam);
  vec3 V = toCam / dist;

  // boat frame: q.x across (to starboard), q.y along (toward the bow)
  float hd = uBoat.z;
  vec2 fw = vec2(sin(hd), cos(hd));
  vec2 rt = vec2(cos(hd), -sin(hd));
  vec2 bd = wp.xz - uBoat.xy;
  vec2 q = vec2(dot(bd, rt), dot(bd, fw));
  float sAlong = q.y / ${(HERO_HULL.len / 2).toFixed(3)};
  // no river inside the boat: its floorboards sit just above the waterline
  if (abs(sAlong) < 1.0 && abs(q.x) < hullHalfBeamAtWater(sAlong) * 0.96) discard;
  float boatSpd = clamp(uBoat.w / 2.0, 0.0, 1.4);

  vec4 fld = waterField(wp.xz);
  // each water only where it belongs: the sea's where the ground is joined to the sea (not over the ponds
  // and pans, nor the polders' fields below its level); inland water only where it stands above its bed
  vec3 lv = waterLevels(wp.xz);
  // (a khal narrower than the field's texels: its bed there reads half bank, so only ground well above the
  // level is taken as dry; the depth test hides the rest under the banks)
  if (uInland > 0.5 ? (lv.b < 0.5 || lv.r < fld.r - 0.3) : lv.g < 0.5) discard;
  float level = uInland > 0.5 ? lv.r : uWaterLevel;
  float depth = max(level - fld.r, 0.0);
  // the season sets the river's pace: fast and full in the rains, slack in the dry months
  vec2 flow = fld.gb * uFlowScale;
  float spd = length(flow);
  vec2 along = spd > 0.02 ? flow / spd : vec2(0.0, -1.0);
  vec2 across = vec2(-along.y, along.x);
  // the river's own frame: ripples are drawn out along the current, as moving water stretches them
  vec2 fp = vec2(dot(wp.xz, across), dot(wp.xz, along));

  // two-phase flow map: ripples drift with the current, without a visible reset
  float ph = uTime * 0.1;
  float p0 = fract(ph);
  float p1 = fract(ph + 0.5);
  float w0 = 1.0 - abs(2.0 * p0 - 1.0);
  vec2 uvA = fp / vec2(6.5, 17.0);
  vec2 adv = vec2(0.0, spd * 10.0 / 17.0);
  vec2 tA = ripple(uvA - adv * p0) * w0 + ripple(uvA - adv * p1 + 0.37) * (1.0 - w0);
  vec2 nA = across * tA.x + along * tA.y;
  // wind ripples, not advected
  vec2 nB = ripple(wp.xz / 3.2 - uWind.xy * uTime * 0.08 + vec2(0.13, 0.71));
  // a slow broad swell
  vec2 nC = ripple(wp.xz / 46.0 + vec2(uTime * 0.004, -uTime * 0.006));
  float far = 1.0 / (1.0 + dist * 0.01);
  // still water (the bil, the khals, the slack by the banks) lies glassier than the running channel and the open sea
  float running = max(smoothstep(0.0, 0.2, spd), fld.a);
  vec2 slope = nA * (0.07 + 0.13 * running) + nB * (0.06 + 0.1 * uWind.z) * (0.6 + 0.4 * running) * far + nC * (0.04 + 0.06 * running);
  // the wind's waves the boat and the floating plants ride (see waves.ts), as the surface stands on them,
  // damped where the water is sheltered and dying out on the shallows; under a gust front the ripples
  // darken and roughen the water (cat's paws)
  float shoal = smoothstep(0.0, 0.6, depth);
  float footprint = max(length(dFdx(wp.xz)), length(dFdy(wp.xz)));
  slope += waveSlopeLod(wp.xz, footprint) * mix(${SHELTERED.toFixed(2)}, 1.0, running) * shoal;
  // toward the open Bay: the wind's waves higher, the swell, and where it breaks over the shallows the surf
  float open = uInland > 0.5 ? 0.0 : seaExposure(wp.xz);
  float surf = 0.0;
  if (open > 0.002) {
    slope *= 1.0 + ${OPEN_SEA.toFixed(2)} * open;
    float sf = swellFactor(open, depth);
    slope += swellSlope(wp.xz) * sf;
    // white water on the fronts of the breaking crests, and the lace of foam they leave behind them (a ridged
    // noise: veins, not patches)
    float breaking = swellBreaking(open, depth);
    if (breaking > 0.01) {
      float swellCrest = swellHeight(wp.xz) / max(uSwell.w, 1e-3);
      float lace = smoothstep(0.9, 0.98, 1.0 - abs(fbm3(wp.xz * 0.5 + vec2(uTime * 0.05, -uTime * 0.04)) * 2.0 - 1.0));
      surf = breaking * (smoothstep(0.82, 0.97, swellCrest) * 0.85 + lace * 0.45 * smoothstep(-0.6, 0.4, swellCrest));
    }
  }
  // the swash's sheet over the sand: thin and all but clear, its leading edge a line of froth, the white water
  // thinning over the beach's face
  float film = wp.y - fld.r;
  float sheet = 1.0;
  if (uInland < 0.5 && open > 0.05 && film < 0.3) {
    sheet = smoothstep(0.0, 0.08, film);
    surf *= mix(0.4, 1.0, smoothstep(0.0, 0.3, level - fld.r));
    surf += smoothstep(0.09, 0.025, film) * smoothstep(0.0, 0.012, film) * min(open * 1.5, 1.0) * (0.55 + 0.45 * vnoise(wp.xz * 2.0 + uTime * 0.5));
  }
  slope += nB * 0.1 * uWind.z * max(windGust(wp.xz) - 1.0, 0.0) * far;
  // rain: every drop rings the surface where it strikes, its crest catching the light, white for an instant
  // where it struck (the chop a downpour raises comes with the waves above)
  float rainWhite = 0.0;
  if (uRain > 0.01 && dist < 160.0) {
    vec3 rr = rainRipples(wp.xz, uRain);
    slope += rr.xy * (0.7 + 0.6 * uRain) * far;
    rainWhite = rr.z * far;
  }
  // a strong wind breaks the tops of the waves into whitecaps, streaked downwind, under the gusts
  // (none at all below a fresh breeze, even in its gusts: then the noise is not worth reading)
  float whitecaps = 0.0;
  if (uWind.z * (1.0 + uWind.w) > 1.4) {
    float blow = uWind.z * windGust(wp.xz);
    vec2 wq = vec2(dot(wp.xz, vec2(-uWind.y, uWind.x)) * 2.2, dot(wp.xz, uWind.xy) * 0.55 - uTime * 0.9);
    float crest = vnoise(wq) * 0.65 + vnoise(wq * 2.7 + 3.1) * 0.35;
    whitecaps = smoothstep(1.4, 2.6, blow) * smoothstep(0.72, 0.9, crest) * (0.5 + 0.5 * vnoise(wp.xz * 0.15 - uTime * 0.05));
  }

  float foam = whitecaps * 0.6 * running + rainWhite * 0.6;
  // in a strong wind the highest crests break, white for a moment in ragged patches, streaked away downwind
  float crest = smoothstep(0.4, 0.8, vWave / max(uSea.x, 0.02));
  if (crest > 0.0) {
    vec2 cq = vec2(dot(wp.xz, vec2(-uWind.y, uWind.x)) * 4.0, dot(wp.xz, uWind.xy) * 1.3 - uTime * 1.5);
    float rag = vnoise(cq) * 0.6 + vnoise(cq * 2.9 + 1.7) * 0.4;
    foam += crest * smoothstep(1.3, 2.4, uWind.z) * smoothstep(0.6, 0.78, rag) * 0.75;
  }
  // water lapping along the hull at the waterline, livelier with way on
  if (abs(sAlong) < 1.0) {
    float edge = abs(q.x) - hullHalfBeamAtWater(sAlong);
    foam += smoothstep(0.28, 0.0, edge) * (0.3 + 0.4 * boatSpd) * smoothstep(0.35, 0.7, vnoise(vec2(q.y * 3.0 - uTime * 1.5, q.x * 9.0)));
  }
  if (q.y > -180.0 && q.y < 12.0 && abs(q.x) < 75.0) {
    // the slopes of the water she pushes aside (as the surface stands on it, see wake.ts), and the fine rings
    float e = 0.08;
    float hc = boatWake(q, uBoat.w, uOar, 0.0);
    vec2 g = vec2(boatWake(q + vec2(e, 0.0), uBoat.w, uOar, 0.0) - hc, boatWake(q + vec2(0.0, e), uBoat.w, uOar, 0.0) - hc) / e;
    float rc = boatRipples(q, boatSpd);
    g += vec2(boatRipples(q + vec2(0.12, 0.0), boatSpd) - rc, boatRipples(q + vec2(0.0, 0.12), boatSpd) - rc) / 0.12 * 0.05;
    slope += (rt * g.x + fw * g.y) * shoal;
    // a paddled boat raises no white water, only a little curl at her stem where the water heaps highest
    // (most in a strong stroke's surge) and some froth along her wake's arms close astern, soon gone
    foam += smoothstep(0.03, 0.08, hc) * smoothstep(0.45, 0.8, vnoise(q * 6.0 + vec2(0.0, uTime * 2.5))) * 0.6;
    float d = ${(HERO_HULL.len * 0.32).toFixed(3)} - q.y;
    if (d > 0.0) {
      float arm = 0.66 + d * 0.3536;
      float wa = (abs(q.x) - arm) / (0.25 + d * 0.03);
      foam += exp(-wa * wa) * exp(-d * 0.12) * smoothstep(1.2, 2.0, uBoat.w) * smoothstep(0.55, 0.85, vnoise(vec2(q.x * 3.0, q.y * 1.4 + uTime * 0.8))) * 0.4;
    }
  }

  if (uInland < 0.5) {
    shipShade(wp.xz, uShip0, uShipSize0, shoal, slope, foam);
    shipShade(wp.xz, uShip1, uShipSize1, shoal, slope, foam);
    shipShade(wp.xz, uShip2, uShipSize2, shoal, slope, foam);
  }
  // the paddle: white water where the blade bites, and the eddies it leaves where it came out
  float rb = length(q - uOar.xy);
  foam += uOar.w * smoothstep(0.6, 0.0, rb) * (0.25 + 0.12 * min(uOar.z, 4.0)) * smoothstep(0.3, 0.75, vnoise(q * 7.0 + uTime * 3.0));
  vec2 sd = wp.xz - uSwirl.xy;
  float sr = length(sd);
  if (sr < 3.0 && uSwirl.w > 0.0) {
    float age = uSwirl.z;
    // squared by hand: pow() of a negative base is undefined in GLSL
    float rr = (sr - 0.2 - age * 0.45) / (0.12 + age * 0.06);
    float ring = exp(-rr * rr) * exp(-age * 1.1) * uSwirl.w;
    slope += sd / max(sr, 1e-3) * ring * 0.18;
    // the dimple turning at the eddy's heart
    slope += vec2(-sd.y, sd.x) * exp(-sr * sr * 6.0) * exp(-age * 1.4) * uSwirl.w * 0.6;
    foam += ring * 0.35 * smoothstep(0.4, 0.8, vnoise(wp.xz * 9.0 + uTime));
  }

  netRings(uNetA0, uNetB0, wp.xz, slope, foam);
  netRings(uNetA1, uNetB1, wp.xz, slope, foam);
  // a light thing touching the water: a short train of fine ripples spreading from it at a hand's breadth a
  // second, widening and fading as they go (left out where a pixel is too coarse to draw them)
  if (uTouch.w > 0.0 && uTouch.z < 5.0) {
    vec2 td = wp.xz - uTouch.xy;
    float tr = length(td);
    float age = uTouch.z;
    float front = tr - 0.03 - age * 0.24;
    float spread = 0.035 + age * 0.03;
    float train = exp(-front * front / (spread * spread)) * exp(-age * 0.8) / (1.0 + tr * 4.0);
    slope += td / max(tr, 1e-3) * cos(front * 150.0) * train * 0.35 * uTouch.w * smoothstep(0.02, 0.006, footprint);
  }

  // flecks of foam and silt riding the current, thickest in the slack water by the banks (none on still water)
  vec2 fq = vec2(fp.x * 0.9, fp.y * 0.22);
  float fa = smoothstep(0.74, 0.92, vnoise(fq - vec2(0.0, spd * 2.2 * p0)));
  float fb = smoothstep(0.74, 0.92, vnoise(fq - vec2(0.0, spd * 2.2 * p1) + 3.7));
  foam += (fa * w0 + fb * (1.0 - w0)) * smoothstep(3.5, 0.6, depth) * smoothstep(0.03, 0.25, spd) * 0.35 * far;

  vec3 N = normalize(vec3(-slope.x, 1.0, -slope.y));
  float NdV = max(dot(N, V), 0.0);
  float F = 0.02 + 0.98 * pow(1.0 - NdV, 5.0);

  // reflection (planar), distorted by the ripples; water standing at another level than the mirror's (a pond
  // seen from the channel, the channel from the bil) shows the hazy sky instead of a misplaced image
  vec4 rc = uTexMatrix * vec4(wp, 1.0);
  vec2 ruv = rc.xy / rc.w + N.xz * 0.05 / (1.0 + dist * 0.02);
  vec3 refl = texture2D(tRefl, clamp(ruv, vec2(0.001), vec2(0.999))).rgb;
  refl = mix(hazeColor(reflect(-V, N)), refl, 1.0 - smoothstep(0.2, 0.6, abs(level - uMirrorLevel)));

  // Premultiplied: the surface reflects F of the light and lets the rest through to the riverbed, which
  // tints itself with the silty water it is seen through (see underwater()). Shallows show their bed.
  float keyUp = max(uKeyDir.y, 0.0);
  vec3 light = uAmb + uKeyColor * keyUp * 0.45;
  vec3 col = refl * F;
  float alpha = F;

  // sun (or moon) glitter
  vec3 H = normalize(uKeyDir + V);
  float nh = max(dot(N, H), 0.0);
  col += uKeyColor * (pow(nh, 1100.0) * 26.0 + pow(nh, 160.0) * 0.7) * step(0.0, uKeyDir.y) * (1.0 - uOvercast);
  col *= sheet;
  alpha *= sheet;

  // a lapping line where the river meets the bank, faint round still water
  float shore = smoothstep(0.5, 0.06, depth) * smoothstep(0.0, 0.04, depth) * (0.35 + 0.65 * smoothstep(0.03, 0.25, spd));
  foam += shore * smoothstep(0.35, 0.8, vnoise(wp.xz * 0.8 + vec2(uTime * 0.25, -uTime * 0.1)));
  vec3 foamCol = vec3(0.62, 0.58, 0.5) * light * 0.3183;
  float fA = clamp(foam, 0.0, 1.0) * 0.55;
  col = col * (1.0 - fA) + foamCol * fA;
  alpha = alpha * (1.0 - fA) + fA;
  // the surf's white water, clean and bright where the swell breaks (the river's foam above is silt-brown)
  float sA = clamp(surf, 0.0, 1.0) * 0.82;
  vec3 surfCol = vec3(0.92, 0.92, 0.9) * light * 0.5;
  col = col * (1.0 - sA) + surfCol * sA;
  alpha = alpha * (1.0 - sA) + sA;

  // fog the premultiplied colour as if it were opaque, then weight it back by its coverage
  col = applyAtmosphere(col / max(alpha, 1e-3), wp) * alpha;
  gl_FragColor = vec4(col, alpha);
}
`;

/** For the two lift nets nearest the camera: a = (x, z, half-side, yaw) of the net's square, b = (splash, drip, 0, 0). */
export interface NetRipples {
  a: [Vector4, Vector4];
  b: [Vector4, Vector4];
}

export interface Water {
  /** The sea's water: the channel, the creeks, the flooded flats and the Bay. */
  mesh: Mesh;
  /** Inland water: the ponds, the pans, the bil and the khal, each at its own level. */
  inland: Mesh;
  /** Keeps the fine field round the camera at (x, z) (`now` rebuilds it at once), and the mirror at the level of the water nearest it. */
  update(x: number, z: number, now?: boolean): void;
  /** Readies the fine field round (x, z) until `until` (performance.now()), for a shot about to open there; true once ready. */
  warm(x: number, z: number, until: number): boolean;
  /** The hero boat: x, z, heading, speed through the water. */
  boat: Vector4;
  /** Its paddle blade in the boat's frame (x across, z along), how hard it pulls, how deep it is (0..1). */
  oar: Vector4;
  /** The eddy the blade left where it last came out: world x, z, seconds since, strength. */
  swirl: Vector4;
  /** The rings of the two lift nets nearest the camera. */
  nets: NetRipples;
  /** A light thing come down on the water: x, z, seconds since, how hard (0: none). */
  touch: Vector4;
  /** The three nearest moving ships (x, z, heading, speed) and their (half-length, half-beam), world/ships.ts. */
  ships: Vector4[];
  shipSizes: Vector4[];
  color: Color;
  ambient: Color;
}

/** `upload` puts a texture on the GPU now (the renderer's `initTexture`). */
export function buildWater(reflection: Texture, textureMatrix: Matrix4, maxAnisotropy: number, upload: (texture: Texture) => void): Water {
  const field = new FineField(0, 0, upload);
  const wide = fieldTexture(FIELD_WIDE);
  // every shader that asks which water stands where (GLSL_COMMON's waterLevels) reads it through G
  const levels = levelTexture();
  G.tLevel.value = levels.texture;
  G.uLevelMap.value.copy(levels.map);
  const boat = new Vector4();
  const oar = new Vector4();
  const swirl = new Vector4(0, 0, 99, 0);
  const nets: NetRipples = { a: [new Vector4(), new Vector4()], b: [new Vector4(), new Vector4()] };
  const touch = new Vector4();
  const ships = [new Vector4(), new Vector4(), new Vector4()];
  const shipSizes = [new Vector4(), new Vector4(), new Vector4()];
  const color = new Color();
  const ambient = new Color();
  const uniforms = {
    ...G,
    tRefl: { value: reflection },
    uTexMatrix: { value: textureMatrix },
    tNormal: { value: rippleNormals(maxAnisotropy) },
    tField: field.uniform,
    uField: { value: field.bounds },
    tFieldWide: { value: wide.texture },
    uFieldWide: { value: wide.bounds },
    uBoat: { value: boat },
    uOar: { value: oar },
    uSwirl: { value: swirl },
    uNetA0: { value: nets.a[0] },
    uNetB0: { value: nets.b[0] },
    uNetA1: { value: nets.a[1] },
    uNetB1: { value: nets.b[1] },
    uTouch: { value: touch },
    uShip0: { value: ships[0] },
    uShip1: { value: ships[1] },
    uShip2: { value: ships[2] },
    uShipSize0: { value: shipSizes[0] },
    uShipSize1: { value: shipSizes[1] },
    uShipSize2: { value: shipSizes[2] },
    uAmb: { value: ambient },
    uBounds: { value: WATER_BOUNDS },
  };
  const grid = waterGrid();
  const make = (inland: boolean) => {
    const material = new ShaderMaterial({
      uniforms: { ...uniforms, uInland: { value: inland ? 1 : 0 } },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      blending: CustomBlending,
      blendEquation: AddEquation,
      blendSrc: OneFactor,
      blendDst: OneMinusSrcAlphaFactor,
    });
    const mesh = new Mesh(grid, material);
    // the vertex shader lays the grid round the camera, so its bounds mean nothing to culling
    mesh.frustumCulled = false;
    mesh.layers.set(LAYER_WATER);
    // first of the see-through things, so fireflies and motes over the river draw on top of it
    mesh.renderOrder = -1;
    mesh.name = inland ? 'water-inland' : 'water';
    return mesh;
  };
  // this world has no sea (geography.ts): its mesh is kept for the water's shared code but never drawn
  const sea = make(false);
  sea.visible = false;
  return {
    mesh: sea,
    inland: make(true),
    warm: (x, z, until) => field.warm(x, z, until),
    update: (x, z, now = false) => {
      field.update(x, z, now);
      G.uMirrorLevel.value = mirrorLevelAt(x, z);
    },
    boat,
    oar,
    swirl,
    touch,
    nets,
    ships,
    shipSizes,
    color,
    ambient,
  };
}

