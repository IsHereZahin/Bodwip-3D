// Every request the geo scripts make goes through here: some hosts refuse requests without a User-Agent
// (Zenodo answers 403), and busy ones (Overpass) need a few tries.

const AGENT = 'bangla-river-geo/0.1 (offline data preparation; non-commercial)';
const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);

export async function get(url, init = {}, tries = 4) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { ...init, headers: { 'User-Agent': AGENT, ...init.headers } });
      if (!RETRY_STATUS.has(res.status) || i === tries - 1) return res;
      last = new Error(`${url}: ${res.status}`);
      await res.body?.cancel();
    } catch (err) {
      last = err;
    }
    await new Promise((r) => setTimeout(r, 4000 * 2 ** i));
  }
  throw last;
}
