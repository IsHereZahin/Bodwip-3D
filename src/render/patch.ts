import { ShaderChunk } from 'three';
import type { IUniform, Material } from 'three';
import { G } from '../core/globals';
import { GLSL_COMMON } from './glsl';
import type { GroundSet } from './surfaces';

export interface PatchOptions {
  /** Sway in metres at `windHeight` above the object's origin. */
  wind?: number;
  windHeight?: number;
  /** Glow when the key light is behind the surface (leaves, straw, sailcloth). */
  translucency?: number;
  /** World-space albedo noise so repeated surfaces don't look printed. */
  grime?: number;
  /** Paddy plots, wet banks and riverbed caustics, driven by the terrain's `aZone` attribute. */
  terrain?: boolean;
  /** Photo ground layers blended by the terrain's `aSplat` weights (needs `terrain`). */
  splat?: GroundSet;
  /** Keep the vertex normal on back faces, so a cloud of leaf cards shades as one soft volume. */
  foliage?: boolean;
  /** Custom vertex displacement after `begin_vertex`; `key` names it in the program cache. */
  vertex?: { key: string; pars: string; code: string; uniforms?: Record<string, IUniform> };
  /**
   * How the season shows on it: 'leaf' greens up in the rains and dries and pales in the dry months;
   * 'tree' as a leaf, and in spring a share of trees burst into red flower; 'kash' plumes only in autumn.
   */
  seasonal?: 'leaf' | 'tree' | 'kash';
}

/** Metres covered by one repeat of a ground texture. */
const SPLAT_TILE = 2.6;

// same as three's project_vertex, but keeps the world position for the atmosphere and adds wind there
const PROJECT_VERTEX = /* glsl */ `
vec4 mvPosition = vec4(transformed, 1.0);
#ifdef USE_BATCHING
mvPosition = batchingMatrix * mvPosition;
#endif
#ifdef USE_INSTANCING
mvPosition = instanceMatrix * mvPosition;
#endif
vec4 atmW = modelMatrix * mvPosition;
#if defined(ATM_WIND) || defined(ATM_SEASONAL)
vec3 root = vec3(modelMatrix[3]);
#ifdef USE_INSTANCING
root = (modelMatrix * vec4(instanceMatrix[3].xyz, 1.0)).xyz;
#endif
#endif
#ifdef ATM_SEASONAL
vAtmRoot = root;
#endif
#ifdef ATM_WIND
{
  float hk = clamp(position.y / ATM_WIND_H, 0.0, 1.6);
  hk *= hk;
  // the one wind (env/wind.ts): the local strength under the gust fronts rolling downwind. Drag grows
  // with the square of the wind, so a plant leans further the harder it blows, and shivers faster.
  float s = uWind.z * windGust(root.xz);
  float lean = s * (0.5 + 0.5 * s + 0.25 * s * s);
  float flutter = sin(uGust.x * 3.0 + root.x * 0.73 + root.z * 0.41 + position.y * 0.8) * (0.25 + 0.2 * min(s, 2.0));
  vec2 sway = uWind.xy * (lean * 0.45 + flutter * 0.4) + vec2(-uWind.y, uWind.x) * 0.22 * min(s, 2.0) * sin(uGust.x * 2.2 + root.z * 0.3);
  atmW.xz += sway * hk * ATM_WIND;
}
#endif
vAtmWorld = atmW.xyz;
#ifdef ATM_TERRAIN
vZone = aZone;
#endif
#ifdef ATM_SPLAT
vSplat = aSplat;
#endif
mvPosition = viewMatrix * atmW;
gl_Position = projectionMatrix * mvPosition;
`;

// The ground's detail: the two strongest of five photo layers (rarely do more meet), sampled at two
// scales (the larger one rotated, which hides the repeat) and blended by weight and by their own relief,
// so pebbles poke through mud rather than fading into it. The terrain keeps its painted palette and
// borrows each layer's detail relative to that layer's average colour, so from afar the land looks as
// it always did. The layer index is a texture coordinate, so nothing here indexes an array of samples.
const SPLAT_PARS = /* glsl */ `
uniform highp sampler2DArray tGroundC;
uniform highp sampler2DArray tGroundN;
uniform vec3 uGroundMean[5];
varying vec4 vSplat;
void splatTake(float i, float w, inout float i1, inout float a1, inout float i2, inout float a2) {
  if (w > a1) { i2 = i1; a2 = a1; i1 = i; a1 = w; }
  else if (w > a2) { i2 = i; a2 = w; }
}
`;

