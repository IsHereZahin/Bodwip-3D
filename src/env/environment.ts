import { Color, DirectionalLight, HemisphereLight, Vector3 } from 'three';
import type { Object3D } from 'three';
import { G } from '../core/globals';
import { DEG, clamp, smoothstep } from '../core/mathx';
import type { Sky } from '../world/sky';
import type { Water } from '../world/water';

// Time of day. A simple solar model for a Bengal autumn (latitude 23.7° N) gives the sun's path;
// a table of looks keyed on its elevation gives every colour. Golden hour and dusk are lingered over.

const LATITUDE = 23.7 * DEG;
const DECLINATION = 8 * DEG;

interface Look {
  elev: number;
  zenith: string;
  zenithK: number;
  horizon: string;
  horizonK: number;
  fog: string;
  fogK: number;
  glow: string;
  glowK: number;
  sun: string;
  sunE: number;
  hemiSky: string;
  hemiGround: string;
  hemiE: number;
  water: string;
  exposure: number;
  mist: number;
}

const LOOKS: Look[] = [
  { elev: -24, zenith: '#0e1a3c', zenithK: 0.05, horizon: '#1e2c4a', horizonK: 0.07, fog: '#1a2440', fogK: 0.06, glow: '#000000', glowK: 0, sun: '#000000', sunE: 0, hemiSky: '#4a5f96', hemiGround: '#181410', hemiE: 0.42, water: '#4a4636', exposure: 5.0, mist: 0.004 },
  { elev: -10, zenith: '#18295a', zenithK: 0.07, horizon: '#4a4064', horizonK: 0.11, fog: '#3c3656', fogK: 0.09, glow: '#ff6a3a', glowK: 0.05, sun: '#000000', sunE: 0, hemiSky: '#53608f', hemiGround: '#20160e', hemiE: 0.4, water: '#5a5040', exposure: 3.2, mist: 0.004 },
  { elev: -4, zenith: '#203468', zenithK: 0.15, horizon: '#d98a6c', horizonK: 0.32, fog: '#a57a72', fogK: 0.26, glow: '#ff6a2e', glowK: 0.45, sun: '#ff5a1e', sunE: 0, hemiSky: '#6a74a2', hemiGround: '#3a2a1c', hemiE: 0.5, water: '#6a5a42', exposure: 1.9, mist: 0.0036 },
  { elev: 0, zenith: '#33508f', zenithK: 0.34, horizon: '#ffa070', horizonK: 0.62, fog: '#e39a76', fogK: 0.52, glow: '#ff7a30', glowK: 1.0, sun: '#ff7838', sunE: 1.1, hemiSky: '#8a90b8', hemiGround: '#5a3e24', hemiE: 0.75, water: '#7a6644', exposure: 1.4, mist: 0.003 },
  { elev: 5, zenith: '#3f6cb8', zenithK: 0.5, horizon: '#ffc28a', horizonK: 0.9, fog: '#eeb48c', fogK: 0.78, glow: '#ffa050', glowK: 0.95, sun: '#ffac68', sunE: 2.5, hemiSky: '#9aa6c8', hemiGround: '#6a4c2c', hemiE: 0.95, water: '#7d6a46', exposure: 1.12, mist: 0.0024 },
  { elev: 12, zenith: '#4a7ac4', zenithK: 0.6, horizon: '#ffd9b0', horizonK: 1.0, fog: '#e6c6a6', fogK: 0.9, glow: '#ffc080', glowK: 0.55, sun: '#ffcf98', sunE: 3.1, hemiSky: '#a8b8d8', hemiGround: '#6a5232', hemiE: 1.05, water: '#7a6a48', exposure: 1.0, mist: 0.0016 },
  { elev: 30, zenith: '#4a7fd0', zenithK: 0.7, horizon: '#c8d8ea', horizonK: 1.1, fog: '#c4cfdc', fogK: 1.0, glow: '#fff0d8', glowK: 0.15, sun: '#fff0dc', sunE: 3.8, hemiSky: '#b0c4e4', hemiGround: '#5e5434', hemiE: 1.2, water: '#76694a', exposure: 0.88, mist: 0.0008 },
  { elev: 80, zenith: '#3f78d4', zenithK: 0.75, horizon: '#c0d4ec', horizonK: 1.15, fog: '#bccbdc', fogK: 1.05, glow: '#ffffff', glowK: 0.05, sun: '#fff6ea', sunE: 4.2, hemiSky: '#b4c8e8', hemiGround: '#5e5434', hemiE: 1.3, water: '#74694c', exposure: 0.84, mist: 0.0006 },
];

