import {
  CapsuleGeometry,
  DoubleSide,
  Euler,
  Group,
  LatheGeometry,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  Quaternion,
  SphereGeometry,
  TorusGeometry,
  Vector2,
  Vector3,
} from 'three';
import type { BufferGeometry } from 'three';
import { MeshBuilder } from '../render/builder';
import { patchMaterial } from '../render/patch';
import { clothTexture, weaveTexture } from '../render/textures';
import { ellipticLimb, handGeometry, limbGeometry, type HandShape } from './anatomy';
import type { Crew } from './boatPhysics';
import { ClothRibbon, ClothTube, type Ring } from './cloth';
import type { BodyDrive } from './paddle';

// The majhi: a lean, weathered boatman paddling with a বৈঠা at the stern, standing and facing the bow.
// Faceless and stylised; a wide palm-leaf mathal shades where a face would be. He is built to real
// proportions, and each frame his feet stay planted on the boards while the rest of him balances: he
// keeps upright as the deck rolls under him (a beat late, as people do) and works the stroke with his
// whole body (wound up and reaching at the catch, unwinding, sinking at the knees and leaning out over
// the blade through the pull), bending further in when the paddle runs out of his arms' reach. His head
// keeps looking down the river. His hands are closed round the paddle, his right on the cross-grip at
// its top (turning with it as he feathers the blade), his left down the shaft; his arms reach them from
// his shoulders. His lungi, vest and gamchha are cloth: they follow him a beat late, swing and settle,
// and stir in the wind. Where his weight is goes back to the boat, which heels and trims under it.
// He faces +z, so his right side is −x; he paddles on his left (+x).

const UP = new Vector3(0, 1, 0);
const SHIN = 0.41;
const THIGH = 0.42;
const ANKLE = 0.07;
const UPPER_ARM = 0.29;
const FOREARM = 0.26;
const REACH = UPPER_ARM + FOREARM;
const HIP_HALF = 0.09;
/** Hip joints above the soles, knees softly bent. */
const PELVIS_HEIGHT = 0.82;
/** From the hip joints to the base of the chest. */
const SPINE = 0.08;
const SHOULDER = new Vector3(0.18, 0.4, 0);
const NECK_BASE = new Vector3(0, 0.46, 0.01);
/** Balance: how fast he rights himself as the deck tilts, and how far (he leaves a little to the deck). */
const BALANCE = { f: 1.3, zeta: 0.55, share: 0.85 };
/** His skin: a sun-browned, shyamla Bengali complexion (sRGB). */
const SKIN_TONE = '#8d5a3b';
/** How far he bends in when a hold runs out of his arms' reach (m): his hips take part of it, his chest the rest. */
const LEAN_MAX = 0.16;

/** The trunk's lathe profile, [radius, height above the chest's base]; front to back it is TRUNK_DEPTH of this. */
const TRUNK: readonly (readonly [number, number])[] = [
  [0.13, 0],
  [0.14, 0.08],
  [0.148, 0.18],
  [0.165, 0.28],
  [0.178, 0.36],
  [0.17, 0.41],
  [0.12, 0.455],
  [0.05, 0.475],
];
const TRUNK_DEPTH = 0.7;
const TRUNK_BY_HEIGHT = TRUNK.map(([r, y]) => [y, r] as const);
/** The vest's radius by height on the chest, [height, radius]: loose over the belly, hugging the chest. */
const VEST: readonly (readonly [number, number])[] = [
  [-0.03, 0.154],
  [0.08, 0.155],
  [0.18, 0.163],
  [0.28, 0.178],
  [0.35, 0.188],
  [0.385, 0.184],
];
const VEST_TOP = 0.385;
const VEST_LENGTH = 0.4;
/** The vest's shoulder straps, either side of the neck. */
const STRAP_X = 0.105;
/** The forearm, elbow to wrist: [height, half-width across the wrist's broad axis, half-depth]. */
const FOREARM_RINGS: readonly (readonly [number, number, number])[] = [
  [0, 0.04, 0.038],
  [0.05, 0.044, 0.039],
  [0.11, 0.04, 0.034],
  [0.18, 0.034, 0.026],
  [0.235, 0.03, 0.0215],
  [FOREARM, 0.0285, 0.0198],
];
/** The lungi from its top to the hip joints, on the pelvis: [t, height above the hip joints, half-width, half-depth]. */
const LUNGI_TOP: readonly (readonly [number, number, number, number])[] = [
  [0.0, 0.05, 0.142, 0.112],
  [0.1, 0.022, 0.152, 0.122],
  [0.2, -0.03, 0.185, 0.143],
];
const LUNGI_HIPS = 0.2;
/** The thigh's radius from hip (0) to knee (1). */
const THIGH_RADIUS: readonly (readonly [number, number])[] = [
  [0, 0.075],
  [0.25, 0.08],
  [0.5, 0.07],
  [0.75, 0.058],
  [1, 0.052],
];
/** The gamchha over his right shoulder: where it lies (round the shoulder's section, front to back) and which particles that holds. */
const GAMCHHA_X = -0.112;
const GAMCHHA_PSI = [0.4, 0.95, Math.PI / 2, 2.19, 2.74];
const GAMCHHA_PINS = [6, 7, 8, 9, 10];
const GAMCHHA_COUNT = 17;

