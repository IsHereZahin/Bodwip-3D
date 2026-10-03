import {
  AddEquation,
  Color,
  CustomBlending,
  DataTexture,
  DataUtils,
  HalfFloatType,
  LinearFilter,
  LinearMipmapLinearFilter,
  Matrix4,
  Mesh,
  OneFactor,
  OneMinusSrcAlphaFactor,
  PlaneGeometry,
  RGBAFormat,
  RepeatWrapping,
  ShaderMaterial,
  Vector4,
} from 'three';
import type { Texture } from 'three';
import { G, LAYER_WATER } from '../core/globals';
import { periodicNoise } from '../core/noise';
import { GLSL_COMMON } from '../render/glsl';
import { HERO_HULL, hullWaterlineGlsl } from './hull';
import { WORLD_Z0, WORLD_Z1, downstream, halfWidth, riverX, terrainHeight } from './geography';

const FIELD_X0 = -620;
const FIELD_SX = 1240;
const FIELD_W = 256;
const FIELD_H = 1024;

/** Tiling ripple normals, generated once. */
function rippleNormals(maxAnisotropy: number): DataTexture {
  const N = 256;
  const h = new Float32Array(N * N);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const u = x / N;
      const v = y / N;
      const ridged = 1 - Math.abs(periodicNoise(u * 8, v * 8, 8, 1) * 2 - 1);
      h[y * N + x] =
        ridged * 0.45 +
        periodicNoise(u * 16, v * 16, 16, 2) * 0.3 +
        periodicNoise(u * 32, v * 32, 32, 3) * 0.16 +
        periodicNoise(u * 64, v * 64, 64, 4) * 0.08;
    }
  }
  const data = new Uint8Array(N * N * 4);
  const k = 7;
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const dx = h[y * N + ((x + 1) % N)] - h[y * N + ((x + N - 1) % N)];
      const dy = h[((y + 1) % N) * N + x] - h[((y + N - 1) % N) * N + x];
      const nx = -dx * k;
      const ny = -dy * k;
      const l = Math.hypot(nx, ny, 1);
      const i = (y * N + x) * 4;
      data[i] = Math.round((nx / l * 0.5 + 0.5) * 255);
      data[i + 1] = Math.round((ny / l * 0.5 + 0.5) * 255);
      data[i + 2] = Math.round((1 / l * 0.5 + 0.5) * 255);
      data[i + 3] = 255;
    }
  }
  const t = new DataTexture(data, N, N);
  t.wrapS = t.wrapT = RepeatWrapping;
  t.minFilter = LinearMipmapLinearFilter;
  t.magFilter = LinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = maxAnisotropy;
  t.needsUpdate = true;
  return t;
}

/** r: riverbed height, gb: surface current (m/s). Lets the water know its depth and flow anywhere. */
function riverField(): { texture: DataTexture; bounds: Vector4 } {
  const SZ = WORLD_Z0 - WORLD_Z1;
  const data = new Uint16Array(FIELD_W * FIELD_H * 4);
  for (let j = 0; j < FIELD_H; j++) {
    const z = WORLD_Z1 + ((j + 0.5) / FIELD_H) * SZ;
    const cx = riverX(z);
    const hw = halfWidth(z);
    const [fx, fz] = downstream(z);
    for (let i = 0; i < FIELD_W; i++) {
      const x = FIELD_X0 + ((i + 0.5) / FIELD_W) * FIELD_SX;
      const h = terrainHeight(x, z);
      const t = (x - cx) / hw;
      const speed = h < 0 ? 0.85 * Math.max(0, 1 - t * t) : 0;
      const k = (j * FIELD_W + i) * 4;
      data[k] = DataUtils.toHalfFloat(Math.max(-12, Math.min(12, h)));
      data[k + 1] = DataUtils.toHalfFloat(fx * speed);
      data[k + 2] = DataUtils.toHalfFloat(fz * speed);
      data[k + 3] = DataUtils.toHalfFloat(1);
    }
  }
  const texture = new DataTexture(data, FIELD_W, FIELD_H, RGBAFormat, HalfFloatType);
  texture.minFilter = texture.magFilter = LinearFilter;
  texture.needsUpdate = true;
  return { texture, bounds: new Vector4(FIELD_X0, WORLD_Z1, 1 / FIELD_SX, 1 / SZ) };
}

const VERT = /* glsl */ `
varying vec3 vWorld;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

const FRAG = /* glsl */ `
${GLSL_COMMON}
uniform sampler2D tRefl;
uniform mat4 uTexMatrix;
uniform sampler2D tNormal;
uniform sampler2D tField;
uniform vec4 uField;
uniform vec4 uBoat;      // x, z, heading, speed
uniform vec3 uAmb;
varying vec3 vWorld;

