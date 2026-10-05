import { BufferGeometry, DoubleSide, Group, InstancedBufferAttribute, InstancedMesh, Matrix4, MeshStandardMaterial, Quaternion, Vector3 } from 'three';
import type { Texture } from 'three';
import { G, LAYER_NO_REFLECT } from '../core/globals';
import { Rng } from '../core/rng';
import { MeshBuilder, mixRgb, rgb, type RGB } from '../render/builder';
import { CROP_REACH } from '../render/glsl';
import { patchMaterial } from '../render/patch';
import { mustardCanopyTexture, mustardTexture, riceCanopyTexture, riceRowTexture } from '../render/textures';
import { onRoad } from './geography';
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

const CHUNK = 16;
/** Chunks whose middle is nearer than the first are real plants, nearer than the second rows of cards; the rest canopy. */
const LOD_AT = [20, 44] as const;
const BUILD_PER_FRAME = 2;
const CACHE = 160;
/** A patch's side (m), near the camera and farther off. */
const PATCH = [1.2, 2.4, 2.4] as const;
const CAPACITY = [2400, 1800, 4000] as const;
/** Where the plants of a patch stand, as a share of the paddy zone (the terrain's own mask). */
const ZONE_MIN = 0.55;

const UP = new Vector3(0, 1, 0);

// ---- the plants. Colours: the rice's carry only shading in r and g (its shader tints it for its stage) and
// in b whether it is a panicle; uv carries each vertex's offset from the foot of its hill or plant, so the
// shader can spread or gather a plant about its own foot.

/** One leaf blade from (x, z): tapering, arching outward; unit height. */
function blade(b: MeshBuilder, rng: Rng, x: number, z: number, part: number, height: number, width: number, bend: number): void {
  const az = rng.range(0, Math.PI * 2);
  const dir = new Vector3(Math.cos(az), 0, Math.sin(az));
  const side = new Vector3(-dir.z, 0, dir.x);
  const p = new Vector3();
  const n = new Vector3();
  const tangent = new Vector3();
  const segments = 3;
  const start = b.vertexCount;
  for (let s = 0; s < segments; s++) {
    const t = s / (segments - 1);
    p.set(x, 0, z).addScaledVector(dir, bend * height * t * t).addScaledVector(UP, height * t * (1 - 0.35 * bend * t));
    tangent.copy(dir).multiplyScalar(2 * bend * height * t).addScaledVector(UP, height).normalize();
    n.crossVectors(side, tangent).normalize().lerp(UP, 0.5).normalize();
    const shade = 0.45 + 0.55 * t;
    const c: RGB = [shade, shade, part];
    if (s === segments - 1) b.vertex(p, n, p.x - x, p.z - z, c);
    else {
      const half = width * (1 - t * 0.7);
      const l = p.clone().addScaledVector(side, -half);
      const r = p.clone().addScaledVector(side, half);
      b.vertex(l, n, l.x - x, l.z - z, c);
      b.vertex(r, n, r.x - x, r.z - z, c);
    }
  }
  b.quad(start, start + 1, start + 3, start + 2);
  b.tri(start + 2, start + 3, start + 4);
}

/** A ripening panicle nodding over from the top of its tiller (part 1). */
function panicle(b: MeshBuilder, rng: Rng, x: number, z: number): void {
  const az = rng.range(0, Math.PI * 2);
  const dir = new Vector3(Math.cos(az), 0, Math.sin(az));
  const side = new Vector3(-dir.z, 0, dir.x);
  const pts = [new Vector3(0, 0.8, 0), new Vector3(0.05, 0.98, 0), new Vector3(0.15, 0.85, 0)].map((q) =>
    new Vector3(x, q.y, z).addScaledVector(dir, q.x),
  );
  const start = b.vertexCount;
  pts.forEach((q, i) => {
    const w = i === 0 ? 0.004 : 0.016 * (1 - i * 0.25);
    const shade = 0.8 + 0.07 * i;
    const l = q.clone().addScaledVector(side, -w);
    const r = q.clone().addScaledVector(side, w);
    b.vertex(l, UP, l.x - x, l.z - z, [shade, shade, 1]);
    b.vertex(r, UP, r.x - x, r.z - z, [shade, shade, 1]);
  });
  for (let i = 0; i < pts.length - 1; i++) b.quad(start + i * 2, start + i * 2 + 1, start + i * 2 + 3, start + i * 2 + 2);
}

