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
#ifdef ATM_WIND
{
  vec3 root = vec3(modelMatrix[3]);
  #ifdef USE_INSTANCING
  root = (modelMatrix * vec4(instanceMatrix[3].xyz, 1.0)).xyz;
  #endif
  float hk = clamp(position.y / ATM_WIND_H, 0.0, 1.6);
  hk *= hk;
  // one shared wind field: slow gust fronts travelling downwind, plus each plant's own flutter
  float gust = 0.55 + 0.45 * sin(dot(root.xz, uWind.xy) * 0.045 - uTime * 0.8);
  float flutter = sin(uTime * 2.1 + root.x * 0.73 + root.z * 0.41 + position.y * 0.8);
  vec2 sway = uWind.xy * (gust * 0.75 + flutter * 0.3) + vec2(-uWind.y, uWind.x) * 0.22 * sin(uTime * 1.6 + root.z * 0.3);
  atmW.xz += sway * hk * ATM_WIND * uWind.z;
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
#ifdef ATM_GRIME
diffuseColor.rgb *= 1.0 + ATM_GRIME * ((fbm3(vAtmWorld.xz * 0.35 + vAtmWorld.y * 0.25) - 0.5) * 1.3 + (vnoise(vAtmWorld.xz * 3.1 + vAtmWorld.y * 2.0) - 0.5) * 0.45);
#endif
#ifdef ATM_TERRAIN
${SPLAT_COLOR}
{
  vec2 wp = vAtmWorld.xz;
  diffuseColor.rgb *= 0.8 + 0.4 * fbm3(wp * 0.07);
  #ifndef ATM_SPLAT
  diffuseColor.rgb *= 1.0 + 0.16 * (vnoise(wp * 0.9) - 0.5);
  #endif
  // paddy: rectangular plots with raised bunds (ail), each plot at its own stage of growth
  if (vZone > 0.01) {
    float ang = 0.3 + 0.35 * sin(floor(wp.y / 240.0) * 1.7);
    vec2 q = mat2(cos(ang), -sin(ang), sin(ang), cos(ang)) * wp;
    vec2 size = vec2(36.0, 22.0);
    vec2 cell = floor(q / size);
    vec2 f = fract(q / size);
    float r = hash12(cell);
    vec3 fc = r < 0.28 ? vec3(0.060, 0.120, 0.018)
            : r < 0.62 ? vec3(0.300, 0.200, 0.045)
            : r < 0.84 ? vec3(0.110, 0.190, 0.030)
            : vec3(0.170, 0.125, 0.065);
    fc *= 0.82 + 0.36 * vnoise(q * 0.3 + r * 50.0);
    vec2 e = min(f, 1.0 - f) * size;
    float bund = 1.0 - smoothstep(0.25, 0.8, min(e.x, e.y));
    fc = mix(fc, vec3(0.13, 0.11, 0.065), bund);
    diffuseColor.rgb = mix(diffuseColor.rgb, fc, vZone);
  }
  diffuseColor.rgb *= splatDetail;
  // the bank darkens and shines where the river has just wet it
  atmWet = smoothstep(0.6, 0.05, vAtmWorld.y);
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
// sunlight focused by the ripples into a moving net of caustics on the shallow bed
if (vAtmWorld.y < -0.02 && uReflPass < 0.5) {
  vec2 q = vAtmWorld.xz * 0.85;
  float a = vnoise(q + vec2(uTime * 0.31, uTime * 0.17));
  float b = vnoise(q * 1.41 + vec2(-uTime * 0.23, uTime * 0.29) + 4.7);
  float caustic = pow(clamp(1.0 - abs(a - b) * 3.2, 0.0, 1.0), 5.0);
  outgoingLight += diffuseColor.rgb * uKeyColor * max(uKeyDir.y, 0.0) * caustic * smoothstep(-2.2, -0.08, vAtmWorld.y) * 1.6;
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
      GLSL_COMMON + 'varying vec3 vAtmWorld;\n' + (options.terrain ? 'varying float vZone;\n' : '') + splatFragPars + frag;
  };
  return material;
}
