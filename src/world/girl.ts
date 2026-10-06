import {
  BufferAttribute,
  BufferGeometry,
  CapsuleGeometry,
  CylinderGeometry,
  DoubleSide,
  Euler,
  Group,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  Quaternion,
  TorusGeometry,
  Vector2,
  Vector3,
  Vector4,
} from 'three';
import { G } from '../core/globals';
import { angleDelta, smoothstep, tableAt } from '../core/mathx';
import { windAt } from '../env/wind';
import { MeshBuilder, rgb, scaleRgb, type RGB } from '../render/builder';
import { patchMaterial } from '../render/patch';
import { clothTexture, lehengaTexture, paperUmbrellaTexture, softSpotTexture } from '../render/textures';
import { solveTwoBone } from './boatman';
import { ClothRibbon, ClothTube, type Ring } from './cloth';
import { BRIDGE, JOURNEY, bridgeDeck, bridgeFrame, bridgeToWorld, journeyFrame } from './geography';
import { Human, enclosing, radiusAt, type Grip } from './human';
import type { RadiusMap } from './humanData';

// The girl on the old bridge: a village girl of seventeen in a simple red lehenga, nothing of a bride's about it:
// a full, light skirt of soft crimson gathered at her waist to her ankles, scattered with small cream butis and a
// fine vine at its hem, a plain blouse a deeper red, and a sheer cream ওড়না edged in red thrown over her left
// shoulder, one end in front of her and one down her back; a few red and gold glass bangles, her long hair loose.
// In the rain she has her red Chinese paper umbrella, painted with plum blossom, open over her; when it is dry
// she has none. She is a person as games make one (human.ts), and she is not still: she breathes, shifts her weight, lets her gaze
// wander over the water and the fields, blinks. When the young majhi comes up the khal she sees him far off and
// watches him come, stepping in to the parapet and resting her hand on it; as his boat goes in under the arch
// below her she turns and crosses the deck (each foot stepping, her weight going over it, her hips swaying with
// it) to the far parapet, in time to see him come out on the other side, and she watches him go up the khal
// until he is far away, and after. The one wind (env/wind.ts) moves all of her that is loose, with the air her
// walking makes: her hair (human.ts), the lehenga's skirt and the ওড়না, the umbrella, which the
// gusts push and she holds against them, its paper stirring. She keeps the rain off what is under it. She faces
// +z in her own frame (her right is −x); her frame is moved and turned with her over the deck.

/** Where she stands by each parapet in the bridge's frame (x along it, z along the khal, the river's side −z). */
const NEAR = { x: -1.1, z: -(BRIDGE.width / 2 - 0.36) };
const FAR = { x: -0.72, z: BRIDGE.width / 2 - 0.38 };
/** How much nearer the parapet she steps to watch him (m). */
const LEAN_IN = 0.12;
/** Facing the river's side, and the far side (world yaw); she turns to her left between them. */
const YAW_NEAR = BRIDGE.angle + Math.PI;
const YAW_FAR = BRIDGE.angle + Math.PI * 2;
/** Her feet from her middle as she stands: [across, along, turned out]. */
const FEET = [
  [-0.1, 0.03, -0.18],
  [0.09, -0.04, 0.25],
] as const;
/**
 * Her steps: how long a foot swings (s), how far a foot may lag where it should be before she moves it (m, rad),
 * how far ahead of her way she puts it down (s), how high it lifts (m).
 */
const STEP = { time: 0.58, slack: 0.08, turn: 0.3, lead: 0.32, lift: 0.07 };
/** The crossing: how long it takes (s), and the share of it spent turning round. */
const CROSS = { time: 6.6, turn: 0.3 };
/**
 * Where the majhi is along his way from the bridge (m, his head) as she: sees him, has stepped in to the parapet
 * to watch, turns to cross (his bow going in under the arch), and has let him go.
 */
const WATCH = { notice: -28, lean: -16, cross: -9.5, gone: 75 };
const UP = new Vector3(0, 1, 0);

/** The lehenga's skirt, gathered at her waist, to her ankles: its top height from spine05's head. */
const SKIRT_TOP = 0.07;
/** How far below spine05's head its hem hangs, and how far it stands out there (m): light organza, full. */
const SKIRT_DROP = 0.88;
const SKIRT_FLARE = 0.27;
/** How far the blouse stands off her skin (as built), and the skirt's lining round her legs. */
const BODICE_OFF = 0.012;
const SALWAR_OFF = 0.04;

/**
 * The ওড়না, thrown over her left shoulder: 20 particles 0.1 m apart, held at three of them (in front of her
 * shoulder, on it, behind it; gathered narrow there), one end falling open in front of her to her knees and the
 * other down her back, both lifting and turning in the wind. Its width gathered and open (m).
 */
const ORNA = { count: 20, narrow: 0.1, front: 0.16, back: 0.26 };
const ORNA_PINS = [8, 9, 10];

/** The paper umbrella: from her grip up the shaft to the canopy's crown (m), the canopy's radius and depth, its ribs. */
const SHAFT = 0.74;
const CANOPY_R = 0.54;
const CANOPY_DEPTH = 0.15;
const RIBS = 32;
/** How it rests in her hand (her frame): tilted back over her head and a little inward. */
const REST = new Vector3(0.12, 1, -0.6).normalize();
/** Held up before her to open or close it, and carried closed by its handle with its tip down (her frame). */
const UPRIGHT = new Vector3(0.05, 1, 0.12).normalize();
const CANE = new Vector3(-0.3, -1, 0.42).normalize();
/** The handle, below where her hand holds the open umbrella's shaft (m). */
const HANDLE = 0.115;
/**
 * The umbrella goes with the rains: she has it when it is the rainy season or raining, and opens it when the rain
 * comes (over this much, 0..1) and closes it once it has stopped (under this); raising and opening it, or closing
 * and lowering it, takes this long (s), a little after the rain has begun or ended (s).
 */
const RAIN = { open: 0.1, close: 0.04, act: 2.4, react: 1.2 };
/** Its tilt answers the wind as a damped spring (Hz, damping); how far she lets it go (rad). */
const TILT = { f: 1.15, zeta: 0.32, max: 0.5 };

const ease = (x: number) => smoothstep(0, 1, x);

/** A damped spring step toward `target`, for the eased angles of her gaze (its answer is reused by the next call). */
const stepped: [number, number] = [0, 0];
function follow(x: number, v: number, target: number, w: number, dt: number): [number, number] {
  v += (w * w * (target - x) - 2 * w * v) * dt;
  stepped[0] = x + v * dt;
  stepped[1] = v;
  return stepped;
}

/** The canopy's height below its crown at a share `f` of its radius: a shallow dome. */
const canopyDrop = (f: number) => CANOPY_DEPTH * Math.pow(f, 1.5);

