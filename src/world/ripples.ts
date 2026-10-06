import {
  BufferAttribute,
  BufferGeometry,
  HalfFloatType,
  LinearFilter,
  Mesh,
  OrthographicCamera,
  RGBAFormat,
  Scene,
  ShaderMaterial,
  Vector2,
  Vector3,
  Vector4,
  WebGLRenderTarget,
} from 'three';
import type { Texture, WebGLRenderer } from 'three';
import { G } from '../core/globals';
import { GLSL_COMMON, GLSL_FULLSCREEN_VERT } from '../render/glsl';
import { HERO_HULL, HERO_SINK, hullWaterlineGlsl } from './hull';

// The water's own ripples where the camera looks: a patch of the surface, a few metres across, simulated as
// water is (the wave equation on a grid, on the GPU), so every ring spreads, crosses the others and runs back
// off the banks and the boat's sides. Whatever touches the water starts them (`drop`): the paddle as it bites,
// pulls and comes out, the boat's stem as she goes, a fish turning at the surface or leaping, a frog going in,
// a turtle sliding off its stone, the drips off a lifted net. The patch follows the camera's view (`update`):
// what lay in it moves over as it goes, and it lets its ripples die away toward its edges. The water shader
// reads its slopes (`RIPPLE_GLSL`); farther off, and in the rain, the water's own analytic rings stand in.

/** Texels across the patch, and its size (m): 6 cm a texel, fine enough for a paddle's and a frog's rings. */
const TEXELS = 256;
const SIZE = 15.36;
/** The simulation's own step (s), and the most steps a frame takes (a slow frame drops the rest). */
const STEP = 1 / 60;
const MOST_STEPS = 3;
/** How fast ripples spread (m/s), and how much of them is left after each step. */
const SPEED = 0.55;
const DAMP = 0.994;
/** The most drops taken in a frame (the rest wait for the next). */
const DROPS = 24;
/** How far ahead of the camera the patch lies where it looks out level, and the farthest along its view (m). */
const AHEAD = 5;
const FARTHEST = 11;

const C = (SPEED * STEP) / (SIZE / TEXELS);

/** The water field's uniforms (world/water.ts), for the depth: the patch's banks are where the water ends. */
export interface FieldUniforms {
  tField: { value: Texture };
  uField: { value: Vector4 };
  tFieldWide: { value: Texture };
  uFieldWide: { value: Vector4 };
}

/** The water shader's uniforms for the ripples (`RIPPLE_GLSL`), which the patch keeps up to date. */
export interface RippleUniforms {
  tRipple: { value: Texture | null };
  uRipple: { value: Vector4 };
}