/** Linear interpolation in a table of [x, y] rows sorted by x, clamped at its ends. */
function profile(table: readonly (readonly [number, number])[], x: number): number {
  if (x <= table[0][0]) return table[0][1];
  for (let i = 1; i < table.length; i++) {
    const [x1, y1] = table[i];
    if (x <= x1) {
      const [x0, y0] = table[i - 1];
      return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
    }
  }
  return table[table.length - 1][1];
}

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/** The shortest signed angle from 0 to `a`. */
function wrap(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

/**
 * A point on his trunk with the vest on it (chest frame), in the upright section at `x`, `psi` round from
 * the front (0) over the shoulder (π/2) to the back (π), lifted `lift` off the surface; `n` its normal.
 */
function onShoulder(x: number, psi: number, lift: number, p: Vector3, n: Vector3): void {
  const cy = 0.36;
  const depth = TRUNK_DEPTH * 1.03;
  const radius = (y: number) => profile(TRUNK_BY_HEIGHT, y) + 0.009;
  const inside = (s: number) => {
    const y = cy + Math.sin(psi) * s;
    const z = Math.cos(psi) * s;
    return (z / depth) ** 2 + x * x < radius(y) ** 2;
  };
  // walk out from the middle of the section to where the ray leaves him
  let lo = 0;
  let hi = 0.25;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (inside(mid)) lo = mid;
    else hi = mid;
  }
  const y = cy + Math.sin(psi) * lo;
  const z = Math.cos(psi) * lo;
  // the normal is the gradient of (z/depth)² + x² − r(y)²
  const r = radius(y);
  const dr = (radius(y + 0.002) - radius(y - 0.002)) / 0.004;
  n.set(x, -r * dr, z / (depth * depth)).normalize();
  p.set(x, y, z).addScaledVector(n, lift);
}

/** The lungi's folds: pleats gathered at the knot, the overlap running down from it, drape, the waist's roll, a ragged hem. */
function lungiFold(t: number, th: number): { r: number; y: number } {
  const knot = Math.PI / 2;
  const near = (c: number, w: number) => Math.exp(-((wrap(th - c) / w) ** 2));
  const drape = (0.004 + 0.014 * t) * (0.55 * Math.sin(5 * th + 1.3) + 0.35 * Math.sin(9 * th + 0.4) + 0.22 * Math.sin(14 * th + 2.1));
  const pleats = t < 0.45 ? 0.007 * near(knot, 0.55) * (1 - t / 0.45) * Math.sin(th * 24) : 0;
  const overlap = 0.011 * near(knot + 0.25, 0.1) * (t > 0.05 ? 1 : 0.4);
  const roll = Math.abs(t - 0.1) < 0.01 ? 0.011 : 0;
  // it hangs round both knees as one tube, so it falls in between them, front and back
  const between = t > 0.3 ? -0.02 * ((t - 0.3) / 0.7) ** 2 * (near(knot, 0.32) + near(-knot, 0.32)) : 0;
  const hem = t > 0.95 ? 0.012 * Math.sin(3 * th + 0.5) + 0.006 * Math.sin(7 * th + 1.1) + 0.012 * near(knot + 0.25, 0.3) : 0;
  return { r: drape + pleats + overlap + roll + between, y: hem };
}

/** The vest's folds: the neck scooped front and back, deep armholes, drape toward the hem, soft rolls over the belly. */
function vestFold(t: number, th: number): { r: number; y: number } {
  const s = Math.sin(th);
  const c = Math.cos(th);
  const cut = 0.05 * Math.max(0, s) ** 4 + 0.03 * Math.max(0, -s) ** 4 + 0.085 * c ** 8;
  const drape = (0.0015 + 0.006 * t * t) * (0.6 * Math.sin(6 * th + 0.7) + 0.4 * Math.sin(11 * th + 2.3));
  const belly = t > 0.45 && t < 0.9 ? 0.0025 * Math.sin((t - 0.45) * 50) * (0.5 + 0.5 * s) : 0;
  return { r: drape + belly, y: cut * Math.max(0, 1 - t / 0.3) };
}

/** Two-bone IK: places `mid` (knee or elbow) so the chain from `root` reaches `target`, bending toward `pole`. */
function solveTwoBone(root: Vector3, target: Vector3, a: number, b: number, pole: Vector3, mid: Vector3, end: Vector3): void {
  const d = new Vector3().subVectors(target, root);
  let len = d.length();
  const reach = (a + b) * 0.999;
  if (len > reach) {
    d.multiplyScalar(reach / len);
    len = reach;
  }
  const dir = d.clone().normalize();
  end.copy(root).add(d);
  const x = (a * a - b * b + len * len) / (2 * len);
  const h = Math.sqrt(Math.max(a * a - x * x, 0));
  const bend = new Vector3().subVectors(pole, root);
  bend.addScaledVector(dir, -bend.dot(dir)).normalize();
  mid.copy(root).addScaledVector(dir, x).addScaledVector(bend, h);
}

