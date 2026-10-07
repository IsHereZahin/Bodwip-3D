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
// It also plays a visit (the map's places, rig/visits.ts): a place's own few shots in the viewer's world (no
// world of their own), joined by the same dissolves, from the viewer's view and back to it after the last.

/** A scene's world: the day of the year, the hour (or so long before or after that day's sunrise, sunset or moonrise), the moon, the weather and the wind. */
export interface SceneWorld {
  day: number;
  hour: number | { at: 'sunrise' | 'sunset' | 'moonrise'; offset: number };
  /** The moon's age in days (14.8 is full); left as it is if absent. */
  moon?: number;
  weather: WeatherChoice;
  /** Wind strength held for the scene, or null for the weather's own. */
  wind: number | null;
  /** The way the wind blows toward, held for the scene (radians, as env/wind.ts has it), or the season's own if absent. */
  windToward?: number;
  /**
   * How fast the sky's clock runs in the scene, times its own pace (1 if absent). Away from a rise or a set it
   * runs 0.1 h a second, a time-lapse no camera on the moon could hold through a shot.
   */
  pace?: number;
  /**
   * The scene's own passage of time instead (a sunrise, a sunset, a moonrise seen whole in a few seconds): the
   * hours past its opening hour at points through it, `[u, hours]` from u = 0 (0 h) to 1, passed through on a
   * smooth monotone curve, slow where the keys crowd (the sun on the horizon) and never stopping.
   */
  sweep?: readonly (readonly [number, number])[];
  /**
   * The rain through the scene (0..1), as `[u, rain]` keys passed through as a sweep's are, and how wet the land is
   * (0..1: soaked through by ½, puddles beyond): the film's own weather, so a scene can show the rain coming on,
   * a downpour, its easing, and the land wetting as it goes (each scene takes the wet up where the last left it).
   * Without them the `weather` choice rules and the land is as wet as it would be.
   */
  rain?: readonly (readonly [number, number])[];
  wet?: readonly (readonly [number, number])[];
}

const SWEEP_D: number[] = [];
const SWEEP_M: number[] = [];

/** The hours of a `sweep` at `u` (0..1): a monotone cubic through its keys (Fritsch–Carlson), so time never runs back or stops dead. */
export function sweepAt(keys: readonly (readonly [number, number])[], u: number): number {
  const n = keys.length;
  if (u <= keys[0][0]) return keys[0][1];
  if (u >= keys[n - 1][0]) return keys[n - 1][1];
  // (the secants and the slopes in reused arrays: a sweep is asked for every frame)
  const d = SWEEP_D;
  const m = SWEEP_M;
  d.length = m.length = 0;
  for (let i = 0; i < n - 1; i++) d.push((keys[i + 1][1] - keys[i][1]) / (keys[i + 1][0] - keys[i][0]));
  m.push(d[0]);
  for (let i = 1; i < n - 1; i++) m.push(d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2);
  m.push(d[n - 2]);
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) {
      m[i] = m[i + 1] = 0;
      continue;
    }
    const a = m[i] / d[i];
    const b = m[i + 1] / d[i];
    const h = a * a + b * b;
    if (h > 9) {
      const t = 3 / Math.sqrt(h);
      m[i] = t * a * d[i];
      m[i + 1] = t * b * d[i];
    }
  }
  let k = 0;
  while (u > keys[k + 1][0]) k++;
  const span = keys[k + 1][0] - keys[k][0];
  const t = (u - keys[k][0]) / span;
  const t2 = t * t;
  const t3 = t2 * t;
  return (2 * t3 - 3 * t2 + 1) * keys[k][1] + (t3 - 2 * t2 + t) * span * m[k] + (-2 * t3 + 3 * t2) * keys[k + 1][1] + (t3 - t2) * span * m[k + 1];
}

/** The film's petal's way (world/petals.ts HeroPetal): `tau` is seconds after it lets go of its bough. */
export interface PetalWay {
  /** Where it leaves its bough, and where it comes down on the water. */
  readonly from: Vector3;
  readonly to: Vector3;
  /** Seconds from its bough to the water. */
  readonly fall: number;
  at(tau: number, out: Vector3): Vector3;
  /** Its way without its swing from side to side. */
  slowAt(tau: number, out: Vector3): Vector3;
}

