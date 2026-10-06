import {
  BoxGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DoubleSide,
  Euler,
  Group,
  LatheGeometry,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  PointLight,
  Quaternion,
  SphereGeometry,
  TorusGeometry,
  Vector2,
  Vector3,
  Vector4,
} from 'three';
import type { BufferGeometry } from 'three';
import { MeshBuilder, rgb, scaleRgb, taperedTube } from '../render/builder';
import { patchMaterial } from '../render/patch';
import { checkTexture, hullPlankTexture, softSpotTexture, weaveTexture } from '../render/textures';
import { windAt } from '../env/wind';
import { Boatman, TARUN_OUTFIT, type OarPose } from './boatman';
import { REST_PHASE, type BoatBody } from './boatPhysics';
import { HERO_HULL, HERO_SINK, buildHull, hullHalfWidthAt, hullStation } from './hull';
import {
  BLADE_LENGTH,
  MEAN_THRUST,
  PADDLE_REACH,
  bodyDrive,
  makeBodyDrive,
  makePaddlePose,
  paddleForce,
  paddlePose,
  strokePhase,
  type PaddleForce,
} from './paddle';

// The hero boat: a Bengal dinghy, planked and cramped with iron, tarred below and weathered above, with
// her frames and floorboards inside, a chhoi of woven bamboo over her middle, cargo in the bow, a
// lantern hung from the chhoi, and the boatman paddling with a বৈঠা from a platform at the stern. The
// boat's motion comes from BoatBody (which the same stroke drives); this file builds her and poses
// everything aboard.

const LEN = HERO_HULL.len;
const zAt = (s: number) => (s - 0.5) * LEN;
const sAt = (z: number) => z / LEN + 0.5;
const UP = new Vector3(0, 1, 0);
const Z_AXIS = new Vector3(0, 0, 1);

/** The cross-grip at the top of the paddle: half its length and its radius; his right hand holds it this far out on his side of the shaft. */
const CROSS_HALF = 0.11;
const CROSS_RADIUS = 0.022;
const CROSS_HOLD = 0.068;
/** The shaft's radius at the grip and at the blade's throat; his left hand holds it this far down from the grip. */
const SHAFT_TOP = 0.028;
const SHAFT_THROAT = 0.032;
const LOWER_HOLD = 0.5;
const LOWER_HOLD_RADIUS = SHAFT_TOP + ((SHAFT_THROAT - SHAFT_TOP) * LOWER_HOLD) / (PADDLE_REACH - BLADE_LENGTH / 2);
/** Middle of the boatman's feet on the stern platform: toward the side he paddles on (+x). */
const STANCE = new Vector3(0.24, 0.33, -2.95);

/**
 * His mathal, when it is off: set down on the stern's deck just behind him and to his right, tipped with the
 * stern's rise (boat frame; its height found on the hull). Where his hand takes it (the rim nearest him, in the
 * hat's frame, set down and on his head), and the seconds that putting it on and taking it off take.
 */
const HAT_DOWN = { x: -0.1, z: -3.4, tip: -0.3, yaw: 0.35 };
const GRASP_DOWN = new Vector3(0.0, -0.01, 0.33);
const GRASP_HEAD = new Vector3(-0.14, -0.012, 0.3);
const HAT_ON_S = 3.8;
const HAT_OFF_S = 3.4;
/**
 * He answers the weather a little late, as anyone does (s), and does not change it again for a while (s): the
 * mathal goes on in a hard sun or the rain and comes off when it is mild, never on a whim.
 */
const HAT_REACT = 2.5;
const HAT_HOLD = 16;

/** Where along a run of keyed times (s) a moment lies: the key it is in and how far through it, eased. */
function keyed(t: number, keys: readonly number[]): { k: number; e: number } {
  let k = 0;
  while (k < keys.length - 2 && t > keys[k + 1]) k++;
  const f = Math.min(1, Math.max(0, (t - keys[k]) / (keys[k + 1] - keys[k])));
  return { k, e: f * f * (3 - 2 * f) };
}
/** Basis vectors for setting the paddle's turn. */
const basisX = new Vector3();
const basisY = new Vector3();
const basisZ = new Vector3();

// multipliers on the plank texture (which carries the wood's own colour): weathered, darker timber, tar
const WOOD: [number, number, number] = [0.92, 0.88, 0.82];
const WOOD_DARK: [number, number, number] = [0.6, 0.53, 0.45];
const TAR: [number, number, number] = [0.3, 0.25, 0.21];
const BLUE_STRAKE: [number, number, number] = [0.34, 0.52, 0.82];

/** A point on the hull's skin at station s, round the section by a (−1 port gunwale … 1 starboard), set in by `inset`. */
function skinPoint(s: number, a: number, inset: number, out: Vector3, normal: Vector3): Vector3 {
  const { keel, sheer, hb } = hullStation(HERO_HULL, s);
  const phi = Math.abs(a) * (Math.PI / 2);
  const side = a < 0 ? -1 : 1;
  normal.set(side * Math.sin(phi), -Math.cos(phi) + 0.2, 0).normalize();
  out.set(side * hb * Math.pow(Math.sin(phi), 0.8), keel + (sheer - keel) * (1 - Math.cos(phi)), zAt(s));
  return out.addScaledVector(normal, -Math.min(inset, hb * 0.4));
}