/**
 * The paper umbrella, built along +y from her grip: the canopy (its paper stretched over the ribs, sagging a
 * little between them, textured from above), and its frame: 32 bamboo ribs under it, the stretchers from the
 * runner with the coloured threads woven round them, the bamboo shaft with its nodes, the cord-bound handle and
 * the tied cap at the top.
 */
function paperUmbrella(): { canopy: BufferGeometry; ribs: MeshBuilder; shaft: MeshBuilder } {
  const crown = SHAFT;
  // the canopy: rings out from the crown, two segments to a rib, the paper between ribs a little lower
  const RINGS = 9;
  const SEGS = RIBS * 2;
  const pos: number[] = [];
  const uv: number[] = [];
  const index: number[] = [];
  pos.push(0, crown + 0.004, 0);
  uv.push(0.5, 0.5);
  for (let k = 1; k <= RINGS; k++) {
    const f = k / RINGS;
    for (let j = 0; j < SEGS; j++) {
      const a = (j / SEGS) * Math.PI * 2;
      const between = j % 2;
      const r = CANOPY_R * f * (1 - between * 0.012 * f * f);
      const y = crown - canopyDrop(f) - between * 0.007 * f;
      pos.push(Math.cos(a) * r, y, Math.sin(a) * r);
      uv.push(0.5 + (Math.cos(a) * r) / (2 * CANOPY_R), 0.5 - (Math.sin(a) * r) / (2 * CANOPY_R));
    }
  }
  const ringAt = (k: number, j: number) => 1 + (k - 1) * SEGS + (((j % SEGS) + SEGS) % SEGS);
  for (let j = 0; j < SEGS; j++) index.push(0, ringAt(1, j + 1), ringAt(1, j));
  for (let k = 1; k < RINGS; k++)
    for (let j = 0; j < SEGS; j++) {
      const a = ringAt(k, j);
      const b = ringAt(k, j + 1);
      const c = ringAt(k + 1, j + 1);
      const d = ringAt(k + 1, j);
      index.push(a, b, c, a, c, d);
    }
  const canopy = new BufferGeometry();
  canopy.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  canopy.setAttribute('uv', new BufferAttribute(new Float32Array(uv), 2));
  canopy.setIndex(index);
  canopy.computeVertexNormals();

  const f = new MeshBuilder();
  const sh = new MeshBuilder();
  const rib = rgb('#5a3b22');
  const cane = rgb('#c2a46a');
  const strip = (p: Vector3, q: Vector3, w: number, col: RGB) => {
    const d = new Vector3().subVectors(q, p);
    const side = new Vector3().crossVectors(d, UP);
    if (side.lengthSq() < 1e-8) side.set(1, 0, 0);
    side.normalize().multiplyScalar(w);
    const n = new Vector3().crossVectors(side, d).normalize();
    const s = f.vertex(p.clone().sub(side), n, 0, 0, col);
    f.vertex(p.clone().add(side), n, 1, 0, col);
    f.vertex(q.clone().add(side), n, 1, 1, col);
    f.vertex(q.clone().sub(side), n, 0, 1, col);
    f.quad(s, s + 1, s + 2, s + 3);
    f.quad(s, s + 3, s + 2, s + 1);
  };
  const runnerY = crown - 0.3;
  const threads = [rgb('#2f7a5a'), rgb('#d8b048'), rgb('#2c4a8a'), rgb('#e8e0d0'), rgb('#b83a3a')];
  for (let k = 0; k < RIBS; k++) {
    const a = (k / RIBS) * Math.PI * 2;
    const at = (fr: number, below: number) => new Vector3(Math.cos(a) * CANOPY_R * fr, crown - canopyDrop(fr) - below, Math.sin(a) * CANOPY_R * fr);
    // the rib under the paper, crown to rim, in four straight lengths
    for (let s = 0; s < 4; s++) strip(at(0.05 + 0.95 * (s / 4), 0.004), at(0.05 + 0.95 * ((s + 1) / 4), 0.004), 0.0032, rib);
    // the stretcher from the runner up to the rib's middle
    const foot = new Vector3(Math.cos(a) * 0.016, runnerY, Math.sin(a) * 0.016);
    const head = at(0.46, 0.008);
    strip(foot, head, 0.0024, rib);
    // the threads woven round the stretchers near the runner, each round its own colour
    const t0 = foot.clone().lerp(head, 0.16);
    const t1 = foot.clone().lerp(head, 0.24);
    strip(t0, t1, 0.0048, threads[k % threads.length]);
  }
  // the shaft of bamboo, its nodes; the runner; the handle bound in dark cord; the cap at the top
  sh.add(new CylinderGeometry(0.0085, 0.0085, crown + 0.2, 7), new Matrix4().makeTranslation(0, (crown + 0.2) / 2 - 0.2, 0), cane);
  for (let y = -0.02; y < crown - 0.05; y += 0.17) sh.add(new CylinderGeometry(0.0098, 0.0098, 0.008, 7), new Matrix4().makeTranslation(0, y, 0), scaleRgb(cane, 0.78));
  sh.add(new CylinderGeometry(0.019, 0.019, 0.06, 10), new Matrix4().makeTranslation(0, runnerY, 0), rgb('#4a2e18'));
  sh.add(new CylinderGeometry(0.012, 0.0125, 0.17, 8), new Matrix4().makeTranslation(0, -HANDLE, 0), rgb('#2a1c14'));
  sh.add(new CylinderGeometry(0.015, 0.012, 0.025, 8), new Matrix4().makeTranslation(0, -0.2, 0), rgb('#3a2414'));
  sh.add(new CylinderGeometry(0.004, 0.026, 0.03, 10), new Matrix4().makeTranslation(0, crown + 0.018, 0), rgb('#8a171a'));
  sh.add(new CylinderGeometry(0.006, 0.006, 0.05, 6), new Matrix4().makeTranslation(0, crown + 0.05, 0), rgb('#3a2414'));
  return { canopy, ribs: f, shaft: sh };
}

/**
 * The canopy and its ribs (`uFlap`: x the paper's stir in the wind (m), y seconds, z how open, 0 folded .. 1 open):
 * its paper lifting and dipping round its rim, more the farther out; and folding, each point swung down about the
 * crown on its rib (keeping its length) until the ribs lie along the shaft with the paper gathered between them.
 */
const FLAP_PARS = /* glsl */ `
uniform vec3 uFlap;
`;
const FLAP_CODE = /* glsl */ `
{
  float rr = length(transformed.xz);
  float fr = rr / ${CANOPY_R.toFixed(3)};
  float fa = atan(transformed.z, transformed.x);
  float ft = uFlap.y;
  transformed.y += uFlap.x * uFlap.z * fr * fr * (0.6 * sin(fa * 3.0 + ft * 4.7 + sin(ft * 0.9) * 2.0) + 0.4 * sin(fa * 5.0 - ft * 6.3));
  float top = ${(SHAFT + 0.004).toFixed(4)};
  float drop = top - transformed.y;
  float reach = length(vec2(rr, drop));
  float th = mix(1.52, atan(drop, rr), smoothstep(0.0, 1.0, uFlap.z));
  vec2 out2 = rr > 1e-5 ? transformed.xz / rr : vec2(1.0, 0.0);
  transformed.xz = out2 * reach * cos(th);
  transformed.y = top - reach * sin(th);
}
`;

