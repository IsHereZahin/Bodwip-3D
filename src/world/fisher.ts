import { BoxGeometry, BufferAttribute, BufferGeometry, CylinderGeometry, DoubleSide, Group, LatheGeometry, LineBasicMaterial, LineSegments, Matrix4, Mesh, MeshBasicMaterial, MeshStandardMaterial, PlaneGeometry, Quaternion, Vector2, Vector3, type Vector4 } from 'three';
import { LAYER_NO_REFLECT } from '../core/globals';
import { clamp, lerp, smoothstep } from '../core/mathx';
import { Rng } from '../core/rng';
import { windAt } from '../env/wind';
import { MeshBuilder, rgb, scaleRgb } from '../render/builder';
import { patchMaterial } from '../render/patch';
import { castNetTexture, softSpotTexture, weaveTexture } from '../render/textures';
import { Boatman, type OarPose, type Outfit } from './boatman';
import type { HumanName } from './humanData';
import { fishGeometry } from './fish';
import type { Ripples } from './ripples';
import { WATER_LEVEL, terrainHeight, waterRise } from './geography';
import { buildHull, hullHalfWidthAt, hullStation, type HullShape } from './hull';
import type { BodyDrive } from './paddle';
import { FISHER_NEAR } from './plan';
import { RIVER } from './waterways';
import { surfaceShare, waveHeight, waveSlope } from './waves';

// The fisherman with his cast net (ঝাঁকি জাল) on the river below where the khal comes in (the user asked for
// a fisherman catching fish with a net). His dinghy is tied to a bamboo pole planted in the bed; he stands in
// her bow with the net gathered over his arm, winds his body round to the right, and swings: the net leaves
// his hands as a bundle and opens in the air into a wide circle, spinning, its weighted rim dropping first,
// and falls flat on the water, its weighted rim striking all round in a ring of splashes that sends ripples out
// over the open water and in under the mesh (the water shader, from `bindWater`'s uniforms: the water moves
// because the net moved it). The weights carry the rim down while he holds the line, so it closes over the fish
// like a bell; he hauls it in hand over hand, sitting back into each pull as the dinghy dips her bow, the rim
// drawn together under the water and stirring it as it comes; draws the bag up out of the water at the bow,
// water pouring and dripping from it and the fish in its bottom showing, swings it in, lays it in the boat and
// shakes the catch out, a few silver fish flapping on the boards, and gathers the net for the next cast. No two
// casts fall quite alike. His body is the boatman's (human.ts) in his own clothes, his hands on the net's neck
// or the line (boatman.ts holds); the net is a mesh of rings and spokes laid each frame from where the cast has got to.

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
 * leaving his hands, its landing, taking up the line while it sinks, hauling (six pulls, hand over hand), the bag
 * drawn up out of the water at the bow (raised), swung in and laid in the boat, the catch shaken out, the net
 * gathered again.
 */
