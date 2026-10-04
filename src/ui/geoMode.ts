import { BufferGeometry, Float32BufferAttribute, Group, LineBasicMaterial, LineSegments, Raycaster, Vector2, Vector3 } from 'three';
import type { PerspectiveCamera, Scene } from 'three';
import { BUILDINGS, CELL, COVER, GRID_H, GRID_W, KIND, LAYERS, LINES, PLACES, cellCentre, coverAt, heightAt, kindAt, modelledAt, type Place } from '../geo/data';
import { MAP_SCALE, toLatLon, toUtm } from '../geo/project';
import { onPlant } from '../world/plantSite';
import { onPort } from '../world/portSite';
import { terrainHeight, waterLevelAt } from '../world/geography';

// The GIS reference mode (`?debug&geo`, GEOGRAPHY_PLAN.md §11): what the map says against what is drawn. A
// readout of the camera and the cursor (WGS84 and UTM, the ground as drawn and as the DEM has it, what covers
// it and where that comes from, the water and the tide, the nearest place with its real distance and bearing);
// OpenStreetMap's lines draped over the ground (the coastline, roads, waterways, structures, power, the plant's
// and the port's sites, the buildings' footprints); and a pin at every place, coloured by how sure its position
// is. Debug only: loaded on demand, nothing of it is in the ordinary page.

/** Line colours by kind (sRGB hex). */
const COLOURS: Record<string, number> = {
  coast: 0x33e0ff,
  road: 0xffcc33,
  rail: 0xff66cc,
  waterway: 0x3388ff,
  structure: 0xffffff,
  power: 0xff4444,
  site: 0xff00ff,
  building: 0xff9955,
};
/** Pins by confidence. */
const SURE: Record<Place['confidence'], string> = { high: '#4ade80', medium: '#facc15', low: '#fb923c', model: '#f87171' };
/** Lines lie this far above what is drawn, and are cut into pieces this long so they follow the ground (m). */
const LIFT = 0.8;
const PIECE = 15;
/** Labels farther than this are hidden (m). */
const LABEL_REACH = 2500;
/** The readout refreshes this often (s). */
const EVERY = 0.25;

export interface GeoReadings {
  /** The sea's level now (m), the tide's flow (+ ebb, − flood), and its words. */
  level: number;
  flow: number;
  tide: string;
}

/** The ground drawn under (x, z), with what the water stands at there. */
const surfaceAt = (x: number, z: number) => Math.max(terrainHeight(x, z), waterLevelAt(x, z));

export class GeoMode {
  private readonly group = new Group();
  private readonly hud: HTMLElement;
  private readonly labels: { el: HTMLElement; at: Vector3 }[] = [];
  private readonly ndc = new Vector2(2, 2);
  private readonly ray = new Raycaster();
  private wait = 0;
  private readonly camera: PerspectiveCamera;
  private readonly readings: () => GeoReadings;

  constructor(scene: Scene, camera: PerspectiveCamera, canvas: HTMLCanvasElement, readings: () => GeoReadings) {
    this.camera = camera;
    this.readings = readings;
    this.group.name = 'geo-overlay';
    this.group.add(this.lines(), this.pins());
    scene.add(this.group);
    const hud = (this.hud = document.createElement('pre'));
    hud.style.cssText =
      'position:fixed;left:12px;top:12px;z-index:5;margin:0;padding:10px 12px;max-width:520px;background:rgba(8,10,14,.82);color:#e7f0ff;font:12px/1.45 ui-monospace,Consolas,monospace;border-radius:8px;pointer-events:none;white-space:pre-wrap';
    document.body.appendChild(hud);
    canvas.addEventListener('pointermove', (e) => {
      const r = canvas.getBoundingClientRect();
      this.ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    });
    canvas.addEventListener('pointerleave', () => this.ndc.set(2, 2));
  }

  /** Every frame: the labels follow the camera; the readout refreshes a few times a second. */
  update(dt: number): void {
    this.placeLabels();
    this.wait -= dt;
    if (this.wait > 0) return;
    this.wait = EVERY;
    this.hud.textContent = this.readout();
  }

  // ---------- the overlay ----------

