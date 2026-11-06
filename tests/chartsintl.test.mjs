import test from 'node:test';
import assert from 'node:assert/strict';

import {
  eaipForIcao, eaipPdfUrl, isEaipPdfName, parseEaipCharts, parseEaipCycleIndex, parseEaipValidity,
} from '../app/js/lib/eaip.js';
import { chartCoverage, coverageStatus } from '../app/js/lib/chartproviders.js';
import { normaliseCatalogue, pdfName } from '../app/js/lib/charts.js';
import { ACCESS, CHART_SOURCES, accessKeyFor } from '../app/js/data/chart-sources.js';
import { documentUrl, headerText } from '../api/chart.js';

/* Captured from AIP Austria: the chart page for LOWW in cycle 261030. */
const CYCLE_INDEX = '<a href="https://eaip.austrocontrol.at/lo/261030/index.htm">aktuelle Ausgabe</a>'
  + '<a href="https://eaip.austrocontrol.at/lo/261126/index.htm">zukünftige Ausgabe</a>';

const AIRPORT_PAGE = `
  <table>
    <tr><td><a href="Charts/LOWW/LO_AD_2_LOWW_1-1_en.pdf">LOWW AD 2 MAP 1-1</a></td>
      <td>Flugplatzkarte - ICAO <i>Aerodrome Chart - ICAO</i></td></tr>
    <tr><td><a href="Charts/LOWW/LO_AD_2_LOWW_9-1-1_en.pdf">LOWW AD 2 MAP 9-1-1</a></td>
      <td><i>Standard Departure Chart - Instrument (SID) - ICAO (RWY 11)</i></td></tr>
    <tr><td><a href="Charts/LOWW/LO_AD_2_LOWW_11-1_en.pdf">LOWW AD 2 MAP 11-1</a></td>
      <td><i>Standard Arrival Chart - Instrument (STAR) - ICAO</i></td></tr>
    <tr><td><a href="Charts/LOWW/LO_AD_2_LOWW_13-2-1_en.pdf">LOWW AD 2 MAP 13-2-1</a></td>
      <td><i>Instrument Approach Chart - ICAO (RNP RWY 11)</i></td></tr>
    <tr><td><a href="../../../../etc/passwd.pdf">not a chart</a></td><td>Ignore me</td></tr>
  </table>
  <p><b>Effective from:</b> 30 OCT 2026 00:00 UTC &nbsp; <b>Valid till:</b> 26 NOV 2026 00:00 UTC</p>`;

test('the eAIP cycle is read from the publisher, not computed', () => {
  assert.equal(parseEaipCycleIndex(CYCLE_INDEX), '261030');
  assert.equal(parseEaipCycleIndex(''), '');
});

test('an Austrian airport page yields real charts, classified by map series', () => {
  const charts = parseEaipCharts(AIRPORT_PAGE, { icao: 'LOWW', cycle: '261030' });
  assert.equal(charts.length, 4, 'hostile and non-chart links are dropped');
  assert.deepEqual(charts.map(chart => chart.category), ['diagram', 'sid', 'star', 'approach']);
  assert.equal(charts[0].pdf, 'LO_AD_2_LOWW_1-1_en.pdf', 'the published file name keeps its case');
  assert.match(charts[1].title, /Standard Departure Chart - Instrument \(SID\)/);
  assert.equal(charts[0].cycle, '261030');
});

test('validity dates are read through the page markup', () => {
  const validity = parseEaipValidity(AIRPORT_PAGE);
  assert.equal(validity.effective, Date.UTC(2026, 9, 30));
  assert.equal(validity.expires, Date.UTC(2026, 10, 26));
});

test('only a chart name the authority publishes can become a document URL', () => {
  const source = eaipForIcao('LOWW');
  const url = eaipPdfUrl(source, '261030', 'LOWW', 'LO_AD_2_LOWW_1-1_en.pdf');
  assert.equal(url, 'https://eaip.austrocontrol.at/lo/261030/Charts/LOWW/LO_AD_2_LOWW_1-1_en.pdf');
  assert.equal(eaipPdfUrl(source, '261030', 'LOWW', '../../etc/passwd.pdf'), null);
  assert.equal(isEaipPdfName('LO_AD_2_LOWW_1-1_EN.PDF'), true, 'the check is case-insensitive');
  assert.equal(isEaipPdfName('latest.yml'), false);
  assert.equal(eaipForIcao('EDDM'), null, 'Germany is not an eAIP provider');
});

test('a published document name keeps the case its publisher serves', () => {
  const austrian = normaliseCatalogue({
    icao: 'LOWW', cycle: '261030', source: 'austrocontrol-eaip', sourceName: 'AIP Austria',
    charts: [{ code: 'MAP 1-1', title: 'Aerodrome Chart - ICAO', category: 'diagram', pdf: 'LO_AD_2_LOWW_1-1_en.pdf' }],
  }, 'LOWW');
  // The AIP Austria server is case-sensitive: the viewer must ask for exactly
  // the published spelling or the document 404s.
  assert.equal(austrian[0].pdf, 'LO_AD_2_LOWW_1-1_en.pdf');
  assert.equal(pdfName('LO_AD_2_LOWW_1-1_en.pdf', 'austrocontrol-eaip'), 'LO_AD_2_LOWW_1-1_en.pdf');

  const faa = normaliseCatalogue({
    icao: 'KJFK', cycle: '2610',
    charts: [{ code: 'APD', title: 'AIRPORT DIAGRAM', pdf: '00410ad.pdf' }],
  }, 'KJFK');
  assert.equal(faa[0].pdf, '00410AD.PDF', 'the FAA catalogue keeps its upper-case names');
  assert.match(faa[0].url, /^https:\/\/aeronav\.faa\.gov\/d-tpp\/2610\/00410AD\.PDF$/);
});

