import { BufferAttribute, BufferGeometry, DoubleSide, Group, InstancedBufferAttribute, InstancedMesh, Matrix4, MeshStandardMaterial, Quaternion, Vector3 } from 'three';
import type { Texture } from 'three';
import { G, LAYER_NO_REFLECT } from '../core/globals';
import { Rng } from '../core/rng';
import { MeshBuilder, mixRgb, rgb, type RGB } from '../render/builder';
import { CROP_REACH } from '../render/glsl';
import { patchMaterial } from '../render/patch';
import { mustardCanopyTexture, mustardRacemeTexture, riceCanopyTexture, riceHillTexture } from '../render/textures';
import { onRoad, terrainHeight } from './geography';
import { groundLattice } from './terrain';

// The crops in the paddy plots, standing in 3D round the camera (out to CROP_REACH; beyond, the terrain
// paints each plot with its crop's colour): transplanted rice in rows of hills, from seedlings standing in
// water through the deep green of the growing crop to the gold of ripe heads nodding over, then the
// stubble after the harvest; and in the winter, mustard sown thick and in full yellow flower.
// What a plot holds is the season's (env/season.ts): every patch works out its plot's crop in the vertex
// shader, from the same plot layout and shares the terrain paints with (plotFrame, cropShares in glsl.ts),
// so the crops grow, ripen, are reaped and give way to mustard as the year turns, smoothly, with nothing
// to rebuild. The wind (env/wind.ts) rolls across them in gust fronts, bending each plant from its foot.
// Patches are laid in each plot's own frame, rows along its length, filling it between its bunds; near the
// camera each is real plants, farther off rows of painted cards under a painted canopy, and farthest the
// canopy alone (seen that low and that far, the rows below it no longer show, and they cost the most).
// Nothing pops: each level of detail fades into the next over a band of distance (both stand there, one
// sinking as the other rises), the outermost sinks into the painted plots, and a chunk built late (the
// camera came faster than the building) grows up out of the ground. Chunks in front of the camera are built
// first, within a few milliseconds a frame; the film builds its next shot's ahead (`warm`).

/** The plots' layout, as glsl.ts (plotFrame, plotWarp, PLOT_SIZE, PLOT_ANGLE) has it: keep the two in step. */
const PLOT = { w: 32, h: 20, angle: 0.12 };
const plotWarp = (x: number, z: number): [number, number] => [
  14 * Math.sin(z * 0.0131 + 1.3) + 9 * Math.sin(x * 0.0087 + 0.4),
  11 * Math.sin(x * 0.0117 + 2.1) + 7 * Math.sin((x + z) * 0.0071 + 4.0),
];
const COS = Math.cos(PLOT.angle);
const SIN = Math.sin(PLOT.angle);
/** A world point in the plots' frame (plotFrame in glsl.ts). */
function toPlots(x: number, z: number): [number, number] {
  const [wx, wz] = plotWarp(x, z);
  return [COS * (x + wx) + SIN * (z + wz), -SIN * (x + wx) + COS * (z + wz)];
}
/** The world point at a point of the plots' frame: the warp undone by a few fixed-point steps (it bends gently, so they converge fast). */
function fromPlots(qx: number, qy: number): [number, number] {
  const bx = COS * qx - SIN * qy;
  const bz = SIN * qx + COS * qy;
  let x = bx;
  let z = bz;
  for (let k = 0; k < 4; k++) {
    const [wx, wz] = plotWarp(x, z);
    x = bx - wx;
    z = bz - wz;
  }
  return [x, z];
}
/** Bare ground left inside each plot's bunds (m). */
const MARGIN = 0.6;

const CHUNK = 8;
/** A chunk's half-diagonal: how far its patches stand from its middle at most. */
const CHUNK_REACH = CHUNK * 0.71;
/**
 * Each level of detail's band (m, as `groundReach` measures): fading in over `in`, out over `out`. The real
 * plants, with their heads near (to `SWITCH`) and without them beyond (the same hills, so where one gives way to
 * the other nothing changes but the heads, which have faded first); then the canopy alone, crossfading with the
 * plants, and sinking into the painted plots. (A middle level of row cards was a step of its own: the user saw
 * three kinds of crop one behind the other and asked for the middle one gone.)
 */
