import { ShaderChunk } from 'three';
import type { IUniform, Material } from 'three';
import { G } from '../core/globals';
import { CROP_REACH, GLSL_COMMON } from './glsl';
import { SALT_FIELDS } from '../world/plan';
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
  /** Darkens and glosses what stands in the water near its surface (stones at the water's edge, posts): a wet band. */
  wetline?: boolean;
  /** Water stands on its flat once the rain has gone on (the ways): puddles mirroring the sky, ringed by the drops. */
  puddles?: boolean;
  /** Paddy plots, wet banks and riverbed caustics, driven by the terrain's `aZone` attribute. */
  terrain?: boolean;
  /** Photo ground layers blended by the terrain's `aSplat` weights (needs `terrain`). */
  splat?: GroundSet;
  /** Keep the vertex normal on back faces, so a cloud of leaf cards shades as one soft volume. */
  foliage?: boolean;
  /** Custom vertex displacement after `begin_vertex`; `key` names it in the program cache. */
  vertex?: { key: string; pars: string; code: string; uniforms?: Record<string, IUniform> };
  /**
   * Instanced: an instance whose root's sphere of this radius (m, holding all of it as the wind sways it) lies
   * wholly outside the view is dropped before any of its vertices' work (the grass and the crops lie all round the
   * camera, most of them behind it).
   */
  cull?: number;
  /**
   * How the season shows on it: 'leaf' greens up in the rains and dries and pales in the dry months;
   * 'tree' as a leaf, and in spring a share of trees burst into red flower; 'kash' plumes only in autumn.
   */
  seasonal?: 'leaf' | 'tree' | 'kash';
}

/** Metres covered by one repeat of a ground texture. */
const SPLAT_TILE = 2.6;

/**
 * The most a plant leans over in the wind, in the wind's units (× its `wind` and the square of its height
 * over `windHeight`): a breeze is far below it, a storm reaches it (≈1.3 m at a mango's crown).
 */
