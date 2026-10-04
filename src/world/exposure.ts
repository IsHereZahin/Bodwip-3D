import { CELL, GRID_H, GRID_W, KIND, LAYERS, fcol, frow } from '../geo/data';

// How open each stretch of the sea's water is to the Bay's swell: 1 on the open sea and the coasts that face
// it, falling away as the swell works its way into narrower water (round Sonadia, up the channel's mouth, into
// the creeks), so the channel and the Kohelia lie calm while the beaches facing the Bay take the surf. The
// open Bay is the sea at the map's west and south edges. Over open water a swell carries on undiminished; in
// a narrow channel it dies within a few hundred metres. How open the water round a point is: the share of
// the sea's cells within OPEN_RADIUS of it [মডেল: no wave model of the coast exists; the lengths are chosen so
// the channel at Gorakghata is all but still].

/** The radius (world m) over which a point's water is judged open or narrow. */
const OPEN_RADIUS = 800;
/** How far (world m) the swell runs to fall to 1/e: in the narrowest water, and on the open sea. */
const DECAY_NARROW = 150;
const DECAY_OPEN = 30000;

/** Each cell's exposure (0..1), rows north to south as the map's. */
export const EXPOSURE: Float32Array = (() => {
  const W = GRID_W;
  const H = GRID_H;
  const n = W * H;
  const sea = new Uint8Array(n);
  const deep = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const k = LAYERS.kind[i] & 0x7f;
    sea[i] = k === KIND.sea || k === KIND.tidal || k === KIND.mangrove ? 1 : 0;
    deep[i] = k === KIND.sea ? 1 : 0;
  }
  // the share of open water round each cell (the flats and mangroves the tide covers break the swell up, so
  // they do not count), from a summed-area table
  const sat = new Float64Array((W + 1) * (H + 1));
  for (let r = 0; r < H; r++) {
    let row = 0;
    for (let c = 0; c < W; c++) {
      row += deep[r * W + c];
      sat[(r + 1) * (W + 1) + c + 1] = sat[r * (W + 1) + c + 1] + row;
    }
  }
  const R = Math.round(OPEN_RADIUS / CELL);
  // the cost of a step through each cell: its length over the swell's decay length there
  const cost = new Float32Array(n);
  for (let r = 0; r < H; r++) {
    const r0 = Math.max(0, r - R);
    const r1 = Math.min(H, r + R + 1);
    for (let c = 0; c < W; c++) {
      const i = r * W + c;
      if (!sea[i]) continue;
      const c0 = Math.max(0, c - R);
      const c1 = Math.min(W, c + R + 1);
      const count = sat[r1 * (W + 1) + c1] - sat[r0 * (W + 1) + c1] - sat[r1 * (W + 1) + c0] + sat[r0 * (W + 1) + c0];
      const open = count / ((r1 - r0) * (c1 - c0));
      const t = Math.min(1, Math.max(0, (open - 0.5) / 0.4));
      const decay = DECAY_NARROW * (DECAY_OPEN / DECAY_NARROW) ** (t * t * (3 - 2 * t));
      cost[i] = CELL / decay;
    }
  }
  // the least total cost from the open Bay through the sea's cells (−log of the exposure), by chamfer sweeps
  const dist = new Float32Array(n).fill(Infinity);
  for (let r = 0; r < H; r++) if (sea[r * W]) dist[r * W] = 0;
  for (let c = 0; c < W; c++) if (sea[(H - 1) * W + c]) dist[(H - 1) * W + c] = 0;
  const D = Math.SQRT2;
  for (let pass = 0; pass < 4; pass++) {
    for (let r = 0; r < H; r++) {
      for (let c = 0; c < W; c++) {
        const i = r * W + c;
        if (!sea[i]) continue;
        const k = cost[i];
        let d = dist[i];
        if (c > 0) d = Math.min(d, dist[i - 1] + k);
        if (r > 0) d = Math.min(d, dist[i - W] + k);
        if (c > 0 && r > 0) d = Math.min(d, dist[i - W - 1] + k * D);
        if (c < W - 1 && r > 0) d = Math.min(d, dist[i - W + 1] + k * D);
        dist[i] = d;
      }
    }
    for (let r = H - 1; r >= 0; r--) {
      for (let c = W - 1; c >= 0; c--) {
        const i = r * W + c;
        if (!sea[i]) continue;
        const k = cost[i];
        let d = dist[i];
        if (c < W - 1) d = Math.min(d, dist[i + 1] + k);
        if (r < H - 1) d = Math.min(d, dist[i + W] + k);
        if (c < W - 1 && r < H - 1) d = Math.min(d, dist[i + W + 1] + k * D);
        if (c > 0 && r < H - 1) d = Math.min(d, dist[i + W - 1] + k * D);
        dist[i] = d;
      }
    }
  }
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = Number.isFinite(dist[i]) ? Math.exp(-dist[i]) : 0;
  return out;
})();

/** Exposure at a world point, bilinear between cells (0 off the sea's water). */
export function exposureAt(x: number, z: number): number {
  const fc = Math.min(GRID_W - 1.0001, Math.max(0, fcol(x)));
  const fr = Math.min(GRID_H - 1.0001, Math.max(0, frow(z)));
  const c = Math.floor(fc);
  const r = Math.floor(fr);
  const tx = fc - c;
  const ty = fr - r;
  const i = r * GRID_W + c;
  const a = EXPOSURE[i] * (1 - tx) + EXPOSURE[i + 1] * tx;
  const b = EXPOSURE[i + GRID_W] * (1 - tx) + EXPOSURE[i + GRID_W + 1] * tx;
  return a * (1 - ty) + b * ty;
}
