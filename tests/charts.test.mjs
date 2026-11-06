import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseHTML } from 'linkedom';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');

/** Poll a page state until it settles, so a slow promise is not a flaky test. */
async function until(check, timeoutMs = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('timed out waiting for the page state');
}

const META = `<?xml version="1.0" encoding="utf-8"?>
<digital_tpp cycle="2610" from_edate="0901Z  10/01/26" to_edate="0901Z  10/29/26">
  <state_code ID="CA" state_fullname="CALIFORNIA">
    <city_name ID="SAN FRANCISCO" volume="SW-1">
      <airport_name ID="SAN FRANCISCO INTL" military="N" apt_ident="SFO" icao_ident="KSFO" alnum="1234">
        <record>
          <chart_code>APD</chart_code>
          <chart_name>AIRPORT DIAGRAM</chart_name>
          <pdf_name>00375AD.PDF</pdf_name>
          <amdtdate></amdtdate>
        </record>
        <record>
          <chart_code>IAP</chart_code>
          <chart_name>ILS OR LOC RWY 28L</chart_name>
          <pdf_name>00375IL28L.PDF</pdf_name>
          <amdtdate>12/05/2019</amdtdate>
        </record>
        <record>
          <chart_code>IAP</chart_code>
          <chart_name>RNAV (GPS) Y RWY 19R</chart_name>
          <pdf_name>00375R19R.PDF</pdf_name>
          <amdtdate></amdtdate>
        </record>
        <record>
          <chart_code>DP</chart_code>
          <chart_name>SFO SIX</chart_name>
          <pdf_name>00375SFO6.PDF</pdf_name>
          <amdtdate></amdtdate>
        </record>
        <record>
          <chart_code>STR</chart_code>
          <chart_name>BIG SUR FIVE</chart_name>
          <pdf_name>00375BIG5.PDF</pdf_name>
          <amdtdate></amdtdate>
        </record>
        <record>
          <chart_code>MIN</chart_code>
          <chart_name>TAKEOFF MINIMUMS</chart_name>
          <pdf_name>00375MIN.PDF</pdf_name>
          <amdtdate></amdtdate>
        </record>
        <record>
          <chart_code>HOT</chart_code>
          <chart_name>HOT SPOT 1</chart_name>
          <pdf_name>00375HOT.PDF</pdf_name>
          <amdtdate></amdtdate>
        </record>
      </airport_name>
    </city_name>
  </state_code>
</digital_tpp>`;

test('the FAA cycle code follows the 28-day publication calendar', async () => {
  const { CYCLE_EPOCH, faaCycle, cycleStart, cycleEnd, CYCLE_DAYS } = await import('../app/js/lib/charts.js');
  assert.equal(faaCycle(Date.UTC(2026, 0, 22, 9, 1)), '2601');
  // 2025's cycles start on 23 January; thirteen 28-day cycles reach 25 December.
  assert.equal(faaCycle(Date.UTC(2026, 0, 21, 23, 0)), '2513');
  const second = CYCLE_DAYS * 86400000;
  assert.equal(faaCycle(CYCLE_EPOCH + second), '2602');
  const start = cycleStart('2602');
  assert.equal(faaCycle(start), '2602');
  assert.equal(cycleEnd('2602') - start, second);
  // A code that does not exist in the surrounding year still resolves sanely.
  assert.equal(cycleStart('not-a-cycle'), null);
});