const BANDS = [
  { in: [-2, -1], out: [1e4, 1e4 + 1] },
  { in: [-2, -1], out: [CROP_REACH.fade, CROP_REACH.edge] },
  { in: [CROP_REACH.fade, CROP_REACH.edge], out: CROP_REACH.canopy },
] as const;
/** Chunks whose middle is nearer than this (m) have the plants with their heads; the heads fade before it. */
const SWITCH = 23;
/** The heads fade out over this (m, by `groundReach`), before any of their chunks give way to the headless ones. */
const HEADS_OUT = [12, 16.5] as const;
/** Milliseconds a frame may spend building chunks. */
const BUILD_MS = 2.5;
/** Seconds a chunk built late takes to grow up out of the ground. */
const GROW = 0.9;
/** Chunks kept built: those in view, and the film's next shot's, made ahead of it. */
const CACHE = 1400;
/** A patch's side (m), near the camera and farther off. */
const PATCH = [1.2, 1.2, 2.4] as const;
const CAPACITY = [3000, 5600, 7200] as const;
/** Where the plants of a patch stand, as a share of the paddy zone (the terrain's own mask). */
const ZONE_MIN = 0.55;

const UP = new Vector3(0, 1, 0);

// ---- the plants. Colours: the rice's carry only shading in r and g (its shader tints it for its stage) and
// in b whether it is a panicle; uv carries each vertex's offset from the foot of its hill or plant, so the
// shader can spread or gather a plant about its own foot.

/**
 * A near patch of rice, 1.2 m square: four rows 0.3 m apart along its x, five hills to a row. Each hill is
 * three cards of `riceHillTexture`'s hill crossed at sixty degrees (unit height: the shader sizes it for its
 * stage), and over it three panicles, each a ribbon of the texture's panicle arching out from the top of a
 * tiller and hanging over (the shader lowers them out of sight until the heads come). Vertex colour: shading in
 * r and g, and in b whether it is a panicle; `uv` each vertex's offset from its hill's foot, the texture
 * coordinates in `uv1`. Without `heads` the same hills, the panicles left out (the farther plants).
 */
function ricePatch(seed: number, heads = true): BufferGeometry {
  const rng = new Rng(seed);
  const b = new MeshBuilder();
  const uv1: number[] = [];
  const S = PATCH[0];
  const UP3 = new Vector3(0, 1, 0);
  const p = new Vector3();
  for (let row = 0; row < 4; row++) {
    for (let k = 0; k < 5; k++) {
      const hx = ((k + 0.5) / 5 - 0.5) * S + rng.range(-0.03, 0.03);
      const hz = ((row + 0.5) / 4 - 0.5) * S + rng.range(-0.025, 0.025);
      const turn = rng.range(0, Math.PI);
      const tall = rng.range(0.88, 1.06);
      // wide enough that neighbouring hills meet, as the crop closes over its rows
      const w = rng.range(0.27, 0.33);
      // the hill: three crossed cards, each leaning its own way a little
      for (let c = 0; c < 3; c++) {
        const a = turn + (c * Math.PI) / 3;
        const dx = Math.cos(a) * w;
        const dz = Math.sin(a) * w;
        const lx = rng.range(-0.04, 0.04);
        const lz = rng.range(-0.04, 0.04);
        const n = new Vector3(-dz, 0.6, dx).normalize();
        const shade = rng.range(0.85, 1.08);
        const col: RGB = [shade, shade, 0];
        const v0 = b.vertex(p.set(hx - dx, 0, hz - dz), n, -dx, -dz, col);
        b.vertex(p.set(hx + dx, 0, hz + dz), n, dx, dz, col);
        b.vertex(p.set(hx + dx + lx, tall, hz + dz + lz), n, dx + lx, dz + lz, col);
        b.vertex(p.set(hx - dx + lx, tall, hz - dz + lz), n, -dx + lx, -dz + lz, col);
        uv1.push(0, 0, 0.5, 0, 0.5, 1, 0, 1);
        b.quad(v0, v0 + 1, v0 + 2, v0 + 3);
      }
      // the panicles: from a tiller's top near the hill's crown, arching out and hanging over
      for (let i = 0; i < 3; i++) {
        const az = rng.range(0, Math.PI * 2);
        const out = new Vector3(Math.cos(az), 0, Math.sin(az));
        const side = new Vector3(-out.z, 0, out.x);
        const base = new Vector3(hx, 0, hz).addScaledVector(out, rng.range(0.02, 0.07)).setY(tall * rng.range(0.8, 0.92));
        const len = rng.range(0.2, 0.27);
        const width = 0.032;
        const shade = rng.range(0.9, 1.05);
        const col: RGB = [shade, shade, 1];
        // the same draws either way, so the hills stand alike with their heads or without
        if (!heads) continue;
        const start = b.vertexCount;
        const steps = 3;
        for (let j = 0; j <= steps; j++) {
          const t = j / steps;
          // up and out, over the top, then down: a quarter of an ellipse and a little more
          const ang = t * 2.1;
          const q = base.clone().addScaledVector(out, Math.sin(ang) * len * 0.62).addScaledVector(UP3, (Math.cos(ang) - 0.35 * t) * len * 0.42);
          const nrm = side.clone().cross(out.clone().multiplyScalar(Math.cos(ang)).addScaledVector(UP3, -Math.sin(ang))).normalize().lerp(UP3, 0.4).normalize();
          const hw = width * (1 - 0.35 * t);
          const l = q.clone().addScaledVector(side, -hw);
          const r = q.clone().addScaledVector(side, hw);
          b.vertex(l, nrm, l.x - hx, l.z - hz, col);
          b.vertex(r, nrm, r.x - hx, r.z - hz, col);
          uv1.push(0.5, t, 1, t);
        }
        for (let j = 0; j < steps; j++) b.quad(start + j * 2, start + j * 2 + 1, start + j * 2 + 3, start + j * 2 + 2);
      }
    }
  }
  const g = b.build();
  g.setAttribute('uv1', new BufferAttribute(new Float32Array(uv1), 2));
  return g;
}

