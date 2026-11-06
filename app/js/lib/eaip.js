/* eAIP providers: national AIPs published as structured HTML with PDF charts.
 *
 * One provider is integrated here — AIP Austria, published by Austro Control.
 * AIP Austria GEN 3.2 §3.1.2 states that every chart published in the AIP is
 * subject to Creative Commons Attribution 4.0 International: it may be used,
 * shared and modified free of charge with credit. That is a real reuse grant
 * from the rights holder, so Stratos may fetch and display those documents
 * itself, with the attribution shown beside the chart.
 *
 * Nothing here invents a document. The chart list is read from the authority's
 * own chart index page for an AIRAC cycle, and a PDF name must match the
 * authority's naming pattern before the proxy will serve it.
 *
 * Adding another eAIP means one descriptor plus whatever its index needs; a
 * publisher whose terms do not grant reuse belongs in data/chart-sources.js as
 * a link, not here.
 */

export const EAIP_SOURCES = {
  'austrocontrol-eaip': {
    id: 'austrocontrol-eaip',
    name: 'AIP Austria',
    publisher: 'Austro Control GmbH',
    country: 'Austria',
    iso2: 'AT',
    region: 'Europe',
    prefixes: ['LO'],
    base: 'https://eaip.austrocontrol.at/lo',
    // The cycle directory is the AIRAC effective date (YYMMDD). It is read from
    // the publisher's index rather than computed, so a shifted cycle cannot
    // point the loader at a directory that does not exist.
    cycleIndexUrl: 'https://eaip.austrocontrol.at/',
    licenceCategory: 'FREE_REUSE',
    licenceLabel: 'CC BY 4.0',
    attribution: '© Austro Control GmbH — AIP Austria, CC BY 4.0',
    terms: 'https://eaip.austrocontrol.at/lo/261002/PART_1/LO_GEN_3_2_en.pdf',
    checked: '2026-11-06',
    note: 'AIP Austria GEN 3.2 §3.1.2 publishes the AIP charts under CC BY 4.0, so Stratos may display them with attribution.',
  },
};

export const EAIP_LIST = Object.values(EAIP_SOURCES);

/** Provider that governs an airport, or null. Longest prefix wins. */
export function eaipForIcao(icao) {
  const code = String(icao || '').trim().toUpperCase();
  if (!/^[A-Z]{4}$/.test(code)) return null;
  const matches = EAIP_LIST.filter(source => source.prefixes.some(prefix => code.startsWith(prefix)));
  if (!matches.length) return null;
  return matches.sort((a, b) => Math.max(...b.prefixes.map(p => p.length)) - Math.max(...a.prefixes.map(p => p.length)))[0];
}

export function eaipById(id) {
  return EAIP_SOURCES[String(id || '')] || null;
}

/** The chart index page for one airport in one cycle. */
export function eaipAirportPage(source, cycle, icao) {
  const code = String(icao || '').trim().toUpperCase();
  if (!source || !/^\d{6}$/.test(String(cycle || '')) || !/^[A-Z]{4}$/.test(code)) return null;
  return `${source.base}/${cycle}/ad_2_${code.toLowerCase()}.htm`;
}

/** The publisher's own PDF address, used for the "Official ↗" link. */
export function eaipPdfUrl(source, cycle, icao, pdf) {
  const page = eaipAirportPage(source, cycle, icao);
  if (!page || !isEaipPdfName(pdf)) return null;
  // The file name keeps the case the publisher serves: the AIP uses lower-case
  // "_en.pdf" and the server is case-sensitive.
  return `${source.base}/${cycle}/Charts/${String(icao).toUpperCase()}/${String(pdf)}`;
}

/** A document name this provider actually publishes. */
export function isEaipPdfName(pdf) {
  return /^LO_AD_2_[A-Z]{4}_[A-Z0-9]+(-[A-Z0-9]+)*_en\.PDF$/i.test(String(pdf || ''));
}

/**
 * Current cycle from the publisher's landing page. The page lists the current
 * version first and the future one second; the first match is the effective
 * publication, which is what a pilot needs.
 */
