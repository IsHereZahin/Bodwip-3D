import { PerspectiveCamera, Quaternion, Vector3 } from 'three';
import { clamp, damp, smoothstep } from '../core/mathx';
import type { WeatherChoice } from '../env/weather';
import { JOURNEY, journeyAt, journeyFrame, terrainHeight, waterLevelAt } from '../world/geography';

// The film tour's engine: it plays a list of scenes (rig/tour.ts), each a camera move in its own place,
// season, hour and weather, joined by dissolves, as a film is cut: the shot being left goes on moving while the
// next one, already moving, dissolves in over it. The next scene's world is set when it begins; the shot being
// left is drawn again each frame in its own world (main.ts keeps its look: the light, the sky, the season, the
// weather, its grass and crops, where the boat was) until it has gone. When the tour starts it saves the
// viewer's world (time, season, moon, weather, where the boat is) and puts it back when they take the camera
// again, dissolving each way between their view and the film's. The frame is letterboxed and each place is named.
// Nothing may appear in a shot: the ground, grass and crops along the next shot's path are built a little each
// frame through the last seconds of the one before.

/** A scene's world: the day of the year, the hour (or so long before or after that day's sunrise, sunset or moonrise), the moon, the weather and the wind. */
export interface SceneWorld {
  day: number;
  hour: number | { at: 'sunrise' | 'sunset' | 'moonrise'; offset: number };
  /** The moon's age in days (14.8 is full); left as it is if absent. */
  moon?: number;
  weather: WeatherChoice;
  /** Wind strength held for the scene, or null for the weather's own. */
  wind: number | null;
  /**
   * How fast the sky's clock runs in the scene, times its own pace (1 if absent). Away from a rise or a set it
   * runs 0.1 h a second, a time-lapse no camera on the moon could hold through a shot.
   */
  pace?: number;
}

/** What the tour may do to the world, and read from it (main.ts provides it). */
export interface Stage {
  /** Sets the world for a scene, at once (the water's level, the weather, the waves and all). */
  set(world: SceneWorld): void;
  /** Keeps the viewer's world, to put back after the tour. */
  save(): void;
  restore(): void;
  /** Puts the boat at a point of her journey (0 start .. 1 end). */
  placeBoat(journey: number): void;
  /** The boat now: where she is, how she moves, and which way she is going. */
  readonly boatPos: Vector3;
  readonly boatVel: Vector3;
  readonly boatCourse: number;
  /** Sends the flocks of birds across, near a point and heading. */
  birds(at: Vector3, heading: number): void;
  /** Puts the train's nose `s` m along the railway (from its east end), running west if `west`. */
  train(s: number, west: boolean): void;
  /** Puts the fisherman `at` s into his cast (world/fisher.ts: he throws a little over three seconds in). */
  fisherman(at: number): void;
  /** Puts the gher's fisherman (world/saltworks.ts, in the rains) `at` s into his cast. */
  gherFisherman(at: number): void;
  /** Lightning strikes at these many seconds from now, within the view (world/lightning.ts). */
  lightning(seconds: readonly number[]): void;
  readonly sunDir: Vector3;
  readonly moonDir: Vector3;
  /** Builds whatever of each point's surroundings is not built yet (the ground, the grass, the crops), without showing it. */
  prepare(points: readonly Vector3[]): void;
  /** Builds a little of the same within this frame's budget; true once all of it is built. */
  warm(points: readonly Vector3[]): boolean;
  /** The shot now showing is being left: keep its look (its world, its light, its grass and crops, the boat) to draw it under the next. */
  leave(): void;
  /** The shot being left has dissolved away. */
  left(): void;
}

export interface Scene {
  caption: string;
  seconds: number;
  world: SceneWorld;
  /** Where the boat is on her journey as the scene opens, for scenes in her waters; else she goes on. */
  journey?: number;
  /** Once, as the scene opens and after its world is set: cue the birds or the train. */
  begin?(stage: Stage): void;
  /** The camera at `u` (0..1 through the scene): where it is and what it looks at. */
  pose(u: number, stage: Stage, pos: Vector3, look: Vector3): void;
}

/** What main.ts draws for the shot being left, each frame of a dissolve. */
export interface Leaving {
  readonly camera: PerspectiveCamera;
  /** Where the boat is in that shot, if the shot coming in has moved her elsewhere; else null (she is where she is). */
  readonly boat: Vector3 | null;
}

