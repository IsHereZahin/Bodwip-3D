import {
  ClampToEdgeWrapping,
  DataTexture,
  LinearFilter,
  LinearMipmapLinearFilter,
  NoColorSpace,
  RepeatWrapping,
  SRGBColorSpace,
} from 'three';
import { Rng } from '../core/rng';

// Every texture is painted at load time on a 2D canvas: no image files to download.

let maxAnisotropy = 4;
export function setMaxAnisotropy(n: number): void {
  maxAnisotropy = Math.max(1, Math.min(8, n));
}

type Ctx = CanvasRenderingContext2D;

function paint(w: number, h: number, draw: (ctx: Ctx) => void): Ctx {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('2D canvas unavailable');
  draw(ctx);
  return ctx;
}

/**
 * Canvas → texture. Canvas row 0 becomes v = 1 (same as CanvasTexture). With `bleed`, transparent
 * texels take the average opaque colour so mipmaps don't grow dark fringes round leaves.
 */
function toTexture(ctx: Ctx, options: { repeat?: boolean; bleed?: boolean; data?: boolean } = {}): DataTexture {
  const { width: w, height: h } = ctx.canvas;
  const src = ctx.getImageData(0, 0, w, h).data;
  const out = new Uint8Array(w * h * 4);
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  if (options.bleed) {
    for (let i = 0; i < src.length; i += 4) {
      if (src[i + 3] > 128) {
        r += src[i];
        g += src[i + 1];
        b += src[i + 2];
        n++;
      }
    }
  }
  const ar = n ? r / n : 0;
  const ag = n ? g / n : 0;
  const ab = n ? b / n : 0;
  for (let y = 0; y < h; y++) {
    const sy = h - 1 - y;
    for (let x = 0; x < w; x++) {
      const si = (sy * w + x) * 4;
      const di = (y * w + x) * 4;
      const a = src[si + 3];
      if (options.bleed && a < 10) {
        out[di] = ar;
        out[di + 1] = ag;
        out[di + 2] = ab;
      } else {
        out[di] = src[si];
        out[di + 1] = src[si + 1];
        out[di + 2] = src[si + 2];
      }
      out[di + 3] = a;
    }
  }
  const t = new DataTexture(out, w, h);
  t.colorSpace = options.data ? NoColorSpace : SRGBColorSpace;
  t.wrapS = t.wrapT = options.repeat ? RepeatWrapping : ClampToEdgeWrapping;
  t.magFilter = LinearFilter;
  t.minFilter = LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = maxAnisotropy;
  t.needsUpdate = true;
  return t;
}

function css(rgb: readonly number[], k = 1): string {
  return `rgb(${Math.round(rgb[0] * k)},${Math.round(rgb[1] * k)},${Math.round(rgb[2] * k)})`;
}

function leafPath(ctx: Ctx, len: number, wid: number): void {
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.quadraticCurveTo(len * 0.45, -wid, len, 0);
  ctx.quadraticCurveTo(len * 0.45, wid, 0, 0);
  ctx.fill();
}

/** A round cluster of leaves for canopy cards. */
export function leafClusterTexture(
  seed: number,
  palette: readonly string[],
  leaf: { count: number; len: [number, number]; width: number },
): DataTexture {
  const S = 256;
  const rng = new Rng(seed);
  const ctx = paint(S, S, (c) => {
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < leaf.count * (pass === 0 ? 0.5 : 1); i++) {
        const a = rng.range(0, Math.PI * 2);
        const r = Math.sqrt(rng.next()) * S * 0.33;
        const len = rng.range(leaf.len[0], leaf.len[1]) * S;
        c.save();
        c.translate(S / 2 + Math.cos(a) * r, S / 2 + Math.sin(a) * r);
        c.rotate(a + rng.range(-0.7, 0.7));
        // first pass: darker leaves deeper in the clump
        c.fillStyle = pass === 0 ? palette[0] : rng.pick(palette);
        leafPath(c, len, len * leaf.width);
        c.strokeStyle = 'rgba(230,240,190,0.16)';
        c.lineWidth = 1;
        c.beginPath();
        c.moveTo(len * 0.05, 0);
        c.lineTo(len * 0.9, 0);
        c.stroke();
        c.restore();
      }
    }
  });
  return toTexture(ctx, { bleed: true });
}

