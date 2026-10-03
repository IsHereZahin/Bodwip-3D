import { smoothstep } from '../core/mathx';
import type { SeasonState } from './season';

// The weather on top of the season: showers that come and go (often in the rains, now and then in the
// summer, hardly ever in the winter), the cloud that comes with them, the squalls that run ahead of a
// storm (the summer's kalboishakhi above all), lightning in heavy rain, and how wet everything is, which
// lingers after the rain has stopped and dries in the sun.

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
  /** How wet the land is, 0..1. */
  wet = 0;
  /** A lightning flash's light, 0..1, decaying fast. */
  flash = 0;
  /** Set for one update when a flash strikes, so the thunder can follow it. */
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
    // a shower comes on over some seconds, the cloud gathers a little ahead of it, a squall runs in quicker
    this.rain += (rain - this.rain) * (1 - Math.exp(-dt / 10));
    this.cloud += (cloud - this.cloud) * (1 - Math.exp(-dt / 8));
    this.squall += (squall - this.squall) * (1 - Math.exp(-dt / 6));
    // wet in a minute of rain; dry over a quarter of an hour, faster in the sun
    if (this.rain > this.wet) this.wet += (this.rain - this.wet) * (1 - Math.exp(-dt / 40));
    else this.wet += (this.rain - this.wet) * (1 - Math.exp(-dt / (900 * (0.4 + this.cloud))));
    // lightning in heavy rain, more often in a storm
    this.struck = false;
    this.flash = Math.max(0, this.flash - dt * 6);
    if (this.rain > 0.55) {
      this.nextStrike -= dt * (this.rain - 0.5) * (1 + 2 * this.squall);
      if (this.nextStrike <= 0) {
        this.flash = 1;
        this.struck = true;
        this.nextStrike = 4 + Math.random() * 14;
      }
    }
  }
}
