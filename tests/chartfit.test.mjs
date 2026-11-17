import test from 'node:test';
import assert from 'node:assert/strict';
import { applyFit, fitChart, fitSimilarity } from '../app/js/lib/chartfit.js';

// A flat stand-in for the map projection: world = lon, -lat, scaled.
const project = (lat, lon) => [lon * 1000, -lat * 1000];
const refs = new Map([
  ['IMPED', { lat: 25.6, lon: 55.9 }], ['DATOB', { lat: 25.9, lon: 55.2 }],
  ['LORID', { lat: 25.1, lon: 56.1 }], ['ROVIB', { lat: 25.4, lon: 55.5 }],
  ['30L', { lat: 25.24, lon: 55.37 }],
]);
// The sheet is the ground turned 10°, scaled by 3 and shifted: a chart to scale.
const sheet = (lat, lon) => {
  const [x, y] = project(lat, lon), t = 10 * Math.PI / 180;
  return [3 * (x * Math.cos(t) - y * Math.sin(t)) + 500, 3 * (x * Math.sin(t) + y * Math.cos(t)) + 900];
};
const labelsFor = names => names.map(name => { const r = refs.get(name); const [x, y] = sheet(r.lat, r.lon); return { text: name, x, y }; });

test('a similarity is recovered exactly from two pairs', () => {
  const fit = fitSimilarity([{ chart: [0, 0], world: [10, 10] }, { chart: [1, 0], world: [10, 12] }]);
  assert.deepEqual(applyFit(fit, 1, 0).map(Math.round), [10, 12]);
  assert.deepEqual(applyFit(fit, 0, 1).map(Math.round), [8, 10], 'a quarter turn, doubled');
});

test('a chart drawn to scale is placed from the names it prints', () => {
  const fit = fitChart(labelsFor(['IMPED', 'DATOB', 'LORID', 'ROVIB']), refs, project);
  assert.ok(fit, 'placed');
  assert.equal(fit.idents.length, 4);
  assert.equal(fit.medianM, 0);
  const back = applyFit(fit, ...sheet(25.24, 55.37));
  assert.deepEqual(back.map(Math.round), project(25.24, 55.37).map(Math.round), 'any other point lands where it belongs');
});

test('a misplaced label is outvoted, and runway labels count', () => {
  const [rx, ry] = sheet(25.24, 55.37);
  const labels = [...labelsFor(['IMPED', 'DATOB', 'LORID']), { text: 'RWY 30L', x: rx, y: ry }, { text: 'ROVIB', x: 0, y: 0 }];
  const fit = fitChart(labels, refs, project);
  assert.ok(fit.idents.includes('30L'));
  assert.ok(!fit.idents.includes('ROVIB'), 'the stray label does not join the fit');
});

test('a chart not drawn to scale, or with too few names, is not placed', () => {
  assert.equal(fitChart(labelsFor(['IMPED', 'DATOB']), refs, project), null, 'two names prove nothing');
  const schematic = [{ text: 'IMPED', x: 100, y: 100 }, { text: 'DATOB', x: 400, y: 120 }, { text: 'LORID', x: 120, y: 700 }, { text: 'ROVIB', x: 650, y: 650 }];
  assert.equal(fitChart(schematic, refs, project), null, 'positions that no single scale explains');
  assert.equal(fitChart([], refs, project), null);
});