test('the metafile becomes a catalogue with real categories and dates', async () => {
  const {
    normaliseCatalogue, parseFaaAirport, parseMetafileHeader, groupCharts, searchCharts,
    validityState, approachType, runwaysInTitle,
  } = await import('../app/js/lib/charts.js');

  const header = parseMetafileHeader(META);
  assert.equal(header.cycle, '2610');
  assert.equal(new Date(header.from).toISOString(), '2026-10-01T09:01:00.000Z');
  assert.equal(new Date(header.to).toISOString(), '2026-10-29T09:01:00.000Z');

  const airport = parseFaaAirport(META, 'KSFO');
  assert.equal(airport.icao, 'KSFO');
  assert.equal(airport.records.length, 7);

  const charts = normaliseCatalogue({
    source: 'faa-dtpp', sourceName: 'FAA Digital Terminal Procedures',
    cycle: header.cycle, effective: header.from, expires: header.to, checkedAt: Date.UTC(2026, 9, 19),
    charts: airport.records,
  }, 'KSFO');

  assert.equal(charts.length, 7);
  assert.deepEqual(groupCharts(charts).map(group => group.key), ['diagram', 'sid', 'star', 'approach', 'minimums', 'hotspot']);

  const ils = charts.find(chart => chart.pdf === '00375IL28L.PDF');
  assert.equal(ils.category, 'approach');
  assert.equal(ils.approach, 'ILS/LOC');
  assert.deepEqual(ils.runways, ['28L']);
  assert.equal(ils.cycle, '2610');
  assert.equal(ils.format, 'PDF');
  assert.equal(ils.retrieval, 'faa-cycle');
  assert.equal(ils.provider, 'faa-dtpp');
  assert.equal(ils.url, 'https://aeronav.faa.gov/d-tpp/2610/00375IL28L.PDF');
  assert.equal(new Date(ils.amended).toISOString().slice(0, 10), '2019-12-05');
  assert.equal(validityState(ils, Date.UTC(2026, 9, 19)), 'current');
  assert.equal(validityState(ils, Date.UTC(2026, 10, 2)), 'expired');
  assert.equal(validityState({ expires: null }), 'unverified');

  assert.equal(approachType('RNAV (GPS) Y RWY 19R'), 'RNAV');
  assert.deepEqual(runwaysInTitle('ILS OR LOC RWY 28L'), ['28L']);
  assert.deepEqual(searchCharts(charts, '19R').map(chart => chart.pdf), ['00375R19R.PDF']);
  assert.equal(searchCharts(charts, 'SID').length, 1);
  assert.equal(searchCharts(charts, '').length, 7);
  assert.equal(searchCharts(charts, 'EGLL').length, 0);
});

test('approach families are read from the published title', async () => {
  const { approachType } = await import('../app/js/lib/charts.js');
  assert.equal(approachType('ILS OR LOC RWY 28L'), 'ILS/LOC');
  assert.equal(approachType('ILS RWY 28L'), 'ILS');
  assert.equal(approachType('LOC RWY 10'), 'LOC');
  assert.equal(approachType('VOR OR GPS RWY 13L/R'), 'VOR');
  assert.equal(approachType('NDB OR GPS RWY 04'), 'NDB');
});

test('no chart is gated: the paid access rule is gone', async () => {
  const charts = await import('../app/js/lib/charts.js');
  for (const name of ['isFreeChart', 'accessLevel', 'canOpenChart']) {
    assert.equal(name in charts, false, `${name} must be gone: every published chart is free`);
  }
  for (const file of ['app/js/pilot/charts.js', 'app/js/efb/charts.js']) {
    const source = read(file);
    assert.doesNotMatch(source, /entitlement|canOpenChart|isPremium|premiumPanel/i, `${file} must not consult a licence`);
  }
  assert.doesNotMatch(read('app/pilot.css'), /premium-|chart-lock|chart-access|chart-row-lock/, 'the gate styles are gone');
  assert.doesNotMatch(read('app/js/pilot/charts.js'), /Premium/);
});

