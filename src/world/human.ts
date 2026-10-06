import {
  Bone,
  BufferAttribute,
  BufferGeometry,
  DataTexture,
  DoubleSide,
  FloatType,
  Group,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  NearestFilter,
  Quaternion,
  RGBAFormat,
  Raycaster,
  Skeleton,
  SkinnedMesh,
  Sphere,
  Vector2,
  Vector3,
  Vector4,
} from 'three';
import type { IUniform, Material } from 'three';
import { patchMaterial } from '../render/patch';
import { HUMANS, type HumanData, type HumanName, type RadiusMap } from './humanData';

// A person as games build one: MakeHuman's CC0 body (humanData.ts) on a skeleton, its skin following its bones
// by weights, with a photographed skin, eyes, eyebrows, eyelashes and hair cards. The scene's own posing (the
// boatman's and the girl's IK, their balance and gaze) says where the joints go; this turns that into the
// bones: the hips and a spine bending in five steps, the neck in three, the head, eyes that look and lids that
// blink; thighs and shins about the knee's hinge, the feet; collarbones, upper arms about the elbow's hinge,
// forearms twisting toward the wrist in two steps (as a forearm does), and hands closed round what they hold,
// each finger wrapped round the bar. Every bone is a direct child of `group` with no rotation in the bind
// pose, so a bone's pose is simply where its head goes and how it turns from the bind (a point p of the bind
// goes to at + q·(p − head)). Positions here are in `group`'s frame, which is its owner's frame.

const SIDES = ['R', 'L'] as const;
/** In the scene a side is −1 (his right, −x) or +1 (his left, +x). */
const suffix = (side: number) => (side < 0 ? 'R' : 'L');

/** A power grip: the bar across the palm on a slant from the heel of the hand to the index knuckle, the wrist cocked back. */
const GRIP_SLANT = 0.3;
const WRIST_EXTENSION = 0.3;
/** From the knuckles' joints to the palm's skin, and the knuckles above the bar, for a hand 1.64 m tall (scaled by the hand). */
const PALM_DEPTH = 0.0142;
const KNUCKLE_LIFT = 0.01;
const FINGER_RADIUS = 0.0092;
const THUMB_RADIUS = 0.0105;
/** How far the eyes turn from straight ahead, and blinks: how often (s, a range) and how long. */
const EYE_REACH = 0.45;
const BLINK = { min: 2.2, max: 6.5, close: 0.07, open: 0.16 };
// Loose hair in the wind, before the skinning (in the head's bind frame), as hair really answers it: most of it
// barely stirs, and now and then a few locks (`aLock`, each card its own number) lift and go back, each on its
// own time, more of them in a gust. Each moves within its reach (`aFree`, m: none at the roots, most at the ends
// and down the back, as the build measures it), downwind and lifted with the air past it, with a little ripple of
// its own; never in toward the head and body (the part of a move toward the neck's line is taken out), and never
// down or forward over the face (`uHairFace`: the brow's height and the face's front plane), so the eyes stay clear.
const HAIR_PARS = /* glsl */ `
attribute float aFree;
attribute float aLock;
uniform vec4 uHairWind;
uniform vec2 uHairAxis;
uniform vec2 uHairFace;
`;
const HAIR_CODE = /* glsl */ `
if (aFree > 0.0) {
  float hr = aFree;
  vec3 hp = transformed;
  float ht = uHairWind.w;
  vec3 hw = uHairWind.xyz;
  float hs = length(hw);
  // the gust here now, and whether this lock is one the air has taken: its own slow chance in time
  float gust = 0.55 + 0.9 * vnoise(vec2(ht * 0.3, hp.x * 3.0 + hp.z * 2.0));
  float lockT = vnoise(vec2(ht * (0.32 + 0.25 * aLock) + aLock * 37.0, aLock * 11.0));
  float taken = smoothstep(0.74 - 0.12 * min(1.0, hs * gust * 0.12), 0.9, lockT);
  vec3 ripple = vec3(vnoise(hp.yz * 23.0 + vec2(ht * 2.1, aLock * 9.0)), vnoise(hp.xz * 23.0 + vec2(aLock * 5.0, ht * 1.8)), vnoise(hp.xy * 23.0 + vec2(ht * 2.4, 3.0))) - 0.5;
  vec3 down = hw / max(hs, 0.001);
  vec3 hd = down * min(1.0, 0.08 * hs * gust) + vec3(0.0, 0.45 * min(1.0, 0.07 * hs * gust), 0.0) + ripple * (0.25 + 0.04 * hs);
  // all of it stirs a little with the air; the taken locks lift and stream
  hd *= hr * (0.1 + 0.9 * taken);
  vec2 inward = normalize(uHairAxis - hp.xz + vec2(1e-5));
  float hin = dot(hd.xz, inward);
  if (hin > 0.0) hd.xz -= inward * hin;
  // over the face: only up and back
  if (hp.z > uHairFace.y && hp.y < uHairFace.x) {
    hd.y = max(hd.y, 0.0);
    hd.z = min(hd.z, 0.0);
  }
  float hl = length(hd);
  if (hl > hr) hd *= hr / hl;
  transformed += hd;
}
`;

