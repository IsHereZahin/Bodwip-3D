import { ShaderChunk } from 'three';
import type { IUniform, Material } from 'three';
import { G } from '../core/globals';
import { CROP_REACH, GLSL_COMMON } from './glsl';
import type { GroundSet } from './surfaces';

export interface PatchOptions {
  /** Sway in metres at `windHeight` above the object's origin. */
  wind?: number;
  windHeight?: number;
  /** Glow when the key light is behind the surface (leaves, straw, sailcloth). */
  translucency?: number;
  /** Skin: the key light carried a little way under it past the terminator, reddened by the blood in it. */
  skin?: number;
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
  #if ATM_SEASONAL == 3
  // kash plumes only from late in the rains through autumn; out of season the white heads are not there.
  // The plume is the only bright part of the kash's texture (its stem is a dark olive), told by the texel's
  // brightness before the dry months' tint below (a warm white is too saturated to tell it by its colour)
  float lum = dot(diffuseColor.rgb, vec3(0.3, 0.59, 0.11));
  float plume = smoothstep(0.32, 0.5, lum);
  diffuseColor.a *= 1.0 - plume * (1.0 - uSeasonA.w);
  #endif
  // the season in the leaves: lush in the rains, dusty and paler in the dry months
  diffuseColor.rgb *= mix(vec3(1.0), vec3(1.2, 1.06, 0.7), uSeasonA.y * 0.6) * (0.86 + 0.16 * uSeasonA.x);
  #if ATM_SEASONAL == 2
  // spring: a share of the trees (shimul, palash, krishnachura) aflame with red flowers
  // each tree comes into flower (and goes over) gradually as the season passes its turn
  float bloom = smoothstep(-0.05, 0.05, uSeasonA.z - hash12(floor(vAtmRoot.xz * 0.37) + 3.1));
  if (bloom > 0.0) {
    float spot = vnoise(vAtmWorld.xz * 2.3 + vAtmWorld.y * 1.7);
    float crown = smoothstep(1.2, 3.0, vAtmWorld.y - vAtmRoot.y);
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.62, 0.06, 0.02) * (0.7 + 0.5 * spot), smoothstep(0.35, 0.6, spot) * crown * bloom);
  }
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
  // plants and reaps them (env/season.ts, cropShares in glsl.ts): seedlings standing in water, green rice,
  // ripe gold, mustard in flower in the winter, or stubble after the harvest
  float plotWater = 0.0;
  if (vZone > 0.01) {
    vec2 q = plotFrame(wp);
    vec2 cell = floor(q / PLOT_SIZE);
    vec2 f = fract(q / PLOT_SIZE);
    float rank = plotRank(cell);
    vec4 sh = cropShares(rank);
    float stubble = max(0.0, 1.0 - sh.x - sh.y - sh.z - sh.w);
    float grown = hash12(cell + 3.7);
    // from afar, the crop's own colour: seedlings bright over their water, rice deeper green as it grows,
    // ripe gold, the vivid yellow of mustard in flower, the straw-brown of stubble; in clumps and in the
    // lines it was planted in, the mustard's flowers in drifts
    vec3 canopy = sh.x * vec3(0.10, 0.20, 0.035) + sh.y * mix(vec3(0.085, 0.19, 0.03), vec3(0.05, 0.12, 0.018), grown)
      + sh.z * vec3(0.42, 0.28, 0.05) + sh.w * vec3(0.66, 0.47, 0.012) + stubble * vec3(0.19, 0.14, 0.07);
    canopy *= 0.84 + 0.32 * vnoise(q * vec2(0.45, 1.6) + grown * 40.0);
    canopy *= 0.9 + 0.2 * vnoise(q * 0.12 + grown * 13.0);
    // close by, the crops stand in 3D (world/crops.ts) and the plot shows its own ground under them: water
    // among the young and growing rice, damp soil under the ripe, dry earth under mustard and stubble (not
    // in the mirror, which draws no crops)
    float under = (1.0 - smoothstep(${CROP_REACH.fade.toFixed(1)}, ${CROP_REACH.edge.toFixed(1)}, distance(wp, uCamPos.xz))) * smoothstep(0.45, 0.65, vZone) * (1.0 - uReflPass);
    vec3 ground = mix(vec3(0.085, 0.07, 0.042), vec3(0.15, 0.115, 0.07), sh.w + stubble);
    vec3 fc = mix(canopy, ground, under);
    vec2 e = min(f, 1.0 - f) * PLOT_SIZE;
    float bund = 1.0 - smoothstep(0.25, 0.8, min(e.x, e.y));
    // water standing in the plots: under the seedlings always, among the growing rice, and in the fallow
    // plots as the season has it
    float flooded = smoothstep(-0.035, 0.035, uSeasonB.y - fract(rank * 3.7 + 0.21)) * (sh.w + stubble);
    plotWater = (1.0 - bund) * vZone * max(max(sh.x, sh.y * under * 0.9), flooded);
    fc = mix(fc, fc * 0.45, plotWater * 0.6);
    fc = mix(fc, vec3(0.13, 0.11, 0.065), bund);
    diffuseColor.rgb = mix(diffuseColor.rgb, fc, vZone);
    atmBrine = plotWater * 0.5;
  }
  // the salt works (লবণ মাঠ) on the coastal flats, block by block behind a feeder channel of sea water and
  // an earth bund (the bunds stand in 3D, world/coast.ts, whose twin of this layout must stay in step).
  // Most blocks are salt farms (khola): a settling pond where the sea water comes in; evaporation beds with
  // mud floors where the brine thickens in the sun, some strong enough to rime their edges white; then the
  // small crystallizer beds lined with black plastic, each at its stage: a film of brine mirroring the sky,
  // crust forming in it, a white sheet of salt ready to rake, or just raked (the heaps stand on the bunds).
  // Others are brackish shrimp ponds (gher), or barren mudflat, cracked and bloomed white with salt. In the
  // rains (uSeasonB.w) the farms lie flooded, the plastic taken up.
  float panW = 0.0;
  if (vZone < -0.01) {
    float salt = -vZone;
    float ang = 0.12 + 0.2 * sin(floor(wp.y / 300.0) * 2.3);
    vec2 q = mat2(cos(ang), -sin(ang), sin(ang), cos(ang)) * wp;
    const vec2 blockSize = vec2(96.0, 60.0);
    vec2 block = floor(q / blockSize);
    vec2 bq = q - block * blockSize;
    float kind = sin(block.x * 3.1 + block.y * 1.3 + 0.7);
    vec2 eb = min(bq, blockSize - bq);
    float edge = min(eb.x, eb.y);
    float channel = 1.0 - smoothstep(1.2, 1.6, edge);
    float rim = (1.0 - smoothstep(2.0, 2.6, edge)) * (1.0 - channel);
    float working = smoothstep(-0.05, 0.05, uSeasonB.w - (0.5 + 0.45 * sin(block.x * 1.7 + block.y * 2.9 + 1.3)));
    vec3 clay = vec3(0.24, 0.21, 0.17) * (0.9 + 0.2 * vnoise(q * 1.7));
    vec3 brackish = vec3(0.1, 0.1, 0.075);
    vec3 pc = brackish;
    float water = 1.0;
    float bund = rim;
    if (kind > 0.6) {
      // barren mudflat: cracked grey clay, white where the salt blooms, a few dull halophytes
      float crack = smoothstep(0.035, 0.0, abs(vnoise(q * 0.9) - 0.5)) + smoothstep(0.03, 0.0, abs(vnoise(q * 2.3 + 7.0) - 0.5)) * 0.6;
      pc = vec3(0.23, 0.205, 0.165) * (0.85 + 0.25 * vnoise(q * 0.4));
      pc = mix(pc, vec3(0.55, 0.54, 0.5), smoothstep(0.62, 0.8, fbm3(q * 0.18)) * 0.8);
      pc = mix(pc, vec3(0.13, 0.14, 0.09), smoothstep(0.7, 0.85, vnoise(q * 0.6 + 3.0)) * 0.7);
      pc *= 1.0 - crack * 0.35;
      water = 0.0;
      bund = 0.0;
    } else if (kind < -0.75) {
      // a shrimp pond: brackish water behind its bund
      pc = vec3(0.08, 0.1, 0.07);
    } else {
      float u = bq.x / blockSize.x;
      vec2 lq = bq;
      vec2 size = blockSize;
      if (u >= 0.5) {
        lq.x -= blockSize.x * 0.5;
        size = vec2(8.0, 5.0);
      } else if (u >= 0.22) {
        lq.x -= blockSize.x * 0.22;
        size = vec2(8.96, 10.0);
      }
      vec2 cell = floor(lq / size);
      vec2 e = min(fract(lq / size), 1.0 - fract(lq / size)) * size;
      float inner = 1.0 - smoothstep(0.3, 0.7, min(e.x, e.y));
      // the section's own cells only where they fit whole, the rest of the strip is bund
      bund = max(rim, u >= 0.22 ? inner : 0.0);
      float stage = hash12(cell + block * 31.0 + 4.1);
      vec3 work;
      float wet;
      if (u < 0.22) {
        // the settling pond
        work = vec3(0.11, 0.115, 0.085);
        wet = 1.0;
      } else if (u < 0.5) {
        // evaporation beds: brine over mud, browner where it is new, greyer and greener as it thickens, a
        // few drying out with salt riming their floors
        work = mix(vec3(0.16, 0.145, 0.105), vec3(0.15, 0.165, 0.135), stage);
        wet = 1.0;
        if (stage > 0.82) {
          work = mix(vec3(0.3, 0.28, 0.24), vec3(0.6, 0.59, 0.55), smoothstep(0.5, 0.8, vnoise(q * 1.3 + stage * 20.0)));
          wet = 0.2;
        }
      } else {
        // crystallizers on black plastic
        vec3 sheet = vec3(0.016, 0.017, 0.02);
        vec3 crust = vec3(0.8, 0.79, 0.76) * (0.9 + 0.14 * vnoise(q * 2.3 + stage * 30.0));
        if (stage < 0.3) {
          work = sheet;
          wet = 1.0;
        } else if (stage < 0.55) {
          float forming = smoothstep(0.45, 0.7, fbm3(q * 0.9 + stage * 40.0) + (stage - 0.42) * 1.4);
          work = mix(sheet, crust * 0.85, forming);
          wet = 1.0 - forming * 0.6;
        } else if (stage < 0.85) {
          work = crust;
          wet = 0.1;
        } else {
          // raked: drag lines left in a thin crust across the black
          float lines = smoothstep(0.55, 0.85, sin(lq.y * 9.0 + vnoise(q * 1.5) * 3.0));
          work = mix(sheet, crust * 0.7, lines * 0.5);
          wet = 0.4;
        }
        panW = 1.0;
      }
      pc = mix(brackish, work, working);
      water = mix(1.0, wet, working);
    }
    // the bunds: grey clay, rimed white with salt where the brine laps them while the farm works
    vec3 bundC = mix(clay, vec3(0.5, 0.49, 0.46), working * 0.5 * smoothstep(0.6, 0.95, bund) * vnoise(q * 4.0));
    pc = mix(pc, bundC, bund);
    water *= 1.0 - bund;
    // the feeder channel runs with sea water whatever the season
    pc = mix(pc, brackish, channel);
    water = max(water, channel);
    diffuseColor.rgb = mix(diffuseColor.rgb, pc, salt);
    float brine = water * salt;
    panW *= salt * (1.0 - bund);
    plotWater = max(plotWater, brine);
    atmBrine = max(atmBrine, brine * 0.85);
  }
  // the photo layers' grain, less of it on the smooth pans
  diffuseColor.rgb *= mix(splatDetail, vec3(1.0), panW * 0.7);
  // the ground darkens and shines where the water has wet it: the flats the tide has uncovered since its
  // last high water, a pond's rim; the plots where water stands; everything after rain
  vec3 wetLv = waterLevels(vAtmWorld.xz);
  float tideTop = max(uTideHigh, uWaterLevel);
  float shore = wetLv.g > 0.5 ? smoothstep(tideTop + 0.35, tideTop - 0.05, vAtmWorld.y) : smoothstep(wetLv.r + 0.6, wetLv.r + 0.05, vAtmWorld.y);
  atmWet = max(max(shore, plotWater * 0.85), uWet * 0.55);
  // the mud the tide has just left keeps a film of water that mirrors the sky
  if (wetLv.g > 0.5) atmBrine = max(atmBrine, shore * smoothstep(uWaterLevel + 0.02, uWaterLevel + 0.3, vAtmWorld.y) * 0.6);
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
#ifdef ATM_SKIN
{
  // a wrapped terminator: where the light grazes and just past it, what scatters under the skin comes out red
  float nl = dot(normalize(inverseTransformDirection(normal, viewMatrix)), uKeyDir);
  float wrap = clamp((nl + 0.45) / 1.45, 0.0, 1.0);
  float scatter = max(wrap * wrap * 1.45 - max(nl, 0.0), 0.0) * smoothstep(0.6, 0.0, nl);
  outgoingLight += diffuseColor.rgb * vec3(1.0, 0.36, 0.2) * uKeyColor * scatter * ATM_SKIN;
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
float causticLevel = waterSurface(vAtmWorld.xz);
if (vAtmWorld.y < causticLevel - 0.02 && uReflPass < 0.5) {
  vec2 q = vAtmWorld.xz * 0.85;
  float a = vnoise(q + vec2(uTime * 0.31, uTime * 0.17));
  float b = vnoise(q * 1.41 + vec2(-uTime * 0.23, uTime * 0.29) + 4.7);
  float caustic = pow(clamp(1.0 - abs(a - b) * 3.2, 0.0, 1.0), 5.0);
  outgoingLight += diffuseColor.rgb * uKeyColor * max(uKeyDir.y, 0.0) * caustic * smoothstep(causticLevel - 2.2, causticLevel - 0.08, vAtmWorld.y) * 1.6;
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
  if (options.skin) defines.ATM_SKIN = options.skin.toFixed(3);
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