const tmpDir = new Vector3();
const basisX = new Vector3();
const basisY = new Vector3();
const basisZ = new Vector3();
const basis = new Matrix4();

/** Sets a +y-built part at `from`, pointing at `to`. */
function aim(mesh: Mesh, from: Vector3, to: Vector3): void {
  mesh.position.copy(from);
  mesh.quaternion.setFromUnitVectors(UP, tmpDir.subVectors(to, from).normalize());
}

/** As `aim`, and turned about its length so its x axis lies along `across` (a flattened limb). */
function aimRolled(mesh: Mesh, from: Vector3, to: Vector3, across: Vector3): void {
  mesh.position.copy(from);
  basisY.subVectors(to, from).normalize();
  basisX.copy(across).addScaledVector(basisY, -across.dot(basisY)).normalize();
  basisZ.crossVectors(basisX, basisY);
  mesh.quaternion.setFromRotationMatrix(basis.makeBasis(basisX, basisY, basisZ));
}

function spring(x: number, v: number, target: number, f: number, zeta: number, dt: number): [number, number] {
  const w = f * Math.PI * 2;
  v += (w * w * (target - x) - 2 * zeta * w * v) * dt;
  return [x + v * dt, v];
}

/** What he wears: the lungi's check (ground, stripe, thin thread), the vest, the gamchha's check (sRGB), and a seed for the weave. */
export interface Outfit {
  lungi: readonly [string, string, string];
  vest: string;
  gamchha: readonly [string, string, string];
  seed: number;
}

/** The majhi's: a blue checked lungi, an off-white vest, a red gamchha. */
export const MAJHI_OUTFIT: Outfit = {
  lungi: ['#2c4a86', '#e8e2d2', '#16244a'],
  vest: '#d6cfbf',
  gamchha: ['#a8342a', '#efe6d6', '#5a1410'],
  seed: 71,
};

export interface BoatTilt {
  rotX: number;
  rotZ: number;
}

/** Where a hand holds a bar (boat frame): a point on its axis, and the bar's direction there toward the thumb. */
export interface Hold {
  at: Vector3;
  thumb: Vector3;
}

export interface OarPose {
  /** His right hand's hold (on the cross-grip) and his left's (down the shaft). */
  holds: readonly [Hold, Hold];
}

interface Arm {
  /** −1 his right (−x), +1 his left. */
  side: number;
  upper: Mesh;
  fore: Mesh;
  elbow: Mesh;
  hand: Mesh;
  shape: HandShape;
  shoulder: Vector3;
  wrist: Vector3;
  /** Across the wrist (boat frame), for turning the forearm to meet the hand. */
  across: Vector3;
  /** Last frame's elbow, and the forearm's line as seen down the bar: the hand is posed from them. */
  elbowAt: Vector3;
  roll: Vector3;
}

export class Boatman {
  readonly group = new Group();
  /** Where his weight is, offset from where it rests (boat frame), for the boat's balance. */
  readonly crew: Crew = { x: 0, z: 0 };
  /** How far his hands' holds were from his shoulders this frame, over his arms' length (debug). */
  stretch = 0;

  private readonly stance: Vector3;
  private readonly feet: Vector3[] = [];
  private readonly legs: { thigh: Mesh; shin: Mesh; knee: Mesh; side: number }[] = [];
  private readonly arms: Arm[] = [];
  private readonly chest = new Group();
  private readonly head = new Group();
  private readonly neck: Mesh;
  private readonly lungi: ClothTube;
  private readonly vest: ClothTube;
  private readonly gamchha: ClothRibbon;
  private readonly gamchhaAt: Vector3[] = [];
  private readonly gamchhaNormal: Vector3[] = [];
  /** Carries the knot of the lungi at the waist; follows the hips. */
  private readonly knot = new Group();
  private readonly restPelvis = new Vector3();
  private posed = false;
  private balX = 0;
  private balZ = 0;
  private vBalX = 0;
  private vBalZ = 0;
  // the body's frames this instant, for the cloth
  private readonly pelvis = new Vector3();
  private readonly pelvisQ = new Quaternion();
  private readonly chestQ = new Quaternion();
  private readonly chestInv = new Quaternion();
  private readonly pAx = new Vector3();
  private readonly pAy = new Vector3();
  private readonly pAz = new Vector3();
  private readonly cAx = new Vector3();
  private readonly cAy = new Vector3();
  private readonly cAz = new Vector3();
  private readonly hips = [new Vector3(), new Vector3()];
  private readonly knees = [new Vector3(), new Vector3()];
  private readonly shinTop = [new Vector3(), new Vector3()];
  private readonly legC = new Vector3();
  private readonly legL = new Vector3();
  private readonly legR = new Vector3();
  private readonly legAcross = new Vector3();
  private readonly legFwd = new Vector3();
  // scratch
  private readonly headQ = new Quaternion();
  private readonly e = new Euler();
  private readonly q = new Quaternion();
  private readonly v = new Vector3();
  private readonly v2 = new Vector3();
  private readonly v3 = new Vector3();
  private readonly lean = new Vector3();
  private readonly pole = new Vector3();
  private readonly end = new Vector3();
  private readonly axis = new Vector3();
  private readonly fore = new Vector3();
  private readonly d = new Vector3();
  private readonly ad = new Vector3();

