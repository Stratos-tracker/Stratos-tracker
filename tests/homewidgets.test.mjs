import test from 'node:test';
import assert from 'node:assert/strict';
import { readLayout, offsetLabel, airportTime, flightProgress, DEFAULT_WIDGETS } from '../app/js/efb/homewidgets.js';
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
  assert.deepEqual(readLayout(null, apps), { widgets: DEFAULT_WIDGETS, apps });
  const saved = JSON.stringify({ widgets: ['arr', 'bogus', 'arr'], apps: ['fuel', 'gone', 'navigator'] });
  assert.deepEqual(readLayout(saved, apps), { widgets: ['arr'], apps: ['fuel', 'navigator', 'charts'] });
  assert.deepEqual(readLayout('{not json', apps).widgets, DEFAULT_WIDGETS);
});