const SPLAT_COLOR = /* glsl */ `
vec3 splatN = vec3(0.0, 0.0, 1.0);
vec3 splatDetail = vec3(1.0);
#ifdef ATM_SPLAT
{
  // the mirror pass sees the banks only from afar, upside down: it keeps the painted colours
  float near = uReflPass > 0.5 ? 0.0 : 1.0 - smoothstep(60.0, 220.0, length(vAtmWorld - uCamPos));
  if (near > 0.0) {
    vec2 wp = vAtmWorld.xz;
    // pebbles gather in patches along the waterline
    float peb = vSplat.w * smoothstep(-0.95, -0.45, vAtmWorld.y) * smoothstep(0.4, 0.1, vAtmWorld.y)
              * smoothstep(0.3, 0.56, fbm3(wp * 0.16));
    float keep = 1.0 - peb;
    float i1 = 0.0;
    float a1 = vSplat.x * keep;
    float i2 = -1.0;
    float a2 = -1.0;
    splatTake(1.0, vSplat.y * keep, i1, a1, i2, a2);
    splatTake(2.0, max(1.0 - vSplat.x - vSplat.y - vSplat.z, 0.0) * keep, i1, a1, i2, a2);
    splatTake(3.0, vSplat.z * keep, i1, a1, i2, a2);
    splatTake(4.0, peb, i1, a1, i2, a2);

    vec2 uvA = wp / ${SPLAT_TILE.toFixed(2)};
    vec2 uvB = mat2(0.8, -0.6, 0.6, 0.8) * wp / ${(SPLAT_TILE * 3.7).toFixed(2)} + 0.31;
    vec3 m1 = uGroundMean[int(i1)];
    vec3 c1 = texture(tGroundC, vec3(uvA, i1)).rgb / m1;
    c1 *= mix(1.0, dot(texture(tGroundC, vec3(uvB, i1)).rgb / m1, vec3(0.3, 0.59, 0.11)), 0.45);
    vec3 n1 = texture(tGroundN, vec3(uvA, i1)).xyz * 2.0 - 1.0;
    vec3 detail = c1;
    vec3 n = n1;
    if (a2 > 0.03) {
      vec3 m2 = uGroundMean[int(i2)];
      vec3 c2 = texture(tGroundC, vec3(uvA, i2)).rgb / m2;
      c2 *= mix(1.0, dot(texture(tGroundC, vec3(uvB, i2)).rgb / m2, vec3(0.3, 0.59, 0.11)), 0.45);
      float h1 = a1 + dot(c1, vec3(0.3, 0.59, 0.11)) * 0.18;
      float h2 = a2 + dot(c2, vec3(0.3, 0.59, 0.11)) * 0.18;
      float top = max(h1, h2);
      float k1 = max(h1 - top + 0.2, 0.0);
      float k2 = max(h2 - top + 0.2, 0.0);
      float k = k2 / (k1 + k2);
      detail = mix(c1, c2, k);
      n = mix(n1, texture(tGroundN, vec3(uvA, i2)).xyz * 2.0 - 1.0, k);
    }
    splatDetail = mix(vec3(1.0), clamp(detail, 0.25, 2.4), near * 0.85);
    splatN = normalize(mix(vec3(0.0, 0.0, 1.0), normalize(n), near));
  }
}
#endif
`;

