import { Color, DirectionalLight, HemisphereLight, Matrix4, PCFShadowMap, PerspectiveCamera, PointLight, Quaternion, SRGBColorSpace, Scene, Sphere, Triangle, Vector3, Vector4, WebGLRenderer, type RenderTarget } from 'three';
import type { InstancedMesh, Light, Mesh, Object3D } from 'three';
import { Soundscape } from './audio/soundscape';
import { G, LAYER_NO_REFLECT, LAYER_WATER } from './core/globals';
import { clamp, smoothstep } from './core/mathx';
import { Clock, LAPSE, SPEEDS } from './env/clock';
import type { SkyEvent, SkyEventKind } from './env/clock';
import { Environment } from './env/environment';
import { SEASON_NAMES, YEAR, applySeason, bangladeshTime, banglaDate, makeSeasonState, moonAgeOn, seasonAt, seasonIndex, seasonMiddle } from './env/season';
import { YearJourney } from './rig/yearJourney';
import { SUNRISE, morningOn, planCinematic } from './rig/cinematic';
import { OPENING_SECONDS } from './rig/opening';
import { findSights } from './rig/showcase';
import { Sightlines } from './rig/sightlines';
import { setSunDay } from './env/astro';
import { Weather, type WeatherChoice } from './env/weather';
import { Wind, gustAt } from './env/wind';
import { Pipeline } from './render/pipeline';
import { loadSurfaces } from './render/surfaces';
import { setMaxAnisotropy } from './render/textures';
import { Director, sweepAt, type Leaving, type Stage } from './rig/director';
import { MapPanel } from './ui/mapPanel';
import { mapSpots } from './rig/visits';
import { WorldLook, type Captured } from './render/snapshot';
import { blossomTree, cropField, tourScenes } from './rig/tour';
import { Rig, VIEWS } from './rig/rig';
import type { ViewName } from './rig/rig';
import { EVENT_NOW, bn, clockLabel } from './ui/bangla';
import { Controls } from './ui/controls';
import type { CameraChoice, TimeMode } from './ui/controls';
import { Hud } from './ui/hud';
import { buildBackdrop } from './world/backdrop';
import { buildHillMist } from './world/hillMist';
import { buildCorridorMap } from './world/corridor';
import { Bil } from './world/bil';
import { JOURNEY, WATER_LEVEL, journeyAt, journeyFrame, setSaltWet, setWaterRise, terrainHeight, waterLevelAt, waterwayAt } from './world/geography';
import { Drift } from './world/drift';
import { SHOAL_DEPTH, sea, surfaceShare, updateSea, waveHeight } from './world/waves';
import { wakeHeight } from './world/wake';
import { HeroBoat } from './world/hero';
import { PaddleSplash } from './world/splash';
import { Khejur } from './world/khejur';
import { STROKE_SECONDS } from './world/paddle';
import { Life } from './world/life';
import { Crops } from './world/crops';
import { Meadow } from './world/meadow';
import { buildPondLife } from './world/ponds';
import { GroundSplashes, buildRain, buildRainSplashes } from './world/rain';
import { buildRoads } from './world/roads';
import { BRIDGE_CLEARING, bridgeTrees, buildBridge } from './world/bridge';
import { cullBeyond, setCullReach, updateCulling } from './render/cull';
import { buildSky } from './world/sky';
import { Terrain, meshGround } from './world/terrain';
import { buildVegetation, crownDetail, palmStems, treeCrowns } from './world/vegetation';
import { FallingLeaves } from './world/leaves';
import { HeroPetal, PetalCarpet } from './world/petals';
import { Fish } from './world/fish';
import { Falls } from './world/falls';
import { Frogs } from './world/frogs';
import { Turtles } from './world/turtles';
import { Songbirds } from './world/songbirds';
import { Fisher } from './world/fisher';
import { Harvest } from './world/harvest';
import { Lightning } from './world/lightning';
import { SaltWorks } from './world/saltworks';
import { buildStones } from './world/stones';
import { buildVillages, planGhats, planHuts } from './world/village';
import { buildSanko } from './world/sanko';
import { buildYards } from './world/yard';
import { BANYAN_CLEARING, GRAVE_BANYAN_CLEARING, GRAVEYARD_BANYAN, buildBanyan } from './world/banyan';
import { MOSQUE_POND_TREES } from './world/plan';
import { NIGHT_GLOWS, buildLandmarks, lampsGlow } from './world/landmarks';
import { KALIMA_FONT } from './render/textures';
import { Train, buildRailway } from './world/railway';
import { buildWater } from './world/water';
import { Ripples } from './world/ripples';
import { currentAt } from './world/boatPhysics';
import { HERO_HULL, heroBeamAtWater } from './world/hull';

const BLACK = new Color(0, 0, 0);
const MIST = new Color(0.8, 0.72, 0.6);
const DEBUG = new URLSearchParams(location.search).has('debug');
/** How far a press on the film must move (CSS pixels) to be a drag that takes the camera, not a tap. */
const DRAG_PX = 8;
/** The map's sheet is at most 1240 px wide (ui/map.css): a screen this wide or narrower (CSS px) is covered but for its margins. */
const MAP_COVERS = 1280;
/** Where the viewer's choice to mute the sound is remembered. */
const MUTED_KEY = 'nodi.muted';
/** The cinematic morning's first minutes stay clear whatever the season (s); then its weather comes. */
const OPENING_CLEAR_SECONDS = 300;
/** A chosen season comes on as the year turns to it over this many seconds; a chosen moon waxes or wanes to its phase over this many. */
const YEAR_TURN_SECONDS = 6;
const MOON_TURN_SECONDS = 4;
/** A season, weather or moon the viewer chooses holds this long, then the world eases back to the mode's own. */
const SESSION_MS = 60000;
/**
 * A change of mode (cinematic ↔ Live) passes through a moment of dark: down over the first (s), the other world
 * set at once under it, up over the second. Turned over in the open, the hour would sweep the sun backwards or
 * through a whole night.
 */
const DIP: readonly [number, number] = [0.6, 1.3];
/** Days in the moon's month. */
const SYNODIC = 29.530589;
/** How long the title stays over the opening flight (s): off before it is half over (the flight is 9 s), so the sun is seen coming up and the land lighting as it comes down. */
const TITLE_SECONDS = 6;
/** Untouched this long, the camera turns to watch a sky event by itself. */
const WATCH_IDLE_MS = 12000;
/** Milliseconds a frame may spend building the film's next shot ahead of it. */
const WARM_MS = 3;
/**
 * Milliseconds the cut's own frame may spend on the ground along the shot coming in, its grass and its crops (past
 * where it opens): past it they are built by their own updates over the next frames (nearest and ahead first,
 * growing in as the shot dissolves in) rather than stalling the cut.
 */
const PREPARE_MS = 30;

/** Lets the loader repaint between build steps. */
const nextTask = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/**
 * A group that never moves once built (the trees, the houses, the landmarks): its matrices are made once and none
 * is remade. (three's frame walk still visits each node, but one that neither remakes its own matrix nor is forced
 * by a parent remaking its own costs only the visit; with `matrixAutoUpdate` on, all of them were remade every
 * frame.) Nothing in it may be moved afterwards: it would stand where it was.
 */
const still = <T extends Object3D>(group: T): T => {
  group.updateMatrixWorld(true);
  group.traverse((o) => {
    o.matrixAutoUpdate = false;
  });
  return group;
};

const isSun = (kind: SkyEventKind) => kind === 'sunrise' || kind === 'sunset';
const hourOf = (ev: SkyEvent) => (ev.time - Math.floor(ev.time)) * 24;
const notice = (ev: SkyEvent) => `${EVENT_NOW[ev.kind]} · ${clockLabel(hourOf(ev))}`;