interface Arm {
  side: number;
  grip: Grip;
  shoulder: Vector3;
  wrist: Vector3;
  hold: Vector3;
  barQ: Quaternion;
  elbowAt: Vector3;
  roll: Vector3;
}

/** A foot on the deck (world): planted, or swinging from `from` (`t` 0..1 through the swing). */
interface Foot {
  at: Vector3;
  yaw: number;
  from: Vector3;
  fromYaw: number;
  t: number;
  /** Where it should be now (world), and turned how. */
  want: Vector3;
  wantYaw: number;
}

export class Girl {
  readonly group = new Group();
  /** The canopy's middle and radius (world), so the rain can leave dry what is under it. */
  readonly shelter = new Vector4(0, -99, 0, 0);
  readonly body: Human;

  private readonly feet: Foot[] = [];
  private readonly arms: Arm[] = [];
  private readonly skirt: ClothTube;
  private readonly orna: ClothRibbon;
  private readonly ornaAt: Vector3[] = [];
  private readonly ornaNormal: Vector3[] = [];
  private readonly brolly = new Group();
  private readonly flap = new Vector3();
  /**
   * The umbrella: whether she has it with her, how open it is (0 folded .. 1 open), how high she holds it (0
   * carried closed by her side, ½ held up before her, 1 over her head), and what she is doing with it.
   */
  private hasBrolly = false;
  /** Whether she brought it out: settled only while nobody watches her (or at a jump), never in sight. */
  private brought = false;
  private open = 0;
  private raise = 0;
  private brollyAct: { up: boolean; t: number } | null = null;
  /** Where she looks this frame (`gaze` fills it). */
  private readonly gazeNow: { yaw: number; pitch: number; at: Vector3 | null } = { yaw: 0, pitch: 0, at: null };
  private rainFor = 0;
  private readonly upright = new Vector3();
  private readonly holdAt = new Vector3();
  private readonly footShadow: Mesh;
  private readonly brollyShadow: Mesh;
  private readonly inverse = new Quaternion();
  /** The skirt's top row round her hips (pelvis frame). */
  private readonly hips: { zc: number; a: number; b: number };
  /** Where her right hand holds the umbrella (chest frame, from spine01's head in the bind). */
  private readonly gripAt: Vector3;
  // where she is on the deck: her middle (world, on the deck), the way she faces, how she is moving
  private readonly root = new Vector3();
  private readonly rootWas = new Vector3();
  private readonly rootVel = new Vector3();
  private rootYaw = YAW_NEAR;
  /** By which parapet (0 the river's, 1 the far one); how far through crossing (−1 when not); her lean in to the parapet and her hand on it, eased. */
  private side: 0 | 1 = 0;
  private crossing = -1;
  private lean = 0;
  private handOn = 0;
  private lastStep = 1;
  private lastAlong = Number.NaN;
  private placed = false;
  // her body's frames this instant
  private readonly pelvis = new Vector3();
  private readonly pelvisQ = new Quaternion();
  private readonly chestQ = new Quaternion();
  private readonly chestInv = new Quaternion();
  private readonly headQ = new Quaternion();
  private readonly hipAt = [new Vector3(), new Vector3()];
  private readonly knees = [new Vector3(), new Vector3()];
  private readonly ankles = [new Vector3(), new Vector3()];
  // her gaze (eased) and the umbrella's tilt (a damped spring), with their rates
  private lookYaw = 0;
  private lookPitch = 0;
  private vYaw = 0;
  private vPitch = 0;
  private readonly tilt = new Vector2();
  private readonly vTilt = new Vector2();
  private posed = false;
  // scratch
  private readonly e = new Euler();
  private readonly q = new Quaternion();
  private readonly q2 = new Quaternion();
  private readonly v = new Vector3();
  private readonly v2 = new Vector3();
  private readonly v3 = new Vector3();
  private readonly end = new Vector3();
  private readonly pole = new Vector3();
  private readonly wind = new Vector3();
  private readonly gravity = new Vector3(0, -9.81, 0);
  private readonly air = { x: 0, z: 0 };
  private readonly grip = new Vector3();
  private readonly shaftDir = new Vector3();
  private readonly look = new Vector3();
  private readonly target = new Vector3();

