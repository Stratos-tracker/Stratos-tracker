/* Stratos service worker.
   The shell is available offline after the first visit. Live data, telemetry,
   logbook JSON, weather and map tiles are NEVER cached, so stale data can never
   be presented as live. A new build replaces the old cache on activation. */
const CACHE = 'stratos-shell-2.1.45-phone';
const SHELL = [
  './',
  'index.html',
  'manifest.webmanifest',
  'stratos-ui.css',
  'pilot.css',
  'shell.css',
  // The phone presentation layer: one stylesheet and one runtime, loaded only
  // by the five destinations that declare a mobile section.
  'mobile.css',
  'js/mobile.js',
  // The professional EFB chrome, the optional 3D globe, and the vendored
  // renderer it needs. Globe tiles themselves are live data, never cached.
  'efb-hud.css',
  'js/lib/globe3d.js',
  'js/lib/earthview.js',
  'vendor/maplibre/maplibre-gl.js',
  'vendor/maplibre/maplibre-gl.css',
  // The five destinations themselves, so an installed app opens each tab
  // offline instead of falling back to the map.
  'logbook.html',
  'weather.html',
  'pilot.html',
  'icon-180.png',
  'icon-192.png',
  'icon-512.png',
  'icon-maskable-512.png',
  'vendor/qrcode.js',
  // The bag has its own entry point and manifest, so an installed EFB opens
  // offline on itself rather than on the tracker.
  'efb.html',
  'efb.css',
  'efb-flightplan.css',
  'manifest-efb.webmanifest',
  'js/efb.js',
  // Phone Mode: its own entry point, manifest, stylesheet and modules, so an
  // installed phone app opens the phone interface — not the desktop deck.
  'directto.css',
  'js/lib/directto.js',
  'js/lib/routestore.js',
  'js/directto-control.js',
  'manifest-phone.webmanifest',
  // The account pages are static, so they open offline too; every account API
  // call is cross-origin and never touches this cache.
  'account.html',
  'auth.html',
  'login.html',
  'signup.html',
  'terms.html',
  'privacy.html',
  'forgot.html',
  'reset.html',
  'verify.html',
  'account.css',
  'js/account/api.js',
  'js/account/ui.js',
  'js/account/gate.js',
  'js/account/landing.js',
  'js/account/auth.js',
  'js/account/live.js',
  'js/account/discovery.js',
  'js/account/dashboard.js',
];

/**
 * Whether an earlier build installed a phone page of its own.
 *
 * Phone Mode used to be `phone.html`, cached under `/phone`; this build serves
 * the Flight Deck at that URL instead. A worker that waits for the update prompt
 * would leave the old page in place, because that page is the last thing showing
 * the prompt and it is answering its own navigations from cache. Detecting the
 * legacy shell lets this worker take over at once instead.
 */
async function hasLegacyPhoneShell() {
  const keys = await caches.keys();
  for (const key of keys) {
    if (key === CACHE) continue;
    const cache = await caches.open(key);
    if (await cache.match('phone.html')) return true;
  }
  return false;
}

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE)
      .then(cache => cache.addAll(SHELL))
      .then(() => hasLegacyPhoneShell())
      .then(async legacy => {
        // A phone shell that no longer exists is a broken entry point, not a
        // panel worth preserving: replace it immediately. Any other update still
        // waits, so the shell is never swapped under a live map, and a first
        // install takes over at once.
        if (legacy) return self.skipWaiting();
        const keys = await caches.keys();
        if (keys.length <= 1) return self.skipWaiting();
        return undefined;
      })
  );
});

self.addEventListener('message', event => {
  if (event.data && event.data.type === 'STRATOS_SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    // Whether the page that installed this worker was the old phone shell has to
    // be answered before its cache is removed.
    const legacyPhone = await hasLegacyPhoneShell();
    const keys = await caches.keys();
    await Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key)));
    await self.clients.claim();
    if (!legacyPhone) return;
    // That page is the deleted shell. Put the phone on the Flight Deck now,
    // rather than waiting for a hand-close that would only ever reach the old
    // worker: a reopened standalone app would otherwise show the stale shell.
    const windows = await self.clients.matchAll({ type: 'window' });
    for (const client of windows) {
      let path = '';
      try { path = new URL(client.url).pathname; } catch (_) { path = ''; }
      if (!/\/phone(\/|\.html)?$/.test(path) || typeof client.navigate !== 'function') continue;
      try { await client.navigate(client.url); } catch (_) { /* the browser may refuse */ }
    }
  })());
});

function isLiveRequest(url) {
  return (
    url.pathname.includes('/api/') ||
    url.pathname.endsWith('/logbook.json') ||
    // The release manifest is checked fresh; a cached copy would keep offering
    // an old "latest" version after a new release is published.
    url.pathname.endsWith('/releases.json') ||
    url.pathname.endsWith('/health') ||
    url.pathname.endsWith('/stream') ||
    url.pathname.endsWith('/metar') ||
    url.pathname.endsWith('/weather') ||
    url.pathname.endsWith('/airports.json') ||
    url.pathname.endsWith('/navaids.json') ||
    url.pathname.startsWith('/tile/') ||
    url.pathname.startsWith('/relay/')
  );
}

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (isLiveRequest(url)) return;
  // Never cache range requests (chart PDFs) or authenticated responses.
  if (request.headers.has('range') || request.headers.has('authorization')) return;

  event.respondWith(
    fetch(request)
      .then(response => {
        if (response && response.ok && response.type === 'basic') {
          const copy = response.clone();
          caches.open(CACHE).then(cache => cache.put(request, copy)).catch(() => {});
        }
        return response;
      })
      .catch(async () => {
        const cached = await caches.match(request);
        if (cached) return cached;
        if (request.mode === 'navigate') {
          /* An installed bag must open the bag, not the Flight Deck. */
          const pathname = new URL(request.url).pathname;
          const wantsEfb = /\/efb\.html$/.test(pathname);
          if (wantsEfb) return (await caches.match('efb.html')) || Response.error();
          // Phone Mode is the Flight Deck itself, so the phone shell is the
          // cached tracker rather than a page of its own.
          if (/\/phone(\.html)?$/.test(pathname)) return (await caches.match('index.html')) || Response.error();
          return (await caches.match('index.html')) || (await caches.match('./')) || Response.error();
        }
        return Response.error();
      })
  );
});
