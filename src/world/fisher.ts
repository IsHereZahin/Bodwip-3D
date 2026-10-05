import { BoxGeometry, BufferAttribute, BufferGeometry, CylinderGeometry, DoubleSide, Group, LatheGeometry, Matrix4, Mesh, MeshBasicMaterial, MeshStandardMaterial, PlaneGeometry, Quaternion, Vector2, Vector3 } from 'three';
import { LAYER_NO_REFLECT } from '../core/globals';
import { clamp, lerp, smoothstep } from '../core/mathx';
import { Rng } from '../core/rng';
import { windAt } from '../env/wind';
import { MeshBuilder, rgb, scaleRgb } from '../render/builder';
import { patchMaterial } from '../render/patch';
import { castNetTexture, softSpotTexture, weaveTexture } from '../render/textures';
import { Boatman, type OarPose, type Outfit } from './boatman';
import type { HumanName } from './humanData';
import { fishGeometry, type Fish } from './fish';
import { WATER_LEVEL, terrainHeight, waterRise } from './geography';
import { buildHull, hullHalfWidthAt, hullStation, type HullShape } from './hull';
import type { BodyDrive } from './paddle';
import { FISHER_NEAR } from './plan';
import { RIVER } from './waterways';
import { SHELTERED, waveHeight, waveSlope } from './waves';

// The fisherman with his cast net (ঝাঁকি জাল) on the river below where the khal comes in (the user asked for
// a fisherman catching fish with a net). His dinghy is tied to a bamboo pole planted in the bed; he stands in
// her bow with the net gathered over his arm, winds his body round to the right, and swings: the net leaves
// his hands as a bundle and opens in the air into a wide circle, spinning, its weighted rim dropping first,
// and falls flat on the water with a ring of splashes. The weights carry the rim down while he holds the line,
// so it closes over the fish like a bell; he hauls it in hand over hand, the rim drawn together under it,
// lifts the dripping bag over the bow, lays it in the boat and shakes the catch out, a few silver fish
// flapping on the boards, and gathers the net for the next cast. His body is the boatman's (human.ts) in his
// own clothes, his hands on the net's neck or the line (boatman.ts holds); the net is a mesh of rings and
// spokes laid each frame from where the cast has got to.

/** The dinghy: a little shorter and narrower than the boats at the ghats. */
const DINGHY: HullShape = { len: 5.2, beam: 0.62, keelMid: -0.2, keelRise: 0.55, sheerMid: 0.3, sheerRise: 0.62 };
/** Where he stands along her (0 stern .. 1 bow), and her waterline over her shape's zero. */
const STAND_AT = 0.7;
const FLOAT = 0.06;

/** The net: spread radius, length when it hangs full from its crown, as gathered on his arm, and its rings and spokes. */
const NET = { radius: 3.1, length: 2.3, gathered: 0.95, rings: 12, spokes: 40, mesh: 0.42 };
/** How far ahead of his feet it falls (m), and how high it flies over the line between. */
const CAST = { reach: 5.6, apex: 1.7 };

/**
 * The cast's moments (s from the cycle's start): holding the net, winding round, the swing and the net's
 * leaving his hands, its landing, taking up the line, hauling (five pulls), the bag lifted out and laid in the
 * boat, the catch shaken out, the net gathered again.
 */
const T = { windup: 1.6, swing: 2.9, release: 3.3, through: 3.45, land: 4.6, grab: 5.0, haul: 7.6, pull: 1.0, pulls: 5, raised: 13.4, laid: 14.4, emptied: 15.6, cycle: 19 };
/** The catch: how many fish come up in the net. */
const CATCH = 5;

/**
 * On the river it is the young majhi (`tarun`) out with his net in his own clothes for it: a faded green check
 * lungi rolled to the knee, a washed sky-blue sando, a checked gamchha; bareheaded.
 */
const OUTFIT: Outfit = { lungi: ['#3e5a3a', '#cfc6a8', '#22301c'], vest: '#a9c3d6', gamchha: ['#8c2f28', '#e8dfcc', '#4a1612'], seed: 91, hat: false };

