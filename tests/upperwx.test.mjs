import test from 'node:test';
import assert from 'node:assert/strict';
import {
  gridPoints, openMeteoUrl, parseGrid, ellrod, isolines, jetColor, turbCategory, sample, levelFor, LEVELS,
} from '../app/js/lib/upperwx.js';

const box = { minLat: 40, maxLat: 48, minLon: -70, maxLon: -58 };
const cols = 4;
const rows = 3;

function fake(points, fn) {
  // One Open-Meteo-shaped answer per point.
  return points.map(p => {
    const w = fn(p);
    return { hourly: {
      time: ['2026-11-14T17:00'],
      wind_speed_250hPa: [w.up], wind_direction_250hPa: [270], geopotential_height_250hPa: [10450],
      wind_speed_300hPa: [w.lo], wind_direction_300hPa: [270], geopotential_height_300hPa: [9200],
    } };
  });
}

test('levels map flight levels to pressure and a shear layer below', () => {
  assert.deepEqual(levelFor(340), { fl: 340, hpa: 250, lower: 300 });
  assert.equal(levelFor(999).fl, 340, 'an unknown level falls back to FL340');
  assert.ok(LEVELS.every(l => l.lower > l.hpa));
  const url = openMeteoUrl(gridPoints(box, 2, 2), levelFor(340));
  assert.match(url, /wind_speed_250hPa/);
  assert.match(url, /geopotential_height_300hPa/);
  assert.match(url, /forecast_hours=1/);
});

test('a uniform wind with no shear has no Ellrod turbulence', () => {
  const pts = gridPoints(box, cols, rows);
  const grid = parseGrid(fake(pts, () => ({ up: 120, lo: 120 })), pts, levelFor(340), box, cols, rows);
  assert.ok(grid.ti.every(v => v === 0));
  assert.equal(grid.time, '2026-11-14T17:00');
  assert.equal(Math.round(grid.upper[0].u), 120, 'a westerly blows towards the east');
});

test('vertical shear across a sheared jet gives a positive index that grows with the shear', () => {
  const pts = gridPoints(box, cols, rows);
  // Speed rises northward (horizontal shear) and with height (vertical shear).
  const weak = parseGrid(fake(pts, p => ({ up: 80 + (p.lat - 40) * 8, lo: 70 + (p.lat - 40) * 6 })), pts, levelFor(340), box, cols, rows);
  const strong = parseGrid(fake(pts, p => ({ up: 80 + (p.lat - 40) * 16, lo: 50 + (p.lat - 40) * 6 })), pts, levelFor(340), box, cols, rows);
  const mean = a => a.reduce((s, v) => s + v, 0) / a.length;
  assert.ok(mean(weak.ti) > 0);
  assert.ok(mean(strong.ti) > mean(weak.ti) * 2);
  assert.equal(turbCategory(3), null);
  assert.equal(turbCategory(9).label, 'Moderate');
  assert.equal(turbCategory(20).label, 'Severe');
});

test('an answer for the wrong number of points is refused', () => {
  const pts = gridPoints(box, cols, rows);
  assert.throws(() => parseGrid([], pts, levelFor(340), box, cols, rows));
});

test('isotachs follow the crossing and the jet ramp starts at 50 kt', () => {
  // 2x2 cells, values rising left to right: the 100 kt line is vertical in the middle.
  const values = [80, 100, 120, 80, 100, 120, 80, 100, 120];
  const segs = isolines(values, 3, 3, 90);
  assert.equal(segs.length, 2);
  assert.ok(segs.every(s => Math.abs(s[0] - 0.5) < 1e-9 && Math.abs(s[2] - 0.5) < 1e-9));
  assert.equal(jetColor(30), null);
  assert.ok(jetColor(45)[3] < jetColor(60)[3]);
  assert.deepEqual(jetColor(110).slice(0, 3), [249, 115, 22]);
  assert.equal(Math.round(sample({ box: { minLat: 0, maxLat: 1, minLon: 0, maxLon: 1 }, cols: 2, rows: 2 }, [0, 10, 20, 30], 0.5, 0.5)), 15);
});
