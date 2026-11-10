/**
 * DIRECT TO, for every desktop surface that can change the route.
 *
 * One implementation, mounted wherever the page offers a control column: the
 * Flight Deck's action stack (#fab) and the EFB (which has no such column, so
 * the button floats bottom-right). The behaviour, wording and route rules are
 * identical to Phone Mode, because all three edit the same stored plan through
 * `lib/directto.js` and `lib/routestore.js`.
 *
 * This changes the EFB route only. Nothing here reaches the aircraft's FMS, and
 * the panel says so before the pilot confirms.
 */

import { searchAirports } from './efb/common.js';
import { searchDirect, planDirectTo, restoreDirectTo, directToState } from './lib/directto.js';
import { readPlan, writePlan, readBackup, writeBackup, clearBackup } from './lib/routestore.js';

const svgIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20 20 4"/><path d="M14 4h6v6"/></svg>';

const state = { results: [], selected: null, token: 0, plan: readPlan() };

function ensureStyles() {
  if (document.querySelector('link[data-directto]')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = 'directto.css';
  link.dataset.directto = '1';
  document.head.appendChild(link);
}

function panelMarkup() {
  return `
    <div class="dto-card" role="dialog" aria-modal="true" aria-labelledby="dto-title">
      <header>
        <b id="dto-title">Direct to</b>
        <button class="dto-x" type="button" data-dto="close" aria-label="Close">✕</button>
      </header>
      <label class="dto-search">
        <input id="dto-input" type="search" placeholder="Waypoint, airport, VOR or NDB" autocomplete="off" autocapitalize="characters" spellcheck="false" aria-label="Search for a fix">
        <span id="dto-hint">Search the loaded route or an airport directory.</span>
      </label>
      <ul class="dto-results" id="dto-results" role="listbox" aria-label="Direct to results"></ul>
      <div class="dto-preview" id="dto-preview" hidden></div>
      <footer>
        <button type="button" data-dto="cancel">Cancel</button>
        <button type="button" class="primary" data-dto="confirm" disabled>Confirm direct to</button>
      </footer>
    </div>`;
}

function esc(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, ch => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));
}

function toast(message, ms = 4200) {
  let node = document.getElementById('dto-toast');
  if (!node) {
    node = document.createElement('div');
    node.id = 'dto-toast';
    node.className = 'dto-toast';
    document.body.appendChild(node);
  }
  node.textContent = message;
  node.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { node.hidden = true; }, ms);
}

function mountButton() {
  const fab = document.getElementById('fab');
  const button = document.createElement('button');
  button.type = 'button';
  button.className = fab ? 'fab dto-fab' : 'dto-fab dto-fab-floating';
  button.id = 'bDirectTo';
  button.setAttribute('aria-label', 'Direct to a waypoint');
  button.title = 'Direct to — modifies the EFB route, not the aircraft FMS';
  button.innerHTML = `${svgIcon}<span>DIRECT<br>TO</span>`;
  button.addEventListener('click', open);
  if (fab) fab.prepend(button);
  else document.body.appendChild(button);
}

function mountSheet() {
  const sheet = document.createElement('div');
  sheet.className = 'dto-sheet';
  sheet.id = 'dto-sheet';
  sheet.hidden = true;
  sheet.setAttribute('aria-hidden', 'true');
  sheet.innerHTML = panelMarkup();
  document.body.appendChild(sheet);

  sheet.addEventListener('click', event => {
    if (event.target === sheet) { close(); return; }
    const command = event.target.closest('[data-dto]');
    if (!command) return;
    if (command.dataset.dto === 'close' || command.dataset.dto === 'cancel') close();
    if (command.dataset.dto === 'confirm') confirm();
  });

  const input = sheet.querySelector('#dto-input');
  let timer = null;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    state.token += 1;
    const token = state.token;
    const query = input.value.trim().toUpperCase();
    if (!query) { state.results = []; renderResults(); return; }
    state.results = searchDirect(state.plan, query, []);
    renderResults();
    if (query.length < 2) return;
    timer = setTimeout(async () => {
      try {
        const airports = await searchAirports(query, 8);
        if (token !== state.token) return;
        state.results = searchDirect(state.plan, query, airports);
        renderResults();
      } catch (_) { /* the route matches stay */ }
    }, 180);
  });

  input.addEventListener('keydown', event => {
    if (event.key === 'Escape') { close(); return; }
    if (event.key !== 'Enter') return;
    event.preventDefault();
    const query = input.value.trim().toUpperCase();
    if (!query) return;
    const matches = state.results.length ? state.results : searchDirect(state.plan, query, []);
    if (!matches.length) return;
    state.results = matches;
    renderResults();
    select(matches[0]);
  });

  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !sheet.hidden) close();
  });
  return sheet;
}

let sheetEl = null;

function open() {
  state.plan = readPlan();
  if (!state.plan.points.length) {
    toast('No flight plan is loaded. Build or import a route first.');
    return;
  }
  if (!sheetEl) sheetEl = mountSheet();
  state.results = [];
  state.selected = null;
  const preview = document.getElementById('dto-preview');
  const confirmButton = sheetEl.querySelector('[data-dto="confirm"]');
  if (preview) { preview.hidden = true; preview.innerHTML = ''; }
  if (confirmButton) confirmButton.disabled = true;
  renderResults();
  sheetEl.hidden = false;
  sheetEl.setAttribute('aria-hidden', 'false');
  const input = document.getElementById('dto-input');
  input.value = '';
  setTimeout(() => input.focus({ preventScroll: true }), 30);

  const direct = directToState(state.plan);
  const hint = document.getElementById('dto-hint');
  if (hint && direct) hint.textContent = `Direct to ${direct.id} is active. Clearing it restores the original route.`;
}