/** Where the dinghy lies: off the middle toward the south bank, her bow across the river and a little upstream; the place the net falls. */
const SITE = (() => {
  const s = RIVER.line.nearestS(FISHER_NEAR[0], FISHER_NEAR[1]);
  const p = RIVER.at(s);
  const at = RIVER.beside(s, 1, RIVER.half(s) * 0.45);
  // across the river to its north side (right, going down it), a little upstream
  const bx = -Math.cos(p.heading) * 0.9 - Math.sin(p.heading) * 0.42;
  const bz = Math.sin(p.heading) * 0.9 - Math.cos(p.heading) * 0.42;
  return { x: at.x, z: at.z, yaw: Math.atan2(bx, bz), s };
})();

/** Where the fisherman works and which way he faces (for the film's shot of him). */
export const FISHER_SITE: { readonly x: number; readonly z: number; readonly yaw: number; readonly s: number } = SITE;

/**
 * Where a man casts: his place and the way he faces; on foot on a bund (`ground`, the height of his feet) or, by
 * default, in his dinghy on the river; the water he fishes when it is not the river's (`water`: its surface,
 * standing over its own floor), and his clothes.
 */
export interface FisherPlace {
  x: number;
  z: number;
  yaw: number;
  ground?: number;
  water?: number;
  outfit?: Outfit;
  /** Whose body (the young majhi's on the river unless given). */
  who?: HumanName;
}

const ease = (x: number) => smoothstep(0, 1, x);
/** Where `t` lies between `a` and `b`, 0..1. */
const span = (t: number, a: number, b: number) => clamp((t - a) / (b - a), 0, 1);

export class Fisher {
  readonly group = new Group();
  private readonly boat = new Group();
  private readonly man: Boatman;
  private readonly fish: Fish;
  private readonly stance: Vector3;
  private readonly site: FisherPlace;
  /** In his dinghy on the river (else on foot on a bund). */
  private readonly afloat: boolean;
  private readonly pose: OarPose = {
    holds: [
      { at: new Vector3(), thumb: new Vector3(0, 1, 0) },
      { at: new Vector3(), thumb: new Vector3(0, 1, 0) },
    ],
  };
  private readonly drive: BodyDrive = { twist: 0, bend: 0.15, lean: 0, crouch: 0.05, shift: 0 };
  private readonly tilt = { rotX: 0, rotZ: 0 };
  private readonly wind = new Vector3();
  private readonly gravity = new Vector3(0, -9.81, 0);
  private readonly air = { x: 0, z: 0 };
  private readonly slope = { x: 0, z: 0 };
  /** Seconds into the cast now. */
  private time = 0;

  // the net's state this frame
  private readonly crown = new Vector3();
  private open = 0;
  private cup = 0;
  private length: number = NET.gathered;
  private spin = 0;
  private lean = 0;
  private readonly released = new Vector3();
  private readonly landing = new Vector3();
  private bed = -10;
  private readonly net: Mesh;
  private readonly netPos: Float32Array;
  private readonly rim: Mesh;
  private readonly rimPos: Float32Array;
  private readonly line: Mesh;
  private readonly linePos: Float32Array;
  private readonly catchFish: Mesh[] = [];
  private readonly fishSpots: { u: number; v: number; turn: number; beat: number }[] = [];
  private nextDrip = 0;
  private splashed = false;

  // scratch
  private readonly v = new Vector3();
  private readonly v2 = new Vector3();
  private readonly hands = new Vector3();
  private readonly q = new Quaternion();
  private readonly axis = new Vector3();

