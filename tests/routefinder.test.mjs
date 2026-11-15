import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCallsign, cruiseKt, blockMinutes, matchesDuration, fromAdsbdb, candidatesFrom, simbriefUrl, findRoutes,
} from '../app/js/lib/routefinder.js';

// Real adsbdb shape (BAW117, trimmed).
const BAW117 = { response: { flightroute: {
  callsign: 'BAW117', airline: { name: 'British Airways', icao: 'BAW' },
  origin: { icao_code: 'EGLL', iata_code: 'LHR', name: 'London Heathrow Airport', municipality: 'London', country_iso_name: 'GB', latitude: 51.4706, longitude: -0.46194 },
  destination: { icao_code: 'KJFK', iata_code: 'JFK', name: 'John F Kennedy International Airport', municipality: 'New York', country_iso_name: 'US', latitude: 40.6398, longitude: -73.7789 },
} } };

test('only airline callsigns are route candidates', () => {
  assert.deepEqual(parseCallsign(' baw117 '), { callsign: 'BAW117', airline: 'BAW', number: '117' });
  assert.deepEqual(parseCallsign('EZY45LP'), { callsign: 'EZY45LP', airline: 'EZY', number: '45LP' });
  assert.equal(parseCallsign('N413FR'), null, 'a registration is not an airline flight');
  assert.equal(parseCallsign('GABCD'), null);
  assert.equal(parseCallsign(''), null);
});

test('block time grows with distance and depends on the aircraft class', () => {
  assert.equal(cruiseKt('AT76'), 270);
  assert.equal(cruiseKt('E75L'), 420);
  assert.equal(cruiseKt('B77W'), 485);
  assert.equal(cruiseKt('A20N'), 450);
  assert.equal(blockMinutes(450, 'A20N'), 85);
  assert.ok(blockMinutes(450, 'AT76') > blockMinutes(450, 'A20N'));
  assert.ok(matchesDuration(85, '1-2'));
  assert.ok(!matchesDuration(85, 'lt1'));
  assert.ok(matchesDuration(600, 'gt8') && matchesDuration(600, 'any'));
});

test('adsbdb routes become airports with coordinates; broken ones are dropped', () => {
  const r = fromAdsbdb(BAW117);
  assert.equal(r.airlineName, 'British Airways');
  assert.equal(r.origin.icao, 'EGLL');
  assert.equal(r.destination.city, 'New York');
  assert.equal(fromAdsbdb({ response: 'unknown callsign' }), null);
  assert.equal(fromAdsbdb({ response: { flightroute: { ...BAW117.response.flightroute, destination: BAW117.response.flightroute.origin } } }), null, 'a round trip to itself is not a route');
});

test('candidates are airline flights, de-duplicated and filtered by airline', () => {
  const payloads = [
    { ac: [{ flight: 'BAW117  ', t: 'B77W', r: 'G-STBA' }, { flight: 'N413FR', t: 'A20N' }, { flight: 'DLH400', t: 'B748' }] },
    { ac: [{ flight: 'BAW117', t: 'B77W' }] },
    null,
  ];
  assert.deepEqual(candidatesFrom(payloads).map(c => c.callsign), ['BAW117', 'DLH400']);
  assert.deepEqual(candidatesFrom(payloads, { airline: 'dlh' }).map(c => c.callsign), ['DLH400']);
});

test('the SimBrief uplink carries callsign, type and both airports', () => {
  const url = new URL(simbriefUrl({ airline: 'BAW', number: '117', type: 'B77W', origin: { icao: 'EGLL' }, destination: { icao: 'KJFK' } }));
  assert.equal(url.origin + url.pathname, 'https://dispatch.simbrief.com/options/custom');
  assert.deepEqual(Object.fromEntries(url.searchParams), { airline: 'BAW', fltnum: '117', type: 'B77W', orig: 'EGLL', dest: 'KJFK' });
});

test('a search returns matching real flights and honours the flight-time filter', async () => {
  const fetchTraffic = async url => (url.endsWith('/B77W') ? { ac: [{ flight: 'BAW117', t: 'B77W' }, { flight: 'BAW5', t: 'B77W' }] } : { ac: [] });
  const fetchRoute = async cs => (cs === 'BAW117' ? BAW117 : { response: 'unknown callsign' });
  const long = await findRoutes({ type: 'B77W', duration: '4-8', fetchTraffic, fetchRoute });
  assert.equal(long.results.length, 1);
  assert.equal(long.results[0].callsign, 'BAW117');
  assert.ok(long.results[0].distanceNm > 2900 && long.results[0].distanceNm < 3000, `${long.results[0].distanceNm} nm`);
  const short = await findRoutes({ type: 'B77W', duration: 'lt1', fetchTraffic, fetchRoute });
  assert.equal(short.results.length, 0);
  await assert.rejects(findRoutes({ type: 'B77W', fetchTraffic: async () => { throw new Error('down'); }, fetchRoute }), /unavailable/);
});

