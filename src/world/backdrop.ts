import { BufferAttribute, BufferGeometry, DoubleSide, Mesh, ShaderMaterial } from 'three';
import { G } from '../core/globals';
import { GLSL_COMMON } from '../render/glsl';
import { PLAIN, WORLD } from './plan';

// The land beyond the village is not there: past the world's edges it fades into the haze (glsl.ts
// EDGE_HAZE), and standing in the haze are the hills on the horizon, in three ranks one behind the other, each
// paler the farther it is, mist lying at their feet. A painted backdrop that costs almost nothing (three
// strips round the world, flat-shaded by the haze itself). The hills keep low along the river's line east and
// west, where the sun and the moon rise and set over the water, and stand higher to the north and south.

/** Each rank: how far beyond the world's edges (m), how high its hills rise at most (m), and how much of the haze is in it. */
const RANKS = [
  { beyond: 700, high: 62, haze: 0.22 },
  { beyond: 1300, high: 105, haze: 0.4 },
  { beyond: 2000, high: 155, haze: 0.56 },
] as const;
/** Segments round each rank. */
const SEGMENTS = 360;
/** How far below the plain each strip reaches, so no sky shows under it (m). */
const FOOT = 40;

const VERT = /* glsl */ `
${GLSL_COMMON}
attribute vec2 aRank;
varying vec3 vWorld;
varying vec2 vRank;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  vRank = aRank;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

const FRAG = /* glsl */ `
${GLSL_COMMON}
varying vec3 vWorld;
// x: how much of the haze is in this rank; y: the height of the hills over this point
varying vec2 vRank;
void main() {
  vec3 rd = normalize(vWorld - uCamPos);
  vec3 haze = hazeColor(rd);
  // the woods on the hills, dark green-grey, lit as the haze about them is
  vec3 body = haze * vec3(0.36, 0.47, 0.41);
  // mist lies along their feet and in the hollows between them
  float up = clamp((vWorld.y - ${PLAIN.toFixed(2)}) / max(vRank.y, 4.0), 0.0, 1.0);
  float k = clamp(vRank.x + 0.5 * (1.0 - smoothstep(0.0, 0.5, up)), 0.0, 1.0);
  // in winter the cloud lies along their flanks, the tops standing out of it
  k = clamp(k + uHillCloud * 0.45 * smoothstep(0.1, 0.45, up) * (1.0 - smoothstep(0.6, 0.95, up)), 0.0, 1.0);
  gl_FragColor = vec4(mix(body, haze, k), 1.0);
}`;

/** The height of a rank's hills at `angle` round the world (x along cos, z along sin): low east and west, higher north and south, rolling. */
function hillHeight(rank: number, angle: number): number {
  const phase = rank * 1.7;
  const roll =
    0.55 +
    0.24 * Math.sin(angle * 3 + 0.8 + phase) +
    0.14 * Math.sin(angle * 7 + 2.1 + phase * 1.3) +
    0.07 * Math.sin(angle * 17 + phase * 2.2) +
    0.04 * Math.sin(angle * 41 + phase * 3.1);
  const northSouth = Math.abs(Math.sin(angle));
  const along = 0.16 + 0.84 * Math.min(1, Math.max(0, (northSouth - 0.2) / 0.6)) ** 2;
  return RANKS[rank].high * along * Math.max(0.12, roll);
}

export function buildBackdrop(): Mesh {
  const cx = (WORLD.x0 + WORLD.x1) / 2;
  const cz = (WORLD.z0 + WORLD.z1) / 2;
  const hx = (WORLD.x1 - WORLD.x0) / 2;
  const hz = (WORLD.z1 - WORLD.z0) / 2;
  const pos: number[] = [];
  const rank: number[] = [];
  const index: number[] = [];
  RANKS.forEach((r, k) => {
    const first = pos.length / 3;
    for (let i = 0; i <= SEGMENTS; i++) {
      const a = (i / SEGMENTS) * Math.PI * 2;
      const x = cx + Math.cos(a) * (hx + r.beyond);
      const z = cz + Math.sin(a) * (hz + r.beyond);
      const h = hillHeight(k, a);
      pos.push(x, PLAIN - FOOT, z, x, PLAIN + h, z);
      rank.push(r.haze, h, r.haze, h);
    }
    for (let i = 0; i < SEGMENTS; i++) {
      const a = first + i * 2;
      index.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
  });
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  geometry.setAttribute('aRank', new BufferAttribute(new Float32Array(rank), 2));
  geometry.setIndex(index);
  const material = new ShaderMaterial({ uniforms: { ...G }, vertexShader: VERT, fragmentShader: FRAG, side: DoubleSide });
  const mesh = new Mesh(geometry, material);
  mesh.name = 'backdrop';
  mesh.frustumCulled = false;
  return mesh;
}
