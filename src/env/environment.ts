import { Color, DirectionalLight, HemisphereLight, Vector3 } from 'three';
import type { Object3D } from 'three';
import { G } from '../core/globals';
import { DEG, clamp, smoothstep } from '../core/mathx';
import type { Sky } from '../world/sky';
import type { Water } from '../world/water';
import { moonDirection, moonIllumination, sunDirection } from './astro';
import type { SeasonState } from './season';
import type { Weather } from './weather';

// Light and colour for a moment of the day. A table of looks keyed on the sun's elevation gives every
// colour; the moon lights the night when it is up, as brightly as its phase allows. The season and the
// weather then work on it: cloud dims the sun and greys the sky (its own soft light taking over), the
// season's haze and fog thicken the air (winter mornings vanish into fog), the river takes the season's
// silt, and lightning lights everything for an instant.

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

/** Where the faint light of a moonless sky seems to come from: high, a little off the zenith. */
const SKY_GLOW_DIR = new Vector3(0.25, 0.92, -0.3).normalize();

const tmpA = new Color();
const tmpB = new Color();
/** The river's silt in autumn, which the looks' water colours were made for. */
const AUTUMN_SILT = new Color('#7d6a46');

/** Draws a colour toward the grey of its own brightness. */
function toGrey(c: Color, k: number): void {
  const lum = c.r * 0.3 + c.g * 0.59 + c.b * 0.11;
  c.lerp(tmpA.setScalar(lum * 0.92), k);
}

function mixLook(a: Look, b: Look, t: number, key: keyof Look, scaleKey: keyof Look | null, out: Color): Color {
  tmpA.set(a[key] as string).multiplyScalar(scaleKey ? (a[scaleKey] as number) : 1);
  tmpB.set(b[key] as string).multiplyScalar(scaleKey ? (b[scaleKey] as number) : 1);
  return out.copy(tmpA).lerp(tmpB, t);
}

/** The two looks either side of a sun elevation, and how far between them it lies. */
function bracket(elev: number): [Look, Look, number] {
  let i = 1;
  while (i < LOOKS.length - 1 && LOOKS[i].elev < elev) i++;
  const a = LOOKS[i - 1];
  const b = LOOKS[i];
  return [a, b, smoothstep(0, 1, clamp((elev - a.elev) / (b.elev - a.elev), 0, 1))];
}

/** A display colour for the horizon at a sun elevation; the timeline paints the day with it. */
export function skyColorAt(elev: number, out: Color): Color {
  const [a, b, t] = bracket(elev);
  const k = Math.sqrt(a.horizonK + (b.horizonK - a.horizonK) * t);
  return out.set(a.horizon).lerp(tmpB.set(b.horizon), t).multiplyScalar(Math.min(1, k));
}