const COLOR_EXTRA = /* glsl */ `
float atmWet = 0.0;
// how much of the ground is open water that mirrors the sky (brine in the salt pans, flooded plots)
float atmBrine = 0.0;
#ifdef ATM_SEASONAL
{
  // the season in the leaves: lush in the rains, dusty and paler in the dry months
  diffuseColor.rgb *= mix(vec3(1.0), vec3(1.2, 1.06, 0.7), uSeasonA.y * 0.6) * (0.86 + 0.16 * uSeasonA.x);
  #if ATM_SEASONAL == 2
  // spring: a share of the trees (shimul, palash, krishnachura) aflame with red flowers
  if (hash12(floor(vAtmRoot.xz * 0.37) + 3.1) < uSeasonA.z) {
    float spot = vnoise(vAtmWorld.xz * 2.3 + vAtmWorld.y * 1.7);
    float crown = smoothstep(1.2, 3.0, vAtmWorld.y - vAtmRoot.y);
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.62, 0.06, 0.02) * (0.7 + 0.5 * spot), smoothstep(0.35, 0.6, spot) * crown);
  }
  #endif
  #if ATM_SEASONAL == 3
  // kash plumes only from late in the rains through autumn; out of season the white heads are not there
  float lum = dot(diffuseColor.rgb, vec3(0.3, 0.59, 0.11));
  float sat = max(diffuseColor.r, max(diffuseColor.g, diffuseColor.b)) - min(diffuseColor.r, min(diffuseColor.g, diffuseColor.b));
  float plume = smoothstep(0.35, 0.6, lum) * (1.0 - smoothstep(0.08, 0.2, sat));
  diffuseColor.a *= 1.0 - plume * (1.0 - uSeasonA.w);
  #endif
}
#endif
#ifdef ATM_GRIME
diffuseColor.rgb *= 1.0 + ATM_GRIME * ((fbm3(vAtmWorld.xz * 0.35 + vAtmWorld.y * 0.25) - 0.5) * 1.3 + (vnoise(vAtmWorld.xz * 3.1 + vAtmWorld.y * 2.0) - 0.5) * 0.45);
#endif
#ifndef ATM_TERRAIN
// after rain everything is darker and glistens
atmWet = uWet * 0.4;
diffuseColor.rgb *= mix(1.0, 0.8, atmWet);
#endif
#ifdef ATM_TERRAIN
${SPLAT_COLOR}
{
  vec2 wp = vAtmWorld.xz;
  diffuseColor.rgb *= 0.8 + 0.4 * fbm3(wp * 0.07);
  #ifndef ATM_SPLAT
  diffuseColor.rgb *= 1.0 + 0.16 * (vnoise(wp * 0.9) - 0.5);
  #endif
  // the season on open ground: grass greener and soil darker in the rains, straw-pale and dusty when dry
  {
    float greenish = clamp((diffuseColor.g - diffuseColor.r) * 9.0, 0.0, 1.0);
    diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(1.3, 1.08, 0.66), greenish * uSeasonA.y * 0.65);
    diffuseColor.rgb *= mix(1.0, 0.86 + 0.14 * uSeasonA.x, greenish);
    diffuseColor.rgb *= mix(1.0, 0.8, uSeasonB.z * (1.0 - greenish));
  }
  // paddy: rectangular plots with raised bunds (ail). Each plot keeps its place in the order the season
  // plants and reaps them (env/season.ts): seedlings standing in water, green rice, ripe gold, mustard in
  // flower in the winter, or stubble after the harvest
  float plotWater = 0.0;
  if (vZone > 0.01) {
    float ang = 0.3 + 0.35 * sin(floor(wp.y / 240.0) * 1.7);
    vec2 q = mat2(cos(ang), -sin(ang), sin(ang), cos(ang)) * wp;
    vec2 size = vec2(36.0, 22.0);
    vec2 cell = floor(q / size);
    vec2 f = fract(q / size);
    float r = hash12(cell);
    float c1 = uCrops.x;
    float c2 = c1 + uCrops.y;
    float c3 = c2 + uCrops.z;
    float c4 = c3 + uCrops.w;
    vec3 fc = r < c1 ? vec3(0.085, 0.165, 0.03)
            : r < c2 ? mix(vec3(0.060, 0.120, 0.018), vec3(0.110, 0.190, 0.030), hash12(cell + 3.7))
            : r < c3 ? vec3(0.300, 0.200, 0.045)
            : r < c4 ? vec3(0.46, 0.36, 0.02)
            : vec3(0.170, 0.125, 0.065);
    fc *= 0.82 + 0.36 * vnoise(q * 0.3 + r * 50.0);
    vec2 e = min(f, 1.0 - f) * size;
    float bund = 1.0 - smoothstep(0.25, 0.8, min(e.x, e.y));
    // water standing in the plots: under the seedlings always, in others as the season has it
    plotWater = (1.0 - bund) * vZone * max(r < c1 ? 1.0 : 0.0, step(hash12(cell + 7.1), uSeasonB.y) * step(c3, r));
    fc = mix(fc, fc * 0.45, plotWater * 0.6);
    fc = mix(fc, vec3(0.13, 0.11, 0.065), bund);
    diffuseColor.rgb = mix(diffuseColor.rgb, fc, vZone);
    atmBrine = plotWater * 0.5;
  }
  // salt pans (লবণ মাঠ) on the coastal flats: blocks of small pans behind low clay bunds, a brine channel
  // round each block, some blocks lying fallow. In the dry months (uSeasonB.w) a pan at work holds brine
  // over its clay floor, or brine on black plastic sheeting, or has dried to a white crust of salt ready
  // to rake; in the rains, and in the pans not at work, the water stands brackish and still. The layout
  // has a twin in world/coast.ts (the heaps sit on these bunds): keep the two in step
  float panW = 0.0;
  if (vZone < -0.01) {
    float ang = 0.12 + 0.2 * sin(floor(wp.y / 300.0) * 2.3);
    vec2 q = mat2(cos(ang), -sin(ang), sin(ang), cos(ang)) * wp;
    vec2 blockSize = vec2(96.0, 60.0);
    vec2 block = floor(q / blockSize);
    vec2 bq = q - block * blockSize;
    float fallow = step(0.55, sin(block.x * 3.1 + block.y * 1.3 + 0.7));
    vec2 size = vec2(16.0, 10.0) * (0.8 + 0.4 * (0.5 + 0.5 * sin(block.x * 1.7 + block.y * 2.9)));
    vec2 cell = floor(bq / size);
    vec2 f = fract(bq / size);
    vec2 e = min(f, 1.0 - f) * size;
    // the channel round the block, and the pans that do not fit whole at its far edges
    vec2 eb = min(bq, blockSize - bq);
    float channel = 1.0 - smoothstep(1.2, 1.8, min(eb.x, eb.y));
    float whole = step(bq.x, floor(blockSize.x / size.x) * size.x) * step(bq.y, floor(blockSize.y / size.y) * size.y);
    panW = -vZone * (1.0 - fallow) * whole * (1.0 - channel);
    cell += block * 31.0;
    float bund = 1.0 - smoothstep(0.3, 0.9, min(e.x, e.y));
    float working = step(hash12(cell + 19.3), uSeasonB.w);
    float stage = hash12(cell + 4.1);
    vec3 crust = vec3(0.82, 0.81, 0.78) * (0.9 + 0.14 * vnoise(q * 2.3 + stage * 30.0));
    vec3 pc = stage < 0.35 ? vec3(0.27, 0.25, 0.21) : stage < 0.7 ? vec3(0.02, 0.02, 0.024) : crust;
    float wetPan = mix(1.0, stage < 0.7 ? 1.0 : 0.0, working);
    pc = mix(vec3(0.17, 0.16, 0.12), pc, working);
    pc = mix(pc, vec3(0.22, 0.19, 0.15), bund);
    diffuseColor.rgb = mix(diffuseColor.rgb, pc, panW);
    float brine = (1.0 - bund) * panW * wetPan;
    // the channels run with brine whatever the season
    float run = channel * -vZone * (1.0 - fallow * 0.6);
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.14, 0.13, 0.1), run);
    brine = max(brine, run);
    plotWater = max(plotWater, brine);
    atmBrine = max(atmBrine, brine * 0.8);
  }
  // the photo layers' grain, less of it on the smooth pans
  diffuseColor.rgb *= mix(splatDetail, vec3(1.0), panW * 0.7);
  // the bank darkens and shines where the river has just wet it, the plots where water stands, and
  // everything after rain
  atmWet = max(max(smoothstep(uWaterLevel + 0.6, uWaterLevel + 0.05, vAtmWorld.y), plotWater * 0.85), uWet * 0.55);
  diffuseColor.rgb *= mix(1.0, 0.55, atmWet);
}
#endif
`;