  constructor(fish: Fish, place: FisherPlace = SITE) {
    this.fish = fish;
    this.site = place;
    this.afloat = place.ground === undefined;
    this.group.name = 'fisher';
    const rng = new Rng(97);
    const weave = weaveTexture(61);
    weave.repeat.set(6, 2);
    const basket = new Mesh(
      new LatheGeometry([new Vector2(0, 0), new Vector2(0.14, 0), new Vector2(0.2, 0.08), new Vector2(0.23, 0.2), new Vector2(0.21, 0.2), new Vector2(0.18, 0.08), new Vector2(0, 0.02)], 14),
      patchMaterial(new MeshStandardMaterial({ map: weave, color: '#c9b386', roughness: 0.9, side: DoubleSide }), { grime: 0.3 }),
    );
    if (!this.afloat) {
      // on foot on a bund: his basket beside him
      this.stance = new Vector3(0, 0, 0);
      basket.position.set(-0.55, 0, -0.35);
      this.boat.add(basket);
      this.boat.position.set(place.x, place.ground ?? 0, place.z);
    } else {
      this.stance = this.buildDinghy(rng, basket);
      this.boat.position.set(place.x, WATER_LEVEL, place.z);
    }
    this.boat.rotation.set(0, place.yaw, 0, 'YXZ');
    this.man = new Boatman(this.stance, [0.014, 0.014], place.outfit ?? OUTFIT, place.who ?? 'tarun');
    this.boat.add(this.man.group);
    // his soft shadow on the boards or the bund
    const shadow = new Mesh(
      new PlaneGeometry(0.8, 0.6).rotateX(-Math.PI / 2),
      new MeshBasicMaterial({ map: softSpotTexture(), transparent: true, depthWrite: false, color: '#000000', opacity: 0.45 }),
    );
    shadow.position.copy(this.stance).y += 0.02;
    this.boat.add(shadow);
    this.group.add(this.boat);
    // the net: rings out from its crown, spokes round it; the twine's mesh laid on in the spread net's own plane
    const n = (NET.rings + 1) * NET.spokes;
    this.netPos = new Float32Array(n * 3);
    const uv = new Float32Array(n * 2);
    const color = new Float32Array(n * 3);
    for (let i = 0; i <= NET.rings; i++) {
      const r = i / NET.rings;
      for (let j = 0; j < NET.spokes; j++) {
        const a = (j / NET.spokes) * Math.PI * 2;
        const k = i * NET.spokes + j;
        uv.set([(Math.cos(a) * r * NET.radius) / NET.mesh, (Math.sin(a) * r * NET.radius) / NET.mesh], k * 2);
        // the lead-weighted rim and the knot at the crown darker
        const shade = 1 - 0.45 * smoothstep(0.88, 1, r) - 0.3 * (1 - smoothstep(0, 0.12, r));
        color.set([shade, shade, shade], k * 3);
      }
    }
    const idx: number[] = [];
    for (let i = 0; i < NET.rings; i++) {
      for (let j = 0; j < NET.spokes; j++) {
        const a = i * NET.spokes + j;
        const b = i * NET.spokes + ((j + 1) % NET.spokes);
        idx.push(a, a + NET.spokes, b, b, a + NET.spokes, b + NET.spokes);
      }
    }
    const netGeo = new BufferGeometry();
    netGeo.setAttribute('position', new BufferAttribute(this.netPos, 3));
    netGeo.setAttribute('uv', new BufferAttribute(uv, 2));
    netGeo.setAttribute('color', new BufferAttribute(color, 3));
    netGeo.setIndex(idx);
    // a veil of pale twine, glowing where the low sun comes through it; drawn before the water, which lies over it where it has sunk
    this.net = new Mesh(
      netGeo,
      patchMaterial(
        new MeshStandardMaterial({ map: castNetTexture(), color: '#c4bba4', vertexColors: true, transparent: true, depthWrite: false, side: DoubleSide, roughness: 0.8 }),
        { translucency: 1.1 },
      ),
    );
    this.net.frustumCulled = false;
    this.net.renderOrder = -2;
    // the rim's weighted rope, and the hand line: thin tubes laid each frame
    const tube = (count: number) => {
      const pos = new Float32Array(count * 3 * 3);
      const g = new BufferGeometry();
      g.setAttribute('position', new BufferAttribute(pos, 3));
      const tri: number[] = [];
      for (let i = 0; i < count - 1; i++) {
        for (let k = 0; k < 3; k++) {
          const a = i * 3 + k;
          const b = i * 3 + ((k + 1) % 3);
          tri.push(a, a + 3, b, b, a + 3, b + 3);
        }
      }
      g.setIndex(tri);
      return { g, pos };
    };
    const rimTube = tube(NET.spokes + 1);
    this.rimPos = rimTube.pos;
    this.rim = new Mesh(rimTube.g, patchMaterial(new MeshStandardMaterial({ color: '#3a3630', roughness: 0.6, metalness: 0.2, side: DoubleSide }), {}));
    const lineTube = tube(14);
    this.linePos = lineTube.pos;
    this.line = new Mesh(lineTube.g, patchMaterial(new MeshStandardMaterial({ color: '#cbbf9e', roughness: 0.9, side: DoubleSide }), {}));
    for (const m of [this.rim, this.line]) {
      m.frustumCulled = false;
      m.renderOrder = -2;
    }
    this.group.add(this.net, this.rim, this.line);

    // the catch: small silver fish
    const fishMat = patchMaterial(new MeshStandardMaterial({ vertexColors: true, roughness: 0.3, metalness: 0.35, side: DoubleSide }), {});
    const fishGeo = fishGeometry();
    for (let i = 0; i < CATCH; i++) {
      const m = new Mesh(fishGeo, fishMat);
      m.scale.setScalar(rng.range(0.13, 0.19));
      m.visible = false;
      this.catchFish.push(m);
      this.group.add(m);
      this.fishSpots.push({ u: rng.range(-0.3, 0.3), v: rng.range(-0.25, 0.25), turn: rng.range(0, Math.PI * 2), beat: rng.range(0, 10) });
    }
    // what moves stays out of the shadow map (it is not redrawn every frame), and out of the mirror
    this.group.traverse((o) => {
      if (o.name !== 'pole') o.castShadow = false;
      o.layers.set(LAYER_NO_REFLECT);
    });
  }