const LEAN_MAX = 3.2;

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
  float t = uTime;
  // the one wind (env/wind.ts) as it reached this plant: the gust fronts rolling downwind, felt a moment
  // late and smoothed (a tree takes a second or two to answer a gust, a tuft of grass none: what the fronts
  // were here a moment ago is what they are now a little way downwind), made uneven by the air's own
  // turbulence, each plant a little differently, the more so in a storm
  vec2 past = uWind.xy * uGust.y * clamp(sqrt(ATM_WIND_H / 10.0), 0.1, 1.3);
  float felt = 0.5 * windGust(root.xz + past * 0.35) + 0.3 * windGust(root.xz + past * 0.9) + 0.2 * windGust(root.xz + past * 1.6);
  float s = uWind.z * felt;
  float turb = vnoise(root.xz * 0.045 + vec2(t * 0.33, -t * 0.27)) - 0.5;
  float drive = max(0.0, s * (1.0 + turb * (0.5 + 0.4 * min(s, 2.0))));
  // drag grows with the square of the wind, but leaves fold and branches streamline as it rises and the wood
  // stiffens as it bends: the lean levels off, so a storm bows a crown over and holds it there, thrashing,
  // rather than sliding it off its trunk with every gust
  float raw = 0.45 * drive * (0.5 + 0.5 * drive + 0.25 * drive * drive);
  float lean = ${LEAN_MAX.toFixed(2)} * tanh(raw / ${LEAN_MAX.toFixed(2)});
  // each plant its own: a natural period by its size (a big tree swings slowly, a tuft of grass quickly),
  // its own phase and its own give, so no two move in step
  float seed = hash12(floor(root.xz * 3.1) + 0.37);
  float seed2 = hash12(floor(root.xz * 1.7) + 7.1);
  float w = 6.2832 * mix(0.32, 0.52, seed) / (0.6 + 0.4 * sqrt(ATM_WIND_H / 10.0));
  float give = mix(0.75, 1.3, seed2);
  float strong = min(drive, 2.5);
  float storm = smoothstep(1.0, 2.5, strong);
  // about its lean the trunk rocks on two unrelated swings, so it never quite repeats; in a storm the gusts
  // still heave it further over and let it back as they pass, and the rough air buffets it every which way
  float rock = sin(t * w + seed * 6.2832) + 0.45 * sin(t * w * 2.31 + seed2 * 6.2832);
  vec2 buffet = vec2(vnoise(vec2(t * 0.85 + seed * 31.0, seed2 * 7.0)), vnoise(vec2(seed * 5.0, t * 0.7 + seed2 * 23.0))) * 2.0 - 1.0;
  vec2 down = uWind.xy;
  vec2 across = vec2(-uWind.y, uWind.x);
  float along = lean + 0.35 * strong * storm * (felt - 1.0) + rock * (0.14 + 0.22 * strong + 0.03 * strong * strong) + buffet.x * 0.35 * strong * storm;
  float aside = 0.16 * strong * sin(t * w * 0.73 + seed2 * 9.0) + buffet.y * 0.25 * strong * storm;
  vec2 sway = (down * along + across * aside) * hk * ATM_WIND * give;
  // the crown's parts on their own swings, quicker and smaller, out where the branches are; whipping in a storm
  float bk = smoothstep(0.3, 0.95, position.y / ATM_WIND_H);
  float bp = dot(position, vec3(0.6, 0.31, 0.45)) + seed * 13.0;
  vec2 branch = down * sin(t * w * 2.7 + bp) + across * 0.6 * sin(t * w * 3.4 + bp * 1.3);
  sway += branch * (0.05 + 0.09 * strong + 0.04 * strong * strong) * bk * ATM_WIND * ATM_WIND_H * 0.25;
  atmW.xz += sway;
  // a stem keeps its length as it bends: what is carried over comes down
  float above = max(atmW.y - root.y, 0.3);
  atmW.y -= min(dot(sway, sway) / (2.0 * above), above * 0.5);
  #ifdef ATM_FLUTTER
  // the leaves: a quick small shiver, each its own; streaming and flickering in a storm
  float fp = dot(position, vec3(3.1, 2.3, 2.7)) + seed * 40.0;
  atmW.xyz += vec3(sin(t * (8.0 + 5.0 * seed) + fp), 0.6 * sin(t * 11.0 + fp * 1.7), cos(t * (7.0 + 4.0 * seed2) + fp)) * (0.012 + 0.03 * strong + 0.02 * storm) * bk * ATM_WIND * 4.0;
  // and beaten by the rain: each leaf knocked down and springing back as the drops strike it, in a downpour hard
  float knock = max(0.0, sin(t * (17.0 + 9.0 * seed2) + fp * 2.3)) * max(0.0, sin(t * 2.1 + fp));
  atmW.y -= knock * uRain * uRain * 0.035 * bk * ATM_WIND * 4.0;
  #endif
}
#endif
vAtmWorld = atmW.xyz;
#ifdef ATM_TERRAIN
vZone = aZone;
vPool = aPool;
#endif
#ifdef ATM_SPLAT
vSplat = aSplat;
#endif
mvPosition = viewMatrix * atmW;
gl_Position = projectionMatrix * mvPosition;
`;

// An instance wholly outside the view: its vertices are put beyond the far plane at once, spared the wind's and
// their own work. Its root's sphere is tested against the frustum's sides (widened to R × (P + 1), never less than
// the true reach R × √(P² + 1), so nothing partly in view is dropped) and against the eye's back.
const CULL_VERTEX = /* glsl */ `
#if defined(ATM_CULL) && defined(USE_INSTANCING)
{
  vec4 atmC = projectionMatrix * viewMatrix * modelMatrix * vec4(instanceMatrix[3].xyz, 1.0);
  if (atmC.w < -ATM_CULL || abs(atmC.x) > atmC.w + ATM_CULL * (projectionMatrix[0][0] + 1.0) || abs(atmC.y) > atmC.w + ATM_CULL * (projectionMatrix[1][1] + 1.0)) {
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
    return;
  }
}
#endif
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
// how much of the ground is open water that mirrors the sky (brine in the salt pans, flooded plots, puddles)
float atmBrine = 0.0;
// how much of it is a puddle the rain has left (it rings as the drops strike it)
float atmPuddle = 0.0;
// the face's world normal, for how the rain falls on it
#ifdef FLAT_SHADED
vec3 atmN = vec3(0.0, 1.0, 0.0);
#else
vec3 atmN = inverseTransformDirection(vNormal, viewMatrix);
#endif
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
  // (none at all out of the season: the ramp starts at its share, so no tree keeps a little red all year)
  float bloom = smoothstep(0.0, 0.06, uSeasonA.z - hash12(floor(vAtmRoot.xz * 0.37) + 3.1));
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
{
  // rain wets what it falls on: the faces turned up to it soonest and most (roofs, decks, the ways, leaves), the
  // walls less; wet, a surface is darker and glossier, and one turned up mirrors a little of the sky
  #ifdef ATM_FLUTTER
  float atmUp = abs(atmN.y);
  #else
  float atmUp = max(atmN.y, 0.0);
  #endif
  atmWet = smoothstep(0.0, 0.5, uWet) * (0.35 + 0.65 * atmUp);
  diffuseColor.rgb *= mix(1.0, 0.7, atmWet);
  atmBrine = max(atmBrine, atmWet * atmUp * atmUp * 0.16);
  #ifdef ATM_PUDDLES
  // water standing on the flat once the rain has gone on, in the dips (a noise of them), more as it goes on
  float pud = smoothstep(0.45, 1.0, uWet);
  if (pud > 0.0) {
    float blob = vnoise(vAtmWorld.xz * 0.75 + 3.7) * 0.65 + vnoise(vAtmWorld.xz * 2.4) * 0.35;
    atmPuddle = smoothstep(1.0 - 0.32 * pud, 1.09 - 0.32 * pud, blob) * smoothstep(0.93, 0.99, atmN.y);
    atmWet = max(atmWet, atmPuddle);
    atmBrine = max(atmBrine, atmPuddle * 0.85);
    diffuseColor.rgb *= mix(1.0, 0.6, atmPuddle);
  }
  #endif
}
#endif
#ifdef ATM_WETLINE
{
  // wet up to a hand's breadth above the water it stands in, darker and glossier
  float wl = waterSurface(vAtmWorld.xz);
  float wetBand = smoothstep(wl + 0.16, wl + 0.02, vAtmWorld.y);
  diffuseColor.rgb *= mix(1.0, 0.55, wetBand);
  atmWet = max(atmWet, wetBand * 0.9);
}
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
    vec3 canopy = sh.x * vec3(0.11, 0.26, 0.035) + sh.y * mix(vec3(0.12, 0.29, 0.025), vec3(0.065, 0.19, 0.018), grown)
      + sh.z * vec3(0.52, 0.37, 0.045) + sh.w * vec3(0.66, 0.47, 0.012) + stubble * vec3(0.19, 0.14, 0.07);
    canopy *= 0.84 + 0.32 * vnoise(q * vec2(0.45, 1.6) + grown * 40.0);
    canopy *= 0.9 + 0.2 * vnoise(q * 0.12 + grown * 13.0);
    // close by, the crops stand in 3D (world/crops.ts) and the plot shows its own ground under them: water
    // among the young and growing rice, damp soil under the ripe, dry earth under mustard and stubble (not
    // in the mirror, which draws no crops)
    // (seen from higher up the crop closes over its rows and hides the ground: the canopy's colour there)
    float under = (1.0 - smoothstep(${CROP_REACH.fade.toFixed(1)}, ${CROP_REACH.edge.toFixed(1)}, groundReach(vAtmWorld))) * smoothstep(0.45, 0.65, vZone) * (1.0 - uReflPass)
      * (1.0 - smoothstep(4.0, 22.0, uCamPos.y - vAtmWorld.y));
    vec3 ground = mix(vec3(0.085, 0.07, 0.042), vec3(0.15, 0.115, 0.07), sh.w + stubble);
    vec3 fc = mix(canopy, ground, under);
    vec2 e = min(f, 1.0 - f) * PLOT_SIZE;
    float bund = 1.0 - smoothstep(0.15, 0.5, min(e.x, e.y));
    // water standing in the plots: under the seedlings always, among the growing rice, and in the fallow
    // plots as the season has it
    float flooded = smoothstep(-0.035, 0.035, uSeasonB.y - fract(rank * 3.7 + 0.21)) * (sh.w + stubble);
    plotWater = (1.0 - bund) * vZone * max(max(sh.x, sh.y * under * 0.9), flooded);
    fc = mix(fc, fc * 0.45, plotWater * 0.6 * (1.0 - 0.5 * sh.x));
    // the bunds are grassed over, a little paler than the crop round them, bare earth only in the dry months
    fc = mix(fc, mix(vec3(0.075, 0.15, 0.04), vec3(0.13, 0.11, 0.065), uSeasonA.y), bund);
    diffuseColor.rgb = mix(diffuseColor.rgb, fc, vZone);
    atmBrine = plotWater * mix(0.5, 0.6, sh.x);
  }
  // the salt farms (লবণ মাঠ, world/plan.ts SALT_FIELDS; world/geography.ts digs them, world/saltworks.ts builds
  // their bunds and heaps, and their twins of this layout must stay in step): each a farm (khola) inside its earth
  // embankment, a feeder ditch along its foot. A settling pond where the water is let in; evaporation beds with mud
  // floors where the brine thickens in the sun, a few strong enough to rime their floors white; then the small
  // crystallizer beds lined with black plastic, each at its stage (saltStage): a film of brine mirroring the sky,
  // crust forming in it, a white sheet of salt ready to rake, or just raked (the heaps stand on the bunds). Out of
  // the salt season (uSeasonB.w: from late autumn to the first storms of summer) the plastic is taken up and the
  // rains stand in the pans as real water (the water's own surface, uSaltWet), the settling pond's all year.
  float panW = 0.0;
  if (vZone < -0.01) {
    float salt = -vZone;
    // which farm, and where in its frame
    vec2 bq = vec2(-1e3);
    vec2 blockSize = vec2(1.0);
    float pondShare = 0.0;
    float evapShare = 0.0;
    vec2 evapCell = vec2(1.0);
    vec2 crystalCell = vec2(1.0);
    float rimInset = 2.0;
    float farmSeed = 0.0;
    float grassy = 0.0;
${SALT_FIELDS.map((f) => `    if (bq.x < -900.0) {
      vec2 rel = wp - vec2(${f.x.toFixed(1)}, ${f.z.toFixed(1)});
      vec2 fq = vec2(dot(rel, vec2(${Math.sin(f.yaw).toFixed(5)}, ${Math.cos(f.yaw).toFixed(5)})), dot(rel, vec2(${Math.cos(f.yaw).toFixed(5)}, ${(-Math.sin(f.yaw)).toFixed(5)}))) + vec2(${(f.w / 2).toFixed(2)}, ${(f.d / 2).toFixed(2)});
      if (fq.x > -4.0 && fq.y > -4.0 && fq.x < ${(f.w + 4).toFixed(2)} && fq.y < ${(f.d + 4).toFixed(2)}) {
        bq = fq;
        blockSize = vec2(${f.w.toFixed(2)}, ${f.d.toFixed(2)});
        pondShare = ${f.pond.toFixed(4)};
        evapShare = ${f.evaporation.toFixed(4)};
        evapCell = vec2(${f.evapCell[0].toFixed(3)}, ${f.evapCell[1].toFixed(3)});
        crystalCell = vec2(${f.crystalCell[0].toFixed(3)}, ${f.crystalCell[1].toFixed(3)});
        rimInset = ${f.rimInset.toFixed(3)};
        farmSeed = ${f.seed.toFixed(4)};
        grassy = ${f.grassy ? '1.0' : '0.0'};
      }
    }`).join('\n')}
    vec2 q = bq;
    vec2 eb = min(bq, blockSize - bq);
    float edge = min(eb.x, eb.y);
    // the feeder ditch along the embankment's foot, outside it, and the embankment itself
    float ditch = smoothstep(-2.0, -1.5, edge) * (1.0 - smoothstep(-0.5, -0.2, edge));
    float rim = smoothstep(-0.4, 0.1, edge) * (1.0 - smoothstep(rimInset - 0.4, rimInset, edge));
    float working = smoothstep(-0.05, 0.05, uSeasonB.w - 0.5);
    vec3 clay = vec3(0.24, 0.21, 0.17) * (0.9 + 0.2 * vnoise(q * 1.7));
    vec3 brackish = vec3(0.1, 0.1, 0.075);
    float u = bq.x / blockSize.x;
    vec2 lq = bq;
    vec2 size = blockSize;
    if (u >= evapShare) {
      lq.x -= blockSize.x * evapShare;
      size = crystalCell;
    } else if (u >= pondShare) {
      lq.x -= blockSize.x * pondShare;
      size = evapCell;
    }
    vec2 cell = floor(lq / size);
    vec2 e = min(fract(lq / size), 1.0 - fract(lq / size)) * size;
    float inner = 1.0 - smoothstep(0.3, 0.7, min(e.x, e.y));
    float bund = max(rim, u >= pondShare ? inner * step(rimInset, edge) : 0.0);
    // each bed's stage in the work (saltworks.ts saltStage is its twin)
    float stage = fract(cell.x * 0.618 + cell.y * 0.29 + 0.11 + farmSeed);
    vec3 work;
    float wet;
    bool pond = u < pondShare;
    if (pond) {
      // the settling pond: its water is the water's own, all year
      work = vec3(0.11, 0.115, 0.085);
      wet = 0.0;
    } else if (u < evapShare) {
      // evaporation beds: brine over mud, browner where it is new, greyer and greener as it thickens, a few
      // drying out with salt riming their floors
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
    // out of the season the floors lie bare and dark under the rains' water (which the water itself draws)
    vec3 pc = mix(brackish, work, working);
    float water = wet * working * (1.0 - uSaltWet) * step(rimInset, edge);
    // the bunds: grey clay, rimed white with salt where the brine laps them while the farm works; an old farm's
    // embankment grassed over
    vec3 bundC = mix(clay, vec3(0.5, 0.49, 0.46), working * 0.5 * smoothstep(0.6, 0.95, bund) * vnoise(q * 4.0));
    bundC = mix(bundC, mix(vec3(0.09, 0.15, 0.05), vec3(0.14, 0.13, 0.075), uSeasonA.y) * (0.85 + 0.3 * vnoise(q * 0.9)), grassy * rim);
    pc = mix(pc, bundC, max(bund, 1.0 - step(0.0, edge)));
    water *= 1.0 - bund;
    // the feeder ditch runs with the creek's water whatever the season
    pc = mix(pc, brackish, ditch);
    water = max(water, ditch);
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
  // rain wets the ground unevenly: the trodden earth and the hollows soonest and most (vPool, world/terrain.ts),
  // a slope drains; once it has rained on a while water stands in them, more as it goes on
  float lie = clamp(vPool, 0.0, 1.0);
  float level = smoothstep(0.86, 0.98, atmN.y);
  float soak = smoothstep(0.0, 0.5, uWet) * (0.4 + 0.6 * max(lie, level * 0.55));
  float pud = smoothstep(0.45, 1.0, uWet);
  if (pud > 0.0) {
    float blob = vnoise(vAtmWorld.xz * 0.7 + 1.3) * 0.6 + vnoise(vAtmWorld.xz * 2.3 + 7.1) * 0.4;
    atmPuddle = smoothstep(1.22 - 0.42 * pud, 1.32 - 0.42 * pud, blob * 0.7 + lie * 0.5) * level;
  }
  atmWet = max(max(shore, plotWater * 0.85), max(soak * 0.85, atmPuddle));
  atmBrine = max(atmBrine, atmPuddle * 0.9);
  diffuseColor.rgb *= mix(1.0, 0.6, atmPuddle);
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
#if defined(STANDARD) || defined(LAMBERT) || defined(PHONG)
// the village's lamps after dark (world/landmarks.ts): their warm light on what is near them
if (uNight > 0.01) outgoingLight += diffuseColor.rgb * lampsAt(vAtmWorld, normalize(inverseTransformDirection(normal, viewMatrix)));
#endif
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
// still water standing on a surface (brine in the pans, flooded plots, puddles, the film of rain on a roof)
// mirrors the sky, more so at a grazing look; in the rain the drops ring it, white for an instant where they strike
if (atmBrine > 0.01 && uReflPass < 0.5) {
  vec3 toEye = normalize(uCamPos - vAtmWorld);
  float fres = 0.02 + 0.98 * pow(1.0 - max(toEye.y, 0.0), 5.0);
  vec3 still = vec3(0.0, 1.0, 0.0);
  float splash = 0.0;
  if (uRain > 0.01 && atmBrine > 0.3) {
    vec3 rr = rainRipples(vAtmWorld.xz, uRain);
    still = normalize(vec3(-rr.x * 2.5, 1.0, -rr.y * 2.5));
    splash = rr.z;
  }
  // (a puddle mirrors less of the sky than open water: the banks, trees and houses round it shut much of it out)
  vec3 sky = hazeColor(reflect(-toEye, still)) * (1.0 - 0.45 * atmPuddle);
  outgoingLight = mix(outgoingLight, sky, clamp(fres * 0.9 + 0.08 - 0.05 * atmPuddle, 0.0, 1.0) * atmBrine);
  outgoingLight += (uFogColor * 1.2 + 0.05) * splash * 0.5 * atmBrine;
}
#ifdef ATM_TERRAIN
// sunlight focused by the ripples into a moving net of caustics on the shallow bed
float causticLevel = waterSurface(vAtmWorld.xz);
if (vAtmWorld.y < causticLevel - 0.02 && uReflPass < 0.5) {
  vec2 q = vAtmWorld.xz * 0.85;
  float a = vnoise(q + vec2(uTime * 0.31, uTime * 0.17));
  float b = vnoise(q * 1.41 + vec2(-uTime * 0.23, uTime * 0.29) + 4.7);
  float caustic = pow(clamp(1.0 - abs(a - b) * 3.2, 0.0, 1.0), 5.0);
  outgoingLight += diffuseColor.rgb * uKeyColor * max(uKeyDir.y, 0.0) * caustic * smoothstep(causticLevel - 2.2, causticLevel - 0.08, vAtmWorld.y) * 0.9;
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
    if (options.foliage) defines.ATM_FLUTTER = '';
  }
  if (options.translucency) defines.ATM_TRANSL = options.translucency.toFixed(3);
  if (options.skin) defines.ATM_SKIN = options.skin.toFixed(3);
  if (options.grime) defines.ATM_GRIME = options.grime.toFixed(3);
  if (options.wetline) defines.ATM_WETLINE = '';
  if (options.puddles) defines.ATM_PUDDLES = '';
  if (options.terrain) defines.ATM_TERRAIN = '';
  if (options.terrain && options.splat) defines.ATM_SPLAT = '';
  if (options.seasonal) defines.ATM_SEASONAL = options.seasonal === 'leaf' ? '1' : options.seasonal === 'tree' ? '2' : '3';
  if (options.cull) defines.ATM_CULL = options.cull.toFixed(2);
  material.defines = { ...(material.defines ?? {}), ...defines };

  const key = `atm|${JSON.stringify(defines)}|${options.foliage ? 'f' : ''}|${options.vertex?.key ?? ''}`;
  material.customProgramCacheKey = () => key;

  const splat = options.terrain ? options.splat : undefined;
  const splatUniforms = splat
    ? { tGroundC: { value: splat.color }, tGroundN: { value: splat.normal }, uGroundMean: { value: splat.means } }
    : {};

  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, G, options.vertex?.uniforms ?? {}, splatUniforms);
    const terrainPars = options.terrain ? 'attribute float aZone;\nattribute float aPool;\nvarying float vZone;\nvarying float vPool;\n' : '';
    const splatVertPars = splat ? 'attribute vec4 aSplat;\nvarying vec4 vSplat;\n' : '';
    shader.vertexShader =
      GLSL_COMMON +
      'varying vec3 vAtmWorld;\n' +
      (options.seasonal ? 'varying vec3 vAtmRoot;\n' : '') +
      terrainPars +
      splatVertPars +
      (options.vertex?.pars ?? '') +
      shader.vertexShader
        .replace('#include <begin_vertex>', `#include <begin_vertex>\n${CULL_VERTEX}\n${options.vertex?.code ?? ''}`)
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
      (options.terrain ? 'varying float vZone;\nvarying float vPool;\n' : '') +
      splatFragPars +
      frag;
  };
  return material;
}
