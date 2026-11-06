/* The Flight Deck's two chart panels.
 *
 * Left: the plan as filed — departure and arrival, the procedures it names,
 * progress along the route and every waypoint.
 *
 * Right: the procedure deck. Departure airport, runway, SID and the transition
 * it flies; arrival airport, runway, STAR and its transition; the approach
 * where the dataset carries approach geometry. Changing anything here
 * recomputes the published legs and hands them to the map at once, through
 * `window.PROCLAYERS` — the map script draws what this module publishes and
 * owns nothing else about the plan.
 *
 * Data honesty: a kind the dataset does not carry is disabled with the reason
 * on the control, and an airport outside the dataset says so. Nothing is
 * interpolated to fill a gap.
 */
import {
  KINDS, KIND_ORDER, endpointsFor, pathFor, pathNote, describe, kindNote,
  planSelection, procedureList, transitionList, runwayIds, airportCode, missedPathFor,
} from './lib/procdeck.js';

const KEY = 'stratos.procdeck';
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const esc = value => String(value == null ? '' : value).replace(/[&<>"']/g, c => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

const state = {
  dep: '', arr: '', sid: '', sidTrans: '', depRwy: '', star: '', starTrans: '', arrRwy: '',
  approach: '', approachTrans: '', approachRwy: '', planOpen: true, procOpen: true,
};

const CACHE = new Map();
const LOADING = new Set();
let layers = [];
let lastPlanKey = '';
let syncTimer = null;
let busy = 0;

function bridge() {
  return (typeof window !== 'undefined' && window.DECK) || null;
}

function loadState() {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (saved && typeof saved === 'object') {
      for (const key of Object.keys(state)) {
        if (typeof saved[key] === typeof state[key]) state[key] = saved[key];
      }
    }
  } catch (_) { /* a bad saved selection is simply replaced by the plan's */ }
  if (typeof window !== 'undefined' && window.innerWidth < 900) {
    if (!localStorage.getItem(KEY)) { state.planOpen = false; state.procOpen = false; }
  }
}

function saveState() {
  try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (_) { /* storage is optional */ }
}

/** The plan's own procedures, adopted only when the plan itself changed. */
function adoptPlan() {
  const deck = bridge();
  if (!deck) return false;
  const plan = deck.plan ? deck.plan() : null;
  const selection = planSelection(plan);
  const route = (deck.route && deck.route()) || [];
  const ends = route.length > 1 && route[0].k === 'apt' && route[route.length - 1].k === 'apt'
    ? { dep: airportCode(route[0].id), arr: airportCode(route[route.length - 1].id) }
    : { dep: '', arr: '' };
  const key = [selection.dep || ends.dep, selection.arr || ends.arr, selection.sid, selection.sidTrans,
    selection.depRwy, selection.star, selection.starTrans, selection.arrRwy, selection.approach, selection.approachRwy].join('|');
  if (key === lastPlanKey) return false;
  const previous = lastPlanKey;
  lastPlanKey = key;

  // An airport that changes because a plan was loaded drops the procedures
  // that belonged to the old one. On the very first read (no earlier plan) the
  // pilot's saved choice is kept: the route's own ends are not a new plan.
  const hadPlan = Boolean(previous);
  const nextDep = selection.dep || ends.dep;
  const nextArr = selection.arr || ends.arr;
  if (nextDep && nextDep !== state.dep) {
    if (hadPlan) { state.sid = ''; state.sidTrans = ''; state.depRwy = ''; }
    state.dep = nextDep;
  }
  if (nextArr && nextArr !== state.arr) {
    if (hadPlan) { state.star = ''; state.starTrans = ''; state.arrRwy = ''; state.approach = ''; state.approachTrans = ''; }
    state.arr = nextArr;
  }
  // A newly loaded plan names its own procedures; those win over a stale choice.
  if (!previous || selection.sid || selection.star) {
    if (selection.sid) { state.sid = selection.sid; state.sidTrans = selection.sidTrans; }
    if (selection.star) { state.star = selection.star; state.starTrans = selection.starTrans; }
    if (selection.depRwy) state.depRwy = selection.depRwy;
    if (selection.arrRwy) state.arrRwy = selection.arrRwy;
    if (selection.approach) { state.approach = selection.approach; state.approachTrans = ''; }
    if (selection.approachRwy) state.approachRwy = selection.approachRwy;
  }
  return true;
}

/* One airport's payload, from the simulator's CIFP first and the bundled
   dataset second. A payload that says why it has nothing is kept as-is so the
   panel can print that reason instead of retrying forever. */
async function loadAirport(code) {
  const airport = airportCode(code);
  if (!airport) return null;
  if (CACHE.has(airport)) return CACHE.get(airport);
  for (const url of endpointsFor(airport)) {
    try {
      const response = await fetch(url, {
        cache: 'no-store',
        credentials: location.protocol === 'file:' ? 'omit' : 'include',
      });
      const payload = await response.json().catch(() => null);
      if (payload && (payload.ok === true || payload.reason)) {
        CACHE.set(airport, payload);
        return payload;
      }
      // A bridge that is not running answers with HTML or a 404 page: try the
      // next source rather than reporting the airport as unavailable.
    } catch (_) { /* same: this source is not there, the next one may be */ }
  }
  const unavailable = {
    ok: false,
    airport,
    reason: 'unreachable',
    error: `Procedure data for ${airport} could not be loaded. On a PC, start the Stratos bridge; on the website the bundled FAA dataset covers United States airports.`,
  };
  CACHE.set(airport, unavailable);
  return unavailable;
}

async function compute() {
  const deck = bridge();
  if (!deck) return;
  busy += 1;
  try {
    const [depPayload, arrPayload] = await Promise.all([loadAirport(state.dep), loadAirport(state.arr)]);
    // A remembered choice belongs to the airport it was made for. When the
    // airport changed under it, drop it rather than quietly draw nothing.
    const known = (payload, kind, ident) => !ident || procedureList(payload, kind).some(proc => proc.id === ident);
    if (!known(depPayload, 'sid', state.sid)) { state.sid = ''; state.sidTrans = ''; }
    if (!known(arrPayload, 'star', state.star)) { state.star = ''; state.starTrans = ''; }
    if (!known(arrPayload, 'approach', state.approach)) { state.approach = ''; state.approachTrans = ''; }
    const next = [];
    if (state.sid) next.push({ ...pathFor(depPayload, { kind: 'sid', ident: state.sid, runway: state.depRwy, transition: state.sidTrans }), airport: state.dep });
    if (state.star) next.push({ ...pathFor(arrPayload, { kind: 'star', ident: state.star, runway: state.arrRwy, transition: state.starTrans }), airport: state.arr });
    if (state.approach) {
      next.push({ ...pathFor(arrPayload, { kind: 'approach', ident: state.approach, runway: state.approachRwy || state.arrRwy, transition: state.approachTrans }), airport: state.arr });
      // The go-around path is published for the same approach but is a
      // separate layer; it is drawn only when the map's MISSED toggle is on.
      const missed = missedPathFor(arrPayload, { ident: state.approach, runway: state.approachRwy || state.arrRwy });
      if (missed.ok) next.push({ ...missed, airport: state.arr });
    }
    layers = next
      .filter(layer => layer && (layer.ok || layer.error))
      .map(layer => ({ ...layer, color: (KINDS[layer.kind] || {}).color || '#f472b6' }));
    if (typeof window !== 'undefined') window.PROCLAYERS = layers.filter(layer => layer.ok);
    const notes = layers.filter(layer => !layer.ok || !layer.complete).map(layer => pathNote(layer));
    if (deck.notes) deck.notes(notes);
    if (deck.redraw) deck.redraw();
  } finally {
    busy -= 1;
    render();
  }
}

function runwayOptions(payload, selected) {
  const ids = runwayIds(payload);
  if (!ids.length) return `<option value="">${payload && payload.ok ? 'No runway data' : 'No data'}</option>`;
  return ['<option value="">Any runway</option>', ...ids.map(id =>
    `<option value="${esc(id)}"${id === selected ? ' selected' : ''}>${esc(id)}</option>`)].join('');
}

function procedureOptions(payload, kind, selected, runway) {
  let list = procedureList(payload, kind);
  const note = kindNote(payload, kind);
  // With a runway chosen, offer only the approaches that land on it.
  if (kind === 'approach' && runway) {
    const landed = list.filter(proc => proc.runways.includes(runway));
    if (landed.length) list = landed;
  }
  if (!list.length) {
    return `<option value="">${esc(note || 'None published')}</option>`;
  }
  return [`<option value="">${kind === 'sid' ? 'No departure procedure' : kind === 'star' ? 'No arrival procedure' : 'No approach'}</option>`,
    ...list.map(proc => `<option value="${esc(proc.id)}"${proc.id === selected ? ' selected' : ''}>${esc(proc.id)}</option>`)].join('');
}

function transitionOptions(payload, kind, ident, selected) {
  const list = transitionList(payload, { kind, ident });
  if (!list.length) return '<option value="">No transition data</option>';
  const none = kind === 'approach' ? 'Final segment only' : 'Runway transition only';
  return [`<option value="">${none}</option>`, ...list.map(item =>
    `<option value="${esc(item.id)}"${item.id === selected ? ' selected' : ''}>${esc(item.label)}${item.complete ? '' : ' (partial)'}</option>`)].join('');
}

function groupHtml(side, payload) {
  const isDep = side === 'dep';
  const kind = isDep ? 'sid' : 'star';
  const info = describe(payload);
  const procedure = isDep ? state.sid : state.star;
  const transition = isDep ? state.sidTrans : state.starTrans;
  const runway = isDep ? state.depRwy : state.arrRwy;
  const airport = isDep ? state.dep : state.arr;
  const note = kindNote(payload, kind);
  const layer = layers.find(item => item.kind === kind);
  const status = !airport
    ? 'No airport chosen'
    : !payload || payload.ok !== true
      ? (payload && payload.error) || 'Procedure data unavailable'
      : `${info.counts[kind]} ${KINDS[kind].label}${info.counts[kind] === 1 ? '' : 's'} · ${info.runways.length} runway${info.runways.length === 1 ? '' : 's'}${info.cycle ? ' · AIRAC ' + info.cycle : ''}`;
  const drawn = layer && layer.ok
    ? `<div class="dk-drawn"><i style="background:${(KINDS[kind] || {}).color}"></i>${esc(pathNote(layer))}</div>`
    : '';
  return `<section class="dk-group" data-side="${side}">
  <header><span class="dk-kind" style="--dk-c:${(KINDS[kind] || {}).color}">${KINDS[kind].label}</span><b>${isDep ? 'Departure' : 'Arrival'}</b></header>
  <label class="dk-f"><span>Airport</span><input data-dk="${side}" data-field="airport" value="${esc(airport)}" maxlength="4" spellcheck="false" placeholder="ICAO"></label>
  <div class="dk-pair">
    <label class="dk-f"><span>Runway</span><select data-dk="${side}" data-field="runway"${payload && payload.ok ? '' : ' disabled'}>${runwayOptions(payload, runway)}</select></label>
    <label class="dk-f"><span>${KINDS[kind].label}</span><select data-dk="${side}" data-field="procedure"${payload && payload.ok ? '' : ' disabled'}>${procedureOptions(payload, kind, procedure, runway)}</select></label>
  </div>
  <label class="dk-f"><span>Transition</span><select data-dk="${side}" data-field="transition"${procedure ? '' : ' disabled'}>${transitionOptions(payload, kind, procedure, transition)}</select></label>
  <div class="dk-status${note ? ' warn' : ''}">${esc(status)}</div>
  ${drawn}
</section>`;
}

function approachHtml(payload) {
  const info = describe(payload);
  const note = kindNote(payload, 'approach');
  const available = Boolean(payload && payload.ok === true && info.counts.approach);
  const layer = layers.find(item => item.kind === 'approach');
  const runway = state.approachRwy || state.arrRwy;
  const status = !state.arr
    ? 'No arrival airport chosen'
    : !payload || payload.ok !== true
      ? (payload && payload.error) || 'Procedure data unavailable'
      : available
        ? `${info.counts.approach} approach${info.counts.approach === 1 ? '' : 'es'} · ${info.runways.length} runway${info.runways.length === 1 ? '' : 's'}${info.cycle ? ' · AIRAC ' + info.cycle : ''}`
        : note || `No approach leg geometry for ${state.arr} in this dataset`;
  const drawn = layer && layer.ok
    ? `<div class="dk-drawn"><i style="background:${KINDS.approach.color}"></i>${esc(pathNote(layer))}</div>`
    : '';
  return `<section class="dk-group" data-side="app">
  <header><span class="dk-kind" style="--dk-c:${KINDS.approach.color}">APP</span><b>Approach</b></header>
  <div class="dk-pair">
    <label class="dk-f"><span>Runway</span><select data-dk="app" data-field="runway"${available ? '' : ' disabled'}>${runwayOptions(payload, runway)}</select></label>
    <label class="dk-f"><span>Approach</span><select data-dk="app" data-field="procedure"${available ? '' : ' disabled'}>${procedureOptions(payload, 'approach', state.approach, runway)}</select></label>
  </div>
  <label class="dk-f"><span>Transition</span><select data-dk="app" data-field="transition"${state.approach ? '' : ' disabled'}>${transitionOptions(payload, 'approach', state.approach, state.approachTrans)}</select></label>
  <div class="dk-status${available && layer && layer.ok ? '' : ' warn'}">${esc(status)}</div>
  ${drawn}
  <div class="dk-actions"><button type="button" data-dk-chart="${esc(state.arr)}"${state.arr ? '' : ' disabled'}>Open ${esc(state.arr || 'airport')} charts</button></div>
</section>`;
}

function routeRow(point, index, cumulative, flown) {
  const alt = Number(point.elev) || 0;
  const level = alt >= 10000 ? 'FL' + Math.round(alt / 100) : alt ? Math.round(alt).toLocaleString() + ' ft' : '';
  const procedure = point.ss === 'sid' ? 'SID' : point.ss === 'star' ? 'STAR' : '';
  const passed = cumulative[index] <= flown;
  return `<li class="dk-wp${passed ? ' past' : ''}"><button type="button" data-dk-focus="${index}">
    <span class="dk-i">${index + 1}</span><b>${esc(point.id)}</b>
    <span class="dk-b">${esc(level)}</span><span class="dk-d">${cumulative[index].toFixed(0)} nm</span>
    ${procedure ? `<em>${procedure}</em>` : ''}</button></li>`;
}

function planHtml() {
  const deck = bridge();
  const route = (deck && deck.route && deck.route()) || [];
  const plan = (deck && deck.plan && deck.plan()) || null;
  const info = plan ? (plan.origin || {}) : {};
  const dest = plan ? (plan.destination || {}) : {};
  const dep = state.dep || info.icao || (route[0] && route[0].id) || '';
  const arr = state.arr || dest.icao || (route.length > 1 && route[route.length - 1].id) || '';
  const depAirport = deck && deck.airport ? deck.airport(dep) : null;
  const arrAirport = deck && deck.airport ? deck.airport(arr) : null;
  const cumulative = (deck && deck.cumulative && deck.cumulative()) || [];
  const flown = (deck && deck.flown && deck.flown()) || 0;
  const total = cumulative.length ? cumulative[cumulative.length - 1] : 0;
  const pct = total ? Math.max(0, Math.min(100, Math.round((flown / total) * 100))) : 0;
  const remaining = Math.max(0, total - flown);

  if (!route.length) {
    return `<div class="dk-empty"><b>No plan loaded</b><p>Import a SimBrief plan (Pilot ID or username) and its SID and STAR are read from the OFP, then drawn here and on the chart.</p></div>`;
  }
  return `<div class="dk-route">
    <div class="dk-end"><span>FROM</span><b>${esc(dep || '—')}</b><em>${esc(depAirport ? depAirport.name : info.name || '')}</em></div>
    <div class="dk-arrow">→</div>
    <div class="dk-end"><span>TO</span><b>${esc(arr || '—')}</b><em>${esc(arrAirport ? arrAirport.name : dest.name || '')}</em></div>
  </div>
  <div class="dk-chips">
    <span style="--dk-c:${KINDS.sid.color}">${esc(state.sid || 'no SID')}${state.sid ? ' · ' + esc(KINDS.sid.label) : ''}</span>
    <span style="--dk-c:${KINDS.star.color}">${esc(state.star || 'no STAR')}${state.star ? ' · ' + esc(KINDS.star.label) : ''}</span>
    <span>${route.length} fixes</span><span>${total.toFixed(0)} nm</span>
  </div>
  <div class="dk-prog"><div class="dk-bar"><i style="width:${pct}%"></i></div>
    <div class="dk-progt"><span>${flown.toFixed(0)} nm flown · ${pct}%</span><span>${remaining.toFixed(0)} nm to run</span></div></div>
  <ol class="dk-wps">${route.slice(0, 80).map((point, i) => routeRow(point, i, cumulative, flown)).join('')}</ol>
  ${route.length > 80 ? `<div class="dk-status">Showing the first 80 of ${route.length} fixes.</div>` : ''}`;
}

function coverageHtml() {
  const dep = describe(CACHE.get(state.dep));
  const arr = describe(CACHE.get(state.arr));
  const cycle = dep.cycle || arr.cycle || '';
  const source = /FAA/i.test(dep.source || arr.source) ? 'FAA CIFP · United States' : (dep.source || arr.source || 'No procedure dataset');
  return `<div class="dk-cov"><b>${esc(source)}</b><span>${cycle ? 'AIRAC ' + esc(cycle) : 'cycle unknown'} · SID, STAR and approach leg geometry with runway thresholds. Airways are not in this dataset.</span></div>`;
}

function render() {
  const plan = $('#planpane');
  const proc = $('#procpane');
  if (!plan || !proc) return;
  const deck = bridge();
  if (!deck) return;
  plan.classList.toggle('closed', !state.planOpen);
  proc.classList.toggle('closed', !state.procOpen);
  plan.classList.toggle('open', state.planOpen);
  proc.classList.toggle('open', state.procOpen);
  const host = $('#app');
  if (host) host.classList.toggle('dk-plan-open', state.planOpen && window.innerWidth >= 901);
  if (state.planOpen) {
    const title = plan.querySelector('.dk-head b');
    if (title) title.textContent = 'Flight plan';
    const body = plan.querySelector('.dk-body');
    if (body) body.innerHTML = planHtml();
  }
  if (state.procOpen) {
    const body = proc.querySelector('.dk-body');
    if (body) {
      const depPayload = CACHE.get(state.dep);
      const arrPayload = CACHE.get(state.arr);
      body.innerHTML = groupHtml('dep', depPayload) + groupHtml('arr', arrPayload) + approachHtml(arrPayload) + coverageHtml();
    }
  }
  for (const button of $$('[data-dk-toggle]')) {
    const side = button.dataset.dkToggle;
    const open = side === 'plan' ? state.planOpen : state.procOpen;
    button.setAttribute('aria-expanded', open ? 'true' : 'false');
    button.classList.toggle('on', open);
  }
}

function mountPanes() {
  const host = $('#app');
  if (!host || $('#planpane')) return;
  const plan = document.createElement('aside');
  plan.id = 'planpane';
  plan.className = 'dkpane dk-left';
  plan.setAttribute('aria-label', 'Flight plan');
  plan.innerHTML = `<div class="dk-head"><b>Flight plan</b><span class="dk-tools"><button type="button" class="dk-fold" data-dk-fit title="Fit the route on the chart">⤢</button><button type="button" class="dk-fold" data-dk-toggle="plan" aria-expanded="true" title="Collapse the flight plan">‹</button></span></div><div class="dk-body"></div>`;
  const proc = document.createElement('aside');
  proc.id = 'procpane';
  proc.className = 'dkpane dk-right';
  proc.setAttribute('aria-label', 'Procedures');
  proc.innerHTML = `<div class="dk-head"><b>Procedures</b><button type="button" class="dk-fold" data-dk-toggle="proc" aria-expanded="true" title="Collapse the procedure deck">›</button></div><div class="dk-body"></div>`;
  host.append(plan, proc);
}

function onPaneClick(event) {
  const toggle = event.target.closest('[data-dk-toggle]');
  if (toggle) {
    const side = toggle.dataset.dkToggle;
    if (side === 'plan') state.planOpen = !state.planOpen;
    else state.procOpen = !state.procOpen;
    saveState();
    render();
    return;
  }
  const fit = event.target.closest('[data-dk-fit]');
  if (fit) {
    const deck = bridge();
    if (deck && deck.fit) deck.fit();
    return;
  }
  const focus = event.target.closest('[data-dk-focus]');
  if (focus) {
    const deck = bridge();
    const route = (deck && deck.route && deck.route()) || [];
    const point = route[Number(focus.dataset.dkFocus)];
    if (point && deck.focus) deck.focus(point.lat, point.lon, point.k === 'apt' ? 11.5 : 9.5);
    return;
  }
  const chart = event.target.closest('[data-dk-chart]');
  if (chart) {
    const deck = bridge();
    if (deck && deck.charts) deck.charts(chart.dataset.dkChart);
  }
}

function onPaneChange(event) {
  const input = event.target.closest('[data-dk]');
  if (!input) return;
  const side = input.dataset.dk;
  const field = input.dataset.field;
  let value = String(input.value || '').trim();
  if (field === 'airport') value = value.toUpperCase();
  if (side === 'dep' || side === 'arr') {
    if (field === 'airport') {
      state[side] = airportCode(value);
      if (side === 'dep') { state.sid = ''; state.sidTrans = ''; state.depRwy = ''; }
      else { state.star = ''; state.starTrans = ''; state.arrRwy = ''; state.approach = ''; state.approachRwy = ''; }
    } else if (field === 'runway') {
      if (side === 'dep') state.depRwy = value; else state.arrRwy = value;
    } else if (field === 'procedure') {
      if (side === 'dep') { state.sid = value.toUpperCase(); state.sidTrans = ''; }
      else { state.star = value.toUpperCase(); state.starTrans = ''; }
    } else if (field === 'transition') {
      if (side === 'dep') state.sidTrans = value.toUpperCase(); else state.starTrans = value.toUpperCase();
    }
  }
  if (side === 'app') {
    if (field === 'runway') {
      state.approachRwy = value.toUpperCase();
      // Keep the approach and its runway together.
      if (state.approach && state.approachRwy) {
        const proc = procedureList(CACHE.get(state.arr), 'approach').find(item => item.id === state.approach);
        if (proc && proc.runways.length && !proc.runways.includes(state.approachRwy)) {
          state.approach = '';
          state.approachTrans = '';
        }
      }
    } else if (field === 'procedure') {
      state.approach = value.toUpperCase();
      state.approachTrans = '';
    } else if (field === 'transition') {
      state.approachTrans = value.toUpperCase();
    }
  }
  saveState();
  compute();
}

/** Re-read the plan (SimBrief loads, route edits) and repaint if it changed. */
export function syncProcDeck() {
  if (!bridge()) return;
  const changed = adoptPlan();
  if (changed) saveState();
  if (changed || !layers.length) compute();
  else render();
}

export function initProcDeck() {
  if (typeof window === 'undefined' || !bridge()) return;
  loadState();
  mountPanes();
  const host = $('#app');
  if (host) {
    host.addEventListener('click', onPaneClick);
    host.addEventListener('change', onPaneChange);
  }
  for (const button of $$('[data-dk-layer]')) button.classList.add('on');
  adoptPlan();
  compute();
  if (syncTimer) clearInterval(syncTimer);
  syncTimer = setInterval(syncProcDeck, 2500);
  window.addEventListener('resize', () => {
    if (window.innerWidth < 900 && state.planOpen && state.procOpen) {
      state.planOpen = false;
      saveState();
      render();
    }
  });
  window.PROCDECK = { state, sync: syncProcDeck, layers: () => layers, busy: () => busy };
}
