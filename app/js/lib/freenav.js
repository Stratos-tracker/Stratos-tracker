/* FreeNav — free German chart index.
 *
 * FreeNav (https://freenav.github.io/) is an independent, non-commercial index
 * of German AIP charts. Its own notice says the material is published with DFS
 * permission for flight simulation and home use, not for navigation.
 *
 * FreeNav publishes its index as one JavaScript object that maps an ICAO code
 * to GND, SID, STAR, IAC and VFR chart names and links. Those links point at the
 * official DFS print endpoint (aip.dfs.de); FreeNav does not mirror the PDFs.
 * Stratos reads only that small public index (GitHub Pages allows CORS) and
 * opens the DFS document in a new tab. It never fetches, proxies, frames or
 * caches the PDFs, and it never invents a chart that FreeNav did not list.
 *
 * The index is untrusted input. Every link is checked against the DFS print
 * endpoint and against the airport it belongs to before it reaches the page.
 */

export const FREENAV_HOME = 'https://freenav.github.io/';
export const FREENAV_INDEX_URL = 'https://freenav.github.io/script.js';

export const FREENAV_NOTICE = 'FreeNav is a free German chart index published with DFS permission for flight simulation and home use. It is not for navigation.';

/** FreeNav's chart chapters, in the order the site presents them. */
export const FREENAV_SECTIONS = [
  { key: 'GND', label: 'Ground & aerodrome', category: 'diagram' },
  { key: 'SID', label: 'Standard instrument departures', category: 'sid' },
  { key: 'STAR', label: 'Standard terminal arrivals', category: 'star' },
  { key: 'IAC', label: 'Instrument approaches', category: 'approach' },
  { key: 'VFR', label: 'VFR charts', category: 'vfr' },
];

const SECTION_BY_KEY = new Map(FREENAV_SECTIONS.map(section => [section.key, section]));

/** EDxx and ETxx are the German location indicators FreeNav covers. */
export function isFreenavIcao(icao) {
  return /^(ED|ET)[A-Z0-9]{2}$/.test(String(icao || '').trim().toUpperCase());
}

function cleanText(value, max = 160) {
  return String(value == null ? '' : value)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/** Strip JavaScript comments without touching slashes inside quoted strings. */
function withoutComments(text) {
  let result = '';
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (inString) {
      result += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      result += char;
      continue;
    }
    if (char === '/' && text[index + 1] === '/') {
      while (index < text.length && text[index] !== '\n' && text[index] !== '\r') index++;
      result += '\n';
      continue;
    }
    if (char === '/' && text[index + 1] === '*') {
      index += 2;
      while (index < text.length && !(text[index] === '*' && text[index + 1] === '/')) index++;
      index++;
      continue;
    }
    result += char;
  }
  return result;
}