/** Coconut frond: u along the frond, v across it (rib at v = 0.5). */
export function palmFrondTexture(seed: number): DataTexture {
  const W = 512;
  const H = 128;
  const rng = new Rng(seed);
  const ctx = paint(W, H, (c) => {
    const greens = ['#3f5a1e', '#4d6b25', '#5b7a2b', '#6b8a33', '#58742a'];
    for (let i = 0; i < 110; i++) {
      const t = i / 110;
      const x = 6 + t * (W - 14);
      const len = (H * 0.48) * Math.pow(Math.sin(Math.PI * Math.min(t * 1.12, 1)), 0.6) * (1 - 0.25 * t) + 4;
      for (const side of [-1, 1]) {
        const ang = (0.55 + rng.range(-0.08, 0.08)) * side;
        c.strokeStyle = t > 0.88 && rng.next() < 0.5 ? '#8a7a3c' : rng.pick(greens);
        c.lineWidth = 2.8 - t * 1.4;
        c.beginPath();
        c.moveTo(x, H / 2);
        c.quadraticCurveTo(
          x + Math.cos(ang) * len * 0.5,
          H / 2 + Math.sin(ang) * len * 0.5,
          x + Math.cos(ang) * len * 0.95 + 4,
          H / 2 + Math.sin(ang) * len,
        );
        c.stroke();
      }
    }
    c.strokeStyle = '#8f8a4a';
    c.lineWidth = 3;
    c.beginPath();
    c.moveTo(0, H / 2);
    c.lineTo(W - 4, H / 2);
    c.stroke();
  });
  return toTexture(ctx, { bleed: true });
}

/** Banana leaf: v along the leaf (stem at v = 0), torn into strips at the edges. */
export function bananaLeafTexture(seed: number): DataTexture {
  const W = 128;
  const H = 512;
  const rng = new Rng(seed);
  const ctx = paint(W, H, (c) => {
    c.fillStyle = '#5f8f2a';
    c.beginPath();
    c.moveTo(W / 2, H);
    for (let i = 0; i <= 40; i++) {
      const t = i / 40;
      c.lineTo(W / 2 + (W * 0.46) * Math.pow(Math.sin(Math.PI * t), 0.45), H - t * H);
    }
    for (let i = 40; i >= 0; i--) {
      const t = i / 40;
      c.lineTo(W / 2 - (W * 0.46) * Math.pow(Math.sin(Math.PI * t), 0.45), H - t * H);
    }
    c.fill();
    // veins sweep outward from the midrib
    c.strokeStyle = 'rgba(200,230,140,0.22)';
    c.lineWidth = 1;
    for (let y = 8; y < H; y += 6) {
      c.beginPath();
      c.moveTo(W / 2, y);
      c.lineTo(4, y - 18);
      c.moveTo(W / 2, y);
      c.lineTo(W - 4, y - 18);
      c.stroke();
    }
    c.fillStyle = '#b8c878';
    c.fillRect(W / 2 - 2, 0, 4, H);
    // wind tears
    c.globalCompositeOperation = 'destination-out';
    c.lineWidth = 2;
    for (let i = 0; i < 26; i++) {
      const y = rng.range(40, H - 30);
      const side = rng.sign();
      c.beginPath();
      c.moveTo(side > 0 ? W : 0, y);
      c.lineTo(W / 2 + side * rng.range(4, 18), y + rng.range(10, 22));
      c.stroke();
    }
  });
  return toTexture(ctx, { bleed: true });
}

