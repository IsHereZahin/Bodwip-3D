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

/** One half of a leaf, either side of the midrib (`side` ±1). */
function halfLeafPath(ctx: Ctx, len: number, wid: number, side: number): void {
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.quadraticCurveTo(len * 0.45, side * wid, len, 0);
  ctx.closePath();
  ctx.fill();
}

/** A tangent-space normal as a CSS colour (canvas y runs down the texture, so it is v negated). */
function normalCss(x: number, yDown: number, z: number): string {
  const l = Math.hypot(x, yDown, z);
  return `rgb(${Math.round((x / l * 0.5 + 0.5) * 255)},${Math.round((-yDown / l * 0.5 + 0.5) * 255)},${Math.round((z / l * 0.5 + 0.5) * 255)})`;
}

/**
 * A round cluster of leaves for canopy cards, with a matching normal map: every leaf tilts its own
 * way and folds along its midrib, so a crown catches the light leaf by leaf rather than card by card.
 */
export function leafClusterTexture(
  seed: number,
  palette: readonly string[],
  leaf: { count: number; len: [number, number]; width: number },
): { map: DataTexture; normal: DataTexture } {
  const S = 256;
  const rng = new Rng(seed);
  const normals = paint(S, S, (n) => {
    n.fillStyle = normalCss(0, 0, 1);
    n.fillRect(0, 0, S, S);
  });
  const ctx = paint(S, S, (c) => {
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < leaf.count * (pass === 0 ? 0.5 : 1); i++) {
        const a = rng.range(0, Math.PI * 2);
        const r = Math.sqrt(rng.next()) * S * 0.33;
        const len = rng.range(leaf.len[0], leaf.len[1]) * S;
        const rot = a + rng.range(-0.7, 0.7);
        const x = S / 2 + Math.cos(a) * r;
        const y = S / 2 + Math.sin(a) * r;
        c.save();
        c.translate(x, y);
        c.rotate(rot);
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
        // the same leaf in the normal map: a random tilt, and each half turned away from the midrib
        const tx = rng.range(-0.55, 0.55);
        const ty = rng.range(-0.55, 0.55);
        const fold = 0.45;
        normals.save();
        normals.translate(x, y);
        normals.rotate(rot);
        for (const side of [-1, 1]) {
          // the fold leans the half's normal across the leaf: (−sin, cos) of the leaf's angle on canvas
          const fx = -Math.sin(rot) * side * fold;
          const fy = Math.cos(rot) * side * fold;
          normals.fillStyle = normalCss(tx + fx, ty + fy, 1);
          halfLeafPath(normals, len, len * leaf.width, side);
        }
        normals.restore();
      }
    }
  });
  return { map: toTexture(ctx, { bleed: true }), normal: toTexture(normals, { data: true }) };
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
    // each blade dark at the root and bleached toward the tip, as in late-summer grass
    const tips = ['#9aa64a', '#a9ad55', '#b8b060', '#8f9c44', '#c0a866'];
    for (let i = 0; i < 40; i++) {
      const bx = S / 2 + rng.range(-20, 20);
      const tx = bx + rng.range(-50, 50);
      const ty = rng.range(4, S * 0.5);
      const w = rng.range(1.6, 3.4);
      const g = c.createLinearGradient(0, S, 0, ty);
      g.addColorStop(0, '#1c2a0d');
      g.addColorStop(0.45, rng.pick(['#3e5a1c', '#4a6622', '#567028']));
      g.addColorStop(1, rng.pick(tips));
      c.fillStyle = g;
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

/**
 * Handloom cotton (lungi, gamchha, vest): a check of `stripe` and `thin` threads on `base`, with slubs in
 * the yarn, and a normal map of its plain weave (or, `knit`, of a knitted vest's ribs). Tiles.
 */
export function clothTexture(base: string, stripe: string, thin: string, seed: number, knit = false): { map: DataTexture; normal: DataTexture } {
  const S = 256;
  const CELL = 4;
  const rng = new Rng(seed);
  const ctx = paint(S, S, (c) => {
    c.fillStyle = base;
    c.fillRect(0, 0, S, S);
    c.globalAlpha = 0.65;
    for (const [col, w, step] of [
      [stripe, 20, 64],
      [thin, 4, 32],
    ] as const) {
      c.fillStyle = col;
      for (let q = 8; q < S; q += step) {
        c.fillRect(q, 0, w, S);
        c.fillRect(0, q, S, w);
      }
    }
    // slubs: lengths of yarn a shade lighter or darker, along the warp and the weft, wrapping round the
    // tile (handloom only; a machine-knit vest is even)
    c.globalAlpha = 1;
    for (let i = 0; i < (knit ? 0 : 160); i++) {
      c.fillStyle = rng.next() < 0.5 ? `rgba(255,248,236,${rng.range(0.04, 0.12)})` : `rgba(12,9,6,${rng.range(0.05, 0.15)})`;
      const at = Math.floor(rng.range(0, S / 2)) * 2;
      const from = rng.range(0, S);
      const len = rng.range(20, 160);
      for (const wrap of [0, -S]) {
        if (rng.next() < 0.5) c.fillRect(at, from + wrap, 2, len);
        else c.fillRect(from + wrap, at, len, 2);
      }
    }
  });
  const hgt = paint(S, S, (c) => {
    c.fillStyle = 'rgb(110,110,110)';
    c.fillRect(0, 0, S, S);
    for (let j = 0; j < S / CELL; j++) {
      for (let i = 0; i < S / CELL; i++) {
        const v = Math.round(rng.range(165, 205));
        c.fillStyle = `rgb(${v},${v},${v})`;
        c.beginPath();
        // plain weave: warp over weft, then weft over warp; a knit is columns of loops
        const vertical = knit || (i + j) % 2 === 1;
        c.ellipse(i * CELL + CELL / 2, j * CELL + CELL / 2, vertical ? 1.2 : 2, vertical ? 2.1 : 1.2, 0, 0, Math.PI * 2);
        c.fill();
      }
    }
  });
  return { map: toTexture(ctx, { repeat: true }), normal: normalFromHeight(hgt, 2.5) };
}

/**
 * A raft of water-lily pads seen from above (notched, pale-rimmed, veined, in greens from fresh to old),
 * with here and there a white or pink flower among them; transparent between. Tiles.
 */
export function lilyCarpetTexture(seed: number): DataTexture {
  const S = 512;
  const rng = new Rng(seed);
  const greens = [
    [46, 80, 28],
    [56, 94, 33],
    [68, 106, 38],
    [84, 116, 42],
    [102, 112, 50],
  ];
  const ctx = paint(S, S, (c) => {
    c.clearRect(0, 0, S, S);
    for (let i = 0; i < 150; i++) {
      const x = rng.range(0, S);
      const y = rng.range(0, S);
      const r = rng.range(15, 32);
      const col = rng.pick(greens);
      const k = rng.range(0.85, 1.12);
      const notch = rng.range(0, Math.PI * 2);
      // drawn again across each edge it crosses, so the tile repeats without a seam
      for (const ox of [-S, 0, S]) {
        for (const oy of [-S, 0, S]) {
          const cx = x + ox;
          const cy = y + oy;
          if (cx < -r || cx > S + r || cy < -r || cy > S + r) continue;
          c.fillStyle = css(col, k);
          c.beginPath();
          c.moveTo(cx, cy);
          c.arc(cx, cy, r, notch + 0.18, notch + Math.PI * 2 - 0.18);
          c.closePath();
          c.fill();
          c.strokeStyle = css(col, k * 1.25);
          c.lineWidth = 1.2;
          c.beginPath();
          c.arc(cx, cy, r - 1, notch + 0.2, notch + Math.PI * 2 - 0.2);
          c.stroke();
          c.strokeStyle = 'rgba(30,50,18,0.35)';
          c.lineWidth = 0.8;
          for (let v = 0; v < 7; v++) {
            const a = notch + 0.4 + (v / 7) * (Math.PI * 2 - 0.8);
            c.beginPath();
            c.moveTo(cx, cy);
            c.lineTo(cx + Math.cos(a) * r * 0.9, cy + Math.sin(a) * r * 0.9);
            c.stroke();
          }
        }
      }
    }
    for (let i = 0; i < 9; i++) {
      const x = rng.range(20, S - 20);
      const y = rng.range(20, S - 20);
      c.fillStyle = rng.next() < 0.35 ? '#e9a1b8' : '#f3efe6';
      for (let p = 0; p < 12; p++) {
        const a = (p / 12) * Math.PI * 2 + rng.range(-0.1, 0.1);
        c.beginPath();
        c.ellipse(x + Math.cos(a) * 7, y + Math.sin(a) * 7, 8, 3, a, 0, Math.PI * 2);
        c.fill();
      }
      c.fillStyle = '#f0c33a';
      c.beginPath();
      c.arc(x, y, 4, 0, Math.PI * 2);
      c.fill();
    }
  });
  return toTexture(ctx, { repeat: true, bleed: true });
}

/** A tangent-space normal map from a grey height canvas (white = raised), by central differences. Tiles. */
function normalFromHeight(height: Ctx, strength: number): DataTexture {
  const { width: w, height: h } = height.canvas;
  const src = height.getImageData(0, 0, w, h).data;
  const at = (x: number, y: number) => src[((((y + h) % h) * w + ((x + w) % w)) * 4)] / 255;
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // canvas y runs down, texture v up: the row flip below makes +v the canvas's up
      const dx = (at(x + 1, y) - at(x - 1, y)) * strength;
      const dy = (at(x, y - 1) - at(x, y + 1)) * strength;
      const l = Math.hypot(dx, dy, 1);
      const i = ((h - 1 - y) * w + x) * 4;
      out[i] = Math.round((-dx / l * 0.5 + 0.5) * 255);
      out[i + 1] = Math.round((-dy / l * 0.5 + 0.5) * 255);
      out[i + 2] = Math.round((1 / l * 0.5 + 0.5) * 255);
      out[i + 3] = 255;
    }
  }
  const t = new DataTexture(out, w, h);
  t.colorSpace = NoColorSpace;
  t.wrapS = t.wrapT = RepeatWrapping;
  t.magFilter = LinearFilter;
  t.minFilter = LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = maxAnisotropy;
  t.needsUpdate = true;
  return t;
}

