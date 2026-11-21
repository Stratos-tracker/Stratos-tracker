import test from 'node:test';
import assert from 'node:assert/strict';
import { groupedSections, metaText, viewerUrl } from '../app/js/efb/chartfoxcharts.js';

/* Shapes as ChartFox's v2 API returned them for EGLL. */
const chart = (type, type_key, name) => ({ id: `${type}-${name}`, airport_icao: 'EGLL', name, code: '2-1', type, type_key, meta: [], view_url: `https://chartfox.org/EGLL#${type}`, has_georeferences: true });

test('grouped charts read in pilot order: ground, SID, STAR, approach, other', () => {
  const data = {
    0: [chart(0, 'Unknown', 'ATC SURVEILLANCE MINIMUM ALTITUDE CHART')],
    6: [chart(6, 'Approach', 'ILS/DME I-AA RWY 09L')],
    3: [chart(3, 'GroundLayout', 'AERODROME CHART')],
    5: [chart(5, 'STAR', 'BIG 1Z')],
    4: [chart(4, 'SID', 'BPK 6J')],
    9: [],
  };
  assert.deepEqual(groupedSections(data).map(s => s.title), ['Airport & ground layout', 'Departures (SID)', 'Arrivals (STAR)', 'Approaches', 'General & other']);
  assert.deepEqual(groupedSections({ 12: [chart(12, 'MinimumAltitude', 'X')] }).map(s => s.title), ['Minimum Altitude'], 'a type ChartFox adds later still shows');
  assert.deepEqual(groupedSections(null), [], 'an airport with no charts has no sections');
});

test('chart metadata reads as short text', () => {
  assert.deepEqual(metaText([{ type: 1, type_key: 'Runway', value: ['09L', '09R'] }, { type: 2, type_key: 'ProcedureName', value: 'BPK 6J' }, null]), ['Runway: 09L, 09R', 'Procedure Name: BPK 6J']);
  assert.deepEqual(metaText(null), []);
});

test('only ChartFox viewer pages open from a chart', () => {
  assert.equal(viewerUrl('https://chartfox.org/EGLL#07f62b19'), 'https://chartfox.org/EGLL#07f62b19');
  assert.equal(viewerUrl('javascript:alert(1)'), '');
  assert.equal(viewerUrl('https://evil.example/chartfox.org/'), '');
});