test('the proxy accepts only an allowlisted publisher request', () => {
  const austrian = documentUrl({ source: 'austrocontrol', icao: 'LOWW', cycle: '261030', pdf: 'LO_AD_2_LOWW_1-1_en.pdf' });
  assert.equal(austrian.url, 'https://eaip.austrocontrol.at/lo/261030/Charts/LOWW/LO_AD_2_LOWW_1-1_en.pdf');
  // A chart cannot be requested through another aerodrome's path.
  assert.equal(documentUrl({ source: 'austrocontrol', icao: 'LOWI', cycle: '261030', pdf: 'LO_AD_2_LOWW_1-1_en.pdf' }), null);
  assert.equal(documentUrl({ source: 'austrocontrol', icao: 'LOWW', cycle: '26', pdf: 'LO_AD_2_LOWW_1-1_en.pdf' }), null);
  const faa = documentUrl({ cycle: '2610', file: '00375AD.PDF' });
  assert.equal(faa.url, 'https://aeronav.faa.gov/d-tpp/2610/00375AD.PDF');
  assert.equal(documentUrl({ cycle: '2610', file: '..%2F..%2Fetc%2Fpasswd' }), null);
  assert.equal(documentUrl({}), null);
});

test('a credit line can travel in an HTTP header', () => {
  // Node rejects any header value outside latin-1 and fails the whole response,
  // so a typographic dash or a copyright sign must never reach the wire as-is.
  for (const credit of [documentUrl({ cycle: '2610', file: '00375AD.PDF' }).credit,
    documentUrl({ source: 'austrocontrol', icao: 'LOWW', cycle: '261030', pdf: 'LO_AD_2_LOWW_1-1_en.pdf' }).credit]) {
    const safe = headerText(credit);
    assert.match(safe, /^[\x20-\x7e]+$/, `${credit} becomes a safe header`);
    assert.doesNotMatch(safe, /[\u0080-\uffff]/);
  }
  assert.equal(headerText('© Austro Control GmbH — AIP Austria, CC BY 4.0'), '(c) Austro Control GmbH - AIP Austria, CC BY 4.0');
});

test('every registered country reports one of the seven access statuses', () => {
  const allowed = new Set(Object.keys(ACCESS));
  for (const entry of CHART_SOURCES) {
    const key = accessKeyFor(entry);
    assert.ok(allowed.has(key), `${entry.id} has a usable access status (${key})`);
  }
  assert.equal(ACCESS.AVAILABLE_IN_APP.label, 'Available in Stratos');
  assert.equal(ACCESS.FREE_PUBLIC_ACCESS.label, 'Free to view');
  assert.equal(ACCESS.FREE_WITH_REGISTRATION.label, 'Account required');
  assert.equal(ACCESS.PERMISSION_REQUIRED.label, 'Permission required');
  assert.equal(ACCESS.PAID.label, 'Paid');
  assert.equal(ACCESS.UNKNOWN.label, 'Terms unverified');
  assert.equal(ACCESS.UNAVAILABLE.label, 'No source');
});

test('coverage separates what Stratos can display from what it may only link', () => {
  const austria = chartCoverage('LOWW');
  assert.equal(austria.integrated, true);
  assert.equal(austria.access, 'AVAILABLE_IN_APP');
  assert.match(austria.provider.name, /AIP Austria/);

  const germany = chartCoverage('EDDM');
  assert.equal(germany.integrated, false);
  assert.equal(germany.access, 'PERMISSION_REQUIRED');
  assert.match(germany.message, /DFS/);
  assert.match(germany.message, /written approval|does not permit/i);
  assert.equal(coverageStatus(germany).label, 'Permission required');

  assert.equal(chartCoverage('CYUL').access, 'PAID', 'NAV CANADA sells its charts');
  assert.equal(chartCoverage('YSSY').access, 'PERMISSION_REQUIRED', 'Airservices allows personal viewing only');
  assert.equal(chartCoverage('EGLL').access, 'FREE_PUBLIC_ACCESS');
  assert.equal(chartCoverage('LFPG').access, 'FREE_PUBLIC_ACCESS');
  assert.equal(chartCoverage('WSSS').access, 'FREE_WITH_REGISTRATION');
  assert.equal(chartCoverage('RJTT').access, 'FREE_PUBLIC_ACCESS');
  assert.equal(chartCoverage('SBGR').access, 'FREE_PUBLIC_ACCESS');
  assert.equal(chartCoverage('FACT').access, 'FREE_PUBLIC_ACCESS');
  assert.equal(chartCoverage('KJFK').integrated, true);
  const unknown = chartCoverage('ZZZZ');
  assert.equal(unknown.access, 'UNAVAILABLE');
  assert.equal(coverageStatus(unknown).label, 'No source');
});
