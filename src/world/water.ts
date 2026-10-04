import {
  AddEquation,
  BufferAttribute,
  BufferGeometry,
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
  RGBAFormat,
  RepeatWrapping,
  ShaderMaterial,
  Vector4,
} from 'three';
import type { Texture } from 'three';
import { G, LAYER_WATER } from '../core/globals';
import { periodicNoise } from '../core/noise';
import { GLSL_COMMON } from '../render/glsl';
import { HERO_HULL, HERO_SINK, hullWaterlineGlsl } from './hull';
import { wakeGlsl } from './wake';
import { SHELTERED, waveHeightLodGlsl, waveSlopeGlsl } from './waves';
import { WORLD_U, WORLD_Z0, WORLD_Z1, downstream, edgeHalfWidth, halfWidth, islandCoast, riverX, streamSpeed, terrainHeight } from './geography';

/** The fine field over the channel and its backwaters: about 3 m a texel across, so the khals and the bil's channels have a depth of their own. */
const FIELD = { x0: -620, sx: 1240, w: 384, h: 1280 };
/** The wide field out to the open sea west of the island (and the mainland's edge east), coarser. */
const FIELD_WIDE = { x0: -WORLD_U - 100, sx: (WORLD_U + 100) * 2, w: 384, h: 640 };

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

/**
 * r: the bed's height, gb: the surface current (m/s), a: how open the water is to the wind and the swell
 * (1 in the channel and out on the sea, 0 in the khals, the bil, the ponds and the creeks, which lie still).
 * Lets the water know its depth, its flow and its shelter anywhere.
 */
function riverField(o: { x0: number; sx: number; w: number; h: number }): { texture: DataTexture; bounds: Vector4 } {
  const SZ = WORLD_Z0 - WORLD_Z1;
  const data = new Uint16Array(o.w * o.h * 4);
  for (let j = 0; j < o.h; j++) {
    const z = WORLD_Z1 + ((j + 0.5) / o.h) * SZ;
    const cx = riverX(z);
    const hw = halfWidth(z);
    const [fx, fz] = downstream(z);
    const mid = streamSpeed(z);
    for (let i = 0; i < o.w; i++) {
      const x = o.x0 + ((i + 0.5) / o.w) * o.sx;
      const h = terrainHeight(x, z);
      const u = x - cx;
      const t = u / hw;
      const speed = h < 0 ? mid * Math.max(0, 1 - t * t) : 0;
      const inChannel = Math.abs(u) < edgeHalfWidth(z, u >= 0 ? 1 : -1) + 6;
      const atSea = u > 0 && islandCoast(z, u) < -10;
      const k = (j * o.w + i) * 4;
      data[k] = DataUtils.toHalfFloat(Math.max(-12, Math.min(12, h)));
      data[k + 1] = DataUtils.toHalfFloat(fx * speed);
      data[k + 2] = DataUtils.toHalfFloat(fz * speed);
      data[k + 3] = DataUtils.toHalfFloat(h < 0 && (inChannel || atSea) ? 1 : 0);
    }
  }
  const texture = new DataTexture(data, o.w, o.h, RGBAFormat, HalfFloatType);
  texture.minFilter = texture.magFilter = LinearFilter;
  texture.needsUpdate = true;
  return { texture, bounds: new Vector4(o.x0, WORLD_Z1, 1 / o.sx, 1 / SZ) };
}

/** GLSL: the water field at p, from the fine one over the channel or the wide one beyond it. */
const FIELD_GLSL = /* glsl */ `
vec4 waterField(vec2 p) {
  vec2 f = (p - uField.xy) * uField.zw;
  vec4 fine = texture2D(tField, f);
  vec4 wide = texture2D(tFieldWide, (p - uFieldWide.xy) * uFieldWide.zw);
  return f.x > 0.01 && f.x < 0.99 ? fine : wide;
}`;

/** Angular segments of the water's grid; its vertices lie this share of their distance from the camera apart. */
const GRID_SEGMENTS = 256;
const GRID_SPACING = (Math.PI * 2) / GRID_SEGMENTS;
/** Out to here (m) the grid is fine enough to carry waves; beyond, its rings widen fast to the world's edge. */
const GRID_WAVES = 300;
const GRID_FAR = 6000;
/** The water's extent (x0, z0, x1, z1): the world's, and the open Bay on to the horizon west and south. */
const WATER_BOUNDS = new Vector4(-WORLD_U, WORLD_Z1 - 5000, WORLD_U + 4000, WORLD_Z0);