const SIM = /* glsl */ `
${GLSL_COMMON}
uniform sampler2D tState;
uniform sampler2D tField;
uniform vec4 uField;
uniform sampler2D tFieldWide;
uniform vec4 uFieldWide;
uniform vec4 uWindow;
uniform vec2 uShift;
uniform vec4 uBoat;
uniform vec4 uDrops[${DROPS}];
uniform int uDropCount;
varying vec2 vUv;
vec4 waterField(vec2 p) {
  vec2 f = (p - uField.xy) * uField.zw;
  vec4 fine = texture2D(tField, f);
  vec4 wide = texture2D(tFieldWide, (p - uFieldWide.xy) * uFieldWide.zw);
  vec2 edge = min(f, 1.0 - f);
  return min(edge.x, edge.y) > 0.01 ? fine : wide;
}
${hullWaterlineGlsl(HERO_HULL, HERO_SINK)}
// the state where this texel was a step ago (the patch may have moved over since); still water off its edge
vec2 was(vec2 uv) {
  vec2 p = uv + uShift * uWindow.w;
  if (p.x < 0.0 || p.y < 0.0 || p.x > 1.0 || p.y > 1.0) return vec2(0.0);
  return texture2D(tState, p).rg;
}
void main() {
  float e = uWindow.w;
  vec2 s = was(vUv);
  float lap = was(vUv + vec2(e, 0.0)).r + was(vUv - vec2(e, 0.0)).r + was(vUv + vec2(0.0, e)).r + was(vUv - vec2(0.0, e)).r - 4.0 * s.r;
  float h = (2.0 * s.r - s.g + ${(C * C).toFixed(5)} * lap) * ${DAMP.toFixed(4)};
  vec2 xz = uWindow.xy + vUv * uWindow.z;
  // what touches the water: a soft dimple (or heap) each
  for (int i = 0; i < ${DROPS}; i++) {
    if (i >= uDropCount) break;
    vec4 d = uDrops[i];
    float r = length(xz - d.xy);
    if (r < d.z) h += d.w * 0.5 * (1.0 + cos(3.14159 * r / d.z));
  }
  // the banks and the boat's sides stand still, so the rings run back off them; the shallows calm them
  vec3 lv = waterLevels(xz);
  float depth = lv.r - waterField(xz).r;
  float wall = lv.b < 0.5 || depth < 0.03 ? 0.0 : smoothstep(0.03, 0.2, depth);
  vec2 bd = xz - uBoat.xy;
  vec2 q = vec2(dot(bd, vec2(cos(uBoat.z), -sin(uBoat.z))), dot(bd, vec2(sin(uBoat.z), cos(uBoat.z))));
  float sAlong = q.y / ${(HERO_HULL.len / 2).toFixed(3)};
  if (abs(sAlong) < 1.0 && abs(q.x) < hullHalfBeamAtWater(sAlong)) wall = 0.0;
  // the patch's edge takes the rings in rather than throwing them back
  vec2 edge = min(vUv, 1.0 - vUv);
  float absorb = mix(0.9, 1.0, smoothstep(0.0, 0.06, min(edge.x, edge.y)));
  gl_FragColor = vec4(h * wall * absorb, s.r * wall, 0.0, 1.0);
}`;

/** GLSL for the water shader: the ripples' slope at p (needs `tRipple`, `uRipple`), faded where a pixel is too coarse to draw them. */
export const RIPPLE_GLSL = /* glsl */ `
uniform sampler2D tRipple;
uniform vec4 uRipple;    // the patch's corner (x, z), 1 / its size, its texel (m)
vec2 rippleSlope(vec2 p, float footprint) {
  vec2 uv = (p - uRipple.xy) * uRipple.z;
  vec2 edge = min(uv, 1.0 - uv);
  float inside = min(edge.x, edge.y);
  if (inside <= 0.0) return vec2(0.0);
  float e = uRipple.w * uRipple.z;
  float hx = texture2D(tRipple, uv + vec2(e, 0.0)).r - texture2D(tRipple, uv - vec2(e, 0.0)).r;
  float hz = texture2D(tRipple, uv + vec2(0.0, e)).r - texture2D(tRipple, uv - vec2(0.0, e)).r;
  return vec2(hx, hz) / (2.0 * uRipple.w) * smoothstep(0.0, 0.08, inside) * smoothstep(uRipple.w * 3.0, uRipple.w, footprint);
}`;

export class Ripples {
  /** The water's material's: the ripples' heights, and where the patch lies. */
  private readonly uniforms: RippleUniforms;
  private readonly targets: [WebGLRenderTarget, WebGLRenderTarget];
  private current = 0;
  private readonly material: ShaderMaterial;
  private readonly scene = new Scene();
  private readonly camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly drops: Vector4[] = Array.from({ length: DROPS }, () => new Vector4());
  private queued = 0;
  /** The patch's corner (whole texels), and how far it has moved since its last step (texels). */
  private readonly corner = { i: 0, j: 0 };
  private readonly shift: Vector2;
  private carry = 0;
  private placed = false;