/** The planked hull inside and out, and the timber that holds her together. */
function hullGeometry(): BufferGeometry {
  const b = new MeshBuilder();
  buildHull(b, HERO_HULL, { tar: TAR, top: WOOD, band: BLUE_STRAKE, wet: true }, HERO_SINK);
  const p = new Vector3();
  const n = new Vector3();

  // the inside skin (her ceiling), darker toward the bilge where light hardly reaches
  const S = 40;
  const A = 18;
  const start = b.vertexCount;
  for (let i = 0; i <= S; i++) {
    const s = 0.035 + (0.93 * i) / S;
    for (let j = 0; j <= A; j++) {
      const a = (j / A) * 2 - 1;
      skinPoint(s, a, 0.028, p, n);
      b.vertex(p, n.clone().negate(), zAt(s) * 0.45, Math.abs(a) * 1.6, scaleRgb(WOOD, 0.42 + 0.48 * Math.abs(a)));
    }
  }
  for (let i = 0; i < S; i++) {
    for (let j = 0; j < A; j++) {
      const k = start + i * (A + 1) + j;
      b.quad(k, k + 1, k + A + 2, k + A + 1);
    }
  }
  // the gunwale cap: closes the gap between the skins along the top
  for (const side of [-1, 1]) {
    const cap = b.vertexCount;
    for (let i = 0; i <= S; i++) {
      const s = 0.035 + (0.93 * i) / S;
      const outer = skinPoint(s, side, 0, new Vector3(), n).addScaledVector(UP, 0.005);
      const inner = skinPoint(s, side, 0.04, new Vector3(), n).addScaledVector(UP, 0.005);
      b.vertex(outer, UP, zAt(s) * 0.45, 0, WOOD_DARK);
      b.vertex(inner, UP, zAt(s) * 0.45, 0.06, WOOD_DARK);
    }
    for (let i = 0; i < S; i++) b.quad(cap + i * 2, cap + i * 2 + 2, cap + i * 2 + 3, cap + i * 2 + 1);
  }

  // frames (ribs) every half metre or so, and the keelson along the bottom
  for (let s = 0.09; s < 0.92; s += 0.058) {
    const pts: Vector3[] = [];
    for (let j = 0; j <= 12; j++) pts.push(skinPoint(s, (j / 12) * 1.9 - 0.95, 0.045, new Vector3(), n));
    taperedTube(b, pts, pts.map(() => 0.022), 4, WOOD_DARK, 0.6);
  }
  const keelson: Vector3[] = [];
  for (let s = 0.07; s <= 0.93; s += 0.043) keelson.push(skinPoint(s, 0, 0.06, new Vector3(), n));
  taperedTube(b, keelson, keelson.map(() => 0.04), 5, WOOD_DARK, 0.6);

  // loose floorboards (patatan) down the middle, tapering with the hull, with gaps between them
  const boards = 5;
  for (let k = 0; k < boards; k++) {
    const tint = scaleRgb(WOOD, 0.82 + ((k * 37) % 9) * 0.03);
    const y = 0.1 + ((k * 13) % 3) * 0.004;
    const top = b.vertexCount;
    const steps = 14;
    for (let i = 0; i <= steps; i++) {
      const s = 0.27 + (0.59 * i) / steps;
      const w = hullHalfWidthAt(HERO_HULL, s, y) * 0.94;
      const x0 = -w + (2 * w * k) / boards + 0.012;
      const x1 = -w + (2 * w * (k + 1)) / boards - 0.012;
      b.vertex(new Vector3(x0, y, zAt(s)), UP, zAt(s) * 0.45, k * 0.25, tint);
      b.vertex(new Vector3(x1, y, zAt(s)), UP, zAt(s) * 0.45, k * 0.25 + 0.06, tint);
    }
    for (let i = 0; i < steps; i++) b.quad(top + i * 2, top + i * 2 + 2, top + i * 2 + 3, top + i * 2 + 1);
  }

  // the boatman's platform at the stern: boards laid across
  for (let z = zAt(0.075); z < zAt(0.27); z += 0.175) {
    const s = sAt(z + 0.075);
    const w = hullHalfWidthAt(HERO_HULL, s, 0.3) * 0.97;
    const m = new Matrix4().makeTranslation(0, 0.3, z + 0.075);
    b.add(new BoxGeometry(w * 2, 0.03, 0.155), m, scaleRgb(WOOD, 0.85 + ((Math.round(z * 10) * 7) % 5) * 0.04));
  }
  b.add(new BoxGeometry(hullHalfWidthAt(HERO_HULL, 0.27, 0.25) * 2, 0.08, 0.08), new Matrix4().makeTranslation(0, 0.25, zAt(0.27)), WOOD_DARK);

  // thwarts across at gunwale height, each braced by a pair of knees
  for (const s of [0.3, 0.71, 0.84]) {
    const { sheer } = hullStation(HERO_HULL, s);
    const y = sheer - 0.08;
    const w = hullHalfWidthAt(HERO_HULL, s, y) * 0.98;
    b.add(new BoxGeometry(w * 2, 0.045, 0.17), new Matrix4().makeTranslation(0, y, zAt(s)), WOOD);
    for (const side of [-1, 1]) {
      const m = new Matrix4().compose(
        new Vector3(side * (w - 0.07), y - 0.08, zAt(s)),
        new Quaternion().setFromAxisAngle(Z_AXIS, side * 0.75),
        new Vector3(1, 1, 1),
      );
      b.add(new BoxGeometry(0.05, 0.18, 0.06), m, WOOD_DARK);
    }
  }

  // stem and stern posts carried up past the sheer, the bow's capped in red
  for (const [s, dir] of [
    [0.997, 1],
    [0.003, -1],
  ] as const) {
    const { sheer } = hullStation(HERO_HULL, s);
    const tip = new Vector3(0, sheer - 0.1, zAt(s));
    const pts = [tip, tip.clone().add(new Vector3(0, 0.22, dir * 0.06)), tip.clone().add(new Vector3(0, 0.36, dir * 0.0))];
    taperedTube(b, pts, [0.06, 0.045, 0.03], 6, dir > 0 ? rgb('#8a2a1e') : WOOD_DARK, 0.4);
  }
  return b.build();
}

