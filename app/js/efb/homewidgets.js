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
/* A fresh deck: the flight widget top left, the two airport clocks under it. */
export const DEFAULT_POS = { 'w:flight': [0, 0], 'w:dep': [0, 5], 'w:arr': [2, 5] };

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
  // Saved cells: [column, row] per item, whole numbers only.
  const pos = saved.pos && typeof saved.pos === 'object' ? {} : { ...DEFAULT_POS };
  if (saved.pos && typeof saved.pos === 'object') {
    for (const [key, spot] of Object.entries(saved.pos)) {
      if (Array.isArray(spot) && spot.length === 2 && spot.every(n => Number.isInteger(n) && n >= 0)) pos[key] = spot;
    }
  }
  return { widgets, apps, dock, pos };
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

/* ── the home grid: every app and widget sits on cells, anywhere, gaps allowed ── */

/** Cells an item covers: an app is one cell, the clocks two by two. */
export const SIZES = { flight: [3, 5], dep: [2, 2], arr: [2, 2], navigator: [3, 2], clock: [3, 2] };
export const sizeOf = key => (key.startsWith('w:') ? SIZES[key.slice(2)] || [2, 2] : [1, 1]);

/** True when a w×h block at column c, row r is inside the grid and free. */
export function fits(placed, c, r, w, h, cols, ignore = '') {
  if (c < 0 || r < 0 || c + w > cols) return false;
  for (const [key, p] of Object.entries(placed)) {
    if (key === ignore) continue;
    if (c < p.c + p.w && p.c < c + w && r < p.r + p.h && p.r < r + h) return false;
  }
  return true;
}

/** The first free spot for a w×h item, reading left to right, top to bottom. */
export function firstFit(placed, w, h, cols) {
  for (let r = 0; r < 400; r += 1) {
    for (let c = 0; c + w <= cols; c += 1) if (fits(placed, c, r, w, h, cols)) return { c, r };
  }
  return { c: 0, r: 400 };
}

/** Where everything goes: saved spots that still fit are kept, the rest
 *  (new items, or ones that no longer fit this many columns) take the first
 *  free spot. Widgets are placed before apps so they keep their blocks. */
export function placeAll(keys, saved, cols) {
  const placed = {};
  const put = key => {
    const [w, h] = sizeOf(key);
    const spot = saved && saved[key];
    placed[key] = Array.isArray(spot) && fits(placed, spot[0], spot[1], w, h, cols)
      ? { c: spot[0], r: spot[1], w, h }
      : { ...firstFit(placed, w, h, cols), w, h };
  };
  // Widgets first (saved spots, then new ones), then apps the same way.
  for (const group of [keys.filter(k => k.startsWith('w:')), keys.filter(k => !k.startsWith('w:'))]) {
    const fixed = group.filter(k => Array.isArray(saved && saved[k]));
    for (const key of [...fixed, ...group.filter(k => !fixed.includes(k))]) put(key);
  }
  return placed;
}
