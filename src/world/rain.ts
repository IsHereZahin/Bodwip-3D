import { DoubleSide, InstancedBufferAttribute, InstancedBufferGeometry, Mesh, PlaneGeometry, ShaderMaterial, Vector3 } from 'three';
import { G, LAYER_NO_REFLECT } from '../core/globals';
import { Rng } from '../core/rng';
import { WIND_MS } from '../env/wind';
import { GLSL_COMMON } from '../render/glsl';
import { BRIDGE, bridgeDeck, bridgeFrame, terrainHeight, waterLevelAt } from './geography';

// Rain: streaks falling through a box that travels with the camera, thicker the harder it rains, and gone
// below the water's surface. Each drop falls through the moving air, so it drifts downwind as it falls:
// for every metre it drops it travels (wind ÷ fall speed) metres with the wind, in the gust where it is,
// the same wind (env/wind.ts, windGust) that bends the trees and grass beside it. Its streak runs back up
// along its path, toward where it came from. A light rain is fewer drops, not fainter ones; a downpour is all of
// them, their streaks longer. Where they strike: on the water, the rings (the water shader, from G.uRain and
// GLSL_COMMON's rainDrop) and a crown of water thrown up by each (buildRainSplashes, from the same drops); on the
// land, the ghats and the bridge, a splash where each lands (GroundSplashes).

const DROPS = 14000;
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
  // a streak back along its path, turned to face the camera, longer in a downpour
  vec3 axis = normalize(vec3(-drift.x, 1.0, -drift.y));
  vec3 side = normalize(cross(axis, at - uCamPos));
  float near = length(at - uCamPos);
  // about a pixel wide wherever it is, so near drops are not blots
  vec3 p = at + axis * position.y * (0.3 + 0.28 * uRain) + side * position.x * 0.0016 * near;
  // the lighter the rain, the fewer of the drops fall (each has its own threshold)
  float falls = step(fract(aSeed.x * 13.7 + aSeed.z * 7.1), 0.15 + 0.85 * uRain) * step(0.01, uRain);
  vAlpha = (0.35 + 0.65 * uRain) * falls * smoothstep(2.0, 4.5, near) * (1.0 - smoothstep(12.0, 22.0, near)) * step(waterSurface(at.xz), y);
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

// ---- where the drops strike ----

/** How far round the camera the splashes are drawn (m). */
const SPLASH_REACH = 14;

/**
 * A splash: a crown of water thrown up where a drop strikes, five fingers flung up and out with a bead at each
 * tip, rising and falling back in a fraction of a second. `vUv` is the quad's (x −½..½ across, y 0..1 up).
 */
const CROWN_FRAG = /* glsl */ `
${GLSL_COMMON}
varying vec2 vUv;
varying float vAlpha;
varying float vSeed;
varying vec3 vWorld;
void main() {
  if (vAlpha < 0.01) discard;
  // leaning a little, its own way
  float lean = (vSeed - 0.5) * 0.5;
  vec2 q = vec2(vUv.x * 2.0, vUv.y);
  q = vec2(q.x * cos(lean) - q.y * sin(lean), q.x * sin(lean) + q.y * cos(lean));
  float a = 0.0;
  for (int i = 0; i < 6; i++) {
    float r1 = fract(vSeed * 7.31 + float(i) * 0.613);
    float r2 = fract(vSeed * 3.17 + float(i) * 0.379);
    // three to six of them, unevenly spread and long
    if (r1 < 0.25) continue;
    float ang = ((float(i) + r2 * 0.6) / 5.6 - 0.5) * (1.5 + 0.5 * vSeed);
    vec2 dir = vec2(sin(ang), cos(ang));
    float len = 0.45 + 0.55 * r2;
    float t = clamp(dot(q, dir), 0.0, len);
    // thin, thickest near its tip, gone into the water at its foot; a bead thrown off beyond it
    a = max(a, smoothstep(0.05, 0.0, length(q - dir * t)) * smoothstep(0.1, 0.55, t / len) * (0.5 + 0.5 * r1));
    a = max(a, smoothstep(0.085, 0.015, length(q - dir * (len + 0.08 + 0.1 * r1))) * 0.9);
  }
  if (a < 0.02) discard;
  // water lit by the grey sky, brighter than the dark water it is thrown up from
  vec3 col = uFogColor * 1.35 + uKeyColor * max(uKeyDir.y, 0.0) * 0.12 + 0.04;
  gl_FragColor = vec4(applyAtmosphere(col, vWorld), a * vAlpha * 0.6);
}
`;

