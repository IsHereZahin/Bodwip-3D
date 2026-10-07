import { Matrix4, PerspectiveCamera, Quaternion, Vector3 } from 'three';
import { angleDelta, clamp, damp, lerp, smoothstep } from '../core/mathx';
import type { SeasonState } from '../env/season';
import { BoatBody, type Crew } from '../world/boatPhysics';
import { BRIDGE, JOURNEY, SANKO, bridgeDeck, bridgeFrame, bridgeSoffit, inlandWaterAt, journeyAt, journeyFrame, sankoDeck, sankoFrame, terrainHeight, waterLevelAt, waterwayAt } from '../world/geography';
import { sankoToWorld } from '../world/sites';
import { FlyCam } from './flycam';
import { HANDOFF, OPENING_SECONDS, openingFloor, openingPose, openingSide, roundShare, wayAt, type RestPlace } from './opening';
import { Composer, USUAL, narrowScale, type Moment, type Shot } from './compose';
import { chooseShown, sightWeight, type Sight } from './showcase';
import type { Sightlines } from './sightlines';

/** How far along her way the boatman steers for, m. */
const LOOK_AHEAD = 16;
/** How near the journey's end she is when the mist comes down and she is taken back to its start (m). */
const END_REACH = 25;
const LOOP_FADE = 3;
const IDLE_SECONDS = 7;
const DIST_MIN = 6;
const DIST_MAX = 60;
const PITCH_MIN = -0.04;
const PITCH_MAX = 1.0;
/** How quickly an idle camera turns: slowly for its resting drift, briskly when asked to look. */
const TURN_IDLE = 0.25;
const TURN_ASKED = 1.6;
/** Seconds to ease from the free camera back to the boat. */
const BLEND_SECONDS = 1.4;
/** How often (s) the sights shown by themselves are chosen again, by what each is worth now. */
const CHOOSE_SECONDS = 2;

export interface View {
  yaw: number;
  pitch: number;
  dist: number;
}

/** Viewpoints around the boat. Picked, the camera rests at it; otherwise (`auto`, the default) it composes its own views (compose.ts). */
export const VIEWS = {
  stern: { yaw: 0.32, pitch: 0.12, dist: 14 },
  boatman: { yaw: 1.9, pitch: 0.08, dist: 6.5 },
  bow: { yaw: Math.PI - 0.3, pitch: 0.1, dist: 13 },
  high: { yaw: -1.2, pitch: 0.5, dist: 34 },
} satisfies Record<string, View>;
export type ViewName = keyof typeof VIEWS | 'auto';

/**
 * Where the camera rests after the opening flight, should the viewer pick no view and take the camera: behind her on
 * the flight's side, about where the flight ends (its yaw's sign set by that side: `beginOpening`).
 */
const OPENING_VIEW: View = { yaw: 0.26, pitch: 0.33, dist: 22 };

/**
 * Following the boat under the old bridge, the camera eases down under its arch (or, over the banks, up
 * over its deck) rather than passing through the brickwork.
 */
function keepClearOfBridge(cam: Vector3): void {
  const f = bridgeFrame(cam.x, cam.z);
  const face = BRIDGE.width / 2 + BRIDGE.parapet;
  const s = smoothstep(face + 3, face + 0.4, Math.abs(f.z)) * smoothstep(BRIDGE.half + 3, BRIDGE.half + 1, Math.abs(f.x));
  if (s <= 0) return;
  // the bridge's heights are above the khal's water
  const soffit = bridgeSoffit(f.x);
  if (soffit - 0.6 > 0.8) cam.y = lerp(cam.y, Math.min(cam.y, BRIDGE.water + soffit - 0.6), s);
  else cam.y = lerp(cam.y, Math.max(cam.y, BRIDGE.water + bridgeDeck(f.x) + BRIDGE.parapetHeight + 1.2), s);
}

/**
 * Following the boat under the bamboo sanko, the camera goes through the boats' way under its middle span, below
 * its bracing (or, out over the banks, up over its walkway) rather than through its culms and trestles.
 */
