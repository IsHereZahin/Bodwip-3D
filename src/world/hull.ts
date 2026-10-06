import { Vector3 } from 'three';
import { smoothstep } from '../core/mathx';
import { MeshBuilder, mixRgb, scaleRgb, type RGB } from '../render/builder';

/** A Bengal country boat: long and narrow, with bow and stern sweeping up high. Bow points to +z. */
export interface HullShape {
  /** Overall length (m). */
  len: number;
  /** Half of the widest beam. */
  beam: number;
  keelMid: number;
  keelRise: number;
  sheerMid: number;
  sheerRise: number;
}

export const HERO_HULL: HullShape = { len: 9, beam: 0.85, keelMid: -0.32, keelRise: 0.9, sheerMid: 0.45, sheerRise: 1.1 };
/**
 * How far below her shape's own zero the hero floats (m): laden with her cargo and the boatman she sits deep,
 * a hand's breadth of freeboard less, so her waterline is at this height in her own frame.
 */
export const HERO_SINK = 0.08;

/** The hero's half-beam where the water meets her, at s in [0, 1] from stern to bow. */
export const heroBeamAtWater = (s: number) => hullHalfWidthAt(HERO_HULL, s, HERO_SINK);

/** s in [0, 1] from stern to bow. */
export function hullStation(shape: HullShape, s: number): { keel: number; sheer: number; hb: number } {
  const a = Math.abs(2 * s - 1);
  return {
    keel: shape.keelMid + shape.keelRise * Math.pow(a, 2.5),
    sheer: shape.sheerMid + shape.sheerRise * Math.pow(a, 3),
    hb: shape.beam * Math.pow(Math.max(1 - Math.pow(a, 2.2), 0), 0.6),
  };
}

/** Half-width of the hull at height y (0 where y is outside the hull at this station). */
export function hullHalfWidthAt(shape: HullShape, s: number, y: number): number {
  const { keel, sheer, hb } = hullStation(shape, s);
  if (y <= keel || sheer <= keel) return 0;
  const c = 1 - Math.min((y - keel) / (sheer - keel), 1);
  return hb * Math.pow(Math.sqrt(Math.max(1 - c * c, 0)), 0.8);
}

/** GLSL twin of hullHalfWidthAt(…, y = waterline): the water shader cuts the river out of the hull with it. */
export function hullWaterlineGlsl(shape: HullShape, waterline = 0): string {
  const f = (n: number) => n.toFixed(4);
  return /* glsl */ `
float hullHalfBeamAtWater(float s) {
  float a = abs(s);
  float keel = ${f(shape.keelMid)} + ${f(shape.keelRise)} * pow(a, 2.5);
  if (keel >= ${f(waterline)}) return 0.0;
  float sheer = ${f(shape.sheerMid)} + ${f(shape.sheerRise)} * pow(a, 3.0);
  float hb = ${f(shape.beam)} * pow(max(1.0 - pow(a, 2.2), 0.0), 0.6);
  float c = 1.0 - (${f(waterline)} - keel) / (sheer - keel);
  return hb * pow(sqrt(max(1.0 - c * c, 0.0)), 0.8);
}`;
}

/**
 * Hull skin as one surface running from the gunwale on one side, under the keel, to the other.
 * u runs along the boat (planks), v up the side; `band` paints a strip below the gunwale, and `wet`
 * darkens the wood just above the waterline, where the river keeps it soaked.
 */
export function buildHull(b: MeshBuilder, shape: HullShape, colors: { tar: RGB; top: RGB; band?: RGB; wet?: boolean }, waterline = 0): void {
  const S = 48;
  const A = 20;
  const start = b.vertexCount;
  const p = new Vector3();
  const n = new Vector3();
  for (let i = 0; i <= S; i++) {
    const s = i / S;
    const { keel, sheer, hb } = hullStation(shape, s);
    const z = (s - 0.5) * shape.len;
    for (let j = 0; j <= A; j++) {
      const a = (j / A) * 2 - 1;
      const phi = Math.abs(a) * (Math.PI / 2);
      const side = a < 0 ? -1 : 1;
      p.set(side * hb * Math.pow(Math.sin(phi), 0.8), keel + (sheer - keel) * (1 - Math.cos(phi)), z);
      n.set(side * Math.sin(phi), -Math.cos(phi) + 0.2, 0).normalize();
      const up = Math.abs(a);
      let c = mixRgb(colors.tar, colors.top, Math.pow(up, 3));
      if (colors.band && up > 0.8 && up < 0.92) c = colors.band;
      if (colors.wet) c = scaleRgb(c, 1 - 0.4 * smoothstep(waterline + 0.14, waterline, p.y));
      b.vertex(p, n, z * 0.45, up * 1.6, c);
    }
  }
  // wound to face outward, as her normals do (wound inward, her outside was a back face: the near side of a
  // boat drawn one-sided vanished, and a two-sided one was lit as if from within); her inside is the back face,
  // so a boat's material must be two-sided
  for (let i = 0; i < S; i++) {
    for (let j = 0; j < A; j++) {
      const a = start + i * (A + 1) + j;
      const c = a + A + 1;
      b.quad(a, a + 1, c + 1, c);
    }
  }
}

