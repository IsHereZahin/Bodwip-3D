import {
  BufferAttribute,
  BufferGeometry,
  Color,
  HalfFloatType,
  LinearFilter,
  Mesh,
  OrthographicCamera,
  Scene,
  ShaderMaterial,
  Vector2,
  Vector3,
  WebGLRenderTarget,
} from 'three';
import type { PerspectiveCamera, WebGLRenderer } from 'three';
import { G } from '../core/globals';
import { GLSL_FULLSCREEN_VERT } from './glsl';
import { PlanarReflection } from './reflection';

const BLOOM_LEVELS = 5;

function rt(w: number, h: number, samples = 0, depth = false): WebGLRenderTarget {
  const t = new WebGLRenderTarget(Math.max(1, w), Math.max(1, h), {
    type: HalfFloatType,
    samples,
    depthBuffer: depth,
    stencilBuffer: false,
    minFilter: LinearFilter,
    magFilter: LinearFilter,
  });
  t.texture.generateMipmaps = false;
  return t;
}

function pass(fragmentShader: string, uniforms: Record<string, { value: unknown }>): ShaderMaterial {
  return new ShaderMaterial({ uniforms, vertexShader: GLSL_FULLSCREEN_VERT, fragmentShader, depthTest: false, depthWrite: false });
}

// NaN fails every comparison, so this survives compilers (ANGLE/D3D) that optimise isnan() away
const GLSL_SANITIZE = /* glsl */ `
vec3 sanitize(vec3 c) {
  bvec3 ok = bvec3(c.x >= 0.0 && c.x < 65000.0, c.y >= 0.0 && c.y < 65000.0, c.z >= 0.0 && c.z < 65000.0);
  return all(ok) ? c : vec3(0.0);
}`;

const BRIGHT = /* glsl */ `${GLSL_SANITIZE}
uniform sampler2D tSrc; uniform vec2 uTexel; uniform float uThreshold;
varying vec2 vUv;
void main() {
  vec3 c = texture2D(tSrc, vUv + uTexel * vec2(-0.5, -0.5)).rgb + texture2D(tSrc, vUv + uTexel * vec2(0.5, -0.5)).rgb
         + texture2D(tSrc, vUv + uTexel * vec2(-0.5, 0.5)).rgb + texture2D(tSrc, vUv + uTexel * vec2(0.5, 0.5)).rgb;
  c *= 0.25;
  // a single NaN/Inf pixel would otherwise smear into a black square through the whole bloom chain
  c = sanitize(c);
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  // soft knee, and a ceiling so single glitter pixels don't flicker as huge blooms
  c *= smoothstep(uThreshold, uThreshold * 2.0, l);
  c *= min(1.0, 24.0 / max(l, 1e-4));
  gl_FragColor = vec4(c, 1.0);
}`;

const DOWN = /* glsl */ `
uniform sampler2D tSrc; uniform vec2 uTexel;
varying vec2 vUv;
void main() {
  vec3 c = texture2D(tSrc, vUv).rgb * 4.0;
  c += texture2D(tSrc, vUv + uTexel * vec2(-1.0, -1.0)).rgb;
  c += texture2D(tSrc, vUv + uTexel * vec2(1.0, -1.0)).rgb;
  c += texture2D(tSrc, vUv + uTexel * vec2(-1.0, 1.0)).rgb;
  c += texture2D(tSrc, vUv + uTexel * vec2(1.0, 1.0)).rgb;
  gl_FragColor = vec4(c / 8.0, 1.0);
}`;

const UP = /* glsl */ `
uniform sampler2D tSrc; uniform sampler2D tPrev; uniform vec2 uTexel;
varying vec2 vUv;
void main() {
  vec3 c = vec3(0.0);
  c += texture2D(tSrc, vUv + uTexel * vec2(-1.0, 0.0)).rgb * 2.0;
  c += texture2D(tSrc, vUv + uTexel * vec2(1.0, 0.0)).rgb * 2.0;
  c += texture2D(tSrc, vUv + uTexel * vec2(0.0, -1.0)).rgb * 2.0;
  c += texture2D(tSrc, vUv + uTexel * vec2(0.0, 1.0)).rgb * 2.0;
  c += texture2D(tSrc, vUv + uTexel * vec2(-1.0, -1.0)).rgb;
  c += texture2D(tSrc, vUv + uTexel * vec2(1.0, -1.0)).rgb;
  c += texture2D(tSrc, vUv + uTexel * vec2(-1.0, 1.0)).rgb;
  c += texture2D(tSrc, vUv + uTexel * vec2(1.0, 1.0)).rgb;
  gl_FragColor = vec4(texture2D(tPrev, vUv).rgb + c / 12.0, 1.0);
}`;

