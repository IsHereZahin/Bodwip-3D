import { CORRIDOR } from '../render/glsl';
import { BIL, BRIDGE, JOURNEY, SANKO, corridorDistance, journeyAt, landUse, terrainHeight, waterLevelAt } from '../world/geography';
import { BANYAN, CHAR, HILLS, MOSQUE, WORLD, ZAMINDAR } from '../world/plan';
import { roadLines } from '../world/roads';
import { railAt, RAIL_LENGTH } from '../world/railway';
import './map.css';

// The map (L): the village drawn flat from above (the waters, the fields, the homesteads' groves, the ways and
// the hills, shaded), the land beyond the village's own faded as the haze has it, and the places to go: each can
// be seen from above, and those on the boat's way reached by the boat. A click anywhere on the village's land
// goes there too. The viewer shows as an arrow while the map is open.

/** Metres a pixel of the map. */
const M = 4;
/** Rows painted a frame while the map is open (it is painted once, the first time it is opened). */
const ROWS_PER_FRAME = 40;

/** A place to go: where it is, what to look at there (m above its ground), and where the boat goes for it (m along her way), if she can. */
export interface MapPlace {
  name: string;
  x: number;
  z: number;
  lookUp: number;
  boat: number | null;
}

/** What the map can ask of the scene. */
export interface MapActions {
  /** Looks at (x, z) from above, from the waters' side of it. */
  fly(x: number, z: number, lookUp: number): void;
  /** Puts the boat `s` m along her way, and the camera behind her. */
  sail(s: number): void;
}

/** The boat's way's nearest point to (x, z) (m along it). */
function nearestOnWay(x: number, z: number): number {
  let best = 0;
  let bd = Infinity;
  for (let s = 0; s <= JOURNEY.length; s += 5) {
    const p = journeyAt(s);
    const d = (p.x - x) ** 2 + (p.z - z) ** 2;
    if (d < bd) (bd = d), (best = s);
  }
  return best;
}

/** The places offered, in the order of the boat's journey. */
function places(): MapPlace[] {
  const hill = (i: number) => ({ x: HILLS[i].x, z: HILLS[i].z });
  const rail = railAt(Math.min(RAIL_LENGTH, (() => {
    let best = 0;
    for (let s = 0; s <= RAIL_LENGTH; s += 8) if (Math.abs(railAt(s).x - BIL.x) < Math.abs(railAt(best).x - BIL.x)) best = s;
    return best;
  })()));
  const list: { name: string; at: { x: number; z: number }; lookUp: number; boat: boolean }[] = [
    { name: 'যাত্রার শুরু', at: journeyAt(40), lookUp: 2, boat: true },
    { name: 'নদীর ধারের পাহাড়', at: hill(0), lookUp: 30, boat: true },
    { name: 'চরের কাশবন', at: { x: CHAR.x, z: CHAR.z }, lookUp: 2, boat: true },
    { name: 'চরের পেছনের পাহাড়', at: hill(2), lookUp: 20, boat: true },
    { name: 'জমিদারবাড়ি', at: ZAMINDAR, lookUp: 6, boat: true },
    { name: 'বটতলার ঘাট', at: BANYAN, lookUp: 5, boat: true },
    { name: 'পুরোনো সেতু', at: BRIDGE, lookUp: 3, boat: true },
    { name: 'মসজিদ', at: MOSQUE, lookUp: 4, boat: false },
    { name: 'বাঁশের সাঁকো', at: SANKO, lookUp: 2, boat: false },
    { name: 'শাপলা বিল', at: BIL, lookUp: 1, boat: true },
    { name: 'বিলের পাহাড়', at: hill(1), lookUp: 28, boat: true },
    { name: 'রেললাইন', at: rail, lookUp: 4, boat: false },
  ];
  return list.map((p) => ({ name: p.name, x: p.at.x, z: p.at.z, lookUp: p.lookUp, boat: p.boat ? nearestOnWay(p.at.x, p.at.z) : null }));
}

