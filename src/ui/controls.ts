import { Color, Vector3 } from 'three';
import { DEG } from '../core/mathx';
import { SYNODIC_MONTH, sunDirection } from '../env/astro';
import type { Clock, SkyEvent, SkyEventKind } from '../env/clock';
import { skyColorAt } from '../env/environment';
import { SEASON_NAMES, banglaDate, seasonIndex } from '../env/season';
import type { ViewName } from '../rig/rig';
import { ATTRIBUTION } from '../geo/data';
import { EVENT_NAME, MOON_PHASES, bn, clockLabel, nearestPhase, tithiLabel } from './bangla';
import './controls.css';

export type CameraChoice = 'follow' | 'free' | 'walk' | 'film';

/** The weather menu: by the season, or held clear, breezy, windy, raining or stormy. */
export const WEATHER_PICKS = [
  ['auto', 'ঋতু অনুযায়ী'],
  ['calm', 'পরিষ্কার, শান্ত'],
  ['breeze', 'মৃদু হাওয়া'],
  ['windy', 'জোর হাওয়া'],
  ['drizzle', 'হালকা বৃষ্টি'],
  ['rain', 'বৃষ্টি'],
  ['storm', 'ঝড়'],
] as const;
export type WeatherPick = (typeof WEATHER_PICKS)[number][0];

/** What the controls ask of the scene. */
export interface ControlHandlers {
  togglePlay(): void;
  /** Steps through the playback speeds, wrapping round. */
  faster(): void;
  seek(hour: number): void;
  /** True while the timeline is being dragged; the clock holds still meanwhile. */
  scrub(active: boolean): void;
  jump(ev: SkyEvent): void;
  camera(choice: CameraChoice): void;
  view(name: ViewName): void;
  moon(age: number): void;
  /** A season by index into SEASON_NAMES, or today's date. */
  season(choice: number | 'today'): void;
  weather(choice: WeatherPick): void;
  sound(): void;
  /** Opens or closes the map. */
  map(): void;
  /** Any use of the controls; it counts as activity, like touching the scene. */
  touched(): void;
}

const VIEW_NAMES: Record<ViewName, string> = {
  stern: 'পেছন থেকে',
  boatman: 'মাঝির পাশে',
  bow: 'সামনে থেকে',
  high: 'উঁচু থেকে',
};

