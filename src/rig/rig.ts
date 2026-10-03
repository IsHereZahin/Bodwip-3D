import { PerspectiveCamera, Vector3 } from 'three';
import { angleDelta, clamp, damp, smoothstep } from '../core/mathx';
import { JOURNEY_Z0, JOURNEY_Z1, boatLane, riverX, terrainHeight } from '../world/geography';

const laneX = (z: number) => riverX(z) + boatLane(z);

const SPEED = 3.2;
const LOOP_FADE = 3;
const IDLE_SECONDS = 7;

/** Where the camera rests when left alone: behind and a little to starboard, looking down the river. */
const REST = { yaw: 0.42, pitch: 0.12, dist: 17 };

/** The boat's drift down the river, and the orbiting camera that follows it. */
export class Rig {
  readonly boat = { pos: new Vector3(), heading: Math.PI, speed: SPEED, pitch: 0, roll: 0 };
  /** 0..1 mist fade while the journey loops back to its start. */
  fade = 0;
  dragging = false;

  private z = JOURNEY_Z0;
  private loopT = -1;
  private yaw = REST.yaw;
  private pitch = REST.pitch;
  private dist = REST.dist;
  private yawT = REST.yaw;
  private pitchT = REST.pitch;
  private distT = REST.dist;
  private idle = 0;
  private readonly pointers = new Map<number, { x: number; y: number }>();
  private pinch = 0;
  private readonly keys = new Set<string>();
  private readonly target = new Vector3();

  readonly camera: PerspectiveCamera;

  constructor(camera: PerspectiveCamera, element: HTMLElement) {
    this.camera = camera;
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
        if (this.pinch > 0) this.distT = clamp(this.distT * (before / Math.max(after, 1)), 6, 80);
        this.pinch = after;
      } else {
        this.yawT -= (e.clientX - prev.x) * 0.005;
        this.pitchT = clamp(this.pitchT + (e.clientY - prev.y) * 0.004, -0.04, 1.2);
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
        this.distT = clamp(this.distT * Math.exp(e.deltaY * 0.0012), 6, 80);
        this.idle = 0;
      },
      { passive: false },
    );
    // arrow keys orbit, +/- zoom: the scene is explorable without a pointer
    window.addEventListener('keydown', (e) => this.keys.add(e.code));
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
  }

  /** Puts the boat at a point of the journey (0 = start, 1 = end). */
  place(t: number): void {
    this.z = JOURNEY_Z0 + (JOURNEY_Z1 - JOURNEY_Z0) * clamp(t, 0, 1);
    this.loopT = -1;
    this.fade = 0;
  }

  /** Jumps the camera to its targets (no easing), for stills. */
  settle(view?: { yaw?: number; pitch?: number; dist?: number }): void {
    if (view?.yaw !== undefined) this.yawT = view.yaw;
    if (view?.pitch !== undefined) this.pitchT = view.pitch;
    if (view?.dist !== undefined) this.distT = view.dist;
    this.yaw = this.yawT;
    this.pitch = this.pitchT;
    this.dist = this.distT;
    this.idle = -1e9;
  }

  update(dt: number, t: number, stroke: number): void {
    // keyboard orbit
    const k = this.keys;
    if (k.has('ArrowLeft')) this.yawT += dt * 1.2;
    if (k.has('ArrowRight')) this.yawT -= dt * 1.2;
    if (k.has('ArrowUp')) this.pitchT = clamp(this.pitchT + dt * 0.6, -0.04, 1.2);
    if (k.has('ArrowDown')) this.pitchT = clamp(this.pitchT - dt * 0.6, -0.04, 1.2);
    if (k.has('Equal') || k.has('NumpadAdd')) this.distT = clamp(this.distT * Math.exp(-dt), 6, 80);
    if (k.has('Minus') || k.has('NumpadSubtract')) this.distT = clamp(this.distT * Math.exp(dt), 6, 80);
    if (k.size) this.idle = 0;

    // the boat: a surge with each oar stroke
    this.boat.speed = SPEED * (1 + 0.07 * Math.sin(stroke * Math.PI * 2 - 0.6));
    if (this.loopT < 0) {
      this.z -= this.boat.speed * dt;
      if (this.z < JOURNEY_Z1 + 40) this.loopT = 0;
    } else {
      this.loopT += dt;
      this.z -= this.boat.speed * dt;
      if (this.loopT > LOOP_FADE && this.loopT - dt <= LOOP_FADE) this.z = JOURNEY_Z0;
      if (this.loopT > LOOP_FADE * 2) this.loopT = -1;
    }
    this.fade = this.loopT < 0 ? 0 : this.loopT < LOOP_FADE ? smoothstep(0, LOOP_FADE, this.loopT) : smoothstep(LOOP_FADE * 2, LOOP_FADE, this.loopT);

    const z = this.z;
    const x = laneX(z);
    // heading along the boat's own track, one metre ahead
    this.boat.heading = Math.atan2(laneX(z - 1) - x, -1);
    this.boat.pos.set(x, 0.03 * Math.sin(t * 1.3) + 0.02 * Math.sin(t * 2.1 + 1), z);
    this.boat.pitch = 0.012 * Math.sin(t * 1.1) + 0.006 * Math.sin(stroke * Math.PI * 2);
    this.boat.roll = 0.018 * Math.sin(t * 0.9 + 0.4) + 0.012 * Math.sin(stroke * Math.PI * 2 + 1.2);

    // camera: eases back to the resting view after a while, drifting slowly so it never sits still
    this.idle += dt;
    if (this.idle > IDLE_SECONDS) {
      const drift = REST.yaw + 0.28 * Math.sin(t * 0.035);
      this.yawT += angleDelta(this.yawT, drift) * (1 - Math.exp(-dt * 0.25));
      this.pitchT = damp(this.pitchT, REST.pitch, 0.25, dt);
      this.distT = damp(this.distT, REST.dist, 0.2, dt);
    }
    this.yaw = damp(this.yaw, this.yawT, 4, dt);
    this.pitch = damp(this.pitch, this.pitchT, 4, dt);
    this.dist = damp(this.dist, this.distT, 3, dt);

    const h = this.boat.heading;
    const fx = Math.sin(h);
    const fz = Math.cos(h);
    this.target.set(x + fx * 4, 2.4, z + fz * 4);
    const back = h + Math.PI + this.yaw;
    const cp = Math.cos(this.pitch) * this.dist;
    const cam = this.camera.position;
    cam.set(this.target.x + Math.sin(back) * cp, this.target.y + Math.sin(this.pitch) * this.dist, this.target.z + Math.cos(back) * cp);
    const ground = Math.max(terrainHeight(cam.x, cam.z), 0);
    cam.y = Math.max(cam.y, ground + 1.2);
    this.camera.lookAt(this.target);
    this.camera.updateMatrixWorld();
  }

  /** Field of view that keeps the river in frame on tall phone screens. */
  static fovFor(aspect: number): number {
    return aspect < 1 ? 62 + (1 - aspect) * 18 : 48;
  }
}
