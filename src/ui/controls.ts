import { Color, Vector3 } from 'three';
import { DEG } from '../core/mathx';
import { SYNODIC_MONTH, sunDirection } from '../env/astro';
import type { Clock, SkyEvent, SkyEventKind } from '../env/clock';
import { skyColorAt } from '../env/environment';
import { SEASON_NAMES, SEASON_STARTS, YEAR, banglaDate, seasonIndex } from '../env/season';
import type { ViewName } from '../rig/rig';
import { EVENT_NAME, MOON_PHASES, bn, clockLabel, nearestPhase, tithiLabel } from './bangla';
import './controls.css';

export type CameraChoice = 'follow' | 'free' | 'film';

/** What the controls ask of the scene. */
export interface ControlHandlers {
  togglePlay(): void;
  /** Steps through the playback speeds, wrapping round. */
  faster(): void;
  seek(hour: number): void;
  /** True while the timeline is being dragged; the clock holds still meanwhile. */
  scrub(active: boolean): void;
  jump(ev: SkyEvent): void;
  /** Back to Bangladesh's own time now. */
  now(): void;
  camera(choice: CameraChoice): void;
  view(name: ViewName): void;
  moon(age: number): void;
  /** A season by index into SEASON_NAMES, or back to the journey's. */
  season(choice: number | 'journey'): void;
  sound(): void;
  /** Opens or closes the map. */
  map(): void;
  /** The film's scene before or after this one. */
  scene(step: -1 | 1): void;
  /** Any use of the controls; it counts as activity, like touching the scene. */
  touched(): void;
}

const VIEW_NAMES: Record<ViewName, string> = {
  stern: 'পেছন থেকে',
  boatman: 'মাঝির পাশে',
  bow: 'সামনে থেকে',
  high: 'উঁচু থেকে',
};

/** Each season's colour on the ring, as the land wears it: summer's amber, the rains' grey-blue, Sharat's kash, Hemanta's paddy, winter's mist, spring's shimul. */
const SEASON_HUES = ['#e0a24a', '#7c9cb8', '#ece4cf', '#d8b257', '#aab6c0', '#cf5a40'];
/** Each season's months, for its line in the menu. */
const SEASON_MONTHS = ['বৈশাখ–জ্যৈষ্ঠ', 'আষাঢ়–শ্রাবণ', 'ভাদ্র–আশ্বিন', 'কার্তিক–অগ্রহায়ণ', 'পৌষ–মাঘ', 'ফাল্গুন–চৈত্র'];

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

/** Where a day of the year stands on the season ring (radians clockwise from its top, Boishakh's start at the top). */
const ringAngle = (day: number) => ((((day - SEASON_STARTS[0]) % YEAR) + YEAR) % YEAR / YEAR) * Math.PI * 2;

/** An arc of the ring from angle `a` to `b` (radians clockwise from its top) at radius `r`. */
function arcPath(a: number, b: number, r: number): string {
  const p = (t: number) => `${(Math.sin(t) * r).toFixed(2)} ${(-Math.cos(t) * r).toFixed(2)}`;
  return `M${p(a)}A${r} ${r} 0 ${b - a > Math.PI ? 1 : 0} 1 ${p(b)}`;
}

const $ = <T extends Element>(selector: string) => document.querySelector(selector) as T;

/** Minutes the timeline moves per key (an hour with Shift or Page keys). */
const STEP_KEYS: Record<string, number> = { ArrowRight: 1, ArrowUp: 1, PageUp: 1, ArrowLeft: -1, ArrowDown: -1, PageDown: -1 };

/**
 * The control dock, a thin pane of glass along the foot of the screen with a running stitch along its top: on
 * the left the year's ring of six seasons (the journey's place in it marked) with the hour, the Bangla date and
 * whether the clock is Bangladesh's own now; in the middle the day's timeline with its sunrise, sunset, moonrise
 * and moonset; on the right the camera, the view, the moon, sound, the map, full screen and the rest. The
 * season, the moon, the view and the rest open as small menus above their buttons. It fades away when the
 * pointer rests and comes back when it moves.
 */
