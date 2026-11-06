import test from 'node:test';
import assert from 'node:assert/strict';

import {
  KINDS, airportCode, endpointsFor, runwayIds, runwayThreshold, procedureList,
  transitionList, pathFor, pathNote, describe, kindNote, planSelection, procedureLabels,
  approachTitle,
} from '../app/js/lib/procdeck.js';
import handler from '../api/procedures.js';

const payload = {
  ok: true,
  airport: 'KATL',
  source: 'FAA CIFP (FAACIFP18, United States)',
  cycle: '2611',
  runways: {
    '08R': { lat: 33.646801, lon: -84.4384 },
    '26L': { lat: 33.646801, lon: -84.405502 },
    '10': { lat: 33.6203, lon: -84.447899 },
  },
  procedures: {
    sid: [{
      id: 'BANNG3',
      transitions: [
        { id: 'RW08B', runway: '08', combined: true, complete: true, skipped: 0, points: [
          { id: 'SKNNR', lat: 33.634564, lon: -84.342553, terminator: 'DF' },
          { id: 'GRITZ', lat: 33.602144, lon: -84.276336, terminator: 'TF' },
          { id: 'BANNG', lat: 32.961247, lon: -84.421383, terminator: 'TF' },
        ] },
        { id: 'RW10', runway: '10', combined: false, complete: true, skipped: 0, points: [
          { id: 'GRITZ', lat: 33.602144, lon: -84.276336, terminator: 'CF' },
          { id: 'BANNG', lat: 32.961247, lon: -84.421383, terminator: 'TF' },
        ] },
        { id: 'LUCKK', runway: '', combined: false, complete: true, skipped: 0, points: [
          { id: 'BANNG', lat: 32.961247, lon: -84.421383, terminator: 'IF' },
          { id: 'LUCKK', lat: 32.300347, lon: -84.408139, terminator: 'TF' },
        ] },
        { id: 'DBN', runway: '', combined: false, complete: false, skipped: 2, points: [
          { id: 'OTTOF', lat: 32.5, lon: -83.1, terminator: 'TF' },
        ] },
      ],
    }],
    star: [{
      id: 'GNDLF2',
      transitions: [
        { id: 'BANNG', runway: '', combined: false, complete: true, skipped: 0, points: [
          { id: 'BANNG', lat: 32.961247, lon: -84.421383, terminator: 'IF' },
          { id: 'HONIE', lat: 33.3, lon: -84.5, terminator: 'TF' },
        ] },
        { id: 'RW26L', runway: '26L', combined: false, complete: true, skipped: 0, points: [
          { id: 'HONIE', lat: 33.3, lon: -84.5, terminator: 'TF' },
          { id: 'KATL', lat: 33.6367, lon: -84.4281, terminator: 'TF' },
        ] },
        { id: 'FST', runway: '', combined: false, complete: true, skipped: 0, points: [
          { id: 'FST', lat: 30.9, lon: -85.0, terminator: 'IF' },
          { id: 'HONIE', lat: 33.3, lon: -84.5, terminator: 'TF' },
        ] },
      ],
    }],
  },
};

const approachPayload = {
  ...payload,
  procedures: {
    ...payload.procedures,
    approach: [{
      id: 'I26L',
      transitions: [
        { id: '', runway: '26L', combined: false, complete: true, skipped: 0, points: [
          { id: 'HONIE', lat: 33.3, lon: -84.5, terminator: 'IF' },
          { id: 'RW26L', lat: 33.646801, lon: -84.405502, terminator: 'TF' },
          { id: 'MISS1', lat: 33.7, lon: -84.3, terminator: 'TF' },
          { id: 'MISS2', lat: 33.8, lon: -84.2, terminator: 'HM' },
        ] },
        { id: 'BANNG', runway: '', combined: false, complete: true, skipped: 0, points: [
          { id: 'BANNG', lat: 32.961247, lon: -84.421383, terminator: 'IF' },
          { id: 'HONIE', lat: 33.3, lon: -84.5, terminator: 'TF' },
        ] },
      ],
    }, {
      id: 'H26LZ',
      transitions: [
        { id: '', runway: '26L', combined: false, complete: true, skipped: 0, points: [
          { id: 'RW26L', lat: 33.646801, lon: -84.405502, terminator: 'TF' },
        ] },
      ],
    }],
  },
};

test('procdeck: an airport is four characters and asks both sources', () => {
  assert.equal(airportCode('katl'), 'KATL');
  assert.equal(airportCode('K'), '');
  const endpoints = endpointsFor('katl', 'sid', 'banng3');
  assert.deepEqual(endpoints, [
    '/procedures.json?airport=KATL&kind=sid&id=BANNG3',
    '/api/procedures?airport=KATL&kind=sid&id=BANNG3',
  ]);
  assert.deepEqual(endpointsFor(''), []);
});

