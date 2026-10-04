import { COVER, GRID_H, GRID_W, KIND, LAYERS, LINES, PLACES, fcol, frow, type Place } from '../geo/data';
import './map.css';

// The map (GEOGRAPHY_PLAN.md §9): the baked ground drawn flat (sea and its shallows, the flats and the
// mangroves, the land by what covers it, the hills shaded), the main roads, and the places to go. Each place
// offers the ways there: by the boat over the water, on foot (stepping out there through the mist), or seen
// from above. Where the viewer is shows as an arrow while the map is open.

/** The places offered, in the order listed, with what can be done there. */
const OFFERED: readonly { id: string; boat: boolean; walk: boolean }[] = [
  { id: 'gorakghata-jetty-head', boat: true, walk: true },
  { id: 'adinath-jetty-head', boat: true, walk: true },
  { id: 'adinath-temple', boat: false, walk: true },
  { id: 'gorakghata-town', boat: false, walk: true },
  { id: 'arch-bridge', boat: false, walk: true },
  { id: 'kastura-ghat', boat: true, walk: true },
  { id: 'nazirartek', boat: true, walk: true },
  { id: 'wind-farm', boat: false, walk: true },
  { id: 'sonadia-beach', boat: true, walk: true },
  { id: 'shapla-bil', boat: false, walk: true },
  { id: 'kalarmarchhara', boat: false, walk: true },
  { id: 'matarbari-port', boat: true, walk: true },
  { id: 'matarbari-plant', boat: false, walk: true },
  { id: 'matarbari', boat: false, walk: true },
  { id: 'summit-fsru', boat: true, walk: false },
  { id: 'hills-highest', boat: false, walk: true },
];

export interface MapActions {
  sail(place: Place): void;
  walk(place: Place): void;
  fly(place: Place): void;
}

/** sRGB colours of the ground as the map draws it. */
const PAINT: Record<number, readonly [number, number, number]> = {
  [COVER.none]: [124, 140, 85],
  [COVER.tree]: [63, 95, 51],
  [COVER.shrub]: [93, 115, 66],
  [COVER.grass]: [124, 140, 85],
  [COVER.crop]: [142, 162, 90],
  [COVER.built]: [163, 154, 140],
  [COVER.bare]: [163, 143, 114],
  [COVER.sand]: [216, 201, 162],
  [COVER.mud]: [125, 117, 98],
  [COVER.marsh]: [111, 138, 99],
  [COVER.mangrove]: [47, 77, 44],
  [COVER.saltpan]: [201, 198, 189],
  [COVER.pond]: [91, 135, 148],
  [COVER.water]: [79, 122, 131],
};

