import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { faaLimit, openAirLimit, fromFaa, fromSim, inFaaCoverage, faaUrl, labelFor, STYLES, ORDER } from '../app/js/lib/airspace.js';

const page = fs.readFileSync(new URL('../app/index.html', import.meta.url), 'utf8');
const square = [[[-118.5, 33.8], [-118.2, 33.8], [-118.2, 34.0], [-118.5, 34.0], [-118.5, 33.8]]];

test('FAA and OpenAir limits read the way a chart writes them', () => {
  assert.equal(faaLimit(0, 'FT', 'SFC'), 'SFC');
  assert.equal(faaLimit(10000, 'FT', 'MSL'), '10000 ft');
  assert.equal(faaLimit('180', 'FL', 'STD'), 'FL180');
  assert.equal(faaLimit(1200, 'FT', 'AGL'), '1200 AGL');
  assert.equal(faaLimit(-9998, 'FT', 'MSL'), 'UNL', 'the FAA marks an unpublished limit -9998');
  assert.deepEqual(labelFor({ cls: 'B', lower: 'SFC', upper: '10000 ft' }), { cls: 'B', limits: 'SFC–10000' });
  assert.deepEqual(labelFor({ cls: 'R', lower: '2000 AGL', upper: 'FL180' }), { cls: 'R', limits: '2000 AGL–FL180' });
  assert.equal(openAirLimit('GND'), 'SFC');
  assert.equal(openAirLimit('FL 65'), 'FL65');
  assert.equal(openAirLimit('2500ft MSL'), '2500 ft');
  assert.equal(openAirLimit('1500 AGL'), '1500 AGL');
  assert.equal(openAirLimit('UNLTD'), 'UNL');
});

test('FAA features become areas of the right class, and blanket airspace is left out', () => {
  const b = fromFaa({ properties: { NAME: 'LOS ANGELES CLASS B', CLASS: 'B', TYPE_CODE: 'CLASS', LOCAL_TYPE: 'CLASS_B', LOWER_VAL: 2000, LOWER_UOM: 'FT', LOWER_CODE: 'MSL', UPPER_VAL: 10000, UPPER_UOM: 'FT', UPPER_CODE: 'MSL' }, geometry: { type: 'Polygon', coordinates: square } });
  assert.deepEqual([b.cls, b.lower, b.upper, b.rings.length, b.source], ['B', '2000 ft', '10000 ft', 1, 'FAA']);
  const moa = fromFaa({ properties: { NAME: 'BUCKHORN MOA', TYPE_CODE: 'MOA', LOWER_VAL: '200', LOWER_UOM: 'FT', LOWER_CODE: 'SFC', UPPER_VAL: '180', UPPER_UOM: 'FL', UPPER_CODE: 'STD', TIMESOFUSE: '0600 - 2200, MON - FRI' }, geometry: { type: 'MultiPolygon', coordinates: [square, square] } });
  assert.deepEqual([moa.cls, moa.upper, moa.rings.length, moa.times], ['MOA', 'FL180', 2, '0600 - 2200, MON - FRI']);
  assert.equal(fromFaa({ properties: { CLASS: 'E', LOCAL_TYPE: 'CLASS_E5' }, geometry: { type: 'Polygon', coordinates: square } }), null, 'E5 covers whole states');
  assert.equal(fromFaa({ properties: { CLASS: 'E', LOCAL_TYPE: 'CLASS_E2' }, geometry: { type: 'Polygon', coordinates: square } }).cls, 'E', 'E surface areas stay');
  assert.equal(fromFaa({ properties: { LOCAL_TYPE: 'MODE C' }, geometry: { type: 'Polygon', coordinates: square } }), null, 'Mode C veils are not airspace classes');
});

test('the simulator\'s OpenAir areas share the shape, with points turned to lon/lat', () => {
  const area = fromSim({ class: 'CTR', name: 'GATWICK CTR', lower: 'SFC', upper: '2500ft MSL', points: [[51.1, -0.3], [51.2, -0.1], [51.1, 0.0]] });
  assert.deepEqual(area.rings[0][0], [-0.3, 51.1]);
  assert.deepEqual([area.cls, area.lower, area.upper, area.source], ['CTR', 'SFC', '2500 ft', 'sim']);
  assert.equal(fromSim({ class: 'A', points: [[1, 1], [2, 2], [3, 1]] }), null, 'OpenAir A is Class A');
  assert.equal(fromSim({ class: 'X', points: [[1, 1], [2, 2], [3, 1]] }), null);
});

test('FAA queries go only where the FAA publishes, and ask for what is drawn', () => {
  assert.ok(inFaaCoverage([33, -119, 35, -117]), 'Los Angeles');
  assert.ok(inFaaCoverage([20, -158, 22, -156]), 'Hawaii');
  assert.ok(!inFaaCoverage([50, -1, 52, 1]), 'London');
  const url = new URL(faaUrl('Class_Airspace', [33, -119, 35, -117]));
  assert.equal(url.searchParams.get('geometry'), '-119,33,-117,35');
  assert.match(url.searchParams.get('where'), /CLASS IN \('B','C','D'\)/);
  assert.equal(url.searchParams.get('f'), 'geojson');
  for (const cls of ORDER) assert.ok(STYLES[cls], cls + ' has a style');
});

test('the map offers an Airspaces layer and draws it under the route', () => {
  assert.ok(page.includes('data-l="asp">Airspaces</button>'), 'a layer chip');
  assert.ok(page.includes('asp:!!L.asp'), 'remembered');
  assert.ok(page.includes('/navdata/airspace?'), 'reads the simulator airspace from the bridge');
  assert.ok(page.includes("window.ASP.faaUrl("), 'and the FAA airspace for the US');
  assert.match(page, /drawFaaCharts\(\);drawAirspaces\(\);drawWeather\(\)/, 'under the weather and the route');
});
