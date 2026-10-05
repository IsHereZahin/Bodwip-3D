import { PerspectiveCamera, Quaternion, Vector3 } from 'three';
import { angleDelta, clamp, damp, lerp, smoothstep } from '../core/mathx';
import { BoatBody, type Crew } from '../world/boatPhysics';
import { BRIDGE, JOURNEY, bridgeDeck, bridgeFrame, bridgeSoffit, inlandWaterAt, khalAt, khalFrame, khalHalfWidth, terrainHeight, waterLevelAt } from '../world/geography';
import { FlyCam } from './flycam';

/** How far along the khal the boatman steers for, m. */
const LOOK_AHEAD = 16;
/** Where she is as the scene opens: this far below the old bridge, its arch ahead of her in the evening light (m). */
const OPENING_BELOW_BRIDGE = 60;
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

export interface View {
  yaw: number;
  pitch: number;
  dist: number;
}

/** Viewpoints around the boat. The camera rests at the chosen one; `stern` is the default. */
export const VIEWS = {
  stern: { yaw: 0.32, pitch: 0.12, dist: 14 },
  boatman: { yaw: 1.9, pitch: 0.08, dist: 6.5 },
  bow: { yaw: Math.PI - 0.3, pitch: 0.1, dist: 13 },
  high: { yaw: -1.2, pitch: 0.5, dist: 34 },
} satisfies Record<string, View>;
export type ViewName = keyof typeof VIEWS;

/**
 * Where the camera rests until the viewer picks a view: low over the water off the boat's quarter, looking up
 * the khal past her into the evening light, the banks close either side.
 */
const OPENING_VIEW: View = { yaw: 0.4, pitch: 0.08, dist: 13 };

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

/** Whether a camera at (x, z) is over the water or close over the khal's banks (not in among the banks' trees). */
function overWater(x: number, z: number): boolean {
  if (inlandWaterAt(x, z)) return true;
  const f = khalFrame(x, z);
  return f !== null && f.d < khalHalfWidth(f.s) + 3;
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

/** The boat's journey up the khal into the bil, and the camera: an orbit that follows the boat, or a free flyer. */
export class Rig {
  /** The boat as a floating body, paddled up the khal. */
  readonly boat = new BoatBody();
  /** 0..1 mist fade while the journey loops back to its start. */
  fade = 0;
  dragging = false;
  mode: CameraMode = 'follow';
  /** A direction to turn toward once nobody is steering (a rising moon, say); null to rest. */
  watch: Vector3 | null = null;

  private loopT = -1;
  /** How far along the khal she is (m), kept while she is too far off it to say. */
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

  readonly camera: PerspectiveCamera;

  constructor(camera: PerspectiveCamera, element: HTMLElement) {
    this.camera = camera;
    this.place((JOURNEY.bridge - OPENING_BELOW_BRIDGE) / JOURNEY.length);
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

  /** Puts the boat at a point of the journey (0 = its start below the bridge, 1 = its end out in the bil). */
  place(t: number): void {
    this.along = clamp(t, 0, 1) * JOURNEY.length;
    const p = khalAt(this.along);
    this.boat.place(p.x, p.z, p.heading);
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
    const b = this.boat;
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
    for (const code of k) if (!MODIFIERS.has(code)) this.idle = 0;
    if (this.mode === 'follow') {
      if (k.has('ArrowLeft')) this.yawT += dt * 1.2;
      if (k.has('ArrowRight')) this.yawT -= dt * 1.2;
      if (k.has('ArrowUp')) this.pitchT = clamp(this.pitchT + dt * 0.6, PITCH_MIN, PITCH_MAX);
      if (k.has('ArrowDown')) this.pitchT = clamp(this.pitchT - dt * 0.6, PITCH_MIN, PITCH_MAX);
      if (k.has('Equal') || k.has('NumpadAdd')) this.zoom(Math.exp(-dt));
      if (k.has('Minus') || k.has('NumpadSubtract')) this.zoom(Math.exp(dt));
    }

    // the boat: up the khal, steering for a point a little ahead along it; near the end the mist comes down
    // and she is taken back to the start
    const b = this.boat;
    const f = khalFrame(b.pos.x, b.pos.z);
    if (f) this.along = f.s;
    const ahead = khalAt(Math.min(JOURNEY.length, this.along + LOOK_AHEAD));
    this.steerTo.x = ahead.x;
    this.steerTo.z = ahead.z;
    b.step(dt, t, this.steerTo, crew);
    if (this.loopT < 0) {
      if (this.along > JOURNEY.length - END_REACH) this.loopT = 0;
    } else {
      this.loopT += dt;
      if (this.loopT > LOOP_FADE && this.loopT - dt <= LOOP_FADE) {
        const start = khalAt(0);
        b.place(start.x, start.z, start.heading);
        this.along = 0;
      }
      if (this.loopT > LOOP_FADE * 2) this.loopT = -1;
    }
    this.fade = this.loopT < 0 ? 0 : this.loopT < LOOP_FADE ? smoothstep(0, LOOP_FADE, this.loopT) : smoothstep(LOOP_FADE * 2, LOOP_FADE, this.loopT);
    // cameras follow where she is going, not the stern's wag with each stroke
    const h = b.course;

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
        const drift = this.rest.yaw + 0.22 * Math.sin(t * 0.035);
        this.yawT += angleDelta(this.yawT, drift) * turn;
        this.pitchT = damp(this.pitchT, this.rest.pitch, 0.25, dt);
        this.distT = damp(this.distT, this.rest.dist, 0.2, dt);
      }
      this.orbit(b.pos.x, b.pos.z, h, dt, b.pos.y + 2.2, 3);
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

  /**
   * Places the follow camera on its orbit round a point just ahead of the boat. The khal is narrow and its
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
    let reach = Math.cos(this.pitch) * this.dist;
    const rise = Math.sin(this.pitch) * this.dist;
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
    this.camera.lookAt(this.target);
    this.camera.updateMatrixWorld();
  }

  /** Field of view that keeps the khal in frame on tall phone screens. */
  static fovFor(aspect: number): number {
    return aspect < 1 ? 62 + (1 - aspect) * 18 : 50;
  }
}
