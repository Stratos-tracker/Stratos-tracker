// Stratos mobile shell.
//
// A phone-only layer over the existing pages. It owns the fixed bottom
// navigation, turns the map's live flight card into a draggable sheet, keeps
// flight planning reachable without the desktop rail, and offers installation
// on the profile page. It never reads telemetry itself: the map keeps writing
// the card, the sheet only re-frames it, so no value can be invented here.
//
// Everything is scoped to pages that declare `data-mobile-section` on <body>,
// and every visual rule lives in mobile.css behind the phone breakpoint. The
// desktop interface is not touched.

const SECTIONS = [
  { id: 'map', label: 'Map', href: 'index.html' },
  { id: 'flights', label: 'Flights', href: 'logbook.html' },
  { id: 'charts', label: 'Charts', href: 'efb.html#/charts' },
  { id: 'weather', label: 'Weather', href: 'weather.html' },
  { id: 'profile', label: 'Profile', href: 'pilot.html#settings' },
];

const svg = body => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

// One square-line family for the five destinations: map plane, flight list,
// chart sheet, weather cell, pilot silhouette.
const ICON = {
  map: svg('<path d="M3 6.6 9 4l6 2.6L21 4v13.4L15 20l-6-2.6L3 20z"/><path d="M9 4v13.4M15 6.6V20"/>'),
  flights: svg('<path d="M4 6h16M4 12h16M4 18h10"/><path d="M17.5 15.5 20 18l-2.5 2.5" stroke-width="1.6"/>'),
  charts: svg('<rect x="4" y="3.5" width="16" height="17" rx="2.5"/><path d="M4 8.5h16M9 8.5V20.5"/>'),
  weather: svg('<circle cx="8.5" cy="8.5" r="3"/><path d="M6 19h11a3.4 3.4 0 0 0 .3-6.98A5 5 0 0 0 7.4 13A3.6 3.6 0 0 0 6 19z"/>'),
  profile: svg('<circle cx="12" cy="8" r="3.6"/><path d="M4.6 20c0-3.7 3.4-6 7.4-6s7.4 2.3 7.4 6"/>'),
};

const section = document.body.dataset.mobileSection || '';

// The chrome is for phones only. A desktop window keeps every byte of its own
// interface: no nav node, no grip in the flight card, no observers.
const PHONE = (() => {
  try { return matchMedia('(max-width: 767px)').matches; } catch (_) { return false; }
})();

// Chrome and Android fire this once the app is installable. It has to be held
// here: the event cannot be replayed later, and the profile card is the only
// place that offers it.
let installPrompt = null;
window.addEventListener('beforeinstallprompt', event => {
  event.preventDefault();
  installPrompt = event;
});

/**
 * The EFB draws its rail from grouped markup. On a phone it is one strip, so
 * the groups are flattened here as well as in mobile.css: the EFB's own
 * stylesheet has media rules for coarse pointers, and this keeps the strip
 * correct in a narrow desktop window and in mobile emulation too.
 */
function mountEfbStrip() {
  const rail = document.getElementById('efb-nav');
  if (!rail) return;

  // The EFB's grouped rail is a sidebar. On a phone the same destinations are
  // rebuilt as one row: same hrefs, same icons, same labels, taken from the
  // rail itself so the two navigations can never disagree.
  let strip = null;
  let last = '';
  const build = () => {
    const links = [...rail.querySelectorAll('a[data-app], a.en-home')];
    if (!links.length) return;
    if (!strip) {
      strip = document.createElement('nav');
      strip.className = 'm-enav';
      strip.setAttribute('aria-label', 'EFB sections');
      rail.after(strip);
    }
    const current = location.hash || '#/home';
    const html = links.map(link => {
      const glyph = link.querySelector('svg')?.outerHTML || '';
      const label = (link.querySelector('.en-label')?.textContent || link.getAttribute('title') || '').trim();
      const href = link.getAttribute('href') || '';
      const active = href === current ? ' aria-current="page"' : '';
      return `<a href="${href}"${active}>${glyph}<span>${label}</span></a>`;
    }).join('');
    if (html === last) return;
    last = html;
    strip.innerHTML = html;
  };

  rail.style.display = 'none';
  build();
  // The rail is filled from the EFB's route table after this module runs, and
  // rebuilt when the EFB changes modes, so the strip follows it.
  new MutationObserver(build).observe(rail, { childList: true, subtree: true });
  window.addEventListener('hashchange', build);
}