// the ground's relief: the blended tangent-space normal, projected from above (the banks are gentle)
const SPLAT_NORMAL = /* glsl */ `
#ifdef ATM_SPLAT
{
  vec3 nGeo = inverseTransformDirection(normal, viewMatrix);
  vec3 tU = normalize(vec3(1.0, 0.0, 0.0) - nGeo * nGeo.x);
  vec3 tV = cross(tU, nGeo);
  vec3 nW = normalize(tU * splatN.x + tV * splatN.y + nGeo * splatN.z);
  normal = normalize((viewMatrix * vec4(nW, 0.0)).xyz);
}
#endif
`;

const TRANSLUCENCY = /* glsl */ `
#ifdef ATM_TRANSL
{
  vec3 vdir = normalize(vAtmWorld - uCamPos);
  float back = pow(max(dot(vdir, uKeyDir), 0.0), 4.0);
  outgoingLight += diffuseColor.rgb * uKeyColor * (back * 0.85 + 0.06) * ATM_TRANSL * 0.3;
}
#endif
#ifdef ATM_TERRAIN
// still water standing on the ground (brine in the pans, flooded plots) mirrors the sky, more so at a grazing look
if (atmBrine > 0.01 && uReflPass < 0.5) {
  vec3 toEye = normalize(uCamPos - vAtmWorld);
  float fres = 0.02 + 0.98 * pow(1.0 - max(toEye.y, 0.0), 5.0);
  outgoingLight = mix(outgoingLight, hazeColor(reflect(-toEye, vec3(0.0, 1.0, 0.0))), clamp(fres * 0.9 + 0.08, 0.0, 1.0) * atmBrine);
}
// sunlight focused by the ripples into a moving net of caustics on the shallow bed
if (vAtmWorld.y < uWaterLevel - 0.02 && uReflPass < 0.5) {
  vec2 q = vAtmWorld.xz * 0.85;
  float a = vnoise(q + vec2(uTime * 0.31, uTime * 0.17));
  float b = vnoise(q * 1.41 + vec2(-uTime * 0.23, uTime * 0.29) + 4.7);
  float caustic = pow(clamp(1.0 - abs(a - b) * 3.2, 0.0, 1.0), 5.0);
  outgoingLight += diffuseColor.rgb * uKeyColor * max(uKeyDir.y, 0.0) * caustic * smoothstep(uWaterLevel - 2.2, uWaterLevel - 0.08, vAtmWorld.y) * 1.6;
}
#endif
`;

