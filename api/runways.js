// Stratos API: runway ends for one airport, from OurAirports (public domain).
//
// The plate suggestion needs the ground truth of where each runway end is:
// the published designator plus the threshold's own latitude and longitude.
// OurAirports publishes that in runways.csv, which is a 25 MB file parsed once
// per warm instance and then filtered per airport, so no request downloads it.
//
// Query: /api/runways?icao=KJFK

const CACHE_MS = 24 * 60 * 60 * 1000;
const SOURCES = [
  'https://davidmegginson.github.io/ourairports-data/runways.csv',
  'https://raw.githubusercontent.com/davidmegginson/ourairports-data/main/runways.csv',
];

let cache = null; // { at, rows, source }
let pending = null;

function splitCsvLine(line) {
  const out = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { out.push(field); field = ''; }
    else field += ch;
  }
  out.push(field);
  return out;
}

async function loadRunways() {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.rows;
  if (pending) return pending;
  pending = (async () => {
    let text = '';
    let source = '';
    for (const url of SOURCES) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 20000);
        const response = await fetch(url, { signal: controller.signal });
        clearTimeout(timer);
        if (!response.ok) continue;
        text = await response.text();
        source = url;
        break;
      } catch (_) { /* try the next mirror */ }
    }
    if (!text) throw new Error('runway data unavailable');
    const rows = new Map(); // airport_ident -> [{ident, lat, lon}]
    const lines = text.split('\n');
    const head = splitCsvLine(lines[0] || '');
    const col = name => head.indexOf(name);
    const cIdent = col('airport_ident');
    const cClosed = col('closed');
    const cLen = col('length_ft');
    const cWidth = col('width_ft');
    const cSurface = col('surface');
    const cLeIdent = col('le_ident');
    const cLeLat = col('le_latitude_deg');
    const cLeLon = col('le_longitude_deg');
    const cHeIdent = col('he_ident');
    const cHeLat = col('he_latitude_deg');
    const cHeLon = col('he_longitude_deg');
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (!line || line.length < 20) continue;
      const f = splitCsvLine(line);
      if (cIdent < 0 || !f[cIdent]) continue;
      const key = f[cIdent].toUpperCase();
      const ends = [];
      const push = (ident, lat, lon) => {
        const la = Number(lat);
        const lo = Number(lon);
        if (!ident || !Number.isFinite(la) || !Number.isFinite(lo)) return;
        ends.push({ ident: String(ident).toUpperCase(), lat: la, lon: lo });
      };
      push(f[cLeIdent], f[cLeLat], f[cLeLon]);
      push(f[cHeIdent], f[cHeLat], f[cHeLon]);
      if (!ends.length) continue;
      const row = {
        closed: cClosed >= 0 && String(f[cClosed]) === '1',
        lengthFt: Number(f[cLen]) || null,
        widthFt: Number(f[cWidth]) || null,
        surface: f[cSurface] || '',
        ends,
      };
      if (!rows.has(key)) rows.set(key, []);
      rows.get(key).push(row);
    }
    cache = { at: Date.now(), rows, source };
    return rows;
  })();
  try {
    return await pending;
  } finally {
    pending = null;
  }
}

export default async function handler(req, res) {
  if (req.method && !['GET', 'HEAD'].includes(req.method)) {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  const icao = String((req.query && req.query.icao) || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{3,5}$/.test(icao)) {
    res.status(400).json({ error: 'Expected an ICAO code' });
    return;
  }
  try {
    const rows = await loadRunways();
    const runways = rows.get(icao) || [];
    res.setHeader('Cache-Control', 'public, s-maxage=86400, stale-while-revalidate=3600');
    res.status(200).json({ icao, runways, source: 'OurAirports runways.csv (public domain)' });
  } catch (error) {
    res.setHeader('Cache-Control', 'no-store');
    res.status(502).json({ error: String((error && error.message) || 'Runway data unavailable') });
  }
}
