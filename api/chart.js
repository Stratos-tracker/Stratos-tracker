// Stratos API: one published chart document.
// Query: /api/chart?cycle=2610&file=00375AD.PDF                    (FAA d-TPP)
//        /api/chart?source=austrocontrol&icao=LOWW&cycle=261030&pdf=LO_AD_2_LOWW_1-1_en.pdf
//        /api/chart?source=sia-france&icao=LFPG&edition=eAIP_29_OCT_2026&pdf=AD_2_LFPG_SID_...pdf
//        /api/chart?source=sia-france&icao=LFPG&edition=eAIP_29_OCT_2026   (aerodrome sheet)
//
// A deliberately narrow pass-through. The only hosts, path shapes and document
// names that can be requested are those the publishing authority actually
// serves, and only where its terms allow Stratos to display the document:
//   - FAA d-TPP: U.S. Government work, public domain.
//   - AIP Austria: CC BY 4.0, attribution shown beside the chart.
//   - AIP France: Licence Ouverte, attribution shown beside the chart.
// No other URL, header or credential is forwarded.

import { EAIP_SOURCES, franceChartUrl, francePdfUrl, isEaipPdfName } from '../app/js/lib/eaip.js';
import { airmateDocument } from './airmate.js';

const ALLOWED_FILE = /^[A-Z0-9]{1,12}\.PDF$/;
const ALLOWED_CYCLE = /^\d{4}$/;
const ALLOWED_EAIP_CYCLE = /^\d{6}$/;
const ALLOWED_ICAO = /^[A-Z]{4}$/;
const MAX_BYTES = 24 * 1024 * 1024;

// HTTP header values are latin-1, but a credit line is written for people and
// may carry a typographic dash or a copyright sign. Fold those to their plain
// ASCII equivalents so a credit can never break the document response.
export function headerText(value) {
  return String(value == null ? '' : value)
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/\u00a9/g, '(c)')
    .replace(/\u00ae/g, '(r)')
    .replace(/\u2122/g, '(tm)')
    .replace(/\u2026/g, '...')
    .replace(/[^\x20-\x7E]/g, '');
}

function fail(res, status, error, message) {
  res.setHeader('Cache-Control', 'no-store');
  res.status(status).json({ error, message });
}

/** Resolve the request to one allowlisted URL, or null. Exported for tests. */
export function documentUrl(query) {
  const source = String((query && query.source) || '').trim().toLowerCase();
  if (source === 'austrocontrol' || source === 'austrocontrol-eaip') {
    const cycle = String(query.cycle || '').trim();
    const icao = String(query.icao || '').trim().toUpperCase();
    // The published file name is matched case-insensitively but forwarded in
    // the case the authority uses: the AIP serves "_en.pdf" and 404s on "_EN.PDF".
    const pdf = String(query.pdf || '').trim();
    const provider = EAIP_SOURCES['austrocontrol-eaip'];
    if (!ALLOWED_EAIP_CYCLE.test(cycle) || !ALLOWED_ICAO.test(icao) || !isEaipPdfName(pdf)) return null;
    // The document belongs to the airport it names: LOWW charts cannot be
    // requested through another aerodrome's path.
    if (!new RegExp(`_${icao}_`, 'i').test(pdf)) return null;
    return {
      url: `${provider.base}/${cycle}/Charts/${icao}/${pdf}`,
      credit: provider.attribution,
    };
  }
  if (source === 'sia-france') {
    const edition = String(query.edition || '').trim();
    const icao = String(query.icao || '').trim().toUpperCase();
    const pdf = String(query.pdf || '').trim();
    if (!ALLOWED_ICAO.test(icao)) return null;
    const provider = EAIP_SOURCES['sia-france'];
    // Without a name the aerodrome sheet is served from its stable direct path.
    // With one, it must be a chart the SIA publishes for this very airport in
    // this edition's Cartes folder: the URL is built here, never taken from the
    // caller, so a chart cannot be fetched from another aerodrome's folder.
    const url = pdf ? franceChartUrl(provider, edition, icao, pdf) : francePdfUrl(provider, edition, icao);
    return url ? { url, credit: provider.attribution } : null;
  }
  if (source === 'airmate') {
    // The caller names an airport and a document; the address comes from the
    // catalogue Airmate returned, never from the query string.
    const icao = String(query.icao || '').trim().toUpperCase();
    const doc = String(query.doc || '').trim().toUpperCase();
    if (!ALLOWED_ICAO.test(icao) || !/^[A-Z0-9][A-Z0-9-]{0,11}$/.test(doc)) return null;
    return airmateDocument(icao, doc);
  }
  const cycle = String((query && query.cycle) || '').trim();
  const file = String((query && query.file) || '').trim().toUpperCase();
  if (!ALLOWED_CYCLE.test(cycle) || !ALLOWED_FILE.test(file)) return null;
  return {
    url: `https://aeronav.faa.gov/d-tpp/${cycle}/${file}`,
    credit: 'U.S. Government work — public domain (FAA)',
  };
}

export default async function handler(req, res) {
  const target = documentUrl(req.query || {});
  if (!target) {
    fail(res, 400, 'bad-request', 'Invalid chart request.');
    return;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(target.url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Stratos/2 (flight simulation companion; published aeronautical charts)',
        Accept: 'application/pdf',
      },
    });
    if (!response.ok) {
      fail(res, 502, 'upstream', `The document source answered ${response.status}.`);
      return;
    }
    const declared = Number(response.headers.get('content-length') || 0);
    if (declared > MAX_BYTES) {
      fail(res, 502, 'too-large', 'The document is larger than Stratos will serve.');
      return;
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > MAX_BYTES || buffer.subarray(0, 4).toString() !== '%PDF') {
      fail(res, 502, 'not-a-pdf', 'The source did not return a PDF document.');
      return;
    }
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // Attribution travels with the document so it is credited wherever it is
    // rendered, not only in the page that requested it.
    res.setHeader('X-Chart-Attribution', headerText(target.credit));
    // The cycle is part of the URL, so a document never changes in place.
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.status(200).send(buffer);
  } catch (error) {
    fail(res, 502, 'upstream',
      error && error.name === 'AbortError' ? 'The document request timed out.' : (error.message || String(error)));
  } finally {
    clearTimeout(timer);
  }
}
