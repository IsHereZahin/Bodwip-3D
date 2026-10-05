import { DataTexture, DataUtils, HalfFloatType, LinearFilter, RedFormat } from 'three';
import { G } from '../core/globals';
import { EDGE_MARGIN } from '../render/glsl';
import { corridorDistance } from './geography';
import { WORLD } from './plan';

// The land the village keeps to, as the shaders see it: how far each place lies from the boat's way and the
// bil (geography.ts corridorDistance), over the world and the margin round it, so the haze can thicken past
// `CORRIDOR.clear` (glsl.ts applyAtmosphere) and the land beyond fade away.

/** The map's cells (m). */
const CELL = 8;

/** Fills `G.tCorridor` / `G.uCorridorMap` once, at load. */
export function buildCorridorMap(): void {
  const x0 = WORLD.x0 - EDGE_MARGIN;
  const x1 = WORLD.x1 + EDGE_MARGIN;
  const z0 = WORLD.z0 - EDGE_MARGIN;
  const z1 = WORLD.z1 + EDGE_MARGIN;
  const w = Math.ceil((x1 - x0) / CELL);
  const h = Math.ceil((z1 - z0) / CELL);
  const data = new Uint16Array(w * h);
  // u runs west to east (x falling), v north to south (z falling), as the waters' level map does
  for (let r = 0; r < h; r++) {
    const z = z1 - (r + 0.5) * CELL;
    for (let c = 0; c < w; c++) {
      const x = x1 - (c + 0.5) * CELL;
      // past the edges of the field it is measured on, on outward from them
      const out = Math.hypot(Math.max(0, WORLD.x0 - x, x - WORLD.x1), Math.max(0, WORLD.z0 - z, z - WORLD.z1));
      data[r * w + c] = DataUtils.toHalfFloat(Math.min(4000, corridorDistance(x, z) + out));
    }
  }
  const texture = new DataTexture(data, w, h, RedFormat, HalfFloatType);
  texture.minFilter = texture.magFilter = LinearFilter;
  texture.needsUpdate = true;
  G.tCorridor.value = texture;
  G.uCorridorMap.value.set(x1, z1, 1 / (x1 - x0), 1 / (z1 - z0));
}
