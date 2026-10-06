/**
 * How far round the camera the crops stand in 3D (world/crops.ts), measured by `groundReach` (the camera's
 * height above them counting double, so seen from the air the fields are the terrain's painted plots): the
 * plants themselves, full out to `fade` and gone by `edge` (within it the terrain paints the ground under them;
 * beyond, the plot in its crop's colour), and the canopy cards over the plots on out to `canopy`.
 */
export const CROP_REACH = { fade: 30, edge: 37, canopy: [80, 100], lift: 2 } as const;

import { POND_LEVEL, POND_RISE, SALT_BAND, SALT_DRAIN, WATER_LEVEL } from '../world/plan';

/**
 * Shared uniforms, noise and aerial perspective. Included exactly once in every scene shader
 * (custom ones and the patched built-in materials), so haze is identical on land, water and sky.
 */
/**
 * How far past the world's edges the map of the waters (water.ts levelTexture) runs on (m), so the river goes on
 * into the haze instead of ending at the edge; the haze still thickens from the world's own edges.
 */
export const EDGE_MARGIN = 600;

/**
 * The land the village keeps to (geography.ts corridorDistance: from the boat's way and the bil, m): all is drawn
 * out to `clear`; beyond, the land fades into the haze at `haze` per m. The crops and the grass stop at `crops`,
 * the trees thin away between `trees`, and the free camera keeps within `camera`. The user asked for the land
 * either side of the waters cut to a third, nothing grown on the rest, and nobody let out onto it.
 */
export const CORRIDOR = { clear: 230, haze: 0.008, crops: 300, trees: [290, 420], camera: 205 } as const;

