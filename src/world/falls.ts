import { BufferAttribute, BufferGeometry, CylinderGeometry, DoubleSide, Group, Matrix4, Mesh, MeshStandardMaterial, ShaderMaterial, TorusGeometry, Vector2, Vector3, Vector4 } from 'three';
import { G, LAYER_NO_REFLECT } from '../core/globals';
import { smoothstep } from '../core/mathx';
import { MeshBuilder, rgb, scaleRgb, type RGB } from '../render/builder';
import { GLSL_COMMON } from '../render/glsl';
import { patchMaterial } from '../render/patch';
import { brickTexture, plasterTexture } from '../render/textures';
import { CHANNELS, SLUICE_SITE, sluiceOutfall, type Channel } from './channels';
import { terrainHeight, waterLevelAt, WATER_LEVEL } from './geography';
import { Frame } from './houses';
import { meshGround } from './terrain';
import { SLUICE } from './plan';
import type { Ripples } from './ripples';

// Falling water: the hill stream (ছড়া) tumbling down the steep wooded hill's face from ledge to ledge into the
// river, and the sluice (স্লুইস গেট) in the river's north levee pouring the fields' water out. Each runs with
// the season: the stream full and white in the rains and a thread in the dry months, the sluice's gate up and
// its water pouring from the rains into autumn and down, the drain dry, the rest of the year. Their water is a
// ribbon laid along the channel's bed, its froth carried down it (a flow of noise along its length), white where
// it falls off a ledge or out of the vent; where it reaches the river it whitens the water and rings it (the
// water shader's `uFall`, world/ripples.ts).

/** How deep the stream's water runs over its bed (m), full and in the dry months; how much narrower it is then. */
const STREAM_DEPTH: [number, number] = [0.05, 0.16];

/**
 * The sluice's water, as water moves (the user's direction, 2026-10-08: the spill had lain flat across the river
 * where it ran under it, and the drain's water hung over its bed). `HEAD`: how high the fields' water stands over the
 * vent's sill at its fullest (m), in the rains; it falls with the season (`sluiceFlow`). `KEEP`: the share of the
 * height the water loses down the apron's steps that it keeps as speed (the steps take the rest). `PACE`: the
 * froth's pattern runs along the spill at the water's own speed, laid out at this one (m/s).
 */
const SLUICE_WATER = { HEAD: 0.3, KEEP: 0.5, PACE: 1.6, POINTS: 28 };
const GRAVITY = 9.81;

/** A point of a ribbon of water: its line, half its width, its froth, whether it falls there, and (if given) its `v` along it. */
type RibbonPoint = { p: Vector3; half: number; foam: number; fall: number; v?: number };

/**
 * The sluice's outfall in its own frame (m out from the headwall toward the river, over the ground), for laying
 * its water: the vent's floor and its river edge (`brink`); the apron's first tread and where it ends (`lip`), the
 * line down the steps' edges after it (`slope`, per metre); half the vent's width and the apron's; and the drain's
 * line, a point every 2 m to the brink, with its bed (as drawn), how far it is from the brink and half its water's width.
 */
interface Outfall {
  f: Frame;
  floor: number;
  brink: number;
  tread: number;
  lip: number;
  slope: number;
  ventHalf: number;
  apronHalf: number;
  drain: { x: number; z: number; bed: number; toBrink: number; half: number }[];
}

const VERT = /* glsl */ `
${GLSL_COMMON}
attribute vec3 aCentre;
attribute float aFoam;
attribute float aFall;
uniform float uFlow;
uniform float uNarrows;
varying vec3 vWorld;
varying vec2 vUv;
varying float vFoam;
varying float vFall;
void main() {
  // thinner and narrower as the flow drops, drawn in toward its line (not the sluice's water: its width is the
  // vent's and the drain's, whatever flows)
  vec3 p = mix(aCentre, position, mix(1.0, mix(0.3, 1.0, uFlow), uNarrows));
  vWorld = p;
  vUv = uv;
  vFoam = aFoam;
  vFall = aFall;
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}`;

