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
  /** Small flowers dotted over the leaves (a flowering bush's), each a few petals round a paler eye. */
  flowers?: { count: number; palette: readonly string[] },
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
    if (flowers) {
      for (let i = 0; i < flowers.count; i++) {
        const a = rng.range(0, Math.PI * 2);
        const r = Math.sqrt(rng.next()) * S * 0.31;
        const x = S / 2 + Math.cos(a) * r;
        const y = S / 2 + Math.sin(a) * r;
        const size = rng.range(3.5, 6.5);
        const turn = rng.range(0, Math.PI);
        c.fillStyle = rng.pick(flowers.palette);
        for (let q = 0; q < 5; q++) {
          const pa = turn + (q / 5) * Math.PI * 2;
          c.beginPath();
          c.ellipse(x + Math.cos(pa) * size * 0.55, y + Math.sin(pa) * size * 0.55, size * 0.55, size * 0.38, pa, 0, Math.PI * 2);
          c.fill();
        }
        c.fillStyle = 'rgba(255, 236, 214, 0.85)';
        c.beginPath();
        c.arc(x, y, size * 0.22, 0, Math.PI * 2);
        c.fill();
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

/**
 * A tal (palmyra) leaf: its stalk up from the bottom middle to two fifths of the way, and from its tip a round
 * fan of stiff pleated segments spread through some 250 degrees, each split at its end, dark along its fold.
 * v up the stalk and out through the fan.
 */
export function palmFanTexture(seed: number): DataTexture {
  const S = 256;
  const rng = new Rng(seed);
  const ctx = paint(S, S, (c) => {
    const hub = { x: S / 2, y: S * 0.6 };
    c.strokeStyle = '#6d6a3c';
    c.lineWidth = 5;
    c.beginPath();
    c.moveTo(S / 2, S);
    c.lineTo(hub.x, hub.y);
    c.stroke();
    const greens = ['#3f5a24', '#4a6629', '#55722f', '#5f7c35', '#47622a'];
    const n = 46;
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      // from down-left, over the top, to down-right
      const a = -2.2 + t * 4.4 + rng.range(-0.02, 0.02);
      const len = S * rng.range(0.4, 0.47) * (0.75 + 0.25 * Math.cos(a * 0.6));
      const half = 0.045;
      const tip = { x: hub.x + Math.sin(a) * len, y: hub.y - Math.cos(a) * len };
      c.fillStyle = rng.pick(greens);
      c.beginPath();
      c.moveTo(hub.x, hub.y);
      c.lineTo(hub.x + Math.sin(a - half) * len * 0.97, hub.y - Math.cos(a - half) * len * 0.97);
      // the split tip
      c.lineTo(tip.x + Math.sin(a - 0.08) * 8, tip.y - Math.cos(a - 0.08) * 8);
      c.lineTo(tip.x, tip.y);
      c.lineTo(tip.x + Math.sin(a + 0.08) * 8, tip.y - Math.cos(a + 0.08) * 8);
      c.lineTo(hub.x + Math.sin(a + half) * len * 0.97, hub.y - Math.cos(a + half) * len * 0.97);
      c.closePath();
      c.fill();
      // the fold down its middle, darker
      c.strokeStyle = 'rgba(30, 40, 15, 0.5)';
      c.lineWidth = 1;
      c.beginPath();
      c.moveTo(hub.x, hub.y);
      c.lineTo(tip.x, tip.y);
      c.stroke();
    }
    // the dense heart of the fan where the segments meet
    c.fillStyle = '#4a6328';
    c.beginPath();
    c.arc(hub.x, hub.y, S * 0.07, 0, Math.PI * 2);
    c.fill();
  });
  return toTexture(ctx, { bleed: true });
}

/**
 * Weathered stone, tiling (the stones' and rocks' surface, world/stones.ts), with a matching normal map: a
 * grey ground of fine grains light and dark, soft mottling where it has weathered, a few thin dark cracks, and
 * pale grey lichen in small patches. The mottling and the cracks are laid into a height the normal map is taken
 * from. Everything wraps round the edges, so it tiles.
 */
export function rockTexture(seed: number): { map: DataTexture; normal: DataTexture } {
  const S = 256;
  const rng = new Rng(seed);
  const height = new Float32Array(S * S);
  const tone = new Float32Array(S * S);
  /** A soft round bump of `amount` into `field` at (cx, cy), wrapping round the edges. */
  const bump = (field: Float32Array, cx: number, cy: number, r: number, amount: number) => {
    const r2 = r * r;
    for (let dy = -Math.ceil(r); dy <= Math.ceil(r); dy++) {
      for (let dx = -Math.ceil(r); dx <= Math.ceil(r); dx++) {
        const d2 = dx * dx + dy * dy;
        if (d2 > r2) continue;
        const x = (((Math.round(cx) + dx) % S) + S) % S;
        const y = (((Math.round(cy) + dy) % S) + S) % S;
        const f = 1 - d2 / r2;
        field[y * S + x] += amount * f * f;
      }
    }
  };
  // weathering: broad soft mottles, lighter and darker, in the height and in the tone alike
  for (let i = 0; i < 260; i++) {
    const x = rng.range(0, S);
    const y = rng.range(0, S);
    const r = rng.range(6, 30);
    const a = rng.range(-1, 1);
    bump(height, x, y, r, a * 0.18);
    bump(tone, x, y, r, a * 0.09 + rng.range(-0.04, 0.04));
  }
  // grain: tiny pits and crystals
  for (let i = 0; i < S * S; i++) {
    const g = rng.next() - 0.5;
    height[i] += g * 0.05;
    tone[i] += g * 0.16;
  }
  // cracks: thin wandering lines, cut into the height
  for (let k = 0; k < 5; k++) {
    let x = rng.range(0, S);
    let y = rng.range(0, S);
    let a = rng.range(0, Math.PI * 2);
    for (let i = 0; i < 18; i++) {
      a += rng.range(-0.5, 0.5);
      x += Math.cos(a) * 4;
      y += Math.sin(a) * 4;
      bump(height, x, y, 1.6, -0.35);
      bump(tone, x, y, 1.4, -0.22);
    }
  }
  const map = paint(S, S, (c) => {
    const img = c.createImageData(S, S);
    for (let i = 0; i < S * S; i++) {
      const v = Math.max(0.35, Math.min(1.3, 1 + tone[i]));
      img.data[i * 4] = 128 * v;
      img.data[i * 4 + 1] = 124 * v;
      img.data[i * 4 + 2] = 116 * v;
      img.data[i * 4 + 3] = 255;
    }
    c.putImageData(img, 0, 0);
    // lichen: small pale grey patches of tiny dots (drawn at each wrap so a patch crossing an edge tiles)
    for (let k = 0; k < 10; k++) {
      const cx = rng.range(0, S);
      const cy = rng.range(0, S);
      const r = rng.range(5, 13);
      const col = rng.pick(['rgba(196, 198, 186, 0.5)', 'rgba(178, 182, 168, 0.45)', 'rgba(200, 192, 166, 0.35)']);
      const dots = Array.from({ length: Math.round(r * 7) }, () => {
        const a = rng.range(0, Math.PI * 2);
        const d = Math.sqrt(rng.next()) * r;
        return { x: cx + Math.cos(a) * d, y: cy + Math.sin(a) * d, s: rng.range(0.5, 1.5) };
      });
      c.fillStyle = col;
      for (const ox of [-S, 0, S]) {
        for (const oy of [-S, 0, S]) {
          for (const d of dots) {
            c.beginPath();
            c.arc(d.x + ox, d.y + oy, d.s, 0, Math.PI * 2);
            c.fill();
          }
        }
      }
    }
  });
  const normals = paint(S, S, (n) => {
    const img = n.createImageData(S, S);
    const h = (x: number, y: number) => height[(((y % S) + S) % S) * S + (((x % S) + S) % S)];
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const dx = (h(x + 1, y) - h(x - 1, y)) * 4;
        const dy = (h(x, y + 1) - h(x, y - 1)) * 4;
        const l = Math.hypot(dx, dy, 1);
        const o = (y * S + x) * 4;
        img.data[o] = (-dx / l * 0.5 + 0.5) * 255;
        img.data[o + 1] = (dy / l * 0.5 + 0.5) * 255;
        img.data[o + 2] = (1 / l * 0.5 + 0.5) * 255;
        img.data[o + 3] = 255;
      }
    }
    n.putImageData(img, 0, 0);
  });
  return { map: toTexture(map, { repeat: true }), normal: toTexture(normals, { repeat: true, data: true }) };
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

