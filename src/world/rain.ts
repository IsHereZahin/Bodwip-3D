import { DoubleSide, InstancedBufferAttribute, InstancedBufferGeometry, Mesh, PlaneGeometry, ShaderMaterial } from 'three';
import { G, LAYER_NO_REFLECT } from '../core/globals';
import { Rng } from '../core/rng';
import { WIND_MS } from '../env/wind';
import { GLSL_COMMON } from '../render/glsl';

// Rain: streaks falling through a box that travels with the camera, thicker the harder it rains, and gone
// below the water's surface. Each drop falls through the moving air, so it drifts downwind as it falls:
// for every metre it drops it travels (wind ÷ fall speed) metres with the wind, in the gust where it is,
// the same wind (env/wind.ts, windGust) that bends the trees and grass beside it. Its streak runs back up
// along its path, toward where it came from. The rings the drops make on the water are drawn by the water
// shader from G.uRain.

const DROPS = 9000;
/** The box of falling rain round the camera: across, and height. */
const BOX = 44;
const HEIGHT = 26;
/** How fast a drop falls (m/s), and the length and width of its streak (m). */
const FALL = 7.5;

const VERT = /* glsl */ `
${GLSL_COMMON}
attribute vec3 aSeed;
varying float vAlpha;
void main() {
  // each drop falls through the box again and again; the box follows the camera and wraps round it
  float h = fract(aSeed.y - uTime * ${FALL.toFixed(1)} / ${HEIGHT.toFixed(1)});
  vec2 base = uCamPos.xz + (fract(aSeed.xz - uCamPos.xz / ${BOX.toFixed(1)}) - 0.5) * ${BOX.toFixed(1)};
  // the air's velocity where the drop is (m/s) over its fall speed: how far downwind it goes per metre
  vec2 drift = uWind.xy * uWind.z * windGust(base) * ${WIND_MS.toFixed(1)} / ${FALL.toFixed(1)};
  float y = uCamPos.y - ${(HEIGHT * 0.35).toFixed(2)} + h * ${HEIGHT.toFixed(1)};
  // higher up, it is still upwind of where it will land
  vec3 at = vec3(base.x - drift.x * (y - uCamPos.y), y, base.y - drift.y * (y - uCamPos.y));
  // a streak back along its path, turned to face the camera
  vec3 axis = normalize(vec3(-drift.x, 1.0, -drift.y));
  vec3 side = normalize(cross(axis, at - uCamPos));
  float near = length(at - uCamPos);
  // about a pixel wide wherever it is, so near drops are not blots
  vec3 p = at + axis * position.y * 0.42 + side * position.x * 0.0016 * near;
  vAlpha = uRain * smoothstep(2.0, 4.5, near) * (1.0 - smoothstep(12.0, 22.0, near)) * step(uWaterLevel, y);
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}
`;

const FRAG = /* glsl */ `
${GLSL_COMMON}
varying float vAlpha;
void main() {
  if (vAlpha < 0.003) discard;
  // the streaks catch the grey light of the sky, brighter than the sky behind them
  vec3 col = uFogColor * 1.25 + vec3(0.03) + uKeyColor * 0.04;
  gl_FragColor = vec4(col, vAlpha * 0.3);
}
`;

export function buildRain(): Mesh {
  const quad = new PlaneGeometry(1, 1).translate(0, 0.5, 0);
  const geometry = new InstancedBufferGeometry();
  geometry.index = quad.index;
  geometry.setAttribute('position', quad.getAttribute('position'));
  const rng = new Rng(17);
  const seeds = new Float32Array(DROPS * 3);
  for (let i = 0; i < seeds.length; i++) seeds[i] = rng.next();
  geometry.setAttribute('aSeed', new InstancedBufferAttribute(seeds, 3));
  geometry.instanceCount = DROPS;
  const mesh = new Mesh(
    geometry,
    // two-sided: a streak is turned to face the camera about its own length, and which face that shows depends on the slant
    new ShaderMaterial({ uniforms: { ...G }, vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthWrite: false, side: DoubleSide }),
  );
  mesh.frustumCulled = false;
  mesh.layers.set(LAYER_NO_REFLECT);
  mesh.renderOrder = 5;
  mesh.name = 'rain';
  return mesh;
}
