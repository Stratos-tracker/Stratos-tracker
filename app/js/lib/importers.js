/* Import a flight history from another tracker.
 *
 * Volanta exports a CSV with Origin, Destination, DepartureTime, Duration,
 * Airline, Callsign, FlightNumber, AircraftType, AircraftRegistration, Route,
 * ArrivalTime, Distance and Fuel; its older JSON export carries the same
 * flights. ELEVATEX exports a CSV set whose flights.csv holds the same facts
 * under its own column names.
 *
 * Neither export is a published contract — Volanta's changed shape several
 * times in a single day — so columns are matched by meaning, not by position,
 * and a row that yields no origin and no destination is counted and dropped
 * instead of guessed at.
 *
 * What is imported is what the file states. Times are the export's block
 * times, so they fill start/end and the logbook's own duration maths reads
 * them; landing rate, altitude and track are left empty rather than invented,
 * and the detail view already says "not measured" for those.
 */

const FIELDS = {
  origin: ['origin', 'originicao', 'originairport', 'departure', 'departureairport', 'departureicao', 'dep', 'depicao', 'dpt', 'dptairport', 'from'],
  destination: ['destination', 'destinationicao', 'destinationairport', 'arrival', 'arrivalairport', 'arrivalicao', 'arr', 'arricao', 'to'],
  departureTime: ['departuretime', 'departuredate', 'departureutc', 'departed', 'starttime', 'start', 'date', 'blockoff', 'blockofftime', 'offblock'],
  arrivalTime: ['arrivaltime', 'arrivaldate', 'arrivalutc', 'arrived', 'endtime', 'end', 'blockon', 'blockontime', 'onblock'],
  duration: ['duration', 'durationminutes', 'flighttime', 'airborne', 'blocktime', 'timeenroute', 'totaltime', 'elapsed'],
  aircraft: ['aircrafttype', 'aircraft', 'aircraftmodel', 'type', 'equipment', 'plane', 'model'],
  registration: ['aircraftregistration', 'registration', 'tail', 'tailnumber', 'reg', 'acreg'],
  callsign: ['callsign', 'flightnumber', 'flightno', 'flight', 'ident', 'flightid'],
  distance: ['distance', 'dist', 'distanceflown', 'nm', 'nauticalmiles', 'miles'],
  route: ['route', 'routing', 'waypoints'],
};

const SOURCES = [
  ['elevatex', 'ELEVATEX'],
  ['volanta', 'Volanta'],
];

/** "Volanta", "ELEVATEX" or a neutral label, from the file name. */
export function detectSource(name) {
  const lower = String(name || '').toLowerCase();
  for (const [needle, label] of SOURCES) if (lower.includes(needle)) return label;
  return 'flight log';
}

/* ── CSV ────────────────────────────────────────────────────────────── */

