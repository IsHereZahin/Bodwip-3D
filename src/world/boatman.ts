import { BufferAttribute, BufferGeometry, DoubleSide, Euler, Group, LatheGeometry, Matrix4, Mesh, MeshStandardMaterial, Quaternion, SphereGeometry, TorusGeometry, Vector2, Vector3 } from 'three';
import { angleDelta, smoothstep, tableAt } from '../core/mathx';
import { MeshBuilder } from '../render/builder';
import { patchMaterial } from '../render/patch';
import { clothTexture, weaveTexture } from '../render/textures';
import type { Crew } from './boatPhysics';
import { ClothRibbon, ClothTube, type Ring } from './cloth';
import { Human, enclosing, radiusAt, type Grip } from './human';
import { HUMANS, type HumanName } from './humanData';
import type { BodyDrive } from './paddle';

// A boatman paddling with a বৈঠা at the stern, standing and facing the bow: the film's young majhi (`tarun`), his
// hair loose and lifting in the wind, a red cotton ফিতা tied round his head with its ends loose behind, and his
// palm-leaf mathal, which he puts on and takes off as the sun and the rain ask (hero.ts); or an older man always
// under his (the same body works the salt and the harvest). His body is a person as games make one (human.ts: MakeHuman's body on a skeleton,
// a photographed skin, eyes, hair). Each frame his feet stay planted on the boards while the rest of him
// balances: he keeps upright as the deck rolls under him (a beat late, as people do) and works the stroke with
// his whole body (wound up and reaching at the catch, unwinding, sinking at the knees and leaning out over the
// blade through the pull), his shoulders coming forward and up as he reaches, bending further in when the
// paddle runs out of his arms' reach. His head keeps looking down the river; he blinks. His hands are closed
// round the paddle, his right on the cross-grip at its top (turning with it as he feathers the blade), his
// left down the shaft; his arms reach them from his shoulders. His sando is fitted to him; his lungi and
// gamchha are cloth: they follow him a beat late, swing and settle, and stir in the wind. Where his weight is
// goes back to the boat, which heels and trims under it. He faces +z, so his right side is −x; he paddles on
// his left (+x).

const UP = new Vector3(0, 1, 0);
/** Balance: how fast he rights himself as the deck tilts, and how far (he leaves a little to the deck). */
const BALANCE = { f: 1.3, zeta: 0.55, share: 0.85 };
/**
 * Bracing: on a lively deck he sinks lower at the knees and bends a little more, to keep his weight over his
 * feet: how much per rad/s of the deck's rocking, the most he sinks (m), and how quickly he settles into it (s).
 */
const BRACE = { perRate: 0.3, max: 0.09, tau: 1.2 };
/** His knees soft at rest: the hips this much lower than standing straight (m). */
const SOFT_KNEES = 0.035;
/** How far he bends in when a hold runs out of his arms' reach (m): his hips take part of it, his chest the rest. */
const LEAN_MAX = 0.16;
/** His shoulders: how far they rise as a hand reaches up, and come forward as it reaches out (rad), and how quickly. */
const SHRUG = { lift: 0.4, forward: 0.22, tau: 0.12 };
/** His feet on the boards from the middle of his stance: [across, along, turned out]; his right foot forward. */
const FEET = [
  [-0.15, 0.15, -0.2],
  [0.09, -0.17, 0.4],
] as const;
/** The lungi from its top to the hips, on the pelvis: [t, height from spine05's head, ease over the skin]. */
const LUNGI_TOP: readonly (readonly [number, number, number])[] = [
  [0.0, 0.065, 0.012],
  [0.1, 0.04, 0.013],
  [0.2, -0.025, 0.015],
];
const LUNGI_HIPS = 0.2;
/** The gamchha over his right shoulder: where it lies (round the shoulder, front over the top to the back) and which particles that holds. */
const GAMCHHA_X = -0.112;
const GAMCHHA_PSI = [0.4, 0.95, Math.PI / 2, 2.19, 2.74];
const GAMCHHA_PINS = [6, 7, 8, 9, 10];
const GAMCHHA_COUNT = 17;
/** How far the sando stands off his skin (as built in scripts/humans/build.mjs), and the gamchha off it. */
const VEST_OFF = 0.012;