// Dual quaternion skinning: each bone's pose as a dual quaternion (its turn, and its move), blended by the
// weights and applied as one rigid motion, so a shoulder raised or a forearm twisted keeps its volume where the
// usual blend of matrices collapses it (the "candy wrapper") or swells it. Each bone takes two texels of
// `tBoneDQ`: its rotation, then its dual part.
const DQ_PARS = /* glsl */ `
uniform highp sampler2D tBoneDQ;
vec3 dqRotate(vec4 q, vec3 v) { return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v); }
`;
const DQ_BASE = /* glsl */ `
#ifdef USE_SKINNING
  ivec4 dqI = ivec4(skinIndex) * 2;
  vec4 dqR0 = texelFetch(tBoneDQ, ivec2(dqI.x, 0), 0);
  vec4 dqD0 = texelFetch(tBoneDQ, ivec2(dqI.x + 1, 0), 0);
  vec4 dqR1 = texelFetch(tBoneDQ, ivec2(dqI.y, 0), 0);
  vec4 dqD1 = texelFetch(tBoneDQ, ivec2(dqI.y + 1, 0), 0);
  vec4 dqR2 = texelFetch(tBoneDQ, ivec2(dqI.z, 0), 0);
  vec4 dqD2 = texelFetch(tBoneDQ, ivec2(dqI.z + 1, 0), 0);
  vec4 dqR3 = texelFetch(tBoneDQ, ivec2(dqI.w, 0), 0);
  vec4 dqD3 = texelFetch(tBoneDQ, ivec2(dqI.w + 1, 0), 0);
  // each on the first one's side, so the blend takes the short way round
  float dqS1 = dot(dqR0, dqR1) < 0.0 ? -1.0 : 1.0;
  float dqS2 = dot(dqR0, dqR2) < 0.0 ? -1.0 : 1.0;
  float dqS3 = dot(dqR0, dqR3) < 0.0 ? -1.0 : 1.0;
  vec4 dqR = dqR0 * skinWeight.x + dqR1 * (skinWeight.y * dqS1) + dqR2 * (skinWeight.z * dqS2) + dqR3 * (skinWeight.w * dqS3);
  vec4 dqD = dqD0 * skinWeight.x + dqD1 * (skinWeight.y * dqS1) + dqD2 * (skinWeight.z * dqS2) + dqD3 * (skinWeight.w * dqS3);
  float dqLen = max(length(dqR), 1e-6);
  dqR /= dqLen;
  dqD /= dqLen;
#endif
`;
const DQ_NORMAL = /* glsl */ `
#ifdef USE_SKINNING
  objectNormal = dqRotate(dqR, objectNormal);
  #ifdef USE_TANGENT
  objectTangent = dqRotate(dqR, objectTangent);
  #endif
#endif
`;
const DQ_POSITION = /* glsl */ `
#ifdef USE_SKINNING
  transformed = dqRotate(dqR, transformed) + 2.0 * (dqR.w * dqD.xyz - dqD.w * dqR.xyz + cross(dqR.xyz, dqD.xyz));
#endif
`;

const v1 = new Vector3();
const moved = new Vector3();
const v2 = new Vector3();
const v3 = new Vector3();
const q1 = new Quaternion();
const q2 = new Quaternion();
const m1 = new Matrix4();
const hb = { a: new Vector3(), f: new Vector3(), d: new Vector3(), ad: new Vector3(), y: new Vector3(), z: new Vector3() };
const Y = new Vector3();
const X = new Vector3();
const Z = new Vector3();
// the limbs' own scratch (posing runs every frame for every person: nothing is made there)
const limbRoot = new Vector3();
const limbHinge = new Vector3();
const qHinge = new Quaternion();
const qTwist = new Quaternion();

/** What each ray laid on a character's body met (`Human.cast`), by the character's data. */
const castMemo = new WeakMap<HumanData, Map<string, { point: Vector3; normal: Vector3 } | null>>();

/** A side's bones that are posed every frame, looked up once. */
interface SideBones {
  clavicle: number;
  shoulder01: number;
  upperarm01: number;
  upperarm02: number;
  lowerarm01: number;
  lowerarm02: number;
  wrist: number;
  upperleg01: number;
  upperleg02: number;
  lowerleg01: number;
  lowerleg02: number;
  foot: number;
  eye: number;
  lidUpper: number;
  lidLower: number;
  /** Which way the eye looks in the bind (head to tail). */
  eyeAxis: Vector3;
}

/** The rotation whose y axis is `dir` and x axis `side` (made square to it). */
function frame(dir: Vector3, side: Vector3, out: Quaternion): Quaternion {
  Y.copy(dir).normalize();
  X.copy(side).addScaledVector(Y, -side.dot(Y));
  if (X.lengthSq() < 1e-10) X.set(1, 0, 0).addScaledVector(Y, -Y.x);
  X.normalize();
  Z.crossVectors(X, Y);
  return out.setFromRotationMatrix(m1.makeBasis(X, Y, Z));
}

const vec = (p: readonly number[]) => new Vector3(p[0], p[1], p[2]);

/** Where a hand's bones sit round a bar of one radius, in the bar's frame (see `Human.grip`). */
export interface Grip {
  /** The wrist joint, in the bar's frame. */
  wrist: Vector3;
  /** Which way the forearm runs into the wrist, in the bar's frame. */
  fore: Vector3;
  /** Across the knuckles toward the index finger, in the bar's frame. */
  across: Vector3;
  bones: { index: number; at: Vector3; q: Quaternion }[];
}

/** The skin's distance from a radius map's axis at height `y` (relative to its origin) and angle `th`, and the row's middle. */
export function radiusAt(map: RadiusMap, y: number, th: number): { r: number; zc: number } {
  const f = Math.min(map.rows - 1.001, Math.max(0, (y - map.y0) / map.dy));
  const k = Math.floor(f);
  const t = f - k;
  const a = ((((th / (Math.PI * 2)) % 1) + 1) % 1) * map.angles;
  const i = Math.floor(a);
  const s = a - i;
  const j = (i + 1) % map.angles;
  const at = (row: number, col: number) => map.r[row * map.angles + col];
  const r0 = at(k, i) * (1 - s) + at(k, j) * s;
  const r1 = at(k + 1, i) * (1 - s) + at(k + 1, j) * s;
  return { r: r0 * (1 - t) + r1 * t, zc: map.zc[k] * (1 - t) + map.zc[k + 1] * t };
}

