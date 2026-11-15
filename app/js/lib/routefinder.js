/* Real-world route ideas for the EFB Route Finder.
 *
 * FLYING NOW: live ADS-B aircraft of a type (adsb.lol, through the same proxy
 * the map uses), whose callsign is then looked up in adsbdb's route database
 * for its scheduled origin and destination.
 * All flights: every route an airline's callsigns are known to fly, from the
 * Virtual Radar Server standing data (updated daily), whether or not one is
 * airborne now. Block time is estimated from the great-circle distance and the
 * type's typical cruise speed; it is a planning figure, not the timetable.
 */

import { distanceNm } from './geo.js';

// Common airliner types searched when no type is chosen.
export const ROUTE_TYPES = [
  { code: 'A20N', label: 'Airbus A320neo' }, { code: 'A320', label: 'Airbus A320' },
  { code: 'A21N', label: 'Airbus A321neo' }, { code: 'A321', label: 'Airbus A321' },
  { code: 'A319', label: 'Airbus A319' }, { code: 'A333', label: 'Airbus A330-300' },
  { code: 'A359', label: 'Airbus A350-900' }, { code: 'A388', label: 'Airbus A380' },
  { code: 'B738', label: 'Boeing 737-800' }, { code: 'B38M', label: 'Boeing 737 MAX 8' },
  { code: 'B739', label: 'Boeing 737-900' }, { code: 'B752', label: 'Boeing 757-200' },
  { code: 'B763', label: 'Boeing 767-300' }, { code: 'B77W', label: 'Boeing 777-300ER' },
  { code: 'B789', label: 'Boeing 787-9' }, { code: 'E190', label: 'Embraer E190' },
  { code: 'E75L', label: 'Embraer E175' }, { code: 'CRJ9', label: 'Bombardier CRJ900' },
  { code: 'AT76', label: 'ATR 72-600' }, { code: 'DH8D', label: 'Dash 8 Q400' },
];
export const DEFAULT_TYPES = ['A20N', 'A320', 'A321', 'A21N', 'B738', 'B38M', 'B77W', 'B789'];

export const DURATIONS = [
  { id: 'any', label: 'Any', min: 0, max: Infinity },
  { id: 'lt1', label: '< 1 h', min: 0, max: 60 },
  { id: '1-2', label: '1–2 h', min: 60, max: 120 },
  { id: '2-4', label: '2–4 h', min: 120, max: 240 },
  { id: '4-8', label: '4–8 h', min: 240, max: 480 },
  { id: 'gt8', label: '8 h +', min: 480, max: Infinity },
];

/** 'BAW117' -> { callsign, airline: 'BAW', number: '117' }; general aviation and junk -> null. */
export function parseCallsign(raw) {
  const callsign = String(raw || '').trim().toUpperCase();
  const m = /^([A-Z]{3})(\d{1,4}[A-Z]{0,2})$/.exec(callsign);
  return m ? { callsign, airline: m[1], number: m[2] } : null;
}

const TURBOPROP = /^(AT[4-7]|DH8|SF34|JS4|B190|D328)/;
const REGIONAL = /^(CRJ|E1[3-9]|E7|E9|E29|BCS|A22)/;
const WIDEBODY = /^(A3[3-5]|A38|B7[4-8]|B76|B77|B78|IL96|MD11)/;
export function cruiseKt(type) {
  const t = String(type || '').toUpperCase();
  if (TURBOPROP.test(t)) return 270;
  if (REGIONAL.test(t)) return 420;
  if (WIDEBODY.test(t)) return 485;
  return 450;
}

/** Block minutes: airborne time at the type's cruise plus 25 minutes of taxi, climb and approach. */
export const blockMinutes = (nm, type) => Math.round((nm / cruiseKt(type)) * 60 + 25);

/** duration: a DURATIONS id, or [minMinutes, maxMinutes] from the slider. */
export function matchesDuration(minutes, duration) {
  if (Array.isArray(duration)) return minutes >= duration[0] && minutes <= duration[1];
  const d = DURATIONS.find(x => x.id === duration) || DURATIONS[0];
  return minutes >= d.min && minutes < d.max;
}

const airport = a => (a && /^[A-Z0-9]{4}$/.test(a.icao_code || '') && Number.isFinite(a.latitude) && Number.isFinite(a.longitude)
  ? { icao: a.icao_code, iata: a.iata_code || '', name: a.name || '', city: a.municipality || '', country: a.country_iso_name || '', lat: a.latitude, lon: a.longitude }
  : null);