  /**
   * `stance`: the middle of his feet on the boards (boat frame); `barRadii`: the radius of what his right
   * hand holds (the cross-grip) and his left (the shaft); `outfit`: what he wears.
   */
  constructor(stance: Vector3, barRadii: readonly [number, number], outfit: Outfit = MAJHI_OUTFIT) {
    this.stance = stance.clone();
    this.group.name = 'boatman';
    const skin = patchMaterial(new MeshStandardMaterial({ color: SKIN_TONE, roughness: 0.55 }), { translucency: 0.35 });
    // the hands carry paler palms and nails in their vertex colours
    const handSkin = patchMaterial(new MeshStandardMaterial({ color: SKIN_TONE, roughness: 0.55, vertexColors: true }), { translucency: 0.35 });
    const cloth = (weave: ReturnType<typeof clothTexture>, roughness: number, relief = 0.7) =>
      new MeshStandardMaterial({
        map: weave.map,
        normalMap: weave.normal,
        normalScale: new Vector2(relief, relief),
        vertexColors: true,
        roughness,
        side: DoubleSide,
      });
    const { lungi, vest, gamchha, seed } = outfit;
    const lungiMat = patchMaterial(cloth(clothTexture(lungi[0], lungi[1], lungi[2], seed), 0.92), { grime: 0.15, translucency: 0.15 });
    const vestMat = patchMaterial(cloth(clothTexture(vest, vest, vest, seed + 1, true), 0.94, 0.3), { grime: 0.3, translucency: 0.2 });
    const gamchhaMat = patchMaterial(cloth(clothTexture(gamchha[0], gamchha[1], gamchha[2], seed + 2), 0.9), { translucency: 0.3 });
    const hair = new MeshStandardMaterial({ color: '#17110d', roughness: 0.75 });
    const hatWeave = weaveTexture(53);
    hatWeave.repeat.set(10, 3);
    const hatMat = patchMaterial(new MeshStandardMaterial({ map: hatWeave, color: '#fff0cc', roughness: 0.85, side: DoubleSide }), {
      translucency: 0.5,
    });
    const g = this.group;

    // feet: bare, turned out a little; the leading foot forward toward the bow
    for (const [dx, dz, yaw] of [
      [-0.16, 0.15, -0.2],
      [0.08, -0.17, 0.4],
    ] as const) {
      const foot = new Mesh(new CapsuleGeometry(0.042, 0.16, 4, 10), skin);
      foot.rotation.set(Math.PI / 2, 0, 0);
      foot.geometry.scale(1.15, 1, 0.62);
      const holder = new Group();
      holder.add(foot);
      foot.position.set(0, 0.026, 0.05);
      holder.position.set(stance.x + dx, stance.y, stance.z + dz);
      holder.rotation.y = yaw;
      g.add(holder);
      this.feet.push(holder.position.clone());
    }
    for (const side of [-1, 1]) {
      const thigh = new Mesh(limbGeometry(THIGH, [0.075, 0.08, 0.07, 0.058, 0.05]), skin);
      const shin = new Mesh(limbGeometry(SHIN, [0.05, 0.055, 0.05, 0.038, 0.032]), skin);
      const knee = new Mesh(new SphereGeometry(0.052, 10, 8), skin);
      g.add(thigh, shin, knee);
      this.legs.push({ thigh, shin, knee, side });
    }

    // torso: a lathe for the trunk, shoulders bare; the vest's straps over it (the vest itself is cloth)
    const trunk = new LatheGeometry(
      TRUNK.map(([r, y]) => new Vector2(r, y)),
      20,
    );
    trunk.scale(1, 1, TRUNK_DEPTH);
    this.chest.add(new Mesh(trunk, skin), new Mesh(this.straps(), vestMat));
    g.add(this.chest);
    this.neck = new Mesh(limbGeometry(0.12, [0.05, 0.047, 0.046]), skin);
    g.add(this.neck);

    // head: no face; short black hair, ears, and the mathal over it all
    const skull = new Mesh(new SphereGeometry(0.1, 16, 12), skin);
    skull.scale.set(0.86, 1.08, 1);
    const hairCap = new Mesh(new SphereGeometry(0.104, 16, 10, 0, Math.PI * 2, 0, Math.PI * 0.55), hair);
    hairCap.position.set(0, 0.006, -0.01);
    hairCap.rotation.x = -0.35;
    hairCap.scale.set(0.88, 1.06, 1.02);
    this.head.add(skull, hairCap);
    for (const side of [-1, 1]) {
      const ear = new Mesh(new SphereGeometry(0.026, 8, 6), skin);
      ear.scale.set(0.38, 1, 0.68);
      ear.position.set(side * 0.086, -0.005, -0.008);
      this.head.add(ear);
    }
    const hat = new Mesh(
      new LatheGeometry(
        [
          [0.0, 0.15],
          [0.035, 0.145],
          [0.12, 0.1],
          [0.22, 0.05],
          [0.3, 0.016],
          [0.34, 0.0],
          [0.348, -0.014],
        ].map(([r, y]) => new Vector2(r, y)),
        28,
      ),
      hatMat,
    );
    const rim = new Mesh(new TorusGeometry(0.345, 0.011, 5, 32), new MeshStandardMaterial({ color: '#5a4630', roughness: 0.8 }));
    rim.rotation.x = Math.PI / 2;
    rim.position.y = -0.008;
    const hatHolder = new Group();
    hatHolder.add(hat, rim);
    hatHolder.position.set(0, 0.075, -0.005);
    hatHolder.rotation.x = -0.12;
    this.head.add(hatHolder);
    g.add(this.head);

    // arms: a deltoid capping the shoulder, a forearm broad across the wrist, and a hand closed on the paddle
    [-1, 1].forEach((side, i) => {
      const shape = handGeometry(barRadii[i], side > 0);
      const upper = new Mesh(limbGeometry(UPPER_ARM, [0.052, 0.054, 0.046, 0.04, 0.036], 0.056), skin);
      const fore = new Mesh(ellipticLimb(FOREARM_RINGS), skin);
      const elbow = new Mesh(new SphereGeometry(0.038, 10, 8), skin);
      const hand = new Mesh(shape.geometry, handSkin);
      g.add(upper, fore, elbow, hand);
      this.arms.push({
        side,
        upper,
        fore,
        elbow,
        hand,
        shape,
        shoulder: new Vector3(),
        wrist: new Vector3(),
        across: new Vector3(1, 0, 0),
        elbowAt: new Vector3(),
        roll: new Vector3(0, -1, 0),
      });
    });

    // the lungi: wrapped and rolled at the waist, hitched to the knees, knotted in front
    this.lungi = new ClothTube(lungiMat, {
      segments: 36,
      rings: 10,
      fold: lungiFold,
      freedom: (t) => 0.75 * Math.max(0, (t - 0.2) / 0.8) ** 1.3,
      shade: (t) => (Math.abs(t - 0.1) < 0.01 ? 1.04 : Math.abs(t - 0.1) < 0.11 ? 0.8 : t > 0.95 ? 0.88 : 1),
      uRepeat: 4,
      vRepeat: 2.2,
    });
    const knotB = new MeshBuilder();
    const ball = new SphereGeometry(1, 10, 8);
    knotB.add(ball, new Matrix4().makeTranslation(0.028, 0.024, 0.128).scale(new Vector3(0.034, 0.026, 0.02)));
    knotB.add(ball, new Matrix4().makeTranslation(0.05, 0.004, 0.122).scale(new Vector3(0.022, 0.03, 0.016)));
    this.knot.add(new Mesh(knotB.build(), lungiMat));
    // the vest: a knitted sando, close on the chest and loose over the belly
    this.vest = new ClothTube(vestMat, {
      segments: 30,
      rings: 9,
      fold: vestFold,
      freedom: (t) => 0.5 * Math.max(0, (t - 0.55) / 0.45) ** 1.2,
      shade: (t) => (t > 0.95 ? 0.9 : 1),
      uRepeat: 3,
      vRepeat: 1.5,
    });
    // the gamchha: folded over his right shoulder, its ends hanging down his chest and back
    this.gamchha = new ClothRibbon(gamchhaMat, GAMCHHA_COUNT, 0.04, 0.085, GAMCHHA_PINS, 0.33, 2.4);
    for (const psi of GAMCHHA_PSI) {
      const p = new Vector3();
      const n = new Vector3();
      onShoulder(GAMCHHA_X, psi, 0.016, p, n);
      this.gamchhaAt.push(p);
      this.gamchhaNormal.push(n);
    }
    g.add(this.lungi.mesh, this.knot, this.vest.mesh, this.gamchha.mesh);

    this.restPelvis.set(stance.x, stance.y + PELVIS_HEIGHT, stance.z);
  }

