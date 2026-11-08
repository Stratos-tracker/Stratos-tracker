/* Automatic PC discovery for the tablet.
 *
 * The browser cannot browse mDNS or call an HTTP LAN address from an HTTPS
 * page, so the PC advertises its bridge through the signed-in account. The
 * tablet asks that same account for fresh bridge records, then performs one
 * top-level navigation to the bridge's own /pair/connect page. That page is
 * the local Stratos map, served by the PC, so the existing /stream telemetry
 * and LAN-only pairing remain the only live path.
 *
 * Nothing here invents a connection: a bridge is used only when the account
 * has reported a fresh private-LAN address for it. A single bridge is opened
 * automatically; several bridges show a short name-only chooser.
 */

import * as api from './api.js';
import { findBridge } from './live.js';
import { pairingStatus } from '../bridge.js';

const HEARTBEAT_MS = 30_000;
const SEARCH_MS = 15_000;
const STATUS_ID = 'lan-status';
const CHOICE_ID = 'lan-choice';

let presenceTimer = null;
let autoStarted = false;
let autoTimer = null;

function loopback(base) {
  try {
    const url = new URL(base);
    return url.protocol === 'http:'
      && (url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '::1');
  } catch (_) {
    return false;
  }
}

/** A private HTTP origin is the only address a tablet may be sent to. */
export function isPrivateBridgeUrl(value) {
  try {
    const url = new URL(String(value || ''));
    if (url.protocol !== 'http:' || url.username || url.password || url.pathname !== '/') return false;
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (host === 'localhost' || host === '::1' || host.endsWith('.local')) return true;
    const parts = host.split('.');
    if (parts.length !== 4 || parts.some(part => !/^\d{1,3}$/.test(part) || Number(part) > 255)) return false;
    const [a, b] = parts.map(Number);
    return a === 10 || a === 127 || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  } catch (_) {
    return false;
  }
}

function bridgeId() {
  const key = 'stratos.bridgeId';
  try {
    const saved = localStorage.getItem(key) || '';
    if (/^[A-Za-z0-9_-]{6,64}$/.test(saved)) return saved;
    const generated = `pc-${crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2)}`
      .replace(/[^A-Za-z0-9_-]/g, '');
    localStorage.setItem(key, generated);
    return generated;
  } catch (_) {
    return 'pc-temporary-device';
  }
}

function hosted() {
  return location.protocol === 'https:' && !/^(localhost|127\.0\.0\.1)$/.test(location.hostname);
}

function phoneSized() {
  try {
    const touch = navigator.maxTouchPoints > 0 || 'ontouchstart' in window
      || matchMedia('(pointer:coarse)').matches;
    return touch && Math.min(innerWidth, innerHeight) <= 1024;
  } catch (_) {
    return false;
  }
}

/**
 * The bridge record the PC publishes. It is only produced when the bridge is
 * reachable over loopback, which keeps a tablet's local map from advertising
 * itself as another PC.
 */
export async function localBridgePresence() {
  if (!api.savedToken()) return null;
  let found = null;
  try { found = await findBridge(); } catch (_) { return null; }
  if (!found || !loopback(found.base)) return null;

  let status = null;
  try { status = await pairingStatus(found.base); } catch (_) { /* health is enough */ }
  const address = status && status.localUrl ? new URL(status.localUrl).origin : '';
  if (!isPrivateBridgeUrl(address)) return null;
  const health = found.health || {};
  const simulator = health.simulator && health.simulator.source ? health.simulator.source : '';
  return {
    id: bridgeId(),
    url: address,
    name: (status && status.hostName) || 'Stratos PC',
    version: String(health.version || '').slice(0, 40),
    simulator: String(simulator).slice(0, 40),
  };
}

/** Keep the PC's bridge record fresh while this desktop app is open. */
export function startBridgePresence() {
  if (presenceTimer || !api.savedToken()) return () => {};
  let stopped = false;
  const report = async () => {
    if (stopped || document.hidden) return;
    const bridge = await localBridgePresence();
    if (!bridge) return;
    try { await api.reportBridge(bridge); } catch (_) { /* retried on the next tick */ }
  };
  report();
  presenceTimer = setInterval(report, HEARTBEAT_MS);
  const wake = () => report();
  addEventListener('online', wake);
  addEventListener('focus', wake);
  return () => {
    stopped = true;
    clearInterval(presenceTimer);
    presenceTimer = null;
    removeEventListener('online', wake);
    removeEventListener('focus', wake);
  };
}

/** Fresh bridges for this account, newest first. */
export async function discoverBridges() {
  const payload = await api.discoverBridges();
  return (Array.isArray(payload.bridges) ? payload.bridges : [])
    .filter(bridge => bridge && isPrivateBridgeUrl(bridge.url))
    .sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
}