/** The map's colour for a place (sRGB 0..255). */
function paintAt(x: number, z: number, out: number[]): void {
  const h = terrainHeight(x, z);
  const w = waterLevelAt(x, z);
  let r: number;
  let g: number;
  let b: number;
  if (w > h) {
    const deep = Math.min(1, (w - h) / 3);
    r = 70 - 26 * deep;
    g = 112 - 36 * deep;
    b = 128 - 24 * deep;
  } else {
    const u = landUse(x, z);
    // fields, the homesteads' groves and yards, verges, the char's sand, the bil's marsh
    r = 128 * u.field + 70 * u.mound + 168 * u.yard + 112 * u.verge + 214 * u.sand + 104 * u.marsh;
    g = 152 * u.field + 102 * u.mound + 150 * u.yard + 138 * u.verge + 198 * u.sand + 130 * u.marsh;
    b = 80 * u.field + 58 * u.mound + 118 * u.yard + 80 * u.verge + 160 * u.sand + 96 * u.marsh;
    const sum = u.field + u.mound + u.yard + u.verge + u.sand + u.marsh;
    if (sum > 0.01) (r /= sum), (g /= sum), (b /= sum);
    else (r = 120), (g = 146), (b = 82);
    // light from the north-west over the slopes
    const dx = terrainHeight(x + M, z) - h;
    const dz = terrainHeight(x, z + M) - h;
    const shade = Math.max(0.5, Math.min(1.4, 1 + (dx + dz) * 0.18));
    r *= shade;
    g *= shade;
    b *= shade;
  }
  // beyond the village's own land, the haze
  const fog = 1 - Math.exp(-Math.max(0, corridorDistance(x, z) - CORRIDOR.clear) * CORRIDOR.haze);
  out[0] = r + (206 - r) * fog;
  out[1] = g + (210 - g) * fog;
  out[2] = b + (212 - b) * fog;
}