function mountNav() {
  if (!section || document.querySelector('.m-nav')) return;
  const nav = document.createElement('nav');
  nav.className = 'm-nav';
  nav.setAttribute('aria-label', 'Primary sections');
  nav.innerHTML = SECTIONS.map(item => {
    const current = item.id === section;
    return `<a href="${item.href}" data-mnav="${item.id}"${current ? ' aria-current="page"' : ''}>${ICON[item.id]}<span>${item.label}</span></a>`;
  }).join('');
  document.body.appendChild(nav);
  document.body.classList.add('has-mnav');

  // A tab is a section switch, not a research trip: the next page starts
  // loading on touch, and the current one fades out for a beat. Same-page
  // taps scroll to the top instead of reloading the map.
  nav.addEventListener('click', event => {
    const link = event.target.closest('a');
    if (!link || event.metaKey || event.ctrlKey || event.shiftKey || event.button > 0) return;
    const href = link.getAttribute('href') || '';
    if (link.dataset.mnav === section) {
      event.preventDefault();
      window.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }
    event.preventDefault();
    document.body.classList.add('m-leaving');
    setTimeout(() => { location.href = href; }, 90);
  });

  // Warm the other four sections while the phone is idle. The service worker
  // already serves the shell from cache, so this is a small nudge, not a
  // request storm: four documents, once per session.
  const warm = () => {
    for (const item of SECTIONS) {
      if (item.id === section) continue;
      const link = document.createElement('link');
      link.rel = 'prefetch';
      link.href = item.href;
      link.as = 'document';
      document.head.appendChild(link);
    }
  };
  try {
    if (document.visibilityState === 'visible' && 'requestIdleCallback' in window) {
      requestIdleCallback(warm, { timeout: 2500 });
    } else {
      setTimeout(warm, 1500);
    }
  } catch (_) { /* prefetch is a bonus, never a requirement */ }
}

/* ── The map's flight sheet ────────────────────────────────────────────
   The page renders #fc and rewrites it as telemetry changes, so the grip is
   re-inserted whenever the card's children are replaced. Three rests: peek
   (callsign, route, speed, level), half (fields and SID/STAR) and full. */
function mountSheet() {
  const card = document.getElementById('fc');
  if (!card) return;

  const order = ['peek', 'half', 'full'];
  let snap = card.dataset.snap || 'peek';
  const syncFlight = () => {
    const visible = card.style.display !== 'none' && card.innerHTML.trim() !== '';
    document.body.classList.toggle('m-flight', visible);
    if (!visible) card.dataset.snap = snap;
  };

  const apply = next => {
    snap = order.includes(next) ? next : 'peek';
    card.dataset.snap = snap;
    const grip = card.querySelector('.m-grip');
    if (grip) {
      const expanded = snap !== 'peek';
      grip.setAttribute('aria-expanded', expanded ? 'true' : 'false');
      grip.setAttribute('aria-label', expanded ? 'Collapse flight panel' : 'Expand flight panel');
      grip.title = expanded ? 'Collapse flight panel' : 'Expand flight panel';
    }
    syncFlight();
  };

  const step = direction => {
    const at = order.indexOf(snap);
    apply(order[Math.min(order.length - 1, Math.max(0, at + direction))]);
  };

  const bindGrip = grip => {
    grip.addEventListener('click', () => {
      // A drag ends with a click; that click must not also cycle the sheet.
      if (grip.dataset.dragged === '1') { delete grip.dataset.dragged; return; }
      step(snap === 'full' ? -2 : 1);
    });
    let startY = 0;
    let startSnap = snap;
    grip.addEventListener('pointerdown', event => {
      startY = event.clientY;
      startSnap = snap;
      grip.setPointerCapture?.(event.pointerId);
    });
    grip.addEventListener('pointerup', event => {
      const dy = event.clientY - startY;
      if (Math.abs(dy) < 24) return;
      grip.dataset.dragged = '1';
      const at = order.indexOf(startSnap);
      if (dy < 0) apply(order[Math.min(order.length - 1, at + 1)]);
      else apply(order[Math.max(0, at - 1)]);
    });
    grip.addEventListener('pointercancel', () => { grip.dataset.dragged = '1'; });
  };

  const ensureGrip = () => {
    if (card.querySelector('.m-grip')) return;
    const grip = document.createElement('button');
    grip.type = 'button';
    grip.className = 'm-grip';
    grip.innerHTML = '<span></span>';
    card.prepend(grip);
    bindGrip(grip);
    apply(snap);
  };

  ensureGrip();
  apply(snap);
  syncFlight();

  // The page replaces the card's markup whenever the values change. Watch the
  // children only, so scroll position and the sheet's rest survive an update.
  const observer = new MutationObserver(() => { ensureGrip(); syncFlight(); });
  observer.observe(card, { childList: true, attributes: true, attributeFilter: ['style'] });

  // Flight planning lived on the desktop rail. One pill keeps it on a phone
  // without adding a sixth tab or a menu.
  const app = document.getElementById('app');
  const plan = document.getElementById('bRoute');
  if (app && plan && !document.querySelector('.m-plan')) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'm-plan';
    button.innerHTML = `${svg('<path d="M5 18 18 5"/><path d="M9 5h9v9"/>')}<span>Plan</span>`;
    button.title = 'Flight planning';
    button.setAttribute('aria-label', 'Open flight planning');
    button.addEventListener('click', () => plan.click());
    app.appendChild(button);
  }
}