/** Seconds a dissolve takes. */
const DISSOLVE = 2.2;
/** Seconds before a cut that the next shot's places begin to be built. */
const WARM_AHEAD = 6;
/** Where through a shot its places are readied. */
const PATH = [0, 0.25, 0.5, 0.75, 1] as const;
/** The boat's usual way (m/s), for guessing where she will be through a shot not yet begun. */
const CRUISE = 1.2;
/** How a shot's own camera move carries on past its end while it dissolves away: slowing over this many seconds. */
const CARRY = 1.2;

/** The shot being left, while the next dissolves in over it. */
interface Outgoing {
  /** Its scene, or null for the viewer's own view. */
  scene: Scene | null;
  since: number;
  /** Its camera as it was left (`look` unused for the viewer's view, which keeps `quat`), and how they were moving (m/s). */
  pos: Vector3;
  look: Vector3;
  quat: Quaternion;
  vPos: Vector3;
  vLook: Vector3;
  /** The boat as that shot had her, how she was moving, her course; whether the shot coming in moved her away. */
  boat: Vector3;
  boatVel: Vector3;
  course: number;
  moved: boolean;
  /** Its sun and moon: a shot posed by them (the night's) is posed by its own, not the one coming in. */
  sun: Vector3;
  moon: Vector3;
}

export class Director {
  /** 0..1, eased: how far the letterbox bars have closed. */
  letterbox = 0;
  caption = '';
  captionAlpha = 0;
  /** 0..1: how much of the shot being left still shows. */
  dissolve = 0;
  /** What the current shot looks at; the shadow map and the wildlife follow it. */
  readonly focus = new Vector3();

  private playing = false;
  private index = 0;
  private time = 0;
  private readonly scenes: readonly Scene[];
  private readonly stage: Stage;
  private readonly pos = new Vector3();
  private readonly look = new Vector3();
  /** The stage as a shot not yet begun will see it: the boat where she will be (`guessPos`, `guessCourse`). */
  private readonly guess: Stage;
  private readonly guessPos = new Vector3();
  private guessCourse = 0;
  /** The next shot's places, while they are being built ahead of its cut; done once built. */
  private ahead: Vector3[] | null = null;
  private aheadDone = false;
  /** The shot being left, and the stage as it sees the boat (where she was, going on as she went). */
  private out: Outgoing | null = null;
  private readonly ghost: Stage;
  private readonly ghostPos = new Vector3();
  private readonly outCamera = new PerspectiveCamera();
  private readonly leavingView: { camera: PerspectiveCamera; boat: Vector3 | null };
  /** The viewer's camera as it moves, for leaving it moving. */
  private readonly viewPos = new Vector3();
  private readonly viewVel = new Vector3();
  private readonly tmp = new Vector3();
  private readonly tmp2 = new Vector3();
  /** The boat as a scene is entered, to tell whether it moved her. */
  private readonly boatWas = new Vector3();

  constructor(scenes: readonly Scene[], stage: Stage) {
    this.scenes = scenes;
    this.stage = stage;
    const self = this;
    this.guess = Object.create(stage, {
      boatPos: { get: () => self.guessPos },
      boatCourse: { get: () => self.guessCourse },
    }) as Stage;
    this.ghost = Object.create(stage, {
      boatPos: { get: () => self.ghostPos },
      boatCourse: { get: () => self.out?.course ?? 0 },
      sunDir: { get: () => self.out?.sun ?? stage.sunDir },
      moonDir: { get: () => self.out?.moon ?? stage.moonDir },
    }) as Stage;
    this.leavingView = { camera: this.outCamera, boat: null };
  }

  /** The tour is on. */
  get active(): boolean {
    return this.playing;
  }

  /** Which scene is showing (from 0), and how many there are. */
  get sceneIndex(): number {
    return this.index;
  }
  get sceneCount(): number {
    return this.scenes.length;
  }

  /**
   * On to the scene `step` from this one (−1 the one before, +1 the next), at the viewer's asking: cut as the
   * film cuts by itself, this shot going on beneath while the other dissolves in, from its beginning.
   */
  skip(step: number): void {
    if (!this.playing) return;
    const n = this.scenes.length;
    this.leaveScene();
    this.enter((((this.index + step) % n) + n) % n);
  }

  /** The shot being left, to draw beneath this frame's while a dissolve lasts; null otherwise. */
  get leaving(): Leaving | null {
    if (!this.out) return null;
    this.leavingView.boat = this.out.moved ? this.ghostPos : null;
    return this.leavingView;
  }

  /** Starts the tour: the viewer's view dissolves into the first scene, both moving. */
  start(camera: PerspectiveCamera): void {
    if (this.playing) return;
    this.leaveView(camera);
    this.stage.save();
    this.playing = true;
    this.enter(0);
  }