/** What the tour may do to the world, and read from it (main.ts provides it). */
export interface Stage {
  /** Sets the world for a scene, at once (the water's level, the weather, the waves and all). */
  set(world: SceneWorld): void;
  /** The film's own rain and wet now (0..1 each; see SceneWorld.rain). */
  weather(rain: number, wet: number): void;
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
  /** The scene's clock at this many hours past its opening hour (`SceneWorld.sweep`). */
  sweep(hours: number): void;
  /** The majhi bareheaded, his mathal set down (as the rain begins: he will see to it himself, hero.ts). */
  bareheaded(): void;
  /** The date palm the film climbs (world/khejur.ts): its foot, its tapping cut, its pot's mouth, the way the cut faces; and the shot of its sap begun. */
  readonly sapTree: { readonly foot: Vector3; readonly cut: Vector3; readonly mouth: Vector3; readonly out: Vector3 };
  sap(): void;
  /** The film's petal over the khal (tour.ts blossomTree), and its letting go `at` s into its fall (negative: so long before it lets go). */
  readonly petal: PetalWay;
  dropPetal(at: number): void;
  readonly sunDir: Vector3;
  readonly moonDir: Vector3;
  /**
   * Builds what of each point's surroundings is not built yet (the ground, the grass, the crops), without showing
   * it: the ground all of it, the rest within a moment's budget (their own updates finish it).
   */
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
  /**
   * A further shot of the scene before it, cut to as a film cuts within a scene (a short dissolve): its world goes
   * on as it is (its own `world` unused), and so does the boat unless it has its own `journey` (a cut that leaves
   * time out: she is put on there). The viewer's previous and next pass the whole scene.
   */
  shot?: boolean;
  /** How long (s) it dissolves in over the shot before it, if not the usual (`DISSOLVE`, or `SHOT_DISSOLVE` for a further shot). */
  dissolve?: number;
  /** Its world; a visit's shots have none (they are seen in the viewer's own). */
  world?: SceneWorld;
  /** Where the boat is on her journey as the scene (or a further shot) opens, for scenes in her waters; else she goes on. */
  journey?: number;
  /**
   * Once, as the scene opens and after its world is set: cue the birds or the train. `at`: seconds into the scene
   * it opens at (0 as the film plays; a still cued partway through starts there, its cues as far on).
   */
  begin?(stage: Stage, at: number): void;
  /** The camera at `u` (0..1 through the scene): where it is and what it looks at. */
  pose(u: number, stage: Stage, pos: Vector3, look: Vector3): void;
  /**
   * A shot with a shallow depth of field: the distance in focus at `u` (m), the camera at `eye` (posed by `pose`
   * first). Without it the whole frame is sharp.
   */
  focus?(u: number, stage: Stage, eye: Vector3): number;
  /** How open the lens is (with `focus`): the far distance is blurred over this share of the frame's height times 1 m over the focus. Default `APERTURE`. */
  aperture?: number;
}

/** The lens for a shot (render/pipeline.ts): the distance in focus (m), and how open it is (`Scene.aperture`; 0: all sharp). */
export interface Dof {
  focus: number;
  aperture: number;
}

/** A close shot's lens: focused 1.2 m off, the far distance blurred over 1% of the frame's height. */
const APERTURE = 0.012;

/** What main.ts draws for the shot being left, each frame of a dissolve. */
export interface Leaving {
  readonly camera: PerspectiveCamera;
  /** Where the boat is in that shot, if the shot coming in has moved her elsewhere; else null (she is where she is). */
  readonly boat: Vector3 | null;
  /** Its lens. */
  readonly dof: Dof;
}

