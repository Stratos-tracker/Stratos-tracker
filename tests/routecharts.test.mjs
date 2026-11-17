import test from 'node:test';
import assert from 'node:assert/strict';
import { chartFamily, namesApproach, namesProcedure, pickRouteCharts } from '../app/js/lib/routecharts.js';

// Real titles: FAA d-TPP for KJFK, GCAA AIP for OMDB.
const KJFK = [
  { code: 'MIN', title: 'TAKEOFF MINIMUMS' },
  { code: 'APD', title: 'AIRPORT DIAGRAM' },
  { code: 'DP', title: 'DEEZZ SIX (RNAV)' },
  { code: 'DP', title: 'DEEZZ SIX (RNAV), CONT.1' },
  { code: 'STR', title: 'CAMRN FIVE' },
  { code: 'STR', title: 'PARCH FOUR (RNAV)' },
  { code: 'IAP', title: 'ILS OR LOC RWY 04L' },
  { code: 'IAP', title: 'RNAV (GPS) Z RWY 13L' },
  { code: 'IAP', title: 'RNAV (GPS) Y RWY 13L' },
];
const OMDB = [
  { category: 'diagram', title: 'AD CHART - ICAO' },
  { category: 'diagram', title: 'AIRCRAFT PARKING/DOCKING CHART - ICAO APRONS Alpha' },
  { category: 'star', title: 'STAR CHART - ICAO RWY 12 L/R RNAV1 DATOB 1E, IMPED 3B, IMPED 3E , LORID 1E' },
  { category: 'star', title: 'STAR CHART - ICAO RWY 30 L/R RNAV1 DATOB 4C, DATOB 4D, IMPED 3C, LORID 4C' },
  { category: 'approach', title: 'IAC - ICAO RWY 30L ILS CAT A-D L' },
  { category: 'approach', title: 'IAC - ICAO RNP RWY 30L CAT A-D L' },
];

test('chart families come from the category or the FAA code', () => {
  assert.equal(chartFamily({ code: 'STR' }), 'star');
  assert.equal(chartFamily({ code: 'IAP' }), 'approach');
  assert.equal(chartFamily({ category: 'sid', code: 'X' }), 'sid');
  assert.equal(chartFamily({ code: 'MIN' }), 'other');
});

test('SID and STAR names match across truncated and spelled-out forms', () => {
  assert.ok(namesProcedure('CAMRN FIVE', 'CAMRN5'), 'FAA spells the number');
  assert.ok(namesProcedure('STAR CHART - ICAO RWY 12 L/R RNAV1 DATOB 1E, IMPED 3B, IMPED 3E', 'IMPE3E'), 'simulator data truncates the fix');
  assert.ok(namesProcedure('STAR CHART - ICAO RWY 12 L/R RNAV1 DATOB 1E, IMPED 3B, IMPED 3E', 'IMPED3E'));
  assert.equal(namesProcedure('STAR CHART - ICAO RWY 30 L/R RNAV1 IMPED 3C', 'IMPED3E'), false, 'another variant');
  assert.equal(namesProcedure('CAMRN FIVE', 'CAMRN4'), false, 'another number');
});

test('approach codes match type, runway and variant', () => {
  assert.ok(namesApproach('ILS OR LOC RWY 04L', 'I04L'));
  assert.equal(namesApproach('ILS OR LOC RWY 04L', 'I04R'), false);
  assert.ok(namesApproach('RNAV (GPS) Z RWY 13L', 'R13LZ'));
  assert.equal(namesApproach('RNAV (GPS) Y RWY 13L', 'R13LZ'), false, 'Y is not Z');
  assert.ok(namesApproach('IAC - ICAO RWY 30L ILS CAT A-D L', 'I30L'));
  assert.equal(namesApproach('IAC - ICAO RNP RWY 30L CAT A-D L', 'I30L'), false, 'RNP is not ILS');
});

test('a route picks its own charts at each airport', () => {
  assert.deepEqual(pickRouteCharts(KJFK, { star: 'CAMRN5', approach: 'R13LZ' }), { diagram: 1, sid: null, star: 4, approach: 7 });
  assert.equal(pickRouteCharts(KJFK, { sid: 'DEEZZ6' }).sid, 2, 'the first page, not its continuation');
  assert.deepEqual(pickRouteCharts(OMDB, { star: 'IMPE3E', runway: '30L' }), { diagram: 0, sid: null, star: 2, approach: 4 },
    'no filed approach: the runway ILS');
  assert.equal(pickRouteCharts(OMDB, { star: 'XXXXX1' }).star, null, 'nothing is guessed');
});

test('the desktop app reaches the chart API on the site, and Electron allows it', async () => {
  const fs = await import('node:fs');
  const read = file => fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
  const { siteApi } = await import('../app/js/bridge.js');
  globalThis.location = { protocol: 'file:', hostname: '' };
  try {
    assert.equal(siteApi('/api/charts?icao=OMDB'), 'https://www.stratos-tracker.com/api/charts?icao=OMDB');
  } finally { delete globalThis.location; }
  assert.equal(siteApi('/api/charts?icao=OMDB'), '/api/charts?icao=OMDB', 'served pages stay relative');
  assert.match(read('electron-main.cjs'), /'www\.stratos-tracker\.com'/, 'Electron lets the site answer the file page');
  const plate = read('app/js/lib/plate.js');
  assert.match(plate, /fetch\(siteApi\(`\/api\/charts\?/, 'the map overlay catalogue goes through siteApi');
  assert.match(read('app/index.html'), /mcPlate\.chartDocumentUrl\(/, 'and so do its documents');
  assert.match(read('app/js/efb/common.js'), /candidates\.push\(siteApi\(`\/api\/charts\?/, 'and the Charts app catalogue');
});
