import { BackSide, Color, Mesh, ShaderMaterial, SphereGeometry, Vector3 } from 'three';
import { G } from '../core/globals';
import { GLSL_COMMON } from '../render/glsl';

const VERT = /* glsl */ `
varying vec3 vWorld;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
  gl_Position.z = gl_Position.w * 0.99999;
}
`;

const FRAG = /* glsl */ `
${GLSL_COMMON}
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uMoonDir;
uniform float uCloud;
varying vec3 vWorld;

// star field: one jittered star per cell of a grid on the sky, twinkling
vec3 stars(vec3 rd) {
  vec3 p = rd * 230.0;
  vec3 c = floor(p);
  float h = hash13(c);
  if (h < 0.9955) return vec3(0.0);
  vec3 jit = vec3(hash13(c + 1.7), hash13(c + 3.1), hash13(c + 5.3)) - 0.5;
  float d = length(fract(p) - 0.5 - jit * 0.6);
  float tw = 0.65 + 0.35 * sin(uTime * (1.3 + h * 4.0) + h * 70.0);
  float b = (h - 0.9955) / 0.0045;
  return mix(vec3(1.0, 0.85, 0.7), vec3(0.75, 0.85, 1.0), hash13(c + 9.1)) * smoothstep(0.14, 0.0, d) * tw * (0.15 + b * b * 1.6);
}

void main() {
  vec3 rd = normalize(vWorld - uCamPos);
  float y = rd.y;
  float hy = max(y, 0.0);
  float mu = dot(rd, uSunDir);
  float mup = max(mu, 0.0);

  vec3 col = mix(uHorizon, uZenith, 1.0 - exp(-hy * 5.5));
  // warm bloom of the low sun, spreading along the horizon
  float low = 1.0 - smoothstep(0.0, 0.45, uSunDir.y);
  col += uSunColor * (0.05 * pow(mup, 3.0) * exp(-hy * 3.0) * (0.3 + low) + 0.06 * pow(mup, 18.0) + 0.16 * pow(mup, 400.0));
  vec3 disc = uSunColor * 30.0 * smoothstep(0.99989, 0.99994, mu);

  // night: stars, a faint milky band, and the moon with a cool halo
  vec3 night = vec3(0.0);
  if (uNight > 0.01) {
    night += stars(rd) * smoothstep(0.0, 0.25, y);
    float band = exp(-pow(dot(rd, normalize(vec3(0.3, 0.55, 0.78))) * 3.2, 2.0));
    night += vec3(0.010, 0.012, 0.020) * band * (0.6 + 0.6 * fbm3(rd.xz * 9.0 / (abs(rd.y) + 0.4)));
    float md = dot(rd, uMoonDir);
    float moonDisc = smoothstep(0.99962, 0.99975, md);
    float craters = 0.82 + 0.18 * fbm3(rd.xy * 900.0);
    night += vec3(1.1, 1.08, 1.0) * moonDisc * craters * 1.4;
    night += vec3(0.04, 0.05, 0.08) * pow(max(md, 0.0), 300.0) + vec3(0.008, 0.01, 0.018) * pow(max(md, 0.0), 12.0);
    night *= uNight;
  }

  // clouds on a curved layer: silver-gold lining toward the sun, cool grey-violet undersides
  float cov = 0.0;
  vec3 cloudCol = vec3(0.0);
  if (y > 0.0) {
    vec2 p = rd.xz / (y + 0.09);
    vec2 q = p * 0.5 + uWind.xy * uTime * 0.0035;
    float d = fbm5(q) * 0.8 + fbm3(q * 3.3 + 7.0) * 0.2;
    cov = smoothstep(1.0 - uCloud, 1.0 - uCloud + 0.26, d);
    vec2 sdir = normalize(uSunDir.xz + vec2(1e-5));
    float ds = fbm5(q + sdir * 0.08) * 0.8 + fbm3((q + sdir * 0.08) * 3.3 + 7.0) * 0.2;
    float lit = clamp(0.55 + (d - ds) * 5.0, 0.0, 1.0);
    // low sun lights the undersides warm; away from it they stay cool grey-violet
    vec3 shade = mix(uHorizon, uZenith, 0.65) * 0.6 + uGlow * 0.14;
    vec3 sunlit = uSunColor * 0.26 * (0.4 + 0.6 * lit) + uZenith * 0.25 + uGlow * 0.35;
    cloudCol = mix(shade, sunlit, lit);
    float edge = cov * (1.0 - cov) * 4.0;
    cloudCol += uSunColor * 0.5 * pow(mup, 10.0) * (edge * 0.8 + 0.25);
    cloudCol += uKeyColor * 0.12 * uNight;
    cov *= smoothstep(0.0, 0.14, y) * 0.95;
  }
  col += disc * (1.0 - cov) + night * (1.0 - cov * 0.9);
  col = mix(col, cloudCol, cov);

  // the horizon dissolves into the same haze the land fades into
  vec3 haze = hazeColor(rd);
  col = mix(col, haze, exp(-hy * 10.0) * 0.9);
  if (y < 0.0) col = haze;
  gl_FragColor = vec4(col, 1.0);
}
`;

export interface Sky {
  mesh: Mesh;
  zenith: Color;
  horizon: Color;
  moonDir: Vector3;
  cloud: { value: number };
}

export function buildSky(): Sky {
  const zenith = new Color();
  const horizon = new Color();
  const moonDir = new Vector3(0, 1, 0);
  const cloud = { value: 0.44 };
  const material = new ShaderMaterial({
    uniforms: { ...G, uZenith: { value: zenith }, uHorizon: { value: horizon }, uMoonDir: { value: moonDir }, uCloud: cloud },
    vertexShader: VERT,
    fragmentShader: FRAG,
    side: BackSide,
    depthWrite: false,
  });
  const mesh = new Mesh(new SphereGeometry(4000, 48, 24), material);
  mesh.frustumCulled = false;
  mesh.renderOrder = -10;
  mesh.name = 'sky';
  return { mesh, zenith, horizon, moonDir, cloud };
}