  /** OSM's lines, the coastline and the buildings' footprints, draped over the ground, one LineSegments a colour. */
  private lines(): Group {
    const byColour = new Map<number, number[]>();
    const push = (colour: number, ax: number, az: number, bx: number, bz: number) => {
      let list = byColour.get(colour);
      if (!list) byColour.set(colour, (list = []));
      const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / PIECE));
      for (let k = 0; k < n; k++) {
        const x0 = ax + ((bx - ax) * k) / n;
        const z0 = az + ((bz - az) * k) / n;
        const x1 = ax + ((bx - ax) * (k + 1)) / n;
        const z1 = az + ((bz - az) * (k + 1)) / n;
        list.push(x0, surfaceAt(x0, z0) + LIFT, z0, x1, surfaceAt(x1, z1) + LIFT, z1);
      }
    };
    for (const l of LINES) {
      const colour = COLOURS[l.k] ?? 0xffffff;
      for (let k = 2; k < l.points.length; k += 2) push(colour, l.points[k - 2], l.points[k - 1], l.points[k], l.points[k + 1]);
    }
    // the coastline: where the land (and inland water) meets the sea, its flats and its mangroves, along cell edges
    const land = (i: number) => {
      const k = LAYERS.kind[i] & 0x7f;
      return k === KIND.land || k === KIND.inland;
    };
    for (let r = 0; r < GRID_H - 1; r++) {
      for (let c = 0; c < GRID_W - 1; c++) {
        const i = r * GRID_W + c;
        for (const j of [i + 1, i + GRID_W]) {
          if (land(i) === land(j)) continue;
          const a = cellCentre(c, r);
          const b = cellCentre(j % GRID_W, Math.floor(j / GRID_W));
          const mx = (a.x + b.x) / 2;
          const mz = (a.z + b.z) / 2;
          const len = Math.hypot(b.x - a.x, b.z - a.z);
          const px = (-(b.z - a.z) / len) * (CELL / 2);
          const pz = ((b.x - a.x) / len) * (CELL / 2);
          push(COLOURS.coast, mx - px, mz - pz, mx + px, mz + pz);
        }
      }
    }
    // the buildings' footprints
    const B = BUILDINGS;
    for (let i = 0; i < B.count; i++) {
      const ux = Math.cos(B.yaw[i]);
      const uz = -Math.sin(B.yaw[i]);
      const hl = B.l[i] / 2;
      const hw = B.w[i] / 2;
      const corner = (s: number, t: number) => [B.x[i] + ux * hl * s - uz * hw * t, B.z[i] + uz * hl * s + ux * hw * t];
      const cs = [corner(1, 1), corner(-1, 1), corner(-1, -1), corner(1, -1)];
      for (let k = 0; k < 4; k++) push(COLOURS.building, cs[k][0], cs[k][1], cs[(k + 1) % 4][0], cs[(k + 1) % 4][1]);
    }
    const out = new Group();
    for (const [colour, list] of byColour) {
      const g = new BufferGeometry();
      g.setAttribute('position', new Float32BufferAttribute(list, 3));
      const mesh = new LineSegments(g, new LineBasicMaterial({ color: colour, transparent: true, opacity: 0.85 }));
      mesh.frustumCulled = false;
      out.add(mesh);
    }
    return out;
  }

  /** A pin at each place, coloured by how sure its position is, with a label: name, real lat/lon, source, confidence. */
  private pins(): LineSegments {
    const pos: number[] = [];
    const col: number[] = [];
    for (const p of PLACES) {
      const { x, z } = p.world;
      const y = surfaceAt(x, z);
      pos.push(x, y, z, x, y + 30, z);
      const c = parseInt(SURE[p.confidence].slice(1), 16);
      const rgb = [(c >> 16) / 255, ((c >> 8) & 255) / 255, (c & 255) / 255];
      col.push(...rgb, ...rgb);
      const el = document.createElement('div');
      el.style.cssText = `position:fixed;z-index:4;transform:translate(-50%,-100%);padding:2px 6px;border-radius:4px;background:rgba(8,10,14,.75);color:${SURE[p.confidence]};font:11px/1.3 ui-monospace,Consolas,monospace;pointer-events:none;white-space:nowrap;display:none`;
      el.textContent = `${p.name} · ${p.lat.toFixed(5)}, ${p.lon.toFixed(5)} · ${p.source} · ${p.confidence}`;
      document.body.appendChild(el);
      this.labels.push({ el, at: new Vector3(x, y + 31, z) });
    }
    const g = new BufferGeometry();
    g.setAttribute('position', new Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new Float32BufferAttribute(col, 3));
    const mesh = new LineSegments(g, new LineBasicMaterial({ vertexColors: true }));
    mesh.frustumCulled = false;
    return mesh;
  }

  private placeLabels(): void {
    const v = new Vector3();
    for (const l of this.labels) {
      v.copy(l.at).project(this.camera);
      const far = l.at.distanceTo(this.camera.position) > LABEL_REACH;
      if (far || v.z > 1 || Math.abs(v.x) > 1.1 || Math.abs(v.y) > 1.1) {
        l.el.style.display = 'none';
        continue;
      }
      l.el.style.display = 'block';
      l.el.style.left = `${((v.x + 1) / 2) * innerWidth}px`;
      l.el.style.top = `${((1 - v.y) / 2) * innerHeight}px`;
    }
  }

  // ---------- the readout ----------

  /** Where the cursor's ray meets the ground or the water, marched out and then halved down; null if it doesn't. */
  private pick(): Vector3 | null {
    if (Math.abs(this.ndc.x) > 1 || Math.abs(this.ndc.y) > 1) return null;
    this.ray.setFromCamera(this.ndc, this.camera);
    const o = this.ray.ray.origin;
    const d = this.ray.ray.direction;
    const below = (t: number) => o.y + d.y * t < surfaceAt(o.x + d.x * t, o.z + d.z * t);
    let lo = 0;
    for (let t = 2; t < 9000; t = t * 1.03 + 1) {
      if (!below(t)) {
        lo = t;
        continue;
      }
      let hi = t;
      for (let k = 0; k < 12; k++) {
        const mid = (lo + hi) / 2;
        if (below(mid)) hi = mid;
        else lo = mid;
      }
      return new Vector3(o.x + d.x * hi, o.y + d.y * hi, o.z + d.z * hi);
    }
    return null;
  }

  private readout(): string {
    const cam = this.camera.position;
    const w = this.readings();
    const lines = ['GIS reference (?debug&geo)', `camera  ${where(cam.x, cam.z)}`, `        ${Math.round(cam.y - terrainHeight(cam.x, cam.z))} m above the ground`];
    const at = this.pick();
    if (at) {
      lines.push(`cursor  ${where(at.x, at.z)}`);
      lines.push(`        ${ground(at.x, at.z)}`);
    }
    lines.push(`water   sea ${w.level.toFixed(2)} m, flow ${w.flow.toFixed(2)} (${w.tide})`);
    const near = nearest(at ?? cam);
    if (near) lines.push(`nearest ${near.place.name}: ${Math.round(near.real)} m real, bearing ${Math.round(near.bearing)}°`);
    return lines.join('\n');
  }
}

