import { CORRIDOR } from '../render/glsl';
import type { SpotGroup, SpotIcon } from '../rig/visits';
import { BIL, JOURNEY, KHAL, RIVER, corridorDistance, journeyAt, landUse, terrainHeight, waterLevelAt } from '../world/geography';
import { WORLD } from '../world/plan';
import { roadLines } from '../world/roads';
import './map.css';

// The map (L): the village drawn flat from above as a map is drawn (the waters with their shorelines, the
// fields, the homesteads' groves, the ways, the hills shaded from the north-west), the boat's way dashed along
// its waters, the waters named, the land beyond the village's own faded as the haze has it; the places to see,
// each a badge with its sign; and the boat where she is now. A place, picked on the map or from the list beside
// it, is shown in its own few shots (rig/visits.ts) and the camera comes back to the boat after. A click
// anywhere else on the village's land looks at it from above.

/** Metres a pixel of the painted ground, and how much finer the map is drawn over it (markers, lines, words). */
const M = 4;
const FINE = 2;
/** Rows painted a frame while the map is open (it is painted once, the first time it is opened). */
const ROWS_PER_FRAME = 40;

/** A place offered (rig/visits.ts Spot, without its shots). */
export interface MapSpot {
  id: string;
  name: string;
  note: string;
  icon: SpotIcon;
  group: SpotGroup;
  x: number;
  z: number;
}

/** What the map can ask of the scene. */
export interface MapActions {
  /** Shows a place in its own shots, and comes back to the boat. */
  visit(id: string): void;
  /** Looks at (x, z) from above, from the waters' side of it. */
  fly(x: number, z: number, lookUp: number): void;
}

/** Each place's sign: a path in a 24 × 24 box, filled. */
const ICONS: Record<SpotIcon, string> = {
  mosque: 'M12 2.6c-3.2 1.8-4.9 4.2-4.9 6.9h9.8c0-2.7-1.7-5.1-4.9-6.9zM6.2 10.6h11.6v9.6H6.2zM2.8 7.4h2.2v12.8H2.8zM19 7.4h2.2v12.8H19zM10.8 14.2h2.4v6h-2.4z',
  grave: 'M7.6 19.6V9.2a4.4 4.4 0 0 1 8.8 0v10.4zM4.6 19.8h14.8v2.2H4.6zM11 10.4h2v5.4h-2zM9.4 11.6h5.2v1.6H9.4z',
  manor: 'M12 2.8 2.6 8.4h18.8zM4.6 9.6h2.2v8.6H4.6zM8.8 9.6H11v8.6H8.8zM13 9.6h2.2v8.6H13zM17.2 9.6h2.2v8.6h-2.2zM2.6 19.2h18.8v2.2H2.6z',
  ghat: 'M2.6 5.4h6.2v3.2h3.1v3.1H15v3.1h3.1v3.1h3.3v2H2.6zM2.6 20.4h18.8v1.6H2.6z',
  bridge: 'M1.8 9.4h20.4v3.6h-1.8a8.4 8.4 0 0 0-16.8 0H1.8zM1.8 18.4h20.4v1.8H1.8z',
  sanko: 'M2.2 15.2 12 8.2l9.8 7-1.1 1.6L12 10.6l-8.7 6.2zM5.8 13.4v7.4h1.7v-7.4zM16.5 13.4v7.4h1.7v-7.4zM11.2 10v10.8h1.6V10z',
  lily: 'M12 3.6c1.6 2.2 2.1 4.5 0 7.6-2.1-3.1-1.6-5.4 0-7.6zM4.8 8.6c2.7.2 4.6 1.6 5.9 4.9-3.5.1-5.3-1.6-5.9-4.9zM19.2 8.6c-.6 3.3-2.4 5-5.9 4.9 1.3-3.3 3.2-4.7 5.9-4.9zM3.6 15.6c5.4 2.2 11.4 2.2 16.8 0-1 2.8-4.4 4.4-8.4 4.4s-7.4-1.6-8.4-4.4z',
  kash: 'M11 21.2V9c0-3.1 1.1-5.2 3.2-6.4-1 2.2-1 4.2 0 6.4s1 4.2-2 5.2v7zM5.8 21.2v-8c0-2.1.7-3.8 2.1-4.7-.6 1.7-.6 2.9 0 4.4.6 1.7.2 3.1-1.1 3.8v4.5zM16.2 21.2v-6.2c0-1.7.6-3 1.7-3.8-.4 1.3-.4 2.4 0 3.6.4 1.3 0 2.3-.9 2.8v3.6z',
  salt: 'M1.8 19.2 7.2 10.8l5.4 8.4zM10.4 19.2l5.8-9.4 5.8 9.4zM1.8 20.2h20.4v1.8H1.8z',
  hill: 'M1.6 19.4 8.8 6.6l4.2 6.4 2.2-3.2 7.2 9.6z',
  train: 'M7 2.8h10a3.2 3.2 0 0 1 3.2 3.2v9.2a3.2 3.2 0 0 1-3.2 3.2H7a3.2 3.2 0 0 1-3.2-3.2V6A3.2 3.2 0 0 1 7 2.8zM6 6.8v4.4h12V6.8zM8 13.4a1.4 1.4 0 1 0 0 2.8 1.4 1.4 0 0 0 0-2.8zM16 13.4a1.4 1.4 0 1 0 0 2.8 1.4 1.4 0 0 0 0-2.8zM6.6 19.2 4.4 22h2.2l2.2-2.8zM17.4 19.2l2.2 2.8h-2.2l-2.2-2.8z',
  palm: 'M11 21.6V11.2h2v10.4zM12 10.6C9.2 6.6 5.2 6.4 2.8 8.4c3.2-.4 6.2.2 8.4 3zM12 10.6c2.8-4 6.8-4.2 9.2-2.2-3.2-.4-6.2.2-8.4 3zM12 10.4c-.8-4.2-3.8-6.6-7.2-6.4 3.2 1.2 5.2 3.4 6.2 7zM12 10.4c.8-4.2 3.8-6.6 7.2-6.4-3.2 1.2-5.2 3.4-6.2 7z',
};
/** Each group's colour, its name in the list, and its order. */
const GROUPS: Record<SpotGroup, { color: string; title: string }> = {
  river: { color: '#2f7a82', title: 'নদীর পথে' },
  village: { color: '#a8553a', title: 'গ্রামে' },
  fields: { color: '#71792c', title: 'মাঠে' },
};
const GROUP_ORDER: readonly SpotGroup[] = ['river', 'village', 'fields'];