/** A near patch of rice, 1.2 m square: four rows 0.3 m apart along its x, five hills to a row. */
function ricePatch(seed: number): BufferGeometry {
  const rng = new Rng(seed);
  const b = new MeshBuilder();
  const S = PATCH[0];
  for (let row = 0; row < 4; row++) {
    for (let k = 0; k < 5; k++) {
      const hx = ((k + 0.5) / 5 - 0.5) * S + rng.range(-0.03, 0.03);
      const hz = ((row + 0.5) / 4 - 0.5) * S + rng.range(-0.025, 0.025);
      for (let i = 0; i < 4; i++) {
        blade(b, rng, hx + rng.range(-0.015, 0.015), hz + rng.range(-0.015, 0.015), 0, rng.range(0.7, 1.0), rng.range(0.009, 0.013), rng.range(0.2, 0.55));
      }
      panicle(b, rng, hx, hz);
    }
  }
  return b.build();
}

/** A near patch of mustard, 1.2 m square: a dozen plants in flower, leaves low, racemes crowding the tops. */
function mustardPatch(seed: number): BufferGeometry {
  const rng = new Rng(seed);
  const b = new MeshBuilder();
  const S = PATCH[0];
  const stem = rgb('#5d7a3a');
  const leaf = rgb('#4f6e47');
  const flower = rgb('#f2cd27');
  const pod = rgb('#86a046');
  const strip = (from: Vector3, to: Vector3, w: number, c0: RGB, c1: RGB, foot: Vector3) => {
    const d = to.clone().sub(from);
    const side = new Vector3(-d.z, 0, d.x).normalize().multiplyScalar(w);
    if (side.lengthSq() < 1e-8) side.set(w, 0, 0);
    const n = new Vector3().crossVectors(side, d).normalize().lerp(UP, 0.5).normalize();
    const pts = [from.clone().sub(side), from.clone().add(side), to.clone().add(side), to.clone().sub(side)];
    const s = b.vertexCount;
    pts.forEach((p, i) => b.vertex(p, n, p.x - foot.x, p.z - foot.z, i < 2 ? c0 : c1));
    b.quad(s, s + 1, s + 2, s + 3);
  };
  // sown broadcast, not in rows: the plants stand where the seed fell
  for (let i = 0; i < 12; i++) {
    const foot = new Vector3(rng.range(-0.5, 0.5), 0, rng.range(-0.5, 0.5)).multiplyScalar(S * 0.94);
    const h = rng.range(0.85, 1.15);
    const top = foot.clone().add(new Vector3(rng.range(-0.06, 0.06), h, rng.range(-0.06, 0.06)));
    strip(foot, top, 0.007, stem, stem, foot);
    // broad leaves low on the stem, drooping out
    for (let k = 0; k < 3; k++) {
      const a = rng.range(0, Math.PI * 2);
      const at = foot.clone().lerp(top, rng.range(0.05, 0.3));
      const tip = at.clone().add(new Vector3(Math.cos(a) * 0.22, rng.range(0.02, 0.1), Math.sin(a) * 0.22));
      strip(at, tip, 0.045, leaf, mixRgb(leaf, [0.2, 0.3, 0.16], 0.4), foot);
    }
    // branches, each ending in a raceme: two crossed cards of flowers, pods green below them
    const fork = foot.clone().lerp(top, rng.range(0.55, 0.7));
    const tips = [top];
    for (let k = 0; k < 3; k++) {
      const a = rng.range(0, Math.PI * 2);
      const t = top.clone().add(new Vector3(Math.cos(a) * rng.range(0.08, 0.18), rng.range(-0.15, -0.02), Math.sin(a) * rng.range(0.08, 0.18)));
      strip(fork, t, 0.005, stem, stem, foot);
      tips.push(t);
    }
    for (const t of tips) {
      for (const a of [0, Math.PI / 2]) {
        const dx = Math.cos(a + i) * 0.05;
        const dz = Math.sin(a + i) * 0.05;
        const s = b.vertexCount;
        const lo = t.y - 0.08;
        const hi = t.y + 0.06;
        b.vertex(new Vector3(t.x - dx, lo, t.z - dz), UP, t.x - dx - foot.x, t.z - dz - foot.z, pod);
        b.vertex(new Vector3(t.x + dx, lo, t.z + dz), UP, t.x + dx - foot.x, t.z + dz - foot.z, pod);
        b.vertex(new Vector3(t.x + dx * 1.2, hi, t.z + dz * 1.2), UP, t.x + dx * 1.2 - foot.x, t.z + dz * 1.2 - foot.z, flower);
        b.vertex(new Vector3(t.x - dx * 1.2, hi, t.z - dz * 1.2), UP, t.x - dx * 1.2 - foot.x, t.z - dz * 1.2 - foot.z, flower);
        b.quad(s, s + 1, s + 2, s + 3);
      }
    }
  }
  return b.build();
}

