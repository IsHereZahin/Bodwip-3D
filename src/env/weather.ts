import { smoothstep } from '../core/mathx';
import type { SeasonState } from './season';

// The weather on top of the season: showers that come and go (often in the rains, now and then in the
// summer, hardly ever in the winter), the cloud that comes with them, the squalls that run ahead of a
// storm (the summer's kalboishakhi above all), lightning in heavy rain, and how wet everything is: the land
// wets the sooner and the further the harder it rains (a drizzle only damps it; a downpour soon stands water in
// every hollow: render/patch.ts reads wet past ½ as puddles), and dries slowly once it stops, faster in the sun.
// The film can hold the rain and the wet where a scene wants them (`hold`), the cloud and the wind following.

export type WeatherChoice = 'auto' | 'clear' | 'drizzle' | 'rain' | 'storm';

export class Weather {
  /** The viewer's choice, or 'auto' to follow the season. */
  choice: WeatherChoice = 'auto';
  /** Until this scene time (s) the season's weather holds off, so the evening opens fine. */
  clearUntil = 0;
  /** How hard it is raining (0..1), the cloud cover, a squall's added wind (0..1). */
  rain = 0;
  cloud = 0.4;
  squall = 0;
  /** How wet the land is, 0..1: surfaces soaked through by ½, puddles from there on. */
  wet = 0;
  /** The film's own rain and wet for the scene now playing (rig/director.ts SceneWorld), or null. */
  hold: { rain: number; wet: number } | null = null;
  /** The light of the lightning now showing, 0..1 (world/lightning.ts sets it each frame; the environment reads it). */
  flash = 0;
  /** Set for one update when lightning strikes (world/lightning.ts draws it; the thunder follows). */
  struck = false;
  private nextStrike = 10;

  update(dt: number, t: number, season: SeasonState): void {
    // showers: a slow wander in time; it rains while it stands above a level the season sets
    const wander = 0.5 + 0.3 * Math.sin(t * 0.011 + 1.3) + 0.2 * Math.sin(t * 0.037 + 0.4);
    const level = 1 - season.rain * 1.3;
    let rain = smoothstep(level, level + 0.15, wander) * (0.45 + 0.55 * season.rain / 0.55);
    let cloud = Math.min(1, season.cloud + rain * 0.5);
    // a storm: the wind gets up ahead of the rain, and stays gusty through it
    const storminess = season.gusts > 0.75 ? (season.gusts - 0.75) * 4 : 0;
    let squall = rain * (0.5 + 0.5 * storminess);
    if (this.choice === 'clear' || (this.choice === 'auto' && t < this.clearUntil)) {
      rain = 0;
      cloud = Math.min(cloud, 0.25);
      squall = 0;
    } else if (this.choice === 'drizzle') {
      // a light, steady rain: the water stippled, hardly any wind with it
      rain = 0.3;
      cloud = Math.max(cloud, 0.7);
      squall = 0.05;
    } else if (this.choice === 'rain') {
      rain = Math.max(rain, 0.6);
      cloud = Math.max(cloud, 0.85);
      squall = Math.max(squall, 0.25);
    } else if (this.choice === 'storm') {
      rain = 1;
      cloud = 1;
      squall = 1;
    }
    if (this.hold) {
      // the film's weather: the cloud heavy over its rain, the wind rising with it
      rain = this.hold.rain;
      cloud = Math.max(cloud, 0.72 + 0.28 * rain);
      squall = Math.max(squall, rain * (0.32 + 0.6 * storminess));
    }
    // a shower comes on over some seconds, the cloud gathers a little ahead of it, a squall runs in quicker
    this.rain = this.hold ? rain : this.rain + (rain - this.rain) * (1 - Math.exp(-dt / 10));
    this.cloud += (cloud - this.cloud) * (1 - Math.exp(-dt / 8));
    this.squall += (squall - this.squall) * (1 - Math.exp(-dt / 6));
    if (this.hold) this.wet = this.hold.wet;
    else {
      // a rain soaks the land toward a wetness that goes with how hard it falls, the faster the harder (a
      // heavy shower in a minute or so); dry, it dries over a quarter of an hour, faster in the sun
      const soaked = this.rain > 0.02 ? Math.min(1, 0.3 + 0.8 * this.rain) : 0;
      if (soaked > this.wet) this.wet += (soaked - this.wet) * (1 - Math.exp(-(dt * (0.3 + this.rain)) / 50));
      else this.wet += (soaked - this.wet) * (1 - Math.exp(-dt / (900 * (0.4 + this.cloud))));
    }
    // lightning in heavy rain, more often in a storm
    this.struck = false;
    if (this.rain > 0.55) {
      this.nextStrike -= dt * (this.rain - 0.5) * (1 + 2 * this.squall);
      if (this.nextStrike <= 0) {
        this.struck = true;
        this.nextStrike = 4 + Math.random() * 14;
      }
    }
  }
}
