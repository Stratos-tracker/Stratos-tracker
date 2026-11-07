import test from 'node:test';
import assert from 'node:assert/strict';

import {
  airportOrigin, buildTaxiGraph, geometryBounds, localise, normaliseWays,
  runwayEnds, runwayTarget, shortestPath, taxiRoute,
} from '../app/js/lib/groundchart.js';

const AIRFIELD = [
  ['taxiway', 'A', [[51.0000, 0.0000], [51.0010, 0.0000], [51.0010, 0.0020]]],
  ['taxiway', 'B', [[51.0010, 0.0020], [51.0020, 0.0020]]],
  ['runway', '09/27', [[51.0020, 0.0020], [51.0020, 0.0200]]],
  ['apron', '', [[51.0000, 0.0000], [51.0005, 0.0000], [51.0005, 0.0005], [51.0000, 0.0005]]],
  ['terminal', '', [[51.0006, 0.0001], [51.0009, 0.0001], [51.0009, 0.0004], [51.0006, 0.0004]]],
];

test('normaliseWays keeps real ways and discards malformed ones', () => {
  const ways = normaliseWays([...AIRFIELD, ['taxiway', 'C', []], ['', '', null], null]);
  assert.equal(ways.length, 5);
  assert.equal(ways[0].type, 'taxiway');
  assert.equal(ways[0].ref, 'A');
  assert.equal(ways[2].points.length, 2);
});

test('localise produces metres around the geometry origin, and bounds cover it', () => {
  const origin = airportOrigin(AIRFIELD);
  const local = localise(AIRFIELD, origin);
  const runway = local.find(way => way.type === 'runway');
  const length = Math.hypot(
    runway.points[1].x - runway.points[0].x,
    runway.points[1].y - runway.points[0].y,
  );
  // 0.018° of longitude at 51°N is about 1,260 m.
  assert.ok(length > 1200 && length < 1320, `runway length ${length}`);
  const bounds = geometryBounds(local);
  assert.ok(bounds.width > 0 && bounds.height > 0);
});

test('the taxi graph joins ways that meet at a shared vertex', () => {
  const graph = buildTaxiGraph(localise(AIRFIELD, airportOrigin(AIRFIELD)));
  assert.ok(graph.nodes.length >= 4);
  assert.ok(graph.edges.length >= 3);
  const names = graph.edges.map(edge => edge.ref);
  assert.ok(names.includes('A'));
  assert.ok(names.includes('B'));
});

test('shortest path follows the charted centre lines and keeps their refs in order', () => {
  const graph = buildTaxiGraph(localise(AIRFIELD, airportOrigin(AIRFIELD)));
  const start = graph.nodes.find(node => Math.abs(node.lat - 51.0) < 1e-6 && Math.abs(node.lon - 0.0) < 1e-6);
  const end = graph.nodes.find(node => Math.abs(node.lat - 51.002) < 1e-6 && Math.abs(node.lon - 0.002) < 1e-6);
  assert.ok(start && end);
  const path = shortestPath(graph, start.id, end.id);
  assert.ok(path);
  assert.deepEqual(path.refs, ['A', 'B']);
  assert.ok(path.lengthM > 200);
  assert.equal(path.nodes[0].id, start.id);
  assert.equal(path.nodes[path.nodes.length - 1].id, end.id);
});

test('taxiRoute derives a route from a live position to the runway threshold', () => {
  const route = taxiRoute(AIRFIELD, { lat: 51.0, lon: 0.0 }, { lat: 51.002, lon: 0.002 });
  assert.ok(route);
  assert.deepEqual(route.refs, ['A', 'B']);
  assert.equal(route.path.length, route.nodes.length);
});

const APRON_FIELD = [
  ['runway', '09/27', [[51.0020, 0.0000], [51.0020, 0.0180]]],
  ['taxiway', 'A', [[51.0006, 0.0006], [51.0006, 0.0154]]],
  ['taxiway', 'A1', [[51.0006, 0.0020], [51.0020, 0.0020]]],
  ['taxiway', 'A3', [[51.0006, 0.0140], [51.0020, 0.0140]]],
  ['taxiway', 'B', [[51.0034, 0.0010], [51.0034, 0.0160]]],
  ['taxiway', 'B2', [[51.0020, 0.0120], [51.0034, 0.0120]]],
];

test('a connector that meets a centre line mid-way becomes a graph junction', () => {
  const graph = buildTaxiGraph(localise(APRON_FIELD, airportOrigin(APRON_FIELD)));
  const junction = graph.nodes.find(node => Math.abs(node.lat - 51.0006) < 1e-4 && Math.abs(node.lon - 0.002) < 1e-4);
  assert.ok(junction, 'the A1 foot is a node');
  assert.ok(junction.edges.length >= 3, `junction edges ${junction.edges.length}`);
});

test('a runway route ends at a connector on the runway, not a closer parallel taxiway', () => {
  const target = { lat: 51.002, lon: 0.018 };
  const route = taxiRoute(APRON_FIELD, { lat: 51.0006, lon: 0.0018 }, target, { preferRunway: true });
  assert.ok(route);
  const last = route.path[route.path.length - 1];
  assert.ok(Math.abs(last.lat - 51.002) < 1e-4, `ends at ${last.lat}`);
  assert.deepEqual(route.refs, ['A', 'A3']);
});

test('taxiRoute refuses to bridge a gap the chart does not join', () => {
  const route = taxiRoute(AIRFIELD, { lat: 51.0, lon: 0.0 }, { lat: 51.02, lon: 0.03 });
  assert.equal(route, null);
});

test('runwayTarget matches the end a designator names', () => {
  const ends = runwayEnds(AIRFIELD);
  assert.equal(ends.length, 2);
  const east = runwayTarget(AIRFIELD, { lat: 51.001, lon: 0.001 }, '27');
  assert.ok(east);
  assert.ok(Math.abs(east.lon - 0.02) < 1e-6, `picked ${east.lon}`);
  assert.equal(east.matched, true);
  const west = runwayTarget(AIRFIELD, { lat: 51.001, lon: 0.001 }, '09');
  assert.ok(Math.abs(west.lon - 0.002) < 1e-6, `picked ${west.lon}`);
  assert.equal(west.matched, true);
});

test('with no designator the nearest runway end is reported as unmatched', () => {
  const target = runwayTarget(AIRFIELD, { lat: 51.002, lon: 0.004 });
  assert.ok(target);
  assert.equal(target.matched, false);
  assert.ok(target.distance >= 0);
});