/**
 * A near patch of mustard, 1.2 m square, sown thick: fourteen plants in flower, broad leaves low, the stems
 * branching toward the top, each branch ending in a raceme (two crossed cards of `mustardRacemeTexture`).
 * The racemes' texture coordinates are in `uv1` (the texture's channel 1): `uv` carries each vertex's offset
 * from its plant's foot for the shader. Stems and leaves sample the texture's opaque white quarter.
 */
function mustardPatch(seed: number): BufferGeometry {
  const rng = new Rng(seed);
  const b = new MeshBuilder();
  const uv1: number[] = [];
  const S = PATCH[0];
  const stem = rgb('#5d7a3a');
  const leaf = rgb('#4f6e47');
  const solid = (n: number) => {
    for (let i = 0; i < n; i++) uv1.push(0.9, 0.5);
  };
  const strip = (from: Vector3, to: Vector3, w: number, c0: RGB, c1: RGB, foot: Vector3) => {
    const d = to.clone().sub(from);
    const side = new Vector3(-d.z, 0, d.x).normalize().multiplyScalar(w);
    if (side.lengthSq() < 1e-8) side.set(w, 0, 0);
    const n = new Vector3().crossVectors(side, d).normalize().lerp(UP, 0.5).normalize();
    const pts = [from.clone().sub(side), from.clone().add(side), to.clone().add(side), to.clone().sub(side)];
    const s = b.vertexCount;
    pts.forEach((p, i) => b.vertex(p, n, p.x - foot.x, p.z - foot.z, i < 2 ? c0 : c1));
    solid(4);
    b.quad(s, s + 1, s + 2, s + 3);
  };
  // sown broadcast, not in rows: the plants stand where the seed fell
  for (let i = 0; i < 14; i++) {
    const foot = new Vector3(rng.range(-0.5, 0.5), 0, rng.range(-0.5, 0.5)).multiplyScalar(S * 0.94);
    const h = rng.range(0.8, 1.15);
    const top = foot.clone().add(new Vector3(rng.range(-0.06, 0.06), h, rng.range(-0.06, 0.06)));
    strip(foot, top, 0.007, stem, stem, foot);
    // broad leaves low on the stem, drooping out
    for (let k = 0; k < 3; k++) {
      const a = rng.range(0, Math.PI * 2);
      const at = foot.clone().lerp(top, rng.range(0.05, 0.3));
      const tip = at.clone().add(new Vector3(Math.cos(a) * 0.22, rng.range(0.02, 0.1), Math.sin(a) * 0.22));
      strip(at, tip, 0.045, leaf, mixRgb(leaf, [0.2, 0.3, 0.16], 0.4), foot);
    }
    // branches from a fork, each ending in a raceme a little below the main one
    const fork = foot.clone().lerp(top, rng.range(0.55, 0.7));
    const tips = [top];
    for (let k = 0; k < 3; k++) {
      const a = rng.range(0, Math.PI * 2);
      const t = top.clone().add(new Vector3(Math.cos(a) * rng.range(0.08, 0.2), rng.range(-0.2, -0.03), Math.sin(a) * rng.range(0.08, 0.2)));
      strip(fork, t, 0.005, stem, stem, foot);
      tips.push(t);
    }
    for (const t of tips) {
      const w = rng.range(0.07, 0.1);
      const a0 = rng.range(0, Math.PI);
      const shade = rng.range(0.85, 1.05);
      const c: RGB = [shade, shade, shade];
      for (const a of [a0, a0 + Math.PI / 2]) {
        const dx = Math.cos(a) * w;
        const dz = Math.sin(a) * w;
        const n = new Vector3(-dz, 0.6, dx).normalize();
        // the card's foot 0.17 m down the stalk (the pods), its top 0.07 m above the tip (the flowers' dome)
        const lo = t.y - 0.17;
        const hi = t.y + 0.07;
        const s = b.vertexCount;
        b.vertex(new Vector3(t.x - dx, lo, t.z - dz), n, t.x - dx - foot.x, t.z - dz - foot.z, c);
        b.vertex(new Vector3(t.x + dx, lo, t.z + dz), n, t.x + dx - foot.x, t.z + dz - foot.z, c);
        b.vertex(new Vector3(t.x + dx, hi, t.z + dz), n, t.x + dx - foot.x, t.z + dz - foot.z, c);
        b.vertex(new Vector3(t.x - dx, hi, t.z - dz), n, t.x - dx - foot.x, t.z - dz - foot.z, c);
        uv1.push(0, 0, 0.75, 0, 0.75, 1, 0, 1);
        b.quad(s, s + 1, s + 2, s + 3);
      }
    }
  }
  const g = b.build();
  g.setAttribute('uv1', new BufferAttribute(new Float32Array(uv1), 2));
  return g;
}