/** The balanced `{...}` literal assigned to `airports`, or null. */
function airportsLiteral(source) {
  const marker = /\bairports\s*=\s*\{/.exec(source);
  if (!marker) return null;
  const start = source.indexOf('{', marker.index);
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < source.length; index++) {
    const char = source[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{') depth++;
    else if (char === '}') {
      depth--;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  return null;
}

/** JSON.parse the literal, accepting the trailing commas a JS file may carry. */
function objectFromLiteral(literal) {
  const cleaned = withoutComments(literal);
  for (const candidate of [cleaned, cleaned.replace(/,\s*([}\]])/g, '$1')]) {
    try {
      const data = JSON.parse(candidate);
      if (data && typeof data === 'object' && !Array.isArray(data)) return data;
    } catch (_) { /* try the relaxed form next */ }
  }
  return null;
}

/**
 * True only for https links on aip.dfs.de's print endpoint, and only when the
 * document path names the airport it is being shown for.
 */
export function isDfsChartUrl(value, icao = '') {
  const code = String(icao || '').trim().toUpperCase();
  try {
    const url = new URL(String(value || ''));
    if (url.protocol !== 'https:' || url.hostname !== 'aip.dfs.de') return false;
    if (url.port || url.username || url.password || url.search || url.hash) return false;
    if (!/^\/(?:basicIFR|basicVFR)\/print\/AD\/[A-Za-z0-9%._~!$&'()*+,;=:@-]+\/[A-Za-z0-9%._~!$&'()*+,;=:@-]+$/.test(url.pathname)) return false;
    const decoded = decodeURIComponent(url.pathname);
    if (decoded.includes('..')) return false;
    if (code && !decoded.split(/[^A-Z0-9]+/).includes(code)) return false;
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Read FreeNav's index into a Map of ICAO → section list.
 *
 * A chart is kept only when its title and link are usable and the DFS address
 * belongs to that airport. An airport with no verified chart is absent, so the
 * interface never offers an empty or fabricated section.
 */
export function parseFreenavIndex(source) {
  const literal = airportsLiteral(String(source || ''));
  if (!literal) return null;
  const data = objectFromLiteral(literal);
  if (!data) return null;

  const airports = new Map();
  for (const [rawIcao, rawSections] of Object.entries(data)) {
    const icao = String(rawIcao || '').trim().toUpperCase();
    if (!isFreenavIcao(icao)) continue;
    if (!rawSections || typeof rawSections !== 'object' || Array.isArray(rawSections)) continue;

    const sections = [];
    for (const [rawKey, rawCharts] of Object.entries(rawSections)) {
      const spec = SECTION_BY_KEY.get(String(rawKey || '').trim().toUpperCase());
      if (!spec || !rawCharts || typeof rawCharts !== 'object' || Array.isArray(rawCharts)) continue;
      const charts = [];
      const seen = new Set();
      for (const [rawTitle, rawUrl] of Object.entries(rawCharts)) {
        const title = cleanText(rawTitle);
        const url = typeof rawUrl === 'string' ? rawUrl.trim() : '';
        if (!title || !isDfsChartUrl(url, icao)) continue;
        const key = `${title}\n${url}`;
        if (seen.has(key)) continue;
        seen.add(key);
        charts.push({
          icao,
          title,
          url,
          section: spec.key,
          sectionLabel: spec.label,
          category: spec.category,
        });
      }
      if (charts.length) sections.push({ ...spec, charts });
    }
    if (sections.length) airports.set(icao, sections);
  }
  return airports.size ? airports : null;
}

/** One airport's sections and flat chart list, or null when FreeNav has none. */
export function freenavForIcao(index, icao) {
  const code = String(icao || '').trim().toUpperCase();
  if (!index || typeof index.get !== 'function') return null;
  const sections = index.get(code);
  if (!Array.isArray(sections) || !sections.length) return null;
  return {
    icao: code,
    sections,
    charts: sections.flatMap(section => section.charts),
  };
}

let cachedIndex = null;
let cachedAt = 0;
let pendingIndex = null;
const INDEX_CACHE_MS = 30 * 60 * 1000;

/**
 * Read FreeNav's public index. A failure is reported, never replaced with an
 * empty or stale chart list; the caller can fall back to another source.
 */
export async function loadFreenavIndex(now = Date.now()) {
  if (cachedIndex && now - cachedAt < INDEX_CACHE_MS) return cachedIndex;
  if (pendingIndex) return pendingIndex;
  pendingIndex = (async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetch(FREENAV_INDEX_URL, {
        cache: 'no-store',
        credentials: 'omit',
        signal: controller.signal,
        headers: { Accept: 'text/javascript, application/javascript, text/plain' },
      });
      if (!response.ok) throw new Error(`FreeNav answered ${response.status}.`);
      const text = await response.text();
      const index = parseFreenavIndex(text);
      if (!index) throw new Error('FreeNav’s chart index could not be read.');
      cachedIndex = index;
      cachedAt = Date.now();
      return index;
    } finally {
      clearTimeout(timer);
    }
  })().catch(error => {
    if (error && error.name === 'AbortError') throw new Error('FreeNav’s chart index timed out.');
    throw error;
  }).finally(() => { pendingIndex = null; });
  return pendingIndex;
}

/** Clear the in-memory index (tests and an explicit refresh). */
export function resetFreenavCache() {
  cachedIndex = null;
  cachedAt = 0;
  pendingIndex = null;
}