  /** Hands the camera back, the film's shot dissolving into the viewer's view; `immediate` (for stills) at once, without putting the viewer's world back. */
  stop(immediate = false): void {
    if (!this.playing) return;
    this.playing = false;
    if (immediate) {
      this.finishLeaving();
      this.dissolve = 0;
      this.captionAlpha = 0;
      this.letterbox = 0;
      return;
    }
    this.leaveScene();
    this.stage.restore();
    if (this.out) this.out.moved = true;
  }

  /**
   * Runs after the rig has placed its own camera, and before the frame is drawn; moves the camera while the tour
   * plays, and the shot being left while one dissolves away.
   */
  update(dt: number, t: number, camera: PerspectiveCamera): void {
    if (!this.playing) {
      // the viewer's view: how it moves, for leaving it moving when the tour starts
      if (dt > 0) this.viewVel.lerp(this.tmp.subVectors(camera.position, this.viewPos).divideScalar(dt), 1 - Math.exp(-6 * dt));
      this.viewPos.copy(camera.position);
      this.captionAlpha = damp(this.captionAlpha, 0, 6, dt);
    } else {
      const scene = this.scenes[this.index];
      this.time += dt;
      // the end of the shot: on into the next, this one going on beneath it as it dissolves away
      if (this.time >= scene.seconds) {
        this.leaveScene();
        this.enter((this.index + 1) % this.scenes.length);
      }
      this.play(t, camera);
    }
    this.updateLeaving(dt, t, camera);
    this.letterbox = damp(this.letterbox, this.playing ? 1 : 0, 2.2, dt);
  }

  private play(t: number, camera: PerspectiveCamera): void {
    const scene = this.scenes[this.index];
    this.frameCamera(scene, t, camera);
    this.caption = scene.caption;
    this.captionAlpha = scene.caption ? clamp(Math.min((this.time - 1.2) / 0.9, (scene.seconds - 1.6 - this.time) / 0.9), 0, 1) : 0;
    // the last seconds: build the next shot's places ahead, a little each frame
    if (this.time > scene.seconds - WARM_AHEAD && !this.aheadDone) {
      this.ahead ??= this.pathOf(this.scenes[(this.index + 1) % this.scenes.length], true);
      this.aheadDone = this.stage.warm(this.ahead);
    }
  }

  /** For stills: into a scene, at a point within it (its world set, the camera posed). */
  cue(index: number, u: number, camera: PerspectiveCamera): void {
    this.finishLeaving();
    this.playing = true;
    this.enter(((index % this.scenes.length) + this.scenes.length) % this.scenes.length);
    const scene = this.scenes[this.index];
    this.time = scene.seconds * clamp(u, 0, 1);
    this.letterbox = 1;
    this.frameCamera(scene, 0, camera);
    this.caption = scene.caption;
    this.captionAlpha = scene.caption ? 1 : 0;
  }

  private enter(index: number): void {
    const scene = this.scenes[index];
    this.index = index;
    this.time = 0;
    this.boatWas.copy(this.stage.boatPos);
    this.stage.set(scene.world);
    if (scene.journey !== undefined) this.stage.placeBoat(scene.journey);
    scene.begin?.(this.stage);
    // the shot being left keeps the boat where it had her if this one put her elsewhere (by its journey or in its
    // `begin`: the sunset's and the kash's do), or it would lose her and show her hole in the water
    if (this.out) this.out.moved = Math.hypot(this.stage.boatPos.x - this.boatWas.x, this.stage.boatPos.z - this.boatWas.z) > 0.5;
    this.ahead = null;
    this.aheadDone = false;
    // whatever was not built ahead is built now, along the whole shot
    this.stage.prepare(this.pathOf(scene, false));
  }

  // ---- the shot being left ----

  /** Leaves the scene now playing: its camera goes on as it was going, its boat on her way, in its kept world. */
  private leaveScene(): void {
    const scene = this.scenes[this.index];
    const o = this.beginLeaving();
    o.scene = scene;
    o.boat.copy(this.stage.boatPos);
    o.boatVel.copy(this.stage.boatVel).setY(0);
    o.course = this.stage.boatCourse;
    // where its camera is at its end, and how its own move was carrying it there
    this.ghostPos.copy(o.boat);
    const d = Math.min(0.5, scene.seconds * 0.05);
    scene.pose(1, this.ghost, o.pos, o.look);
    scene.pose(1 - d / scene.seconds, this.ghost, this.tmp, this.tmp2);
    o.vPos.subVectors(o.pos, this.tmp).divideScalar(d);
    o.vLook.subVectors(o.look, this.tmp2).divideScalar(d);
  }