/** adsbdb /v0/callsign answer -> { airlineName, origin, destination } or null. */
export function fromAdsbdb(json) {
  const r = json && json.response && json.response.flightroute;
  const origin = airport(r && r.origin);
  const destination = airport(r && r.destination);
  if (!origin || !destination || origin.icao === destination.icao) return null;
  return { airlineName: (r.airline && r.airline.name) || '', origin, destination };
}

/** Airline callsigns from adsb.lol /v2/type answers, de-duplicated, optionally one airline only. */
export function candidatesFrom(payloads, { airline = '' } = {}) {
  const want = String(airline || '').toUpperCase();
  const seen = new Map();
  for (const payload of payloads) {
    for (const ac of (payload && Array.isArray(payload.ac) ? payload.ac : [])) {
      const cs = parseCallsign(ac.flight);
      if (!cs || (want && cs.airline !== want) || seen.has(cs.callsign)) continue;
      seen.set(cs.callsign, { ...cs, type: String(ac.t || '').toUpperCase(), registration: String(ac.r || '') });
    }
  }
  return [...seen.values()];
}

/** SimBrief's dispatch page, prefilled (the documented redirect parameters). */
export function simbriefUrl(f) {
  const q = new URLSearchParams({ airline: f.airline, fltnum: f.number, ...(f.type ? { type: f.type } : {}), orig: f.origin.icao, dest: f.destination.icao });
  return `https://dispatch.simbrief.com/options/custom?${q}`;
}

const routeCache = new Map();

/**
 * Real flights matching the filters. fetchTraffic(url) answers adsb.lol JSON
 * (the page decides proxy or direct); fetchRoute(callsign) answers adsbdb JSON.
 */