// light shafts: the bright sky round the sun smeared radially; anything in front of it blocks them
const RAYS = /* glsl */ `
uniform sampler2D tSrc; uniform vec2 uSun; uniform float uAspect;
varying vec2 vUv;
void main() {
  vec2 d = (uSun - vUv) / 48.0 * 0.85;
  vec2 uv = vUv;
  float w = 1.0;
  vec3 acc = vec3(0.0);
  for (int i = 0; i < 48; i++) {
    acc += texture2D(tSrc, uv).rgb * w;
    uv += d;
    w *= 0.965;
  }
  vec2 dd = (vUv - uSun) * vec2(uAspect, 1.0);
  gl_FragColor = vec4(acc / 48.0 * exp(-length(dd) * 1.4), 1.0);
}`;

const COMPOSITE = /* glsl */ `${GLSL_SANITIZE}
uniform sampler2D tScene; uniform sampler2D tBloom; uniform sampler2D tRays; uniform sampler2D tHeld;
uniform float uExposure; uniform float uBloom; uniform float uRays; uniform float uFade; uniform float uFrame; uniform float uNight; uniform float uLetter;
uniform float uDissolve;
uniform vec3 uFadeColor; uniform vec3 uRayColor;
varying vec2 vUv;
vec3 aces(vec3 x) {
  const mat3 m1 = mat3(0.59719, 0.07600, 0.02840, 0.35458, 0.90834, 0.13383, 0.04823, 0.01566, 0.83777);
  const mat3 m2 = mat3(1.60475, -0.10208, -0.00327, -0.53108, 1.10813, -0.07276, -0.07367, -0.00605, 1.07602);
  vec3 v = m1 * x;
  vec3 a = v * (v + 0.0245786) - 0.000090537;
  vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
  return clamp(m2 * (a / b), 0.0, 1.0);
}
vec3 toSRGB(vec3 c) { return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c)); }
float hash(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
void main() {
  vec2 uv = vUv;
  vec2 cc = uv - 0.5;
  // slight chromatic fringe toward the frame edges
  vec2 ca = cc * dot(cc, cc) * 0.006;
  vec3 col = vec3(texture2D(tScene, uv - ca).r, texture2D(tScene, uv).g, texture2D(tScene, uv + ca).b);
  col = sanitize(col);
  col += texture2D(tBloom, uv).rgb * uBloom;
  col += texture2D(tRays, uv).rgb * uRayColor * uRays;
  col *= uExposure;
  // white balance: warm highlights, cool shadows; at night dim areas lose colour and drift blue
  float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = mix(col, col * vec3(1.03, 1.0, 0.94), smoothstep(0.08, 0.9, lum) * (1.0 - uNight));
  col = mix(col, col * vec3(0.9, 1.0, 1.08), 1.0 - smoothstep(0.0, 0.14, lum));
  col = mix(col, vec3(lum) * vec3(0.72, 0.88, 1.22), uNight * 0.5 * (1.0 - smoothstep(0.03, 0.4, lum)));
  vec3 m = aces(col);
  // painterly grade: teal in the shadows, amber in the highlights, a firm S-curve
  float l = dot(m, vec3(0.299, 0.587, 0.114));
  m += vec3(0.0, 0.012, 0.022) * (1.0 - smoothstep(0.0, 0.35, l));
  m = mix(m, m * vec3(1.04, 0.99, 0.9), smoothstep(0.45, 1.0, l));
  m = clamp(mix(vec3(l), m, 1.1), 0.0, 1.0);
  m = mix(m, m * m * (3.0 - 2.0 * m), 0.32);
  float vig = 1.0 - smoothstep(0.38, 1.05, length(cc * vec2(1.05, 1.25)));
  m *= mix(0.7, 1.0, vig);
  m = toSRGB(m);
  // film grain and dither against banding in the smooth sky
  float g = hash(gl_FragCoord.xy + fract(uFrame * 0.618) * 311.0) - 0.5;
  m += g * 0.026 * (1.0 - l * 0.6) + (hash(gl_FragCoord.yx * 1.3 + uFrame) - 0.5) / 255.0;
  // a dissolve: the held last frame of the shot before, giving way to this one
  if (uDissolve > 0.0) m = mix(m, texture2D(tHeld, uv).rgb, uDissolve);
  m = mix(m, uFadeColor, uFade);
  // letterbox bars while the film tour plays
  if (abs(vUv.y - 0.5) > 0.5 - uLetter) m = vec3(0.0);
  gl_FragColor = vec4(m, 1.0);
}`;