  /** The vest's straps, over each shoulder from the chest to the back (chest frame). */
  private straps(): BufferGeometry {
    const b = new MeshBuilder();
    const p = new Vector3();
    const n = new Vector3();
    const across = new Vector3();
    const steps = 14;
    for (const side of [-1, 1]) {
      const start = b.vertexCount;
      for (let i = 0; i <= steps; i++) {
        const psi = -0.25 + (i / steps) * (Math.PI + 0.5);
        onShoulder(side * STRAP_X, psi, 0.004, p, n);
        across.set(1, 0, 0).addScaledVector(n, -n.x).normalize();
        b.vertex(p.clone().addScaledVector(across, -0.015), n, 0, i * 0.08);
        b.vertex(p.clone().addScaledVector(across, 0.015), n, 0.12, i * 0.08);
      }
      for (let i = 0; i < steps; i++) {
        const a = start + i * 2;
        b.quad(a, a + 1, a + 3, a + 2);
      }
    }
    return b.build();
  }

  /** The ring of the lungi at `t` (0 its top .. 1 its hem), where his hips and knees put it. */
  private readonly lungiRing = (t: number, out: Ring): Ring => {
    if (t < LUNGI_HIPS) {
      const k = Math.min(LUNGI_TOP.length - 2, Math.floor(t * 10));
      const f = (t - LUNGI_TOP[k][0]) * 10;
      const [, h0, a0, b0] = LUNGI_TOP[k];
      const [, h1, a1, b1] = LUNGI_TOP[k + 1];
      out.c.copy(this.pelvis).addScaledVector(this.pAy, h0 + (h1 - h0) * f);
      out.ax.copy(this.pAx);
      out.az.copy(this.pAz);
      out.a = a0 + (a1 - a0) * f;
      out.b = b0 + (b1 - b0) * f;
      return out;
    }
    // from the hips down it hangs round both thighs: at each height an ellipse through the two legs, clear
    // of them by a hand's breadth lower down, so a knee pushed forward carries the cloth with it; the hem
    // just below the knees
    const s = (t - LUNGI_HIPS) / (1 - LUNGI_HIPS);
    this.legL.lerpVectors(this.hips[0], this.knees[0], s);
    this.legR.lerpVectors(this.hips[1], this.knees[1], s);
    this.legC.addVectors(this.legL, this.legR).multiplyScalar(0.5).addScaledVector(UP, -0.02 * s);
    this.legAcross.subVectors(this.legR, this.legL);
    const half = this.legAcross.length() / 2;
    this.legAcross.normalize();
    this.legFwd.crossVectors(this.legAcross, UP).normalize();
    const r = profile(THIGH_RADIUS, s);
    const clear = 0.02 + 0.04 * smoothstep(0, 0.5, s);
    const belly = Math.sin(Math.PI * s);
    out.c.copy(this.legC);
    out.ax.copy(this.legAcross);
    out.az.copy(this.legFwd);
    out.a = half + r + clear + 0.012 * belly;
    out.b = r + 0.068 + 0.01 * belly;
    return out;
  };

