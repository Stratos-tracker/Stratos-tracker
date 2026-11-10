import test from 'node:test';
import assert from 'node:assert/strict';
import {
  readFlightFile, flightsFromCsv, flightsFromJson, parseCsv, parseDate, parseDuration, detectSource,
} from '../app/js/lib/importers.js';

const VOLANTA = `Origin,Destination,DepartureTime,Duration,Airline,Callsign,FlightNumber,AircraftType,AircraftRegistration,Route,ArrivalTime,Distance,Fuel
EGLL,KBOS,2026-03-01T09:30:00Z,6:45,BAW,BAW117,BA117,B77W,G-STBA,DCT,2026-03-01T16:15:00Z,2980nm,42000
KJFK,KLAX,2026-03-02T14:00:00Z,5:50,DAL,DAL410,DAL410,A320,N410DA,"DCT JFK, DCT LAX",2026-03-02T19:50:00Z,2150,18000
`;

const ELEVATEX = `departure_airport,destination_airport,departure_time,duration_minutes,aircraft,tail,flight,distance
EGLL,EDDF,15/03/2026 08:20,1:05,A320,G-EUUU,BA902,355
KJFK,CYYZ,16/03/2026 18:05,95,B738,C-GEJW,AC881,295
`;

test('a Volanta CSV is read by column meaning, not position', () => {
  const flights = flightsFromCsv(VOLANTA, 'Volanta');
  assert.equal(flights.length, 2, 'both flights are kept');

  const first = flights[0];
  assert.equal(first.depAirport, 'EGLL');
  assert.equal(first.arrAirport, 'KBOS');
  assert.equal(first.aircraft, 'B77W');
  assert.equal(first.registration, 'G-STBA');
  assert.equal(first.callsign, 'BAW117');
  assert.equal(first.distanceNm, 2980);
  assert.equal(first.recordedBy, 'import');
  assert.equal(first.source, 'Volanta');
  assert.equal(first.startTime, Date.parse('2026-03-01T09:30:00Z'));
  assert.equal(first.endTime, Date.parse('2026-03-01T16:15:00Z'));
  assert.ok(!('landing' in first) && !('track' in first), 'nothing the export did not state is invented');
  assert.match(first.notes, /Imported from Volanta/);
});

test('an ELEVATEX flights CSV with its own headers and DD/MM/YYYY works', () => {
  const flights = flightsFromCsv(ELEVATEX, 'ELEVATEX');
  assert.equal(flights.length, 2);
  assert.equal(flights[0].depAirport, 'EGLL');
  assert.equal(flights[0].arrAirport, 'EDDF');
  assert.equal(flights[0].startTime, Date.UTC(2026, 2, 15, 8, 20), 'day-first dates are read as written');
  assert.equal(flights[0].endTime - flights[0].startTime, 65 * 60000, 'a clock duration fills the end time');
  assert.equal(flights[1].distanceNm, 295);
});

test('quoted fields keep their commas and empty rows are ignored', () => {
  const flights = flightsFromCsv(VOLANTA, 'Volanta');
  assert.match(flights[1].notes, /DCT JFK, DCT LAX/, 'the quoted route survives');
  assert.equal(parseCsv('a,b\n"x, y",z\n').length, 2);
  const rows = parseCsv('Origin,Destination\nEGLL,KBOS\n\n,\n');
  const kept = flightsFromCsv('Origin,Destination\nEGLL,KBOS\n,\n', 'Volanta');
  assert.equal(rows.length, 2, 'a blank line and an all-empty row are dropped');
  assert.equal(kept.length, 1, 'a row with no airport is not turned into a flight');
});

test('a Volanta-style JSON export is read too', () => {
  const flights = flightsFromJson(JSON.stringify({
    flights: [
      { origin: { icao: 'KJFK' }, destination: { icao: 'KLAX' }, departureTime: '2026-04-02T10:00:00Z', duration: '5h 40m', aircraft: 'A320', callsign: 'DAL410' },
      { origin: 'EGPH', destination: 'EGLL', departureTime: '2026-04-03T07:00:00Z', arrivalTime: '2026-04-03T08:15:00Z', aircraft: 'A21N' },
    ],
  }), 'Volanta');
  assert.equal(flights.length, 2);
  assert.equal(flights[0].depAirport, 'KJFK');
  assert.equal(flights[0].arrAirport, 'KLAX');
  assert.equal(flights[0].endTime - flights[0].startTime, 340 * 60000, 'an hours-and-minutes duration is understood');
  assert.equal(flights[1].arrAirport, 'EGLL');
});

test('re-importing the same export produces the same record ids', () => {
  const a = flightsFromCsv(VOLANTA, 'Volanta');
  const b = flightsFromCsv(VOLANTA, 'Volanta');
  assert.deepEqual(a.map(f => f.id), b.map(f => f.id), 'ids are stable, so a second import merges instead of duplicating');
  assert.notEqual(a[0].id, a[1].id);
});

test('duration, distance units, dates and source naming are understood honestly', () => {
  assert.equal(parseDuration('6:45'), 405);
  assert.equal(parseDuration('1:05:30'), 66);
  assert.equal(parseDuration('95'), 95);
  assert.equal(parseDuration('2h 10m'), 130);
  assert.equal(parseDuration(''), null);
  assert.equal(parseDate('2026-03-01T09:30:00Z'), Date.parse('2026-03-01T09:30:00Z'));
  assert.equal(parseDate('15/03/2026 08:20'), Date.UTC(2026, 2, 15, 8, 20));
  assert.equal(parseDate('not a date'), null);
  const km = flightsFromCsv('Origin,Destination,DepartureTime,Distance\nEGLL,KBOS,2026-03-01T09:30:00Z,5500 km\n', 'Volanta');
  assert.equal(km[0].distanceNm, 2970, 'kilometres are converted to nautical miles');
  assert.equal(detectSource('volanta-flights.csv'), 'Volanta');
  assert.equal(detectSource('ELEVATEX_flights.csv'), 'ELEVATEX');
  assert.equal(detectSource('flights.csv'), 'flight log');
});

test('a file that cannot be a flight log says so instead of importing nothing quietly', () => {
  assert.throws(() => flightsFromCsv('Name,Age\nAlice,30\n', 'Volanta'), /no origin or destination column/);
  assert.throws(() => flightsFromJson('not json', 'Volanta'), /not valid JSON/);
  assert.throws(() => flightsFromJson('{"profile":{}}', 'Volanta'), /No flight list/);
  assert.equal(readFlightFile('Volanta.csv', VOLANTA).length, 2);
  assert.equal(readFlightFile('export.json', '{"flights":[{"origin":"EGLL","destination":"KBOS"}]}').length, 1);
});