function keepClearOfSanko(cam: Vector3): void {
  const f = sankoFrame(cam.x, cam.z);
  const s = smoothstep(4, 1, Math.abs(f.b)) * smoothstep(SANKO.half + 2, SANKO.half, Math.abs(f.a));
  if (s <= 0) return;
  if (Math.abs(f.a) < SANKO.gap + 1) {
    const w = sankoToWorld(lerp(f.a, clamp(f.a, 0.5 - SANKO.gap, SANKO.gap - 0.5), s), f.b);
    cam.x = w.x;
    cam.z = w.z;
    cam.y = lerp(cam.y, Math.min(cam.y, SANKO.water + sankoDeck(SANKO.gap) - 0.75), s);
  } else cam.y = lerp(cam.y, Math.max(cam.y, SANKO.water + sankoDeck(f.a) + 2.2), s);
}

/** Whether a camera at (x, z) is over the water or close over a bank (not in among the banks' trees). */
function overWater(x: number, z: number): boolean {
  if (inlandWaterAt(x, z)) return true;
  const w = waterwayAt(x, z);
  return w !== null && w.d < w.half + 3;
}

/**
 * Low and close, with a rising or setting sun or moon in the frame beside the boat: turned this far
 * (rad) from it toward her way ahead, so it sits off to the side, not glaring straight down the view.
 */
const WATCH_VIEW = { pitch: 0.05, dist: 14, aside: 0.42 };

/** The camera's yaw (from her course `h`) that frames an event in direction `dir` beside the boat. */
function watchYaw(dir: Vector3, h: number): number {
  const toward = angleDelta(h, Math.atan2(dir.x, dir.z));
  return toward - Math.sign(toward) * Math.min(Math.abs(toward), WATCH_VIEW.aside);
}

export type CameraMode = 'follow' | 'free';

const ORBIT_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Equal', 'Minus', 'NumpadAdd', 'NumpadSubtract']);
const FLY_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'PageUp', 'PageDown']);
const MODIFIERS = new Set(['ShiftLeft', 'ShiftRight']);

/** The boat's journey down the river, up the khal and into the bil, and the camera: an orbit that follows the boat, or a free flyer. */
export class Rig {
  /** The boat as a floating body, paddled along her way. */
  readonly boat = new BoatBody();
  /** 0..1 mist fade while the journey loops back to its start. */
  fade = 0;
  dragging = false;
  mode: CameraMode = 'follow';
  /** A direction to turn toward once nobody is steering (a rising moon, say); null to rest. */
  watch: Vector3 | null = null;
  /** Left to itself the camera composes its own views (the view `auto`, the default), or rests at the view picked. */
  auto = true;
  /** The film or a map place's visit has the camera (main.ts, each frame): the composer only holds its shot. */
  directed = false;
  /** The sky and the season the composed views are made in (main.ts sets them once; they change in place). */
  sky: { sun: Vector3; moon: Vector3; season: SeasonState } | null = null;

  private loopT = -1;
  /** How far along her way she is (m), kept while she is too far off it to say. */
  private along = 0;
  private readonly steerTo = { x: 0, z: 0 };
  private rest: View = OPENING_VIEW;
  private yaw = this.rest.yaw;
  private pitch = this.rest.pitch;
  private dist = this.rest.dist;
  private yawT = this.rest.yaw;
  private pitchT = this.rest.pitch;
  private distT = this.rest.dist;
  private idle = 0;
  private turnRate = TURN_IDLE;
  private blend = 1;
  private readonly fromPos = new Vector3();
  private readonly fromQuat = new Quaternion();
  private readonly toQuat = new Quaternion();
  private readonly pointers = new Map<number, { x: number; y: number }>();
  private pinch = 0;
  private readonly keys = new Set<string>();
  private readonly target = new Vector3();
  private readonly fly = new FlyCam();
  /** The opening flight while it runs: how far into it (s), the side of the river it comes down over, the floor laid for it. */
  private opening: { t: number; side: number; floor: Float32Array } | null = null;
  /**
   * The shot the opening flight hands the camera over in: the composer's usual one (compose.ts `USUAL`) on the
   * flight's side, her on the third away from the camera, so it looks on ahead along her way (on the nearer third
   * the look swung back against the flight's turn as it settled); and where it is in her way's frame (`restAt`).
   */
  private readonly handOver: Shot = { bearing: 0, dist: 0, high: 0, third: 1 };
  private readonly restAt: RestPlace = { a: 0, c: 0, h: 0, focus: 0, wide: 1 };
  /** Her middle, where the opening flight looks round her (as the composer frames her). */
  private readonly herMid = new Vector3();
  private readonly openPos = new Vector3();
  private readonly openLook = new Vector3();
  private readonly openQuat = new Quaternion();
  private readonly endPos = new Vector3();
  private readonly endLook = new Vector3();
  private readonly endQuat = new Quaternion();
  private readonly pathEnd = new Vector3();
  private readonly pathEndLook = new Vector3();
  private readonly lookAt = new Matrix4();
  /** The village's sights along her way (showcase.ts), and the composer of the views left to itself (compose.ts). */
  private sights: readonly Sight[] = [];
  /** What stands where (the trees, the palms, the houses): for the opening flight's floor and the composer. */
  private lines: Sightlines | null = null;
  private composer: Composer | null = null;
  /** Whether the composer has the camera now, and what it is given each frame. */
  private composing = false;
  private moment: Moment | null = null;
  /** Seconds until the sights shown are chosen again. */
  private choosing = 0;
  private readonly showPos = new Vector3();
  private readonly showLook = new Vector3();