/** Eyes painted on the bow, as on many country boats. */
function bowEyes(): BufferGeometry {
  const b = new MeshBuilder();
  const p = new Vector3();
  const n = new Vector3();
  for (const side of [-1, 1]) {
    const c = skinPoint(0.915, side * 0.72, -0.004, p, n).clone();
    const nn = n.clone();
    const u = new Vector3(0, 0, 1);
    const v = new Vector3().crossVectors(nn, u).normalize();
    for (const [rx, ry, col, lift] of [
      [0.085, 0.05, rgb('#efe9dc'), 0],
      [0.032, 0.032, rgb('#111111'), 0.002],
    ] as const) {
      const centre = b.vertex(c.clone().addScaledVector(nn, lift), nn, 0.5, 0.5, col);
      const ring: number[] = [];
      for (let k = 0; k < 16; k++) {
        const t = (k / 16) * Math.PI * 2;
        ring.push(b.vertex(c.clone().addScaledVector(u, Math.cos(t) * rx).addScaledVector(v, Math.sin(t) * ry).addScaledVector(nn, lift), nn, 0, 0, col));
      }
      for (let k = 0; k < 16; k++) b.tri(centre, ring[k], ring[(k + 1) % 16]);
    }
  }
  return b.build();
}

/** The chhoi: a woven bamboo half-barrel over the middle of the boat. */
function canopyGeometry(z0: number, z1: number): BufferGeometry {
  const b = new MeshBuilder();
  const Z = 8;
  const A = 16;
  for (let i = 0; i <= Z; i++) {
    const z = z0 + ((z1 - z0) * i) / Z;
    const s = sAt(z);
    const { sheer } = hullStation(HERO_HULL, s);
    const R = hullHalfWidthAt(HERO_HULL, s, sheer - 0.02) * 0.98;
    for (let j = 0; j <= A; j++) {
      const th = (j / A) * Math.PI;
      const nrm = new Vector3(Math.cos(th), Math.sin(th), 0);
      b.vertex(new Vector3(R * Math.cos(th), sheer + R * 0.95 * Math.sin(th), z), nrm, (th * R) / 0.45, z / 0.45);
    }
  }
  for (let i = 0; i < Z; i++) {
    for (let j = 0; j < A; j++) {
      const a = i * (A + 1) + j;
      b.quad(a, a + 1, a + A + 2, a + A + 1);
    }
  }
  return b.build();
}

/** The chhoi's bamboo hoops and the battens lashed along them; a long bamboo pole laid along the thwarts. */
function bambooGeometry(z0: number, z1: number): BufferGeometry {
  const b = new MeshBuilder();
  const cane = rgb('#a88d55');
  const arch = (z: number, lift: number) => {
    const s = sAt(z);
    const { sheer } = hullStation(HERO_HULL, s);
    const R = hullHalfWidthAt(HERO_HULL, s, sheer - 0.02) * 0.98 + lift;
    return { sheer, R };
  };
  for (let i = 0; i <= 4; i++) {
    const z = z0 + ((z1 - z0) * i) / 4;
    const { sheer, R } = arch(z, 0.02);
    const pts: Vector3[] = [];
    for (let j = 0; j <= 12; j++) {
      const th = (j / 12) * Math.PI;
      pts.push(new Vector3(R * Math.cos(th), sheer + R * 0.95 * Math.sin(th), z));
    }
    taperedTube(b, pts, pts.map(() => 0.022), 5, cane, 0.5);
  }
  for (const th of [0.75, Math.PI / 2, Math.PI - 0.75]) {
    const pts: Vector3[] = [];
    for (let i = 0; i <= 6; i++) {
      const z = z0 - 0.05 + ((z1 - z0 + 0.1) * i) / 6;
      const { sheer, R } = arch(Math.min(Math.max(z, z0), z1), 0.035);
      pts.push(new Vector3(R * Math.cos(th), sheer + R * 0.95 * Math.sin(th), z));
    }
    taperedTube(b, pts, pts.map(() => 0.014), 4, cane, 0.5);
  }
  // the lagi: a long bamboo punting pole, resting on the thwarts along the port side, with its nodes
  const a = new Vector3(-0.42, hullStation(HERO_HULL, 0.3).sheer - 0.02, zAt(0.22));
  const c = new Vector3(-0.36, hullStation(HERO_HULL, 0.84).sheer - 0.02, zAt(0.86));
  taperedTube(b, [a, c], [0.034, 0.026], 6, rgb('#b8a066'), 1);
  const along = new Vector3().subVectors(c, a);
  const len = along.length();
  along.normalize();
  const q = new Quaternion().setFromUnitVectors(UP, along);
  for (let d = 0.2; d < len; d += 0.38) {
    const m = new Matrix4().compose(a.clone().addScaledVector(along, d), q, new Vector3(1, 1, 1));
    b.add(new CylinderGeometry(0.036, 0.036, 0.018, 6), m, rgb('#7d6838'));
  }
  return b.build();
}

