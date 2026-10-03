/** The DOM around the canvas: loader, title card, controls hint, sound toggle, error message. */
export class Hud {
  private readonly load = document.getElementById('load');
  private readonly arc = document.getElementById('load-arc');
  private readonly title = document.getElementById('title');
  private readonly hint = document.getElementById('hint');
  private readonly sound = document.getElementById('sound') as HTMLButtonElement | null;
  private readonly err = document.getElementById('err');
  private readonly captionEl = document.getElementById('caption');
  private readonly film = document.getElementById('film') as HTMLButtonElement | null;
  private hintTimer = 0;

  progress(p: number): void {
    const v = Math.max(0.02, Math.min(1, p));
    if (this.arc) this.arc.style.strokeDashoffset = String(1 - v);
  }

  ready(): void {
    if (this.load) {
      this.load.classList.add('done');
      window.setTimeout(() => this.load?.remove(), 1400);
    }
    this.title?.classList.add('show');
    window.setTimeout(() => this.title?.classList.remove('show'), 6500);
    window.setTimeout(() => this.hint?.classList.add('show'), 1800);
    this.hintTimer = window.setTimeout(() => this.dismissHint(), 16000);
    this.sound?.classList.add('show');
    this.film?.classList.add('show');
  }

  /** `bar` is the lower letterbox bar's height as a fraction of the screen; the caption sits inside it. */
  setCaption(text: string, alpha: number, bar: number): void {
    const el = this.captionEl;
    if (!el) return;
    if (el.textContent !== text) el.textContent = text;
    el.style.opacity = String(alpha * 0.95);
    el.style.bottom = `${(bar * 100) / 2}%`;
  }

  bindFilm(toggle: () => boolean): void {
    this.film?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.setFilm(toggle());
    });
  }

  setFilm(on: boolean): void {
    if (!this.film) return;
    this.film.setAttribute('aria-pressed', String(on));
    this.film.setAttribute('aria-label', on ? 'চলচ্চিত্র থামান' : 'চলচ্চিত্র দেখুন');
    this.film.classList.toggle('on', on);
  }

  dismissHint(): void {
    window.clearTimeout(this.hintTimer);
    this.hint?.classList.remove('show');
  }

  /** `toggle` returns whether sound is now on. */
  bindSound(toggle: () => boolean): void {
    this.sound?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.setSound(toggle());
    });
  }

  setSound(on: boolean): void {
    if (!this.sound) return;
    this.sound.setAttribute('aria-pressed', String(on));
    this.sound.setAttribute('aria-label', on ? 'শব্দ বন্ধ করুন' : 'শব্দ চালু করুন');
    this.sound.classList.toggle('on', on);
  }

  error(message: string): void {
    this.load?.remove();
    if (!this.err) return;
    this.err.textContent = message;
    this.err.hidden = false;
  }
}