/** Cycle position → solar time (0 = noon): lingering in golden hour and dusk, quick through the night. */
const PHASE_TO_SOLAR: [number, number][] = [
  [0.0, 0.229],
  [0.3, 0.262],
  [0.42, 0.305],
  [0.56, 0.69],
  [0.7, 0.742],
  [0.84, 0.93],
  [1.0, 1.229],
];

function solarTime(phase: number): number {
  for (let i = 1; i < PHASE_TO_SOLAR.length; i++) {
    const [p1, s1] = PHASE_TO_SOLAR[i];
    const [p0, s0] = PHASE_TO_SOLAR[i - 1];
    if (phase <= p1) return s0 + ((phase - p0) / (p1 - p0)) * (s1 - s0);
  }
  return PHASE_TO_SOLAR[PHASE_TO_SOLAR.length - 1][1];
}

/** Sun direction for solar time `s`. West (the sunset) lies ahead of the boat and a little to its right. */
function sunDirection(s: number, out: Vector3): Vector3 {
  const H = s * Math.PI * 2;
  const sinE = Math.sin(LATITUDE) * Math.sin(DECLINATION) + Math.cos(LATITUDE) * Math.cos(DECLINATION) * Math.cos(H);
  const elev = Math.asin(clamp(sinE, -1, 1));
  // azimuth from south, positive toward west
  const az = Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(LATITUDE) - Math.tan(DECLINATION) * Math.cos(LATITUDE));
  const theta = az - Math.PI / 2 + 20 * DEG;
  return out.set(Math.cos(elev) * Math.sin(theta), Math.sin(elev), -Math.cos(elev) * Math.cos(theta));
}

const tmpA = new Color();
const tmpB = new Color();

function mixLook(a: Look, b: Look, t: number, key: keyof Look, scaleKey: keyof Look | null, out: Color): Color {
  tmpA.set(a[key] as string).multiplyScalar(scaleKey ? (a[scaleKey] as number) : 1);
  tmpB.set(b[key] as string).multiplyScalar(scaleKey ? (b[scaleKey] as number) : 1);
  return out.copy(tmpA).lerp(tmpB, t);
}

export class Environment {
  /** 0..1 around one day. 0 is the start of golden hour. */
  phase = 0;
  /** Real seconds for a full day at speed 1. */
  readonly daySeconds = 900;
  speed = 1;
  exposure = 1;
  /** 0 by day, 1 at night: lanterns, fireflies, stars. */
  night = 0;
  lamp = 0;
  readonly elevation = { deg: 0 };
  readonly key: DirectionalLight;
  readonly hemi: HemisphereLight;
  private readonly sunDir = new Vector3();
  private readonly moonDir = new Vector3();
  private readonly sunColor = new Color();
  private readonly lastShadowDir = new Vector3();
  private readonly sky: Sky;
  private readonly water: Water;

  constructor(sky: Sky, water: Water) {
    this.sky = sky;
    this.water = water;
    this.key = new DirectionalLight(0xffffff, 1);
    this.key.castShadow = true;
    const cam = this.key.shadow.camera;
    cam.left = -170;
    cam.right = 170;
    cam.top = 170;
    cam.bottom = -170;
    cam.near = 1;
    cam.far = 900;
    this.key.shadow.bias = -0.0004;
    this.key.shadow.normalBias = 0.05;
    this.key.shadow.radius = 2;
    this.hemi = new HemisphereLight(0xffffff, 0x444444, 1);
  }