/**
 * The smallest ellipse (squared to the body) round a radius map's row at height `y` holding all of its skin:
 * middle (z), half-width and half-depth. Clothes are sized from it, so it must hug the body: a body's section is
 * no ellipse (the buttocks stand out behind the hips), and an ellipse first fitted to the widest and deepest
 * points then grown until it held them all came out up to 18% too wide round the hips (every lungi and skirt
 * looked inflated at the waist). So the half-width and the middle are searched for the least area that still
 * holds every point.
 */
export function enclosing(map: RadiusMap, y: number): { zc: number; a: number; b: number } {
  let xMax = 0;
  let front = 0;
  let back = 0;
  const pts: [number, number][] = [];
  const zc0 = radiusAt(map, y, 0).zc;
  for (let k = 0; k < map.angles; k++) {
    const th = (k / map.angles) * Math.PI * 2;
    const { r } = radiusAt(map, y, th);
    const x = Math.sin(th) * r;
    const z = Math.cos(th) * r;
    pts.push([x, z]);
    xMax = Math.max(xMax, Math.abs(x));
    front = Math.max(front, z);
    back = Math.max(back, -z);
  }
  let best = { zc: zc0 + (front - back) / 2, a: Infinity, b: Infinity };
  for (let grow = 0; grow <= 0.4; grow += 0.005) {
    const a = xMax * (1 + grow);
    for (let dz = -0.03; dz <= 0.03; dz += 0.0025) {
      const c = (front - back) / 2 + dz;
      // the least half-depth holding every point at this half-width and middle
      let b = 0;
      for (const [x, z] of pts) b = Math.max(b, Math.abs(z - c) / Math.sqrt(Math.max(1e-6, 1 - (x / a) ** 2)));
      if (a * b < best.a * best.b) best = { zc: zc0 + c, a, b };
    }
  }
  return best;
}

/** The materials of the parts the clothes make (by part name: 'vest', 'blouse'). */
export type Garments = Record<string, Material>;

export interface HumanOptions {
  /** Hair worn loose: it moves in the wind (`hairWind`). */
  flowingHair?: boolean;
}

export class Human {
  readonly group = new Group();
  readonly data: HumanData;
  readonly bones: Bone[];
  /** Bind lengths and heights for the scene's IK (m). */
  readonly dims: {
    thigh: number;
    shin: number;
    upperArm: number;
    foreArm: number;
    /** The ankle joint above the sole. */
    ankle: number;
    /** spine05's head above the soles: the point the hips turn about. */
    pelvis: number;
  };
  /** Posed this frame: spine01's head and the chest's turn; spine05's head and the hips'. */
  readonly chest = new Vector3();
  readonly chestQ = new Quaternion();
  readonly pelvis = new Vector3();
  readonly pelvisQ = new Quaternion();
  readonly headQ = new Quaternion();
  /** The head bone's head (the top of the neck), posed. */
  readonly head = new Vector3();

  private readonly bind: Vector3[];
  private readonly at: Vector3[];
  private readonly q: Quaternion[];
  private readonly index = new Map<string, number>();
  /** The bones posed every frame, looked up once: the trunk's, and each side's (0 his right, 1 his left). */
  private readonly ix: { root: number; spine05: number; spine: readonly number[]; neck: readonly number[]; head: number; sides: readonly SideBones[] };
  private readonly grips = new Map<string, Grip>();
  /** Per side (0 his right, 1 his left): bind frames of the limbs and the hand's across. */
  private readonly limb: {
    upper: Quaternion;
    foreHinge: Quaternion;
    foreTwist: Quaternion;
    thigh: Quaternion;
    shin: Quaternion;
    across: Vector3;
    hinge: Vector3;
    knee: Vector3;
  }[] = [];
  private readonly shrug = [new Quaternion(), new Quaternion()];
  private surfaces: Mesh[] | null = null;
  private readonly meshes: SkinnedMesh[] = [];
  /** The bones' poses as dual quaternions for the skinning, written as they are set and sent on `commit`. */
  private readonly dq: Float32Array;
  private readonly dqTexture: DataTexture;
  private readonly dqUniform: IUniform<DataTexture>;
  private nextBlink = 1.5;
  private blinkAt = -10;
  /** Loose hair's air: xyz the air moving past the head (m/s, in the head's bind frame), w seconds. */
  readonly hairWind = new Vector4();