/** Kash (Saccharum spontaneum): a thin stem and a feathery white plume. v along the stem. */
export function kashTexture(seed: number): DataTexture {
  const W = 64;
  const H = 256;
  const rng = new Rng(seed);
  const ctx = paint(W, H, (c) => {
    c.strokeStyle = '#8a8456';
    c.lineWidth = 3;
    c.beginPath();
    c.moveTo(W / 2, H);
    c.quadraticCurveTo(W / 2, H * 0.6, W / 2 + 4, H * 0.45);
    c.stroke();
    // the plume droops to one side; a thin dense core keeps its coverage through the mipmaps,
    // and long fine fibres fray its edge
    const rx = (t: number) => W / 2 + 4 + t * t * 16;
    const ry = (t: number) => H * 0.5 - t * H * 0.47 + t * t * t * 16;
    for (let k = 0; k < 30; k++) {
      const t = k / 29;
      c.fillStyle = `rgba(${238 - rng.int(0, 10)},${233 - rng.int(0, 10)},${220 - rng.int(0, 16)},0.9)`;
      c.beginPath();
      c.ellipse(rx(t), ry(t), 1.2 + 3.2 * Math.sin(Math.PI * Math.min(1, t * 1.1)), 6, 0.3 * t, 0, Math.PI * 2);
      c.fill();
    }
    for (let k = 0; k < 420; k++) {
      const t = rng.next();
      const y = ry(t);
      const x = rx(t);
      const spread = (4 + 15 * Math.sin(Math.PI * Math.min(1, t * 1.1))) * rng.range(0.35, 1);
      c.strokeStyle = `rgba(${245 - rng.int(0, 12)},${240 - rng.int(0, 14)},${228 - rng.int(0, 20)},${rng.range(0.55, 0.95)})`;
      c.lineWidth = rng.range(0.6, 1.3);
      c.beginPath();
      c.moveTo(x, y);
      c.lineTo(x + rng.sign() * spread, y - rng.range(4, 14));
      c.stroke();
    }
  });
  return toTexture(ctx, { bleed: true });
}

/** A tuft of grass blades rooted at the bottom centre. */
export function grassTexture(seed: number): DataTexture {
  const S = 128;
  const rng = new Rng(seed);
  const ctx = paint(S, S, (c) => {
    const greens = ['#4d6a24', '#5f7d2a', '#6f8a33', '#7f9240', '#94924a'];
    for (let i = 0; i < 26; i++) {
      const bx = S / 2 + rng.range(-14, 14);
      const tx = bx + rng.range(-46, 46);
      const ty = rng.range(4, S * 0.45);
      const w = rng.range(2, 4);
      c.fillStyle = rng.pick(greens);
      c.beginPath();
      c.moveTo(bx - w, S);
      c.quadraticCurveTo((bx + tx) / 2 - w * 0.5, (S + ty) / 2, tx, ty);
      c.quadraticCurveTo((bx + tx) / 2 + w * 0.5, (S + ty) / 2, bx + w, S);
      c.fill();
    }
  });
  return toTexture(ctx, { bleed: true });
}

/** Thatch: straw laid down the slope (v), with binding lines across. Tiles. */
export function strawTexture(seed: number): DataTexture {
  const S = 256;
  const rng = new Rng(seed);
  const ctx = paint(S, S, (c) => {
    c.fillStyle = '#6b5636';
    c.fillRect(0, 0, S, S);
    const tones = ['#8e7850', '#a48c5c', '#6f5a3a', '#7f6943', '#b49c6a', '#5e4b30'];
    for (let i = 0; i < 3200; i++) {
      const x = rng.range(0, S);
      const y = rng.range(0, S);
      const len = rng.range(14, 34);
      const ang = rng.range(-0.08, 0.08);
      c.strokeStyle = rng.pick(tones);
      c.lineWidth = rng.range(1, 2);
      for (const ox of [-S, 0, S]) {
        for (const oy of [-S, 0, S]) {
          if (x + ox < -40 || x + ox > S + 40 || y + oy < -40 || y + oy > S + 40) continue;
          c.beginPath();
          c.moveTo(x + ox, y + oy);
          c.lineTo(x + ox + Math.sin(ang) * len, y + oy + Math.cos(ang) * len);
          c.stroke();
        }
      }
    }
    c.strokeStyle = 'rgba(40,30,18,0.45)';
    c.lineWidth = 2;
    for (let y = 30; y < S; y += 64) {
      c.beginPath();
      c.moveTo(0, y);
      c.lineTo(S, y + 2);
      c.stroke();
    }
  });
  return toTexture(ctx, { repeat: true });
}