const FRAG = /* glsl */ `
${GLSL_COMMON}
uniform float uFlow;
uniform float uSpeed;
uniform float uTimed;
varying vec3 vWorld;
varying vec2 vUv;
varying float vFoam;
varying float vFall;
void main() {
  // under the river's surface (as high as the season has it) the river hides it: drawn after the water, it lay
  // over it as a pale band
  if (vWorld.y < waterSurface(vWorld.xz) - 0.01) discard;
  // the froth carried down: two layers of noise drawn out along the flow, quicker where it falls; or, laid out by
  // the time the water takes to get there (uTimed), at the water's own speed everywhere
  float speed = uSpeed * (1.0 + 2.5 * vFall * (1.0 - uTimed));
  vec2 q = vec2(vUv.x * 3.0, vUv.y * 1.3 - uTime * speed);
  float n = vnoise(q) * 0.6 + vnoise(q * 2.3 + vec2(1.7, -uTime * speed * 0.7)) * 0.4;
  float streak = vnoise(vec2(vUv.x * 9.0, vUv.y * 0.35 - uTime * speed * 1.4));
  float foam = clamp(vFoam * (0.45 + 0.75 * uFlow) + (n - 0.5) * 0.6 + streak * 0.25 * vFall, 0.0, 1.0);
  foam = smoothstep(0.3, 0.85, foam);
  // clear water: the sky in it at a glance, the bed through it; froth: white, lit by the sun and the sky
  vec3 V = normalize(uCamPos - vWorld);
  vec3 N = normalize(vec3((n - 0.5) * 0.6, 1.0, (streak - 0.5) * 0.6));
  if (vFall > 0.5) N = normalize(vec3(V.x, 0.3, V.z));
  float F = 0.03 + 0.97 * pow(1.0 - max(dot(N, V), 0.0), 5.0);
  vec3 sky = hazeColor(reflect(-V, N));
  vec3 lit = uKeyColor * max(uKeyDir.y, 0.0) * 0.35 + sky * 0.55;
  vec3 water = sky * F + uWaterBody * 0.35 * (1.0 - F);
  vec3 froth = vec3(0.86, 0.88, 0.86) * lit;
  vec3 col = mix(water, froth, foam);
  float alpha = mix(0.35 + 0.4 * F, 0.92, foam) * mix(0.6, 1.0, uFlow) * smoothstep(0.0, 0.25, 1.0 - abs(vUv.x));
  col = applyAtmosphere(col, vWorld);
  gl_FragColor = vec4(col * alpha, alpha);
}`;

/**
 * The flowing water's material: `speed` how fast its froth runs (m/s along it); `flow` the season's (0..1); `timed`:
 * its ribbon's `v` is the time the water takes to get there times `speed`, not metres; `narrows`: it draws in as
 * the flow drops.
 */
function waterMaterial(speed: number, flow: { value: number }, { timed = false, narrows = true } = {}): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: { ...G, uFlow: flow, uSpeed: { value: speed }, uTimed: { value: timed ? 1 : 0 }, uNarrows: { value: narrows ? 1 : 0 } },
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
    // premultiplied, as the water's
    premultipliedAlpha: true,
  });
}

/**
 * A ribbon of water along `line` (points with the water's surface height), `half` m either side of it, its froth
 * `foam` (0..1) and whether it falls there (`fall`): u runs across it (−1..1), v along it (m, or the point's `v`).
 */
function ribbon(line: readonly RibbonPoint[]): BufferGeometry {
  const n = line.length;
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(n * 6), 3));
  g.setAttribute('aCentre', new BufferAttribute(new Float32Array(n * 6), 3));
  g.setAttribute('uv', new BufferAttribute(new Float32Array(n * 4), 2));
  g.setAttribute('aFoam', new BufferAttribute(new Float32Array(n * 2), 1));
  g.setAttribute('aFall', new BufferAttribute(new Float32Array(n * 2), 1));
  const index: number[] = [];
  for (let i = 1; i < n; i++) {
    const k = (i - 1) * 2;
    index.push(k, k + 2, k + 1, k + 1, k + 2, k + 3);
  }
  g.setIndex(index);
  layRibbon(g, line);
  return g;
}