/** The map as an image: one pixel a cell, hill-shaded, the main roads over it. */
function paintMap(): HTMLCanvasElement {
  const W = GRID_W;
  const H = GRID_H;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;
  const img = ctx.createImageData(W, H);
  const { kind, cover, terrain } = LAYERS;
  for (let r = 0; r < H; r++) {
    for (let c = 0; c < W; c++) {
      const i = r * W + c;
      const k = kind[i] & 0x7f;
      const h = terrain[i] / 10;
      let rgb: readonly [number, number, number];
      if (k === KIND.sea) {
        const deep = Math.min(1, Math.max(0, -h / 14));
        rgb = [79 - 36 * deep, 122 - 48 * deep, 131 - 39 * deep];
      } else if (k === KIND.inland) rgb = PAINT[COVER.pond];
      else if (k === KIND.tidal) rgb = cover[i] === COVER.sand ? PAINT[COVER.sand] : PAINT[COVER.mud];
      else if (k === KIND.mangrove) rgb = PAINT[COVER.mangrove];
      else rgb = PAINT[cover[i]] ?? PAINT[COVER.none];
      // light from the north-west over the hills
      let shade = 1;
      if (k === KIND.land && c > 0 && r > 0 && c < W - 1 && r < H - 1) {
        const dx = (terrain[i + 1] - terrain[i - 1]) / 10;
        const dz = (terrain[i + W] - terrain[i - W]) / 10;
        shade = Math.max(0.55, Math.min(1.35, 1 + (dx * 0.6 - dz * 0.6) * 0.08));
      }
      const o = i * 4;
      img.data[o] = Math.min(255, rgb[0] * shade);
      img.data[o + 1] = Math.min(255, rgb[1] * shade);
      img.data[o + 2] = Math.min(255, rgb[2] * shade);
      img.data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  // the main roads
  ctx.strokeStyle = 'rgba(240, 226, 196, 0.85)';
  ctx.lineWidth = 1.2;
  for (const l of LINES) {
    if (l.k !== 'road' || !/^(trunk|primary|secondary|tertiary)/.test(l.t ?? '')) continue;
    ctx.beginPath();
    for (let k = 0; k < l.points.length; k += 2) {
      const x = fcol(l.points[k]) + 0.5;
      const y = frow(l.points[k + 1]) + 0.5;
      if (k === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  return canvas;
}

export class MapPanel {
  private readonly dialog: HTMLDialogElement;
  private readonly base: HTMLCanvasElement;
  private readonly view: HTMLCanvasElement;
  private readonly list: HTMLUListElement;
  private readonly places: { place: Place; boat: boolean; walk: boolean; item: HTMLLIElement }[] = [];
  private chosen = -1;
  private readonly actions: MapActions;

  constructor(actions: MapActions) {
    this.actions = actions;
    const d = (this.dialog = document.createElement('dialog'));
    d.id = 'mapdlg';
    d.setAttribute('aria-label', 'মানচিত্র');
    d.innerHTML = `
      <h2>মানচিত্র</h2>
      <button type="button" class="ibtn close" aria-label="বন্ধ করুন">✕</button>
      <div class="map-body">
        <div class="map-frame"><canvas class="map-view"></canvas></div>
        <div class="map-side">
          <p class="map-note">কোথায় যাবেন? নৌকায় জলপথ ধরে, কুয়াশা পেরিয়ে সেখানে হেঁটে, বা ওপর থেকে দেখে।</p>
          <ul class="map-list"></ul>
        </div>
      </div>`;
    document.body.appendChild(d);
    d.querySelector('.close')?.addEventListener('click', () => this.close());
    d.addEventListener('cancel', (e) => {
      e.preventDefault();
      this.close();
    });
    this.base = paintMap();
    this.view = d.querySelector('.map-view') as HTMLCanvasElement;
    this.view.width = this.base.width;
    this.view.height = this.base.height;
    this.list = d.querySelector('.map-list') as HTMLUListElement;
    for (const o of OFFERED) {
      const place = PLACES.find((p) => p.id === o.id);
      if (!place) continue;
      const item = document.createElement('li');
      item.innerHTML = `<span class="name"></span><span class="ways"></span>`;
      (item.querySelector('.name') as HTMLElement).textContent = place.name;
      const ways = item.querySelector('.ways') as HTMLElement;
      const button = (label: string, title: string, act: () => void) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'chip';
        b.textContent = label;
        b.title = title;
        b.addEventListener('click', () => {
          this.close();
          act();
        });
        ways.appendChild(b);
      };
      if (o.boat) button('নৌকায়', 'নৌকা জলপথ ধরে সেখানে যাবে', () => this.actions.sail(place));
      if (o.walk) button('হেঁটে', 'কুয়াশা পেরিয়ে সেখানে নেমে হাঁটুন', () => this.actions.walk(place));
      button('ওপর থেকে', 'ওপর থেকে দেখুন', () => this.actions.fly(place));
      const index = this.places.length;
      item.addEventListener('pointerenter', () => this.choose(index));
      this.list.appendChild(item);
      this.places.push({ place, boat: o.boat, walk: o.walk, item });
    }
    // a place's dot on the map picks it in the list
    this.view.addEventListener('click', (e) => {
      const rect = this.view.getBoundingClientRect();
      const x = ((e.clientX - rect.left) / rect.width) * this.view.width;
      const y = ((e.clientY - rect.top) / rect.height) * this.view.height;
      let best = -1;
      let bestD = 40;
      this.places.forEach((p, i) => {
        const d2 = Math.hypot(fcol(p.place.world.x) - x, frow(p.place.world.z) - y);
        if (d2 < bestD) (bestD = d2), (best = i);
      });
      if (best >= 0) {
        this.choose(best);
        this.places[best].item.scrollIntoView({ block: 'nearest' });
      }
    });
  }

  get isOpen(): boolean {
    return this.dialog.open;
  }

  toggle(): void {
    if (this.dialog.open) this.close();
    else this.dialog.showModal();
  }

  close(): void {
    if (this.dialog.open) this.dialog.close();
  }

  private choose(i: number): void {
    if (this.chosen >= 0) this.places[this.chosen]?.item.classList.remove('chosen');
    this.chosen = i;
    this.places[i]?.item.classList.add('chosen');
  }

  /** While open: the map, the places, and an arrow where the viewer is, pointing the way he faces. */
  update(x: number, z: number, heading: number): void {
    if (!this.dialog.open) return;
    const ctx = this.view.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(this.base, 0, 0);
    ctx.font = '22px "Noto Serif Bengali", serif';
    ctx.textBaseline = 'middle';
    this.places.forEach((p, i) => {
      const px = fcol(p.place.world.x) + 0.5;
      const py = frow(p.place.world.z) + 0.5;
      const on = i === this.chosen;
      ctx.fillStyle = on ? '#ffd27a' : '#f4ead2';
      ctx.strokeStyle = 'rgba(20, 16, 12, 0.85)';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(px, py, on ? 9 : 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      if (on) {
        ctx.lineWidth = 5;
        ctx.strokeText(p.place.name, px + 14, py);
        ctx.fillText(p.place.name, px + 14, py);
      }
    });
    // the viewer: the map's +x is east (world −x), its +y south (world −z)
    const vx = fcol(x) + 0.5;
    const vy = frow(z) + 0.5;
    const ax = -Math.sin(heading);
    const ay = -Math.cos(heading);
    ctx.save();
    ctx.translate(vx, vy);
    ctx.rotate(Math.atan2(ay, ax) + Math.PI / 2);
    ctx.fillStyle = '#ff6a3a';
    ctx.strokeStyle = '#1a120c';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(0, -18);
    ctx.lineTo(11, 12);
    ctx.lineTo(0, 6);
    ctx.lineTo(-11, 12);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }
}
