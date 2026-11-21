import test from 'node:test';
import assert from 'node:assert/strict';
import { readLayout, offsetLabel, airportTime, flightProgress, DEFAULT_WIDGETS, fits, firstFit, placeAll, photoSteps } from '../app/js/efb/homewidgets.js';
import { parseOfp } from '../app/js/lib/flightsummary.js';

test('airport clocks label the UTC offset SimBrief publishes', () => {
  assert.equal(offsetLabel(1), '+1');
  assert.equal(offsetLabel(-9), '-9');
  assert.equal(offsetLabel(0), '+0');
  assert.equal(offsetLabel(5.5), '+5:30');
  assert.equal(offsetLabel(null), '', 'an unknown zone has no label, never a guess');
  const noon = Date.UTC(2026, 10, 18, 12, 0);
  assert.equal(airportTime(noon, -9), '03:00');
  assert.equal(airportTime(noon, 5.5), '17:30');
  assert.equal(airportTime(noon, null), '12:00', 'an unknown zone shows UTC');
});

test('the OFP keeps each airport time zone', () => {
  const ofp = parseOfp({
    origin: { icao_code: 'EGLL', timezone: '0' },
    destination: { icao_code: 'LSZH', timezone: '1' },
    general: {}, times: {}, aircraft: {}, fuel: {}, weights: {}, navlog: { fix: [] },
  });
  assert.equal(ofp.origin.timezone, 0);
  assert.equal(ofp.destination.timezone, 1);
});

test('flight progress is clamped to the trip', () => {
  assert.deepEqual(flightProgress(400, 100), { total: 400, left: 100, flown: 300, fraction: 0.75 });
  assert.equal(flightProgress(400, 900).flown, 0, 'farther than the trip means nothing flown yet');
  assert.equal(flightProgress(400, null).fraction, 0, 'no position means no progress');
  assert.equal(flightProgress(0, 10), null);
});

test('the saved home layout drops unknown entries and keeps new apps', () => {
  const apps = ['navigator', 'charts', 'fuel'];
  assert.deepEqual(readLayout(null, apps, ['navigator']), { widgets: DEFAULT_WIDGETS, apps, dock: ['navigator'], pos: { 'w:flight': [0, 0], 'w:dep': [0, 5], 'w:arr': [2, 5] } });
  const saved = JSON.stringify({ widgets: ['arr', 'bogus', 'arr'], apps: ['fuel', 'gone', 'navigator'], dock: ['charts', 'gone'] });
  assert.deepEqual(readLayout(saved, apps, ['navigator']), { widgets: ['arr'], apps: ['fuel', 'navigator', 'charts'], dock: ['charts'], pos: { 'w:flight': [0, 0], 'w:dep': [0, 5], 'w:arr': [2, 5] } });
  assert.deepEqual(readLayout('{not json', apps).widgets, DEFAULT_WIDGETS);
});

test('apps and widgets go anywhere on the grid, gaps included, never overlapping', () => {
  const placed = { 'w:flight': { c: 0, r: 0, w: 3, h: 5 } };
  assert.equal(fits(placed, 3, 0, 1, 1, 8), true, 'beside the widget is free');
  assert.equal(fits(placed, 2, 4, 1, 1, 8), false, 'inside the widget is taken');
  assert.equal(fits(placed, 7, 0, 2, 2, 8), false, 'past the last column is out');
  assert.equal(fits(placed, 6, 9, 2, 2, 8), true, 'far down with gaps above is fine');
  assert.deepEqual(firstFit(placed, 1, 1, 8), { c: 3, r: 0 });
  const out = placeAll(['w:flight', 'navigator', 'charts'], { navigator: [7, 3], charts: [1, 1] }, 8);
  assert.deepEqual(out['w:flight'], { c: 0, r: 0, w: 3, h: 5 });
  assert.deepEqual(out.navigator, { c: 7, r: 3, w: 1, h: 1 }, 'a saved spot with gaps around it is kept');
  assert.deepEqual(out.charts, { c: 3, r: 0, w: 1, h: 1 }, 'a spot inside a widget moves to the first free cell');
  assert.deepEqual(placeAll(['fuel'], { fuel: [9, 0] }, 6).fuel, { c: 0, r: 0, w: 1, h: 1 }, 'a spot past a narrower grid moves');
});

test('saved cells must be whole, positive numbers', () => {
  const raw = JSON.stringify({ pos: { fuel: [2, 3], charts: [-1, 0], notepad: [1.5, 2], weather: 'x' } });
  assert.deepEqual(readLayout(raw, ['fuel']).pos, { fuel: [2, 3] });
});

test('the aircraft photo is searched in the agreed order', () => {
  assert.deepEqual(photoSteps({ title: 'N8312C', sim: 'C-GTLZ', ofp: 'HB-JHK', own: 'HB-JHA' }), [
    { reg: 'N8312C' }, { reg: 'C-GTLZ' }, { reg: 'HB-JHK' }, { find: 'callsign' }, { reg: 'HB-JHA' }, { find: 'similar' },
  ], 'title, livery tail, SimBrief, live callsign, the backup entry, then a similar aircraft');
  assert.deepEqual(photoSteps({}), [{ find: 'callsign' }, { find: 'similar' }], 'with nothing known it still detects');
});
