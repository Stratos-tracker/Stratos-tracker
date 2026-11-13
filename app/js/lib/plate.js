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
  return { canvas, width: canvas.width, height: canvas.height, pages: doc.numPages };
}