  /** The dinghy, tied to her bamboo pole: her hull, floorboards, a thwart, the basket; where he stands in her bow. */
  private buildDinghy(rng: Rng, basket: Mesh): Vector3 {
    const place = this.site;
    // her hull, floorboards from the stern seat to the bow, a thwart, a basket for the catch
    const wood = new MeshBuilder();
    buildHull(wood, DINGHY, { tar: rgb('#2b2119'), top: rgb('#5c4b38'), band: rgb('#6e2e24'), wet: true }, 0);
    const deck = hullStation(DINGHY, STAND_AT).keel + 0.1;
    // each board as wide as the hull is at its height there, so none shows through her planking
    for (let s = 0.2; s <= 0.82; s += 0.155) {
      const z = (s - 0.5) * DINGHY.len;
      const w = Math.min(hullHalfWidthAt(DINGHY, s - 0.05, deck + 0.02), hullHalfWidthAt(DINGHY, s + 0.05, deck + 0.02)) * 2 - 0.04;
      if (w > 0.1) wood.add(new BoxGeometry(w, 0.03, 0.6), new Matrix4().makeTranslation(0, deck, z), scaleRgb(rgb('#6b573e'), rng.range(0.85, 1.05)));
    }
    const seat = hullStation(DINGHY, 0.4);
    wood.add(new BoxGeometry(seat.hb * 2 - 0.04, 0.04, 0.22), new Matrix4().makeTranslation(0, seat.sheer - 0.1, (0.4 - 0.5) * DINGHY.len), rgb('#5a4733'));
    this.boat.add(new Mesh(wood.build(), patchMaterial(new MeshStandardMaterial({ vertexColors: true, roughness: 0.85 }), { grime: 0.35 })));
    basket.position.set(-0.18, deck, (0.48 - 0.5) * DINGHY.len);
    this.boat.add(basket);

    // the bamboo pole she is tied to, planted in the bed off her stern, and its rope
    const back = new Vector3(0, 0, -DINGHY.len * 0.5 - 0.5).applyAxisAngle(new Vector3(0, 1, 0), place.yaw).add(new Vector3(place.x, 0, place.z));
    const bed = terrainHeight(back.x, back.z);
    const pole = new Mesh(
      new CylinderGeometry(0.03, 0.04, WATER_LEVEL + 2.4 - bed, 6).translate(0, (WATER_LEVEL + 2.4 - bed) / 2, 0),
      patchMaterial(new MeshStandardMaterial({ color: '#9c8c5c', roughness: 0.7 }), { grime: 0.4 }),
    );
    pole.position.set(back.x, bed, back.z);
    pole.name = 'pole';
    pole.rotation.set(0.05, 0, -0.06);
    this.group.add(pole);
    const rope = new Mesh(new CylinderGeometry(0.008, 0.008, 0.75, 4).rotateX(Math.PI / 2), new MeshStandardMaterial({ color: '#5a4c36', roughness: 0.9 }));
    rope.position.set(0, DINGHY.sheerMid + DINGHY.sheerRise * 0.6, -DINGHY.len * 0.5 - 0.15);
    this.boat.add(rope);
    return new Vector3(0, deck, (STAND_AT - 0.5) * DINGHY.len);
  }

  /** Sets the cast `t` s in (0: holding the net, about to wind up; the throw comes at `T.release`). */
  cue(t: number): void {
    this.time = ((t % T.cycle) + T.cycle) % T.cycle;
    this.splashed = this.time > T.land;
  }