  constructor() {
    this.group.name = 'girl';
    // the lehenga: a soft crimson, light and with a little sheen, thin enough for the low sun to glow through it;
    // its butis and hem in cream thread
    const skirtMat = patchMaterial(
      new MeshStandardMaterial({ map: lehengaTexture('#a52a2e', '#eadbc2', true), vertexColors: true, roughness: 0.62, side: DoubleSide }),
      { translucency: 1.0 },
    );
    // the ওড়না: sheer cream edged in red, the light and what is behind it showing through
    const ornaMat = patchMaterial(
      new MeshStandardMaterial({ map: lehengaTexture('#ece2d1', '#b8463f', false), vertexColors: true, roughness: 0.6, side: DoubleSide, transparent: true, opacity: 0.86, depthWrite: false }),
      { translucency: 1.6 },
    );
    // the blouse: plain, a deeper red
    const blouseWeave = clothTexture('#7e1f24', '#832227', '#781c21', 42, true);
    blouseWeave.map.repeat.set(12, 12);
    const blouseMat = patchMaterial(new MeshStandardMaterial({ map: blouseWeave.map, roughness: 0.7, side: DoubleSide, vertexColors: true }), { translucency: 0.4 });
    const sandal = new MeshStandardMaterial({ color: '#4a2e1c', roughness: 0.7 });
    const g = this.group;

    const body = (this.body = new Human('meye', { blouse: blouseMat }, { flowingHair: true }));
    g.add(body.group);
    for (let i = 0; i < 2; i++)
      this.feet.push({ at: new Vector3(), yaw: 0, from: new Vector3(), fromYaw: 0, t: -1, want: new Vector3(), wantYaw: 0 });
    // sandals under her soles, on the feet's bones
    for (const s of ['R', 'L']) {
      const ankle = body.bindOf(`foot.${s}`);
      const sole = new Mesh(new CapsuleGeometry(0.042, 0.16, 2, 10), sandal);
      sole.rotation.set(Math.PI / 2, 0, 0);
      sole.geometry.scale(1.1, 1, 0.12);
      sole.position.set(0, 0.004 - ankle.y, 0.05);
      const strap = new Mesh(new TorusGeometry(0.036, 0.005, 4, 12, Math.PI), sandal);
      strap.position.set(0, 0.012 - ankle.y, 0.085);
      strap.scale.set(1, 0.55, 1);
      body.bone(`foot.${s}`).add(sole, strap);
    }
    // red and gold glass bangles on both wrists, round the forearm just above the wrist
    const glass = patchMaterial(new MeshStandardMaterial({ vertexColors: true, roughness: 0.18, metalness: 0.1 }), {});
    for (const s of ['R', 'L']) {
      const wrist = body.bindOf(`wrist.${s}`);
      const dir = new Vector3().subVectors(wrist, body.bindOf(`lowerarm02.${s}`)).normalize();
      const b = new MeshBuilder();
      const turn = new Matrix4().makeRotationFromQuaternion(new Quaternion().setFromUnitVectors(new Vector3(0, 0, 1), dir));
      ['#a8141e', '#c99a3c', '#a8141e', '#c99a3c'].forEach((col, k) => {
        const m = new Matrix4().makeTranslation(dir.x * (-0.03 - 0.0075 * k), dir.y * (-0.03 - 0.0075 * k), dir.z * (-0.03 - 0.0075 * k)).multiply(turn);
        b.add(new TorusGeometry(0.033, 0.0028, 5, 20), m, rgb(col));
      });
      body.bone(`wrist.${s}`).add(new Mesh(b.build(), glass));
    }

    // the hands: her right closed round the umbrella's handle, her left free
    [-1, 1].forEach((side) => {
      this.arms.push({
        side,
        grip: body.grip(side, side < 0 ? 0.0125 : 0.016),
        shoulder: new Vector3(),
        wrist: new Vector3(),
        hold: new Vector3(),
        barQ: new Quaternion(),
        elbowAt: new Vector3(side * 0.25, 1.0, 0.05),
        roll: new Vector3(0, -1, 0),
      });
    });
    const chestMap = body.data.sections.chest;
    this.gripAt = new Vector3(-0.15, 0.04, radiusAt(chestMap, 0.04, 0).zc + 0.2);

    // the skirt: gathered close at her waist into many small folds that open as it falls into soft, crisp
    // flutes, standing out round her and swinging free toward the hem at her ankles
    const e = enclosing(body.data.sections.pelvis, SKIRT_TOP);
    this.hips = { zc: e.zc, a: e.a + BODICE_OFF + 0.012, b: e.b + BODICE_OFF + 0.012 };
    this.skirt = new ClothTube(skirtMat, {
      segments: 48,
      rings: 22,
      fold: (t, th) => ({
        r:
          0.005 * Math.sin(th * 32) * (1 - smoothstep(0, 0.25, t)) +
          (0.016 * Math.sin(th * 11 + 0.5) + 0.01 * Math.sin(th * 7 + 2.1) + 0.012 * (0.5 + 0.5 * Math.sin(th * 4 + 1))) * smoothstep(0.08, 1, t),
        y: 0.006 * Math.sin(th * 11 + 0.5) * smoothstep(0.9, 1, t),
      }),
      freedom: (t) => 0.95 * smoothstep(0.1, 1, t),
      shade: (t) => (t < 0.025 ? 0.85 : 0.94 + 0.06 * smoothstep(0.85, 1, t)),
      uRepeat: 6,
      vRepeat: 1,
    });
    g.add(this.skirt.mesh);

    // the ওড়না over her left shoulder, opening out from it toward both ends
    const first = ORNA_PINS[0];
    const last = ORNA_PINS[ORNA_PINS.length - 1];
    // narrower down her front (over her breast), wider down her back
    const open = (i: number) => (i < first ? (ORNA.front - ORNA.narrow) * smoothstep(0, 3, first - i) : (ORNA.back - ORNA.narrow) * smoothstep(0, 4, i - last));
    this.orna = new ClothRibbon(ornaMat, ORNA.count, 0.1, (i) => ORNA.narrow + open(i), ORNA_PINS, 1, 1);
    const neck = body.bindOf('neck01');
    const mid = (y: number) => body.bindOf('spine01').z + radiusAt(chestMap, y - body.bindOf('spine01').y, 0).zc;
    // in front of her left shoulder, on top of it, and behind it
    const rays: [number, number, Vector3][] = [
      [0.145, neck.y - 0.12, new Vector3(0.25, 0.3, 1)],
      [0.13, neck.y - 0.04, new Vector3(0.1, 1, 0.1)],
      [0.12, neck.y - 0.12, new Vector3(0, 0.35, -1)],
    ];
    for (const [x, y, dir] of rays) {
      const from = new Vector3(x, y, mid(y));
      dir.normalize();
      const hit = body.cast(from, dir);
      const p = hit ? hit.point : from.clone().addScaledVector(dir, 0.1);
      const n = hit ? hit.normal : dir;
      this.ornaAt.push(p.addScaledVector(n, 0.03));
      this.ornaNormal.push(n.clone());
    }
    g.add(this.orna.mesh);

    // the umbrella, and the soft shadows she and it lay on the deck (moving things stay out of the shadow map)
    const parts = paperUmbrella();
    const canopyMat = patchMaterial(new MeshStandardMaterial({ map: paperUmbrellaTexture(), roughness: 0.5, side: DoubleSide }), {
      translucency: 1.4,
      vertex: { key: 'paperflap', pars: FLAP_PARS, code: FLAP_CODE, uniforms: { uFlap: { value: this.flap } } },
    });
    const ribMat = patchMaterial(new MeshStandardMaterial({ vertexColors: true, roughness: 0.6, side: DoubleSide }), {
      translucency: 0.3,
      vertex: { key: 'paperflap', pars: FLAP_PARS, code: FLAP_CODE, uniforms: { uFlap: { value: this.flap } } },
    });
    const shaftMat = patchMaterial(new MeshStandardMaterial({ vertexColors: true, roughness: 0.6 }), { translucency: 0.2 });
    this.brolly.add(new Mesh(parts.canopy, canopyMat), new Mesh(parts.ribs.build(), ribMat), new Mesh(parts.shaft.build(), shaftMat));
    g.add(this.brolly);
    const spot = softSpotTexture();
    this.footShadow = new Mesh(
      new PlaneGeometry(0.62, 0.5).rotateX(-Math.PI / 2),
      new MeshBasicMaterial({ map: spot, transparent: true, depthWrite: false, color: '#000000', opacity: 0.6 }),
    );
    this.footShadow.position.y = 0.012;
    this.brollyShadow = new Mesh(
      new PlaneGeometry(1.25, 1.25).rotateX(-Math.PI / 2),
      new MeshBasicMaterial({ map: spot, transparent: true, depthWrite: false, color: '#000000', opacity: 0.4 }),
    );
    g.add(this.footShadow, this.brollyShadow);
    this.group.traverse((o) => {
      if ((o as Mesh).isMesh) {
        o.castShadow = false;
        o.receiveShadow = o !== this.footShadow && o !== this.brollyShadow;
      }
    });

    this.standAt(NEAR.x, NEAR.z, YAW_NEAR);
    this.settleFeet();
    this.place();
  }