/** The crop's canopy seen from above: one quad over a far patch at `height` (unit). */
function canopy(height: number): BufferGeometry {
  const b = new MeshBuilder();
  const h = PATCH[2] / 2;
  const s = b.vertex(new Vector3(-h, height, -h), UP, 0, 0);
  b.vertex(new Vector3(-h, height, h), UP, 0, 1);
  b.vertex(new Vector3(h, height, h), UP, 1, 1);
  b.vertex(new Vector3(h, height, -h), UP, 1, 0);
  b.quad(s, s + 1, s + 2, s + 3);
  return b.build();
}

// ---- the shaders: the plot's crop now, the plant's shape for it, and the wind

/**
 * Which crop the patch's plot holds now (as the terrain paints it), and how much of it stands at this level of
 * detail: its band's share at its distance (the outermost sinking into the terrain's painted plot), and how
 * far a chunk built late has grown.
 */
const stage = (lod: 0 | 1 | 2) => /* glsl */ `
vec3 cropRoot = instanceMatrix[3].xyz;
vec2 cropCell = floor(plotFrame(cropRoot.xz) / PLOT_SIZE);
vec4 cropSh = cropShares(plotRank(cropCell));
float cropStubble = max(0.0, 1.0 - cropSh.x - cropSh.y - cropSh.z - cropSh.w);
float cropGrown = hash12(cropCell + 3.7);
float cropD = groundReach(cropRoot);
float cropFade = smoothstep(${BANDS[lod].in[0].toFixed(1)}, ${BANDS[lod].in[1].toFixed(1)}, cropD) * (1.0 - smoothstep(${BANDS[lod].out[0].toFixed(1)}, ${BANDS[lod].out[1].toFixed(1)}, cropD))
  * smoothstep(aBorn, aBorn + ${GROW.toFixed(2)}, uTime);
`;

