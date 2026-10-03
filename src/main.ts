import { Color, PCFShadowMap, PerspectiveCamera, SRGBColorSpace, Scene, Vector3, WebGLRenderer } from 'three';
import { Soundscape } from './audio/soundscape';
import { G, LAYER_NO_REFLECT, LAYER_WATER } from './core/globals';
import { clamp } from './core/mathx';
import { Environment } from './env/environment';
import { Pipeline } from './render/pipeline';
import { setMaxAnisotropy } from './render/textures';
import { Director } from './rig/director';
import { Rig } from './rig/rig';
import { Hud } from './ui/hud';
import { RiverTraffic } from './world/boats';
import { HeroBoat } from './world/hero';
import { Life } from './world/life';
import { buildSky } from './world/sky';
import { buildTerrain } from './world/terrain';
import { buildVegetation } from './world/vegetation';
import { buildVillages, planHuts } from './world/village';
import { buildWater } from './world/water';

const BLACK = new Color(0, 0, 0);
const MIST = new Color(0.8, 0.72, 0.6);
const DEBUG = new URLSearchParams(location.search).has('debug');

/** Lets the loader repaint between build steps. */
const nextTask = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

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

  const scene = new Scene();
  const camera = new PerspectiveCamera(48, innerWidth / innerHeight, 0.5, 6000);
  camera.layers.enable(LAYER_WATER);
  camera.layers.enable(LAYER_NO_REFLECT);
  const pipeline = new Pipeline(0.5);

  hud.progress(0.05);
  await nextTask();
  const sky = buildSky();
  scene.add(sky.mesh);
  scene.add(buildTerrain());
  hud.progress(0.3);
  await nextTask();
  const water = buildWater(pipeline.reflection.target.texture, pipeline.reflection.textureMatrix, Math.min(aniso, 8));
  scene.add(water.mesh);
  hud.progress(0.42);
  await nextTask();
  const huts = planHuts();
  scene.add(buildVillages(huts));
  hud.progress(0.52);
  await nextTask();
  scene.add(buildVegetation(huts));
  hud.progress(0.78);
  await nextTask();

  const hero = new HeroBoat();
  hero.setShadows(false);
  scene.add(hero.group);
  const traffic = new RiverTraffic();
  scene.add(traffic.group);
  const life = new Life();
  scene.add(life.group);
  const env = new Environment(sky, water);
  env.addTo(scene);
  env.setShadowMapSize(Math.min(4096, renderer.capabilities.maxTextureSize) >= 4096 && devicePixelRatio <= 1.5 ? 4096 : 2048);
  const rig = new Rig(camera, canvas);
  const director = new Director();
  const sound = new Soundscape();
  hero.onStroke = () => sound.splash();
  hud.progress(0.85);
  await nextTask();

  // ---- size and adaptive resolution ----
  const perf = { scale: 1, acc: 0, n: 0, frames: 0, cool: 0, locked: false, ms: 16 };
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

  // ---- input ----
  const held = new Set<string>();
  const startSound = () => {
    if (!sound.muted) {
      sound.start();
      hud.setSound(true);
    }
  };
  for (const type of ['pointerdown', 'keydown'] as const) window.addEventListener(type, startSound, { passive: true });
  canvas.addEventListener('pointerdown', () => hud.dismissHint());
  // the film tour: C or the film button; it also starts by itself after a long while untouched,
  // and any look-around hands the camera back
  let lastInput = performance.now();
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const setFilm = (on: boolean) => {
    if (on) director.start();
    else director.stop(camera);
    hud.setFilm(director.active);
    if (on) hud.dismissHint();
  };
  const takeOver = () => {
    lastInput = performance.now();
    if (director.active) setFilm(false);
  };
  canvas.addEventListener('pointerdown', takeOver);
  canvas.addEventListener('wheel', takeOver, { passive: true });
  hud.bindFilm(() => {
    lastInput = performance.now();
    setFilm(!director.active);
    return director.active;
  });
  window.addEventListener('keydown', (e) => {
    held.add(e.code);
    if (e.code.startsWith('Arrow')) takeOver();
    if (e.code === 'KeyC') {
      lastInput = performance.now();
      setFilm(!director.active);
    }
    if (e.code === 'KeyM') {
      sound.setMuted(!sound.muted);
      if (!sound.muted) sound.start();
      hud.setSound(!sound.muted);
    }
  });
  window.addEventListener('keyup', (e) => held.delete(e.code));
  window.addEventListener('blur', () => held.clear());
  hud.bindSound(() => {
    sound.setMuted(!sound.muted);
    if (!sound.muted) sound.start();
    return !sound.muted;
  });

  // ---- first frame state, then compile every program before the loader goes ----
  const debug = { freeze: false };
  let t = 0;
  const focus = new Vector3();
  const step = (dt: number) => {
    t += dt;
    G.uTime.value = t;
    G.uWind.value.z = 0.75 + 0.25 * Math.sin(t * 0.05) + 0.1 * Math.sin(t * 0.23);
    env.speed = held.has('KeyT') ? 40 : 1;
    env.update(dt);
    rig.update(dt, t, hero.stroke);
    const b = rig.boat;
    director.update(dt, t, camera, b.pos, b.heading);
    hero.update(t, env.lamp);
    hero.group.position.copy(b.pos);
    hero.group.rotation.set(b.pitch, b.heading, b.roll, 'YXZ');
    water.boat.set(b.pos.x, b.pos.z, b.heading, b.speed);
    traffic.update(dt, t, b.pos.z);
    life.update(dt, t, b.pos, b.heading, env.night);
    sky.mesh.position.copy(camera.position);
    // the shadow box rides ahead of the boat, snapped so it redraws only every few metres
    if (director.active) focus.copy(director.focus);
    else focus.set(b.pos.x + Math.sin(b.heading) * 60, 0, b.pos.z + Math.cos(b.heading) * 60);
    focus.set(Math.round(focus.x / 12) * 12, 0, Math.round(focus.z / 12) * 12);
    if (env.aimShadow(focus, false)) renderer.shadowMap.needsUpdate = true;
    sound.update(dt, env.night, G.uWind.value.z);
  };
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
    if (!director.active && !reducedMotion && now - lastInput > 75000) setFilm(true);
    const intro = clamp(1 - (now - readyAt) / 2600, 0, 1);
    const cut = Math.max(intro, director.fade);
    pipeline.render(renderer, scene, camera, {
      exposure: env.exposure,
      fade: Math.max(cut, rig.fade),
      fadeColor: rig.fade > cut ? MIST : BLACK,
      night: env.night,
      letterbox: director.letterbox,
    });
    hud.setCaption(director.caption, director.captionAlpha, pipeline.bar);

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

  if (DEBUG) {
    // hooks for headless stills: put the boat and the day where you want them and freeze
    Object.assign(window, {
      __river: {
        ready: true,
        shot(o: { journey?: number; phase?: number; yaw?: number; pitch?: number; dist?: number; film?: [number, number] }) {
          if (o.journey !== undefined) rig.place(o.journey);
          if (o.phase !== undefined) env.phase = o.phase;
          rig.settle(o);
          if (o.film) director.cue(o.film[0], o.film[1]);
          else director.stop(camera, true);
          director.letterbox = o.film ? 1 : 0;
          perf.locked = true;
          readyAt = -1e9;
          debug.freeze = false;
          step(0.001);
          renderer.shadowMap.needsUpdate = true;
          debug.freeze = true;
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
        },
        info() {
          return { calls: renderer.info.render.calls, triangles: renderer.info.render.triangles, scale: perf.scale, ms: Math.round(perf.ms * 10) / 10, programs: renderer.info.programs?.length };
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