  /** Her umbrella's state (debug): with her, how open, how high she holds it. */
  get umbrella(): { has: boolean; open: number; raise: number } {
    return { has: this.hasBrolly, open: this.open, raise: this.raise };
  }

  /** The deck's height at a world point on it. */
  private deckAt(x: number, z: number): number {
    return BRIDGE.water + bridgeDeck(bridgeFrame(x, z).x);
  }

  private standAt(bx: number, bz: number, yaw: number): void {
    const w = bridgeToWorld(bx, bz);
    this.root.set(w.x, this.deckAt(w.x, w.z), w.z);
    this.rootYaw = yaw;
  }

  /** Puts her frame where her middle is, turned the way she faces. */
  private place(): void {
    this.group.position.copy(this.root);
    this.group.rotation.set(0, this.rootYaw, 0);
    this.group.updateMatrixWorld();
    this.inverse.copy(this.group.quaternion).invert();
  }

  /** Where each foot should be under her as she stands now (world), a little ahead of her as she moves. */
  private wantFeet(): void {
    const c = Math.cos(this.rootYaw);
    const s = Math.sin(this.rootYaw);
    FEET.forEach(([dx, dz, out], i) => {
      const f = this.feet[i];
      f.want.set(this.root.x + dx * c + dz * s, 0, this.root.z - dx * s + dz * c).addScaledVector(this.rootVel, STEP.lead);
      f.want.y = this.deckAt(f.want.x, f.want.z);
      f.wantYaw = this.rootYaw + out;
    });
  }

  private settleFeet(): void {
    this.rootVel.set(0, 0, 0);
    this.wantFeet();
    for (const f of this.feet) {
      f.at.copy(f.want);
      f.yaw = f.wantYaw;
      f.t = -1;
    }
  }

  /**
   * Where she goes on the deck now, from where the majhi is on his way (`along`: m past the bridge): by the near
   * parapet watching him come, stepping in to it; across the deck as he goes under; by the far one after.
   */
  private choreograph(dt: number, along: number, near: boolean): void {
    // a jump (the boat put elsewhere, the journey begun again): she is where she would be by then, at once
    const jumped = !Number.isFinite(this.lastAlong) || Math.abs(along - this.lastAlong) > 6;
    this.lastAlong = along;
    if (jumped) {
      this.crossing = -1;
      this.side = along > WATCH.cross + 2 ? 1 : 0;
      this.lean = this.side === 1 ? 1 : smoothstep(WATCH.notice, WATCH.lean, along);
    }
    if (this.crossing < 0 && this.side === 0 && near && along > WATCH.cross && along < WATCH.cross + 6) this.crossing = 0;
    if (this.crossing >= 0) {
      this.crossing += dt / CROSS.time;
      if (this.crossing >= 1) {
        this.crossing = -1;
        this.side = 1;
      }
    }
    const want = this.crossing >= 0 ? 0 : this.side === 0 ? smoothstep(WATCH.notice, WATCH.lean, along) : 1;
    this.lean += (want - this.lean) * (jumped ? 1 : 1 - Math.exp(-dt / 1.4));
    const hand = this.crossing < 0 && this.lean > 0.55 ? 1 : 0;
    this.handOn += (hand - this.handOn) * (jumped ? 1 : 1 - Math.exp(-dt / 0.45));

    this.rootWas.copy(this.root);
    if (this.crossing >= 0) {
      // turning round to her left over her first steps, then across, slow at the start and the end
      const p = this.crossing;
      const from = { x: NEAR.x, z: NEAR.z - LEAN_IN };
      const mid = { x: NEAR.x + 0.14, z: NEAR.z + 0.3 };
      if (p < CROSS.turn) {
        const k = ease(p / CROSS.turn);
        this.standAt(from.x + (mid.x - from.x) * k, from.z + (mid.z - from.z) * k, YAW_NEAR + Math.PI * k);
      } else {
        const k = ease((p - CROSS.turn) / (1 - CROSS.turn));
        this.standAt(mid.x + (FAR.x - mid.x) * k, mid.z + (FAR.z - mid.z) * k, YAW_FAR);
      }
    } else if (this.side === 0) this.standAt(NEAR.x, NEAR.z - LEAN_IN * this.lean, YAW_NEAR);
    else this.standAt(FAR.x, FAR.z + LEAN_IN * this.lean, YAW_FAR);
    if (jumped || !this.placed) {
      this.settleFeet();
      this.placed = true;
    } else if (dt > 0) this.rootVel.subVectors(this.root, this.rootWas).divideScalar(dt);
  }

  /** Her feet: each stays planted until it lags where it should be, then swings there, one at a time. */
  private stepFeet(dt: number): void {
    this.wantFeet();
    const swinging = this.feet.findIndex((f) => f.t >= 0);
    if (swinging >= 0) {
      const f = this.feet[swinging];
      f.t = Math.min(1, f.t + dt / STEP.time);
      const k = ease(f.t);
      f.at.lerpVectors(f.from, f.want, k);
      f.at.y += STEP.lift * Math.sin(Math.PI * f.t);
      f.yaw = f.fromYaw + angleDelta(f.fromYaw, f.wantYaw) * k;
      if (f.t >= 1) {
        f.at.copy(f.want);
        f.yaw = f.wantYaw;
        f.t = -1;
        this.lastStep = swinging;
      }
      return;
    }
    // the foot that lags more, or the one that did not step last when both lag
    const lag = this.feet.map((f) => {
      const d = Math.hypot(f.at.x - f.want.x, f.at.z - f.want.z);
      const turn = Math.abs(angleDelta(f.yaw, f.wantYaw));
      return d > STEP.slack || turn > STEP.turn ? d + turn * 0.3 : 0;
    });
    if (lag[0] <= 0 && lag[1] <= 0) return;
    const i = lag[0] > 0 && lag[1] > 0 ? 1 - this.lastStep : lag[0] > lag[1] ? 0 : 1;
    const f = this.feet[i];
    f.from.copy(f.at);
    f.fromYaw = f.yaw;
    f.t = 0;
  }

