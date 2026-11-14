import test from 'node:test';
import assert from 'node:assert/strict';
import { smoothPosition, easeAngle, MAX_PREDICT_S } from '../app/js/lib/ownsmooth.js';
import { distanceNm } from '../app/js/lib/geo.js';

const sample = { lat: 40, lon: -74, gs: 360, trk: 90, hdg: 88 }; // 0.1 NM/s eastbound

test('first fix and large jumps snap to the sample', () => {
  assert.ok(distanceNm(smoothPosition(null, sample, 0, 0.016), sample) < 1e-6);
  const far = smoothPosition({ lat: 0, lon: 0 }, sample, 0, 0.016);
  assert.ok(distanceNm(far, sample) < 1e-6);
});

test('a moving aircraft keeps moving between samples instead of stepping', () => {
  let shown = { lat: 40, lon: -74 };
  const xs = [];
  for (let f = 1; f <= 15; f++) { // 0.25 s at 60 fps, no new sample
    shown = smoothPosition(shown, sample, f / 60, 1 / 60);
    xs.push(shown.lon);
  }
  xs.reduce((prev, x) => { assert.ok(x > prev, 'eastward every frame'); return x; }, -74);
  assert.ok(Math.abs(shown.lat - 40) < 1e-4, 'stays on the eastbound track');
});

test('a new sample is blended in, not snapped to', () => {
  const shown = { lat: 40, lon: -74 };
  const next = { ...sample, lon: -73.995 }; // ~0.23 NM ahead
  const out = smoothPosition(shown, next, 0, 1 / 60);
  assert.ok(out.lon > -74 && out.lon < -73.995);
});

test('a stalled feed stops projecting after MAX_PREDICT_S', () => {
  const at = age => { let s = { lat: 40, lon: -74 }; for (let i = 0; i < 200; i++) s = smoothPosition(s, sample, age, 0.1); return s; };
  assert.deepEqual(at(MAX_PREDICT_S), at(60));
});

test('stationary aircraft is not projected', () => {
  const out = smoothPosition({ lat: 40, lon: -74 }, { ...sample, gs: 0 }, 1.5, 1);
  assert.ok(distanceNm(out, sample) < 1e-4);
});

test('antimeridian and heading wrap take the short way', () => {
  const out = smoothPosition({ lat: 0, lon: 179.999 }, { lat: 0, lon: -179.999, gs: 0 }, 0, 1);
  assert.ok(out.lon > 179.999 || out.lon < -179.99, `crossed the short way: ${out.lon}`);
  const h = easeAngle(350, 10, 1 / 60);
  assert.ok(h > 350 || h < 10, `turned through north: ${h}`);
  assert.equal(easeAngle(undefined, 45, 0.1), 45);
});