test('every registered country resolves to its own publisher, never a copy', async () => {
  const {
    officialSourcesFor, isListedRegion, countryForIcao, registryStats, LICENCES, LISTED_PUBLISHERS,
  } = await import('../app/js/lib/chartdir.js');

  const canada = officialSourcesFor('CYYZ');
  assert.equal(canada.length, 1, 'NAV CANADA is the only listed source for Canada');
  assert.equal(canada[0].id, 'navcanada');
  assert.match(canada[0].url, /^https:\/\/www\.navcanada\.ca\//);
  assert.match(canada[0].note, /licensed/i);

  assert.deepEqual(officialSourcesFor('EGLL').map(source => source.id), ['nats-uk', 'ead-basic', 'ais-online']);
  assert.equal(officialSourcesFor('EDDF')[0].id, 'dfs');
  assert.equal(officialSourcesFor('LFPO')[0].id, 'sia');
  assert.equal(officialSourcesFor('LIRF')[0].id, 'enav');
  assert.equal(officialSourcesFor('EBBR')[0].id, 'skeyes', 'a registered national publisher wins over the regional index');
  assert.deepEqual(officialSourcesFor('LYBE').map(source => source.id), ['ead-basic', 'ais-online'], 'a European state with no national entry falls back to EUROCONTROL');
  assert.deepEqual(officialSourcesFor('YSSY').map(source => source.id), ['airservices-au']);

  // Worldwide: every region in the registry resolves to its own authority.
  const WORLDWIDE = [
    ['SBGR', 'decea-br', 'Brazil'], ['SAEZ', 'anac-ar', 'Argentina'], ['SCEL', 'dgac-cl', 'Chile'],
    ['SKBO', 'aerocivil-co', 'Colombia'], ['SPJC', 'corpac-pe', 'Peru'], ['SEQM', 'dgac-ec', 'Ecuador'],
    ['SUAA', 'dinacia-uy', 'Uruguay'], ['SGAS', 'dinac-py', 'Paraguay'], ['SLLP', 'dgac-bo', 'Bolivia'],
    ['SVMI', 'inac-ve', 'Venezuela'], ['MMMX', 'afac-mx', 'Mexico'],
    ['FAOR', 'sacaa-za', 'South Africa'], ['HKJK', 'kcaa-ke', 'Kenya'], ['HECA', 'caa-eg', 'Egypt'],
    ['GMMN', 'onda-ma', 'Morocco'], ['DNMM', 'ncaa-ng', 'Nigeria'], ['DGAA', 'gcaa-gh', 'Ghana'],
    ['HAAB', 'ecaa-et', 'Ethiopia'], ['HTDA', 'tcaa-tz', 'Tanzania'], ['HUEN', 'ucaa-ug', 'Uganda'],
    ['FYWH', 'ncaa-na', 'Namibia'], ['FIMP', 'dca-mu', 'Mauritius'], ['FVHA', 'caaz-zw', 'Zimbabwe'],
    ['RJTT', 'ais-japan', 'Japan'], ['RKSI', 'koca', 'South Korea'], ['ZBAA', 'caac', 'China'],
    ['VHHH', 'cad-hk', 'Hong Kong'], ['RCTP', 'caa-tw', 'Taiwan'], ['WSSS', 'caas-sg', 'Singapore'],
    ['WMKK', 'caam-my', 'Malaysia'], ['VTBS', 'caat-th', 'Thailand'], ['WIII', 'dephub-id', 'Indonesia'],
    ['RPLL', 'caap-ph', 'Philippines'], ['VIDP', 'aai-in', 'India'], ['OPKC', 'caa-pk', 'Pakistan'],
    ['VVTS', 'caav-vn', 'Vietnam'], ['VNKT', 'caan-np', 'Nepal'], ['VCBI', 'caa-lk', 'Sri Lanka'],
    ['VGHS', 'caab-bd', 'Bangladesh'], ['OMDB', 'gcaa-ae', 'United Arab Emirates'], ['OTHH', 'caa-qa', 'Qatar'],
    ['OEJN', 'gaca-sa', 'Saudi Arabia'], ['OOMS', 'caa-om', 'Oman'], ['OBBI', 'mtt-bh', 'Bahrain'],
    ['OKBK', 'dgca-kw', 'Kuwait'], ['OJAI', 'carc-jo', 'Jordan'], ['LLBG', 'iaa-il', 'Israel'],
    ['OLBA', 'dgca-lb', 'Lebanon'], ['NZAA', 'airways-nz', 'New Zealand'], ['NFFN', 'caaf-fj', 'Fiji'],
    ['AYPY', 'casa-pg', 'Papua New Guinea'],
  ];
  for (const [icao, id, country] of WORLDWIDE) {
    assert.equal(officialSourcesFor(icao)[0].id, id, `${icao} resolves to ${country}'s publisher`);
    assert.equal(countryForIcao(icao).name, country, `${icao} belongs to ${country}`);
    assert.equal(isListedRegion(icao), true, `${icao} is link-only, not embedded`);
  }

  assert.deepEqual(officialSourcesFor('ZZZZ'), [], 'an airport with no registered publisher says so');
  assert.equal(isListedRegion('KSFO'), false, 'the FAA is embedded, not link-only');

  // A registry record is a portal, never a document and never a guess.
  for (const entry of LISTED_PUBLISHERS) {
    assert.match(entry.url, /^https:\/\//, `${entry.id} links over https`);
    assert.doesNotMatch(entry.url, /\.pdf$/i, `${entry.id} links to a portal, not a file`);
    assert.ok(LICENCES[entry.licence], `${entry.id} uses a listed licence category`);
    assert.ok(entry.authority && entry.country && entry.name && entry.region, `${entry.id} names its authority, country, publisher and region`);
    assert.ok(Array.isArray(entry.categories) && entry.categories.length, `${entry.id} names the chart types it publishes`);
  }
  const stats = registryStats();
  assert.ok(stats.countries >= 60, `the registry covers ${stats.countries} countries`);
  assert.equal(stats.byLicence.FREE_REUSE, 1, 'exactly one publisher has terms that permit embedding');

  // The resolver holds no document URL: a chart can only come from a catalogue.
  const source = read('app/js/lib/chartdir.js');
  assert.doesNotMatch(source, /aeronav/i);
  assert.doesNotMatch(source, /\.pdf/i);
});

test('providers declare what they publish and only the FAA is integrated', async () => {
  const { CHART_PROVIDERS, availableProviders, chartCoverage, coverageSummary, coverageStatus, isFaaIcao } =
    await import('../app/js/lib/chartproviders.js');

  const us = chartCoverage('KJFK');
  assert.equal(us.integrated, true);
  assert.equal(us.country, 'United States');
  assert.equal(us.provider.id, 'faa-dtpp');
  assert.match(us.provider.licence, /public domain/i);

  for (const [icao, country, publisher] of [
    ['CYYZ', 'Canada', 'navcanada'],
    ['EGLL', 'United Kingdom', 'nats-uk'],
    ['EDDF', 'Germany', 'dfs'],
    ['YSSY', 'Australia', 'airservices-au'],
  ]) {
    const coverage = chartCoverage(icao);
    assert.equal(coverage.integrated, false, `${icao} is not integrated`);
    assert.equal(coverage.country, country);
    assert.equal(coverage.provider.id, publisher);
    assert.ok(coverage.sources.some(source => source.id === publisher));
    assert.match(coverage.message, /redistribution licence/);
  }

  const belgium = chartCoverage('EBBR');
  assert.equal(belgium.integrated, false);
  assert.equal(belgium.country, 'Belgium');
  assert.equal(belgium.provider.id, 'skeyes');
  assert.ok(belgium.sources.some(source => source.id === 'skeyes'));

  // A free-to-view publisher is link-only: the EFB says so and never embeds it.
  const brazil = chartCoverage('SBGR');
  assert.equal(brazil.integrated, false);
  assert.equal(brazil.linkOnly, true);
  assert.equal(brazil.country, 'Brazil');
  assert.equal(brazil.provider.id, 'decea-br');
  assert.equal(brazil.licenceCategory, 'FREE_PUBLIC');
  assert.match(brazil.message, /redistribution licence/);
  assert.equal(coverageStatus(brazil).label, 'Link only');

  // A paid or permisson-gated publisher is a different status again.
  const canada = chartCoverage('CYYZ');
  assert.equal(canada.status, 'restricted');
  assert.equal(canada.licenceCategory, 'PAID');
  assert.equal(coverageStatus(canada).label, 'Publisher only');

  // Nothing registered: an honest gap, with no invented source.
  const unknown = chartCoverage('ZZZZ');
  assert.equal(unknown.integrated, false);
  assert.equal(unknown.status, 'unavailable');
  assert.equal(unknown.provider, null);
  assert.deepEqual(unknown.sources, []);
  assert.equal(coverageStatus(unknown).label, 'No source');
  assert.match(coverageSummary(), /United States/);
  assert.doesNotMatch(coverageSummary(), /worldwide/i);
  assert.equal(isFaaIcao('PHNL'), true);
  assert.equal(isFaaIcao('EGLL'), false);

  assert.deepEqual(availableProviders().map(provider => provider.id), ['faa-dtpp']);
  for (const provider of CHART_PROVIDERS) {
    assert.ok(provider.id && provider.name && provider.status, 'identity and status are declared');
    assert.ok(provider.regions.length, `${provider.id} names its regions`);
    assert.ok(provider.categories.length, `${provider.id} names its categories`);
    assert.match(provider.format, /PDF/);
    assert.ok(provider.update && provider.licence && provider.attribution);
  }
});

test('a local chart is only accepted with a real PDF header', async () => {
  const { isPdfBytes } = await import('../app/js/lib/charts.js');
  const header = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]);
  assert.equal(isPdfBytes(header), true);
  assert.equal(isPdfBytes(header.buffer), true);
  assert.equal(isPdfBytes(new Uint8Array([0x50, 0x4b, 0x03, 0x04])), false, 'a zip is not a PDF');
  assert.equal(isPdfBytes(new ArrayBuffer(0)), false);
});