  /** `eye`: the camera; `t` the clock (s). Posed only while the camera is near enough to see it. */
  update(dt: number, t: number, eye: Vector3): void {
    if (Math.hypot(eye.x - this.site.x, eye.z - this.site.z) > 420) return;
    this.time += dt;
    if (this.time >= T.cycle) {
      this.time -= T.cycle;
      this.splashed = false;
    }
    const level = this.site.water ?? WATER_LEVEL + waterRise();
    if (this.afloat) this.floatBoat(t, level);
    this.poseCast(this.time, level);
    // the man: his weight on the boards, the wind past him
    windAt(this.site.x, this.site.z, this.air);
    const c = Math.cos(this.site.yaw);
    const s = Math.sin(this.site.yaw);
    this.wind.set(this.air.x * c - this.air.z * s, 0, this.air.x * s + this.air.z * c);
    this.tilt.rotX = this.boat.rotation.x;
    this.tilt.rotZ = this.boat.rotation.z;
    this.man.update(dt, t, this.drive, this.pose, this.tilt, this.wind, this.gravity);
    this.layNet(t);
    this.layLine();
    this.layCatch(t);
  }

  /** She rides the sheltered ripples where she lies, and heels a little under his swing and his hauling. */
  private floatBoat(t: number, level: number): void {
    const b = this.boat;
    waveSlope(this.site.x, this.site.z, t, this.slope, SHELTERED);
    b.position.y = level + FLOAT + waveHeight(this.site.x, this.site.z, t, SHELTERED);
    const c = Math.cos(this.site.yaw);
    const s = Math.sin(this.site.yaw);
    // the slopes along her and across her, and his weight (crew is in her frame: x across, z along)
    const along = this.slope.x * s + this.slope.z * c;
    const across = this.slope.x * c - this.slope.z * s;
    b.rotation.x = Math.atan(along) * 0.8 + this.man.crew.z * 0.02;
    b.rotation.z = -Math.atan(across) * 0.8 - this.man.crew.x * 0.06;
  }

  /** A point in front of him, turned with his chest (`twist`): his hands' places, in the boat's frame. */
  private bodyPoint(x: number, y: number, z: number, twist: number, out: Vector3): Vector3 {
    const a = twist * 0.85;
    return out.set(x * Math.cos(a) + z * Math.sin(a), y, -x * Math.sin(a) + z * Math.cos(a)).add(this.stance);
  }