function chip() {
  let element = document.getElementById(STATUS_ID);
  if (element) return element;
  element = document.createElement('div');
  element.id = STATUS_ID;
  element.setAttribute('role', 'status');
  element.setAttribute('aria-live', 'polite');
  element.style.cssText = [
    'position:fixed', 'left:50%', 'bottom:18px', 'transform:translateX(-50%)',
    'z-index:99999', 'max-width:calc(100vw - 32px)', 'padding:8px 13px',
    'border:1px solid rgba(56,189,248,.35)', 'border-radius:999px',
    'background:rgba(7,13,22,.94)', 'color:#dbeafe', 'font:600 12px/1.3 system-ui,sans-serif',
    'box-shadow:0 8px 24px rgba(0,0,0,.35)', 'text-align:center', 'pointer-events:none',
  ].join(';');
  document.body.appendChild(element);
  return element;
}

const STATUS_TEXT = {
  searching: 'Searching for your PC…',
  connecting: 'Found your PC — opening the live map…',
  'not-found': 'PC not found — start Stratos on your PC',
  choose: 'Choose the PC to connect',
};

export function paintLanStatus(state, detail = '') {
  if (!hosted()) return;
  const element = chip();
  const text = detail || STATUS_TEXT[state] || '';
  element.hidden = !text;
  element.textContent = text;
  element.dataset.state = state;
}

function chooser(bridges, open) {
  let card = document.getElementById(CHOICE_ID);
  if (card) card.remove();
  card = document.createElement('div');
  card.id = CHOICE_ID;
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-label', 'Choose the PC to connect');
  card.style.cssText = [
    'position:fixed', 'left:50%', 'bottom:60px', 'transform:translateX(-50%)',
    'z-index:99999', 'width:min(360px,calc(100vw - 32px))', 'padding:14px',
    'border:1px solid rgba(56,189,248,.35)', 'border-radius:14px',
    'background:rgba(7,13,22,.98)', 'color:#e5eef8', 'font:14px/1.4 system-ui,sans-serif',
    'box-shadow:0 12px 36px rgba(0,0,0,.45)',
  ].join(';');
  const title = document.createElement('b');
  title.textContent = 'Which PC should Stratos use?';
  title.style.display = 'block';
  title.style.marginBottom = '8px';
  card.appendChild(title);
  bridges.forEach((bridge, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn btn--primary btn--wide';
    button.style.cssText = 'display:block;width:100%;margin:6px 0;padding:9px 11px;text-align:left;border-radius:8px;border:1px solid rgba(56,189,248,.35);background:#0b1a29;color:#dbeafe;font:600 13px system-ui,sans-serif;cursor:pointer';
    const name = String(bridge.name || `Stratos PC ${index + 1}`).slice(0, 60);
    const simulator = String(bridge.simulator || '').slice(0, 40);
    button.textContent = simulator ? `${name} · ${simulator}` : name;
    button.addEventListener('click', () => open(bridge));
    card.appendChild(button);
  });
  document.body.appendChild(card);
}

export function bridgeNextPath(code = '') {
  return `/index.html${code ? `#account=${encodeURIComponent(code)}` : ''}`;
}

export function pairConnectUrl(base, code = '') {
  return `${String(base).replace(/\/+$/, '')}/pair/connect?next=${encodeURIComponent(bridgeNextPath(code))}`;
}

async function openBridge() {
  paintLanStatus('connecting');
  // The account has already told us which PC is live, so there is nothing to
  // open on another origin: Stratos's own live view reads the same flight from
  // the account feed. No LAN address, no second browser tab, no typing.
  try { sessionStorage.setItem('stratos.openedLive', '1'); } catch (_) { /* private mode */ }
  location.assign('live.html');
}

/**
 * Watch for a fresh bridge and connect to it. One bridge navigates by itself;
 * several show a name-only chooser. Nothing happens on a desktop-sized page.
 */
export function startAutoConnect({ force = false } = {}) {
  if (autoStarted || !hosted() || !api.savedToken()) return;
  if (!force && !phoneSized()) return;
  // Already there, or the pilot has come back to the Deck on purpose: the live
  // view is opened once per session, not on every navigation.
  if (/live\.html$/.test(location.pathname)) return;
  if (!force) {
    try { if (sessionStorage.getItem('stratos.openedLive') === '1') return; } catch (_) { /* private mode */ }
  }
  autoStarted = true;

  const look = async () => {
    if (document.hidden) return;
    paintLanStatus('searching');
    let bridges = [];
    try { bridges = await discoverBridges(); } catch (_) { bridges = []; }
    if (!bridges.length) {
      paintLanStatus('not-found');
      return;
    }
    clearInterval(autoTimer);
    autoTimer = null;
    if (bridges.length === 1) {
      await openBridge(bridges[0]);
      return;
    }
    paintLanStatus('choose');
    chooser(bridges, openBridge);
  };

  look();
  autoTimer = setInterval(() => { if (!document.hidden) look(); }, SEARCH_MS);
}

/**
 * The bridge page receives a one-time code in its fragment. Exchange it for a
 * local session, then remove it from the address bar. A fragment is never sent
 * to the bridge, so the code does not appear in its request log.
 */
export async function consumeAccountHandoff() {
  const code = new URLSearchParams(String(location.hash || '').replace(/^#/, '')).get('account');
  if (!code) return null;
  try { history.replaceState(null, '', location.pathname + location.search); } catch (_) { /* old browser */ }
  try { return await api.exchangeHandoff(code); } catch (_) { return null; }
}