  constructor(name: HumanName, garments: Garments = {}, options: HumanOptions = {}) {
    const data = (this.data = HUMANS[name]);
    this.group.name = `human:${name}`;
    data.names.forEach((n, i) => this.index.set(n, i));
    this.bind = data.bones.map((b) => vec(b.head));
    const sideBones = (s: 'R' | 'L'): SideBones => {
      const eye = this.bi(`eye.${s}`);
      return {
        clavicle: this.bi(`clavicle.${s}`),
        shoulder01: this.bi(`shoulder01.${s}`),
        upperarm01: this.bi(`upperarm01.${s}`),
        upperarm02: this.bi(`upperarm02.${s}`),
        lowerarm01: this.bi(`lowerarm01.${s}`),
        lowerarm02: this.bi(`lowerarm02.${s}`),
        wrist: this.bi(`wrist.${s}`),
        upperleg01: this.bi(`upperleg01.${s}`),
        upperleg02: this.bi(`upperleg02.${s}`),
        lowerleg01: this.bi(`lowerleg01.${s}`),
        lowerleg02: this.bi(`lowerleg02.${s}`),
        foot: this.bi(`foot.${s}`),
        eye,
        lidUpper: this.bi(`orbicularis03.${s}`),
        lidLower: this.bi(`orbicularis04.${s}`),
        eyeAxis: vec(data.bones[eye].tail).sub(this.bind[eye]).normalize(),
      };
    };
    this.ix = {
      root: this.bi('root'),
      spine05: this.bi('spine05'),
      spine: ['spine04', 'spine03', 'spine02', 'spine01'].map((n) => this.bi(n)),
      neck: ['neck01', 'neck02', 'neck03'].map((n) => this.bi(n)),
      head: this.bi('head'),
      sides: SIDES.map(sideBones),
    };
    this.at = this.bind.map((p) => p.clone());
    this.q = this.bind.map(() => new Quaternion());
    this.bones = data.bones.map((_, i) => {
      const bone = new Bone();
      bone.name = data.names[i];
      bone.position.copy(this.bind[i]);
      this.group.add(bone);
      return bone;
    });
    const skeleton = new Skeleton(
      this.bones,
      this.bind.map((p) => new Matrix4().makeTranslation(-p.x, -p.y, -p.z)),
    );
    this.dq = new Float32Array(this.bones.length * 8);
    this.dqTexture = new DataTexture(this.dq, this.bones.length * 2, 1, RGBAFormat, FloatType);
    this.dqTexture.magFilter = this.dqTexture.minFilter = NearestFilter;
    this.dqUniform = { value: this.dqTexture };
    this.bind.forEach((p, i) => this.set(i, p, q1.identity()));
    this.commit();

    const H = (n: string) => this.bind[this.bi(n)];
    this.dims = {
      thigh: H('lowerleg01.L').distanceTo(H('upperleg01.L')),
      shin: H('foot.L').distanceTo(H('lowerleg01.L')),
      upperArm: H('lowerarm01.L').distanceTo(H('upperarm01.L')),
      foreArm: H('wrist.L').distanceTo(H('lowerarm01.L')),
      ankle: H('foot.L').y,
      pelvis: H('spine05').y,
    };
    for (const s of SIDES) {
      const u0 = v1.subVectors(H(`lowerarm01.${s}`), H(`upperarm01.${s}`)).normalize().clone();
      const f0 = v2.subVectors(H(`wrist.${s}`), H(`lowerarm01.${s}`)).normalize().clone();
      const hinge = new Vector3().crossVectors(u0, f0).normalize();
      const across = v3.subVectors(H(`finger2-1.${s}`), H(`finger5-1.${s}`)).normalize().clone();
      const d0 = new Vector3().subVectors(H(`lowerleg01.${s}`), H(`upperleg01.${s}`)).normalize();
      const e0 = new Vector3().subVectors(H(`foot.${s}`), H(`lowerleg01.${s}`)).normalize();
      const knee = new Vector3().crossVectors(d0, e0).normalize();
      this.limb.push({
        upper: frame(u0, hinge, new Quaternion()).invert(),
        foreHinge: frame(f0, hinge, new Quaternion()).invert(),
        foreTwist: frame(f0, across, new Quaternion()).invert(),
        thigh: frame(d0, knee, new Quaternion()).invert(),
        shin: frame(e0, knee, new Quaternion()).invert(),
        across,
        hinge: hinge.clone(),
        knee: knee.clone(),
      });
    }

    // materials: a photographed skin that scatters a little light, with the soft sheen of its fine down at the
    // edges and a skin's weaker gloss; wet, glossy eyes; cards of hair, brows and lashes
    const tex = data.textures;
    const skin = patchMaterial(
      new MeshPhysicalMaterial({ map: tex.skin, roughness: 0.52, specularIntensity: 0.7, sheen: 0.35, sheenRoughness: 0.55, sheenColor: '#e6b8a0' }),
      { translucency: 0.25, skin: 0.36 },
    );
    const eyes = patchMaterial(
      new MeshPhysicalMaterial({ map: tex.eyes, roughness: 0.25, clearcoat: 1, clearcoatRoughness: 0.04, alphaTest: 0.5 }),
      {},
    );
    const cards = (map: typeof tex.hair, roughness: number, alphaTest: number) =>
      patchMaterial(new MeshStandardMaterial({ map, roughness, alphaTest, alphaToCoverage: true, side: DoubleSide }), { translucency: 0.5 });
    const neck = this.bindOf('neck01');
    const hair = options.flowingHair
      ? patchMaterial(new MeshStandardMaterial({ map: tex.hair, roughness: 0.48, alphaTest: 0.4, alphaToCoverage: true, side: DoubleSide }), {
          translucency: 0.6,
          vertex: {
            key: 'hairwind',
            pars: HAIR_PARS,
            code: HAIR_CODE,
            uniforms: {
              uHairWind: { value: this.hairWind },
              uHairAxis: { value: new Vector2(neck.x, neck.z) },
              // above the brows, and in front of the eyes' backs: the face the wind must not cover
              uHairFace: { value: new Vector2(this.bindOf('eye.L').y + 0.06, this.bindOf('eye.L').z - 0.05) },
            },
          },
        })
      : cards(tex.hair, 0.5, 0.4);
    const materials: Record<string, Material> = {
      body: skin,
      eyes,
      brows: cards(tex.brows, 0.8, 0.3),
      lashes: cards(tex.lashes, 0.8, 0.3),
      hair,
      ...garments,
    };

    // the garments' edges are cut by alpha (their vertex colours' alpha, white otherwise: the cloth materials
    // read vertex colours), smoothed by the multisampling
    for (const m of Object.values(garments)) {
      m.alphaTest = 0.5;
      m.alphaToCoverage = true;
    }
    for (const m of new Set(Object.values(materials))) this.dualQuaternions(m);
    for (const [key, part] of Object.entries(data.parts)) {
      const g = new BufferGeometry();
      g.setAttribute('position', new BufferAttribute(part.position, 3));
      g.setAttribute('normal', new BufferAttribute(part.normal, 3, true));
      g.setAttribute('uv', new BufferAttribute(part.uv, 2));
      g.setAttribute('skinIndex', new BufferAttribute(part.skinIndex, 4));
      g.setAttribute('skinWeight', new BufferAttribute(part.skinWeight, 4, true));
      if (key === 'hair' && options.flowingHair) {
        // how far the air may move each part of it (mm in the data)
        const n = part.position.length / 3;
        const free = new Float32Array(n);
        const lock = new Float32Array(n);
        for (let i = 0; i < n; i++) {
          free[i] = (part.free?.[i] ?? 0) / 1000;
          lock[i] = (part.lock?.[i] ?? 0) / 255;
        }
        g.setAttribute('aFree', new BufferAttribute(free, 1));
        g.setAttribute('aLock', new BufferAttribute(lock, 1));
      }
      if (garments[key]) {
        const n = part.position.length / 3;
        const rgba = new Float32Array(n * 4).fill(1);
        if (part.cut) for (let i = 0; i < n; i++) rgba[i * 4 + 3] = part.cut[i] / 255;
        g.setAttribute('color', new BufferAttribute(rgba, 4));
      }
      g.setIndex(new BufferAttribute(part.index, 1));
      const mesh = new SkinnedMesh(g, materials[key] ?? skin);
      mesh.name = key;
      mesh.bind(skeleton, new Matrix4());
      // posed, the body keeps within this of its hips (moved with them in setTrunk)
      mesh.boundingSphere = new Sphere(new Vector3(0, data.height * 0.55, 0), data.height * 0.9);
      this.meshes.push(mesh);
      mesh.castShadow = false;
      mesh.receiveShadow = true;
      this.group.add(mesh);
    }
  }