/** Corrugated tin with rust: ridges run down the slope (v). Tiles. */
export function tinTexture(seed: number): DataTexture {
  const S = 256;
  const rng = new Rng(seed);
  const ctx = paint(S, S, (c) => {
    for (let x = 0; x < S; x++) {
      const k = 0.5 + 0.5 * Math.sin((x / S) * Math.PI * 2 * 16);
      const v = Math.round(110 + 60 * k);
      c.fillStyle = `rgb(${v},${v},${v - 6})`;
      c.fillRect(x, 0, 1, S);
    }
    for (let i = 0; i < 26; i++) {
      const x = rng.range(0, S);
      const y = rng.range(0, S);
      const r = rng.range(10, 46);
      for (const ox of [-S, 0, S]) {
        for (const oy of [-S, 0, S]) {
          const g = c.createRadialGradient(x + ox, y + oy, 0, x + ox, y + oy, r);
          g.addColorStop(0, `rgba(${120 + rng.int(0, 30)},${58 + rng.int(0, 20)},28,0.75)`);
          g.addColorStop(1, 'rgba(110,60,30,0)');
          c.fillStyle = g;
          c.fillRect(x + ox - r, y + oy - r, r * 2, r * 2);
        }
      }
    }
    // rust streaks run down from the nail lines
    c.fillStyle = 'rgba(95,48,22,0.35)';
    for (let i = 0; i < 40; i++) c.fillRect(rng.range(0, S), rng.range(0, S), rng.range(1, 3), rng.range(20, 70));
  });
  return toTexture(ctx, { repeat: true });
}

/** Woven bamboo mat (the boat's chhoi canopy). Tiles. */
export function weaveTexture(seed: number): DataTexture {
  const S = 256;
  const N = 16;
  const rng = new Rng(seed);
  const ctx = paint(S, S, (c) => {
    c.fillStyle = '#3a2c1a';
    c.fillRect(0, 0, S, S);
    const cell = S / N;
    for (let i = 0; i < N; i++) {
      for (let j = 0; j < N; j++) {
        const over = (i + j) % 2 === 0;
        const base = over ? [176, 141, 85] : [150, 117, 66];
        const k = rng.range(0.78, 1.05);
        const g = c.createLinearGradient(i * cell, j * cell, over ? i * cell : (i + 1) * cell, over ? (j + 1) * cell : j * cell);
        g.addColorStop(0, css(base, k * 0.8));
        g.addColorStop(0.5, css(base, k));
        g.addColorStop(1, css(base, k * 0.75));
        c.fillStyle = g;
        c.fillRect(i * cell + 1, j * cell + 1, cell - 2, cell - 2);
      }
    }
  });
  return toTexture(ctx, { repeat: true });
}

/** Patchwork sail: panels of cloth in faded colours, darker seams. */
export function sailTexture(seed: number): DataTexture {
  const S = 256;
  const rng = new Rng(seed);
  const cloth = ['#d9ccb0', '#c9b38a', '#b98a5c', '#a85b3c', '#ddd5c2', '#8d7c5d', '#c8a56b', '#9a4f36'];
  const ctx = paint(S, S, (c) => {
    const split = (x: number, y: number, w: number, h: number, depth: number): void => {
      if (depth > 4 || (depth > 1 && rng.next() < 0.3) || w < 30 || h < 30) {
        c.fillStyle = rng.pick(cloth);
        c.fillRect(x, y, w, h);
        c.strokeStyle = 'rgba(60,40,25,0.55)';
        c.lineWidth = 2;
        c.strokeRect(x + 1, y + 1, w - 2, h - 2);
        return;
      }
      if (w > h) {
        const cut = w * rng.range(0.3, 0.7);
        split(x, y, cut, h, depth + 1);
        split(x + cut, y, w - cut, h, depth + 1);
      } else {
        const cut = h * rng.range(0.3, 0.7);
        split(x, y, w, cut, depth + 1);
        split(x, y + cut, w, h - cut, depth + 1);
      }
    };
    split(0, 0, S, S, 0);
    for (let i = 0; i < 900; i++) {
      c.fillStyle = `rgba(70,50,30,${rng.range(0.02, 0.08)})`;
      c.fillRect(rng.range(0, S), rng.range(0, S), rng.range(2, 9), rng.range(2, 9));
    }
  });
  return toTexture(ctx);
}

