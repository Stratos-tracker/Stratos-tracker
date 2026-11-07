import test from 'node:test';
import assert from 'node:assert/strict';

import {
  altitudeInk, normaliseTrack, pickTrackPoint, projectTrack, trackBounds, verticalTrend,
} from '../app/js/lib/track3d.js';

const track = [
  { lat: 51.0, lon: -0.10, alt: 0, agl: 0, t: 1_700_000_000 },
  { lat: 51.2, lon: 0.10, alt: 12000, agl: 11600, t: 1_700_000_300 },
  { lat: 51.5, lon: 0.40, alt: 35000, agl: 34600, t: 1_700_000_900 },
  { lat: 51.8, lon: 0.60, alt: 8000, agl: 7500, t: 1_700_001_500 },
];

test('normaliseTrack accepts array and object samples and drops invalid points', () => {
  const mixed = normaliseTrack([[51, -0.1, 1000, 10, 900], { lat: 51.1, lon: 0.1, alt: 2000 }, { lat: 'x', lon: 0 }]);
  assert.equal(mixed.length, 2);
  assert.equal(mixed[0].alt, 1000);
  assert.equal(mixed[0].agl, 900);
  assert.equal(mixed[1].agl, null);
});

test('projectTrack keeps every recorded sample and lifts higher altitude up the screen', () => {
  const projected = projectTrack(track, { width: 900, height: 520, yaw: 0.4, pitch: 0.3 });
  assert.equal(projected.points.length, track.length);
  assert.equal(projected.maxAlt, 35000);
  assert.ok(projected.points[2].y < projected.points[0].y, 'the 35,000 ft sample sits above the ground sample');
  assert.ok(projected.exaggeration > 0, 'the vertical share is stated');
  assert.ok(Number.isFinite(projected.exaggeration));
  for (const point of projected.points) {
    assert.ok(Number.isFinite(point.x) && Number.isFinite(point.y));
    assert.ok(point.x >= -40 && point.x <= 940 && point.y >= -40 && point.y <= 560);
  }
});

test('a flat recording projects as a flat line and reports true vertical scale', () => {
  const flat = track.map(point => ({ ...point, alt: 0, agl: 0 }));
  const projected = projectTrack(flat, { width: 800, height: 480, pitch: 0 });
  assert.equal(projected.exaggeration, 0);
  const ys = projected.points.map(point => point.y);
  assert.ok(Math.max(...ys) - Math.min(...ys) < 1.5);
});

test('empty tracks project to an empty view without throwing', () => {
  const projected = projectTrack([], { width: 640, height: 400 });
  assert.deepEqual(projected.points, []);
  assert.equal(projected.toScreen, null);
  assert.equal(trackBounds([]), null);
});

test('pickTrackPoint selects the nearest sample and respects the radius', () => {
  const projected = projectTrack(track, { width: 800, height: 480, yaw: 0, pitch: 0.3 });
  const target = projected.points[1];
  assert.equal(pickTrackPoint(projected.points, target.x + 4, target.y - 3, 16).index, 1);
  assert.equal(pickTrackPoint(projected.points, target.x + 200, target.y, 16), null);
});

test('verticalTrend reads climb, descent and level from the recorded times', () => {
  const climb = verticalTrend(track.map((point, i) => ({ ...point, alt: i * 4000 })), 2);
  assert.equal(climb.label, 'climbing');
  assert.ok(climb.fpm > 0);
  const descend = verticalTrend(track.map((point, i) => ({ ...point, alt: 40000 - i * 4000 })), 2);
  assert.equal(descend.label, 'descending');
  const level = verticalTrend(track.map(point => ({ ...point, alt: 30000 })), 2);
  assert.equal(level.label, 'level');
  assert.equal(verticalTrend([], 4), null);
});

test('altitudeInk stays in the cyan family and brightens with height', () => {
  const low = altitudeInk(0);
  const high = altitudeInk(1);
  assert.notEqual(low, high);
  const parse = value => value.match(/\d+/g).map(Number);
  const [lr, lg, lb] = parse(low);
  const [hr, hg, hb] = parse(high);
  assert.ok(hr > lr && hg > lg && hb > lb, `${low} → ${high}`);
  assert.ok(hb >= hg && hg >= hr, 'the ramp is blue-cyan, not a decorative hue');
});