  /** His body and hands, and the net's crown and shape, `t` s into the cast. */
  private poseCast(t: number, level: number): void {
    const [right, left] = this.pose.holds;
    const d = this.drive;
    let twist = 0;
    d.lean = 0;
    right.thumb.set(0, 1, 0);
    left.thumb.set(0, 1, 0);
    if (t < T.windup || t >= T.emptied) {
      // holding the net gathered on his arms (and gathering it again after the catch), breathing, ready
      const g = t >= T.emptied ? 1 - ease(span(t, T.emptied, T.emptied + 1.5)) : 0;
      const work = t >= T.emptied ? Math.sin(t * 5.5) * 0.05 * (1 - span(t, T.cycle - 1.2, T.cycle)) : 0;
      d.bend = 0.15 + 0.2 * g;
      d.crouch = 0.05 + 0.04 * g;
      d.shift = 0;
      this.bodyPoint(-0.2 + work, 0.92 - 0.1 * g, 0.28, 0, right.at);
      this.bodyPoint(0.14, 1.12 - 0.2 * g - work, 0.3, 0, left.at);
      this.length = lerp(NET.gathered, 0.5, g);
      this.open = 0;
      this.cup = 0;
      this.netFromHand(right.at);
    } else if (t < T.release) {
      // winding round to his right, then the swing: round and out, the net flung from his hands as they come forward
      const w = ease(span(t, T.windup, T.swing));
      const sw = span(t, T.swing, T.release + 0.15);
      const swing = sw * sw * (3 - 2 * sw);
      twist = lerp(-0.85 * w, 0.55, swing);
      d.bend = 0.25 + 0.1 * swing;
      d.crouch = 0.05 + 0.07 * w - 0.04 * swing;
      d.shift = -0.05 * w + 0.17 * swing;
      this.bodyPoint(-0.32 + 0.17 * swing, 0.95 + 0.3 * swing, 0.25 + 0.35 * swing, twist, right.at);
      this.bodyPoint(-0.05 + 0.17 * swing, 1.1 + 0.2 * swing, 0.3 + 0.3 * swing, twist, left.at);
      this.length = NET.gathered;
      this.open = 0.08 * swing;
      this.cup = 0;
      this.netFromHand(right.at);
      this.boat.localToWorld(this.released.copy(right.at));
    } else {
      // after the throw: arms out and down, the line taken up in both hands; then the hauling, the lift and the catch
      const after = span(t, T.release, T.grab);
      if (t < T.grab) {
        twist = lerp(0.55, 0, ease(after));
        d.bend = lerp(0.35, 0.15, after);
        d.crouch = 0.05;
        d.shift = lerp(0.12, 0, after);
        this.bodyPoint(lerp(-0.1, 0.0, after), lerp(1.25, 1.0, ease(after)), lerp(0.6, 0.42, after), twist, right.at);
        this.bodyPoint(lerp(0.12, 0.12, after), lerp(1.2, 0.98, ease(after)), lerp(0.55, 0.28, after), twist, left.at);
      } else if (t < T.haul) {
        // waiting for the weights to close it, the line in his hands
        const breathe = Math.sin(t * 1.6) * 0.012;
        d.bend = 0.15;
        d.crouch = 0.05;
        d.shift = 0;
        this.bodyPoint(0.0, 1.0 + breathe, 0.42, 0, right.at);
        this.bodyPoint(0.12, 0.98 + breathe, 0.28, 0, left.at);
      } else if (t < T.haul + T.pull * T.pulls) {
        // hand over hand: one hand reaches forward down the line and draws it back while the other goes forward
        const k = (t - T.haul) / T.pull;
        const f = k - Math.floor(k);
        const odd = Math.floor(k) % 2 === 1;
        const back = ease(span(f, 0, 0.6));
        const fore = ease(span(f, 0.6, 1));
        const puller = odd ? left : right;
        const other = odd ? right : left;
        const ps = odd ? 1 : -1;
        this.bodyPoint(ps * lerp(0.02, 0.2, back) * (1 - fore), lerp(0.88, 1.12, back) - 0.24 * fore, lerp(0.62, 0.12, back) + 0.5 * fore, 0, puller.at);
        this.bodyPoint(-ps * lerp(0.2, 0.02, back), lerp(1.12, 0.88, back), lerp(0.12, 0.62, back), 0, other.at);
        twist = ps * 0.12 * Math.sin(Math.PI * back);
        d.bend = 0.3 + 0.12 * Math.sin(Math.PI * f);
        d.crouch = 0.08;
        d.shift = 0.04;
      } else if (t < T.raised) {
        // the bag up over the bow, both hands on its neck
        const u = ease(span(t, T.haul + T.pull * T.pulls, T.raised));
        d.bend = lerp(0.35, 0.2, u);
        d.crouch = 0.06;
        d.shift = 0.08;
        this.bodyPoint(-0.08, lerp(0.95, 1.45, u), lerp(0.62, 0.48, u), 0, right.at);
        this.bodyPoint(0.08, lerp(0.95, 1.45, u), lerp(0.62, 0.48, u), 0, left.at);
      } else {
        // swung in to his left and laid on the boards, then shaken so the catch falls out
        const u = ease(span(t, T.raised, T.laid));
        const shake = t > T.laid ? Math.sin(t * 19) * 0.06 : 0;
        twist = 0.45 * u;
        d.bend = lerp(0.2, 0.5, u);
        d.crouch = lerp(0.06, 0.14, u);
        d.shift = 0.04;
        this.bodyPoint(lerp(-0.08, 0.28, u), lerp(1.45, 0.78, u) + shake, lerp(0.48, 0.3, u), twist, right.at);
        this.bodyPoint(lerp(0.08, 0.42, u), lerp(1.45, 0.8, u) + shake, lerp(0.48, 0.28, u), twist, left.at);
      }
      this.netAfterThrow(t, level);
    }
    d.twist = twist;
  }

  /** The net hanging gathered from his hand. */
  private netFromHand(hand: Vector3): void {
    this.boat.localToWorld(this.crown.copy(hand)).y -= 0.05;
    this.spin = 0;
    this.lean = 0;
  }