export interface FrameParams {
  exposure: number;
  fade: number;
  fadeColor: Color;
  night: number;
  /** 0..1: letterbox bars closing in. */
  letterbox: number;
  /** Keep this frame (as it is shown) for a dissolve into whatever comes next. */
  hold?: boolean;
  /** 0..1: how much of the held frame still shows over this one. */
  dissolve?: number;
}

/**
 * Mirror pass → scene (MSAA, HDR) → bloom chain → light shafts → one composite pass
 * (tone map, grade, vignette, grain) straight to the canvas.
 */
export class Pipeline {
  readonly reflection: PlanarReflection;
  private readonly sceneRT: WebGLRenderTarget;
  private readonly bright: WebGLRenderTarget;
  private readonly down: WebGLRenderTarget[] = [];
  private readonly up: WebGLRenderTarget[] = [];
  private readonly rays: WebGLRenderTarget;
  /** The last frame of a shot, held for a dissolve. */
  private readonly held: WebGLRenderTarget;
  private readonly quad: Mesh;
  private readonly quadScene = new Scene();
  private readonly quadCam = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly mBright = pass(BRIGHT, { tSrc: { value: null }, uTexel: { value: new Vector2() }, uThreshold: { value: 1.6 } });
  private readonly mDown = pass(DOWN, { tSrc: { value: null }, uTexel: { value: new Vector2() } });
  private readonly mUp = pass(UP, { tSrc: { value: null }, tPrev: { value: null }, uTexel: { value: new Vector2() } });
  private readonly mRays = pass(RAYS, { tSrc: { value: null }, uSun: { value: new Vector2() }, uAspect: { value: 1 } });
  private readonly mComposite = pass(COMPOSITE, {
    tScene: { value: null },
    tBloom: { value: null },
    tRays: { value: null },
    tHeld: { value: null },
    uDissolve: { value: 0 },
    uExposure: { value: 1 },
    uBloom: { value: 0.06 },
    uRays: { value: 0 },
    uFade: { value: 1 },
    uFrame: { value: 0 },
    uNight: { value: 0 },
    uLetter: { value: 0 },
    uFadeColor: { value: new Color(0, 0, 0) },
    uRayColor: { value: new Color() },
  });
  private readonly sunNdc = new Vector3();
  private width = 1;
  private height = 1;
  private frame = 0;
  private reflScale: number;
  /** Height of one letterbox bar as a fraction of the frame. */
  bar = 0.12;

  constructor(reflScale = 0.5) {
    this.reflScale = reflScale;
    this.sceneRT = rt(1, 1, 4, true);
    this.bright = rt(1, 1);
    for (let i = 0; i < BLOOM_LEVELS; i++) {
      this.down.push(rt(1, 1));
      this.up.push(rt(1, 1));
    }
    this.rays = rt(1, 1);
    this.held = rt(1, 1);
    this.reflection = new PlanarReflection(1, 1);
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    this.quad = new Mesh(g, this.mComposite);
    this.quad.frustumCulled = false;
    this.quadScene.add(this.quad);
  }

  /** Target for compiling scene programs with the same render-target state as real frames. */
  get sceneTarget(): WebGLRenderTarget {
    return this.sceneRT;
  }

  get size(): { width: number; height: number } {
    return { width: this.width, height: this.height };
  }

  /** The mirror pass's resolution as a share of the frame's. */
  setReflectionScale(k: number): void {
    this.reflScale = k;
    this.reflection.setSize(Math.round(this.width * k), Math.round(this.height * k));
  }