/** The rice: its height for the stage (seedling, growing, ripe, stubble), and none where the plot is in mustard or under a deep flood. */
const RICE = /* glsl */ `
float cropTall = cropSh.x * 0.3 + cropSh.y * mix(0.6, 0.95, cropGrown) + cropSh.z + cropStubble * 0.17;
float cropWater = waterSurface(cropRoot.xz);
float cropHere = (1.0 - cropSh.w) * cropFade * smoothstep(cropWater - 0.9, cropWater - 0.5, cropRoot.y);
// leaves: the seedlings' fresh bright green, the growing crop's lush yellow-green (deeper as it grows), the
// ripe crop's yellowing gold-green, straw once reaped
vec3 leafC = (cropSh.x * vec3(0.17, 0.44, 0.04) + cropSh.y * mix(vec3(0.15, 0.38, 0.025), vec3(0.075, 0.24, 0.018), cropGrown)
  + cropSh.z * vec3(0.4, 0.34, 0.05) + cropStubble * vec3(0.32, 0.24, 0.11)) / max(1.0 - cropSh.w, 1e-3);
// heads: from late in the growing into the ripe crop, pale green turning a deep gold
float heads = cropSh.z + cropSh.y * smoothstep(0.7, 0.92, cropGrown);
vec3 headC = mix(vec3(0.3, 0.42, 0.1), vec3(0.7, 0.46, 0.06), cropSh.z / max(cropSh.y + cropSh.z, 1e-3));
`;

/**
 * The one wind (env/wind.ts) in gust fronts rolling across the field: each plant bends from its foot, its
 * top most, as far as its stems allow (`k`: how readily it bends), keeping its length as it goes over.
 */
const sway = (k: number) => /* glsl */ `
{
  float s = uWind.z * windGust(cropRoot.xz);
  float lean = s * (0.5 + 0.5 * s + 0.25 * s * s);
  float flutter = sin(uGust.x * 3.0 + cropRoot.x * 0.73 + cropRoot.z * 0.41 + transformed.x * 2.3 + transformed.z * 1.7) * (0.25 + 0.2 * min(s, 2.0));
  vec2 push = uWind.xy * (lean * 0.45 + flutter * 0.4) + vec2(-uWind.y, uWind.x) * 0.2 * min(s, 2.0) * sin(uGust.x * 2.2 + cropRoot.z * 0.3 + transformed.x);
  float hk = max(transformed.y, 0.0);
  vec2 bend = push * ${k.toFixed(3)} * hk * hk / max(cropTall, 0.15);
  float bl = length(bend);
  float most = 0.75 * hk;
  if (bl > 1e-4) bend *= most * tanh(bl / max(most, 1e-3)) / bl;
  transformed.y -= dot(bend, bend) / max(2.0 * hk, 0.05);
  transformed.xz += (transpose(mat3(instanceMatrix)) * vec3(bend.x, 0.0, bend.y)).xz;
}`;

/** Gathers a plant to its foot (uv holds each vertex's offset from it) by `k`, and sinks it out of sight when gone. */
const gather = (k: string, tall: string) => /* glsl */ `
transformed.xz = transformed.xz - uv + uv * ${k};
transformed.y *= ${tall};
if (${k} < 0.01) transformed.y = -0.3;
`;

const nearRice = (lod: 0 | 1) => /* glsl */ `
${stage(lod)}
${RICE}
${gather('cropHere * mix(0.55, 1.0, smoothstep(0.2, 0.7, cropTall))', 'cropTall * cropHere')}
if (color.b > 0.5) transformed.y = mix(-0.05, transformed.y, heads * (1.0 - smoothstep(${HEADS_OUT[0].toFixed(1)}, ${HEADS_OUT[1].toFixed(1)}, cropD)));
vColor.rgb = mix(leafC, headC, color.b) * vColor.g;
cropTall *= cropHere;
${sway(0.1)}
`;

const farRice = (lod: 2, headShare: number) => /* glsl */ `
${stage(lod)}
${RICE}
transformed.y *= cropTall * cropHere;
if (cropHere < 0.01) transformed.y = -0.3;
vColor.rgb = mix(leafC, headC, heads * ${headShare.toFixed(2)}) * vColor.g;
cropTall *= cropHere;
${sway(0.1)}
`;

const MUSTARD = /* glsl */ `
float cropTall = 1.05;
float cropHere = cropSh.w * cropFade;
`;

/** Mustard is not in rows: each patch turned its own quarter-turn, so their plants never line up. */
const SCATTER = /* glsl */ `
{
  float a = floor(hash12(cropRoot.xz * 1.37) * 4.0) * 1.5708;
  transformed.xz = mat2(cos(a), sin(a), -sin(a), cos(a)) * transformed.xz;
}
`;

