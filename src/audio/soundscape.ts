/**
 * The whole soundscape is synthesised with Web Audio from one noise buffer and a few oscillators: the khal's
 * water, wind, rain, the paddle's splashes, birds by day, crickets by night, thunder. Nothing is downloaded.
 * Browsers only allow audio after a user gesture, so `start()` is called from one.
 */
export class Soundscape {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private river: GainNode | null = null;
  private lap: GainNode | null = null;
  private wind: GainNode | null = null;
  private windFilter: BiquadFilterNode | null = null;
  private rain: GainNode | null = null;
  /** A downpour's roar under the hiss: low and full, only in heavy rain. */
  private downpour: GainNode | null = null;
  private nextBird = 2;
  private nextCricket = 0;
  /** Thunder on its way (it travels at the speed of sound), to be let fade if the scene changes first. */
  private readonly rolling: { source: AudioBufferSourceNode; gain: GainNode }[] = [];
  private hidden = false;
  muted = false;

  start(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    let ctx: AudioContext;
    try {
      ctx = new AudioContext();
    } catch (err) {
      console.warn('Audio unavailable', err);
      return;
    }
    this.ctx = ctx;
    const len = ctx.sampleRate * 4;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    let brown = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      brown = 0.985 * brown + 0.015 * w;
      data[i] = w * 0.5 + brown * 3;
    }
    this.noise = buf;
    this.master = ctx.createGain();
    // it comes in gently, not at once with the first touch
    this.master.gain.value = 0;
    if (!this.muted) this.master.gain.setTargetAtTime(0.8, ctx.currentTime, 0.5);
    this.master.connect(ctx.destination);