/**
 * The water's mesh: rings round the camera, each a little wider than the last, so its vertices lie about as
 * far apart as a pixel's worth of distance needs (centimetres under the camera, metres far off). The vertex
 * shader moves it with the camera; nothing is snapped, so each wave is drawn only where the vertices lie
 * close enough to draw it, and the surface does not shimmer as the camera moves.
 */
function waterGrid(): BufferGeometry {
  const radii: number[] = [];
  let r = 0.6;
  while (r < GRID_WAVES) {
    radii.push(r);
    r *= 1 + GRID_SPACING;
  }
  while (r < GRID_FAR) {
    radii.push(r);
    r *= 1.25;
  }
  radii.push(r);
  const n = GRID_SEGMENTS;
  const pos = new Float32Array((1 + radii.length * n) * 3);
  radii.forEach((radius, i) => {
    for (let j = 0; j < n; j++) {
      const a = (j / n) * Math.PI * 2;
      const k = (1 + i * n + j) * 3;
      pos[k] = Math.cos(a) * radius;
      pos[k + 2] = Math.sin(a) * radius;
    }
  });
  const index: number[] = [];
  // a fan under the camera, then a band of quads between each ring and the next (wound to face up)
  for (let j = 0; j < n; j++) index.push(0, 1 + ((j + 1) % n), 1 + j);
  for (let i = 0; i + 1 < radii.length; i++) {
    for (let j = 0; j < n; j++) {
      const a = 1 + i * n + j;
      const b = 1 + i * n + ((j + 1) % n);
      index.push(a, b, b + n, a, b + n, a + n);
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(pos, 3));
  g.setIndex(index);
  return g;
}

const VERT = /* glsl */ `
${GLSL_COMMON}
uniform sampler2D tField;
uniform vec4 uField;
uniform sampler2D tFieldWide;
uniform vec4 uFieldWide;
uniform vec4 uBoat;
uniform vec4 uOar;
uniform vec4 uBounds;
varying vec3 vWorld;
varying float vWave;
${FIELD_GLSL}
${waveHeightLodGlsl()}
${wakeGlsl()}
void main() {
  // the grid round the camera, laid on the world and kept to the water's extent
  vec2 local = position.xz;
  float spacing = max(length(local), 0.6) * ${GRID_SPACING.toFixed(5)};
  vec2 xz = clamp(uCamPos.xz + local, uBounds.xy, uBounds.zw);
  vec4 fld = waterField(xz);
  float depth = max(uWaterLevel - fld.r, 0.0);
  // still water carries a share of the open water's waves, and they die out on the shallows by the shore
  float running = max(smoothstep(0.0, 0.2, length(fld.gb) * uFlowScale), fld.a);
  float shoal = smoothstep(0.0, 0.6, depth);
  float h = waveHeightLod(xz, spacing) * mix(${SHELTERED.toFixed(2)}, 1.0, running) * shoal;
  vWave = h;
  // the water the boat pushes aside
  vec2 bd = xz - uBoat.xy;
  if (abs(bd.x) + abs(bd.y) < 150.0) {
    vec2 q = vec2(dot(bd, vec2(cos(uBoat.z), -sin(uBoat.z))), dot(bd, vec2(sin(uBoat.z), cos(uBoat.z))));
    h += boatWake(q, uBoat.w, uOar, spacing) * shoal;
  }
  vWorld = vec3(xz.x, uWaterLevel + h, xz.y);
  gl_Position = projectionMatrix * viewMatrix * vec4(vWorld, 1.0);
}
`;

const FRAG = /* glsl */ `
${GLSL_COMMON}
uniform sampler2D tRefl;
uniform mat4 uTexMatrix;
uniform sampler2D tNormal;
uniform sampler2D tField;
uniform vec4 uField;
uniform sampler2D tFieldWide;
uniform vec4 uFieldWide;
uniform vec4 uBoat;      // x, z, heading, speed through the water
uniform vec4 uOar;       // the paddle's blade in the boat's frame (x across, z along), how hard it pulls, how deep it is (0..1)
uniform vec4 uSwirl;     // where the blade last came out (world x, z), seconds since, how hard it had pulled
uniform vec4 uNetA0;     // the lift net nearest the camera: its square's middle (x, z), half its side, its yaw
uniform vec4 uNetB0;     // ... how hard its rim is cutting the surface, how much water is running out of it
uniform vec4 uNetA1;     // the next nearest
uniform vec4 uNetB1;
uniform vec3 uAmb;
varying vec3 vWorld;
varying float vWave;

${FIELD_GLSL}
${hullWaterlineGlsl(HERO_HULL, HERO_SINK)}
${waveSlopeGlsl()}
${wakeGlsl()}

vec2 ripple(vec2 uv) { return texture2D(tNormal, uv).xy * 2.0 - 1.0; }

// rings spreading from raindrops: in each cell of two offset grids a drop lands now and then, and its
// ring widens and fades (squared by hand: pow() of a negative base is undefined in GLSL)
vec2 rainRings(vec2 p) {
  vec2 s = vec2(0.0);
  for (int i = 0; i < 2; i++) {
    vec2 q = p * (1.6 + float(i) * 0.9) + float(i) * 7.3;
    vec2 c = floor(q);
    float h = hash12(c + float(i) * 13.0);
    float ph = fract(uTime * (0.9 + h) + h * 7.0);
    vec2 o = fract(q) - 0.5 - (vec2(hash12(c + 3.1), hash12(c + 5.7)) - 0.5) * 0.6;
    float d = length(o);
    float k = (d - ph * 0.45) * 18.0;
    s += o / max(d, 1e-3) * exp(-k * k) * (1.0 - ph);
  }
  return s;
}

// a lift net: rings spreading from its square's rim as it comes up through the surface or goes in, foam
// where it cuts the water, and drops pattering inside the square once it is up (separate uniforms rather
// than an indexed array, which ANGLE runs slowly)
void netRings(vec4 na, vec4 nb, vec2 p, inout vec2 slope, inout float foam) {
  if (nb.x + nb.y < 0.01) return;
  vec2 o = p - na.xy;
  vec2 ax = vec2(cos(na.w), -sin(na.w));
  vec2 az = vec2(sin(na.w), cos(na.w));
  vec2 l = vec2(dot(o, ax), dot(o, az));
  vec2 e = abs(l) - na.z;
  float edge = length(max(e, 0.0)) + min(max(e.x, e.y), 0.0);
  float ae = abs(edge);
  if (ae < 5.0 && nb.x > 0.01) {
    vec2 nl = edge > 0.0 ? normalize(max(e, 0.0) + 1e-4) * sign(l) : (e.x > e.y ? vec2(sign(l.x), 0.0) : vec2(0.0, sign(l.y)));
    vec2 nw = (ax * nl.x + az * nl.y) * (edge > 0.0 ? 1.0 : -1.0);
    slope += nw * cos(ae * 8.0 - uTime * 6.5) * exp(-ae * 0.9) * nb.x * 0.22;
    foam += nb.x * exp(-ae * 4.0) * 0.35 * smoothstep(0.35, 0.75, vnoise(p * 6.0 + uTime * 2.0));
  }
  if (nb.y > 0.01 && e.x < 0.0 && e.y < 0.0) slope += rainRings(p * 1.4 + 11.0) * nb.y * 0.5;
}

// ---- the boat: fine rings for the shading (her bow wave, wake and the blade's push are boatWake's) ----
float boatRipples(vec2 q, float spd) {
  float L = ${(HERO_HULL.len / 2).toFixed(3)};
  // the hull rocking on the waves sends little rings off her sides, livelier with way on
  float s = clamp(q.y / L, -0.92, 0.92);
  float hb = 0.82 * sqrt(max(1.0 - s * s, 0.0)) + 0.05;
  float dd = length(vec2(max(abs(q.x) - hb, 0.0), q.y - s * L));
  float h = 0.4 * exp(-dd * 0.55) * sin(dd * 5.0 - uTime * 3.4) * (0.35 + 0.65 * spd);
  // rings spreading from where the blade pulls, only while it is in the water
  float ro = length(q - uOar.xy);
  h += 0.12 * min(uOar.z, 4.0) * uOar.w * exp(-ro * 0.6) * sin(ro * 7.0 - uTime * 6.0);
  return h;
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
  float boatSpd = clamp(uBoat.w / 2.0, 0.0, 1.4);

  vec4 fld = waterField(wp.xz);
  float depth = max(uWaterLevel - fld.r, 0.0);
  // the season sets the river's pace: fast and full in the rains, slack in the dry months
  vec2 flow = fld.gb * uFlowScale;
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
  vec2 nB = ripple(wp.xz / 3.2 - uWind.xy * uTime * 0.08 + vec2(0.13, 0.71));
  // a slow broad swell
  vec2 nC = ripple(wp.xz / 46.0 + vec2(uTime * 0.004, -uTime * 0.006));
  float far = 1.0 / (1.0 + dist * 0.01);
  // still water (the bil, the khals, the slack by the banks) lies glassier than the running channel and the open sea
  float running = max(smoothstep(0.0, 0.2, spd), fld.a);
  vec2 slope = nA * (0.07 + 0.13 * running) + nB * (0.06 + 0.1 * uWind.z) * (0.6 + 0.4 * running) * far + nC * (0.04 + 0.06 * running);
  // the wind's waves the boat and the floating plants ride (see waves.ts), as the surface stands on them,
  // damped where the water is sheltered and dying out on the shallows; under a gust front the ripples
  // darken and roughen the water (cat's paws)
  float shoal = smoothstep(0.0, 0.6, depth);
  slope += waveSlope(wp.xz) * mix(${SHELTERED.toFixed(2)}, 1.0, running) * shoal;
  slope += nB * 0.1 * uWind.z * max(windGust(wp.xz) - 1.0, 0.0) * far;
  // rain: every drop rings the surface (the chop it raises comes with the waves above)
  if (uRain > 0.01) slope += rainRings(wp.xz) * uRain * far;
  // a strong wind breaks the tops of the waves into whitecaps, streaked downwind, under the gusts
  // (none at all below a fresh breeze, even in its gusts: then the noise is not worth reading)
  float whitecaps = 0.0;
  if (uWind.z * (1.0 + uWind.w) > 1.4) {
    float blow = uWind.z * windGust(wp.xz);
    vec2 wq = vec2(dot(wp.xz, vec2(-uWind.y, uWind.x)) * 2.2, dot(wp.xz, uWind.xy) * 0.55 - uTime * 0.9);
    float crest = vnoise(wq) * 0.65 + vnoise(wq * 2.7 + 3.1) * 0.35;
    whitecaps = smoothstep(1.4, 2.6, blow) * smoothstep(0.72, 0.9, crest) * (0.5 + 0.5 * vnoise(wp.xz * 0.15 - uTime * 0.05));
  }

  float foam = whitecaps * 0.6 * running;
  // in a strong wind the highest crests break, white for a moment in ragged patches, streaked away downwind
  float crest = smoothstep(0.4, 0.8, vWave / max(uSea.x, 0.02));
  if (crest > 0.0) {
    vec2 cq = vec2(dot(wp.xz, vec2(-uWind.y, uWind.x)) * 4.0, dot(wp.xz, uWind.xy) * 1.3 - uTime * 1.5);
    float rag = vnoise(cq) * 0.6 + vnoise(cq * 2.9 + 1.7) * 0.4;
    foam += crest * smoothstep(1.3, 2.4, uWind.z) * smoothstep(0.6, 0.78, rag) * 0.75;
  }
  // water lapping along the hull at the waterline, livelier with way on
  if (abs(sAlong) < 1.0) {
    float edge = abs(q.x) - hullHalfBeamAtWater(sAlong);
    foam += smoothstep(0.28, 0.0, edge) * (0.3 + 0.4 * boatSpd) * smoothstep(0.35, 0.7, vnoise(vec2(q.y * 3.0 - uTime * 1.5, q.x * 9.0)));
  }
  if (q.y > -180.0 && q.y < 12.0 && abs(q.x) < 75.0) {
    // the slopes of the water she pushes aside (as the surface stands on it, see wake.ts), and the fine rings
    float e = 0.08;
    float hc = boatWake(q, uBoat.w, uOar, 0.0);
    vec2 g = vec2(boatWake(q + vec2(e, 0.0), uBoat.w, uOar, 0.0) - hc, boatWake(q + vec2(0.0, e), uBoat.w, uOar, 0.0) - hc) / e;
    float rc = boatRipples(q, boatSpd);
    g += vec2(boatRipples(q + vec2(0.12, 0.0), boatSpd) - rc, boatRipples(q + vec2(0.0, 0.12), boatSpd) - rc) / 0.12 * 0.05;
    slope += (rt * g.x + fw * g.y) * shoal;
    // a paddled boat raises no white water, only a little curl at her stem where the water heaps highest
    // (most in a strong stroke's surge) and some froth along her wake's arms close astern, soon gone
    foam += smoothstep(0.03, 0.08, hc) * smoothstep(0.45, 0.8, vnoise(q * 6.0 + vec2(0.0, uTime * 2.5))) * 0.6;
    float d = ${(HERO_HULL.len * 0.32).toFixed(3)} - q.y;
    if (d > 0.0) {
      float arm = 0.66 + d * 0.3536;
      float wa = (abs(q.x) - arm) / (0.25 + d * 0.03);
      foam += exp(-wa * wa) * exp(-d * 0.12) * smoothstep(1.2, 2.0, uBoat.w) * smoothstep(0.55, 0.85, vnoise(vec2(q.x * 3.0, q.y * 1.4 + uTime * 0.8))) * 0.4;
    }
  }

  // the paddle: white water where the blade bites, and the eddies it leaves where it came out
  float rb = length(q - uOar.xy);
  foam += uOar.w * smoothstep(0.6, 0.0, rb) * (0.25 + 0.12 * min(uOar.z, 4.0)) * smoothstep(0.3, 0.75, vnoise(q * 7.0 + uTime * 3.0));
  vec2 sd = wp.xz - uSwirl.xy;
  float sr = length(sd);
  if (sr < 3.0 && uSwirl.w > 0.0) {
    float age = uSwirl.z;
    // squared by hand: pow() of a negative base is undefined in GLSL
    float rr = (sr - 0.2 - age * 0.45) / (0.12 + age * 0.06);
    float ring = exp(-rr * rr) * exp(-age * 1.1) * uSwirl.w;
    slope += sd / max(sr, 1e-3) * ring * 0.18;
    // the dimple turning at the eddy's heart
    slope += vec2(-sd.y, sd.x) * exp(-sr * sr * 6.0) * exp(-age * 1.4) * uSwirl.w * 0.6;
    foam += ring * 0.35 * smoothstep(0.4, 0.8, vnoise(wp.xz * 9.0 + uTime));
  }

  netRings(uNetA0, uNetB0, wp.xz, slope, foam);
  netRings(uNetA1, uNetB1, wp.xz, slope, foam);

  // flecks of foam and silt riding the current, thickest in the slack water by the banks (none on still water)
  vec2 fq = vec2(fp.x * 0.9, fp.y * 0.22);
  float fa = smoothstep(0.74, 0.92, vnoise(fq - vec2(0.0, spd * 2.2 * p0)));
  float fb = smoothstep(0.74, 0.92, vnoise(fq - vec2(0.0, spd * 2.2 * p1) + 3.7));
  foam += (fa * w0 + fb * (1.0 - w0)) * smoothstep(3.5, 0.6, depth) * smoothstep(0.03, 0.25, spd) * 0.35 * far;

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
  col += uKeyColor * (pow(nh, 1100.0) * 26.0 + pow(nh, 160.0) * 0.7) * step(0.0, uKeyDir.y) * (1.0 - uOvercast);

  // a lapping line where the river meets the bank, faint round still water
  float shore = smoothstep(0.5, 0.06, depth) * smoothstep(0.0, 0.04, depth) * (0.35 + 0.65 * smoothstep(0.03, 0.25, spd));
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

/** For the two lift nets nearest the camera: a = (x, z, half-side, yaw) of the net's square, b = (splash, drip, 0, 0). */
export interface NetRipples {
  a: [Vector4, Vector4];
  b: [Vector4, Vector4];
}

export interface Water {
  mesh: Mesh;
  /** The hero boat: x, z, heading, speed through the water. */
  boat: Vector4;
  /** Its paddle blade in the boat's frame (x across, z along), how hard it pulls, how deep it is (0..1). */
  oar: Vector4;
  /** The eddy the blade left where it last came out: world x, z, seconds since, strength. */
  swirl: Vector4;
  /** The rings of the two lift nets nearest the camera. */
  nets: NetRipples;
  color: Color;
  ambient: Color;
}

export function buildWater(reflection: Texture, textureMatrix: Matrix4, maxAnisotropy: number): Water {
  const field = riverField(FIELD);
  const wide = riverField(FIELD_WIDE);
  const boat = new Vector4();
  const oar = new Vector4();
  const swirl = new Vector4(0, 0, 99, 0);
  const nets: NetRipples = { a: [new Vector4(), new Vector4()], b: [new Vector4(), new Vector4()] };
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
      tFieldWide: { value: wide.texture },
      uFieldWide: { value: wide.bounds },
      uBoat: { value: boat },
      uOar: { value: oar },
      uSwirl: { value: swirl },
      uNetA0: { value: nets.a[0] },
      uNetB0: { value: nets.b[0] },
      uNetA1: { value: nets.a[1] },
      uNetB1: { value: nets.b[1] },
      uAmb: { value: ambient },
      uBounds: { value: WATER_BOUNDS },
    },
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    blending: CustomBlending,
    blendEquation: AddEquation,
    blendSrc: OneFactor,
    blendDst: OneMinusSrcAlphaFactor,
  });
  const mesh = new Mesh(waterGrid(), material);
  // the vertex shader lays the grid round the camera, so its bounds mean nothing to culling
  mesh.frustumCulled = false;
  mesh.layers.set(LAYER_WATER);
  // first of the see-through things, so fireflies and motes over the river draw on top of it
  mesh.renderOrder = -1;
  mesh.name = 'water';
  return { mesh, boat, oar, swirl, nets, color, ambient };
}

