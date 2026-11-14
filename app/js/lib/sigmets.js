/* SIGMETs and G-AIRMETs from the NOAA Aviation Weather Center data API.
 *
 * The bridge (/sigmets) and the hosted proxy (/api/sigmets) pass the three
 * upstream feeds through untouched as { airsigmet, isigmet, gairmet }; this
 * module is the one place they are interpreted:
 *
 *   airsigmet — US SIGMETs and convective SIGMETs
 *   isigmet   — international SIGMETs, by FIR
 *   gairmet   — US G-AIRMETs (the current snapshot, fore=0)
 *
 * An advisory is kept only with a polygon and a validity window that has not
 * ended. Freezing-level contours in the G-AIRMET feed are lines, not hazard
 * areas, and are left out. Nothing is inferred from the raw text.
 */

import { destination, distanceNm, bearingDeg } from './geo.js';

export const SIGMET_FEEDS = {
  airsigmet: 'https://aviationweather.gov/api/data/airsigmet?format=json',
  isigmet: 'https://aviationweather.gov/api/data/isigmet?format=json',
  gairmet: 'https://aviationweather.gov/api/data/gairmet?format=json&fore=0',
};

const HAZARDS = {
  TS: 'Thunderstorms', CONVECTIVE: 'Convective', TURB: 'Turbulence', 'TURB-HI': 'Turbulence (high)',
  'TURB-LO': 'Turbulence (low)', ICE: 'Icing', VA: 'Volcanic ash', MTW: 'Mountain waves',
  IFR: 'IFR conditions', MT_OBSC: 'Mountain obscuration', SFC_WND: 'Strong surface wind',
  LLWS: 'Low-level wind shear', TC: 'Tropical cyclone', DS: 'Dust storm', SS: 'Sandstorm',
  RDOACT: 'Radioactive cloud', IFR_CIG: 'IFR ceiling',
};

export const hazardLabel = code => HAZARDS[String(code || '').toUpperCase()] || String(code || 'Hazard');

const num = value => (value == null || value === '' || value === 'None' ? null : (Number.isFinite(Number(value)) ? Number(value) : null));
const epochMs = value => {
  if (value == null || value === '') return null;
  if (typeof value === 'number' || /^\d+$/.test(String(value))) return Number(value) * 1000;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
};

/**
 * A ring with its longitudes unwrapped: no step between neighbours exceeds
 * 180 deg, so an area across the antimeridian keeps going past +/-180 instead
 * of jumping to the other side of the world.
 */
function ring(coords) {
  const points = (Array.isArray(coords) ? coords : [])
    .map(point => ({ lat: num(point && point.lat), lon: num(point && point.lon) }))
    .filter(point => point.lat != null && point.lon != null);
  for (let i = 1; i < points.length; i += 1) {
    while (points[i].lon - points[i - 1].lon > 180) points[i].lon -= 360;
    while (points[i].lon - points[i - 1].lon < -180) points[i].lon += 360;
  }
  return points;
}

/** The point moved by whole turns of longitude to sit beside a ring's first vertex. */
const besideRing = (point, poly) => ({ lat: point.lat, lon: point.lon + 360 * Math.round((poly[0].lon - point.lon) / 360) });

/** coords is a ring, or (multi-area SIGMETs) a list of rings. */
function polygons(coords) {
  if (!Array.isArray(coords) || !coords.length) return [];
  const rings = Array.isArray(coords[0]) ? coords.map(ring) : [ring(coords)];
  return rings.filter(r => r.length >= 3);
}

// G-AIRMET levels are hundreds of feet ("060"), or SFC.
const gairmetLevel = value => (String(value || '').toUpperCase() === 'SFC' ? 0 : (num(value) == null ? null : num(value) * 100));

