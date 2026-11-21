/* ChartFox account linking for the EFB (OAuth 2.0 authorization code + PKCE).
 *
 * ChartFox's API is a Laravel Passport server at https://api.chartfox.org:
 * /oauth/authorize takes the signed-in ChartFox user's consent and
 * /oauth/token exchanges the code (and later the refresh token). Stratos is a
 * public client: there is no client secret anywhere, and PKCE (S256) proves
 * the token request comes from the page that started the sign-in.
 *
 * The tokens are the user's own and live on this device only (localStorage),
 * never on a Stratos server; they are sent only to api.chartfox.org.
 * shortcut: a browser-held token is the standard model for a public PKCE client;
 * move to a server-side session if Stratos ever gains user accounts with one.
 */

export const CHARTFOX_CLIENT_ID = '01a1fe7e-cdcb-7300-b68d-baf156a6ad44';
export const CHARTFOX_API = 'https://api.chartfox.org';
export const CHARTFOX_AUTHORIZE = `${CHARTFOX_API}/oauth/authorize`;
export const CHARTFOX_TOKEN = `${CHARTFOX_API}/oauth/token`;
export const CHARTFOX_SCOPES = [
  'oauth:user:name', 'oauth:telemetry:view', 'airports:view',
  'charts:index', 'charts:view', 'charts:view_source_url', 'charts:files',
];

const TOKEN_KEY = 'stratos.chartfox.token';
const PENDING_KEY = 'stratos.chartfox.pending';

/** The callback page beside the EFB, on whichever host serves it. */
export function chartfoxRedirectUri(base = (typeof location !== 'undefined' ? location.href : '')) {
  return new URL('chartfox-callback.html', base).href;
}

function base64url(bytes) {
  let text = '';
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** A random URL-safe string (PKCE verifier, state). */
export function randomToken(bytes = 48, cryptoImpl = globalThis.crypto) {
  return base64url(cryptoImpl.getRandomValues(new Uint8Array(bytes)));
}

/** The S256 code challenge for a verifier. */
export async function pkceChallenge(verifier, cryptoImpl = globalThis.crypto) {
  const digest = await cryptoImpl.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

/** The consent page URL. Scopes are space-separated, as Passport expects. */
export function authorizeUrl({ redirectUri, state, challenge, clientId = CHARTFOX_CLIENT_ID }) {
  const query = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: CHARTFOX_SCOPES.join(' '),
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });
  return `${CHARTFOX_AUTHORIZE}?${query}`;
}

/** What is kept from a token response: the two tokens and when access ends. */
export function tokenRecord(response, now = Date.now()) {
  if (!response || typeof response.access_token !== 'string' || !response.access_token) return null;
  const life = Number(response.expires_in);
  return {
    access: response.access_token,
    refresh: typeof response.refresh_token === 'string' ? response.refresh_token : '',
    expiresAt: now + (Number.isFinite(life) && life > 0 ? life * 1000 : 3600 * 1000),
  };
}

function store() {
  try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch (_) { return null; }
}
function readToken() {
  try { return JSON.parse(store()?.getItem(TOKEN_KEY) || 'null'); } catch (_) { return null; }
}
function writeToken(record) {
  try {
    if (record) store()?.setItem(TOKEN_KEY, JSON.stringify(record));
    else store()?.removeItem(TOKEN_KEY);
  } catch (_) { /* private mode: the link lasts for this page only */ }
}

export function chartfoxConnected() {
  const record = readToken();
  return Boolean(record && (record.refresh || record.expiresAt > Date.now()));
}

export function disconnectChartfox() { writeToken(null); }

/** Send the user to ChartFox's consent page; `returnTo` is where to come back. */
export async function connectChartfox(returnTo = (typeof location !== 'undefined' ? location.href : '')) {
  const verifier = randomToken(48);
  const state = randomToken(24);
  const redirectUri = chartfoxRedirectUri();
  try {
    sessionStorage.setItem(PENDING_KEY, JSON.stringify({ verifier, state, redirectUri, returnTo }));
  } catch (_) {
    throw new Error('This browser blocks the storage the ChartFox sign-in needs.');
  }
  location.href = authorizeUrl({ redirectUri, state, challenge: await pkceChallenge(verifier) });
}

async function postToken(form, fetchImpl = fetch) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetchImpl(CHARTFOX_TOKEN, {
      method: 'POST',
      signal: controller.signal,
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form).toString(),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const reason = payload && (payload.error_description || payload.error);
      throw new Error(reason ? `ChartFox: ${reason}` : `ChartFox answered ${response.status}`);
    }
    return payload;
  } finally {
    clearTimeout(timer);
  }
}

/** The callback page: check the state, exchange the code, keep the tokens.
 *  Returns where to send the user back to. */
export async function completeChartfoxSignIn(search = location.search, fetchImpl = fetch) {
  const params = new URLSearchParams(search);
  let pending = null;
  try { pending = JSON.parse(sessionStorage.getItem(PENDING_KEY) || 'null'); } catch (_) { pending = null; }
  try { sessionStorage.removeItem(PENDING_KEY); } catch (_) { /* nothing to clear */ }
  if (params.get('error')) throw new Error(params.get('error_description') || 'ChartFox access was not granted.');
  if (!pending || !params.get('code')) throw new Error('This sign-in was not started from Stratos, or it expired. Start it again from Charts.');
  if (params.get('state') !== pending.state) throw new Error('The sign-in did not match the one Stratos started, so it was refused.');
  const payload = await postToken({
    grant_type: 'authorization_code',
    client_id: CHARTFOX_CLIENT_ID,
    redirect_uri: pending.redirectUri,
    code_verifier: pending.verifier,
    code: params.get('code'),
  }, fetchImpl);
  const record = tokenRecord(payload);
  if (!record) throw new Error('ChartFox did not return an access token.');
  writeToken(record);
  return pending.returnTo || 'efb.html#/charts';
}

let refreshing = null;

/** A usable access token, refreshed when it is about to expire; null when the
 *  account is not linked or the refresh was refused (the link is then dropped). */
export async function chartfoxToken(fetchImpl = fetch) {
  const record = readToken();
  if (!record) return null;
  if (record.expiresAt - Date.now() > 60 * 1000) return record.access;
  if (!record.refresh) { writeToken(null); return null; }
  refreshing = refreshing || postToken({
    grant_type: 'refresh_token',
    client_id: CHARTFOX_CLIENT_ID,
    refresh_token: record.refresh,
    scope: CHARTFOX_SCOPES.join(' '),
  }, fetchImpl).then(payload => {
    const next = tokenRecord(payload);
    writeToken(next);
    return next ? next.access : null;
  }).catch(() => { writeToken(null); return null; }).finally(() => { refreshing = null; });
  return refreshing;
}

/** GET a ChartFox API path with the user's token. A 401 refreshes once. */
export async function chartfoxGet(path, fetchImpl = fetch) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const token = await chartfoxToken(fetchImpl);
    if (!token) throw Object.assign(new Error('Connect your ChartFox account to see its charts.'), { code: 'signed-out' });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    let response;
    try {
      response = await fetchImpl(`${CHARTFOX_API}${path}`, {
        signal: controller.signal,
        headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
      });
    } finally {
      clearTimeout(timer);
    }
    if (response.status === 401 && attempt === 0) {
      const record = readToken();
      if (record) writeToken({ ...record, expiresAt: 0 });
      continue;
    }
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`ChartFox answered ${response.status}`);
    return response.json();
  }
  throw Object.assign(new Error('ChartFox no longer accepts this sign-in. Connect again.'), { code: 'signed-out' });
}