  /** The ring of the vest at `t` (0 its top .. 1 its hem): on his chest, and toward the hem more and more on his hips. */
  private readonly vestRing = (t: number, out: Ring): Ring => {
    const y = VEST_TOP - t * VEST_LENGTH;
    const r = profile(VEST, y);
    const w = smoothstep(0.55, 1, t);
    out.c.copy(this.cAy).multiplyScalar(y).add(this.chest.position);
    out.c.lerp(this.v2.copy(this.pelvis).addScaledVector(this.pAy, SPINE + y), w);
    out.ax.copy(this.cAx).lerp(this.pAx, w).normalize();
    out.az.copy(this.cAz).lerp(this.pAz, w).normalize();
    out.a = r + 0.008 * w;
    out.b = r * (0.72 + 0.08 * w);
    return out;
  };

  private readonly gamchhaPin = (i: number, p: Vector3, n: Vector3): void => {
    const k = i - GAMCHHA_PINS[0];
    p.copy(this.gamchhaAt[k]).applyQuaternion(this.chestQ).add(this.chest.position);
    n.copy(this.gamchhaNormal[k]).applyQuaternion(this.chestQ);
  };

  private readonly awayFromChest = (p: Vector3, out: Vector3): void => {
    out.subVectors(p, this.chest.position);
    out.addScaledVector(this.cAy, -out.dot(this.cAy)).normalize();
  };

  /** Keeps the lungi off his thighs and the tops of his shins, a finger's width proud of the skin. */
  private readonly keepOffLegs = (p: Vector3): void => {
    for (let i = 0; i < 2; i++) {
      // not round the top of the thigh: the hip joint is inside him, and the waist sits close above it
      this.pushOff(p, this.hips[i], this.knees[i], (f) => profile(THIGH_RADIUS, f) + 0.012, false);
      this.pushOff(p, this.knees[i], this.shinTop[i], (f) => 0.055 - 0.005 * f + 0.012, true);
    }
  };

