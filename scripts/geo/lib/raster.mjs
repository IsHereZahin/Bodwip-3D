// Reads the area out of a remote cloud-optimised GeoTIFF (only the tiles it needs, by range requests) and
// keeps it as raw samples plus a JSON sidecar that says where they lie.
import { writeFile } from 'node:fs/promises';
import { fromUrl } from 'geotiff';
import proj4 from 'proj4';

proj4.defs('EPSG:32646', '+proj=utm +zone=46 +datum=WGS84 +units=m +no_defs');

/** The bbox (WGS84) in a CRS's own units, as [minX, minY, maxX, maxY], covering all four corners. */
export function bboxIn(crs, b) {
  if (crs === 'EPSG:4326') return [b.west, b.south, b.east, b.north];
  const pts = [
    [b.west, b.south],
    [b.east, b.south],
    [b.west, b.north],
    [b.east, b.north],
  ].map((p) => proj4('EPSG:4326', crs, p));
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

/**
 * Rows read per request batch: a whole large window at once fires so many range requests that hosts drop
 * the connections. 1024 matches the usual COG tile height, so no tile is fetched twice.
 */
const STRIP = 1024;

async function retry(job, tries = 4) {
  for (let i = 0; ; i++) {
    try {
      return await job();
    } catch (err) {
      if (i === tries - 1) throw err;
      await new Promise((r) => setTimeout(r, 3000 * 2 ** i));
    }
  }
}

/**
 * Reads `bbox` ([minX, minY, maxX, maxY] in the file's CRS) at the file's resolution, or at `res` (its units
 * per pixel) from the coarsest overview finer than that, a strip of rows at a time. Samples are
 * band-sequential.
 */
export async function readWindow(url, bbox, res, headers = {}) {
  const tiff = await retry(() => fromUrl(url, { headers, allowFullFile: false, blockSize: 1 << 20 }));
  const image = await tiff.getImage();
  const [rx, ry] = image.getResolution();
  const resX = res ?? Math.abs(rx);
  const resY = res ?? Math.abs(ry);
  const width = Math.round((bbox[2] - bbox[0]) / resX);
  const height = Math.round((bbox[3] - bbox[1]) / resY);
  const fillValue = image.getGDALNoData() ?? 0;
  let bands = null;
  for (let row = 0; row < height; row += STRIP) {
    const rows = Math.min(STRIP, height - row);
    // strips run from the north (bbox top) down
    const top = bbox[3] - row * resY;
    const strip = await retry(() => tiff.readRasters({ bbox: [bbox[0], top - rows * resY, bbox[2], top], width, height: rows, interleave: false, fillValue }));
    bands ??= Array.from({ length: strip.length }, (_, i) => new strip[i].constructor(width * height));
    for (let i = 0; i < strip.length; i++) bands[i].set(strip[i], row * width);
  }
  return { bands, width, height, nodata: image.getGDALNoData(), type: bands[0].constructor.name };
}

/** Writes a window as `<path>.bin` (bands one after another) and `<path>.json`. */
export async function saveWindow(path, window, meta) {
  const bytes = window.bands.map((b) => Buffer.from(b.buffer, b.byteOffset, b.byteLength));
  await writeFile(`${path}.bin`, Buffer.concat(bytes));
  const sidecar = { ...meta, width: window.width, height: window.height, bands: window.bands.length, type: window.type, nodata: window.nodata };
  await writeFile(`${path}.json`, JSON.stringify(sidecar, null, 2));
  return sidecar;
}
