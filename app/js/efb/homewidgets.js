/* EFB home widgets: the pure parts, so the page and the tests read them the same
 * way. The deck draws them; nothing here touches the DOM.
 */

export const HOME_LAYOUT_KEY = 'stratos.efb.home';

/* Every widget the deck can show, in gallery order. `wide` widgets span the
   column; the airport clocks sit side by side. */
export const WIDGETS = [
  { id: 'flight', name: 'Flight tracking', wide: true },
  { id: 'dep', name: 'Departure airport time' },
  { id: 'arr', name: 'Arrival airport time' },
  { id: 'navigator', name: 'Navigator', wide: true },
  { id: 'clock', name: 'UTC and local clock', wide: true },
];
export const DEFAULT_WIDGETS = ['flight', 'dep', 'arr'];

/** The saved layout, with unknown ids dropped and missing apps appended. An
 *  app in the dock is not on the home screen as well, as on an iPad. */
export function readLayout(raw, appIds, dockIds = []) {
  let saved = {};
  try { saved = raw ? JSON.parse(raw) : {}; } catch (_) { saved = {}; }
  const known = new Set(WIDGETS.map(w => w.id));
  const widgets = Array.isArray(saved.widgets)
    ? [...new Set(saved.widgets.filter(id => known.has(id)))]
    : DEFAULT_WIDGETS.slice();
  const order = Array.isArray(saved.apps) ? saved.apps.filter(id => appIds.includes(id)) : [];
  const apps = [...new Set(order), ...appIds.filter(id => !order.includes(id))];
  const dock = [...new Set((Array.isArray(saved.dock) ? saved.dock : dockIds).filter(id => appIds.includes(id)))];
  return { widgets, apps, dock };
}

/** SimBrief's airport UTC offset in hours as a clock label: +1, -9, +5:30. */
export function offsetLabel(hours) {
  const h = Number(hours);
  if (hours == null || hours === '' || !Number.isFinite(h)) return '';
  const sign = h < 0 ? '-' : '+';
  const whole = Math.trunc(Math.abs(h));
  const minutes = Math.round((Math.abs(h) - whole) * 60);
  return `${sign}${whole}${minutes ? `:${String(minutes).padStart(2, '0')}` : ''}`;
}

/** HH:MM at an airport `hours` from UTC, or UTC itself when the offset is unknown. */
export function airportTime(now, hours) {
  const h = Number(hours);
  const shift = hours != null && hours !== '' && Number.isFinite(h) ? h * 3600000 : 0;
  return new Date(Number(now) + shift).toISOString().slice(11, 16);
}

/** Flown and remaining distance along a total, clamped, with the fraction flown. */
export function flightProgress(totalNm, remainingNm) {
  const total = Number(totalNm);
  if (!Number.isFinite(total) || total <= 0) return null;
  const known = remainingNm != null && remainingNm !== '' && Number.isFinite(Number(remainingNm));
  const left = known ? Math.min(total, Math.max(0, Number(remainingNm))) : total;
  return { total, left, flown: total - left, fraction: (total - left) / total };
}
