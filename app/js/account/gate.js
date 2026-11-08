/* The first-launch sign-in gate.
 *
 * A plain script on purpose: it runs in <head> before the tracker's own code, so
 * the sign-in page appears before the map starts to draw. A module would be
 * deferred until after the map had already initialised.
 *
 * Rules
 *   · Signed in — the app opens as usual.
 *   · "Skip for now" — the app opens and Settings offers the account later.
 *   · Neither — the sign-in page, with the destination remembered.
 *
 * Where it applies
 *   The public site and the desktop app. A page served by the bridge itself is
 *   exempt: the PC already handed this phone its own local session, and asking
 *   for an account there would break the live view. A development server on
 *   localhost is exempt for the same practical reason.
 *
 * What it is worth
 *   A prompt, not a lock. These are static files, so anyone who edits
 *   localStorage steps around it. The real boundary is the account API, which
 *   answers 401 to every data route without a valid session. The gate exists so
 *   a first launch starts with a clear choice instead of an empty map.
 */
(function () {
  'use strict';

  var TOKEN_KEY = 'stratos.account.token';
  var SKIP_KEY = 'stratos.account.skipped';
  var BASE_KEY = 'stratos.account.api';
  // Kept in step with DEFAULT_RELAY in js/lib/connect.js: a plain script loaded
  // before the modules cannot import it.
  var DEFAULT_API = 'https://stratos-relay.jadhariri108.workers.dev';
  var AUTH = 'auth.html';

  var protocol = location.protocol;
  var isFile = protocol === 'file:';
  var host = String(location.hostname || '');
  var localHost = host === 'localhost'
    || host === '127.0.0.1'
    || /^10\./.test(host)
    || /^192\.168\./.test(host)
    || /^172\.(1[6-9]|2\d|3[01])\./.test(host)
    || /\.local$/i.test(host);
  // The bridge's own pages, and a dev server, are already local and trusted.
  if (!isFile && (localHost || location.port === '8765')) return;

  function read(store, key) {
    try { return store.getItem(key) || ''; } catch (_) { return ''; }
  }

  function token() {
    return read(localStorage, TOKEN_KEY) || read(sessionStorage, TOKEN_KEY);
  }

  function skipped() {
    return read(localStorage, SKIP_KEY) === '1';
  }

  function forget() {
    try { localStorage.removeItem(TOKEN_KEY); } catch (_) { /* private mode */ }
    try { sessionStorage.removeItem(TOKEN_KEY); } catch (_) { /* private mode */ }
  }

  function nextTarget() {
    // A packaged app is loaded from file:, where an absolute path is not a route
    // on this app; the page name is what the destination needs to be.
    if (isFile) {
      var parts = location.pathname.split('/');
      return parts[parts.length - 1] + location.search;
    }
    return location.pathname + location.search;
  }

  function signInUrl() {
    return AUTH + '?next=' + encodeURIComponent(nextTarget());
  }

  function apiBase() {
    var configured = '';
    try { configured = String(window.STRATOS_ACCOUNT_API || '').trim(); } catch (_) { /* ignore */ }
    if (!configured) configured = read(localStorage, BASE_KEY);
    return (configured || DEFAULT_API).replace(/\/+$/, '');
  }

  var current = token();
  if (!current) {
    if (skipped()) return;
    location.replace(signInUrl());
    return;
  }

  // A stored token can be expired, or revoked from another device. Ask the
  // service; when it says no, clear the token and show the way back in. A
  // network failure is not a reason to throw a pilot out of a map that runs
  // from this machine.
  fetch(apiBase() + '/api/auth/session', {
    headers: { Authorization: 'Bearer ' + current, Accept: 'application/json' },
    cache: 'no-store',
    credentials: 'omit',
    mode: 'cors',
  }).then(function (response) {
    if (response.status === 401) {
      forget();
      location.replace(signInUrl());
    }
  }).catch(function () { /* offline: the local app still runs */ });
})();