export class Controls {
  private readonly dock = $<HTMLElement>('#dock');
  /** The mark in the corner, up with the dock: the way to the help and the sources. */
  private readonly brand = $<HTMLElement>('#brand');
  private readonly play = $<HTMLButtonElement>('#play');
  private readonly speed = $<HTMLButtonElement>('#speed');
  private readonly live = $<HTMLButtonElement>('#live');
  private readonly range = $<HTMLInputElement>('#tl');
  private readonly sunRow = $<HTMLElement>('#tl-sun');
  private readonly moonRow = $<HTMLElement>('#tl-moon');
  private readonly band = $<HTMLElement>('#tl-band');
  private readonly clock = $<HTMLOutputElement>('#clock');
  private readonly tithi = $<HTMLElement>('#tithi');
  private readonly bdate = $<HTMLElement>('#bdate');
  private readonly cameraButtons = [...document.querySelectorAll<HTMLButtonElement>('#camera button')];
  private readonly seasonBtn = $<HTMLButtonElement>('#season-btn');
  private readonly ringArcs = $<SVGGElement>('#ring-arcs');
  private readonly ringMark = $<SVGCircleElement>('#ring-mark');
  private readonly moonBtn = $<HTMLButtonElement>('#moon-btn');
  private readonly moonLit = $<SVGPathElement>('#moon-lit');
  private readonly seasonItems: HTMLButtonElement[] = [];
  private readonly moonItems: HTMLButtonElement[] = [];
  private readonly sound = $<HTMLButtonElement>('#sound');
  private readonly fullscreen = $<HTMLButtonElement>('#fullscreen');
  private readonly help = $<HTMLDialogElement>('#help');
  private readonly filmNav = $<HTMLElement>('#film-nav');
  private readonly filmCount = $<HTMLElement>('#film-count');
  private readonly pops = [...document.querySelectorAll<HTMLElement>('.pop')];
  /** The button that opened the menu last (a menu opens over whichever of its buttons was used). */
  private invoker: HTMLElement | null = null;
  private readonly handlers: ControlHandlers;

  private shown = false;
  private scrubbing = false;
  private idleTimer = 0;
  private film = false;
  private last = { minute: -1, playing: true, speed: 0, live: false, camera: '', sound: false, sky: -1, phase: -1, moonAge: -1, tithi: '', date: '', season: -1, ring: -1, journey: true, scene: '' };