  /** Where she looks now: the majhi while she watches him, ahead of her as she crosses, along the khal where he went, or over the water. */
  private gaze(t: number, man: Vector3, along: number, out: { yaw: number; pitch: number; at: Vector3 | null }): void {
    out.yaw = 0.42 * Math.sin(t * 0.11) + 0.22 * Math.sin(t * 0.047 + 2.0);
    out.pitch = -0.08 + 0.06 * Math.sin(t * 0.09 + 0.7);
    out.at = null;
    let watch = 0;
    if (this.crossing >= 0) {
      // where he will come out from under her: the water beyond the far parapet
      const w = bridgeToWorld(FAR.x, BRIDGE.width / 2 + 4);
      this.target.set(w.x, BRIDGE.water + 0.8, w.z);
      watch = smoothstep(0.2, 0.55, this.crossing);
    } else if (this.side === 0 ? along > WATCH.notice : along < WATCH.gone * 1.6) {
      this.target.copy(man);
      // once he has gone a long way she keeps looking where he went, her gaze lifting a little along the khal
      if (this.side === 1 && along > WATCH.gone) this.target.y += (along - WATCH.gone) * 0.05;
      watch = this.side === 0 ? smoothstep(WATCH.notice, WATCH.notice + 5, along) : 1;
    }
    if (watch <= 0) return;
    const eyes = this.v.copy(this.body.head).applyQuaternion(this.group.quaternion).add(this.group.position);
    const d = this.v2.subVectors(this.target, eyes).applyQuaternion(this.inverse);
    if (d.z < -0.5) return;
    const yaw = Math.max(-1.15, Math.min(1.15, Math.atan2(d.x, Math.max(d.z, 0.4))));
    const pitch = Math.max(-0.95, Math.min(0.2, Math.atan2(d.y, Math.hypot(d.x, d.z))));
    out.yaw += (yaw - out.yaw) * watch;
    out.pitch += (pitch - out.pitch) * watch;
    if (watch > 0.3) out.at = this.look.copy(this.target).sub(this.group.position).applyQuaternion(this.inverse);
  }

  /** Closes a hand on what it holds (see `Human.holdBar`). */
  private placeHand(arm: Arm, at: Vector3, thumb: Vector3): void {
    this.body.holdBar(arm.side, arm.grip, at, thumb, arm.elbowAt, arm.roll, arm.barQ, arm.wrist);
    arm.hold.copy(at);
  }

  /** The skirt's ring at `t` (0 its top at her waist .. 1 its hem at her ankles). */
  private readonly skirtRing = (t: number, out: Ring): Ring => {
    const ax = this.v.set(1, 0, 0).applyQuaternion(this.pelvisQ);
    const az = this.v2.set(0, 0, 1).applyQuaternion(this.pelvisQ);
    const h = SKIRT_TOP - t * SKIRT_DROP;
    out.c.set(0, h, this.hips.zc * (1 - t)).applyQuaternion(this.pelvisQ).add(this.pelvis);
    // lower down it hangs round both legs (over its lining), clear of them, standing out toward the hem
    const legs = smoothstep(0.15, 0.6, t);
    const half = this.hipAt[0].distanceTo(this.hipAt[1]) / 2;
    const thigh = tableAt(this.body.data.sections.thigh, Math.min(1, t * 1.1)) + SALWAR_OFF;
    // and round her feet as they part in a step
    const stride = Math.max(0, this.ankles[0].distanceTo(this.ankles[1]) - 0.2) * 0.5 * smoothstep(0.5, 1, t);
    out.ax.copy(ax);
    out.az.copy(az);
    out.a = Math.max(this.hips.a, half + thigh * legs + 0.01) + SKIRT_FLARE * t * t;
    out.b = Math.max(this.hips.b * (1 - 0.4 * legs), thigh + 0.02) + SKIRT_FLARE * 0.7 * t * t + stride;
    return out;
  };

  /** Keeps the swinging skirt off her legs (its lining's width) when the wind blows it back against them. */
  private readonly keepOffLegs = (p: Vector3): void => {
    const { thigh, shin } = this.body.data.sections;
    for (let i = 0; i < 2; i++) {
      this.pushOff(p, this.hipAt[i], this.knees[i], tableAt(thigh, 0.5) + SALWAR_OFF + 0.01);
      this.pushOff(p, this.knees[i], this.ankles[i], tableAt(shin, 0.2) + SALWAR_OFF);
    }
  };

  private pushOff(p: Vector3, a: Vector3, b: Vector3, r: number): void {
    const seg = this.end.subVectors(b, a);
    const f = Math.min(1, Math.max(0, this.v.subVectors(p, a).dot(seg) / seg.lengthSq()));
    const away = this.v.subVectors(p, a).addScaledVector(seg, -f);
    const d = away.length();
    if (d < r && d > 1e-5) p.addScaledVector(away, (r - d) / d);
  }

  private readonly ornaPin = (i: number, p: Vector3, n: Vector3): void => {
    const k = i - ORNA_PINS[0];
    this.body.onChest(this.ornaAt[k], p);
    n.copy(this.ornaNormal[k]).applyQuaternion(this.chestQ);
  };

  private readonly awayFromBody = (p: Vector3, out: Vector3): void => {
    out.subVectors(p, this.body.chest);
    const up = this.v3.set(0, 1, 0).applyQuaternion(this.chestQ);
    out.addScaledVector(up, -out.dot(up));
    if (out.lengthSq() < 1e-8) out.set(0, 0, 1);
    out.normalize();
  };

  /**
   * Pushes `p` out of her (as her clothes make her: `off` over the skin) where a radius map covers it: the
   * chest's, carried by her chest, or below it the hips', carried by her hips.
   */
  private keepOutOf(p: Vector3, off: number): void {
    const body = this.body;
    const tryMap = (map: RadiusMap, bind: Vector3, q: Quaternion, inv: Quaternion, origin: Vector3) => {
      const v = this.v.subVectors(p, origin).applyQuaternion(inv).add(bind);
      const y = v.y - bind.y;
      if (y < map.y0 || y > map.y0 + map.dy * (map.rows - 1)) return false;
      const zc = radiusAt(map, y, 0).zc + bind.z;
      const dx = v.x;
      const dz = v.z - zc;
      const r = Math.hypot(dx, dz);
      if (r < 1e-4) return true;
      const R = radiusAt(map, y, Math.atan2(dx, dz)).r + off;
      if (r < R) {
        v.x = (dx * R) / r;
        v.z = zc + (dz * R) / r;
        p.copy(v.sub(bind).applyQuaternion(q)).add(origin);
      }
      return true;
    };
    const { chest, pelvis } = body.data.sections;
    if (!tryMap(chest, body.bindOf('spine01'), this.chestQ, this.chestInv, body.chest)) {
      this.q2.copy(this.pelvisQ).invert();
      tryMap(pelvis, body.bindOf('spine05'), this.pelvisQ, this.q2, this.pelvis);
    }
  }

  /** Keeps the ওড়না's hanging length out of her (its width with it: it hangs a little clear of her breast and back). */
  private readonly keepOffBody = (p: Vector3): void => this.keepOutOf(p, BODICE_OFF + 0.055);