/** A jute sack, its neck gathered and tied. */
function sackGeometry(): BufferGeometry {
  return new LatheGeometry(
    [
      [0.0, 0],
      [0.2, 0.02],
      [0.27, 0.12],
      [0.25, 0.26],
      [0.16, 0.36],
      [0.05, 0.41],
      [0.06, 0.47],
      [0.0, 0.48],
    ].map(([r, y]) => new Vector2(r, y)),
    12,
  );
}

export class HeroBoat {
  readonly group = new Group();
  readonly lantern: PointLight;
  /** Fired as the blade goes in at each stroke, with how hard he is pulling it (for the splash sound). */
  onStroke: ((power: number) => void) | null = null;
  /** The paddle's blade (world); `bladeWet` how much of it is in the water (0..1), `bladeDrive` how hard it pulls (1 = the mean). */
  readonly blade = new Vector3();
  bladeWet = 0;
  bladeDrive = 0;
  /** The blade's position in the boat's own frame (x across, z along), for the water's rings. */
  readonly bladeLocal = new Vector3();
  /** The eddy the blade left where it last came out: world x, z, seconds since, strength. */
  readonly swirl = new Vector4(0, 0, 99, 0);

  /** The lantern's glass, glowing as the light in it does (the film keeps a shot's glow while it dissolves away). */
  readonly glass: MeshStandardMaterial;
  private readonly paddle = new Group();
  readonly man: Boatman;
  private readonly lanternPivot = new Group();
  private readonly shadow: Mesh;
  private readonly stroke = makePaddlePose();
  private readonly drive = makeBodyDrive();
  private readonly force: PaddleForce = { thrust: 0, side: 0, x: 0, z: 0 };
  private readonly basis = new Matrix4();
  private wasWet = false;
  private lastPhase = 0;
  private swingX = 0;
  private swingZ = 0;
  private vSwingX = 0;
  private vSwingZ = 0;
  private lastRollRate = 0;
  private lastPitchRate = 0;
  private readonly hands: OarPose = {
    holds: [
      { at: new Vector3(), thumb: new Vector3() },
      { at: new Vector3(), thumb: new Vector3() },
    ],
  };
  private readonly wind = new Vector3();
  private readonly air = { x: 0, z: 0 };
  private readonly gravity = new Vector3();
  private readonly inverse = new Quaternion();
  // the mathal: on his head or set down; what he is doing with it; what the weather asks of it
  private hatOn = false;
  private hatWant = false;
  private wantFor = 0;
  private sinceHat = HAT_HOLD;
  private hatAct: { put: boolean; t: number } | null = null;
  private readonly lastPos = new Vector3(Number.NaN, 0, 0);
  private readonly downPos = new Vector3();
  private readonly downQ = new Quaternion();
  private readonly headPos = new Vector3();
  private readonly headQ = new Quaternion();
  private readonly carryQ = new Quaternion();
  private readonly hand0 = new Vector3();
  private readonly handA = new Vector3();
  private readonly handB = new Vector3();
  private readonly grasp = new Vector3();
  private readonly hv = new Vector3();