  /**
   * Pushes `p` out of the capsule from `a` to `b` whose radius at `f` (0 at a .. 1 at b) is `radius(f)`;
   * without `capA`, points beyond its `a` end are left alone.
   */
  private pushOff(p: Vector3, a: Vector3, b: Vector3, radius: (f: number) => number, capA: boolean): void {
    const seg = this.v3.subVectors(b, a);
    const along = this.v2.subVectors(p, a).dot(seg) / seg.lengthSq();
    if (along < 0 && !capA) return;
    const f = Math.min(1, Math.max(0, along));
    const away = this.v2.subVectors(p, a).addScaledVector(seg, -f);
    const d = away.length();
    const r = radius(f);
    if (d < r && d > 1e-5) p.addScaledVector(away, (r - d) / d);
  }

  private readonly keepOffChest = (p: Vector3): void => {
    const v = this.v3.subVectors(p, this.chest.position).applyQuaternion(this.chestInv);
    if (v.y < -0.15 || v.y > 0.44) return;
    const rx = profile(VEST, v.y) + 0.016;
    const rz = rx * 0.72 + 0.004;
    const e = Math.hypot(v.x / rx, v.z / rz);
    if (e >= 1 || e < 1e-4) return;
    v.x /= e;
    v.z /= e;
    p.copy(v.applyQuaternion(this.chestQ)).add(this.chest.position);
  };

  private shoulderOf(arm: Arm): Vector3 {
    return arm.shoulder.set(arm.side * SHOULDER.x, SHOULDER.y, SHOULDER.z).applyQuaternion(this.chestQ).add(this.chest.position);
  }

  /** Elbows out and down, a little back. */
  private poleOf(arm: Arm): Vector3 {
    return this.pole.set(arm.side * 0.5, -0.6, -0.25).applyQuaternion(this.chestQ).add(arm.shoulder);
  }

  /**
   * Closes `arm`'s hand on its hold: the bar runs through the palm, and the hand turns about the bar until
   * the wrist faces the forearm (from last frame's elbow). Leaves the wrist where the arm must reach.
   */
  private placeHand(arm: Arm, hold: Hold): void {
    const { shape } = arm;
    // the hand's +x runs along the bar toward a right hand's thumb, away from a left hand's
    const a = this.axis.copy(hold.thumb).multiplyScalar(arm.side < 0 ? 1 : -1).normalize();
    const f = this.fore.set(0, shape.fore.y, shape.fore.z).normalize();
    arm.roll.addScaledVector(a, -arm.roll.dot(a)).normalize();
    for (let pass = 0; pass < 2; pass++) {
      // the forearm as seen down the bar: from the elbow to the hold, then (better) to the wrist
      const d = this.d.subVectors(pass === 0 ? hold.at : arm.wrist, arm.elbowAt);
      d.addScaledVector(a, -d.dot(a));
      if (d.lengthSq() > 1e-6) arm.roll.copy(d.normalize());
      const ad = this.ad.crossVectors(a, arm.roll);
      basisY.copy(arm.roll).multiplyScalar(f.y).addScaledVector(ad, -f.z);
      basisZ.copy(arm.roll).multiplyScalar(f.z).addScaledVector(ad, f.y);
      arm.hand.quaternion.setFromRotationMatrix(basis.makeBasis(a, basisY, basisZ));
      arm.wrist.copy(shape.wrist).applyQuaternion(arm.hand.quaternion).add(hold.at);
    }
    arm.hand.position.copy(hold.at);
    arm.across.copy(shape.across).applyQuaternion(arm.hand.quaternion);
  }

