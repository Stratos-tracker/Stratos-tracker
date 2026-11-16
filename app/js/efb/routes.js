/* EFB · Route Finder.
 *
 * Real airline flights (every known route, or only those airborne now with
 * FLYING NOW), filtered by aircraft type, airline, airports and block time, each one a callsign, a departure and an arrival ready to uplink to
 * SimBrief. Data and estimates: see lib/routefinder.js.
 */

import { esc } from './common.js';
import { AIRLINES } from '../lib/airlines.js';
import { BUNDLED_AIRPORTS } from '../data/airports.js';
import { ROUTE_TYPES, findRoutes, findAllRoutes, simbriefUrl, parkedAt, standAt, standQuery } from '../lib/routefinder.js';
import { hedgedOverpass } from './groundchart.js';

const PREFS = 'stratos.efb.routes';
const fmtBlock = m => `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
// The flight-time slider, in minutes; an end stop means "or less" / "or more".
const DUR_MIN = 30, DUR_MAX = 1260, DUR_STEP = 15;
const fmtDur = m => (m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${m % 60 ? ` ${String(m % 60).padStart(2, '0')}m` : ''}`);

// adsb.lol sends no CORS headers: the hosted site and the dev server proxy it
// at /api/traffic (as the map does); the desktop app can fetch it directly.
let proxy = null;
async function useProxy() {
  if (proxy !== null) return proxy;
  if (location.protocol === 'https:') return (proxy = true);
  try { proxy = (await fetch('/api/traffic', { cache: 'no-store' })).status === 400; } catch (_) { proxy = false; }
  return proxy;
}
async function fetchTraffic(url) {
  const response = await fetch((await useProxy()) ? `/api/traffic?url=${encodeURIComponent(url)}` : url, { cache: 'no-store' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}
// 404 is "no route known" (an answer); anything else failed and is retried next time.
const fetchRoute = callsign => fetch(`https://api.adsbdb.com/v0/callsign/${encodeURIComponent(callsign)}`).then(r => {
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
});
// The route and airport files are static on GitHub (CORS-open); a missing airline file is a 404.
const fetchText = url => fetch(url).then(r => {
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.text();
});

export async function mount(root) {
  let destroyed = false;
  let prefs = { type: '', airline: '', from: '', to: '', durMin: DUR_MIN, durMax: DUR_MAX, live: false };
  try { prefs = { ...prefs, ...JSON.parse(localStorage.getItem(PREFS) || '{}') }; } catch (_) { /* defaults */ }
  const logoFor = icao => (AIRLINES.find(a => a.icao === icao) || {}).logo;

  root.innerHTML = `
    <div class="rf">
      <form class="e-card rf-filters" id="rf-form">
        <label class="rf-field"><span class="e-label">Aircraft</span>
          <input class="e-input" id="rf-type" list="rf-types" placeholder="Any airliner" value="${esc(prefs.type)}" autocomplete="off" spellcheck="false" maxlength="4"></label>
        <label class="rf-field"><span class="e-label">Airline</span>
          <input class="e-input" id="rf-airline" list="rf-airlines" placeholder="Any airline · ICAO" value="${esc(prefs.airline)}" autocomplete="off" spellcheck="false" maxlength="3"></label>
        <label class="rf-field"><span class="e-label">Departure</span>
          <input class="e-input" id="rf-from" list="rf-airports" placeholder="Any · ICAO" value="${esc(prefs.from)}" autocomplete="off" spellcheck="false" maxlength="4"></label>
        <label class="rf-field"><span class="e-label">Arrival</span>
          <input class="e-input" id="rf-to" list="rf-airports" placeholder="Any · ICAO" value="${esc(prefs.to)}" autocomplete="off" spellcheck="false" maxlength="4"></label>
        <div class="rf-field"><span class="e-label">Flight time</span>
          <div class="rf-slider" id="rf-dur">
            <div class="rf-track"><i id="rf-fill"></i>
              <input type="range" id="rf-dmin" min="${DUR_MIN}" max="${DUR_MAX}" step="${DUR_STEP}" value="${prefs.durMin}" aria-label="Shortest flight time">
              <input type="range" id="rf-dmax" min="${DUR_MIN}" max="${DUR_MAX}" step="${DUR_STEP}" value="${prefs.durMax}" aria-label="Longest flight time"></div>
            <output id="rf-dlabel"></output></div></div>
        <button class="e-btn rf-now" id="rf-now" type="button" aria-pressed="${prefs.live}" title="Only flights airborne right now"><i></i>Flying now</button>
        <button class="e-btn primary rf-go" type="submit">Find flights</button>
        <datalist id="rf-types">${ROUTE_TYPES.map(t => `<option value="${t.code}">${esc(t.label)}</option>`).join('')}</datalist>
        <datalist id="rf-airports">${BUNDLED_AIRPORTS.map(a => `<option value="${a.id}">${esc(a.name)}</option>`).join('')}</datalist>
        <datalist id="rf-airlines">${AIRLINES.map(a => `<option value="${a.icao}">${esc(a.name)}</option>`).join('')}</datalist>
      </form>
      <div id="rf-status" class="rf-status"></div>
      <div id="rf-results" class="rf-results"></div>
      <div class="e-small e-faint rf-source">Routes: Virtual Radar Server standing data · live flights: adsb.lol, adsbdb · stands of parked aircraft © OpenStreetMap contributors · block time estimated from distance and type · not for real-world flight</div>
    </div>`;

  const status = root.querySelector('#rf-status');
  const list = root.querySelector('#rf-results');
  const typeIn = root.querySelector('#rf-type');
  const airlineIn = root.querySelector('#rf-airline');
  const fromIn = root.querySelector('#rf-from');
  const toIn = root.querySelector('#rf-to');
  const nowBtn = root.querySelector('#rf-now');
  nowBtn.addEventListener('click', () => { prefs.live = !prefs.live; nowBtn.setAttribute('aria-pressed', String(prefs.live)); });

  const dMin = root.querySelector('#rf-dmin'), dMax = root.querySelector('#rf-dmax');
  function syncDur(moved) {
    let lo = +dMin.value, hi = +dMax.value;
    if (lo > hi) { if (moved === dMin) hi = lo; else lo = hi; dMin.value = lo; dMax.value = hi; }
    prefs.durMin = lo; prefs.durMax = hi;
    const pct = v => ((v - DUR_MIN) / (DUR_MAX - DUR_MIN)) * 100;
    root.querySelector('#rf-fill').style.cssText = `left:${pct(lo)}%;right:${100 - pct(hi)}%`;
    root.querySelector('#rf-dlabel').textContent = lo === DUR_MIN && hi === DUR_MAX ? 'Any length'
      : lo === DUR_MIN ? `Up to ${fmtDur(hi)}` : hi === DUR_MAX ? `${fmtDur(lo)} +` : lo === hi ? fmtDur(lo) : `${fmtDur(lo)} – ${fmtDur(hi)}`;
    dMin.style.zIndex = lo > DUR_MAX - 60 ? 3 : ''; // keep the low thumb reachable when both sit at the top
  }
  dMin.addEventListener('input', () => syncDur(dMin));
  dMax.addEventListener('input', () => syncDur(dMax));
  syncDur();

  // One OpenStreetMap stand query per airport for the life of the page.
  const standsByAirport = new Map();
  const standsAt = apt => {
    if (!standsByAirport.has(apt.icao)) standsByAirport.set(apt.icao, hedgedOverpass(standQuery(apt.lat, apt.lon)).then(r => r.ways));
    return standsByAirport.get(apt.icao);
  };
  // A parked aircraft names its real stand under the airport it is parked at.
  async function fillStands(results) {
    await Promise.all(results.map(async (f, i) => {
      const end = parkedAt(f);
      if (!end) return;
      const ways = await standsAt(f[end]).catch(() => null);
      const slot = !destroyed && list.querySelector(`[data-stand="${i}-${end}"]`);
      if (!slot) return;
      const stand = ways && standAt(ways, f);
      slot.textContent = stand ? `${stand.kind === 'gate' ? 'Gate' : 'Stand'} ${stand.ref}` : 'Parked · stand not charted';
      slot.title = stand ? `Where the aircraft is parked now, matched to OpenStreetMap (${stand.metres} m)` : 'Parked here, but OpenStreetMap labels no stand at this spot';
      slot.hidden = false;
    }));
  }

  function card(f, live, i) {
    const logo = logoFor(f.airline);
    const parked = live && parkedAt(f);
    const slot = end => `<em class="rf-stand" data-stand="${i}-${end}" hidden></em>`;
    return `<article class="rf-card">
      <header class="rf-head">
        ${logo ? `<img class="rf-logo" src="${esc(logo)}" alt="">` : `<span class="rf-logo rf-code">${esc(f.airline)}</span>`}
        <div class="rf-id"><b>${esc(f.callsign)}</b><span>${esc(f.airlineName || AIRLINES.find(a => a.icao === f.airline)?.name || f.airline)}${f.type ? ` · ${esc(f.type)}${f.typical ? ' <i class="rf-typ" title="The type this airline usually flies on a route this long; this flight was not seen today">typical</i>' : ''}` : ''}${f.registration ? ` · ${esc(f.registration)}` : ''}</span></div>
        ${!live ? '<span class="e-badge rf-live">Real route</span>'
          : parked === 'origin' ? '<span class="e-badge accent rf-live">At the gate</span>'
          : parked === 'destination' ? '<span class="e-badge rf-live">Arrived</span>'
          : f.onGround ? '<span class="e-badge good rf-live">Taxiing</span>'
          : '<span class="e-badge good rf-live">Airborne now</span>'}
      </header>
      <div class="rf-route">
        <div class="rf-apt"><b>${esc(f.origin.icao)}</b><span>${esc(f.origin.city || f.origin.name)}</span>${parked === 'origin' ? slot('origin') : ''}</div>
        <div class="rf-leg"><span>${f.distanceNm.toLocaleString('en-US')} nm</span><i></i><span>${fmtBlock(f.blockMinutes)}</span></div>
        <div class="rf-apt rf-arr"><b>${esc(f.destination.icao)}</b><span>${esc(f.destination.city || f.destination.name)}</span>${parked === 'destination' ? slot('destination') : ''}</div>
      </div>
      <footer class="rf-actions">
        <a class="e-btn primary small" href="${esc(simbriefUrl(f))}" target="_blank" rel="noopener">Uplink to SimBrief ↗</a>
      </footer>
    </article>`;
  }

  async function search() {
    prefs.type = typeIn.value.trim().toUpperCase();
    prefs.airline = airlineIn.value.trim().toUpperCase();
    prefs.from = fromIn.value.trim().toUpperCase();
    prefs.to = toIn.value.trim().toUpperCase();
    try { localStorage.setItem(PREFS, JSON.stringify(prefs)); } catch (_) { /* optional */ }
    if (prefs.type && !/^[A-Z0-9]{2,4}$/.test(prefs.type)) { status.innerHTML = '<div class="e-notice warn">Aircraft is an ICAO type code, e.g. B738.</div>'; return; }
    if (prefs.airline && !/^[A-Z]{3}$/.test(prefs.airline)) { status.innerHTML = '<div class="e-notice warn">Airline is a 3-letter ICAO code, e.g. BAW.</div>'; return; }
    if ([prefs.from, prefs.to].some(c => c && !/^[A-Z0-9]{4}$/.test(c))) { status.innerHTML = '<div class="e-notice warn">Airports are 4-letter ICAO codes, e.g. EGLL.</div>'; return; }
    const live = prefs.live;
    list.innerHTML = '';
    status.innerHTML = `<div class="e-loading"><i></i>${live ? 'Finding live flights…' : 'Finding real routes…'}</div>`;
    try {
      const { results, pool } = await (live ? findRoutes : findAllRoutes)({
        ...prefs, duration: [prefs.durMin <= DUR_MIN ? 0 : prefs.durMin, prefs.durMax >= DUR_MAX ? Infinity : prefs.durMax], fetchTraffic, fetchRoute, fetchText,
        onProgress: p => { if (!destroyed) status.innerHTML = `<div class="e-loading"><i></i>Checking routes · ${p.found} found of ${p.looked} flights</div>`; },
      });
      if (destroyed) return;
      list.innerHTML = results.map((f, i) => card(f, live, i)).join('');
      if (live) fillStands(results);
      status.innerHTML = results.length
        ? `<div class="e-small e-muted">${results.length} real flight${results.length === 1 ? '' : 's'} · from ${pool.toLocaleString('en-US')} ${live ? 'airborne now' : 'known routes'}</div>`
        : `<div class="e-notice">${live ? (pool ? 'No airborne flight with a known route matches these filters right now.' : 'No matching flight is airborne right now.') : (pool ? 'No route matches these filters.' : `No known route matches${prefs.airline ? '' : ' for the major airlines searched; pick an airline'}.`)} Widen the flight time or clear a filter.</div>`;
    } catch (error) {
      if (!destroyed) status.innerHTML = `<div class="e-notice bad">${esc(error.message)}</div>`;
    }
  }

  root.querySelector('#rf-form').addEventListener('submit', event => { event.preventDefault(); search(); });
  return { destroy() { destroyed = true; } };
}