  constructor() {
    const g = this.group;
    g.name = 'hero-boat';
    const planks = hullPlankTexture(51);
    const wood = patchMaterial(
      new MeshStandardMaterial({
        map: planks.map,
        normalMap: planks.normal,
        vertexColors: true,
        roughness: 0.82,
        side: DoubleSide,
      }),
      { grime: 0.3 },
    );
    g.add(new Mesh(hullGeometry(), wood));
    const paint = patchMaterial(new MeshStandardMaterial({ vertexColors: true, roughness: 0.6 }), { grime: 0.2 });
    g.add(new Mesh(bowEyes(), paint));

    // a little bilge water under the floorboards
    const bilgeW = hullHalfWidthAt(HERO_HULL, 0.5, -0.18) * 1.9;
    const bilge = new Mesh(
      new PlaneGeometry(bilgeW, LEN * 0.5).rotateX(-Math.PI / 2),
      patchMaterial(new MeshStandardMaterial({ color: '#1d1a12', roughness: 0.08, metalness: 0.1 }), {}),
    );
    bilge.position.set(0, -0.17, 0.4);
    g.add(bilge);

    const cz0 = zAt(0.38);
    const cz1 = zAt(0.66);
    const weave = patchMaterial(new MeshStandardMaterial({ map: weaveTexture(52), roughness: 0.9, side: DoubleSide }), {
      translucency: 0.3,
    });
    g.add(new Mesh(canopyGeometry(cz0, cz1), weave));
    const bamboo = patchMaterial(new MeshStandardMaterial({ vertexColors: true, roughness: 0.55 }), { grime: 0.35 });
    g.add(new Mesh(bambooGeometry(cz0, cz1), bamboo));

    this.addCargo(cz0);
    // (through patchMaterial, as everything is: seen from across the water it takes the haze)
    this.glass = patchMaterial(new MeshStandardMaterial({ color: '#ffe2b0', emissive: new Color('#ffb257'), emissiveIntensity: 0, roughness: 0.15 }), {});
    this.lantern = this.addLantern(cz1, this.glass);

    // the boatman's shadow on his platform: the boat does not cast into the shadow map, so a soft spot
    this.shadow = new Mesh(
      new PlaneGeometry(0.9, 0.75).rotateX(-Math.PI / 2),
      new MeshBasicMaterial({ map: softSpotTexture(), transparent: true, depthWrite: false, color: '#000000', opacity: 0.85 }),
    );
    this.shadow.position.set(STANCE.x, 0.318, STANCE.z);
    g.add(this.shadow);

    this.buildPaddle(wood);
    // the young majhi the film follows
    this.man = new Boatman(STANCE, [CROSS_RADIUS, LOWER_HOLD_RADIUS], TARUN_OUTFIT, 'tarun');
    g.add(this.man.group);
    // where his mathal is set down: on the stern's rising deck behind him
    const s = sAt(HAT_DOWN.z);
    const { sheer } = hullStation(HERO_HULL, s);
    this.downPos.set(HAT_DOWN.x, sheer - 0.015, HAT_DOWN.z);
    this.downQ.setFromEuler(new Euler(HAT_DOWN.tip, HAT_DOWN.yaw, 0, 'YXZ'));
  }

  /** What the sky and the weather ask of his mathal now: on (a hard sun, rain) or off (main.ts, each frame). */
  wantHat(on: boolean): void {
    this.hatWant = on;
  }

  /** Puts the mathal where the weather wants it at once (a new scene, a jump), or, with `on`, there. */
  settleHat(on = this.hatWant): void {
    this.hatOn = on;
    this.hatAct = null;
    this.wantFor = 0;
    // from here he answers the weather when it changes, after a moment; and the boat put somewhere just now
    // (a scene opening) is no jump that would settle it again
    this.sinceHat = HAT_HOLD;
    this.lastPos.x = Number.NaN;
  }

  /**
   * His right hand and the mathal while he puts it on or takes it off (the stroke is at rest, the paddle held up
   * in his left hand): to where it lies, lifted over his head and settled on it with a touch at the brim, and back
   * to the paddle's grip; or the other way round. Sets the hand's hold and how his body turns and bends to it;
   * returns how far from where it lies to his head the mathal is carried (0..1), or −1 while it is not carried.
   */
  private hatHand(drive: { twist: number; bend: number; crouch: number }): number {
    const act = this.hatAct;
    const right = this.hands.holds[0];
    if (!act || act.t < 0) return -1;
    this.man.hatOnHead(this.headPos, this.headQ);
    const downRim = this.handA.copy(GRASP_DOWN).applyQuaternion(this.downQ).add(this.downPos);
    const headRim = this.handB.copy(GRASP_HEAD).applyQuaternion(this.headQ).add(this.headPos);
    const above = this.hv.copy(headRim).add(this.grasp.set(0, 0.2, 0.06));
    const g0 = this.hand0.copy(right.at);
    const at = right.at;
    let carry = -1;
    // how near the place behind him his hand is: he turns and bends to it
    let reachBack = 0;
    if (act.put) {
      const { k, e } = keyed(act.t, [0, 0.8, 1.0, 2.0, 2.4, 2.9, 3.6, HAT_ON_S]);
      if (k === 0) (at.lerpVectors(g0, downRim, e), (reachBack = e));
      else if (k === 1) (at.copy(downRim), (reachBack = 1));
      else if (k === 2) (at.lerpVectors(downRim, above, e), (carry = e), (reachBack = 1 - e));
      else if (k === 3) (at.lerpVectors(above, headRim, e), (carry = 1));
      else if (k === 4) at.copy(headRim).addScaledVector(this.grasp.set(0, 0, 1).applyQuaternion(this.headQ), 0.012 * Math.sin(e * Math.PI * 2));
      else if (k === 5) at.lerpVectors(headRim, g0, e);
      else at.copy(g0);
    } else {
      const { k, e } = keyed(act.t, [0, 0.7, 0.85, 1.5, 2.5, 2.7, 3.3, HAT_OFF_S]);
      if (k === 0) at.lerpVectors(g0, headRim, e);
      else if (k === 1) at.copy(headRim);
      else if (k === 2) (at.lerpVectors(headRim, above, e), (carry = 1));
      else if (k === 3) (at.lerpVectors(above, downRim, e), (carry = 1 - e), (reachBack = e));
      else if (k === 4) (at.copy(downRim), (reachBack = 1));
      else if (k === 5) (at.lerpVectors(downRim, g0, e), (reachBack = 1 - e));
      else at.copy(g0);
    }
    // the thumb along the brim where he holds it
    right.thumb.set(1, 0.25, 0).applyQuaternion(carry >= 0 ? this.carryQ.slerpQuaternions(this.downQ, this.headQ, carry) : this.headQ).normalize();
    drive.twist = drive.twist * (1 - reachBack) - 0.55 * reachBack;
    drive.bend += 0.22 * reachBack;
    drive.crouch += 0.07 * reachBack;
    return carry;
  }

