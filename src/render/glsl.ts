/**
 * How far round the camera the crops stand in 3D (world/crops.ts): full height out to `fade`, gone by `edge`
 * (m). Beyond, the terrain paints the plots with the crop's colour; within, it paints the ground under them.
 */
export const CROP_REACH = { fade: 64, edge: 80 } as const;

/**
 * Shared uniforms, noise and aerial perspective. Included exactly once in every scene shader
 * (custom ones and the patched built-in materials), so haze is identical on land, water and sky.
 */
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
uniform float uMirrorLevel;
uniform float uFlowScale;
uniform vec4 uSeasonA;
uniform vec4 uSeasonB;
uniform vec4 uCrops;
uniform float uWet;
uniform float uRain;
uniform float uOvercast;

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

// The paddy plots: rectangles PLOT_SIZE metres in a frame turned in bands 240 m long down the river (the
// terrain paints them, render/patch.ts; the crops stand in them, world/crops.ts, whose CPU twin of this
// layout must stay in step)
const vec2 PLOT_SIZE = vec2(36.0, 22.0);
vec2 plotFrame(vec2 wp) {
  float ang = 0.3 + 0.35 * sin(floor(wp.y / 240.0) * 1.7);
  return mat2(cos(ang), -sin(ang), sin(ang), cos(ang)) * wp;
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
// (world/water.ts levelTexture)
vec3 waterLevels(vec2 p) {
  return texture2D(tLevel, (uLevelMap.xy - p) * uLevelMap.zw).rgb;
}

// How open the sea's water at p is to the Bay's swell (world/exposure.ts): 1 on the open sea, 0 up the creeks
float seaExposure(vec2 p) {
  return texture2D(tLevel, (uLevelMap.xy - p) * uLevelMap.zw).a;
}

// The surface of the water over p (m): the sea's (the tide) over its cells, an inland water's own over
// its, and far below the ground where there is none (a field below high water behind its bund stays dry)
float waterSurface(vec2 p) {
  vec3 lv = waterLevels(p);
  return lv.g > 0.5 ? uWaterLevel : lv.b > 0.5 ? lv.r : -1e4;
}

// Seen from above the water, anything under its surface fades into the silty water body with the
// length of water the eye looks through it; the surface itself adds only reflection, glitter and foam
vec3 underwater(vec3 col, vec3 wpos) {
  if (uReflPass > 0.5) return col;
  float level = waterSurface(wpos.xz);
  if (wpos.y >= level || uCamPos.y <= level) return col;
  float path = length(wpos - uCamPos) * (level - wpos.y) / (uCamPos.y - wpos.y);
  return mix(uWaterBody, col * vec3(0.78, 0.86, 0.72), exp(-path * 2.8));
}

// Aerial perspective: analytic exponential height fog plus a thin river mist that hugs the water
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
  float od = odF + odM;
  vec3 hc = hazeColor(rd);
  vec3 mc = hc * 1.06 + uGlow * 0.05;
  vec3 fc = (hc * odF + mc * odM) / max(od, 1e-5);
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
