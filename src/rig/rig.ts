import { PerspectiveCamera, Quaternion, Vector3 } from 'three';
import { G } from '../core/globals';
import { angleDelta, clamp, damp, lerp, smoothstep } from '../core/mathx';
import { BoatBody, type Crew } from '../world/boatPhysics';
import { BRIDGE, JOURNEY_Z0, JOURNEY_Z1, boatLane, bridgeDeck, bridgeFrame, bridgeSoffit, riverX, terrainHeight, waterLevelAt } from '../world/geography';
import { routeLength, waterRoute, waterToward } from '../world/navigation';
import { Walker } from '../world/walker';
import { FlyCam } from './flycam';

const laneX = (z: number) => riverX(z) + boatLane(z);
/** Heading along the boat's own track, one metre ahead. */
const headingAt = (z: number) => Math.atan2(laneX(z - 1) - laneX(z), -1);

/** How far down the lane the boatman steers for, m. */
const LOOK_AHEAD = 16;

/**
 * The journey's lane as a path: a point every PATH_STEP m of z from its start down to its end, and how far along
 * the lane each one lies. The boatman steers for a point LOOK_AHEAD m further along it, not further down in z:
 * where the compact map draws the channel together its bends run nearly across the map, and a point ahead in z
 * there lies across the inner bank.
 */
const PATH_STEP = 5;
const JOURNEY_PATH = (() => {
  const n = Math.max(2, Math.ceil((JOURNEY_Z0 - JOURNEY_Z1) / PATH_STEP) + 1);
  const x = new Float64Array(n);
  const z = new Float64Array(n);
  const s = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    z[i] = JOURNEY_Z0 - i * PATH_STEP;
    x[i] = laneX(z[i]);
    if (i > 0) s[i] = s[i - 1] + Math.hypot(x[i] - x[i - 1], z[i] - z[i - 1]);
  }
  return { x, z, s, n };
})();

/** The point `ahead` m further along the journey's lane from where it passes nearest (x, z). */
function aheadOnJourney(x: number, z: number, ahead: number, out: { x: number; z: number }): { x: number; z: number } {
  const P = JOURNEY_PATH;
  // the nearest point, looked for among those within a stretch of z round her
  const guess = Math.round((JOURNEY_Z0 - z) / PATH_STEP);
  let best = Math.min(P.n - 1, Math.max(0, guess));
  let bestD = Infinity;
  for (let i = Math.max(0, guess - 60); i <= Math.min(P.n - 1, guess + 60); i++) {
    const d = (P.x[i] - x) ** 2 + (P.z[i] - z) ** 2;
    if (d < bestD) (bestD = d), (best = i);
  }
  const want = P.s[best] + ahead;
  let i = best;
  while (i < P.n - 1 && P.s[i + 1] < want) i++;
  if (i >= P.n - 1) return Object.assign(out, { x: P.x[P.n - 1], z: P.z[P.n - 1] });
  const t = (want - P.s[i]) / Math.max(1e-6, P.s[i + 1] - P.s[i]);
  return Object.assign(out, { x: P.x[i] + (P.x[i + 1] - P.x[i]) * t, z: P.z[i] + (P.z[i + 1] - P.z[i]) * t });
}
const LOOP_FADE = 3;
const IDLE_SECONDS = 7;
const DIST_MIN = 6;
const DIST_MAX = 80;
const PITCH_MIN = -0.04;
const PITCH_MAX = 1.2;
/** How quickly an idle camera turns: slowly for its resting drift, briskly when asked to look. */
const TURN_IDLE = 0.25;
const TURN_ASKED = 1.6;
/** Seconds to ease from the free camera back to the boat. */
const BLEND_SECONDS = 1.4;

export interface View {
  yaw: number;
  pitch: number;
  dist: number;
}

/** Viewpoints around the boat. The camera rests at the chosen one; `stern` is the default. */
export const VIEWS = {
  stern: { yaw: 0.42, pitch: 0.12, dist: 17 },
  boatman: { yaw: 1.9, pitch: 0.08, dist: 7 },
  bow: { yaw: Math.PI - 0.35, pitch: 0.1, dist: 15 },
  high: { yaw: -1.4, pitch: 0.55, dist: 75 },
} satisfies Record<string, View>;
export type ViewName = keyof typeof VIEWS;

