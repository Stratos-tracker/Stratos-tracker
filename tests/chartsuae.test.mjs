import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EAIP_SOURCES, eaipForIcao, isUaeChartName, parseUaeCharts, parseUaeEdition, uaeAirportPage, uaeChartUrl,
} from '../app/js/lib/eaip.js';
import { documentUrl } from '../api/chart.js';

const UAE = EAIP_SOURCES['gcaa-uae'];
const NOV16 = Date.UTC(2026, 10, 16);

// The GCAA index, trimmed to the real row markup.
const INDEX = `<tbody><tr class="odd-row"><td align="center" class="date" valign="top"><a href="AIRACs/2026-P13/html/index-en-GB.html">10 DEC 2026</a></td><td>10 DEC 2026</td><td>21 JAN 2027</td><td valign="top">AIRAC AMDT 01/2027</td></tr>
<tr class="odd-row"><td align="center" class="date" valign="top"><a href="AIRACs/2026-P12/html/index-en-GB.html">15 OCT 2026</a></td><td align="center" class="date" valign="top">15 OCT 2026<br>15 OCT 2026</td><td align="center" class="date" valign="top">26 NOV 2026<br><br></td><td valign="top">AIRAC AMDT 12/2026<br>AIC 07/2026</td></tr>
<tr><td align="center" class="date" valign="top"><a href="AIRACs/2026-P10/html/index-en-GB.html">17 SEP 2026</a></td><td>17 SEP 2026</td><td align="center" class="date" valign="top">29 OCT 2026</td><td valign="top">AIRAC AMDT 11/2026</td></tr>`;

const PAGE = `<div class="Figure"><span class="Figure-title">AD CHART - ICAO (Chart OMDB-AD-2-21)</span><div class="graphic-box center"><a target="_blank" id="Chart-OMDB-AD-2-21" href="../../graphics/OMDB-AD-2-21_2026-08.pdf"><img/></a></div></div>
<div class="Figure" id="n1"><span class="Figure-title">STANDARD DEPARTURE CHART - OMNI DIRECTIONAL DEPARTURE (Chart OMDB-AD-2-48)</span><div class="graphic-box AmdtInsertedAIRAC"><a target="_blank" id="Chart-OMDB-AD-2-48" href="../../graphics/OMDB-AD-2-48_2026-12.pdf"><img/></a></div><div class="graphic-box AmdtDeletedAIRAC"><a target="_blank" id="deleted-Chart-OMDB-AD-2-48" href="../../graphics/OMDB-AD-2-48_2025-10.pdf"><img/></a></div></div>
<div class="Figure"><span class="Figure-title">IAC - ICAO RWY 12L ILS CAT A-D</span><div class="graphic-box "><a href="../../graphics/OMDB-AD-2-66_2025-06.pdf"><img/></a></div></div>
<div class="Figure"><span class="Figure-title">VFR CHART - DUBAI CREEK VFR ROUTES (Chart OMDB-AD-2-91.1)</span><div class="graphic-box "><a href="../../graphics/OMDB-AD-2-91.1_2026-08.pdf"><img/></a></div></div>
<div class="Figure"><span class="Figure-title">FOREIGN (Chart OMAA-AD-2-1)</span><div class="graphic-box "><a href="../../graphics/OMAA-AD-2-1_2026-08.pdf"><img/></a></div></div>`;

test('UAE airports resolve to the GCAA AIP', () => {
  assert.equal(eaipForIcao('OMDB'), UAE);
  assert.equal(eaipForIcao('OMAA'), UAE);
});

test('the package in force is the newest dated today or before, never a future one', () => {
  const edition = parseUaeEdition(INDEX, NOV16);
  assert.equal(edition.folder, '2026-P12', 'not the December package');
  assert.equal(edition.cycle, 'AIRAC AMDT 12/2026');
  assert.equal(edition.amdtEffective['2026-P12'], Date.UTC(2026, 10, 26));
  assert.equal(edition.amdtEffective['2026-P10'], Date.UTC(2026, 9, 29));
  assert.equal(edition.expires, Date.UTC(2026, 10, 26), 'valid until the next amendment takes effect');
  assert.equal(parseUaeEdition(INDEX, Date.UTC(2026, 0, 1)), null, 'nothing published yet is no edition');
});

