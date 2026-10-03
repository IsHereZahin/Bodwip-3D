import {
  DataArrayTexture,
  DataTexture,
  LinearFilter,
  LinearMipmapLinearFilter,
  NoColorSpace,
  RepeatWrapping,
  SRGBColorSpace,
  Vector3,
} from 'three';
import type { Texture } from 'three';

// Photo-scanned surfaces (CC0, Poly Haven), served from public/textures. Everything else in the scene
// is still made in code; these give the ground and the bark their close-up grain. If they cannot be
// loaded the scene falls back to its painted colours.

/** Terrain layers, in the order the terrain's splat weights use. */
export const GROUND_LAYERS = ['grass', 'dirt', 'mud', 'sand', 'pebbles'] as const;

const SIZE = 1024;

export interface GroundSet {
  /** One layer per entry of GROUND_LAYERS. */
  color: DataArrayTexture;
  normal: DataArrayTexture;
  /** Average colour of each layer (linear), so the terrain can keep its own palette and borrow the detail. */
  means: Vector3[];
}

export interface Surfaces {
  ground: GroundSet | null;
  bark: { color: Texture; normal: Texture } | null;
}

const urlOf = (name: string) => `${import.meta.env.BASE_URL}textures/${name}.webp`;

/** Decoded RGBA pixels of one texture, rows flipped so that v = 1 is the image's top (as for image textures). */
async function pixels(name: string, normal: boolean): Promise<Uint8Array> {
  const res = await fetch(urlOf(name));
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
  const bitmap = await createImageBitmap(await res.blob(), { colorSpaceConversion: normal ? 'none' : 'default' });
  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('2D canvas unavailable');
  ctx.drawImage(bitmap, 0, 0, SIZE, SIZE);
  bitmap.close();
  const src = ctx.getImageData(0, 0, SIZE, SIZE).data;
  const out = new Uint8Array(SIZE * SIZE * 4);
  const row = SIZE * 4;
  for (let y = 0; y < SIZE; y++) out.set(src.subarray((SIZE - 1 - y) * row, (SIZE - y) * row), y * row);
  return out;
}

function setup<T extends Texture>(t: T, srgb: boolean, anisotropy: number): T {
  t.colorSpace = srgb ? SRGBColorSpace : NoColorSpace;
  t.wrapS = t.wrapT = RepeatWrapping;
  t.magFilter = LinearFilter;
  t.minFilter = LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = anisotropy;
  t.needsUpdate = true;
  return t;
}

function stack(layers: Uint8Array[], srgb: boolean, anisotropy: number): DataArrayTexture {
  const data = new Uint8Array(SIZE * SIZE * 4 * layers.length);
  layers.forEach((px, i) => data.set(px, i * SIZE * SIZE * 4));
  return setup(new DataArrayTexture(data, SIZE, SIZE, layers.length), srgb, anisotropy);
}

const srgbToLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));

/** Mean linear colour, from every 7th texel. */
function meanColor(px: Uint8Array): Vector3 {
  const m = new Vector3();
  let n = 0;
  for (let i = 0; i < px.length; i += 28) {
    m.x += srgbToLinear(px[i] / 255);
    m.y += srgbToLinear(px[i + 1] / 255);
    m.z += srgbToLinear(px[i + 2] / 255);
    n++;
  }
  return m.divideScalar(n);
}

async function loadGround(anisotropy: number): Promise<GroundSet> {
  const [colors, normals] = await Promise.all([
    Promise.all(GROUND_LAYERS.map((l) => pixels(`${l}_c`, false))),
    Promise.all(GROUND_LAYERS.map((l) => pixels(`${l}_n`, true))),
  ]);
  return { color: stack(colors, true, anisotropy), normal: stack(normals, false, anisotropy), means: colors.map(meanColor) };
}

async function loadBark(anisotropy: number): Promise<{ color: Texture; normal: Texture }> {
  const [c, n] = await Promise.all([pixels('bark_c', false), pixels('bark_n', true)]);
  return {
    color: setup(new DataTexture(c, SIZE, SIZE), true, anisotropy),
    normal: setup(new DataTexture(n, SIZE, SIZE), false, anisotropy),
  };
}

/** Loads every photo texture; a set that fails is left out (and the scene uses its painted look there). */
export async function loadSurfaces(anisotropy: number): Promise<Surfaces> {
  const [ground, bark] = await Promise.allSettled([loadGround(anisotropy), loadBark(anisotropy)]);
  for (const r of [ground, bark]) if (r.status === 'rejected') console.warn('surface textures unavailable:', r.reason);
  return {
    ground: ground.status === 'fulfilled' ? ground.value : null,
    bark: bark.status === 'fulfilled' ? bark.value : null,
  };
}