/** Woven check cloth (lungi, gamchha). Tiles. */
export function checkTexture(base: string, stripe: string, thin: string): DataTexture {
  const S = 128;
  const ctx = paint(S, S, (c) => {
    c.fillStyle = base;
    c.fillRect(0, 0, S, S);
    c.globalAlpha = 0.65;
    for (const [col, w, step] of [
      [stripe, 10, 32],
      [thin, 2, 16],
    ] as const) {
      c.fillStyle = col;
      for (let p = 4; p < S; p += step) {
        c.fillRect(p, 0, w, S);
        c.fillRect(0, p, S, w);
      }
    }
  });
  return toTexture(ctx, { repeat: true });
}

/** Tarred, weathered planks laid along u. Tiles. */
export function plankTexture(seed: number): DataTexture {
  const S = 256;
  const rng = new Rng(seed);
  const ctx = paint(S, S, (c) => {
    const plank = 32;
    for (let y = 0; y < S; y += plank) {
      c.fillStyle = css([46, 35, 26], rng.range(0.8, 1.2));
      c.fillRect(0, y, S, plank);
      for (let i = 0; i < 70; i++) {
        c.fillStyle = `rgba(${110 + rng.int(0, 40)},${88 + rng.int(0, 30)},${62 + rng.int(0, 20)},${rng.range(0.05, 0.22)})`;
        c.fillRect(rng.range(0, S), y + rng.range(2, plank - 2), rng.range(20, 90), rng.range(1, 2));
      }
      c.fillStyle = 'rgba(10,6,3,0.8)';
      c.fillRect(0, y, S, 2);
    }
    for (let i = 0; i < 16; i++) {
      const g = c.createRadialGradient(rng.range(0, S), rng.range(0, S), 0, rng.range(0, S), rng.range(0, S), rng.range(20, 60));
      g.addColorStop(0, 'rgba(130,110,80,0.18)');
      g.addColorStop(1, 'rgba(130,110,80,0)');
      c.fillStyle = g;
      c.fillRect(0, 0, S, S);
    }
  });
  return toTexture(ctx, { repeat: true });
}

/** Palm bark: grey-brown with the ring scars of fallen fronds (rings run across v). Tiles. */
export function palmBarkTexture(seed: number): DataTexture {
  const W = 64;
  const H = 256;
  const rng = new Rng(seed);
  const ctx = paint(W, H, (c) => {
    c.fillStyle = '#6b5f50';
    c.fillRect(0, 0, W, H);
    for (let i = 0; i < 300; i++) {
      c.fillStyle = `rgba(${rng.int(60, 140)},${rng.int(55, 125)},${rng.int(45, 105)},0.25)`;
      c.fillRect(rng.range(0, W), rng.range(0, H), rng.range(1, 3), rng.range(4, 16));
    }
    for (let y = 4; y < H; y += rng.range(9, 15)) {
      c.fillStyle = 'rgba(40,34,26,0.7)';
      c.fillRect(0, y, W, rng.range(1.5, 3));
    }
  });
  return toTexture(ctx, { repeat: true });
}

/** Fishing net: a thin diamond mesh, transparent between the cords. Tiles. */
export function netTexture(): DataTexture {
  const S = 128;
  const ctx = paint(S, S, (c) => {
    c.strokeStyle = 'rgba(52,46,36,1)';
    c.lineWidth = 1.6;
    for (let k = -S; k < S * 2; k += 16) {
      c.beginPath();
      c.moveTo(k, 0);
      c.lineTo(k + S, S);
      c.moveTo(k + S, 0);
      c.lineTo(k, S);
      c.stroke();
    }
  });
  return toTexture(ctx, { repeat: true, bleed: true });
}