test('only the copy of an amended chart in force today is offered', () => {
  const before = parseUaeCharts(PAGE, { icao: 'OMDB', amdtEffective: Date.UTC(2026, 10, 26), now: NOV16 });
  const after = parseUaeCharts(PAGE, { icao: 'OMDB', amdtEffective: Date.UTC(2026, 10, 26), now: Date.UTC(2026, 10, 27) });
  const omni = list => list.find(chart => chart.code === 'OMDB-AD-2-48').pdf;
  assert.equal(omni(before), 'OMDB-AD-2-48_2025-10.pdf', 'until the amendment, the current edition');
  assert.equal(omni(after), 'OMDB-AD-2-48_2026-12.pdf', 'from its effective date, the new one');
  assert.equal(before.length, 4, 'one entry per figure; the other aerodrome is dropped');
});

test('titles and families come from the GCAA figure titles', () => {
  const charts = parseUaeCharts(PAGE, { icao: 'OMDB', now: NOV16 });
  const byPdf = Object.fromEntries(charts.map(chart => [chart.pdf, chart]));
  assert.equal(byPdf['OMDB-AD-2-21_2026-08.pdf'].title, 'AD CHART - ICAO');
  assert.equal(byPdf['OMDB-AD-2-21_2026-08.pdf'].category, 'diagram');
  assert.equal(byPdf['OMDB-AD-2-66_2025-06.pdf'].category, 'approach');
  assert.equal(byPdf['OMDB-AD-2-91.1_2026-08.pdf'].category, 'vfr');
  assert.equal(byPdf['OMDB-AD-2-48_2025-10.pdf'].category, 'sid');
});

test('the airport page is the one the package menu links, even in an older package', () => {
  const menu = `<a href='../eAIP/../../../2026-P10/html/eAIP/AD-2.OMDB-en-GB.html#x'>OMDB</a>`;
  const page = uaeAirportPage(UAE, '2026-P12', menu.replace('#x', ''), 'OMDB');
  assert.deepEqual(page, { url: `${UAE.base}/AIRACs/2026-P10/html/eAIP/AD-2.OMDB-en-GB.html`, pkg: '2026-P10' });
  assert.equal(uaeAirportPage(UAE, '2026-P12', `<a href='https://evil.example/AD-2.OMDB-en-GB.html'>`, 'OMDB'), null, 'never another host');
});

test('the proxy only rebuilds GCAA chart addresses for the airport named', () => {
  assert.ok(isUaeChartName('OMDB-AD-2-51-Text-1_2023-03.pdf', 'OMDB'));
  assert.equal(isUaeChartName('OMAA-AD-2-1_2026-08.pdf', 'OMDB'), false, 'another airport');
  assert.equal(isUaeChartName('../x/OMDB-AD-2-1_2026-08.pdf', 'OMDB'), false, 'no paths');
  const ok = documentUrl({ source: 'gcaa', icao: 'OMDB', pkg: '2026-P10', pdf: 'OMDB-AD-2-21_2026-08.pdf' });
  assert.equal(ok.url, `${UAE.base}/AIRACs/2026-P10/graphics/OMDB-AD-2-21_2026-08.pdf`);
  assert.match(ok.credit, /CC BY 4\.0/);
  assert.equal(documentUrl({ source: 'gcaa', icao: 'OMDB', pkg: '../..', pdf: 'OMDB-AD-2-21_2026-08.pdf' }), null);
  assert.equal(documentUrl({ source: 'gcaa', icao: 'OMDB', pkg: '2026-P10', pdf: 'OMAA-AD-2-21_2026-08.pdf' }), null);
  assert.equal(uaeChartUrl(UAE, '2026-P10', 'LFPG', 'OMDB-AD-2-21_2026-08.pdf'), null);
});

test('the map overlay asks the proxy for a UAE chart, never the publisher URL', async () => {
  const { chartQuery } = await import('../app/js/lib/plate.js');
  const chart = { source: 'gcaa-uae', edition: '2026-P12', pdf: 'OMDB-AD-2-43_2025-06.pdf', url: `${UAE.base}/AIRACs/2026-P12/graphics/OMDB-AD-2-43_2025-06.pdf` };
  assert.equal(chartQuery('OMDB', { chart }), 'source=gcaa&icao=OMDB&pkg=2026-P12&pdf=OMDB-AD-2-43_2025-06.pdf');
  assert.equal(chartQuery('EGLL', { chart: { url: '/api/chart?source=airmate&icao=EGLL&doc=X' } }), 'source=airmate&icao=EGLL&doc=X',
    'a proxy address is still used as given');
});