  readonly camera: PerspectiveCamera;

  constructor(camera: PerspectiveCamera, element: HTMLElement) {
    this.camera = camera;
    this.place(JOURNEY.opening / JOURNEY.length);
    element.addEventListener('pointerdown', (e) => {
      this.endOpening();
      element.setPointerCapture(e.pointerId);
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      this.dragging = true;
      this.steer();
    });
    element.addEventListener('pointermove', (e) => {
      const prev = this.pointers.get(e.pointerId);
      if (!prev) return;
      if (this.pointers.size === 2) {
        const pts = [...this.pointers.values()];
        const before = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
        prev.x = e.clientX;
        prev.y = e.clientY;
        const after = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
        if (this.pinch > 0) this.zoom(before / Math.max(after, 1));
        this.pinch = after;
      } else {
        const dx = e.clientX - prev.x;
        const dy = e.clientY - prev.y;
        if (this.mode === 'free') this.fly.drag(dx, dy);
        else {
          this.yawT -= dx * 0.005;
          this.pitchT = clamp(this.pitchT + dy * 0.004, PITCH_MIN, PITCH_MAX);
        }
        prev.x = e.clientX;
        prev.y = e.clientY;
      }
      this.steer();
    });
    const end = (e: PointerEvent) => {
      this.pointers.delete(e.pointerId);
      this.pinch = 0;
      this.dragging = this.pointers.size > 0;
    };
    element.addEventListener('pointerup', end);
    element.addEventListener('pointercancel', end);
    element.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        this.endOpening();
        this.steer();
        this.zoom(Math.exp(e.deltaY * 0.0012));
      },
      { passive: false },
    );
  }

  /**
   * Keys routed from the page; only camera keys are kept. Arrows orbit and +/- zoom when following the boat;
   * WASD, Q/E and the arrows fly the free camera. Returns whether the key steers the camera.
   */
  press(code: string, down: boolean): boolean {
    if (!down) {
      this.keys.delete(code);
      return false;
    }
    const steers = (this.mode === 'free' ? FLY_KEYS : ORBIT_KEYS).has(code);
    if (steers || MODIFIERS.has(code)) this.keys.add(code);
    return steers;
  }

  releaseKeys(): void {
    this.keys.clear();
  }

  setMode(mode: CameraMode): void {
    if (mode === this.mode) return;
    this.composing = false;
    if (mode === 'free') this.fly.startFrom(this.camera);
    else {
      this.fromPos.copy(this.camera.position);
      this.fromQuat.copy(this.camera.quaternion);
      this.blend = 0;
    }
    this.mode = mode;
    this.idle = 0;
  }

  /** Follows the boat from one of the viewpoints and rests there from now on; or (`auto`) composes its own views again, at once. */
  setView(name: ViewName): void {
    this.setMode('follow');
    if (name === 'auto') {
      this.auto = true;
      this.idle = IDLE_SECONDS;
      return;
    }
    this.steer();
    this.auto = false;
    this.rest = VIEWS[name];
    this.yawT += angleDelta(this.yawT, this.rest.yaw);
    this.pitchT = this.rest.pitch;
    this.distT = this.rest.dist;
    this.idle = 0;
  }

  /** Starts the opening flight: from high over the river ahead of her, down over the village's bank to her, and round behind her. */
  beginOpening(): void {
    this.setMode('follow');
    // it ends behind her on the side it comes down over (+1 her left: a yaw that takes the camera round to her left
    // is negative), in the composer's own shot there
    const side = openingSide(this.along);
    this.rest = { ...OPENING_VIEW, yaw: -side * OPENING_VIEW.yaw };
    this.settle(this.rest);
    // (left alone from now: settle() holds a still's camera as it is, which would keep the composer from ever
    // taking over after the flight until the viewer had touched something)
    this.idle = 0;
    // (on a narrow screen farther out, as the composer weighs its shots, and the flight round her with it)
    const wide = narrowScale(this.camera) ** 0.6;
    const s = this.handOver;
    s.bearing = side * USUAL.bearing;
    s.dist = USUAL.dist * wide;
    s.high = USUAL.high;
    s.third = side;
    this.restAt.wide = wide;
    // the follow camera posed once, for what the flight looks at
    const b = this.boat;
    this.orbit(b.pos.x, b.pos.z, b.course, 0, b.pos.y + 2.2, 3);
    this.restPlace(this.fillMoment());
    this.opening = { t: 0, side, floor: openingFloor(this.along, side, this.restAt, b.pos.y, this.lines) };
  }

  /**
   * Where the opening flight ends: its hand-over shot for her place and course now, where the composer would stand
   * in it (`endPos`, framed: `endLook`; drawn in where the bank closes in), given the moment it weighs; and what the
   * follow camera looks at (orbit() has posed it). In her way's frame at her place (`restAt`).
   */
  private restPlace(m: Moment | null): void {
    const b = this.boat;
    const s = this.handOver;
    const c = this.composer;
    if (c && m) c.poseOf(s, m, this.endPos, this.endLook);
    else {
      const toward = b.course + s.bearing;
      this.endPos.set(b.pos.x + Math.sin(toward) * s.dist, b.pos.y + s.high, b.pos.z + Math.cos(toward) * s.dist);
    }
    const p = wayAt(this.along);
    const fx = Math.sin(p.heading);
    const fz = Math.cos(p.heading);
    const dx = this.endPos.x - p.x;
    const dz = this.endPos.z - p.z;
    this.restAt.a = dx * fx + dz * fz;
    this.restAt.c = dx * fz - dz * fx;
    this.restAt.h = this.endPos.y - b.pos.y;
    // (it goes round her middle, where it looks and the composer frames her from: going round a point ahead of her
    // while looking at her, its look turned quicker than it went round as it came behind her)
    this.herMid.set(b.pos.x, b.pos.y + 1.3, b.pos.z);
    this.restAt.focus = (this.herMid.x - p.x) * fx + (this.herMid.z - p.z) * fz;
  }

  /** Ends the opening flight (the viewer took the camera, or the film began): the camera eases over to her. */
  endOpening(): void {
    if (!this.opening) return;
    this.opening = null;
    this.fromPos.copy(this.camera.position);
    this.fromQuat.copy(this.camera.quaternion);
    this.blend = 0;
  }

  /** The village's sights along her way (showcase.ts findSights), and what hides what, for the views composed left to itself. */
  setSights(sights: readonly Sight[], lines: Sightlines): void {
    this.sights = sights;
    this.lines = lines;
    this.composer = new Composer(lines, this.camera, (pos) => {
      keepClearOfBridge(pos);
      keepClearOfSanko(pos);
    });
  }

  /** The sights along her way (for the debug hooks). */
  get sightList(): readonly Sight[] {
    return this.sights;
  }

  /** What the composer is doing (for the debug hooks): whether it has the camera, its shot, and that shot's score term by term. */
  get composition(): unknown {
    const m = this.composer && this.fillMoment();
    const dir = this.camera.getWorldDirection(new Vector3());
    return { composing: this.composing, auto: this.auto, along: this.along, pos: this.camera.position.toArray(), dir: dir.toArray(), ...this.composer?.state, now: m ? this.composer?.explain(m) : null };
  }

  /** Whether the opening flight is running. */
  get flying(): boolean {
    return this.opening !== null;
  }

  /** The letterbox the opening flight is shot in (0..1): full as it sets off, opening out as it comes down to her. */
  get openingBars(): number {
    return this.opening ? 1 - smoothstep(OPENING_SECONDS * 0.45, OPENING_SECONDS - 0.5, this.opening.t) : 0;
  }

  /** Starts turning toward `watch` now, rather than after the camera has sat idle. */
  lookNow(): void {
    this.idle = IDLE_SECONDS;
    this.turnRate = TURN_ASKED;
  }

  /** Puts the boat at a point of the journey (0 = where she sets out on the river, 1 = its end out in the bil). */
  place(t: number): void {
    this.along = clamp(t, 0, 1) * JOURNEY.length;
    const p = journeyAt(this.along);
    this.boat.place(p.x, p.z, p.heading);
    this.choosing = 0;
    this.loopT = -1;
    this.fade = 0;
  }

  /** How far through the journey she is (0..1). */
  get progress(): number {
    return this.along / JOURNEY.length;
  }

  /** Points the follow camera's targets at `dir`, framed as when watching a sky event; for stills. */
  aim(dir: Vector3): void {
    this.yawT = watchYaw(dir, this.boat.course);
    this.pitchT = WATCH_VIEW.pitch;
    this.distT = WATCH_VIEW.dist;
  }

  /** Back to following the boat from her resting view, at once (under a cut: the camera is not seen moving). */
  followNow(): void {
    this.endOpening();
    this.setMode('follow');
    this.blend = 1;
  }

  /** Puts the free camera at a point; for stills. */
  placeFree(x: number, y: number, z: number, yaw: number, pitch: number): void {
    this.setMode('free');
    this.fly.place(x, y, z, yaw, pitch);
    // a still jumps there (the ease from the camera before, an opening flight's, would hold it where it was)
    this.blend = 1;
  }

  /** Jumps the camera to its targets (no easing), for stills. */
  settle(view?: Partial<View>): void {
    if (view?.yaw !== undefined) this.yawT = view.yaw;
    if (view?.pitch !== undefined) this.pitchT = view.pitch;
    if (view?.dist !== undefined) this.distT = view.dist;
    this.yaw = this.yawT;
    this.pitch = this.pitchT;
    this.dist = this.distT;
    this.idle = -1e9;
    this.blend = 1;
    this.composing = false;
  }

  /** Stands the camera at once where it would compose its view now (for stills; `settle` first). */
  composeNow(): void {
    this.choose(true);
    const m = this.fillMoment();
    if (!this.composer || !m) return;
    this.endOpening();
    this.setMode('follow');
    this.auto = true;
    this.idle = IDLE_SECONDS + 1;
    this.composer.takeFrom(this.camera, m);
    this.composer.settle(m, this.showPos, this.showLook);
    this.camera.position.copy(this.showPos);
    this.camera.lookAt(this.showLook);
    this.camera.updateMatrixWorld();
    this.composing = true;
    this.blend = 1;
  }

  /**
   * Someone takes the camera: from a composed view the follow camera takes over where it stands (its orbit set to
   * that place, turning to her over the rig's blend), so nothing jumps.
   */
  private steer(): void {
    this.idle = 0;
    if (this.composing) this.stopComposing(!this.directed);
  }

  /**
   * The composer lets the camera go; `adopt`: the follow camera's orbit set to where the composed view last stood
   * (not under the film, whose camera that is not).
   */
  private stopComposing(adopt: boolean): void {
    this.composing = false;
    if (!adopt) return;
    const cam = this.showPos;
    const dx = cam.x - this.target.x;
    const dy = cam.y - this.target.y;
    const dz = cam.z - this.target.z;
    const d = Math.max(Math.hypot(dx, dy, dz), 1e-3);
    this.dist = this.distT = clamp(d / narrowScale(this.camera), DIST_MIN, DIST_MAX);
    this.pitch = this.pitchT = clamp(Math.asin(clamp(dy / d, -1, 1)), PITCH_MIN, PITCH_MAX);
    this.yaw = this.yawT = angleDelta(this.boat.course + Math.PI, Math.atan2(dx, dz));
    this.fromPos.copy(cam);
    this.lookAt.lookAt(cam, this.showLook, this.camera.up);
    this.fromQuat.setFromRotationMatrix(this.lookAt);
    this.blend = 0;
  }

  /**
   * Chooses again which sights are shown by themselves, by what each is worth in the season and the light now; the
   * one she is with keeps its stretch. `still`: for a still, a stretch she is already in counts from its start.
   */
  private choose(still: boolean): void {
    if (!this.sky) return;
    this.choosing = CHOOSE_SECONDS;
    let keep: Sight | null = null;
    if (!still) for (const s of this.sights) if (sightWeight(s, this.along) > 0) keep = s;
    const night = 1 - smoothstep(-0.12, 0.05, this.sky.sun.y);
    chooseShown(this.sights, { season: this.sky.season, night }, keep, still ? -Infinity : this.along);
  }

  /** What the composer is given now: her place and course, the water under her, the sight whose stretch she is in, the sky. */
  private fillMoment(): Moment | null {
    if (!this.sky) return null;
    const b = this.boat;
    let sight: Sight | null = null;
    let share = 0;
    for (const s of this.sights) {
      const k = sightWeight(s, this.along);
      if (k > share) (share = k), (sight = s);
    }
    const level = waterLevelAt(b.pos.x, b.pos.z);
    const m = (this.moment ??= { boat: b.pos, course: 0, water: 0, sight: null, share: 0, sights: this.sights, ...this.sky });
    m.course = b.course;
    m.water = Number.isFinite(level) ? level : b.pos.y;
    m.sight = sight;
    m.share = share;
    m.sights = this.sights;
    return m;
  }

  /** Where the camera looks, on the ground some way ahead; the shadow map follows it. */
  focus(out: Vector3): Vector3 {
    if (this.mode === 'free') return this.fly.focus(out);
    const b = this.boat;
    if (this.composing) {
      // ahead of the composed view, which may look away from her course
      const cam = this.camera.position;
      const dx = this.showLook.x - cam.x;
      const dz = this.showLook.z - cam.z;
      const d = Math.hypot(dx, dz) || 1;
      return out.set(cam.x + (dx / d) * 45, 0, cam.z + (dz / d) * 45);
    }
    return out.set(b.pos.x + Math.sin(b.course) * 40, 0, b.pos.z + Math.cos(b.course) * 40);
  }

  /** What the river's life gathers around: the boat, or the free camera. */
  get subject(): Vector3 {
    return this.mode === 'free' ? this.fly.position : this.boat.pos;
  }

  get subjectHeading(): number {
    return this.mode === 'free' ? this.fly.heading : this.boat.heading;
  }

  /** `crew`: where the boatman's weight is. */
  update(dt: number, t: number, crew: Crew): void {
    const k = this.keys;
    for (const code of k) if (!MODIFIERS.has(code)) this.steer();
    if (k.size) this.endOpening();
    this.choosing -= dt;
    if (this.choosing <= 0) this.choose(false);
    if (this.mode === 'follow') {
      if (k.has('ArrowLeft')) this.yawT += dt * 1.2;
      if (k.has('ArrowRight')) this.yawT -= dt * 1.2;
      if (k.has('ArrowUp')) this.pitchT = clamp(this.pitchT + dt * 0.6, PITCH_MIN, PITCH_MAX);
      if (k.has('ArrowDown')) this.pitchT = clamp(this.pitchT - dt * 0.6, PITCH_MIN, PITCH_MAX);
      if (k.has('Equal') || k.has('NumpadAdd')) this.zoom(Math.exp(-dt));
      if (k.has('Minus') || k.has('NumpadSubtract')) this.zoom(Math.exp(dt));
    }

    // the boat: along her way, steering for a point a little ahead on it; near the end the mist comes down
    // and she is taken back to the start
    const b = this.boat;
    const f = journeyFrame(b.pos.x, b.pos.z);
    if (f) this.along = f.s;
    const ahead = journeyAt(Math.min(JOURNEY.length, this.along + LOOK_AHEAD));
    this.steerTo.x = ahead.x;
    this.steerTo.z = ahead.z;
    b.step(dt, t, this.steerTo, crew);
    if (this.loopT < 0) {
      if (this.along > JOURNEY.length - END_REACH) this.loopT = 0;
    } else {
      this.loopT += dt;
      if (this.loopT > LOOP_FADE && this.loopT - dt <= LOOP_FADE) {
        const start = journeyAt(0);
        b.place(start.x, start.z, start.heading);
        this.along = 0;
      }
      if (this.loopT > LOOP_FADE * 2) this.loopT = -1;
    }
    this.fade = this.loopT < 0 ? 0 : this.loopT < LOOP_FADE ? smoothstep(0, LOOP_FADE, this.loopT) : smoothstep(LOOP_FADE * 2, LOOP_FADE, this.loopT);
    // cameras follow where she is going, not the stern's wag with each stroke
    const h = b.course;

    // left alone, the camera turns to watch a sky event; otherwise it composes its own views (or, with a view
    // picked, eases back to it and drifts slowly there so it never sits still)
    this.idle += dt;
    this.turnRate = damp(this.turnRate, TURN_IDLE, 0.3, dt);
    const idle = this.idle > IDLE_SECONDS;
    if (this.mode === 'free') this.fly.update(dt, k, this.camera, idle ? this.watch : null, this.turnRate);
    else {
      const compose = this.auto && idle && !this.watch && !this.opening;
      const turn = 1 - Math.exp(-dt * this.turnRate);
      if (idle && this.watch) {
        this.yawT += angleDelta(this.yawT, watchYaw(this.watch, h)) * turn;
        this.pitchT = damp(this.pitchT, WATCH_VIEW.pitch, this.turnRate, dt);
        this.distT = damp(this.distT, WATCH_VIEW.dist, this.turnRate, dt);
      } else if (idle && !compose) {
        const drift = this.rest.yaw + 0.22 * Math.sin(t * 0.035);
        this.yawT += angleDelta(this.yawT, drift) * turn;
        this.pitchT = damp(this.pitchT, this.rest.pitch, 0.25, dt);
        this.distT = damp(this.distT, this.rest.dist, 0.2, dt);
      }
      this.orbit(b.pos.x, b.pos.z, h, dt, b.pos.y + 2.2, 3);
      if (this.opening) this.flyOpening(dt);
      else this.compose(dt, compose);
    }

    // ease over from wherever the free camera was
    if (this.blend < 1) {
      this.blend = Math.min(1, this.blend + dt / BLEND_SECONDS);
      const e = smoothstep(0, 1, this.blend);
      this.toQuat.copy(this.camera.quaternion);
      this.camera.position.lerpVectors(this.fromPos, this.camera.position, e);
      this.camera.quaternion.slerpQuaternions(this.fromQuat, this.toQuat, e);
      this.camera.updateMatrixWorld();
    }
  }

  /**
   * The opening flight's frame, over the follow camera's (orbit() has just posed it): the flight's own pose, easing
   * over its last seconds into its hand-over shot as the composer stands in it, placed and framed as it frames; at
   * its end the composer takes the camera there, and nothing moves. (Without a composer it eases into the follow
   * camera's pose, which takes over as it is.)
   */
  private flyOpening(dt: number): void {
    const o = this.opening;
    if (!o) return;
    o.t = Math.min(o.t + dt, OPENING_SECONDS);
    const c = this.composer;
    const m = c ? this.fillMoment() : null;
    this.restPlace(m);
    const b = this.boat;
    openingPose(o.t, this.along, o.side, this.restAt, b.pos.y, this.target, this.herMid, o.floor, this.openPos, this.openLook);
    const cam = this.camera;
    // (smootherstep eases: their acceleration too starts from nothing and ends in it)
    const smoother = (x: number) => x * x * x * (x * (6 * x - 15) + 10);
    if (!c || !m) {
      // no composer to hand over to: eased into the follow camera's pose, which takes over as it is
      const e = smoother(clamp((o.t - (OPENING_SECONDS - HANDOFF)) / HANDOFF, 0, 1));
      this.endQuat.copy(cam.quaternion);
      this.lookAt.lookAt(this.openPos, this.openLook, cam.up);
      this.openQuat.setFromRotationMatrix(this.lookAt);
      cam.position.lerpVectors(this.openPos, cam.position, e);
      cam.quaternion.slerpQuaternions(this.openQuat, this.endQuat, e);
      cam.updateMatrixWorld();
      if (o.t >= OPENING_SECONDS) this.opening = null;
      return;
    }
    // its place: the flight's own ends where the composer stands in the hand-over shot but for her way's bends, and
    // that little is taken up over its last seconds (not the way still to go: that cut its last move short); its look
    // from looking at her to the composer's framing from where it is, turning the way the flight turns
    openingPose(OPENING_SECONDS, this.along, o.side, this.restAt, b.pos.y, this.target, this.herMid, o.floor, this.pathEnd, this.pathEndLook);
    const e = smoother(clamp((o.t - (OPENING_SECONDS - HANDOFF)) / HANDOFF, 0, 1));
    cam.position.copy(this.endPos).sub(this.pathEnd).multiplyScalar(e).add(this.openPos);
    this.lookAt.lookAt(cam.position, this.openLook, cam.up);
    cam.quaternion.setFromRotationMatrix(this.lookAt);
    const w = roundShare(o.t, this.restAt);
    if (w > 0) {
      c.lookFrom(cam.position, m, this.handOver.third, this.endLook);
      this.lookAt.lookAt(cam.position, this.endLook, cam.up);
      this.endQuat.setFromRotationMatrix(this.lookAt);
      cam.quaternion.slerp(this.endQuat, w);
    }
    cam.updateMatrixWorld();
    if (o.t < OPENING_SECONDS) return;
    // the end: the composer takes the camera where it stands, framed as it frames (and should a sky event want
    // watching, or a view be picked, the follow camera takes it from there: `stopComposing`)
    this.opening = null;
    c.takeFrom(cam, m, this.handOver.third);
    this.composing = true;
    this.showPos.copy(cam.position);
    this.showLook.copy(this.endLook);
  }

  /**
   * Left to itself (`want`), the composer has the camera: it takes it from the follow camera's pose (orbit() has
   * just posed it), so the hand-over has no seam, and moves it on its own springs from there. Under the film or a
   * visit it holds its shot without weighing new ones.
   */
  private compose(dt: number, want: boolean): void {
    const c = this.composer;
    const m = c && this.fillMoment();
    if (!c || !m) return;
    if (want !== this.composing) {
      if (want) c.takeFrom(this.camera, m);
      else this.stopComposing(!this.directed);
      this.composing = want;
    }
    if (!this.composing) return;
    c.update(dt, m, this.showPos, this.showLook, !this.directed);
    const cam = this.camera;
    cam.position.copy(this.showPos);
    cam.lookAt(this.showLook);
    cam.updateMatrixWorld();
  }

  /** Scales the orbit distance by `factor`; the free camera moves forward or back instead. */
  private zoom(factor: number): void {
    if (this.mode === 'free') this.fly.nudge(-Math.log(factor) * 40);
    else this.distT = clamp(this.distT * factor, DIST_MIN, DIST_MAX);
  }

  /**
   * Places the follow camera on its orbit round a point just ahead of the boat. The waters are narrow and their
   * banks are wooded: low down, the camera keeps over the water (drawing in toward her where the orbit would
   * take it in among the banks' trees); higher up it may look down over them.
   */
  private orbit(x: number, z: number, h: number, dt: number, height: number, ahead: number): void {
    this.yaw = damp(this.yaw, this.yawT, 4, dt);
    this.pitch = damp(this.pitch, this.pitchT, 4, dt);
    this.dist = damp(this.dist, this.distT, 3, dt);
    const fx = Math.sin(h);
    const fz = Math.cos(h);
    this.target.set(x + fx * ahead, height, z + fz * ahead);
    const back = h + Math.PI + this.yaw;
    // (farther out on a narrow screen, so her majhi at her stern stays in it)
    const dist = this.dist * narrowScale(this.camera);
    let reach = Math.cos(this.pitch) * dist;
    const rise = Math.sin(this.pitch) * dist;
    const cam = this.camera.position;
    if (rise < 9) {
      // pulled in along its line until it is over the water
      for (let r = reach; r > DIST_MIN * 0.7; r -= 1) {
        if (overWater(this.target.x + Math.sin(back) * r, this.target.z + Math.cos(back) * r)) {
          reach = r;
          break;
        }
        if (r - 1 <= DIST_MIN * 0.7) reach = r - 1;
      }
    }
    cam.set(this.target.x + Math.sin(back) * reach, this.target.y + rise, this.target.z + Math.cos(back) * reach);
    const ground = Math.max(terrainHeight(cam.x, cam.z), waterLevelAt(cam.x, cam.z));
    cam.y = Math.max(cam.y, ground + 1.2);
    keepClearOfBridge(cam);
    keepClearOfSanko(cam);
    this.camera.lookAt(this.target);
    this.camera.updateMatrixWorld();
  }

  /** Field of view that keeps the water in frame on tall phone screens. */
  static fovFor(aspect: number): number {
    return aspect < 1 ? 62 + (1 - aspect) * 18 : 50;
  }
}