  constructor(handlers: ControlHandlers) {
    this.handlers = handlers;
    const h = handlers;
    const use = (fn: () => void) => () => {
      h.touched();
      fn();
    };

    this.play.addEventListener('click', use(() => h.togglePlay()));
    this.speed.addEventListener('click', use(() => h.faster()));
    this.live.addEventListener('click', use(() => h.now()));
    this.sound.addEventListener('click', use(() => h.sound()));
    for (const b of this.cameraButtons) b.addEventListener('click', use(() => h.camera(b.dataset.mode as CameraChoice)));

    // the season ring: six arcs, each in its season's colour
    SEASON_STARTS.forEach((start, i) => {
      const a = ringAngle(start) + 0.07;
      const b = ringAngle(SEASON_STARTS[(i + 1) % 6]) - 0.07 + (i === 5 ? 0 : 0);
      const arc = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      arc.setAttribute('d', arcPath(a, b < a ? b + Math.PI * 2 : b, 17));
      arc.setAttribute('stroke', SEASON_HUES[i]);
      arc.classList.add('ring-arc');
      this.ringArcs.append(arc);
    });

    // the menus: the six seasons (or the journey's), the moon's phases, the views
    const seasons = $<HTMLElement>('#season-pop .pop-seasons');
    SEASON_NAMES.forEach((name, i) => {
      const item = this.menuItem(`<i class="dot" style="background:${SEASON_HUES[i]}"></i><span>${name}<small>${SEASON_MONTHS[i]}</small></span>`, 'menuitemradio');
      item.addEventListener('click', use(() => this.pick(() => h.season(i))));
      seasons.append(item);
      this.seasonItems.push(item);
    });
    const journey = $<HTMLButtonElement>('#season-pop .journey');
    journey.addEventListener('click', use(() => this.pick(() => h.season('journey'))));
    this.seasonItems.push(journey);
    const moons = $<HTMLElement>('#moon-pop .pop-moons');
    MOON_PHASES.forEach((p, i) => {
      const item = this.menuItem(`<svg viewBox="-8 -8 16 16" width="18" height="18" aria-hidden="true"><circle class="moon-dark" r="6.6"/><path class="moon-lit" d="${moonPath(p.age, 6.6)}"/></svg><span>${p.name}</span>`, 'menuitemradio');
      item.addEventListener('click', use(() => this.pick(() => h.moon(MOON_PHASES[i].age))));
      moons.append(item);
      this.moonItems.push(item);
    });
    const views = $<HTMLElement>('#views-pop .pop-list');
    for (const [name, label] of Object.entries(VIEW_NAMES)) {
      const item = this.menuItem(`<span>${label}</span>`, 'menuitem');
      item.addEventListener('click', use(() => this.pick(() => h.view(name as ViewName))));
      views.append(item);
    }
    document.addEventListener(
      'click',
      (e) => {
        const by = (e.target as Element | null)?.closest<HTMLElement>('[popovertarget]');
        if (by) this.invoker = by;
      },
      true,
    );
    $<HTMLElement>('#more-pop [data-act="map"]').addEventListener('click', use(() => this.pick(() => handlers.map())));
    for (const pop of this.pops) {
      // opened, it stands over its button, within the screen, and takes the keys
      pop.addEventListener('toggle', (e) => {
        if ((e as ToggleEvent).newState !== 'open') return;
        this.placePop(pop);
        (pop.querySelector<HTMLElement>('[aria-checked="true"]') ?? pop.querySelector<HTMLElement>('button'))?.focus({ preventScroll: true });
        this.wake();
      });
      pop.addEventListener('keydown', (e) => this.menuKeys(pop, e));
    }

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
    $<HTMLElement>('#hide-ui').addEventListener('click', use(() => this.pick(() => this.toggleUi())));
    $<HTMLElement>('#ui-restore').addEventListener('click', use(() => this.toggleUi()));
    $<HTMLElement>('#help-btn').addEventListener('click', use(() => this.pick(() => this.toggleHelp())));
    $<HTMLElement>('#map-btn').addEventListener('click', use(() => handlers.map()));
    this.brand.addEventListener('click', use(() => this.toggleHelp()));
    $<HTMLElement>('#film-prev').addEventListener('click', use(() => handlers.scene(-1)));
    $<HTMLElement>('#film-next').addEventListener('click', use(() => handlers.scene(1)));
    // a click on the dimmed backdrop closes the sheet
    this.help.addEventListener('click', (e) => {
      if (e.target === this.help) this.help.close();
    });

    // the dock wakes on any movement and rests a few seconds after it stops
    const wake = () => this.wake();
    for (const type of ['pointermove', 'pointerdown', 'keydown'] as const) window.addEventListener(type, wake, { passive: true });
    this.dock.addEventListener('focusin', wake);
    this.filmNav.addEventListener('focusin', wake);
  }

  get helpOpen(): boolean {
    return this.help.open;
  }

  show(): void {
    this.shown = true;
    this.dock.classList.add('show');
    this.brand.classList.add('show');
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
    if (off) {
      this.closePops();
      restore.focus({ preventScroll: true });
    } else {
      if (document.activeElement === restore) $<HTMLElement>('#more-btn').focus({ preventScroll: true });
      this.wake();
    }
  }

  toggleFullscreen(): void {
    const request = document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen();
    request.catch((err: unknown) => console.warn('fullscreen:', err));
  }

