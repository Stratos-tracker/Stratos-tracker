/* Stratos Flight Deck · phone layout.
 *
 * A phone-only frame around the same map: the map tools as one rail on the left, and a tray above
 * the tab bar with the departure and arrival charts and a Sync-with-flight
 * switch. It reads the map's own state (route, V, A) and drives it through the
 * map's own functions; nothing here keeps a second copy of the plan.
 * Classic script, loaded after the Flight Deck's inline script. */
(function () {
  if (!matchMedia('(max-width: 767px)').matches || !document.getElementById('map')) return;
  const $ = s => document.querySelector(s);
  const esc = v => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const app = document.getElementById('app');
  document.body.classList.add('pd');

  const tray = document.createElement('div');
  tray.id = 'pd-tray';
  tray.innerHTML = `<div class="pd-apts"></div>
    <div class="pd-row"><label class="pd-sync"><span>Sync with flight</span><input type="checkbox" role="switch" aria-label="Sync the map with your flight"><i></i></label>
    <a class="pd-edit" href="efb.html#/flightplan">Edit plan</a></div>`;
  const apts = tray.querySelector('.pd-apts');
  const sync = tray.querySelector('.pd-sync input');
  app.append(tray);

  // The map tools become one rail on the left: search and the map style join them.
  const fab = $('#fab');
  if (fab) {
    const search = document.createElement('button');
    search.className = 'fab'; search.id = 'pdSearch'; search.type = 'button';
    search.title = 'Search flights, airports and navaids'; search.setAttribute('aria-label', 'Search');
    search.innerHTML = '<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6"/><path d="m15 15 5 5"/></svg>';
    const style = document.createElement('button');
    style.className = 'fab pd-style'; style.id = 'pdStyle'; style.type = 'button'; style.title = 'Map style and layers';
    fab.prepend(style, search);
    search.addEventListener('click', () => {
      const open = document.body.classList.toggle('pd-search');
      if (open) setTimeout(() => $('#q')?.focus(), 30);
    });
    style.addEventListener('click', () => $('#bLay')?.click());
  }
  // Going somewhere from the search closes it again.
  // (Go to clears the field once it has moved the map; a miss leaves the text and the panel open.)
  document.addEventListener('click', e => {
    if (!e.target.closest('#res [data-qi], #qGo')) return;
    setTimeout(() => { if ($('#q') && !$('#q').value) document.body.classList.remove('pd-search'); }, 600);
  });

  const go = p => {
    if (!p) return;
    setFol(false); V.lat = p.lat; V.lon = p.lon; V.tz = null; focusZoom(Math.max(V.z, p.k === 'apt' ? 11 : 9.5)); render();
  };
  tray.addEventListener('click', e => {
    const b = e.target.closest('[data-chart]');
    if (b) { const a = A.find(x => x.id === b.dataset.chart); if (a) openCharts(a); return; }
    const g = e.target.closest('[data-go]');
    if (g) go(A.find(x => x.id === g.dataset.go));
  });
  sync.addEventListener('change', () => { setFol(sync.checked); render(); });

  const STYLE = { sat: 'SAT', tr: 'TER', world: 'MAP', vfr: 'VFR', lowifr: 'IFR', highifr: 'HI' };
  let sig = '';
  function paint() {
    // The map writes its imagery credit just above whatever covers the bottom of the screen.
    window.pdInset = Math.round(innerHeight - tray.getBoundingClientRect().top + 12);
    document.body.style.setProperty('--pd-tray', tray.offsetHeight + 'px'); // the Status panel docks above the tray
    const s = JSON.stringify([route.map(p => p.id + (p.ss || '')), L.style, V.fol, CH.on]);
    if (s === sig) return;
    sig = s;
    document.body.classList.toggle('pd-chart', !!CH.on);
    const style = $('#pdStyle'); if (style) style.textContent = STYLE[L.style] || 'MAP';
    sync.checked = !!V.fol;
    const ends = [route[0], route[route.length - 1]].filter(p => p && p.k === 'apt');
    const pair = ends.length === 2 && ends[0].id === ends[1].id ? ends.slice(0, 1) : ends;
    apts.innerHTML = pair.length
      ? pair.map(p => `<div class="pd-apt"><button type="button" class="pd-icao" data-go="${esc(p.id)}">${esc(p.id)}</button><button type="button" class="pd-charts" data-chart="${esc(p.id)}">Charts</button></div>`).join('')
      : '<span class="pd-none">Import or build a plan to pin its airports here</span>';
  }
  // shortcut: polls the map's plan 4x a second instead of hooking every place that edits it; move to an event if the plan code grows one.
  paint();
  setInterval(paint, 250);
})();