const nearMustard = (lod: 0 | 1) => /* glsl */ `
${stage(lod)}
${MUSTARD}
${gather('cropHere', 'cropHere')}
${SCATTER}
cropTall *= cropHere;
${sway(0.14)}
`;

const farMustard = (lod: 2) => /* glsl */ `
${stage(lod)}
${MUSTARD}
transformed.y *= cropHere;
if (cropHere < 0.01) transformed.y = -0.3;
${SCATTER}
cropTall *= cropHere;
${sway(0.14)}
`;

function cropMaterial(key: string, code: string, map?: Texture): MeshStandardMaterial {
  const material = new MeshStandardMaterial({ vertexColors: true, side: DoubleSide, roughness: 0.75, map: map ?? null, alphaTest: map ? 0.45 : 0 });
  // thin leaves: the low sun through them lights the field from behind, the tips glowing
  return patchMaterial(material, { translucency: 2.6, foliage: true, vertex: { key, pars: 'attribute float aBorn;\n', code } });
}

interface Layer {
  meshes: InstancedMesh[];
  matrices: InstancedBufferAttribute;
  colors: InstancedBufferAttribute;
  /** When each patch's chunk was built (the shader clock), for growing in. */
  born: InstancedBufferAttribute;
  capacity: number;
  /** Which of `meshes` are the mustard (shown only while some plot holds it). */
  mustard: InstancedMesh[];
}

interface ChunkData {
  key: string;
  m: Float32Array;
  c: Float32Array;
  n: number;
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

/** The crops round the camera, rebuilt chunk by chunk as the view moves. */
export class Crops {
  readonly group = new Group();
  /** Two sets of meshes (see `holdView`); `cur` is the one built for the camera. */
  private readonly sets: [[Layer, Layer, Layer], [Layer, Layer, Layer]];
  private readonly views: [Group, Group] = [new Group(), new Group()];
  private cur = 0;
  private readonly cache = new Map<string, ChunkData>();
  private wanted: Want[] = [];
  private centre = '';
  private dirty = false;
  private frame = 0;

  constructor() {
    this.group.name = 'crops';
    const riceCanopy = riceCanopyTexture(14);
    const mustardCanopy = mustardCanopyTexture(17);
    // the near rice's hills and panicles, read through its second uv set
    const hill = riceHillTexture(19);
    hill.channel = 1;
    // the near mustard's racemes: read through its second uv set
    const racemes = mustardRacemeTexture(18);
    racemes.channel = 1;
    const riceTop = canopy(0.84);
    const nearRiceShape = ricePatch(11);
    const headlessRiceShape = ricePatch(11, false);
    const mustardShape = mustardPatch(12);
    const mustardTop = canopy(0.92);
    type Part = { geometry: BufferGeometry; key: string; code: string; map?: Texture; mustard: boolean };
    const materials = new Map<string, MeshStandardMaterial>();
    const make = (view: Group, lod: 0 | 1 | 2, parts: Part[]): Layer => {
      const capacity = CAPACITY[lod];
      const matrices = new InstancedBufferAttribute(new Float32Array(capacity * 16), 16);
      const colors = new InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
      const born = new InstancedBufferAttribute(new Float32Array(capacity), 1);
      const meshes = parts.map((p) => {
        // each level of detail (and each set) its own copy: the birth times are per layer
        const geometry = p.geometry.clone();
        geometry.setAttribute('aBorn', born);
        const key = `${p.key}-${lod}`;
        let material = materials.get(key);
        if (!material) materials.set(key, (material = cropMaterial(key, p.code, p.map)));
        const mesh = new InstancedMesh(geometry, material, capacity);
        // every part of a patch shares its place and tint
        mesh.instanceMatrix = matrices;
        mesh.instanceColor = colors;
        mesh.count = 0;
        mesh.receiveShadow = true;
        mesh.castShadow = false;
        // inland, out of the river's mirror
        mesh.layers.set(LAYER_NO_REFLECT);
        mesh.frustumCulled = false;
        view.add(mesh);
        return mesh;
      });
      return { meshes, matrices, colors, born, capacity, mustard: meshes.filter((_, i) => parts[i].mustard) };
    };
    const set = (view: Group): [Layer, Layer, Layer] => [
      make(view, 0, [
        { geometry: nearRiceShape, key: 'crop-rice-near', code: nearRice(0), map: hill, mustard: false },
        { geometry: mustardShape, key: 'crop-mustard-near', code: nearMustard(0), map: racemes, mustard: true },
      ]),
      make(view, 1, [
        { geometry: headlessRiceShape, key: 'crop-rice-hills', code: nearRice(1), map: hill, mustard: false },
        { geometry: mustardShape, key: 'crop-mustard-near', code: nearMustard(1), map: racemes, mustard: true },
      ]),
      make(view, 2, [
        { geometry: riceTop, key: 'crop-rice-top', code: farRice(2, 0.7), map: riceCanopy, mustard: false },
        { geometry: mustardTop, key: 'crop-mustard-top', code: farMustard(2), map: mustardCanopy, mustard: true },
      ]),
    ];
    this.sets = [set(this.views[0]), set(this.views[1])];
    this.views[1].visible = false;
    this.group.add(...this.views);
  }