  setSize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    this.sceneRT.setSize(width, height);
    this.reflection.setSize(Math.round(width * this.reflScale), Math.round(height * this.reflScale));
    let w = Math.max(1, width >> 1);
    let h = Math.max(1, height >> 1);
    this.bright.setSize(w, h);
    this.rays.setSize(Math.max(1, width >> 2), Math.max(1, height >> 2));
    this.held.setSize(width, height);
    for (let i = 0; i < BLOOM_LEVELS; i++) {
      w = Math.max(1, w >> 1);
      h = Math.max(1, h >> 1);
      this.down[i].setSize(w, h);
      this.up[i].setSize(w, h);
    }
  }

  private run(material: ShaderMaterial, renderer: WebGLRenderer, target: WebGLRenderTarget | null): void {
    this.quad.material = material;
    renderer.setRenderTarget(target);
    renderer.render(this.quadScene, this.quadCam);
  }

  render(renderer: WebGLRenderer, scene: Scene, camera: PerspectiveCamera, params: FrameParams): void {
    // mirror pass: the reflected world, fogged only above the water (see applyAtmosphere)
    if (this.reflection.update(camera)) {
      this.reflection.camera.layers.set(0);
      G.uCamPos.value.copy(this.reflection.camera.position);
      G.uReflPass.value = 1;
      renderer.setRenderTarget(this.reflection.target);
      renderer.render(scene, this.reflection.camera);
    }
    G.uCamPos.value.copy(camera.position);
    G.uReflPass.value = 0;
    renderer.setRenderTarget(this.sceneRT);
    renderer.render(scene, camera);

    // bloom: bright pass, then down and back up a mip chain
    this.mBright.uniforms.tSrc.value = this.sceneRT.texture;
    (this.mBright.uniforms.uTexel.value as Vector2).set(1 / this.width, 1 / this.height);
    this.run(this.mBright, renderer, this.bright);
    let src = this.bright;
    for (let i = 0; i < BLOOM_LEVELS; i++) {
      this.mDown.uniforms.tSrc.value = src.texture;
      (this.mDown.uniforms.uTexel.value as Vector2).set(1 / src.width, 1 / src.height);
      this.run(this.mDown, renderer, this.down[i]);
      src = this.down[i];
    }
    let upSrc = this.down[BLOOM_LEVELS - 1];
    for (let i = BLOOM_LEVELS - 2; i >= 0; i--) {
      this.mUp.uniforms.tSrc.value = upSrc.texture;
      this.mUp.uniforms.tPrev.value = this.down[i].texture;
      (this.mUp.uniforms.uTexel.value as Vector2).set(1 / upSrc.width, 1 / upSrc.height);
      this.run(this.mUp, renderer, this.up[i]);
      upSrc = this.up[i];
    }

    // light shafts when the sun is low and near (or just outside) the frame
    const sunDir = G.uSunDir.value;
    this.sunNdc.copy(camera.position).addScaledVector(sunDir, 1000).project(camera);
    const facing = this.sunNdc.z < 1 && sunDir.y > -0.03;
    const onScreen = facing ? Math.max(0, 1 - Math.max(Math.abs(this.sunNdc.x), Math.abs(this.sunNdc.y)) * 0.6) : 0;
    const rayAmount = onScreen * (1 - params.night) * (1 - Math.min(1, Math.max(0, sunDir.y - 0.25) * 3));
    if (rayAmount > 0.01) {
      this.mRays.uniforms.tSrc.value = this.bright.texture;
      (this.mRays.uniforms.uSun.value as Vector2).set(this.sunNdc.x * 0.5 + 0.5, this.sunNdc.y * 0.5 + 0.5);
      this.mRays.uniforms.uAspect.value = this.width / this.height;
      this.run(this.mRays, renderer, this.rays);
    }

    const u = this.mComposite.uniforms;
    u.tScene.value = this.sceneRT.texture;
    u.tBloom.value = upSrc.texture;
    u.tRays.value = this.rays.texture;
    u.uRays.value = rayAmount * 0.55;
    (u.uRayColor.value as Color).set(1.0, 0.82, 0.6);
    u.uExposure.value = params.exposure;
    u.uFade.value = params.fade;
    (u.uFadeColor.value as Color).copy(params.fadeColor);
    u.uFrame.value = this.frame++ % 1000;
    u.uNight.value = params.night;
    // bars that crop to 2.35:1 on landscape screens, a slimmer frame on portrait ones
    const aspect = this.width / this.height;
    this.bar = aspect > 1 ? Math.max(0, (1 - aspect / 2.35) / 2) : 0.06;
    u.uLetter.value = params.letterbox * this.bar;
    if (params.hold) {
      // keep this frame as it is shown, for the dissolve to come (the held texture unbound meanwhile: a
      // pass may not read the target it writes)
      u.tHeld.value = null;
      u.uDissolve.value = 0;
      this.run(this.mComposite, renderer, this.held);
    }
    u.tHeld.value = this.held.texture;
    u.uDissolve.value = params.dissolve ?? 0;
    this.run(this.mComposite, renderer, null);
  }
}