  /**
   * Her umbrella this instant: with her in the rains, opened as the rain comes and closed once it stops; raised
   * before her and opened, then lifted over her head (or lowered before her, closed, and carried down by her side).
   * A jump (`snap`: a new scene, the journey begun again) finds it as the weather is. Whether she has brought it
   * changes only out of sight (`watched` false): a shower out of the rains catches her without it while she is
   * watched, and once it is over she carries it closed till nobody is looking; it never appears or vanishes in view.
   */
  private brollyWeather(dt: number, rain: number, rainy: boolean, snap: boolean, watched: boolean): void {
    const carry = rainy || rain > 0.05;
    if (snap) {
      this.brollyAct = null;
      this.brought = this.hasBrolly = carry;
      this.open = this.raise = carry && rain > RAIN.open ? 1 : 0;
      return;
    }
    if (!watched) this.brought = carry;
    // (while she is closing it and lowering it to her side she still has it, whatever the season does)
    this.hasBrolly = this.brought || this.open > 0 || this.raise > 0 || this.brollyAct !== null;
    const want = this.hasBrolly && (this.open > 0.5 ? rain > RAIN.close : rain > RAIN.open);
    const act = this.brollyAct;
    if (!act) {
      const now = this.raise > 0.5;
      this.rainFor = want !== now ? this.rainFor + dt : 0;
      if (this.rainFor > RAIN.react) this.brollyAct = { up: want, t: 0 };
      return;
    }
    act.t += dt;
    const k = Math.min(1, act.t / RAIN.act);
    // up: raised before her (to ⅓), opened (to ⅔), lifted over her head; down the other way
    const lift = smoothstep(0, 0.33, k);
    const spread = smoothstep(0.33, 0.67, k);
    const over = smoothstep(0.67, 1, k);
    if (act.up) {
      this.raise = 0.5 * lift + 0.5 * over;
      this.open = spread;
    } else {
      this.raise = 1 - 0.5 * lift - 0.5 * over;
      this.open = 1 - spread;
    }
    if (k >= 1) this.brollyAct = null;
  }