test('an airport outside FAA coverage points at its publisher instead of inventing charts', async () => {
  installDom();
  const { resetEntitlementCache } = await import('../app/js/lib/entitlement.js');
  resetEntitlementCache();
  globalThis.stratosDesktop = {
    getEntitlement: async () => ({ premium: false, verified: true, mode: 'none', reason: 'No licence service is configured.' }),
  };
  globalThis.fetch = async () => ({
    ok: false, status: 404,
    json: async () => ({ unsupported: true, message: 'No FAA d-TPP charts are published for EGLL.' }),
  });
  const { mount } = await import('../app/js/pilot/charts.js');
  const root = document.getElementById('view');
  const instance = await mount(root, {
    params: new URLSearchParams('icao=EGLL'), directory: [], bridgeBase: 'http://127.0.0.1:8765', health: null,
  });
  await until(() => root.querySelectorAll('.chart-sources a').length === 3);
  const names = [...root.querySelectorAll('.chart-sources a b')].map(node => node.textContent);
  assert.match(names[0], /NATS AIS/);
  assert.match(names[1], /EAD Basic/);
  assert.ok(root.querySelector('#chart-open-file'), 'the viewer offers a local PDF');
  assert.match(root.textContent, /does not hold a redistribution licence/);
  assert.match(root.textContent, /no integrated charts/);
  instance.destroy();
});

