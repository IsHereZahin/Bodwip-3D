/** A point in the world (m). */
type Point = { x: number; y: number; z: number };

/** What the train sounds from this frame (world/railway.ts `Train.acoustics`). */
export interface TrainSound {
  /** Its engine, under the cab car. */
  engine: Point;
  /** Its bogies, where its wheels roll on the rails. */
  bogies: Point[];
  /** The rail joints its wheels struck since the last frame: where, and how long ago (s). */
  joints: (Point & { ago: number })[];
  /** How long ago the driver began to sound the horn (s), if since the last frame. */
  horn: number | null;
}

/** The speed of sound (m/s). */
const SOUND_SPEED = 343;
/**
 * The train's loudness (gain): its wheels' rolling at `near` m beside its middle (its bogies' power summed there is
 * ≈`rollSum`), its engine and its horn at `near` m, a joint's clack at `clackNear` m; how far off its clatter is still
 * heard (m); its delay lines' longest wait (s: ≈2 km). An air horn carries over the fields a kilometre and more
 * (at 450 m it is as loud as the train's rolling beside it), and on jointed rails each clack stands out over the
 * rolling: the bus's compressor holds them in as near as they come.
 */
const TRAIN_VOICE = { roll: 0.3, rollSum: 5, engine: 0.07, horn: 3, clack: 1, near: 20, clackNear: 10, clatterReach: 450, longest: 6 };
/** How far from the railway line the train is heard (m): whole within the first, gone past the second (the user's rule: none past 300 m). */
const TRAIN_HEARD: readonly [number, number] = [260, 300];
/** The horn's two notes (Hz) and its blasts: when each begins after the first (s) and how long it lasts (one long one, as the user's reference sounds it). */
const HORN = { notes: [295, 360], blasts: [[0, 2.8]] } as const;

/** What the air and the grass take of a sound's highs over `r` m: the cutoff of a lowpass (Hz). */
const airCutoff = (r: number) => Math.max(320, 9000 / (1 + r / 80));

/** A sound placed in the world: the wait its distance gives it (Doppler as that changes), its level, its highs lost on the way, its side. */
interface Placed {
  delay: DelayNode;
  level: GainNode;
  air: BiquadFilterNode;
  pan: StereoPannerNode;
}

interface TrainVoice {
  bus: GainNode;
  roll: Placed;
  engine: Placed;
  horn: Placed;
  /** The horn's valve: open while the driver sounds it (before the delay: the sound sets off from the train). */
  hornGate: GainNode;
  /** The horn's pitch as the air's pressure bends it (cents, onto every bell's detune). */
  hornBend: ConstantSourceNode;
  /** Where the listener and the engine were last frame, and whether the train was heard then: a jump of either puts its sounds where they are at once. */
  ear: Point;
  engineWas: Point;
  heard: boolean;
}

