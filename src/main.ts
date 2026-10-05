import { Color, PCFShadowMap, PerspectiveCamera, SRGBColorSpace, Scene, Vector3, WebGLRenderer } from 'three';
import type { InstancedMesh, Mesh } from 'three';
import { Soundscape } from './audio/soundscape';
import { G, LAYER_NO_REFLECT, LAYER_WATER } from './core/globals';
import { clamp } from './core/mathx';
import { Clock, SPEEDS } from './env/clock';
import type { SkyEvent, SkyEventKind } from './env/clock';
import { Environment } from './env/environment';
import { YEAR, applySeason, dayOfYear, makeSeasonState, moonAgeOn, seasonAt, seasonIndex, seasonMiddle } from './env/season';
import { setSunDay } from './env/astro';
import { Weather, type WeatherChoice } from './env/weather';
import { Wind } from './env/wind';
import { Pipeline } from './render/pipeline';
import { loadSurfaces } from './render/surfaces';
import { setMaxAnisotropy } from './render/textures';
import { Director, type Stage } from './rig/director';
import { tourScenes } from './rig/tour';
import { Rig, VIEWS } from './rig/rig';
import type { ViewName } from './rig/rig';
import { EVENT_NOW, clockLabel } from './ui/bangla';
import { Controls } from './ui/controls';
import { WEATHER_PICKS } from './ui/controls';
import type { CameraChoice, WeatherPick } from './ui/controls';
import { Hud } from './ui/hud';
import { Bil } from './world/bil';
import { WATER_LEVEL, terrainHeight } from './world/geography';
import { Drift } from './world/drift';
import { sea, updateSea } from './world/waves';
import { HeroBoat } from './world/hero';
import { Life } from './world/life';
import { Crops } from './world/crops';
import { Meadow } from './world/meadow';
import { buildPondLife } from './world/ponds';
import { buildRain } from './world/rain';
import { buildRoads } from './world/roads';
import { BRIDGE_CLEARING, bridgeTrees, buildBridge } from './world/bridge';
import { Girl } from './world/girl';
import { cullBeyond, setCullReach, updateCulling } from './render/cull';
import { buildSky } from './world/sky';
import { Terrain } from './world/terrain';
import { buildVegetation } from './world/vegetation';
import { buildVillages, planGhats, planHuts } from './world/village';
import { buildSanko } from './world/sanko';
import { buildYards } from './world/yard';
import { BANYAN_CLEARING, buildBanyan } from './world/banyan';
import { buildLandmarks } from './world/landmarks';
import { buildWater } from './world/water';