test('the bundled viewer carries the helpers the app Chromium lacks', async () => {
  await import('../app/vendor/pdfjs/compat.mjs');
  // Electron 37 runs Chromium 138: no typed-array hex/base64 helpers and no
  // Map upsert, which is exactly what pdf.js 6 calls.
  assert.equal(new Uint8Array([0, 15, 255]).toHex(), '000fff');
  assert.deepEqual([...Uint8Array.fromHex('00ff10')], [0, 255, 16]);
  assert.equal(new Uint8Array([104, 105]).toBase64(), 'aGk=');
  assert.deepEqual([...Uint8Array.fromBase64('aGk=')], [104, 105]);
  assert.throws(() => Uint8Array.fromHex('abc'), 'an odd hex string is refused');

  const map = new Map([['a', 1]]);
  assert.equal(map.getOrInsert('a', 2), 1, 'an existing key keeps its value');
  assert.equal(map.getOrInsert('b', 2), 2);
  assert.equal(map.getOrInsertComputed('c', key => key.length), 1);
  assert.equal(map.getOrInsertComputed('c', () => 99), 1, 'the computed value is stored once');
  const weak = new WeakMap();
  const key = {};
  assert.equal(weak.getOrInsert(key, 'v'), 'v');
  assert.equal(weak.getOrInsertComputed(key, () => 'other'), 'v');

  const page = read('app/js/pilot/charts.js');
  assert.match(page, /import\('\.\.\/\.\.\/vendor\/pdfjs\/compat\.mjs'\)[\s\S]{0,120}pdf\.min\.mjs/, 'the shims load before pdf.js');
  assert.match(page, /workerSrc = new URL\('\.\.\/\.\.\/vendor\/pdfjs\/worker-compat\.mjs'/, 'the worker loads the same shims');
  const worker = read('app/vendor/pdfjs/worker-compat.mjs');
  assert.match(worker, /import '\.\/compat\.mjs';\s*import '\.\/pdf\.worker\.min\.mjs';/);
});

test('a Premium entitlement is only trusted when a trusted channel verifies it', async () => {
  const { describeEntitlement, getEntitlement, isPremium, premiumSetupNotes, resetEntitlementCache } =
    await import('../app/js/lib/entitlement.js');

  const previous = globalThis.stratosDesktop;
  try {
    resetEntitlementCache();
    globalThis.stratosDesktop = { getEntitlement: async () => ({ premium: true, verified: true, mode: 'development' }) };
    const dev = await getEntitlement({ force: true });
    assert.equal(isPremium(dev), true);
    assert.match(describeEntitlement(dev), /not a purchase/i);

    resetEntitlementCache();
    globalThis.stratosDesktop = { getEntitlement: async () => ({ premium: true, verified: false }) };
    assert.equal(isPremium(await getEntitlement({ force: true })), false);

    resetEntitlementCache();
    delete globalThis.stratosDesktop;
    const browser = await getEntitlement({ force: true });
    assert.equal(isPremium(browser), false);
    assert.equal(browser.mode, 'unavailable');

    // A value in browser storage is never consulted; only the desktop channel is.
    globalThis.localStorage = { getItem: () => 'true', setItem() {}, removeItem() {} };
    resetEntitlementCache();
    assert.equal(isPremium(await getEntitlement({ force: true })), false);
    assert.ok(premiumSetupNotes().length >= 2);
  } finally {
    resetEntitlementCache();
    if (previous) globalThis.stratosDesktop = previous;
    else delete globalThis.stratosDesktop;
  }
});

function installDom() {
  const { window } = parseHTML('<!doctype html><html data-theme="night"><head></head><body><main id="view"></main></body></html>');
  globalThis.window = window;
  globalThis.document = window.document;
  Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true });
  Object.defineProperty(globalThis, 'location', {
    value: { protocol: 'http:', hostname: 'localhost', href: 'http://localhost/app/pilot.html', hash: '' },
    configurable: true,
  });
  globalThis.localStorage = {
    store: new Map(),
    getItem(key) { return this.store.get(key) ?? null; },
    setItem(key, value) { this.store.set(key, String(value)); },
    removeItem(key) { this.store.delete(key); },
  };
  globalThis.sessionStorage = {
    store: new Map(),
    getItem(key) { return this.store.get(key) ?? null; },
    setItem(key, value) { this.store.set(key, String(value)); },
    removeItem(key) { this.store.delete(key); },
  };
  globalThis.HTMLElement = window.HTMLElement;
  globalThis.Event = window.Event;
  globalThis.CustomEvent = window.CustomEvent;
  globalThis.fetch = async () => { throw new Error('the charts page must not fetch without an airport'); };
  return window;
}