test('procdeck: the payload lists its runways, procedures and transitions', () => {
  assert.deepEqual(runwayIds(payload), ['08R', '10', '26L']);
  assert.deepEqual(runwayThreshold(payload, 'RW08R'), { id: 'RW08R', lat: 33.646801, lon: -84.4384 });
  assert.equal(runwayThreshold(payload, '99'), null);

  const sids = procedureList(payload, 'sid');
  assert.deepEqual(sids.map(p => p.id), ['BANNG3']);
  assert.deepEqual(sids[0].branches, ['LUCKK', 'DBN']);
  assert.deepEqual(sids[0].runways, ['08', '10']);

  const transitions = transitionList(payload, { kind: 'sid', ident: 'banng3' });
  assert.deepEqual(transitions.map(t => t.id), ['RW08B', 'RW10', 'DBN', 'LUCKK']);
  assert.equal(transitions[0].label, 'Runway 08');
  assert.equal(transitions[0].kind, 'runway');
  assert.equal(transitions[3].label, 'via LUCKK');
});

test('procdeck: a SID joins its runway transition to the chosen branch at the shared fix', () => {
  const path = pathFor(payload, { kind: 'sid', ident: 'BANNG3', runway: '08', transition: 'LUCKK' });
  assert.equal(path.ok, true);
  assert.equal(path.segments.length, 1, 'the halves meet at BANNG');
  assert.deepEqual(path.points.map(p => p.id), ['SKNNR', 'GRITZ', 'BANNG', 'LUCKK']);
  assert.equal(path.transition, 'LUCKK');
  assert.equal(path.complete, true);
  assert.match(pathNote(path), /SID BANNG3 · runway 08 from AIRAC 2611/);
});

test('procdeck: halves that share no fix are drawn as two published sections', () => {
  const path = pathFor(payload, { kind: 'sid', ident: 'BANNG3', runway: '10', transition: 'DBN' });
  assert.equal(path.ok, true);
  assert.equal(path.segments.length, 2, 'no invented line between unrelated pieces');
  assert.deepEqual(path.segments[0].map(p => p.id), ['GRITZ', 'BANNG']);
  assert.deepEqual(path.segments[1].map(p => p.id), ['OTTOF']);
  assert.equal(path.complete, false, 'a skipped leg is reported, not hidden');
  assert.match(pathNote(path), /2 legs not resolvable/);
});

test('procdeck: a STAR ends at the runway threshold instead of the field centre', () => {
  const path = pathFor(payload, { kind: 'star', ident: 'GNDLF2', runway: '26L', transition: 'BANNG' });
  assert.equal(path.ok, true);
  assert.equal(path.segments.length, 1);
  assert.deepEqual(path.points.map(p => p.id), ['BANNG', 'HONIE', 'RW26L']);
  const threshold = path.points[path.points.length - 1];
  assert.equal(threshold.lat, 33.646801);
  assert.equal(threshold.lon, -84.405502);
});

test('procdeck: an approach lists its runways, entry branches and final segment', () => {
  const approaches = procedureList(approachPayload, 'approach');
  assert.deepEqual(approaches.map(p => p.id), ['H26LZ', 'I26L']);
  assert.deepEqual(approaches[1].runways, ['26L'], 'the runway leg names the runway');
  assert.deepEqual(approaches[1].branches, ['BANNG'], 'the final segment is not an entry branch');
  assert.equal(approaches[1].title, 'ILS RWY 26L');
  assert.equal(approachTitle('H26LZ'), 'RNAV (RNP) Z RWY 26L');
  assert.equal(approachTitle('XX'), '', 'an unreadable ident gets no invented title');

  const transitions = transitionList(approachPayload, { kind: 'approach', ident: 'i26l' });
  assert.deepEqual(transitions.map(t => t.id), ['', 'BANNG']);
  assert.equal(transitions[0].label, 'Final approach');
  assert.equal(transitions[0].kind, 'final');
  assert.equal(transitions[1].label, 'via BANNG');
  assert.equal(kindNote(approachPayload, 'approach'), '');
});