  constructor(field: FieldUniforms, boat: Vector4, uniforms: RippleUniforms) {
    const target = () =>
      new WebGLRenderTarget(TEXELS, TEXELS, { type: HalfFloatType, format: RGBAFormat, depthBuffer: false, minFilter: LinearFilter, magFilter: LinearFilter, generateMipmaps: false });
    this.targets = [target(), target()];
    this.material = new ShaderMaterial({
      uniforms: {
        ...G,
        ...field,
        tState: { value: this.targets[0].texture },
        uWindow: { value: new Vector4(0, 0, SIZE, 1 / TEXELS) },
        uShift: { value: new Vector2() },
        uBoat: { value: boat },
        uDrops: { value: this.drops },
        uDropCount: { value: 0 },
      },
      vertexShader: GLSL_FULLSCREEN_VERT,
      fragmentShader: SIM,
      depthTest: false,
      depthWrite: false,
    });
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    const quad = new Mesh(g, this.material);
    quad.frustumCulled = false;
    this.scene.add(quad);
    this.shift = this.material.uniforms.uShift.value as Vector2;
    this.uniforms = uniforms;
    uniforms.tRipple.value = this.targets[0].texture;
  }

  /** Something touches the water at (x, z): a dimple `strength` m deep (negative: a heap) over `radius` m. */
  drop(x: number, z: number, radius: number, strength: number): void {
    if (this.queued >= DROPS || !Number.isFinite(x + z + strength)) return;
    this.drops[this.queued++].set(x, z, Math.max(radius, (SIZE / TEXELS) * 1.5), -strength);
  }

  /** Whether (x, z) lies in the patch, where its ripples are drawn (a touch elsewhere is not seen ringing). */
  covers(x: number, z: number): boolean {
    const u = this.uniforms.uRipple.value;
    return x > u.x && z > u.y && x < u.x + SIZE && z < u.y + SIZE;
  }

  /**
   * Moves the patch to where the camera at `eye`, looking along `forward`, sees the water at `level` (m), and
   * runs the water on `dt` seconds (none while the world is held still).
   */
  update(renderer: WebGLRenderer, dt: number, eye: Vector3, forward: Vector3, level: number): void {
    // where the view meets the water, no farther than FARTHEST along the ground; AHEAD out when it looks level
    let along = AHEAD;
    if (forward.y < -0.05) along = Math.min(FARTHEST, (eye.y - level) / -forward.y);
    const flat = Math.hypot(forward.x, forward.z) || 1;
    const cx = eye.x + (forward.x / flat) * along * Math.min(1, flat * 1.4);
    const cz = eye.z + (forward.z / flat) * along * Math.min(1, flat * 1.4);
    const cell = SIZE / TEXELS;
    const i = Math.round((cx - SIZE / 2) / cell);
    const j = Math.round((cz - SIZE / 2) / cell);
    // a jump (a cut, a still) starts from still water rather than dragging the old rings across
    const jumped = !this.placed || Math.abs(i - this.corner.i) > TEXELS / 2 || Math.abs(j - this.corner.j) > TEXELS / 2;
    const u = this.material.uniforms;
    if (jumped) this.shift.set(TEXELS * 4, TEXELS * 4);
    else this.shift.add({ x: i - this.corner.i, y: j - this.corner.j });
    this.corner.i = i;
    this.corner.j = j;
    this.placed = true;
    (u.uWindow.value as Vector4).set(i * cell, j * cell, SIZE, 1 / TEXELS);
    this.uniforms.uRipple.value.set(i * cell, j * cell, 1 / SIZE, cell);
    this.carry = Math.min(this.carry + dt, STEP * MOST_STEPS);
    let steps = 0;
    while (this.carry >= STEP) {
      this.carry -= STEP;
      u.uDropCount.value = steps === 0 ? this.queued : 0;
      this.run(renderer);
      // after its first step the patch has moved over: the rest read it in place
      this.shift.set(0, 0);
      steps++;
    }
    // a frame with no step (the world held) keeps its drops for the next
    if (steps > 0) this.queued = 0;
  }

  private run(renderer: WebGLRenderer): void {
    const from = this.targets[this.current];
    const to = this.targets[1 - this.current];
    this.material.uniforms.tState.value = from.texture;
    const was = renderer.getRenderTarget();
    renderer.setRenderTarget(to);
    renderer.render(this.scene, this.camera);
    renderer.setRenderTarget(was);
    this.current = 1 - this.current;
    this.uniforms.tRipple.value = to.texture;
  }
}