/**
 * A country boat's planking: weathered strakes running along u with grain and the odd knot, butt joints,
 * seams caulked with tar, and the iron cramps (patam) that Bengal boatwrights drive across each seam.
 * Four strakes per tile. Comes with a normal map, so seams sink and cramps stand proud.
 */
export function hullPlankTexture(seed: number): { map: DataTexture; normal: DataTexture } {
  const S = 512;
  const STRAKES = 4;
  const rng = new Rng(seed);
  const hgt = paint(S, S, (c) => {
    c.fillStyle = 'rgb(128,128,128)';
    c.fillRect(0, 0, S, S);
  });
  const ctx = paint(S, S, (c) => {
    const band = S / STRAKES;
    for (let k = 0; k < STRAKES; k++) {
      const y0 = k * band;
      // each strake its own board, weathered to a different grey-brown
      c.fillStyle = css([150, 128, 100], rng.range(0.78, 1.08));
      c.fillRect(0, y0, S, band);
      for (let i = 0; i < 260; i++) {
        const light = rng.next() < 0.5;
        c.fillStyle = light ? `rgba(196,176,140,${rng.range(0.05, 0.2)})` : `rgba(62,46,32,${rng.range(0.05, 0.25)})`;
        const y = y0 + rng.range(3, band - 3);
        const len = rng.range(30, 200);
        const x = rng.range(-40, S);
        c.fillRect(x, y, len, rng.range(0.6, 1.8));
        hgt.fillStyle = light ? 'rgba(150,150,150,0.4)' : 'rgba(105,105,105,0.4)';
        hgt.fillRect(x, y, len, 1);
      }
      // a knot or two, the grain swirling round it
      for (let i = 0; i < rng.int(0, 2); i++) {
        const kx = rng.range(20, S - 20);
        const ky = y0 + rng.range(band * 0.3, band * 0.7);
        for (let r = 9; r > 1; r -= 2) {
          c.strokeStyle = `rgba(70,48,30,${0.22 + (9 - r) * 0.05})`;
          c.beginPath();
          c.ellipse(kx, ky, r * 2.4, r, 0, 0, Math.PI * 2);
          c.stroke();
        }
      }
      // where two boards butt end to end
      const butt = rng.range(0, S);
      c.fillStyle = 'rgba(24,16,10,0.85)';
      c.fillRect(butt, y0, 2, band);
      hgt.fillStyle = 'rgb(60,60,60)';
      hgt.fillRect(butt, y0, 2, band);
      // the seam above this strake, caulked and tarred
      c.fillStyle = 'rgba(20,14,9,0.9)';
      c.fillRect(0, y0, S, 3);
      c.fillStyle = 'rgba(30,22,14,0.35)';
      c.fillRect(0, y0 + 3, S, 3);
      hgt.fillStyle = 'rgb(40,40,40)';
      hgt.fillRect(0, y0, S, 3);
      // iron cramps across the seam, rust bleeding down from each
      for (let x = rng.range(4, 30); x < S; x += rng.range(34, 52)) {
        const g = c.createLinearGradient(0, y0, 0, y0 + 26);
        g.addColorStop(0, 'rgba(120,58,28,0.35)');
        g.addColorStop(1, 'rgba(120,58,28,0)');
        c.fillStyle = g;
        c.fillRect(x - 2, y0, 9, 26);
        c.fillStyle = '#2a2420';
        c.fillRect(x, y0 - 7, 5, 14);
        hgt.fillStyle = 'rgb(215,215,215)';
        hgt.fillRect(x, y0 - 7, 5, 14);
      }
      // nail heads along the strake where it meets a frame
      for (let x = rng.range(10, 60); x < S; x += rng.range(60, 90)) {
        c.fillStyle = 'rgba(30,26,22,0.8)';
        c.beginPath();
        c.arc(x, y0 + band / 2, 1.6, 0, Math.PI * 2);
        c.fill();
      }
    }
    // scuffs and water stains over everything
    for (let i = 0; i < 26; i++) {
      const g = c.createRadialGradient(rng.range(0, S), rng.range(0, S), 0, rng.range(0, S), rng.range(0, S), rng.range(30, 90));
      const dark = rng.next() < 0.6;
      g.addColorStop(0, dark ? 'rgba(40,30,20,0.16)' : 'rgba(210,196,170,0.12)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      c.fillStyle = g;
      c.fillRect(0, 0, S, S);
    }
  });
  const map = toTexture(ctx, { repeat: true });
  return { map, normal: normalFromHeight(hgt, 3.2) };
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

/** A soft round shadow, dark in the middle and gone at the rim (alpha only), for contact shadows. */
export function softSpotTexture(): DataTexture {
  const S = 64;
  const ctx = paint(S, S, (c) => {
    const g = c.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    g.addColorStop(0, 'rgba(0,0,0,0.75)');
    g.addColorStop(0.55, 'rgba(0,0,0,0.35)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    c.fillStyle = g;
    c.fillRect(0, 0, S, S);
  });
  return toTexture(ctx);
}

/**
 * A water-hyacinth leaf, mapped as a disc onto the middle of the square: glossy green, darker at the
 * base, fine veins curving out from the stalk. The top-left corner is plain white for petals, so the
 * flowers can share the leaves' material.
 */
export function hyacinthLeafTexture(seed: number): DataTexture {
  const S = 128;
  const rng = new Rng(seed);
  const ctx = paint(S, S, (c) => {
    const g = c.createRadialGradient(S / 2, S * 0.92, 2, S / 2, S / 2, S * 0.6);
    g.addColorStop(0, '#2f5a1c');
    g.addColorStop(0.5, '#4f8a2c');
    g.addColorStop(1, '#6aa53a');
    c.fillStyle = g;
    c.fillRect(0, 0, S, S);
    // veins fan out from where the stalk joins, curving with the leaf's edge
    c.lineWidth = 1;
    for (let i = 0; i < 26; i++) {
      const a = -Math.PI / 2 + (i / 25 - 0.5) * 2.6;
      c.strokeStyle = `rgba(205,235,150,${rng.range(0.12, 0.26)})`;
      c.beginPath();
      c.moveTo(S / 2, S * 0.92);
      c.quadraticCurveTo(S / 2 + Math.cos(a) * S * 0.25, S * 0.92 + Math.sin(a) * S * 0.45, S / 2 + Math.cos(a) * S * 0.5, S / 2 + Math.sin(a) * S * 0.48);
      c.stroke();
    }
    // a gloss streak along the leaf
    const gl = c.createLinearGradient(S * 0.25, S * 0.2, S * 0.75, S * 0.8);
    gl.addColorStop(0, 'rgba(255,255,230,0)');
    gl.addColorStop(0.5, 'rgba(255,255,230,0.12)');
    gl.addColorStop(1, 'rgba(255,255,230,0)');
    c.fillStyle = gl;
    c.fillRect(0, 0, S, S);
    c.fillStyle = '#ffffff';
    c.fillRect(0, 0, 10, 10);
  });
  return toTexture(ctx);
}