async function main(hud: Hud): Promise<void> {
  // the mosque's inscription is painted in its calligraphic face, waited for before the landmarks are built: its
  // file is asked for now, so it comes down while the land is built rather than holding the load up there
  document.fonts.load(`700 64px ${KALIMA_FONT}`, 'لا إله').catch(() => []);
  // the site opens in the cinematic mode (the user's direction): the morning the system finds the most beautiful,
  // weighed over the whole year (rig/cinematic.ts); Live is Bangladesh's own date and hour, at a press. The loader
  // says which morning it is: its season, its date and the dawn
  const plan = planCinematic();
  {
    const date = banglaDate(plan.day);
    hud.now(SEASON_NAMES[seasonIndex(plan.day)], `${bn(date.date)} ${date.month}`, clockLabel(plan.dawn));
  }
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
  // checking a program's log on its first use waits for the driver to finish it: a stall the first time anything
  // new is drawn (a film cut's frame). Checked while developing; three advises turning it off in production
  renderer.debug.checkShaderErrors = import.meta.env.DEV;
  const aniso = renderer.capabilities.getMaxAnisotropy();
  setMaxAnisotropy(aniso);
  // the photo textures download while the first parts are built
  const surfacesLoading = loadSurfaces(Math.min(aniso, 8));

  const scene = new Scene();
  // the scene itself never moves: left to update its own matrix, it would push every object's matrices to be
  // remade every frame, the groups that never move (`still`) too
  scene.matrixAutoUpdate = false;
  const camera = new PerspectiveCamera(48, innerWidth / innerHeight, 0.5, 6000);
  camera.layers.enable(LAYER_WATER);
  camera.layers.enable(LAYER_NO_REFLECT);
  const pipeline = new Pipeline(0.5);
  // what is built starts compiling at once, the GPU's driver working on its programs while the rest is built (the
  // load's longest wait was for them all at its end). They are made for the lights the scene will have (the sun with
  // its shadow and the sky, env/environment.ts; the hero boat's lantern) and drawn into the scene pass's target, as
  // its frames are, so the compile at the end finds them made. (Only while the scene has no lights of its own.)
  const sceneLights = new Scene();
  {
    const sun = new DirectionalLight();
    sun.castShadow = true;
    sceneLights.add(sun, new HemisphereLight(), new PointLight());
  }
  const compileSoon = () => {
    renderer.setRenderTarget(pipeline.sceneTarget);
    renderer.compile(scene, camera, sceneLights);
    renderer.setRenderTarget(null);
  };

  hud.progress(0.05);
  await nextTask();
  const sky = buildSky();
  scene.add(sky.mesh);
  // beyond the world's edges only the haze and the hills on the horizon; past the land the village keeps to
  // (the boat's way and the bil) the land fades into the haze too
  scene.add(still(buildBackdrop()));
  // the cloud that gathers on the hills in winter
  scene.add(still(buildHillMist()));
  buildCorridorMap();
  const surfaces = await surfacesLoading;
  hud.progress(0.15);
  // the ground in patches round the camera, finer near it (world/terrain.ts)
  const terrain = new Terrain(surfaces.ground);
  scene.add(terrain.group);
  hud.progress(0.3);
  await nextTask();
  const water = buildWater(pipeline.reflection.target.texture, pipeline.reflection.textureMatrix, Math.min(aniso, 8), (t) => renderer.initTexture(t));
  scene.add(water.mesh, water.inland);
  // the water's own ripples where the camera looks: what touches it rings it
  const ripples = new Ripples(water.field, water.boat, water.ripple);
  let bladeWas = 0;
  const rippleView = new Vector3();
  hud.progress(0.42);
  await nextTask();
  // the homesteads: their houses round their yards, their haystacks, their ghats and boats
  const huts = planHuts();
  const ghats = planGhats();
  const villages = still(buildVillages(huts, ghats));
  scene.add(villages);
  scene.add(still(buildYards(huts)));
  // the banyan at the hub, the zamindar house, its ghat and temple, the mosque, the tea stall
  scene.add(still(buildBanyan(surfaces.bark)));
  // and the old banyan by the mosque's graveyard
  scene.add(still(buildBanyan(surfaces.bark, GRAVEYARD_BANYAN)));
  // the mosque's inscription is painted in its calligraphic face: wait for it a moment (offline, a system Arabic face stands in)
  await Promise.race([document.fonts.load(`700 64px ${KALIMA_FONT}`, 'لا إله').catch(() => []), new Promise((r) => setTimeout(r, 4000))]);
  scene.add(still(buildLandmarks()));
  compileSoon();
  // everything standing, for the trees and the grass to keep clear of
  const standing = huts;
  hud.progress(0.52);
  await nextTask();
  // the trees (left undrawn beyond the haze: render/cull.ts)
  const vegetation = buildVegetation(standing, surfaces.bark, [BRIDGE_CLEARING, BANYAN_CLEARING, GRAVE_BANYAN_CLEARING], [...bridgeTrees(), ...MOSQUE_POND_TREES]);
  scene.add(still(vegetation));
  cullBeyond(vegetation, 1900);
  // the leaves and petals the trees round the camera let fall (the banyan's too)
  const leaves = new FallingLeaves(treeCrowns());
  scene.add(leaves.group);
  // and those lying under the trees in flower and afloat below them
  const petalCarpet = new PetalCarpet(treeCrowns());
  scene.add(petalCarpet.group);
  // the small birds in the trees, and the fish in the water, round the camera
  const songbirds = new Songbirds(treeCrowns());
  scene.add(songbirds.group);
  const fish = new Fish(ripples);
  scene.add(fish.group);
  // frogs at the waters' edges in the rains, and turtles basking on the khal's rocks in the dry months
  const frogs = new Frogs(ripples);
  scene.add(frogs.group);
  const turtles = new Turtles(ripples);
  scene.add(turtles.group);
  // the hill stream down the wooded hill's face, and the sluice in the river's north levee
  const falls = new Falls(ripples, water.fallInto);
  scene.add(falls.group);
  let fallsLoud = 0;
  // the frogs come out in the rains and the wet; the turtles bask in the dry months' sun
  const frogsOut = () => Math.max(smoothstep(0.1, 0.4, season.rain), weather.wet * 0.5);
  const turtlesOut = () => season.rain < 0.15 && weather.rain < 0.05 && env.sunDir.y > 0.12;
  // the tree in flower over the khal whose petal the film follows down to the water (its ring is the fish's):
  // its crown filled out with boughs and twigs for the camera under it
  const blossom = blossomTree();
  const heroPetal = new HeroPetal(water.touch);
  heroPetal.aim(blossom.crown, blossom.r);
  scene.add(heroPetal.mesh);
  const blossomCrown = blossom.tree ? crownDetail(blossom.tree) : null;
  if (blossomCrown) {
    scene.add(still(blossomCrown));
    cullBeyond(blossomCrown, 1900);
  }
  // the fisherman casting his net on the river below the khal's mouth (his net's rings are the fish's)
  const fisher = new Fisher(ripples);
  // the water each casts his net into feels it (the river's and the gher's)
  fisher.bindWater(water.nets.a[0], water.nets.b[0]);
  scene.add(fisher.group);
  // the aman harvest in Hemanta, on the field the film looks across for it
  const harvest = new Harvest(cropField(2, 318));
  scene.add(harvest.group);
  // the ways, in 1.3 km cells: the far ones are left undrawn; the paths laid on the ground as it is drawn (its
  // lattice's), or they floated over its hollows and sank under its crowns by a hand's breadth
  const roads = buildRoads(meshGround);
  scene.add(still(roads));
  cullBeyond(roads, 2600);
  scene.add(still(buildBridge()));
  scene.add(still(buildSanko()));
  // stones along the banks and at the water's edge, and the khal's rocks the boat goes round; the kept pond's
  // pebbles, small, drawn only near
  const stones = buildStones();
  scene.add(still(stones.group));
  cullBeyond(stones.pebbles, 160);
  // the salt field by where she sets out, and the men raking its salt in the dry months
  const saltWorks = new SaltWorks(ripples);
  saltWorks.bindWater(water.nets.a[1], water.nets.b[1]);
  scene.add(saltWorks.group);
  // the railway across the fields north of the bil, and its train now and then
  scene.add(still(buildRailway()));
  const train = new Train();
  scene.add(train.group);
  // the date palms tapped for their sap in winter
  const khejur = new Khejur();
  scene.add(khejur.group);
  // the drops the majhi's blade throws
  const splash = new PaddleSplash();
  scene.add(splash.points);
  const splashBack = new Vector3();
  scene.add(still(buildPondLife()));
  const bil = new Bil();
  scene.add(bil.group);
  const meadow = new Meadow(standing, ghats);
  scene.add(meadow.group);
  const crops = new Crops();
  scene.add(crops.group);
  const drift = new Drift();
  scene.add(drift.group);
  compileSoon();
  hud.progress(0.78);
  await nextTask();

  const hero = new HeroBoat();
  hero.setShadows(false);
  scene.add(hero.group);
  const life = new Life();
  scene.add(life.group);
  // the cinematic morning (the user's direction): the clock at its dawn on its day, with its moon; the sun rises in
  // the opening's first seconds (`sunrise`, step()), then the clock runs on at the wall's pace, and the season
  // follows the boat's way round the year from that day (yearJourney.ts). Live (`mode`) is Bangladesh's own date,
  // hour and moon, the clock kept to the wall's (`clock.live`) until the viewer turns it.
  let mode: TimeMode = 'cinematic';
  const clock = new Clock(plan.dawn, plan.moon, plan.day);
  clock.live = false;
  const yearJourney = new YearJourney(plan.day);
  /** The mode's own moon (the cinematic morning's, or the real one in Live): its age at `time`, going on with the clock's days. */
  const ownMoon = { age: clock.moonAge, time: clock.time };
  /** The sunrise running: how far into it (s; below 0 it is still to begin), from its dawn's hour to its lit stage's. */
  let sunrise: { t: number; dawn: number; lit: number } | null = { t: -SUNRISE.from, dawn: plan.dawn, lit: plan.lit };
  const season = makeSeasonState();
  const weather = new Weather();
  weather.clearUntil = OPENING_CLEAR_SECONDS;
  const wind = new Wind();
  const rain = buildRain();
  scene.add(rain);
  // where the drops strike: crowns thrown up from the water, splashes on the land, the ghats and the bridge
  const rainCrowns = buildRainSplashes();
  scene.add(rainCrowns);
  const groundSplashes = new GroundSplashes();
  scene.add(groundSplashes.mesh);
  const lightning = new Lightning();
  scene.add(lightning.mesh);
  const env = new Environment(sky, water);
  water.takeShadow(env.key);
  env.season = season;
  env.weather = weather;
  env.addTo(scene);
  const SHADOW_BEST = Math.min(4096, renderer.capabilities.maxTextureSize) >= 4096 && devicePixelRatio <= 1.5 ? 4096 : 2048;
  env.setShadowMapSize(SHADOW_BEST);
  const rig = new Rig(camera, canvas);
  // the views it composes left to itself are made in the sky and the season as they are
  rig.sky = { sun: env.sunDir, moon: env.moonDir, season };

  // ---- the film tour's stage: what its scenes set in the world (season, hour, moon, weather, the boat,
  // the birds) and read from it; the viewer's own world is kept and put back after ----
  let kept: { time: number; day: number; moon: number; speed: number; playing: boolean; live: boolean; weather: WeatherChoice; wind: number | null; journey: number } | null = null;
  // the clock's pace in the scene shown (SceneWorld.pace); the viewer's own clock runs at 1; where a sweep starts
  let scenePace = 1;
  let sweepFrom = 0;
  const settleWorld = () => {
    updateSky(0, true);
    env.update(clock.hour, clock.moonAge);
  };
  const stage: Stage = {
    set(world) {
      yearTurn = null;
      moonTurn = null;
      // the last scene's strikes still to come, and its thunder still on its way, are not this one's
      lightning.schedule([]);
      sound.hushThunder();
      clock.setDayOfYear(world.day);
      if (world.moon !== undefined) clock.setMoonAge(world.moon);
      const h = world.hour;
      if (typeof h === 'number') clock.setHour(h);
      else {
        clock.setHour(12);
        const ev = clock.today().find((e) => e.kind === h.at);
        clock.setHour(ev ? hourOf(ev) + h.offset : h.at === 'sunrise' ? 6 : 18);
      }
      // the scene's own time runs as it would in the sky's time-lapse, or as its sweep takes it (sweep())
      clock.live = false;
      clock.speed = LAPSE;
      clock.playing = !world.sweep;
      sweepFrom = clock.time;
      scenePace = world.pace ?? 1;
      weather.choice = world.weather;
      wind.override = world.wind;
      wind.towardOverride = world.windToward ?? null;
      // the scene's own rain and wet, as it opens (the director keeps them through it), or the weather's own
      weather.hold = world.rain ? { rain: sweepAt(world.rain, 0), wet: world.wet ? sweepAt(world.wet, 0) : 0 } : null;
      settleWorld();
      // a new scene: his mathal is as its weather wants it, as if it had been all along
      hero.wantHat(hatWanted());
      hero.settleHat();
    },
    save() {
      finishTurns();
      // (a sunrise still running is the viewer's world's: it is risen when the film gives it back)
      finishSunrise();
      kept = {
        time: clock.time,
        day: clock.dayOfYear,
        moon: clock.moonAge,
        speed: clock.speed,
        playing: clock.playing,
        live: clock.live,
        weather: weather.choice,
        wind: wind.override,
        journey: rig.progress,
      };
    },
    restore() {
      lightning.schedule([]);
      sound.hushThunder();
      if (!kept) return;
      clock.time = kept.time;
      clock.setDayOfYear(kept.day);
      clock.setMoonAge(kept.moon);
      clock.speed = kept.speed;
      clock.playing = kept.playing;
      // (kept to the wall's, it is the wall's time now, not the film's start)
      clock.live = kept.live;
      if (clock.live) clock.follow(bangladeshTime().hour);
      scenePace = 1;
      weather.choice = kept.weather;
      wind.override = kept.wind;
      wind.towardOverride = null;
      weather.hold = null;
      rig.place(kept.journey);
      settleWorld();
      kept = null;
    },
    weather(rainNow, wetNow) {
      weather.hold = { rain: rainNow, wet: wetNow };
    },
    placeBoat: (journey) => rig.place(journey),
    get boatPos() {
      return rig.boat.pos;
    },
    get boatVel() {
      return rig.boat.vel;
    },
    get boatCourse() {
      return rig.boat.course;
    },
    birds: (at, heading) => life.launchAll(at, heading, 60),
    train: (s, west) => train.place(t, s, west),
    fisherman: (at) => fisher.cue(at),
    lightning: (seconds) => lightning.schedule(seconds),
    gherFisherman: (at) => saltWorks.cueGher(at),
    bareheaded: () => hero.settleHat(false),
    sap: () => khejur.cue(t),
    sapTree: khejur.hero,
    petal: heroPetal,
    dropPetal: (at) => heroPetal.cue(t, at),
    sweep: (hours) => {
      clock.time = sweepFrom + hours / 24;
    },
    get sunDir() {
      return env.sunDir;
    },
    get moonDir() {
      return env.moonDir;
    },
    prepare: (points) => {
      // only what is missing, and nothing uploaded: the camera's own update shows it (the film is moving). The
      // ground where the shot opens all at once; for a moment the ground along the rest of its way, the grass and
      // the crops, from where it opens. What is left is built by their own updates over the next frames, under the
      // dissolve (a coarser patch standing in for one not built yet, the grass and crops growing in): a skip or a
      // map place's first shot, which nothing was built ahead for, built the whole way at once and stalled
      terrain.warm(points[0], Infinity);
      const until = performance.now() + PREPARE_MS;
      for (const p of points) terrain.warm(p, until);
      for (const p of points) {
        meadow.warm(p, until);
        crops.warm(p, until);
      }
      water.update(points[0].x, points[0].z);
    },
    warm: (points) => {
      const until = performance.now() + WARM_MS;
      let done = true;
      for (const p of points) done = terrain.warm(p, until) && meadow.warm(p, until) && crops.warm(p, until) && petalCarpet.warm(p, until) && done;
      // and the water's fine field where the shot opens, last (the wide one stands in till it is ready)
      return water.warm(points[0].x, points[0].z, until) && done;
    },
    leave() {
      worldLook.capture(lookLeft);
      // the shadow map it was drawn with stays with it; the shot coming in draws its own into the spare
      leftShadow = env.key.shadow.map;
      if (spareShadow && spareShadow.width !== env.key.shadow.mapSize.x) {
        spareShadow.dispose();
        spareShadow = null;
      }
      env.key.shadow.map = spareShadow;
      spareShadow = null;
      renderer.shadowMap.needsUpdate = true;
      leftBoat.pos.copy(hero.group.position);
      leftBoat.quat.copy(hero.group.quaternion);
      meadow.holdView();
      crops.holdView();
    },
    left() {
      if (leftShadow) spareShadow = leftShadow;
      leftShadow = null;
      meadow.releaseView();
      crops.releaseView();
    },
  };
  const director = new Director(tourScenes(ghats), stage);
  // what the camera shows along her way left to itself, and what hides what from it
  const sightlines = new Sightlines(treeCrowns(), palmStems(), huts);
  rig.setSights(findSights(ghats, sightlines), sightlines);

  // ---- the shot the film is leaving, drawn each frame of a dissolve beneath the one coming in, in its own
  // world: the shared uniforms (the light, the fog, the season, the weather, the water), the lights, the sky,
  // the water's colours, the rain, the lantern, the shadow map, its grass and crops, and the boat where it had
  // her. The clock (uTime) and the gust fronts run on in it, so its water, trees and grass go on moving ----
  const worldLook = new WorldLook()
    .trackUniforms(G as unknown as Record<string, { value: unknown }>, ['uTime', 'uCamPos', 'uReflPass', 'uGust'])
    .track(env, 'exposure')
    .track(env, 'night')
    .track(env, 'lamp')
    .track(env.key, 'color')
    .track(env.key, 'intensity')
    .track(env.key, 'position')
    .track(env.key.target, 'position')
    .track(env.key.shadow, 'matrix')
    .track(env.hemi, 'color')
    .track(env.hemi, 'groundColor')
    .track(env.hemi, 'intensity')
    .track(sky, 'zenith')
    .track(sky, 'horizon')
    .track(sky, 'moonDir')
    .track(sky.moonGlow, 'value')
    .track(sky.cloud, 'value')
    .track(sky, 'shift')
    .track(water, 'color')
    .track(water, 'ambient')
    .track(water, 'boat')
    .track(water, 'oar')
    .track(water, 'swirl')
    .track(rain, 'visible')
    .track(hero.lantern, 'intensity')
    .track(hero.glass, 'emissiveIntensity');
  for (const m of NIGHT_GLOWS) worldLook.track(m, 'emissiveIntensity');
  const lookLeft: Captured = [];
  const lookLive: Captured = [];
  let leftShadow: RenderTarget | null = null;
  let spareShadow: RenderTarget | null = null;
  const leftBoat = { pos: new Vector3(), quat: new Quaternion() };
  const heroKeep = { pos: new Vector3(), quat: new Quaternion(), hull: new Vector4() };
  /** The water learns the hero hull's frame as it is drawn now, so it is cut out of her where it meets her as she heaves and heels. */
  const hullOnWater = () => water.hull.set(hero.group.position.y, hero.group.rotation.x, hero.group.rotation.z, 0);
  /** Draws the shot being left into the pipeline's held frame, then puts the world back as the shot coming in has it. */
  const drawLeaving = (leaving: Leaving) => {
    const cam = leaving.camera;
    worldLook.capture(lookLive);
    worldLook.apply(lookLeft);
    const liveShadow = env.key.shadow.map;
    const redraw = renderer.shadowMap.needsUpdate;
    env.key.shadow.map = leftShadow;
    renderer.shadowMap.needsUpdate = false;
    if (leaving.boat) {
      heroKeep.pos.copy(hero.group.position);
      heroKeep.quat.copy(hero.group.quaternion);
      hero.group.position.set(leaving.boat.x, leftBoat.pos.y, leaving.boat.z);
      hero.group.quaternion.copy(leftBoat.quat);
      // the water she cuts and pushes aside, where she lies in that shot (worldLook puts `water.boat` back after;
      // her hull's frame is put back here)
      heroKeep.hull.copy(water.hull);
      water.boat.set(leaving.boat.x, leaving.boat.z, hero.group.rotation.y, water.boat.w);
      hullOnWater();
    }
    terrain.update(cam.position);
    meadow.showHeld(true);
    crops.showHeld(true);
    sky.mesh.position.copy(cam.position);
    updateCulling(cam.position);
    pipeline.render(renderer, scene, cam, { exposure: env.exposure, fade: 0, fadeColor: BLACK, night: env.night, letterbox: director.letterbox, toHeld: true, dof: leaving.dof });
    // back to the shot coming in
    worldLook.apply(lookLive);
    env.key.shadow.map = liveShadow;
    renderer.shadowMap.needsUpdate = redraw;
    if (leaving.boat) {
      hero.group.position.copy(heroKeep.pos);
      hero.group.quaternion.copy(heroKeep.quat);
      water.hull.copy(heroKeep.hull);
    }
    terrain.update(camera.position);
    meadow.showHeld(false);
    crops.showHeld(false);
    sky.mesh.position.copy(camera.position);
  };
  const sound = new Soundscape();
  // the blade's splash, heard as near as it is (not at all from across the fields or the air above them)
  hero.onStroke = (power) => sound.splash(power, smoothstep(90, 12, camera.position.distanceTo(hero.blade)));
  /** How near the water the listener is: 1 on it or by it, fading high above it or away over the fields. */
  const waterNear = () => {
    const p = camera.position;
    const level = waterLevelAt(p.x, p.z);
    if (Number.isFinite(level)) return smoothstep(45, 4, p.y - level);
    const w = waterwayAt(p.x, p.z);
    const edge = w ? w.d - w.half : 80;
    return smoothstep(70, 6, edge) * smoothstep(45, 6, p.y - terrainHeight(p.x, p.z));
  };
  hud.progress(0.85);
  await nextTask();

  // ---- quality: the detail the device can afford (D7: in full on a good GPU, 30 fps on an ordinary laptop) ----
  /** `?quality=low|high` holds a tier; without it the low one comes in by itself when the picture is slow at ADAPT.lowAt. */
  const QUALITY_ASKED = new URLSearchParams(location.search).get('quality');
  let quality: 'high' | 'low' = 'high';
  const setQuality = (q: 'high' | 'low') => {
    quality = q;
    const low = q === 'low';
    // no multisampling (the dearest part of a frame on a weak GPU), less drawn far off, a coarser mirror, a
    // smaller shadow map, the grass kept closer
    pipeline.setSamples(low ? 0 : 4);
    setCullReach(low ? 0.7 : 1);
    pipeline.setReflectionScale(low ? 0.33 : 0.5);
    env.setShadowMapSize(low ? 2048 : SHADOW_BEST);
    renderer.shadowMap.needsUpdate = true;
    meadow.setReach(low ? 0.7 : 1);
  };
  if (QUALITY_ASKED === 'low') setQuality('low');

  // ---- size and adaptive resolution ----
  /**
   * How the picture's size follows the frame rate. Frames are averaged over `quick` frames at first (the opening),
   * then over `steady`; slower than `slow` s a frame, the size goes straight to what would hold `aim` (a frame's
   * cost goes nearly with its pixels), never below `least` (on a dense screen, a phone's, `leastDense`: still
   * nearly a pixel to each of its CSS pixels); under `fast` it grows back a step at a time. Still slow at `lowAt`,
   * the lower tier. A frame whose own work on the CPU is `cpuBound` of it waits on the CPU: fewer pixels would not
   * help it, so the size is kept. A frame counts at most `longest` s (one stall alone does not shrink the picture).
   */
  const ADAPT = { quick: 20, steady: 60, quickFor: 600, slow: 0.024, fast: 0.0175, aim: 0.018, least: 0.6, leastDense: 0.5, lowAt: 0.75, cpuBound: 0.8, longest: 0.25 };
  /** Device pixels to a CSS pixel at full size (a denser screen is drawn at most this fine). */
  const densest = () => Math.min(devicePixelRatio || 1, 1.75);
  const leastScale = () => (densest() >= 1.5 ? ADAPT.leastDense : ADAPT.least);
  /** The GPU's milliseconds for a frame the calibration at load aims under (it leaves room for the CPU's part). */
  const GPU_AIM = 14;
  const perf = { scale: 1, acc: 0, cpu: 0, n: 0, frames: 0, cool: 0, locked: false, ms: 16, driftMs: 0, under: 0 };
  const resize = () => {
    const w = Math.max(1, innerWidth);
    const h = Math.max(1, innerHeight);
    const k = Math.max(0.5, densest() * perf.scale);
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

  // ---- sound: browsers allow it only after the first touch or key; muting is remembered ----
  let soundOn = false;
  try {
    sound.muted = localStorage.getItem(MUTED_KEY) === '1';
  } catch {
    // storage blocked (a private window): sound starts on as usual
  }
  const startSound = (e: Event) => {
    // the speaker button and M toggle it themselves (else this would start it and the toggle mute it at once)
    if (e.target instanceof Element && e.target.closest('#sound')) return;
    if (e instanceof KeyboardEvent && e.code === 'KeyM') return;
    if (!sound.muted) {
      sound.start();
      soundOn = true;
    }
  };
  // (a touch's pointerdown does not count as a gesture for audio on every browser: its end does)
  for (const type of ['pointerdown', 'pointerup', 'touchend', 'keydown'] as const) window.addEventListener(type, startSound, { passive: true });
  const toggleSound = () => {
    sound.setMuted(!sound.muted);
    if (!sound.muted) sound.start();
    soundOn = !sound.muted;
    try {
      localStorage.setItem(MUTED_KEY, sound.muted ? '1' : '0');
    } catch {
      // not remembered, no harm
    }
  };
  // nothing plays while the page is hidden
  document.addEventListener('visibilitychange', () => sound.pause(document.hidden));

  // ---- camera: follow the boat, fly free, or watch the film tour ----
  let lastInput = performance.now();
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  /** The sky event being watched; `asked` when the viewer chose it rather than idling into it. */
  const watch: { event: SkyEvent | null; asked: boolean } = { event: null, asked: false };
  const noteInput = () => {
    lastInput = performance.now();
  };
  /** The film is playing (not a visit from the map, which plays in the viewer's own world). */
  const filming = () => director.active && !director.visiting;
  const setFilm = (on: boolean) => {
    if (on) rig.endOpening();
    if (on) director.start(camera);
    else director.stop();
    if (on) hud.quiet();
  };
  /** The viewer is steering: the film hands the camera back and any watching stops. */
  const takeOver = () => {
    noteInput();
    watch.asked = false;
    if (director.active) setFilm(false);
  };
  // in the film a tap (or a click) only wakes the controls; a drag past a few pixels, a second finger or the wheel
  // takes the camera (a touch screen has no other way to see the film's buttons)
  const pressed = new Map<number, { x: number; y: number }>();
  canvas.addEventListener('pointerdown', (e) => {
    hud.dismissHint();
    noteInput();
    pressed.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (!director.active || pressed.size > 1) takeOver();
  });
  canvas.addEventListener('pointermove', (e) => {
    const p = pressed.get(e.pointerId);
    if (p && director.active && Math.hypot(e.clientX - p.x, e.clientY - p.y) > DRAG_PX) takeOver();
  });
  for (const type of ['pointerup', 'pointercancel'] as const) canvas.addEventListener(type, (e) => pressed.delete(e.pointerId));
  canvas.addEventListener('wheel', takeOver, { passive: true });
  // a pointer moving over the page is someone there: the film doesn't start by itself under it
  window.addEventListener('pointermove', noteInput, { passive: true });
  /** The viewer reaches for the world's own controls (the time, the season, the moon): the film gives the world back first. */
  const ownWorld = () => {
    noteInput();
    if (director.active) setFilm(false);
  };

  const chooseCamera = (choice: CameraChoice) => {
    noteInput();
    if (choice === 'film') {
      if (!filming()) setFilm(true);
      return;
    }
    if (director.active) setFilm(false);
    rig.setMode(choice);
  };
  // the composed views first: the camera's own, until the viewer picks another
  const viewNames: ViewName[] = ['auto', ...(Object.keys(VIEWS) as ViewName[])];
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
  /** Bangladesh's own hour now, the clock running with the wall's (Live). */
  const keepToWall = () => {
    clock.speed = SPEEDS[0];
    clock.playing = true;
    clock.live = true;
    clock.follow(bangladeshTime().hour);
  };
  /** The viewer takes the clock (its timeline, pace or pause, a sky event): it is theirs, no longer kept to the wall's or rising. */
  const takeClock = () => {
    clock.live = false;
    sunrise = null;
  };
  /** Steps the clock's pace; in Live, round to real time, it is the wall's own again. */
  const stepSpeed = (dir: 1 | -1, wrap: boolean) => {
    const n = SPEEDS.length;
    const i = SPEEDS.indexOf(clock.speed) + dir;
    clock.speed = SPEEDS[wrap ? (i + n) % n : clamp(i, 0, n - 1)];
    if (clock.speed === SPEEDS[0] && mode === 'live') keepToWall();
    else takeClock();
  };
  /** The sunrise's hour now: from its dawn up to its lit stage over `SUNRISE.seconds`, eased; then the clock runs on from there. */
  const riseSun = (dt: number) => {
    if (!sunrise) return;
    sunrise.t += dt;
    clock.setHour(sunrise.dawn + (sunrise.lit - sunrise.dawn) * smooth(clamp(sunrise.t / SUNRISE.seconds, 0, 1)));
    if (sunrise.t >= SUNRISE.seconds) sunrise = null;
  };
  /** The sunrise done at once (the film starts over it): the sun at its lit stage. */
  const finishSunrise = () => {
    if (!sunrise) return;
    clock.setHour(sunrise.lit);
    sunrise = null;
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
    if (director.active) {
      // (leaving the film puts the viewer's own day back: the same event is found again on it)
      setFilm(false);
      const again = clock.today().find((e) => e.kind === ev.kind);
      if (!again) return;
      ev = again;
    }
    // (an event jumped to is watched in the sky's time-lapse: in real time a sunset takes the best part of an hour)
    takeClock();
    clock.jumpTo(ev);
    if (clock.speed < LAPSE) clock.speed = LAPSE;
    look(ev);
    hud.toast(notice(ev), null);
  };
  const followSky = (now: number) => {
    // the film tour shows the sky's events itself, in its own time; the cinematic morning's sunrise is the opening's
    // own, and a change of mode is no moment to turn to the sky
    if (director.active || sunrise || dip) {
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

  // ---- the viewer's environment. The season is the mode's own: in the cinematic mode the journey's, the year
  // turning as the boat goes on her way (yearJourney.ts); in Live today's. A chosen season comes as the year turns
  // to it over a few seconds (the sun's path, the light, the land, the trees, the crops, the river all following
  // the days as they roll by), a chosen moon waxes or wanes to its phase. Each holds for a minute; then the world
  // eases back to the mode's own season, the season's weather and the mode's own moon.
  const smooth = (x: number) => x * x * (3 - 2 * x);
  const wrap = (x: number, n: number) => ((x % n) + n) % n;
  /** The short way round the year from day `a` to day `b`. */
  const yearsWay = (a: number, b: number) => wrap(b - a + YEAR / 2, YEAR) - YEAR / 2;
  /** The day of the year where the boat is on her way. */
  const journeyDay = () => yearJourney.dayAt(rig.progress * JOURNEY.length);
  /** A season held (the viewer's choice, a still's) rather than the mode's own. */
  let seasonHeld = false;
  /** Whether the season follows the boat's way: the cinematic mode's own (else it holds the clock's day: Live's today, a chosen season, a still, the film's). */
  const onJourney = () => mode === 'cinematic' && !seasonHeld && !filming();
  /** The journey's day last frame, to tell her being put elsewhere (the map, the loop) from her going on. */
  let lastJourneyDay = Number.NaN;
  /** The year turning to a day (`to`, or the journey's when null) from `from`, and for how long so far. */
  let yearTurn: { from: number; to: number | null; t: number } | null = null;
  let moonTurn: { from: number; by: number; t: number } | null = null;
  let sessionUntil = 0;
  const turnTarget = (y: { to: number | null }) => y.to ?? journeyDay();
  /** The day of the year the land and the sun show now: the turning year's, the journey's or the clock's. */
  const shownDay = () => {
    if (yearTurn) return wrap(yearTurn.from + yearsWay(yearTurn.from, turnTarget(yearTurn)) * smooth(Math.min(1, yearTurn.t / YEAR_TURN_SECONDS)), YEAR);
    return onJourney() ? journeyDay() : clock.dayOfYear;
  };
  /** The day the year is on, or turning to. */
  const aimedDay = () => (yearTurn ? turnTarget(yearTurn) : shownDay());
  /**
   * Keeps the year with the boat: the clock's date in step with the journey's day (so the sky's events, the
   * timeline and the date read it), and a jump of her place eased over as a turn of the year.
   */
  const followYear = () => {
    if (!onJourney()) {
      lastJourneyDay = Number.NaN;
      return;
    }
    const day = journeyDay();
    if (!yearTurn && Number.isFinite(lastJourneyDay) && Math.abs(yearsWay(lastJourneyDay, day)) > 2) yearTurn = { from: lastJourneyDay, to: null, t: 0 };
    lastJourneyDay = day;
    if (!yearTurn && Math.floor(clock.dayOfYear) !== Math.floor(day)) clock.setDayOfYear(day);
    setSunDay(shownDay());
  };
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
    if (yearTurn) clock.setDayOfYear(turnTarget(yearTurn));
    if (moonTurn) clock.setMoonAge(wrap(moonTurn.from + moonTurn.by, SYNODIC));
    yearTurn = null;
    moonTurn = null;
  };
  const startSession = () => {
    sessionUntil = performance.now() + SESSION_MS;
  };
  /** Turns the year to a season's middle (or back to the mode's own: the journey's, or today's in Live); the river eases to its new level. */
  const chooseSeason = (choice: number | 'own', session = true) => {
    const from = shownDay();
    seasonHeld = choice !== 'own';
    yearTurn = { from, to: choice !== 'own' ? seasonMiddle(choice) : mode === 'live' ? bangladeshTime().day : null, t: 0 };
    if (session && choice !== 'own') startSession();
  };
  /** The weather and the wind are the season's own (the user asked for no picker: calm, breeze, wind, drizzle, rain and storm all come as the season brings them). */
  const seasonsWeather = () => {
    weather.choice = 'auto';
    wind.override = null;
  };
  /** Waxes or wanes the moon to a phase (the short way round). */
  const chooseMoon = (age: number, session = true) => {
    const from = shownMoon();
    moonTurn = { from, by: wrap(age - from + SYNODIC / 2, SYNODIC) - SYNODIC / 2, t: 0 };
    if (session) startSession();
  };
  /** The minute is up: back to the mode's own season, the season's weather and the mode's own moon, all eased. */
  const backToMode = () => {
    sessionUntil = 0;
    chooseSeason('own', false);
    seasonsWeather();
    chooseMoon(wrap(ownMoon.age + (clock.time - ownMoon.time), SYNODIC), false);
    hud.toast(mode === 'live' ? 'আজকের ঋতু, আবহাওয়া আর আসল চাঁদে ফিরছে' : 'যাত্রার ঋতু, আবহাওয়া আর চাঁদে ফিরছে', null);
  };

  // ---- the mode: the cinematic morning (the default) or Live, Bangladesh's own date and hour now. A change goes
  // down into a moment of dark and comes up in the other world, set whole under it (DIP) ----
  let dip: { t: number; to: TimeMode; done: boolean } | null = null;
  /** The cinematic morning on the day the journey shows where she is: the clock at its dawn, its moon, the sun to rise `after` s on. */
  const beginSunrise = (after: number) => {
    const m = morningOn(journeyDay());
    clock.setDayOfYear(m.day);
    clock.setHour(m.dawn);
    clock.setMoonAge(m.moon);
    sunrise = { t: -after, dawn: m.dawn, lit: m.lit };
  };
  /** Sets a mode's whole world at once (under the dip's dark): its day, hour, moon, season, weather and what goes with them. */
  const setMode = (to: TimeMode) => {
    mode = to;
    yearTurn = null;
    moonTurn = null;
    sessionUntil = 0;
    seasonHeld = false;
    lastJourneyDay = Number.NaN;
    seasonsWeather();
    if (to === 'live') {
      sunrise = null;
      keepToWall();
      clock.setDayOfYear(bangladeshTime().day);
      clock.setMoonAge(moonAgeOn(new Date()));
      // the season's own weather as it is now: no fair spell held for it
      weather.clearUntil = 0;
    } else {
      clock.live = false;
      clock.speed = SPEEDS[0];
      clock.playing = true;
      // the morning comes again: the sun rising as the dark lifts, the first minutes fair
      beginSunrise(DIP[1] * 0.5);
      weather.clearUntil = t + OPENING_CLEAR_SECONDS;
    }
    ownMoon.age = clock.moonAge;
    ownMoon.time = clock.time;
    watch.event = null;
    watch.asked = false;
    // the world as it stands in it, at once: the season, the weather and the wet, the light, his mathal, the
    // frogs and the turtles where they would be, the shadow
    setSunDay(shownDay());
    updateSky(0, true);
    env.update(clock.hour, clock.moonAge);
    hero.wantHat(hatWanted());
    hero.settleHat();
    frogs.settle(camera.position, frogsOut());
    turtles.settle(rig.boat.pos, turtlesOut());
    renderer.shadowMap.needsUpdate = true;
  };
  /**
   * The Live button (and 0), as it shows (controls.ts): off, on to Live; on, back to the cinematic morning; on with
   * the clock taken elsewhere, back to now. Not while a change is already under way.
   */
  const toggleLive = () => {
    if (dip) return;
    const shownOn = !filming() && mode === 'live';
    ownWorld();
    dip = { t: 0, to: shownOn && clock.live ? 'cinematic' : 'live', done: false };
  };
  const controls = new Controls({
    togglePlay: () => {
      ownWorld();
      clock.playing = !clock.playing;
      takeClock();
    },
    faster: () => {
      ownWorld();
      stepSpeed(1, true);
    },
    seek: (hour) => {
      ownWorld();
      takeClock();
      clock.setHour(hour);
    },
    scrub: (active) => {
      scrubbing = active;
    },
    jump,
    camera: chooseCamera,
    view: setView,
    moon: (age) => {
      ownWorld();
      chooseMoon(age);
    },
    season: (choice) => {
      ownWorld();
      chooseSeason(choice);
    },
    live: toggleLive,
    sound: toggleSound,
    map: () => {
      noteInput();
      map.toggle();
    },
    scene: (step) => director.skip(step),
    touched: noteInput,
  });

  // ---- the map (L): the places to go; a jump there passes through a moment of dark, while what stands there
  // is built ----
  let jumpAt = -1e9;
  /** Builds what stands round (x, z) now, under the dark of the jump. */
  const readyAround = (x: number, z: number) => {
    const at = new Vector3(x, terrainHeight(x, z), z);
    terrain.warm(at, Infinity);
    meadow.warm(at, Infinity);
    crops.warm(at, Infinity);
    water.update(x, z, true);
  };
  const leaveFilm = () => {
    if (director.active) director.stop(true);
  };
  // the map's places, each shown in its own shots (rig/visits.ts), the boat put on her way short of it
  const spots = mapSpots(sightlines);
  const map = new MapPanel(
    {
      visit(id) {
        const spot = spots.find((s) => s.id === id);
        if (!spot) return;
        noteInput();
        watch.asked = false;
        // the camera the visit comes back to: her follow view (unseen until then)
        rig.followNow();
        director.visit(spot.shots, camera);
        hud.quiet();
        // the year with the boat where the visit puts her, at once, under its first dissolve (each shot keeps its
        // own look through a dissolve: the viewer's view goes out in the season it had)
        if (onJourney()) {
          yearTurn = null;
          lastJourneyDay = Number.NaN;
          followYear();
          updateSky(0, true);
        }
      },
      fly(x, z, lookUp) {
        noteInput();
        leaveFilm();
        // from the waters' side of the place, up and back from it, looking at it
        const s = journeyFrame(x, z)?.s;
        let tx = 0;
        let tz = 0;
        let wayX = x;
        let wayZ = z;
        if (s !== undefined && (journeyFrame(x, z)?.d ?? 99) < 12) {
          // on the boat's way itself: look along it
          const p = journeyAt(s);
          tx = -Math.sin(p.heading);
          tz = -Math.cos(p.heading);
        } else {
          let best = { d: Infinity, x: 0, z: 0 };
          for (let k = 0; k <= JOURNEY.length; k += 5) {
            const p = journeyAt(k);
            const d = (p.x - x) ** 2 + (p.z - z) ** 2;
            if (d < best.d) best = { d, x: p.x, z: p.z };
          }
          const len = Math.hypot(best.x - x, best.z - z) || 1;
          tx = (best.x - x) / len;
          tz = (best.z - z) / len;
          wayX = best.x;
          wayZ = best.z;
          // a hill from a little back along the boat's way, so it is seen across the water, not as a wall
          const bs = journeyFrame(best.x, best.z)?.s;
          if (bs !== undefined && lookUp >= 15) {
            const p = journeyAt(Math.max(0, bs - 130));
            wayX = p.x;
            wayZ = p.z;
          }
        }
        // a hill is seen whole from the water below it, low; anything else from a little above, nearer
        const hill = lookUp >= 15;
        const cx = hill ? wayX : x + tx * 70;
        const cz = hill ? wayZ : z + tz * 70;
        const ground = Math.max(terrainHeight(cx, cz), waterLevelAt(cx, cz));
        const cy = ground + (hill ? 8 : 22);
        const ty = hill ? ground + lookUp * 0.9 : terrainHeight(x, z) + lookUp;
        readyAround(cx, cz);
        rig.placeFree(cx, cy, cz, Math.atan2(x - cx, z - cz), Math.atan2(ty - cy, Math.hypot(x - cx, z - cz)));
        jumpAt = performance.now();
      },
    },
    spots,
  );


  // ---- keyboard: one place for every shortcut (the help sheet lists them) ----
  const held = new Set<string>();
  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    // the help sheet keeps the keys while it is open (Escape closes it by itself); ? closes it as it opened it
    if (controls.helpOpen) {
      if (e.key === '?' && !e.repeat) controls.toggleHelp();
      return;
    }
    // the map takes its own key and Escape; the rest wait while it is open
    if (e.code === 'KeyL') {
      noteInput();
      map.toggle();
      return;
    }
    if (map.isOpen) return;
    // leave keys to a focused dropdown, and arrows to the focused timeline
    const target = e.target;
    if (target instanceof HTMLSelectElement || target instanceof HTMLTextAreaElement) return;
    if (target instanceof HTMLInputElement && /^(Arrow|Page|Home|End)/.test(e.code)) return;
    if (e.code === 'Escape' && director.active) {
      takeOver();
      return;
    }
    // in the film, the arrows (and the page keys) go back and on through its scenes
    if (filming() && /^(ArrowLeft|ArrowRight|PageUp|PageDown)$/.test(e.code)) {
      e.preventDefault();
      noteInput();
      if (!e.repeat) director.skip(e.code === 'ArrowLeft' || e.code === 'PageUp' ? -1 : 1);
      return;
    }
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
        ownWorld();
        clock.playing = !clock.playing;
        takeClock();
        break;
      case 'Digit0':
      case 'Numpad0':
        toggleLive();
        break;
      case 'KeyY':
        ownWorld();
        // (on from the season the year is turning to, so a second press goes on to the one after)
        chooseSeason((seasonIndex(aimedDay()) + 1) % 6);
        break;
      case 'BracketLeft':
        ownWorld();
        stepSpeed(-1, false);
        break;
      case 'BracketRight':
        ownWorld();
        stepSpeed(1, false);
        break;
      case 'KeyN': {
        ownWorld();
        const ev = clock.next();
        if (ev) jump(ev);
        break;
      }
      case 'KeyC':
        setFilm(!filming());
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
        setView('auto');
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
  const forward = new Vector3();
  /**
   * The season from the day of the year, the weather on it, and the wind they make; `settle` jumps
   * straight to where they are heading (for stills and a fresh season) instead of easing there.
   */
  const updateSky = (dt: number, settle: boolean) => {
    seasonAt(shownDay(), season);
    applySeason(season);
    // the waters full in the rains and low in spring: what floats and what reads the water's level follows
    // (the shaders through uWaterRise, set by applySeason); what reads the sea's level reads the river's
    setWaterRise(season.water);
    // the salt farms flooded as ghers in the rains, drained while the salt is made
    const saltWet = 1 - smoothstep(0.15, 0.7, season.salt);
    setSaltWet(saltWet);
    G.uSaltWet.value = saltWet;
    G.uWaterLevel.value = WATER_LEVEL + season.water;
    G.uTideHigh.value = WATER_LEVEL + season.water;
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
    rainCrowns.visible = weather.rain > 0.01;
    // the khal drifts down to its sluice faster when the season's runoff is high (the rains), slower in the dry months
    G.uFlowScale.value = season.flow;
    // the clouds drift on the wind
    const w = G.uWind.value;
    sky.shift.x += w.x * (0.4 + 0.6 * w.z) * dt * 0.0035;
    sky.shift.y += w.y * (0.4 + 0.6 * w.z) * dt * 0.0035;
  };
  /** The majhi's mathal: on in a hard sun (high, clear, out of the cool of winter) or in the rain; off when it is mild. */
  const hatWanted = () => weather.rain > 0.15 || (env.sunDir.y > 0.55 && G.uOvercast.value < 0.45 && season.warm > -0.1);
  const step = (dt: number) => {
    t += dt;
    G.uTime.value = t;
    clock.boost = filming() ? scenePace : held.has('KeyT') ? Math.max(1, (40 * LAPSE) / clock.speed) : 1;
    // the cinematic morning's sun rising, then the clock running on; kept to Bangladesh's own time (Live); or running
    // at the pace the viewer chose
    if (sunrise && !filming()) riseSun(dt);
    else if (clock.live && !filming() && !held.has('KeyT')) clock.follow(bangladeshTime().hour);
    // (the viewer's own clock passes each sky event in seconds; the film keeps the pace its scenes were shot at)
    else if (!scrubbing) clock.advance(dt, !filming());
    if (held.has('KeyT')) takeClock();
    turn(dt);
    followYear();
    updateSky(dt, false);
    // lightning where the storm strikes (in a shot, or ahead of whoever is looking, mostly within the view), its
    // light on the cloud and the land, and the thunder after it
    const fell = lightning.update(dt, camera, weather.struck, director.active || Math.random() < 0.7);
    if (fell !== null) sound.thunder(fell);
    weather.flash = lightning.light;
    env.update(clock.hour, shownMoon());
    lampsGlow(env.night);
    // cloud on the hills: in winter (and late autumn) lying thick in the mornings and evenings, thinner at noon;
    // in the rains it hangs on them while it rains
    const lowSun = 1 - smoothstep(0.12, 0.65, env.sunDir.y);
    G.uHillCloud.value = Math.max(smoothstep(0.35, 0.9, season.fog) * (0.4 + 0.6 * lowSun), weather.rain * 0.7);
    followSky(performance.now());
    // the boat floats and is paddled by physics; the boatman's weight from last frame trims her
    rig.directed = director.active;
    rig.update(dt, t, hero.crew);
    const b = rig.boat;
    hero.wantHat(hatWanted());
    director.update(dt, t, camera);
    hero.update(dt, t, env.lamp, b);
    // the paddle rings the water: a dimple where it bites, a wake as it pulls, a heap where it comes out; and
    // her stem parts it as she goes
    if (dt > 0) {
      const wet = hero.bladeWet > 0.15;
      if (wet && bladeWas <= 0.15) ripples.drop(hero.blade.x, hero.blade.z, 0.22, 0.012);
      else if (wet) ripples.drop(hero.blade.x, hero.blade.z, 0.16, 0.0025 * Math.min(2, hero.bladeDrive) * dt * 60);
      else if (bladeWas > 0.15) ripples.drop(hero.blade.x, hero.blade.z, 0.2, -0.008);
      bladeWas = hero.bladeWet;
      if (b.speed > 0.15) {
        const stem = (HERO_HULL.len / 2) * 0.96;
        ripples.drop(b.pos.x + Math.sin(b.heading) * stem, b.pos.z + Math.cos(b.heading) * stem, 0.28, 0.0012 * Math.min(b.speed, 2) * dt * 60);
      }
    }
    splash.update(dt, hero.blade, hero.bladeWet, b.power, splashBack.set(-Math.sin(b.heading), 0, -Math.cos(b.heading)), renderer.domElement.height);
    // (the people of a shot being left go on working while it dissolves away, though the camera has left them)
    const leftEye = director.leaving?.camera.position ?? null;
    saltWorks.update(dt, t, camera.position, season.salt, leftEye);
    fisher.update(dt, t, camera.position, leftEye);
    harvest.update(dt, t, camera.position, season.crops[2], leftEye);
    khejur.update(t, camera.position, shownDay(), clock.hour);
    train.update(t, env.night);
    water.boat.set(b.pos.x, b.pos.z, b.heading, b.speed);
    hullOnWater();
    water.oar.set(hero.bladeLocal.x, hero.bladeLocal.z, hero.bladeDrive, hero.bladeWet);
    water.swirl.copy(hero.swirl);
    const simStart = performance.now();
    // the hyacinth meets the hero's hull and blade
    drift.update(dt, t, camera.position, b, hero.blade);
    // while a shot dissolves away its falling leaves fall on, though the camera has left them
    leaves.update(dt, t, camera.position, director.leaving !== null);
    petalCarpet.update(t, camera.position, b.pos, b.heading, leftEye);
    heroPetal.update(t, camera.position, leftEye);
    camera.getWorldDirection(forward);
    groundSplashes.update(dt, t, camera.position, forward, weather.rain);
    songbirds.update(dt, t, camera.position, env.night > 0.5 || weather.rain > 0.5);
    fish.update(dt, t, camera.position, b.pos);
    frogs.update(dt, camera.position, b.pos, frogsOut());
    turtles.update(dt, b.pos, turtlesOut());
    fallsLoud = falls.update(dt, season.rain, season.flood, season.water, weather.wet, camera.position);
    // the bil's lilies give way to her hull and blade and are drawn back by their stems
    bil.update(dt, t, b, hero.blade, hero.bladeWet);
    perf.driftMs += (performance.now() - simStart - perf.driftMs) * 0.1;
    // birds and fireflies gather round whoever is being watched: the boat, or the free camera
    life.update(dt, t, director.active ? director.focus : rig.subject, director.active ? rig.boat.course : rig.subjectHeading, env.night, weather.rain);
    sky.mesh.position.copy(camera.position);
    terrain.update(camera.position);
    water.update(camera.position.x, camera.position.z);
    // the grass and the crops build what the camera faces first
    camera.getWorldDirection(forward);
    meadow.update(camera.position, false, forward);
    crops.update(camera.position, false, forward);
    // the shadow box rides ahead of the view, snapped so it redraws only every few metres
    if (director.active) focus.copy(director.focus);
    else rig.focus(focus);
    focus.set(Math.round(focus.x / 12) * 12, 0, Math.round(focus.z / 12) * 12);
    if (env.aimShadow(focus, false)) renderer.shadowMap.needsUpdate = true;
    sound.update(dt, env.night, G.uWind.value.z * gustAt(camera.position.x, camera.position.z), weather.rain, waterNear(), frogsOut(), fallsLoud);
  };
  updateSky(0, true);
  step(0);
  // the opening: a drone's flight down to the boat before her journey begins. Its first view is readied now (the
  // follow camera's, where it ends, is built as it comes down), and drawn a few times behind the loader (below)
  rig.beginOpening();
  step(0);
  terrain.update(camera.position, true);
  water.update(camera.position.x, camera.position.z, true);
  renderer.setRenderTarget(pipeline.sceneTarget);
  // every material compiled now, the hidden ones too (out of season, out of reach, waiting for their scene), so
  // none is first compiled in the middle of the film (compile passes over what is hidden)
  const unhidden: Object3D[] = [];
  scene.traverse((o) => {
    if (!o.visible && !(o as Light).isLight) {
      o.visible = true;
      unhidden.push(o);
    }
  });
  await renderer.compileAsync(scene, camera);
  for (const o of unhidden) o.visible = false;
  renderer.setRenderTarget(null);
  hud.progress(1);

  // the opening's first view drawn a few times behind the loader to learn what a frame of it costs this device's
  // GPU, so the flight starts at a size (and a tier) the device can hold rather than stuttering until the adaptive
  // resolution finds it
  const gpuCost = async (): Promise<number> => {
    const gl = renderer.getContext() as WebGL2RenderingContext;
    const timer = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    const pixel = new Uint8Array(4);
    const costs: number[] = [];
    for (let i = 0; i < 5; i++) {
      updateCulling(camera.position);
      const query = timer ? gl.createQuery() : null;
      if (timer && query) gl.beginQuery(timer.TIME_ELAPSED_EXT, query);
      const t0 = performance.now();
      pipeline.render(renderer, scene, camera, { exposure: env.exposure, fade: 1, fadeColor: BLACK, night: env.night, letterbox: rig.openingBars });
      if (timer && query) gl.endQuery(timer.TIME_ELAPSED_EXT);
      // reading a pixel back waits for the GPU to finish the frame: without the timer, that wait is the cost
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
      let ms = performance.now() - t0;
      // (a timer's result is given only after the page has had its turn: a frame, or a moment in a hidden tab)
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => resolve());
        setTimeout(resolve, 50);
      });
      if (timer && query) {
        if (gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE) && !gl.getParameter(timer.GPU_DISJOINT_EXT)) ms = gl.getQueryParameter(query, gl.QUERY_RESULT) / 1e6;
        gl.deleteQuery(query);
      }
      // (the first frames upload textures, draw the shadow map and finish programs)
      if (i >= 2) costs.push(ms);
    }
    return costs.sort((a, b) => a - b)[1];
  };
  {
    let ms = await gpuCost();
    // too slow even at three quarters of the picture: the lower tier, and its cost measured again
    if (!QUALITY_ASKED && ms * ADAPT.lowAt ** 2 > GPU_AIM) {
      setQuality('low');
      ms = await gpuCost();
    }
    if (ms > GPU_AIM) {
      perf.scale = Math.max(leastScale(), Math.sqrt(GPU_AIM / ms));
      resize();
    }
  }

  // a phone's (or a tablet's) screen that refreshes 110 times a second or more is drawn for at every other refresh:
  // 60 a second, evenly. Drawn for at its full rate it would only heat until it slowed, and slowed unevenly
  const everyOther =
    matchMedia('(pointer: coarse)').matches &&
    (await new Promise<number>((resolve) => {
      // its refresh: the middle of a dozen frames' intervals (or 60 Hz in a hidden tab, whose frames do not come)
      const times: number[] = [];
      const tick = (time: number) => {
        times.push(time);
        if (times.length < 13) requestAnimationFrame(tick);
        else resolve(times.slice(1).map((v, i) => v - times[i]).sort((a, b) => a - b)[6]);
      };
      requestAnimationFrame(tick);
      setTimeout(() => resolve(1000 / 60), 1000);
    })) < 1000 / 110;
  let skipped = false;
  /** A new size the adaptive resolution has chosen, taken up just before the next frame is drawn. */
  let resizeDue = false;

  let readyAt = performance.now();
  let last = performance.now();
  // back from a hidden tab or another app: the time away is no frame's. Counted, it read as one long frame and
  // shrank the picture, and dropped even a capable device to the lower tier for the rest of its visit
  let away = false;
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) away = true;
  });
  const frame = () => {
    // (on such a screen, every other refresh passes undrawn)
    if (everyOther && (skipped = !skipped)) return;
    renderer.info.reset();
    const now = performance.now();
    const raw = Math.max(0, (now - last) / 1000);
    last = now;
    perf.ms += (raw * 1000 - perf.ms) * 0.05;
    const dt = debug.freeze ? 0 : Math.min(raw, 0.05);
    // a change of mode: down into the dark, the other world set under it, up again
    let dark = 0;
    if (dip) {
      dip.t += Math.min(raw, 0.1);
      if (!dip.done && dip.t >= DIP[0]) {
        setMode(dip.to);
        dip.done = true;
      }
      dark = dip.t < DIP[0] ? smooth(dip.t / DIP[0]) : 1 - smooth(Math.min(1, (dip.t - DIP[0]) / DIP[1]));
      if (dip.t >= DIP[0] + DIP[1]) dip = null;
    }
    step(dt);
    // the ripples run on with the world, round where the camera looks at the water
    ripples.update(renderer, dt, camera.position, camera.getWorldDirection(rippleView), G.uMirrorLevel.value);
    if (sessionUntil && now > sessionUntil && !filming()) backToMode();
    const cut = Math.max(clamp(1 - (now - readyAt) / 2600, 0, 1), clamp(1 - (now - jumpAt) / 900, 0, 1), dark);
    // the journey's mist fade belongs to the boat; a free camera elsewhere doesn't see the boat loop
    const loop = rig.mode === 'follow' || director.active ? rig.fade : 0;
    // a dissolve: the shot being left, still moving in its own world, drawn first for this one to melt over
    const leaving = director.leaving;
    // under the map where it covers nearly the whole screen (a phone's, a laptop's), the world is drawn a frame in
    // three: what shows at its edges is dimmed under it and still moves, and on a weak device the map keeps its own
    // pace. The world goes on every frame (step); on a wide screen, where it shows beside the map, it is drawn whole
    const underMap = map.isOpen && innerWidth <= MAP_COVERS;
    perf.under = underMap ? perf.under + 1 : 0;
    if (!underMap || perf.under % 3 === 1) {
      // (a canvas resized after a frame is drawn goes out blank for that frame: a flash of the page behind it)
      if (resizeDue) {
        resizeDue = false;
        resize();
      }
      if (leaving) drawLeaving(leaving);
      updateCulling(camera.position);
      pipeline.render(renderer, scene, camera, {
        exposure: env.exposure,
        fade: Math.max(cut, loop),
        fadeColor: loop > cut ? MIST : BLACK,
        night: env.night,
        letterbox: Math.max(director.letterbox, rig.openingBars),
        dissolve: leaving ? director.dissolve : 0,
        dof: director.active ? director.dof : undefined,
      });
    }
    hud.setCaption(director.caption, director.captionAlpha, pipeline.bar);
    // the opening flight has come down to the boat: the hint to the controls
    if (wasFlying && !rig.flying) hud.hintNow();
    wasFlying = rig.flying;
    controls.update(clock, filming() ? 'film' : rig.mode, soundOn, !seasonHeld, mode, filming() ? { index: director.sceneIndex, count: director.sceneCount } : undefined);
    camera.getWorldDirection(forward);
    map.update(rig.boat.pos.x, rig.boat.pos.z, rig.boat.course, t);

    // adaptive resolution: hold ~45–60 fps by trading pixels (ADAPT)
    perf.frames++;
    // (not through a dissolve, which draws two shots a frame for a moment, nor under the map; the first frames settle in)
    if (away) {
      away = false;
      perf.acc = perf.cpu = perf.n = 0;
    } else if (perf.frames > 10 && !perf.locked && !document.hidden && !leaving && !underMap) {
      perf.acc += Math.min(raw, ADAPT.longest);
      perf.cpu += (performance.now() - now) / 1000;
      if (++perf.n >= (perf.frames < ADAPT.quickFor ? ADAPT.quick : ADAPT.steady)) {
        const avg = perf.acc / perf.n;
        const cpuBound = perf.cpu / perf.n > avg * ADAPT.cpuBound;
        perf.acc = 0;
        perf.cpu = 0;
        perf.n = 0;
        const before = perf.scale;
        if (avg > ADAPT.slow && perf.scale > leastScale() && !cpuBound) {
          perf.scale = Math.max(leastScale(), perf.scale * clamp(Math.sqrt(ADAPT.aim / avg), 0.7, 0.92));
          perf.cool = now + 3000;
        } else if (avg < ADAPT.fast && perf.scale < 1 && now > perf.cool) {
          perf.scale = Math.min(1, perf.scale + 0.06);
          perf.cool = now + 3000;
        }
        // still slow with the picture at three quarters (or waiting on the CPU): the lower tier, once, unless a
        // tier was asked for; it frees enough that the picture may grow again
        if ((perf.scale <= ADAPT.lowAt || cpuBound) && avg > ADAPT.slow && quality === 'high' && !QUALITY_ASKED) {
          setQuality('low');
          perf.cool = now + 3000;
        }
        if (before !== perf.scale) resizeDue = true;
      }
    }
  };
  let wasFlying = true;
  renderer.setAnimationLoop(frame);
  readyAt = performance.now();
  hud.ready(TITLE_SECONDS);
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
      /** The view the camera would compose there by itself (rig/compose.ts), as when the viewer has stopped steering. */
      compose?: boolean;
      /** Free camera at [x, y, z, yaw, pitch]. */
      free?: [number, number, number, number, number];
      film?: [number, number];
      /** A map place's shots (rig/visits.ts): its id, which shot, and how far through it (0..1). */
      visit?: [string, number, number];
      /** Day of the year (0 = 1 January), or a season by index (0 গ্রীষ্ম … 5 বসন্ত, at its middle). */
      day?: number;
      season?: number;
      weather?: WeatherChoice;
      /** Hold the wind at this strength (null: follow the season again). */
      wind?: number | null;
      /** Hold the rain (0..1) and how wet the land is (0..1), as a film scene does (after its own, with `film`). */
      rain?: number;
      wet?: number;
    }
    const b0 = () => rig.boat;
    Object.assign(window, {
      __river: {
        ready: true,
        shot(o: ShotOptions) {
          rig.endOpening();
          // stills set the world at once, and hold it: the hour theirs, not the wall's or a sunrise's; the day
          // theirs, or the journey's where the boat is put
          yearTurn = null;
          moonTurn = null;
          sessionUntil = 0;
          dip = null;
          takeClock();
          seasonHeld = true;
          if (o.day === undefined && o.season === undefined && o.journey !== undefined) clock.setDayOfYear(yearJourney.dayAt(o.journey * JOURNEY.length));
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
          // his mathal as this moment's weather has it
          hero.wantHat(hatWanted());
          hero.settleHat();
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
          // (after the world is set: it frames by the sun and the season as they are now)
          if (o.compose && !o.free) rig.composeNow();
          // a still keeps no rain held over from a film shot before it (a film shot holds its own)
          if (!o.film) weather.hold = null;
          const visit = o.visit ? spots.find((s) => s.id === o.visit?.[0]) : undefined;
          if (o.film) director.cue(o.film[0], o.film[1], camera);
          else if (visit && o.visit) director.cueVisit(visit.shots, o.visit[1], o.visit[2], camera);
          else director.stop(true, false);
          if (o.rain !== undefined) {
            weather.hold = { rain: o.rain, wet: o.wet ?? weather.wet };
            updateSky(0, true);
          }
          director.letterbox = o.film ? 1 : 0;
          // a still is drawn whole: at full size and in the tier asked for (the high one by default), whatever
          // the calibration at load or the adaptive resolution had chosen for this device
          perf.locked = true;
          const tier = QUALITY_ASKED === 'low' ? 'low' : 'high';
          if (quality !== tier) setQuality(tier);
          if (perf.scale !== 1) {
            perf.scale = 1;
            resize();
          }
          readyAt = -1e9;
          lastInput = performance.now();
          debug.freeze = false;
          clock.playing = false;
          // the frogs and the turtles where they would be by now (step poses them)
          frogs.settle(camera.position, frogsOut());
          turtles.settle(b0().pos, turtlesOut());
          step(0.001);
          terrain.update(camera.position, true);
          water.update(camera.position.x, camera.position.z, true);
          meadow.update(camera.position, true);
          petalCarpet.update(t, camera.position, b0().pos, b0().heading, null, true);
          crops.update(camera.position, true);
          renderer.shadowMap.needsUpdate = true;
          debug.freeze = true;
        },
        /** Leaves the follow camera to itself from now, as after the viewer has stopped steering (for recordings). */
        letGo: () => rig.lookNow(),
        /** The village's sights along her way (rig/showcase.ts): where each is seen best (m and share of the way), its stretch if it is shown by itself, how well it is seen. */
        sights: () =>
          rig.sightList.map((g) => ({
            name: g.name,
            s: Math.round(g.s),
            share: Math.round((g.s / JOURNEY.length) * 1e4) / 1e4,
            seen: [Math.round(g.seen.from), Math.round(g.seen.to)],
            stretch: g.shown ? [Math.round(g.from), Math.round(g.to)] : null,
            best: Math.round(g.best * 100) / 100,
            at: [Math.round(g.at.x), Math.round(g.at.z)],
          })),
        /** What the composed camera is doing: its shot (in her frame), what it is of, and the shot's score term by term. */
        composition: () => rig.composition,
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
         * Runs the world `seconds` (1/30 s steps, without drawing) and measures how the hero hull meets the
         * water drawn round her: at stations down both sides of her waterline, the surface (its waves at the
         * share the shader draws, and her wake) less her waterline there as she heaves, pitches and heels
         * (`gap` > 0: the water stands up her side; < 0: it has fallen away from her). Also the most she
         * heaved off the still level, pitched and rolled.
         */
        hullWater(seconds = 20) {
          const r = (v: number, k = 1000) => Math.round(v * k) / k;
          debug.freeze = false;
          clock.playing = true;
          let lo = Infinity;
          let hi = -Infinity;
          let sq = 0;
          let n = 0;
          let heave = 0;
          let pitch = 0;
          let roll = 0;
          const flow = { x: 0, z: 0 };
          for (let i = 1; i <= Math.round(seconds * 30); i++) {
            step(1 / 30);
            const b = b0();
            heave = Math.max(heave, Math.abs(b.pos.y - waterLevelAt(b.pos.x, b.pos.z)));
            pitch = Math.max(pitch, Math.abs(b.rotX));
            roll = Math.max(roll, Math.abs(b.rotZ));
            const fx = Math.sin(b.heading);
            const fz = Math.cos(b.heading);
            for (let k = 1; k < 12; k++) {
              const along = (k / 12 - 0.5) * HERO_HULL.len;
              const half = heroBeamAtWater(k / 12);
              for (const across of [-half, half]) {
                const x = b.pos.x + fz * across + fx * along;
                const z = b.pos.z - fx * across + fz * along;
                const level = waterLevelAt(x, z);
                if (half <= 0 || !Number.isFinite(level)) continue;
                const depth = level - terrainHeight(x, z);
                currentAt(x, z, flow);
                const surface = level + waveHeight(x, z, t, surfaceShare(depth, Math.hypot(flow.x, flow.z))) + wakeHeight(across, along, b.speed) * smoothstep(0, SHOAL_DEPTH, depth);
                const gap = surface - (b.pos.y + across * b.rotZ - along * b.rotX);
                lo = Math.min(lo, gap);
                hi = Math.max(hi, gap);
                sq += gap * gap;
                n++;
              }
            }
          }
          debug.freeze = true;
          clock.playing = false;
          return { gap: { min: r(lo), max: r(hi), rms: r(Math.sqrt(sq / Math.max(n, 1))) }, heave: r(heave), pitch: r(pitch), roll: r(roll), wind: r(G.uWind.value.z, 100), seaHeight: r(sea.height, 100) };
        },
        /**
         * Flies the opening flight again from where it begins (1/30 s steps, without drawing) and measures it
         * every `every` s: how near the camera comes to anything drawn (the nearest triangle within `reach` m,
         * over every visible mesh but the ground, the water and the sky: trees, palms, bamboo, houses, the
         * bridge), how high it is over the ground or the water, its speed, its acceleration (a jolt shows as a
         * spike), how fast it turns (°/s) and how steeply it looks down. The worst of each, and a sample every
         * `log` s. With `until`, it stops there and holds the frame (a still of the flight at that moment).
         */
        flight(every = 0.1, reach = 12, log = 1, until = Infinity) {
          const r = (v: number, k = 100) => Math.round(v * k) / k;
          const skip = new Set<Object3D>([water.mesh, water.inland, sky.mesh]);
          terrain.group.traverse((o) => skip.add(o));
          const mat = new Matrix4();
          const one = new Matrix4();
          const ball = new Sphere();
          const tri = new Triangle();
          const q = new Vector3();
          // the nearest triangle of anything drawn to `p`, within `reach`
          const nearest = (p: Vector3) => {
            let best = reach;
            let what = '';
            scene.traverseVisible((o) => {
              const m = o as Mesh;
              if (!m.isMesh || skip.has(o)) return;
              const g = m.geometry;
              const pos = g.getAttribute('position');
              if (!pos) return;
              if (!g.boundingSphere) g.computeBoundingSphere();
              const inst = (m as InstancedMesh).isInstancedMesh ? (m as InstancedMesh) : null;
              for (let i = 0; i < (inst ? inst.count : 1); i++) {
                mat.copy(m.matrixWorld);
                if (inst) mat.multiply((inst.getMatrixAt(i, one), one));
                ball.copy(g.boundingSphere!).applyMatrix4(mat);
                if (ball.radius > 300 || ball.distanceToPoint(p) > best) continue;
                const n = g.index ? g.index.count : pos.count;
                const at = (k: number) => (g.index ? g.index.getX(k) : k);
                for (let k = 0; k + 2 < n; k += 3) {
                  tri.a.fromBufferAttribute(pos, at(k)).applyMatrix4(mat);
                  if (tri.a.distanceTo(p) > best + 30) continue;
                  tri.b.fromBufferAttribute(pos, at(k + 1)).applyMatrix4(mat);
                  tri.c.fromBufferAttribute(pos, at(k + 2)).applyMatrix4(mat);
                  const d = tri.closestPointToPoint(p, q).distanceTo(p);
                  if (d < best) {
                    best = d;
                    let top: Object3D = m;
                    while (top.parent && top.parent !== scene) top = top.parent;
                    what = `${top.name || '?'}/${m.name || m.parent?.name || '?'}`;
                  }
                }
              }
            });
            return { d: best, what };
          };
          debug.freeze = false;
          clock.playing = true;
          rig.place(JOURNEY.opening / JOURNEY.length);
          rig.beginOpening();
          step(0);
          const samples: { t: number; near: number; what: string; over: number; speed: number; accel: number; turn: number; pitch: number }[] = [];
          const ahead = new Vector3();
          const worst = { near: reach, what: '', at: 0, over: Infinity, overAt: 0, accel: 0, accelAt: 0, speed: 0, turn: 0, turnAt: 0 };
          const prev = [camera.position.clone(), camera.position.clone()];
          const prevQuat = camera.quaternion.clone();
          const every30 = Math.max(1, Math.round(every * 30));
          for (let i = 1; i <= Math.round(Math.min(OPENING_SECONDS + 1, until) * 30); i++) {
            step(1 / 30);
            const p = camera.position;
            const ft = i / 30;
            // speed and acceleration over the last two steps
            const speed = p.distanceTo(prev[1]) * 30;
            const accel = i > 2 ? q.copy(p).sub(prev[1]).sub(prev[1]).add(prev[0]).length() * 900 : 0;
            prev[0].copy(prev[1]);
            prev[1].copy(p);
            const turn = (2 * Math.acos(Math.min(1, Math.abs(prevQuat.dot(camera.quaternion)))) * 30 * 180) / Math.PI;
            prevQuat.copy(camera.quaternion);
            if (turn > worst.turn) {
              worst.turn = turn;
              worst.turnAt = ft;
            }
            worst.speed = Math.max(worst.speed, speed);
            if (accel > worst.accel) {
              worst.accel = accel;
              worst.accelAt = ft;
            }
            if (i % every30) continue;
            const level = waterLevelAt(p.x, p.z);
            const over = p.y - Math.max(terrainHeight(p.x, p.z), Number.isFinite(level) ? level : -Infinity);
            const near = nearest(p);
            if (near.d < worst.near) Object.assign(worst, { near: near.d, what: near.what, at: ft });
            if (over < worst.over) Object.assign(worst, { over, overAt: ft });
            if (i % Math.max(every30, Math.round(log * 30))) continue;
            const pitch = (Math.asin(camera.getWorldDirection(ahead).y) * 180) / Math.PI;
            samples.push({ t: r(ft, 10), near: r(near.d), what: near.what, over: r(over), speed: r(speed), accel: r(accel), turn: r(turn, 10), pitch: r(pitch, 10) });
          }
          if (Number.isFinite(until)) {
            terrain.update(camera.position, true);
            water.update(camera.position.x, camera.position.z, true);
            meadow.update(camera.position, true);
            crops.update(camera.position, true);
            renderer.shadowMap.needsUpdate = true;
          }
          debug.freeze = true;
          clock.playing = false;
          return { worst: { near: r(worst.near), what: worst.what, at: r(worst.at, 10), over: r(worst.over), overAt: r(worst.overAt, 10), speed: r(worst.speed), accel: r(worst.accel), accelAt: r(worst.accelAt, 10), turn: r(worst.turn, 10), turnAt: r(worst.turnAt, 10) }, samples };
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
            // (a mesh may have nothing built yet: the lightning before its first strike)
            const tris = (g.index ? g.index.count : (g.getAttribute('position')?.count ?? 0)) / 3;
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
        /** Puts the train's nose `s` m along the railway (from its east end), running west if `forward`. */
        train(s: number, forward = true) {
          train.place(t, s, forward);
          step(0.001);
        },
        /** Where the first few falling leaves are. */
        leaves: (n = 6) => leaves.sample(n),
        birds(ahead = 40) {
          life.launchAll(rig.boat.pos, rig.boat.heading, ahead);
          step(0.016);
        },
        /** A lightning strike in the view, held `age` s into it (0 its first stroke at its brightest). */
        bolt(age = 0) {
          const stats = lightning.strikeNow(camera, age);
          step(0);
          return stats;
        },
        /** The date palm the film climbs: its foot, cut, pot's mouth and the way the cut faces. */
        sapTree() {
          const r = (v: Vector3) => [v.x, v.y, v.z].map((k) => Math.round(k * 1000) / 1000);
          return { foot: r(khejur.hero.foot), cut: r(khejur.hero.cut), mouth: r(khejur.hero.mouth), out: r(khejur.hero.out) };
        },
        /** The film's petal: the tree it falls from, where it lets go and comes down, and how long it falls. */
        petal() {
          const r = (v: Vector3) => [v.x, v.y, v.z].map((k) => Math.round(k * 100) / 100);
          return { crown: r(blossom.crown), reach: blossom.r, kind: blossom.tree?.kind ?? null, from: r(heroPetal.from), to: r(heroPetal.to), fall: heroPetal.fall };
        },
        /** Holds the majhi's stroke at `phase` (0..1, the blade going in at 0) for a still of his rowing. */
        stroke(phase: number) {
          rig.boat.strokeTime = phase * STROKE_SECONDS;
          step(0);
        },
        /** Puts the fisherman `at` s into his cast (he throws ≈3.3 s in). */
        fisher(at: number) {
          fisher.cue(at);
        },
        /** Where the people's heads are (world) and the boat's heading, for framing them close. */
        people() {
          const at = (o: { getWorldPosition(v: Vector3): Vector3 }) => {
            const p = o.getWorldPosition(new Vector3());
            return [Math.round(p.x * 1000) / 1000, Math.round(p.y * 1000) / 1000, Math.round(p.z * 1000) / 1000];
          };
          return {
            boatman: at(hero.man.body.bone('head')),
            salt: saltWorks.workers,
            heading: rig.boat.heading,
          };
        },
        resume() {
          debug.freeze = false;
          clock.playing = true;
        },
        /** The environment as shown now: the turning year and moon, the crops, the river, the weather, the session, and the sun against the view. */
        /** The cinematic morning as chosen (rig/cinematic.ts): its day, dawn, lit stage and moon, and the best days as weighed, term by term. */
        cinematic() {
          const r = (v: number) => Math.round(v * 100) / 100;
          return {
            day: plan.day,
            dawn: r(plan.dawn),
            lit: r(plan.lit),
            moon: r(plan.moon),
            ranked: plan.ranked.map((w) => ({ day: w.day, score: r(w.score), ...Object.fromEntries(Object.entries(w.terms).map(([k, v]) => [k, r(v)])) })),
          };
        },
        envState() {
          const r = (v: number, k = 100) => Math.round(v * k) / k;
          const fwd = camera.getWorldDirection(new Vector3());
          const sunOff = Math.acos(Math.max(-1, Math.min(1, fwd.dot(env.sunDir)))) * (180 / Math.PI);
          return {
            mode,
            live: clock.live,
            hour: r(clock.hour),
            rising: sunrise !== null,
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
          return { calls: renderer.info.render.calls, triangles: renderer.info.render.triangles, scale: perf.scale, ms: Math.round(perf.ms * 10) / 10, programs: renderer.info.programs?.length, camera: cam, mode: director.active ? 'film' : rig.mode, scene: director.active ? director.sceneIndex : null, dissolve: Math.round(director.dissolve * 100) / 100, leavingAt: director.leaving?.camera.position.toArray().map((v) => Math.round(v * 100) / 100) ?? null, quality, time: Math.round(G.uTime.value * 100) / 100, hour: Math.round(clock.hour * 100) / 100, driftMs: Math.round(perf.driftMs * 100) / 100, rain: Math.round(G.uRain.value * 100) / 100, rainShown: rain.visible, wind: Math.round(G.uWind.value.z * 100) / 100, seaWind: Math.round(sea.wind * 10) / 10, waveHeight: Math.round(sea.height * 100) / 100, wavePeak: Math.round(sea.peak * 10) / 10, chop: Math.round(sea.chop * 100) / 100 };
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