  /** The mathal where it is this instant (after he is posed): on his head, in his hand, or set down. */
  private placeHat(carry: number): void {
    const hat = this.man.hat;
    if (!hat) return;
    const act = this.hatAct;
    // on his head while it is on and he is not taking it off yet; or putting it on, once it is there
    const onHead = carry < 0 && (act ? (act.put ? act.t > 2.4 : act.t < 0.85) : this.hatOn);
    if (onHead) {
      this.man.hatOnHead(hat.position, hat.quaternion);
      // settled with a touch: it rocks a hair as he lets go
      if (act?.put && act.t < 3.1) hat.quaternion.multiply(this.carryQ.setFromAxisAngle(this.grasp.set(1, 0, 0), 0.04 * Math.sin((act.t - 2.4) * 9) * Math.max(0, 1 - (act.t - 2.4) / 0.7)));
    } else if (carry >= 0) {
      this.carryQ.slerpQuaternions(this.downQ, this.headQ, carry);
      hat.quaternion.copy(this.carryQ);
      this.grasp.lerpVectors(GRASP_DOWN, GRASP_HEAD, carry).applyQuaternion(this.carryQ);
      hat.position.copy(this.hands.holds[0].at).sub(this.grasp);
    } else {
      hat.position.copy(this.downPos);
      hat.quaternion.copy(this.downQ);
    }
    // the air lifts less of his hair under it
    this.man.hairFree = onHead ? 0.25 : 1;
  }

  /** The weather has changed what he wants of his mathal: once it has held a moment he rests the paddle and sees to it. */
  private hatWeather(dt: number, body: BoatBody): void {
    // a jump (the boat put somewhere else): it is as the weather there wants it
    if (Number.isFinite(this.lastPos.x) && this.lastPos.distanceToSquared(body.pos) > 64) this.settleHat();
    this.lastPos.copy(body.pos);
    this.sinceHat += dt;
    const act = this.hatAct;
    if (!act) {
      this.wantFor = this.hatWant !== this.hatOn ? this.wantFor + dt : 0;
      if (this.wantFor > HAT_REACT && this.sinceHat > HAT_HOLD) this.hatAct = { put: this.hatWant, t: -1 };
    } else if (act.t < 0) {
      // the stroke he is in finished and the paddle held up first
      if (Math.abs(strokePhase(body.strokeTime) - REST_PHASE) < 0.012) act.t = 0;
    } else {
      act.t += dt;
      if (act.t >= (act.put ? HAT_ON_S : HAT_OFF_S)) {
        this.hatOn = act.put;
        this.hatAct = null;
        this.sinceHat = 0;
        this.wantFor = 0;
      }
    }
    body.rowing = this.hatAct === null;
  }

  /** Where the boatman's weight is (offset from rest, boat frame), for the boat's balance. */
  get crew(): { x: number; z: number } {
    return this.man.crew;
  }

  /** How far the boatman reached for the paddle this frame, over his arms' length (debug). */
  get reach(): number {
    return this.man.stretch;
  }

