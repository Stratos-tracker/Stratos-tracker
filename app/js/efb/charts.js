/* EFB · Charts.
 *
 * A worldwide chart library: the registry in data/chart-sources.js names the
 * publisher for every country Stratos knows about, and this page resolves an
 * airport to its publisher, its licence category and its coverage status.
 *
 * One publisher is integrated — the FAA d-TPP, whose terms allow Stratos to
 * fetch and render the documents. For every other country the page states what
 * the licence allows and links to the authority instead of copying its charts:
 * a public web page is not a redistribution licence. Nothing here invents a
 * chart, and an airport with no registered publisher says exactly that.
 *
 * The viewer is the same PDF implementation the tracker uses, so there is one
 * set of gestures and one renderer inside Stratos.
 */

import {
  esc, searchAirports, loadChartCatalogue, filterCharts, chartSourcesFor,
} from './common.js';
import {
  COUNTRIES, REGIONS, countriesForRegion, licenceFor, registryStats, sourcesForCountry,
} from '../lib/chartdir.js';
import { chartCoverage, coverageStatus } from '../lib/chartproviders.js';
import { accessFor } from '../lib/chartdir.js';
import {
  chartCacheKey, isPdfBytes, officialChartUrl, readChartCache,
  validityState, validityText, writeChartCache,
} from '../lib/charts.js';
import { defaultBridgeBase, isHostedPage } from '../bridge.js';
import { ChartViewer } from '../pilot/charts.js';

/** Integrated publishers whose catalogue is an AIP edition, not an FAA cycle. */
const EAIP_CYCLE = new Set(['austrocontrol-eaip', 'sia-france']);

const RECENT_KEY = 'stratos.efb.charts.recent';
const SAVED_KEY = 'stratos.efb.charts.saved';
const CATEGORY_FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'diagram', label: 'Diagram' },
  { key: 'sid', label: 'SID' },
  { key: 'star', label: 'STAR' },
  { key: 'approach', label: 'Approach' },
  { key: 'other', label: 'Other' },
];

const APPROACH_FAMILIES = ['ils', 'loc', 'rnav', 'vor', 'ndb', 'approach', 'visual'];

/* ChartFox's own document groups. Individual chart metadata is only available
   through its authenticated API; these groups open the airport page instead. */
const CHARTFOX_GROUPS = [
  { key: 'ground', title: 'Airport & ground layout', category: 'diagram', label: 'ChartFox · Ground' },
  { key: 'sid', title: 'Standard instrument departures', category: 'sid', label: 'ChartFox · Departures' },
  { key: 'star', title: 'Standard terminal arrivals', category: 'star', label: 'ChartFox · Arrivals' },
  { key: 'approach', title: 'Approach charts', category: 'approach', label: 'ChartFox · Approaches' },
  { key: 'reference', title: 'General & reference', category: 'other', label: 'ChartFox · Reference' },
];

function chartfoxUrl(code) {
  return `https://chartfox.org/${encodeURIComponent(code)}`;
}

function readList(key, limit) {
  try {
    const raw = JSON.parse(localStorage.getItem(key) || '[]');
    return Array.isArray(raw)
      ? raw.filter(item => item && /^[A-Z0-9]{3,5}$/.test(String(item.icao || '').toUpperCase())).slice(0, limit)
      : [];
  } catch (_) { return []; }
}

function writeList(key, list) {
  try { localStorage.setItem(key, JSON.stringify(list)); } catch (_) { /* private mode */ }
}

function recentAirports() { return readList(RECENT_KEY, 6); }
function savedAirports() { return readList(SAVED_KEY, 12); }

function rememberAirport(icao, name) {
  const list = recentAirports().filter(item => item.icao !== icao);
  list.unshift({ icao, name: name || '' });
  writeList(RECENT_KEY, list.slice(0, 6));
}

function toggleSaved(icao, name) {
  const list = savedAirports();
  const existing = list.findIndex(item => item.icao === icao);
  if (existing === -1) list.unshift({ icao, name: name || '' });
  else list.splice(existing, 1);
  writeList(SAVED_KEY, list.slice(0, 12));
  return existing === -1;
}