/** A middling-far patch of rice, 2.4 m square: four row cards (0.6 m apart along its z, each standing for two rows), unit height. */
function riceRows(): BufferGeometry {
  const b = new MeshBuilder();
  const S = PATCH[1];
  for (let row = 0; row < 4; row++) {
    const z = ((row + 0.5) / 4 - 0.5) * S;
    const n = new Vector3(0, 0.7, row % 2 ? 0.7 : -0.7).normalize();
    const s = b.vertex(new Vector3(-S / 2, 0, z), n, 0, 0);
    b.vertex(new Vector3(S / 2, 0, z), n, 1, 0);
    b.vertex(new Vector3(S / 2, 1, z), n, 1, 1);
    b.vertex(new Vector3(-S / 2, 1, z), n, 0, 1);
    b.quad(s, s + 1, s + 2, s + 3);
  }
  return b.build();
}

/** The crop's canopy seen from above: one quad over a far patch at `height` (unit). */
function canopy(height: number): BufferGeometry {
  const b = new MeshBuilder();
  const h = PATCH[1] / 2;
  const s = b.vertex(new Vector3(-h, height, -h), UP, 0, 0);
  b.vertex(new Vector3(-h, height, h), UP, 0, 1);
  b.vertex(new Vector3(h, height, h), UP, 1, 1);
  b.vertex(new Vector3(h, height, -h), UP, 1, 0);
  b.quad(s, s + 1, s + 2, s + 3);
  return b.build();
}

/** A middling-far patch of mustard: six bushes where the seed fell, each two crossed cards 0.9 m by 1.1 m. */
function mustardCards(seed: number): BufferGeometry {
  const rng = new Rng(seed);
  const b = new MeshBuilder();
  const S = PATCH[1];
  for (let i = 0; i < 6; i++) {
    const x = rng.range(-0.4, 0.4) * S;
    const z = rng.range(-0.4, 0.4) * S;
    const a0 = rng.range(0, Math.PI);
    for (const a of [a0, a0 + Math.PI / 2]) {
      const dx = Math.cos(a) * 0.45;
      const dz = Math.sin(a) * 0.45;
      const h = rng.range(0.95, 1.15);
      const n = new Vector3(-dz, 0.8, dx).normalize();
      const s = b.vertex(new Vector3(x - dx, 0, z - dz), n, 0, 0);
      b.vertex(new Vector3(x + dx, 0, z + dz), n, 1, 0);
      b.vertex(new Vector3(x + dx, h, z + dz), n, 1, 1);
      b.vertex(new Vector3(x - dx, h, z - dz), n, 0, 1);
      b.quad(s, s + 1, s + 2, s + 3);
    }
  }
  return b.build();
}

// ---- the shaders: the plot's crop now, the plant's shape for it, and the wind

/** Which crop the patch's plot holds now (as the terrain paints it), and how far out it is. */
const STAGE = /* glsl */ `
vec3 cropRoot = instanceMatrix[3].xyz;
vec2 cropCell = floor(plotFrame(cropRoot.xz) / PLOT_SIZE);
vec4 cropSh = cropShares(plotRank(cropCell));
float cropStubble = max(0.0, 1.0 - cropSh.x - cropSh.y - cropSh.z - cropSh.w);
float cropGrown = hash12(cropCell + 3.7);
// out at the edge of the crops' reach they sink away (the terrain paints the plot's crop beyond)
float cropFade = 1.0 - smoothstep(${CROP_REACH.fade.toFixed(1)}, ${CROP_REACH.edge.toFixed(1)}, distance(cropRoot.xz, uCamPos.xz));
`;