  /** A bone's index by MakeHuman's name. */
  bi(name: string): number {
    const i = this.index.get(name);
    if (i === undefined) throw new Error(`no bone ${name}`);
    return i;
  }

  /** A bone's bind head. */
  bindOf(name: string): Vector3 {
    return this.bind[this.bi(name)];
  }

  /** Skins a material's meshes by dual quaternions (see DQ_BASE): its shader's skinning steps replaced. */
  private dualQuaternions(m: Material): void {
    const before = m.onBeforeCompile;
    const key = m.customProgramCacheKey();
    m.onBeforeCompile = (shader, renderer) => {
      before.call(m, shader, renderer);
      shader.uniforms.tBoneDQ = this.dqUniform;
      shader.vertexShader = shader.vertexShader
        .replace('void main() {', `${DQ_PARS}
void main() {`)
        .replace('#include <skinbase_vertex>', DQ_BASE)
        .replace('#include <skinnormal_vertex>', DQ_NORMAL)
        .replace('#include <skinning_vertex>', DQ_POSITION);
    };
    m.customProgramCacheKey = () => `${key}|dq`;
  }

  /** Sends this frame's pose to the skinning. Call once the bones are set. */
  commit(): void {
    this.dqTexture.needsUpdate = true;
  }

  /** Poses bone `i`: its head at `at`, turned by `q` from the bind (so a bind point p goes to at + q·(p − head)). */
  private set(i: number, at: Vector3, q: Quaternion): void {
    this.at[i].copy(at);
    this.q[i].copy(q);
    this.bones[i].position.copy(at);
    this.bones[i].quaternion.copy(q);
    // the motion p → q·p + t, with t = at − q·head: its dual quaternion is (q, ½ t q)
    const t = moved.copy(this.bind[i]).applyQuaternion(q).negate().add(at);
    const o = i * 8;
    this.dq[o] = q.x;
    this.dq[o + 1] = q.y;
    this.dq[o + 2] = q.z;
    this.dq[o + 3] = q.w;
    this.dq[o + 4] = 0.5 * (t.x * q.w + t.y * q.z - t.z * q.y);
    this.dq[o + 5] = 0.5 * (-t.x * q.z + t.y * q.w + t.z * q.x);
    this.dq[o + 6] = 0.5 * (t.x * q.y - t.y * q.x + t.z * q.w);
    this.dq[o + 7] = -0.5 * (t.x * q.x + t.y * q.y + t.z * q.z);
  }

  /** Poses bone `i` rigidly with bone `parent` (its head carried by the parent's turn). */
  private follow(i: number, parent: number, q: Quaternion = this.q[parent]): void {
    v1.subVectors(this.bind[i], this.bind[parent]).applyQuaternion(this.q[parent]).add(this.at[parent]);
    this.set(i, v1, q);
  }

  /**
   * Sets the hips and the spine: spine05's head (the point the hips turn about) at `pelvis`, the hips turned by
   * `pelvisQ` and the upper chest by `chestQ`, the spine between bending in even steps. Then the collarbones,
   * each lifted or brought forward by its shrug (see `setShrug`).
   */
  setTrunk(pelvis: Vector3, pelvisQ: Quaternion, chestQ: Quaternion): void {
    this.pelvis.copy(pelvis);
    this.pelvisQ.copy(pelvisQ);
    this.chestQ.copy(chestQ);
    const { root, spine05, spine } = this.ix;
    v2.subVectors(this.bind[root], this.bind[spine05]).applyQuaternion(pelvisQ).add(pelvis);
    this.set(root, v2, pelvisQ);
    // the bend from the hips to the chest shared along the spine, a little of it in the lower back too
    q2.copy(pelvisQ).invert().multiply(chestQ);
    this.set(spine05, pelvis, q1.identity().slerp(q2, 0.12).premultiply(pelvisQ));
    let prev = spine05;
    for (let k = 0; k < spine.length; k++) {
      const i = spine[k];
      q1.identity().slerp(q2, (k + 1) / spine.length).premultiply(pelvisQ);
      v1.subVectors(this.bind[i], this.bind[prev]).applyQuaternion(this.q[prev]).add(this.at[prev]);
      this.set(i, v1, q1);
      prev = i;
    }
    this.chest.copy(this.at[prev]);
    for (const m of this.meshes) m.boundingSphere?.center.copy(pelvis);
    for (let k = 0; k < 2; k++) {
      const b = this.ix.sides[k];
      q1.copy(chestQ).multiply(this.shrug[k]);
      v1.subVectors(this.bind[b.clavicle], this.bind[prev]).applyQuaternion(chestQ).add(this.chest);
      this.set(b.clavicle, v1, q1);
      this.follow(b.shoulder01, b.clavicle);
    }
  }