/**
 * Kash (Saccharum spontaneum), two cards in one texture. The left half (u 0..0.5) is a flowering stem: a thin
 * cane with a leaf or two, and at its top (the upper quarter) a slender silky plume nodding to one side, its
 * fibres silver-white with a lilac flush at their base. The right half (u 0.5..1) is the clump's long narrow
 * grey-green leaves, arching out from the root. v along the stem. Only the plume is bright (the season hides it
 * by its brightness: render/patch.ts).
 */
export function kashTexture(seed: number): DataTexture {
  const W = 256;
  const H = 512;
  const half = W / 2;
  const rng = new Rng(seed);
  const ctx = paint(W, H, (c) => {
    // ---- the flowering stem ----
    // the cane a little left of the half's middle, so the plume nodding right stays inside it
    const cx = half * 0.4;
    const top = H * 0.27;
    c.strokeStyle = '#6f7240';
    c.lineWidth = 2.4;
    c.beginPath();
    c.moveTo(cx, H);
    c.quadraticCurveTo(cx - 2, H * 0.6, cx + 3, top);
    c.stroke();
    // a sheathing leaf or two up the cane
    for (const [y0, side] of [
      [H * 0.78, 1],
      [H * 0.58, -1],
    ] as const) {
      c.fillStyle = side > 0 ? '#5c6a36' : '#66733c';
      c.beginPath();
      c.moveTo(cx, y0);
      c.quadraticCurveTo(cx + side * 22, y0 - 60, cx + side * 50, y0 - 40);
      c.quadraticCurveTo(cx + side * 20, y0 - 50, cx + 1, y0 - 16);
      c.fill();
    }
    // the plume: a rachis nodding over to one side, a thin dense core along it (it keeps its coverage
    // through the mipmaps), and silky fibres fanning up and out from it
    const rx = (t: number) => cx + 3 + t * t * 20;
    const ry = (t: number) => top - t * (H * 0.21) + t * t * t * 26;
    c.strokeStyle = 'rgba(214, 206, 204, 0.95)';
    c.lineWidth = 2.2;
    c.beginPath();
    for (let k = 0; k <= 20; k++) {
      const t = k / 20;
      if (k === 0) c.moveTo(rx(t), ry(t));
      else c.lineTo(rx(t), ry(t));
    }
    c.stroke();
    for (let k = 0; k < 700; k++) {
      const t = Math.pow(rng.next(), 0.8);
      const x = rx(t);
      const y = ry(t);
      // fullest a third of the way up, tapering to a fine tip
      const full = Math.sin(Math.PI * Math.min(1, 0.15 + t * 0.95));
      const len = (5 + 15 * full) * rng.range(0.4, 1);
      const a = rng.sign() * rng.range(0.15, 1.1) - 0.25;
      const base = rng.next() < 0.3;
      c.strokeStyle = base
        ? `rgba(${208 + rng.int(0, 14)},${190 + rng.int(0, 12)},${206 + rng.int(0, 12)},${rng.range(0.5, 0.85)})`
        : `rgba(${236 + rng.int(0, 14)},${233 + rng.int(0, 14)},${226 + rng.int(0, 16)},${rng.range(0.35, 0.85)})`;
      c.lineWidth = rng.range(0.5, 1.1);
      c.beginPath();
      c.moveTo(x, y);
      c.quadraticCurveTo(x + Math.sin(a) * len * 0.5, y - len * 0.6, x + Math.sin(a) * len, y - Math.cos(a) * len * 0.7 + len * 0.15);
      c.stroke();
    }
    // ---- the leaves: long, narrow, arching out and drooping, each with a paler midrib ----
    for (let i = 0; i < 26; i++) {
      const bx = half + half / 2 + rng.range(-8, 8);
      const side = rng.sign();
      const reach = rng.range(10, 58) * side;
      const tipY = rng.range(H * 0.12, H * 0.62);
      const w = rng.range(2.2, 4);
      const g = c.createLinearGradient(0, H, 0, tipY);
      g.addColorStop(0, '#2c3a17');
      g.addColorStop(0.5, rng.pick(['#4d5f2b', '#566830', '#5a6b33', '#617236']));
      g.addColorStop(1, rng.pick(['#7f8a52', '#8a9258', '#96985e']));
      c.fillStyle = g;
      const mx = bx + reach * 0.35;
      const my = (H + tipY) / 2 - 30;
      c.beginPath();
      c.moveTo(bx - w, H);
      c.quadraticCurveTo(mx - w, my, bx + reach, tipY);
      c.quadraticCurveTo(mx + w, my, bx + w, H);
      c.fill();
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

/** Corrugated tin with rust: ridges run down the slope (v), 32 to a repeat (2.4 m of sheet). Tiles. */
export function tinTexture(seed: number): DataTexture {
  const S = 512;
  const rng = new Rng(seed);
  const ctx = paint(S, S, (c) => {
    for (let x = 0; x < S; x++) {
      const k = 0.5 + 0.5 * Math.sin((x / S) * Math.PI * 2 * 32);
      const v = Math.round(110 + 60 * k);
      c.fillStyle = `rgb(${v},${v},${v - 6})`;
      c.fillRect(x, 0, 1, S);
    }
    for (let i = 0; i < 14; i++) {
      const x = rng.range(0, S);
      const y = rng.range(0, S);
      const r = rng.range(14, 90);
      for (const ox of [-S, 0, S]) {
        for (const oy of [-S, 0, S]) {
          const g = c.createRadialGradient(x + ox, y + oy, 0, x + ox, y + oy, r);
          g.addColorStop(0, `rgba(${120 + rng.int(0, 30)},${58 + rng.int(0, 20)},28,0.45)`);
          g.addColorStop(1, 'rgba(110,60,30,0)');
          c.fillStyle = g;
          c.fillRect(x + ox - r, y + oy - r, r * 2, r * 2);
        }
      }
    }
    // rust streaks run down from the nail lines
    c.fillStyle = 'rgba(95,48,22,0.35)';
    for (let i = 0; i < 80; i++) c.fillRect(rng.range(0, S), rng.range(0, S), rng.range(1, 4), rng.range(30, 140));
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

/**
 * A cast net's mesh (tiles): pale twine knotted in diamonds on nothing, the knots a little heavier. Seen from
 * afar its mipmaps leave a faint veil, as a net in the air is.
 */
export function castNetTexture(): DataTexture {
  const S = 128;
  const N = 6;
  const ctx = paint(S, S, (c) => {
    c.strokeStyle = 'rgba(232,226,210,1)';
    c.lineWidth = 2.8;
    const cell = S / N;
    for (let k = -N; k <= 2 * N; k++) {
      c.beginPath();
      c.moveTo(k * cell, 0);
      c.lineTo(k * cell + S, S);
      c.moveTo(k * cell + S, 0);
      c.lineTo(k * cell, S);
      c.stroke();
    }
    c.fillStyle = 'rgba(214,206,186,1)';
    for (let i = 0; i <= N; i++) {
      for (let j = 0; j <= N; j++) {
        c.beginPath();
        c.arc(i * cell, j * cell, 2.8, 0, Math.PI * 2);
        c.fill();
      }
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

/**
 * A row of transplanted rice seen side-on: ten hills of leaves along the card (2.4 m of row), rooted at the
 * bottom, in greys the crop's shader tints for its stage (seedling, green, ripe, stubble). Dense at the root,
 * so the row keeps its body in the mipmaps; a few panicles arch over the top.
 */
export function riceRowTexture(seed: number): DataTexture {
  const W = 512;
  const H = 224;
  const rng = new Rng(seed);
  const ctx = paint(W, H, (c) => {
    for (let k = 0; k < 10; k++) {
      const x0 = ((k + 0.5) / 10) * W + rng.range(-4, 4);
      for (let i = 0; i < 24; i++) {
        const bx = x0 + rng.range(-5, 5);
        const tx = bx + rng.range(-40, 40);
        const ty = H * (1 - rng.range(0.55, 0.95));
        const w = rng.range(2, 3.6);
        const g = c.createLinearGradient(0, H, 0, ty);
        g.addColorStop(0, '#383838');
        g.addColorStop(0.5, css([1, 1, 1], rng.range(120, 160)));
        g.addColorStop(1, css([1, 1, 1], rng.range(200, 235)));
        c.fillStyle = g;
        c.beginPath();
        c.moveTo(bx - w, H);
        c.quadraticCurveTo(bx + (tx - bx) * 0.25 - w * 0.5, (H + ty) / 2, tx, ty);
        c.quadraticCurveTo(bx + (tx - bx) * 0.25 + w * 0.5, (H + ty) / 2, bx + w, H);
        c.fill();
      }
      // panicles, nodding over to one side from the tallest stems
      for (let i = 0; i < 2; i++) {
        const sx = x0 + rng.range(-6, 6);
        const top = H * 0.06 + rng.range(0, 10);
        const dir = rng.sign();
        c.strokeStyle = css([1, 1, 1], rng.range(215, 245));
        c.lineWidth = rng.range(2.2, 3);
        c.beginPath();
        c.moveTo(sx, H * 0.3);
        c.quadraticCurveTo(sx + dir * 4, top, sx + dir * rng.range(18, 28), top + rng.range(18, 30));
        c.stroke();
      }
    }
  });
  return toTexture(ctx, { bleed: true });
}

/**
 * The near rice, two cards in one texture, in greys the crop's shader tints for its stage. The left half
 * (u 0..0.5) is one hill of transplanted rice side-on: some thirty long narrow leaves fanning up and out from
 * a narrow foot, the longer ones arching over at the tip, dark at the foot and pale toward the light. The right
 * half (u 0.5..1) is one panicle laid straight along v (v 0 where it leaves its stem, 1 at its tip; the geometry
 * bends it): a rachis with short branches angled toward the tip, each crowded with plump grains, drawn twice as
 * wide as it should look (the ribbon it is laid on squeezes it), with a dense core for the mipmaps.
 */
export function riceHillTexture(seed: number): DataTexture {
  const W = 512;
  const H = 512;
  const rng = new Rng(seed);
  const ctx = paint(W, H, (c) => {
    // ---- the hill ----
    const cx = W / 4;
    for (let i = 0; i < 44; i++) {
      const bx = cx + rng.range(-16, 16);
      const reach = rng.range(-115, 115) * (0.35 + 0.65 * rng.next());
      const tall = rng.range(0.55, 0.98);
      const ty = H * (1 - tall);
      // the longer leaves arch over: their tip falls back below their highest point
      const droop = tall > 0.75 ? rng.range(10, 60) : rng.range(0, 14);
      const tx = bx + reach;
      const w = rng.range(2.4, 4.2);
      const g = c.createLinearGradient(0, H, 0, ty);
      // dark only at the very foot, where the leaves crowd into shade; light all the way up from there
      g.addColorStop(0, '#5a5a5a');
      g.addColorStop(0.2, css([1, 1, 1], rng.range(165, 190)));
      g.addColorStop(1, css([1, 1, 1], rng.range(215, 250)));
      c.fillStyle = g;
      const mx = bx + reach * 0.3;
      const my = ty + (H - ty) * 0.25;
      c.beginPath();
      c.moveTo(bx - w, H);
      c.quadraticCurveTo(mx - w * 0.6, my, tx, ty + droop);
      c.quadraticCurveTo(mx + w * 0.6, my, bx + w, H);
      c.fill();
    }
    // a dense core of stems at the foot, so the hill keeps its body far off
    c.fillStyle = '#6a6a6a';
    c.beginPath();
    c.moveTo(cx - 18, H);
    c.lineTo(cx - 6, H * 0.62);
    c.lineTo(cx + 6, H * 0.62);
    c.lineTo(cx + 18, H);
    c.fill();
    // ---- the panicle ----
    const px = W * 0.75;
    const top = 10;
    const bottom = H - 4;
    c.strokeStyle = '#bdbdbd';
    c.lineWidth = 7;
    c.beginPath();
    c.moveTo(px, bottom);
    c.lineTo(px, top + 30);
    c.stroke();
    // branches, alternating sides, longer near the panicle's base, angled toward its tip
    const branches = 13;
    for (let b = 0; b < branches; b++) {
      const t = b / (branches - 1);
      const y0 = bottom - 20 - t * (bottom - top - 60);
      const side = b % 2 ? 1 : -1;
      const len = (1 - 0.65 * t) * rng.range(70, 100);
      const ex = px + side * len * 0.55;
      const ey = y0 - len;
      // the grains along it, plump and pale, each with a darker edge
      const grains = Math.round(5 + 4 * (1 - t));
      for (let k = 0; k < grains; k++) {
        const f = (k + 1) / (grains + 0.5);
        const gx = px + (ex - px) * f + rng.range(-4, 4);
        const gy = y0 + (ey - y0) * f + rng.range(-4, 4);
        const a = Math.atan2(ey - y0, ex - px) + rng.range(-0.3, 0.3);
        c.fillStyle = css([1, 1, 1], rng.range(150, 175));
        c.beginPath();
        c.ellipse(gx, gy, 15, 8, a, 0, Math.PI * 2);
        c.fill();
        c.fillStyle = css([1, 1, 1], rng.range(205, 240));
        c.beginPath();
        c.ellipse(gx - 1, gy - 1, 12, 6, a, 0, Math.PI * 2);
        c.fill();
      }
    }
    // the tip: a last few grains in line
    for (let k = 0; k < 4; k++) {
      c.fillStyle = css([1, 1, 1], 220);
      c.beginPath();
      c.ellipse(px + rng.range(-3, 3), top + 10 + k * 16, 10, 8, Math.PI / 2, 0, Math.PI * 2);
      c.fill();
    }
  });
  return toTexture(ctx, { bleed: true });
}

/**
 * A row of ripening heads seen side-on, for the middling-far rice (laid over its row cards' tops): panicles
 * nodding over all along the 2.4 m of row, in greys the shader tints green or gold.
 */
export function riceHeadsTexture(seed: number): DataTexture {
  const W = 512;
  const H = 96;
  const rng = new Rng(seed);
  const ctx = paint(W, H, (c) => {
    c.lineCap = 'round';
    for (let i = 0; i < 46; i++) {
      const sx = rng.range(6, W - 6);
      const sy = rng.range(H * 0.15, H * 0.35);
      const dir = rng.sign();
      const len = rng.range(26, 40);
      // an arch over and down, grains crowding it
      const ex = sx + dir * len * 0.8;
      const ey = sy + len * rng.range(0.55, 0.9);
      for (let k = 0; k < 9; k++) {
        const t = (k + 0.5) / 9;
        const x = sx + (ex - sx) * t;
        const y = sy - Math.sin(Math.PI * t * 0.7) * 10 + (ey - sy) * t * t;
        c.fillStyle = css([1, 1, 1], rng.range(170, 235));
        c.beginPath();
        c.ellipse(x, y, 4.5, 3.2, rng.range(0, 3), 0, Math.PI * 2);
        c.fill();
      }
    }
  });
  return toTexture(ctx, { bleed: true });
}

/** Rice seen from above: crowns of leaves splayed from each hill in rows, with the water or soil between them. */
export function riceCanopyTexture(seed: number): DataTexture {
  const S = 256;
  const rng = new Rng(seed);
  const ctx = paint(S, S, (c) => {
    c.lineCap = 'round';
    // 10 hills along each of 8 rows, as the card's 2.4 m square holds them
    for (let row = 0; row < 8; row++) {
      for (let k = 0; k < 10; k++) {
        const cx = ((k + 0.5) / 10) * S + rng.range(-3, 3);
        const cy = ((row + 0.5) / 8) * S + rng.range(-3, 3);
        for (let i = 0; i < 11; i++) {
          const a = rng.range(0, Math.PI * 2);
          const len = rng.range(9, 19);
          c.strokeStyle = css([1, 1, 1], rng.range(130, 230));
          c.lineWidth = rng.range(1.4, 2.4);
          c.beginPath();
          c.moveTo(cx, cy);
          c.quadraticCurveTo(cx + Math.cos(a) * len * 0.5, cy + Math.sin(a) * len * 0.5 - 2, cx + Math.cos(a) * len, cy + Math.sin(a) * len);
          c.stroke();
        }
      }
    }
  });
  return toTexture(ctx, { bleed: true });
}

/**
 * A mustard plant in flower, side-on (the card is about 0.9 m by 1.1 m): blue-green lobed leaves low down,
 * branching stems, and racemes of small yellow flowers crowded at the tips, green pods below them.
 */
export function mustardTexture(seed: number): DataTexture {
  const S = 256;
  const rng = new Rng(seed);
  const ctx = paint(S, S, (c) => {
    c.lineCap = 'round';
    // broad lobed leaves at the foot
    for (let i = 0; i < 9; i++) {
      const x = S / 2 + rng.range(-70, 70);
      const y = S - rng.range(10, 70);
      c.fillStyle = rng.pick(['#4b6b44', '#557a4c', '#5f8456', '#456140']);
      c.beginPath();
      c.ellipse(x, y, rng.range(12, 22), rng.range(28, 44), rng.range(-0.9, 0.9), 0, Math.PI * 2);
      c.fill();
    }
    // stems branching toward the top, each ending in a raceme
    const tips: [number, number][] = [];
    for (let i = 0; i < 7; i++) {
      const bx = S / 2 + rng.range(-22, 22);
      const mx = bx + rng.range(-30, 30);
      const my = S * rng.range(0.45, 0.6);
      c.strokeStyle = rng.pick(['#5d7d3c', '#678a42', '#557236']);
      c.lineWidth = rng.range(2, 3.4);
      c.beginPath();
      c.moveTo(bx, S);
      c.quadraticCurveTo(bx, my + 30, mx, my);
      c.stroke();
      for (let j = 0; j < 3; j++) {
        const tx = mx + rng.range(-46, 46);
        const ty = rng.range(14, S * 0.4);
        c.lineWidth = rng.range(1.2, 2.2);
        c.beginPath();
        c.moveTo(mx, my);
        c.quadraticCurveTo(mx, (my + ty) / 2, tx, ty);
        c.stroke();
        tips.push([tx, ty]);
        // pods along the stalk below the flowers
        c.strokeStyle = '#7f9b48';
        c.lineWidth = 1;
        for (let p = 0; p < 6; p++) {
          const t = rng.range(0.15, 0.6);
          const px = tx + (mx - tx) * t;
          const py = ty + (my - ty) * t;
          c.beginPath();
          c.moveTo(px, py);
          c.lineTo(px + rng.range(-9, 9), py - rng.range(5, 11));
          c.stroke();
        }
        c.strokeStyle = rng.pick(['#5d7d3c', '#678a42', '#557236']);
      }
    }
    // the racemes: crowds of four-petalled yellow flowers, buds greener at the very top
    for (const [tx, ty] of tips) {
      for (let k = 0; k < 34; k++) {
        const a = rng.range(0, Math.PI * 2);
        const r = Math.sqrt(rng.next()) * rng.range(8, 14);
        c.fillStyle = k < 4 ? '#c8cf52' : rng.pick(['#f4d12a', '#efc31f', '#f7dc45', '#e6b51a']);
        c.beginPath();
        c.arc(tx + Math.cos(a) * r, ty + Math.sin(a) * r * 1.3 + 4, rng.range(2, 3.4), 0, Math.PI * 2);
        c.fill();
      }
    }
  });
  return toTexture(ctx, { bleed: true });
}

/**
 * One mustard raceme seen close (the near plants' flower heads), in the left three quarters: its stalk, green
 * pods angled up along it below, and above them a dome of small four-petalled yellow flowers, the buds greener at
 * the very top. The right quarter is opaque white, for the stems and leaves (their vertex colour shows through).
 */
export function mustardRacemeTexture(seed: number): DataTexture {
  const S = 128;
  const W = 96;
  const rng = new Rng(seed);
  const ctx = paint(S, S, (c) => {
    c.fillStyle = '#ffffff';
    c.fillRect(W + 8, 0, S - W - 8, S);
    c.lineCap = 'round';
    const cx = W / 2;
    c.strokeStyle = '#5f7f3a';
    c.lineWidth = 2.2;
    c.beginPath();
    c.moveTo(cx, S);
    c.lineTo(cx, S * 0.3);
    c.stroke();
    // the pods: slim, angled up from the stalk, longer lower down
    for (let p = 0; p < 16; p++) {
      const y = S - rng.range(4, S * 0.5);
      const side = p % 2 ? 1 : -1;
      const len = 10 + (y / S) * 14;
      c.strokeStyle = rng.pick(['#7c9a44', '#86a24a', '#6f8e3c']);
      c.lineWidth = rng.range(1.4, 2.2);
      c.beginPath();
      c.moveTo(cx, y);
      c.lineTo(cx + side * len * 0.55, y - len);
      c.stroke();
    }
    // the flowers: a dense core (it keeps its coverage through the mipmaps), then the petals round it
    c.fillStyle = '#e9bd1e';
    c.beginPath();
    c.ellipse(cx, S * 0.3, 14, 12, 0, 0, Math.PI * 2);
    c.fill();
    for (let k = 0; k < 46; k++) {
      const a = rng.range(0, Math.PI * 2);
      const r = Math.sqrt(rng.next()) * 30;
      const x = cx + Math.cos(a) * r;
      const y = S * 0.3 + Math.sin(a) * r * 0.75 + (r / 30) * 10;
      const size = rng.range(3.2, 4.6);
      const turn = rng.range(0, Math.PI / 2);
      c.fillStyle = rng.pick(['#f6d22b', '#f2c41f', '#f9de4a', '#ebb81a']);
      for (let q = 0; q < 4; q++) {
        const pa = turn + (q * Math.PI) / 2;
        c.beginPath();
        c.ellipse(x + Math.cos(pa) * size * 0.6, y + Math.sin(pa) * size * 0.6, size * 0.62, size * 0.4, pa, 0, Math.PI * 2);
        c.fill();
      }
      c.fillStyle = '#d99a12';
      c.beginPath();
      c.arc(x, y, 1, 0, Math.PI * 2);
      c.fill();
    }
    // the buds at the tip, closed and greener
    for (let k = 0; k < 10; k++) {
      c.fillStyle = rng.pick(['#c9cf55', '#b8c04a', '#d6d25a']);
      c.beginPath();
      c.arc(cx + rng.range(-7, 7), S * 0.3 - rng.range(12, 22), rng.range(1.8, 2.8), 0, Math.PI * 2);
      c.fill();
    }
  });
  return toTexture(ctx, { bleed: true });
}

/** A field of mustard in flower from above: crowded yellow racemes, the blue-green of the leaves showing between. */
export function mustardCanopyTexture(seed: number): DataTexture {
  const S = 256;
  const rng = new Rng(seed);
  const ctx = paint(S, S, (c) => {
    c.lineCap = 'round';
    for (let i = 0; i < 70; i++) {
      c.strokeStyle = rng.pick(['#4b6b44', '#557a4c', '#5f8456']);
      c.lineWidth = rng.range(3, 6);
      const x = rng.range(0, S);
      const y = rng.range(0, S);
      const a = rng.range(0, Math.PI * 2);
      c.beginPath();
      c.moveTo(x, y);
      c.lineTo(x + Math.cos(a) * rng.range(10, 22), y + Math.sin(a) * rng.range(10, 22));
      c.stroke();
    }
    for (let i = 0; i < 90; i++) {
      const x = rng.range(8, S - 8);
      const y = rng.range(8, S - 8);
      const r = rng.range(7, 13);
      for (let k = 0; k < 22; k++) {
        const a = rng.range(0, Math.PI * 2);
        const d = Math.sqrt(rng.next()) * r;
        c.fillStyle = rng.pick(['#f4d12a', '#efc31f', '#f7dc45', '#e6b51a', '#d9cf4a']);
        c.beginPath();
        c.arc(x + Math.cos(a) * d, y + Math.sin(a) * d, rng.range(1.8, 3), 0, Math.PI * 2);
        c.fill();
      }
    }
  });
  return toTexture(ctx, { bleed: true });
}

/**
 * Old Bengal brickwork: thin, hand-made bricks in running courses, each its own shade from dull red to
 * burnt purple and pale salmon, some edges crumbled, set in grey-white lime mortar. Tiles; one tile is
 * eight courses of about 7.5 cm with their joints (≈0.6 m) and three bricks' length across. Comes with a
 * normal map, so the joints sink and worn faces dip.
 */
export function brickTexture(seed: number): { map: DataTexture; normal: DataTexture } {
  const S = 256;
  const COURSES = 8;
  const PER = 3;
  const rng = new Rng(seed);
  const shades = ['#8a4a34', '#94563e', '#7f4434', '#9e6048', '#7a4234', '#a56c54', '#8f5240', '#734036'];
  const bricks: { x: number; y: number; w: number; h: number; c: string; wear: number }[] = [];
  const ch = S / COURSES;
  const cw = S / PER;
  for (let r = 0; r < COURSES; r++) {
    const shift = r % 2 ? cw / 2 : 0;
    for (let k = -1; k < PER; k++) {
      const x = k * cw + shift;
      bricks.push({ x: x + 2.5, y: r * ch + 2.5, w: cw - 5 + rng.range(-2, 1), h: ch - 5 + rng.range(-1, 0.5), c: rng.pick(shades), wear: rng.next() });
    }
  }
  const draw = (c: Ctx, height: boolean) => {
    c.fillStyle = height ? '#303030' : '#b8b2a4';
    c.fillRect(0, 0, S, S);
    for (const b of bricks) {
      // drawn twice where it wraps, so the tile repeats seamlessly
      for (const ox of [0, S]) {
        if (b.x + ox > S || b.x + b.w + ox < 0) continue;
        if (height) {
          c.fillStyle = `rgb(${190 - b.wear * 50},${190 - b.wear * 50},${190 - b.wear * 50})`;
        } else c.fillStyle = b.c;
        c.beginPath();
        c.roundRect(b.x + ox - (ox ? S : 0), b.y, b.w, b.h, 2 + b.wear * 3);
        c.fill();
      }
    }
    // grit, pits and crumbled corners
    const r2 = new Rng(seed + 5);
    for (let i = 0; i < 1800; i++) {
      const x = r2.range(0, S);
      const y = r2.range(0, S);
      const v = r2.range(-1, 1);
      c.fillStyle = height ? `rgba(${v > 0 ? 255 : 0},${v > 0 ? 255 : 0},${v > 0 ? 255 : 0},${Math.abs(v) * 0.18})` : `rgba(${v > 0 ? 230 : 40},${v > 0 ? 200 : 25},${v > 0 ? 170 : 20},${Math.abs(v) * 0.16})`;
      c.fillRect(x, y, r2.range(1, 3), r2.range(1, 3));
    }
  };
  const ctx = paint(S, S, (c) => draw(c, false));
  const height = paint(S, S, (c) => draw(c, true));
  const map = toTexture(ctx, { repeat: true });
  return { map, normal: normalFromHeight(height, 3) };
}

/**
 * Lime plaster on an old wall, washed a pale ochre long ago: mottled where the wash has worn, streaked
 * dark by years of rain running down, cracked, and fallen away in patches to the brick beneath. Tiles
 * (≈2.5 m). With a normal map: the cracks and the edges of the fallen patches stand in relief.
 */
export function plasterTexture(seed: number, options: { white?: boolean; fallen?: boolean } = {}): { map: DataTexture; normal: DataTexture } {
  const S = 512;
  const rng = new Rng(seed);
  const white = options.white === true;
  // two fallen patches a tile, ragged-edged, so the repeat does not show as a pattern (none on a wall kept up)
  const patches = Array.from({ length: options.fallen === false ? 0 : 2 }, () => {
    const cx = rng.range(60, S - 60);
    const cy = rng.range(60, S - 60);
    const r = rng.range(26, 54);
    return Array.from({ length: 14 }, (_, k) => {
      const a = (k / 14) * Math.PI * 2;
      const rr = r * rng.range(0.55, 1.15);
      return [cx + Math.cos(a) * rr * 1.3, cy + Math.sin(a) * rr * 0.8] as const;
    });
  });
  const cracks = Array.from({ length: 5 }, () => {
    const pts: [number, number][] = [[rng.range(0, S), rng.range(0, S)]];
    for (let k = 0; k < 7; k++) {
      const [x, y] = pts[pts.length - 1];
      pts.push([x + rng.range(-22, 22), y + rng.range(8, 30)]);
    }
    return pts;
  });
  const streaks = Array.from({ length: 70 }, () => ({ x: rng.range(0, S), y: rng.range(-S * 0.2, S * 0.6), w: rng.range(2, 14), l: rng.range(40, 260), a: rng.range(0.04, 0.16) }));
  const draw = (c: Ctx, height: boolean) => {
    c.fillStyle = height ? '#9a9a9a' : white ? '#f0ede4' : '#d9c9a6';
    c.fillRect(0, 0, S, S);
    if (!height) {
      // the wash worn unevenly (a fresh whitewash only a little)
      const r2 = new Rng(seed + 3);
      const tones = white
        ? ['rgba(226,222,212,0.22)', 'rgba(250,248,242,0.25)', 'rgba(214,210,200,0.15)', 'rgba(236,232,222,0.25)']
        : ['rgba(196,176,140,0.25)', 'rgba(232,220,196,0.25)', 'rgba(180,160,128,0.2)', 'rgba(205,190,160,0.3)'];
      for (let i = 0; i < 260; i++) {
        c.fillStyle = r2.pick(tones);
        c.beginPath();
        c.ellipse(r2.range(0, S), r2.range(0, S), r2.range(10, 50), r2.range(8, 40), r2.range(0, 3), 0, Math.PI * 2);
        c.fill();
      }
      // rain stains running down from the coping
      for (const s of streaks) {
        const g = c.createLinearGradient(0, s.y, 0, s.y + s.l);
        g.addColorStop(0, `rgba(60,58,48,${white ? s.a * 0.5 : s.a})`);
        g.addColorStop(1, 'rgba(60,58,48,0)');
        c.fillStyle = g;
        c.fillRect(s.x, s.y, s.w, s.l);
      }
    }
    // fallen patches: the brick beneath, its courses showing through what is left of the wash
    for (const p of patches) {
      const path = () => {
        c.beginPath();
        p.forEach(([x, y], k) => (k ? c.lineTo(x, y) : c.moveTo(x, y)));
        c.closePath();
      };
      c.save();
      path();
      c.clip();
      c.fillStyle = height ? '#727272' : '#a07a62';
      c.fillRect(0, 0, S, S);
      c.strokeStyle = height ? '#5a5a5a' : 'rgba(200,190,170,0.7)';
      c.lineWidth = 1.5;
      for (let y = 0; y < S; y += 8) {
        c.beginPath();
        c.moveTo(0, y);
        c.lineTo(S, y);
        c.stroke();
      }
      c.restore();
      // the broken edge of the plaster round it
      c.strokeStyle = height ? '#b4b4b4' : 'rgba(150,136,108,0.45)';
      c.lineWidth = 1.5;
      path();
      c.stroke();
    }
    // hairline cracks
    c.strokeStyle = height ? '#6a6a6a' : 'rgba(90,80,62,0.35)';
    c.lineWidth = 0.8;
    for (const pts of cracks) {
      c.beginPath();
      c.moveTo(pts[0][0], pts[0][1]);
      for (const [x, y] of pts.slice(1)) c.lineTo(x, y);
      c.stroke();
    }
  };
  const ctx = paint(S, S, (c) => draw(c, false));
  const height = paint(S, S, (c) => draw(c, true));
  return { map: toTexture(ctx, { repeat: true }), normal: normalFromHeight(height, 2) };
}

/** A printed cotton for a kameez: small sprigs of flowers scattered over a soft ground, a fine thread showing. */
export function printTexture(ground: string, sprig: string, leaf: string, seed: number): DataTexture {
  const S = 128;
  const rng = new Rng(seed);
  const ctx = paint(S, S, (c) => {
    c.fillStyle = ground;
    c.fillRect(0, 0, S, S);
    c.globalAlpha = 0.08;
    c.fillStyle = '#000000';
    for (let y = 0; y < S; y += 2) c.fillRect(0, y, S, 1);
    c.globalAlpha = 1;
    for (let i = 0; i < 14; i++) {
      const x = rng.range(0, S);
      const y = rng.range(0, S);
      for (const [ox, oy] of [
        [0, 0],
        [S, 0],
        [0, S],
        [-S, 0],
        [0, -S],
      ]) {
        c.fillStyle = leaf;
        c.beginPath();
        c.ellipse(x + ox + 4, y + oy + 3, 3, 1.4, 0.6, 0, Math.PI * 2);
        c.fill();
        c.fillStyle = sprig;
        for (let k = 0; k < 5; k++) {
          const a = (k / 5) * Math.PI * 2;
          c.beginPath();
          c.arc(x + ox + Math.cos(a) * 2.4, y + oy + Math.sin(a) * 2.4, 1.6, 0, Math.PI * 2);
          c.fill();
        }
      }
    }
  });
  return toTexture(ctx, { repeat: true });
}


/**
 * A railway's bed seen from above, along v: grey-brown ballast stones packed round dark timber-and-concrete
 * sleepers every 0.7 m (one repeat is two sleepers, 1.4 m), the rust-brown wear down the rails' lines. Tiles along v.
 */
export function trackTexture(): DataTexture {
  const W = 128;
  const H = 256;
  const rng = new Rng(91);
  const ctx = paint(W, H, (c) => {
    c.fillStyle = 'rgb(112,104,94)';
    c.fillRect(0, 0, W, H);
    for (let i = 0; i < 5200; i++) {
      const v = rng.int(70, 150);
      c.fillStyle = `rgba(${v + 6},${v},${v - 8},0.8)`;
      c.fillRect(rng.range(0, W), rng.range(0, H), rng.range(1, 3.5), rng.range(1, 3));
    }
    // the sleepers across the bed, a little short of its edges
    for (const y of [H * 0.25, H * 0.75]) {
      c.fillStyle = 'rgb(78,72,66)';
      c.fillRect(W * 0.12, y - 10, W * 0.76, 20);
      c.fillStyle = 'rgba(40,36,32,0.5)';
      c.fillRect(W * 0.12, y + 7, W * 0.76, 3);
    }
    // rust along where the rails run
    for (const x of [0.36, 0.64]) {
      c.fillStyle = 'rgba(120,70,40,0.35)';
      c.fillRect(W * x - 5, 0, 10, H);
    }
  });
  return toTexture(ctx, { repeat: true });
}

/** The roads' surfaces, side by side in one texture (world/roads.ts draws a cell of roads in one call). */
export const ROAD_SURFACES = ['asphalt', 'brick', 'earth'] as const;

/**
 * The roads' surfaces side by side, each across its road's width (a third of u: one edge to the other) and
 * 3 m along it (v): bitumen with worn wheel tracks and crumbling edges; herringbone brick (HBB, the village
 * roads) in dusty mortar with a brick-on-edge border; bare earth with ruts and grass along the sides.
 */
export function roadAtlas(): DataTexture {
  const W = 128;
  const H = 256;
  const ctx = paint(W * ROAD_SURFACES.length, H, (c) => {
    ROAD_SURFACES.forEach((surface, i) => {
      c.save();
      c.translate(i * W, 0);
      c.beginPath();
      c.rect(0, 0, W, H);
      c.clip();
      paintRoad(c, surface, W, H);
      c.restore();
    });
  });
  return toTexture(ctx, { repeat: true });
}

function paintRoad(c: Ctx, surface: (typeof ROAD_SURFACES)[number], W: number, H: number): void {
  const rng = new Rng(surface === 'asphalt' ? 71 : surface === 'brick' ? 72 : 73);
  {
    if (surface === 'asphalt') {
      c.fillStyle = 'rgb(74,73,71)';
      c.fillRect(0, 0, W, H);
      // aggregate: fine light and dark speckle
      for (let i = 0; i < 2600; i++) {
        const v = rng.int(50, 120);
        c.fillStyle = `rgba(${v},${v},${v - 4},0.55)`;
        c.fillRect(rng.range(0, W), rng.range(0, H), rng.range(0.6, 1.8), rng.range(0.6, 1.8));
      }
      // the wheels have polished two lighter tracks each way
      for (const x of [0.22, 0.38, 0.62, 0.78]) {
        const g = c.createLinearGradient((x - 0.07) * W, 0, (x + 0.07) * W, 0);
        g.addColorStop(0, 'rgba(120,118,112,0)');
        g.addColorStop(0.5, 'rgba(120,118,112,0.28)');
        g.addColorStop(1, 'rgba(120,118,112,0)');
        c.fillStyle = g;
        c.fillRect((x - 0.07) * W, 0, 0.14 * W, H);
      }
      // patches and cracks
      for (let i = 0; i < 6; i++) {
        c.fillStyle = `rgba(${rng.int(40, 60)},${rng.int(40, 58)},${rng.int(38, 55)},0.6)`;
        c.fillRect(rng.range(0.1, 0.7) * W, rng.range(0, H), rng.range(8, 30), rng.range(10, 40));
      }
      c.strokeStyle = 'rgba(30,30,28,0.5)';
      for (let i = 0; i < 10; i++) {
        c.beginPath();
        let x = rng.range(0, W);
        let y = rng.range(0, H);
        c.moveTo(x, y);
        for (let k = 0; k < 5; k++) c.lineTo((x += rng.range(-8, 8)), (y += rng.range(-10, 10)));
        c.stroke();
      }
      // crumbling edges going to dust
      for (const [x0, dir] of [
        [0, 1],
        [W, -1],
      ] as const) {
        for (let y = 0; y < H; y += 2) {
          const w = rng.range(2, 9);
          c.fillStyle = `rgba(${rng.int(120, 150)},${rng.int(108, 128)},${rng.int(84, 100)},0.85)`;
          c.fillRect(dir > 0 ? x0 : x0 - w, y, w, 2);
        }
      }
    } else if (surface === 'brick') {
      c.fillStyle = 'rgb(150,124,96)';
      c.fillRect(0, 0, W, H);
      // herringbone: bricks 8 × 4 texels at ±45°, in mortar
      const B = 9;
      for (let y = -2 * B; y < H + 2 * B; y += B) {
        for (let x = -2 * B; x < W + 2 * B; x += B * 2) {
          for (const flip of [0, 1]) {
            // old bricks, sun-bleached and dusty: a pale terracotta, some greyer, some still red
            const k = rng.next();
            const r = rng.int(150, 182);
            const g = rng.int(92, 112) - (k > 0.85 ? 18 : 0);
            const b = rng.int(70, 88) - (k > 0.85 ? 14 : 0);
            c.save();
            c.translate(x + flip * B, y + (flip ? B / 2 : 0));
            c.rotate(flip ? -Math.PI / 4 : Math.PI / 4);
            c.fillStyle = `rgb(${r},${g},${b})`;
            c.fillRect(-B * 0.62, -B * 0.24, B * 1.24, B * 0.48);
            c.restore();
          }
        }
      }
      // dust and wear down the middle
      const g = c.createLinearGradient(0, 0, W, 0);
      g.addColorStop(0, 'rgba(170,150,120,0)');
      g.addColorStop(0.5, 'rgba(176,160,134,0.38)');
      g.addColorStop(1, 'rgba(170,150,120,0)');
      c.fillStyle = g;
      c.fillRect(0, 0, W, H);
      // the border: bricks laid on edge along both sides
      for (const x0 of [0, W - 10]) {
        for (let y = 0; y < H; y += 5) {
          c.fillStyle = `rgb(${rng.int(140, 170)},${rng.int(84, 104)},${rng.int(64, 80)})`;
          c.fillRect(x0 + 1, y + 1, 8, 3.5);
        }
      }
    } else {
      c.fillStyle = 'rgb(128,104,76)';
      c.fillRect(0, 0, W, H);
      for (let i = 0; i < 1800; i++) {
        const v = rng.int(-24, 24);
        c.fillStyle = `rgba(${128 + v},${104 + v},${76 + v},0.6)`;
        c.fillRect(rng.range(0, W), rng.range(0, H), rng.range(1, 4), rng.range(1, 4));
      }
      // two ruts worn by cartwheels and feet
      for (const x of [0.3, 0.7]) {
        const g = c.createLinearGradient((x - 0.1) * W, 0, (x + 0.1) * W, 0);
        g.addColorStop(0, 'rgba(90,70,50,0)');
        g.addColorStop(0.5, 'rgba(90,70,50,0.45)');
        g.addColorStop(1, 'rgba(90,70,50,0)');
        c.fillStyle = g;
        c.fillRect((x - 0.1) * W, 0, 0.2 * W, H);
      }
      // grass along both sides, and a strip down the middle
      for (let i = 0; i < 900; i++) {
        const side = rng.next();
        const x = side < 0.4 ? rng.range(0, 0.14) * W : side < 0.8 ? rng.range(0.86, 1) * W : rng.range(0.46, 0.54) * W;
        c.fillStyle = `rgba(${rng.int(60, 90)},${rng.int(90, 120)},${rng.int(40, 60)},0.8)`;
        c.fillRect(x, rng.range(0, H), 1.2, rng.range(2, 5));
      }
    }
  }
}