/** The lungi's folds: pleats gathered at the knot, the overlap running down from it, drape, the waist's roll, a ragged hem. */
export function lungiFold(t: number, th: number): { r: number; y: number } {
  const knot = Math.PI / 2;
  const near = (c: number, w: number) => Math.exp(-((angleDelta(c, th) / w) ** 2));
  const drape = (0.004 + 0.014 * t) * (0.55 * Math.sin(5 * th + 1.3) + 0.35 * Math.sin(9 * th + 0.4) + 0.22 * Math.sin(14 * th + 2.1));
  const pleats = t < 0.45 ? 0.007 * near(knot, 0.55) * (1 - t / 0.45) * Math.sin(th * 24) : 0;
  const overlap = 0.011 * near(knot + 0.25, 0.1) * (t > 0.05 ? 1 : 0.4);
  const roll = Math.abs(t - 0.1) < 0.01 ? 0.011 : 0;
  // it hangs round both knees as one tube, so it falls in between them, front and back
  const between = t > 0.3 ? -0.02 * ((t - 0.3) / 0.7) ** 2 * (near(knot, 0.32) + near(-knot, 0.32)) : 0;
  const hem = t > 0.95 ? 0.012 * Math.sin(3 * th + 0.5) + 0.006 * Math.sin(7 * th + 1.1) + 0.012 * near(knot + 0.25, 0.3) : 0;
  return { r: drape + pleats + overlap + roll + between, y: hem };
}

const ikD = new Vector3();
const ikDir = new Vector3();
const ikBend = new Vector3();

/** Two-bone IK: places `mid` (knee or elbow) so the chain from `root` reaches `target`, bending toward `pole`. */
export function solveTwoBone(root: Vector3, target: Vector3, a: number, b: number, pole: Vector3, mid: Vector3, end: Vector3): void {
  const d = ikD.subVectors(target, root);
  let len = d.length();
  const reach = (a + b) * 0.999;
  if (len > reach) {
    d.multiplyScalar(reach / len);
    len = reach;
  }
  const dir = ikDir.copy(d).normalize();
  end.copy(root).add(d);
  const x = (a * a - b * b + len * len) / (2 * len);
  const h = Math.sqrt(Math.max(a * a - x * x, 0));
  const bend = ikBend.subVectors(pole, root);
  bend.addScaledVector(dir, -bend.dot(dir)).normalize();
  mid.copy(root).addScaledVector(dir, x).addScaledVector(bend, h);
}

/** A damped spring step toward `target` (its answer is reused by the next call). */
const sprung: [number, number] = [0, 0];
function spring(x: number, v: number, target: number, f: number, zeta: number, dt: number): [number, number] {
  const w = f * Math.PI * 2;
  v += (w * w * (target - x) - 2 * zeta * w * v) * dt;
  sprung[0] = x + v * dt;
  sprung[1] = v;
  return sprung;
}

/**
 * What he wears: the lungi's check (ground, stripe, thin thread), the sando, the gamchha's check (sRGB), and a
 * seed for the weave; `hat`: the palm-leaf mathal always on his head (true, the default), or put on and taken off
 * by whoever moves him (false: `hat` is then placed each frame); `band`: a cotton headband of that colour.
 */
export interface Outfit {
  lungi: readonly [string, string, string];
  vest: string;
  gamchha: readonly [string, string, string];
  seed: number;
  hat?: boolean;
  band?: string;
}

/** The older boatmen's and workers': a blue checked lungi, an off-white sando, a red gamchha, the mathal. */
export const MAJHI_OUTFIT: Outfit = {
  lungi: ['#2c4a86', '#e8e2d2', '#16244a'],
  vest: '#d6cfbf',
  gamchha: ['#a8342a', '#efe6d6', '#5a1410'],
  seed: 71,
};

/**
 * The young boatman's (`tarun`): a deep indigo lungi checked in teal and cream, a clean white sando that shows his
 * shoulders, the red-and-white gamchha over one of them; bareheaded, so his face and hair are seen.
 */
export const TARUN_OUTFIT: Outfit = {
  lungi: ['#1f2f5c', '#3f8a86', '#e2dccb'],
  vest: '#ece8de',
  gamchha: ['#b3312a', '#f1ebdd', '#5e1610'],
  seed: 83,
  hat: false,
  band: '#9c2a22',
};

/** The mathal's middle above the head bone's head (bind, before its tip back), and that tip back (rad). */
const HAT_SEAT = { drop: -0.112, back: -0.012, tip: -0.12 };
/** The ফিতা: its width (m), how far it stands off the skin over the forehead and over the hair, its ends' particles. */
const BAND = { width: 0.022, skin: 0.004, hair: 0.016, tails: 6, segment: 0.034 };

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
  grip: Grip;
  shoulder: Vector3;
  wrist: Vector3;
  /** The bar's frame at the hand this frame. */
  barQ: Quaternion;
  /** Last frame's elbow, and the forearm's line as seen down the bar: the hand is posed from them. */
  elbowAt: Vector3;
  roll: Vector3;
  /** His shoulder's lift and reach forward (rad), eased. */
  lift: number;
  forward: number;
}


