// Renders one published terminal-procedure document to a canvas so the map can
// draw it as a chart layer, and resolves which document to open for an airport.
//
// The catalogue and the bytes come from the same authority the Charts workspace
// uses; nothing here builds a document address from a name the publisher did not
// publish. The document itself carries no corner coordinates — its placement on
// the map is the pilot's alignment, done in the map page.

let pdfjsPromise = null;

function loadPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import('../../vendor/pdfjs/compat.mjs')
      .then(() => import('../../vendor/pdfjs/pdf.min.mjs'))
      .then(library => {
        library.GlobalWorkerOptions.workerSrc = new URL('../../vendor/pdfjs/worker-compat.mjs', import.meta.url).href;
        return library;
      })
      .catch(error => { pdfjsPromise = null; throw error; });
  }
  return pdfjsPromise;
}

const CATALOGUE_CACHE_MS = 10 * 60 * 1000;
const catalogueCache = new Map(); // icao -> { at, data }

/** The airport's chart catalogue, straight from the publishing authority. */
export async function plateCatalogue(icao) {
  const code = String(icao || '').toUpperCase();
  if (!/^[A-Z0-9]{3,5}$/.test(code)) throw new Error('not an airport code');
  const hit = catalogueCache.get(code);
  if (hit && Date.now() - hit.at < CATALOGUE_CACHE_MS) return hit.data;
  const response = await fetch(`/api/charts?icao=${encodeURIComponent(code)}`, { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`catalogue returned ${response.status}`);
  const data = await response.json();
  catalogueCache.set(code, { at: Date.now(), data });
  return data;
}

/* The airport diagram first: it is the sheet a pilot places against the ground,
   with the runway ends the alignment points refer to. Then a departure, then an
   arrival, then whatever the authority lists first. */
function chartRank(entry) {
  const code = String((entry && entry.code) || '');
  const title = String((entry && entry.title) || '');
  if (/APD|AD\b|AIRPORT DIAGRAM|AERODROME/i.test(code + ' ' + title)) return 0;
  if (/SID|DP\b|DEPARTURE/i.test(code + ' ' + title)) return 1;
  if (/STAR|ARRIVAL/i.test(code + ' ' + title)) return 2;
  return 3;
}

/** The chart the map opens for an airport, with the cycle it was published in. */
export async function plateChart(icao) {
  const data = await plateCatalogue(icao);
  const charts = Array.isArray(data && data.charts) ? data.charts : [];
  if (!charts.length) throw new Error((data && data.message) || `no published charts for ${icao}`);
  const chart = [...charts].sort((a, b) => chartRank(a) - chartRank(b))[0];
  return { chart, charts, cycle: data.cycle || '', airport: data.airport || '' };
}

/** The proxy query for one entry, in the shape its own provider publishes. */
export function chartQuery(icao, entry, cycle) {
  const chart = (entry && entry.chart) || entry || {};
  const code = String(icao || '').toUpperCase();
  if (chart.source === 'austrocontrol-eaip') {
    return `source=austrocontrol&icao=${encodeURIComponent(code)}`
      + `&cycle=${encodeURIComponent(chart.cycle || cycle || '')}&pdf=${encodeURIComponent(chart.pdf || '')}`;
  }
  if (chart.source === 'sia-france') {
    return `source=sia-france&icao=${encodeURIComponent(code)}&edition=${encodeURIComponent(chart.edition || '')}`
      + (chart.pdf ? `&pdf=${encodeURIComponent(chart.pdf)}` : '');
  }
  return `cycle=${encodeURIComponent(chart.cycle || cycle || '')}&file=${encodeURIComponent(chart.pdf || '')}`;
}

/** Render page one of a document to a canvas at a resolution the map can zoom. */
export async function renderChart(url, { maxWidth = 2000, page: pageNumber = 1 } = {}) {
  const pdfjs = await loadPdfjs();
  const doc = await pdfjs.getDocument({
    url,
    standardFontDataUrl: new URL('../../vendor/pdfjs/standard_fonts/', import.meta.url).href,
  }).promise;
  const page = await doc.getPage(Math.max(1, Math.min(pageNumber, doc.numPages)));
  const base = page.getViewport({ scale: 1 });
  const scale = Math.max(1, Math.min(3, maxWidth / base.width));
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(viewport.width);
  canvas.height = Math.round(viewport.height);
  const context = canvas.getContext('2d');
  context.fillStyle = '#fff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: context, viewport }).promise;

  /* Every label the document itself prints, with the canvas point it sits on.
     The runway designators are what the suggestion matches against the runway
     ends the airport publishes — read from the chart, never inferred from the
     airport's position or the chart's size. */
  const labels = [];
  try {
    const content = await page.getTextContent();
    for (const item of content.items) {
      const text = String((item && item.str) || '').trim();
      const transform = item && item.transform;
      if (!text || !transform) continue;
      const [x0, y0] = viewport.convertToViewportPoint(transform[4], transform[5]);
      if (!Number.isFinite(x0) || !Number.isFinite(y0)) continue;
      /* Charts print designators along the runway, so the label's own direction
         matters both for grouping its glyphs and for finding where it sits: the
         reported point is the glyph origin, and the printed designator's centre
         is half its advance along that direction. */
      const a = Number(transform[0]) || 0;
      const b = Number(transform[1]) || 0;
      const length = Math.hypot(a, b) || 1;
      const ux = a / length;
      const uy = b / length;
      const advance = Math.abs(Number(item.width) || 0) * (viewport.scale || 1);
      const x = x0 + (ux * advance) / 2;
      const y = y0 - (uy * advance) / 2;
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      labels.push({ text, x, y, angle: Math.atan2(-uy, ux), advance });
      if (labels.length > 6000) break;
    }
  } catch (_) { /* a document without a text layer simply suggests nothing */ }

  return { canvas, width: canvas.width, height: canvas.height, pages: doc.numPages, labels };
}

function normaliseIdent(value) {
  return String(value || '').toUpperCase().replace(/^0+(?=\d)/, '');
}

/**
 * The points a chart can be placed against, for one airport: every runway end,
 * indexed by designator, and every waypoint its published procedures name. Both
 * carry their own coordinates, so a label printed on the document can only be
 * matched to a point the authority actually publishes.
 */
export async function plateReferences(icao) {
  const code = String(icao || '').toUpperCase();
  const refs = new Map();
  const put = (ident, lon, lat, kind) => {
    const key = normaliseIdent(ident);
    if (!key || !Number.isFinite(Number(lon)) || !Number.isFinite(Number(lat))) return;
    if (!refs.has(key)) refs.set(key, { lon: Number(lon), lat: Number(lat), kind });
  };

  try {
    const runways = await plateRunways(code);
    for (const runway of runways.runways || []) {
      for (const end of runway.ends || []) put(end.ident, end.lon, end.lat, 'runway');
    }
  } catch (_) { /* thresholds unavailable: waypoints may still place it */ }

  try {
    const response = await fetch(`/api/procedures?airport=${encodeURIComponent(code)}`, { headers: { Accept: 'application/json' } });
    if (response.ok) {
      const data = await response.json();
      for (const [ident, end] of Object.entries(data.runways || {})) put(ident, end && end.lon, end && end.lat, 'runway');
      for (const kind of ['sid', 'star', 'approach', 'iap']) {
        for (const procedure of (data.procedures || {})[kind] || []) {
          for (const transition of procedure.transitions || []) {
            for (const point of transition.points || []) put(point.id, point.lon, point.lat, 'waypoint');
          }
        }
      }
    }
  } catch (_) { /* procedures are only published for the US: the runway ends carry the rest */ }

  return refs;
}

/** Runway ends for one airport: the designator and its own coordinates. */
export async function plateRunways(icao) {
  const code = String(icao || '').toUpperCase();
  const response = await fetch(`/api/runways?icao=${encodeURIComponent(code)}`, { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`runway data returned ${response.status}`);
  return await response.json();
}