  /**
   * Poses her for this instant. `t`: seconds; `man`: the majhi's head (world), whom she watches; `rain`: how hard
   * it rains (0..1), which has her open her umbrella and tilt it into the wind; `rainy`: the rains' season, when
   * she has it with her; `watched`: whether a camera is near enough to see her (what she carries changes only
   * when it isn't).
   */
  update(dt: number, t: number, man: Vector3, rain: number, rainy: boolean, watched: boolean): void {
    const body = this.body;
    const { dims } = body;
    const way = journeyFrame(man.x, man.z);
    const alongWay = way ? way.s - JOURNEY.bridge : -1e3;
    // only while he is on the khal by the bridge does she follow him with her eyes and her feet
    const nearKhal = way !== null && Math.abs(alongWay) < 400 && Math.abs(bridgeFrame(man.x, man.z).x) < 18;
    const wasAlong = this.lastAlong;
    this.choreograph(dt, alongWay, nearKhal);
    this.brollyWeather(dt, rain, rainy, !Number.isFinite(wasAlong) || Math.abs(alongWay - wasAlong) > 6, watched);
    this.place();
    this.stepFeet(dt);

    // the air past her, in her own frame (she stands high and open to it on the bridge), and her own way through it
    windAt(this.root.x, this.root.z, this.air);
    this.wind.set(this.air.x, 0, this.air.z).sub(this.rootVel).applyQuaternion(this.inverse).multiplyScalar(1.1);
    const speed = this.wind.length();

    // her feet in her own frame, and which carries her weight now
    const local = (f: Foot, out: Vector3) => out.copy(f.at).sub(this.group.position).applyQuaternion(this.inverse);
    const swing = this.feet.findIndex((f) => f.t >= 0);
    const walk = swing >= 0 ? Math.sin(Math.PI * this.feet[swing].t) : 0;
    // standing, her weight goes slowly from one foot to the other; walking, over the foot that carries her
    const shift = Math.sin(t * 0.57 + 1.0) * (1 - Math.min(1, this.rootVel.length() * 3));
    const breath = Math.sin(t * 1.46);
    let swayX = 0.024 * shift;
    if (swing >= 0) swayX += local(this.feet[1 - swing], this.v3).x * 0.45 * walk;
    // she leans a little into a strong wind (x: forward bend, z: toward −x), and forward over the parapet's coping
    const leanZ = Math.max(-0.06, Math.min(0.06, -this.wind.z * 0.004));
    const leanX = Math.max(-0.06, Math.min(0.06, this.wind.x * 0.004));
    this.pelvis.set(swayX, dims.pelvis - 0.012 - 0.008 * Math.abs(shift) - 0.016 * (swing >= 0 ? 1 - walk : 0), 0.035 * this.handOn);
    this.pelvisQ.setFromEuler(this.e.set(0.03 + leanZ * 0.5 + 0.06 * this.handOn, 0.06 * shift + (swing >= 0 ? (swing === 0 ? 0.07 : -0.07) * walk : 0), -0.045 * shift + leanX * 0.5 - swayX * 0.6, 'YXZ'));

    // where she looks: the chest turns with a share of it, the head the rest, her eyes ahead of both
    const look = this.gazeNow;
    this.gaze(t, man, alongWay, look);
    const step = Math.min(dt, 1 / 20);
    [this.lookYaw, this.vYaw] = follow(this.lookYaw, this.vYaw, look.yaw, 1.6, step);
    [this.lookPitch, this.vPitch] = follow(this.lookPitch, this.vPitch, look.pitch, 1.6, step);
    // looking down, she bends a little at the chest too; over the coping, more
    this.q.setFromEuler(this.e.set(-0.02 + 0.012 * breath + leanZ - 0.25 * Math.min(0, this.lookPitch) + 0.14 * this.handOn, 0.32 * this.lookYaw, leanX + 0.04 * shift, 'YXZ'));
    this.chestQ.copy(this.pelvisQ).multiply(this.q);
    this.chestInv.copy(this.chestQ).invert();
    body.setTrunk(this.pelvis, this.pelvisQ, this.chestQ);

    // head, on the neck, turned the rest of the way; her eyes on him, or where she looks
    this.headQ.setFromEuler(this.e.set(0.04 - 0.8 * this.lookPitch, this.lookYaw, 0.02 * shift, 'YXZ'));
    const target = look.at ?? this.look.set(0, 0, 30).applyQuaternion(this.q.setFromEuler(this.e.set(-look.pitch, look.yaw, 0, 'YXZ'))).add(body.head);
    body.setHead(this.headQ, target, t);

    // legs to the feet, the knees easing forward; a foot in the air toes down a little as it leaves and lands
    for (let i = 0; i < 2; i++) {
      const side = i === 0 ? -1 : 1;
      const f = this.feet[i];
      const hip = body.hip(side, this.hipAt[i]);
      const ankle = local(f, this.ankles[i]).addScaledVector(UP, dims.ankle);
      const pole = this.pole.copy(hip).add(this.v.set(side * 0.1, -0.3, 1).applyQuaternion(this.pelvisQ));
      solveTwoBone(hip, ankle, dims.thigh, dims.shin, pole, this.knees[i], this.end);
      const pitch = f.t >= 0 ? 0.22 * Math.sin(Math.PI * 2 * f.t) : 0;
      body.setLeg(side, this.knees[i], this.end, angleDelta(this.rootYaw, f.yaw), pitch);
    }

    // the umbrella: the gusts push its canopy downwind and she holds it against them; when the rain drives
    // she tilts it into the wind; its paper stirs
    const wx = this.wind.x;
    const wz = this.wind.z;
    const into = Math.min(1, rain * 1.5) * 0.03;
    const push = 0.0045 * speed;
    const w = TILT.f * Math.PI * 2;
    if (step > 0) {
      this.vTilt.x += (w * w * (-wx * into - this.tilt.x) - 2 * TILT.zeta * w * this.vTilt.x + wx * push * w) * step;
      this.vTilt.y += (w * w * (-wz * into - this.tilt.y) - 2 * TILT.zeta * w * this.vTilt.y + wz * push * w) * step;
      this.tilt.x += this.vTilt.x * step;
      this.tilt.y += this.vTilt.y * step;
      const l = this.tilt.length();
      if (l > TILT.max) this.tilt.multiplyScalar(TILT.max / l);
    }
    this.flap.set((0.002 + 0.0016 * speed) * this.open, t, this.open);

    // hands first, then the arms reach them
    const [right, left] = this.arms;
    if (!this.posed) for (const arm of this.arms) arm.elbowAt.copy(body.shoulder(arm.side, arm.shoulder)).add(this.v.set(arm.side * 0.06, -0.25, 0));
    // a hand hanging easy by her side (swinging a little as she walks), or resting on the parapet's coping
    const reach = dims.upperArm + dims.foreArm;
    const swingArm = swing < 0 ? 0 : (swing === 0 ? 1 : -0.7) * walk;
    const face = BRIDGE.width / 2 - Math.abs(bridgeFrame(this.root.x, this.root.z).z);
    const easy = (side: number, swingOf: number, out: Vector3): Vector3 => {
      const down = this.v3.set(0.12 * side, -1, 0.06 + 0.02 * shift + 0.22 * swingOf).normalize().applyQuaternion(this.pelvisQ);
      body.shoulder(side, out).addScaledVector(down, reach * 0.93 + 0.075);
      if (this.handOn > 0.001) out.lerp(this.v.set(0.17 * side, BRIDGE.parapetHeight + 0.045, face + 0.07), ease(this.handOn));
      return out;
    };
    // (in this.v: each is handed over before the next is asked for)
    const handThumb = (side: number) => this.v.set(side * (0.1 + 0.6 * this.handOn), -0.2 * (1 - this.handOn), 1 - 0.6 * this.handOn).normalize().applyQuaternion(this.pelvisQ);

    // the umbrella in her right hand: over her head (giving a little to the tilt), held up before her, or carried
    // closed by its handle, its tip down by her foot
    this.shaftDir.copy(REST).add(this.v.set(this.tilt.x, 0, this.tilt.y)).normalize();
    body.onChest(this.v2.copy(this.gripAt).add(body.bindOf('spine01')), this.grip).addScaledVector(this.v.set(this.tilt.x, 0, this.tilt.y), -0.06);
    if (this.hasBrolly && this.raise < 1) {
      const before = body.onChest(this.v2.set(-0.04, -0.02, radiusAt(this.body.data.sections.chest, -0.02, 0).zc + 0.3).add(body.bindOf('spine01')), this.upright);
      const side = easy(-1, 0, this.holdAt);
      if (this.raise < 0.5) {
        const k = ease(this.raise * 2);
        this.grip.lerpVectors(side, before, k);
        this.shaftDir.copy(CANE).lerp(UPRIGHT, k).normalize();
      } else {
        const k = ease((this.raise - 0.5) * 2);
        this.grip.lerpVectors(before, this.grip, k);
        this.shaftDir.lerpVectors(UPRIGHT, this.shaftDir, k).normalize();
      }
    }
    // held by the handle when it is carried down, by the shaft above it when it is up
    const handle = HANDLE * (1 - Math.min(1, this.raise * 2));
    this.brolly.position.copy(this.grip).addScaledVector(this.shaftDir, handle);
    this.brolly.quaternion.setFromUnitVectors(UP, this.shaftDir);
    this.brolly.visible = this.hasBrolly;
    if (this.hasBrolly) this.placeHand(right, this.grip, this.shaftDir);
    else this.placeHand(right, easy(-1, -swingArm, this.holdAt), handThumb(-1));
    // her left hangs easy, or rests on the coping
    this.placeHand(left, easy(1, swingArm, this.v2), handThumb(1));
    for (const arm of this.arms) {
      const shoulder = body.shoulder(arm.side, arm.shoulder);
      const pole = this.pole.set(arm.side * 0.4, -0.5, -0.35).applyQuaternion(this.chestQ).add(shoulder);
      solveTwoBone(shoulder, arm.wrist, dims.upperArm, dims.foreArm, pole, arm.elbowAt, this.end);
      body.setHand(arm.grip, arm.hold, arm.barQ);
      body.setArm(arm.side, arm.elbowAt);
    }
    this.posed = true;

    // her clothes, and her hair in the air past her head
    this.skirt.update(dt, t, this.skirtRing, this.wind, this.keepOffLegs);
    this.orna.update(dt, t, this.ornaPin, this.awayFromBody, this.keepOffBody, this.wind, this.gravity);
    const hair = this.v.copy(this.wind).applyQuaternion(this.q.copy(this.headQ).invert());
    body.hairWind.set(hair.x, hair.y, hair.z, t);
    body.commit();

    // the soft shadows on the deck: under her feet, and the umbrella's where the key light throws it
    this.footShadow.position.x = this.pelvis.x * 0.6;
    const canopy = this.v.copy(this.shaftDir).multiplyScalar(SHAFT - CANOPY_DEPTH * 0.5).add(this.grip);
    const key = this.v2.copy(G.uKeyDir.value).applyQuaternion(this.inverse);
    const k = key.y > 0.12 ? (canopy.y - 0.012) / key.y : 0;
    const sx = Math.max(-1.4, Math.min(1.4, canopy.x - key.x * k));
    const sz = Math.max(-1.6, Math.min(1.6, canopy.z - key.z * k));
    // only on the deck, between the parapets
    const onDeck = this.v3.set(sx, 0, sz).applyQuaternion(this.group.quaternion).add(this.group.position);
    const inside = Math.abs(bridgeFrame(onDeck.x, onDeck.z).z) < BRIDGE.width / 2 - 0.3;
    this.brollyShadow.position.set(sx, 0.014, sz);
    const strength = smoothstep(0.12, 0.4, key.y) * (1 - G.uOvercast.value * 0.8) * (inside ? 1 : 0);
    (this.brollyShadow.material as MeshBasicMaterial).opacity = 0.42 * strength * this.open;
    this.brollyShadow.visible = strength * this.open > 0.01;

    // what the umbrella keeps dry, for the rain
    canopy.applyQuaternion(this.group.quaternion).add(this.group.position);
    this.shelter.set(canopy.x, canopy.y, canopy.z, this.open > 0.8 ? CANOPY_R * 1.05 : 0);
  }
}

