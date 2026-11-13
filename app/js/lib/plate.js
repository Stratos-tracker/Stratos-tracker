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

/* ── Runway bands ────────────────────────────────────────────────────────
   A chart draws each runway as a long, narrow, evenly filled band. Flood
   filling the paved tone and keeping the thin long blobs gives a runway's two
   ends directly, which are its thresholds, without reading a single label. */
/* ── Runway strokes ────────────────────────────────────────────────────────
   A chart draws runways as long straight strokes, so a Hough pass over the
   rendered page finds their two ends, which are the thresholds. */
export function runwayStrokes(canvas, options = {}) {
  const maxDim = options.maxDim || 700;
  const minFraction = options.minFraction || 0.18;
  const step = Math.max(1, Math.ceil(Math.max(canvas.width, canvas.height) / maxDim));
  const w = Math.floor(canvas.width / step), h = Math.floor(canvas.height / step);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  let pixels;
  try { pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data; }
  catch (_) { return []; }

  const ink = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let dark = 0;
      for (let dy = 0; dy < step && !dark; dy++) {
        const row = ((y * step + dy) * canvas.width + x * step) * 4;
        for (let dx = 0; dx < step; dx++) {
          const i = row + dx * 4;
          if (pixels[i + 3] > 40 && 0.299 * pixels[i] + 0.587 * pixels[i + 1] + 0.114 * pixels[i + 2] < 150) { dark = 1; break; }
        }
      }
      ink[y * w + x] = dark;
    }
  }

  const thetas = 180;
  const cos = new Float32Array(thetas), sin = new Float32Array(thetas);
  for (let t = 0; t < thetas; t++) {
    const a = (t * Math.PI) / thetas;
    cos[t] = Math.cos(a); sin[t] = Math.sin(a);
  }
  const rhoMax = Math.ceil(Math.hypot(w, h));
  const stride = 2 * rhoMax + 3;
  const acc = new Uint16Array(thetas * stride);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!ink[y * w + x]) continue;
      for (let t = 0; t < thetas; t++) acc[t * stride + Math.round(x * cos[t] + y * sin[t]) + rhoMax]++;
    }
  }

  const walk = (t, rho) => {
    const cx = cos[t], cy = sin[t];
    const px = cx * rho, py = cy * rho;
    const ux = -cy, uy = cx;
    const reach = Math.hypot(w, h);
    let best = null, runStart = null, lastHit = null;
    for (let d = -reach; d <= reach; d += 1) {
      const x = Math.round(px + ux * d), y = Math.round(py + uy * d);
      let hit = false;
      if (x >= 0 && y >= 0 && x < w && y < h) {
        for (let o = -1; o <= 1 && !hit; o++) {
          const xx = Math.round(x - cy * o), yy = Math.round(y + cx * o);
          if (xx >= 0 && yy >= 0 && xx < w && yy < h && ink[yy * w + xx]) hit = true;
        }
      }
      if (hit) { if (runStart === null) runStart = d; lastHit = d; }
      else if (runStart !== null && d - lastHit > 5) {
        if (lastHit - runStart > (best ? best.len : 0)) best = { len: lastHit - runStart, from: runStart, to: lastHit };
        runStart = null;
      }
    }
    if (runStart !== null && lastHit - runStart > (best ? best.len : 0)) best = { len: lastHit - runStart, from: runStart, to: lastHit };
    if (!best) return null;
    return {
      a: [(px + ux * best.from) * step, (py + uy * best.from) * step],
      b: [(px + ux * best.to) * step, (py + uy * best.to) * step],
      length: best.len * step,
    };
  };

  const peaks = [];
  for (let t = 0; t < thetas; t++) {
    const base = t * stride;
    for (let r = 0; r <= 2 * rhoMax; r++) {
      const v = acc[base + r];
      if (v >= 30) peaks.push({ val: v, t, r });
    }
  }
  peaks.sort((p, q) => q.val - p.val);

  const minLength = Math.max(w, h) * minFraction * step;
  const keep = [];
  for (const peak of peaks.slice(0, 2500)) {
    const seg = walk(peak.t, peak.r - rhoMax);
    if (!seg || seg.length < minLength) continue;
    const angle = Math.atan2(seg.b[1] - seg.a[1], seg.b[0] - seg.a[0]);
    const mx = (seg.a[0] + seg.b[0]) / 2, my = (seg.a[1] + seg.b[1]) / 2;
    const dup = keep.find(k => {
      let da = Math.abs(((k.angle - angle) % Math.PI + Math.PI) % Math.PI);
      if (da > Math.PI / 2) da = Math.PI - da;
      return da < 0.05 && Math.hypot(k.mx - mx, k.my - my) < Math.max(30, seg.length * 0.3);
    });
    if (dup) { if (seg.length > dup.length) { dup.a = seg.a; dup.b = seg.b; dup.length = seg.length; } continue; }
    keep.push({ a: seg.a, b: seg.b, length: seg.length, angle, mx, my });
  }
  return keep.sort((p, q) => q.length - p.length);
}

/**
 * Pair drawn strokes with published runways and return the threshold
 * correspondences. A runway's two ends are its thresholds, so each match is
 * worth two points; at least two runways must agree before a fit is trusted.
 */
