/**
 * The active route, as the Flight Deck, the EFB and Phone Mode all store it.
 *
 * One key, one shape. The route plan is written by the planner and read by every
 * surface, so a direct-to applied on a phone is the same route the desktop map
 * loads next time, and nothing has to be duplicated per device.
 *
 * Every function takes an optional storage so the read/write/backup path can be
 * tested without a browser.
 */

export const ROUTE_KEY = 'stratos.activeRoute';
export const BACKUP_KEY = 'stratos.directTo.backup';

function safeParse(raw) {
  try {
    const value = JSON.parse(raw || 'null');
    return value && typeof value === 'object' ? value : null;
  } catch (_) {
    return null;
  }
}

function usablePoint(point) {
  return Boolean(point)
    && Number.isFinite(Number(point.lat))
    && Number.isFinite(Number(point.lon));
}

/** The stored route plan, or a minimal empty plan when none exists. */
export function readPlan(storage = globalThis.localStorage) {
  let stored = null;
  try { stored = safeParse(storage.getItem(ROUTE_KEY)); } catch (_) { stored = null; }
  if (!stored || !Array.isArray(stored.points)) {
    return { name: '', points: [], cruiseKts: null, cruiseAlt: null, plan: null, id: null };
  }
  return {
    ...stored,
    points: stored.points.filter(usablePoint),
  };
}

/**
 * Write the plan back, keeping every field this module does not own (name,
 * cruise figures, the imported OFP) exactly as the planner left them.
 */
export function writePlan(plan, storage = globalThis.localStorage) {
  if (!plan) return false;
  let previous = null;
  try { previous = safeParse(storage.getItem(ROUTE_KEY)); } catch (_) { previous = null; }
  const next = {
    ...(previous || {}),
    ...plan,
    points: (Array.isArray(plan.points) ? plan.points : []).filter(usablePoint),
    savedAt: Date.now(),
  };
  try {
    storage.setItem(ROUTE_KEY, JSON.stringify(next));
    return true;
  } catch (_) {
    return false;
  }
}

/** Keep the points a direct-to replaced, so CLEAR can restore them exactly. */
export function readBackup(storage = globalThis.localStorage) {
  let stored = null;
  try { stored = safeParse(storage.getItem(BACKUP_KEY)); } catch (_) { stored = null; }
  if (!stored || !Array.isArray(stored.points) || !stored.points.length) return null;
  return { ...stored, points: stored.points.filter(usablePoint) };
}

export function writeBackup(backup, storage = globalThis.localStorage) {
  if (!backup || !Array.isArray(backup.points) || !backup.points.length) return false;
  try {
    storage.setItem(BACKUP_KEY, JSON.stringify({
      points: backup.points.filter(usablePoint),
      at: Number(backup.at) || Date.now(),
      id: backup.id || '',
    }));
    return true;
  } catch (_) {
    return false;
  }
}

export function clearBackup(storage = globalThis.localStorage) {
  try { storage.removeItem(BACKUP_KEY); } catch (_) { /* private mode */ }
}
