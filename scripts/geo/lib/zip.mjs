// Reads single members out of a remote zip over HTTP range requests, so a few tiles can be taken from an
// archive of many gigabytes without downloading it. Handles zip64 (the big archives need it), stored and
// deflated members.
import { inflateRawSync } from 'node:zlib';
import { get } from './http.mjs';

async function range(url, start, end) {
  const res = await get(url, { headers: { Range: `bytes=${start}-${end}` } });
  if (res.status !== 206) throw new Error(`${url}: range request answered ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

const totalOf = (res) => Number(/\/(\d+)$/.exec(res.headers.get('content-range') ?? '')?.[1]);

/**
 * The archive's last bytes and its total size, from Content-Range: some hosts refuse HEAD (Zenodo), and
 * some refuse a suffix range too, so the size is then asked for with a one-byte range first.
 */
async function tailOf(url, length) {
  const res = await get(url, { headers: { Range: `bytes=-${length}` } });
  if (res.status === 206 && totalOf(res)) return { tail: Buffer.from(await res.arrayBuffer()), total: totalOf(res) };
  await res.body?.cancel();
  const probe = await get(url, { headers: { Range: 'bytes=0-0' } });
  const total = totalOf(probe);
  await probe.body?.cancel();
  if (probe.status !== 206 || !total) throw new Error(`${url}: range requests answered ${res.status}, ${probe.status}`);
  const n = Math.min(total, length);
  return { tail: await range(url, total - n, total - 1), total };
}

/** The archive's members: name, method, sizes and where each one's local header starts. */
export async function listZip(url) {
  const { tail } = await tailOf(url, 1 << 16);
  const eocd = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error(`${url}: no end-of-central-directory record`);
  let count = tail.readUInt16LE(eocd + 10);
  let cdSize = tail.readUInt32LE(eocd + 12);
  let cdOffset = tail.readUInt32LE(eocd + 16);
  if (cdOffset === 0xffffffff || cdSize === 0xffffffff || count === 0xffff) {
    const locator = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x06, 0x07]));
    if (locator < 0) throw new Error(`${url}: zip64 locator missing`);
    const recordAt = Number(tail.readBigUInt64LE(locator + 8));
    const record = await range(url, recordAt, recordAt + 55);
    count = Number(record.readBigUInt64LE(32));
    cdSize = Number(record.readBigUInt64LE(40));
    cdOffset = Number(record.readBigUInt64LE(48));
  }
  const cd = await range(url, cdOffset, cdOffset + cdSize - 1);
  const entries = [];
  let p = 0;
  for (let i = 0; i < count && p < cd.length; i++) {
    if (cd.readUInt32LE(p) !== 0x02014b50) throw new Error(`${url}: bad central directory entry ${i}`);
    const method = cd.readUInt16LE(p + 10);
    let compressed = cd.readUInt32LE(p + 20);
    let uncompressed = cd.readUInt32LE(p + 24);
    const nameLen = cd.readUInt16LE(p + 28);
    const extraLen = cd.readUInt16LE(p + 30);
    const commentLen = cd.readUInt16LE(p + 32);
    let local = cd.readUInt32LE(p + 42);
    const name = cd.toString('utf8', p + 46, p + 46 + nameLen);
    // zip64 sizes and offset live in extra field 0x0001, in this order, only for the fields that overflowed
    let e = p + 46 + nameLen;
    const extraEnd = e + extraLen;
    while (e + 4 <= extraEnd) {
      const id = cd.readUInt16LE(e);
      const len = cd.readUInt16LE(e + 2);
      if (id === 0x0001) {
        let q = e + 4;
        if (uncompressed === 0xffffffff) (uncompressed = Number(cd.readBigUInt64LE(q))), (q += 8);
        if (compressed === 0xffffffff) (compressed = Number(cd.readBigUInt64LE(q))), (q += 8);
        if (local === 0xffffffff) local = Number(cd.readBigUInt64LE(q));
      }
      e += 4 + len;
    }
    entries.push({ name, method, compressed, uncompressed, local });
    p = extraEnd + commentLen;
  }
  return entries;
}

/** One member's bytes, inflated. */
export async function readZipMember(url, entry) {
  const head = await range(url, entry.local, entry.local + 29);
  if (head.readUInt32LE(0) !== 0x04034b50) throw new Error(`${url}: bad local header for ${entry.name}`);
  const dataAt = entry.local + 30 + head.readUInt16LE(26) + head.readUInt16LE(28);
  const data = await range(url, dataAt, dataAt + entry.compressed - 1);
  if (entry.method === 0) return data;
  if (entry.method === 8) return inflateRawSync(data);
  throw new Error(`${entry.name}: compression method ${entry.method} not supported`);
}