  /**
   * Poses him for this instant. `time`: seconds, for the cloth's flutter; `drive`: how his body works the
   * stroke now; `oar`: where his hands hold the paddle; `tilt`: the deck's angles; `wind`: the air moving
   * past him (m/s) and `gravity`, both in the boat's frame.
   */
  update(dt: number, time: number, drive: BodyDrive, oar: OarPose, tilt: BoatTilt, wind: Vector3, gravity: Vector3): void {
    // balance: he leans against the deck's tilt to stay upright, a beat late
    [this.balX, this.vBalX] = spring(this.balX, this.vBalX, -tilt.rotX * BALANCE.share, BALANCE.f, BALANCE.zeta, dt);
    [this.balZ, this.vBalZ] = spring(this.balZ, this.vBalZ, -tilt.rotZ * BALANCE.share, BALANCE.f, BALANCE.zeta, dt);

    // hips: they sink as his knees give into the pull, move with him toward the bow and out over the
    // side, tip forward as he bends from them, and turn with a share of his twist
    this.e.set(this.balX, 0, this.balZ, 'YXZ');
    this.v.set(0.12 * drive.lean, PELVIS_HEIGHT - drive.crouch, drive.shift).applyEuler(this.e);
    this.pelvis.copy(this.stance).add(this.v);
    this.pelvisQ.setFromEuler(this.e.set(this.balX + 0.04 + 0.35 * drive.bend, 0.4 * drive.twist, this.balZ - 0.3 * drive.lean, 'YXZ'));

    // chest: the rest of the bend, the twist and the lean
    this.q.setFromEuler(this.e.set(0.13 + 0.65 * drive.bend, 0.6 * drive.twist, -0.7 * drive.lean, 'YXZ'));
    this.chestQ.copy(this.pelvisQ).multiply(this.q);
    this.chest.position.copy(this.pelvis).add(this.v.set(0, SPINE, 0).applyQuaternion(this.pelvisQ));

    // hands first, for they are where the paddle is; then he bends in if a hold is out of his arms' reach
    this.stretch = 0;
    this.lean.set(0, 0, 0);
    this.arms.forEach((arm, i) => {
      const hold = oar.holds[i];
      const shoulder = this.shoulderOf(arm);
      if (!this.posed) solveTwoBone(shoulder, hold.at, UPPER_ARM, FOREARM, this.poleOf(arm), arm.elbowAt, this.end);
      this.placeHand(arm, hold);
      const off = this.v.subVectors(arm.wrist, shoulder);
      const dist = off.length();
      this.stretch = Math.max(this.stretch, dist / REACH);
      const excess = dist - REACH * 0.985;
      if (excess > 0) this.lean.addScaledVector(off, excess / dist);
    });
    if (this.lean.length() > LEAN_MAX) this.lean.setLength(LEAN_MAX);
    this.pelvis.addScaledVector(this.lean, 0.5);
    this.chest.position.add(this.lean);
    this.chest.quaternion.copy(this.chestQ);
    this.chestInv.copy(this.chestQ).invert();
    this.knot.position.copy(this.pelvis);
    this.knot.quaternion.copy(this.pelvisQ);

    // head: level in the world and looking down the river (a little down, toward the blade, as he bends),
    // whatever the body and the deck do
    const neckBase = this.v.copy(NECK_BASE).applyQuaternion(this.chestQ).add(this.chest.position).clone();
    this.headQ.setFromEuler(this.e.set(-tilt.rotX * 0.9 + 0.08 + 0.2 * drive.bend, 0.25 * drive.twist, -tilt.rotZ * 0.9, 'YXZ'));
    const headCentre = neckBase.clone().add(this.v.set(0, 0.15, 0.005).applyQuaternion(this.headQ));
    this.head.position.copy(headCentre);
    this.head.quaternion.copy(this.headQ);
    aim(this.neck, neckBase, headCentre.clone().addScaledVector(UP, -0.06));

    // legs: from the hips to the planted feet, knees forward and a little out
    this.legs.forEach((leg, i) => {
      const hip = this.hips[i].set(leg.side * HIP_HALF, -0.03, 0).applyQuaternion(this.pelvisQ).add(this.pelvis);
      const knee = this.knees[i];
      const ankle = this.feet[i].clone().addScaledVector(UP, ANKLE);
      const pole = hip.clone().add(new Vector3(leg.side * 0.25, -0.35, 1).applyQuaternion(this.pelvisQ));
      solveTwoBone(hip, ankle, THIGH, SHIN, pole, knee, this.end);
      aim(leg.thigh, hip, knee);
      aim(leg.shin, knee, this.end);
      leg.knee.position.copy(knee);
      this.shinTop[i].lerpVectors(knee, this.end, 0.3);
    });

    // arms: from the shoulders to the wrists, the forearm turned to meet the hand
    for (const arm of this.arms) {
      const shoulder = this.shoulderOf(arm);
      solveTwoBone(shoulder, arm.wrist, UPPER_ARM, FOREARM, this.poleOf(arm), arm.elbowAt, this.end);
      aim(arm.upper, shoulder, arm.elbowAt);
      aimRolled(arm.fore, arm.elbowAt, this.end, arm.across);
      arm.elbow.position.copy(arm.elbowAt);
    }
    this.posed = true;

    // cloth: the frames it hangs from, then each piece
    this.pAx.set(1, 0, 0).applyQuaternion(this.pelvisQ);
    this.pAy.set(0, 1, 0).applyQuaternion(this.pelvisQ);
    this.pAz.set(0, 0, 1).applyQuaternion(this.pelvisQ);
    this.cAx.set(1, 0, 0).applyQuaternion(this.chestQ);
    this.cAy.set(0, 1, 0).applyQuaternion(this.chestQ);
    this.cAz.set(0, 0, 1).applyQuaternion(this.chestQ);
    this.lungi.update(dt, time, this.lungiRing, wind, this.keepOffLegs);
    this.vest.update(dt, time, this.vestRing, wind);
    this.gamchha.update(dt, time, this.gamchhaPin, this.awayFromChest, this.keepOffChest, wind, gravity);

    // his weight, for the boat: his hips and his chest (which leans out over the blade with each pull)
    this.crew.x = (this.pelvis.x - this.restPelvis.x) * 0.6 + (this.chest.position.x - this.stance.x) * 0.4;
    this.crew.z = (this.pelvis.z - this.restPelvis.z) * 0.6 + (this.chest.position.z - this.stance.z) * 0.4;
  }
}