/** Seconds a dissolve takes between scenes, and between the shots of one scene. */
const DISSOLVE = 2.2;
const SHOT_DISSOLVE = 0.7;
/** Seconds before a cut that the next shot's places begin to be built (a place thick with grass and crops takes a second or more of building, a few milliseconds a frame). */
const WARM_AHEAD = 9;
/** Where through a shot its places are readied. */
const PATH = [0, 0.25, 0.5, 0.75, 1] as const;
/** The boat's usual way (m/s), for guessing where she will be through a shot not yet begun. */
const CRUISE = 1.2;
/** How a shot's own camera move carries on past its end while it dissolves away: slowing over this many seconds. */
const CARRY = 1.2;
/** Seconds into a scene after which "previous" starts it again rather than going back to the one before. */
const RESTART = 3;

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
  /** The current shot's lens. */
  readonly dof: Dof = { focus: 10, aperture: 0 };

  private playing = false;
  private index = 0;
  private time = 0;
  private readonly scenes: readonly Scene[];
  /** A visit's shots while one plays (the map's), else null: the film's scenes. */
  private visitShots: readonly Scene[] | null = null;
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
  private readonly leavingView: { camera: PerspectiveCamera; boat: Vector3 | null; dof: Dof };
  /** The viewer's camera as it moves, for leaving it moving. */
  private readonly viewPos = new Vector3();
  private readonly viewVel = new Vector3();
  private readonly tmp = new Vector3();
  private readonly tmp2 = new Vector3();
  /** The boat as a scene is entered, to tell whether it moved her. */
  private readonly boatWas = new Vector3();
  /** How long the dissolve into the shot now showing takes (s). */
  private dissolveFor = DISSOLVE;
  /** Seconds into the scene now showing (all its shots). */
  private sceneTime = 0;
  /** A skip asked for while a dissolve was still going on, taken once it has (0: none). */
  private queued = 0;
  private readonly scenesShown: number;

  constructor(scenes: readonly Scene[], stage: Stage) {
    this.scenes = scenes;
    this.stage = stage;
    this.scenesShown = scenes.filter((s) => !s.shot).length;
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
    this.leavingView = { camera: this.outCamera, boat: null, dof: { focus: 10, aperture: 0 } };
  }

  /** The tour, or a visit, is on. */
  get active(): boolean {
    return this.playing;
  }

  /** A visit from the map is playing (not the film). */
  get visiting(): boolean {
    return this.playing && this.visitShots !== null;
  }

  /** What is playing: a visit's shots, or the film's scenes. */
  private get list(): readonly Scene[] {
    return this.visitShots ?? this.scenes;
  }

  /** Which scene is showing (from 0, its shots counted as one), and how many there are. */
  get sceneIndex(): number {
    let k = -1;
    for (let i = 0; i <= this.index; i++) if (!this.scenes[i].shot) k++;
    return Math.max(0, k);
  }
  get sceneCount(): number {
    return this.scenesShown;
  }

  /** The first shot of the scene the shot `i` belongs to. */
  private firstShot(i: number): number {
    while (i > 0 && this.scenes[i].shot) i--;
    return i;
  }

  /**
   * On to the scene `step` from this one (−1 the one before, or this one's beginning once it has run a few
   * seconds; +1 the next), at the viewer's asking: cut as the film cuts by itself, this shot going on beneath
   * while the other dissolves in, from its beginning. Asked during a dissolve, it waits for it to end (cutting
   * then would drop the half-faded shot at once).
   */
  skip(step: number): void {
    if (!this.playing || this.visitShots) return;
    if (this.out) {
      this.queued = step;
      return;
    }
    const n = this.scenes.length;
    let i = this.firstShot(this.index);
    if (step > 0) {
      do i = (i + 1) % n;
      while (this.scenes[i].shot);
    } else if (this.sceneTime < RESTART) i = this.firstShot((i - 1 + n) % n);
    this.leaveScene();
    this.enter(i);
  }

  /** The shot being left, to draw beneath this frame's while a dissolve lasts; null otherwise. */
  get leaving(): Leaving | null {
    if (!this.out) return null;
    this.leavingView.boat = this.out.moved ? this.ghostPos : null;
    return this.leavingView;
  }

  /** Starts the tour: the viewer's view dissolves into the first scene, both moving. */
  start(camera: PerspectiveCamera): void {
    if (this.playing && !this.visitShots) return;
    if (this.visitShots) this.stop(true);
    this.leaveView(camera);
    this.stage.save();
    this.playing = true;
    this.enter(0);
  }

  /**
   * Plays a visit: the viewer's view dissolves into the place's first shot, both moving, and after its last the
   * camera dissolves back to the viewer's view. The viewer's world goes on as it is (the film playing is left at
   * once, its world put back). The first shot may put the boat on her way (`journey`).
   */
  visit(shots: readonly Scene[], camera: PerspectiveCamera): void {
    if (this.playing) this.stop(true);
    this.leaveView(camera);
    this.visitShots = shots;
    this.playing = true;
    this.enter(0);
  }

  /**
   * Hands the camera back, the film's shot dissolving into the viewer's view; `immediate` at once (a jump from the
   * map, under its own moment of dark; or a still), putting the viewer's world back unless `restore` is false
   * (stills keep the world they set).
   */
  stop(immediate = false, restore = true): void {
    if (!this.playing) return;
    // a visit kept the viewer's world: nothing to put back
    if (this.visitShots) restore = false;
    this.playing = false;
    this.queued = 0;
    if (immediate) {
      this.visitShots = null;
      this.finishLeaving();
      this.dissolve = 0;
      this.captionAlpha = 0;
      this.letterbox = 0;
      if (restore) this.stage.restore();
      return;
    }
    this.leaveScene();
    this.visitShots = null;
    if (restore) this.stage.restore();
    if (this.out) this.out.moved = true;
    // the hand-back is a full dissolve, whichever shot it leaves
    this.dissolveFor = DISSOLVE;
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
      // a skip asked for during the last dissolve, now it has ended
      if (this.queued !== 0 && !this.out) {
        const step = this.queued;
        this.queued = 0;
        this.skip(step);
      }
      const scene = this.list[this.index];
      this.time += dt;
      this.sceneTime += dt;
      // the end of the shot: on into the next, this one going on beneath it as it dissolves away; after a visit's
      // last, back to the viewer's view
      if (this.time >= scene.seconds) {
        if (this.visitShots && this.index === this.visitShots.length - 1) this.stop();
        else {
          this.leaveScene();
          this.enter((this.index + 1) % this.list.length);
        }
      }
      if (this.playing) this.play(dt, t, camera);
    }
    this.updateLeaving(dt, t, camera);
    this.letterbox = damp(this.letterbox, this.playing ? 1 : 0, 2.2, dt);
  }

  private play(dt: number, t: number, camera: PerspectiveCamera): void {
    const scene = this.list[this.index];
    this.frameCamera(scene, t, camera);
    // a caption still up as its scene is left (the viewer skipped on) fades before the next one's comes
    if (scene.caption !== this.caption && this.captionAlpha > 0.02) this.captionAlpha = damp(this.captionAlpha, 0, 9, dt);
    else {
      this.caption = scene.caption;
      this.captionAlpha = scene.caption ? clamp(Math.min((this.time - 1.2) / 0.9, (scene.seconds - 1.6 - this.time) / 0.9), 0, 1) : 0;
    }
    if (scene.world?.sweep && !scene.shot) this.stage.sweep(sweepAt(scene.world.sweep, clamp(this.time / scene.seconds, 0, 1)));
    if (scene.world && !scene.shot) this.rainAt(scene.world, clamp(this.time / scene.seconds, 0, 1));
    // the last seconds: build the next shot's places ahead, a little each frame (after a visit's last, none)
    const last = this.visitShots !== null && this.index === this.visitShots.length - 1;
    if (this.time > scene.seconds - WARM_AHEAD && !this.aheadDone && !last) {
      this.ahead ??= this.pathOf(this.list[(this.index + 1) % this.list.length], true);
      this.aheadDone = this.stage.warm(this.ahead);
    }
  }

  /** For stills: into a scene, at a point within it (its world set, the camera posed). */
  cue(index: number, u: number, camera: PerspectiveCamera): void {
    this.finishLeaving();
    this.visitShots = null;
    this.playing = true;
    const i = ((index % this.scenes.length) + this.scenes.length) % this.scenes.length;
    // a later shot of a scene: the scene opened (its cues as far on), and the boat on as far as she would have come by
    // then from the last shot that put her somewhere (the scene's first, or a later one leaving time out)
    const first = this.firstShot(i);
    let elapsed = this.scenes[i].seconds * clamp(u, 0, 1);
    for (let k = first; k < i; k++) elapsed += this.scenes[k].seconds;
    this.enter(first, elapsed);
    if (i !== first) {
      let from = first;
      for (let k = first + 1; k <= i; k++) if (this.scenes[k].journey !== undefined) from = k;
      let since = this.scenes[i].seconds * clamp(u, 0, 1);
      for (let k = from; k < i; k++) since += this.scenes[k].seconds;
      const placed = this.scenes[from].journey;
      if (placed !== undefined) this.stage.placeBoat(Math.min(1, placed + (since * CRUISE) / JOURNEY.length));
      this.index = i;
    }
    const scene = this.scenes[this.index];
    this.time = scene.seconds * clamp(u, 0, 1);
    if (scene.world?.sweep && !scene.shot) this.stage.sweep(sweepAt(scene.world.sweep, clamp(u, 0, 1)));
    if (scene.world && !scene.shot) this.rainAt(scene.world, clamp(u, 0, 1));
    this.letterbox = 1;
    this.frameCamera(scene, 0, camera);
    this.caption = scene.caption;
    this.captionAlpha = scene.caption ? 1 : 0;
  }

  /** For stills: into a visit's shot `index`, `u` through it (the boat put where its first shot puts her). */
  cueVisit(shots: readonly Scene[], index: number, u: number, camera: PerspectiveCamera): void {
    this.finishLeaving();
    this.visitShots = shots;
    this.playing = true;
    const i = clamp(Math.round(index), 0, shots.length - 1);
    const at = shots[i].seconds * clamp(u, 0, 1);
    this.enter(0, i === 0 ? at : 0);
    if (i > 0) this.enter(i, at);
    this.time = at;
    this.letterbox = 1;
    this.frameCamera(shots[i], 0, camera);
    this.caption = shots[i].caption;
    this.captionAlpha = shots[i].caption ? 1 : 0;
  }

  /** A scene's own rain and wet at `u` through it, if it has them. */
  private rainAt(world: SceneWorld, u: number): void {
    if (world.rain) this.stage.weather(sweepAt(world.rain, u), world.wet ? sweepAt(world.wet, u) : 0);
  }

  private enter(index: number, at = 0): void {
    const scene = this.list[index];
    this.index = index;
    this.time = 0;
    if (!scene.shot) this.sceneTime = 0;
    this.boatWas.copy(this.stage.boatPos);
    this.dissolveFor = scene.dissolve ?? (scene.shot ? SHOT_DISSOLVE : DISSOLVE);
    // a further shot of the same scene: its world goes on as it is (and the boat, unless the cut leaves time out)
    if (!scene.shot && scene.world) this.stage.set(scene.world);
    if (scene.journey !== undefined) this.stage.placeBoat(scene.journey);
    scene.begin?.(this.stage, at);
    // the shot being left keeps the boat where it had her if this one put her elsewhere (by its journey or in its
    // `begin`: the sunset's and the kash's do), or it would lose her and show her hole in the water
    if (this.out) this.out.moved = Math.hypot(this.stage.boatPos.x - this.boatWas.x, this.stage.boatPos.z - this.boatWas.z) > 0.5;
    this.ahead = null;
    this.aheadDone = false;
    // what was not built ahead: the ground now, along the whole shot, and the grass and crops begun (main.ts)
    this.stage.prepare(this.pathOf(scene, false));
  }

  // ---- the shot being left ----

  /** Leaves the scene now playing: its camera goes on as it was going, its boat on her way, in its kept world. */
  private leaveScene(): void {
    const scene = this.list[this.index];
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
    if (o.since >= this.dissolveFor) {
      this.finishLeaving();
      return;
    }
    this.dissolve = 1 - smoothstep(0, this.dissolveFor, o.since);
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
      this.lens(o.scene, 1, this.ghost, this.pos, this.leavingView.dof);
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
      this.leavingView.dof.aperture = 0;
    }
    cam.updateMatrixWorld();
  }

  /** A shot's lens at `u`, its camera at `eye`. */
  private lens(scene: Scene, u: number, stage: Stage, eye: Vector3, out: Dof): void {
    out.aperture = scene.focus ? (scene.aperture ?? APERTURE) : 0;
    if (scene.focus) out.focus = Math.max(0.3, scene.focus(u, stage, eye));
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
    this.lens(scene, u, this.stage, this.pos, this.dof);
    this.pos.x += Math.sin(t * 0.37) * 0.05;
    this.pos.y += Math.sin(t * 0.53) * 0.035;
    this.pos.y = Math.max(this.pos.y, Math.max(terrainHeight(this.pos.x, this.pos.z), waterLevelAt(this.pos.x, this.pos.z)) + 0.6);
    camera.position.copy(this.pos);
    camera.lookAt(this.look);
    camera.updateMatrixWorld();
    this.focus.copy(this.look);
  }
}