const FOLIAGE_NORMAL = ShaderChunk.normal_fragment_begin.replace('normal *= faceDirection;', '');

/** Adds shared atmosphere (and optional wind, grime, translucency, ground layers) to a built-in material. */
export function patchMaterial<T extends Material>(material: T, options: PatchOptions = {}): T {
  const defines: Record<string, string> = {};
  if (options.wind) {
    defines.ATM_WIND = options.wind.toFixed(3);
    defines.ATM_WIND_H = (options.windHeight ?? 2).toFixed(3);
  }
  if (options.translucency) defines.ATM_TRANSL = options.translucency.toFixed(3);
  if (options.grime) defines.ATM_GRIME = options.grime.toFixed(3);
  if (options.terrain) defines.ATM_TERRAIN = '';
  if (options.terrain && options.splat) defines.ATM_SPLAT = '';
  if (options.seasonal) defines.ATM_SEASONAL = options.seasonal === 'leaf' ? '1' : options.seasonal === 'tree' ? '2' : '3';
  material.defines = { ...(material.defines ?? {}), ...defines };

  const key = `atm|${JSON.stringify(defines)}|${options.foliage ? 'f' : ''}|${options.vertex?.key ?? ''}`;
  material.customProgramCacheKey = () => key;

  const splat = options.terrain ? options.splat : undefined;
  const splatUniforms = splat
    ? { tGroundC: { value: splat.color }, tGroundN: { value: splat.normal }, uGroundMean: { value: splat.means } }
    : {};

  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, G, options.vertex?.uniforms ?? {}, splatUniforms);
    const terrainPars = options.terrain ? 'attribute float aZone;\nvarying float vZone;\n' : '';
    const splatVertPars = splat ? 'attribute vec4 aSplat;\nvarying vec4 vSplat;\n' : '';
    shader.vertexShader =
      GLSL_COMMON +
      'varying vec3 vAtmWorld;\n' +
      (options.seasonal ? 'varying vec3 vAtmRoot;\n' : '') +
      terrainPars +
      splatVertPars +
      (options.vertex?.pars ?? '') +
      shader.vertexShader
        .replace('#include <begin_vertex>', `#include <begin_vertex>\n${options.vertex?.code ?? ''}`)
        .replace('#include <project_vertex>', PROJECT_VERTEX);

    let frag = shader.fragmentShader
      .replace('#include <color_fragment>', `#include <color_fragment>\n${COLOR_EXTRA}`)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 0.4, atmWet);')
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>\n${SPLAT_NORMAL}`)
      .replace('#include <opaque_fragment>', `${TRANSLUCENCY}\n#include <opaque_fragment>`)
      .replace('#include <fog_fragment>', 'gl_FragColor.rgb = applyAtmosphere(underwater(gl_FragColor.rgb, vAtmWorld), vAtmWorld);');
    if (options.foliage) frag = frag.replace('#include <normal_fragment_begin>', FOLIAGE_NORMAL);
    const splatFragPars = splat ? SPLAT_PARS : '';
    shader.fragmentShader =
      GLSL_COMMON +
      'varying vec3 vAtmWorld;\n' +
      (options.seasonal ? 'varying vec3 vAtmRoot;\n' : '') +
      (options.terrain ? 'varying float vZone;\n' : '') +
      splatFragPars +
      frag;
  };
  return material;
}
