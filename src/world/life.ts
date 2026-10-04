import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  MeshStandardMaterial,
  Points,
  Quaternion,
  ShaderMaterial,
  Vector3,
} from 'three';
import { G, LAYER_NO_REFLECT } from '../core/globals';
import { Rng } from '../core/rng';
import { GLSL_COMMON } from '../render/glsl';
import { patchMaterial } from '../render/patch';
import { edgeHalfWidth, riverX, terrainHeight, waterLevelAt } from './geography';

// ---------- birds ----------

/** Body along +z, wings out along ±x; `aWing` marks wing vertices for the flap. */
function birdGeometry(span: number, bodyLen: number): BufferGeometry {
  const P: number[] = [];
  const W: number[] = [];
  const v = (x: number, y: number, z: number, wing: number) => {
    P.push(x, y, z);
    W.push(wing);
  };
  const b = bodyLen;
  // body: a thin diamond in two planes
  v(0, 0, b * 0.6, 0); v(0.05, 0, 0, 0); v(0, 0, -b * 0.4, 0);
  v(0, 0, b * 0.6, 0); v(0, 0, -b * 0.4, 0); v(-0.05, 0, 0, 0);
  v(0, 0, b * 0.6, 0); v(0, 0.05, 0, 0); v(0, 0, -b * 0.4, 0);
  // wings: swept back, tapering to the tip
  for (const s of [-1, 1]) {
    v(0, 0, b * 0.18, 0); v(s * span * 0.5, 0, -b * 0.12, s); v(0, 0, -b * 0.18, 0);
    v(0, 0, b * 0.18, 0); v(s * span * 0.25, 0, b * 0.05, s * 0.5); v(s * span * 0.5, 0, -b * 0.12, s);
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(P), 3));
  g.setAttribute('aWing', new BufferAttribute(new Float32Array(W), 1));
  g.computeVertexNormals();
  return g;
}

const FLAP = {
  key: 'bird-flap',
  pars: 'attribute float aWing;\nattribute vec2 aBird;\n',
  code: /* glsl */ `
  if (aWing != 0.0) {
    float bout = 0.3 + 0.7 * smoothstep(-0.3, 0.4, sin(uTime * 0.37 + aBird.x * 3.0));
    float ang = sin(uTime * aBird.y + aBird.x) * 0.7 * bout;
    float r = abs(transformed.x);
    float s = sign(aWing);
    transformed.x = s * r * cos(ang);
    transformed.y += r * sin(ang);
  }`,
};

interface Flock {
  mesh: InstancedMesh;
  offsets: Vector3[];
  center: Vector3;
  velocity: Vector3;
  life: number;
  wait: number;
  altitude: [number, number];
  speed: [number, number];
}

// ---------- particles ----------

const MOTE_VERT = /* glsl */ `
${GLSL_COMMON}
uniform float uPR;
attribute float aSeed;
varying float vA;
void main() {
  // drift in world space, wrapped into a 60 m box that travels with the camera
  vec3 p = position * 60.0 + vec3(uTime * 0.25, sin(uTime * 0.3 + aSeed * 6.0) * 0.6, uTime * 0.15) * uWind.z;
  p = uCamPos + mod(p - uCamPos + 30.0, 60.0) - 30.0;
  p.y = max(p.y, 0.3);
  vec4 mv = viewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  float d = -mv.z;
  vec3 v = normalize(p - uCamPos);
  // only visible where they catch the low sun: forward scattering
  float fwd = pow(max(dot(v, uSunDir), 0.0), 5.0);
  vA = (fwd * 1.2 + 0.04) * smoothstep(30.0, 6.0, d) * smoothstep(0.6, 2.0, d) * (1.0 - uNight) * (1.0 - smoothstep(0.05, 0.4, uRain));
  gl_PointSize = uPR * clamp(26.0 / d, 1.0, 4.0);
}`;

const MOTE_FRAG = /* glsl */ `
${GLSL_COMMON}
varying float vA;
void main() {
  float r = length(gl_PointCoord - 0.5);
  float a = smoothstep(0.5, 0.0, r) * vA;
  gl_FragColor = vec4(uSunColor * 0.35 * a, 1.0);
}`;

const FIREFLY_VERT = /* glsl */ `
${GLSL_COMMON}
uniform float uPR;
attribute float aSeed;
varying float vA;
void main() {
  vec3 p = position + vec3(sin(uTime * 0.4 + aSeed * 10.0), sin(uTime * 0.7 + aSeed * 4.0) * 0.4, cos(uTime * 0.35 + aSeed * 7.0)) * 0.8;
  vec4 mv = viewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  float d = -mv.z;
  // slow irregular blinks
  float blink = pow(max(sin(uTime * (0.6 + aSeed * 0.9) + aSeed * 40.0), 0.0), 6.0);
  vA = blink * uNight * smoothstep(160.0, 20.0, d) * (1.0 - smoothstep(0.1, 0.5, uRain));
  gl_PointSize = uPR * clamp(60.0 / d, 2.0, 7.0);
}`;

