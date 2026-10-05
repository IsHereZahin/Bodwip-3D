import { AdditiveBlending, BufferAttribute, BufferGeometry, Points, ShaderMaterial, Vector3 } from 'three';
import { G, LAYER_NO_REFLECT } from '../core/globals';
import { Rng } from '../core/rng';
import { waterLevelAt } from './geography';

// The water the majhi's blade throws: as it goes in, a handful of drops kicked up and out round it (more, and
// higher, the harder the stroke), and as it comes out, drops running off it and falling back, each its own: a
// fixed pool of points, flung and falling under gravity until they are back in the water. Lit by the sky and
// the key light, small and bright as drops are; never the same twice.

const POOL = 96;
/** Drops at the blade's entry (at the steady stroke) and off it as it comes out; how long one lives at most (s). */
const ENTRY = 16;
const EXIT = 9;
const LIFE = 1.1;

const VERT = /* glsl */ `
attribute float aAlpha;
varying float vAlpha;
uniform float uScale;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = clamp(uScale * 0.011 / max(-mv.z, 0.1), 0.0, 9.0);
  vAlpha = aAlpha;
}
`;
const FRAG = /* glsl */ `
uniform vec3 uKeyColor;
uniform vec3 uFogColor;
varying float vAlpha;
void main() {
  vec2 d = gl_PointCoord - 0.5;
  float r = dot(d, d) * 4.0;
  if (r > 1.0) discard;
  // a drop: the sky's light in it and a glint of the key light
  vec3 col = uFogColor * 0.8 + uKeyColor * 0.35 * (1.0 - r);
  gl_FragColor = vec4(col, vAlpha * (1.0 - r * 0.6));
}
`;

export class PaddleSplash {
  readonly points: Points;
  private readonly pos: Float32Array;
  private readonly alpha: Float32Array;
  private readonly vel: Vector3[] = [];
  private readonly age = new Float32Array(POOL).fill(LIFE);
  private next = 0;
  private wet = 0;
  private readonly rng = new Rng(4242);
  private readonly material: ShaderMaterial;

  constructor() {
    this.pos = new Float32Array(POOL * 3);
    this.alpha = new Float32Array(POOL);
    for (let i = 0; i < POOL; i++) this.vel.push(new Vector3());
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(this.pos, 3));
    g.setAttribute('aAlpha', new BufferAttribute(this.alpha, 1));
    this.material = new ShaderMaterial({
      uniforms: { uScale: { value: 1000 }, uKeyColor: G.uKeyColor, uFogColor: G.uFogColor },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
    });
    this.points = new Points(g, this.material);
    this.points.frustumCulled = false;
    this.points.layers.set(LAYER_NO_REFLECT);
    this.points.name = 'paddle-splash';
  }

  private emit(at: Vector3, n: number, speed: number, up: number, spread: number, along: Vector3): void {
    for (let k = 0; k < n; k++) {
      const i = this.next;
      this.next = (this.next + 1) % POOL;
      const a = this.rng.range(0, Math.PI * 2);
      const r = this.rng.range(0, spread);
      this.pos[i * 3] = at.x + Math.cos(a) * r;
      this.pos[i * 3 + 1] = at.y;
      this.pos[i * 3 + 2] = at.z + Math.sin(a) * r;
      const s = speed * this.rng.range(0.4, 1.1);
      this.vel[i].set(Math.cos(a) * s * 0.6, up * this.rng.range(0.5, 1.2), Math.sin(a) * s * 0.6).addScaledVector(along, this.rng.range(0, speed * 0.5));
      this.age[i] = this.rng.range(0, 0.15);
    }
  }

  /**
   * `blade`: where the blade's middle is (world); `wet`: how much of it is in the water (0..1); `drive`: how hard
   * this stroke pulls (1 the steady one); `back`: which way the blade is drawn (world, level); `height`: the
   * picture's height in pixels, for the drops' size.
   */
  update(dt: number, blade: Vector3, wet: number, drive: number, back: Vector3, height: number): void {
    this.material.uniforms.uScale.value = height;
    const level = waterLevelAt(blade.x, blade.z);
    // in: kicked up round where it enters; out: running off it
    if (wet > 0.35 && this.wet <= 0.35) this.emit(this.tmp.set(blade.x, level + 0.02, blade.z), Math.round(ENTRY * Math.min(1.6, Math.max(0.5, drive))), 1.1 + 0.4 * drive, 1.6 + 0.6 * drive, 0.12, back);
    if (wet < 0.25 && this.wet >= 0.25) this.emit(this.tmp.set(blade.x, level + 0.15, blade.z), EXIT, 0.25, 0.3, 0.18, back);
    this.wet = wet;
    for (let i = 0; i < POOL; i++) {
      if (this.age[i] >= LIFE) {
        this.alpha[i] = 0;
        continue;
      }
      this.age[i] += dt;
      const v = this.vel[i];
      v.y -= 9.81 * dt;
      this.pos[i * 3] += v.x * dt;
      this.pos[i * 3 + 1] += v.y * dt;
      this.pos[i * 3 + 2] += v.z * dt;
      // back in the water
      if (this.pos[i * 3 + 1] < waterLevelAt(this.pos[i * 3], this.pos[i * 3 + 2])) this.age[i] = LIFE;
      this.alpha[i] = this.age[i] >= LIFE ? 0 : 0.55 * (1 - this.age[i] / LIFE);
    }
    (this.points.geometry.getAttribute('position') as BufferAttribute).needsUpdate = true;
    (this.points.geometry.getAttribute('aAlpha') as BufferAttribute).needsUpdate = true;
  }

  private readonly tmp = new Vector3();
}
