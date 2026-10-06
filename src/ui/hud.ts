/** The DOM around the canvas: the loader and its mark, the controls hint, film captions, event notices, error message. */
export class Hud {
  private readonly load = document.getElementById('load');
  private readonly loadNow = document.getElementById('load-now');
  private readonly hint = document.getElementById('hint');
  private readonly err = document.getElementById('err');
  /** The caption's style as last written. */
  private captionOpacity = '';
  private captionBottom = '';
  private readonly captionEl = document.getElementById('caption');
  private readonly toastEl = document.getElementById('toast');
  private readonly toastText = document.getElementById('toast-text');
  private readonly toastLook = document.getElementById('toast-look') as HTMLButtonElement | null;
  private hintTimer = 0;
  private toastTimer = 0;
  private onLook: (() => void) | null = null;

  constructor() {
    this.toastLook?.addEventListener('click', () => {
      this.onLook?.();
      this.onLook = null;
      if (this.toastLook) this.toastLook.hidden = true;
    });
  }

  /** How far the world is built (0..1): the mark's red sun rises out of the river with it. */
  progress(p: number): void {
    this.load?.style.setProperty('--rise', Math.max(0.05, Math.min(1, p)).toFixed(3));
  }

  /** The loader's line under the river: the season, the Bangla date and the hour in Bangladesh now. */
  now(season: string, date: string, time: string): void {
    if (!this.loadNow) return;
    this.loadNow.replaceChildren(Object.assign(document.createElement('b'), { textContent: season }), ` · ${date} · ${time}`);
  }

  /** The world is built: the still gives way to the opening flight; the mark stays over it `titleSeconds`, then goes. */
  ready(titleSeconds: number): void {
    this.load?.classList.add('done');
    window.setTimeout(() => this.lift(), Math.max(0, titleSeconds - 2.8) * 1000);
  }

  /** The mark fades off the screen and the loader is gone. */
  private lift(): void {
    if (!this.load || this.load.classList.contains('gone')) return;
    this.load.classList.add('gone');
    window.setTimeout(() => this.load?.remove(), 3000);
  }

  /** The opening flight has come down to the boat: the controls' hint shows for a while. */
  hintNow(): void {
    this.hint?.classList.add('show');
    window.clearTimeout(this.hintTimer);
    this.hintTimer = window.setTimeout(() => this.dismissHint(), 14000);
  }

  /** `bar` is the lower letterbox bar's height as a fraction of the screen; the caption sits inside it. */
  setCaption(text: string, alpha: number, bar: number): void {
    const el = this.captionEl;
    if (!el) return;
    if (el.textContent !== text) el.textContent = text;
    // (written only when they change: every frame else)
    const opacity = (alpha * 0.95).toFixed(3);
    const bottom = `${((bar * 100) / 2).toFixed(2)}%`;
    if (opacity !== this.captionOpacity) el.style.opacity = this.captionOpacity = opacity;
    if (bottom !== this.captionBottom) el.style.bottom = this.captionBottom = bottom;
  }

  dismissHint(): void {
    window.clearTimeout(this.hintTimer);
    this.hint?.classList.remove('show');
  }

  /** Clears the screen for the film: the title card, the hint and any notice go. */
  quiet(): void {
    this.dismissHint();
    this.lift();
    window.clearTimeout(this.toastTimer);
    this.toastEl?.classList.remove('show');
    this.onLook = null;
  }

  /** A short notice at the top of the screen. `look`, when given, adds a button that acts on it. */
  toast(text: string, look: (() => void) | null): void {
    if (!this.toastEl || !this.toastText || !this.toastLook) return;
    this.dismissHint();
    this.toastText.textContent = text;
    this.onLook = look;
    this.toastLook.hidden = !look;
    this.toastEl.classList.add('show');
    window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => {
      this.toastEl?.classList.remove('show');
      this.onLook = null;
    }, 7000);
  }

  error(message: string): void {
    this.load?.remove();
    if (!this.err) return;
    this.err.textContent = message;
    this.err.hidden = false;
  }
}
