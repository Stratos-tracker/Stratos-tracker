import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  AIRMATE_ATTRIBUTION,
  airmateConfig,
  airmateDocument,
  airmateDocuments,
  airmateForget,
  parseAirmateDocuments,
} from '../api/airmate.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');

const ENV = {
  AIRMATE_AIP_URL: 'https://api.example-aip.test/v1/airport/{icao}/documents',
  AIRMATE_API_KEY: 'test-key',
};

/* The calibration shape the placement engine reads: a plan-view rectangle given
   in sheet pixels and in degrees, top-left origin. */
const GEOREF = {
  is_georeferenced: true,
  width: 1162,
  height: 1782,
  bounding_boxes: {
    planview: {
      pixels: { x1: 4, y1: 6, x2: 1150, y2: 1770 },
      latlng: { lng1: -73.82, lat1: 40.6, lng2: -73.74, lat2: 40.66 },
    },
    insets: [],
  },
};

const REPLY = {
  airport: 'KJFK',
  cycle: '2611',
  effective: '2026-10-29T09:01:00Z',
  expires: '2026-11-26T09:01:00Z',
  license: 'Airmate — licensed use',
  documents: [
    { code: 'APD', title: 'AIRPORT DIAGRAM', kind: 'diagram', pdf: 'https://cdn.example-aip.test/KJFK/APD.pdf', georef: GEOREF },
    { code: 'IAP-13L', title: 'ILS OR LOC RWY 13L', kind: 'approach', pdf: 'https://cdn.example-aip.test/KJFK/IAP13L.pdf' },
    { code: 'SID-1', title: 'KENNEDY ONE DEPARTURE', kind: 'sid', pdf: 'https://cdn.example-aip.test/KJFK/SID1.pdf' },
    // Rejected: no title.
    { code: 'BAD1', pdf: 'https://cdn.example-aip.test/KJFK/BAD1.pdf' },
    // Rejected: plain http, not https.
    { code: 'BAD2', title: 'PLAIN HTTP', pdf: 'http://cdn.example-aip.test/KJFK/BAD2.pdf' },
    // Rejected: duplicate of APD.
    { code: 'APD', title: 'AIRPORT DIAGRAM (copy)', pdf: 'https://cdn.example-aip.test/KJFK/APD2.pdf' },
    // Kept, but with its unreadable calibration dropped rather than half-used.
    { code: 'APD-INSET', title: 'AIRPORT DIAGRAM INSET', pdf: 'https://cdn.example-aip.test/KJFK/APD3.pdf', georef: { is_georeferenced: true, bounding_boxes: {} } },
    // Rejected calibration: a plan view outside the sheet it claims to describe.
    { code: 'APD-OUT', title: 'AIRPORT DIAGRAM OUTSIDE', pdf: 'https://cdn.example-aip.test/KJFK/APD4.pdf', georef: { is_georeferenced: true, width: 100, height: 100, bounding_boxes: { planview: { pixels: { x1: 0, y1: 0, x2: 900, y2: 900 }, latlng: { lng1: -73.8, lat1: 40.6, lng2: -73.7, lat2: 40.7 } } } } },
  ],
};

function fakeFetch(payload, { status = 200 } = {}) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => payload,
    };
  };
  impl.calls = calls;
  return impl;
}

test('airmate: unlicensed, the source simply is not there', async () => {
  airmateForget();
  assert.equal(airmateConfig({}), null, 'no endpoint and key means no source');
  assert.equal(airmateConfig({ AIRMATE_AIP_URL: ENV.AIRMATE_AIP_URL }), null, 'a key is required too');
  assert.equal(airmateConfig({ AIRMATE_API_KEY: 'k' }), null, 'an endpoint is required too');
  assert.equal(
    airmateConfig({ AIRMATE_AIP_URL: 'http://api.example-aip.test/{icao}', AIRMATE_API_KEY: 'k' }),
    null,
    'only an https endpoint is used',
  );
  assert.equal(
    airmateConfig({ AIRMATE_AIP_URL: 'https://api.example-aip.test/documents', AIRMATE_API_KEY: 'k' }),
    null,
    'the address must say where the airport goes',
  );

  const fetchImpl = fakeFetch(REPLY);
  assert.equal(await airmateDocuments('KJFK', { env: {}, fetchImpl }), null);
  assert.equal(fetchImpl.calls.length, 0, 'nothing is requested without a licence');
});

test('airmate: the reply is narrowed to charts the app can actually draw', () => {
  const parsed = parseAirmateDocuments(REPLY, { icao: 'KJFK' });
  assert.ok(parsed, 'a reply in the expected shape is accepted');
  assert.deepEqual(parsed.charts.map(c => c.code), ['APD', 'IAP-13L', 'SID-1', 'APD-INSET', 'APD-OUT']);
  assert.equal(parsed.charts[0].category, 'diagram');
  assert.equal(parsed.charts[1].category, 'approach');
  assert.deepEqual(parsed.charts[0].georef.bounding_boxes.planview.pixels, GEOREF.bounding_boxes.planview.pixels,
    'the calibration reaches the placement engine unchanged');
  assert.equal(parsed.charts[3].georef, null, 'calibration that cannot be read is dropped, not half-used');
  assert.equal(parsed.charts.find(c => c.code === 'APD-OUT').georef, null,
    'a plan view that falls outside the sheet is dropped too');
  assert.equal(parsed.cycle, '2611');
  assert.equal(parsed.licensed, 'Airmate — licensed use');
});

