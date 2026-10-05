import { Vector3 } from 'three';
import type { PerspectiveCamera } from 'three';
import { clamp, damp, lerp, smoothstep } from '../core/mathx';
import type { WeatherChoice } from '../env/weather';
import { JOURNEY, journeyAt, journeyFrame, terrainHeight, waterLevelAt } from '../world/geography';

// The film tour's engine: it plays a list of scenes (rig/tour.ts), each a camera move in its own place,
// season, hour and weather, joined by dissolves. Before a cut the last frame is held; the next scene's
// world is set at once beneath it, and the held frame melts away over the new shot. When the tour starts
// it saves the viewer's world (time, season, moon, weather, where the boat is) and puts it back when they
// take the camera again, dissolving back to their view. The frame is letterboxed and each place is named.
// Nothing may appear in a shot: the ground, grass and crops along the next shot's path are built a little each
// frame through the last seconds of the one before, and whatever is left as the cut's frame is held.

/** A scene's world: the day of the year, the hour (or so long before or after that day's sunrise, sunset or moonrise), the moon, the weather and the wind. */
export interface SceneWorld {
  day: number;
  hour: number | { at: 'sunrise' | 'sunset' | 'moonrise'; offset: number };
  /** The moon's age in days (14.8 is full); left as it is if absent. */
  moon?: number;
  weather: WeatherChoice;
  /** Wind strength held for the scene, or null for the weather's own. */
  wind: number | null;
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
  /** The boat now: where she is, and which way she is going. */
  readonly boatPos: Vector3;
  readonly boatCourse: number;
  /** Sends the flocks of birds across, near a point and heading. */
  birds(at: Vector3, heading: number): void;
  /** Puts the train's nose `s` m along the railway (from its east end), running west if `west`. */
  train(s: number, west: boolean): void;
  readonly sunDir: Vector3;
  readonly moonDir: Vector3;
  /** Builds now what stands round each point (the ground, the grass, the crops), the first point last, so a shot opens on it whole. */
  prepare(points: readonly Vector3[]): void;
  /** Builds a little of the same within this frame's budget, without showing it; true once all of it is built. */
  warm(points: readonly Vector3[]): boolean;
}

export interface Scene {
  caption: string;
  seconds: number;
  world: SceneWorld;
  /** Where the boat is on her journey as the scene opens, for scenes in her waters; else she goes on. */
  journey?: number;
  /** The exposure, as a share of the light's own (a night lifted so it reads), else 1. */
  exposure?: number;
  /** Once, as the scene opens and after its world is set: cue the birds or the train. */
  begin?(stage: Stage): void;
  /** The camera at `u` (0..1 through the scene, eased): where it is and what it looks at. */
  pose(u: number, stage: Stage, pos: Vector3, look: Vector3): void;
}

/** Seconds a dissolve takes. */
const DISSOLVE = 1.8;
/** Seconds before a cut that the next shot's places begin to be built. */
const WARM_AHEAD = 6;
/** Where through a shot its places are readied. */
const PATH = [0, 0.25, 0.5, 0.75, 1] as const;
/** The boat's usual way (m/s), for guessing where she will be through a shot not yet begun. */
const CRUISE = 1.2;

type State = 'off' | 'opening' | 'playing' | 'closing';

export class Director {
  /** 0..1, eased: how far the letterbox bars have closed. */
  letterbox = 0;
  caption = '';
  captionAlpha = 0;
  /** Keep this frame for a dissolve (one frame before each cut). */
  hold = false;
  /** 0..1: how much of the held frame still shows. */
  dissolve = 0;
  /** What the current shot looks at; the shadow map and the wildlife follow it. */
  readonly focus = new Vector3();

  private state: State = 'off';
  private index = 0;
  private time = 0;
  private sinceCut = 99;
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

  constructor(scenes: readonly Scene[], stage: Stage) {
    this.scenes = scenes;
    this.stage = stage;
    const self = this;
    this.guess = Object.create(stage, {
      boatPos: { get: () => self.guessPos },
      boatCourse: { get: () => self.guessCourse },
    }) as Stage;
  }

  /** The exposure for this frame, as a share of the light's own: the scene's while the tour plays. */
  get exposure(): number {
    return this.state === 'playing' || this.state === 'closing' ? (this.scenes[this.index].exposure ?? 1) : 1;
  }

  /** The tour is on (or handing over at either end). */
  get active(): boolean {
    return this.state !== 'off';
  }

  start(): void {
    if (this.state === 'off') this.state = 'opening';
  }

  /** `immediate` (for stills) hands straight back without a dissolve or putting the viewer's world back. */
  stop(immediate = false): void {
    if (this.state === 'off') return;
    if (immediate || this.state === 'opening') {
      this.state = 'off';
      this.hold = false;
      if (immediate) {
        this.dissolve = 0;
        this.sinceCut = 99;
        this.captionAlpha = 0;
        this.letterbox = 0;
      }
      return;
    }
    this.state = 'closing';
  }