// marker glyphs: a half sun or a crescent on the horizon, with an arrow for rising or setting
const HORIZON = '<path d="M2 15h14"/>';
const UP = '<path d="M9 6.2V1.8M6.9 3.9 9 1.8l2.1 2.1"/>';
const DOWN = '<path d="M9 1.8v4.4M6.9 4.1 9 6.2l2.1-2.1"/>';
const SUN = '<path d="M5.4 15a3.6 3.6 0 0 1 7.2 0z" fill="currentColor"/>';
const MOON = '<path d="M10.8 7.7A3.5 3.5 0 1 0 10.8 13.7A3.2 3.2 0 0 1 10.8 7.7Z" fill="currentColor" stroke="none"/>';
const svg = (body: string) =>
  `<svg viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const EVENT_ICON: Record<SkyEventKind, string> = {
  sunrise: svg(HORIZON + SUN + UP),
  sunset: svg(HORIZON + SUN + DOWN),
  moonrise: svg(HORIZON + MOON + UP),
  moonset: svg(HORIZON + MOON + DOWN),
};

/** The lit part of a moon of this age, as seen from the north: an SVG path in a circle of radius `r`. */
function moonPath(age: number, r: number): string {
  const phi = (age / SYNODIC_MONTH) * Math.PI * 2;
  const rx = Math.abs(Math.cos(phi)) * r;
  const waxing = phi < Math.PI;
  const crescent = Math.cos(phi) > 0;
  const limb = waxing ? 1 : 0;
  const terminator = waxing === crescent ? 0 : 1;
  return `M0 ${-r}A${r} ${r} 0 0 ${limb} 0 ${r}A${rx.toFixed(2)} ${r} 0 0 ${terminator} 0 ${-r}Z`;
}

const $ = <T extends Element>(selector: string) => document.querySelector(selector) as T;

/** Minutes the timeline moves per key (an hour with Shift or Page keys). */
const STEP_KEYS: Record<string, number> = { ArrowRight: 1, ArrowUp: 1, PageUp: 1, ArrowLeft: -1, ArrowDown: -1, PageDown: -1 };

/**
 * The control dock: play/pause and speed, a 24-hour timeline marked with the day's sunrise, sunset,
 * moonrise and moonset, the camera mode, viewpoints, the moon's phase, sound, full screen, hiding the
 * interface and the help sheet. It fades away when the pointer rests and comes back when it moves.
 */
export class Controls {
  private readonly dock = $<HTMLElement>('#dock');
  private readonly play = $<HTMLButtonElement>('#play');
  private readonly speed = $<HTMLButtonElement>('#speed');
  private readonly range = $<HTMLInputElement>('#tl');
  private readonly sunRow = $<HTMLElement>('#tl-sun');
  private readonly moonRow = $<HTMLElement>('#tl-moon');
  private readonly band = $<HTMLElement>('#tl-band');
  private readonly clock = $<HTMLOutputElement>('#clock');
  private readonly tithi = $<HTMLElement>('#tithi');
  private readonly cameraButtons = [...document.querySelectorAll<HTMLButtonElement>('#camera button')];
  private readonly views = $<HTMLSelectElement>('#views');
  private readonly moon = $<HTMLSelectElement>('#moon');
  private readonly moonLit = $<SVGPathElement>('#moon-lit');
  private readonly season = $<HTMLSelectElement>('#season');
  private readonly weather = $<HTMLSelectElement>('#weather');
  private readonly bdate = $<HTMLElement>('#bdate');
  private readonly sound = $<HTMLButtonElement>('#sound');
  private readonly fullscreen = $<HTMLButtonElement>('#fullscreen');
  private readonly help = $<HTMLDialogElement>('#help');
  private readonly handlers: ControlHandlers;

  private shown = false;
  private scrubbing = false;
  private idleTimer = 0;
  private film = false;
  private last = { minute: -1, playing: true, speed: 0, camera: '', sound: false, sky: -1, phase: -1, moonAge: -1, tithi: '', date: '', season: -1 };

  constructor(handlers: ControlHandlers) {
    this.handlers = handlers;
    const h = handlers;
    const use = (fn: () => void) => () => {
      h.touched();
      fn();
    };

    this.play.addEventListener('click', use(() => h.togglePlay()));
    this.speed.addEventListener('click', use(() => h.faster()));
    this.sound.addEventListener('click', use(() => h.sound()));
    for (const b of this.cameraButtons) b.addEventListener('click', use(() => h.camera(b.dataset.mode as CameraChoice)));

    for (const [name, label] of Object.entries(VIEW_NAMES)) this.views.add(new Option(label, name));
    this.views.addEventListener(
      'change',
      use(() => {
        h.view(this.views.value as ViewName);
        // the list is a menu of jumps: it always reads "দৃশ্য", so the same view can be picked again
        this.views.selectedIndex = 0;
      }),
    );
    MOON_PHASES.forEach((p, i) => this.moon.add(new Option(p.name, String(i))));
    this.moon.addEventListener('change', use(() => h.moon(MOON_PHASES[Number(this.moon.value)].age)));
    // the season shows itself; the menu jumps to the middle of another, or back to today's date
    SEASON_NAMES.forEach((name, i) => this.season.add(new Option(name, String(i))));
    this.season.add(new Option('আজকের তারিখ', 'today'));
    this.season.addEventListener('change', use(() => h.season(this.season.value === 'today' ? 'today' : Number(this.season.value))));
    for (const [value, label] of WEATHER_PICKS) this.weather.add(new Option(label, value));
    this.weather.addEventListener('change', use(() => h.weather(this.weather.value as WeatherPick)));

    // the timeline: drag or click to set the time; the arrow keys step ten minutes, an hour with Shift
    this.paintDay();
    this.range.addEventListener('input', use(() => h.seek(Number(this.range.value) / 60)));
    this.range.addEventListener('pointerdown', () => this.setScrub(true));
    for (const type of ['pointerup', 'pointercancel', 'blur'] as const) window.addEventListener(type, () => this.setScrub(false));
    this.range.addEventListener('keydown', (e) => {
      const big = e.shiftKey || e.code.startsWith('Page');
      const step = STEP_KEYS[e.code];
      let minute = Number(this.range.value);
      if (step) minute += step * (big ? 60 : 10);
      else if (e.code === 'Home') minute = 0;
      else if (e.code === 'End') minute = 1439;
      else return;
      e.preventDefault();
      h.touched();
      this.range.value = String(Math.min(Math.max(minute, 0), 1439));
      h.seek(Number(this.range.value) / 60);
    });

    if (!document.fullscreenEnabled) this.fullscreen.hidden = true;
    this.fullscreen.addEventListener('click', use(() => this.toggleFullscreen()));
    document.addEventListener('fullscreenchange', () => {
      const on = document.fullscreenElement !== null;
      this.fullscreen.setAttribute('aria-pressed', String(on));
      this.fullscreen.setAttribute('aria-label', on ? 'পূর্ণ পর্দা থেকে বেরোন' : 'পূর্ণ পর্দা');
    });
    $<HTMLElement>('#hide-ui').addEventListener('click', use(() => this.toggleUi()));
    $<HTMLElement>('#ui-restore').addEventListener('click', use(() => this.toggleUi()));
    $<HTMLElement>('#map-btn').addEventListener('click', use(() => h.map()));
    $<HTMLElement>('#help-btn').addEventListener('click', use(() => this.toggleHelp()));
    // the data the map is made from, credited as each source asks (OpenStreetMap's with its copyright page)
    const sources = $<HTMLUListElement>('#sources');
    for (const text of ATTRIBUTION) {
      const item = document.createElement('li');
      item.textContent = text;
      if (text.includes('OpenStreetMap')) {
        const link = document.createElement('a');
        link.href = 'https://www.openstreetmap.org/copyright';
        link.target = '_blank';
        link.rel = 'noopener';
        link.textContent = 'openstreetmap.org/copyright';
        item.append(' (', link, ')');
      }
      sources.appendChild(item);
    }
    // a click on the dimmed backdrop closes the sheet
    this.help.addEventListener('click', (e) => {
      if (e.target === this.help) this.help.close();
    });

    // the dock wakes on any movement and rests a few seconds after it stops
    const wake = () => this.wake();
    for (const type of ['pointermove', 'pointerdown', 'keydown'] as const) window.addEventListener(type, wake, { passive: true });
    this.dock.addEventListener('focusin', wake);
  }

  get helpOpen(): boolean {
    return this.help.open;
  }

  show(): void {
    this.shown = true;
    this.dock.classList.add('show');
    this.wake();
  }

  toggleHelp(): void {
    if (this.help.open) this.help.close();
    else this.help.showModal();
  }

  toggleUi(): void {
    const restore = $<HTMLElement>('#ui-restore');
    const off = document.body.classList.toggle('ui-off');
    // keep keyboard focus on something that can be seen
    if (off) restore.focus({ preventScroll: true });
    else {
      if (document.activeElement === restore) $<HTMLElement>('#hide-ui').focus({ preventScroll: true });
      this.wake();
    }
  }

  toggleFullscreen(): void {
    const request = document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen();
    request.catch((err: unknown) => console.warn('fullscreen:', err));
  }

  /** Mirrors the scene's state; touches the page only where something changed. `tide`: the tide in words. */
  update(clock: Clock, camera: CameraChoice, sound: boolean, tide: string): void {
    const l = this.last;
    const minute = Math.floor(clock.hour * 60);
    if (minute !== l.minute) {
      l.minute = minute;
      const label = clockLabel(clock.hour);
      this.clock.value = label;
      if (!this.scrubbing) this.range.value = String(minute);
      this.range.setAttribute('aria-valuetext', label);
    }
    if (clock.playing !== l.playing) {
      l.playing = clock.playing;
      this.play.classList.toggle('paused', !clock.playing);
      this.play.setAttribute('aria-label', clock.playing ? 'সময় থামান' : 'সময় চালান');
    }
    if (clock.speed !== l.speed) {
      l.speed = clock.speed;
      this.speed.textContent = `${bn(clock.speed)}×`;
      this.speed.setAttribute('aria-label', `সময়ের গতি ${bn(clock.speed)} গুণ; বাড়াতে চাপুন`);
    }
    if (camera !== l.camera) {
      l.camera = camera;
      for (const b of this.cameraButtons) b.setAttribute('aria-pressed', String(b.dataset.mode === camera));
      this.film = camera === 'film';
      this.wake();
    }
    if (sound !== l.sound) {
      l.sound = sound;
      this.sound.setAttribute('aria-pressed', String(sound));
      this.sound.setAttribute('aria-label', sound ? 'শব্দ বন্ধ করুন' : 'শব্দ চালু করুন');
    }
    if (clock.revision !== l.sky) {
      l.sky = clock.revision;
      // the sun's path changes with the day of the year
      this.paintSky();
      this.markDay(clock);
    }
    const day = clock.dayOfYear;
    const s = seasonIndex(day);
    const d = banglaDate(day);
    const date = `${bn(d.date)} ${d.month} · ${SEASON_NAMES[s]} · ${tide}`;
    if (date !== l.date) {
      l.date = date;
      this.bdate.textContent = date;
    }
    if (s !== l.season && document.activeElement !== this.season) {
      l.season = s;
      this.season.value = String(s);
    }
    const age = clock.moonAge;
    if (Math.abs(age - l.moonAge) > 0.05) {
      l.moonAge = age;
      this.moonLit.setAttribute('d', moonPath(age, 7));
      const tithi = tithiLabel(age);
      if (tithi !== l.tithi) {
        l.tithi = tithi;
        this.tithi.textContent = tithi;
      }
      const phase = nearestPhase(age);
      if (phase !== l.phase && document.activeElement !== this.moon) {
        l.phase = phase;
        this.moon.value = String(phase);
      }
    }
  }

  /** Shows a weather choice made elsewhere (by a key). */
  showWeather(choice: WeatherPick): void {
    this.weather.value = choice;
  }

  /** Paints the bar with the colour of the sky through one day (the day's own sun path), and its hour ticks. */
  private paintDay(): void {
    this.paintSky();
    const track = $<HTMLElement>('#tl-track');
    for (const hour of [6, 12, 18]) {
      const tick = document.createElement('span');
      tick.className = 'tl-tick';
      tick.style.left = `${(hour / 24) * 100}%`;
      track.prepend(tick);
    }
  }

  /** The bar's colours: the sky through the day, as the sun crosses it on this day of the year. */
  private paintSky(): void {
    const c = new Color();
    const dir = new Vector3();
    const stops: string[] = [];
    for (let i = 0; i <= 48; i++) {
      const elev = Math.asin(sunDirection(i / 2, dir).y) / DEG;
      stops.push(`#${skyColorAt(elev, c).getHexString()} ${((i / 48) * 100).toFixed(2)}%`);
    }
    $<HTMLElement>('#tl-track').style.background = `linear-gradient(90deg, ${stops.join(', ')})`;
  }

  /** Marks today's sunrise, sunset, moonrise and moonset, and the hours the moon is up. */
  private markDay(clock: Clock): void {
    this.sunRow.replaceChildren();
    this.moonRow.replaceChildren();
    this.band.replaceChildren();
    for (const ev of clock.today()) {
      const hour = (ev.time - clock.day) * 24;
      const label = `${EVENT_NAME[ev.kind]} · ${clockLabel(hour)}`;
      const mark = document.createElement('button');
      mark.type = 'button';
      mark.className = `tl-mark ${ev.kind}`;
      mark.style.left = `${(hour / 24) * 100}%`;
      mark.title = label;
      mark.setAttribute('aria-label', `${label}: দেখতে চাপুন`);
      mark.innerHTML = EVENT_ICON[ev.kind];
      mark.addEventListener('click', () => {
        this.handlers.touched();
        this.handlers.jump(ev);
      });
      (ev.kind === 'sunrise' || ev.kind === 'sunset' ? this.sunRow : this.moonRow).append(mark);
    }
    for (const [from, to] of clock.moonSpans()) {
      const span = document.createElement('span');
      span.style.left = `${(from / 24) * 100}%`;
      span.style.width = `${((to - from) / 24) * 100}%`;
      span.title = 'চাঁদ আকাশে';
      this.band.append(span);
    }
  }

  private setScrub(active: boolean): void {
    if (active === this.scrubbing) return;
    this.scrubbing = active;
    this.handlers.scrub(active);
  }

  private wake(): void {
    if (!this.shown) return;
    this.dock.classList.remove('idle');
    window.clearTimeout(this.idleTimer);
    this.idleTimer = window.setTimeout(() => this.rest(), this.film ? 2500 : 5000);
  }

  /** Steps aside, unless the pointer is over the dock, a key has focused it, or a drag is under way. */
  private rest(): void {
    if (this.dock.matches(':hover') || this.dock.querySelector(':focus-visible') || this.scrubbing || this.helpOpen) this.wake();
    else this.dock.classList.add('idle');
  }
}