function close() {
  if (sheetEl) {
    sheetEl.hidden = true;
    sheetEl.setAttribute('aria-hidden', 'true');
  }
}

function renderResults() {
  const list = document.getElementById('dto-results');
  if (!list) return;
  if (!state.results.length) {
    list.innerHTML = '<li class="dto-empty">Type a waypoint from the route, or an airport ident.</li>';
    return;
  }
  list.innerHTML = state.results.map((row, index) => `
    <li role="option" aria-selected="${state.selected && state.selected.id === row.id ? 'true' : 'false'}">
      <button type="button" data-result="${index}">
        <span class="dto-id">${esc(row.id)}</span>
        <span class="dto-name">${esc(row.name)}${row.source === 'route' ? ' · in route' : ''}</span>
        <span class="dto-num"><b>${row.distanceNm == null ? '—' : `${Math.round(row.distanceNm).toLocaleString('en-GB')} nm`}</b>${row.bearingDeg == null ? '' : `${String(Math.round(row.bearingDeg)).padStart(3, '0')}°`}</span>
      </button>
    </li>`).join('');
  list.querySelectorAll('[data-result]').forEach(button => {
    button.addEventListener('click', () => select(state.results[Number(button.dataset.result)]));
  });
}

function select(row) {
  if (!row) return;
  state.selected = row;
  renderResults();
  const result = planDirectTo(state.plan, row, { gsKt: 0 });
  const box = document.getElementById('dto-preview');
  const confirmButton = sheetEl ? sheetEl.querySelector('[data-dto="confirm"]') : null;
  if (!result.ok) {
    if (box) { box.hidden = false; box.innerHTML = `<p class="dto-note">${esc(result.error)}</p>`; }
    if (confirmButton) confirmButton.disabled = true;
    return;
  }
  if (confirmButton) confirmButton.disabled = false;
  if (!box) return;
  const info = result.preview;
  box.hidden = false;
  box.innerHTML = `
    <div class="dto-leg">${esc(info.from.id)}<i></i>${esc(info.to.id)}</div>
    <dl class="dto-rows">
      <dt>Direct leg</dt><dd>${info.legNm.toFixed(1)} nm</dd>
      <dt>Bearing</dt><dd>${info.bearingDeg == null ? '—' : `${String(info.bearingDeg).padStart(3, '0')}°`}</dd>
      <dt>Route after</dt><dd>${Math.round(info.totalNm).toLocaleString('en-GB')} nm</dd>
      <dt>Affected</dt><dd>${info.skippedPoints} bypassed · ${info.resumedPoints} kept</dd>
    </dl>
    <p class="dto-note">${info.inRoute ? 'The route resumes from this fix.' : 'This fix is not in the route; the points after departure are kept.'}
      Measured from ${esc(info.from.id)}, the plan origin — no live position is used for the calculation.
      EFB route only: nothing is transmitted to the aircraft.</p>`;
}

function confirm() {
  if (!state.selected) return;
  const result = planDirectTo(state.plan, state.selected, { gsKt: 0 });
  if (!result.ok) { toast(result.error); return; }
  writeBackup({ points: state.plan.points, at: Date.now(), id: state.plan.id || '' });
  if (!writePlan(result.plan)) { toast('Could not save the route in this browser.'); return; }
  state.plan = readPlan();
  close();
  window.dispatchEvent(new CustomEvent('stratos:route-changed', { detail: { plan: state.plan } }));
  syncClearButton();
  toast(`Direct to ${result.preview.to.id} saved. Reload the map to draw the new route.`, 5200);
}

function clearDirect() {
  const backup = readBackup();
  if (!backup && !directToState(state.plan)) { toast('There is no direct-to to clear.'); return; }
  const restored = restoreDirectTo(state.plan, backup);
  if (!writePlan(restored)) { toast('Could not save the route in this browser.'); return; }
  clearBackup();
  state.plan = readPlan();
  close();
  window.dispatchEvent(new CustomEvent('stratos:route-changed'));
  syncClearButton();
  toast(backup
    ? 'Direct to cleared. The original route is restored — reload the map to draw it.'
    : 'Direct to cleared. No original route was saved on this device.', 5200);
}

/* CLEAR DIRECT TO appears only while a direct-to is active, beside the button
   that made it, so the original route is always one press away. */
function syncClearButton() {
  const existing = document.getElementById('bClearDirect');
  const active = directToState(state.plan);
  if (!active) { if (existing) existing.remove(); return; }
  if (existing) return;
  const anchor = document.getElementById('bDirectTo');
  if (!anchor) return;
  const clear = document.createElement('button');
  clear.type = 'button';
  clear.className = anchor.className;
  clear.id = 'bClearDirect';
  clear.title = 'Restore the route the direct-to replaced';
  clear.innerHTML = '<span>CLEAR<br>DTO</span>';
  clear.addEventListener('click', clearDirect);
  if (document.getElementById('fab')) anchor.after(clear);
  else document.body.appendChild(clear);
}

function boot() {
  ensureStyles();
  mountButton();
  syncClearButton();
  window.addEventListener('storage', event => {
    if (event.key && !/activeRoute|directTo/.test(event.key)) return;
    state.plan = readPlan();
    syncClearButton();
  });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
else boot();
