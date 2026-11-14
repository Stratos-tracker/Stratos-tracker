/* EFB · Route Finder.
 *
 * Real flights in the air now, filtered by aircraft type, airline and block
 * time, each one a callsign, a departure and an arrival ready to uplink to
 * SimBrief. Data and estimates: see lib/routefinder.js.
 */

import { esc } from './common.js';
import { AIRLINES } from '../lib/airlines.js';
import { DURATIONS, ROUTE_TYPES, findRoutes, simbriefUrl } from '../lib/routefinder.js';

const PREFS = 'stratos.efb.routes';
const fmtBlock = m => `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;

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

export async function mount(root) {
  let destroyed = false;
  let prefs = { type: '', airline: '', duration: 'any' };
  try { prefs = { ...prefs, ...JSON.parse(localStorage.getItem(PREFS) || '{}') }; } catch (_) { /* defaults */ }
  const logoFor = icao => (AIRLINES.find(a => a.icao === icao) || {}).logo;

  root.innerHTML = `
    <div class="rf">
      <form class="e-card rf-filters" id="rf-form">
        <label class="rf-field"><span class="e-label">Aircraft</span>
          <input class="e-input" id="rf-type" list="rf-types" placeholder="Any airliner" value="${esc(prefs.type)}" autocomplete="off" spellcheck="false" maxlength="4"></label>
        <label class="rf-field"><span class="e-label">Airline</span>
          <input class="e-input" id="rf-airline" list="rf-airlines" placeholder="Any airline · ICAO" value="${esc(prefs.airline)}" autocomplete="off" spellcheck="false" maxlength="3"></label>
        <div class="rf-field"><span class="e-label">Flight time</span>
          <div class="e-seg" id="rf-dur" role="group" aria-label="Flight time">${DURATIONS.map(d => `<button type="button" data-dur="${d.id}" aria-pressed="${d.id === prefs.duration}">${esc(d.label)}</button>`).join('')}</div></div>
        <button class="e-btn primary rf-go" type="submit">Find flights</button>
        <datalist id="rf-types">${ROUTE_TYPES.map(t => `<option value="${t.code}">${esc(t.label)}</option>`).join('')}</datalist>
        <datalist id="rf-airlines">${AIRLINES.map(a => `<option value="${a.icao}">${esc(a.name)}</option>`).join('')}</datalist>
      </form>
      <div id="rf-status" class="rf-status"></div>
      <div id="rf-results" class="rf-results"></div>
      <div class="e-small e-faint rf-source">Live flights: adsb.lol · routes: adsbdb · block time estimated from distance and type · not for real-world flight</div>
    </div>`;

  const status = root.querySelector('#rf-status');
  const list = root.querySelector('#rf-results');
  const typeIn = root.querySelector('#rf-type');
  const airlineIn = root.querySelector('#rf-airline');

  root.querySelectorAll('[data-dur]').forEach(b => b.addEventListener('click', () => {
    prefs.duration = b.dataset.dur;
    root.querySelectorAll('[data-dur]').forEach(o => o.setAttribute('aria-pressed', String(o === b)));
  }));

  function card(f) {
    const logo = logoFor(f.airline);
    return `<article class="rf-card">
      <header class="rf-head">
        ${logo ? `<img class="rf-logo" src="${esc(logo)}" alt="">` : `<span class="rf-logo rf-code">${esc(f.airline)}</span>`}
        <div class="rf-id"><b>${esc(f.callsign)}</b><span>${esc(f.airlineName || f.airline)} · ${esc(f.type)}${f.registration ? ` · ${esc(f.registration)}` : ''}</span></div>
        <span class="e-badge good rf-live">Airborne now</span>
      </header>
      <div class="rf-route">
        <div class="rf-apt"><b>${esc(f.origin.icao)}</b><span>${esc(f.origin.city || f.origin.name)}</span></div>
        <div class="rf-leg"><span>${f.distanceNm.toLocaleString('en-US')} nm</span><i></i><span>${fmtBlock(f.blockMinutes)}</span></div>
        <div class="rf-apt rf-arr"><b>${esc(f.destination.icao)}</b><span>${esc(f.destination.city || f.destination.name)}</span></div>
      </div>
      <footer class="rf-actions">
        <a class="e-btn primary small" href="${esc(simbriefUrl(f))}" target="_blank" rel="noopener">Uplink to SimBrief ↗</a>
      </footer>
    </article>`;
  }

  async function search() {
    prefs.type = typeIn.value.trim().toUpperCase();
    prefs.airline = airlineIn.value.trim().toUpperCase();
    try { localStorage.setItem(PREFS, JSON.stringify(prefs)); } catch (_) { /* optional */ }
    if (prefs.type && !/^[A-Z0-9]{2,4}$/.test(prefs.type)) { status.innerHTML = '<div class="e-notice warn">Aircraft is an ICAO type code, e.g. B738.</div>'; return; }
    if (prefs.airline && !/^[A-Z]{3}$/.test(prefs.airline)) { status.innerHTML = '<div class="e-notice warn">Airline is a 3-letter ICAO code, e.g. BAW.</div>'; return; }
    list.innerHTML = '';
    status.innerHTML = '<div class="e-loading"><i></i>Finding live flights…</div>';
    try {
      const { results, pool } = await findRoutes({
        ...prefs, fetchTraffic, fetchRoute,
        onProgress: p => { if (!destroyed) status.innerHTML = `<div class="e-loading"><i></i>Checking routes · ${p.found} found of ${p.looked} flights</div>`; },
      });
      if (destroyed) return;
      list.innerHTML = results.map(card).join('');
      status.innerHTML = results.length
        ? `<div class="e-small e-muted">${results.length} real flights · from ${pool} airborne now</div>`
        : `<div class="e-notice">${pool ? 'No flight with a known route matches these filters right now.' : 'No matching flight is airborne right now.'} Widen the flight time or clear a filter.</div>`;
    } catch (error) {
      if (!destroyed) status.innerHTML = `<div class="e-notice bad">${esc(error.message)}</div>`;
    }
  }

  root.querySelector('#rf-form').addEventListener('submit', event => { event.preventDefault(); search(); });
  return { destroy() { destroyed = true; } };
}
