// Stratos API: the terminal chart catalogue for one airport.
// Query: /api/charts?icao=KJFK
//
// Two publishers are integrated, both because their own terms allow it:
//   - FAA d-TPP (U.S. Government work, public domain): one metafile per cycle.
//   - AIP Austria (CC BY 4.0): the authority's chart index per aerodrome.
// Every other authority is a link in data/chart-sources.js, not a catalogue:
// a publicly readable AIP is not a redistribution licence.
//
// Nothing is bundled: a stale copy on disk could mark an expired procedure as
// current. Each source is cached only for its own publication cycle window.

import { FAA_BASE, faaCycle, parseFaaAirport, parseMetafileHeader } from '../app/js/lib/charts.js';
import {
  eaipAirportPage, eaipForIcao, eaipPdfUrl, parseEaipCharts, parseEaipCycleIndex, parseEaipValidity,
} from '../app/js/lib/eaip.js';

const CACHE_MS = 6 * 60 * 60 * 1000;
const FETCH_TIMEOUT = 25000;

let faaCache = null; // { text, header, at, cycle }
let faaPending = null;

async function download(url, accept = 'text/xml,application/xml,text/html') {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: accept,
        'User-Agent': 'Stratos/2 (flight simulation companion; charts from the publishing authority)',
      },
    });
    if (!response.ok) return null;
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

async function faaCatalogue() {
  if (faaCache && Date.now() - faaCache.at < CACHE_MS) return faaCache;
  if (faaPending) return faaPending;
  faaPending = (async () => {
    // The 28-day guess can land in the gap around a cycle change, so try the
    // neighbouring cycles too and keep whichever publication the FAA serves.
    for (const step of [0, 1, -1, 2]) {
      const guess = faaCycle(Date.now() + step * 28 * 86400000);
      const text = await download(`${FAA_BASE}/${guess}/xml_data/d-TPP_Metafile.xml`);
      if (!text || !text.includes('<digital_tpp')) continue;
      const header = parseMetafileHeader(text);
      faaCache = { text, header, at: Date.now(), cycle: header.cycle || guess };
      return faaCache;
    }
    throw new Error('The FAA d-TPP publication could not be reached.');
  })().finally(() => { faaPending = null; });
  return faaPending;
}

/* ── AIP Austria ──────────────────────────────────────────────────────── */

const eaipCache = new Map(); // key: `${source.id}:${icao}:${cycle}`
let eaipCycle = null; // { cycle, at }

/** Current Austrian cycle, read from the publisher's own landing page. */
async function austrianCycle() {
  if (eaipCycle && Date.now() - eaipCycle.at < 60 * 60 * 1000) return eaipCycle.cycle;
  const html = await download('https://eaip.austrocontrol.at/', 'text/html');
  const cycle = parseEaipCycleIndex(html);
  if (!cycle) throw new Error('The AIP Austria publication cycle could not be read.');
  eaipCycle = { cycle, at: Date.now() };
  return cycle;
}

async function eaipCatalogue(source, icao) {
  const cycle = await austrianCycle();
  const key = `${source.id}:${icao}:${cycle}`;
  const hit = eaipCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit;

  const pageUrl = eaipAirportPage(source, cycle, icao);
  const html = await download(pageUrl, 'text/html');
  if (!html) return null;
  const charts = parseEaipCharts(html, { icao, cycle }).map(chart => ({
    ...chart,
    url: eaipPdfUrl(source, cycle, icao, chart.pdf),
  }));
  if (!charts.length) return null;
  const validity = parseEaipValidity(html);
  const entry = {
    source: source.id,
    sourceName: `${source.name} (${source.licenceLabel})`,
    license: source.attribution,
    attribution: source.attribution,
    cycle,
    effective: validity.effective,
    expires: validity.expires,
    checkedAt: Date.now(),
    at: Date.now(),
    icao,
    charts,
  };
  eaipCache.set(key, entry);
  return entry;
}

export default async function handler(req, res) {
  const icao = String((req.query && req.query.icao) || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{3,5}$/.test(icao)) {
    res.setHeader('Cache-Control', 'no-store');
    res.status(400).json({ error: 'A 3-5 character airport identifier is required.' });
    return;
  }

  const eaip = eaipForIcao(icao);
  if (eaip) {
    let data;
    try {
      data = await eaipCatalogue(eaip, icao);
    } catch (error) {
      res.setHeader('Cache-Control', 'no-store');
      res.status(502).json({ error: 'source-unavailable', message: error.message || String(error), retry: true });
      return;
    }
    if (!data) {
      res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=600');
      res.status(404).json({
        source: eaip.id,
        sourceName: eaip.name,
        license: eaip.attribution,
        icao,
        charts: [],
        unsupported: true,
        message: `${eaip.name} publishes no aerodrome chart index for ${icao}.`,
      });
      return;
    }
    res.setHeader('Cache-Control', 'public, s-maxage=21600, stale-while-revalidate=3600');
    res.status(200).json({
      source: data.source,
      sourceName: data.sourceName,
      license: data.license,
      attribution: data.attribution,
      cycle: data.cycle,
      effective: data.effective,
      expires: data.expires,
      checkedAt: data.checkedAt,
      icao,
      charts: data.charts.map(chart => ({
        code: chart.code,
        title: chart.title,
        pdf: chart.pdf,
        url: chart.url,
        category: chart.category,
      })),
    });
    return;
  }

  let data;
  try {
    data = await faaCatalogue();
  } catch (error) {
    res.setHeader('Cache-Control', 'no-store');
    res.status(502).json({ error: 'source-unavailable', message: error.message || String(error), retry: true });
    return;
  }

  const base = {
    source: 'faa-dtpp',
    sourceName: 'FAA Digital Terminal Procedures',
    license: 'U.S. Government work - public domain',
    effective: data.header.from,
    expires: data.header.to,
    checkedAt: data.at,
    icao,
  };

  const block = parseFaaAirport(data.text, icao);
  if (!block || !block.records.length) {
    res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=600');
    res.status(404).json({
      ...base,
      cycle: data.cycle,
      unsupported: true,
      charts: [],
      message: `No FAA d-TPP charts are published for ${icao}. Stratos shows a national authority's charts `
        + 'only where its terms allow in-app display; every other publisher is linked from its official site.',
    });
    return;
  }

  res.setHeader('Cache-Control', 'public, s-maxage=21600, stale-while-revalidate=3600');
  res.status(200).json({
    ...base,
    cycle: data.cycle,
    airport: block.name,
    charts: block.records.map(record => ({
      code: record.code,
      title: record.title,
      pdf: record.pdf,
      amended: record.amended,
    })),
  });
}
