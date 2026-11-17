/* Airspace for the map's Airspaces layer, from two sources in one shape:
 *   - the simulator's own airspace file (X-Plane OpenAir, served by the bridge),
 *   - the FAA's public-domain Class Airspace and Special Use Airspace services
 *     (United States only), so pilots without the bridge still see US airspace.
 * Every area becomes { cls, name, lower, upper, rings: [[[lon, lat], ...]], times }.
 */

const FAA_BASE = 'https://services6.arcgis.com/ssFJjBXIUyZDrSYZ/arcgis/rest/services/';

/** Classes and types the layer draws, with their chart style. */
export const STYLES = {
  B: { stroke: '#3b82f6', fill: 'rgba(59,130,246,.10)', width: 2.2, dash: [] },
  C: { stroke: '#d946ef', fill: 'rgba(217,70,239,.09)', width: 2, dash: [] },
  D: { stroke: '#3b82f6', fill: 'rgba(59,130,246,.05)', width: 1.6, dash: [7, 5] },
  CTR: { stroke: '#3b82f6', fill: 'rgba(59,130,246,.05)', width: 1.6, dash: [7, 5] },
  E: { stroke: '#d946ef', fill: '', width: 1.2, dash: [4, 4] },
  R: { stroke: '#ef4444', fill: 'rgba(239,68,68,.08)', width: 1.8, dash: [10, 4] },
  P: { stroke: '#dc2626', fill: 'rgba(220,38,38,.12)', width: 2, dash: [] },
  Q: { stroke: '#f97316', fill: 'rgba(249,115,22,.07)', width: 1.6, dash: [10, 4] },
  W: { stroke: '#a16207', fill: 'rgba(161,98,7,.06)', width: 1.4, dash: [10, 4] },
  MOA: { stroke: '#b45309', fill: 'rgba(180,83,9,.05)', width: 1.4, dash: [12, 5] },
  A: { stroke: '#b45309', fill: 'rgba(180,83,9,.05)', width: 1.4, dash: [12, 5] },
};

/** Draw order: wide, soft areas first, the busiest control zones last. */
export const ORDER = ['MOA', 'W', 'A', 'Q', 'E', 'D', 'CTR', 'C', 'B', 'R', 'P'];

/** 'SFC', '4000 ft', 'FL65', '2500 AGL' from the FAA's value, unit and reference. */
export function faaLimit(value, uom, code) {
  const v = Number(value);
  const c = String(code || '').toUpperCase();
  if (v < 0) return 'UNL'; // the FAA writes -9998 where no limit is published
  if (c === 'SFC' || (!v && c !== 'STD')) return 'SFC';
  if (String(uom).toUpperCase() === 'FL' || c === 'STD') return 'FL' + Math.round(v);
  if (c === 'AGL') return v + ' AGL';
  return v + ' ft';
}

/** An OpenAir limit ('SFC', 'GND', '4000ft MSL', 'FL65', 'UNLTD') tidied for a label. */
export function openAirLimit(text) {
  const t = String(text || '').trim().toUpperCase();
  if (!t || t === 'GND' || t === 'SFC' || t === '0') return 'SFC';
  if (/^FL\s*\d+/.test(t)) return t.replace(/\s+/g, '');
  if (/UNL/.test(t)) return 'UNL';
  const m = /^(\d+)\s*(FT)?\s*(MSL|AMSL|AGL|AAL|SFC|GND)?/.exec(t);
  if (!m) return t;
  return /AGL|AAL|SFC|GND/.test(m[3] || '') ? m[1] + ' AGL' : m[1] + ' ft';
}

/** Rings from a GeoJSON Polygon or MultiPolygon, as [[lon, lat], ...]. */
function ringsOf(geometry) {
  if (!geometry) return [];
  if (geometry.type === 'Polygon') return geometry.coordinates.slice(0, 1);
  if (geometry.type === 'MultiPolygon') return geometry.coordinates.map(poly => poly[0]);
  return [];
}

/** One FAA feature (Class_Airspace or Special_Use_Airspace) in the layer's shape. */
export function fromFaa(feature) {
  const p = feature && feature.properties || {};
  const type = String(p.TYPE_CODE || '').toUpperCase();
  const local = String(p.LOCAL_TYPE || '').toUpperCase();
  let cls = String(p.CLASS || '').toUpperCase();
  if (type === 'MOA') cls = 'MOA';
  else if (type === 'R' || type === 'RESTRICTED' || /^R-/.test(p.NAME || '')) cls = 'R';
  else if (type === 'P' || type === 'PROHIBITED') cls = 'P';
  else if (type === 'W' || type === 'WARNING') cls = 'W';
  else if (type === 'A' || type === 'ALERT') cls = 'A';
  else if (type === 'D' || type === 'DANGER') cls = 'Q';
  if (cls === 'E' && !/CLASS_E[24]$/.test(local)) return null; // surface areas only; the rest blankets the map
  if (!STYLES[cls]) return null;
  const rings = ringsOf(feature.geometry).filter(r => r && r.length >= 3);
  if (!rings.length) return null;
  return {
    cls,
    name: String(p.NAME || '').trim(),
    lower: faaLimit(p.LOWER_VAL, p.LOWER_UOM, p.LOWER_CODE),
    upper: faaLimit(p.UPPER_VAL, p.UPPER_UOM, p.UPPER_CODE),
    rings,
    times: String(p.TIMESOFUSE || '').trim(),
    source: 'FAA',
  };
}

/** One area from the bridge (OpenAir points are [lat, lon]). */
export function fromSim(area) {
  const cls = String(area && area.class || '').toUpperCase();
  if (!STYLES[cls] || cls === 'A') return null; // OpenAir A is Class A, not an alert area
  const ring = (area.points || []).map(p => [p[1], p[0]]);
  if (ring.length < 3) return null;
  return { cls, name: String(area.name || '').trim(), lower: openAirLimit(area.lower), upper: openAirLimit(area.upper), rings: [ring], times: '', source: 'sim' };
}

/** Whether a box (south, west, north, east) touches the FAA's coverage. */
export function inFaaCoverage([s, w, n, e]) {
  const box = (S, W, N, E) => s <= N && n >= S && w <= E && e >= W;
  return box(17, -180, 72, -60) || box(13, 144, 16, 146) || box(18, -161, 23, -154);
}

/** The FAA query for one service and box, simplified for the zoom. */
export function faaUrl(service, [s, w, n, e], tolerance = 0.002) {
  const where = service === 'Class_Airspace'
    ? "CLASS IN ('B','C','D') OR LOCAL_TYPE IN ('CLASS_E2','CLASS_E4')"
    : '1=1';
  const q = new URLSearchParams({
    where,
    geometry: [w, s, e, n].join(','),
    geometryType: 'esriGeometryEnvelope',
    inSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    outFields: '*', // the two services differ in their fields (only Special Use has times of use)
    outSR: '4326',
    maxAllowableOffset: String(tolerance),
    geometryPrecision: '5',
    resultRecordCount: '600',
    f: 'geojson',
  });
  return FAA_BASE + service + '/FeatureServer/0/query?' + q.toString();
}

/** A short label, written the way charts do: class 'C', limits 'SFC–4000'. */
export function labelFor(area) {
  const short = text => String(text).replace(/ ft$/, '');
  return { cls: area.cls, limits: short(area.lower) + '–' + short(area.upper) };
}