/** Lays `line` into a ribbon made for as many points: the sluice's water is laid again as the season moves it. */
function layRibbon(g: BufferGeometry, line: readonly RibbonPoint[]): void {
  const pos = g.getAttribute('position') as BufferAttribute;
  const centre = g.getAttribute('aCentre') as BufferAttribute;
  const uv = g.getAttribute('uv') as BufferAttribute;
  const foam = g.getAttribute('aFoam') as BufferAttribute;
  const fall = g.getAttribute('aFall') as BufferAttribute;
  let v = 0;
  for (let i = 0; i < line.length; i++) {
    const a = line[Math.max(0, i - 1)].p;
    const b = line[Math.min(line.length - 1, i + 1)].p;
    const ax = b.z - a.z;
    const az = -(b.x - a.x);
    const l = Math.hypot(ax, az) || 1;
    if (i > 0) v += line[i].p.distanceTo(line[i - 1].p);
    const { p, half } = line[i];
    for (const s of [-1, 1]) {
      const j = i * 2 + (s + 1) / 2;
      pos.setXYZ(j, p.x + (ax / l) * half * s, p.y, p.z + (az / l) * half * s);
      centre.setXYZ(j, p.x, p.y, p.z);
      uv.setXY(j, s, line[i].v ?? v);
      foam.setX(j, line[i].foam);
      fall.setX(j, line[i].fall);
    }
  }
  for (const attr of [pos, centre, uv, foam, fall]) attr.needsUpdate = true;
  g.computeBoundingSphere();
}

/** The hill stream's water laid down its gully, a point every quarter metre: white where it falls off a ledge. */
function streamLine(c: Channel): RibbonPoint[] {
  const out: RibbonPoint[] = [];
  const n = (c.pts.length - 1) * 4;
  let prev = Infinity;
  for (let i = 0; i <= n; i++) {
    const f = i / 4;
    const k = Math.min(c.pts.length - 2, Math.floor(f));
    const t = f - k;
    const x = c.pts[k][0] + (c.pts[k + 1][0] - c.pts[k][0]) * t;
    const z = c.pts[k][1] + (c.pts[k + 1][1] - c.pts[k][1]) * t;
    // (on the ground as it is drawn, which smooths the gully's ledges into chutes)
    const bed = Math.max(terrainHeight(x, z), meshGround(x, z));
    const drop = Number.isFinite(prev) ? Math.max(0, prev - bed) / 0.25 : 0;
    prev = bed;
    // falling where the bed drops steeply (a ledge's riser), white below it for a little way
    const fall = smoothstep(0.8, 2.2, drop);
    const last = out[out.length - 1];
    const foam = Math.max(fall, last ? last.foam * 0.86 : 0, smoothstep(0.25, 0.8, drop) * 0.6);
    out.push({ p: new Vector3(x, bed + STREAM_DEPTH[1], z), half: c.width * 0.18 * (0.85 + 0.3 * Math.sin(i * 0.37)), foam, fall });
  }
  return out;
}

export class Falls {
  readonly group = new Group();
  /** The stream's and the sluice's flow now (0..1): their water's material and the water shader's foam read them. */
  private readonly streamFlow = { value: 0.5 };
  private readonly sluiceFlow = { value: 0 };
  /** Where each meets the river: the water shader's foam and rings there (x, z, reach, how hard). */
  private readonly into: [Vector4, Vector4];
  private readonly ripples: Ripples;
  private readonly gate: Group;
  private readonly gateLift = 0.95;
  /** The vent's sill (m), the gate's bottom when shut. */
  private sill = 0;
  private readonly spill: Mesh;
  private readonly drainWater: Mesh;
  private readonly outfall: Outfall;
  /** The head and the river's level the sluice's water was last laid for, and whether it falls (not drowned). */
  private readonly laid = { head: -1, river: -1, falls: false };
  private readonly mouths: { x: number; z: number }[] = [];
  /** Where the sluice's water goes into the river (one of `mouths`): it moves with the river's level. */
  private readonly sluiceMouth = { x: 0, z: 0 };
  private nextDrop = 0;

  constructor(ripples: Ripples, into: [Vector4, Vector4]) {
    this.ripples = ripples;
    this.into = into;
    this.group.name = 'falls';
    // the hill stream
    const stream = CHANNELS.find((c) => c.name === 'stream');
    if (stream) {
      const line = streamLine(stream);
      const mesh = new Mesh(ribbon(line), waterMaterial(0.9, this.streamFlow));
      mesh.name = 'stream';
      mesh.renderOrder = 1;
      mesh.layers.set(LAYER_NO_REFLECT);
      this.group.add(mesh);
      const end = line[line.length - 1].p;
      this.mouths.push({ x: end.x, z: end.z });
    }
    // the sluice and its drain
    const parts = this.buildSluice();
    this.gate = parts.gate;
    this.spill = parts.spill;
    this.drainWater = parts.drain;
    this.outfall = parts.outfall;
    this.mouths.push(this.sluiceMouth);
  }