export function parseEaipCycleIndex(html) {
  const source = String(html || '');
  for (const match of source.matchAll(/\/lo\/(\d{6})\/index\.htm/g)) {
    return match[1];
  }
  return '';
}

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

/** "30 OCT 2026" → epoch ms (UTC), or null. */
export function parseEaipDate(value) {
  const match = /(\d{1,2})\s+([A-Z]{3})\s+(\d{4})/i.exec(String(value || ''));
  if (!match) return null;
  const month = MONTHS.indexOf(match[2].toUpperCase());
  if (month === -1) return null;
  return Date.UTC(Number(match[3]), month, Number(match[1]));
}

/** Effective and expiry timestamps printed on the AIP pages. */
export function parseEaipValidity(html) {
  // The dates sit in table cells, so the markup between the label and the date
  // has to be removed before matching.
  const source = String(html || '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');
  const from = /Effective from:?\s*([0-9]{1,2}\s+[A-Z]{3}\s+[0-9]{4})/i.exec(source);
  const to = /Valid till:?\s*([0-9]{1,2}\s+[A-Z]{3}\s+[0-9]{4})/i.exec(source);
  return {
    effective: from ? parseEaipDate(from[1]) : null,
    expires: to ? parseEaipDate(to[1]) : null,
  };
}

function stripTags(value) {
  return String(value || '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Chart category from the AIP map number, then from the caption.
 * The map series is the publisher's own numbering: 1 aerodrome, 2 parking,
 * 3-7 ground/area, 9 SID, 11 STAR, 13-18 instrument approach.
 */
export function classifyEaipChart(code, caption) {
  const map = /MAP\s*(\d+)/i.exec(String(code || ''));
  const series = map ? Number(map[1]) : null;
  const text = String(caption || '').toUpperCase();
  if (series === 1) return 'diagram';
  if (series === 9) return 'sid';
  if (series === 11) return 'star';
  if (series !== null && series >= 13 && series <= 18) return 'approach';
  if (/STANDARD DEPARTURE|\bSID\b/.test(text)) return 'sid';
  if (/STANDARD ARRIVAL|\bSTAR\b/.test(text)) return 'star';
  if (/INSTRUMENT APPROACH|\bIAC\b/.test(text)) return 'approach';
  if (/AERODROME CHART|GROUND MOVEMENT|PARKING|DOCKING/.test(text)) return 'diagram';
  return 'other';
}

/**
 * Charts listed on one airport's AIP chart page. Each row is a real anchor to a
 * PDF the publisher serves; the caption is what the publisher wrote, never a
 * generated name. A page with no rows returns an empty list.
 */
export function parseEaipCharts(html, { icao, cycle } = {}) {
  const code = String(icao || '').trim().toUpperCase();
  const source = String(html || '');
  const charts = [];
  const seen = new Set();
  const rows = source.split(/<tr[\s>]/i);
  for (const row of rows) {
    const link = /<a[^>]+href="([^"]+\.pdf)"[^>]*>([\s\S]*?)<\/a>/i.exec(row);
    if (!link) continue;
    const href = link[1].trim();
    // Case is preserved: the publisher serves "_en.pdf" and 404s on "_EN.PDF".
    const pdf = href.split('/').pop();
    if (!isEaipPdfName(pdf) || seen.has(pdf)) continue;
    seen.add(pdf);
    const linkText = stripTags(link[2]);
    const english = /<i>([\s\S]*?)<\/i>/i.exec(row);
    const caption = english ? stripTags(english[1]) : '';
    const mapCode = /MAP\s*([\d-]+)/i.exec(linkText);
    const label = mapCode ? `MAP ${mapCode[1]}` : linkText;
    const title = caption && !caption.includes('AD 2') ? `${label} · ${caption}` : label;
    charts.push({
      code: label,
      title,
      caption,
      pdf,
      category: classifyEaipChart(label, caption || linkText),
      cycle: String(cycle || ''),
      icao: code,
    });
  }
  return charts;
}