${hullWaterlineGlsl(HERO_HULL)}

vec2 ripple(vec2 uv) { return texture2D(tNormal, uv).xy * 2.0 - 1.0; }

// ---- the boat: Kelvin wake, rings round the hull, the sculling oar ----
float wakeField(vec2 q, float spd) {
  float L = ${(HERO_HULL.len / 2).toFixed(3)};
  float h = 0.0;
  float d = -q.y - L * 0.85;
  if (d > 0.0) {
    float ax = abs(q.x);
    // two diverging arms at the Kelvin angle (tan 19.5° ≈ 0.354)
    float arm = 0.6 + d * 0.354;
    float wdt = 0.45 + d * 0.05;
    float g = exp(-pow((ax - arm) / wdt, 2.0));
    h += g * sin(d * 2.4 - uTime * 4.2 + ax * 1.5) * exp(-d * 0.024);
    // transverse waves inside the V, and a churned trail behind the oar
    float inside = smoothstep(arm + 0.4, arm - 2.0, ax);
    h += inside * 0.45 * sin(d * 1.15 - uTime * 3.1) * exp(-d * 0.04);
  }
  // the hull rocks on the swell even at rest and pushes water aside with way on
  float s = clamp(q.y / L, -0.92, 0.92);
  float hb = 0.82 * sqrt(max(1.0 - s * s, 0.0)) + 0.05;
  float dd = length(vec2(max(abs(q.x) - hb, 0.0), q.y - s * L));
  h += 0.4 * exp(-dd * 0.55) * sin(dd * 5.0 - uTime * 3.4);
  // rings spreading from where the oar blade works
  vec2 oar = vec2(1.4, -L - 1.6);
  float ro = length(q - oar);
  h += 0.35 * exp(-ro * 0.45) * sin(ro * 6.0 - uTime * 5.0);
  return h * (0.35 + 0.65 * spd);
}