  /** The sluice: its headwall over the vent, wing walls, the gate in its guides on the river face and its wheel, the apron; the drain's water and the spill. */
  private buildSluice(): { gate: Group; spill: Mesh; drain: Mesh; outfall: Outfall } {
    const site = SLUICE_SITE;
    const drain = CHANNELS.find((c) => c.name === 'drain');
    // the vent's sill at the drain's bed, cut through the bund it stands at the end of (plan.ts SLUICE.bund)
    const bed = Math.max(drain?.floorMin ?? WATER_LEVEL + 1, terrainHeight(site.x - site.out.x * 2.5, site.z - site.out.z * 2.5));
    // (its foot under the outfall's floor in front of it, the bund's earth standing higher behind)
    const ground = Math.min(terrainHeight(site.x, site.z), terrainHeight(site.x + site.out.x * 0.8, site.z + site.out.z * 0.8));
    const top = Math.max(bed + 1.9, terrainHeight(site.x - site.out.x * 3, site.z - site.out.z * 3) + 0.5);
    const f = new Frame(site.x, 0, site.z, site.face);
    const brick = new MeshBuilder();
    const cement = new MeshBuilder();
    const iron = new MeshBuilder();
    const W = SLUICE.width + 2.6;
    const vent = { w: 1.2, h: 1.0 };
    // old brick, darkened and dulled by years of floods
    const red: RGB = rgb('#8f7466');
    const grey: RGB = rgb('#9a958a');
    // the headwall: two piers either side of the vent, a lintel over it, the wall to its top
    const pier = (W - vent.w) / 2;
    const foot = Math.min(bed, ground) - 0.4;
    for (const s of [-1, 1]) f.box(brick, s * (vent.w / 2 + pier / 2), (foot + top) / 2, 0, pier, top - foot, 0.5, scaleRgb(red, 0.95), 1.5);
    f.box(brick, 0, (bed + vent.h + top) / 2, 0, vent.w + 0.02, top - bed - vent.h, 0.5, red, 1.5);
    // the vent's floor, down to the bank under it
    f.box(cement, 0, (foot + bed) / 2, 0, vent.w + 0.02, bed - foot, 0.5, grey, 1);
    // a cement coping along its top, the year it was built long worn off
    f.box(cement, 0, top + 0.06, 0, W + 0.2, 0.12, 0.62, grey, 1);
    // wing walls flaring out toward the river along the outfall's sides, holding the bund's earth back: from the
    // outfall's floor up to a little over the earth behind them, stepping down its river face
    const groundAt = (x: number, along: number) => {
      const p = f.p(x, 0, along);
      return terrainHeight(p.x, p.z);
    };
    for (const s of [-1, 1]) {
      for (let k = 0; k < 3; k++) {
        const along = 0.6 + k * 0.7;
        const x = s * sluiceOutfall(along);
        const floor = groundAt(x - s * 0.4, along);
        const h = Math.max(0.5, Math.min(top - k * 0.55, groundAt(x + s * 0.4, along) + 0.35) - floor);
        f.box(brick, x, floor + h / 2 - 0.2, along, 0.35, h + 0.4, 0.75, scaleRgb(red, 0.9 + k * 0.03), 1.5, s * 0.42);
      }
    }
    // the apron: a sloping cement slab from the vent's sill down the bank into the water, stepped, the outfall's
    // whole floor from wing wall to wing wall (the ground's 2 m lattice, drawn up the bund behind them, would show
    // through it as earth heaped against the headwall)
    const sill = bed + 0.02;
    const low = WATER_LEVEL - 0.5;
    const apronLen = 3.2;
    const steps = 6;
    const run = apronLen / steps;
    for (let k = 0; k < steps; k++) {
      const middle = 0.3 + (k + 0.5) * run;
      const y = sill + (low - sill) * ((k + 0.5) / steps);
      f.box(cement, 0, y - 0.15, middle, 2 * sluiceOutfall(middle), 0.3, run + 0.02, scaleRgb(grey, 0.85 + 0.05 * (k % 2)), 1);
    }
    // the gate on the headwall's river face, where the river's water presses it shut: its iron guides down to the
    // apron, the frame over them, its screw and wheel (behind the wall, the river saw only an empty hole)
    const gateAt = 0.35;
    const ironCol: RGB = rgb('#3a3632');
    const guideFoot = sill + (low - sill) * (0.5 / steps);
    for (const s of [-1, 1]) f.box(iron, s * (vent.w / 2 + 0.06), (guideFoot + top + 1.3) / 2, gateAt, 0.1, top + 1.3 - guideFoot, 0.2, ironCol, 1);
    f.box(iron, 0, top + 1.3, gateAt, vent.w + 0.35, 0.14, 0.16, ironCol, 1);
    const gate = new Group();
    const plate = new MeshBuilder();
    new Frame(0, 0, 0, 0).box(plate, 0, vent.h / 2, 0, vent.w + 0.1, vent.h + 0.1, 0.06, rgb('#4a3f36'), 1);
    // the screw rising from it through the frame, and the wheel on top
    new Frame(0, 0, 0, 0).box(plate, 0, vent.h + (top + 1.3 - bed - vent.h) / 2, 0, 0.05, top + 1.3 - bed - vent.h, 0.05, rgb('#5a524a'), 1);
    const wheel = new TorusGeometry(0.32, 0.025, 6, 20).rotateX(Math.PI / 2);
    plate.add(wheel, new Matrix4().makeTranslation(0, top + 1.42 - bed, 0), rgb('#2e2a26'));
    for (let k = 0; k < 4; k++) {
      const spoke = new CylinderGeometry(0.012, 0.012, 0.64, 4).rotateZ(Math.PI / 2).rotateY((k * Math.PI) / 4);
      plate.add(spoke, new Matrix4().makeTranslation(0, top + 1.42 - bed, 0), rgb('#2e2a26'));
    }
    const ironMat = patchMaterial(new MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.4 }), { grime: 0.5 });
    const gateMesh = new Mesh(plate.build(), ironMat);
    gateMesh.castShadow = false;
    gate.add(gateMesh);
    this.sill = bed;
    const gp = f.p(0, bed, gateAt);
    gate.position.copy(gp);
    gate.quaternion.setFromAxisAngle(new Vector3(0, 1, 0), site.face);
    this.group.add(gate);
    const brickSet = brickTexture(921);
    const plaster = plasterTexture(922, { fallen: false });
    for (const [b, m] of [
      [brick, patchMaterial(new MeshStandardMaterial({ map: brickSet.map, normalMap: brickSet.normal, normalScale: new Vector2(0.8, 0.8), vertexColors: true, roughness: 0.88 }), { grime: 0.8, wetline: true })],
      [cement, patchMaterial(new MeshStandardMaterial({ map: plaster.map, normalMap: plaster.normal, vertexColors: true, roughness: 0.92 }), { grime: 0.55, wetline: true })],
      [iron, ironMat],
    ] as const) {
      const mesh = new Mesh(b.build(), m);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.group.add(mesh);
    }
    // the outfall, for laying the water as the season and the river move (laySluiceWater): the vent's floor and its
    // river edge, the first tread, the line down the steps' edges after it
    const outfall: Outfall = {
      f,
      floor: bed,
      brink: 0.25,
      tread: sill + (low - sill) * (0.5 / steps),
      lip: 0.3 + run,
      slope: (low - sill) / steps / run,
      ventHalf: vent.w / 2,
      apronHalf: (vent.w + 0.9) / 2 - 0.1,
      drain: [],
    };
    // the drain's line from the fields to the vent's edge, a point every 2 m on its bed as drawn: as wide as its flat
    // bed, drawn in to the vent's width through the headwall
    if (drain) {
      const [x0, z0] = drain.pts[0];
      const end = f.p(0, 0, outfall.brink);
      const length = Math.hypot(end.x - x0, end.z - z0);
      const n = Math.max(1, Math.ceil(length / 2));
      for (let i = 0; i <= n; i++) {
        const x = x0 + ((end.x - x0) * i) / n;
        const z = z0 + ((end.z - z0) * i) / n;
        const toBrink = (length * (n - i)) / n;
        const inWall = toBrink < 0.5;
        outfall.drain.push({ x, z, bed: inWall ? bed : Math.max(bed, meshGround(x, z) + 0.02), toBrink, half: outfall.ventHalf + (drain.width / 2 - 0.4 - outfall.ventHalf) * smoothstep(0.5, 1.1, toBrink) });
      }
    }
    // (laid as the season fills them: blank till then)
    const blank = (n: number): RibbonPoint[] => Array.from({ length: n }, (_, i) => ({ p: f.p(0, bed, i * 0.01), half: 0, foam: 0, fall: 0 }));
    const drainMesh = new Mesh(ribbon(blank(Math.max(2, outfall.drain.length))), waterMaterial(0.25, this.sluiceFlow, { narrows: false }));
    drainMesh.name = 'sluice drain';
    drainMesh.layers.set(LAYER_NO_REFLECT);
    this.group.add(drainMesh);
    const spill = new Mesh(ribbon(blank(SLUICE_WATER.POINTS)), waterMaterial(SLUICE_WATER.PACE, this.sluiceFlow, { timed: true, narrows: false }));
    spill.name = 'sluice spill';
    spill.renderOrder = 1;
    spill.layers.set(LAYER_NO_REFLECT);
    this.group.add(spill);
    return { gate, spill, drain: drainMesh, outfall };
  }

  /**
   * Lays the sluice's water for the fields' water standing `head` m over the vent's sill and the river's surface at
   * `river` (m). Over the sill the flow goes critical: its depth two thirds of the head, its discharge q = √(g·yc³)
   * a metre of the vent. It leaves the vent's edge thinned to 0.715 of that depth at q over it (a free overfall),
   * falls under gravity onto the apron's first tread, and skims down over the steps' edges gathering speed (`KEEP`
   * of the height it loses), thinning and spreading as it goes, till it runs under the river's surface. In the
   * drain behind it the water stands `head` deep, drawn down to the brink's depth over its last few metres. Sets
   * where it goes into the river (`sluiceMouth`), and whether it falls at all (the river not over the vent's edge).
   */
  private laySluiceWater(head: number, river: number): void {
    const o = this.outfall;
    const { HEAD, KEEP, PACE, POINTS } = SLUICE_WATER;
    const yc = (2 / 3) * Math.max(head, 0.005);
    const q = Math.sqrt(GRAVITY * yc * yc * yc);
    const yb = 0.715 * yc;
    const reach = 3 * HEAD;
    if (o.drain.length > 1) {
      layRibbon(
        this.drainWater.geometry,
        o.drain.map((d) => ({ p: new Vector3(d.x, d.bed + yb + (head - yb) * (1 - Math.exp(-d.toBrink / reach)), d.z), half: d.half, foam: 0, fall: 0 })),
      );
    }
    const mouth = o.f.p(0, 0, o.brink + 0.4);
    this.laid.falls = river < o.floor + yb && head > 0.005;
    if (!this.laid.falls) {
      // the vent drowned: no fall, the water boils up in front of it
      this.sluiceMouth.x = mouth.x;
      this.sluiceMouth.z = mouth.z;
      return;
    }
    const vb = q / yb;
    const edge = (a: number) => Math.min(o.tread, o.tread + o.slope * (a - o.lip));
    const half = (a: number) => Math.min(o.apronHalf, o.ventHalf + 0.25 * (a - o.brink));
    // along it a centimetre at a time: the sheet's middle, its speed, whether it is still falling
    const path: { a: number; y: number; v: number; nappe: boolean }[] = [];
    let landed: { y: number; v: number } | null = null;
    for (let a = o.brink; a < o.lip + 8; a += 0.01) {
      let y: number;
      let v: number;
      const t = (a - o.brink) / vb;
      if (!landed && o.floor - 0.5 * GRAVITY * t * t > edge(a)) {
        y = o.floor + yb / 2 - 0.5 * GRAVITY * t * t;
        v = Math.hypot(vb, GRAVITY * t);
      } else {
        landed ??= { y: edge(a), v: Math.hypot(vb, GRAVITY * t) };
        v = Math.sqrt(landed.v * landed.v + 2 * GRAVITY * KEEP * (landed.y - edge(a)));
        y = edge(a) + (q * (o.ventHalf / half(a))) / v / 2;
      }
      path.push({ a, y, v, nappe: !landed });
      // (on a little under the river's surface: the water shader's own cut hides it there, exactly at the surface)
      if (y < river - 0.03) break;
    }
    const end = path[path.length - 1].a;
    const line: RibbonPoint[] = [];
    let time = 0;
    for (let i = 0; i < POINTS; i++) {
      const k = path[Math.round((i / (POINTS - 1)) * (path.length - 1))];
      const p = o.f.p(0, k.y, k.a);
      if (i > 0) {
        const before = line[i - 1].p;
        const prev = path[Math.round(((i - 1) / (POINTS - 1)) * (path.length - 1))];
        time += p.distanceTo(before) / ((k.v + prev.v) / 2);
      }
      // clear as it leaves the vent, white as it lands and skims down the steps, whitest going into the river
      const share = (k.a - o.brink) / Math.max(end - o.brink, 1e-3);
      line.push({ p, half: half(k.a), foam: k.nappe ? 0.35 + 0.4 * share : 0.8 + 0.2 * share, fall: k.nappe ? 1 : 0, v: time * PACE });
    }
    layRibbon(this.spill.geometry, line);
    const into = o.f.p(0, 0, end);
    this.sluiceMouth.x = into.x;
    this.sluiceMouth.z = into.z;
  }

  /**
   * The season's flow (`rain`: the season's rain, `flood`: how much of the fields stands in water, `wet`: how wet
   * the land is, 0..1 each) and the water's foam and rings where each meets the river; `eye` the camera, for the
   * rings it would see; returns how loud their falling water is there (0..1) for the soundscape.
   */
  update(dt: number, rain: number, flood: number, rise: number, wet: number, eye: Vector3): number {
    const stream = Math.min(1, 0.18 + 0.82 * smoothstep(0.05, 0.45, rain) + 0.15 * wet);
    // the fields drain out through the sluice from the rains till they are dry in late autumn (`rise`, the
    // rivers' season, still above their mean); in the dry months its gate is down
    const sluice = Math.min(1, smoothstep(0.06, 0.4, rain) + 0.7 * smoothstep(0.05, 0.4, rise) * smoothstep(0.1, 0.4, flood) + smoothstep(0.6, 0.95, wet) * 0.15);
    this.streamFlow.value += (stream - this.streamFlow.value) * (1 - Math.exp(-dt / 4));
    this.sluiceFlow.value += (sluice - this.sluiceFlow.value) * (1 - Math.exp(-dt / 4));
    const s = this.sluiceFlow.value;
    // the gate raised as the fields drain, down in the dry months; the spill and the drain's water with it. The
    // spill's head comes out under the gate's plate, so the gate is half up before it shows
    this.gate.position.y = this.sill + this.gateLift * smoothstep(0.02, 0.12, s);
    // the fields' water over the sill, and the river's surface in front of the outfall, laid again as they move
    const head = SLUICE_WATER.HEAD * s;
    const front = this.outfall.f.p(0, 0, 4);
    const level = waterLevelAt(front.x, front.z);
    const river = Number.isFinite(level) ? level : WATER_LEVEL;
    if (Math.abs(head - this.laid.head) > 0.003 || Math.abs(river - this.laid.river) > 0.005) {
      this.laid.head = head;
      this.laid.river = river;
      this.laySluiceWater(head, river);
    }
    this.spill.visible = s > 0.07 && this.laid.falls;
    this.drainWater.visible = s > 0.02;
    // where each meets the river: froth and rings (the river's level now: in the rains the spill is drowned)
    const [a, b] = this.mouths;
    this.into[0].set(a.x, a.z, 1.4 + 1.2 * this.streamFlow.value, this.streamFlow.value);
    this.into[1].set(b.x, b.z, 1.6 + 1.5 * s, s);
    this.nextDrop -= dt;
    if (this.nextDrop <= 0) {
      this.nextDrop = 0.12;
      for (const [k, m] of this.mouths.entries()) {
        const flow = k === 0 ? this.streamFlow.value : s;
        if (flow < 0.08 || Math.hypot(m.x - eye.x, m.z - eye.z) > 25) continue;
        this.ripples.drop(m.x + (Math.random() - 0.5) * 0.8, m.z + (Math.random() - 0.5) * 0.8, 0.18, 0.01 * flow);
      }
    }
    // how loud: the nearest falling water, louder the more there is, fading as sound does (with the distance, from a
    // few metres off: it had carried nearly whole for 90 m and drowned the rest, the user's note of 2026-10-08)
    let loud = 0;
    for (const [k, m] of this.mouths.entries()) {
      const flow = k === 0 ? this.streamFlow.value : s;
      loud = Math.max(loud, flow * Math.min(1, 6 / Math.hypot(m.x - eye.x, m.z - eye.z)));
    }
    return loud;
  }
}