export class Boatman {
  readonly group = new Group();
  /** Where his weight is, offset from where it rests (boat frame), for the boat's balance. */
  readonly crew: Crew = { x: 0, z: 0 };
  /** How far his hands' holds were from his shoulders this frame, over his arms' length (debug). */
  stretch = 0;
  readonly body: Human;
  /** The mathal when it comes off (`Outfit.hat` false): a child of his frame, placed by whoever moves him; else null. */
  readonly hat: Group | null = null;
  /** How much the wind may move his hair (less under the mathal). */
  hairFree = 1;
  /**
   * For a man on his feet and walking (the salt farms' people, world/saltHands.ts): where his feet are this
   * instant and how far each is pitched (his frame; else planted where he stands), his hips' bob and sway, and
   * what he looks at (his frame; else down the river, as a boatman does). Null: he stands.
   */
  gait: { feet: [Vector3, Vector3]; pitch: [number, number]; hips: Vector3; look: Vector3 | null } | null = null;

  private readonly stance: Vector3;
  private readonly feet: Vector3[] = [];
  private readonly arms: Arm[] = [];
  private readonly lungi: ClothTube;
  private readonly gamchha: ClothRibbon;
  private readonly gamchhaAt: Vector3[] = [];
  private readonly gamchhaNormal: Vector3[] = [];
  /** The lungi's top rows round his waist and hips (pelvis frame): middle front to back, half-width, half-depth. */
  private readonly waist: { h: number; zc: number; a: number; b: number }[];
  /** Carries the knot of the lungi at the waist; follows the hips. */
  private readonly knot = new Group();
  private readonly restPelvis = new Vector3();
  private readonly reach: number;
  private readonly pelvisHeight: number;
  private posed = false;
  private balX = 0;
  private balZ = 0;
  private vBalX = 0;
  private vBalZ = 0;
  private brace = 0;
  private readonly lastTilt = { rotX: 0, rotZ: 0 };
  // the body's frames this instant, for the cloth
  private readonly pelvis = new Vector3();
  private readonly pelvisQ = new Quaternion();
  private readonly chestQ = new Quaternion();
  private readonly chestInv = new Quaternion();
  private readonly pAx = new Vector3();
  private readonly pAy = new Vector3();
  private readonly pAz = new Vector3();
  private readonly cAy = new Vector3();
  private readonly hips = [new Vector3(), new Vector3()];
  private readonly knees = [new Vector3(), new Vector3()];
  private readonly ankles = [new Vector3(), new Vector3()];
  private readonly shinTop = [new Vector3(), new Vector3()];
  private readonly legC = new Vector3();
  private readonly legL = new Vector3();
  private readonly legR = new Vector3();
  private readonly legAcross = new Vector3();
  private readonly legFwd = new Vector3();
  private readonly look = new Vector3();
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
  /** The mathal's seat on his head, from the head bone's head (bind frame). */
  private readonly hatSeat = new Vector3();
  /** The ফিতা's two loose ends, the knot they hang from (bind, on the back of his head), and the head's middle (bind). */
  private readonly tails: ClothRibbon[] = [];
  private readonly knot0 = new Vector3();
  private readonly knot1 = new Vector3();
  private readonly back = new Vector3();
  private readonly skull = new Vector3();
  private readonly skullAt = new Vector3();