export class Environment {
  exposure = 1;
  /** 0 by day, 1 at night: lanterns, fireflies, stars. */
  night = 0;
  lamp = 0;
  readonly elevation = { deg: 0 };
  readonly key: DirectionalLight;
  readonly hemi: HemisphereLight;
  /** Directions to the sun and the moon; either may be below the horizon. */
  readonly sunDir = new Vector3();
  readonly moonDir = new Vector3();
  private readonly sunColor = new Color();
  private readonly moonColor = new Color();
  private readonly lastShadowDir = new Vector3();
  private readonly sky: Sky;
  private readonly water: Water;
  /** The season and the weather this light is made for (set once by main; read each update). */
  season: SeasonState | null = null;
  weather: Weather | null = null;

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
    if (this.key.shadow.mapSize.x === size) return;
    this.key.shadow.mapSize.set(size, size);
    // a map already made keeps its size until it is let go
    this.key.shadow.map?.dispose();
    this.key.shadow.map = null;
  }

  /** `hour` is local solar time (12 = noon); `moonAge` is days since new moon. */
  update(hour: number, moonAge: number): void {
    sunDirection(hour, this.sunDir);
    const elev = Math.asin(this.sunDir.y) / DEG;
    this.elevation.deg = elev;
    const [a, b, t] = bracket(elev);

    mixLook(a, b, t, 'zenith', 'zenithK', this.sky.zenith);
    mixLook(a, b, t, 'horizon', 'horizonK', this.sky.horizon);
    mixLook(a, b, t, 'fog', 'fogK', G.uFogColor.value);
    mixLook(a, b, t, 'glow', 'glowK', G.uGlow.value);
    mixLook(a, b, t, 'sun', null, this.sunColor);
    const sunE = a.sunE + (b.sunE - a.sunE) * t;
    const s = this.season;
    const w = this.weather;
    const cloud = w ? w.cloud : 0.44;
    const rain = w ? w.rain : 0;
    const flash = w ? w.flash : 0;
    // overcast: the sun dims behind the cloud and the sky's own grey light takes over
    const overcast = smoothstep(0.5, 0.95, cloud);
    toGrey(this.sky.zenith, overcast * 0.75);
    toGrey(this.sky.horizon, overcast * 0.7);
    toGrey(G.uFogColor.value, overcast * 0.6);
    G.uGlow.value.multiplyScalar(1 - 0.8 * overcast);
    this.sky.zenith.addScalar(flash * 0.25);
    this.sky.cloud.value = cloud;
    G.uOvercast.value = overcast;
    // the season's sunlight: harsher in the summer, cooler in the winter
    const warm = s ? s.warm : 0;
    this.sunColor.multiply(tmpB.setRGB(1 + 0.4 * warm, 1, 1 - 0.6 * warm));
    // the disc sinks below the horizon over the last degree
    const visible = smoothstep(-1.2, 0.6, elev);
    G.uSunColor.value.copy(this.sunColor).multiplyScalar(sunE * visible * (s ? s.light : 1) * (1 - 0.8 * overcast));
    G.uSunDir.value.copy(this.sunDir);
    this.exposure = (a.exposure + (b.exposure - a.exposure) * t) * (1 + 0.15 * overcast + 0.6 * flash);
    // mist gathers on the river before sunrise and burns off as the sun climbs; evenings stay clear. In
    // the winter and late autumn the mornings drown in fog; dust and rain thicken the air
    const dawn = hour < 12 ? smoothstep(-14, -4, elev) * smoothstep(12, 2, elev) : 0;
    const fog = s ? s.fog : 0.3;
    G.uMist.value = (a.mist + (b.mist - a.mist) * t) * (1 + 0.9 * dawn) * (1 + fog * (0.4 + 3.2 * dawn));
    // thick fog is white: it drowns the sunrise's colour rather than taking it
    toGrey(G.uFogColor.value, fog * dawn * 0.75);
    G.uFogColor.value.multiplyScalar(1 + fog * dawn * 0.35);
    G.uGlow.value.multiplyScalar(1 - 0.7 * fog * dawn);
    G.uFogDensity.value = (0.0006 + 0.0003 * smoothstep(20, -5, elev)) * (1 + 0.8 * (s ? s.haze : 0.15) + 2.5 * rain);
    this.night = smoothstep(-3, -12, elev);
    this.lamp = smoothstep(4, -5, elev);
    G.uNight.value = this.night;

    // night light: the moon while it is up, as brightly as its phase allows and warmer when low, over a
    // faint glow from the whole sky, so a moonless night still shows its shapes
    moonDirection(hour, moonAge, this.moonDir);
    this.sky.moonDir.copy(this.moonDir);
    const moonElev = Math.asin(this.moonDir.y) / DEG;
    const phase = 0.15 + 0.85 * Math.pow(moonIllumination(moonAge), 1.5);
    const moonUp = phase * smoothstep(-0.5, 6, moonElev);
    this.sky.moonGlow.value = phase * smoothstep(-2, 4, moonElev);
    const dark = smoothstep(-5, -14, elev);
    const moonE = 0.7 * dark * moonUp;
    const glowE = 0.4 * dark * (1 - 0.6 * moonUp);
    if (elev < -4.5) {
      this.moonColor.set('#9fb6e6').lerp(tmpB.set('#e2bc92'), smoothstep(16, 3, moonElev));
      G.uKeyColor.value.copy(this.moonColor).multiplyScalar(moonE).add(tmpB.set('#8a9ccc').multiplyScalar(glowE));
      // one light for both: it comes from the moon as soon as the moon clears the horizon (so its
      // glitter on the water sits under the moon) and from the sky's glow while there is no moon
      G.uKeyDir.value.copy(this.moonDir).multiplyScalar(moonE * 5).addScaledVector(SKY_GLOW_DIR, glowE + 1e-4).normalize();
    } else {
      G.uKeyDir.value.copy(this.sunDir);
      G.uKeyColor.value.copy(G.uSunColor.value);
    }
    this.key.color.copy(G.uKeyColor.value);
    this.key.intensity = 1;

    this.hemi.color.set(a.hemiSky).lerp(tmpB.set(b.hemiSky), t);
    toGrey(this.hemi.color, overcast * 0.6);
    this.hemi.groundColor.set(a.hemiGround).lerp(tmpB.set(b.hemiGround), t);
    this.hemi.intensity = (a.hemiE + (b.hemiE - a.hemiE) * t) * (1 + 0.3 * overcast) + flash * 2.5;

    this.water.color.set(a.water).lerp(tmpB.set(b.water), t);
    // the season's silt, against the autumn the looks were made for
    if (s) this.water.color.multiply(tmpB.copy(s.silt)).multiply(tmpA.setRGB(1 / AUTUMN_SILT.r, 1 / AUTUMN_SILT.g, 1 / AUTUMN_SILT.b));
    this.water.ambient.copy(this.hemi.color).multiplyScalar(this.hemi.intensity * 1.6);
    // what the silty water body sends back: lit by the sky and a little by the key light
    const keyUp = Math.max(G.uKeyDir.value.y, 0);
    G.uWaterBody.value
      .copy(G.uKeyColor.value)
      .multiplyScalar(keyUp * 0.45)
      .add(this.water.ambient)
      .multiply(this.water.color)
      .multiplyScalar(1 / Math.PI);
  }

  /** Points the shadow at `focus`; returns true when the shadow map needs redrawing. */
  aimShadow(focus: Vector3, force: boolean): boolean {
    const dir = G.uKeyDir.value;
    const moved = this.key.target.position.distanceToSquared(focus) > 1;
    // while the key is dark (the moon is down) its shadow is invisible, so it need not follow
    const c = G.uKeyColor.value;
    const turned = c.r + c.g + c.b > 0 && this.lastShadowDir.dot(dir) < 0.99996;
    if (!force && !moved && !turned) return false;
    this.key.target.position.copy(focus);
    this.key.position.copy(focus).addScaledVector(dir, 420);
    this.key.target.updateMatrixWorld();
    this.key.updateMatrixWorld();
    this.lastShadowDir.copy(dir);
    return true;
  }
}
