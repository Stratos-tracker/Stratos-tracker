/* The client half of the Stratos account API.
 *
 * The site is served from its own domain and the account service runs on the
 * Cloudflare Worker that already hosts the phone relay, so this is a cross-origin
 * JSON API. It authenticates with `Authorization: Bearer` rather than a cookie on
 * purpose: Safari on iPhone blocks third-party cookies, and the phone is the
 * device this whole feature exists for. The token is opaque, revocable from
 * Settings, and only ever sent to this one origin.
 *
 * Everything here returns a real result or throws AccountError. Nothing is
 * faked: a failed request never falls back to made-up data.
 */

import { DEFAULT_RELAY } from '../lib/connect.js';

const TOKEN_KEY = 'stratos.account.token';
const BASE_KEY = 'stratos.account.api';
const USER_KEY = 'stratos.account.user';
const SKIP_KEY = 'stratos.account.skipped';

export class AccountError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function clean(url) {
  return String(url || '').trim().replace(/\/+$/, '');
}

/** Where the account service lives. Overridable for staging and local dev. */
export function apiBase() {
  try {
    const fromWindow = clean(window.STRATOS_ACCOUNT_API);
    if (fromWindow) return fromWindow;
    const saved = clean(localStorage.getItem(BASE_KEY));
    if (saved) return saved;
  } catch (_) { /* private mode */ }
  // The packaged desktop app loads its files from file:, but its account lives
  // on the deployed service. Only a local dev server uses the local Worker.
  if (location.protocol === 'file:') return clean(DEFAULT_RELAY);
  const host = String(location.hostname || '');
  if (host === 'localhost' || host === '127.0.0.1') return 'http://127.0.0.1:8788';
  return clean(DEFAULT_RELAY);
}

export function rememberApiBase(value) {
  const base = clean(value);
  try {
    if (base) localStorage.setItem(BASE_KEY, base);
    else localStorage.removeItem(BASE_KEY);
  } catch (_) { /* private mode */ }
  return base;
}

/**
 * Where the session token lives.
 *
 * With "remember me" it goes to localStorage and survives the app being
 * closed, which is what a pilot expects on their own PC or tablet. Without it
 * the token lives in sessionStorage, so closing the tab ends the session on a
 * shared or borrowed device. If a write is refused (private mode), the session
 * still works for this tab rather than failing outright.
 */
export function savedToken() {
  try {
    const local = localStorage.getItem(TOKEN_KEY);
    if (local) return String(local);
  } catch (_) { /* private mode */ }
  try { return String(sessionStorage.getItem(TOKEN_KEY) || ''); } catch (_) { return ''; }
}

export function rememberToken(token, { remember = true } = {}) {
  const value = token ? String(token) : '';
  // A signed-in device no longer needs the first-launch prompt.
  if (value) {
    try { localStorage.removeItem(SKIP_KEY); } catch (_) { /* private mode */ }
  }
  try {
    if (value && remember) localStorage.setItem(TOKEN_KEY, value);
    else localStorage.removeItem(TOKEN_KEY);
  } catch (_) { /* private mode */ }
  try {
    if (value && !remember) sessionStorage.setItem(TOKEN_KEY, value);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch (_) { /* private mode */ }
  return value;
}

export function forgetToken() {
  rememberToken('');
  rememberUser(null);
}

/**
 * The account last seen on this device, kept beside the token so a label can
 * name the pilot without waiting for a request. It is a name, never a secret.
 */
export function savedUser() {
  try { return JSON.parse(localStorage.getItem(USER_KEY) || 'null'); } catch (_) { return null; }
}

export function rememberUser(user) {
  try {
    if (user && (user.username || user.email)) {
      localStorage.setItem(USER_KEY, JSON.stringify({
        username: user.username || '',
        email: user.email || '',
      }));
    } else {
      localStorage.removeItem(USER_KEY);
    }
  } catch (_) { /* private mode */ }
}

async function request(path, { method = 'GET', body, auth = true, base = apiBase() } = {}) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const token = savedToken();
  if (auth && token) headers.Authorization = `Bearer ${token}`;

  let response;
  try {
    response = await fetch(base + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
      credentials: 'omit',
      mode: 'cors',
    });
  } catch (_) {
    throw new AccountError(0, 'Stratos could not reach the account service. Check this device’s connection and try again.');
  }

  const text = await response.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch (_) { payload = null; }

  if (!response.ok) {
    if (response.status === 401 && auth) forgetToken();
    const message = (payload && payload.error)
      || (response.status === 404 ? 'The account service does not know that address.' : `The account service answered ${response.status}.`);
    throw new AccountError(response.status, message);
  }
  return payload || {};
}

