import { SRGBColorSpace, TextureLoader } from 'three';
import type { Texture } from 'three';

// The people's bodies, built offline from MakeHuman's CC0 data (scripts/humans/): for each character the bind
// skeleton (metres, soles at y = 0, facing +z, its left toward +x), each mesh part with its skin weights, and
// the measurements the posing and the cloth need. Awaited at the top level, as the map is, so the people are
// built synchronously.

export type HumanName = 'majhi' | 'jele' | 'pathik' | 'meye';

interface ArrayRef {
  type: 'Int16Array' | 'Int8Array' | 'Float32Array' | 'Uint8Array' | 'Uint16Array' | 'Uint32Array';
  offset: number;
  length: number;
}

interface PartRefs {
  position: ArrayRef;
  normal: ArrayRef;
  uv: ArrayRef;
  skinIndex: ArrayRef;
  skinWeight: ArrayRef;
  index: ArrayRef;
  cut?: ArrayRef;
}

export interface Part {
  /** Metres. */
  position: Float32Array;
  normal: Int8Array;
  uv: Float32Array;
  skinIndex: Uint8Array;
  skinWeight: Uint8Array;
  index: Uint16Array | Uint32Array;
  /** A garment's: how far in from its edge each vertex is (0.5 at the edge; it is cut there by alpha). */
  cut?: Uint8Array;
}

/** The skin's outline round a vertical axis, row by row (see radiusMap in scripts/humans/build.mjs). */
export interface RadiusMap {
  /** First row's height and the step, relative to the map's origin (m). */
  y0: number;
  dy: number;
  rows: number;
  angles: number;
  /** Each row's middle, front to back, relative to the origin. */
  zc: number[];
  /** rows × angles distances from the axis; angle 0 is forward (+z), a quarter turn is +x. */
  r: number[];
}

export interface BindBone {
  head: [number, number, number];
  tail: [number, number, number];
}

export interface HumanData {
  height: number;
  /** One per bone of `HUMAN_BONES`, then the character's own (its braid). */
  bones: BindBone[];
  parents: number[];
  names: string[];
  /** The top of the skull. */
  crown: [number, number, number];
  sections: {
    /** Round the chest, from spine01's head. */
    chest: RadiusMap;
    /** Round the hips, from spine05's head. */
    pelvis: RadiusMap;
    /** The left limbs' radius at 11 points from their upper joint to the lower. */
    thigh: number[];
    shin: number[];
    upperArm: number[];
  };
  parts: Record<string, Part>;
  textures: { skin: Texture; hair: Texture; eyes: Texture; brows: Texture; lashes: Texture };
}

interface Raw {
  unit: number;
  bones: string[];
  parents: number[];
  characters: Record<
    HumanName,
    {
      height: number;
      bones: BindBone[];
      extra: { braid: (BindBone & { parent: number })[] } | null;
      crown: [number, number, number];
      sections: HumanData['sections'];
      parts: Record<string, PartRefs>;
      textures: Record<keyof HumanData['textures'], string>;
    }
  >;
}

const base = new URL('humans/', document.baseURI);

async function load(): Promise<Record<HumanName, HumanData>> {
  const res = await fetch(new URL('humans.json', base));
  if (!res.ok) throw new Error(`humans/humans.json: ${res.status}`);
  const raw = (await res.json()) as Raw;
  const bin = await fetch(new URL('humans.bin', base));
  if (!bin.ok || !bin.body) throw new Error(`humans/humans.bin: ${bin.status}`);
  const buffer = await new Response(bin.body.pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer();
  const view = (r: ArrayRef) => {
    const T = { Int16Array, Int8Array, Float32Array, Uint8Array, Uint16Array, Uint32Array }[r.type];
    return new T(buffer, r.offset, r.length);
  };

  const loader = new TextureLoader();
  const textures = new Map<string, Promise<Texture>>();
  const texture = (file: string) => {
    if (!textures.has(file))
      textures.set(
        file,
        loader.loadAsync(new URL(file, base).href).then((t) => {
          t.colorSpace = SRGBColorSpace;
          t.anisotropy = 4;
          return t;
        }),
      );
    return textures.get(file) as Promise<Texture>;
  };

  const out = {} as Record<HumanName, HumanData>;
  for (const [name, c] of Object.entries(raw.characters) as [HumanName, Raw['characters'][HumanName]][]) {
    const parts: Record<string, Part> = {};
    for (const [key, p] of Object.entries(c.parts)) {
      const q = view(p.position) as Int16Array;
      const position = new Float32Array(q.length);
      for (let i = 0; i < q.length; i++) position[i] = q[i] * raw.unit;
      parts[key] = {
        position,
        normal: view(p.normal) as Int8Array,
        uv: view(p.uv) as Float32Array,
        skinIndex: view(p.skinIndex) as Uint8Array,
        skinWeight: view(p.skinWeight) as Uint8Array,
        index: view(p.index) as Uint16Array | Uint32Array,
        ...(p.cut ? { cut: view(p.cut) as Uint8Array } : {}),
      };
    }
    const braid = c.extra?.braid ?? [];
    const entries = await Promise.all(Object.entries(c.textures).map(async ([k, f]) => [k, await texture(f)] as const));
    out[name] = {
      height: c.height,
      bones: [...c.bones, ...braid.map(({ head, tail }) => ({ head, tail }))],
      parents: [...raw.parents, ...braid.map((b) => b.parent)],
      names: [...raw.bones, ...braid.map((_, i) => `braid${i}`)],
      crown: c.crown,
      sections: c.sections,
      parts,
      textures: Object.fromEntries(entries) as HumanData['textures'],
    };
  }
  return out;
}

let data: Record<HumanName, HumanData>;
try {
  data = await load();
} catch (err) {
  const box = document.getElementById('err');
  if (box) {
    box.textContent = 'দুঃখিত, মানুষদের ডেটা লোড করা গেল না। পাতাটি আবার লোড করে দেখুন।';
    box.hidden = false;
  }
  throw err;
}

export const HUMANS = data;