/** Places a crown's quad: its base at `base`, `size` 0..1, `ph` how far through its life (0..1). */
const CROWN_PLACE = /* glsl */ `
vec4 crownAt(vec3 base, float size, float ph, float seed) {
  // it rises and falls back as it spreads; seen side on (turned about the upright to the camera)
  float height = (0.035 + 0.075 * size) * (0.6 + 0.6 * uRain) * sin(3.14159 * min(ph * 1.1, 1.0));
  float width = (0.04 + 0.075 * size) * (0.7 + 0.6 * ph);
  vec3 toCam = uCamPos - base;
  vec3 side = normalize(vec3(toCam.z, 0.0, -toCam.x));
  vec3 p = base + side * position.x * width + vec3(0.0, position.y * max(height, 0.004), 0.0);
  float near = length(toCam);
  vAlpha = (1.0 - smoothstep(${(SPLASH_REACH * 0.6).toFixed(1)}, ${SPLASH_REACH.toFixed(1)}, near)) * smoothstep(0.6, 1.6, near) * (1.0 - 0.6 * ph);
  vUv = position.xy;
  vSeed = seed;
  vWorld = p;
  return projectionMatrix * viewMatrix * vec4(p, 1.0);
}
`;

const WATER_CROWN_VERT = /* glsl */ `
${GLSL_COMMON}
attribute vec3 aCell;
varying vec2 vUv;
varying float vAlpha;
varying float vSeed;
varying vec3 vWorld;
${CROWN_PLACE}
void main() {
  // this instance's cell (its offset from the camera's, of its layer): the drop falling there now, if any
  float k = aCell.z;
  vec2 c = floor(uCamPos.xz / rainCell(k)) + aCell.xy;
  vec4 d = rainDrop(c, k, uRain);
  // the spray's drops are small
  if (k > 2.5) d.w *= 0.45;
  float life = 0.16 + 0.08 * d.w;
  float surface = waterSurface(d.xy);
  vAlpha = 0.0;
  if (uRain < 0.01 || d.w < 0.0 || d.z > life || surface < -1e3) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  gl_Position = crownAt(vec3(d.x, surface + 0.004, d.y), d.w, d.z / life, hash12(c + k * 3.1));
}
`;

function crownMaterial(vertexShader: string): ShaderMaterial {
  return new ShaderMaterial({ uniforms: { ...G }, vertexShader, fragmentShader: CROWN_FRAG, transparent: true, depthWrite: false, side: DoubleSide });
}

function crownMesh(geometry: InstancedBufferGeometry, material: ShaderMaterial, name: string): Mesh {
  const mesh = new Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.layers.set(LAYER_NO_REFLECT);
  mesh.renderOrder = 4;
  mesh.name = name;
  return mesh;
}

function crownQuad(): InstancedBufferGeometry {
  const quad = new PlaneGeometry(1, 1).translate(0, 0.5, 0);
  const geometry = new InstancedBufferGeometry();
  geometry.index = quad.index;
  geometry.setAttribute('position', quad.getAttribute('position'));
  return geometry;
}

/**
 * The crowns of water the drops throw up from the river, the khals, the bil and the ponds round the camera: one
 * instance a cell of each of the drops' layers within reach, each showing its cell's drop (GLSL_COMMON rainDrop),
 * so a crown rises where the water shader starts its ring.
 */
export function buildRainSplashes(): Mesh {
  const cells: number[] = [];
  // (GLSL_COMMON's RAIN_CELL; the spray's fine layer nearer only, its crowns too small to see far off)
  [0.6, 1.0, 1.6, 0.32].forEach((size, k) => {
    const reach = k === 3 ? SPLASH_REACH * 0.6 : SPLASH_REACH;
    const n = Math.ceil(reach / size) + 1;
    for (let dz = -n; dz <= n; dz++) for (let dx = -n; dx <= n; dx++) if (Math.hypot(dx, dz) * size <= reach + size) cells.push(dx, dz, k);
  });
  const geometry = crownQuad();
  geometry.setAttribute('aCell', new InstancedBufferAttribute(new Float32Array(cells), 3));
  geometry.instanceCount = cells.length / 3;
  return crownMesh(geometry, crownMaterial(WATER_CROWN_VERT), 'rain-crowns');
}

