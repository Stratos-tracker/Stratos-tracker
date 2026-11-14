/* The chart clipboard and the flight-phase chart choice for the EFB.
 *
 * Clipboard: the charts a pilot pins for one flight (departure → arrival), kept
 * on this device, so the documents for the flight are one tap away.
 *
 * Auto: which chart the current phase calls for. On the ground before takeoff
 * the departure diagram, in the climb the SID, in the descent the STAR and,
 * below 10,000 ft, the approach, on the ground after landing the arrival
 * diagram. Pinned charts win; otherwise the airport's catalogue supplies the
 * first chart of that kind. The cruise asks for nothing, so the open chart stays.
 */

export const CLIP_KEY = 'stratos.efb.charts.clip';
export const APPROACH_FAMILIES = ['ils', 'loc', 'rnav', 'vor', 'ndb', 'approach', 'visual'];

/** One clipboard per flight; without a plan, one shared list. */
export function flightKey(dep, arr) {
  const a = String(dep || '').toUpperCase();
  const b = String(arr || '').toUpperCase();
  return a || b ? `${a || '----'}-${b || '----'}` : 'no-plan';
}

export const chartId = chart => `${String(chart.icao || '').toUpperCase()}|${chart.pdf || chart.url || chart.title || ''}`;

/** The kind a chart serves for phase selection, or '' for anything else. */
export function chartKind(chart) {
  const category = String((chart && chart.category) || '').toLowerCase();
  if (category === 'diagram' || category === 'sid' || category === 'star') return category;
  if (APPROACH_FAMILIES.includes(category) || (chart && chart.approach)) return 'approach';
  return '';
}

export function readClip(storage, key) {
  try {
    const all = JSON.parse(storage.getItem(CLIP_KEY) || '{}');
    const list = all && Array.isArray(all[key]) ? all[key] : [];
    return list.filter(chart => chart && chart.icao && (chart.pdf || chart.url));
  } catch (_) {
    return [];
  }
}

export function writeClip(storage, key, list) {
  try {
    const all = JSON.parse(storage.getItem(CLIP_KEY) || '{}') || {};
    all[key] = list.slice(0, 24);
    // Keep the six most recently written flights; older clipboards are dropped.
    const keys = Object.keys(all);
    if (keys.length > 6) for (const old of keys.filter(k => k !== key).slice(0, keys.length - 6)) delete all[old];
    storage.setItem(CLIP_KEY, JSON.stringify(all));
  } catch (_) { /* private mode: the clipboard lasts the session */ }
}

/** Pin or unpin; returns the new list. */
export function toggleClip(list, chart) {
  const id = chartId(chart);
  return list.some(item => chartId(item) === id)
    ? list.filter(item => chartId(item) !== id)
    : [...list, chart];
}

export const isPinned = (list, chart) => Boolean(chart) && list.some(item => chartId(item) === chartId(chart));

/**
 * What the phase calls for: { role: 'DEP'|'ARR', kind } or null.
 * phase is inferPhase()'s key; altFt the aircraft's altitude.
 */
export function wantedChart(phase, altFt) {
  switch (phase) {
    case 'parked': case 'taxi': case 'takeoff': return { role: 'DEP', kind: 'diagram' };
    case 'climb': return { role: 'DEP', kind: 'sid' };
    case 'descent': return { role: 'ARR', kind: Number(altFt) <= 10000 ? 'approach' : 'star' };
    case 'afterLanding': return { role: 'ARR', kind: 'diagram' };
    default: return null;
  }
}

/** A pinned chart for that airport and kind, else the first in the catalogue. */
export function pickChart(want, icao, clip, catalogueCharts = []) {
  if (!want || !icao) return null;
  const code = String(icao).toUpperCase();
  const pinned = clip.find(chart => String(chart.icao).toUpperCase() === code && chartKind(chart) === want.kind);
  if (pinned) return pinned;
  return catalogueCharts.find(chart => chartKind(chart) === want.kind) || null;
}