/**
 * Where the camera rests until the viewer picks a view: low over the water off the boat's quarter,
 * looking down the river past her into the evening sun, its path on the water beside her.
 */
const OPENING_VIEW: View = { yaw: 0.5, pitch: 0.08, dist: 15 };

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
 * Low and close, with a rising or setting sun or moon in the frame beside the boat: turned this far
 * (rad) from it toward her way ahead, so it sits off to the side, not glaring straight down the view.
 */
const WATCH_VIEW = { pitch: 0.05, dist: 16, aside: 0.42 };

/** The camera's yaw (from her course `h`) that frames an event in direction `dir` beside the boat. */
function watchYaw(dir: Vector3, h: number): number {
  const toward = angleDelta(h, Math.atan2(dir.x, dir.z));
  return toward - Math.sign(toward) * Math.min(Math.abs(toward), WATCH_VIEW.aside);
}

export type CameraMode = 'follow' | 'free' | 'walk';
/**
 * What the boat is doing: going down the channel on the journey (it loops), following a way to somewhere
 * the viewer chose, steered by the viewer, or tied up where she stopped.
 */
export type Voyage = 'journey' | 'route' | 'helm' | 'moored';

const ORBIT_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Equal', 'Minus', 'NumpadAdd', 'NumpadSubtract']);
/** On foot and at the helm: W and S forward and back (row and rest), A and D to turn. */
const STEER_KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD']);
/** Walking: the camera's place behind him. */
const WALK_VIEW: View = { yaw: 0, pitch: 0.2, dist: 5.5 };
/** How far ahead along her way the boatman steers for (m), and how near its end she ties up. */
const ROUTE_AHEAD = 24;
const ROUTE_END = 14;
/** How fast the helm turns her heading (rad/s). */
const HELM_TURN = 0.45;
/** How far from the boat one can step ashore or aboard (m): back aboard from wherever one stepped off. */
const ASHORE = 14;
const ABOARD = ASHORE + 2;
/** The sea's level now (m): the boat's ways are found for the water there is, with this much under her (m). */
const seaLevel = () => G.uWaterLevel.value;
const UNDER_KEEL = 0.8;
/** On the last stretch in to a landing she is poled over shallower water, with this much under her (m). */
const LANDING_KEEL = 0.45;
const FLY_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'PageUp', 'PageDown']);
const MODIFIERS = new Set(['ShiftLeft', 'ShiftRight']);

/** The boat's journey down the river, and the camera: an orbit that follows the boat, or a free flyer. */
export class Rig {
  /** The boat as a floating body, paddled down its lane (and through the bil). */
  readonly boat = new BoatBody();
  /** 0..1 mist fade while the journey loops back to its start. */
  fade = 0;
  dragging = false;
  mode: CameraMode = 'follow';
  /** A direction to turn toward once nobody is steering (a rising moon, say); null to rest. */
  watch: Vector3 | null = null;
  /** The viewer on foot, when ashore (main.ts adds his group to the scene). */
  readonly walker = new Walker();
  voyage: Voyage = 'journey';
  /** Whatever should be said to the viewer (a Bangla line), once. */
  onNotice: (text: string) => void = () => {};
  private route: { points: { x: number; z: number }[]; lengths: number[]; name: string; thenJourney: boolean } | null = null;
  private helmHeading = 0;
  private readonly walkerPos = new Vector3();

  private loopT = -1;
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

  readonly camera: PerspectiveCamera;

  constructor(camera: PerspectiveCamera, element: HTMLElement) {
    this.camera = camera;
    this.place(0);
    this.walker.group.visible = false;
    element.addEventListener('pointerdown', (e) => {
      element.setPointerCapture(e.pointerId);
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      this.dragging = true;
      this.idle = 0;
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
      this.idle = 0;
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
        this.zoom(Math.exp(e.deltaY * 0.0012));
        this.idle = 0;
      },
      { passive: false },
    );
  }