export async function findRoutes({ type = '', airline = '', from = '', to = '', duration = 'any', fetchTraffic, fetchRoute, limit = 12, maxLookups = (from || to) ? 150 : 60, onProgress = () => {} }) {
  const types = type ? [String(type).toUpperCase()] : DEFAULT_TYPES;
  // One retry: the live feed refuses the odd request when several arrive at once.
  const live = url => fetchTraffic(url).catch(() => new Promise(r => setTimeout(r, 700)).then(() => fetchTraffic(url))).catch(() => null);
  const payloads = await Promise.all(types.map(t => live(`https://api.adsb.lol/v2/type/${encodeURIComponent(t)}`)));
  if (payloads.every(p => !p)) throw new Error('Live flight data is unavailable right now.');
  const pool = candidatesFrom(payloads, { airline });
  // Random order, so each search offers different ideas.
  for (let i = pool.length - 1; i > 0; i -= 1) { const j = Math.floor(Math.random() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
  const results = [];
  let looked = 0;
  for (let i = 0; i < pool.length && results.length < limit && looked < maxLookups; i += 6) {
    const batch = pool.slice(i, i + 6);
    looked += batch.length;
    const routes = await Promise.all(batch.map(async c => {
      // A callsign the database does not know stays cached as null; a failed lookup is forgotten so it is tried again.
      if (!routeCache.has(c.callsign)) routeCache.set(c.callsign, fetchRoute(c.callsign).then(fromAdsbdb).catch(() => { routeCache.delete(c.callsign); return null; }));
      return routeCache.get(c.callsign);
    }));
    batch.forEach((c, k) => {
      const r = routes[k];
      if (!r || results.length >= limit || (from && r.origin.icao !== from) || (to && r.destination.icao !== to)) return;
      const nm = Math.round(distanceNm(r.origin, r.destination));
      const minutes = blockMinutes(nm, c.type);
      if (matchesDuration(minutes, duration)) results.push({ ...c, ...r, distanceNm: nm, blockMinutes: minutes });
    });
    onProgress({ looked, found: results.length, pool: pool.length });
  }
  return { results, pool: pool.length, looked };
}

// ---- All flights: the VRS standing data (github.com/vradarserver/standing-data) ----
export const VRS = 'https://raw.githubusercontent.com/vradarserver/standing-data/main';
// Searched when no airline is chosen: large carriers across every region.
export const DEFAULT_AIRLINES = ['BAW', 'DLH', 'AFR', 'KLM', 'UAE', 'QTR', 'THY', 'DAL', 'AAL', 'UAL', 'SIA', 'QFA', 'ANA', 'CPA', 'EZY', 'RYR'];

const csvRows = text => String(text || '').replace(/^﻿/, '').split(/\r?\n/).slice(1).filter(Boolean).map(l => l.split(','));

/** An airline's route file -> one leg per row: { callsign, airline, number, from, to }. Multi-stop flights become their legs. */
export function parseVrsRoutes(text) {
  const legs = [];
  for (const [callsign, code, number, , codes = ''] of csvRows(text)) {
    if (!parseCallsign(callsign)) continue;
    const stops = codes.split('-').filter(c => /^[A-Z0-9]{4}$/.test(c));
    for (let i = 1; i < stops.length; i += 1) if (stops[i] !== stops[i - 1]) legs.push({ callsign, airline: code, number, from: stops[i - 1], to: stops[i] });
  }
  return legs;
}

/** An airports file (one ICAO prefix) -> Map of ICAO -> airport in the adsbdb shape used by the cards. */
export function parseVrsAirports(text) {
  const out = new Map();
  for (const [, name, icao, iata, city, country, lat, lon] of csvRows(text)) {
    const la = Number(lat), lo = Number(lon);
    if (/^[A-Z0-9]{4}$/.test(icao || '') && Number.isFinite(la) && Number.isFinite(lo)) out.set(icao, { icao, iata: iata || '', name: name || '', city: city || '', country: country || '', lat: la, lon: lo });
  }
  return out;
}

// shortcut: a type's routes are not in the data, so a chosen type only keeps legs it can plausibly fly (range by class); upgrade if a route-to-type source appears.
export function typeCanFly(type, nm) {
  const t = String(type || '').toUpperCase();
  if (!t) return true;
  if (TURBOPROP.test(t)) return nm <= 1000;
  if (REGIONAL.test(t)) return nm <= 2000;
  if (WIDEBODY.test(t)) return nm >= 1200;
  return nm <= 3500;
}

const vrsCache = new Map();
const cachedText = (url, fetchText) => {
  if (!vrsCache.has(url)) vrsCache.set(url, fetchText(url).catch(() => { vrsCache.delete(url); return null; }));
  return vrsCache.get(url);
};

/**
 * Real airline routes matching the filters, airborne now or not.
 * fetchText(url) answers the file's text; a 404 should answer null.
 */
export async function findAllRoutes({ type = '', airline = '', from = '', to = '', duration = 'any', fetchText, limit = 12, onProgress = () => {} }) {
  const airlines = airline ? [String(airline).toUpperCase()] : DEFAULT_AIRLINES;
  const files = await Promise.all(airlines.map(a => cachedText(`${VRS}/routes/schema-01/${a[0]}/${a}-all.csv`, fetchText)));
  if (files.every(f => f === null) && !airline) throw new Error('Route data is unavailable right now.');
  const pool = files.flatMap(f => parseVrsRoutes(f)).filter(l => (!from || l.from === from) && (!to || l.to === to));
  for (let i = pool.length - 1; i > 0; i -= 1) { const j = Math.floor(Math.random() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
  const airports = new Map();
  const airportFor = async icao => {
    const url = `${VRS}/airports/schema-01/${icao[0]}/${icao.slice(0, 2)}.csv`;
    if (!airports.has(url)) airports.set(url, cachedText(url, fetchText).then(parseVrsAirports));
    return (await airports.get(url)).get(icao) || null;
  };
  const results = [];
  let looked = 0;
  const seen = new Set();
  for (let i = 0; i < pool.length && results.length < limit && looked < 400; i += 12) {
    const batch = pool.slice(i, i + 12).filter(l => !seen.has(l.callsign) && seen.add(l.callsign));
    looked += batch.length;
    const found = await Promise.all(batch.map(async l => [l, await airportFor(l.from), await airportFor(l.to)]));
    for (const [l, origin, destination] of found) {
      if (!origin || !destination || results.length >= limit) continue;
      const nm = Math.round(distanceNm(origin, destination));
      const minutes = blockMinutes(nm, type);
      if (typeCanFly(type, nm) && matchesDuration(minutes, duration)) results.push({ callsign: l.callsign, airline: l.airline, number: l.number, type: String(type || '').toUpperCase(), registration: '', airlineName: '', origin, destination, distanceNm: nm, blockMinutes: minutes });
    }
    onProgress({ looked, found: results.length, pool: pool.length });
  }
  return { results, pool: pool.length, looked };
}
