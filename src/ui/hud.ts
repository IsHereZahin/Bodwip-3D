/** The DOM around the canvas: loader, title card, controls hint, film captions, event notices, error message. */
export class Hud {
  private readonly load = document.getElementById('load');
  private readonly arc = document.getElementById('load-arc');
  private readonly title = document.getElementById('title');
  private readonly hint = document.getElementById('hint');
  private readonly err = document.getElementById('err');
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
  }

  /** `bar` is the lower letterbox bar's height as a fraction of the screen; the caption sits inside it. */
  setCaption(text: string, alpha: number, bar: number): void {
    const el = this.captionEl;
    if (!el) return;
    if (el.textContent !== text) el.textContent = text;
    el.style.opacity = String(alpha * 0.95);
    el.style.bottom = `${(bar * 100) / 2}%`;
  }

  dismissHint(): void {
    window.clearTimeout(this.hintTimer);
    this.hint?.classList.remove('show');
  }

  /** Clears the screen for the film: the title card, the hint and any notice go. */
  quiet(): void {
    this.dismissHint();
    this.title?.classList.remove('show');
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