/** A world point as WGS84 and UTM. */
function where(x: number, z: number): string {
  const ll = toLatLon(x, z);
  const u = toUtm(ll.lat, ll.lon);
  return `${ll.lat.toFixed(6)}, ${ll.lon.toFixed(6)}  UTM ${u.zone}N ${Math.round(u.east)} ${Math.round(u.north)}`;
}

const KIND_NAMES = Object.fromEntries(Object.entries(KIND).map(([k, v]) => [v, k]));
const COVER_NAMES = Object.fromEntries(Object.entries(COVER).map(([k, v]) => [v, k]));

/** The ground at a point: drawn against the DEM, what covers it, and where its height comes from. */
function ground(x: number, z: number): string {
  const drawn = terrainHeight(x, z);
  const dem = heightAt(x, z);
  const source = onPlant(x, z) ? '[মডেল] the plant’s fill' : onPort(x, z) ? '[মডেল] the port’s fill or dredging' : modelledAt(x, z) ? '[মডেল] modelled depth' : '[মাপা] DEM';
  return `ground ${drawn.toFixed(1)} m drawn, ${dem.toFixed(1)} m baked · ${KIND_NAMES[kindAt(x, z)]}, ${COVER_NAMES[coverAt(x, z)]} · ${source}`;
}

/** The place nearest a point, its real distance (the world's × MAP_SCALE) and compass bearing from the point. */
function nearest(p: { x: number; z: number }): { place: Place; real: number; bearing: number } | null {
  let best: Place | null = null;
  let bestD = Infinity;
  for (const q of PLACES) {
    const d = Math.hypot(q.world.x - p.x, q.world.z - p.z);
    if (d < bestD) (bestD = d), (best = q);
  }
  if (!best) return null;
  // +x is west, +z north: east is −x
  const bearing = (Math.atan2(-(best.world.x - p.x), best.world.z - p.z) * 180) / Math.PI;
  return { place: best, real: bestD * MAP_SCALE, bearing: (bearing + 360) % 360 };
}