  /**
   * `stance`: the middle of his feet on the boards (boat frame); `barRadii`: the radius of what his right
   * hand holds (the cross-grip) and his left (the shaft); `outfit`: what he wears; `who`: which body.
   */
  constructor(stance: Vector3, barRadii: readonly [number, number], outfit: Outfit = MAJHI_OUTFIT, who: HumanName = 'majhi') {
    this.stance = stance.clone();
    this.group.name = 'boatman';
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
    // the sando is knitted: its texture over the body's own layout, a few repeats across the chest
    const knit = clothTexture(vest, vest, vest, seed + 1, true);
    knit.map.repeat.set(7, 7);
    knit.normal.repeat.set(7, 7);
    const vestMat = patchMaterial(cloth(knit, 0.94, 0.3), { grime: 0.3, translucency: 0.2 });
    const gamchhaMat = patchMaterial(cloth(clothTexture(gamchha[0], gamchha[1], gamchha[2], seed + 2), 0.9), { translucency: 0.3 });
    const hatWeave = weaveTexture(53);
    hatWeave.repeat.set(10, 3);
    const hatMat = patchMaterial(new MeshStandardMaterial({ map: hatWeave, color: '#fff0cc', roughness: 0.85, side: DoubleSide }), {
      translucency: 0.5,
    });
    const g = this.group;

    // loose hair where the body's hair was built to move (human.ts)
    const body = (this.body = new Human(who, { vest: vestMat }, { flowingHair: Boolean(HUMANS[who].parts.hair?.free) }));
    g.add(body.group);
    const { dims } = body;
    this.reach = dims.upperArm + dims.foreArm;
    this.pelvisHeight = dims.pelvis - SOFT_KNEES;
    for (const [dx, dz] of FEET) this.feet.push(new Vector3(stance.x + dx, stance.y, stance.z + dz));

    // the mathal: a wide cone of palm leaf on the crown, its rim a finger thick, tipped back a little
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
    const rim = new Mesh(new TorusGeometry(0.345, 0.011, 5, 32), patchMaterial(new MeshStandardMaterial({ color: '#5a4630', roughness: 0.8 }), {}));
    rim.rotation.x = Math.PI / 2;
    rim.position.y = -0.008;
    const hatHolder = new Group();
    hatHolder.add(hat, rim);
    const crown = new Vector3(...body.data.crown);
    this.hatSeat.copy(crown).sub(body.bindOf('head')).add(this.v.set(0, HAT_SEAT.drop, HAT_SEAT.back));
    for (const m of [hat, rim]) m.castShadow = false;
    if (outfit.hat !== false) {
      hatHolder.position.copy(this.hatSeat);
      hatHolder.rotation.x = HAT_SEAT.tip;
      body.bone('head').add(hatHolder);
    } else {
      // one that comes off: in his frame, placed each frame (on his head, in his hand, or set down)
      this.hat = hatHolder;
      g.add(hatHolder);
    }
    if (outfit.band) this.tieBand(outfit.band, seed);

    // the hands closed round what they hold
    [-1, 1].forEach((side, i) => {
      this.arms.push({
        side,
        grip: body.grip(side, barRadii[i]),
        shoulder: new Vector3(),
        wrist: new Vector3(),
        barQ: new Quaternion(),
        elbowAt: new Vector3(),
        roll: new Vector3(0, -1, 0),
        lift: 0,
        forward: 0,
      });
    });

    // the lungi: wrapped and rolled at the waist, hitched to the knees, knotted in front
    const pelvisMap = body.data.sections.pelvis;
    this.waist = LUNGI_TOP.map(([, h, ease]) => {
      const e = enclosing(pelvisMap, h);
      return { h, zc: e.zc, a: e.a + ease, b: e.b + ease };
    });
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
    const w0 = this.waist[1];
    const front = w0.zc + w0.b;
    knotB.add(ball, new Matrix4().makeTranslation(0.028, w0.h - 0.016, front - 0.004).scale(new Vector3(0.034, 0.026, 0.02)));
    knotB.add(ball, new Matrix4().makeTranslation(0.05, w0.h - 0.036, front - 0.01).scale(new Vector3(0.022, 0.03, 0.016)));
    this.knot.add(new Mesh(knotB.build(), lungiMat));

    // the gamchha: folded over his right shoulder, its ends hanging down his chest and back
    this.gamchha = new ClothRibbon(gamchhaMat, GAMCHHA_COUNT, 0.04, 0.085, GAMCHHA_PINS, 0.33, 2.4);
    const chestBind = body.bindOf('spine01');
    const neck = body.bindOf('neck01');
    const inside = new Vector3(GAMCHHA_X * (body.data.height / 1.64), neck.y - 0.075, chestBind.z + radiusAt(body.data.sections.chest, neck.y - 0.075 - chestBind.y, 0).zc);
    for (const psi of GAMCHHA_PSI) {
      const hit = body.cast(inside, new Vector3(0, Math.sin(psi), Math.cos(psi)));
      const p = hit ? hit.point : inside.clone().addScaledVector(new Vector3(0, Math.sin(psi), Math.cos(psi)), 0.08);
      const n = hit ? hit.normal : new Vector3(0, Math.sin(psi), Math.cos(psi));
      this.gamchhaAt.push(p.addScaledVector(n, VEST_OFF + 0.008));
      this.gamchhaNormal.push(n);
    }
    g.add(this.lungi.mesh, this.knot, this.gamchha.mesh);
    for (const m of [this.lungi.mesh, this.gamchha.mesh]) m.castShadow = false;
    this.knot.traverse((o) => (o.castShadow = false));

    this.restPelvis.set(stance.x, stance.y + this.pelvisHeight, stance.z);
  }