export class MapPanel {
  private readonly dialog: HTMLDialogElement;
  private readonly base: HTMLCanvasElement;
  private readonly view: HTMLCanvasElement;
  private readonly places: { place: MapPlace; item: HTMLLIElement }[] = [];
  private readonly actions: MapActions;
  private painted = 0;
  private chosen = -1;
  private image: ImageData | null = null;

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
          <p class="map-note">কোথায় যাবেন? ওপর থেকে দেখুন, বা নৌকা নিয়ে যান। মানচিত্রে গ্রামের যেকোনো জায়গায় ক্লিক করলেও সেখানে যাবেন।</p>
          <ul class="map-list"></ul>
        </div>
      </div>`;
    document.body.appendChild(d);
    d.querySelector('.close')?.addEventListener('click', () => this.close());
    d.addEventListener('click', (e) => {
      if (e.target === d) this.close();
    });
    this.base = document.createElement('canvas');
    this.base.width = Math.round((WORLD.x1 - WORLD.x0) / M);
    this.base.height = Math.round((WORLD.z1 - WORLD.z0) / M);
    this.view = d.querySelector('.map-view') as HTMLCanvasElement;
    this.view.width = this.base.width;
    this.view.height = this.base.height;
    const list = d.querySelector('.map-list') as HTMLUListElement;
    for (const place of places()) {
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
      button('ওপর থেকে', 'ওপর থেকে দেখুন', () => this.actions.fly(place.x, place.z, place.lookUp));
      const s = place.boat;
      if (s !== null) button('নৌকায়', 'নৌকা নিয়ে সেখানে যান', () => this.actions.sail(s));
      const index = this.places.length;
      item.addEventListener('pointerenter', () => (this.chosen = index));
      list.appendChild(item);
      this.places.push({ place, item });
    }
    // a click on the map: a place's dot picks it; elsewhere on the village's land, go there
    this.view.addEventListener('click', (e) => {
      const rect = this.view.getBoundingClientRect();
      const px = ((e.clientX - rect.left) / rect.width) * this.view.width;
      const py = ((e.clientY - rect.top) / rect.height) * this.view.height;
      const x = WORLD.x1 - px * M;
      const z = WORLD.z1 - py * M;
      let best = -1;
      let bestD = 14;
      this.places.forEach((p, i) => {
        const d2 = Math.hypot((WORLD.x1 - p.place.x) / M - px, (WORLD.z1 - p.place.z) / M - py);
        if (d2 < bestD) (bestD = d2), (best = i);
      });
      if (best >= 0) {
        this.chosen = best;
        this.places[best].item.scrollIntoView({ block: 'nearest' });
        this.places[best].item.querySelector<HTMLButtonElement>('.chip')?.focus();
        return;
      }
      if (corridorDistance(x, z) > CORRIDOR.clear) return;
      this.close();
      this.actions.fly(x, z, 2);
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

  /** Paints a few more rows of the map (the first time it is open). */
  private paint(): void {
    const ctx = this.base.getContext('2d');
    if (!ctx) return;
    const W = this.base.width;
    const H = this.base.height;
    this.image ??= ctx.createImageData(W, H);
    const c = [0, 0, 0];
    const to = Math.min(H, this.painted + ROWS_PER_FRAME);
    for (let py = this.painted; py < to; py++) {
      for (let px = 0; px < W; px++) {
        paintAt(WORLD.x1 - (px + 0.5) * M, WORLD.z1 - (py + 0.5) * M, c);
        const o = (py * W + px) * 4;
        this.image.data[o] = c[0];
        this.image.data[o + 1] = c[1];
        this.image.data[o + 2] = c[2];
        this.image.data[o + 3] = 255;
      }
    }
    this.painted = to;
    ctx.putImageData(this.image, 0, 0);
    if (this.painted < H) return;
    // the ways over the ground: the brick road and the paths
    for (const line of roadLines()) {
      ctx.strokeStyle = line.raised ? 'rgba(190, 120, 92, 0.95)' : 'rgba(222, 202, 160, 0.75)';
      ctx.lineWidth = line.raised ? 2.2 : 1;
      ctx.beginPath();
      line.points.forEach(([x, z], k) => {
        const px = (WORLD.x1 - x) / M;
        const py = (WORLD.z1 - z) / M;
        if (k === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      });
      ctx.stroke();
    }
  }

  /** While open: the map, the places, and an arrow where the viewer is, pointing the way they face. */
  update(x: number, z: number, heading: number): void {
    if (!this.dialog.open) return;
    if (this.painted < this.base.height || !this.image) this.paint();
    const ctx = this.view.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(this.base, 0, 0);
    ctx.font = '15px "Noto Serif Bengali", serif';
    ctx.textBaseline = 'middle';
    this.places.forEach((p, i) => {
      const px = (WORLD.x1 - p.place.x) / M;
      const py = (WORLD.z1 - p.place.z) / M;
      const on = i === this.chosen;
      ctx.fillStyle = on ? '#ffd27a' : '#f4ead2';
      ctx.strokeStyle = 'rgba(20, 16, 12, 0.85)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(px, py, on ? 6 : 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      if (on) {
        ctx.lineWidth = 4;
        ctx.strokeText(p.place.name, px + 9, py);
        ctx.fillText(p.place.name, px + 9, py);
      }
    });
    // the viewer: the map's right is east (world −x), its down south (world −z)
    const vx = (WORLD.x1 - x) / M;
    const vy = (WORLD.z1 - z) / M;
    ctx.save();
    ctx.translate(vx, vy);
    ctx.rotate(Math.atan2(-Math.cos(heading), -Math.sin(heading)) + Math.PI / 2);
    ctx.fillStyle = '#ff6a3a';
    ctx.strokeStyle = '#1a120c';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, -12);
    ctx.lineTo(7, 8);
    ctx.lineTo(0, 4);
    ctx.lineTo(-7, 8);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }
}