const GROUND_CROWN_VERT = /* glsl */ `
${GLSL_COMMON}
attribute vec4 aAt;
attribute float aSize;
varying vec2 vUv;
varying float vAlpha;
varying float vSeed;
varying vec3 vWorld;
${CROWN_PLACE}
void main() {
  // where a drop landed (xyz) and when (w, the shader clock); smaller and quicker than on water
  float life = 0.12 + 0.05 * aSize;
  float age = uTime - aAt.w;
  vAlpha = 0.0;
  if (age < 0.0 || age > life) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  gl_Position = crownAt(aAt.xyz, aSize * 0.6, age / life, fract(aAt.x * 1.37 + aAt.z * 2.11));
}
`;

/** Splashes the most a second, round the camera, in the heaviest rain. */
const GROUND_RATE = 1600;
const GROUND_POOL = 600;

/**
 * The drops striking the land round the camera (the ways, the yards, the banks, the ghats' steps, the bridge's
 * deck): each lands at a spot drawn at random a little ahead of the camera, on the ground as it stands there (the
 * water's drops are the crowns'), and splashes for an instant.
 */
export class GroundSplashes {
  readonly mesh: Mesh;
  private readonly at: Float32Array;
  private readonly size: Float32Array;
  private readonly atAttr: InstancedBufferAttribute;
  private readonly sizeAttr: InstancedBufferAttribute;
  private readonly rng = new Rng(29);
  private next = 0;
  private owed = 0;

  constructor() {
    this.at = new Float32Array(GROUND_POOL * 4).fill(-1e4);
    this.size = new Float32Array(GROUND_POOL);
    const geometry = crownQuad();
    this.atAttr = new InstancedBufferAttribute(this.at, 4);
    this.sizeAttr = new InstancedBufferAttribute(this.size, 1);
    geometry.setAttribute('aAt', this.atAttr);
    geometry.setAttribute('aSize', this.sizeAttr);
    geometry.instanceCount = GROUND_POOL;
    this.mesh = crownMesh(geometry, crownMaterial(GROUND_CROWN_VERT), 'rain-splashes');
  }

  /** `t`: the shader clock (s); `eye` and `forward`: the camera; `rain`: how hard it rains (0..1). */
  update(dt: number, t: number, eye: Vector3, forward: Vector3, rain: number): void {
    this.mesh.visible = rain > 0.01;
    if (rain <= 0.01 || dt <= 0) return;
    this.owed += GROUND_RATE * rain * rain * dt;
    const fx = forward.x;
    const fz = forward.z;
    const fl = Math.hypot(fx, fz) || 1;
    let changed = false;
    for (; this.owed >= 1; this.owed--) {
      const r = (SPLASH_REACH - 2) * Math.sqrt(this.rng.next());
      const a = this.rng.range(0, Math.PI * 2);
      const x = eye.x + (fx / fl) * 4 + Math.cos(a) * r;
      const z = eye.z + (fz / fl) * 4 + Math.sin(a) * r;
      // on the water the crowns splash; on the bridge, its deck between the parapets; else the ground
      if (Number.isFinite(waterLevelAt(x, z))) continue;
      const f = bridgeFrame(x, z);
      const onDeck = Math.abs(f.x) < BRIDGE.half && Math.abs(f.z) < BRIDGE.width / 2;
      const y = onDeck ? BRIDGE.water + bridgeDeck(f.x) : terrainHeight(x, z);
      const k = this.next;
      this.next = (this.next + 1) % GROUND_POOL;
      this.at.set([x, y + 0.01, z, t], k * 4);
      this.size[k] = this.rng.range(0.35, 1);
      changed = true;
    }
    if (changed) {
      this.atAttr.needsUpdate = true;
      this.sizeAttr.needsUpdate = true;
    }
  }
}
