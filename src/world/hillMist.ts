import { InstancedBufferAttribute, InstancedBufferGeometry, Mesh, PlaneGeometry, ShaderMaterial } from 'three';
import { G } from '../core/globals';
import { Rng } from '../core/rng';
import { GLSL_COMMON } from '../render/glsl';
import { WATER_LEVEL, hillHeight, terrainHeight } from './geography';
import { HILLS } from './plan';

// Cloud lying on the hills (the user's ask: in winter the cloud gathers on them): soft banks of it clinging to
// the slopes and drifting over the tops, thickest on winter mornings and evenings, some in the rains, none in a
// dry spring noon (`G.uHillCloud`, set by main.ts from the season, the hour and the rain). Each bank is a soft
// billboard, drawn in the haze's own colour with the light on its top, drifting slowly downwind, thinning to
// nothing near the camera so a camera passing through one is never blinded.

/** Banks on a hill by the water, and on one on the horizon. */
const NEAR_BANKS = 24;
const FAR_BANKS = 10;

const VERT = /* glsl */ `
${GLSL_COMMON}
attribute vec4 aBank;
attribute float aSeed;
varying vec2 vUv;
varying vec3 vWorld;
varying float vSeed;
varying float vSize;
void main() {
  vUv = position.xy;
  vSeed = aSeed;
  vSize = aBank.w;
  // drifting slowly downwind and back, each its own way
  vec3 c = aBank.xyz + vec3(uWind.x, 0.0, uWind.y) * sin(uTime * 0.02 + aSeed * 6.0) * aBank.w * 0.35;
  c.y += sin(uTime * 0.05 + aSeed * 11.0) * 1.5;
  // a camera-facing card, wider than it is tall, as a cloud bank lies
  vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  vec3 w = c + right * position.x * aBank.w + up * position.y * aBank.w * 0.32;
  vWorld = w;
  gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.0);
}`;

const FRAG = /* glsl */ `
${GLSL_COMMON}
varying vec2 vUv;
varying vec3 vWorld;
varying float vSeed;
varying float vSize;
void main() {
  if (uHillCloud < 0.01) discard;
  // a soft, ragged bank: round falloff broken by slowly churning noise
  vec2 q = vUv * vec2(1.0, 1.25);
  float r = length(q);
  float n = fbm3(vUv * vec2(1.6, 3.0) + vec2(vSeed * 7.0, vSeed * 3.0) + vec2(uTime * 0.012, -uTime * 0.008));
  float body = smoothstep(0.95, 0.05, r + (n - 0.5) * 0.7);
  body *= body;
  // thinning to nothing at its bottom, where it melts into the trees: a card cut by the crowns would show a
  // hard edge there
  body *= smoothstep(-0.85, -0.05, vUv.y);
  // gone near the camera
  float near = smoothstep(vSize * 0.25, vSize * 0.9, distance(vWorld, uCamPos));
  float alpha = body * near * uHillCloud * 0.5;
  if (alpha < 0.004) discard;
  vec3 rd = normalize(vWorld - uCamPos);
  vec3 haze = hazeColor(rd);
  // lit from above by the key light, the sky's grey below
  vec3 col = haze * 1.08 + uKeyColor * max(uKeyDir.y, 0.0) * 0.35 * smoothstep(-0.3, 0.4, vUv.y);
  gl_FragColor = vec4(applyAtmosphere(col, vWorld), alpha);
}`;

export function buildHillMist(): Mesh {
  const rng = new Rng(77);
  const banks: number[] = [];
  const seeds: number[] = [];
  for (const hill of HILLS) {
    const n = hill.steep !== undefined ? NEAR_BANKS : FAR_BANKS;
    const s = Math.sin(hill.yaw);
    const c = Math.cos(hill.yaw);
    for (let k = 0; k < n; k++) {
      const a = rng.range(0, Math.PI * 2);
      const d = Math.sqrt(rng.next()) * hill.r * 0.9;
      const la = Math.cos(a) * d * hill.stretch;
      const lb = Math.sin(a) * d;
      const x = hill.x + la * s + lb * c;
      const z = hill.z + la * c - lb * s;
      const size = hill.steep !== undefined ? rng.range(55, 95) : rng.range(90, 150);
      // over the slope, above the crowns under any part of it, or lying on the top: the highest ground
      // within its reach (a card is as tall as 0.32 of its size, each way)
      let ground = terrainHeight(x, z);
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2;
        ground = Math.max(ground, terrainHeight(x + Math.cos(a) * size * 0.4, z + Math.sin(a) * size * 0.4));
      }
      // most lie along the flanks, some over the tops, a few low at the foot by the water
      const over = rng.next() < 0.2 ? rng.range(-hill.h * 0.4, -hill.h * 0.2) : hillHeight(x, z) > hill.h * 0.7 ? rng.range(10, 18) : rng.range(12, 22);
      banks.push(x, Math.max(ground + over, WATER_LEVEL + 4), z, size);
      seeds.push(rng.next());
    }
  }
  const quad = new PlaneGeometry(2, 2);
  const geometry = new InstancedBufferGeometry();
  geometry.index = quad.index;
  geometry.setAttribute('position', quad.getAttribute('position'));
  geometry.setAttribute('aBank', new InstancedBufferAttribute(new Float32Array(banks), 4));
  geometry.setAttribute('aSeed', new InstancedBufferAttribute(new Float32Array(seeds), 1));
  geometry.instanceCount = seeds.length;
  const material = new ShaderMaterial({
    uniforms: { ...G },
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    depthWrite: false,
  });
  const mesh = new Mesh(geometry, material);
  mesh.name = 'hill-mist';
  mesh.frustumCulled = false;
  mesh.renderOrder = 3;
  return mesh;
}