  /**
   * Keys routed from the page; only camera keys are kept. Arrows orbit and +/- zoom when following
   * the boat; WASD, Q/E and the arrows fly the free camera. Returns whether the key steers the camera.
   */
  press(code: string, down: boolean): boolean {
    if (!down) {
      this.keys.delete(code);
      return false;
    }
    const steers =
      (this.mode === 'free' ? FLY_KEYS : ORBIT_KEYS).has(code) || (STEER_KEYS.has(code) && (this.mode === 'walk' || (this.mode === 'follow' && this.voyage === 'helm')));
    if (steers || MODIFIERS.has(code)) this.keys.add(code);
    return steers;
  }

  releaseKeys(): void {
    this.keys.clear();
  }

  setMode(mode: CameraMode): void {
    if (mode === this.mode) return;
    // on foot, the boat's view is reached by going back aboard; ashore, by stepping off her
    if (this.mode === 'walk' && mode === 'follow') {
      this.goAboard();
      return;
    }
    if (mode === 'walk') {
      this.goAshore();
      return;
    }
    if (this.mode === 'walk') this.walker.group.visible = false;
    if (mode === 'free') this.fly.startFrom(this.camera);
    else {
      this.fromPos.copy(this.camera.position);
      this.fromQuat.copy(this.camera.quaternion);
      this.blend = 0;
    }
    this.mode = mode;
    this.idle = 0;
  }

  /** Follows the boat from one of the viewpoints, and rests there from now on. */
  setView(name: ViewName): void {
    this.setMode('follow');
    this.rest = VIEWS[name];
    this.yawT += angleDelta(this.yawT, this.rest.yaw);
    this.pitchT = this.rest.pitch;
    this.distT = this.rest.dist;
    this.idle = 0;
  }

  /** Starts turning toward `watch` now, rather than after the camera has sat idle. */
  lookNow(): void {
    this.idle = IDLE_SECONDS;
    this.turnRate = TURN_ASKED;
  }

  /** Puts the boat at a point of the journey (0 = start, 1 = end). */
  place(t: number): void {
    // he can't be left ashore while she goes elsewhere
    if (this.mode === 'walk') this.aboard();
    const z = JOURNEY_Z0 + (JOURNEY_Z1 - JOURNEY_Z0) * clamp(t, 0, 1);
    this.boat.place(laneX(z), z, headingAt(z));
    this.loopT = -1;
    this.fade = 0;
    this.journey();
  }

  /** Back on the journey down the channel, from wherever she lies (by water to the lane first, if she is off it). */
  journey(): void {
    const b = this.boat;
    b.moor = null;
    b.rowing = true;
    this.route = null;
    const z = clamp(b.pos.z, JOURNEY_Z1 + 60, JOURNEY_Z0);
    if (Math.abs(b.pos.x - laneX(z)) < 60 && Math.abs(b.pos.z - z) < 60) {
      this.voyage = 'journey';
      return;
    }
    const way = this.routeTo(laneX(z), z);
    if (way) this.follow(way, '', true);
    else this.voyage = 'journey';
  }

  /** Her way by water from where she lies to (x, z) at the water there is now; null if none. */
  routeTo(x: number, z: number): { x: number; z: number }[] | null {
    const b = this.boat;
    const way = waterRoute(b.pos.x, b.pos.z, x, z, seaLevel() - UNDER_KEEL);
    // the way ends in deep water; the last stretch goes on over the shallows toward the place itself as far as
    // the water allows (alongside a jetty's head at high water), so she comes in close
    const last = way?.[way.length - 1];
    if (!way || !last) return way;
    const near = waterToward(last.x, last.z, x, z, seaLevel() - LANDING_KEEL);
    if (Math.hypot(near.x - last.x, near.z - last.z) > ROUTE_END) way.push(near);
    return way;
  }

