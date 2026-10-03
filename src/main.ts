import { Color, PCFShadowMap, PerspectiveCamera, SRGBColorSpace, Scene, Vector3, WebGLRenderer } from 'three';
import { Soundscape } from './audio/soundscape';
import { G, LAYER_NO_REFLECT, LAYER_WATER } from './core/globals';
import { clamp } from './core/mathx';
import { Clock, SPEEDS } from './env/clock';
import type { SkyEvent, SkyEventKind } from './env/clock';
import { Environment } from './env/environment';
import { applySeason, dayOfYear, makeSeasonState, moonAgeOn, seasonAt, seasonIndex, seasonMiddle } from './env/season';
import { Weather, type WeatherChoice } from './env/weather';
import { Wind } from './env/wind';
import { Pipeline } from './render/pipeline';
import { loadSurfaces } from './render/surfaces';
import { setMaxAnisotropy } from './render/textures';
import { Director } from './rig/director';
import { Rig, VIEWS } from './rig/rig';
import type { ViewName } from './rig/rig';
import { EVENT_NOW, clockLabel } from './ui/bangla';
import { Controls } from './ui/controls';
import { WEATHER_PICKS } from './ui/controls';
import type { CameraChoice, WeatherPick } from './ui/controls';
import { Hud } from './ui/hud';
import { Bil } from './world/bil';
import { buildSaltWorks } from './world/coast';
import { RiverTraffic } from './world/boats';
import { WETLANDS, terrainHeight } from './world/geography';
import { Drift } from './world/drift';
import { Fishing, fishingClearings } from './world/fishing';
import { HeroBoat } from './world/hero';
import { Life } from './world/life';
import { Meadow } from './world/meadow';
import { buildPondLife } from './world/ponds';
import { buildRain } from './world/rain';
import { buildSky } from './world/sky';
import { buildTerrain } from './world/terrain';
import { buildVegetation } from './world/vegetation';
import { buildVillages, planHuts } from './world/village';
import { buildWater } from './world/water';

const BLACK = new Color(0, 0, 0);
const MIST = new Color(0.8, 0.72, 0.6);
const DEBUG = new URLSearchParams(location.search).has('debug');
/** The first evening: golden hour, on today's date (its season, and its moon). */
const START_HOUR = 17.5;
/** How fast the river rises or falls toward the season's level when the season is changed (m/s). */
const LEVEL_RATE = 0.25;
/** Untouched this long, the camera turns to watch a sky event by itself; longer, the film tour starts. */
const WATCH_IDLE_MS = 12000;
const FILM_IDLE_MS = 75000;

/** Lets the loader repaint between build steps. */
const nextTask = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const isSun = (kind: SkyEventKind) => kind === 'sunrise' || kind === 'sunset';
const hourOf = (ev: SkyEvent) => (ev.time - Math.floor(ev.time)) * 24;
const notice = (ev: SkyEvent) => `${EVENT_NOW[ev.kind]} · ${clockLabel(hourOf(ev))}`;

