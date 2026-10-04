import {
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
  SphereGeometry,
  TorusGeometry,
  Vector2,
  Vector3,
  Vector4,
} from 'three';
import { G } from '../core/globals';
import { windAt } from '../env/wind';
import { MeshBuilder, mixRgb, rgb, scaleRgb, type RGB } from '../render/builder';
import { patchMaterial } from '../render/patch';
import { clothTexture, printTexture, softSpotTexture } from '../render/textures';
import { ellipticLimb, handGeometry, limbGeometry, type HandShape } from './anatomy';
import { SKIN_TONE, aim, aimRolled, solveTwoBone } from './boatman';
import { ClothRibbon, ClothTube, type Ring } from './cloth';
import { BRIDGE, bridgeDeck, bridgeToWorld } from './geography';

// The girl on the old bridge: she stands at the crown by the parapet on the river's side in a
// salwar-kameez, an orna round her shoulders, a coloured umbrella over her, looking out over the water.
// Faceless and stylised, as the boatmen are, and built to the same proportions and the same parts (limbs,
// hands closed round what they hold, cloth). She is not still: she breathes, shifts her weight from foot to
// foot, lets her gaze wander over the river and the fields, and turns to watch the boat come toward her and
// pass beneath. The one wind (env/wind.ts) moves all of her that is loose: her kameez's hem, the long ends
// of her orna streaming behind her, her braid, and the umbrella, which the gusts push and she holds against
// them, tilting it into the wind when the rain drives. She keeps the rain off what is under it.
// She faces +z in her own frame (her right is −x), as the boatman does.

/** Where she stands, in the bridge's frame: by the parapet on the river's (−z) side, just off the crown. */
const STAND = { x: -1.1, z: -(BRIDGE.width / 2 - 0.34) };

const ANKLE = 0.07;
const SHIN = 0.38;
const THIGH = 0.4;
const PELVIS_HEIGHT = 0.83;
const HIP_HALF = 0.085;
/** From the hip joints up to the chest's base. */
const SPINE = 0.08;
const SHOULDER = new Vector3(0.158, 0.375, -0.012);
const NECK_BASE = new Vector3(0, 0.43, 0.005);
const UPPER_ARM = 0.265;
const FOREARM = 0.23;
const UP = new Vector3(0, 1, 0);

/** Her kameez from its neckline to the waist, on the chest: [t, height on the chest, half-width, half-depth]. */
const KAMEEZ_TOP: readonly (readonly [number, number, number, number])[] = [
  [0.0, 0.445, 0.052, 0.046],
  [0.04, 0.42, 0.13, 0.088],
  [0.08, 0.385, 0.182, 0.104],
  [0.18, 0.28, 0.163, 0.118],
  [0.3, 0.15, 0.138, 0.104],
  [0.42, 0.04, 0.133, 0.098],
];
/** From the waist to the hem at her knees, on the pelvis: [t, height above the hip joints, half-width, half-depth]. */
const KAMEEZ_LOW: readonly (readonly [number, number, number, number])[] = [
  [0.42, SPINE + 0.04, 0.133, 0.098],
  [0.55, 0.0, 0.178, 0.128],
  [0.7, -0.14, 0.192, 0.136],
  [0.85, -0.28, 0.208, 0.146],
  [1.0, -0.42, 0.232, 0.158],
];

/** The forearm, elbow to wrist: [height, half-width across the wrist, half-depth] (slighter than the boatman's). */
const FOREARM_RINGS: readonly (readonly [number, number, number])[] = [
  [0, 0.034, 0.032],
  [0.05, 0.037, 0.033],
  [0.11, 0.033, 0.028],
  [0.18, 0.028, 0.022],
  [FOREARM, 0.025, 0.018],
];

/** The orna, folded to a hand's width and a half: 23 particles 0.1 m apart; 7 to 15 lie round her neck and over her shoulders, the ends hang down her back. */
const ORNA_COUNT = 23;
const ORNA_PINS = [7, 8, 9, 10, 11, 12, 13, 14, 15];
/** Where those pins lie on her chest (chest frame): from behind her left shoulder, over it, across her front, over the right. */
const ORNA_AT: readonly (readonly [number, number, number])[] = [
  [0.11, 0.395, -0.085],
  [0.13, 0.43, 0.0],
  [0.11, 0.37, 0.1],
  [0.065, 0.29, 0.13],
  [0.0, 0.26, 0.135],
  [-0.065, 0.29, 0.13],
  [-0.11, 0.37, 0.1],
  [-0.13, 0.43, 0.0],
  [-0.11, 0.395, -0.085],
];