  /** Leaves the viewer's own view: it goes on drifting as it was, turned as it is. */
  private leaveView(camera: PerspectiveCamera): void {
    const o = this.beginLeaving();
    o.scene = null;
    o.pos.copy(camera.position);
    o.quat.copy(camera.quaternion);
    o.vPos.copy(this.viewVel).clampLength(0, 6);
    o.boat.copy(this.stage.boatPos);
    o.boatVel.copy(this.stage.boatVel).setY(0);
    o.course = this.stage.boatCourse;
  }

  private beginLeaving(): Outgoing {
    // a dissolve still going on ends here
    this.finishLeaving();
    this.out = {
      scene: null,
      since: 0,
      pos: new Vector3(),
      look: new Vector3(),
      quat: new Quaternion(),
      vPos: new Vector3(),
      vLook: new Vector3(),
      boat: new Vector3(),
      boatVel: new Vector3(),
      course: 0,
      moved: false,
      sun: this.stage.sunDir.clone(),
      moon: this.stage.moonDir.clone(),
    };
    this.stage.leave();
    return this.out;
  }

  private finishLeaving(): void {
    if (!this.out) return;
    this.out = null;
    this.dissolve = 0;
    this.stage.left();
  }

  /** Moves the shot being left on, and lets it go once dissolved. */
  private updateLeaving(dt: number, t: number, camera: PerspectiveCamera): void {
    const o = this.out;
    if (!o) return;
    o.since += dt;
    if (o.since >= DISSOLVE) {
      this.finishLeaving();
      return;
    }
    this.dissolve = 1 - smoothstep(0, DISSOLVE, o.since);
    const cam = this.outCamera;
    cam.fov = camera.fov;
    cam.aspect = camera.aspect;
    cam.near = camera.near;
    cam.far = camera.far;
    cam.layers.mask = camera.layers.mask;
    cam.updateProjectionMatrix();
    // its own move carries on, easing off as it goes
    const carry = CARRY * (1 - Math.exp(-o.since / CARRY));
    this.ghostPos.copy(o.boat).addScaledVector(o.boatVel, o.since);
    if (o.scene) {
      o.scene.pose(1, this.ghost, this.pos, this.look);
      this.pos.addScaledVector(o.vPos, carry);
      this.look.addScaledVector(o.vLook, carry);
      this.pos.x += Math.sin(t * 0.37) * 0.05;
      this.pos.y += Math.sin(t * 0.53) * 0.035;
      this.pos.y = Math.max(this.pos.y, Math.max(terrainHeight(this.pos.x, this.pos.z), waterLevelAt(this.pos.x, this.pos.z)) + 0.6);
      cam.position.copy(this.pos);
      cam.lookAt(this.look);
    } else {
      cam.position.copy(o.pos).addScaledVector(o.vPos, carry);
      cam.quaternion.copy(o.quat);
    }
    cam.updateMatrixWorld();
  }

  /**
   * The camera's places through a scene. As it opens (`guessed` false) the boat is where she is and goes on at
   * her usual way; ahead of it, she is put where she will be: at the scene's place on her journey, or on from
   * where she is now.
   */
  private pathOf(scene: Scene, guessed: boolean): Vector3[] {
    const b = this.stage.boatPos;
    const s0 = guessed && scene.journey !== undefined ? scene.journey * JOURNEY.length : (journeyFrame(b.x, b.z)?.s ?? 0);
    return PATH.map((u) => {
      const p = journeyAt(Math.min(JOURNEY.length, s0 + u * scene.seconds * CRUISE));
      this.guessPos.set(p.x, b.y, p.z);
      this.guessCourse = p.heading;
      scene.pose(u, this.guess, this.pos, this.look);
      return this.pos.clone();
    });
  }

  /**
   * Poses the camera for this moment of the scene: its move at an even pace from first to last (a shot never
   * comes to rest: the dissolves take each one up moving and let it go moving), a breath of hand-held drift,
   * never in the ground or the water.
   */
  private frameCamera(scene: Scene, t: number, camera: PerspectiveCamera): void {
    const u = clamp(this.time / scene.seconds, 0, 1);
    scene.pose(u, this.stage, this.pos, this.look);
    this.pos.x += Math.sin(t * 0.37) * 0.05;
    this.pos.y += Math.sin(t * 0.53) * 0.035;
    this.pos.y = Math.max(this.pos.y, Math.max(terrainHeight(this.pos.x, this.pos.z), waterLevelAt(this.pos.x, this.pos.z)) + 0.6);
    camera.position.copy(this.pos);
    camera.lookAt(this.look);
    camera.updateMatrixWorld();
    this.focus.copy(this.look);
  }
}