/** Flag emoji from an ISO 3166-1 alpha-2 code, or '' when there is none. */
export function flagFor(iso2) {
  const code = String(iso2 || '').toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) return '';
  return String.fromCodePoint(...[...code].map(letter => 0x1F1E6 + letter.charCodeAt(0) - 65));
}

/** ICAO codes a plan actually names, with the role each one plays. */
export function flightAirports(plan) {
  const ofp = (plan && plan.ofp) || {};
  const rows = [];
  const push = (code, role) => {
    const icao = String(code || '').trim().toUpperCase();
    if (!/^[A-Z]{3,5}$/.test(icao) || rows.some(row => row.icao === icao)) return;
    rows.push({ icao, role });
  };
  push(ofp.origin && ofp.origin.icao, 'DEP');
  push(plan && plan.origin && plan.origin.id, 'DEP');
  push(ofp.destination && ofp.destination.icao, 'ARR');
  push(plan && plan.destination && plan.destination.id, 'ARR');
  const alternates = [ofp.alternate, ofp.alternates, plan && plan.alternate].flat().filter(Boolean);
  for (const alternate of alternates) push(alternate.icao || alternate.id || alternate, 'ALT');
  return rows.slice(0, 5);
}

function documentUrls(chart) {
  const urls = [];
  // Each provider keeps its own proxy parameters; the page never builds a
  // document URL from a name the provider did not publish.
  let query;
  if (chart.source === 'austrocontrol-eaip') {
    query = `source=austrocontrol&icao=${encodeURIComponent(chart.icao || '')}&cycle=${encodeURIComponent(chart.cycle || '')}&pdf=${encodeURIComponent(chart.pdf)}`;
  } else if (chart.source === 'sia-france') {
    // The proxy rebuilds the French document address from the ICAO, edition and
    // the SIA's own file name; the name is only forwarded after the catalogue
    // read it from the publisher's page.
    query = `source=sia-france&icao=${encodeURIComponent(chart.icao || '')}&edition=${encodeURIComponent(chart.edition || '')}`
      + (chart.pdf ? `&pdf=${encodeURIComponent(chart.pdf)}` : '');
  } else {
    query = `cycle=${encodeURIComponent(chart.cycle || '')}&file=${encodeURIComponent(chart.pdf)}`;
  }
  if (!isHostedPage()) {
    urls.push(`${defaultBridgeBase().replace(/\/+$/, '')}/chart?${query}`);
  }
  urls.push(`/api/chart?${query}`);
  return urls;
}