  /**
   * Mirrors the scene's state (and, while the film plays, which of its scenes is showing; `journey`, whether the
   * season follows the boat's way); touches the page only where something changed.
   */
  update(clock: Clock, camera: CameraChoice, sound: boolean, journey: boolean, scene?: { index: number; count: number }): void {
    const l = this.last;
    const film = camera === 'film' && scene ? `${bn(scene.index + 1)} / ${bn(scene.count)}` : '';
    if (film !== l.scene) {
      l.scene = film;
      this.filmCount.textContent = film;
      this.filmNav.classList.toggle('show', film !== '');
    }
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
      this.speed.setAttribute('aria-label', clock.speed === 1 ? 'সময় চলছে আসল গতিতে; দ্রুত করতে চাপুন' : `সময় চলছে আসলের ${bn(clock.speed)} গুণে; বদলাতে চাপুন`);
    }
    const live = clock.live && camera !== 'film';
    if (live !== l.live) {
      l.live = live;
      this.live.classList.toggle('on', live);
      this.live.setAttribute('aria-pressed', String(live));
      this.live.title = live ? 'বাংলাদেশের এই মুহূর্তের সময় চলছে' : 'বাংলাদেশের এই মুহূর্তের সময়ে ফিরুন (0)';
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
    const date = `${bn(d.date)} ${d.month} · ${SEASON_NAMES[s]}`;
    if (date !== l.date) {
      l.date = date;
      this.bdate.textContent = date;
      this.seasonBtn.setAttribute('aria-label', `ঋতু: ${SEASON_NAMES[s]}; অন্য ঋতু বেছে নিন`);
    }
    // the ring: the season lit, its mark where the year is
    const ring = Math.round(ringAngle(day) * 200);
    if (ring !== l.ring) {
      l.ring = ring;
      const a = ringAngle(day);
      this.ringMark.setAttribute('cx', (Math.sin(a) * 17).toFixed(2));
      this.ringMark.setAttribute('cy', (-Math.cos(a) * 17).toFixed(2));
    }
    if (s !== l.season || journey !== l.journey) {
      l.season = s;
      l.journey = journey;
      this.ringArcs.querySelectorAll('.ring-arc').forEach((arc, i) => arc.classList.toggle('now', i === s));
      this.seasonItems.forEach((item, i) => item.setAttribute('aria-checked', String(i === 6 ? journey : !journey && i === s)));
    }
    const age = clock.moonAge;
    if (Math.abs(age - l.moonAge) > 0.05) {
      l.moonAge = age;
      this.moonLit.setAttribute('d', moonPath(age, 6.6));
      const tithi = tithiLabel(age);
      if (tithi !== l.tithi) {
        l.tithi = tithi;
        this.tithi.textContent = tithi;
        this.moonBtn.setAttribute('aria-label', `চাঁদের কলা: ${tithi}`);
        this.moonBtn.title = `চাঁদ: ${tithi}`;
      }
      const phase = nearestPhase(age);
      if (phase !== l.phase) {
        l.phase = phase;
        this.moonItems.forEach((item, i) => item.setAttribute('aria-checked', String(i === phase)));
      }
    }
  }

  /** A menu's item: a button with its glyph and its words. */
  private menuItem(inner: string, role: 'menuitem' | 'menuitemradio'): HTMLButtonElement {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'pop-item';
    item.setAttribute('role', role);
    item.innerHTML = inner;
    return item;
  }

  /** Does what a menu's item asks, and closes the menu. */
  private pick(fn: () => void): void {
    this.closePops();
    fn();
  }

  private closePops(): void {
    for (const pop of this.pops) if (pop.matches(':popover-open')) pop.hidePopover();
  }

  /** Stands an opened menu over the button that opened it, kept within the screen. */
  private placePop(pop: HTMLElement): void {
    const by = this.invoker?.getAttribute('popovertarget') === pop.id ? this.invoker : document.querySelector<HTMLElement>(`[popovertarget="${pop.id}"]`);
    if (!by) return;
    const r = by.getBoundingClientRect();
    const w = pop.offsetWidth;
    const h = pop.offsetHeight;
    const x = Math.min(Math.max(8, r.left + r.width / 2 - w / 2), innerWidth - w - 8);
    const above = r.top - h - 12;
    pop.style.left = `${x}px`;
    pop.style.top = `${above >= 8 ? above : Math.min(r.bottom + 12, innerHeight - h - 8)}px`;
  }

  /** The arrow keys move through a menu's items; Home and End go to its first and last. */
  private menuKeys(pop: HTMLElement, e: KeyboardEvent): void {
    const items = [...pop.querySelectorAll<HTMLElement>('button')];
    const i = items.indexOf(document.activeElement as HTMLElement);
    let to = -1;
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') to = (i + 1) % items.length;
    else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') to = (i - 1 + items.length) % items.length;
    else if (e.key === 'Home') to = 0;
    else if (e.key === 'End') to = items.length - 1;
    else return;
    e.preventDefault();
    e.stopPropagation();
    items[to]?.focus();
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
    this.brand.classList.remove('idle');
    this.filmNav.classList.remove('idle');
    window.clearTimeout(this.idleTimer);
    this.idleTimer = window.setTimeout(() => this.rest(), this.film ? 2500 : 5000);
  }

  /** Steps aside, unless the pointer is over the dock, a key has focused it, a menu is open, or a drag is under way. */
  private rest(): void {
    const menu = this.pops.some((pop) => pop.matches(':popover-open'));
    if (menu || this.dock.matches(':hover') || this.filmNav.matches(':hover') || this.dock.querySelector(':focus-visible') || this.filmNav.querySelector(':focus-visible') || this.scrubbing || this.helpOpen) this.wake();
    else {
      this.dock.classList.add('idle');
      this.brand.classList.add('idle');
      this.filmNav.classList.add('idle');
    }
  }
}