test('airmate: a changed or empty surface is refused, never read as "no charts"', () => {
  assert.equal(parseAirmateDocuments(null), null);
  assert.equal(parseAirmateDocuments({}), null, 'no documents list is not an empty list');
  assert.equal(parseAirmateDocuments({ documents: 'APD' }), null);
  assert.equal(parseAirmateDocuments({ documents: [] }).charts.length, 0);

  const nothingUsable = { documents: [{ code: 'X', pdf: 'not a url' }, { code: '', title: 'NO CODE', pdf: 'https://a.test/x.pdf' }] };
  assert.equal(parseAirmateDocuments(nothingUsable).charts.length, 0);
});

test('airmate: the licence key travels as a bearer token and the airport in the path', async () => {
  airmateForget();
  const fetchImpl = fakeFetch(REPLY);
  const catalogue = await airmateDocuments('KJFK', { env: ENV, fetchImpl });
  assert.ok(catalogue, 'a licensed, reachable source answers');
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(fetchImpl.calls[0].url, 'https://api.example-aip.test/v1/airport/KJFK/documents');
  assert.equal(fetchImpl.calls[0].init.headers.Authorization, 'Bearer test-key');
  assert.equal(catalogue.icao, 'KJFK');
  assert.equal(catalogue.docs.get('APD').title, 'AIRPORT DIAGRAM');

  // A second call inside the cycle is served from the catalogue, not re-fetched.
  await airmateDocuments('KJFK', { env: ENV, fetchImpl });
  assert.equal(fetchImpl.calls.length, 1, 'the catalogue is cached for its cycle');
});

test('airmate: the proxy resolves a document from the signed catalogue only', async () => {
  airmateForget();
  const fetchImpl = fakeFetch(REPLY);
  assert.equal(airmateDocument('KJFK', 'APD', { env: ENV }), null, 'nothing is served before a catalogue exists');

  await airmateDocuments('KJFK', { env: ENV, fetchImpl });
  const doc = airmateDocument('KJFK', 'APD', { env: ENV });
  assert.ok(doc, 'a document of the catalogue is served');
  assert.equal(doc.url, 'https://cdn.example-aip.test/KJFK/APD.pdf');
  assert.equal(doc.credit, 'Airmate — licensed use');

  assert.equal(airmateDocument('KJFK', 'NOPE', { env: ENV }), null, 'an unknown code is not served');
  assert.equal(airmateDocument('KLAX', 'APD', { env: ENV }), null, 'another airport cannot borrow this catalogue');
  assert.equal(airmateDocument('KJFK', 'APD', { env: {} }), null, 'without the licence nothing is served');
});

test('airmate: an unreachable or failing source falls through, it does not fail the page', async () => {
  airmateForget();
  const failing = async () => ({ ok: false, status: 503, json: async () => ({}) });
  assert.equal(await airmateDocuments('KJFK', { env: ENV, fetchImpl: failing }), null);

  airmateForget();
  const throwing = async () => { throw new Error('network down') };
  assert.equal(await airmateDocuments('KJFK', { env: ENV, fetchImpl: throwing }), null);

  airmateForget();
  const junk = fakeFetch({ hello: 'world' });
  assert.equal(await airmateDocuments('KJFK', { env: ENV, fetchImpl: junk }), null, 'an unfamiliar reply is refused');
});

test('airmate: the app asks the proxy by airport and document, never by URL', () => {
  const charts = read('api/charts.js');
  const proxy = read('api/chart.js');
  const lib = read('app/js/lib/plate.js');

  assert.ok(charts.includes("import { airmateDocuments } from './airmate.js'"), 'the catalogue consults Airmate');
  assert.ok(charts.indexOf('airmateDocuments(icao)') < charts.indexOf('const eaip = eaipForIcao(icao)'),
    'a licensed source is consulted before the free authorities');
  assert.ok(charts.includes("url: `/api/chart?source=airmate&icao=${encodeURIComponent(icao)}&doc=${encodeURIComponent(chart.code)}`"),
    'a chart points at the proxy, not at Airmate');
  assert.ok(proxy.includes('return airmateDocument(icao, doc)'), 'the proxy looks the address up itself');
  assert.ok(!/airmate.*url\s*=\s*String\(query/i.test(proxy), 'no address is ever taken from the query string');
  assert.ok(lib.includes("if (chart.url) return String(chart.url).replace("), 'the app follows the address the catalogue gives');
  assert.ok(AIRMATE_ATTRIBUTION.includes('Airmate'), 'the credit names the publisher');
});