/** The rice: its height for the stage (seedling, growing, ripe, stubble), and none where the plot is in mustard or under a deep flood. */
const RICE = /* glsl */ `
float cropTall = cropSh.x * 0.28 + cropSh.y * mix(0.55, 0.95, cropGrown) + cropSh.z + cropStubble * 0.17;
float cropWater = waterSurface(cropRoot.xz);
float cropHere = (1.0 - cropSh.w) * cropFade * smoothstep(cropWater - 0.9, cropWater - 0.5, cropRoot.y);
// leaves: the seedlings' fresh yellow-green, deepening as the crop grows, gold as it ripens, straw once reaped
vec3 leafC = (cropSh.x * vec3(0.2, 0.36, 0.07) + cropSh.y * mix(vec3(0.11, 0.25, 0.045), vec3(0.06, 0.15, 0.025), cropGrown)
  + cropSh.z * vec3(0.45, 0.32, 0.07) + cropStubble * vec3(0.32, 0.24, 0.11)) / max(1.0 - cropSh.w, 1e-3);
// heads: from late in the growing into the ripe crop, green turning gold
float heads = cropSh.z + cropSh.y * smoothstep(0.75, 0.95, cropGrown);
vec3 headC = mix(vec3(0.28, 0.36, 0.12), vec3(0.66, 0.48, 0.13), cropSh.z / max(cropSh.y + cropSh.z, 1e-3));
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

const NEAR_RICE = /* glsl */ `
${STAGE}
${RICE}
${gather('cropHere * mix(0.55, 1.0, smoothstep(0.2, 0.7, cropTall))', 'cropTall * cropHere')}
if (color.b > 0.5) transformed.y = mix(-0.05, transformed.y, heads);
vColor.rgb = mix(leafC, headC, color.b) * vColor.g;
cropTall *= cropHere;
${sway(0.1)}
`;

const FAR_RICE = /* glsl */ `
${STAGE}
${RICE}
transformed.y *= cropTall * cropHere;
if (cropHere < 0.01) transformed.y = -0.3;
vColor.rgb = mix(leafC, headC, heads * 0.35) * vColor.g;
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

const NEAR_MUSTARD = /* glsl */ `
${STAGE}
${MUSTARD}
${gather('cropHere', 'cropHere')}
${SCATTER}
cropTall *= cropHere;
${sway(0.14)}
`;

const FAR_MUSTARD = /* glsl */ `
${STAGE}
${MUSTARD}
transformed.y *= cropHere;
if (cropHere < 0.01) transformed.y = -0.3;
${SCATTER}
cropTall *= cropHere;
${sway(0.14)}
`;

function cropMaterial(key: string, code: string, map?: Texture): MeshStandardMaterial {
  const material = new MeshStandardMaterial({ vertexColors: true, side: DoubleSide, roughness: 0.75, map: map ?? null, alphaTest: map ? 0.45 : 0 });
  return patchMaterial(material, { translucency: 1.4, foliage: true, vertex: { key, pars: '', code } });
}

interface Layer {
  meshes: InstancedMesh[];
  matrices: InstancedBufferAttribute;
  colors: InstancedBufferAttribute;
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
}

/** The crops round the camera, rebuilt chunk by chunk as the view moves. */
export class Crops {
  readonly group = new Group();
  private readonly layers: [Layer, Layer, Layer];
  private readonly cache = new Map<string, ChunkData>();
  private wanted: string[] = [];
  private centre = '';
  private dirty = false;
  private frame = 0;