  /**
   * The ফিতা: a strip of red cotton round his head from his forehead, just above his brows, round over his hair
   * at the sides to the back, where it is knotted a little lower, its two ends hanging loose. The band is laid on
   * him (each point out from the skull to the skin, then over the hair) and rides with his head; the ends are cloth.
   */
  private tieBand(colour: string, seed: number): void {
    const body = this.body;
    const eye = body.bindOf('eye.L');
    const head = body.bindOf('head');
    this.skull.set(0, eye.y + 0.03, eye.z - 0.085);
    const weave = clothTexture(colour, colour, colour, seed + 3, true);
    weave.map.repeat.set(6, 1);
    const mat = patchMaterial(
      new MeshStandardMaterial({ map: weave.map, normalMap: weave.normal, normalScale: new Vector2(0.5, 0.5), roughness: 0.92, side: DoubleSide }),
      { translucency: 0.4 },
    );
    const N = 56;
    const pos: number[] = [];
    const nrm: number[] = [];
    const uv: number[] = [];
    const index: number[] = [];
    const up = new Vector3();
    for (let k = 0; k <= N; k++) {
      const th = (k / N) * Math.PI * 2;
      const front = 0.5 + 0.5 * Math.cos(th);
      // across the forehead high, round the back a little lower, over the occiput
      const y = eye.y + 0.042 * front + 0.006 * (1 - front);
      const dir = this.v.set(Math.sin(th), 0, Math.cos(th));
      const from = this.v2.set(this.skull.x, y, this.skull.z);
      const hit = body.cast(from, dir);
      const at = hit ? hit.point.clone() : from.clone().addScaledVector(dir, 0.09);
      const out = (hit ? hit.normal.clone() : dir.clone()).setY(0).normalize();
      // on the skin at the forehead, over the hair from the temples round
      at.addScaledVector(out, BAND.skin + (BAND.hair - BAND.skin) * (1 - smoothstep(0.55, 0.9, front)));
      // a little fuller where it is drawn tight over the knot
      const knot = Math.exp(-(((th - Math.PI) / 0.25) ** 2));
      at.addScaledVector(out, 0.004 * knot);
      up.set(0, 1, 0).addScaledVector(out, -out.y).normalize();
      for (const s of [-1, 1]) {
        const p = at.clone().addScaledVector(up, (s * BAND.width) / 2).sub(head);
        pos.push(p.x, p.y, p.z);
        nrm.push(out.x, out.y, out.z);
        uv.push(k / N, s < 0 ? 0 : 1);
      }
      if (k < N) {
        const a = k * 2;
        index.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
      }
      if (k === N / 2) {
        // the knot at the back, and where its ends come from (bind)
        this.back.copy(out);
        this.knot0.copy(at).addScaledVector(up, -0.006).addScaledVector(out, 0.012);
        this.knot1.copy(this.knot0).addScaledVector(this.v3.crossVectors(up, out).normalize(), 0.012);
      }
    }
    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
    geo.setAttribute('normal', new BufferAttribute(new Float32Array(nrm), 3));
    geo.setAttribute('uv', new BufferAttribute(new Float32Array(uv), 2));
    geo.setIndex(index);
    const band = new Mesh(geo, mat);
    // the knot itself: a twist of the cloth
    const knot = new Mesh(new SphereGeometry(1, 10, 8), mat);
    knot.scale.set(0.017, 0.013, 0.011);
    knot.position.copy(this.knot0).addScaledVector(this.back, -0.004).sub(head);
    const holder = new Group();
    holder.add(band, knot);
    for (const m of [band, knot]) m.castShadow = false;
    body.bone('head').add(holder);
    // the two ends, each held at the knot by its first two particles
    for (let i = 0; i < 2; i++) {
      const tail = new ClothRibbon(mat, BAND.tails, BAND.segment, 0.024 - i * 0.003, [0, 1], 1, 1);
      tail.mesh.castShadow = false;
      this.tails.push(tail);
      this.group.add(tail.mesh);
    }
  }

  /** Where the mathal sits on his head as he is posed now (his frame): its middle and its turn. */
  hatOnHead(pos: Vector3, quat: Quaternion): void {
    pos.copy(this.hatSeat).applyQuaternion(this.body.headQ).add(this.body.head);
    quat.copy(this.body.headQ).multiply(this.q.setFromAxisAngle(this.v.set(1, 0, 0), HAT_SEAT.tip));
  }

  /** The ফিতা's ends: held at the knot, the first particle a little back from the second, both carried by his head. */
  private readonly tailPin = (k: number) => (i: number, p: Vector3, n: Vector3): void => {
    const at = this.v.copy(k === 0 ? this.knot0 : this.knot1);
    if (i === 0) at.addScaledVector(this.back, -0.006);
    this.body.onHead(at, p);
    n.copy(this.back).applyQuaternion(this.body.headQ);
  };

  /** Each end's pin, made once. */
  private readonly tailPins = [this.tailPin(0), this.tailPin(1)];

  private readonly tailOut = (p: Vector3, out: Vector3): void => {
    out.subVectors(p, this.skullAt).normalize();
  };

  /** Keeps the ends off the back of his head and neck. */
  private readonly tailKeep = (p: Vector3): void => {
    const d = this.v3.subVectors(p, this.skullAt);
    const r = d.length();
    if (r < 0.105 && r > 1e-5) p.addScaledVector(d, (0.105 - r) / r);
  };