test('the charts page lands on an empty viewer, not an unprompted upgrade panel', async () => {
  installDom();
  const { mount } = await import('../app/js/pilot/charts.js');
  const root = document.getElementById('view');
  const instance = await mount(root, { params: new URLSearchParams(''), directory: [], bridgeBase: '', health: null });
  assert.match(root.textContent, /Charts/);
  assert.match(root.textContent, /Every published chart opens here/);
  assert.match(root.textContent, /Not for navigation/);
  assert.equal(root.querySelector('.premium-panel'), null, 'no upgrade dialog exists');
  assert.equal(root.querySelector('.chart-page'), null, 'no document is rendered until one is picked');
  instance.destroy();
  assert.equal(root.innerHTML, '');
});

test('every chart opens with no licence, not just ILS and LOC', async () => {
  installDom();

  const { parseFaaAirport } = await import('../app/js/lib/charts.js');
  const records = parseFaaAirport(META, 'KSFO').records;
  const requested = [];
  globalThis.fetch = async url => {
    requested.push(String(url));
    if (String(url).includes('/charts?icao=')) {
      return {
        ok: true, status: 200,
        json: async () => ({
          cycle: '2610', effective: Date.UTC(2026, 9, 1, 9, 1), expires: Date.UTC(2026, 9, 29, 9, 1),
          checkedAt: Date.UTC(2026, 9, 19), source: 'faa-dtpp', sourceName: 'FAA Digital Terminal Procedures',
          license: 'U.S. Government work — public domain', charts: records,
        }),
      };
    }
    if (String(url).includes('/chart?')) {
      return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(4096) };
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  const { mount } = await import('../app/js/pilot/charts.js');
  const root = document.getElementById('view');
  const instance = await mount(root, {
    params: new URLSearchParams('icao=KSFO'), directory: [], bridgeBase: 'http://127.0.0.1:8765', health: null,
  });

  await until(() => root.querySelectorAll('.chart-row').length === 7);
  const rows = [...root.querySelectorAll('.chart-row')];
  const ilsRow = rows.find(row => /ILS OR LOC/.test(row.textContent));
  const rnavRow = rows.find(row => /RNAV/.test(row.textContent));
  assert.equal(root.querySelectorAll('.chart-access').length, 0, 'no row is labelled Free or Premium');
  assert.equal(root.querySelectorAll('.chart-row-lock').length, 0, 'nothing in the catalogue is locked');

  rnavRow.click();
  await until(() => requested.some(url => url.includes('/chart?')));
  assert.match(requested.find(url => url.includes('/chart?')), /00375R19R\.PDF/, 'the RNAV approach opens');
  assert.equal(root.querySelector('.premium-panel'), null, 'no licence prompt is shown');

  ilsRow.click();
  await until(() => requested.filter(url => url.includes('/chart?')).length > 1);
  assert.equal(root.querySelector('.premium-panel'), null, 'the ILS chart opens too');
  instance.destroy();
});

test('the catalogue opens every row and restores the last chart', async () => {
  installDom();

  const { parseFaaAirport } = await import('../app/js/lib/charts.js');
  const records = [
    ...parseFaaAirport(META, 'KSFO').records,
    { code: 'IAP', title: 'LOC RWY 19L', pdf: '00375LOC19L.PDF', amended: null, procedure: null },
  ];
  const requested = [];
  globalThis.fetch = async url => {
    requested.push(String(url));
    if (String(url).includes('/charts?icao=')) {
      return {
        ok: true, status: 200,
        json: async () => ({
          cycle: '2610', effective: Date.UTC(2026, 9, 1, 9, 1), expires: Date.UTC(2026, 9, 29, 9, 1),
          checkedAt: Date.UTC(2026, 9, 19), source: 'faa-dtpp', sourceName: 'FAA Digital Terminal Procedures',
          license: 'U.S. Government work — public domain', charts: records,
        }),
      };
    }
    if (String(url).includes('/chart?')) {
      return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(4096) };
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  const { mount } = await import('../app/js/pilot/charts.js');
  const root = document.getElementById('view');
  const directory = [{ id: 'KSFO', name: 'San Francisco Intl' }];
  const first = await mount(root, {
    params: new URLSearchParams('icao=KSFO'), directory, bridgeBase: 'http://127.0.0.1:8765', health: null,
  });
  await until(() => root.querySelectorAll('.chart-row').length === 8);

  const card = root.querySelector('.chart-airport');
  assert.match(card.textContent, /KSFO/);
  assert.match(card.textContent, /San Francisco Intl/);
  assert.match(card.textContent, /United States/);
  assert.match(card.textContent, /Instrument approaches/);
  assert.match(card.textContent, /8 documents/);
  assert.equal(root.querySelectorAll('.chart-access').length, 0, 'no row is labelled Free or Premium');
  assert.equal(root.querySelectorAll('.chart-row-lock').length, 0, 'nothing is locked');

  const rows = [...root.querySelectorAll('.chart-row')];
  const locRow = rows.find(row => /LOC RWY 19L/.test(row.textContent));
  assert.ok(locRow, 'the LOC row is in the catalogue');
  locRow.click();
  await until(() => requested.some(url => url.includes('00375LOC19L.PDF')));
  assert.equal(root.querySelector('.premium-panel'), null, 'LOC opens without the upgrade dialog');

  const saved = JSON.parse(globalThis.sessionStorage.getItem('stratos.charts.selection'));
  assert.equal(saved.icao, 'KSFO');
  assert.match(saved.chartId, /LOC19L/);
  first.destroy();

  // Returning to the page restores the airport and reopens the last chart.
  const before = requested.filter(url => url.includes('/chart?')).length;
  const second = await mount(root, { params: new URLSearchParams(''), directory, bridgeBase: 'http://127.0.0.1:8765', health: null });
  await until(() => root.querySelectorAll('.chart-row').length === 8);
  await until(() => requested.filter(url => url.includes('/chart?')).length > before);
  assert.match(requested.at(-1), /00375LOC19L.PDF/);
  second.destroy();
});

test('every category opens, with no locks and no licence', async () => {
  installDom();

  const { parseFaaAirport } = await import('../app/js/lib/charts.js');
  const records = parseFaaAirport(META, 'KSFO').records;
  const requested = [];
  globalThis.fetch = async url => {
    requested.push(String(url));
    if (String(url).includes('/charts?icao=')) {
      return {
        ok: true, status: 200,
        json: async () => ({
          cycle: '2610', effective: Date.UTC(2026, 9, 1, 9, 1), expires: Date.UTC(2026, 9, 29, 9, 1),
          checkedAt: Date.UTC(2026, 9, 19), source: 'faa-dtpp', sourceName: 'FAA Digital Terminal Procedures',
          license: 'U.S. Government work — public domain', charts: records,
        }),
      };
    }
    if (String(url).includes('/chart?')) {
      return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(4096) };
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  const { mount } = await import('../app/js/pilot/charts.js');
  const root = document.getElementById('view');
  const instance = await mount(root, {
    params: new URLSearchParams('icao=KSFO'), directory: [], bridgeBase: 'http://127.0.0.1:8765', health: null,
  });
  await until(() => root.querySelectorAll('.chart-row').length === 7);
  assert.equal(root.querySelectorAll('.chart-row-lock').length, 0, 'no row is locked');
  assert.equal(root.querySelectorAll('.chart-access').length, 0, 'no row carries a Free or Premium label');

  // Open the first document in every published category: no licence is
  // involved, so none of them may show a prompt.
  const categories = [...root.querySelectorAll('details.chart-group')].map(group => group.dataset.group);
  assert.deepEqual(categories, ['diagram', 'sid', 'star', 'approach', 'minimums', 'hotspot']);
  for (const category of categories) {
    const before = requested.filter(url => url.includes('/chart?')).length;
    const row = root.querySelector(`details.chart-group[data-group="${category}"] .chart-row`);
    assert.ok(row, `${category} has a row`);
    row.click();
    await until(() => requested.filter(url => url.includes('/chart?')).length > before);
    assert.equal(root.querySelector('.premium-panel'), null, `${category} opens without a prompt`);
  }
  assert.ok(requested.some(url => url.includes('00375AD.PDF')), 'the diagram document was fetched');
  instance.destroy();
});

test('the empty viewer offers every chart and no upgrade prompt', async () => {
  installDom();
  const { mount } = await import('../app/js/pilot/charts.js');
  const root = document.getElementById('view');
  const instance = await mount(root, { params: new URLSearchParams(''), directory: [], bridgeBase: '', health: null });
  assert.match(root.textContent, /Select a chart/);
  assert.match(root.textContent, /Every published chart opens here/);
  assert.doesNotMatch(root.textContent, /Premium|Upgrade/);
  instance.destroy();
});

test('ChartFox redirects and hard-coded chart URLs are gone', () => {
  const deck = read('app/index.html');
  assert.doesNotMatch(deck, /chartfox/i);
  assert.doesNotMatch(deck, /FAA_APD/);
  assert.doesNotMatch(deck, /aeronav\.faa\.gov\/d-tpp\/'\+/);
  assert.match(deck, /function openChartsPage\(icao\)\{location\.href='pilot\.html#charts'/);
  assert.match(deck, /chartLauncherHtml/);

  assert.doesNotMatch(read('app/js/pilot/airports.js'), /chartfox/i);
  assert.doesNotMatch(read('app/js/pilot/briefing.js'), /chartfox/i);
  assert.match(read('app/js/pilot/briefing.js'), /pilot\.html#charts/);
  assert.match(read('app/pilot.html'), /data-section="charts"/);
  assert.match(read('app/js/pilot.js'), /charts: \{ label: 'Charts'/);
  assert.match(read('app/js/pilot/charts.js'), /pilot\.html#charts|loadPdfjs/);
});

test('the chart endpoints are narrow and the entitlement check is in the main process', () => {
  const api = read('api/chart.js');
  assert.match(api, /ALLOWED_FILE = \/\^\[A-Z0-9\]\{1,12\}/);
  assert.ok(api.includes('.PDF$'), 'only .PDF documents are accepted');
  assert.match(api, /aeronav\.faa\.gov\/d-tpp\/\$\{cycle\}\/\$\{file\}/);
  assert.match(api, /Buffer\.from/);
  assert.match(read('api/charts.js'), /parseFaaAirport/);
  assert.match(read('api/charts.js'), /faaCycle/);

  const bridge = read('stratos_bridge.py');
  assert.match(bridge, /if path == "\/charts":/);
  assert.match(bridge, /if path == "\/chart":/);
  assert.match(bridge, /CHART_FILE_RE/);

  const main = read('electron-main.cjs');
  assert.match(main, /ipcMain\.handle\('premium:status'/);
  assert.match(main, /STRATOS_ENTITLEMENT_URL/);
  assert.match(main, /STRATOS_DEV_PREMIUM/);
  assert.match(main, /if \(!app\.isPackaged\) \{[\s\S]{0,240}?mode: 'development'/, 'running from source is a labelled development entitlement');
  assert.match(read('electron-preload.cjs'), /getEntitlement: \(\) => ipcRenderer\.invoke\('premium:status'\)/);
});

test('the vertical profile reuses the route estimate and keeps imported altitudes', async () => {
  const { routeProfile, routeTotals, importPln, exportPln } = await import('../app/js/lib/planner.js');
  const route = [
    { id: 'KSFO', lat: 37.6188, lon: -122.375, elev: 13, kind: 'apt' },
    { id: 'DCT', lat: 39.5, lon: -110, elev: 0, kind: 'fix' },
    { id: 'KJFK', lat: 40.6413, lon: -73.7781, elev: 13, kind: 'apt' },
  ];
  const options = { cruiseKts: 450, cruiseAlt: 35000 };
  const totals = routeTotals(route, options);
  const profile = routeProfile(route, options);

  assert.equal(profile.toc.nm, totals.tocNm);
  assert.equal(profile.tod.nm, totals.todNm);
  assert.ok(profile.tocNm > 0 && profile.tocNm < profile.todNm);
  assert.ok(profile.todNm <= profile.distanceNm);
  assert.equal(profile.points[0].plannedAlt, 13);
  assert.equal(profile.points[2].plannedAlt, 13);
  assert.equal(profile.points[1].plannedAlt, 35000);
  assert.equal(profile.cruiseAlt, 35000);
  assert.equal(profile.estimated, true);
  assert.equal(routeProfile([route[0]]), null);

  const plan = `<?xml version="1.0"?><SimBase.Document><FlightPlan.FlightPlan>
    <ATCWaypoint id="KSFO"><ATCWaypointType>Airport</ATCWaypointType>
      <WorldPosition>N37 37.13,W122 22.50,+000000013.00</WorldPosition></ATCWaypoint>
    <ATCWaypoint id="COAST"><ATCWaypointType>User</ATCWaypointType>
      <Altitude>12000.00</Altitude>
      <WorldPosition>N39 30.00,W110 00.00,+000012000.00</WorldPosition></ATCWaypoint>
    <ATCWaypoint id="KJFK"><ATCWaypointType>Airport</ATCWaypointType>
      <WorldPosition>N40 38.48,W073 46.69,+000000013.00</WorldPosition></ATCWaypoint>
  </FlightPlan.FlightPlan></SimBase.Document>`;
  const imported = importPln(plan);
  assert.equal(imported[1].constraintAlt, 12000);
  assert.equal(imported[0].constraintAlt, null);
  assert.match(exportPln(imported), /<Altitude>12000\.00<\/Altitude>/);

  const constrained = routeProfile(imported, options);
  assert.equal(constrained.points[1].constraintAlt, 12000);
  assert.equal(constrained.points[1].plannedAlt, 35000, 'the estimate is not overwritten by the imported altitude');
});