test('procdeck: an approach joins its entry branch to the final segment and stops on the runway', () => {
  const path = pathFor(approachPayload, { kind: 'approach', ident: 'I26L', runway: '26L', transition: 'BANNG' });
  assert.equal(path.ok, true);
  assert.equal(path.segments.length, 1, 'the branch meets the final segment at HONIE');
  assert.deepEqual(path.points.map(p => p.id), ['BANNG', 'HONIE', 'RW26L'], 'the missed approach is not drawn as the approach');
  assert.equal(path.runway, '26L');
  assert.equal(path.complete, true);
  assert.match(pathNote(path), /ILS RWY 26L \(I26L\) · runway 26L/);

  const final = pathFor(approachPayload, { kind: 'approach', ident: 'I26L' });
  assert.equal(final.ok, true);
  assert.deepEqual(final.points.map(p => p.id), ['HONIE', 'RW26L']);
  assert.equal(final.segments.length, 1);
});

test('procdeck: missing data is named, and approaches are never invented', () => {
  const missing = pathFor(payload, { kind: 'sid', ident: 'NOPE', runway: '08' });
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, 'not-in-data');
  assert.match(missing.error, /has no SID NOPE/);

  const approach = pathFor(payload, { kind: 'approach', ident: 'ILS26L', runway: '26' });
  assert.equal(approach.ok, false);
  assert.equal(approach.reason, 'not-in-dataset');
  assert.match(approach.error, /publishes no APP legs/);

  const info = describe(payload);
  assert.deepEqual(info.counts, { sid: 1, star: 1, approach: 0 });
  assert.equal(info.total, 2);
  assert.match(kindNote(payload, 'approach'), /No approach leg geometry/);
  assert.equal(kindNote(payload, 'sid'), '');
  assert.equal(kindNote(null, 'sid'), 'No procedure data for this airport.');
});

test('procdeck: the SimBrief plan supplies the starting selection', () => {
  const selection = planSelection({
    origin: { icao: 'KATL', rwy: '08R', sid: 'BANNG3', sidTrans: 'LUCKK' },
    destination: { icao: 'KJFK', rwy: '04L', star: 'CAMRN5', starTrans: 'CAMRN', approach: 'ILS04L', approachRwy: '04L' },
  });
  assert.deepEqual(selection, {
    dep: 'KATL', depRwy: '08R', sid: 'BANNG3', sidTrans: 'LUCKK',
    arr: 'KJFK', arrRwy: '04L', star: 'CAMRN5', starTrans: 'CAMRN',
    approach: 'ILS04L', approachRwy: '04L',
  });
  assert.deepEqual(planSelection(null), {
    dep: '', depRwy: '', sid: '', sidTrans: '', arr: '', arrRwy: '', star: '', starTrans: '', approach: '', approachRwy: '',
  });
});

test('procdeck: labels follow the zoom, keeping every fix end at any zoom', () => {
  const path = pathFor(payload, { kind: 'sid', ident: 'BANNG3', runway: '08', transition: 'LUCKK' });
  const far = procedureLabels([path], 5).map(l => l.id);
  assert.deepEqual(far, ['LUCKK'], 'only the procedure end is named when zoomed out');
  const near = procedureLabels([path], 10).map(l => l.id);
  assert.deepEqual(near, ['SKNNR', 'GRITZ', 'BANNG', 'LUCKK']);
  assert.ok(KINDS.sid.color !== KINDS.star.color);
});

function fakeRes() {
  const res = {
    headers: {}, statusCode: 0, body: '',
    setHeader(name, value) { this.headers[String(name).toLowerCase()] = value; },
    end(body) { this.body = body; },
  };
  return res;
}

async function callApi(query, method = 'GET') {
  const res = fakeRes();
  await handler({ method, query }, res);
  return { status: res.statusCode, headers: res.headers, body: JSON.parse(res.body) };
}

test('procedures endpoint: it serves the bundled dataset and explains what it cannot', async () => {
  const ok = await callApi({ airport: 'ksea' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.ok, true);
  assert.equal(ok.body.airport, 'KSEA');
  assert.ok(ok.body.procedures.sid.length > 0, 'real SIDs come back');
  assert.match(ok.headers['cache-control'], /s-maxage/);

  const one = await callApi({ airport: 'KSEA', kind: 'star', id: 'chins5' });
  assert.equal(one.status, 200);
  assert.equal(one.body.procedures.star.length <= 1, true);

  const outside = await callApi({ airport: 'EGLL' });
  assert.equal(outside.status, 404, 'the FAA dataset does not cover Heathrow');
  assert.equal(outside.body.reason, 'not-in-dataset');
  assert.match(outside.body.error, /United States/);

  const bad = await callApi({ airport: 'K' });
  assert.equal(bad.status, 400);
  assert.equal((await callApi({})).status, 400);
  assert.equal((await callApi({ airport: 'KSEA' }, 'POST')).status, 405);
});