/** The umbrella: from her grip up the shaft to the canopy's crown (m), the canopy's radius and depth, and the handle below. */
const SHAFT = 0.66;
const CANOPY_R = 0.52;
const CANOPY_DEPTH = 0.21;
const RIBS = 8;
/** How it rests in her hand (her frame): tilted back over her head and a little inward. */
const REST = new Vector3(0.08, 1, -0.28).normalize();
/** Its tilt answers the wind as a damped spring (Hz, damping); how far she lets it go (rad). */
const TILT = { f: 1.15, zeta: 0.32, max: 0.55 };

/** Linear interpolation in the kameez tables, by t. */
function kameezRow(table: readonly (readonly [number, number, number, number])[], t: number): [number, number, number] {
  let i = 0;
  while (i < table.length - 2 && t > table[i + 1][0]) i++;
  const [t0, y0, a0, b0] = table[i];
  const [t1, y1, a1, b1] = table[i + 1];
  const f = Math.min(1, Math.max(0, (t - t0) / (t1 - t0)));
  return [y0 + (y1 - y0) * f, a0 + (a1 - a0) * f, b0 + (b1 - b0) * f];
}

function smooth(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/** A damped spring step toward `target`, for the eased angles of her gaze. */
function follow(x: number, v: number, target: number, w: number, dt: number): [number, number] {
  v += (w * w * (target - x) - 2 * w * v) * dt;
  return [x + v * dt, v];
}

/** The umbrella, built along +y from her grip: a crook below, the shaft, eight ribs under a canopy of eight panels. */
function umbrella(canopy: RGB): { canopy: MeshBuilder; frame: MeshBuilder } {
  const c = new MeshBuilder();
  const f = new MeshBuilder();
  const crown = SHAFT;
  const rim = crown - CANOPY_DEPTH;
  const darker = scaleRgb(canopy, 0.78);
  // panels: crown to rim, bellied out between the ribs and scalloped up at their edges
  for (let k = 0; k < RIBS; k++) {
    const a0 = (k / RIBS) * Math.PI * 2;
    const a1 = ((k + 1) / RIBS) * Math.PI * 2;
    const am = (a0 + a1) / 2;
    const col = k % 2 ? canopy : mixRgb(canopy, darker, 0.35);
    const at = (a: number, r: number, y: number) => new Vector3(Math.cos(a) * r, y, Math.sin(a) * r);
    const n = (a: number) => new Vector3(Math.cos(a) * 0.45, 1, Math.sin(a) * 0.45).normalize();
    const top = c.vertex(new Vector3(0, crown, 0), UP, 0.5, 1, col);
    const r0 = c.vertex(at(a0, CANOPY_R * 0.55, crown - CANOPY_DEPTH * 0.32), n(a0), 0, 0.5, col);
    const rm = c.vertex(at(am, CANOPY_R * 0.56, crown - CANOPY_DEPTH * 0.29), n(am), 0.5, 0.5, col);
    const r1 = c.vertex(at(a1, CANOPY_R * 0.55, crown - CANOPY_DEPTH * 0.32), n(a1), 1, 0.5, col);
    const e0 = c.vertex(at(a0, CANOPY_R, rim), n(a0), 0, 0, scaleRgb(col, 0.9));
    const em = c.vertex(at(am, CANOPY_R * 0.95, rim + 0.035), n(am), 0.5, 0, scaleRgb(col, 0.9));
    const e1 = c.vertex(at(a1, CANOPY_R, rim), n(a1), 1, 0, scaleRgb(col, 0.9));
    c.tri(top, rm, r0);
    c.tri(top, r1, rm);
    c.quad(r0, rm, em, e0);
    c.quad(rm, r1, e1, em);
    // the rib under it, a dark wire from the runner to its tip
    const tip = at(a0, CANOPY_R + 0.01, rim - 0.01);
    const mid = at(a0, CANOPY_R * 0.55, crown - CANOPY_DEPTH * 0.32 - 0.008);
    const runner = new Vector3(0, crown - 0.3, 0);
    for (const [p, q] of [
      [mid, tip],
      [runner, mid],
    ] as const) {
      const d = new Vector3().subVectors(q, p);
      const side = new Vector3().crossVectors(d, UP).normalize().multiplyScalar(0.004);
      const s = f.vertex(p.clone().sub(side), UP, 0, 0);
      f.vertex(p.clone().add(side), UP, 1, 0);
      f.vertex(q.clone().add(side), UP, 1, 1);
      f.vertex(q.clone().sub(side), UP, 0, 1);
      f.quad(s, s + 1, s + 2, s + 3);
      f.quad(s, s + 3, s + 2, s + 1);
    }
  }
  // the shaft, the ferrule above the crown, the runner, and the crook of cane below her hand
  f.add(new CylinderGeometry(0.007, 0.007, crown + 0.08, 6), new Matrix4().makeTranslation(0, (crown + 0.08) / 2 - 0.08, 0), rgb('#3a3a3c'));
  f.add(new CylinderGeometry(0.003, 0.006, 0.07, 6), new Matrix4().makeTranslation(0, crown + 0.035, 0), rgb('#2c2c2e'));
  f.add(new CylinderGeometry(0.013, 0.013, 0.05, 8), new Matrix4().makeTranslation(0, crown - 0.3, 0), rgb('#2c2c2e'));
  const cane = rgb('#8a5a32');
  f.add(new CylinderGeometry(0.0125, 0.0125, 0.14, 8), new Matrix4().makeTranslation(0, -0.07, 0), cane);
  const crook = new TorusGeometry(0.04, 0.0115, 6, 12, Math.PI);
  f.add(crook, new Matrix4().makeTranslation(0.04, -0.14, 0).multiply(new Matrix4().makeRotationZ(Math.PI)), cane);
  return { canopy: c, frame: f };
}

interface Arm {
  side: number;
  upper: Mesh;
  fore: Mesh;
  elbow: Mesh;
  hand: Mesh;
  shape: HandShape;
  shoulder: Vector3;
  wrist: Vector3;
  across: Vector3;
  elbowAt: Vector3;
  roll: Vector3;
}

export class Girl {
  readonly group = new Group();
  /** The canopy's middle and radius (world), so the rain can leave dry what is under it. */
  readonly shelter = new Vector4(0, -99, 0, 0);

  private readonly feet: Vector3[] = [];
  private readonly legs: { thigh: Mesh; shin: Mesh; knee: Mesh; side: number }[] = [];
  private readonly arms: Arm[] = [];
  private readonly chest = new Group();
  private readonly head = new Group();
  private readonly neck: Mesh;
  private readonly kameez: ClothTube;
  private readonly orna: ClothRibbon;
  private readonly braid: ClothRibbon;
  private readonly brolly = new Group();
  private readonly footShadow: Mesh;
  private readonly brollyShadow: Mesh;
  private readonly yaw = BRIDGE.angle + Math.PI;
  private readonly inverse = new Quaternion();
  // her body's frames this instant
  private readonly pelvis = new Vector3();
  private readonly pelvisQ = new Quaternion();
  private readonly chestQ = new Quaternion();
  private readonly chestInv = new Quaternion();
  private readonly headQ = new Quaternion();
  private readonly hips = [new Vector3(), new Vector3()];
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
  private readonly basis = new Matrix4();
  private readonly by = new Vector3();
  private readonly bz = new Vector3();

  constructor() {
    this.group.name = 'girl';
    const skin = patchMaterial(new MeshStandardMaterial({ color: SKIN_TONE, roughness: 0.55 }), { translucency: 0.35 });
    const handSkin = patchMaterial(new MeshStandardMaterial({ color: SKIN_TONE, roughness: 0.55, vertexColors: true }), { translucency: 0.35 });
    const fabric = (map: ReturnType<typeof printTexture>, roughness: number, translucency: number) =>
      patchMaterial(new MeshStandardMaterial({ map, vertexColors: true, roughness, side: DoubleSide }), { translucency });
    // a powder-blue kameez with a small white sprig, white salwar, a rose-pink orna bordered in gold
    const kameezMat = fabric(printTexture('#8fb8cf', '#f4f1e8', '#5f8a6a', 41), 0.9, 0.35);
    const salwarWeave = clothTexture('#ece6da', '#e4ddcd', '#dcd4c2', 42, true);
    const salwarMat = patchMaterial(new MeshStandardMaterial({ map: salwarWeave.map, roughness: 0.92, side: DoubleSide, vertexColors: true }), { translucency: 0.3 });
    const ornaMat = patchMaterial(
      new MeshStandardMaterial({ map: printTexture('#d65a7a', '#f2b8c6', '#c2486a', 44), vertexColors: true, roughness: 0.85, side: DoubleSide }),
      { translucency: 1.2 },
    );
    const hairMat = patchMaterial(new MeshStandardMaterial({ color: '#130e0b', roughness: 0.6 }), {});
    // the braid is a ribbon, whose vertex colours carry its shading
    const braidMat = patchMaterial(new MeshStandardMaterial({ color: '#130e0b', roughness: 0.6, vertexColors: true, side: DoubleSide }), {});
    const sandal = new MeshStandardMaterial({ color: '#4a2e1c', roughness: 0.7 });
    const g = this.group;

    // feet in sandals, one a little ahead and turned out
    for (const [dx, dz, turn] of [
      [-0.1, 0.03, -0.18],
      [0.09, -0.04, 0.25],
    ] as const) {
      const holder = new Group();
      const foot = new Mesh(new CapsuleGeometry(0.036, 0.15, 4, 10), skin);
      foot.rotation.set(Math.PI / 2, 0, 0);
      foot.geometry.scale(1.05, 1, 0.55);
      foot.position.set(0, 0.024, 0.045);
      const sole = new Mesh(new CapsuleGeometry(0.042, 0.16, 2, 10), sandal);
      sole.rotation.set(Math.PI / 2, 0, 0);
      sole.geometry.scale(1.1, 1, 0.12);
      sole.position.set(0, 0.006, 0.045);
      holder.add(foot, sole);
      holder.position.set(dx, 0, dz);
      holder.rotation.y = turn;
      g.add(holder);
      this.feet.push(holder.position.clone());
    }
    // legs in the loose salwar, gathered at the ankle
    for (const side of [-1, 1]) {
      const thigh = new Mesh(limbGeometry(THIGH, [0.088, 0.094, 0.09, 0.084, 0.078]), salwarMat);
      const shin = new Mesh(limbGeometry(SHIN, [0.078, 0.08, 0.074, 0.062, 0.042]), salwarMat);
      const knee = new Mesh(new SphereGeometry(0.08, 10, 8), salwarMat);
      g.add(thigh, shin, knee);
      this.legs.push({ thigh, shin, knee, side });
    }
    g.add(this.chest);
    this.neck = new Mesh(limbGeometry(0.11, [0.045, 0.042, 0.041]), skin);
    g.add(this.neck);

    // head: no face; black hair drawn back smoothly to the braid
    const skull = new Mesh(new SphereGeometry(0.092, 18, 14), skin);
    skull.scale.set(0.86, 1.1, 0.98);
    const hair = new Mesh(new SphereGeometry(0.097, 18, 12, 0, Math.PI * 2, 0, Math.PI * 0.6), hairMat);
    // her hair comes forward to a hairline over the brow, parted in the middle
    hair.position.set(0, 0.01, -0.008);
    hair.rotation.x = -0.22;
    hair.scale.set(0.9, 1.07, 1.03);
    const knot = new Mesh(new SphereGeometry(0.03, 10, 8), hairMat);
    knot.position.set(0, -0.045, -0.085);
    this.head.add(skull, hair, knot);
    for (const side of [-1, 1]) {
      const ear = new Mesh(new SphereGeometry(0.022, 8, 6), skin);
      ear.scale.set(0.38, 1, 0.68);
      ear.position.set(side * 0.079, -0.008, -0.006);
      this.head.add(ear);
    }
    g.add(this.head);

    // arms: elbow-length sleeves of the kameez, bare forearms, hands closed on the umbrella's shaft and loosely at her side
    const sleeve = kameezMat;
    [-1, 1].forEach((side) => {
      const shape = handGeometry(side < 0 ? 0.0125 : 0.009, side > 0);
      shape.geometry.scale(0.88, 0.88, 0.88);
      shape.wrist.multiplyScalar(0.88);
      const upper = new Mesh(limbGeometry(UPPER_ARM, [0.05, 0.05, 0.047, 0.046, 0.048], 0.05), sleeve);
      const fore = new Mesh(ellipticLimb(FOREARM_RINGS), skin);
      const elbow = new Mesh(new SphereGeometry(0.03, 10, 8), skin);
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
        elbowAt: new Vector3(side * 0.25, 1.0, 0.05),
        roll: new Vector3(0, -1, 0),
      });
    });

    // the kameez: held to her from the neckline to the hips, swinging free below them to its hem at the knees
    this.kameez = new ClothTube(kameezMat, {
      segments: 26,
      rings: 22,
      fold: (t, th) => ({ r: (0.004 * Math.sin(th * 8 + 0.5) + 0.01 * (0.5 + 0.5 * Math.sin(th * 5 + 1))) * smooth(0.5, 1, t), y: 0 }),
      freedom: (t) => 0.85 * smooth(0.5, 1, t),
      shade: (t) => 0.95 + 0.05 * smooth(0.9, 1, t),
      uRepeat: 7,
      vRepeat: 4,
    });
    g.add(this.kameez.mesh);
    this.orna = new ClothRibbon(ornaMat, ORNA_COUNT, 0.1, 0.3, ORNA_PINS, 2, 8);
    g.add(this.orna.mesh);
    this.braid = new ClothRibbon(braidMat, 9, 0.055, 0.036, [0, 1], 1, 1);
    g.add(this.braid.mesh);

    // the umbrella, and the soft shadows she and it lay on the deck (moving things stay out of the shadow map)
    const parts = umbrella(rgb('#c33a33'));
    const canopyMat = patchMaterial(new MeshStandardMaterial({ vertexColors: true, roughness: 0.62, side: DoubleSide }), { translucency: 1.1 });
    const frameMat = patchMaterial(new MeshStandardMaterial({ vertexColors: true, roughness: 0.5, metalness: 0.3, side: DoubleSide }), {});
    this.brolly.add(new Mesh(parts.canopy.build(), canopyMat), new Mesh(parts.frame.build(), frameMat));
    g.add(this.brolly);
    const spot = softSpotTexture();
    this.footShadow = new Mesh(
      new PlaneGeometry(0.62, 0.5).rotateX(-Math.PI / 2),
      new MeshBasicMaterial({ map: spot, transparent: true, depthWrite: false, color: '#000000', opacity: 0.6 }),
    );
    this.footShadow.position.y = 0.012;
    this.brollyShadow = new Mesh(
      new PlaneGeometry(1.2, 1.2).rotateX(-Math.PI / 2),
      new MeshBasicMaterial({ map: spot, transparent: true, depthWrite: false, color: '#000000', opacity: 0.4 }),
    );
    g.add(this.footShadow, this.brollyShadow);
    this.group.traverse((o) => {
      if ((o as Mesh).isMesh) {
        o.castShadow = false;
        o.receiveShadow = o !== this.footShadow && o !== this.brollyShadow;
      }
    });

    const at = bridgeToWorld(STAND.x, STAND.z);
    g.position.set(at.x, BRIDGE.water + bridgeDeck(STAND.x), at.z);
    g.rotation.y = this.yaw;
    g.updateMatrixWorld();
    this.inverse.copy(g.quaternion).invert();
  }

  /** Where she would look now: over the river and the fields, or at the boat while it comes near and passes under her. */
  private gaze(t: number, boat: Vector3, out: { yaw: number; pitch: number }): void {
    out.yaw = 0.42 * Math.sin(t * 0.11) + 0.22 * Math.sin(t * 0.047 + 2.0);
    out.pitch = -0.08 + 0.06 * Math.sin(t * 0.09 + 0.7);
    // the boat, in her frame, from her eyes
    const eyes = this.v.copy(this.head.position).applyQuaternion(this.group.quaternion).add(this.group.position);
    const d = this.v2.subVectors(boat, eyes).applyQuaternion(this.inverse);
    const dist = d.length();
    if (dist > 45) return;
    // while it comes, and as it goes under her; once it is behind her she lets it go
    const near = smooth(45, 22, dist) * smooth(-4, -0.5, d.z);
    const yaw = Math.max(-1.1, Math.min(1.1, Math.atan2(d.x, Math.max(d.z, 0.4))));
    const pitch = Math.max(-0.8, Math.min(0.15, Math.atan2(d.y, Math.hypot(d.x, d.z))));
    out.yaw += (yaw - out.yaw) * near;
    out.pitch += (pitch - out.pitch) * near;
  }

  /** Closes a hand on what it holds: the bar through the palm, turned about it until the wrist faces the forearm. */
  private placeHand(arm: Arm, at: Vector3, thumb: Vector3): void {
    const { shape } = arm;
    const a = this.v3.copy(thumb).multiplyScalar(arm.side < 0 ? 1 : -1).normalize();
    const f = this.v2.set(0, shape.fore.y, shape.fore.z).normalize();
    arm.roll.addScaledVector(a, -arm.roll.dot(a));
    if (arm.roll.lengthSq() < 1e-6) arm.roll.set(0, -1, 0).addScaledVector(a, -a.y);
    arm.roll.normalize();
    for (let pass = 0; pass < 2; pass++) {
      const d = this.v.subVectors(pass === 0 ? at : arm.wrist, arm.elbowAt);
      d.addScaledVector(a, -d.dot(a));
      if (d.lengthSq() > 1e-6) arm.roll.copy(d.normalize());
      const ad = this.end.crossVectors(a, arm.roll);
      this.by.copy(arm.roll).multiplyScalar(f.y).addScaledVector(ad, -f.z);
      this.bz.copy(arm.roll).multiplyScalar(f.z).addScaledVector(ad, f.y);
      arm.hand.quaternion.setFromRotationMatrix(this.basis.makeBasis(a, this.by, this.bz));
      arm.wrist.copy(shape.wrist).applyQuaternion(arm.hand.quaternion).add(at);
    }
    arm.hand.position.copy(at);
    arm.across.copy(shape.across).applyQuaternion(arm.hand.quaternion);
  }

  private readonly kameezRing = (t: number, out: Ring): Ring => {
    const top = t < 0.42;
    const [y, a, b] = kameezRow(top ? KAMEEZ_TOP : KAMEEZ_LOW, t);
    const q = top ? this.chestQ : this.pelvisQ;
    out.c.set(0, y, 0).applyQuaternion(q).add(top ? this.chest.position : this.pelvis);
    out.ax.set(1, 0, 0).applyQuaternion(q);
    out.az.set(0, 0, 1).applyQuaternion(q);
    out.a = a;
    out.b = b;
    return out;
  };

  /** Keeps the swinging hem off her legs (inside the salwar's width) when the wind blows it back against them. */
  private readonly keepOffBody = (p: Vector3): void => {
    for (let i = 0; i < 2; i++) {
      this.pushOff(p, this.hips[i], this.knees[i], 0.105);
      this.pushOff(p, this.knees[i], this.ankles[i], 0.09);
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
    const [x, y, z] = ORNA_AT[i - ORNA_PINS[0]];
    p.set(x, y, z).applyQuaternion(this.chestQ).add(this.chest.position);
    n.set(x, 0.25, z).normalize().applyQuaternion(this.chestQ);
  };

  private readonly awayFromBody = (p: Vector3, out: Vector3): void => {
    out.subVectors(p, this.chest.position);
    const up = this.v3.set(0, 1, 0).applyQuaternion(this.chestQ);
    out.addScaledVector(up, -out.dot(up));
    if (out.lengthSq() < 1e-8) out.set(0, 0, -1);
    out.normalize();
  };

  /** Keeps the orna's hanging ends out of her back and shoulders. */
  private readonly keepOffBack = (p: Vector3): void => {
    const v = this.v3.subVectors(p, this.chest.position).applyQuaternion(this.chestInv);
    if (v.y > 0.47 || v.y < -0.45) return;
    const [, a, b] = v.y > 0.04 ? kameezRow(KAMEEZ_TOP, 0.42 - ((v.y - 0.04) / 0.405) * 0.42) : kameezRow(KAMEEZ_LOW, 0.42 + Math.min(1, -v.y / 0.45) * 0.3);
    const rx = a + 0.02;
    const rz = b + 0.02;
    const e = Math.hypot(v.x / rx, v.z / rz);
    if (e >= 1 || e < 1e-4) return;
    v.x /= e;
    v.z /= e;
    p.copy(v.applyQuaternion(this.chestQ)).add(this.chest.position);
  };

  private readonly braidPin = (i: number, p: Vector3, n: Vector3): void => {
    p.set(0, -0.05 - i * 0.04, -0.085 - i * 0.012).applyQuaternion(this.headQ).add(this.head.position);
    n.set(0, 0, -1).applyQuaternion(this.headQ);
  };

  private readonly keepOffHead = (p: Vector3): void => {
    this.keepOffBack(p);
    const d = this.v.subVectors(p, this.head.position);
    const l = d.length();
    if (l < 0.105 && l > 1e-5) p.addScaledVector(d, (0.105 - l) / l);
  };

  /**
   * Poses her for this instant. `t`: seconds; `boat`: where the hero boat is (world), which she watches as
   * it comes; `rain`: how hard it rains (0..1), which has her tilt her umbrella into the wind.
   */
  update(dt: number, t: number, boat: Vector3, rain: number): void {
    const g = this.group;
    // the air past her, in her own frame (she stands high and open to it on the bridge)
    windAt(g.position.x, g.position.z, this.air);
    this.wind.set(this.air.x, 0, this.air.z).applyQuaternion(this.inverse).multiplyScalar(1.1);
    const speed = this.wind.length();

    // her weight goes slowly from one foot to the other; she breathes
    const shift = Math.sin(t * 0.57 + 1.0);
    const breath = Math.sin(t * 1.46);
    // and leans a little into a strong wind (x: forward bend, z: toward −x)
    const leanZ = Math.max(-0.06, Math.min(0.06, -this.wind.z * 0.004));
    const leanX = Math.max(-0.06, Math.min(0.06, this.wind.x * 0.004));
    this.pelvis.set(0.024 * shift, PELVIS_HEIGHT - 0.008 * Math.abs(shift), 0.0);
    this.pelvisQ.setFromEuler(this.e.set(0.03 + leanZ * 0.5, 0.06 * shift, -0.045 * shift + leanX * 0.5, 'YXZ'));

    // where she looks: the chest turns with a share of it, the head the rest
    const look = { yaw: 0, pitch: 0 };
    this.gaze(t, boat, look);
    const step = Math.min(dt, 1 / 20);
    [this.lookYaw, this.vYaw] = follow(this.lookYaw, this.vYaw, look.yaw, 1.8, step);
    [this.lookPitch, this.vPitch] = follow(this.lookPitch, this.vPitch, look.pitch, 1.8, step);
    // looking down, she bends a little at the chest too
    this.q.setFromEuler(this.e.set(-0.02 + 0.012 * breath + leanZ - 0.25 * Math.min(0, this.lookPitch), 0.32 * this.lookYaw, leanX + 0.04 * shift, 'YXZ'));
    this.chestQ.copy(this.pelvisQ).multiply(this.q);
    this.chestInv.copy(this.chestQ).invert();
    this.chest.position.copy(this.pelvis).add(this.v.set(0, SPINE + 0.004 * breath, 0).applyQuaternion(this.pelvisQ));
    this.chest.quaternion.copy(this.chestQ);

    // head, on the neck, turned the rest of the way
    const neckBase = this.v.copy(NECK_BASE).applyQuaternion(this.chestQ).add(this.chest.position).clone();
    this.headQ.setFromEuler(this.e.set(0.04 - 0.8 * this.lookPitch, this.lookYaw, 0.02 * shift, 'YXZ'));
    const headCentre = neckBase.clone().add(this.v.set(0, 0.125, 0.008).applyQuaternion(this.headQ));
    this.head.position.copy(headCentre);
    this.head.quaternion.copy(this.headQ);
    aim(this.neck, neckBase, headCentre.clone().addScaledVector(UP, -0.06));

    // legs to the planted feet, the knee of the foot she rests easing forward
    this.legs.forEach((leg, i) => {
      const hip = this.hips[i].set(leg.side * HIP_HALF, -0.03, 0).applyQuaternion(this.pelvisQ).add(this.pelvis);
      const ankle = this.ankles[i].copy(this.feet[i]).addScaledVector(UP, ANKLE);
      const pole = this.pole.copy(hip).add(this.v.set(leg.side * 0.1, -0.3, 1).applyQuaternion(this.pelvisQ));
      solveTwoBone(hip, ankle, THIGH, SHIN, pole, this.knees[i], this.end);
      aim(leg.thigh, hip, this.knees[i]);
      aim(leg.shin, this.knees[i], this.end);
      leg.knee.position.copy(this.knees[i]);
    });

    // the umbrella: the gusts push its canopy downwind and she holds it against them; when the rain drives
    // she tilts it into the wind
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
    this.shaftDir.copy(REST).add(this.v.set(this.tilt.x, 0, this.tilt.y)).normalize();
    // her right hand holds it at her chest, in front of her right shoulder, giving a little to the tilt
    this.grip.set(-0.15, 0.3, 0.2).applyQuaternion(this.chestQ).add(this.chest.position).addScaledVector(this.v.set(this.tilt.x, 0, this.tilt.y), -0.06);
    this.brolly.position.copy(this.grip);
    this.brolly.quaternion.setFromUnitVectors(UP, this.shaftDir);

    // hands first, then the arms reach them
    const [right, left] = this.arms;
    if (!this.posed) for (const arm of this.arms) arm.elbowAt.copy(this.shoulderOf(arm)).add(this.v.set(arm.side * 0.06, -0.25, 0));
    this.placeHand(right, this.grip, this.shaftDir);
    // her left hangs easy by her side, swinging a touch with her weight
    const restLeft = this.v2.set(0.19 + 0.01 * shift, -0.1, 0.04).applyQuaternion(this.pelvisQ).add(this.pelvis).clone();
    this.placeHand(left, restLeft, this.v3.set(0.1, -0.2, 1).normalize().clone());
    for (const arm of this.arms) {
      const shoulder = this.shoulderOf(arm);
      const pole = this.pole.set(arm.side * 0.4, -0.5, -0.35).applyQuaternion(this.chestQ).add(shoulder);
      solveTwoBone(shoulder, arm.wrist, UPPER_ARM, FOREARM, pole, arm.elbowAt, this.end);
      aim(arm.upper, shoulder, arm.elbowAt);
      aimRolled(arm.fore, arm.elbowAt, this.end, arm.across);
      arm.elbow.position.copy(arm.elbowAt);
    }
    this.posed = true;

    // her clothes and her braid
    this.kameez.update(dt, t, this.kameezRing, this.wind, this.keepOffBody);
    this.orna.update(dt, t, this.ornaPin, this.awayFromBody, this.keepOffBack, this.wind, this.gravity);
    this.braid.update(dt, t, this.braidPin, this.awayFromBody, this.keepOffHead, this.wind, this.gravity);

    // the soft shadows on the deck: under her feet, and the umbrella's where the key light throws it
    this.footShadow.position.x = this.pelvis.x * 0.6;
    const canopy = this.v.copy(this.shaftDir).multiplyScalar(SHAFT - CANOPY_DEPTH * 0.5).add(this.grip);
    const key = this.v2.copy(G.uKeyDir.value).applyQuaternion(this.inverse);
    const k = key.y > 0.12 ? (canopy.y - 0.012) / key.y : 0;
    const sx = Math.max(-1.4, Math.min(1.4, canopy.x - key.x * k));
    const sz = Math.max(-0.3, Math.min(1.6, canopy.z - key.z * k));
    this.brollyShadow.position.set(sx, 0.014, Math.min(sz, 0.3));
    const strength = smooth(0.12, 0.4, key.y) * (1 - G.uOvercast.value * 0.8) * (sz < 0.3 ? 1 : 0);
    (this.brollyShadow.material as MeshBasicMaterial).opacity = 0.42 * strength;
    this.brollyShadow.visible = strength > 0.01;

    // what the umbrella keeps dry, for the rain
    canopy.applyQuaternion(g.quaternion).add(g.position);
    this.shelter.set(canopy.x, canopy.y, canopy.z, CANOPY_R * 1.05);
  }

  private shoulderOf(arm: Arm): Vector3 {
    return arm.shoulder.set(arm.side * SHOULDER.x, SHOULDER.y, SHOULDER.z).applyQuaternion(this.chestQ).add(this.chest.position);
  }
}