  /** Turns a collarbone (in the chest's frame) before `setTrunk`: `lift` raises the shoulder, `forward` brings it forward (rad). */
  setShrug(side: number, lift: number, forward: number): void {
    const k = side < 0 ? 0 : 1;
    const s = side < 0 ? -1 : 1;
    this.shrug[k].setFromAxisAngle(v1.set(0, 0, 1), s * lift).multiply(q1.setFromAxisAngle(v2.set(0, 1, 0), -s * forward));
  }

  /** Where a shoulder joint is now (the upper arm's head), after `setTrunk`. */
  shoulder(side: number, out: Vector3): Vector3 {
    const b = this.ix.sides[side < 0 ? 0 : 1];
    return out.subVectors(this.bind[b.upperarm01], this.bind[b.shoulder01]).applyQuaternion(this.q[b.shoulder01]).add(this.at[b.shoulder01]);
  }

  /** Where a hip joint is now, after `setTrunk`. */
  hip(side: number, out: Vector3): Vector3 {
    const { root } = this.ix;
    return out.subVectors(this.bind[this.ix.sides[side < 0 ? 0 : 1].upperleg01], this.bind[root]).applyQuaternion(this.q[root]).add(this.at[root]);
  }

  /** A point of the bind carried by the chest (spine01) as it is now. */
  onChest(p: Vector3, out: Vector3): Vector3 {
    const i = this.bi('spine01');
    return out.subVectors(p, this.bind[i]).applyQuaternion(this.q[i]).add(this.at[i]);
  }

  /** A point of the bind carried by the head as it is now. */
  onHead(p: Vector3, out: Vector3): Vector3 {
    const i = this.bi('head');
    return out.subVectors(p, this.bind[i]).applyQuaternion(this.q[i]).add(this.at[i]);
  }

  /**
   * Sets the neck and head: the head turned by `headQ`, the neck sharing the turn from the chest; the eyes on
   * `look` (a point in the group's frame; straight ahead if null), within their reach; and now and then a blink.
   * `time` in seconds.
   */
  setHead(headQ: Quaternion, look: Vector3 | null, time: number): void {
    this.headQ.copy(headQ);
    q2.copy(this.chestQ).invert().multiply(headQ);
    const { neck, head, spine } = this.ix;
    let prev = spine[spine.length - 1];
    for (let k = 0; k < neck.length; k++) {
      const i = neck[k];
      q1.identity().slerp(q2, (k + 0.6) / (neck.length + 0.4)).premultiply(this.chestQ);
      v1.subVectors(this.bind[i], this.bind[prev]).applyQuaternion(this.q[prev]).add(this.at[prev]);
      this.set(i, v1, q1);
      prev = i;
    }
    v1.subVectors(this.bind[head], this.bind[prev]).applyQuaternion(this.q[prev]).add(this.at[prev]);
    this.set(head, v1, headQ);
    this.head.copy(v1);

    // a blink every few seconds: quick to close, slower to open
    if (time > this.nextBlink) {
      this.blinkAt = time;
      const r = Math.sin(time * 12.9898) * 43758.5453;
      this.nextBlink = time + BLINK.min + (r - Math.floor(r)) * (BLINK.max - BLINK.min);
    }
    const since = time - this.blinkAt;
    const blink = since < 0 ? 0 : since < BLINK.close ? since / BLINK.close : Math.max(0, 1 - (since - BLINK.close) / BLINK.open);

    let pitch = 0;
    for (const b of this.ix.sides) {
      const eye = b.eye;
      this.follow(eye, head);
      // the eye turns from straight ahead (its bind) toward what it looks at, in the head's frame
      q1.copy(headQ);
      if (look) {
        v2.subVectors(look, this.at[eye]).applyQuaternion(q2.copy(headQ).invert()).normalize();
        v3.copy(b.eyeAxis);
        const angle = v3.angleTo(v2);
        if (angle > EYE_REACH) v2.lerp(v3, 1 - EYE_REACH / angle).normalize();
        q1.multiply(q2.setFromUnitVectors(v3, v2));
        pitch = Math.asin(Math.max(-1, Math.min(1, -v2.y))) - Math.asin(Math.max(-1, Math.min(1, -v3.y)));
      }
      this.bones[eye].quaternion.copy(q1);
      this.q[eye].copy(q1);
      // the upper lid follows the eye down and closes over it; the lower lifts a little
      this.follow(b.lidUpper, head, q1.copy(headQ).multiply(q2.setFromAxisAngle(v1.set(1, 0, 0), Math.max(0, pitch) * 0.7 + blink * 0.62)));
      this.follow(b.lidLower, head, q1.copy(headQ).multiply(q2.setFromAxisAngle(v1.set(1, 0, 0), -blink * 0.12 + Math.max(0, pitch) * 0.2)));
    }
  }

  /**
   * Sets a leg: the thigh from the hip to `knee`, the shin to `ankle`, the foot turned `footYaw` about the
   * vertical and pitched `footPitch` (toes down) about its own across.
   */
  setLeg(side: number, knee: Vector3, ankle: Vector3, footYaw: number, footPitch = 0): void {
    const b = this.ix.sides[side < 0 ? 0 : 1];
    const L = this.limb[side < 0 ? 0 : 1];
    const hip = this.hip(side, limbRoot);
    const d = v1.subVectors(knee, hip).normalize();
    const e = v2.subVectors(ankle, knee).normalize();
    const hinge = limbHinge.crossVectors(d, e);
    if (hinge.lengthSq() < 1e-8) hinge.copy(L.knee).applyQuaternion(this.pelvisQ);
    hinge.normalize();
    frame(d, hinge, q1).multiply(L.thigh);
    this.set(b.upperleg01, hip, q1);
    this.follow(b.upperleg02, b.upperleg01);
    frame(e, hinge, q1).multiply(L.shin);
    this.set(b.lowerleg01, knee, q1);
    this.follow(b.lowerleg02, b.lowerleg01);
    q1.setFromAxisAngle(v1.set(0, 1, 0), footYaw);
    if (footPitch) q1.multiply(q2.setFromAxisAngle(v1.set(1, 0, 0), footPitch));
    this.set(b.foot, ankle, q1);
  }