  addTo(parent: Object3D): void {
    parent.add(this.key, this.key.target, this.hemi);
  }

  setShadowMapSize(size: number): void {
    this.key.shadow.mapSize.set(size, size);
  }

  update(dt: number): void {
    this.phase = (this.phase + (dt * this.speed) / this.daySeconds) % 1;
    const s = solarTime(this.phase);
    sunDirection(s, this.sunDir);
    const elev = Math.asin(this.sunDir.y) / DEG;
    this.elevation.deg = elev;

    let i = 1;
    while (i < LOOKS.length - 1 && LOOKS[i].elev < elev) i++;
    const a = LOOKS[i - 1];
    const b = LOOKS[i];
    const t = smoothstep(0, 1, clamp((elev - a.elev) / (b.elev - a.elev), 0, 1));

    mixLook(a, b, t, 'zenith', 'zenithK', this.sky.zenith);
    mixLook(a, b, t, 'horizon', 'horizonK', this.sky.horizon);
    mixLook(a, b, t, 'fog', 'fogK', G.uFogColor.value);
    mixLook(a, b, t, 'glow', 'glowK', G.uGlow.value);
    mixLook(a, b, t, 'sun', null, this.sunColor);
    const sunE = a.sunE + (b.sunE - a.sunE) * t;
    // the disc sinks below the horizon over the last degree
    const visible = smoothstep(-1.2, 0.6, elev);
    G.uSunColor.value.copy(this.sunColor).multiplyScalar(sunE * visible);
    G.uSunDir.value.copy(this.sunDir);
    this.exposure = a.exposure + (b.exposure - a.exposure) * t;
    G.uMist.value = a.mist + (b.mist - a.mist) * t;
    G.uFogDensity.value = 0.0006 + 0.0003 * smoothstep(20, -5, elev);
    this.night = smoothstep(-3, -12, elev);
    this.lamp = smoothstep(4, -5, elev);
    G.uNight.value = this.night;

    // the moon rides opposite the sun and lights the night
    this.moonDir.set(-this.sunDir.x * 0.75 + 0.2, Math.max(-this.sunDir.y, 0) * 0.7 + 0.32, -this.sunDir.z * 0.75 - 0.1).normalize();
    this.sky.moonDir.copy(this.moonDir);
    const moonE = 0.7 * smoothstep(-5, -14, elev);
    const useMoon = elev < -4.5;
    G.uKeyDir.value.copy(useMoon ? this.moonDir : this.sunDir);
    if (useMoon) G.uKeyColor.value.set('#9fb6e6').multiplyScalar(moonE);
    else G.uKeyColor.value.copy(G.uSunColor.value);
    this.key.color.copy(G.uKeyColor.value);
    this.key.intensity = 1;

    this.hemi.color.set(a.hemiSky).lerp(tmpB.set(b.hemiSky), t);
    this.hemi.groundColor.set(a.hemiGround).lerp(tmpB.set(b.hemiGround), t);
    this.hemi.intensity = a.hemiE + (b.hemiE - a.hemiE) * t;

    this.water.color.set(a.water).lerp(tmpB.set(b.water), t);
    this.water.ambient.copy(this.hemi.color).multiplyScalar(this.hemi.intensity * 1.6);
  }

  /** Points the shadow at `focus`; returns true when the shadow map needs redrawing. */
  aimShadow(focus: Vector3, force: boolean): boolean {
    const dir = G.uKeyDir.value;
    const moved = this.key.target.position.distanceToSquared(focus) > 1;
    const turned = this.lastShadowDir.dot(dir) < 0.99996;
    if (!force && !moved && !turned) return false;
    this.key.target.position.copy(focus);
    this.key.position.copy(focus).addScaledVector(dir, 420);
    this.key.target.updateMatrixWorld();
    this.key.updateMatrixWorld();
    this.lastShadowDir.copy(dir);
    return true;
  }
}