export function runwayThresholdPairs(strokes, runways, options = {}) {
  const tolNm = options.tolNm || 0.06;
  if (!strokes || strokes.length < 2 || !runways || runways.length < 2) return null;

  const lat0 = runways.reduce((s, r) => s + r.ends[0].lat, 0) / runways.length;
  const lon0 = runways.reduce((s, r) => s + r.ends[0].lon, 0) / runways.length;
  const kx = 60 * Math.cos((lat0 * Math.PI) / 180);
  /* Chart y grows downward, so the runway plane does too: a similarity can then
     describe the chart without a reflection. */
  const toNmi = e => [(e.lon - lon0) * kx, -(e.lat - lat0) * 60];
  const dist = (u, v) => Math.hypot(u[0] - v[0], u[1] - v[1]);
  const mid = (u, v) => [(u[0] + v[0]) / 2, (u[1] + v[1]) / 2];
  /* Angle between two undirected lines, folded into 0..90 degrees. A chart may
     be turned on the page, so only these differences survive. */
  const angleGap = (a, b) => {
    let d = Math.abs(a - b) % Math.PI;
    if (d > Math.PI / 2) d = Math.PI - d;
    return d;
  };

  const geo = runways
    .filter(r => r.ends && r.ends.length === 2)
    .map(r => {
      const [p, q] = r.ends.map(toNmi);
      return { rwy: r, p, q, len: dist(p, q), mid: mid(p, q), dir: Math.atan2(q[1] - p[1], q[0] - p[0]) };
    })
    .filter(g => g.len > 0.2);
  if (geo.length < 2) return null;

  const pool = strokes.slice(0, options.pool || 24).map(s => ({ ...s, mid: mid(s.a, s.b) }));

  const fit = pairs => {
    const n = pairs.length;
    let cx = 0, cy = 0, ux = 0, uy = 0;
    for (const p of pairs) { cx += p.chart[0]; cy += p.chart[1]; ux += p.geo[0]; uy += p.geo[1]; }
    cx /= n; cy /= n; ux /= n; uy /= n;
    let sa = 0, sb = 0, ss = 0;
    for (const p of pairs) {
      const X = p.chart[0] - cx, Y = p.chart[1] - cy;
      const U = p.geo[0] - ux, V = p.geo[1] - uy;
      sa += X * U + Y * V; sb += X * V - Y * U; ss += X * X + Y * Y;
    }
    if (!(ss > 0)) return null;
    const scale = Math.hypot(sa, sb) / ss;
    const rot = Math.atan2(sb, sa);
    return {
      scale,
      rot,
      apply: (x, y) => {
        const X = x - cx, Y = y - cy;
        return [ux + scale * (X * Math.cos(rot) - Y * Math.sin(rot)), uy + scale * (X * Math.sin(rot) + Y * Math.cos(rot))];
      },
    };
  };

  /* With a model in hand no direction test is needed: a runway is drawn where
     the model says it is, at the length it says, and that is the whole check. */
  const collect = model => {
    const hits = [];
    for (const g of geo) {
      let good = null;
      for (const s of pool) {
        if (Math.abs((s.length * model.scale) / g.len - 1) > 0.18) continue;
        /* The model already turns the chart: the runway has to lie along the
           direction that turn gives it, or it is not this runway at all. */
        if (angleGap(s.angle, g.dir - model.rot) > 0.09) continue;
        const err = dist(model.apply(s.mid[0], s.mid[1]), g.mid);
        if (err < tolNm && (!good || err < good.err)) good = { stroke: s, err };
      }
      if (good) hits.push({ g, ...good });
    }
    return hits;
  };

  let best = null;
  for (let i = 0; i < geo.length; i++) {
    for (let j = i + 1; j < geo.length; j++) {
      const E = geo[i], F = geo[j];
      const wantGap = angleGap(E.dir, F.dir);
      for (let a = 0; a < pool.length; a++) {
        const P = pool[a];
        for (let b = a + 1; b < pool.length; b++) {
          const Q = pool[b];
          if (Math.abs(angleGap(P.angle, Q.angle) - wantGap) > 0.07) continue;
          if (Math.abs((E.len / P.length) / (F.len / Q.length) - 1) > 0.18) continue;
          for (const swap of [0, 1]) {
            const model = fit(swap
              ? [{ chart: P.mid, geo: F.mid }, { chart: Q.mid, geo: E.mid }]
              : [{ chart: P.mid, geo: E.mid }, { chart: Q.mid, geo: F.mid }]);
            if (!model) continue;
            const hits = collect(model);
            if (hits.length < 3) continue;
            const refined = fit(hits.map(h => ({ chart: h.stroke.mid, geo: h.g.mid })));
            if (!refined) continue;
            let worst = 0;
            for (const h of hits) worst = Math.max(worst, dist(refined.apply(h.stroke.mid[0], h.stroke.mid[1]), h.g.mid));
            if (worst > tolNm) continue;
            const score = hits.length * 100 - worst * 500;
            if (!best || score > best.score) best = { score, hits, model: refined, worst };
          }
        }
      }
    }
  }
  if (!best) return null;

  /* The anchors handed to the map: each band's centre stepped out to the ends
     the published runway length implies, so the sheet is pinned to thresholds
     rather than to wherever the printed band happened to stop. */
  const pairs = [];
  const idents = [];
  for (const h of best.hits) {
    const ux = h.stroke.b[0] - h.stroke.a[0];
    const uy = h.stroke.b[1] - h.stroke.a[1];
    const n = Math.hypot(ux, uy) || 1;
    const half = h.g.len / best.model.scale / 2;
    const c = h.stroke.mid;
    const p1 = [c[0] - (ux / n) * half, c[1] - (uy / n) * half];
    const p2 = [c[0] + (ux / n) * half, c[1] + (uy / n) * half];
    const [ea, eb] = h.g.rwy.ends;
    pairs.push({ chart: p1, lon: ea.lon, lat: ea.lat }, { chart: p2, lon: eb.lon, lat: eb.lat });
    idents.push(ea.ident + '/' + eb.ident);
  }
  return { idents, residualNm: best.worst, scaleMetresPerPx: best.model.scale * 1852, pairs };
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