  // ---- two views: the film's dissolves draw the shot being left (its crops as they stood) beneath the one coming in ----

  /** Keeps the crops as they stand for the shot being left, and builds the next one's into the other set. */
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


  /**
   * The chunks a view at `view` wants, nearest first, each keyed with every level of detail whose band reaches
   * any of its patches (in a band's fade both stand). Seen from higher up they reach less far.
   */
  private wantedAt(view: Vector3): Want[] {
    const cx = Math.floor(view.x / CHUNK);
    const cz = Math.floor(view.z / CHUNK);
    const lift = Math.max(0, view.y - terrainHeight(view.x, view.z) - 3) * CROP_REACH.lift;
    const R = Math.ceil((CROP_REACH.canopy[1] + CHUNK_REACH) / CHUNK);
    const list: Want[] = [];
    for (let dz = -R; dz <= R; dz++) {
      for (let dx = -R; dx <= R; dx++) {
        const x = (cx + dx + 0.5) * CHUNK;
        const z = (cz + dz + 0.5) * CHUNK;
        const d = Math.hypot(x - view.x, z - view.z, lift);
        // the plants, with their heads near and without beyond SWITCH (one or the other, never both)
        if (d < BANDS[1].out[1] + CHUNK_REACH) list.push({ key: `${cx + dx},${cz + dz},${d < SWITCH ? 0 : 1}`, x, z, d });
        if (d > BANDS[2].in[0] - CHUNK_REACH && d < BANDS[2].out[1] + CHUNK_REACH) list.push({ key: `${cx + dx},${cz + dz},2`, x, z, d });
      }
    }
    return list.sort((a, b) => a.d - b.d);
  }

  /** The same chunk at the other plant level (0 ↔ 1), or null for the canopy. */
  private static twin(key: string): string | null {
    if (key.endsWith(',0')) return `${key.slice(0, -1)}1`;
    if (key.endsWith(',1')) return `${key.slice(0, -1)}0`;
    return null;
  }

  /** Builds the chunks a view at `view` will want, until `until` (performance.now()), without showing them: the film readies its next shot. True once all are built. */
  warm(view: Vector3, until: number): boolean {
    for (const w of this.wantedAt(view)) {
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
    // mustard is drawn only while some plot holds it
    const mustard = G.uCrops.value.w > 0.002;
    for (const layer of this.sets[this.cur]) for (const mesh of layer.mustard) mesh.visible = mustard;
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
        if (ahead && forward && w.d > 12 && (w.x - view.x) * forward.x + (w.z - view.z) * forward.z < 0) continue;
        // a chunk only changing between the plant levels stands at once: its hills are the same
        const twin = Crops.twin(w.key);
        this.cache.set(w.key, this.build(w.key, all || (twin !== null && this.cache.has(twin))));
        this.dirty = true;
      }
    }
    if (this.dirty) this.upload();
  }