  /**
   * Runs after the rig has placed its own camera, and before the frame is drawn; overrides the camera while
   * the tour plays. A cut takes two frames: the first is drawn and held, the second opens the new shot
   * (its world set) with the held frame dissolving over it.
   */
  update(dt: number, t: number, camera: PerspectiveCamera): void {
    this.sinceCut += dt;
    const held = this.hold;
    this.hold = false;
    switch (this.state) {
      case 'opening':
        if (!held) {
          // hold the viewer's own frame (the rig's camera, as it is)
          this.hold = true;
          break;
        }
        this.stage.save();
        this.state = 'playing';
        this.enter(0);
        this.play(0, t, camera);
        break;
      case 'playing':
        // the frame before this one ended a scene and was held: on into the next
        if (held) this.enter((this.index + 1) % this.scenes.length);
        this.play(dt, t, camera);
        break;
      case 'closing':
        if (!held) {
          // hold the film's last frame
          this.frameCamera(this.scenes[this.index], t, camera);
          this.hold = true;
          break;
        }
        // put the viewer's world back and dissolve to their camera
        this.stage.restore();
        this.state = 'off';
        this.cut();
        this.captionAlpha = 0;
        break;
      case 'off':
        this.captionAlpha = damp(this.captionAlpha, 0, 6, dt);
        break;
    }
    this.letterbox = damp(this.letterbox, this.state === 'playing' || this.state === 'closing' ? 1 : 0, 2.2, dt);
    this.dissolve = this.sinceCut < DISSOLVE ? 1 - smoothstep(0, DISSOLVE, this.sinceCut) : 0;
  }

  private play(dt: number, t: number, camera: PerspectiveCamera): void {
    const scene = this.scenes[this.index];
    this.time += dt;
    this.frameCamera(scene, t, camera);
    this.caption = scene.caption;
    this.captionAlpha = scene.caption ? clamp(Math.min((this.time - 1.2) / 0.9, (scene.seconds - 1.6 - this.time) / 0.9), 0, 1) : 0;
    // the last seconds: build the next shot's places ahead, a little each frame
    if (this.time > scene.seconds - WARM_AHEAD && !this.aheadDone) {
      this.ahead ??= this.pathOf(this.scenes[(this.index + 1) % this.scenes.length], true);
      this.aheadDone = this.stage.warm(this.ahead);
    }
    // at the end of the scene, hold this frame: the next scene dissolves in from it
    this.hold = this.time >= scene.seconds;
  }

  /** For stills: into a scene, at a point within it (its world set, the camera posed). */
  cue(index: number, u: number, camera: PerspectiveCamera): void {
    this.state = 'playing';
    this.enter(((index % this.scenes.length) + this.scenes.length) % this.scenes.length);
    const scene = this.scenes[this.index];
    this.time = scene.seconds * clamp(u, 0, 1);
    this.sinceCut = 99;
    this.dissolve = 0;
    this.hold = false;
    this.letterbox = 1;
    this.frameCamera(scene, 0, camera);
    this.caption = scene.caption;
    this.captionAlpha = scene.caption ? 1 : 0;
  }

  private cut(): void {
    this.sinceCut = 0;
    this.dissolve = 1;
  }

  private enter(index: number): void {
    const scene = this.scenes[index];
    this.index = index;
    this.time = 0;
    this.cut();
    this.stage.set(scene.world);
    if (scene.journey !== undefined) this.stage.placeBoat(scene.journey);
    scene.begin?.(this.stage);
    this.ahead = null;
    this.aheadDone = false;
    // whatever was not built ahead is built now (the cut's frame is held meanwhile), along the whole shot
    this.stage.prepare(this.pathOf(scene, false));
    scene.pose(0, this.stage, this.pos, this.look);
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

  /** Poses the camera for this moment of the scene: an eased move, a breath of hand-held drift, never in the ground or the water. */
  private frameCamera(scene: Scene, t: number, camera: PerspectiveCamera): void {
    const u = clamp(this.time / scene.seconds, 0, 1);
    // eased at the ends, but never quite still, so a held frame and the next shot both carry motion
    const e = lerp(u, u * u * u * (u * (u * 6 - 15) + 10), 0.7);
    scene.pose(e, this.stage, this.pos, this.look);
    this.pos.x += Math.sin(t * 0.37) * 0.05;
    this.pos.y += Math.sin(t * 0.53) * 0.035;
    this.pos.y = Math.max(this.pos.y, Math.max(terrainHeight(this.pos.x, this.pos.z), waterLevelAt(this.pos.x, this.pos.z)) + 0.6);
    camera.position.copy(this.pos);
    camera.lookAt(this.look);
    camera.updateMatrixWorld();
    this.focus.copy(this.look);
  }
}