  constructor() {
    this.group.name = 'crops';
    const riceRow = riceRowTexture(13);
    const riceCanopy = riceCanopyTexture(14);
    const mustardCanopy = mustardCanopyTexture(17);
    const riceTop = canopy(0.84);
    const mustardTop = canopy(0.92);
    const make = (lod: 0 | 1 | 2, parts: { geometry: BufferGeometry; key: string; code: string; map?: Texture; mustard: boolean }[]): Layer => {
      const capacity = CAPACITY[lod];
      const matrices = new InstancedBufferAttribute(new Float32Array(capacity * 16), 16);
      const colors = new InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
      const meshes = parts.map((p) => {
        const mesh = new InstancedMesh(p.geometry, cropMaterial(p.key, p.code, p.map), capacity);
        // every part of a patch shares its place and tint
        mesh.instanceMatrix = matrices;
        mesh.instanceColor = colors;
        mesh.count = 0;
        mesh.receiveShadow = true;
        mesh.castShadow = false;
        // inland, out of the river's mirror
        mesh.layers.set(LAYER_NO_REFLECT);
        mesh.frustumCulled = false;
        this.group.add(mesh);
        return mesh;
      });
      return { meshes, matrices, colors, capacity, mustard: meshes.filter((_, i) => parts[i].mustard) };
    };
    this.layers = [
      make(0, [
        { geometry: ricePatch(11), key: 'crop-rice-near', code: NEAR_RICE, mustard: false },
        { geometry: mustardPatch(12), key: 'crop-mustard-near', code: NEAR_MUSTARD, mustard: true },
      ]),
      make(1, [
        { geometry: riceRows(), key: 'crop-rice-rows', code: FAR_RICE, map: riceRow, mustard: false },
        { geometry: riceTop, key: 'crop-rice-top', code: FAR_RICE, map: riceCanopy, mustard: false },
        { geometry: mustardCards(15), key: 'crop-mustard-cards', code: FAR_MUSTARD, map: mustardTexture(16), mustard: true },
        { geometry: mustardTop, key: 'crop-mustard-top', code: FAR_MUSTARD, map: mustardCanopy, mustard: true },
      ]),
      make(2, [
        { geometry: riceTop, key: 'crop-rice-top', code: FAR_RICE, map: riceCanopy, mustard: false },
        { geometry: mustardTop, key: 'crop-mustard-top', code: FAR_MUSTARD, map: mustardCanopy, mustard: true },
      ]),
    ];
  }

  /** Call every frame with the camera's position. `all` builds every missing chunk now (for stills). */
  update(view: Vector3, all = false): void {
    this.frame++;
    // mustard is drawn only while some plot holds it
    const mustard = G.uCrops.value.w > 0.002;
    for (const layer of this.layers) for (const mesh of layer.mustard) mesh.visible = mustard;
    const cx = Math.floor(view.x / CHUNK);
    const cz = Math.floor(view.z / CHUNK);
    const centre = `${cx},${cz}`;
    if (centre !== this.centre) {
      this.centre = centre;
      const reach = CROP_REACH.edge + CHUNK * 0.71;
      const R = Math.ceil(reach / CHUNK);
      const list: { key: string; d: number }[] = [];
      for (let dz = -R; dz <= R; dz++) {
        for (let dx = -R; dx <= R; dx++) {
          const d = Math.hypot((cx + dx + 0.5) * CHUNK - view.x, (cz + dz + 0.5) * CHUNK - view.z);
          if (d < reach) list.push({ key: `${cx + dx},${cz + dz},${d < LOD_AT[0] ? 0 : d < LOD_AT[1] ? 1 : 2}`, d });
        }
      }
      list.sort((a, b) => a.d - b.d);
      this.wanted = list.map((l) => l.key);
      this.dirty = true;
    }
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
    const at = [0, 0, 0];
    for (const key of this.wanted) {
      const chunk = this.cache.get(key);
      if (!chunk) continue;
      chunk.used = this.frame;
      const lod = Number(key.split(',')[2]);
      const layer = this.layers[lod];
      const n = Math.min(chunk.n, layer.capacity - at[lod]);
      if (n <= 0) continue;
      (layer.matrices.array as Float32Array).set(chunk.m.subarray(0, n * 16), at[lod] * 16);
      (layer.colors.array as Float32Array).set(chunk.c.subarray(0, n * 3), at[lod] * 3);
      at[lod] += n;
    }
    this.layers.forEach((layer, lod) => {
      layer.matrices.needsUpdate = true;
      layer.colors.needsUpdate = true;
      for (const mesh of layer.meshes) mesh.count = at[lod];
    });
    if (this.cache.size > CACHE) {
      const old = [...this.cache.values()].sort((a, b) => a.used - b.used);
      for (const c of old.slice(0, this.cache.size - CACHE)) this.cache.delete(c.key);
    }
  }

  /** The patches whose middles fall in a chunk: each plot filled between its bunds, rows along its length. */
  private build(key: string): ChunkData {
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
    return { key, m: new Float32Array(m), c: new Float32Array(col), n: col.length / 3, used: this.frame };
  }
}