  private addCargo(cz0: number): void {
    const g = this.group;
    const jute = weaveTexture(54);
    jute.repeat.set(6, 3);
    const juteMat = patchMaterial(new MeshStandardMaterial({ map: jute, color: '#c9ad78', roughness: 0.97 }), { grime: 0.4 });
    const sack = sackGeometry();
    for (const [x, z, s, ry, tilt] of [
      [-0.27, 2.05, 1, 0.3, 0.12],
      [0.24, 2.3, 0.9, 1.2, -0.1],
      [0.0, 2.72, 0.82, 2.2, 0.25],
    ] as const) {
      const m = new Mesh(sack, juteMat);
      m.position.set(x, 0.1, z);
      m.rotation.set(tilt, ry, tilt * 0.5);
      m.scale.set(s, 0.85 * s, s * 0.9);
      g.add(m);
    }
    const clay = patchMaterial(new MeshStandardMaterial({ color: '#9a5a3a', roughness: 0.8 }), { grime: 0.35 });
    const pot = new Mesh(
      new LatheGeometry(
        [
          [0.01, 0],
          [0.14, 0.02],
          [0.22, 0.16],
          [0.17, 0.32],
          [0.09, 0.38],
          [0.11, 0.42],
        ].map(([r, y]) => new Vector2(r, y)),
        16,
      ),
      clay,
    );
    pot.position.set(0.3, 0.1, 1.75);
    g.add(pot);
    // his water: a kolshi by his feet, a bailer, a coil of rope in the bow
    const kolshi = new Mesh(
      new LatheGeometry(
        [
          [0.01, 0],
          [0.1, 0.01],
          [0.17, 0.1],
          [0.15, 0.2],
          [0.06, 0.27],
          [0.05, 0.31],
          [0.075, 0.33],
        ].map(([r, y]) => new Vector2(r, y)),
        16,
      ),
      clay,
    );
    kolshi.position.set(-0.36, 0.315, -2.5);
    g.add(kolshi);
    const bailer = new Mesh(new SphereGeometry(0.12, 12, 6, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2), clay);
    bailer.scale.set(1, 0.55, 1.3);
    bailer.position.set(0.18, 0.18, -1.6);
    bailer.rotation.set(0.2, 0.5, 0);
    g.add(bailer);
    const rope = patchMaterial(new MeshStandardMaterial({ color: '#a38c5e', roughness: 0.97 }), { grime: 0.4 });
    for (let i = 0; i < 4; i++) {
      const ring = new Mesh(new TorusGeometry(0.16 - i * 0.012, 0.018, 6, 20), rope);
      ring.rotation.x = Math.PI / 2;
      ring.position.set(0.12, 0.12 + i * 0.03, 3.25);
      g.add(ring);
    }
    // under the chhoi: a rolled mat and a bundle knotted in a gamchha
    const matRoll = new Mesh(new CylinderGeometry(0.09, 0.09, 1.0, 14), patchMaterial(new MeshStandardMaterial({ map: weaveTexture(55), color: '#d8c7a0', roughness: 0.9 }), {}));
    matRoll.rotation.z = Math.PI / 2;
    matRoll.position.set(0, 0.2, cz0 + 0.5);
    g.add(matRoll);
    const bundle = new Mesh(new SphereGeometry(0.17, 12, 10), patchMaterial(new MeshStandardMaterial({ map: checkTexture('#8a2f2a', '#e8dcc6', '#4a1612'), roughness: 0.9 }), {}));
    bundle.scale.set(1, 0.7, 0.9);
    bundle.position.set(0.25, 0.22, cz0 + 1.0);
    g.add(bundle);
  }

  /** A hurricane lantern hung on a wire from the chhoi's front hoop; it swings as the boat moves. */
  private addLantern(cz1: number, glassMat: MeshStandardMaterial): PointLight {
    const { sheer } = hullStation(HERO_HULL, sAt(cz1));
    const R = hullHalfWidthAt(HERO_HULL, sAt(cz1), sheer - 0.02) * 0.98;
    this.lanternPivot.position.set(0, sheer + R * 0.95 - 0.03, cz1 + 0.12);
    const metal = patchMaterial(new MeshStandardMaterial({ color: '#3a3630', roughness: 0.5, metalness: 0.6 }), {});
    const hang = 0.3;
    const wire = new Mesh(new CylinderGeometry(0.004, 0.004, hang - 0.18, 4), metal);
    wire.position.y = -(hang - 0.18) / 2;
    const base = new Mesh(new CylinderGeometry(0.07, 0.075, 0.05, 12), metal);
    base.position.y = -hang;
    const glass = new Mesh(new CylinderGeometry(0.055, 0.065, 0.13, 12), glassMat);
    glass.position.y = -hang + 0.09;
    const cap = new Mesh(new ConeGeometry(0.075, 0.07, 12), metal);
    cap.position.y = -hang + 0.19;
    const light = new PointLight('#ffb066', 0, 26, 2);
    light.position.y = -hang + 0.1;
    this.lanternPivot.add(wire, base, glass, cap, light);
    this.group.add(this.lanternPivot);
    return light;
  }

