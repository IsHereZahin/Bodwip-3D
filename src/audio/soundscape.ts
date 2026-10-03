/**
 * The whole soundscape is synthesised with Web Audio from one noise buffer and a few oscillators:
 * river, wind, oar splashes, birds by day, crickets by night. Nothing is downloaded.
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
  private nextBird = 2;
  private nextCricket = 0;
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
    this.master.gain.value = this.muted ? 0 : 0.8;
    this.master.connect(ctx.destination);

    this.river = this.bed(380, 40, 0.22);
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
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.ctx && this.master) this.master.gain.setTargetAtTime(muted ? 0 : 0.8, this.ctx.currentTime, 0.15);
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

  /** The paddle's blade going into the water. */
  splash(): void {
    const ctx = this.ctx;
    if (!ctx || !this.master || this.muted) return;
    const t = ctx.currentTime;
    const s = ctx.createBufferSource();
    s.buffer = this.noise;
    s.playbackRate.value = 1.2 + Math.random() * 0.3;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(1600, t);
    bp.frequency.exponentialRampToValueAtTime(500, t + 0.35);
    bp.Q.value = 0.9;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.09, t + 0.04);
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
    for (let k = 0; k < 4; k++) {
      for (let p = 0; p < 3; p++) {
        const at = t + k * 0.42 + p * 0.045;
        g.gain.setValueAtTime(0.012 * level, at);
        g.gain.setValueAtTime(0, at + 0.025);
      }
    }
    o.start(t);
    o.stop(t + 1.8);
  }

  /** Thunder after a lightning flash: a low roll that swells and dies away. */
  thunder(): void {
    const ctx = this.ctx;
    if (!ctx || !this.master || this.muted) return;
    const t = ctx.currentTime + 0.4 + Math.random() * 2.5;
    const s = ctx.createBufferSource();
    s.buffer = this.noise;
    s.playbackRate.value = 0.35 + Math.random() * 0.15;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 160;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.5, t + 0.25);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 3.5 + Math.random() * 2);
    s.connect(lp).connect(g).connect(this.master);
    s.start(t, Math.random() * 2);
    s.stop(t + 6);
  }

  update(dt: number, night: number, wind: number, rain: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.master || !this.wind || !this.windFilter || !this.river || !this.rain) return;
    const now = ctx.currentTime;
    // the river carries further in the still night air
    this.river.gain.setTargetAtTime(0.2 + 0.08 * night, now, 2);
    // the wind roars more than it grows: louder and higher as it strengthens
    this.wind.gain.setTargetAtTime(0.008 + 0.018 * wind + 0.012 * wind * wind, now, 1);
    this.rain.gain.setTargetAtTime(0.09 * rain, now, 1.5);
    this.windFilter.frequency.setTargetAtTime(280 + 140 * wind + 260 * Math.sin(now * 0.07) ** 2, now, 2);
    if (this.muted) return;
    this.nextBird -= dt;
    if (this.nextBird <= 0) {
      if (night < 0.4 && Math.random() > night) this.bird();
      this.nextBird = 2.5 + Math.random() * 6;
    }
    this.nextCricket -= dt;
    if (this.nextCricket <= 0) {
      if (night > 0.3) this.crickets(night);
      this.nextCricket = 0.6 + Math.random() * 1.6;
    }
  }
}
