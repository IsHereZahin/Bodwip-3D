import { BufferAttribute, BufferGeometry, CylinderGeometry, DoubleSide, Group, Matrix4, Mesh, MeshStandardMaterial, ShaderMaterial, TorusGeometry, Vector2, Vector3, Vector4 } from 'three';
import { G, LAYER_NO_REFLECT } from '../core/globals';
import { smoothstep } from '../core/mathx';
import { MeshBuilder, rgb, scaleRgb, type RGB } from '../render/builder';
import { GLSL_COMMON } from '../render/glsl';
import { patchMaterial } from '../render/patch';
import { brickTexture, plasterTexture } from '../render/textures';
import { CHANNELS, SLUICE_SITE, type Channel } from './channels';
import { terrainHeight, WATER_LEVEL } from './geography';
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

const VERT = /* glsl */ `
${GLSL_COMMON}
attribute vec3 aCentre;
attribute float aFoam;
attribute float aFall;
uniform float uFlow;
varying vec3 vWorld;
varying vec2 vUv;
varying float vFoam;
varying float vFall;
void main() {
  // thinner and narrower as the flow drops, drawn in toward its line
  vec3 p = mix(aCentre, position, mix(0.3, 1.0, uFlow));
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
varying vec3 vWorld;
varying vec2 vUv;
varying float vFoam;
varying float vFall;
void main() {
  // the froth carried down: two layers of noise drawn out along the flow, quicker where it falls
  float speed = uSpeed * (1.0 + 2.5 * vFall);
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

/** The flowing water's material: `speed` how fast its froth runs (m/s along it); `flow` the season's (0..1). */
function waterMaterial(speed: number, flow: { value: number }): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: { ...G, uFlow: flow, uSpeed: { value: speed } },
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
 * `foam` (0..1) and whether it falls there (`fall`): u runs across it (−1..1), v along it (m).
 */
function ribbon(line: { p: Vector3; half: number; foam: number; fall: number }[]): BufferGeometry {
  const pos: number[] = [];
  const centre: number[] = [];
  const uv: number[] = [];
  const foam: number[] = [];
  const fall: number[] = [];
  const index: number[] = [];
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
      pos.push(p.x + (ax / l) * half * s, p.y, p.z + (az / l) * half * s);
      centre.push(p.x, p.y, p.z);
      uv.push(s, v);
      foam.push(line[i].foam);
      fall.push(line[i].fall);
    }
    if (i > 0) {
      const k = (i - 1) * 2;
      index.push(k, k + 2, k + 1, k + 1, k + 2, k + 3);
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('aCentre', new BufferAttribute(new Float32Array(centre), 3));
  g.setAttribute('uv', new BufferAttribute(new Float32Array(uv), 2));
  g.setAttribute('aFoam', new BufferAttribute(new Float32Array(foam), 1));
  g.setAttribute('aFall', new BufferAttribute(new Float32Array(fall), 1));
  g.setIndex(index);
  g.computeBoundingSphere();
  return g;
}

/** The hill stream's water laid down its gully, a point every quarter metre: white where it falls off a ledge. */
function streamLine(c: Channel): { p: Vector3; half: number; foam: number; fall: number }[] {
  const out: { p: Vector3; half: number; foam: number; fall: number }[] = [];
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
  private readonly mouths: { x: number; z: number }[] = [];
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
    this.mouths.push({ x: parts.mouth.x, z: parts.mouth.z });
  }

  /** The sluice: its headwall over the vent, wing walls, the gate in its guides and its wheel, the apron; the drain's water and the spill. */
  private buildSluice(): { gate: Group; spill: Mesh; drain: Mesh; mouth: Vector3 } {
    const site = SLUICE_SITE;
    const drain = CHANNELS.find((c) => c.name === 'drain');
    // the vent's sill at the drain's bed (the river's bank falls away under the headwall's river side)
    const bed = Math.max(drain?.floorMin ?? WATER_LEVEL + 1, terrainHeight(site.x - site.out.x * 2.5, site.z - site.out.z * 2.5));
    const ground = terrainHeight(site.x, site.z);
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
    // wing walls flaring out toward the river, stepping down the bank
    for (const s of [-1, 1]) {
      for (let k = 0; k < 3; k++) {
        const along = 0.6 + k * 0.7;
        const x = s * (W / 2 - 0.2 + along * 0.45);
        const ground = terrainHeight(f.p(x, 0, along).x, f.p(x, 0, along).z);
        const h = Math.max(0.5, top - k * 0.55 - ground);
        f.box(brick, x, ground + h / 2 - 0.2, along, 0.35, h + 0.4, 0.75, scaleRgb(red, 0.9 + k * 0.03), 1.5, s * 0.42);
      }
    }
    // the apron: a sloping cement slab from the vent's sill down the bank into the water
    const sill = bed + 0.02;
    const low = WATER_LEVEL - 0.5;
    const apronLen = 3.2;
    const steps = 6;
    for (let k = 0; k < steps; k++) {
      const a0 = (k / steps) * apronLen;
      const y = sill + (low - sill) * ((k + 0.5) / steps);
      f.box(cement, 0, y - 0.15, 0.3 + a0 + apronLen / steps / 2, vent.w + 0.9, 0.3, apronLen / steps + 0.02, scaleRgb(grey, 0.85 + 0.05 * (k % 2)), 1);
    }
    // the gate's iron guides, the frame over the wall, its screw and wheel
    const ironCol: RGB = rgb('#3a3632');
    for (const s of [-1, 1]) f.box(iron, s * (vent.w / 2 + 0.06), (bed + top + 1.3) / 2, -0.3, 0.1, top + 1.3 - bed, 0.12, ironCol, 1);
    f.box(iron, 0, top + 1.3, -0.3, vent.w + 0.35, 0.14, 0.16, ironCol, 1);
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
    const gp = f.p(0, bed, -0.3);
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
    // the drain's water: still behind the gate, a flat ribbon along it at its level
    const drainLine: { p: Vector3; half: number; foam: number; fall: number }[] = [];
    if (drain) {
      const level = bed + 0.45;
      for (const [x, z] of drain.pts) drainLine.push({ p: new Vector3(x, Math.max(level, meshGround(x, z) + 0.06), z), half: drain.width * 0.3, foam: 0, fall: 0 });
    }
    const drainMesh = new Mesh(ribbon(drainLine.length > 1 ? drainLine : [{ p: new Vector3(), half: 0, foam: 0, fall: 0 }, { p: new Vector3(0, 0, 1), half: 0, foam: 0, fall: 0 }]), waterMaterial(0.25, this.sluiceFlow));
    drainMesh.name = 'sluice drain';
    drainMesh.layers.set(LAYER_NO_REFLECT);
    this.group.add(drainMesh);
    // the spill: out of the vent in an arc, down the apron and into the river
    const spillLine: { p: Vector3; half: number; foam: number; fall: number }[] = [];
    for (let k = 0; k <= 24; k++) {
      const t = k / 24;
      const along = 0.25 + t * (apronLen + 0.6);
      const arc = Math.min(1, t * 2.2);
      // (down to the lowest the river falls to: below its surface the river hides the rest)
      const y = sill + 0.35 * (1 - arc) + (low + 0.05 - sill) * Math.min(1, t * 1.1) + 0.06;
      const p = f.p(0, y, along);
      spillLine.push({ p, half: vent.w * 0.46 * (1 + 0.2 * t), foam: 0.55 + 0.45 * smoothstep(0, 0.5, t), fall: t < 0.4 ? 1 : 0 });
    }
    const spill = new Mesh(ribbon(spillLine), waterMaterial(1.6, this.sluiceFlow));
    spill.name = 'sluice spill';
    spill.renderOrder = 1;
    spill.layers.set(LAYER_NO_REFLECT);
    this.group.add(spill);
    return { gate, spill, drain: drainMesh, mouth: f.p(0, 0, apronLen + 0.8) };
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
    // the gate raised as the fields drain, down in the dry months; the spill and the drain's water with it
    this.gate.position.y = this.sill + this.gateLift * smoothstep(0.05, 0.4, s);
    this.spill.visible = s > 0.04;
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
    // how loud: the nearest falling water, louder the more there is
    let loud = 0;
    for (const [k, m] of this.mouths.entries()) {
      const flow = k === 0 ? this.streamFlow.value : s;
      loud = Math.max(loud, flow * (1 - smoothstep(6, 90, Math.hypot(m.x - eye.x, m.z - eye.z))));
    }
    return loud;
  }
}