  /** The বৈঠা: a T-grip, a long round shaft and a leaf-shaped blade. Built with the grip at its origin and the shaft down −y. */
  private buildPaddle(wood: MeshStandardMaterial): void {
    const b = new MeshBuilder();
    const throat = PADDLE_REACH - BLADE_LENGTH / 2;
    // the cross-grip along x, darkened by his hand
    b.add(new CylinderGeometry(CROSS_RADIUS, CROSS_RADIUS, CROSS_HALF * 2, 8), new Matrix4().makeRotationZ(Math.PI / 2), rgb('#6e5c44'));
    b.add(new CylinderGeometry(SHAFT_TOP, SHAFT_THROAT, throat, 10), new Matrix4().makeTranslation(0, -throat / 2, 0), rgb('#9a8466'));
    // the blade: a long leaf, widest past its middle and rounded at the tip, its edges thinned, darker where it stays wet
    const top = b.vertexCount;
    const steps = 12;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const y = -throat - t * BLADE_LENGTH;
      const w = 0.112 * Math.pow(Math.sin(Math.PI * Math.min(1, 0.12 + t * 0.92)), 0.55) + 0.016;
      const th = 0.016 - 0.008 * t;
      const tint = rgb('#a89070', 1 - 0.3 * t);
      for (const [x, z] of [
        [-w, 0],
        [0, th],
        [w, 0],
        [0, -th],
      ] as const) {
        b.vertex(new Vector3(x, y, z), new Vector3(x === 0 ? 0 : Math.sign(x), 0, z === 0 ? 0 : Math.sign(z)), t, x > 0 ? 1 : 0, tint);
      }
    }
    for (let i = 0; i < steps; i++) {
      for (let k = 0; k < 4; k++) {
        const a = top + i * 4 + k;
        const c = top + i * 4 + ((k + 1) % 4);
        b.quad(a, c, c + 4, a + 4);
      }
    }
    // a rope lashing where the blade is bound to the shaft
    b.add(
      new TorusGeometry(SHAFT_THROAT + 0.004, 0.007, 4, 10),
      new Matrix4().makeTranslation(0, -throat + 0.04, 0).multiply(new Matrix4().makeRotationX(Math.PI / 2)),
      rgb('#8e7a52'),
    );
    this.paddle.add(new Mesh(b.build(), wood));
    this.group.add(this.paddle);
  }

  setShadows(cast: boolean): void {
    this.group.traverse((o) => {
      if ((o as Mesh).isMesh && o !== this.shadow) {
        const mesh = o as Mesh;
        mesh.castShadow = cast;
        mesh.receiveShadow = true;
      }
    });
  }

  /** Sets the boat where `body` has her, works the paddle, poses the boatman, swings the lantern. */
  update(dt: number, t: number, lamp: number, body: BoatBody): void {
    const phase = strokePhase(body.strokeTime);
    if (phase < this.lastPhase && this.onStroke) this.onStroke(body.power);
    this.lastPhase = phase;

    const g = this.group;
    // her waterline on the water: she sits HERO_SINK deeper than her shape's zero
    g.position.copy(body.pos);
    g.position.y -= HERO_SINK;
    g.rotation.set(body.rotX, body.heading, body.rotZ, 'YXZ');

    // the paddle: its grip at the mesh's origin, its shaft down the mesh's −y, the blade's width along x
    const P = paddlePose(phase, this.stroke, body.power);
    basisX.copy(P.across);
    basisY.copy(P.shaft).negate();
    basisZ.crossVectors(basisX, basisY);
    this.paddle.position.copy(P.grip);
    this.paddle.quaternion.setFromRotationMatrix(this.basis.makeBasis(basisX, basisY, basisZ));
    // his right hand on the cross-grip on his side of the shaft, thumb toward it; his left down the shaft, thumb up it
    const [right, left] = this.hands.holds;
    right.at.copy(P.grip).addScaledVector(P.across, -CROSS_HOLD);
    right.thumb.copy(P.across);
    left.at.copy(P.grip).addScaledVector(P.shaft, LOWER_HOLD);
    left.thumb.copy(P.shaft).negate();
    // the mathal: put on or taken off as the weather asks, his right hand off the paddle while he does it
    this.hatWeather(dt, body);
    const drive = bodyDrive(phase, this.drive, body.power);
    const carry = this.hatHand(drive);
    // the air past him (the wind where she is, gusts and all, less her own way through it); and which way
    // is down, in her frame
    windAt(body.pos.x, body.pos.z, this.air);
    this.inverse.copy(g.quaternion).invert();
    this.wind.set(this.air.x - body.vel.x, 0, this.air.z - body.vel.z).applyQuaternion(this.inverse);
    this.gravity.set(0, -9.81, 0).applyQuaternion(this.inverse);
    this.man.update(dt, t, drive, this.hands, body, this.wind, this.gravity);
    this.placeHat(carry);
    this.shadow.position.x = STANCE.x + this.man.crew.x * 0.8;
    this.shadow.position.z = STANCE.z + this.man.crew.z * 0.8;

    // the lantern: a pendulum on its wire, hanging true as the deck tilts and swung by the deck's jerks
    const w = Math.sqrt(9.81 / 0.3);
    const zeta = 0.06;
    if (dt > 0) {
      const accZ = (body.rollRate - this.lastRollRate) / dt;
      const accX = (body.pitchRate - this.lastPitchRate) / dt;
      this.vSwingZ += (w * w * (-body.rotZ - this.swingZ) - 2 * zeta * w * this.vSwingZ - 4 * accZ) * dt;
      this.vSwingX += (w * w * (-body.rotX - this.swingX) - 2 * zeta * w * this.vSwingX - 4 * accX) * dt;
      this.swingZ = Math.max(-0.6, Math.min(0.6, this.swingZ + this.vSwingZ * dt));
      this.swingX = Math.max(-0.6, Math.min(0.6, this.swingX + this.vSwingX * dt));
    }
    this.lastRollRate = body.rollRate;
    this.lastPitchRate = body.pitchRate;
    this.lanternPivot.rotation.set(this.swingX, 0, this.swingZ);

    // where the blade works, for the water's rings, the plants it shoves and the eddies it leaves
    this.bladeLocal.copy(P.blade);
    g.updateMatrixWorld();
    this.blade.copy(P.blade).applyMatrix4(g.matrixWorld);
    this.bladeWet = P.wet;
    this.bladeDrive = paddleForce(phase, this.force, body.power).thrust / MEAN_THRUST;
    const wet = P.wet > 0.3;
    if (this.wasWet && !wet) this.swirl.set(this.blade.x, this.blade.z, 0, 1);
    else this.swirl.z += dt;
    this.wasWet = wet;

    const flicker = 0.9 + 0.06 * Math.sin(t * 13.1) + 0.04 * Math.sin(t * 29.7 + 1.3);
    this.glass.emissiveIntensity = lamp * 3.2 * flicker;
    // intensity only: switching the light off would change the light count and recompile every material
    this.lantern.intensity = lamp * 5.5 * flicker;
  }
}

