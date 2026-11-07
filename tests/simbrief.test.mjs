import test from 'node:test';
import assert from 'node:assert/strict';

import { fetchSimbriefPlan, simbriefQuery, validateSimbriefId } from '../app/js/lib/simbrief.js';
import { compareRouteWithOfp, loadOfp, parseOfp, planProcedures, routeProcedures } from '../app/js/lib/flightsummary.js';
import {
  activeRouteGeometryVersion, basePlanFromOfp, buildProcedurePlan, loadProcedurePayloads, planKey,
  procedureChoice, storageFromPlan, ROUTE_GEOMETRY_VERSION,
} from '../app/js/lib/simbriefroute.js';

// The payload shape the SimBrief json=v2 endpoint returns, trimmed to the fields
// the planner and the tracking card read.
function payload() {
  return {
    general: { icao_airline: 'ASA', flight_number: '123', cruise_altitude: '35000', cruise_tas: '452', route: 'SUMMA2 SUMMA J523 BLUIT HRMNS3' },
    origin: { icao_code: 'KSEA', name: 'Seattle-Tacoma Intl', plan_rwy: '16L', sid_ident: 'SUMMA2', sid_trans: '' },
    destination: { icao_code: 'KPDX', name: 'Portland Intl', plan_rwy: '28R', star_ident: 'HRMNS3', star_trans: '', approach_ident: 'ILS28R', approach_rwy: '28R' },
    aircraft: { icaocode: 'B738', name: 'Boeing 737-800', reg: 'N8312C' },
    times: { sched_out: '1792789000', sched_in: '1792795000', est_time_enroute: '4200' },
    navlog: {
      fix: [
        { ident: 'KSEA', name: 'KSEA', pos_lat: '47.449', pos_long: '-122.309', altitude_feet: '433', type: 'apt', is_sid_star: '1', stage: 'CLB' },
        { ident: 'SUMMA', name: 'SUMMA', pos_lat: '47.2583', pos_long: '-122.4125', altitude_feet: '9000', type: 'wpt', is_sid_star: '1', stage: 'CLB' },
        { ident: 'BLUIT', name: 'BLUIT', pos_lat: '46.5', pos_long: '-121.9', altitude_feet: '35000', type: 'wpt', is_sid_star: '0', via_airway: 'J523' },
        { ident: 'KPDX', name: 'KPDX', pos_lat: '45.5898', pos_long: '-122.5951', altitude_feet: '31', type: 'apt' },
      ],
    },
  };
}