/**
 * The whole soundscape is synthesised with Web Audio from one noise buffer and a few oscillators: the khal's
 * water, wind, rain, birds by day, crickets by night, frogs in the rains, the rush of the hill stream's falls and
 * the sluice, thunder, the train (no paddle: the user had its splashes taken out). Nothing is downloaded.
 * Browsers only allow audio after a user gesture: `start()` before one makes the context but it waits, and a
 * `start()` from the first gesture wakes it.
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
  /** Falling water near: the hill stream's falls, the sluice's spill. */
  private falls: GainNode | null = null;
  private nextBird = 2;
  private nextCricket = 0;
  private nextFrog = 0;
  /** Thunder on its way (it travels at the speed of sound), to be let fade if the scene changes first. */
  private readonly rolling: { source: AudioBufferSourceNode; gain: GainNode }[] = [];
  private trainVoice: TrainVoice | null = null;
  private hidden = false;
  muted = false;

  /** Whether it is really being heard: on, and the browser letting it play (not waiting for a first gesture). */
  get audible(): boolean {
    return !this.muted && this.ctx?.state === 'running';
  }

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
    this.falls = this.bed(5200, 450, 0);
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

  /**
   * A frog calling from the water's edge in the rains: mostly the small frogs' quick rattling croaks, now and then a
   * bullfrog's deep two or three "gwaang"s.
   */
  private frog(level: number): void {
    const ctx = this.ctx!;
    const t = ctx.currentTime + 0.05;
    const pan = ctx.createStereoPanner();
    pan.pan.value = Math.random() * 1.8 - 0.9;
    pan.connect(this.master!);
    const bull = Math.random() < 0.18;
    const o = ctx.createOscillator();
    o.type = bull ? 'sawtooth' : 'square';
    const f = bull ? 110 + Math.random() * 60 : 650 + Math.random() * 650;
    o.frequency.value = f;
    const filter = ctx.createBiquadFilter();
    filter.type = bull ? 'lowpass' : 'bandpass';
    filter.frequency.value = bull ? 520 : f * 1.6;
    filter.Q.value = bull ? 0.8 : 4;
    const g = ctx.createGain();
    g.gain.value = 0;
    o.connect(filter).connect(g).connect(pan);
    const peak = (bull ? 0.05 : 0.016) * level;
    const calls = bull ? 2 + Math.floor(Math.random() * 2) : 1 + Math.floor(Math.random() * 3);
    let at = t;
    for (let c = 0; c < calls; c++) {
      if (bull) {
        // a swelling croak, falling a little in pitch
        o.frequency.setValueAtTime(f * 1.08, at);
        o.frequency.linearRampToValueAtTime(f * 0.92, at + 0.42);
        g.gain.setValueAtTime(0, at);
        g.gain.linearRampToValueAtTime(peak, at + 0.08);
        g.gain.linearRampToValueAtTime(peak * 0.7, at + 0.32);
        g.gain.linearRampToValueAtTime(0, at + 0.45);
        at += 0.7 + Math.random() * 0.3;
      } else {
        // a rattle: a few quick pulses
        const pulses = 4 + Math.floor(Math.random() * 5);
        for (let p = 0; p < pulses; p++) {
          const pa = at + p * 0.045;
          g.gain.setValueAtTime(0, pa);
          g.gain.linearRampToValueAtTime(peak, pa + 0.006);
          g.gain.linearRampToValueAtTime(0, pa + 0.03);
        }
        at += pulses * 0.045 + 0.18 + Math.random() * 0.25;
      }
    }
    o.start(t);
    o.stop(at + 0.1);
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
    // (not into a clock held still: it would roll as the sound first starts)
    if (!ctx || !this.master || this.muted || ctx.state !== 'running') return;
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
   * The train, heard where the listener is (`ear`, its right `right`): its wheels rolling at every bogie, its
   * engine, its horn, and the clack of each rail joint a wheel strikes. Each comes as sound does: late by its
   * distance at the speed of sound (a delay that follows the distance, so it comes higher in pitch and goes lower:
   * Doppler), fainter with it, its highs lost in the air and the grass, from its side. `src` null: it has gone by.
   * `lineOff`: how far the listener is from the railway line (m): past `TRAIN_HEARD` it is not heard at all (the
   * user's rule, 2026-10-08), faded out over the last metres of it.
   */
  train(src: TrainSound | null, ear: Point, right: Point, lineOff: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
    const v = (this.trainVoice ??= this.makeTrainVoice());
    const now = ctx.currentTime;
    const heard = Math.min(1, Math.max(0, (TRAIN_HEARD[1] - lineOff) / (TRAIN_HEARD[1] - TRAIN_HEARD[0])));
    v.bus.gain.setTargetAtTime(heard, now, 0.3);
    if (!src || heard <= 0) {
      for (const p of [v.roll, v.engine, v.horn]) p.level.gain.setTargetAtTime(0, now, 0.4);
      v.heard = false;
      return;
    }
    // (a jump of the listener or the train, a cut, a still, the next run: its sounds put where they now are at once,
    // not swept there in a wail of Doppler)
    const e = src.engine;
    const jumped = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) > 40;
    const snap = !v.heard || jumped(ear, v.ear) || jumped(e, v.engineWas);
    v.heard = true;
    Object.assign(v.ear, { x: ear.x, y: ear.y, z: ear.z });
    Object.assign(v.engineWas, { x: e.x, y: e.y, z: e.z });
    const side = (p: Point, r: number) => (((p.x - ear.x) * right.x + (p.y - ear.y) * right.y + (p.z - ear.z) * right.z) / r) * 0.85;
    // its wheels' rolling: every bogie's, adding as noise does (by their power), heard as late as the nearest
    let power = 0;
    let pan = 0;
    let nearest = Infinity;
    for (const b of src.bogies) {
      const r = Math.max(2, Math.hypot(b.x - ear.x, b.y - ear.y, b.z - ear.z));
      const w = (TRAIN_VOICE.near / r) ** 2;
      power += w;
      pan += w * side(b, r);
      nearest = Math.min(nearest, r);
    }
    this.place(v.roll, TRAIN_VOICE.roll * Math.sqrt(power / TRAIN_VOICE.rollSum), nearest, pan / power, snap);
    const r = Math.max(2, Math.hypot(e.x - ear.x, e.y - ear.y, e.z - ear.z));
    const near = Math.min(1, TRAIN_VOICE.near / r);
    this.place(v.engine, TRAIN_VOICE.engine * near, r, side(e, r), snap);
    this.place(v.horn, TRAIN_VOICE.horn * near, r, side(e, r), snap);
    // (the horn and the rail joints not while the browser holds the sound back: they would sound as it starts)
    if (this.muted || this.hidden || ctx.state !== 'running') return;
    if (src.horn !== null) this.blowHorn(v, src.horn);
    for (const j of src.joints) {
      const rj = Math.max(1, Math.hypot(j.x - ear.x, j.y - ear.y, j.z - ear.z));
      if (rj < TRAIN_VOICE.clatterReach) this.clack(v, rj, j.ago, side(j, rj));
    }
  }

  /** The train's voice: its bus (held in by a compressor, as near as it passes), its rolling, its engine and its horn. */
  private makeTrainVoice(): TrainVoice {
    const ctx = this.ctx!;
    const bus = ctx.createGain();
    const hold = ctx.createDynamicsCompressor();
    hold.threshold.value = -16;
    hold.knee.value = 10;
    hold.ratio.value = 3.5;
    hold.attack.value = 0.004;
    hold.release.value = 0.3;
    bus.connect(hold).connect(this.master!);
    const placed = (): Placed => {
      const delay = ctx.createDelay(TRAIN_VOICE.longest);
      const level = ctx.createGain();
      level.gain.value = 0;
      const air = ctx.createBiquadFilter();
      air.type = 'lowpass';
      const pan = ctx.createStereoPanner();
      delay.connect(level).connect(air).connect(pan).connect(bus);
      return { delay, level, air, pan };
    };
    const filter = (type: BiquadFilterType, frequency: number, q = 0.7, gain = 0) => {
      const f = ctx.createBiquadFilter();
      f.type = type;
      f.frequency.value = frequency;
      f.Q.value = q;
      f.gain.value = gain;
      return f;
    };
    const tone = (type: OscillatorType, frequency: number, gain: number, to: AudioNode) => {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = frequency;
      const g = ctx.createGain();
      g.gain.value = gain;
      o.connect(g).connect(to);
      o.start();
    };
    // the wheels on the rails (as a recorded diesel train has them, the user's reference of 2026-10-08): a roar
    // strongest from 150 to 500 Hz with little under it, and the rails' ring round 2.4 kHz
    const roll = placed();
    this.loop().connect(filter('highpass', 100)).connect(filter('highpass', 100)).connect(filter('peaking', 300, 0.7, 6)).connect(filter('lowpass', 700)).connect(roll.delay);
    const ring = ctx.createGain();
    ring.gain.value = 0.6;
    this.loop().connect(filter('bandpass', 2400, 0.8)).connect(ring).connect(roll.delay);
    // the engine: a diesel's firing (a low saw and its fifth) and its exhaust, beating a little
    const engine = placed();
    const firing = ctx.createGain();
    tone('sawtooth', 61, 0.6, firing);
    tone('square', 91.5, 0.25, firing);
    this.loop().connect(filter('lowpass', 240)).connect(firing);
    const beat = ctx.createGain();
    beat.gain.value = 0.85;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 6.2;
    const depth = ctx.createGain();
    depth.gain.value = 0.15;
    lfo.connect(depth).connect(beat.gain);
    lfo.start();
    firing.connect(filter('highpass', 45)).connect(filter('lowpass', 420)).connect(beat).connect(engine.delay);
    // the horn: an air horn's two notes, each from a pair of bells a few cents apart (they beat softly), through its
    // bells' brightness (its harmonics as strong as its notes up to 2 kHz, as the reference's), with the rush of its
    // air under them; its valve shut till the driver sounds it, its pitch bent by the air's pressure (`hornBend`)
    const horn = placed();
    const hornGate = ctx.createGain();
    hornGate.gain.value = 0;
    const bell = filter('highpass', 220);
    const hornBend = ctx.createConstantSource();
    hornBend.offset.value = 0;
    hornBend.start();
    const wobble = ctx.createOscillator();
    wobble.frequency.value = 0.7;
    const wobbleDepth = ctx.createGain();
    wobbleDepth.gain.value = 6;
    wobble.connect(wobbleDepth);
    wobble.start();
    for (const note of HORN.notes) {
      for (const [cents, gain] of [[-5, 0.5], [7, 0.3]] as const) {
        const o = ctx.createOscillator();
        o.type = 'sawtooth';
        o.frequency.value = note;
        o.detune.value = cents;
        hornBend.connect(o.detune);
        wobbleDepth.connect(o.detune);
        const g = ctx.createGain();
        g.gain.value = gain;
        o.connect(g).connect(bell);
        o.start();
      }
    }
    const air = ctx.createGain();
    air.gain.value = 0.12;
    this.loop().connect(filter('bandpass', 1800, 0.5)).connect(air).connect(hornGate);
    bell.connect(filter('peaking', 1400, 0.7, 12)).connect(filter('lowpass', 4000)).connect(hornGate).connect(horn.delay);
    return { bus, roll, engine, horn, hornGate, hornBend, ear: { x: 0, y: 0, z: 0 }, engineWas: { x: 0, y: 0, z: 0 }, heard: false };
  }

  /** Sets a placed sound for `r` m off: its wait (smoothly, or at once on a jump), its level, what the air leaves it, its side. */
  private place(s: Placed, level: number, r: number, pan: number, snap: boolean): void {
    const now = this.ctx!.currentTime;
    const wait = Math.min(TRAIN_VOICE.longest, r / SOUND_SPEED);
    if (snap) {
      s.delay.delayTime.cancelScheduledValues(now);
      s.delay.delayTime.setValueAtTime(wait, now);
    } else s.delay.delayTime.setTargetAtTime(wait, now, 0.1);
    s.level.gain.setTargetAtTime(level, now, 0.1);
    s.air.frequency.setTargetAtTime(airCutoff(r), now, 0.2);
    s.pan.pan.setTargetAtTime(pan, now, 0.1);
  }

  /** The driver sounds the horn (begun `ago` s back): a long blast and a short one, set off from the train. */
  private blowHorn(v: TrainVoice, ago: number): void {
    const start = Math.max(this.ctx!.currentTime, this.ctx!.currentTime - ago);
    const g = v.hornGate.gain;
    const bend = v.hornBend.offset;
    for (const [from, length] of HORN.blasts) {
      const at = start + from;
      // the valve opens: the air comes up to pressure and the note with it, from a little flat; it closes: the
      // pressure falls and the note sags as it dies
      g.setValueAtTime(0, at);
      g.linearRampToValueAtTime(1, at + 0.08);
      g.setValueAtTime(1, at + length - 0.25);
      g.linearRampToValueAtTime(0, at + length);
      bend.setValueAtTime(-60, at);
      bend.linearRampToValueAtTime(0, at + 0.22);
      bend.setValueAtTime(0, at + length - 0.3);
      bend.linearRampToValueAtTime(-90, at + length);
    }
  }

  /**
   * A wheel strikes a rail joint `r` m off, `ago` s back (a bogie's two make the "da-dum"), heard when it has come
   * this far: as the reference has it, a sharp high click (the rail struck, ≈2.6 kHz) over a short low thump (the
   * wheel and the sleeper).
   */
  private clack(v: TrainVoice, r: number, ago: number, pan: number): void {
    const ctx = this.ctx!;
    const at = Math.max(ctx.currentTime, ctx.currentTime - ago + r / SOUND_SPEED);
    const peak = TRAIN_VOICE.clack * Math.min(1, TRAIN_VOICE.clackNear / r);
    const side = ctx.createStereoPanner();
    side.pan.value = pan;
    const air = ctx.createBiquadFilter();
    air.type = 'lowpass';
    air.frequency.value = airCutoff(r);
    air.connect(side).connect(v.bus);
    const part = (type: BiquadFilterType, frequency: number, q: number, level: number, decay: number) => {
      const s = ctx.createBufferSource();
      s.buffer = this.noise;
      s.playbackRate.value = 1.5 + Math.random() * 0.3;
      const body = ctx.createBiquadFilter();
      body.type = type;
      body.frequency.value = frequency * (0.9 + Math.random() * 0.2);
      body.Q.value = q;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(peak * level, at + 0.002);
      g.gain.exponentialRampToValueAtTime(0.0001, at + decay);
      s.connect(body).connect(g).connect(air);
      s.start(at, Math.random() * 3);
      s.stop(at + decay + 0.02);
    };
    part('bandpass', 2600, 0.9, 1, 0.035);
    part('lowpass', 260, 0.7, 0.8, 0.05);
  }

  /**
   * `night`, `wind` (its strength now), `rain` (0..1) where the listener is; `water`: how near the water they
   * are (1 on it or by it, 0 high above it or far off over the fields).
   */
  /**
   * `frogs`: how many frogs the season brings out (0..1, they call at dusk and through the night, and in the rain);
   * `falls`: how near and how full the falling water nearest the listener is (0..1).
   */
  update(dt: number, night: number, wind: number, rain: number, water: number, frogs = 0, falls = 0): void {
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
    // (a rush under the rest, not over it: the user found it drowning the place)
    if (this.falls) this.falls.gain.setTargetAtTime(0.03 * falls, now, 1);
    this.windFilter.frequency.setTargetAtTime(280 + 140 * wind + 260 * Math.sin(now * 0.07) ** 2, now, 2);
    // (none while the browser holds the sound back for a first touch: its clock stands still, and every call made
    // meanwhile would sound at once as it starts)
    if (this.muted || this.hidden || ctx.state !== 'running') return;
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
    // the frogs: a chorus through the rainy nights, a few calls in the rain by day
    this.nextFrog -= dt;
    if (this.nextFrog <= 0) {
      const chorus = frogs * Math.max(night, Math.min(1, rain * 1.5) * 0.5);
      if (chorus > 0.05) this.frog(Math.min(1, chorus));
      this.nextFrog = chorus > 0.05 ? (0.15 + Math.random() * 0.6) / Math.max(0.3, chorus) : 1.5;
    }
  }
}
