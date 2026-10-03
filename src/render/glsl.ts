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

// colour of the haze along a view ray: the horizon tint, warmed on the sun's side
vec3 hazeColor(vec3 rd) {
  float hl = length(rd.xz);
  float sl = length(uSunDir.xz);
  float az = (hl > 1e-4 && sl > 1e-4) ? max(dot(rd.xz / hl, uSunDir.xz / sl), 0.0) : 0.0;
  float mu = max(dot(rd, uSunDir), 0.0);
  return uFogColor + uGlow * (0.3 * pow(az, 3.0) + 0.55 * pow(az, 14.0)) + uSunColor * 0.04 * pow(mu, 24.0);
}

// Seen from above the river, anything under the surface fades into the silty water body with the
// length of water the eye looks through it; the surface itself adds only reflection, glitter and foam
vec3 underwater(vec3 col, vec3 wpos) {
  if (wpos.y >= 0.0 || uReflPass > 0.5 || uCamPos.y <= 0.0) return col;
  float path = length(wpos - uCamPos) * -wpos.y / (uCamPos.y - wpos.y);
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
  if (uReflPass > 0.5 && ro.y < 0.0 && rd.y > 1e-4) {
    float t0 = -ro.y / rd.y;
    ro += rd * t0;
    dist = max(dist - t0, 0.0);
  }
  float y0 = max(ro.y, 0.0);
  float k = rd.y * uFogFalloff;
  float odF = uFogDensity * exp(-y0 * uFogFalloff) * (abs(k) > 1e-5 ? (1.0 - exp(-dist * k)) / k : dist);
  float km = rd.y * 0.45;
  float banks = 0.35 + 1.3 * vnoise(wpos.xz * 0.005 + vec2(uTime * 0.004, uTime * 0.0025));
  float odM = uMist * banks * exp(-y0 * 0.45) * (abs(km) > 1e-5 ? (1.0 - exp(-dist * km)) / km : dist);
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