void main() {
  vec3 wp = vWorld;
  vec3 toCam = uCamPos - wp;
  float dist = length(toCam);
  vec3 V = toCam / dist;

  // boat frame: q.x across (to starboard), q.y along (toward the bow)
  float hd = uBoat.z;
  vec2 fw = vec2(sin(hd), cos(hd));
  vec2 rt = vec2(cos(hd), -sin(hd));
  vec2 bd = wp.xz - uBoat.xy;
  vec2 q = vec2(dot(bd, rt), dot(bd, fw));
  float sAlong = q.y / ${(HERO_HULL.len / 2).toFixed(3)};
  // no river inside the boat: its floorboards sit just above the waterline
  if (abs(sAlong) < 1.0 && abs(q.x) < hullHalfBeamAtWater(sAlong) * 0.96) discard;

  vec4 fld = texture2D(tField, (wp.xz - uField.xy) * uField.zw);
  float depth = max(-fld.r, 0.0);
  vec2 flow = fld.gb;
  float spd = length(flow);
  vec2 along = spd > 0.02 ? flow / spd : vec2(0.0, -1.0);
  vec2 across = vec2(-along.y, along.x);
  // the river's own frame: ripples are drawn out along the current, as moving water stretches them
  vec2 fp = vec2(dot(wp.xz, across), dot(wp.xz, along));

  // two-phase flow map: ripples drift with the current, without a visible reset
  float ph = uTime * 0.1;
  float p0 = fract(ph);
  float p1 = fract(ph + 0.5);
  float w0 = 1.0 - abs(2.0 * p0 - 1.0);
  vec2 uvA = fp / vec2(6.5, 17.0);
  vec2 adv = vec2(0.0, spd * 10.0 / 17.0);
  vec2 tA = ripple(uvA - adv * p0) * w0 + ripple(uvA - adv * p1 + 0.37) * (1.0 - w0);
  vec2 nA = across * tA.x + along * tA.y;
  // wind ripples, not advected
  vec2 nB = ripple(wp.xz / 3.2 + uWind.xy * uTime * 0.08 + vec2(0.13, 0.71));
  // a slow broad swell
  vec2 nC = ripple(wp.xz / 46.0 + vec2(uTime * 0.004, -uTime * 0.006));
  float far = 1.0 / (1.0 + dist * 0.01);
  vec2 slope = nA * 0.2 + nB * (0.06 + 0.1 * uWind.z) * far + nC * 0.1;

  float foam = 0.0;
  if (q.y > -180.0 && q.y < 12.0 && abs(q.x) < 75.0) {
    float spd = clamp(uBoat.w / 3.0, 0.0, 1.4);
    float e = 0.12;
    float hc = wakeField(q, spd);
    vec2 g = vec2(wakeField(q + vec2(e, 0.0), spd) - hc, wakeField(q + vec2(0.0, e), spd) - hc) / e;
    slope += (rt * g.x + fw * g.y) * 0.05;
    // thin streaky whitewater along the wake arms, never a solid sheet
    float d = -q.y - 3.8;
    if (d > 0.0) {
      float arm = 0.6 + d * 0.354;
      float g2 = exp(-pow((abs(q.x) - arm) / (0.35 + d * 0.03), 2.0));
      foam += g2 * exp(-d * 0.05) * smoothstep(0.45, 0.8, vnoise(vec2(q.x * 2.0, q.y * 0.6 + uTime * 0.8)));
    }
  }

  // flecks of foam and silt riding the current, thickest in the slack water by the banks
  vec2 fq = vec2(fp.x * 0.9, fp.y * 0.22);
  float fa = smoothstep(0.74, 0.92, vnoise(fq - vec2(0.0, spd * 2.2 * p0)));
  float fb = smoothstep(0.74, 0.92, vnoise(fq - vec2(0.0, spd * 2.2 * p1) + 3.7));
  foam += (fa * w0 + fb * (1.0 - w0)) * smoothstep(3.5, 0.6, depth) * 0.35 * far;

  vec3 N = normalize(vec3(-slope.x, 1.0, -slope.y));
  float NdV = max(dot(N, V), 0.0);
  float F = 0.02 + 0.98 * pow(1.0 - NdV, 5.0);

  // reflection (planar), distorted by the ripples
  vec4 rc = uTexMatrix * vec4(wp, 1.0);
  vec2 ruv = rc.xy / rc.w + N.xz * 0.05 / (1.0 + dist * 0.02);
  vec3 refl = texture2D(tRefl, clamp(ruv, vec2(0.001), vec2(0.999))).rgb;

  // Premultiplied: the surface reflects F of the light and lets the rest through to the riverbed, which
  // tints itself with the silty water it is seen through (see underwater()). Shallows show their bed.
  float keyUp = max(uKeyDir.y, 0.0);
  vec3 light = uAmb + uKeyColor * keyUp * 0.45;
  vec3 col = refl * F;
  float alpha = F;

  // sun (or moon) glitter
  vec3 H = normalize(uKeyDir + V);
  float nh = max(dot(N, H), 0.0);
  col += uKeyColor * (pow(nh, 1100.0) * 26.0 + pow(nh, 160.0) * 0.7) * step(0.0, uKeyDir.y);

  // a lapping line where the river meets the bank
  float shore = smoothstep(0.5, 0.06, depth) * smoothstep(0.0, 0.04, depth);
  foam += shore * smoothstep(0.35, 0.8, vnoise(wp.xz * 0.8 + vec2(uTime * 0.25, -uTime * 0.1)));
  vec3 foamCol = vec3(0.62, 0.58, 0.5) * light * 0.3183;
  float fA = clamp(foam, 0.0, 1.0) * 0.55;
  col = col * (1.0 - fA) + foamCol * fA;
  alpha = alpha * (1.0 - fA) + fA;

  // fog the premultiplied colour as if it were opaque, then weight it back by its coverage
  col = applyAtmosphere(col / max(alpha, 1e-3), wp) * alpha;
  gl_FragColor = vec4(col, alpha);
}
`;

export interface Water {
  mesh: Mesh;
  boat: Vector4;
  color: Color;
  ambient: Color;
}

export function buildWater(reflection: Texture, textureMatrix: Matrix4, maxAnisotropy: number): Water {
  const field = riverField();
  const boat = new Vector4();
  const color = new Color();
  const ambient = new Color();
  const material = new ShaderMaterial({
    uniforms: {
      ...G,
      tRefl: { value: reflection },
      uTexMatrix: { value: textureMatrix },
      tNormal: { value: rippleNormals(maxAnisotropy) },
      tField: { value: field.texture },
      uField: { value: field.bounds },
      uBoat: { value: boat },
      uAmb: { value: ambient },
    },
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    blending: CustomBlending,
    blendEquation: AddEquation,
    blendSrc: OneFactor,
    blendDst: OneMinusSrcAlphaFactor,
  });
  const SZ = WORLD_Z0 - WORLD_Z1;
  const geometry = new PlaneGeometry(1400, SZ, 8, 32);
  geometry.rotateX(-Math.PI / 2);
  const mesh = new Mesh(geometry, material);
  mesh.position.set(0, 0, (WORLD_Z0 + WORLD_Z1) / 2);
  mesh.layers.set(LAYER_WATER);
  // first of the see-through things, so fireflies and motes over the river draw on top of it
  mesh.renderOrder = -1;
  mesh.name = 'water';
  return { mesh, boat, color, ambient };
}