  private upload(): void {
    this.dirty = false;
    const at = [0, 0, 0];
    for (const w of this.wanted) {
      // not built yet at this plant level: the other one stands in (the same hills), so no gap shows
      const twin = Crops.twin(w.key);
      const chunk = this.cache.get(w.key) ?? (twin !== null ? this.cache.get(twin) : undefined);
      if (!chunk) continue;
      chunk.used = this.frame;
      const lod = Number(chunk.key.split(',')[2]);
      const layer = this.sets[this.cur][lod];
      const n = Math.min(chunk.n, layer.capacity - at[lod]);
      if (n <= 0) continue;
      (layer.matrices.array as Float32Array).set(chunk.m.subarray(0, n * 16), at[lod] * 16);
      (layer.colors.array as Float32Array).set(chunk.c.subarray(0, n * 3), at[lod] * 3);
      (layer.born.array as Float32Array).fill(chunk.born, at[lod], at[lod] + n);
      at[lod] += n;
    }
    this.sets[this.cur].forEach((layer, lod) => {
      layer.matrices.needsUpdate = true;
      layer.colors.needsUpdate = true;
      layer.born.needsUpdate = true;
      for (const mesh of layer.meshes) mesh.count = at[lod];
    });
    if (this.cache.size > CACHE) {
      const old = [...this.cache.values()].sort((a, b) => a.used - b.used);
      for (const c of old.slice(0, this.cache.size - CACHE)) this.cache.delete(c.key);
    }
  }

  /** The patches whose middles fall in a chunk: each plot filled between its bunds, rows along its length. */
  /** `grown`: built out of sight (or for a still), so it stands at once; else it grows in from now. */
  private build(key: string, grown = false): ChunkData {
    const [cx, cz, lod] = key.split(',').map(Number);
    const x0 = cx * CHUNK;
    const z0 = cz * CHUNK;
    const size = PATCH[lod];
    const rng = new Rng((Math.imul(cx, 73856093) ^ Math.imul(cz, 19349663) ^ (lod * 83492791)) >>> 0);
    const lattice = groundLattice(x0, z0, CHUNK, 2);
    const m: number[] = [];
    const col: number[] = [];
    const mat = new Matrix4();
    const q = new Quaternion();
    const pos = new Vector3();
    const scl = new Vector3();
    {
      // rows along the plots' length, turned as the grid is where the chunk lies (the warp bends it by a few degrees at most)
      const [ax, az] = toPlots(x0 + CHUNK / 2, z0 + CHUNK / 2);
      const [bx, bz] = toPlots(x0 + CHUNK / 2 + 1, z0 + CHUNK / 2);
      q.setFromAxisAngle(UP, Math.atan2(bz - az, bx - ax));
      // the chunk's corners in the plots' frame, and the plots they touch
      const corners = [
        [x0, z0],
        [x0 + CHUNK, z0],
        [x0, z0 + CHUNK],
        [x0 + CHUNK, z0 + CHUNK],
      ].map(([x, z]) => toPlots(x, z));
      const i0 = Math.floor(Math.min(...corners.map((p) => p[0])) / PLOT.w) - 1;
      const i1 = Math.floor(Math.max(...corners.map((p) => p[0])) / PLOT.w) + 1;
      const j0 = Math.floor(Math.min(...corners.map((p) => p[1])) / PLOT.h) - 1;
      const j1 = Math.floor(Math.max(...corners.map((p) => p[1])) / PLOT.h) + 1;
      const nx = Math.max(1, Math.round((PLOT.w - 2 * MARGIN) / size));
      const ny = Math.max(1, Math.round((PLOT.h - 2 * MARGIN) / size));
      const px = (PLOT.w - 2 * MARGIN) / nx;
      const py = (PLOT.h - 2 * MARGIN) / ny;
      for (let i = i0; i <= i1; i++) {
        for (let j = j0; j <= j1; j++) {
          for (let u = 0; u < nx; u++) {
            for (let v = 0; v < ny; v++) {
              const qx = i * PLOT.w + MARGIN + (u + 0.5) * px;
              const qy = j * PLOT.h + MARGIN + (v + 0.5) * py;
              const [x, z] = fromPlots(qx, qy);
              if (x < x0 || x >= x0 + CHUNK || z < z0 || z >= z0 + CHUNK) continue;
              const g = lattice(x, z);
              if (g.zone < ZONE_MIN) continue;
              // no patch reaches over a road or a footpath through the fields (the lattice misses a narrow one)
              if (onRoad(x, z, Math.max(px, py) * 0.6 + 0.2)) continue;
              mat.compose(pos.set(x, g.h - 0.02, z), q, scl.set(px / size, 1, py / size));
              m.push(...mat.elements);
              const tint = rng.range(0.86, 1.08);
              col.push(tint, tint, tint);
            }
          }
        }
      }
    }
    return { key, m: new Float32Array(m), c: new Float32Array(col), n: col.length / 3, used: this.frame, born: grown ? -1e4 : G.uTime.value };
  }
}