export async function mount(root, ctx) {
  const plan = ctx.plan();
  const flight = flightAirports(plan);
  const planned = flight.map(row => row.icao);

  let icao = String(ctx.params.get('icao') || recentAirports()[0]?.icao || planned[0] || '').toUpperCase();
  let catalogue = null;
  let coverage = null;
  let sourceLinks = [];
  let loading = false;
  let query = '';
  let category = 'all';
  let selected = null;
  let documentState = { status: 'idle' };
  let viewer = null;
  let airport = null;
  let regionName = '';
  let countryIso = '';
  let destroyed = false;

  root.innerHTML = `
    <div class="ch-workspace">
      <aside class="ch-side" aria-label="Chart library">
        <div class="ch-side-top">
          <div class="e-row" style="gap:5px">
            <select class="e-input small" id="chart-region" aria-label="Chart region">
              <option value="">All regions</option>
              ${REGIONS.map(region => `<option value="${esc(region)}">${esc(region)}</option>`).join('')}
            </select>
            <select class="e-input small" id="chart-country" aria-label="Chart country">
              <option value="">All countries</option>
              ${COUNTRIES.map(country => `<option value="${esc(country.iso2)}">${esc(country.name)}</option>`).join('')}
            </select>
          </div>
          <div class="e-search">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><circle cx="10.8" cy="10.8" r="5.6"/><path d="m15 15 4.4 4.4"/></svg>
            <input class="e-input" id="chart-icao" placeholder="Airport ICAO or name" value="${esc(icao)}" autocomplete="off" spellcheck="false" aria-label="Search charts by airport">
            <div class="e-results" id="chart-results" hidden></div>
          </div>
          <div class="e-row" style="gap:6px">
            <button class="e-btn small" type="button" data-load>Load charts</button>
            <span class="e-spacer"></span>
            <span class="e-small e-faint" id="chart-count"></span>
          </div>
          <div id="chart-quick" class="ch-quick"></div>
          <div class="e-seg ch-seg" id="chart-filter" role="group" aria-label="Chart type filter">
            ${CATEGORY_FILTERS.map(item => `<button type="button" data-cat="${item.key}" aria-pressed="${item.key === 'all' ? 'true' : 'false'}">${item.label}</button>`).join('')}
          </div>
          <input class="e-input small" id="chart-query" placeholder="Filter documents" aria-label="Filter charts">
        </div>
        <div id="chart-list" class="e-list ch-list"></div>
      </aside>
      <section class="ch-main">
        <div id="chart-notice"></div>
        <div id="chart-header"></div>
        <div class="e-card chart-frame" id="chart-viewer-card"></div>
      </section>
    </div>`;

  const listEl = root.querySelector('#chart-list');
  const countEl = root.querySelector('#chart-count');
  const noticeEl = root.querySelector('#chart-notice');
  const headerEl = root.querySelector('#chart-header');
  const viewerCard = root.querySelector('#chart-viewer-card');
  const regionSelect = root.querySelector('#chart-region');
  const countrySelect = root.querySelector('#chart-country');

  function renderCountries() {
    const list = regionName ? countriesForRegion(regionName) : COUNTRIES;
    if (countryIso && !list.some(country => country.iso2 === countryIso)) countryIso = '';
    countrySelect.innerHTML = `<option value="">${regionName ? `All in ${esc(regionName)}` : 'All countries'}</option>`
      + list.map(country => `<option value="${esc(country.iso2)}"${country.iso2 === countryIso ? ' selected' : ''}>${esc(country.name)}</option>`).join('');
  }

  function renderQuick() {
    const host = root.querySelector('#chart-quick');
    const saved = savedAirports();
    const items = flight.map(row => ({ icao: row.icao, label: `${row.role} · ${row.icao}` }));
    for (const item of saved) if (!items.some(entry => entry.icao === item.icao)) items.push({ icao: item.icao, label: `★ ${item.name || item.icao}` });
    for (const item of recentAirports()) {
      if (items.length >= 10) break;
      if (!items.some(entry => entry.icao === item.icao)) items.push({ icao: item.icao, label: item.name || item.icao });
    }
    host.innerHTML = items.length
      ? items.map(item => `<button class="e-btn small ${item.icao === icao ? 'primary' : 'ghost'}" type="button" data-quick="${esc(item.icao)}">${esc(item.label)}</button>`).join('')
      : '<span class="e-small e-faint">Open a flight plan, or save an airport, to pin charts here.</span>';
    host.querySelectorAll('[data-quick]').forEach(button => {
      button.addEventListener('click', () => {
        icao = button.dataset.quick;
        root.querySelector('#chart-icao').value = icao;
        load();
      });
    });
  }

  function visibleCharts() {
    if (!catalogue) return [];
    const byCategory = category === 'all'
      ? catalogue.charts
      : catalogue.charts.filter(chart => {
        if (category === 'approach') return APPROACH_FAMILIES.includes(chart.category) || Boolean(chart.approach);
        if (category === 'other') return !['diagram', 'sid', 'star', 'approach'].includes(chart.category);
        return chart.category === category;
      });
    return filterCharts(byCategory, query);
  }

  function renderList() {
    renderQuick();
    if (loading) {
      listEl.innerHTML = '<div class="e-loading"><i></i>Loading the catalogue…</div>';
      countEl.textContent = '';
      return;
    }
    if (!catalogue && coverage && !coverage.integrated) {
      const shown = filterCharts(chartfoxRows(), query);
      countEl.textContent = `${shown.length} ChartFox group${shown.length === 1 ? '' : 's'}`;
      listEl.innerHTML = `<div class="ch-hint">
        <b>ChartFox · ${esc(icao)}</b>
        <span>Each group opens its ${esc(icao)} page on ChartFox in a new tab. ChartFox needs a free VATSIM login.</span>
      </div>${shown.length ? shown.map(row => `<a class="e-list-item" href="${esc(row.external)}" target="_blank" rel="noopener noreferrer" data-chartfox="${esc(row.category)}">
        <div class="li-main"><b>${esc(row.title)}</b><span>${esc(row.categoryLabel)} · opens on ChartFox</span></div>
        <span class="e-badge">ChartFox ↗</span>
      </a>`).join('') : '<div class="ch-hint"><b>No matching ChartFox groups</b><span>Clear the filter to see them all.</span></div>'}
        <div class="e-small e-faint" style="padding:4px 10px 10px">ChartFox’s own chart names and files are not copied into Stratos.</div>`;
      return;
    }
    if (!catalogue) {
      listEl.innerHTML = `<div class="ch-hint">
        <b>No charts loaded</b>
        <span>Search for any airport in the world. Where the publisher's terms allow it, the charts open here; otherwise Stratos shows the official source.</span>
      </div>`;
      countEl.textContent = '';
      return;
    }
    const charts = visibleCharts();
    countEl.textContent = `${charts.length} doc${charts.length === 1 ? '' : 's'}`;
    if (!charts.length) {
      listEl.innerHTML = `<div class="ch-hint"><b>No matching charts</b><span>Nothing in this catalogue matches the current filter.</span></div>`;
      return;
    }
    listEl.innerHTML = charts.map(chart => {
      const validity = validityState(chart);
      const tone = validity === 'current' ? 'good' : validity === 'expired' ? 'bad' : '';
      return `<button class="e-list-item" type="button" data-chart="${esc(chart.id)}" aria-current="${selected && selected.id === chart.id ? 'true' : 'false'}">
        <div class="li-main"><b>${esc(chart.title || chart.pdf)}</b>
          <span>${esc(chart.categoryLabel || chart.category || 'Chart')}${chart.runways && chart.runways.length ? ` · rw ${esc(chart.runways.join(', '))}` : ''}</span></div>
        <span class="e-badge ${tone}">${validity === 'current' ? 'Current' : validity === 'expired' ? 'Expired' : 'Unverified'}</span>
      </button>`;
    }).join('');
    listEl.querySelectorAll('[data-chart]').forEach(button => {
      button.addEventListener('click', () => {
        const chart = catalogue.charts.find(item => item.id === button.dataset.chart);
        if (chart) openChart(chart);
      });
    });
  }

  function summaryLine(chart) {
    if (!chart) return '';
    // An AIP edition names its AIRAC beside the chart, so it is not repeated here.
    const cycle = chart.cycle && !EAIP_CYCLE.has(chart.source) ? `cycle ${chart.cycle}` : null;
    return [chart.sourceName || 'FAA d-TPP', chart.format || 'PDF', cycle]
      .filter(Boolean).join(' · ');
  }

  function sourcesPanel(sources) {
    if (!sources.length) return '';
    return `<div class="ch-sources">
      <div class="ch-sources-head">
        <div class="e-label">Official sources</div>
        <div class="ch-sources-note">These publishers hold the documents for this airport.</div>
      </div>
      <div class="ch-source-list">${sources.map(source => {
        // What the publisher allows is the useful fact on this row. The licence
        // category speaks only for a source whose access position is unknown, so
        // a verified "permission required" never reads as "terms unverified".
        const licence = licenceFor(source.licenceCategory || source.licence);
        const access = source.accessLabel
          ? { label: source.accessLabel, tone: source.accessTone || '' }
          : accessFor(source);
        const checked = source.checked
          ? ` · checked ${esc(source.checked)}`
          : (access.key === 'UNKNOWN' ? ' · terms not yet verified' : '');
        return `<a class="ch-source" href="${esc(source.url || source.terms || '')}" target="_blank" rel="noopener">
          <div class="ch-source-main"><b>${esc(source.name || source.label || 'Publisher')}</b>
            <span>${esc(source.note || source.licence || 'Official aeronautical documents')}</span>
            <span class="e-small e-faint">${esc(access.label || licence.label)}${checked}</span></div>
          <span class="e-badge ${access.tone || licence.tone}">Open ↗</span>
        </a>`;
      }).join('')}</div>
      <div class="e-small e-faint">Stratos will not copy, frame or proxy a publisher that has not licensed its documents.</div>
    </div>`;
  }

  function renderHeader() {
    if (!headerEl) return;
    if (!coverage) { headerEl.innerHTML = ''; return; }
    const status = coverageStatus(coverage);
    const licence = coverage.licenceCategory ? licenceFor(coverage.licenceCategory) : null;
    const flag = flagFor(coverage.iso2);
    const saved = savedAirports().some(item => item.icao === icao);
    const name = (airport && airport.name) || (coverage.country ? `Airport · ${coverage.country}` : 'Airport');
    const elevation = airport && Number.isFinite(Number(airport.elev)) ? `${Math.round(Number(airport.elev))} ft` : null;
    const iata = airport && airport.iata ? airport.iata : null;
    const cycle = catalogue && catalogue.cycle ? `AIRAC ${catalogue.cycle}` : null;
    headerEl.innerHTML = `<div class="e-card ch-airport">
      <div class="ch-airport-top">
        <div class="ch-airport-id">
          <span class="ch-flag" aria-hidden="true">${esc(flag)}</span>
          <div>
            <div class="ch-airport-codes"><b>${esc(icao)}</b>${iata ? `<span>${esc(iata)}</span>` : ''}</div>
            <div class="ch-airport-name">${esc(name)}</div>
          </div>
        </div>
        <div class="ch-airport-actions">
          <span class="e-badge ${status.tone}">${esc(status.label)}</span>
          <button class="e-btn small ${saved ? 'primary' : 'ghost'}" type="button" id="chart-save" aria-pressed="${saved ? 'true' : 'false'}" title="Save this airport">${saved ? '★ Saved' : '☆ Save'}</button>
        </div>
      </div>
      <div class="ch-airport-meta">
        <span><i>Country</i>${esc(coverage.country || 'Not registered')}</span>
        ${elevation ? `<span><i>Elevation</i>${esc(elevation)}</span>` : ''}
        <span><i>Publisher</i>${esc((coverage.provider && coverage.provider.name) || 'No registered source')}</span>
        ${cycle ? `<span><i>Cycle</i>${esc(cycle)}</span>` : ''}
        ${licence ? `<span><i>Licence</i>${esc(licence.label)}</span>` : ''}
      </div>
    </div>`;
    const save = headerEl.querySelector('#chart-save');
    if (save) {
      save.addEventListener('click', () => {
        toggleSaved(icao, (airport && airport.name) || '');
        renderQuick();
        renderHeader();
      });
    }
  }

  function renderCountry() {
    if (!countryIso && !regionName) return false;
    const country = COUNTRIES.find(entry => entry.iso2 === countryIso) || null;
    const publishers = country ? coverageSources(country.iso2) : [];
    const stats = registryStats();
    viewerCard.classList.remove('is-centred');
    viewerCard.innerHTML = `<div class="ch-viewer-head">
        <div class="e-label">Charts · ${esc(country ? country.name : regionName)}</div>
        <div class="ch-viewer-title">${country ? `${country.name} — ${publishers.length} registered publisher${publishers.length === 1 ? '' : 's'}` : `${esc(regionName)}`}</div>
        <p class="ch-viewer-text">${country
          ? 'These are the authorities that publish this country’s aeronautical charts. Where the licence allows it, Stratos embeds the documents; otherwise this page links to the publisher.'
          : `${stats.countries} countries are registered across ${REGIONS.length} regions. Choose a country to see its publisher and licence.`}</p>
      </div>${sourcesPanel(publishers)}`;
    return true;
  }

  /** Registry publishers for a country, shaped like the source panel rows. */
  function coverageSources(iso2) {
    return sourcesForCountry(iso2).map(entry => ({
      id: entry.id,
      name: entry.name,
      url: entry.url,
      note: entry.note,
      licenceCategory: entry.licence,
      checked: entry.checked,
    }));
  }

  /* A publisher that does not license in-app display still has charts the pilot
     can open at the source. ChartFox needs a free VATSIM login; the link is the
     airport page only, never a copied document. */
  function chartfoxLink(code) {
    return `<a class="e-btn small" style="margin-top:10px;align-self:flex-start" href="${esc(chartfoxUrl(code))}" target="_blank" rel="noopener noreferrer">Open ${esc(code)} on ChartFox ↗</a>`;
  }

  /** The ChartFox document groups, for the same list the FAA documents use. */
  function chartfoxRows() {
    const external = chartfoxUrl(icao);
    const rows = CHARTFOX_GROUPS.map(group => ({
      id: `chartfox-${group.key}`,
      title: group.title,
      category: group.category,
      categoryLabel: group.label,
      external,
    }));
    return category === 'all' ? rows : rows.filter(row => row.category === category);
  }

  function renderViewer() {
    if (!viewerCard) return;
    if (!selected) {
      // An integrated publisher with nothing loaded is a load failure to report,
      // not an external provider: the two must never be shown as the same thing.
      const external = !catalogue && sourceLinks.length > 0 && coverage && !coverage.integrated;
      viewerCard.classList.toggle('is-centred', external);
      if (external) {
        const access = coverage.access || 'UNKNOWN';
        const titles = {
          FREE_PUBLIC_ACCESS: 'These charts are free to view at the publisher',
          FREE_WITH_REGISTRATION: 'These charts need a publisher account',
          PERMISSION_REQUIRED: 'This publisher does not allow in-app display',
          PAID: 'These charts are sold by the publisher',
          UNKNOWN: 'This publisher’s terms are not verified',
          UNAVAILABLE: 'No chart source is registered for this airport',
        };
        viewerCard.innerHTML = `<div class="ch-viewer-head">
            <div class="e-label">Charts · ${esc(icao)}</div>
            <div class="ch-viewer-title">${esc(titles[access] || titles.UNKNOWN)}</div>
            <p class="ch-viewer-text">${esc((coverage && coverage.message) || 'The charts for this airport are published by an external provider.')}</p>
          </div>${chartfoxLink(icao)}${sourcesPanel(sourceLinks)}`;
        return;
      }
      viewerCard.innerHTML = `<div class="ch-viewer-empty">
        <b>No chart open</b>
        <p>Search for an airport anywhere in the world, then choose a document. Charts open in the same viewer the tracker uses: wheel or pinch to zoom, drag to pan, Page Up/Down for pages.</p>
      </div>`;
      return;
    }
    viewerCard.classList.remove('is-centred');
    // The provider's own document address wins: a national AIP does not live on
    // the FAA server, so its address is never rebuilt from the FAA pattern.
    const official = selected.url
      || (selected.pdf && selected.cycle ? officialChartUrl(selected.cycle, selected.pdf) : null);
    viewerCard.innerHTML = `
      <div class="e-row" style="margin-bottom:8px">
        <div style="min-width:0">
          <div class="e-value" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(selected.title || selected.pdf)}</div>
          <div class="e-small e-faint">${esc(summaryLine(selected))}${selected.categoryLabel ? ` · ${esc(selected.categoryLabel)}` : ''}${selected.cycle ? ` · ${esc(EAIP_CYCLE.has(selected.source) ? `AIRAC ${selected.cycle}` : `cycle ${selected.cycle}`)}` : ''}</div>
        </div>
        <span class="e-spacer"></span>
        <div class="chart-toolbar">
          <button class="e-btn small" type="button" data-zoom="out" title="Zoom out">−</button>
          <span class="e-small e-faint" id="chart-zoom">—</span>
          <button class="e-btn small" type="button" data-zoom="in" title="Zoom in">+</button>
          <button class="e-btn small" type="button" data-fit="width">Fit width</button>
          <button class="e-btn small" type="button" data-fit="page">Fit page</button>
          <span class="e-small e-faint" id="chart-pages"></span>
          <button class="e-btn small" type="button" data-page="-1" title="Previous page">‹</button>
          <button class="e-btn small" type="button" data-page="1" title="Next page">›</button>
          ${official ? `<a class="e-btn small" href="${esc(official)}" target="_blank" rel="noopener">Official ↗</a>` : ''}
        </div>
      </div>
      <div class="chart-host" id="chart-host"></div>
      <div class="e-small ${validityState(selected) === 'expired' ? 'e-faint' : 'e-muted'}" style="margin-top:8px" id="chart-validity">
        ${esc(validityText(selected))}${selected.attribution ? ` · ${esc(selected.attribution)}` : ''}
      </div>`;

    const host = viewerCard.querySelector('#chart-host');
    if (documentState.status === 'loading') {
      host.innerHTML = '<div class="e-loading" style="padding:24px"><i></i>Opening the document…</div>';
      return;
    }
    if (documentState.status === 'error') {
      host.innerHTML = `<div class="e-notice bad" style="margin:14px"><div><b>The document could not be opened.</b><br>${esc(documentState.error)}</div></div>`;
      return;
    }
    try {
      viewer = new ChartViewer(host, {
        onState: state => {
          if (destroyed) return;
          if (state.error) {
            documentState = { status: 'error', error: state.error };
            renderViewer();
            return;
          }
          const zoom = viewerCard.querySelector('#chart-zoom');
          if (zoom && state.scale) zoom.textContent = `${Math.round(state.scale * 100)}%`;
          const pages = viewerCard.querySelector('#chart-pages');
          if (pages) pages.textContent = state.pages > 1 ? `${state.page} / ${state.pages}` : '';
        },
      });
    } catch (error) {
      host.innerHTML = `<div class="e-notice bad" style="margin:14px">${esc(error.message)}</div>`;
      return;
    }
    viewerCard.querySelectorAll('[data-zoom]').forEach(button => {
      button.addEventListener('click', () => viewer.zoomBy(button.dataset.zoom === 'in' ? 1.25 : 0.8));
    });
    viewerCard.querySelectorAll('[data-fit]').forEach(button => {
      button.addEventListener('click', () => viewer.fit(button.dataset.fit === 'page' ? 'fit-page' : 'fit-width'));
    });
    viewerCard.querySelectorAll('[data-page]').forEach(button => {
      button.addEventListener('click', () => viewer.setPage(viewer.pageNumber + Number(button.dataset.page)));
    });
    if (documentState.bytes) {
      viewer.load(documentState.bytes).catch(error => {
        if (destroyed) return;
        documentState = { status: 'error', error: error && error.message ? error.message : String(error) };
        renderViewer();
      });
    }
  }

  async function openChart(chart) {
    destroyViewer();
    selected = chart;
    documentState = { status: 'loading' };
    renderList();
    renderViewer();
    try {
      const key = chartCacheKey(selected);
      const cached = await readChartCache(key);
      let bytes = cached && cached.bytes ? new Uint8Array(cached.bytes) : null;
      let fromCache = Boolean(bytes && isPdfBytes(bytes));
      if (!fromCache) {
        let lastError = 'The document source did not answer.';
        for (const candidate of documentUrls(selected)) {
          try {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 25000);
            const response = await fetch(candidate, { cache: 'no-store', signal: controller.signal });
            clearTimeout(timer);
            if (!response.ok) { lastError = `The document source answered ${response.status}.`; continue; }
            const buffer = await response.arrayBuffer();
            if (!isPdfBytes(buffer)) { lastError = 'The source did not return a PDF document.'; continue; }
            bytes = new Uint8Array(buffer);
            fromCache = false;
            await writeChartCache(key, bytes);
            break;
          } catch (error) {
            lastError = error.name === 'AbortError' ? 'The document request timed out.' : error.message;
          }
        }
        if (!bytes) throw new Error(lastError);
      }
      if (destroyed) return;
      documentState = { status: 'ready', bytes, fromCache };
      renderViewer();
    } catch (error) {
      if (destroyed) return;
      documentState = { status: 'error', error: error.message };
      renderViewer();
    }
  }

  function destroyViewer() {
    if (viewer) {
      try { viewer.destroy(); } catch (_) { /* already gone */ }
      viewer = null;
    }
  }

  async function load() {
    icao = String(icao || '').trim().toUpperCase();
    if (!icao) {
      noticeEl.innerHTML = '<div class="e-notice warn">Enter an airport ICAO code or pick one of the suggestions.</div>';
      return;
    }
    destroyViewer();
    selected = null;
    catalogue = null;
    loading = true;
    sourceLinks = [];
    noticeEl.innerHTML = '';
    coverage = chartCoverage(icao);
    headerEl.innerHTML = '';
    renderList();
    renderViewer();

    const info = await searchAirports(icao, 6).catch(() => []);
    if (destroyed) return;
    airport = (info || []).find(row => String(row.id).toUpperCase() === icao) || null;

    const result = await loadChartCatalogue(icao);
    if (destroyed) return;
    loading = false;
    coverage = result.coverage || coverage;
    sourceLinks = result.sources && result.sources.length ? result.sources : chartSourcesFor(icao);
    if (!result.ok) {
      if (!result.unsupported) {
        noticeEl.innerHTML = `<div class="e-notice bad"><div><b>No charts loaded for ${esc(icao)}.</b><br>${esc(result.error || '')}</div></div>`;
      }
      renderHeader();
      renderList();
      renderViewer();
      return;
    }
    catalogue = result.catalogue;
    noticeEl.innerHTML = `<div class="e-notice"><div><b>${esc(icao)}</b> · ${catalogue.charts.length} documents · ${esc(result.source || 'FAA d-TPP')}${catalogue.cycle ? ` · cycle ${esc(catalogue.cycle)}` : ''}</div></div>`;
    rememberAirport(icao, (airport && airport.name) || '');
    renderHeader();
    renderList();
    if (catalogue.charts.length) {
      const first = visibleCharts()[0] || catalogue.charts[0];
      if (first) openChart(first);
    } else {
      renderViewer();
    }
  }

  /* airport search */
  const searchInput = root.querySelector('#chart-icao');
  const results = root.querySelector('#chart-results');
  let searchTimer = null;
  searchInput.addEventListener('input', () => {
    const term = searchInput.value.trim();
    clearTimeout(searchTimer);
    if (term.length < 1) { results.hidden = true; return; }
    searchTimer = setTimeout(async () => {
      const rows = await searchAirports(term, 8);
      if (destroyed) return;
      results.hidden = false;
      results.innerHTML = rows.length
        ? rows.map(row => {
          const country = chartCoverage(String(row.id).toUpperCase()).country;
          return `<button type="button" data-pick="${esc(row.id)}"><b>${esc(row.id)}</b><span>${esc(row.name || '')}${country ? ` · ${esc(country)}` : ''}</span></button>`;
        }).join('')
        : '<div class="e-empty-small">No airports match.</div>';
      results.querySelectorAll('[data-pick]').forEach(button => {
        button.addEventListener('click', () => {
          searchInput.value = button.dataset.pick;
          icao = button.dataset.pick;
          results.hidden = true;
          load();
        });
      });
    }, 180);
  });
  searchInput.addEventListener('keydown', event => {
    if (event.key === 'Enter') {
      results.hidden = true;
      icao = searchInput.value.trim().toUpperCase();
      load();
    }
    if (event.key === 'Escape') results.hidden = true;
  });
  searchInput.addEventListener('blur', () => setTimeout(() => { results.hidden = true; }, 160));

  root.querySelector('[data-load]').addEventListener('click', () => {
    icao = searchInput.value.trim().toUpperCase();
    load();
  });

  root.querySelector('#chart-query').addEventListener('input', event => {
    query = event.target.value;
    renderList();
  });

  root.querySelectorAll('[data-cat]').forEach(button => {
    button.addEventListener('click', () => {
      category = button.dataset.cat;
      root.querySelectorAll('[data-cat]').forEach(other => other.setAttribute('aria-pressed', other === button ? 'true' : 'false'));
      renderList();
    });
  });

  regionSelect.addEventListener('change', () => {
    regionName = regionSelect.value;
    countryIso = '';
    renderCountries();
    if (regionName) {
      coverage = null;
      catalogue = null;
      sourceLinks = [];
      headerEl.innerHTML = '';
      renderList();
      renderCountry();
    }
  });

  countrySelect.addEventListener('change', () => {
    countryIso = countrySelect.value;
    if (!countryIso) { renderViewer(); return; }
    coverage = null;
    catalogue = null;
    sourceLinks = [];
    headerEl.innerHTML = '';
    renderList();
    renderCountry();
  });

  renderCountries();
  renderQuick();
  if (icao) load();
  else {
    noticeEl.innerHTML = `<div class="e-notice"><div>${planned.length ? `Charts for this flight: ${esc(planned.join(' → '))}.` : 'Search for any airport, or pick a country to see its chart publisher.'}</div></div>`;
    renderViewer();
  }

  return {
    destroy() {
      destroyed = true;
      destroyViewer();
    },
  };
}