const T = { windup: 1.6, swing: 2.9, release: 3.3, through: 3.45, land: 4.6, grab: 5.2, haul: 7.8, pull: 1.4, pulls: 6, raised: 18.6, laid: 20.0, emptied: 21.4, cycle: 25 };
/** When the last pull ends and the bag starts up out of the water. */
const HAUL_END = T.haul + T.pull * T.pulls;
/** Drops running off the lifted net. */
const DRIPS = 56;
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
  private readonly ripples: Ripples;
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
  private splashed = false;
  /** This cast's own: how far off his line (m) and how much further or shorter the net falls, how wide it opens, its spin and seed. */
  private cast = { side: 0, reach: 0, spread: 1, spin: 0, seed: 0 };
  private casts = 0;
  /** How hard he is heaving on the line now (0..1), which dips her bow. */
  private heave = 0;
  /** The water the net stirs: the shader's uniforms for it (world/water.ts), once bound. */
  private water: { a: Vector4; b: Vector4 } | null = null;
  private readonly drips: LineSegments;
  private readonly dripPos: Float32Array;
  private readonly dripVel = new Float32Array(DRIPS);
  private dripOwed = 0;
  private readonly dripRng = new Rng(131);

  // scratch
  private readonly v = new Vector3();
  private readonly v2 = new Vector3();
  private readonly hands = new Vector3();
  private readonly q = new Quaternion();
  private readonly axis = new Vector3();

  constructor(ripples: Ripples, place: FisherPlace = SITE) {
    this.ripples = ripples;
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
    // bareheaded at his net, his mathal set down: in the dinghy flat on the boards abaft the thwart, on the
    // middle line where she is wide enough for it (clear of the basket and the catch); on a bund on the ground at
    // his right, clear of his basket
    const hat = this.man.hat;
    if (hat) {
      if (!this.afloat) hat.position.set(this.stance.x - 0.75, this.stance.y + 0.02, this.stance.z + 0.25);
      else hat.position.set(0, this.stance.y + 0.03, -1.0);
      hat.rotation.set(0.04, 0.6, 0);
    }
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
        // (one pass for both its faces: a veil of twine needs no back-to-front pair, whose second program was first
        // compiled when the net first came into view)
        new MeshStandardMaterial({ map: castNetTexture(), color: '#d6cfbb', vertexColors: true, transparent: true, depthWrite: false, side: DoubleSide, forceSinglePass: true, roughness: 0.8 }),
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
    this.rim.frustumCulled = false;
    this.rim.renderOrder = -2;
    // (the line is up out of the water: after it)
    this.line.frustumCulled = false;
    this.line.renderOrder = 1;
    this.group.add(this.net, this.rim, this.line);
    // the drops running off the net as it comes up: short streaks falling to the water
    this.dripPos = new Float32Array(DRIPS * 6).fill(-1e4);
    const dripGeo = new BufferGeometry();
    dripGeo.setAttribute('position', new BufferAttribute(this.dripPos, 3));
    this.drips = new LineSegments(dripGeo, new LineBasicMaterial({ color: '#dfe7ea', transparent: true, opacity: 0.55, depthWrite: false }));
    this.drips.frustumCulled = false;
    this.group.add(this.drips);
    this.newCast();

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
    // (two-sided: her hull's inside is its back face, world/hull.ts)
    this.boat.add(new Mesh(wood.build(), patchMaterial(new MeshStandardMaterial({ vertexColors: true, roughness: 0.85, side: DoubleSide }), { grime: 0.35 })));
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
    this.newCast();
    // where the net left his hands (known from the swing; put in here, for a cue past it)
    this.boat.updateMatrixWorld(true);
    this.boat.localToWorld(this.released.copy(this.stance).add(this.v.set(-0.15, 1.6, 0.6)));
  }

  /** The water's uniforms for the net he casts (world/water.ts `nets`: the middle and reach of what it stirs, and how). */
  bindWater(a: Vector4, b: Vector4): void {
    this.water = { a, b };
  }

  /** Hides what the net stirs (he is not casting where anyone can see). */
  stillWater(): void {
    this.water?.a.set(0, 0, 0, 0);
    this.water?.b.set(0, 0, 0, 0);
  }

  /** A fresh cast: a little off his line, a little further or shorter, wider or narrower, its own spin. */
  private newCast(): void {
    this.casts++;
    const h = (k: number) => {
      const x = Math.sin(this.casts * 12.9898 + k * 78.233 + this.site.x * 0.37) * 43758.5453;
      return x - Math.floor(x);
    };
    this.cast = { side: (h(1) - 0.5) * 1.0, reach: (h(2) - 0.5) * 0.7, spread: 0.93 + 0.12 * h(3), spin: h(4) * Math.PI * 2, seed: h(5) * 97 };
  }

  /**
   * `eye`: the camera (and `also`, a shot's still dissolving away, or null); `t` the clock (s). Posed only while a
   * camera is near enough to see it.
   */
  update(dt: number, t: number, eye: Vector3, also: Vector3 | null = null): void {
    const far = (p: Vector3) => Math.hypot(p.x - this.site.x, p.z - this.site.z) > 420;
    if (far(eye) && (!also || far(also))) return;
    this.time += dt;
    if (this.time >= T.cycle) {
      this.time -= T.cycle;
      this.splashed = false;
      this.newCast();
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
    this.layDrips(dt, level);
    // drawn after the water while any of it is up in the air (the water writes its depth: what is under it is
    // hidden, what is above shows; drawn before it, the water covered the flying net), before it while it lies
    // sunk, so it shows through the water
    const up = this.time < T.land || this.time >= HAUL_END;
    this.net.renderOrder = this.rim.renderOrder = up ? 1 : -2;
  }

  /** She rides the sheltered ripples where she lies, and heels a little under his swing and his hauling. */
  private floatBoat(t: number, level: number): void {
    const b = this.boat;
    // (the waves as the surface round her is drawn: still water, the share inland water carries)
    const share = surfaceShare(level - terrainHeight(this.site.x, this.site.z), 0);
    waveSlope(this.site.x, this.site.z, t, this.slope, share);
    b.position.y = level + FLOAT + waveHeight(this.site.x, this.site.z, t, share);
    const c = Math.cos(this.site.yaw);
    const s = Math.sin(this.site.yaw);
    // the slopes along her and across her, and his weight (crew is in her frame: x across, z along)
    const along = this.slope.x * s + this.slope.z * c;
    const across = this.slope.x * c - this.slope.z * s;
    b.rotation.x = Math.atan(along) * 0.8 + this.man.crew.z * 0.02 + this.heave * 0.018;
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
    this.heave = 0;
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
      } else if (t < HAUL_END) {
        // hand over hand: each pull one hand, reached forward and down the line out over the bow, draws it back to
        // his hip while the other goes forward over it for the next. He reaches with his weight forward and
        // sits back into the draw, knees giving under the heave, his chest turning a little with the pulling arm;
        // between pulls the net glides on and stops (its crown moves in surges, netAfterThrow)
        const k = (t - T.haul) / T.pull;
        const f = k - Math.floor(k);
        const odd = Math.floor(k) % 2 === 1;
        const puller = odd ? left : right;
        const reacher = odd ? right : left;
        const ps = odd ? 1 : -1;
        const draw = ease(span(f, 0.08, 0.78));
        const heave = Math.sin(Math.PI * span(f, 0.08, 0.78));
        // his body: back with the draw, forward again as the next reach comes (continuous from pull to pull)
        const back = f < 0.78 ? draw : 1 - ease(span(f, 0.78, 1));
        this.bodyPoint(ps * lerp(0.06, 0.2, draw), lerp(0.84, 0.97, draw), lerp(0.74, 0.06, draw), 0, puller.at);
        const go = ease(span(f, 0.05, 0.9));
        this.bodyPoint(-ps * lerp(0.2, 0.06, go), lerp(0.97, 0.84, go) + 0.12 * Math.sin(Math.PI * go), lerp(0.06, 0.74, go), 0, reacher.at);
        // (the hand drawing faces down the line, its thumb along it; the reaching one turned over to take it)
        puller.thumb.set(0, 0.3, 1).normalize();
        reacher.thumb.set(0, 0.6, 1).normalize();
        twist = ps * 0.16 * heave;
        d.bend = 0.42 - 0.32 * back + 0.04 * heave;
        d.crouch = 0.07 + 0.08 * heave;
        d.shift = 0.08 - 0.16 * back;
        this.heave = heave;
      } else if (t < T.raised) {
        // the bag drawn up out of the water at the bow, hand over hand straight up, gathering the net into his
        // hands as it comes: he straightens and leans back against its weight
        const u = ease(span(t, HAUL_END, T.raised));
        const k = (t - HAUL_END) / 0.6;
        const f = k - Math.floor(k);
        const odd = Math.floor(k) % 2 === 1;
        const lift = ease(span(f, 0.1, 0.8));
        const high = lerp(0.95, 1.4, u);
        this.bodyPoint(-0.09, high + (odd ? 0.08 * lift : 0.08 * (1 - lift)), lerp(0.66, 0.5, u), 0, right.at);
        this.bodyPoint(0.09, high + (odd ? 0.08 * (1 - lift) : 0.08 * lift), lerp(0.66, 0.5, u), 0, left.at);
        d.bend = lerp(0.38, 0.12, u);
        d.crouch = lerp(0.12, 0.07, u);
        d.shift = lerp(0.06, -0.04, u);
        this.heave = 0.5 * (1 - u);
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
      this.spin = this.cast.spin + 2.4 * (1 - Math.pow(1 - f, 2));
      this.lean = 0.65 * (1 - f);
      this.say(0, 0, 0, 0, 0, 0, 0);
      return;
    }
    if (!this.splashed) {
      // it falls on the water: its weighted rim strikes all round at once (the water shader rings it out from there)
      this.splashed = true;
      this.bed = terrainHeight(out.x, out.z);
    }
    const R = NET.radius * this.cast.spread;
    const age = t - T.land;
    this.lean = 0;
    this.spin = this.cast.spin + 2.4;
    if (t < T.haul) {
      // the weights carry the rim down; the crown stays near the surface on the line
      const u = ease(span(t, T.land, T.haul));
      this.crown.copy(out).setY(level - 0.05);
      this.open = lerp(1, 0.88, u);
      this.cup = lerp(0.2, Math.min(1.6, level - this.bed - 0.1), u);
      this.length = NET.length;
      this.say(out.x, out.z, R * this.open, age, 1 - span(age, 0, 1.6), 0, 0);
      return;
    }
    // the bow, where he draws the crown to and lifts it out
    const bow = this.boat.localToWorld(this.v2.set(0, 0, this.afloat ? DINGHY.len * 0.5 + 0.2 : 0.9));
    if (t < HAUL_END) {
      // each pull draws it a surge nearer (gliding on a little, then stopping), the rim closing under it first,
      // dragging under the surface; it comes up to it as it reaches the bow
      const k = (t - T.haul) / T.pull;
      const steps = Math.floor(k) + ease(span(k - Math.floor(k), 0.08, 0.85));
      const near = steps / T.pulls;
      this.crown.lerpVectors(out, bow, near);
      this.crown.y = level - 0.05 + 0.15 * smoothstep(0.85, 1, near);
      this.open = lerp(0.88, 0, ease(span(t, T.haul, T.haul + 3.2)));
      this.cup = lerp(Math.min(1.6, level - this.bed - 0.1), 0.9, smoothstep(0.5, 1, near));
      this.length = NET.length;
      this.say(this.crown.x, this.crown.z, Math.max(0.45, R * this.open), age, 0, 0.35 + 0.65 * this.heave, 0);
      return;
    }
    if (t < T.raised) {
      // drawn up at the bow: the crown rising between his hands, the net gathered into them as it comes, so the
      // bag below it rises out of the water, pouring
      const [right, left] = this.pose.holds;
      this.hands.addVectors(right.at, left.at).multiplyScalar(0.5);
      this.boat.localToWorld(this.v.copy(this.hands));
      const u = ease(span(t, HAUL_END, T.raised));
      this.crown.lerpVectors(this.v2.setY(level + 0.15), this.v, u);
      this.crown.y -= 0.04;
      this.open = 0;
      this.cup = 0;
      this.length = lerp(NET.length, 1.0, u);
      const out = Math.max(0, this.crown.y - level) / this.length;
      this.say(this.crown.x, this.crown.z, 0.4, 99, 0, 0.3 * (1 - u), Math.min(1, out * 1.5));
      return;
    }
    // swung in: the crown between his hands, the bag hanging below it, shorter as it is laid on the boards
    const [right, left] = this.pose.holds;
    this.hands.addVectors(right.at, left.at).multiplyScalar(0.5);
    this.boat.localToWorld(this.crown.copy(this.hands)).y -= 0.04;
    this.open = 0;
    this.cup = 0;
    const floor = this.boat.position.y + this.stance.y;
    this.length = clamp(this.crown.y - floor - 0.05, 0.25, 1.0);
    // the last of the water running off it over the side as it swings in
    const over = 1 - span(t, T.raised, T.raised + 0.9);
    this.say(this.crown.x, this.crown.z, 0.4, 99, 0, 0, over * 0.6);
  }

  /**
   * Tells the water what the net is doing to it: where (the middle and reach of what it covers), how long since it
   * struck (s), the strike's strength, how hard it is being hauled through, how much water is running off it.
   */
  private say(x: number, z: number, reach: number, age: number, strike: number, pull: number, pour: number): void {
    if (!this.water) return;
    this.water.a.set(x, z, reach, age);
    this.water.b.set(strike, pull, pour, this.cast.seed);
  }

  /** Drops running off the net while it is up out of the water: from its lower part, falling to the surface. */
  private layDrips(dt: number, level: number): void {
    const t = this.time;
    const pouring = t >= HAUL_END && t < T.raised + 1.2 && this.afloat;
    const pos = this.dripPos;
    this.drips.visible = pouring || this.dripVel.some((v) => v !== 0);
    if (!this.drips.visible) return;
    if (pouring) this.dripOwed += dt * 70 * (1 - 0.6 * span(t, T.raised, T.raised + 1.2));
    for (let i = 0; i < DRIPS; i++) {
      const o = i * 6;
      if (this.dripVel[i] === 0) {
        if (this.dripOwed < 1) continue;
        // from a knot in the lower half of the bag, if it is out of the water
        const ring = Math.floor(this.dripRng.range(NET.rings * 0.45, NET.rings + 0.99));
        const k = (ring * NET.spokes + Math.floor(this.dripRng.range(0, NET.spokes))) * 3;
        if (this.netPos[k + 1] < level + 0.03) continue;
        this.dripOwed--;
        pos[o] = pos[o + 3] = this.netPos[k];
        pos[o + 1] = this.netPos[k + 1];
        pos[o + 2] = pos[o + 5] = this.netPos[k + 2];
        this.dripVel[i] = -0.2;
        continue;
      }
      this.dripVel[i] -= 9.81 * dt;
      pos[o + 1] += this.dripVel[i] * dt;
      // a streak back up along its fall
      pos[o + 4] = pos[o + 1] + Math.min(0.09, 0.02 + Math.abs(this.dripVel[i]) * 0.012);
      if (pos[o + 1] <= level) {
        // into the water (its patter is the water shader's, under the bag; near the camera each its own ring)
        if (this.dripRng.next() < 0.5) this.ripples.drop(pos[o], pos[o + 2], 0.05, this.dripRng.range(0.002, 0.005));
        this.dripVel[i] = 0;
        pos[o + 1] = pos[o + 4] = -1e4;
      }
    }
    this.dripOwed = Math.min(this.dripOwed, 4);
    this.drips.geometry.attributes.position.needsUpdate = true;
  }

  /** Where the net falls: ahead of his feet, along her bow. */
  private landingPoint(level: number): Vector3 {
    const fx = Math.sin(this.site.yaw);
    const fz = Math.cos(this.site.yaw);
    const reach = CAST.reach + this.cast.reach + (this.afloat ? DINGHY.len * (STAND_AT - 0.5) : 0);
    // (this cast's own: a little off his line, across it)
    this.landing.set(fx * reach + fz * this.cast.side, 0, fz * reach - fx * this.cast.side);
    return this.landing.add(this.v.set(this.site.x, level, this.site.z));
  }

  /** Lays the net's rings and spokes for its state now, and its weighted rim. */
  private layNet(t: number): void {
    const R = NET.radius * this.cast.spread;
    const pos = this.netPos;
    const flying = this.lean > 0.001;
    // the lean: the spread net tilts back toward him in the air, about the line across his throw
    this.axis.set(Math.cos(this.site.yaw), 0, -Math.sin(this.site.yaw));
    this.q.setFromAxisAngle(this.axis, -this.lean);
    const sunk = this.splashed;
    for (let i = 0; i <= NET.rings; i++) {
      const r = i / NET.rings;
      // gathered it hangs as a bag from its crown; spread it is a shallow bell, its rim lowest
      // gathered it hangs as a sack from his hands, narrow at the top, full low down where the leads (drawn
      // together under it) and the fish weigh it; spread it is a shallow bell, its rim lowest
      const bagR = 0.025 + 0.17 * Math.pow(r, 1.3) * (1 - 0.45 * smoothstep(0.86, 1, r)) * (0.65 + 0.35 * this.length / NET.length);
      const rho = lerp(bagR, R * r * (1 - 0.1 * this.cup / 1.6), this.open);
      const h0 = lerp(-this.length * r, -this.cup * Math.pow(r, 1.6), this.open);
      for (let j = 0; j < NET.spokes; j++) {
        const a = (j / NET.spokes) * Math.PI * 2 + this.spin;
        // the twine ripples a little as it flies, and hangs unevenly in the bag
        const wob = flying ? 0.07 * Math.sin(3 * a + 7 * r - t * 9) * r : 0.03 * Math.sin(5 * a + 3 * r) * r * (1 - this.open);
        // bunched, the twine folds unevenly round it
        const fold = 1 + (1 - this.open) * (0.28 * Math.sin(3 * a + 5 * r + this.cast.seed) + 0.16 * Math.sin(7 * a - 3 * r));
        this.v.set(Math.cos(a) * rho * fold, h0 + wob, Math.sin(a) * rho * fold);
        if (flying) this.v.applyQuaternion(this.q);
        this.v.add(this.crown);
        // never through the bed, nor (sunk or in the bag over the bow) far into the boat
        if (sunk) this.v.y = Math.max(this.v.y, this.bed + 0.04);
        const at = (i * NET.spokes + j) * 3;
        pos[at] = this.v.x;
        pos[at + 1] = this.v.y;
        pos[at + 2] = this.v.z;
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
        this.rimPos.set([pos[k] + Math.cos(a) * 0.021, pos[k + 1] + Math.sin(a) * 0.021, pos[k + 2]], (j * 3 + c) * 3);
      }
    }
    this.rim.geometry.attributes.position.needsUpdate = true;
  }

  /** The hand line from his left hand to the crown: slack while it flies out, taut as he hauls; coiled on his wrist otherwise. */
  private layLine(): void {
    const t = this.time;
    const shown = t >= T.release && t < HAUL_END;
    this.line.visible = shown;
    if (!shown) return;
    // (hauling, it runs through the hand furthest out along it, taut while he heaves and easing between pulls)
    const [right, left] = this.pose.holds;
    const lead = t >= T.haul && right.at.z > left.at.z ? right : left;
    const hand = this.boat.localToWorld(this.v2.copy(lead.at));
    const sag = t < T.land ? 0.5 : t < T.haul ? 0.25 : 0.12 - 0.1 * this.heave;
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
    const inBag = time > HAUL_END - 1.2 && time < T.laid + 0.4;
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