const FIREFLY_FRAG = /* glsl */ `
varying float vA;
void main() {
  float r = length(gl_PointCoord - 0.5);
  float a = (smoothstep(0.5, 0.0, r) * 0.5 + smoothstep(0.15, 0.0, r)) * vA;
  gl_FragColor = vec4(vec3(0.75, 1.0, 0.35) * a * 5.0, 1.0);
}`;

const FIREFLY_WINDOW = 360;

/** Birds crossing the river, dust in the sunbeams, fireflies along the banks after dark. */
export class Life {
  readonly group = new Group();
  private readonly rng = new Rng(91);
  private readonly flocks: Flock[] = [];
  private readonly ffBase: Float32Array;
  private readonly ffSide: Int8Array;
  private readonly ffInland: Float32Array;
  private readonly ffHeight: Float32Array;
  private readonly ffZ: Float32Array;
  private readonly ffGeometry: BufferGeometry;
  private readonly pr = { value: 1 };

  constructor() {
    this.group.name = 'life';
    const white = patchMaterial(new MeshStandardMaterial({ color: '#f2efe6', roughness: 0.8, side: DoubleSide }), {
      vertex: FLAP,
      translucency: 0.6,
    });
    const dark = patchMaterial(new MeshStandardMaterial({ color: '#1e1c1a', roughness: 0.9, side: DoubleSide }), { vertex: FLAP });
    this.flocks.push(this.flock(birdGeometry(1.6, 0.9), white, 9, [7, 16], [9, 12], false));
    this.flocks.push(this.flock(birdGeometry(1.3, 0.7), dark, 13, [35, 70], [11, 14], true));

    // motes
    const N = 500;
    const mp = new Float32Array(N * 3);
    const ms = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      mp[i * 3] = this.rng.next();
      mp[i * 3 + 1] = this.rng.next() * 0.25;
      mp[i * 3 + 2] = this.rng.next();
      ms[i] = this.rng.next();
    }
    const mg = new BufferGeometry();
    mg.setAttribute('position', new BufferAttribute(mp, 3));
    mg.setAttribute('aSeed', new BufferAttribute(ms, 1));
    const motes = new Points(
      mg,
      new ShaderMaterial({
        uniforms: { ...G, uPR: this.pr },
        vertexShader: MOTE_VERT,
        fragmentShader: MOTE_FRAG,
        blending: AdditiveBlending,
        depthWrite: false,
        transparent: true,
      }),
    );
    motes.frustumCulled = false;
    motes.layers.set(LAYER_NO_REFLECT);
    this.group.add(motes);

