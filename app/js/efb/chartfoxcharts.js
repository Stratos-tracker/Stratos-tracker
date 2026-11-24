/* EFB · Charts · ChartFox listing for a linked ChartFox account.
 *
 * Read from ChartFox's v2 API with the user's own token (airports:view,
 * charts:index): the airport, its charts grouped by type, and its runways.
 * A chart's view_url is ChartFox's own viewer page (chartfox.org/EGLL#id),
 * not a file, so a chart opens there; Stratos copies no chart and no file.
 * The existing chart providers are untouched and stay the fallback.
 */

import { chartfoxConnected, chartfoxGet } from '../lib/chartfox.js';
import { namesApproach, namesProcedure } from '../lib/routecharts.js';

const WORDS = ['ZERO', 'ONE', 'TWO', 'THREE', 'FOUR', 'FIVE', 'SIX', 'SEVEN', 'EIGHT', 'NINE'];

/** SIDs and STARs by their idents: "OSHNN FIVE (RNAV)" is "SID - OSHNN5". Other charts keep their name. */
export function shortChartName(chart) {
  const name = String((chart && chart.name) || 'Chart').trim();
  const kind = chart && chart.type_key;
  if (kind !== 'SID' && kind !== 'STAR') return name;
  const text = name.toUpperCase().replace(new RegExp(`\\b([A-Z]{2,5}) (${WORDS.join('|')})\\b`, 'g'), (_, fix, word) => fix + WORDS.indexOf(word));
  const idents = [...new Set(text.match(/\b[A-Z]{2,5}\d[A-Z]?\b/g) || [])];
  return `${kind} - ${idents.length ? idents.join('/') : name}`;
}

/** The georeferenced charts a route uses at one airport: its SID, STAR and approach. */
export function routeChartfoxCharts(grouped, { sid = '', star = '', approach = '', runway = '' } = {}) {
  const charts = Object.values((grouped && grouped.data) || {}).filter(Array.isArray).flat()
    .filter(chart => chart && chart.has_georeferences && !/\bCONT/i.test(chart.name || ''));
  const pick = (kind, test) => charts.find(chart => chart.type_key === kind && test(String(chart.name || '')));
  return [
    sid && pick('SID', name => namesProcedure(name, sid)),
    star && pick('STAR', name => namesProcedure(name, star)),
    (approach || runway) && pick('Approach', name => namesApproach(name, approach, runway)),
  ].filter(Boolean);
}

const TTL = 15 * 60 * 1000;
const CACHE = 'stratos.chartfox.cache.';

/* ChartFox's chart types, in the order a pilot reads them. */
const TYPE_ORDER = ['GroundLayout', 'SID', 'STAR', 'Approach', 'Unknown'];
const TYPE_TITLES = {
  GroundLayout: 'Airport & ground layout', SID: 'Departures (SID)', STAR: 'Arrivals (STAR)',
  Approach: 'Approaches', Unknown: 'General & other',
};

/** The grouped response as ordered sections: known types first, then any others ChartFox adds. */
export function groupedSections(data) {
  const groups = data && typeof data === 'object' ? Object.values(data).filter(Array.isArray) : [];
  const sections = groups.filter(list => list.length).map(list => {
    const key = String(list[0].type_key || 'Unknown');
    return { key, title: TYPE_TITLES[key] || key.replace(/([a-z])([A-Z])/g, '$1 $2'), charts: list };
  });
  const rank = key => (TYPE_ORDER.includes(key) ? TYPE_ORDER.indexOf(key) : TYPE_ORDER.length);
  return sections.sort((a, b) => rank(a.key) - rank(b.key));
}

/** A chart's metadata entries as short "label: value" text (e.g. runways). */
export function metaText(meta) {
  if (!Array.isArray(meta)) return [];
  return meta.map(entry => {
    if (!entry || typeof entry !== 'object') return '';
    const value = entry.value;
    const shown = Array.isArray(value) ? value.join(', ')
      : value && typeof value === 'object' ? Object.values(value).filter(v => v != null && typeof v !== 'object').join(', ')
        : value == null ? '' : String(value);
    const label = String(entry.type_key || '').replace(/([a-z])([A-Z])/g, '$1 $2');
    return shown ? (label ? `${label}: ${shown}` : shown) : '';
  }).filter(Boolean);
}

/** Only ChartFox's own viewer pages are opened from a chart row. */
export function viewerUrl(value) {
  const raw = String(value || '');
  return /^https:\/\/chartfox\.org\//.test(raw) ? raw : '';
}

export async function cachedGet(path) {
  try {
    const hit = JSON.parse(sessionStorage.getItem(CACHE + path) || 'null');
    if (hit && Date.now() - hit.at < TTL) return hit.body;
  } catch (_) { /* no cache */ }
  const body = await chartfoxGet(path);
  try { sessionStorage.setItem(CACHE + path, JSON.stringify({ at: Date.now(), body })); } catch (_) { /* full */ }
  return body;
}

/** A ChartFox chart as a Charts record, opened in the Stratos viewer via the proxy. */
export function chartRecord(chart, icao) {
  return {
    source: 'chartfox', sourceName: 'ChartFox', icao: String(chart.airport_icao || icao || '').toUpperCase(),
    pdf: chart.id, code: chart.code || '', cycle: String(chart.updated_at || '').slice(0, 10) || 'chartfox',
    title: shortChartName(chart), url: viewerUrl(chart.view_url) || null, attribution: 'Charts via ChartFox',
  };
}