test('simbrief: the plan carries the procedures and runways the card shows', async () => {
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async url => {
    calls.push(String(url));
    return { ok: true, status: 200, json: async () => payload() };
  };
  try {
    const plan = await fetchSimbriefPlan('123456');
    assert.equal(plan.origin, 'KSEA');
    assert.equal(plan.destination, 'KPDX');
    assert.equal(plan.fixes.length, 4);
    assert.ok(plan.ofp, 'the normalised OFP is returned so the Flight Deck can store it');
    assert.equal(plan.ofp.origin.sid, 'SUMMA2');
    assert.equal(plan.ofp.origin.rwy, '16L');
    assert.equal(plan.ofp.destination.star, 'HRMNS3');
    assert.equal(plan.ofp.destination.rwy, '28R');
    assert.equal(plan.ofp.flight.cruiseFt, 35000);
    assert.equal(plan.ofp.aircraft.reg, 'N8312C');
    assert.match(calls[0], /userid=123456/, 'a numeric id is asked for as a Pilot ID');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('simbrief: current json=v2 navlog arrays are imported without the XML fallback', async () => {
  const raw = payload();
  raw.navlog = raw.navlog.fix;
  const ofp = parseOfp(raw);
  assert.equal(ofp.fixes.length, 4);
  assert.equal(ofp.fixes[0].ident, 'KSEA');

  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async url => {
    calls.push(String(url));
    return { ok: true, status: 200, json: async () => raw };
  };
  try {
    const plan = await fetchSimbriefPlan('123456');
    assert.equal(plan.fixes.length, 4);
    assert.equal(calls.length, 1, 'the array is enough; no XML request is needed');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('simbrief: the OFP document SimBrief publishes is the one the card opens', () => {
  const raw = payload();
  raw.files = {
    directory: 'https://www.simbrief.com/ofp/flightplans/',
    pdf: { name: 'PDF Document', link: 'KSEAKPDX_PDF_1792876669.pdf' },
  };
  const ofp = parseOfp(raw);
  assert.equal(ofp.documentUrl, 'https://www.simbrief.com/ofp/flightplans/KSEAKPDX_PDF_1792876669.pdf');
  assert.equal(ofp.text, null, 'the PDF is the document, so no duplicate text is stored');

  // A response without a published document keeps its OFP text instead, and it
  // is text: markup never reaches the page.
  const noPdf = payload();
  noPdf.text = { plan_html: '<div><b>[ OFP ]</b><br>KSEA/KPDX<pre>CRZ FL350</pre></div><script>bad()</script>' };
  const textOnly = parseOfp(noPdf);
  assert.equal(textOnly.documentUrl, null);
  assert.match(textOnly.text, /\[ OFP \]/);
  assert.match(textOnly.text, /KSEA\/KPDX/);
  assert.equal(/[<>]/.test(textOnly.text), false, 'the OFP text is plain, not HTML');

  // A plan that names no document and no text answers null rather than a guess.
  assert.equal(parseOfp(payload()).documentUrl, null);
  assert.equal(parseOfp(payload()).text, null);
});

test('simbrief: cruise comes from the plan itself, including its initial level', () => {
  // Real json=v2 responses carry `initial_altitude`; `cruise_altitude` is not
  // guaranteed. Neither is invented when both are missing.
  const real = payload();
  delete real.general.cruise_altitude;
  real.general.initial_altitude = '36000';
  assert.equal(parseOfp(real).flight.cruiseFt, 36000);

  const silent = payload();
  delete silent.general.cruise_altitude;
  assert.equal(parseOfp(silent).flight.cruiseFt, null);
});

test('simbrief: a username query and id validation stay strict', () => {
  assert.equal(simbriefQuery('pilot.name'), 'username=pilot.name');
  assert.equal(validateSimbriefId('abc def').ok, false);
  assert.equal(validateSimbriefId('123456').kind, 'pilot');
});

test('simbrief: the SID and STAR are read where SimBrief actually writes them', () => {
  // A real json=v2 response puts the procedures in `general`, leaves the
  // airport blocks without them, and shortens each ident by one character
  // (LITKU2X -> LITK2X). `route_ifps` carries the full name.
  const ofp = parseOfp({
    general: {
      sid_ident: 'LITK2X', sid_trans: '', star_ident: 'LOGD6N', star_trans: '',
      route: 'LITK2X LITKU Y301 KALIF DCT ULPUK DCT ORTEB DCT KONZI DCT LOGDA LOGD6N',
      route_ifps: 'LITKU2X LITKU Y301 KALIF DCT ULPUK DCT ORTEB DCT KONZI DCT LOGDA LOGDA6N',
    },
    origin: { icao_code: 'LHBP', plan_rwy: '31L' },
    destination: { icao_code: 'EPWA', plan_rwy: '11' },
  });
  assert.equal(ofp.origin.sid, 'LITKU2X', 'the full SID ident the navigation data publishes');
  assert.equal(ofp.destination.star, 'LOGDA6N', 'the full STAR ident');
  assert.equal(ofp.origin.rwy, '31L');
  assert.equal(ofp.destination.rwy, '11');
  assert.equal(ofp.flight.routeIfps, 'LITKU2X LITKU Y301 KALIF DCT ULPUK DCT ORTEB DCT KONZI DCT LOGDA LOGDA6N');
});

test('simbrief: the older airport-block procedure fields still work', () => {
  const ofp = parseOfp({ origin: { sid_ident: 'SUMMA2' }, destination: { star_ident: 'HRMNS3' } });
  assert.equal(ofp.origin.sid, 'SUMMA2');
  assert.equal(ofp.destination.star, 'HRMNS3');
});

test('simbrief: a plan that only names the procedures in its route still yields them', () => {
  const ofp = parseOfp({ general: { route: 'SUMMA2 SUMMA J523 BLUIT HRMNS3' } });
  assert.equal(ofp.origin.sid, 'SUMMA2');
  assert.equal(ofp.destination.star, 'HRMNS3');
  // A plan with no procedure filed invents none: airways, fixes and DCT are not
  // procedure idents.
  assert.deepEqual(routeProcedures('DCT KALIF J523 BLUIT'), { sid: null, star: null });
  assert.deepEqual(routeProcedures('KSEA/16L DCT KALIF UL984 KPDX/28R'), { sid: null, star: null });
});

test('simbrief: a shortened ident is only restored when one character explains it', () => {
  assert.deepEqual(planProcedures({
    flight: { routeIfps: 'LITKU2X LITKU LOGDA6N' },
    origin: { sid: 'LITK2X' },
    destination: { star: 'LOGD6N' },
  }), { sid: 'LITKU2X', star: 'LOGDA6N', sidTrans: null, starTrans: null });
  // A genuinely different procedure is never swapped in for the filed one.
  const kept = planProcedures({ flight: { routeIfps: 'SUMMAX3 X HRMNS3' }, origin: { sid: 'SUMMA2' } });
  assert.equal(kept.sid, 'SUMMA2');
});

test('simbrief: a plan stored before this fix still shows its SID and STAR', () => {
  const stored = {
    simbriefId: '1049175',
    ofp: {
      flight: { routeText: 'LITK2X LITKU Y301 KALIF DCT KONZI DCT LOGDA LOGD6N' },
      origin: { icao: 'LHBP', sid: null, sidTrans: null },
      destination: { icao: 'EPWA', star: null, starTrans: null },
    },
  };
  const memory = { getItem: () => JSON.stringify(stored) };
  const loaded = loadOfp(memory);
  assert.equal(loaded.ofp.origin.sid, 'LITK2X');
  assert.equal(loaded.ofp.destination.star, 'LOGD6N');
  assert.equal(loaded.ofp.origin.icao, 'LHBP', 'the rest of the plan is untouched');
});

test('simbrief: a plan with Detailed Navlog off still imports its SID and STAR', async () => {
  const realFetch = globalThis.fetch;
  let call = 0;
  globalThis.fetch = async () => {
    call += 1;
    if (call === 1) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          general: {
            sid_ident: 'LITK2X', star_ident: 'LOGD6N', route_distance: '344',
            route: 'LITK2X LITKU Y301 KALIF DCT KONZI DCT LOGDA LOGD6N',
            route_ifps: 'LITKU2X LITKU Y301 KALIF DCT KONZI DCT LOGDA LOGDA6N',
          },
          origin: { icao_code: 'LHBP', plan_rwy: '31L' },
          destination: { icao_code: 'EPWA', plan_rwy: '11' },
          navlog: { fix: [] },
        }),
      };
    }
    // The XML fallback has no fixes either, as when Detailed Navlog is off.
    return { ok: false, status: 400 };
  };
  try {
    const plan = await fetchSimbriefPlan('1049175');
    assert.equal(plan.fixes.length, 0, 'there is no navlog to import');
    assert.equal(plan.ofp.origin.sid, 'LITKU2X', 'the SID is still imported');
    assert.equal(plan.ofp.destination.star, 'LOGDA6N', 'the STAR is still imported');
    assert.equal(plan.ofp.origin.rwy, '31L');
    assert.equal(plan.ofp.destination.rwy, '11');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('simbrief: the navlog procedure and airway tags survive normalisation', () => {
  const raw = payload();
  raw.navlog.fix[1].is_sid_star = '1';
  raw.navlog.fix[2].via_airway = 'J523';
  const ofp = parseOfp(raw);
  assert.equal(ofp.fixes[1].isSidStar, true);
  assert.equal(ofp.fixes[1].stage, 'CLB');
  assert.equal(ofp.fixes[2].viaAirway, 'J523');
  const base = basePlanFromOfp(ofp);
  assert.equal(base.plan.points.find(point => point.id === 'SUMMA').ss, 'sid');
  assert.equal(base.plan.points.find(point => point.id === 'BLUIT').aw, 'J523');
});

test('simbrief: the OFP carries the AIRAC cycle and its generated identity', () => {
  const raw = payload();
  raw.params = { airac: '2610', time_generated: '1792788000', request_id: 'req-42' };
  const ofp = parseOfp(raw);
  assert.equal(ofp.airac, '2610');
  assert.equal(ofp.generatedAt, 1792788000);
  assert.equal(ofp.requestId, 'req-42');
  assert.equal(parseOfp(payload()).airac, null, 'a missing cycle is not invented');
});

function overseasPayloads() {
  const ofp = {
    airac: '2610',
    requestId: 'req-42',
    flight: { routeText: 'SUMMA2 SUMMA J523 BLUIT HRMNS3', cruiseTasKt: 452, cruiseFt: 35000 },
    origin: { icao: 'KSEA', rwy: '16L', sid: 'SUMMA2', sidTrans: 'SUMMA' },
    destination: { icao: 'KPDX', rwy: '28R', star: 'HRMNS3', starTrans: 'BLUIT' },
    fixes: [
      { ident: 'KSEA', name: 'Seattle', lat: 47.449, lon: -122.309, type: 'apt', altFt: 433 },
      { ident: 'SUMMA', name: 'SUMMA', lat: 47.2583, lon: -122.4125, type: 'wpt', altFt: 9000 },
      { ident: 'BLUIT', name: 'BLUIT', lat: 46.5, lon: -121.9, type: 'wpt', altFt: 35000 },
      { ident: 'KPDX', name: 'Portland', lat: 45.5898, lon: -122.5951, type: 'apt', altFt: 31 },
    ],
  };
  const depPayload = {
    ok: true,
    airport: 'KSEA',
    source: 'X-Plane 12 CIFP',
    cycle: '2610',
    runways: { '16L': { lat: 47.463794, lon: -122.30775 } },
    procedures: {
      sid: [{
        id: 'SUMMA2',
        transitions: [
          { id: 'RW16L', runway: '16L', complete: true, skipped: 0, points: [
            { id: 'CAVOB', lat: 47.396192, lon: -122.308347, terminator: 'TF', altFt: 2500 },
            { id: 'RENBE', lat: 47.320364, lon: -122.311544, terminator: 'TF' },
          ] },
          { id: 'ALL', complete: true, skipped: 0, points: [
            { id: 'RENBE', lat: 47.320364, lon: -122.311544, terminator: 'TF' },
            { id: 'SUMMA', lat: 47.2583, lon: -122.4125, terminator: 'TF' },
          ] },
          { id: 'SUMMA', complete: true, skipped: 0, points: [
            { id: 'SUMMA', lat: 47.2583, lon: -122.4125, terminator: 'IF' },
          ] },
        ],
      }],
      star: [],
      approach: [],
    },
  };
  const arrPayload = {
    ok: true,
    airport: 'KPDX',
    source: 'X-Plane 12 CIFP',
    cycle: '2610',
    runways: { '28R': { lat: 45.5887, lon: -122.5934 } },
    procedures: {
      sid: [],
      star: [{
        id: 'HRMNS3',
        transitions: [
          { id: 'BLUIT', complete: true, skipped: 0, points: [
            { id: 'BLUIT', lat: 46.5, lon: -121.9, terminator: 'IF' },
            { id: 'HONIE', lat: 45.9, lon: -122.2, terminator: 'TF' },
          ] },
          { id: 'ALL', complete: true, skipped: 0, points: [
            { id: 'HONIE', lat: 45.9, lon: -122.2, terminator: 'TF' },
            { id: 'KPDX', lat: 45.5898, lon: -122.5951, terminator: 'TF' },
          ] },
          { id: 'RW28R', runway: '28R', complete: true, skipped: 0, points: [
            { id: 'KPDX', lat: 45.5898, lon: -122.5951, terminator: 'TF' },
            { id: 'RW28R', lat: 45.5887, lon: -122.5934, terminator: 'TF' },
          ] },
        ],
      }],
      approach: [],
    },
  };
  return { ofp, depPayload, arrPayload };
}

test('simbrief: the automatic map import calls the SimBrief client', async () => {
  const fs = await import('node:fs');
  const page = fs.readFileSync(new URL('../app/index.html', import.meta.url), 'utf8');
  assert.match(page, /import \* as SIMBRIEF from '\.\/js\/lib\/simbrief\.js'/, 'the page imports the client that fetches an OFP');
  assert.match(page, /window\.SIMBRIEF = SIMBRIEF/, 'the classic map script can reach it');
  assert.match(page, /await window\.SIMBRIEF\.fetchSimbriefPlan\(id\)/, 'the automatic import asks that client');
  assert.doesNotMatch(page, /FP\.fetchSimbriefPlan/, 'the flight-panel module is not the SimBrief client');
});

test('simbrief route: a navlog starting after the departure airport is anchored by that airport', () => {
  const raw = payload();
  raw.navlog = raw.navlog.fix.slice(1);
  raw.origin = { ...raw.origin, pos_lat: '47.449', pos_long: '-122.309' };
  const base = basePlanFromOfp(parseOfp(raw));
  assert.equal(base.ok, true);
  assert.deepEqual(base.plan.points.map(point => point.id), ['KSEA', 'SUMMA', 'BLUIT', 'KPDX']);
  assert.equal(base.plan.points[0].kind, 'apt');
  assert.equal(base.plan.points[0].lat, 47.449);
  assert.equal(base.plan.points[0].lon, -122.309);
  assert.equal(base.plan.points[0].source, 'simbrief');
});

test('simbrief route: SimBrief descent fixes are STAR-tagged, and an unavailable STAR is not marked verified', () => {
  const raw = payload();
  raw.navlog.fix[1].is_sid_star = '1';
  raw.navlog.fix[2] = {
    ...raw.navlog.fix[2], is_sid_star: '1', stage: 'DSC', via_airway: 'HRMNS3',
  };
  const ofp = parseOfp(raw);
  const base = basePlanFromOfp(ofp);
  assert.equal(base.plan.points.find(point => point.id === 'SUMMA').ss, 'sid');
  assert.equal(base.plan.points.find(point => point.id === 'BLUIT').ss, 'star');

  const { depPayload } = overseasPayloads();
  const built = buildProcedurePlan(ofp, { depPayload, arrPayload: null });
  assert.equal(built.ok, true);
  assert.ok(built.warnings.some(warning => warning.kind === 'star'));
  assert.ok(!built.plan.points.some(point => point.ss === 'star'), 'unavailable STAR legs stay en-route, not amber');
});

test('simbrief route: the filed procedures become one continuous verified route', () => {
  const { ofp, depPayload, arrPayload } = overseasPayloads();
  assert.equal(procedureChoice(ofp).sidTrans, 'SUMMA');
  assert.equal(basePlanFromOfp(ofp).ok, true);
  assert.equal(basePlanFromOfp(ofp).plan.points.length, 4, 'the navlog is the en-route route');

  const built = buildProcedurePlan(ofp, { depPayload, arrPayload });
  assert.equal(built.ok, true);
  assert.deepEqual(built.plan.points.map(point => point.id), [
    'KSEA', 'RW16L', 'CAVOB', 'RENBE', 'SUMMA', 'BLUIT', 'HONIE', 'RW28R', 'KPDX',
  ], 'runway → SID → transition → en-route → STAR transition → STAR → runway');
  assert.equal(built.plan.points[1].id, 'RW16L', 'the departure path starts at the runway threshold');
  assert.equal(built.plan.sid.id, 'SUMMA2');
  assert.equal(built.plan.star.id, 'HRMNS3');
  assert.equal(built.plan.points.find(point => point.id === 'CAVOB').ss, 'SID');
  assert.equal(built.plan.points.find(point => point.id === 'HONIE').ss, 'STAR');
  assert.equal(built.plan.points.find(point => point.id === 'CAVOB').altFt, 2500, 'a published constraint travels with the leg');
  assert.equal(built.plan.points.find(point => point.id === 'CAVOB').terminator, 'TF');
  assert.equal(built.complete, true);
  assert.deepEqual(built.warnings, []);

  const stored = storageFromPlan(built.plan, ofp, '1049175', built.warnings, built.applied);
  assert.equal(stored.key, planKey(ofp));
  assert.equal(stored.active.plan.simbrief.airac, '2610');
  assert.deepEqual(stored.active.plan.simbrief.applied, { sid: 'SUMMA2', star: 'HRMNS3', approach: '' });
  assert.deepEqual(stored.map.map(point => point.id), built.plan.points.map(point => point.id));
  assert.equal(stored.map.find(point => point.id === 'CAVOB').ss, 'sid', 'the map copy uses the map tag spelling');
  assert.equal(stored.map.find(point => point.id === 'HONIE').ss, 'star');
  assert.equal(stored.active.plan.geometryVersion, ROUTE_GEOMETRY_VERSION);
  assert.equal(activeRouteGeometryVersion({ getItem: () => JSON.stringify(stored.active) }), ROUTE_GEOMETRY_VERSION);
  assert.equal(activeRouteGeometryVersion({ getItem: () => JSON.stringify({ plan: { version: 1 } }) }), 0,
    'a plan saved by an older build is refreshed instead of treated as current');
});

test('simbrief: imported procedure legs are not mistaken for edits to the OFP route', () => {
  const ofp = { fixes: [
    { ident: 'KIDNG' }, { ident: 'EZEEE' }, { ident: 'MDANO' },
    { ident: 'BELFR' }, { ident: 'KDFW' },
  ] };
  const route = [
    { id: 'KDEN', k: 'apt', ss: '' },
    { id: 'RW08', k: 'fix', ss: 'sid' },
    { id: 'KIDNG', k: 'fix', ss: 'sid' },
    { id: 'EZEEE', k: 'fix', ss: '' },
    { id: 'MDANO', k: 'fix', ss: 'star' },
    { id: 'BELFR', k: 'fix', ss: 'star' },
    { id: 'RW35C', k: 'fix', ss: 'star' },
    { id: 'KDFW', k: 'apt', ss: '' },
  ];
  assert.equal(compareRouteWithOfp(route, ofp), 'match');
  assert.equal(compareRouteWithOfp(route.filter(point => point.id !== 'EZEEE'), ofp), 'changed');
  assert.equal(compareRouteWithOfp([...route, { id: 'EXTRA', k: 'fix', ss: '' }], ofp), 'changed', 'a real en-route edit is still detected');
});

test('simbrief route: a STAR-tagged destination airport stays the route anchor', () => {
  const { ofp, depPayload, arrPayload } = overseasPayloads();
  ofp.fixes = ofp.fixes.map((fix, index) => index === ofp.fixes.length - 1
    ? { ...fix, isSidStar: true, stage: 'DSC', viaAirway: 'HRMNS3' }
    : fix);
  const base = basePlanFromOfp(ofp);
  const baseLast = base.plan.points[base.plan.points.length - 1];
  assert.equal(baseLast.id, 'KPDX');
  assert.equal(baseLast.ss, '', 'an airport endpoint is not a procedure leg');

  const built = buildProcedurePlan(ofp, { depPayload, arrPayload });
  assert.equal(built.ok, true);
  assert.equal(built.plan.destination.id, 'KPDX');
  assert.equal(built.plan.star.id, 'HRMNS3');
  assert.equal(built.plan.points[built.plan.points.length - 1].id, 'KPDX');
  assert.equal(built.plan.points.filter(point => point.id === 'KPDX').length, 1, 'the arrival airport is not duplicated');
});

test('simbrief route: unrelated procedure pieces are not joined by a straight line', () => {
  const { ofp, depPayload, arrPayload } = overseasPayloads();
  const brokenSid = {
    ...depPayload,
    procedures: {
      ...depPayload.procedures,
      sid: [{
        id: 'SUMMA2',
        transitions: [
          { id: 'RW16L', runway: '16L', complete: true, skipped: 0, points: [
            { id: 'CAVOB', lat: 47.396192, lon: -122.308347, terminator: 'TF' },
          ] },
          { id: 'SUMMA', complete: true, skipped: 0, points: [
            { id: 'RENBE', lat: 47.320364, lon: -122.311544, terminator: 'TF' },
          ] },
        ],
      }],
    },
  };
  const built = buildProcedurePlan(ofp, { depPayload: brokenSid, arrPayload });
  assert.equal(built.ok, true);
  assert.equal(built.applied.sid, null, 'the SID is not applied when its pieces do not meet');
  assert.ok(built.warnings.some(warning => warning.kind === 'sid' && /do not meet/.test(warning.text)));
  assert.ok(!built.plan.points.some(point => point.id === 'CAVOB'), 'no disconnected point is inserted');
});

test('simbrief route: missing geometry is named and never approximated', () => {
  const { ofp, depPayload, arrPayload } = overseasPayloads();
  const missingSid = { ...ofp, origin: { ...ofp.origin, sid: 'NOPE9' } };
  const built = buildProcedurePlan(missingSid, { depPayload, arrPayload });
  assert.equal(built.ok, true);
  assert.equal(built.applied.sid, null);
  assert.ok(built.warnings.some(warning => warning.kind === 'sid' && /NOPE9/.test(warning.text)));
  assert.ok(!built.plan.points.some(point => point.ss === 'SID'), 'no invented SID legs are inserted');
  assert.equal(built.plan.star.id, 'HRMNS3', 'the verified STAR is still inserted');

  const cyclePayload = { ...depPayload, cycle: '2611' };
  const mismatch = buildProcedurePlan(ofp, { depPayload: cyclePayload, arrPayload });
  assert.ok(mismatch.warnings.some(warning => warning.kind === 'airac' && /2611/.test(warning.text) && /2610/.test(warning.text)));
});

test('simbrief route: procedure payloads fall through to the bundled API', async () => {
  const { ofp, depPayload, arrPayload } = overseasPayloads();
  const calls = [];
  const fetchImpl = async url => {
    calls.push(String(url));
    if (String(url).startsWith('/procedures.json')) {
      return { json: async () => ({ ok: false, reason: 'unreachable' }) };
    }
    return { json: async () => (String(url).includes('KSEA') ? depPayload : arrPayload) };
  };
  const payloads = await loadProcedurePayloads(ofp, fetchImpl);
  assert.equal(payloads.depPayload.airport, 'KSEA');
  assert.equal(payloads.arrPayload.airport, 'KPDX');
  assert.ok(calls.some(url => url.startsWith('/procedures.json')));
  assert.ok(calls.some(url => url.startsWith('/api/procedures')));
});

test('simbrief: a plan with no fixes is an error, not an empty route', async () => {
  const realFetch = globalThis.fetch;
  let call = 0;
  globalThis.fetch = async () => {
    call += 1;
    // The first request is the JSON plan; the XML fallback is refused so the
    // error is the missing fixes, not a parser difference in this runtime.
    if (call === 1) return { ok: true, status: 200, json: async () => ({ general: {}, navlog: { fix: [] } }) };
    return { ok: false, status: 400 };
  };
  try {
    await assert.rejects(() => fetchSimbriefPlan('123456'), /No waypoints found/);
  } finally {
    globalThis.fetch = realFetch;
  }
});