  /** The ring of the lungi at `t` (0 its top .. 1 its hem), where his hips and knees put it. */
  private readonly lungiRing = (t: number, out: Ring): Ring => {
    if (t < LUNGI_HIPS) {
      const k = Math.min(LUNGI_TOP.length - 2, Math.floor(t * 10));
      const f = (t - LUNGI_TOP[k][0]) * 10;
      const r0 = this.waist[k];
      const r1 = this.waist[k + 1];
      const h = r0.h + (r1.h - r0.h) * f;
      const zc = r0.zc + (r1.zc - r0.zc) * f;
      out.c.copy(this.pelvis).addScaledVector(this.pAy, h).addScaledVector(this.pAz, zc);
      out.ax.copy(this.pAx);
      out.az.copy(this.pAz);
      out.a = r0.a + (r1.a - r0.a) * f;
      out.b = r0.b + (r1.b - r0.b) * f;
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
    // the thigh's outline is its widest reach (the buttock's, the muscle's): the cloth hangs round less
    const r = tableAt(this.body.data.sections.thigh, s) * 0.8;
    const clear = 0.012 + 0.03 * smoothstep(0, 0.5, s);
    const belly = Math.sin(Math.PI * s);
    // at the hips it carries on from the waist's ellipse
    const top = this.waist[this.waist.length - 1];
    const k = smoothstep(0, 0.35, s);
    out.c.copy(this.legC);
    out.ax.copy(this.legAcross);
    out.az.copy(this.legFwd);
    out.a = Math.max(half + r + clear + 0.012 * belly, top.a * (1 - k));
    out.b = Math.max(r + 0.05 + 0.01 * belly, top.b * (1 - k));
    return out;
  };

  private readonly gamchhaPin = (i: number, p: Vector3, n: Vector3): void => {
    const k = i - GAMCHHA_PINS[0];
    this.body.onChest(this.gamchhaAt[k], p);
    n.copy(this.gamchhaNormal[k]).applyQuaternion(this.chestQ);
  };

  private readonly awayFromChest = (p: Vector3, out: Vector3): void => {
    out.subVectors(p, this.body.chest);
    out.addScaledVector(this.cAy, -out.dot(this.cAy)).normalize();
  };

  /** The thigh's and the shin's top's radius at `f` along them, a finger's width proud of the skin. */
  private readonly thighOff = (f: number): number => tableAt(this.body.data.sections.thigh, f) + 0.012;
  private readonly shinOff = (f: number): number => tableAt(this.body.data.sections.shin, f * 0.3) + 0.012;

  /** Keeps the lungi off his thighs and the tops of his shins (asked for each of its points, every frame: no closures made here). */
  private readonly keepOffLegs = (p: Vector3): void => {
    for (let i = 0; i < 2; i++) {
      // not round the top of the thigh: the hip joint is inside him, and the waist sits close above it
      this.pushOff(p, this.hips[i], this.knees[i], this.thighOff, false);
      this.pushOff(p, this.knees[i], this.shinTop[i], this.shinOff, true);
    }
  };

  /**
   * Pushes `p` out of the capsule from `a` to `b` whose radius at `f` (0 at a .. 1 at b) is `radius(f)`;
   * without `capA`, points beyond its `a` end are left alone.
   */
  private pushOff(p: Vector3, a: Vector3, b: Vector3, radius: (f: number) => number, capA: boolean): void {
    const seg = this.v3.subVectors(b, a);
    const t = this.v2.subVectors(p, a).dot(seg) / seg.lengthSq();
    if (t < 0 && !capA) return;
    const f = Math.min(1, Math.max(0, t));
    const away = this.v2.subVectors(p, a).addScaledVector(seg, -f);
    const d = away.length();
    const r = radius(f);
    if (d < r && d > 1e-5) p.addScaledVector(away, (r - d) / d);
  }

  /** Keeps the gamchha's hanging ends out of his chest and back (over the sando). */
  private readonly keepOffChest = (p: Vector3): void => {
    const body = this.body;
    const bind = body.bindOf('spine01');
    const v = this.v3.subVectors(p, body.chest).applyQuaternion(this.chestInv).add(bind);
    const y = v.y - bind.y;
    const map = body.data.sections.chest;
    if (y < map.y0 || y > map.y0 + map.dy * (map.rows - 1)) return;
    const zc = radiusAt(map, y, 0).zc + bind.z;
    const dx = v.x;
    const dz = v.z - zc;
    const r = Math.hypot(dx, dz);
    if (r < 1e-4) return;
    const R = radiusAt(map, y, Math.atan2(dx, dz)).r + VEST_OFF + 0.006;
    if (r >= R) return;
    v.x = (dx * R) / r;
    v.z = zc + (dz * R) / r;
    p.copy(v.sub(bind).applyQuaternion(this.chestQ)).add(body.chest);
  };

  /** Elbows down by his sides and a little out and back, as a paddler's stay: never winged out at the shoulder. */
  private poleOf(arm: Arm): Vector3 {
    return this.pole.set(arm.side * 0.32, -0.9, -0.22).applyQuaternion(this.chestQ).add(arm.shoulder);
  }

  /**
   * Poses him for this instant. `time`: seconds, for the cloth's flutter and his blinks; `drive`: how his body
   * works the stroke now; `oar`: where his hands hold the paddle; `tilt`: the deck's angles; `wind`: the air
   * moving past him (m/s) and `gravity`, both in the boat's frame.
   */
  update(dt: number, time: number, drive: BodyDrive, oar: OarPose, tilt: BoatTilt, wind: Vector3, gravity: Vector3): void {
    const body = this.body;
    const { dims } = body;
    // balance: he leans against the deck's tilt to stay upright, a beat late
    [this.balX, this.vBalX] = spring(this.balX, this.vBalX, -tilt.rotX * BALANCE.share, BALANCE.f, BALANCE.zeta, dt);
    [this.balZ, this.vBalZ] = spring(this.balZ, this.vBalZ, -tilt.rotZ * BALANCE.share, BALANCE.f, BALANCE.zeta, dt);
    // the rougher the deck rocks, the lower he braces
    if (dt > 0) {
      const rocking = Math.hypot(tilt.rotX - this.lastTilt.rotX, tilt.rotZ - this.lastTilt.rotZ) / dt;
      const want = Math.min(BRACE.max, rocking * BRACE.perRate);
      this.brace += (want - this.brace) * (1 - Math.exp(-dt / BRACE.tau));
    }
    this.lastTilt.rotX = tilt.rotX;
    this.lastTilt.rotZ = tilt.rotZ;
    const crouch = drive.crouch + this.brace;
    const bend = drive.bend + this.brace * 1.2;

    // hips: they sink as his knees give into the pull, move with him toward the bow and out over the
    // side, tip forward as he bends from them, and turn with a share of his twist
    this.e.set(this.balX, 0, this.balZ, 'YXZ');
    this.v.set(0.12 * drive.lean, this.pelvisHeight - crouch, drive.shift).applyEuler(this.e);
    this.pelvis.copy(this.stance).add(this.v);
    if (this.gait) this.pelvis.add(this.gait.hips);
    this.pelvisQ.setFromEuler(this.e.set(this.balX + 0.04 + 0.35 * bend, 0.4 * drive.twist, this.balZ - 0.3 * drive.lean, 'YXZ'));

    // chest: the rest of the bend, the twist and the lean
    this.q.setFromEuler(this.e.set(0.13 + 0.65 * bend, 0.6 * drive.twist, -0.7 * drive.lean, 'YXZ'));
    this.chestQ.copy(this.pelvisQ).multiply(this.q);
    body.setTrunk(this.pelvis, this.pelvisQ, this.chestQ);

    // hands first, for they are where the paddle is; his shoulders come up and forward toward them; then he
    // bends in if a hold is still out of his arms' reach
    this.stretch = 0;
    this.lean.set(0, 0, 0);
    const ease = dt > 0 ? 1 - Math.exp(-dt / SHRUG.tau) : 1;
    this.cAy.set(0, 1, 0).applyQuaternion(this.chestQ);
    const fwd = this.v3.set(0, 0, 1).applyQuaternion(this.chestQ);
    this.arms.forEach((arm, i) => {
      const hold = oar.holds[i];
      const shoulder = body.shoulder(arm.side, arm.shoulder);
      if (!this.posed) solveTwoBone(shoulder, hold.at, dims.upperArm, dims.foreArm, this.poleOf(arm), arm.elbowAt, this.end);
      body.holdBar(arm.side, arm.grip, hold.at, hold.thumb, arm.elbowAt, arm.roll, arm.barQ, arm.wrist);
      const off = this.v.subVectors(arm.wrist, shoulder);
      const dist = off.length();
      const up = off.dot(this.cAy) / dist;
      const out = Math.max(0, dist / this.reach - 0.8) * (off.dot(fwd) > 0 ? 1 : 0.4);
      // the shoulder blade carries about a third of an arm's rise
      arm.lift += (Math.min(SHRUG.lift, Math.max(0, (up + 0.3) * 0.38)) - arm.lift) * ease;
      arm.forward += (Math.min(SHRUG.forward, out * 1.2) - arm.forward) * ease;
      body.setShrug(arm.side, arm.lift, arm.forward);
    });
    body.setTrunk(this.pelvis, this.pelvisQ, this.chestQ);
    this.arms.forEach((arm) => {
      const shoulder = body.shoulder(arm.side, arm.shoulder);
      const off = this.v.subVectors(arm.wrist, shoulder);
      const dist = off.length();
      this.stretch = Math.max(this.stretch, dist / this.reach);
      const excess = dist - this.reach * 0.985;
      if (excess > 0) this.lean.addScaledVector(off, excess / dist);
    });
    if (this.lean.length() > LEAN_MAX) this.lean.setLength(LEAN_MAX);
    if (this.lean.lengthSq() > 1e-8) {
      // the hips take half of it, and the chest bends over them for the rest
      this.pelvis.addScaledVector(this.lean, 0.5);
      const rise = this.v.subVectors(body.shoulder(-1, this.v2), body.pelvis).add(body.shoulder(1, this.v2)).sub(body.pelvis).multiplyScalar(0.5);
      const turn = this.v2.crossVectors(rise, this.lean);
      const angle = (this.lean.length() * 0.5) / rise.length();
      if (turn.lengthSq() > 1e-10) this.chestQ.premultiply(this.q.setFromAxisAngle(turn.normalize(), angle));
      body.setTrunk(this.pelvis, this.pelvisQ, this.chestQ);
    }
    this.chestInv.copy(this.chestQ).invert();
    this.knot.position.copy(this.pelvis);
    this.knot.quaternion.copy(this.pelvisQ);

    // head: level in the world and looking down the river (a little down, toward the blade, as he bends),
    // whatever the body and the deck do
    this.headQ.setFromEuler(this.e.set(-tilt.rotX * 0.9 + 0.08 + 0.2 * drive.bend, 0.25 * drive.twist, -tilt.rotZ * 0.9, 'YXZ'));
    this.look.set(0, -1.5, 25).applyQuaternion(this.headQ).add(body.head);
    const look = this.gait?.look;
    if (look) {
      // on his feet he turns his head to what he looks at, as far as a neck turns, and his eyes go the rest
      const dx = look.x - body.head.x;
      const dz = look.z - body.head.z;
      const yaw = Math.max(-0.9, Math.min(0.9, Math.atan2(dx, dz)));
      const pitch = Math.max(-0.2, Math.min(0.75, -Math.atan2(look.y - body.head.y, Math.hypot(dx, dz)) * 0.75));
      this.headQ.setFromEuler(this.e.set(pitch, yaw, 0, 'YXZ'));
      this.look.copy(look);
    }
    body.setHead(this.headQ, this.look, time);
    // the air past his head, in its own frame, for his loose hair
    this.v.copy(wind).multiplyScalar(this.hairFree).applyQuaternion(this.q.copy(this.headQ).invert());
    body.hairWind.set(this.v.x, this.v.y, this.v.z, time);

    // legs: from the hips to the planted feet, knees forward and a little out
    for (let i = 0; i < 2; i++) {
      const side = i === 0 ? -1 : 1;
      const hip = body.hip(side, this.hips[i]);
      const ankle = this.ankles[i].copy(this.gait ? this.gait.feet[i] : this.feet[i]).addScaledVector(UP, dims.ankle);
      const pole = this.pole.copy(hip).add(this.v.set(side * 0.25, -0.35, 1).applyQuaternion(this.pelvisQ));
      solveTwoBone(hip, ankle, dims.thigh, dims.shin, pole, this.knees[i], this.end);
      body.setLeg(side, this.knees[i], this.end, this.gait ? FEET[i][2] * 0.3 : FEET[i][2], this.gait ? this.gait.pitch[i] : 0);
      this.shinTop[i].lerpVectors(this.knees[i], this.end, 0.3);
    }

    // arms: from the shoulders to the wrists, the hands on the paddle
    for (const arm of this.arms) {
      const shoulder = body.shoulder(arm.side, arm.shoulder);
      solveTwoBone(shoulder, arm.wrist, dims.upperArm, dims.foreArm, this.poleOf(arm), arm.elbowAt, this.end);
      body.setHand(arm.grip, oar.holds[arm.side < 0 ? 0 : 1].at, arm.barQ);
      body.setArm(arm.side, arm.elbowAt);
    }
    this.posed = true;

    // cloth: the frames it hangs from, then each piece
    this.pAx.set(1, 0, 0).applyQuaternion(this.pelvisQ);
    this.pAy.set(0, 1, 0).applyQuaternion(this.pelvisQ);
    this.pAz.set(0, 0, 1).applyQuaternion(this.pelvisQ);
    this.cAy.set(0, 1, 0).applyQuaternion(this.chestQ);
    this.lungi.update(dt, time, this.lungiRing, wind, this.keepOffLegs);
    this.gamchha.update(dt, time, this.gamchhaPin, this.awayFromChest, this.keepOffChest, wind, gravity);
    if (this.tails.length) {
      this.body.onHead(this.skull, this.skullAt);
      this.tails.forEach((tail, k) => tail.update(dt, time + k * 1.7, this.tailPins[k], this.tailOut, this.tailKeep, wind, gravity));
    }

    // his weight, for the boat: his hips and his chest (which leans out over the blade with each pull)
    this.crew.x = (this.pelvis.x - this.restPelvis.x) * 0.6 + (body.chest.x - this.stance.x) * 0.4;
    this.crew.z = (this.pelvis.z - this.restPelvis.z) * 0.6 + (body.chest.z - this.stance.z) * 0.4;
    body.commit();
  }
}