  /**
   * Puts her `keep` metres short of the end of `points` (a way from where she lies), heading along it, and
   * returns the rest of the way: a long voyage is passed through the mist rather than rowed for an hour.
   */
  skipAlong(points: { x: number; z: number }[], keep: number): { x: number; z: number }[] {
    const b = this.boat;
    const pts = [{ x: b.pos.x, z: b.pos.z }, ...points];
    let s = routeLength(b.pos.x, b.pos.z, points) - keep;
    if (s <= 0) return points;
    for (let k = 1; k < pts.length; k++) {
      const dx = pts[k].x - pts[k - 1].x;
      const dz = pts[k].z - pts[k - 1].z;
      const len = Math.hypot(dx, dz);
      if (s <= len) {
        const f = len > 0 ? s / len : 0;
        b.place(pts[k - 1].x + dx * f, pts[k - 1].z + dz * f, Math.atan2(dx, dz));
        return pts.slice(k);
      }
      s -= len;
    }
    return points;
  }

  /** Sails her along `points` (world) to `name`, where she ties up. */
  sail(points: { x: number; z: number }[], name: string): void {
    this.follow(points, name, false);
  }

  private follow(points: { x: number; z: number }[], name: string, thenJourney: boolean): void {
    const b = this.boat;
    const pts = [{ x: b.pos.x, z: b.pos.z }, ...points];
    const lengths = [0];
    for (let k = 1; k < pts.length; k++) lengths.push(lengths[k - 1] + Math.hypot(pts[k].x - pts[k - 1].x, pts[k].z - pts[k - 1].z));
    this.route = { points: pts, lengths, name, thenJourney };
    this.voyage = 'route';
    b.moor = null;
    b.rowing = true;
  }

  /** Takes the helm (the viewer steers with A and D, rows with W and rests with S), or gives it back. */
  toggleHelm(): void {
    if (this.mode === 'walk') return;
    if (this.voyage === 'helm') {
      this.journey();
      this.onNotice('মাঝি আবার নিজেই বাইছেন');
      return;
    }
    const b = this.boat;
    this.voyage = 'helm';
    this.route = null;
    b.moor = null;
    this.helmHeading = b.course;
    b.rowing = true;
    if (this.mode !== 'follow') this.setMode('follow');
    this.onNotice('হাল আপনার হাতে: A আর D দিয়ে দিক, W দিয়ে বাওয়া, S দিয়ে থামা');
  }

  /** Ties her up where she is, the way she lies. */
  private moorHere(): void {
    const b = this.boat;
    this.voyage = 'moored';
    this.route = null;
    b.rowing = false;
    b.moor = { x: b.pos.x, z: b.pos.z, heading: b.course };
  }

  /** Steps ashore from the boat if there is ground to stand on near her; says why not, if not. */
  goAshore(): boolean {
    const b = this.boat;
    if (Math.hypot(b.vel.x, b.vel.z) > 1.0 && this.voyage !== 'moored') {
      this.moorHere();
      this.onNotice('নৌকা থামছে, তারপর নামুন');
      return false;
    }
    const best = this.landing();
    if (!best) {
      this.onNotice('এখানে নামার মতো মাটি বা ঘাট নেই');
      return false;
    }
    this.moorHere();
    this.walker.place(best.x, best.z, Math.atan2(best.x - b.pos.x, best.z - b.pos.z));
    this.toWalk(true);
    return true;
  }

  /** The nearest ground one can stand on within a step ashore of her, looking round her; null if none. */
  private landing(): { x: number; z: number } | null {
    const b = this.boat;
    for (let r = 2; r <= ASHORE; r += 1.5) {
      for (let k = 0; k < 24; k++) {
        const a = (k / 24) * Math.PI * 2;
        const x = b.pos.x + Math.sin(a) * r;
        const z = b.pos.z + Math.cos(a) * r;
        if (this.walker.canStand(x, z)) return { x, z };
      }
    }
    return null;
  }

  /** Back aboard if she is near; says how far she is, if not. */
  goAboard(): boolean {
    const w = this.walker;
    const b = this.boat;
    const d = Math.hypot(w.x - b.pos.x, w.z - b.pos.z);
    if (d > ABOARD) {
      this.onNotice(`নৌকা ${Math.round(d)} মিটার দূরে: কাছে গিয়ে উঠুন`);
      return false;
    }
    this.aboard();
    return true;
  }