export function normaliseAdvisories(feeds, now = Date.now()) {
  const out = [];
  const add = item => {
    if (!item.polygons.length) return;
    if (item.toMs != null && item.toMs <= now) return;
    out.push(item);
  };
  for (const s of Array.isArray(feeds && feeds.airsigmet) ? feeds.airsigmet : []) {
    const lows = [num(s.altitudeLow1), num(s.altitudeLow2)].filter(v => v != null);
    const highs = [num(s.altitudeHi1), num(s.altitudeHi2)].filter(v => v != null);
    const convective = String(s.hazard).toUpperCase() === 'CONVECTIVE';
    add({
      kind: convective ? 'Convective SIGMET' : String(s.airSigmetType || 'SIGMET').toUpperCase() === 'AIRMET' ? 'AIRMET' : 'SIGMET',
      hazard: String(s.hazard || ''), label: hazardLabel(s.hazard), area: s.seriesId ? `${s.seriesId}` : 'United States',
      fromMs: epochMs(s.validTimeFrom), toMs: epochMs(s.validTimeTo),
      baseFt: lows.length ? Math.min(...lows) : null, topFt: highs.length ? Math.max(...highs) : null,
      polygons: polygons(s.coords), raw: String(s.rawAirSigmet || ''),
    });
  }
  for (const s of Array.isArray(feeds && feeds.isigmet) ? feeds.isigmet : []) {
    add({
      kind: 'SIGMET', hazard: String(s.hazard || ''),
      label: hazardLabel(s.hazard) + (s.qualifier && s.qualifier !== 'None' ? ` · ${String(s.qualifier).toLowerCase()}` : ''),
      area: String(s.firName || s.firId || ''), fromMs: epochMs(s.validTimeFrom), toMs: epochMs(s.validTimeTo),
      baseFt: num(s.base), topFt: num(s.top), polygons: polygons(s.coords), raw: String(s.rawSigmet || ''),
    });
  }
  for (const s of Array.isArray(feeds && feeds.gairmet) ? feeds.gairmet : []) {
    if (String(s.geom || s.geometryType).toUpperCase() !== 'AREA') continue; // LINE = freezing-level contour
    if (/FZLVL/.test(String(s.hazard))) continue;
    add({
      kind: 'G-AIRMET', hazard: String(s.hazard || ''), label: hazardLabel(s.hazard),
      area: `${s.product || ''} ${s.tag || ''}`.trim(), fromMs: epochMs(s.validTime), toMs: epochMs(s.expireTime),
      baseFt: gairmetLevel(s.base), topFt: gairmetLevel(s.top), polygons: polygons(s.coords), raw: '',
    });
  }
  return out;
}

/** Ray casting in lat/lon, on a ring from ring() (longitudes unwrapped). */
export function insidePolygon(point, poly) {
  if (!poly.length) return false;
  point = besideRing(point, poly);
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i, i += 1) {
    const a = poly[i];
    const b = poly[j];
    if ((a.lat > point.lat) !== (b.lat > point.lat)
      && point.lon < ((b.lon - a.lon) * (point.lat - a.lat)) / (b.lat - a.lat) + a.lon) inside = !inside;
  }
  return inside;
}

/** Nautical miles from a point to a polygon's edge (equirectangular, fine at advisory scale). */
function edgeDistanceNm(point, poly) {
  point = besideRing(point, poly);
  const kx = 60 * Math.cos((point.lat * Math.PI) / 180);
  const local = p => ({ x: (p.lon - point.lon) * kx, y: (p.lat - point.lat) * 60 });
  let best = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i, i += 1) {
    const a = local(poly[j]);
    const b = local(poly[i]);
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = dx * dx + dy * dy;
    const t = len ? Math.max(0, Math.min(1, -(a.x * dx + a.y * dy) / len)) : 0;
    best = Math.min(best, Math.hypot(a.x + dx * t, a.y + dy * t));
  }
  return best;
}

/** Route points every `stepNm` along each great-circle leg. */
export function sampleRoute(points, stepNm = 10) {
  const list = (points || []).filter(p => p && Number.isFinite(p.lat) && Number.isFinite(p.lon));
  const out = list.slice(0, 1);
  for (let i = 1; i < list.length; i += 1) {
    const a = list[i - 1];
    const b = list[i];
    const legNm = distanceNm(a, b);
    const course = bearingDeg(a, b);
    for (let d = stepNm; d < legNm; d += stepNm) out.push(destination(a, course, d));
    out.push(b);
  }
  return out;
}

/** Advisories whose area contains, or lies within marginNm of, any of the points. */
export function advisoriesNear(advisories, points, marginNm = 25) {
  const samples = sampleRoute(points);
  if (!samples.length) return [];
  return (advisories || []).filter(item => item.polygons.some(poly => samples.some(p => insidePolygon(p, poly) || edgeDistanceNm(p, poly) <= marginNm)));
}