    // fireflies: fixed spots along both banks inside a window that travels with the boat
    const F = 480;
    this.ffBase = new Float32Array(F * 3);
    this.ffSide = new Int8Array(F);
    this.ffInland = new Float32Array(F);
    this.ffHeight = new Float32Array(F);
    this.ffZ = new Float32Array(F).fill(Number.NaN);
    const fs = new Float32Array(F);
    for (let i = 0; i < F; i++) {
      this.ffSide[i] = this.rng.sign();
      this.ffInland[i] = this.rng.range(-1, 28);
      this.ffHeight[i] = this.rng.range(0.4, 3.2);
      fs[i] = this.rng.next();
      this.ffZ[i] = this.rng.range(0, FIREFLY_WINDOW);
    }
    this.ffGeometry = new BufferGeometry();
    this.ffGeometry.setAttribute('position', new BufferAttribute(this.ffBase, 3));
    this.ffGeometry.setAttribute('aSeed', new BufferAttribute(fs, 1));
    const fireflies = new Points(
      this.ffGeometry,
      new ShaderMaterial({
        uniforms: { ...G, uPR: this.pr },
        vertexShader: FIREFLY_VERT,
        fragmentShader: FIREFLY_FRAG,
        blending: AdditiveBlending,
        depthWrite: false,
        transparent: true,
      }),
    );
    fireflies.frustumCulled = false;
    fireflies.layers.set(LAYER_NO_REFLECT);
    this.group.add(fireflies);
  }

  private flock(
    geometry: BufferGeometry,
    material: MeshStandardMaterial,
    n: number,
    altitude: [number, number],
    speed: [number, number],
    vee: boolean,
  ): Flock {
    const mesh = new InstancedMesh(geometry, material, n);
    mesh.name = 'birds';
    const bird = new Float32Array(n * 2);
    const offsets: Vector3[] = [];
    for (let i = 0; i < n; i++) {
      bird[i * 2] = this.rng.range(0, 6.28);
      bird[i * 2 + 1] = this.rng.range(7, 9.5);
      if (vee) {
        const k = Math.ceil(i / 2);
        offsets.push(new Vector3((i % 2 ? -1 : 1) * k * 2.4, this.rng.range(-0.3, 0.3), -k * 2.2));
      } else {
        offsets.push(new Vector3(this.rng.range(-9, 9), this.rng.range(-2, 2), this.rng.range(-10, 10)));
      }
    }
    geometry.setAttribute('aBird', new InstancedBufferAttribute(bird, 2));
    mesh.frustumCulled = false;
    mesh.visible = false;
    this.group.add(mesh);
    return { mesh, offsets, center: new Vector3(), velocity: new Vector3(), life: 0, wait: this.rng.range(3, 12), altitude, speed };
  }

  setPixelRatio(pr: number): void {
    this.pr.value = pr;
  }

  /** `rain`: how hard it is raining (birds stay down in a downpour). */
  update(dt: number, t: number, hero: Vector3, heading: number, night: number, rain = 0): void {
    const m = new Matrix4();
    const q = new Quaternion();
    const one = new Vector3(1, 1, 1);
    const p = new Vector3();
    const up = new Vector3(0, 1, 0);
    for (const f of this.flocks) {
      if (f.wait > 0) {
        f.wait -= dt;
        f.mesh.visible = false;
        if (f.wait <= 0 && night < 0.5 && rain < 0.4) this.launch(f, hero, heading);
        else if (f.wait <= 0) f.wait = 20;
        continue;
      }
      f.center.addScaledVector(f.velocity, dt);
      f.life -= dt;
      if (f.life <= 0) {
        f.wait = this.rng.range(14, 40);
        continue;
      }
      f.mesh.visible = true;
      const yaw = Math.atan2(f.velocity.x, f.velocity.z);
      f.offsets.forEach((o, i) => {
        p.copy(o).applyAxisAngle(up, yaw).add(f.center);
        p.y += Math.sin(t * 0.8 + i * 1.7) * 0.6;
        q.setFromAxisAngle(up, yaw + Math.sin(t * 0.5 + i) * 0.08);
        m.compose(p, q, one);
        f.mesh.setMatrixAt(i, m);
      });
      f.mesh.instanceMatrix.needsUpdate = true;
    }

    // fireflies wrap through a window running from behind the boat to well ahead of it
    const top = hero.z + 60;
    let moved = false;
    for (let i = 0; i < this.ffZ.length; i++) {
      const z = top - ((((top - this.ffZ[i]) % FIREFLY_WINDOW) + FIREFLY_WINDOW) % FIREFLY_WINDOW);
      const k = i * 3;
      if (this.ffBase[k + 2] === z && !Number.isNaN(this.ffBase[k])) continue;
      const side = this.ffSide[i];
      const x = riverX(z) + side * (edgeHalfWidth(z, side) + 3 + this.ffInland[i]);
      this.ffBase[k] = x;
      this.ffBase[k + 1] = Math.max(terrainHeight(x, z), waterLevelAt(x, z)) + this.ffHeight[i];
      this.ffBase[k + 2] = z;
      moved = true;
    }
    if (moved) (this.ffGeometry.getAttribute('position') as BufferAttribute).needsUpdate = true;
  }

  /** Debug: send every flock up now, `ahead` metres in front of the boat. */
  launchAll(hero: Vector3, heading: number, ahead: number): void {
    for (const f of this.flocks) {
      this.launch(f, hero, heading);
      const fwd = new Vector3(Math.sin(heading), 0, Math.cos(heading));
      const side = new Vector3(fwd.z, 0, -fwd.x);
      f.center.set(hero.x, f.center.y, hero.z).addScaledVector(fwd, ahead).addScaledVector(side, 15);
      f.wait = 0;
    }
  }

  private launch(f: Flock, hero: Vector3, heading: number): void {
    const fwd = new Vector3(Math.sin(heading), 0, Math.cos(heading));
    const side = new Vector3(fwd.z, 0, -fwd.x).multiplyScalar(this.rng.sign());
    const ahead = this.rng.range(140, 380);
    const speed = this.rng.range(f.speed[0], f.speed[1]);
    f.center
      .copy(hero)
      .addScaledVector(fwd, ahead)
      .addScaledVector(side, -320);
    f.center.y = this.rng.range(f.altitude[0], f.altitude[1]);
    f.velocity.copy(side).multiplyScalar(speed).addScaledVector(fwd, this.rng.range(-3, 3));
    f.life = 640 / speed;
  }
}
