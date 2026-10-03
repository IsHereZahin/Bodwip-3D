import { ShaderChunk } from 'three';
import type { IUniform, Material } from 'three';
import { G } from '../core/globals';
import { GLSL_COMMON } from './glsl';

export interface PatchOptions {
  /** Sway in metres at `windHeight` above the object's origin. */
  wind?: number;
  windHeight?: number;
  /** Glow when the key light is behind the surface (leaves, straw, sailcloth). */
  translucency?: number;
  /** World-space albedo noise so repeated surfaces don't look printed. */
  grime?: number;
  /** Paddy plots and wet banks, driven by the terrain's `aZone` attribute. */
  terrain?: boolean;
  /** Keep the vertex normal on back faces, so a cloud of leaf cards shades as one soft volume. */
  foliage?: boolean;
  /** Custom vertex displacement after `begin_vertex`; `key` names it in the program cache. */
  vertex?: { key: string; pars: string; code: string; uniforms?: Record<string, IUniform> };
}

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
mvPosition = viewMatrix * atmW;
gl_Position = projectionMatrix * mvPosition;
`;

const COLOR_EXTRA = /* glsl */ `
float atmWet = 0.0;
#ifdef ATM_GRIME
diffuseColor.rgb *= 1.0 + ATM_GRIME * ((fbm3(vAtmWorld.xz * 0.35 + vAtmWorld.y * 0.25) - 0.5) * 1.3 + (vnoise(vAtmWorld.xz * 3.1 + vAtmWorld.y * 2.0) - 0.5) * 0.45);
#endif
#ifdef ATM_TERRAIN
{
  vec2 wp = vAtmWorld.xz;
  diffuseColor.rgb *= 0.8 + 0.4 * fbm3(wp * 0.07) + 0.16 * (vnoise(wp * 0.9) - 0.5);
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
  // the bank darkens and shines where the river has just wet it
  atmWet = smoothstep(0.6, 0.05, vAtmWorld.y);
  diffuseColor.rgb *= mix(1.0, 0.55, atmWet);
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
`;

const FOLIAGE_NORMAL = ShaderChunk.normal_fragment_begin.replace('normal *= faceDirection;', '');

/** Adds shared atmosphere (and optional wind, grime, translucency) to a built-in material. */
export function patchMaterial<T extends Material>(material: T, options: PatchOptions = {}): T {
  const defines: Record<string, string> = {};
  if (options.wind) {
    defines.ATM_WIND = options.wind.toFixed(3);
    defines.ATM_WIND_H = (options.windHeight ?? 2).toFixed(3);
  }
  if (options.translucency) defines.ATM_TRANSL = options.translucency.toFixed(3);
  if (options.grime) defines.ATM_GRIME = options.grime.toFixed(3);
  if (options.terrain) defines.ATM_TERRAIN = '';
  material.defines = { ...(material.defines ?? {}), ...defines };

  const key = `atm|${JSON.stringify(defines)}|${options.foliage ? 'f' : ''}|${options.vertex?.key ?? ''}`;
  material.customProgramCacheKey = () => key;

  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, G, options.vertex?.uniforms ?? {});
    const terrainPars = options.terrain ? 'attribute float aZone;\nvarying float vZone;\n' : '';
    shader.vertexShader =
      GLSL_COMMON +
      'varying vec3 vAtmWorld;\n' +
      terrainPars +
      (options.vertex?.pars ?? '') +
      shader.vertexShader
        .replace('#include <begin_vertex>', `#include <begin_vertex>\n${options.vertex?.code ?? ''}`)
        .replace('#include <project_vertex>', PROJECT_VERTEX);

    let frag = shader.fragmentShader
      .replace('#include <color_fragment>', `#include <color_fragment>\n${COLOR_EXTRA}`)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 0.3, atmWet);')
      .replace('#include <opaque_fragment>', `${TRANSLUCENCY}\n#include <opaque_fragment>`)
      .replace('#include <fog_fragment>', 'gl_FragColor.rgb = applyAtmosphere(gl_FragColor.rgb, vAtmWorld);');
    if (options.foliage) frag = frag.replace('#include <normal_fragment_begin>', FOLIAGE_NORMAL);
    shader.fragmentShader =
      GLSL_COMMON + 'varying vec3 vAtmWorld;\n' + (options.terrain ? 'varying float vZone;\n' : '') + frag;
  };
  return material;
}