export const GLSL_COMMON = /* glsl */ `
uniform float uTime;
uniform vec3 uCamPos;
uniform float uReflPass;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uKeyDir;
uniform vec3 uKeyColor;
uniform vec3 uGlow;
uniform vec3 uFogColor;
uniform float uFogDensity;
uniform float uFogFalloff;
uniform float uMist;
uniform float uNight;
uniform vec3 uWaterBody;
uniform vec4 uWind;
uniform vec2 uGust;
uniform vec4 uWaveA;
uniform vec4 uWaveB;
uniform vec4 uWaveC;
uniform vec4 uWaveDir;
uniform vec2 uSea;
uniform vec4 uSwell;
uniform float uWaterLevel;
uniform float uTideHigh;
uniform sampler2D tLevel;
uniform vec4 uLevelMap;
uniform sampler2D tCorridor;
uniform vec4 uCorridorMap;
uniform float uMirrorLevel;
uniform float uFlowScale;
uniform float uWaterRise;
uniform float uSaltWet;
uniform vec4 uSeasonA;
uniform vec4 uSeasonB;
uniform vec4 uCrops;
uniform float uWet;
uniform float uRain;
uniform float uOvercast;
uniform float uHillCloud;
uniform vec4 uLightning;
uniform vec4 uLamp0;
uniform vec4 uLamp1;
uniform vec4 uLamp2;
uniform vec4 uLamp3;
uniform vec3 uLampColor0;
uniform vec3 uLampColor1;
uniform vec3 uLampColor2;
uniform vec3 uLampColor3;

// One of the village's lamps on a surface at p facing n (world): a soft light, falling off nearly as the square
// of the distance and smoothly to nothing at its reach, wrapped a little round the surface (a room's lamp fills
// it from its walls too). Four separate uniforms, not an array indexed in a loop (slow on ANGLE/Direct3D).
vec3 lampLight(vec4 lamp, vec3 color, vec3 p, vec3 n) {
  vec3 d = lamp.xyz - p;
  float d2 = dot(d, d);
  float reach2 = lamp.w * lamp.w;
  if (d2 >= reach2 || dot(color, color) <= 0.0) return vec3(0.0);
  float edge = 1.0 - d2 / reach2;
  float nl = clamp(dot(n, d * inversesqrt(max(d2, 1e-4))) * 0.85 + 0.15, 0.0, 1.0);
  return color * edge * edge / (1.0 + d2) * nl;
}
vec3 lampsAt(vec3 p, vec3 n) {
  return lampLight(uLamp0, uLampColor0, p, n) + lampLight(uLamp1, uLampColor1, p, n) + lampLight(uLamp2, uLampColor2, p, n) + lampLight(uLamp3, uLampColor3, p, n);
}

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float hash13(vec3 p3) {
  p3 = fract(p3 * 0.1031);
  p3 += dot(p3, p3.zyx + 31.32);
  return fract((p3.x + p3.y) * p3.z);
}

float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash12(i);
  float b = hash12(i + vec2(1.0, 0.0));
  float c = hash12(i + vec2(0.0, 1.0));
  float d = hash12(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

const mat2 FBM_ROT = mat2(1.6, 1.2, -1.2, 1.6);

float fbm3(vec2 p) {
  float s = 0.0;
  float a = 0.5;
  for (int i = 0; i < 3; i++) { s += a * vnoise(p); p = FBM_ROT * p; a *= 0.5; }
  return s / 0.875;
}

float fbm5(vec2 p) {
  float s = 0.0;
  float a = 0.5;
  for (int i = 0; i < 5; i++) { s += a * vnoise(p); p = FBM_ROT * p; a *= 0.5; }
  return s / 0.96875;
}

// The gusts' factor on the mean wind at p: fronts of stronger air rolling downwind (twin of gustAt in
// env/wind.ts). 1 on average.
float windGust(vec2 p) {
  float along = dot(p, uWind.xy);
  float across = dot(p, vec2(-uWind.y, uWind.x));
  float front = along * 0.045 - uGust.x;
  float g = 0.62 * sin(front) + 0.38 * sin(front * 2.3 + across * 0.031 + 1.7);
  return max(0.0, 1.0 + uWind.w * g);
}

// The paddy plots: rectangles PLOT_SIZE metres, the grid laid along the river's general line and bent by long,
// gentle waves, so the bunds curve over the land as real ones do and no seam crosses the fields (the terrain
// paints them, render/patch.ts; the crops stand in them, world/crops.ts, whose CPU twin of this layout must
// stay in step)
const vec2 PLOT_SIZE = vec2(32.0, 20.0);
const float PLOT_ANGLE = 0.12;
vec2 plotWarp(vec2 p) {
  return vec2(14.0 * sin(p.y * 0.0131 + 1.3) + 9.0 * sin(p.x * 0.0087 + 0.4), 11.0 * sin(p.x * 0.0117 + 2.1) + 7.0 * sin((p.x + p.y) * 0.0071 + 4.0));
}
vec2 plotFrame(vec2 wp) {
  return mat2(cos(PLOT_ANGLE), -sin(PLOT_ANGLE), sin(PLOT_ANGLE), cos(PLOT_ANGLE)) * (wp + plotWarp(wp));
}
// How far the 3D crops at p are from the camera, as their reach measures it (CROP_REACH in glsl.ts)
float groundReach(vec3 p) {
  vec2 d = p.xz - uCamPos.xz;
  float up = max(uCamPos.y - p.y - 3.0, 0.0) * ${CROP_REACH.lift.toFixed(1)};
  return sqrt(dot(d, d) + up * up);
}
// A plot's place in the order the season plants and reaps them (0..1): a field's worth of neighbouring plots
// is worked together, so the stages lie over the land in broad patches, each plot a little ahead or behind
float plotRank(vec2 cell) {
  float field = smoothstep(0.2, 0.8, vnoise((cell + 0.5) * PLOT_SIZE * 0.0065 + vec2(3.1, 7.7)));
  return clamp(0.92 * field + 0.08 * hash12(cell), 0.0, 1.0);
}

// What grows in a plot whose place in the season's order is r (each plot turns from one crop to the next
// gradually as the season's shares, uCrops, pass its place): x seedlings in water, y green rice, z ripe
// rice, w mustard in flower; whatever is left is stubble after the harvest
vec4 cropShares(float r) {
  const float turn = 0.035;
  float c1 = uCrops.x;
  float c2 = c1 + uCrops.y;
  float c3 = c2 + uCrops.z;
  float c4 = c3 + uCrops.w;
  float s1 = smoothstep(c1 - turn, c1 + turn, r);
  float s2 = smoothstep(c2 - turn, c2 + turn, r);
  float s3 = smoothstep(c3 - turn, c3 + turn, r);
  float s4 = smoothstep(c4 - turn, c4 + turn, r);
  return vec4(1.0 - s1, s1 - s2, s2 - s3, s3 - s4);
}

// colour of the haze along a view ray: the horizon tint, warmed on the sun's side
vec3 hazeColor(vec3 rd) {
  float hl = length(rd.xz);
  float sl = length(uSunDir.xz);
  float az = (hl > 1e-4 && sl > 1e-4) ? max(dot(rd.xz / hl, uSunDir.xz / sl), 0.0) : 0.0;
  float mu = max(dot(rd, uSunDir), 0.0);
  return uFogColor + uGlow * (0.3 * pow(az, 3.0) + 0.55 * pow(az, 14.0)) + uSunColor * 0.04 * pow(mu, 24.0);
}

// Which water stands over p (world xz): r inland water's level, g the sea's cells, b inland water's
// (world/water.ts levelTexture, baked at the mean level). The season raises and lowers it (uWaterRise): the
// river, the khals and the bil by all of it, the ponds (above the khal's level) by POND_RISE, as geography.ts's
// waterLevelAt does. A rising water spills over the banks the map carries its level out over: b is then
// taken as water wherever a level was carried (r far above its fill of -20).
vec3 waterLevels(vec2 p) {
  vec3 lv = texture2D(tLevel, (uLevelMap.xy - p) * uLevelMap.zw).rgb;
  // (a salt farm's stands above SALT_BAND: full in the rains, drained for the salt work, geography.ts risenLevel)
  lv.r += lv.r > ${SALT_BAND.toFixed(2)} ? -(1.0 - uSaltWet) * ${SALT_DRAIN.toFixed(2)} : uWaterRise * (lv.r > ${(WATER_LEVEL + (POND_LEVEL - WATER_LEVEL) / 2).toFixed(2)} ? ${POND_RISE.toFixed(2)} : 1.0);
  if (uWaterRise > 0.01 && lv.r > -5.0) lv.b = 1.0;
  return lv;
}

// How open the sea's water at p is to the Bay's swell (world/exposure.ts): 1 on the open sea, 0 up the creeks
float seaExposure(vec2 p) {
  return texture2D(tLevel, (uLevelMap.xy - p) * uLevelMap.zw).a;
}

// How clear an inland water at p is beyond the season's own (the level map's a, which is the sea's exposure
// over the sea): 1 over the pond the village keeps clean (world/water.ts levelTexture)
float waterClarity(vec2 p) {
  return texture2D(tLevel, (uLevelMap.xy - p) * uLevelMap.zw).a;
}

// The surface of the water over p (m): the sea's (the tide) over its cells, an inland water's own over
// its, and far below the ground where there is none (a field below high water behind its bund stays dry)
float waterSurface(vec2 p) {
  vec3 lv = waterLevels(p);
  return lv.g > 0.5 ? uWaterLevel : lv.b > 0.5 ? lv.r : -1e4;
}

// ---- rain on still water (the waters, the puddles, the flooded plots) ----
// The drops land in cells of three sizes. Each cell's drop falls at a fresh place and size every time (each cell
// keeps its own period), so no pattern repeats. How many cells are struck goes with how hard it rains (rain,
// 0..1), and the biggest drops come only in a downpour. One drop at a time per cell, its ring kept inside the cell.
// A fourth, finer layer is spray only: the many small drops that only splash (world/rain.ts's crowns).
const vec4 RAIN_CELL = vec4(0.6, 1.0, 1.6, 0.32);

float rainCell(float k) {
  return k < 0.5 ? RAIN_CELL.x : k < 1.5 ? RAIN_CELL.y : k < 2.5 ? RAIN_CELL.z : RAIN_CELL.w;
}

// The drop of layer k in cell c now: xy where it struck (m), z how long ago (s), w its size (0..1); w < 0: none.
vec4 rainDrop(vec2 c, float k, float rain) {
  float size = rainCell(k);
  float h = hash12(c + k * 17.31);
  float period = 0.5 + 0.9 * h;
  float tt = uTime / period + h * 7.0;
  float n = floor(tt);
  float chance = k < 0.5 ? rain : k < 1.5 ? rain * rain * 0.9 : k < 2.5 ? smoothstep(0.55, 1.0, rain) * 0.7 : rain * rain * 0.85;
  if (hash13(vec3(c, n + k * 3.7)) > chance) return vec4(0.0, 0.0, 0.0, -1.0);
  vec2 o = vec2(hash13(vec3(c, n + 0.37)), hash13(vec3(c + 5.1, n))) * 0.5 + 0.25;
  return vec4((c + o) * size, fract(tt) * period, 0.35 + 0.65 * hash13(vec3(c - 2.3, n + 1.7)));
}

// The rings the drops raise round p: the surface's slope (xy), and the white of a splash where one has just struck (z).
vec3 rainRipples(vec2 p, float rain) {
  vec3 r = vec3(0.0);
  for (int i = 0; i < 3; i++) {
    float k = float(i);
    float size = rainCell(k);
    vec4 d = rainDrop(floor(p / size), k, rain);
    if (d.w < 0.0) continue;
    float ph = d.z / (0.5 + 0.4 * d.w);
    if (ph >= 1.0) continue;
    vec2 o = p - d.xy;
    float dist = length(o);
    // the ring spreads, widening and dying (never past the cell: the drop lands in its middle half); its crest
    // catches the light a little
    float x = (dist - ph * size * (0.14 + 0.1 * d.w)) / (0.018 + 0.04 * ph);
    float fade = (1.0 - ph) * (1.0 - ph) * (0.5 + 0.9 * d.w);
    float crest = exp(-x * x);
    r.xy += o / max(dist, 1e-3) * (-2.0 * x * crest) * fade * 0.65;
    r.z += crest * fade * 0.35 + smoothstep(0.035 + 0.03 * d.w, 0.0, dist) * smoothstep(0.09, 0.0, d.z) * d.w;
  }
  return r;
}

// Seen from above the water, anything under its surface fades into the silty water body with the
// length of water the eye looks through it; the surface itself adds only reflection, glitter and foam
vec3 underwater(vec3 col, vec3 wpos) {
  if (uReflPass > 0.5) return col;
  vec3 lv = waterLevels(wpos.xz);
  float level = lv.g > 0.5 ? uWaterLevel : lv.b > 0.5 ? lv.r : -1e4;
  if (wpos.y >= level || uCamPos.y <= level) return col;
  float path = length(wpos - uCamPos) * (level - wpos.y) / (uCamPos.y - wpos.y);
  // out toward the open Bay the sea is clearer and greener-blue than the channel's silt
  float open = lv.g > 0.5 ? seaExposure(wpos.xz) : 0.0;
  // the rivers run clear and green from late autumn through the dry months, and silty brown in the rains, as
  // the land's runoff (uFlowScale, the season's) brings the silt down
  float clear = 1.0 - smoothstep(0.8, 1.4, uFlowScale);
  // a pond kept clean stays clear whatever the season: its bed and its fish seen through it
  float kept = lv.g > 0.5 ? 0.0 : waterClarity(wpos.xz);
  vec3 body = mix(uWaterBody, uWaterBody * vec3(0.62, 0.98, 1.2), open);
  body = mix(body, body * vec3(0.72, 1.06, 1.02), max(clear, kept));
  body = mix(body, body * vec3(0.9, 1.25, 1.2), kept);
  vec3 seen = col * mix(mix(vec3(0.78, 0.86, 0.72), vec3(0.74, 0.92, 0.86), clear), vec3(0.92, 1.0, 0.95), kept);
  return mix(body, seen, exp(-path * mix(mix(mix(2.8, 1.5, open), 0.7, clear), 0.18, kept)));
}

// Aerial perspective: analytic exponential height fog plus a thin river mist that hugs the water
// how quickly the land beyond the map's edges fades into the haze (per m beyond them): nearly gone 300 m out
#define EDGE_HAZE 0.009
vec3 applyAtmosphere(vec3 col, vec3 wpos) {
  vec3 ro = uCamPos;
  vec3 rd = wpos - ro;
  float dist = length(rd);
  rd /= max(dist, 1e-4);
  // the mirror pass fogs only the stretch from the water surface up to the object;
  // the water shader fogs the stretch from the camera down to the surface
  if (uReflPass > 0.5 && ro.y < uMirrorLevel && rd.y > 1e-4) {
    float t0 = (uMirrorLevel - ro.y) / rd.y;
    ro += rd * t0;
    dist = max(dist - t0, 0.0);
  }
  // seen from above the water, the haze ends at its surface: the water colours the rest (underwater()), and
  // the height fog's density, growing below sea level, must not thicken over a deep bed
  if (uReflPass < 0.5 && rd.y < -1e-4) {
    float surface = waterSurface(wpos.xz);
    if (wpos.y < surface && ro.y > surface) dist = min(dist, (surface - ro.y) / rd.y);
  }
  float y0 = max(ro.y, 0.0);
  // each density integrated along the ray, written as a difference of the two ends' exponentials: the
  // product form (exp(-y0 f) times a growing exp(dist |k|)) is 0 times infinity in fp32 once the eye is a
  // few hundred metres up
  float y1 = y0 + rd.y * dist;
  float k = rd.y * uFogFalloff;
  float odF = uFogDensity * (abs(k) > 1e-5 ? (exp(-y0 * uFogFalloff) - exp(-y1 * uFogFalloff)) / k : dist * exp(-y0 * uFogFalloff));
  float km = rd.y * 0.45;
  float banks = 0.35 + 1.3 * vnoise(wpos.xz * 0.005 + vec2(uTime * 0.004, uTime * 0.0025));
  float odM = uMist * banks * (abs(km) > 1e-5 ? (exp(-y0 * 0.45) - exp(-y1 * 0.45)) / km : dist * exp(-y0 * 0.45));
  // the world is a small window of the land, the baked map (uLevelMap: its west and north edges, 1 / its
  // extent): beyond its edges, where the edge cells only run on, the land fades into the haze
  float odE = 0.0;
  if (uLevelMap.z > 0.0) {
    vec2 hi = uLevelMap.xy - ${EDGE_MARGIN.toFixed(1)};
    vec2 lo = uLevelMap.xy - 1.0 / uLevelMap.zw + ${EDGE_MARGIN.toFixed(1)};
    odE = length(max(max(lo - wpos.xz, wpos.xz - hi), 0.0)) * EDGE_HAZE;
  }
  // and past the land the village keeps to (CORRIDOR), the land fades away
  if (uCorridorMap.z > 0.0) {
    float cd = texture2D(tCorridor, (uCorridorMap.xy - wpos.xz) * uCorridorMap.zw).r;
    odE = max(odE, max(cd - ${CORRIDOR.clear.toFixed(1)}, 0.0) * ${CORRIDOR.haze.toFixed(4)});
  }
  float od = odF + odM + odE;
  vec3 hc = hazeColor(rd);
  vec3 mc = hc * 1.06 + uGlow * 0.05;
  vec3 fc = (hc * (odF + odE) + mc * odM) / max(od, 1e-5);
  return mix(col, fc, 1.0 - exp(-od));
}
`;

/** Full-screen triangle vertex shader for post passes. */
export const GLSL_FULLSCREEN_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;