// ── Accounts ─────────────────────────────────────────────────────────
export async function signup({ name, email, password, username, acceptedTerms, remember = true }) {
  const payload = await request('/api/auth/signup', {
    method: 'POST',
    body: { name, email, password, username, acceptedTerms, remember },
    auth: false,
  });
  if (payload.token) rememberToken(payload.token, { remember });
  if (payload.user) rememberUser(payload.user);
  return payload;
}

export async function login({ email, username, identifier, password, remember = true }) {
  const who = String(identifier ?? email ?? username ?? '').trim();
  const payload = await request('/api/auth/login', {
    method: 'POST', body: { identifier: who, password, remember }, auth: false,
  });
  if (payload.token) rememberToken(payload.token, { remember });
  if (payload.user) rememberUser(payload.user);
  return payload;
}

export async function logout() {
  try {
    if (savedToken()) await request('/api/auth/logout', { method: 'POST' });
  } finally {
    forgetToken();
  }
}

export async function session() {
  if (!savedToken()) return null;
  const payload = await request('/api/auth/session');
  if (payload.user) rememberUser(payload.user);
  return payload.user || null;
}

export const verifyEmail = token => request('/api/auth/verify', { method: 'POST', body: { token }, auth: false });
export const resendVerification = () => request('/api/auth/resend', { method: 'POST' });
export const forgotPassword = email => request('/api/auth/forgot', { method: 'POST', body: { email }, auth: false });
export const resetPassword = async ({ token, password }) => {
  const payload = await request('/api/auth/reset', { method: 'POST', body: { token, password }, auth: false });
  if (payload.token) rememberToken(payload.token);
  if (payload.user) rememberUser(payload.user);
  return payload;
};

/** A single-use code that lets the local bridge page inherit this session. */
export const createHandoff = () => request('/api/auth/handoff', { method: 'POST' });
export const exchangeHandoff = async code => {
  const payload = await request('/api/auth/exchange', {
    method: 'POST', body: { token: code }, auth: false,
  });
  if (payload.token) rememberToken(payload.token);
  if (payload.user) rememberUser(payload.user);
  return payload;
};

// ── Profile and security ─────────────────────────────────────────────
export const updateAccount = changes => request('/api/account', { method: 'PATCH', body: changes });
export const changePassword = ({ current, next }) => request('/api/account/password', { method: 'POST', body: { current, next } });
export const listSessions = () => request('/api/account/sessions');
export const revokeSession = id => request('/api/account/sessions/revoke', { method: 'POST', body: { id } });

// ── Data ─────────────────────────────────────────────────────────────
export const dashboard = () => request('/api/dashboard');
export const getFlights = () => request('/api/flights');
export const getPrefs = () => request('/api/prefs');
export const putPrefs = prefs => request('/api/prefs', { method: 'PUT', body: { prefs } });

/**
 * Push logbook records in batches. The service upserts on (user, id), so a
 * repeated sync is a no-op and a record edited on one device updates the other.
 */
export async function syncFlights(flights, { batch = 200, onProgress } = {}) {
  const list = Array.isArray(flights) ? flights.filter(Boolean) : [];
  if (!list.length) return { received: 0, total: 0 };
  let sent = 0;
  let total = 0;
  for (let i = 0; i < list.length; i += batch) {
    const slice = list.slice(i, i + batch);
    const payload = await request('/api/flights/sync', { method: 'POST', body: { flights: slice } });
    sent += slice.length;
    total = Number(payload.total) || total;
    if (onProgress) onProgress({ sent, of: list.length, total });
  }
  return { received: sent, total };
}

// ── Live flight ──────────────────────────────────────────────────────
export const liveSnapshot = () => request('/api/live');
export const liveTicket = () => request('/api/live/ticket', { method: 'POST' });
export const ingestLive = snapshot => request('/api/live/ingest', { method: 'POST', body: snapshot });
export const clearLive = () => request('/api/live/clear', { method: 'POST' });

// ── Local bridge presence ───────────────────────────────────────────
// The PC reports the LAN address of the bridge it found; a tablet on the same
// account reads it back. Only the authenticated account can see its own rows.
export const reportBridge = bridge => request('/api/bridge/presence', { method: 'POST', body: bridge });
export const discoverBridges = () => request('/api/bridge/discover');

export function liveSocketUrl(ticket, base = apiBase()) {
  const origin = clean(base).replace(/^http/i, 'ws');
  return `${origin}/api/live/ws?ticket=${encodeURIComponent(ticket)}`;
}

export const api = {
  base: apiBase,
  token: savedToken,
  user: savedUser,
  signup, login, logout, session,
  verifyEmail, resendVerification, forgotPassword, resetPassword,
  updateAccount, changePassword, listSessions, revokeSession,
  dashboard, getFlights, getPrefs, putPrefs, syncFlights,
  liveSnapshot, liveTicket, ingestLive, clearLive, liveSocketUrl,
  createHandoff, exchangeHandoff, reportBridge, discoverBridges,
};

export default api;