/** A world point on the map's fine canvas. */
const toMap = (x: number, z: number): [number, number] => [((WORLD.x1 - x) / M) * FINE, ((WORLD.z1 - z) / M) * FINE];

/** The map's colour for the ground at (x, z) (sRGB 0..255), and whether water stands there. */
function paintAt(x: number, z: number, out: number[]): boolean {
  const h = terrainHeight(x, z);
  const w = waterLevelAt(x, z);
  let r: number;
  let g: number;
  let b: number;
  const wet = w > h;
  if (wet) {
    const deep = Math.min(1, (w - h) / 3);
    r = 74 - 30 * deep;
    g = 122 - 40 * deep;
    b = 138 - 26 * deep;
  } else {
    const u = landUse(x, z);
    // fields, the homesteads' groves and yards, verges, the char's sand, the bil's marsh, the salt farms
    r = 150 * u.field + 74 * u.mound + 176 * u.yard + 122 * u.verge + 222 * u.sand + 110 * u.marsh + 168 * u.salt + 150 * u.flats;
    g = 160 * u.field + 106 * u.mound + 156 * u.yard + 146 * u.verge + 206 * u.sand + 136 * u.marsh + 166 * u.salt + 140 * u.flats;
    b = 92 * u.field + 62 * u.mound + 124 * u.yard + 88 * u.verge + 168 * u.sand + 100 * u.marsh + 160 * u.salt + 116 * u.flats;
    const sum = u.field + u.mound + u.yard + u.verge + u.sand + u.marsh + u.salt + u.flats;
    if (sum > 0.01) (r /= sum), (g /= sum), (b /= sum);
    else (r = 130), (g = 150), (b = 90);
    // light from the north-west over the slopes
    const dx = terrainHeight(x + M, z) - h;
    const dz = terrainHeight(x, z + M) - h;
    const shade = Math.max(0.55, Math.min(1.35, 1 + (dx + dz) * 0.2));
    r *= shade;
    g *= shade;
    b *= shade;
  }
  // beyond the village's own land, the haze, a pale parchment
  const fog = 1 - Math.exp(-Math.max(0, corridorDistance(x, z) - CORRIDOR.clear) * CORRIDOR.haze);
  out[0] = r + (214 - r) * fog;
  out[1] = g + (206 - g) * fog;
  out[2] = b + (186 - b) * fog;
  return wet;
}