  /** The net after it leaves his hands: in the air, on the water and sinking, hauled in and lifted out. */
  private netAfterThrow(t: number, level: number): void {
    const out = this.landingPoint(level);
    if (t < T.land) {
      // flying: the crown on its arc, the net opening into its circle as it goes, spinning, leaning back toward him
      const f = span(t, T.release, T.land);
      this.crown.lerpVectors(this.released, out, f);
      this.crown.y = lerp(this.released.y, level + 0.25, f) + 4 * CAST.apex * f * (1 - f);
      this.open = 1 - Math.pow(1 - smoothstep(0.02, 0.7, f), 2);
      this.cup = lerp(0.45, 0.2, f);
      this.length = NET.length;
      this.spin = 2.4 * (1 - Math.pow(1 - f, 2));
      this.lean = 0.65 * (1 - f);
      return;
    }
    if (!this.splashed) {
      // it falls on the water: a ring of splashes round its rim
      this.splashed = true;
      this.bed = terrainHeight(out.x, out.z);
      this.fish.ring(this.v.copy(out).setY(level), NET.radius * 2.2);
      this.fish.ring(this.v.copy(out).setY(level), NET.radius * 1.2);
    }
    this.lean = 0;
    this.spin = 2.4;
    const haulEnd = T.haul + T.pull * T.pulls;
    if (t < T.haul) {
      // the weights carry the rim down; the crown stays near the surface on the line
      const u = ease(span(t, T.land, T.haul));
      this.crown.copy(out).setY(level - 0.05);
      this.open = lerp(1, 0.88, u);
      this.cup = lerp(0.2, Math.min(1.6, level - this.bed - 0.1), u);
      this.length = NET.length;
      return;
    }
    // the bow, where he draws the crown to and lifts it out
    const bow = this.boat.localToWorld(this.v2.set(0, 0, this.afloat ? DINGHY.len * 0.5 + 0.2 : 0.9));
    if (t < haulEnd) {
      // each pull draws it a step nearer, the rim closing under it first; the last lifts the crown clear
      const k = (t - T.haul) / T.pull;
      const steps = Math.floor(k) + ease(span(k - Math.floor(k), 0, 0.6));
      const near = steps / T.pulls;
      this.crown.lerpVectors(out, bow, near);
      this.crown.y = level - 0.05 + 0.75 * smoothstep(0.75, 1, near);
      this.open = lerp(0.88, 0, ease(span(t, T.haul, T.haul + 2.2)));
      this.cup = Math.min(1.6, level - this.bed - 0.1);
      this.length = NET.length;
      if (near > 0.8) this.drip(t, level);
      return;
    }
    // lifted: the crown between his hands, the full bag hanging below it, shorter as it is laid on the boards
    const [right, left] = this.pose.holds;
    this.hands.addVectors(right.at, left.at).multiplyScalar(0.5);
    this.boat.localToWorld(this.crown.copy(this.hands)).y -= 0.04;
    this.open = 0;
    this.cup = 0;
    const floor = this.boat.position.y + this.stance.y;
    this.length = clamp(this.crown.y - floor - 0.05, 0.25, NET.length * 0.8);
    if (t < T.raised) this.drip(t, level);
  }

  /** Where the net falls: ahead of his feet, along her bow. */
  private landingPoint(level: number): Vector3 {
    this.landing.set(Math.sin(this.site.yaw), 0, Math.cos(this.site.yaw)).multiplyScalar(CAST.reach + (this.afloat ? DINGHY.len * (STAND_AT - 0.5) : 0));
    return this.landing.add(this.v.set(this.site.x, level, this.site.z));
  }

  /** Water running out of the lifted net: small rings under it now and then. */
  private drip(t: number, level: number): void {
    if (t < this.nextDrip && t > this.nextDrip - 1) return;
    this.nextDrip = t + 0.3;
    this.fish.ring(this.v.copy(this.crown).setY(level), 0.9);
  }