async function main(hud: Hud): Promise<void> {
  const canvas = document.getElementById('c') as HTMLCanvasElement;
  let renderer: WebGLRenderer;
  try {
    renderer = new WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', stencil: false });
  } catch (err) {
    console.error(err);
    hud.error('দুঃখিত, এই ব্রাউজারে 3D দৃশ্যটি চালানো গেল না (WebGL 2 প্রয়োজন)।');
    return;
  }
  canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    hud.error('গ্রাফিক্স কার্ড সাড়া দিচ্ছে না। পাতাটি আবার লোড করুন।');
  });
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = PCFShadowMap;
  renderer.shadowMap.autoUpdate = false;
  renderer.info.autoReset = false;
  const aniso = renderer.capabilities.getMaxAnisotropy();
  setMaxAnisotropy(aniso);
  // the photo textures download while the first parts are built
  const surfacesLoading = loadSurfaces(Math.min(aniso, 8));

  const scene = new Scene();
  const camera = new PerspectiveCamera(48, innerWidth / innerHeight, 0.5, 6000);
  camera.layers.enable(LAYER_WATER);
  camera.layers.enable(LAYER_NO_REFLECT);
  const pipeline = new Pipeline(0.5);

  hud.progress(0.05);
  await nextTask();
  const sky = buildSky();
  scene.add(sky.mesh);
  const surfaces = await surfacesLoading;
  hud.progress(0.15);
  scene.add(buildTerrain(surfaces.ground));
  hud.progress(0.3);
  await nextTask();
  const water = buildWater(pipeline.reflection.target.texture, pipeline.reflection.textureMatrix, Math.min(aniso, 8));
  scene.add(water.mesh);
  hud.progress(0.42);
  await nextTask();
  const huts = planHuts();
  scene.add(buildVillages(huts));
  scene.add(buildSaltWorks());
  hud.progress(0.52);
  await nextTask();
  scene.add(buildVegetation(huts, surfaces.bark, fishingClearings()));
  scene.add(buildPondLife());
  const bil = new Bil();
  scene.add(bil.group);
  const meadow = new Meadow(huts);
  scene.add(meadow.group);
  const drift = new Drift();
  scene.add(drift.group);
  const fishing = new Fishing();
  scene.add(fishing.group);
  hud.progress(0.78);
  await nextTask();

  const hero = new HeroBoat();
  hero.setShadows(false);
  scene.add(hero.group);
  const traffic = new RiverTraffic();
  scene.add(traffic.group);
  const life = new Life();
  scene.add(life.group);
  const today = new Date();
  const clock = new Clock(START_HOUR, moonAgeOn(today), dayOfYear(today));
  const season = makeSeasonState();
  const weather = new Weather();
  const wind = new Wind();
  const rain = buildRain();
  scene.add(rain);
  const env = new Environment(sky, water);
  env.season = season;
  env.weather = weather;
  env.addTo(scene);
  env.setShadowMapSize(Math.min(4096, renderer.capabilities.maxTextureSize) >= 4096 && devicePixelRatio <= 1.5 ? 4096 : 2048);
  const rig = new Rig(camera, canvas);
  const director = new Director();
  const sound = new Soundscape();
  hero.onStroke = () => sound.splash();
  hud.progress(0.85);
  await nextTask();

  // ---- size and adaptive resolution ----
  const perf = { scale: 1, acc: 0, n: 0, frames: 0, cool: 0, locked: false, ms: 16, driftMs: 0, fishMs: 0 };
  const resize = () => {
    const w = Math.max(1, innerWidth);
    const h = Math.max(1, innerHeight);
    const k = Math.max(0.5, Math.min(devicePixelRatio || 1, 1.75) * perf.scale);
    const W = Math.round(w * k);
    const H = Math.round(h * k);
    renderer.setPixelRatio(1);
    renderer.setSize(W, H, false);
    camera.aspect = w / h;
    camera.fov = Rig.fovFor(w / h);
    camera.updateProjectionMatrix();
    pipeline.setSize(W, H);
    life.setPixelRatio(k);
  };
  resize();
  window.addEventListener('resize', resize);

  // ---- sound: browsers allow it only after the first touch or key ----
  let soundOn = false;
  const startSound = () => {
    if (!sound.muted) {
      sound.start();
      soundOn = true;
    }
  };
  for (const type of ['pointerdown', 'keydown'] as const) window.addEventListener(type, startSound, { passive: true });
  const toggleSound = () => {
    sound.setMuted(!sound.muted);
    if (!sound.muted) sound.start();
    soundOn = !sound.muted;
  };

  // ---- camera: follow the boat, fly free, or watch the film tour ----
  let lastInput = performance.now();
  let filmAuto = false;
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  /** The sky event being watched; `asked` when the viewer chose it rather than idling into it. */
  const watch: { event: SkyEvent | null; asked: boolean } = { event: null, asked: false };
  const noteInput = () => {
    lastInput = performance.now();
  };
  const setFilm = (on: boolean, auto = false) => {
    if (on) director.start();
    else director.stop(camera);
    filmAuto = on && auto;
    if (on) hud.dismissHint();
  };
  /** The viewer is steering: the film hands the camera back and any watching stops. */
  const takeOver = () => {
    noteInput();
    watch.asked = false;
    if (director.active) setFilm(false);
  };
  canvas.addEventListener('pointerdown', () => {
    hud.dismissHint();
    takeOver();
  });
  canvas.addEventListener('wheel', takeOver, { passive: true });

  const chooseCamera = (choice: CameraChoice) => {
    noteInput();
    if (choice === 'film') {
      if (!director.active) setFilm(true);
      return;
    }
    if (director.active) setFilm(false);
    rig.setMode(choice);
  };
  const viewNames = Object.keys(VIEWS) as ViewName[];
  let viewIndex = 0;
  const setView = (name: ViewName) => {
    noteInput();
    watch.asked = false;
    if (director.active) setFilm(false);
    viewIndex = viewNames.indexOf(name);
    rig.setView(name);
  };

  // ---- time ----
  let scrubbing = false;
  const stepSpeed = (dir: 1 | -1, wrap: boolean) => {
    const n = SPEEDS.length;
    const i = SPEEDS.indexOf(clock.speed) + dir;
    clock.speed = SPEEDS[wrap ? (i + n) % n : clamp(i, 0, n - 1)];
  };

  // ---- sky events: announce each one, and turn to watch it when asked or when nobody is steering ----
  const look = (ev: SkyEvent) => {
    watch.event = ev;
    watch.asked = true;
    if (director.active) setFilm(false);
    rig.lookNow();
  };
  const jump = (ev: SkyEvent) => {
    noteInput();
    clock.jumpTo(ev);
    look(ev);
    hud.toast(notice(ev), null);
  };
  const followSky = (now: number) => {
    if (watch.event && !clock.watching(watch.event)) {
      watch.event = null;
      watch.asked = false;
    }
    const idle = !reducedMotion && now - lastInput > WATCH_IDLE_MS;
    if (!watch.event) {
      const ev = clock.watchable();
      if (ev) {
        watch.event = ev;
        // a film tour that started by itself gives way to the sky; one the viewer chose plays on
        if (director.active && filmAuto) setFilm(false);
        if (!director.active) hud.toast(notice(ev), idle ? null : () => look(ev));
      }
    }
    rig.watch = watch.event && !director.active && (watch.asked || idle) ? (isSun(watch.event.kind) ? env.sunDir : env.moonDir) : null;
  };

  /** Moves to the middle of a season (or back to today's date); the river eases to its new level. */
  const chooseSeason = (choice: number | 'today') => {
    clock.setDayOfYear(choice === 'today' ? dayOfYear(new Date()) : seasonMiddle(choice));
  };
  /** Holds the weather (and the wind) as the viewer asks, or hands them back to the season. */
  const chooseWeather = (pick: WeatherPick) => {
    weatherPick = pick;
    weather.choice = pick === 'rain' || pick === 'storm' ? pick : pick === 'auto' ? 'auto' : 'clear';
    wind.override = pick === 'calm' ? 0.15 : pick === 'breeze' ? 0.8 : pick === 'windy' ? 1.8 : null;
  };
  let weatherPick: WeatherPick = 'auto';
  const controls = new Controls({
    togglePlay: () => {
      clock.playing = !clock.playing;
    },
    faster: () => stepSpeed(1, true),
    seek: (hour) => clock.setHour(hour),
    scrub: (active) => {
      scrubbing = active;
    },
    jump,
    camera: chooseCamera,
    view: setView,
    moon: (age) => clock.setMoonAge(age),
    season: chooseSeason,
    weather: chooseWeather,
    sound: toggleSound,
    touched: noteInput,
  });

  // ---- keyboard: one place for every shortcut (the help sheet lists them) ----
  const held = new Set<string>();
  window.addEventListener('keydown', (e) => {
    if (controls.helpOpen || e.ctrlKey || e.metaKey || e.altKey) return;
    // leave keys to a focused dropdown, and arrows to the focused timeline
    const target = e.target;
    if (target instanceof HTMLSelectElement || target instanceof HTMLTextAreaElement) return;
    if (target instanceof HTMLInputElement && /^(Arrow|Page|Home|End)/.test(e.code)) return;
    noteInput();
    held.add(e.code);
    if (rig.press(e.code, true)) takeOver();
    if (e.repeat) return;
    if (e.key === '?' || (e.code === 'Slash' && e.shiftKey)) {
      controls.toggleHelp();
      return;
    }
    switch (e.code) {
      case 'Space':
        if (target instanceof HTMLButtonElement) return;
        e.preventDefault();
        clock.playing = !clock.playing;
        break;
      case 'KeyY':
        chooseSeason((seasonIndex(clock.dayOfYear) + 1) % 6);
        break;
      case 'KeyB': {
        const i = WEATHER_PICKS.findIndex(([v]) => v === weatherPick);
        chooseWeather(WEATHER_PICKS[(i + 1) % WEATHER_PICKS.length][0]);
        controls.showWeather(weatherPick);
        break;
      }
      case 'BracketLeft':
        stepSpeed(-1, false);
        break;
      case 'BracketRight':
        stepSpeed(1, false);
        break;
      case 'KeyN': {
        const ev = clock.next();
        if (ev) jump(ev);
        break;
      }
      case 'KeyC':
        setFilm(!director.active);
        break;
      case 'Digit1':
        chooseCamera('follow');
        break;
      case 'Digit2':
        chooseCamera('free');
        break;
      case 'Digit3':
        chooseCamera('film');
        break;
      case 'KeyV':
        setView(viewNames[(viewIndex + 1) % viewNames.length]);
        break;
      case 'KeyR':
        setView('stern');
        break;
      case 'KeyM':
        toggleSound();
        break;
      case 'KeyF':
        controls.toggleFullscreen();
        break;
      case 'KeyH':
        controls.toggleUi();
        break;
    }
  });
  window.addEventListener('keyup', (e) => {
    held.delete(e.code);
    rig.press(e.code, false);
  });
  window.addEventListener('blur', () => {
    held.clear();
    rig.releaseKeys();
  });

  // ---- first frame state, then compile every program before the loader goes ----
  const debug = { freeze: false };
  let t = 0;
  const focus = new Vector3();
  /**
   * The season from the day of the year, the weather on it, and the wind they make; `settle` jumps
   * straight to where they are heading (for stills and a fresh season) instead of easing there.
   */
  const updateSky = (dt: number, settle: boolean) => {
    seasonAt(clock.dayOfYear, season);
    applySeason(season);
    const ease = settle ? 600 : dt;
    weather.update(ease, t, season);
    wind.update(ease, t, {
      strength: season.wind + weather.squall * 1.6,
      gusts: Math.min(1, season.gusts + weather.squall * 0.4),
      angle: season.windAngle,
    });
    G.uWet.value = weather.wet;
    G.uRain.value = weather.rain;
    rain.visible = weather.rain > 0.003;
    // the river rises and falls toward the season's level rather than jumping
    const level = G.uWaterLevel.value;
    G.uWaterLevel.value = settle ? season.water : level + clamp(season.water - level, -LEVEL_RATE * dt, LEVEL_RATE * dt);
    water.mesh.position.y = G.uWaterLevel.value;
    // the clouds drift on the wind
    const w = G.uWind.value;
    sky.shift.x += w.x * (0.4 + 0.6 * w.z) * dt * 0.0035;
    sky.shift.y += w.y * (0.4 + 0.6 * w.z) * dt * 0.0035;
  };
  const step = (dt: number) => {
    t += dt;
    G.uTime.value = t;
    clock.boost = held.has('KeyT') ? Math.max(1, 40 / clock.speed) : 1;
    if (!scrubbing) clock.advance(dt);
    updateSky(dt, false);
    env.update(clock.hour, clock.moonAge);
    followSky(performance.now());
    // the boat floats and is paddled by physics; the boatman's weight from last frame trims her
    rig.update(dt, t, hero.crew, G.uWind.value.z);
    const b = rig.boat;
    director.update(dt, t, camera, b.pos, b.course);
    hero.update(dt, t, env.lamp, b);
    water.boat.set(b.pos.x, b.pos.z, b.heading, b.speed);
    water.oar.set(hero.bladeLocal.x, hero.bladeLocal.z, hero.bladeDrive, hero.bladeWet);
    water.swirl.copy(hero.swirl);
    traffic.update(dt, t, b.pos.z);
    const simStart = performance.now();
    drift.update(dt, t, camera.position.z, b, hero.blade);
    // the bil's lilies give way to her hull and blade and are drawn back by their stems
    bil.update(dt, t, b, hero.blade, hero.bladeWet);
    perf.driftMs += (performance.now() - simStart - perf.driftMs) * 0.1;
    // the fishermen work their nets; the two nearest ring the water
    const fishStart = performance.now();
    fishing.update(dt, t, camera.position, water.nets);
    perf.fishMs += (performance.now() - fishStart - perf.fishMs) * 0.1;
    // birds and fireflies gather round whoever is being watched: the boat, or the free camera
    life.update(dt, t, rig.subject, rig.subjectHeading, env.night);
    sky.mesh.position.copy(camera.position);
    meadow.update(camera.position);
    // the shadow box rides ahead of the view, snapped so it redraws only every few metres
    if (director.active) focus.copy(director.focus);
    else rig.focus(focus);
    focus.set(Math.round(focus.x / 12) * 12, 0, Math.round(focus.z / 12) * 12);
    if (env.aimShadow(focus, false)) renderer.shadowMap.needsUpdate = true;
    if (weather.struck) sound.thunder();
    sound.update(dt, env.night, G.uWind.value.z, weather.rain);
  };
  updateSky(0, true);
  step(0);
  renderer.setRenderTarget(pipeline.sceneTarget);
  await renderer.compileAsync(scene, camera);
  renderer.setRenderTarget(null);
  hud.progress(1);

  let readyAt = performance.now();
  let last = performance.now();
  const frame = () => {
    renderer.info.reset();
    const now = performance.now();
    const raw = Math.max(0, (now - last) / 1000);
    last = now;
    perf.ms += (raw * 1000 - perf.ms) * 0.05;
    step(debug.freeze ? 0 : Math.min(raw, 0.05));
    if (!director.active && !reducedMotion && !watch.event && now - lastInput > FILM_IDLE_MS) setFilm(true, true);
    const intro = clamp(1 - (now - readyAt) / 2600, 0, 1);
    const cut = Math.max(intro, director.fade);
    // the journey's mist fade belongs to the boat; a free camera elsewhere doesn't see the boat loop
    const loop = rig.mode === 'follow' || director.active ? rig.fade : 0;
    pipeline.render(renderer, scene, camera, {
      exposure: env.exposure,
      fade: Math.max(cut, loop),
      fadeColor: loop > cut ? MIST : BLACK,
      night: env.night,
      letterbox: director.letterbox,
    });
    hud.setCaption(director.caption, director.captionAlpha, pipeline.bar);
    controls.update(clock, director.active ? 'film' : rig.mode, soundOn);

    // adaptive resolution: hold ~45–60 fps by trading pixels, never below 60% scale
    perf.frames++;
    if (perf.frames > 90 && !perf.locked && !document.hidden) {
      perf.acc += raw;
      if (++perf.n >= 60) {
        const avg = perf.acc / perf.n;
        perf.acc = 0;
        perf.n = 0;
        const before = perf.scale;
        if (avg > 0.024 && perf.scale > 0.6) {
          perf.scale = Math.max(0.6, perf.scale * (avg > 0.045 ? 0.82 : 0.9));
          perf.cool = now + 6000;
        } else if (avg < 0.0175 && perf.scale < 1 && now > perf.cool) {
          perf.scale = Math.min(1, perf.scale + 0.06);
          perf.cool = now + 3000;
        }
        if (before !== perf.scale) resize();
      }
    }
  };
  renderer.setAnimationLoop(frame);
  readyAt = performance.now();
  hud.ready();
  controls.show();

  if (DEBUG) {
    // hooks for headless stills: put the boat, the day and the camera where you want them and freeze
    interface ShotOptions {
      journey?: number;
      /** Local solar hour, 0..24 (12 = noon). */
      hour?: number;
      /** Moon's age in days since new moon (14.8 = full). */
      moon?: number;
      yaw?: number;
      pitch?: number;
      dist?: number;
      /** Turn to the sun or the moon: the follow camera frames it low, as when it rises or sets; the free camera looks straight at it. */
      face?: 'sun' | 'moon';
      /** Free camera at [x, y, z, yaw, pitch]. */
      free?: [number, number, number, number, number];
      film?: [number, number];
      /** Day of the year (0 = 1 January), or a season by index (0 গ্রীষ্ম … 5 বসন্ত, at its middle). */
      day?: number;
      season?: number;
      weather?: WeatherChoice;
      /** Hold the wind at this strength (null: follow the season again). */
      wind?: number | null;
    }
    const b0 = () => rig.boat;
    Object.assign(window, {
      __river: {
        ready: true,
        shot(o: ShotOptions) {
          if (o.moon !== undefined) clock.setMoonAge(o.moon);
          if (o.hour !== undefined) clock.setHour(o.hour);
          if (o.season !== undefined) clock.setDayOfYear(seasonMiddle(o.season));
          if (o.day !== undefined) clock.setDayOfYear(o.day);
          if (o.weather !== undefined) weather.choice = o.weather;
          if (o.wind !== undefined) wind.override = o.wind;
          watch.event = null;
          watch.asked = false;
          updateSky(0, true);
          // the boat goes in after the river has its level
          if (o.journey !== undefined) rig.place(o.journey);
          env.update(clock.hour, clock.moonAge);
          const body = o.face === 'sun' ? env.sunDir : env.moonDir;
          if (o.free) {
            const [x, y, z, yaw, pitch] = o.free;
            if (o.face) rig.placeFree(x, y, z, Math.atan2(body.x, body.z), Math.asin(body.y));
            else rig.placeFree(x, y, z, yaw, pitch);
          } else {
            rig.setMode('follow');
            if (o.face) rig.aim(body);
            rig.settle(o);
          }
          if (o.film) director.cue(o.film[0], o.film[1]);
          else director.stop(camera, true);
          director.letterbox = o.film ? 1 : 0;
          perf.locked = true;
          readyAt = -1e9;
          lastInput = performance.now();
          debug.freeze = false;
          clock.playing = false;
          step(0.001);
          meadow.update(camera.position, true);
          renderer.shadowMap.needsUpdate = true;
          debug.freeze = true;
        },
        /** Puts `count` mats of water hyacinth `ahead` metres in front of the boat, in her path. */
        mats(ahead = 14, count = 3) {
          const b = rig.boat;
          drift.placeMats(b.pos.x + Math.sin(b.heading) * ahead, b.pos.z + Math.cos(b.heading) * ahead, count);
        },
        /** The boat's motion now, for checking the physics. */
        boatState() {
          const r = (v: number, k = 1000) => Math.round(v * k) / k;
          return { x: r(b0().pos.x, 100), z: r(b0().pos.z, 100), heave: r(b0().pos.y), pitch: r(b0().rotX), roll: r(b0().rotZ), heading: r(b0().heading), course: r(b0().course), speed: r(b0().speed), crew: { x: r(hero.crew.x), z: r(hero.crew.z) }, reach: r(hero.reach), depth: r(-terrainHeight(b0().pos.x, b0().pos.z), 100) };
        },
        /**
         * Runs the world forward `seconds` (in 1/30 s steps, without drawing) and samples the boat every
         * `every` seconds: where she is, the water under her, the boatman's reach. For checking her route.
         */
        trace(seconds: number, every = 5) {
          const out: { z: number; x: number; depth: number; reach: number; speed: number }[] = [];
          const r = (v: number, k = 100) => Math.round(v * k) / k;
          debug.freeze = false;
          clock.playing = true;
          let worst = 0;
          for (let i = 1; i <= Math.round(seconds * 30); i++) {
            step(1 / 30);
            worst = Math.max(worst, hero.reach);
            if (i % Math.max(1, Math.round(every * 30)) === 0) {
              const b = b0();
              out.push({ z: r(b.pos.z, 10), x: r(b.pos.x, 10), depth: r(-terrainHeight(b.pos.x, b.pos.z)), reach: r(worst), speed: r(b.speed) });
              worst = 0;
            }
          }
          debug.freeze = true;
          clock.playing = false;
          return out;
        },
        /** Each lift net's state: where it is, what its fisherman is doing, the lever, his force, the net's load. */
        nets() {
          return fishing.state();
        },
        /** Where the small wetlands are. */
        wetlands() {
          return WETLANDS.map((w) => ({ x: Math.round(w.x), z: Math.round(w.z), r: w.r }));
        },
        /** Today's sky events, as { kind, hour }. */
        events() {
          return clock.today().map((ev) => ({ kind: ev.kind, hour: Math.round(hourOf(ev) * 100) / 100 }));
        },
        /** Hides every object with this name (debugging what draws where). */
        hide(name: string) {
          scene.traverse((o) => {
            if (o.name === name) o.visible = false;
          });
          step(0);
        },
        birds(ahead = 40) {
          life.launchAll(rig.boat.pos, rig.boat.heading, ahead);
          step(0.016);
        },
        resume() {
          debug.freeze = false;
          clock.playing = true;
        },
        info() {
          const cam = camera.position.toArray().map((v) => Math.round(v * 10) / 10);
          return { calls: renderer.info.render.calls, triangles: renderer.info.render.triangles, scale: perf.scale, ms: Math.round(perf.ms * 10) / 10, programs: renderer.info.programs?.length, camera: cam, mode: director.active ? 'film' : rig.mode, hour: Math.round(clock.hour * 100) / 100, driftMs: Math.round(perf.driftMs * 100) / 100, fishMs: Math.round(perf.fishMs * 100) / 100, rain: Math.round(G.uRain.value * 100) / 100, rainShown: rain.visible, wind: Math.round(G.uWind.value.z * 100) / 100 };
        },
      },
    });
  }
}

const hud = new Hud();
main(hud).catch((err: unknown) => {
  console.error(err);
  hud.error('দুঃখিত, দৃশ্যটি লোড করতে সমস্যা হয়েছে। পাতাটি আবার লোড করে দেখুন।');
});