  /** The camera back with the boat from wherever it was, on foot or flying, easing over or (behind the mist) at once. */
  aboard(ease = true): void {
    this.walker.group.visible = false;
    this.fromPos.copy(this.camera.position);
    this.fromQuat.copy(this.camera.quaternion);
    this.blend = ease ? 0 : 1;
    this.mode = 'follow';
    this.yawT = this.rest.yaw;
    this.pitchT = this.rest.pitch;
    this.distT = this.rest.dist;
    if (!ease) {
      this.yaw = this.yawT;
      this.pitch = this.pitchT;
      this.dist = this.distT;
    }
    this.idle = 0;
  }

  /** Puts him ashore at (x, z) facing `heading`, the boat tied up where she is (the map's jumps). */
  walkFrom(x: number, z: number, heading: number): void {
    if (this.voyage !== 'moored') this.moorHere();
    this.walker.place(x, z, heading);
    this.toWalk(false);
  }

  /** The camera goes over to him on foot, easing from where it was or at once. */
  private toWalk(ease: boolean): void {
    this.walker.group.visible = true;
    this.fromPos.copy(this.camera.position);
    this.fromQuat.copy(this.camera.quaternion);
    this.blend = ease ? 0 : 1;
    this.mode = 'walk';
    this.yawT = WALK_VIEW.yaw;
    this.pitchT = WALK_VIEW.pitch;
    this.distT = WALK_VIEW.dist;
    if (!ease) {
      this.yaw = this.yawT;
      this.pitch = this.pitchT;
      this.dist = this.distT;
    }
    this.idle = 0;
  }

  /** Points the follow camera's targets at `dir`, framed as when watching a sky event; for stills. */
  aim(dir: Vector3): void {
    this.yawT = watchYaw(dir, this.boat.course);
    this.pitchT = WATCH_VIEW.pitch;
    this.distT = WATCH_VIEW.dist;
  }

  /** Puts the free camera at a point; for stills. */
  placeFree(x: number, y: number, z: number, yaw: number, pitch: number): void {
    this.setMode('free');
    this.fly.place(x, y, z, yaw, pitch);
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
  }

  /** Where the camera looks, on the ground some way ahead; the shadow map follows it. */
  focus(out: Vector3): Vector3 {
    if (this.mode === 'free') return this.fly.focus(out);
    if (this.mode === 'walk') return out.set(this.walker.x + Math.sin(this.walker.heading) * 25, 0, this.walker.z + Math.cos(this.walker.heading) * 25);
    const b = this.boat;
    return out.set(b.pos.x + Math.sin(b.course) * 60, 0, b.pos.z + Math.cos(b.course) * 60);
  }

  /** What the river's life gathers around: the boat, or the free camera. */
  get subject(): Vector3 {
    if (this.mode === 'walk') return this.walkerPos.set(this.walker.x, this.walker.y, this.walker.z);
    return this.mode === 'free' ? this.fly.position : this.boat.pos;
  }

  get subjectHeading(): number {
    if (this.mode === 'walk') return this.walker.heading;
    return this.mode === 'free' ? this.fly.heading : this.boat.heading;
  }