  /** Lays the net's rings and spokes for its state now, and its weighted rim. */
  private layNet(t: number): void {
    const R = NET.radius;
    const pos = this.netPos;
    const flying = this.lean > 0.001;
    // the lean: the spread net tilts back toward him in the air, about the line across his throw
    this.axis.set(Math.cos(this.site.yaw), 0, -Math.sin(this.site.yaw));
    this.q.setFromAxisAngle(this.axis, -this.lean);
    const sunk = this.splashed;
    for (let i = 0; i <= NET.rings; i++) {
      const r = i / NET.rings;
      // gathered it hangs as a bag from its crown; spread it is a shallow bell, its rim lowest
      const bagR = 0.04 + 0.15 * Math.sin(Math.PI * Math.min(r, 0.96)) * (0.6 + 0.4 * this.length / NET.length) + 0.04 * r;
      const rho = lerp(bagR, R * r * (1 - 0.1 * this.cup / 1.6), this.open);
      const h0 = lerp(-this.length * r, -this.cup * Math.pow(r, 1.6), this.open);
      for (let j = 0; j < NET.spokes; j++) {
        const a = (j / NET.spokes) * Math.PI * 2 + this.spin;
        // the twine ripples a little as it flies, and hangs unevenly in the bag
        const wob = flying ? 0.07 * Math.sin(3 * a + 7 * r - t * 9) * r : 0.03 * Math.sin(5 * a + 3 * r) * r * (1 - this.open);
        this.v.set(Math.cos(a) * rho, h0 + wob, Math.sin(a) * rho);
        if (flying) this.v.applyQuaternion(this.q);
        this.v.add(this.crown);
        // never through the bed, nor (sunk or in the bag over the bow) far into the boat
        if (sunk) this.v.y = Math.max(this.v.y, this.bed + 0.04);
        pos.set([this.v.x, this.v.y, this.v.z], (i * NET.spokes + j) * 3);
      }
    }
    const geo = this.net.geometry;
    geo.attributes.position.needsUpdate = true;
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
    // the rim's rope along the outermost ring, a little thick for its weights
    const base = NET.rings * NET.spokes;
    for (let j = 0; j <= NET.spokes; j++) {
      const k = (base + (j % NET.spokes)) * 3;
      for (let c = 0; c < 3; c++) {
        const a = (c / 3) * Math.PI * 2;
        this.rimPos.set([pos[k] + Math.cos(a) * 0.016, pos[k + 1] + Math.sin(a) * 0.016, pos[k + 2]], (j * 3 + c) * 3);
      }
    }
    this.rim.geometry.attributes.position.needsUpdate = true;
  }

  /** The hand line from his left hand to the crown: slack while it flies out, taut as he hauls; coiled on his wrist otherwise. */
  private layLine(): void {
    const t = this.time;
    const shown = t >= T.release && t < T.haul + T.pull * T.pulls;
    this.line.visible = shown;
    if (!shown) return;
    const hand = this.boat.localToWorld(this.v2.copy(this.pose.holds[1].at));
    const sag = t < T.land ? 0.5 : t < T.haul ? 0.25 : 0.04;
    const n = 14;
    for (let i = 0; i < n; i++) {
      const f = i / (n - 1);
      this.v.lerpVectors(hand, this.crown, f);
      this.v.y -= sag * 4 * f * (1 - f);
      for (let c = 0; c < 3; c++) {
        const a = (c / 3) * Math.PI * 2;
        this.linePos.set([this.v.x + Math.cos(a) * 0.006, this.v.y + Math.sin(a) * 0.006, this.v.z], (i * 3 + c) * 3);
      }
    }
    this.line.geometry.attributes.position.needsUpdate = true;
  }

  /** The fish: in the bottom of the bag as it comes up, then on the boards, flapping, till they go in the basket. */
  private layCatch(t: number): void {
    const time = this.time;
    const haulEnd = T.haul + T.pull * T.pulls;
    const inBag = time > haulEnd - 1.2 && time < T.laid + 0.4;
    const onBoards = time >= T.laid + 0.4 && time < T.cycle - 0.4;
    this.catchFish.forEach((m, i) => {
      const spot = this.fishSpots[i];
      m.visible = inBag || onBoards;
      if (!m.visible) return;
      const flap = Math.sin(t * 14 + spot.beat) * (onBoards ? 0.5 * Math.max(0, Math.sin(t * 1.3 + spot.beat)) : 0.35);
      if (inBag) {
        // low in the bag, bunched
        m.position.copy(this.crown);
        m.position.x += spot.u * 0.35;
        m.position.z += spot.v * 0.35;
        m.position.y -= this.length * 0.85 + 0.05;
        m.rotation.set(Math.PI / 2 - 0.3, spot.turn, flap);
      } else {
        // on the boards by his left foot
        this.v.set(0.32 + spot.u, this.stance.y + 0.04, this.stance.z - 0.1 + spot.v * 1.5);
        this.boat.localToWorld(this.v);
        m.position.copy(this.v);
        m.rotation.set(0, this.site.yaw + spot.turn, Math.PI / 2 + flap);
      }
    });
  }
}
