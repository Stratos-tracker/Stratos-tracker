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
  const host = String(location.hostname || '');
  if (host === 'localhost' || host === '127.0.0.1' || host === '') return 'http://127.0.0.1:8788';
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

export function savedToken() {
  try { return String(localStorage.getItem(TOKEN_KEY) || ''); } catch (_) { return ''; }
}

export function rememberToken(token) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, String(token));
    else localStorage.removeItem(TOKEN_KEY);
  } catch (_) { /* private mode means the session lasts this tab only */ }
  return token;
}

export function forgetToken() {
  rememberToken('');
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
export async function signup({ email, password, username }) {
  const payload = await request('/api/auth/signup', { method: 'POST', body: { email, password, username }, auth: false });
  if (payload.token) rememberToken(payload.token);
  return payload;
}

export async function login({ email, password }) {
  const payload = await request('/api/auth/login', { method: 'POST', body: { email, password }, auth: false });
  if (payload.token) rememberToken(payload.token);
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
  return payload.user || null;
}

export const verifyEmail = token => request('/api/auth/verify', { method: 'POST', body: { token }, auth: false });
export const resendVerification = () => request('/api/auth/resend', { method: 'POST' });
export const forgotPassword = email => request('/api/auth/forgot', { method: 'POST', body: { email }, auth: false });
export const resetPassword = async ({ token, password }) => {
  const payload = await request('/api/auth/reset', { method: 'POST', body: { token, password }, auth: false });
  if (payload.token) rememberToken(payload.token);
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

export function liveSocketUrl(ticket, base = apiBase()) {
  const origin = clean(base).replace(/^http/i, 'ws');
  return `${origin}/api/live/ws?ticket=${encodeURIComponent(ticket)}`;
}

export const api = {
  base: apiBase,
  token: savedToken,
  signup, login, logout, session,
  verifyEmail, resendVerification, forgotPassword, resetPassword,
  updateAccount, changePassword, listSessions, revokeSession,
  dashboard, getFlights, getPrefs, putPrefs, syncFlights,
  liveSnapshot, liveTicket, ingestLive, clearLive, liveSocketUrl,
};

export default api;