/** Rows of cells, honouring quoted fields, escaped quotes and CRLF. */
export function parseCsv(text) {
  const source = String(text || '').replace(/^\uFEFF/, '');
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < source.length; i += 1) {
    const character = source[i];
    if (quoted) {
      if (character === '"') {
        if (source[i + 1] === '"') { field += '"'; i += 1; }
        else quoted = false;
      } else field += character;
    } else if (character === '"') quoted = true;
    else if (character === ',') { row.push(field); field = ''; }
    else if (character === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (character !== '\r') field += character;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter(cells => cells.some(cell => String(cell).trim() !== ''));
}

function fieldFor(cell) {
  const key = String(cell || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!key) return '';
  for (const [field, names] of Object.entries(FIELDS)) if (names.includes(key)) return field;
  return '';
}

/* ── Values ─────────────────────────────────────────────────────────── */

/** Epoch ms from ISO 8601, DD/MM/YYYY (the order these exports write), or ms. */
export function parseDate(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  if (/^\d{4}-\d{2}-\d{2}([T ]|$)/.test(raw)) {
    const iso = raw.includes('T') ? raw : raw.replace(' ', 'T');
    const withZone = /(?:Z|[+-]\d{2}:?\d{2})$/.test(iso) ? iso : `${iso}Z`;
    const ms = Date.parse(withZone);
    return Number.isFinite(ms) ? ms : null;
  }
  const parts = raw.match(/^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{4})(?:[ ,T]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (parts) {
    const ms = Date.UTC(+parts[3], +parts[2] - 1, +parts[1], +(parts[4] || 0), +(parts[5] || 0), +(parts[6] || 0));
    return Number.isFinite(ms) ? ms : null;
  }
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : null;
}

/** Minutes from "6:45", "6:45:30", "1h 20m", "95" or "95 minutes". */
export function parseDuration(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const clock = raw.match(/^(\d+):(\d{2})(?::(\d{2}))?$/);
  if (clock) return Math.round(+clock[1] * 60 + +clock[2] + (+(clock[3] || 0)) / 60);
  const labelled = raw.match(/^(?:(\d+)\s*h(?:ours?|rs?)?)?\s*(?:(\d+)\s*m(?:in(?:utes?)?)?)?$/i);
  if (labelled && (labelled[1] || labelled[2])) return (+labelled[1] || 0) * 60 + (+labelled[2] || 0);
  const plain = raw.match(/^(\d+(?:\.\d+)?)\s*(min(?:utes?)?|m|h(?:ours?|rs?)?)?$/i);
  if (plain) {
    const n = +plain[1];
    const unit = (plain[2] || 'min').toLowerCase();
    return Math.round(unit.startsWith('h') ? n * 60 : n);
  }
  return null;
}

/** Nautical miles from "2980nm", "5500 km" or a bare number. */
function parseDistance(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const parts = raw.match(/^([\d.,]+)\s*(nm|nmi|nautical\s*miles|km|mi|miles|statute\s*miles)?/i);
  if (!parts) return null;
  let text = parts[1];
  text = /^\d{1,3}(,\d{3})+(\.\d+)?$/.test(text) ? text.replace(/,/g, '') : text.replace(',', '.');
  let n = Number(text);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = (parts[2] || 'nm').toLowerCase().replace(/\s+/g, '');
  if (unit === 'km') n /= 1.852;
  else if (unit === 'mi' || unit === 'miles' || unit === 'statutemiles') n /= 1.15078;
  return Math.round(n);
}

/** "London (EGLL)" -> EGLL; an object with icao/iata -> that code. */
function airportCode(value) {
  const fromObject = value && typeof value === 'object' ? (value.icao || value.iata || value.code || value.id || '') : value;
  const raw = String(fromObject ?? '').trim().toUpperCase();
  if (!raw) return '';
  const token = raw.match(/\b([A-Z]{3,4})\b/);
  if (token) return token[1];
  const bare = raw.replace(/[^A-Z0-9]/g, '');
  return bare.length >= 3 && bare.length <= 4 ? bare : '';
}

function hash34(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

/* ── Record ─────────────────────────────────────────────────────────── */

function toFlight(values, source) {
  const depAirport = airportCode(values.origin);
  const arrAirport = airportCode(values.destination);
  if (!depAirport && !arrAirport) return null;

  const duration = parseDuration(values.duration);
  const startFile = parseDate(values.departureTime);
  const endFile = parseDate(values.arrivalTime);
  const startTime = startFile ?? (endFile != null && duration != null ? endFile - duration * 60000 : null);
  const endTime = endFile ?? (startTime != null && duration != null ? startTime + duration * 60000 : null);

  const callsign = String(values.callsign ?? '').trim().toUpperCase();
  const aircraft = String(values.aircraft ?? '').trim().toUpperCase();
  const registration = String(values.registration ?? '').trim().toUpperCase();
  const distanceNm = parseDistance(values.distance);
  const route = String(values.route ?? '').trim();

  const id = `import-${source.toLowerCase().replace(/[^a-z0-9]+/g, '')}-${hash34([
    source, depAirport, arrAirport, startTime || '', callsign, aircraft || registration,
  ].join('|'))}`;

  const flight = {
    id,
    recordedBy: 'import',
    source,
    sim: 'unknown',
    depAirport,
    arrAirport,
    callsign,
    aircraft,
    registration,
    notes: `Imported from ${source}.`,
  };
  if (startTime != null) flight.startTime = startTime;
  if (endTime != null) flight.endTime = endTime;
  if (distanceNm != null) flight.distanceNm = distanceNm;
  if (route) flight.notes = `Imported from ${source}. Route: ${route.slice(0, 180)}`;
  if (startTime == null && endTime == null) flight.incomplete = true;
  return flight;
}

function valuesFromRow(cells, fields) {
  const values = {};
  cells.forEach((cell, index) => {
    const field = fields[index];
    // First column wins: a Callsign column is more specific than FlightNumber,
    // and either is a better identifier than a later duplicate header.
    if (field && values[field] == null) values[field] = cell;
  });
  return values;
}

function valuesFromObject(entry) {
  const values = {};
  for (const [key, value] of Object.entries(entry)) {
    const field = fieldFor(key);
    if (field && values[field] == null) values[field] = value;
  }
  if (values.origin == null && entry.origin && typeof entry.origin === 'object') values.origin = entry.origin;
  if (values.destination == null && entry.destination && typeof entry.destination === 'object') values.destination = entry.destination;
  return values;
}

/** Flights from a CSV export; rows without any airport are dropped. */
export function flightsFromCsv(text, source = 'flight log') {
  const rows = parseCsv(text);
  if (rows.length < 2) return [];
  const fields = rows[0].map(fieldFor);
  if (!fields.some(field => field === 'origin' || field === 'destination')) {
    throw new Error('That CSV has no origin or destination column.');
  }
  const flights = [];
  for (const row of rows.slice(1)) {
    const flight = toFlight(valuesFromRow(row, fields), source);
    if (flight) flights.push(flight);
  }
  return flights;
}

/** Flights from a JSON export: a bare array, or an object holding one. */
export function flightsFromJson(text, source = 'flight log') {
  let data;
  try {
    data = JSON.parse(text);
  } catch (_) {
    throw new Error('That file is not valid JSON.');
  }
  const list = Array.isArray(data) ? data
    : Array.isArray(data?.flights) ? data.flights
      : Array.isArray(data?.items) ? data.items
        : Array.isArray(data?.data) ? data.data
          : null;
  if (!list) throw new Error('No flight list was found in that JSON file.');
  const flights = [];
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const flight = toFlight(valuesFromObject(entry), source);
    if (flight) flights.push(flight);
  }
  return flights;
}

/** Read a Volanta or ELEVATEX export by name and content. */
export function readFlightFile(name, text) {
  const source = detectSource(name);
  const body = String(text ?? '');
  const looksJson = /\.json$/i.test(String(name || '')) || /^\s*[[{]/.test(body);
  return looksJson ? flightsFromJson(body, source) : flightsFromCsv(body, source);
}