export class MapPanel {
  private readonly dialog: HTMLDialogElement;
  private readonly base: HTMLCanvasElement;
  private readonly view: HTMLCanvasElement;
  private readonly tip: HTMLElement;
  private readonly spots: { spot: MapSpot; card: HTMLButtonElement; path: Path2D }[] = [];
  private readonly actions: MapActions;
  private painted = 0;
  private hovered = -1;
  private image: ImageData | null = null;
  private water: Uint8Array | null = null;

  constructor(actions: MapActions, spots: readonly MapSpot[]) {
    this.actions = actions;
    const d = (this.dialog = document.createElement('dialog'));
    d.id = 'mapdlg';
    d.setAttribute('aria-label', 'মানচিত্র');
    d.innerHTML = `
      <header class="map-head">
        <img class="map-logo" src="brand/logo.svg" alt="" width="40" height="40" />
        <div class="map-titles">
          <h2>নদীগাঁয়ের মানচিত্র</h2>
          <p>একটা জায়গা বেছে নিন: সেখানকার দৃশ্য দেখে আবার নৌকায় ফিরবেন</p>
        </div>
        <button type="button" class="ibtn close" aria-label="বন্ধ করুন">✕</button>
      </header>
      <div class="map-body">
        <div class="map-frame">
          <canvas class="map-view" aria-label="গ্রামের মানচিত্র"></canvas>
          <div class="map-tip" hidden><b class="tip-name"></b><span class="tip-note"></span><span class="tip-go">দেখুন ▸</span></div>
          <div class="map-compass" aria-hidden="true"><span>উ</span></div>
          <ul class="map-legend" aria-hidden="true">
            <li><i class="lg water"></i>পানি</li>
            <li><i class="lg road"></i>ইটের রাস্তা</li>
            <li><i class="lg path"></i>মেঠো পথ</li>
            <li><i class="lg route"></i>নৌকার পথ</li>
            <li><i class="lg boat"></i>নৌকা এখন</li>
          </ul>
        </div>
        <nav class="map-side" aria-label="জায়গাগুলো"></nav>
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
    this.view.width = this.base.width * FINE;
    this.view.height = this.base.height * FINE;
    this.tip = d.querySelector('.map-tip') as HTMLElement;

    // the list: the places by where they are, each a card with its sign, its name and a line about it
    const side = d.querySelector('.map-side') as HTMLElement;
    for (const group of GROUP_ORDER) {
      const members = spots.filter((s) => s.group === group);
      if (!members.length) continue;
      const section = document.createElement('section');
      section.innerHTML = `<h3><i style="background:${GROUPS[group].color}"></i>${GROUPS[group].title}</h3><ul></ul>`;
      const list = section.querySelector('ul') as HTMLUListElement;
      for (const spot of members) {
        const li = document.createElement('li');
        const card = document.createElement('button');
        card.type = 'button';
        card.className = 'spot-card';
        card.innerHTML = `<span class="spot-badge" style="background:${GROUPS[group].color}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="${ICONS[spot.icon]}"/></svg></span><span class="spot-text"><b></b><small></small></span><span class="spot-go" aria-hidden="true">▸</span>`;
        (card.querySelector('b') as HTMLElement).textContent = spot.name;
        (card.querySelector('small') as HTMLElement).textContent = spot.note;
        card.setAttribute('aria-label', `${spot.name}: দৃশ্যটি দেখুন`);
        const index = this.spots.length;
        card.addEventListener('click', () => this.go(index));
        card.addEventListener('pointerenter', () => this.hover(index));
        card.addEventListener('focus', () => this.hover(index));
        li.appendChild(card);
        list.appendChild(li);
        this.spots.push({ spot, card, path: new Path2D(ICONS[spot.icon]) });
      }
      side.appendChild(section);
    }

    // on the map: a place's badge shows it; elsewhere on the village's land, a look from above
    this.view.addEventListener('pointermove', (e) => this.hover(this.spotAt(e)));
    this.view.addEventListener('pointerleave', () => this.hover(-1));
    this.view.addEventListener('click', (e) => {
      const i = this.spotAt(e);
      if (i >= 0) {
        this.go(i);
        return;
      }
      const p = this.pointOf(e);
      if (!p) return;
      const x = WORLD.x1 - (p.x / FINE) * M;
      const z = WORLD.z1 - (p.y / FINE) * M;
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
    else {
      this.hover(-1);
      this.dialog.showModal();
    }
  }

  close(): void {
    if (this.dialog.open) this.dialog.close();
  }

  /** Goes to a place: the map closes, and its shots begin. */
  private go(index: number): void {
    const s = this.spots[index];
    if (!s) return;
    this.close();
    this.actions.visit(s.spot.id);
  }

  /** The point of the map's canvas under a pointer (its pixels), or null off it. */
  private pointOf(e: MouseEvent): { x: number; y: number } | null {
    // the picture is fitted into its box whole (object-fit: contain), centred, so it may not fill it
    const rect = this.view.getBoundingClientRect();
    const scale = Math.min(rect.width / this.view.width, rect.height / this.view.height);
    const x = (e.clientX - rect.left - (rect.width - this.view.width * scale) / 2) / scale;
    const y = (e.clientY - rect.top - (rect.height - this.view.height * scale) / 2) / scale;
    if (x < 0 || y < 0 || x > this.view.width || y > this.view.height) return null;
    return { x, y };
  }

  /** The place whose badge is under a pointer, or −1. */
  private spotAt(e: MouseEvent): number {
    const p = this.pointOf(e);
    if (!p) return -1;
    let best = -1;
    let bestD = 30;
    this.spots.forEach((s, i) => {
      const [mx, my] = toMap(s.spot.x, s.spot.z);
      const d = Math.hypot(mx - p.x, my - p.y);
      if (d < bestD) (bestD = d), (best = i);
    });
    return best;
  }

  /** Picks out a place: its card in the list, its badge on the map and its card over it. */
  private hover(index: number): void {
    if (index === this.hovered) return;
    this.spots[this.hovered]?.card.classList.remove('on');
    this.hovered = index;
    const s = this.spots[index];
    this.view.style.cursor = s ? 'pointer' : 'crosshair';
    if (!s) {
      this.tip.hidden = true;
      return;
    }
    s.card.classList.add('on');
    (this.tip.querySelector('.tip-name') as HTMLElement).textContent = s.spot.name;
    (this.tip.querySelector('.tip-note') as HTMLElement).textContent = s.spot.note;
    // over its badge, in the frame's own pixels
    const rect = this.view.getBoundingClientRect();
    const frame = (this.view.parentElement as HTMLElement).getBoundingClientRect();
    const scale = Math.min(rect.width / this.view.width, rect.height / this.view.height);
    const [mx, my] = toMap(s.spot.x, s.spot.z);
    const left = rect.left - frame.left + (rect.width - this.view.width * scale) / 2 + mx * scale;
    const top = rect.top - frame.top + (rect.height - this.view.height * scale) / 2 + my * scale;
    this.tip.style.left = `${left}px`;
    this.tip.style.top = `${top}px`;
    this.tip.classList.toggle('below', top < 120);
    this.tip.hidden = false;
  }

  /** Paints a few more rows of the ground (the first time the map is open); its shorelines once all are in. */
  private paint(): void {
    const ctx = this.base.getContext('2d');
    if (!ctx) return;
    const W = this.base.width;
    const H = this.base.height;
    this.image ??= ctx.createImageData(W, H);
    this.water ??= new Uint8Array(W * H);
    const c = [0, 0, 0];
    const to = Math.min(H, this.painted + ROWS_PER_FRAME);
    for (let py = this.painted; py < to; py++) {
      for (let px = 0; px < W; px++) {
        const wet = paintAt(WORLD.x1 - (px + 0.5) * M, WORLD.z1 - (py + 0.5) * M, c);
        const o = (py * W + px) * 4;
        this.water[py * W + px] = wet ? 1 : 0;
        this.image.data[o] = c[0];
        this.image.data[o + 1] = c[1];
        this.image.data[o + 2] = c[2];
        this.image.data[o + 3] = 255;
      }
    }
    this.painted = to;
    if (this.painted >= H) {
      // the shorelines: the water's edge a little lighter, as a map draws it
      const img = this.image.data;
      const w = this.water;
      for (let py = 1; py < H - 1; py++) {
        for (let px = 1; px < W - 1; px++) {
          const i = py * W + px;
          if (!w[i]) continue;
          if (w[i - 1] && w[i + 1] && w[i - W] && w[i + W]) continue;
          img[i * 4] = Math.min(255, img[i * 4] * 0.6 + 214 * 0.4);
          img[i * 4 + 1] = Math.min(255, img[i * 4 + 1] * 0.6 + 226 * 0.4);
          img[i * 4 + 2] = Math.min(255, img[i * 4 + 2] * 0.6 + 222 * 0.4);
        }
      }
    }
    ctx.putImageData(this.image, 0, 0);
  }

  /** The map's lines and words over the ground: the ways, the boat's way, the waters' names. */
  private drawLines(ctx: CanvasRenderingContext2D): void {
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const line of roadLines()) {
      ctx.strokeStyle = line.raised ? 'rgba(186, 104, 78, 0.95)' : 'rgba(236, 222, 186, 0.8)';
      ctx.lineWidth = line.raised ? 3.4 : 1.6;
      ctx.setLineDash(line.raised ? [] : [5, 4]);
      ctx.beginPath();
      line.points.forEach(([x, z], k) => {
        const [px, py] = toMap(x, z);
        if (k === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      });
      ctx.stroke();
    }
    // the boat's way along her waters
    ctx.setLineDash([9, 7]);
    ctx.strokeStyle = 'rgba(255, 214, 128, 0.9)';
    ctx.lineWidth = 2.4;
    ctx.beginPath();
    for (let s = 0; s <= JOURNEY.length; s += 6) {
      const p = journeyAt(s);
      const [px, py] = toMap(p.x, p.z);
      if (s === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.stroke();
    ctx.setLineDash([]);
    // the waters' names, along them
    const word = (text: string, x: number, z: number, angle: number, size: number) => {
      const [px, py] = toMap(x, z);
      ctx.save();
      ctx.translate(px, py);
      ctx.rotate(angle);
      ctx.font = `italic 500 ${size}px "Noto Serif Bengali", serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(28, 46, 52, 0.7)';
      ctx.strokeText(text, 0, 0);
      ctx.fillStyle = 'rgba(226, 240, 236, 0.92)';
      ctx.fillText(text, 0, 0);
      ctx.restore();
    };
    const along = (way: typeof RIVER, share: number) => {
      const p = way.at(way.length * share);
      // the map's right is east (world −x), its down south (world −z): the way's direction on it
      let a = Math.atan2(-Math.cos(p.heading), -Math.sin(p.heading));
      if (a > Math.PI / 2) a -= Math.PI;
      if (a < -Math.PI / 2) a += Math.PI;
      return { x: p.x, z: p.z, a };
    };
    const river = along(RIVER, 0.42);
    word('নদী', river.x, river.z, river.a, 22);
    const khal = along(KHAL, 0.72);
    word('খাল', khal.x, khal.z, khal.a, 18);
    // (south of its badge, over the water)
    word('শাপলা বিল', BIL.x + 10, BIL.z - 70, 0, 22);
  }

  /** While open: the map, the places, and the boat where she is now. */
  update(boatX: number, boatZ: number, course: number, time: number): void {
    if (!this.dialog.open) return;
    if (this.painted < this.base.height || !this.image) this.paint();
    const ctx = this.view.getContext('2d');
    if (!ctx) return;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(this.base, 0, 0, this.view.width, this.view.height);
    if (this.painted >= this.base.height) this.drawLines(ctx);
    // the places: a badge each, in its group's colour, its sign in it; the one picked out larger, ringed in gold
    this.spots.forEach((s, i) => {
      const [px, py] = toMap(s.spot.x, s.spot.z);
      const on = i === this.hovered;
      const r = on ? 19 : 15;
      ctx.save();
      ctx.shadowColor = 'rgba(0, 0, 0, 0.45)';
      ctx.shadowBlur = 8;
      ctx.shadowOffsetY = 2;
      ctx.fillStyle = GROUPS[s.spot.group].color;
      ctx.beginPath();
      ctx.arc(px, py, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      ctx.lineWidth = on ? 3 : 2;
      ctx.strokeStyle = on ? '#ffd27a' : 'rgba(250, 240, 220, 0.95)';
      ctx.beginPath();
      ctx.arc(px, py, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.save();
      const k = (r * 1.25) / 24;
      ctx.translate(px - 12 * k, py - 12 * k);
      ctx.scale(k, k);
      ctx.fillStyle = '#fbf3e2';
      ctx.fill(s.path);
      ctx.restore();
    });
    // the boat: a small boat on her course, a slow ring round her
    const [bx, by] = toMap(boatX, boatZ);
    const pulse = (time % 2.4) / 2.4;
    ctx.strokeStyle = `rgba(255, 210, 122, ${0.75 * (1 - pulse)})`;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(bx, by, 8 + 16 * pulse, 0, Math.PI * 2);
    ctx.stroke();
    ctx.save();
    ctx.translate(bx, by);
    ctx.rotate(Math.atan2(-Math.cos(course), -Math.sin(course)));
    ctx.fillStyle = '#ffd27a';
    ctx.strokeStyle = '#2a1c10';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(13, 0);
    ctx.quadraticCurveTo(4, 6, -11, 4);
    ctx.lineTo(-13, 0);
    ctx.lineTo(-11, -4);
    ctx.quadraticCurveTo(4, -6, 13, 0);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }
}