test('a refused live request is retried once, and a failed route lookup is tried again later', async () => {
  let trafficCalls = 0;
  const fetchTraffic = async () => { trafficCalls += 1; if (trafficCalls === 1) throw new Error('429'); return { ac: [{ flight: 'BAW777', t: 'B77W' }] }; };
  let routeCalls = 0;
  const fetchRoute = async () => { routeCalls += 1; if (routeCalls === 1) throw new Error('503'); return BAW117; };
  const first = await findRoutes({ type: 'B77W', fetchTraffic, fetchRoute });
  assert.equal(trafficCalls, 2, 'the refused request was retried');
  assert.equal(first.results.length, 0, 'the lookup failed this time');
  const second = await findRoutes({ type: 'B77W', fetchTraffic, fetchRoute });
  assert.equal(second.results.length, 1, 'the failure was not remembered as "no route"');
  assert.equal(routeCalls, 2);
});

test('VRS route files become legs; multi-stop flights split, junk dropped', async () => {
  const { parseVrsRoutes, parseVrsAirports, typeCanFly } = await import('../app/js/lib/routefinder.js');
  const legs = parseVrsRoutes('﻿Callsign,Code,Number,AirlineCode,AirportCodes\r\nBAW1,BAW,1,BAW,EGLL-KJFK\r\nQFA1,QFA,1,QFA,YSSY-WSSS-EGLL\r\nN123,,,,KJFK-KBOS\r\n');
  assert.deepEqual(legs.map(l => `${l.callsign} ${l.from}-${l.to}`), ['BAW1 EGLL-KJFK', 'QFA1 YSSY-WSSS', 'QFA1 WSSS-EGLL']);
  const apts = parseVrsAirports('Code,Name,ICAO,IATA,Location,CountryISO2,Latitude,Longitude,AltitudeFeet\nEGLL,Heathrow,EGLL,LHR,London,GB,51.4706,-0.4619,83\nXX,bad,,,,,,,\n');
  assert.equal(apts.get('EGLL').city, 'London');
  assert.equal(apts.size, 1);
  assert.ok(typeCanFly('', 9000) && typeCanFly('A388', 4500) && !typeCanFly('A388', 300) && !typeCanFly('AT76', 2000));
});

test('an all-flights search filters by departure and arrival without live traffic', async () => {
  const { findAllRoutes } = await import('../app/js/lib/routefinder.js');
  const files = {
    'BAW-all.csv': 'h\nBAW1,BAW,1,BAW,EGLL-KJFK\nBAW2,BAW,2,BAW,KJFK-EGLL\nBAW3,BAW,3,BAW,EGLL-LFPG\n',
    'EG.csv': 'h\nEGLL,Heathrow,EGLL,LHR,London,GB,51.47,-0.46,83\n',
    'KJ.csv': 'h\nKJFK,JFK,KJFK,JFK,New York,US,40.64,-73.78,13\n',
    'LF.csv': 'h\nLFPG,CDG,LFPG,CDG,Paris,FR,49.01,2.55,392\n',
  };
  const fetchText = async url => files[url.split('/').pop()] ?? null;
  const { results } = await findAllRoutes({ airline: 'BAW', from: 'EGLL', fetchText });
  assert.deepEqual(results.map(r => r.callsign).sort(), ['BAW1', 'BAW3']);
  const long = await findAllRoutes({ airline: 'BAW', from: 'EGLL', duration: '4-8', fetchText });
  assert.deepEqual(long.results.map(r => `${r.origin.icao}-${r.destination.icao}`), ['EGLL-KJFK']);
});

test('the flight-time slider passes a minute range', async () => {
  const { matchesDuration } = await import('../app/js/lib/routefinder.js');
  assert.ok(matchesDuration(90, [60, 120]) && matchesDuration(120, [60, 120]));
  assert.ok(!matchesDuration(130, [60, 120]) && matchesDuration(1500, [480, Infinity]));
});
