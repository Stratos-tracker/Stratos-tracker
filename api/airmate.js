// Stratos API: Airmate AIP as a chart source.
//
// Airmate (Myriel Aviation SA) is the one publisher that hands out calibration
// with the charts it serves, including the FAA plates Stratos already draws: its
// AIP API answers, for one airfield, with the list of documents, the PDF of each
// and the georeferencing that draws it on the map. That calibration is what
// removes the guesswork from placing a plate over the ground.
//
// It is a commercial API. There is no public endpoint and no anonymous access,
// so nothing here is hard-coded: AIRMATE_AIP_URL is the address Airmate issues
// with the licence, with {icao} where the airport belongs, and AIRMATE_API_KEY is
// sent as a bearer token. With either missing the source is simply absent, and
// the free authorities keep answering exactly as before.
//
// The reply is validated field by field. A document with no title, an address
// that is not https, a duplicated code or calibration the placement engine
// cannot read is dropped rather than half-used: a chart that cannot be trusted
// to sit on the ground is not offered as if it could.
//
// The reply shape this expects, per aerodrome:
//   { airport, cycle, effective, expires, license,
//     documents: [ { code, title, kind, pdf, georef } ] }
// kind is one of diagram | sid | star | approach | other; georef, when present,
// is the same metadata the placement engine reads (is_georeferenced,
// bounding_boxes.planview.pixels and .latlng, insets).

const CACHE_MS = 6 * 60 * 60 * 1000;
const FETCH_TIMEOUT = 20000;
const CODE = /^[A-Z0-9][A-Z0-9-]{0,11}$/;
const ICAO = /^[A-Z0-9]{3,5}$/;
const CATEGORIES = new Set(['diagram', 'sid', 'star', 'approach', 'other']);

export const AIRMATE_ATTRIBUTION = 'Airmate AIP (Myriel Aviation SA) — licensed use';

/** The configured endpoint and key, or null when Airmate is not licensed here. */
export function airmateConfig(env = process.env) {
  const url = String((env && env.AIRMATE_AIP_URL) || '').trim();
  const key = String((env && env.AIRMATE_API_KEY) || '').trim();
  if (!url || !key || !url.includes('{icao}')) return null;
  try {
    // Only an https address is accepted, and only the one Airmate issued.
    if (new URL(url.replace('{icao}', 'XXXX')).protocol !== 'https:') return null;
  } catch (_) {
    return null;
  }
  return { url, key };
}

/* Calibration is passed on only when it says, in full, which rectangle of the
   sheet is which rectangle of the ground. The placement engine re-reads it
   against the rendered page and refuses anything that does not fit, so a chart
   with poor metadata is not drawn falsely aligned — it is simply not placed. */
function readableGeoref(meta) {
  if (!meta || typeof meta !== 'object') return null;
  if (meta.is_georeferenced !== true && meta.georeferenced !== true) return null;
  const boxes = meta.bounding_boxes || meta.boundingBoxes || null;
  const plan = boxes && (boxes.planview || boxes.plan_view) || null;
  if (!plan || !plan.pixels || !plan.latlng) return null;
  const px = [plan.pixels.x1, plan.pixels.y1, plan.pixels.x2, plan.pixels.y2].map(Number);
  const ll = [plan.latlng.lng1, plan.latlng.lat1, plan.latlng.lng2, plan.latlng.lat2].map(Number);
  if (!px.every(Number.isFinite) || !ll.every(Number.isFinite)) return null;
  const width = Number(meta.width) || 0;
  const height = Number(meta.height) || 0;
  if (width > 0 && height > 0
    && (Math.min(px[0], px[2]) < 0 || Math.min(px[1], px[3]) < 0
      || Math.max(px[0], px[2]) > width || Math.max(px[1], px[3]) > height)) return null;
  return meta;
}

function pdfAddress(value) {
  try {
    const url = new URL(String(value || '').trim());
    return url.protocol === 'https:' ? url.href : null;
  } catch (_) {
    return null;
  }
}

/**
 * Normalise one Airmate AIP reply into the catalogue Stratos serves.
 * Returns null — not an empty catalogue — when the reply is not the contract
 * above, so a changed API surface can never look like "this airport has none".
 */
export function parseAirmateDocuments(payload, { icao } = {}) {
  if (!payload || typeof payload !== 'object') return null;
  if (!Array.isArray(payload.documents)) return null;
  const seen = new Set();
  const charts = [];
  for (const doc of payload.documents) {
    if (!doc || typeof doc !== 'object') continue;
    const code = String(doc.code || '').trim().toUpperCase();
    const title = String(doc.title || '').trim().replace(/\s+/g, ' ');
    if (!CODE.test(code) || seen.has(code)) continue;
    if (!title || title.length > 120) continue;
    const pdf = pdfAddress(doc.pdf);
    if (!pdf) continue;
    const kind = String(doc.kind || '').trim().toLowerCase();
    // Calibration is kept only if the placement engine can read all of it.
    const georef = readableGeoref(doc.georef);
    seen.add(code);
    charts.push({
      code,
      title,
      pdf,
      category: CATEGORIES.has(kind) ? kind : 'chart',
      georef,
    });
  }
  return {
    icao: String(icao || payload.airport || payload.icao || '').toUpperCase(),
    cycle: String(payload.cycle || '').trim() || null,
    effective: payload.effective || null,
    expires: payload.expires || null,
    licensed: String(payload.license || payload.attribution || '').trim() || AIRMATE_ATTRIBUTION,
    charts,
  };
}

const cache = new Map(); // `${icao}|${endpoint}` -> { at, icao, docs, ...catalogue }

/**
 * The Airmate catalogue for one airport, or null when Airmate is unlicensed,
 * unreachable, or returned something this module refuses to use.
 */
export async function airmateDocuments(icao, { env = process.env, fetchImpl = fetch, now = Date.now() } = {}) {
  const config = airmateConfig(env);
  if (!config) return null;
  const key = String(icao || '').toUpperCase();
  if (!ICAO.test(key)) return null;
  const slot = `${key}|${config.url}`;
  const hit = cache.get(slot);
  if (hit && now - hit.at < CACHE_MS) return hit;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
  try {
    const response = await fetchImpl(config.url.replace('{icao}', encodeURIComponent(key)), {
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${config.key}`,
        'User-Agent': 'Stratos/2 (flight simulation companion; charts under Airmate licence)',
      },
    });
    if (!response || !response.ok) return null;
    const parsed = parseAirmateDocuments(await response.json(), { icao: key });
    if (!parsed || !parsed.charts.length) return null;
    const entry = {
      at: now,
      icao: key,
      docs: new Map(parsed.charts.map(chart => [chart.code, chart])),
      ...parsed,
    };
    cache.set(slot, entry);
    return entry;
  } catch (_) {
    // A licensed source that is down means "no Airmate answer", never a guess.
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One document of a catalogue already fetched. The proxy never takes an address
 * from the caller: it takes the airport and the document code and looks the
 * address up in the reply Airmate itself signed.
 */
export function airmateDocument(icao, code, { env = process.env, now = Date.now() } = {}) {
  const config = airmateConfig(env);
  if (!config) return null;
  const hit = cache.get(`${String(icao || '').toUpperCase()}|${config.url}`);
  if (!hit || now - hit.at >= CACHE_MS) return null;
  const wanted = String(code || '').trim().toUpperCase();
  if (!CODE.test(wanted)) return null;
  const doc = hit.docs.get(wanted);
  return doc ? { url: doc.pdf, credit: hit.licensed } : null;
}

/** Forget the cached catalogues; used by the tests. */
export function airmateForget() {
  cache.clear();
}