    this.river = this.bed(380, 40, 0.12);
    this.lap = this.bed(1100, 300, 0.03);
    // the lapping comes and goes in slow waves
    const lfo = ctx.createOscillator();
    const lfoGain = ctx.createGain();
    lfo.frequency.value = 0.23;
    lfoGain.gain.value = 0.025;
    lfo.connect(lfoGain).connect(this.lap.gain);
    lfo.start();
    this.windFilter = ctx.createBiquadFilter();
    this.windFilter.type = 'bandpass';
    this.windFilter.frequency.value = 420;
    this.windFilter.Q.value = 0.7;
    this.wind = ctx.createGain();
    this.wind.gain.value = 0.02;
    const src = this.loop();
    src.connect(this.windFilter).connect(this.wind).connect(this.master);
    // rain: a bright hiss on the water and the leaves, silent until it rains
    this.rain = this.bed(9000, 1400, 0);
    this.downpour = this.bed(900, 120, 0);
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    this.settle();
  }

  /** The page is hidden (or shown again): nothing plays while nobody can see it. */
  pause(hidden: boolean): void {
    this.hidden = hidden;
    this.settle();
  }

  /** Fades to the level wanted and lets the context sleep while it is silent (or wakes it). */
  private settle(): void {
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
    const silent = this.muted || this.hidden;
    if (!silent && ctx.state === 'suspended') void ctx.resume();
    this.master.gain.setTargetAtTime(silent ? 0 : 0.8, ctx.currentTime, 0.15);
    if (silent)
      setTimeout(() => {
        if ((this.muted || this.hidden) && ctx.state === 'running') void ctx.suspend();
      }, 800);
  }

  private loop(): AudioBufferSourceNode {
    const ctx = this.ctx!;
    const s = ctx.createBufferSource();
    s.buffer = this.noise;
    s.loop = true;
    s.playbackRate.value = 0.8 + Math.random() * 0.4;
    s.start(0, Math.random() * 3);
    return s;
  }

  /** A looping band of filtered noise. */
  private bed(lowpass: number, highpass: number, gain: number): GainNode {
    const ctx = this.ctx!;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = lowpass;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = highpass;
    const g = ctx.createGain();
    g.gain.value = gain;
    this.loop().connect(lp).connect(hp).connect(g).connect(this.master!);
    return g;
  }

  /**
   * The paddle's blade going into the water, in a stroke of `power` (a strong one louder and deeper), heard at
   * `level` (0..1: how near it is to the listener).
   */
  splash(power = 1, level = 1): void {
    const ctx = this.ctx;
    if (!ctx || !this.master || this.muted || level <= 0.01) return;
    const t = ctx.currentTime;
    const s = ctx.createBufferSource();
    s.buffer = this.noise;
    s.playbackRate.value = 1.2 + Math.random() * 0.3 - 0.25 * (power - 1);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(1600, t);
    bp.frequency.exponentialRampToValueAtTime(500, t + 0.35);
    bp.Q.value = 0.9;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.09 * (0.55 + 0.45 * power) * level, t + 0.04);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.55);
    s.connect(bp).connect(g).connect(this.master);
    s.start(t, Math.random() * 3);
    s.stop(t + 0.6);
  }

  /** A short whistled phrase, like a magpie-robin (doyel) singing from the bank. */
  private bird(): void {
    const ctx = this.ctx!;
    const t = ctx.currentTime + 0.05;
    const pan = ctx.createStereoPanner();
    pan.pan.value = Math.random() * 1.6 - 0.8;
    pan.connect(this.master!);
    const notes = 2 + Math.floor(Math.random() * 4);
    let at = t;
    for (let i = 0; i < notes; i++) {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      const f0 = 2200 + Math.random() * 1800;
      const dur = 0.07 + Math.random() * 0.12;
      o.frequency.setValueAtTime(f0, at);
      o.frequency.exponentialRampToValueAtTime(f0 * (0.7 + Math.random() * 0.7), at + dur);
      g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(0.025, at + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
      o.connect(g).connect(pan);
      o.start(at);
      o.stop(at + dur + 0.02);
      at += dur + 0.04 + Math.random() * 0.08;
    }
  }

  /** A burst of cricket chirps: a high tone pulsed a few times. */
  private crickets(level: number): void {
    const ctx = this.ctx!;
    const t = ctx.currentTime + 0.05;
    const o = ctx.createOscillator();
    o.frequency.value = 4300 + Math.random() * 600;
    const g = ctx.createGain();
    g.gain.value = 0;
    const pan = ctx.createStereoPanner();
    pan.pan.value = Math.random() * 1.8 - 0.9;
    o.connect(g).connect(pan).connect(this.master!);
    // each chirp eased in and out over a few milliseconds, so it doesn't click
    for (let k = 0; k < 4; k++) {
      for (let p = 0; p < 3; p++) {
        const at = t + k * 0.42 + p * 0.045;
        g.gain.setValueAtTime(0, at);
        g.gain.linearRampToValueAtTime(0.012 * level, at + 0.003);
        g.gain.setValueAtTime(0.012 * level, at + 0.022);
        g.gain.linearRampToValueAtTime(0, at + 0.025);
      }
    }
    o.start(t);
    o.stop(t + 1.8);
  }

  /** Thunder after a lightning strike `metres` off: it comes at the speed of sound, a low roll that swells and dies away, quieter from further. */
  thunder(metres: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.master || this.muted) return;
    const t = ctx.currentTime + metres / 343;
    const loud = 0.6 * Math.min(1, 900 / Math.max(metres, 300));
    const s = ctx.createBufferSource();
    s.buffer = this.noise;
    s.playbackRate.value = 0.35 + Math.random() * 0.15;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 160;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(loud, t + 0.25);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 3.5 + Math.random() * 2);
    s.connect(lp).connect(g).connect(this.master);
    s.start(t, Math.random() * 2);
    s.stop(t + 6);
    const roll = { source: s, gain: g };
    this.rolling.push(roll);
    s.onended = () => this.rolling.splice(this.rolling.indexOf(roll), 1);
  }

  /** The scene has changed: thunder still on its way from the last one fades out now. */
  hushThunder(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    for (const r of this.rolling) {
      r.gain.gain.cancelScheduledValues(ctx.currentTime);
      r.gain.gain.setTargetAtTime(0.0001, ctx.currentTime, 0.2);
    }
  }

  /**
   * `night`, `wind` (its strength now), `rain` (0..1) where the listener is; `water`: how near the water they
   * are (1 on it or by it, 0 high above it or far off over the fields).
   */
  update(dt: number, night: number, wind: number, rain: number, water: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.master || !this.wind || !this.windFilter || !this.river || !this.rain || !this.lap) return;
    const now = ctx.currentTime;
    // the khal's slow water is a murmur, carried further in the still night air, heard by the water
    this.river.gain.setTargetAtTime((0.12 + 0.06 * night) * (0.15 + 0.85 * water), now, 2);
    this.lap.gain.setTargetAtTime(0.03 * water, now, 1.5);
    // the wind roars more than it grows: louder and higher as it strengthens
    this.wind.gain.setTargetAtTime(0.008 + 0.018 * wind + 0.012 * wind * wind, now, 1);
    // the hiss grows faster than the rain (a drizzle is soft, a downpour loud), and a roar comes in under it
    this.rain.gain.setTargetAtTime(0.04 * rain + 0.08 * rain * rain, now, 1.5);
    if (this.downpour) this.downpour.gain.setTargetAtTime(0.11 * Math.max(0, (rain - 0.45) / 0.55) ** 1.5, now, 2);
    this.windFilter.frequency.setTargetAtTime(280 + 140 * wind + 260 * Math.sin(now * 0.07) ** 2, now, 2);
    if (this.muted || this.hidden) return;
    // the birds keep quiet in the rain and a hard wind, as the songbirds do (they sit still then)
    this.nextBird -= dt;
    if (this.nextBird <= 0) {
      if (night < 0.4 && rain < 0.3 && wind < 1.5 && Math.random() > night) this.bird();
      this.nextBird = 2.5 + Math.random() * 6;
    }
    this.nextCricket -= dt;
    if (this.nextCricket <= 0) {
      if (night > 0.3 && rain < 0.6) this.crickets(night * (1 - rain));
      this.nextCricket = 0.6 + Math.random() * 1.6;
    }
  }
}
