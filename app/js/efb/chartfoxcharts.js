/* EFB · Charts · ChartFox listing for a linked ChartFox account.
 *
 * Read from ChartFox's v2 API with the user's own token (airports:view,
 * charts:index): the airport, its charts grouped by type, and its runways.
 * A chart's view_url is ChartFox's own viewer page (chartfox.org/EGLL#id),
 * not a file, so a chart opens there; Stratos copies no chart and no file.
 * The existing chart providers are untouched and stay the fallback.
 */

import { chartfoxConnected, chartfoxGet } from '../lib/chartfox.js';
import { esc } from './common.js';
import { namesApproach, namesProcedure } from '../lib/routecharts.js';

const NUMBER_WORDS = /\s+(ZERO|ONE|TWO|THREE|FOUR|FIVE|SIX|SEVEN|EIGHT|NINE)\b.*$/;

/** A short chart name: the OSHNN5 SID is "SID - OSHNN". Other charts keep their own name. */
export function shortChartName(chart) {
  const name = String((chart && chart.name) || 'Chart').trim();
  const kind = chart && chart.type_key;
  if (kind !== 'SID' && kind !== 'STAR') return name;
  const fix = name.toUpperCase().replace(/\(.*?\)/g, '').replace(NUMBER_WORDS, '').trim().split(/\s+/)[0].replace(/\d[A-Z]?$/, '');
  return fix ? `${kind} - ${fix}` : name;
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

async function cachedGet(path) {
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

/** Fill `panel` for `icao`; `onPick(icao)` loads another airport, `onOpen(record)` shows a chart. */
export function createChartfoxPanel(panel, onPick, onOpen = () => {}) {
  let current = '';
  let shown = new Map();
  let filter = '';

  const shell = inner => `<div class="cfp">${inner}</div>`;
  const searchBox = `<form class="cfp-search" data-cfp-search><input class="e-input small" name="q" placeholder="ChartFox: ICAO, IATA or airport name" aria-label="Search ChartFox airports"><button class="e-btn small" type="submit">Find</button></form><div class="cfp-results" data-cfp-results></div>`;

  async function show(icao) {
    current = String(icao || '').toUpperCase();
    if (!chartfoxConnected()) { panel.innerHTML = ''; return; }
    if (!current) { panel.innerHTML = shell(searchBox); return; }
    panel.innerHTML = shell(`${searchBox}<div class="e-loading"><i></i>Loading ChartFox charts for ${esc(current)}…</div>`);
    const asked = current;
    try {
      const [airport, grouped, runways] = await Promise.all([
        cachedGet(`/v2/airports/${encodeURIComponent(asked)}`),
        cachedGet(`/v2/airports/${encodeURIComponent(asked)}/charts/grouped`),
        cachedGet(`/v2/airports/${encodeURIComponent(asked)}/runways`).catch(() => null),
      ]);
      if (asked !== current) return;
      render(airport, grouped, runways);
    } catch (error) {
      if (asked !== current) return;
      panel.innerHTML = shell(`${searchBox}<div class="e-notice ${error.code === 'signed-out' ? 'warn' : 'bad'}">${esc(error.message)}</div>`);
    }
  }

  function render(airport, grouped, runways) {
    if (!airport) {
      panel.innerHTML = shell(`${searchBox}<div class="ch-hint"><b>${esc(current)} is not in ChartFox</b><span>The other chart sources below still apply.</span></div>`);
      return;
    }
    const sections = groupedSections(grouped && grouped.data);
    const total = sections.reduce((n, s) => n + s.charts.length, 0);
    const rwys = (runways && Array.isArray(runways.data) ? runways.data : []).map(r => r && r.designator).filter(Boolean);
    const head = `<div class="cfp-head"><b>${esc(airport.icao_code || airport.ident)}${airport.iata_code ? ` · ${esc(airport.iata_code)}` : ''}</b>
      <span>${esc(airport.name || '')}${Number.isFinite(airport.elevation_ft) ? ` · ${esc(String(airport.elevation_ft))} ft` : ''}${rwys.length ? ` · RWY ${esc(rwys.join(' '))}` : ''}</span></div>`;
    if (!total) {
      panel.innerHTML = shell(`${searchBox}${head}<div class="ch-hint"><b>No ChartFox charts for ${esc(current)}</b><span>ChartFox lists this airport but publishes no charts for it.</span></div>`);
      return;
    }
    shown = new Map(sections.flatMap(s => s.charts).map(chart => [String(chart.id), chart]));
    const match = chart => !filter || `${chart.name} ${chart.code}`.toLowerCase().includes(filter);
    const body = sections.map(section => {
      const rows = section.charts.filter(match);
      if (!rows.length) return '';
      return `<details class="cfp-group" open><summary>${esc(section.title)} <em>${rows.length}</em></summary>${rows.map(chart => {
        const url = viewerUrl(chart.view_url);
        const meta = metaText(chart.meta);
        return `<div class="e-list-item cfp-chart">
          <div class="li-main"><b>${esc(shortChartName(chart))}</b><span>${esc([chart.code, ...meta].filter(Boolean).join(' · '))}</span></div>
          ${chart.has_georeferences ? '<span class="e-badge">Georeferenced</span>' : ''}
          <button class="e-btn small primary" type="button" data-cfp-open="${esc(String(chart.id))}">View</button>
          ${url ? `<a class="e-btn small ghost" href="${esc(url)}" target="_blank" rel="noopener noreferrer" title="Open in ChartFox">↗</a>` : ''}
        </div>`;
      }).join('')}</details>`;
    }).join('');
    panel.innerHTML = shell(`${searchBox}${head}
      <input class="e-input small cfp-filter" data-cfp-filter value="${esc(filter)}" placeholder="Filter ${total} ChartFox charts" aria-label="Filter ChartFox charts">
      ${body || '<div class="ch-hint"><b>No matching charts</b><span>Clear the filter to see them all.</span></div>'}
      <div class="e-small e-faint cfp-note">ChartFox charts open in the viewer here; ↗ opens ChartFox's own page.</div>`);
  }

  async function search(query, page = 1) {
    const box = panel.querySelector('[data-cfp-results]');
    if (!box) return;
    box.innerHTML = '<div class="e-loading"><i></i>Searching ChartFox…</div>';
    try {
      const result = await cachedGet(`/v2/airports?query=${encodeURIComponent(query)}&page=${page}`);
      const list = result && Array.isArray(result.data) ? result.data : [];
      const more = result && result.meta && result.meta.current_page < result.meta.last_page;
      box.innerHTML = list.length
        ? list.map(a => `<button type="button" class="e-list-item cfp-airport" data-cfp-pick="${esc(a.icao_code || a.ident)}">
            <div class="li-main"><b>${esc(a.icao_code || a.ident)}${a.iata_code ? ` · ${esc(a.iata_code)}` : ''}</b><span>${esc(a.name || '')}${a.iso_a2_country ? ` · ${esc(a.iso_a2_country)}` : ''}</span></div>
            ${a.has_charts ? '<span class="e-badge">Charts</span>' : '<span class="e-badge">No charts</span>'}
          </button>`).join('') + (more ? `<button type="button" class="e-btn small" data-cfp-more="${page + 1}" data-cfp-q="${esc(query)}">More results</button>` : '')
        : '<div class="ch-hint"><b>No airports found</b><span>Try an ICAO or IATA code, or part of the name.</span></div>';
    } catch (error) {
      box.innerHTML = `<div class="e-notice bad">${esc(error.message)}</div>`;
    }
  }

  panel.addEventListener('submit', event => {
    const form = event.target.closest('[data-cfp-search]');
    if (!form) return;
    event.preventDefault();
    const q = String(new FormData(form).get('q') || '').trim();
    if (q) search(q);
  });
  panel.addEventListener('click', event => {
    const open = event.target.closest('[data-cfp-open]');
    if (open && shown.has(open.dataset.cfpOpen)) { onOpen(chartRecord(shown.get(open.dataset.cfpOpen), current)); return; }
    const pick = event.target.closest('[data-cfp-pick]');
    if (pick) { onPick(pick.dataset.cfpPick); return; }
    const more = event.target.closest('[data-cfp-more]');
    if (more) search(more.dataset.cfpQ, Number(more.dataset.cfpMore));
  });
  panel.addEventListener('input', event => {
    if (!event.target.matches('[data-cfp-filter]')) return;
    filter = event.target.value.trim().toLowerCase();
    const at = event.target.selectionStart;
    show(current).then(() => {
      const box = panel.querySelector('[data-cfp-filter]');
      if (box) { box.focus(); box.setSelectionRange(at, at); }
    });
  });

  return { show };
}