  /**
   * A hand closed round a bar of radius `radius`: its bones in the bar's frame (the bar along x through the
   * origin; a right hand's index finger toward +x, a left's toward −x; the palm against the bar's −z side, the
   * fingers curling over its top and round its front, the thumb round under it), as the old anatomy.ts hands.
   */
  grip(side: number, radius: number): Grip {
    const key = `${side < 0 ? 'R' : 'L'}${radius.toFixed(4)}`;
    const known = this.grips.get(key);
    if (known) return known;
    const s = suffix(side);
    const H = (n: string) => this.bind[this.bi(`${n}.${s}`)];
    const T = (n: string) => vec(this.data.bones[this.bi(`${n}.${s}`)].tail);
    const W = H('wrist');
    const K = [2, 3, 4, 5].map((f) => H(`finger${f}-1`));
    const scale = K[0].distanceTo(K[3]) / 0.0505;
    const hx = new Vector3().subVectors(K[0], K[3]).normalize();
    const hy = new Vector3().subVectors(K[1], W);
    hy.addScaledVector(hx, -hy.dot(hx)).normalize();
    // the palm's side: a right hand's frame is right-handed, a left's mirrored
    const n = side < 0 ? new Vector3().crossVectors(hx, hy) : new Vector3().crossVectors(hy, hx);
    const bindBasis = new Matrix4().makeBasis(hx, hy, n);
    const mirror = new Matrix4().makeScale(side < 0 ? 1 : -1, 1, 1);
    const barBasis = mirror.clone().multiply(new Matrix4().makeRotationZ(-GRIP_SLANT));
    const R = new Matrix4().multiplyMatrices(barBasis, bindBasis.clone().transpose());
    const rq = new Quaternion().setFromRotationMatrix(R);
    // the bar's middle line through the palm, just below the knuckles
    const mid = K.reduce((a, k) => a.add(k), new Vector3()).multiplyScalar(0.25);
    const O = mid.addScaledVector(hy, -KNUCKLE_LIFT * scale).addScaledVector(n, PALM_DEPTH * scale + radius);
    const g = (p: Vector3) => p.clone().sub(O).applyMatrix4(R);
    const bones: Grip['bones'] = [];
    const rigid = (name: string) => bones.push({ index: this.bi(`${name}.${s}`), at: g(H(name)), q: rq.clone() });
    rigid('wrist');
    for (let k = 1; k <= 4; k++) rigid(`metacarpal${k}`);
    // a bone from `at` along `dir`, turned the least from how the hand's turn would carry it
    const aimed = (name: string, at: Vector3, dir: Vector3) => {
      const d0 = T(name).sub(H(name)).normalize().applyQuaternion(rq);
      bones.push({ index: this.bi(`${name}.${s}`), at: at.clone(), q: new Quaternion().setFromUnitVectors(d0, dir.clone().normalize()).multiply(rq) });
    };
    const around = (x: number, rho: number, phi: number) => new Vector3(x, rho * Math.sin(phi), -rho * Math.cos(phi));
    for (let f = 2; f <= 5; f++) {
      const k = g(H(`finger${f}-1`));
      const len = [1, 2, 3].map((j) => H(`finger${f}-${j}`).distanceTo(T(`finger${f}-${j}`)));
      const rho = radius + FINGER_RADIUS * scale;
      const dK = Math.hypot(k.y, k.z);
      let phi = Math.atan2(k.y, -k.z) + Math.acos(Math.max(-1, Math.min(1, (dK * dK + rho * rho - len[0] * len[0]) / (2 * dK * rho))));
      const joints = [k, around(k.x, rho, phi)];
      for (const l of [len[1], len[2]]) {
        phi += 2 * Math.asin(Math.min(1, l / (2 * rho)));
        joints.push(around(k.x, rho, phi));
      }
      for (let j = 0; j < 3; j++) aimed(`finger${f}-${j + 1}`, joints[j], v1.subVectors(joints[j + 1], joints[j]));
    }
    // the thumb: from its root by the wrist round under the bar and across its front, toward the index finger
    const sgn = side < 0 ? 1 : -1;
    const xi = g(K[0]).x;
    const rhoT = radius + THUMB_RADIUS * scale;
    const targets = [around(xi + sgn * 0.013 * scale, radius + 0.017 * scale, -1.15)];
    let phiT = -1.15 - (0.032 * scale) / rhoT;
    targets.push(around(xi + sgn * 0.001 * scale, rhoT, phiT));
    phiT -= (0.027 * scale) / rhoT;
    targets.push(around(xi - sgn * 0.012 * scale, rhoT, phiT));
    let at = g(H('finger1-1'));
    for (let j = 0; j < 3; j++) {
      const name = `finger1-${j + 1}`;
      const dir = v1.subVectors(targets[j], at).normalize().clone();
      aimed(name, at, dir);
      at = at.clone().addScaledVector(dir, H(name).distanceTo(T(name)));
    }
    const grip: Grip = {
      wrist: g(W),
      fore: new Vector3(0, Math.cos(WRIST_EXTENSION), Math.sin(WRIST_EXTENSION)).applyMatrix4(barBasis),
      across: new Vector3(1, 0, 0).applyMatrix4(barBasis),
      bones,
    };
    this.grips.set(key, grip);
    return grip;
  }