const BLACK = new Color(0, 0, 0);
const MIST = new Color(0.8, 0.72, 0.6);
const DEBUG = new URLSearchParams(location.search).has('debug');
/** The first evening: golden hour, on today's date (its season, and its moon); this many hours before that day's sunset (or at START_HOUR, if the sun does not set). */
const START_HOUR = 17.5;
const OPENING_BEFORE_SUNSET = 0.7;
/** The opening minutes stay clear whatever the season (s); then its weather comes. */
const OPENING_CLEAR_SECONDS = 300;
/** A chosen season comes on as the year turns to it over this many seconds; a chosen moon waxes or wanes to its phase over this many. */
const YEAR_TURN_SECONDS = 6;
const MOON_TURN_SECONDS = 4;
/** A season, weather or moon the viewer chooses holds this long, then the world eases back to today's. */
const SESSION_MS = 60000;
/** Days in the moon's month. */
const SYNODIC = 29.530589;
/** Untouched this long, the camera turns to watch a sky event by itself; longer, the film tour starts. */
const WATCH_IDLE_MS = 12000;
const FILM_IDLE_MS = 30000;

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
  // the ground in patches round the camera, finer near it (world/terrain.ts)
  const terrain = new Terrain(surfaces.ground);
  scene.add(terrain.group);
  hud.progress(0.3);
  await nextTask();
  const water = buildWater(pipeline.reflection.target.texture, pipeline.reflection.textureMatrix, Math.min(aniso, 8));
  scene.add(water.mesh, water.inland);
  hud.progress(0.42);
  await nextTask();
  // the homesteads: their houses round their yards, their haystacks, their ghats and boats
  const huts = planHuts();
  const ghats = planGhats();
  const villages = buildVillages(huts, ghats);
  scene.add(villages);
  scene.add(buildYards(huts));
  // the banyan at the hub, the zamindar house, its ghat and temple, the mosque, the tea stall
  scene.add(buildBanyan(surfaces.bark));
  scene.add(buildLandmarks());
  // everything standing, for the trees and the grass to keep clear of
  const standing = huts;
  hud.progress(0.52);
  await nextTask();
  // the trees (left undrawn beyond the haze: render/cull.ts)
  const vegetation = buildVegetation(standing, surfaces.bark, [BRIDGE_CLEARING, BANYAN_CLEARING], bridgeTrees());
  scene.add(vegetation);
  cullBeyond(vegetation, 1900);
  // the ways, in 1.3 km cells: the far ones are left undrawn
  const roads = buildRoads(terrainHeight);
  scene.add(roads);
  cullBeyond(roads, 2600);
  scene.add(buildBridge());
  scene.add(buildSanko());
  const girl = new Girl();
  scene.add(girl.group);
  scene.add(buildPondLife());
  const bil = new Bil();
  scene.add(bil.group);
  const meadow = new Meadow(standing, ghats);
  scene.add(meadow.group);
  const crops = new Crops();
  scene.add(crops.group);
  const drift = new Drift();
  scene.add(drift.group);
  hud.progress(0.78);
  await nextTask();

  const hero = new HeroBoat();
  hero.setShadows(false);
  scene.add(hero.group);
  const life = new Life();
  scene.add(life.group);
  const today = new Date();
  const clock = new Clock(START_HOUR, moonAgeOn(today), dayOfYear(today));
  // golden hour whatever the time of year: winter's sun is down well before half past five
  const sunset = clock.today().find((ev) => ev.kind === 'sunset');
  if (sunset) clock.setHour(hourOf(sunset) - OPENING_BEFORE_SUNSET);
  // the moon as it really is: from the day's moon at the start, going on with the clock's days
  const naturalMoon = { age: clock.moonAge, time: clock.time };
  const season = makeSeasonState();
  const weather = new Weather();
  weather.clearUntil = OPENING_CLEAR_SECONDS;
  const wind = new Wind();
  const rain = buildRain(girl.shelter);
  scene.add(rain);
  const env = new Environment(sky, water);
  env.season = season;
  env.weather = weather;
  env.addTo(scene);
  const SHADOW_BEST = Math.min(4096, renderer.capabilities.maxTextureSize) >= 4096 && devicePixelRatio <= 1.5 ? 4096 : 2048;
  env.setShadowMapSize(SHADOW_BEST);
  const rig = new Rig(camera, canvas);

  // ---- the film tour's stage: what its scenes set in the world (season, hour, moon, weather, the boat,
  // the birds) and read from it; the viewer's own world is kept and put back after ----
  let kept: { time: number; day: number; moon: number; speed: number; playing: boolean; weather: WeatherChoice; wind: number | null; journey: number } | null = null;
  const settleWorld = () => {
    updateSky(0, true);
    env.update(clock.hour, clock.moonAge);
  };
  const stage: Stage = {
    set(world) {
      yearTurn = null;
      moonTurn = null;
      clock.setDayOfYear(world.day);
      if (world.moon !== undefined) clock.setMoonAge(world.moon);
      const h = world.hour;
      if (typeof h === 'number') clock.setHour(h);
      else {
        clock.setHour(12);
        const ev = clock.today().find((e) => e.kind === h.at);
        clock.setHour(ev ? hourOf(ev) + h.offset : h.at === 'sunrise' ? 6 : 18);
      }
      // the scene's own time runs as it would
      clock.speed = 1;
      clock.playing = true;
      weather.choice = world.weather;
      wind.override = world.wind;
      settleWorld();
    },
    save() {
      finishTurns();
      kept = {
        time: clock.time,
        day: clock.dayOfYear,
        moon: clock.moonAge,
        speed: clock.speed,
        playing: clock.playing,
        weather: weather.choice,
        wind: wind.override,
        journey: rig.progress,
      };
    },
    restore() {
      if (!kept) return;
      clock.time = kept.time;
      clock.setDayOfYear(kept.day);
      clock.setMoonAge(kept.moon);
      clock.speed = kept.speed;
      clock.playing = kept.playing;
      weather.choice = kept.weather;
      wind.override = kept.wind;
      rig.place(kept.journey);
      settleWorld();
      kept = null;
    },
    placeBoat: (journey) => rig.place(journey),
    get boatPos() {
      return rig.boat.pos;
    },
    get boatCourse() {
      return rig.boat.course;
    },
    birds: (at, heading) => life.launchAll(at, heading, 60),
    get sunDir() {
      return env.sunDir;
    },
    get moonDir() {
      return env.moonDir;
    },
    prepare: (at) => {
      terrain.update(at, true);
      water.update(at.x, at.z, true);
      meadow.update(at, true);
      crops.update(at, true);
    },
  };
  const director = new Director(tourScenes(ghats), stage);
  const sound = new Soundscape();
  hero.onStroke = (power) => sound.splash(power);
  hud.progress(0.85);
  await nextTask();

  // ---- quality: the detail the device can afford (D7: in full on a good GPU, 30 fps on an ordinary laptop) ----
  /** `?quality=low|high` holds a tier; without it the low one comes in by itself if even the smallest picture is slow. */
  const QUALITY_ASKED = new URLSearchParams(location.search).get('quality');
  let quality: 'high' | 'low' = 'high';
  const setQuality = (q: 'high' | 'low') => {
    quality = q;
    const low = q === 'low';
    // less drawn far off, a coarser mirror, a smaller shadow map, the grass kept closer
    setCullReach(low ? 0.7 : 1);
    pipeline.setReflectionScale(low ? 0.33 : 0.5);
    env.setShadowMapSize(low ? 2048 : SHADOW_BEST);
    renderer.shadowMap.needsUpdate = true;
    meadow.setReach(low ? 0.7 : 1);
  };
  if (QUALITY_ASKED === 'low') setQuality('low');

  // ---- size and adaptive resolution ----
  const perf = { scale: 1, acc: 0, n: 0, frames: 0, cool: 0, locked: false, ms: 16, driftMs: 0 };
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
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  /** The sky event being watched; `asked` when the viewer chose it rather than idling into it. */
  const watch: { event: SkyEvent | null; asked: boolean } = { event: null, asked: false };
  const noteInput = () => {
    lastInput = performance.now();
  };
  const setFilm = (on: boolean) => {
    if (on) director.start();
    else director.stop();
    if (on) hud.quiet();
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
    // the film tour shows the sky's events itself, in its own time
    if (director.active) {
      watch.event = null;
      watch.asked = false;
      rig.watch = null;
      return;
    }
    if (watch.event && !clock.watching(watch.event)) {
      watch.event = null;
      watch.asked = false;
    }
    const idle = !reducedMotion && now - lastInput > WATCH_IDLE_MS;
    if (!watch.event) {
      const ev = clock.watchable();
      if (ev) {
        watch.event = ev;
        hud.toast(notice(ev), idle ? null : () => look(ev));
      }
    }
    rig.watch = watch.event && (watch.asked || idle) ? (isSun(watch.event.kind) ? env.sunDir : env.moonDir) : null;
  };

  // ---- the viewer's environment. A chosen season comes as the year turns to it over a few seconds (the
  // sun's path, the light, the land, the trees, the crops, the river all following the days as they roll
  // by), a chosen moon waxes or wanes to its phase, a chosen weather comes on at its own pace. Each holds
  // for a minute; then the world eases back to today's season, the season's weather and the real moon.
  const smooth = (x: number) => x * x * (3 - 2 * x);
  const wrap = (x: number, n: number) => ((x % n) + n) % n;
  /** The year turning to a chosen day: from which day, by how many (the short way round), and for how long so far. */
  let yearTurn: { from: number; by: number; t: number } | null = null;
  let moonTurn: { from: number; by: number; t: number } | null = null;
  let sessionUntil = 0;
  /** The day of the year the land and the sun show now: the clock's, or the turning year's. */
  const shownDay = () => (yearTurn ? wrap(yearTurn.from + yearTurn.by * smooth(Math.min(1, yearTurn.t / YEAR_TURN_SECONDS)), YEAR) : clock.dayOfYear);
  const shownMoon = () => (moonTurn ? wrap(moonTurn.from + moonTurn.by * smooth(Math.min(1, moonTurn.t / MOON_TURN_SECONDS)), SYNODIC) : clock.moonAge);
  /** Rolls the turning year and moon on; at the end the clock takes the new day and phase. */
  const turn = (dt: number) => {
    if (yearTurn) {
      yearTurn.t += dt;
      if (yearTurn.t >= YEAR_TURN_SECONDS) finishTurns();
      else setSunDay(shownDay());
    }
    if (moonTurn) {
      moonTurn.t += dt;
      if (moonTurn.t >= MOON_TURN_SECONDS) finishTurns();
    }
  };
  const finishTurns = () => {
    if (yearTurn) clock.setDayOfYear(wrap(yearTurn.from + yearTurn.by, YEAR));
    if (moonTurn) clock.setMoonAge(wrap(moonTurn.from + moonTurn.by, SYNODIC));
    yearTurn = null;
    moonTurn = null;
  };
  const startSession = () => {
    sessionUntil = performance.now() + SESSION_MS;
  };
  /** Turns the year to a season's middle (or to today's date); the river eases to its new level. */
  const chooseSeason = (choice: number | 'today', session = true) => {
    const from = shownDay();
    const to = choice === 'today' ? dayOfYear(new Date()) : seasonMiddle(choice);
    yearTurn = { from, by: wrap(to - from + YEAR / 2, YEAR) - YEAR / 2, t: 0 };
    if (session && choice !== 'today') startSession();
  };
  /** Holds the weather (and the wind) as the viewer asks, or hands them back to the season. */
  const chooseWeather = (pick: WeatherPick, session = true) => {
    weatherPick = pick;
    weather.choice = pick === 'drizzle' || pick === 'rain' || pick === 'storm' ? pick : pick === 'auto' ? 'auto' : 'clear';
    wind.override = pick === 'calm' ? 0.15 : pick === 'breeze' ? 0.8 : pick === 'windy' ? 1.8 : null;
    if (session && pick !== 'auto') startSession();
  };
  /** Waxes or wanes the moon to a phase (the short way round). */
  const chooseMoon = (age: number, session = true) => {
    const from = shownMoon();
    moonTurn = { from, by: wrap(age - from + SYNODIC / 2, SYNODIC) - SYNODIC / 2, t: 0 };
    if (session) startSession();
  };
  /** The minute is up: back to today's season, the season's weather and the real moon, all eased. */
  const backToToday = () => {
    sessionUntil = 0;
    chooseSeason('today', false);
    chooseWeather('auto', false);
    controls.showWeather('auto');
    chooseMoon(wrap(naturalMoon.age + (clock.time - naturalMoon.time), SYNODIC), false);
    hud.toast('আজকের ঋতু, আবহাওয়া আর চাঁদে ফিরছে', null);
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
    moon: (age) => chooseMoon(age),
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
    seasonAt(shownDay(), season);
    applySeason(season);
    const ease = settle ? 600 : dt;
    weather.update(ease, t, season);
    wind.update(ease, t, {
      strength: season.wind + weather.squall * 1.6,
      gusts: Math.min(1, season.gusts + weather.squall * 0.4),
      angle: season.windAngle,
    });
    // the ripples the wind and the rain raise: the boat, the floating plants and the water all ride them
    updateSea(ease, G.uWind.value.z, G.uWind.value.w, weather.rain, settle);
    G.uWet.value = weather.wet;
    G.uRain.value = weather.rain;
    rain.visible = weather.rain > 0.003;
    // the khal drifts down to its sluice faster when the season's runoff is high (the rains), slower in the dry months
    G.uFlowScale.value = season.flow;
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
    turn(dt);
    updateSky(dt, false);
    env.update(clock.hour, shownMoon());
    followSky(performance.now());
    // the boat floats and is paddled by physics; the boatman's weight from last frame trims her
    rig.update(dt, t, hero.crew);
    const b = rig.boat;
    director.update(dt, t, camera);
    hero.update(dt, t, env.lamp, b);
    girl.update(dt, t, b.pos, weather.rain);
    water.boat.set(b.pos.x, b.pos.z, b.heading, b.speed);
    water.oar.set(hero.bladeLocal.x, hero.bladeLocal.z, hero.bladeDrive, hero.bladeWet);
    water.swirl.copy(hero.swirl);
    const simStart = performance.now();
    // the hyacinth meets the hero's hull and blade
    drift.update(dt, t, camera.position, b, hero.blade);
    // the bil's lilies give way to her hull and blade and are drawn back by their stems
    bil.update(dt, t, b, hero.blade, hero.bladeWet);
    perf.driftMs += (performance.now() - simStart - perf.driftMs) * 0.1;
    // birds and fireflies gather round whoever is being watched: the boat, or the free camera
    life.update(dt, t, director.active ? director.focus : rig.subject, director.active ? rig.boat.course : rig.subjectHeading, env.night, weather.rain);
    sky.mesh.position.copy(camera.position);
    terrain.update(camera.position);
    water.update(camera.position.x, camera.position.z);
    meadow.update(camera.position);
    crops.update(camera.position);
    // the shadow box rides ahead of the view, snapped so it redraws only every few metres
    if (director.active) focus.copy(director.focus);
    else rig.focus(focus);
    focus.set(Math.round(focus.x / 12) * 12, 0, Math.round(focus.z / 12) * 12);
    if (env.aimShadow(focus, false)) renderer.shadowMap.needsUpdate = true;
    if (weather.struck) sound.thunder();
    sound.update(dt, env.night, G.uWind.value.z, weather.rain);
  };
  // the river, the khals and the bil stand at one level: what reads the sea's level reads it
  G.uWaterLevel.value = WATER_LEVEL;
  G.uTideHigh.value = WATER_LEVEL;
  updateSky(0, true);
  step(0);
  terrain.update(camera.position, true);
  water.update(camera.position.x, camera.position.z, true);
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
    if (!director.active && !reducedMotion && !watch.event && now - lastInput > FILM_IDLE_MS) setFilm(true);
    if (sessionUntil && now > sessionUntil && !director.active) backToToday();
    const cut = clamp(1 - (now - readyAt) / 2600, 0, 1);
    // the journey's mist fade belongs to the boat; a free camera elsewhere doesn't see the boat loop
    const loop = rig.mode === 'follow' || director.active ? rig.fade : 0;
    updateCulling(camera.position);
    pipeline.render(renderer, scene, camera, {
      exposure: env.exposure,
      fade: Math.max(cut, loop),
      fadeColor: loop > cut ? MIST : BLACK,
      night: env.night,
      letterbox: director.letterbox,
      hold: director.hold,
      dissolve: director.dissolve,
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
        // at the smallest picture and still under 30 fps: the lower tier, once, unless a tier was asked for
        if (perf.scale <= 0.6 && avg > 0.034 && quality === 'high' && !QUALITY_ASKED) {
          setQuality('low');
          perf.cool = now + 6000;
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
          // stills set the world at once
          yearTurn = null;
          moonTurn = null;
          sessionUntil = 0;
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
          if (o.film) director.cue(o.film[0], o.film[1], camera);
          else director.stop(true);
          director.letterbox = o.film ? 1 : 0;
          perf.locked = true;
          readyAt = -1e9;
          lastInput = performance.now();
          debug.freeze = false;
          clock.playing = false;
          step(0.001);
          terrain.update(camera.position, true);
          water.update(camera.position.x, camera.position.z, true);
          meadow.update(camera.position, true);
          crops.update(camera.position, true);
          renderer.shadowMap.needsUpdate = true;
          debug.freeze = true;
        },
        /** Puts `count` mats of water hyacinth `ahead` metres in front of the boat, in her path. */
        mats(ahead = 14, count = 3) {
          const b = rig.boat;
          drift.placeMats(b.pos.x + Math.sin(b.heading) * ahead, b.pos.z + Math.cos(b.heading) * ahead, count);
        },
        /** Puts `count` mats of water hyacinth at (x, z). */
        matsAt(x: number, z: number, count = 3) {
          drift.placeMats(x, z, count);
        },
        /** The boat's motion now, for checking the physics. */
        boatState() {
          const r = (v: number, k = 1000) => Math.round(v * k) / k;
          return { x: r(b0().pos.x, 100), z: r(b0().pos.z, 100), heave: r(b0().pos.y), pitch: r(b0().rotX), roll: r(b0().rotZ), heading: r(b0().heading), course: r(b0().course), speed: r(b0().speed), power: r(b0().power, 100), crew: { x: r(hero.crew.x), z: r(hero.crew.z) }, reach: r(hero.reach), depth: r(WATER_LEVEL - terrainHeight(b0().pos.x, b0().pos.z), 100) };
        },
        /**
         * Runs the world forward `seconds` (in 1/30 s steps, without drawing) and samples the boat every
         * `every` seconds: where she is, the water under her, the boatman's reach. For checking her route.
         */
        trace(seconds: number, every = 5) {
          const out: { z: number; x: number; along: number; depth: number; reach: number; speed: number }[] = [];
          const r = (v: number, k = 100) => Math.round(v * k) / k;
          debug.freeze = false;
          clock.playing = true;
          let worst = 0;
          for (let i = 1; i <= Math.round(seconds * 30); i++) {
            step(1 / 30);
            worst = Math.max(worst, hero.reach);
            if (i % Math.max(1, Math.round(every * 30)) === 0) {
              const b = b0();
              out.push({ z: r(b.pos.z, 10), x: r(b.pos.x, 10), along: r(rig.progress, 1000), depth: r(WATER_LEVEL - terrainHeight(b.pos.x, b.pos.z)), reach: r(worst), speed: r(b.speed) });
              worst = 0;
            }
          }
          debug.freeze = true;
          clock.playing = false;
          return out;
        },

        /** Today's sky events, as { kind, hour }. */
        events() {
          return clock.today().map((ev) => ({ kind: ev.kind, hour: Math.round(hourOf(ev) * 100) / 100 }));
        },
        /**
         * What the scene holds, by top-level group: meshes, instances and triangles (all of them, drawn or not);
         * with `group`, that group's geometries by triangles in all, the heaviest first.
         */
        stats(group?: string) {
          const out: Record<string, { meshes: number; instances: number; tris: number }> = {};
          scene.traverse((o) => {
            const m = o as Mesh;
            if (!m.isMesh) return;
            let top = o;
            while (top.parent && top.parent !== scene) top = top.parent;
            const g = m.geometry;
            const tris = (g.index ? g.index.count : g.getAttribute('position').count) / 3;
            const n = (m as InstancedMesh).isInstancedMesh ? (m as InstancedMesh).count : 1;
            const key = group ? (top.name === group ? (m.parent?.name || g.uuid.slice(0, 8)) + ':' + tris : '') : top.name || '?';
            if (!key) return;
            const e = (out[key] ??= { meshes: 0, instances: 0, tris: 0 });
            e.meshes++;
            e.instances += n;
            e.tris += tris * n;
          });
          return Object.fromEntries(Object.entries(out).sort((a, b) => b[1].tris - a[1].tris).slice(0, 40));
        },
        /** Hides every object with this name (debugging what draws where). */
        hide(name: string) {
          scene.traverse((o) => {
            if (o.name === name) o.visible = false;
          });
          step(0);
        },
        /** Shows again every object with this name (after `hide`). */
        show(name: string) {
          scene.traverse((o) => {
            if (o.name === name) o.visible = true;
          });
          step(0);
        },
        birds(ahead = 40) {
          life.launchAll(rig.boat.pos, rig.boat.heading, ahead);
          step(0.016);
        },
        /** Where the people's heads are (world) and the boat's heading, for framing them close. */
        people() {
          const at = (o: { getWorldPosition(v: Vector3): Vector3 }) => {
            const p = o.getWorldPosition(new Vector3());
            return [Math.round(p.x * 1000) / 1000, Math.round(p.y * 1000) / 1000, Math.round(p.z * 1000) / 1000];
          };
          return {
            boatman: at(hero.man.body.bone('head')),
            girl: at(girl.body.bone('head')),
            heading: rig.boat.heading,
            girlYaw: girl.group.rotation.y,
          };
        },
        resume() {
          debug.freeze = false;
          clock.playing = true;
        },
        /** The environment as shown now: the turning year and moon, the crops, the river, the weather, the session, and the sun against the view. */
        envState() {
          const r = (v: number, k = 100) => Math.round(v * k) / k;
          const fwd = camera.getWorldDirection(new Vector3());
          const sunOff = Math.acos(Math.max(-1, Math.min(1, fwd.dot(env.sunDir)))) * (180 / Math.PI);
          return {
            day: r(shownDay(), 10),
            clockDay: clock.dayOfYear,
            moon: r(shownMoon()),
            crops: G.uCrops.value.toArray().map((v) => r(v)),
            level: r(G.uWaterLevel.value),
            flow: r(G.uFlowScale.value),
            rain: r(weather.rain),
            cloud: r(weather.cloud),
            wind: r(G.uWind.value.z),
            weather: weather.choice,
            session: sessionUntil ? Math.round((sessionUntil - performance.now()) / 1000) : 0,
            turning: !!(yearTurn || moonTurn),
            sunElevation: r(Math.asin(env.sunDir.y) * (180 / Math.PI), 10),
            sunFromView: r(sunOff, 10),
          };
        },
        info() {
          const cam = camera.position.toArray().map((v) => Math.round(v * 10) / 10);
          return { calls: renderer.info.render.calls, triangles: renderer.info.render.triangles, scale: perf.scale, ms: Math.round(perf.ms * 10) / 10, programs: renderer.info.programs?.length, camera: cam, mode: director.active ? 'film' : rig.mode, quality, time: Math.round(G.uTime.value * 100) / 100, hour: Math.round(clock.hour * 100) / 100, driftMs: Math.round(perf.driftMs * 100) / 100, rain: Math.round(G.uRain.value * 100) / 100, rainShown: rain.visible, wind: Math.round(G.uWind.value.z * 100) / 100, seaWind: Math.round(sea.wind * 10) / 10, waveHeight: Math.round(sea.height * 100) / 100, wavePeak: Math.round(sea.peak * 10) / 10, chop: Math.round(sea.chop * 100) / 100 };
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
