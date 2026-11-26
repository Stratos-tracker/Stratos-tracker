import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseIvaoPilots } from '../app/js/lib/vatsim.js';
import { compactMetar, parseBbox } from '../api/weather.js';

const page = fs.readFileSync(new URL('../app/index.html', import.meta.url), 'utf8');

test('IVAO pilots arrive in the same shape as VATSIM pilots', () => {
  // The real whazzup v2 record shape (trimmed).
  const feed = { clients: { pilots: [
    { callsign: 'uae449', lastTrack: { latitude: 24.36, longitude: 56.74, altitude: 32009, groundSpeed: 478, heading: 305 },
      flightPlan: { aircraftId: 'A388', departureId: 'NZAA', arrivalId: 'OMDB', level: 'F320', route: 'UPLAR A464 RIGMI' } },
    { callsign: 'NOTRACK' },
    { callsign: 'BAD', lastTrack: { latitude: 99, longitude: 0 } },
  ] } };
  const [p, ...rest] = parseIvaoPilots(feed);
  assert.equal(rest.length, 0, 'records without a usable position are dropped');
  assert.deepEqual(p, { id: 'UAE449', source: 'ivao', lat: 24.36, lon: 56.74, alt: 32009, gs: 478, hdg: 305,
    aircraft: 'A388', dep: 'NZAA', arr: 'OMDB', cruiseFt: 32000, route: 'UPLAR A464 RIGMI' });
  assert.deepEqual(parseIvaoPilots(null), []);
});

test('the area METAR query validates its box and reduces each station', () => {
  assert.deepEqual(parseBbox('24,54,26,56'), [24, 54, 26, 56]);
  assert.equal(parseBbox('24,54,60,56'), null, 'more than 30 degrees a side');
  assert.equal(parseBbox('26,54,24,56'), null, 'min above max');
  assert.equal(parseBbox('a,b,c,d'), null);
  const station = compactMetar({ icaoId: 'EGLL', lat: 51.48, lon: -0.45, fltCat: 'MVFR', wdir: 240, wspd: 12, wgst: 22,
    visib: '6+', clouds: [{ cover: 'FEW', base: 1200 }, { cover: 'BKN', base: 2400 }, { cover: 'OVC', base: 3800 }], temp: 9, dewp: 6, rawOb: 'METAR EGLL' });
  assert.equal(station.cat, 'MVFR');
  assert.equal(station.ceiling, 2400, 'the lowest broken or overcast layer');
  assert.equal(compactMetar({ icaoId: 'X', clouds: [{ cover: 'SCT', base: 900 }] }).ceiling, null, 'scattered is no ceiling');
});

test('the map offers the new layers and keeps their state', () => {
  for (const [key, label] of [['wxapt', 'Airport weather'], ['faavfr', 'FAA Sectional'], ['faatac', 'FAA Terminal'], ['faalo', 'FAA IFR Low'], ['faahi', 'FAA IFR High']]) {
    assert.ok(page.includes(`data-l="${key}">${label}</button>`), `${label} is a layer chip`);
    assert.ok(page.includes(`${key}:!!L.${key}`), `${label} is remembered`);
  }
  assert.match(page, /drawFaaCharts\(\);drawAirspaces\(\);drawWeather\(\);drawDayNight\(\);drawAirportWx\(\);/, 'FAA charts and airspaces under the weather, stations on top');
  assert.match(page, /<option value="ivao">IVAO/, 'IVAO is a traffic source');
  assert.match(page, /window\.VATSIM\.parseIvaoPilots\(feed\)/);
  assert.ok(page.includes('FAA Aeronautical Information Services (public domain)'), 'the charts are credited');
});

test('live chart tracking: the next fix on a route chart offers "Continue track on {chart}?"', async () => {
  const fs = await import('node:fs');
  const page = fs.readFileSync(new URL('../app/index.html', import.meta.url), 'utf8');
  assert.match(page, /<div id="ctAsk" role="dialog"/, 'the prompt has a place on the map');
  assert.match(page, /Continue track on '\+esc\(item\.title\)\+'\?/, 'it names the chart');
  assert.match(page, /data-ct="yes">Yes<\/button><button type="button" data-ct="no">No/, 'it asks yes or no');
  assert.match(page, /if\(ok\)\{telHideEmpty\(\);ctTick\(\)\}/, 'it is checked only while your own aircraft is live');
  assert.match(page, /if\(hit\.names\.has\(fix\)\)\{ctAsk/, 'a fix printed anywhere on the chart counts, scaled or not');
  assert.match(page, /location\.href='efb\.html#\/charts\?icao='\+encodeURIComponent\(item\.icao\)\+'&chart='/, 'yes opens that chart in Charts');
  const charts = fs.readFileSync(new URL('../app/js/efb/charts.js', import.meta.url), 'utf8');
  assert.match(charts, /ctx\.params\.get\('chart'\)/, 'Charts opens the chart a link names');
});

test('the aircraft is placed on a chart from the fixes it prints, even when not to scale', async () => {
  const { placeOnChart } = await import('../app/js/lib/chartfit.js');
  const refs = new Map([['AAAAA', { lat: 47, lon: -122 }], ['BBBBB', { lat: 47.5, lon: -122 }], ['CCCCC', { lat: 47, lon: -121.5 }], ['DDDDD', { lat: 47.5, lon: -121.5 }]]);
  const labels = [...refs].map(([text, r]) => ({ text, x: (r.lon + 123) * 100, y: (48 - r.lat) * 100 }));
  const on = placeOnChart(labels, refs, 47.001, -122.001);
  assert.equal(on.on, 'AAAAA', 'over a fix, the aircraft sits on that fix');
  assert.deepEqual([on.x, on.y], [100, 100]);
  const mid = placeOnChart(labels, refs, 47.25, -121.75);
  assert.ok(Math.abs(mid.x - 125) < 1 && Math.abs(mid.y - 75) < 1, 'between fixes it is interpolated');
  assert.ok(Math.abs(mid.rot) < .01, 'north up on a north-up chart');
  assert.equal(placeOnChart(labels, refs, 10, 10), null, 'far from every printed fix, it is not shown');
});