/* ── Installation ──────────────────────────────────────────────────────
   Android and Chrome offer the native prompt; iOS has no programmatic
   install, so the card states the Share path instead of pretending. */
function mountInstall() {
  if (section !== 'profile') return;
  const view = document.getElementById('view');
  const page = document.querySelector('.page');
  if (!view || !page) return;
  let dismissed = false;
  try { dismissed = localStorage.getItem('stratos.installDismissed') === '1'; } catch (_) { /* private mode */ }
  if (dismissed) return;

  const standalone = (() => {
    try {
      return matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
    } catch (_) { return false; }
  })();
  if (standalone) return;

  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
  if (!ios && !installPrompt) return;

  // iOS has no programmatic install: the card is a hint, not a button that
  // would do nothing when tapped.
  const card = document.createElement(ios ? 'div' : 'button');
  if (!ios) card.type = 'button';
  card.className = 'm-install';
  card.innerHTML = `${svg('<rect x="7" y="2.5" width="10" height="19" rx="2.2"/><path d="M11 5.5h2M10.5 18.5h3"/>')}
    <span><b>Install Stratos</b><span>${ios ? 'Tap Share, then Add to Home Screen' : 'Open full screen, offline-ready'}</span></span>`;
  if (!ios) {
    card.addEventListener('click', async () => {
      const prompt = installPrompt;
      if (!prompt) return;
      installPrompt = null;
      try {
        prompt.prompt();
        await prompt.userChoice;
      } catch (_) { /* the browser refused; the row is removed below either way */ }
      row.remove();
    });
  }

  const row = document.createElement('div');
  row.className = 'm-install-row';
  row.appendChild(card);
  const dismiss = document.createElement('button');
  dismiss.type = 'button';
  dismiss.className = 'm-install-x';
  dismiss.setAttribute('aria-label', 'Dismiss install hint');
  dismiss.textContent = '×';
  dismiss.addEventListener('click', () => {
    try { localStorage.setItem('stratos.installDismissed', '1'); } catch (_) { /* private mode */ }
    row.remove();
  });
  row.appendChild(dismiss);
  page.insertBefore(row, view);
}

function boot() {
  if (!section || !PHONE) return;
  mountNav();
  if (section === 'map') mountSheet();
  if (section === 'charts') mountEfbStrip();
  mountInstall();

  // A dark status bar behind a translucent bar, matching the app's own navy.
  const theme = document.querySelector('meta[name="theme-color"]');
  if (theme) theme.setAttribute('content', '#060d14');

  document.body.classList.add('m-enter');
  setTimeout(() => document.body.classList.remove('m-enter'), 260);

  // Leaving the page by any other route gets the same short fade.
  window.addEventListener('pagehide', () => document.body.classList.add('m-leaving'));
}

try {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
} catch (_) { /* the page still works without the mobile chrome */ }