  /** `crew`: where the boatman's weight is. */
  update(dt: number, t: number, crew: Crew): void {
    const k = this.keys;
    for (const code of k) if (!MODIFIERS.has(code)) this.idle = 0;
    if (this.mode === 'follow' || this.mode === 'walk') {
      if (k.has('ArrowLeft')) this.yawT += dt * 1.2;
      if (k.has('ArrowRight')) this.yawT -= dt * 1.2;
      if (k.has('ArrowUp')) this.pitchT = clamp(this.pitchT + dt * 0.6, PITCH_MIN, PITCH_MAX);
      if (k.has('ArrowDown')) this.pitchT = clamp(this.pitchT - dt * 0.6, PITCH_MIN, PITCH_MAX);
      if (k.has('Equal') || k.has('NumpadAdd')) this.zoom(Math.exp(-dt));
      if (k.has('Minus') || k.has('NumpadSubtract')) this.zoom(Math.exp(dt));
    }

    // the boat: down the lane on the journey, along her way to a chosen place, as the viewer steers her, or tied up
    const b = this.boat;
    this.steer(dt);
    b.step(dt, t, this.steerTo, crew);
    if (this.voyage !== 'journey') this.loopT = -1;
    else if (this.loopT < 0) {
      if (b.pos.z < JOURNEY_Z1 + 40) this.loopT = 0;
    } else {
      this.loopT += dt;
      if (this.loopT > LOOP_FADE && this.loopT - dt <= LOOP_FADE) b.place(laneX(JOURNEY_Z0), JOURNEY_Z0, headingAt(JOURNEY_Z0));
      if (this.loopT > LOOP_FADE * 2) this.loopT = -1;
    }
    this.fade = this.loopT < 0 ? 0 : this.loopT < LOOP_FADE ? smoothstep(0, LOOP_FADE, this.loopT) : smoothstep(LOOP_FADE * 2, LOOP_FADE, this.loopT);
    // on foot: he walks as the keys say
    const w = this.walker;
    if (this.mode === 'walk') {
      w.update(dt, t, {
        forward: (k.has('KeyW') ? 1 : 0) - (k.has('KeyS') ? 1 : 0),
        turn: (k.has('KeyA') ? 1 : 0) - (k.has('KeyD') ? 1 : 0),
        run: k.has('ShiftLeft') || k.has('ShiftRight'),
      });
    }
    const x = this.mode === 'walk' ? w.x : b.pos.x;
    const z = this.mode === 'walk' ? w.z : b.pos.z;
    // cameras follow where she is going, not the stern's wag with each stroke
    const h = this.mode === 'walk' ? w.heading : b.course;

    // left alone, the camera turns to watch a sky event, or eases back to its resting view and drifts
    // slowly there so it never sits still
    this.idle += dt;
    this.turnRate = damp(this.turnRate, TURN_IDLE, 0.3, dt);
    const idle = this.idle > IDLE_SECONDS;
    if (this.mode === 'free') this.fly.update(dt, k, this.camera, idle ? this.watch : null, this.turnRate);
    else {
      const turn = 1 - Math.exp(-dt * this.turnRate);
      if (idle && this.watch) {
        this.yawT += angleDelta(this.yawT, watchYaw(this.watch, h)) * turn;
        this.pitchT = damp(this.pitchT, WATCH_VIEW.pitch, this.turnRate, dt);
        this.distT = damp(this.distT, WATCH_VIEW.dist, this.turnRate, dt);
      } else if (idle) {
        const rest = this.mode === 'walk' ? WALK_VIEW : this.rest;
        const drift = rest.yaw + (this.mode === 'walk' ? 0 : 0.28 * Math.sin(t * 0.035));
        this.yawT += angleDelta(this.yawT, drift) * turn;
        this.pitchT = damp(this.pitchT, rest.pitch, 0.25, dt);
        this.distT = damp(this.distT, rest.dist, 0.2, dt);
      }
      this.orbit(x, z, h, dt, this.mode === 'walk' ? w.y + 1.45 : b.pos.y + 2.4, this.mode === 'walk' ? 0.6 : 4);
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

  /** Scales the orbit distance by `factor`; the free camera moves forward or back instead. */
  private zoom(factor: number): void {
    if (this.mode === 'free') this.fly.nudge(-Math.log(factor) * 40);
    else this.distT = clamp(this.distT * factor, DIST_MIN, DIST_MAX);
  }

  /** Steers the boat as her voyage has it: the point the boatman makes for, whether he rows, her line. */
  private steer(dt: number): void {
    const b = this.boat;
    const k = this.keys;
    switch (this.voyage) {
      case 'journey':
        aheadOnJourney(b.pos.x, b.pos.z, LOOK_AHEAD, this.steerTo);
        break;
      case 'route': {
        const r = this.route;
        if (!r) {
          this.moorHere();
          break;
        }
        // where along her way she is (the nearest point of it), and the point a little ahead of that
        let best = 0;
        let bestD = Infinity;
        for (let i = 1; i < r.points.length; i++) {
          const a = r.points[i - 1];
          const c = r.points[i];
          const sx = c.x - a.x;
          const sz = c.z - a.z;
          const l2 = sx * sx + sz * sz || 1;
          const u = Math.max(0, Math.min(1, ((b.pos.x - a.x) * sx + (b.pos.z - a.z) * sz) / l2));
          const d = Math.hypot(b.pos.x - a.x - sx * u, b.pos.z - a.z - sz * u);
          if (d < bestD) {
            bestD = d;
            best = r.lengths[i - 1] + Math.sqrt(l2) * u;
          }
        }
        const total = r.lengths[r.lengths.length - 1];
        const s = Math.min(total, best + ROUTE_AHEAD);
        let i = 1;
        while (i < r.lengths.length - 1 && r.lengths[i] < s) i++;
        const u = (s - r.lengths[i - 1]) / Math.max(1e-6, r.lengths[i] - r.lengths[i - 1]);
        this.steerTo.x = r.points[i - 1].x + (r.points[i].x - r.points[i - 1].x) * u;
        this.steerTo.z = r.points[i - 1].z + (r.points[i].z - r.points[i - 1].z) * u;
        if (total - best < ROUTE_END) {
          if (r.thenJourney) {
            this.route = null;
            this.voyage = 'journey';
          } else {
            const name = r.name;
            this.moorHere();
            if (name) this.onNotice(this.landing() ? `${name}: এসে গেছি, G চেপে নামুন` : `${name}: এসে গেছি, তবে এই জলে ঘাটে ভেড়া গেল না`);
          }
        }
        break;
      }
      case 'helm': {
        // A and D turn her head; W rows, S rests the paddle
        if (k.has('KeyA')) this.helmHeading += HELM_TURN * dt;
        if (k.has('KeyD')) this.helmHeading -= HELM_TURN * dt;
        if (k.has('KeyW')) b.rowing = true;
        if (k.has('KeyS')) b.rowing = false;
        this.steerTo.x = b.pos.x + Math.sin(this.helmHeading) * LOOK_AHEAD;
        this.steerTo.z = b.pos.z + Math.cos(this.helmHeading) * LOOK_AHEAD;
        break;
      }
      case 'moored':
        this.steerTo.x = b.pos.x + Math.sin(b.course) * LOOK_AHEAD;
        this.steerTo.z = b.pos.z + Math.cos(b.course) * LOOK_AHEAD;
        break;
    }
  }

  /** Places the follow camera on its orbit round a point just ahead of the boat (or of him, on foot). */
  private orbit(x: number, z: number, h: number, dt: number, height: number, ahead: number): void {
    this.yaw = damp(this.yaw, this.yawT, 4, dt);
    this.pitch = damp(this.pitch, this.pitchT, 4, dt);
    this.dist = damp(this.dist, this.distT, 3, dt);
    const fx = Math.sin(h);
    const fz = Math.cos(h);
    this.target.set(x + fx * ahead, height, z + fz * ahead);
    const back = h + Math.PI + this.yaw;
    const cp = Math.cos(this.pitch) * this.dist;
    const cam = this.camera.position;
    cam.set(this.target.x + Math.sin(back) * cp, this.target.y + Math.sin(this.pitch) * this.dist, this.target.z + Math.cos(back) * cp);
    const ground = Math.max(terrainHeight(cam.x, cam.z), waterLevelAt(cam.x, cam.z));
    cam.y = Math.max(cam.y, ground + 1.2);
    keepClearOfBridge(cam);
    this.camera.lookAt(this.target);
    this.camera.updateMatrixWorld();
  }

  /** Field of view that keeps the river in frame on tall phone screens. */
  static fovFor(aspect: number): number {
    return aspect < 1 ? 62 + (1 - aspect) * 18 : 48;
  }
}