  /**
   * Closes a hand on a bar at `hold` running toward `thumb` (the hand's thumb side): the bar runs through the
   * palm, and the hand turns about it until the wrist faces the forearm, seen from `elbow` (last frame's).
   * Writes the bar's frame to `barQ` and where the wrist goes (where the arm must reach) to `wrist`; `roll`
   * keeps the forearm's line as seen down the bar from one frame to the next.
   */
  holdBar(side: number, grip: Grip, hold: Vector3, thumb: Vector3, elbow: Vector3, roll: Vector3, barQ: Quaternion, wrist: Vector3): void {
    // the bar's +x runs toward a right hand's thumb, away from a left hand's
    const a = hb.a.copy(thumb).multiplyScalar(side < 0 ? 1 : -1).normalize();
    const f = hb.f.set(0, grip.fore.y, grip.fore.z).normalize();
    roll.addScaledVector(a, -roll.dot(a));
    if (roll.lengthSq() < 1e-6) roll.set(0, -1, 0).addScaledVector(a, -a.y);
    roll.normalize();
    for (let pass = 0; pass < 2; pass++) {
      // the forearm as seen down the bar: from the elbow to the hold, then (better) to the wrist
      const d = hb.d.subVectors(pass === 0 ? hold : wrist, elbow);
      d.addScaledVector(a, -d.dot(a));
      if (d.lengthSq() > 1e-6) roll.copy(d.normalize());
      const ad = hb.ad.crossVectors(a, roll);
      hb.y.copy(roll).multiplyScalar(f.y).addScaledVector(ad, -f.z);
      hb.z.copy(roll).multiplyScalar(f.z).addScaledVector(ad, f.y);
      barQ.setFromRotationMatrix(m1.makeBasis(a, hb.y, hb.z));
      wrist.copy(grip.wrist).applyQuaternion(barQ).add(hold);
    }
  }

  /** Puts a hand on its hold: the bar's frame turned by `barQ` with its origin at `at`. */
  setHand(grip: Grip, at: Vector3, barQ: Quaternion): void {
    for (const b of grip.bones) this.set(b.index, v1.copy(b.at).applyQuaternion(barQ).add(at), q1.copy(barQ).multiply(b.q));
  }

  /**
   * Sets an arm after its hand (`setHand`): the upper arm from the shoulder to `elbow`, turned about the elbow's
   * hinge; the forearm from the elbow toward the wrist, twisting in two steps to meet the hand.
   */
  setArm(side: number, elbow: Vector3): void {
    const b = this.ix.sides[side < 0 ? 0 : 1];
    const L = this.limb[side < 0 ? 0 : 1];
    const gh = this.shoulder(side, limbRoot);
    const wrist = this.at[b.wrist];
    const u = v1.subVectors(elbow, gh).normalize();
    const f = v2.subVectors(wrist, elbow).normalize();
    const hinge = limbHinge.crossVectors(u, f);
    if (hinge.lengthSq() < 1e-8) hinge.copy(L.hinge).applyQuaternion(this.chestQ);
    hinge.normalize();
    frame(u, hinge, q1).multiply(L.upper);
    this.set(b.upperarm01, gh, q1);
    this.follow(b.upperarm02, b.upperarm01);
    // the forearm: about the hinge at the elbow, turned with the hand at the wrist
    const hingeQ = frame(f, hinge, qHinge).multiply(L.foreHinge);
    const across = v3.copy(L.across).applyQuaternion(this.q[b.wrist]);
    const twistQ = frame(f, across, qTwist).multiply(L.foreTwist);
    this.set(b.lowerarm01, elbow, q1.copy(hingeQ).slerp(twistQ, 0.4));
    this.follow(b.lowerarm02, b.lowerarm01, q1.copy(hingeQ).slerp(twistQ, 0.92));
  }

  /** A bone, to hang things on that move with it (its frame is the bind's, turned and moved with the bone). */
  bone(name: string): Bone {
    return this.bones[this.bi(name)];
  }

  /**
   * The outermost skin (or garment) the ray from `origin` along `dir` meets within a metre, in the bind pose;
   * for laying things on him (the gamchha, the orna). Every body of one character meets the same ray alike, so
   * each ray is cast once a character (the salt farms' many workers lay the same ফিতা, each ray through the
   * whole body). The result is the caller's own to change.
   */
  cast(origin: Vector3, dir: Vector3): { point: Vector3; normal: Vector3 } | null {
    let memo = castMemo.get(this.data);
    if (!memo) castMemo.set(this.data, (memo = new Map()));
    const key = `${origin.x},${origin.y},${origin.z},${dir.x},${dir.y},${dir.z}`;
    let hit = memo.get(key);
    if (hit === undefined) memo.set(key, (hit = this.castThrough(origin, dir)));
    return hit && { point: hit.point.clone(), normal: hit.normal.clone() };
  }

  private castThrough(origin: Vector3, dir: Vector3): { point: Vector3; normal: Vector3 } | null {
    if (!this.surfaces) {
      const cover = new MeshBasicMaterial({ side: DoubleSide });
      this.surfaces = Object.entries(this.data.parts)
        .filter(([k]) => !['eyes', 'brows', 'lashes', 'hair'].includes(k))
        .map(([, p]) => {
          const g = new BufferGeometry();
          g.setAttribute('position', new BufferAttribute(p.position, 3));
          g.setIndex(new BufferAttribute(p.index, 1));
          return new Mesh(g, cover);
        });
    }
    const ray = new Raycaster(origin, dir.clone().normalize(), 0, 1);
    let best: { distance: number; point: Vector3; normal: Vector3 } | null = null;
    for (const m of this.surfaces)
      for (const h of ray.intersectObject(m, false))
        if (h.face && (!best || h.distance > best.distance)) best = { distance: h.distance, point: h.point.clone(), normal: h.face.normal.clone() };
    return best && { point: best.point, normal: best.normal };
  }
}
