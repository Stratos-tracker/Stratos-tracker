import test from 'node:test';
import assert from 'node:assert/strict';
import { normaliseAdvisories, advisoriesNear, insidePolygon, sampleRoute } from '../app/js/lib/sigmets.js';
import { distanceNm } from '../app/js/lib/geo.js';

const NOW = Date.UTC(2026, 10, 14, 13, 0) ;
const sec = ms => Math.round(ms / 1000);
const box = (lat1, lon1, lat2, lon2) => [
  { lat: lat1, lon: lon1 }, { lat: lat1, lon: lon2 }, { lat: lat2, lon: lon2 }, { lat: lat2, lon: lon1 }, { lat: lat1, lon: lon1 },
];

// Shapes copied from the live AWC feeds (2026-11-14), trimmed.
const FEEDS = {
  airsigmet: [
    { airSigmetType: 'SIGMET', hazard: 'TURB', seriesId: 'OSCAR 9', validTimeFrom: sec(NOW - 3600e3), validTimeTo: sec(NOW + 3600e3),
      altitudeLow1: 20000, altitudeLow2: null, altitudeHi1: null, altitudeHi2: 30000, coords: box(40, -110, 42, -105), rawAirSigmet: 'SIGMET OSCAR 9' },
    { airSigmetType: 'SIGMET', hazard: 'CONVECTIVE', seriesId: '12C', validTimeFrom: sec(NOW - 7200e3), validTimeTo: sec(NOW - 60e3),
      altitudeHi1: 28000, altitudeHi2: 28000, coords: box(30, -90, 31, -89), rawAirSigmet: 'expired' },
  ],
  isigmet: [
    { hazard: 'VA', qualifier: 'ERUPTION MT SANGAY', firName: 'SEFG GUAYAQUIL', validTimeFrom: sec(NOW), validTimeTo: sec(NOW + 6 * 3600e3),
      base: 0, top: 21000, geom: 'AREA', coords: box(-2.5, -79, -1.5, -78), rawSigmet: 'SEFG SIGMET 3' },
    { hazard: 'TS', qualifier: 'EMBD', firName: 'DGAC ACCRA', validTimeFrom: sec(NOW), validTimeTo: sec(NOW + 3600e3), base: null, top: 40000, geom: 'AREAS',
      coords: [box(10, -3, 11, -2), box(10, -6, 11, -5)], rawSigmet: 'two areas' },
  ],
  gairmet: [
    { hazard: 'ICE', product: 'ZULU', tag: '1C', geom: 'AREA', base: 'FZL', top: '160', validTime: '2026-11-14T15:00:00.000Z', expireTime: sec(NOW + 2 * 3600e3),
      coords: [{ lat: '44.0', lon: '-100.0' }, { lat: '44.0', lon: '-98.0' }, { lat: '46.0', lon: '-98.0' }] },
    { hazard: 'FZLVL', geom: 'LINE', coords: [{ lat: '43.8', lon: '-120.4' }, { lat: '42.9', lon: '-121.2' }], expireTime: sec(NOW + 3600e3) },
    { hazard: 'IFR', geom: 'AREA', base: 'SFC', top: '010', coords: [], expireTime: sec(NOW + 3600e3) },
  ],
};

test('the three feeds normalise to one list; expired, line and shapeless entries are dropped', () => {
  const items = normaliseAdvisories(FEEDS, NOW);
  assert.deepEqual(items.map(item => `${item.kind}:${item.hazard}`), ['SIGMET:TURB', 'SIGMET:VA', 'SIGMET:TS', 'G-AIRMET:ICE']);
  const turb = items[0];
  assert.equal(turb.baseFt, 20000);
  assert.equal(turb.topFt, 30000);
  assert.equal(turb.toMs, NOW + 3600e3);
  assert.equal(items[1].label, 'Volcanic ash · eruption mt sangay');
  assert.equal(items[2].polygons.length, 2, 'a multi-area SIGMET keeps every area');
  assert.equal(items[3].baseFt, null, 'FZL is not a number and is not guessed');
  assert.equal(items[3].topFt, 16000);
  assert.deepEqual(normaliseAdvisories(null, NOW), []);
  assert.deepEqual(normaliseAdvisories({ airsigmet: null, isigmet: 'x' }, NOW), []);
});

test('point in polygon', () => {
  const square = box(0, 0, 10, 10);
  assert.ok(insidePolygon({ lat: 5, lon: 5 }, square));
  assert.ok(!insidePolygon({ lat: 15, lon: 5 }, square));
});

test('a route that crosses an area matches it even with no waypoint inside', () => {
  const items = normaliseAdvisories(FEEDS, NOW);
  // KDEN-ish to KORD-ish: both ends outside the turbulence box, the leg passes through it.
  const route = [{ lat: 41, lon: -112 }, { lat: 41, lon: -100 }];
  const near = advisoriesNear(items, route, 0).map(item => item.hazard);
  assert.ok(near.includes('TURB'));
  assert.ok(!near.includes('VA'));
});

test('the margin catches an area just beside the route, and not one far away', () => {
  const items = normaliseAdvisories(FEEDS, NOW);
  const beside = [{ lat: 39.75, lon: -108 }]; // 15 NM south of the box
  assert.deepEqual(advisoriesNear(items, beside, 25).map(item => item.hazard), ['TURB']);
  assert.deepEqual(advisoriesNear(items, beside, 5), []);
  assert.deepEqual(advisoriesNear(items, [], 25), []);
});

test('the second area of a multi-area SIGMET matches on its own', () => {
  const items = normaliseAdvisories(FEEDS, NOW);
  assert.deepEqual(advisoriesNear(items, [{ lat: 10.5, lon: -5.5 }], 0).map(item => item.hazard), ['TS']);
});

test('route sampling keeps the ends and steps along each leg', () => {
  const samples = sampleRoute([{ lat: 0, lon: 0 }, { lat: 0, lon: 1 }], 10);
  assert.deepEqual(samples[0], { lat: 0, lon: 0 });
  assert.deepEqual(samples.at(-1), { lat: 0, lon: 1 });
  samples.slice(1).forEach((p, i) => assert.ok(distanceNm(samples[i], p) <= 10.0001, 'no gap over 10 NM'));
  assert.ok(samples.length >= 7);
});

test('an area across the antimeridian stays one area and matches on both sides', () => {
  // A Pacific FIR box from 170E to 170W, as the feed sends it (longitudes jump sign).
  const feed = { isigmet: [{ hazard: 'TURB', firName: 'NZZO AUCKLAND OCEANIC', validTimeTo: sec(NOW + 3600e3), geom: 'AREA',
    coords: [{ lat: -30, lon: 170 }, { lat: -30, lon: -170 }, { lat: -20, lon: -170 }, { lat: -20, lon: 170 }, { lat: -30, lon: 170 }] }] };
  const [item] = normaliseAdvisories(feed, NOW);
  const lons = item.polygons[0].map(p => p.lon);
  assert.ok(Math.max(...lons) - Math.min(...lons) <= 20, `ring spans 20 degrees, not 340: ${lons}`);
  assert.equal(advisoriesNear([item], [{ lat: -25, lon: 179 }], 0).length, 1, 'inside, east of the line');
  assert.equal(advisoriesNear([item], [{ lat: -25, lon: -179 }], 0).length, 1, 'inside, west of the line');
  assert.equal(advisoriesNear([item], [{ lat: -25, lon: 0 }], 0).length, 0, 'the far side of the world is outside');
});
