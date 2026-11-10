/**
 * Direct-to routing, shared by Phone Mode and the Flight Deck.
 *
 * Pure functions only: no DOM and no storage, so the selection preview, the
 * applied route and the restore path can be tested without a browser. The
 * caller owns persistence and rendering.
 *
 * What a direct-to does here is what it does on a flight deck: the route is cut
 * at the aircraft's present position, a single leg is flown to the selected
 * fix, and the remainder of the original route resumes from that fix. The
 * original points are kept by the caller (`backupPlan`) so CLEAR DIRECT TO can
 * put them back exactly as they were.
 *
 * Nothing is invented: no position means the direct leg is measured from the
 * plan's origin, and the preview says so. No groundspeed means no ETE.
 */

const EARTH_RADIUS_NM = 3440.065;

const toRad = degrees => (Number(degrees) * Math.PI) / 180;
const toDeg = radians => (Number(radians) * 180) / Math.PI;

function usable(point) {
  return Boolean(point)
    && Number.isFinite(Number(point.lat))
    && Number.isFinite(Number(point.lon))
    && Math.abs(Number(point.lat)) <= 90
    && Math.abs(Number(point.lon)) <= 180;
}

/** Great-circle distance in nautical miles, or null for an unusable fix. */
export function distanceNm(a, b) {
  if (!usable(a) || !usable(b)) return null;
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const dLat = lat2 - lat1;
  const dLon = toRad(Number(b.lon) - Number(a.lon));
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_NM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Initial true bearing in degrees (0–360) from a to b, or null. */
export function bearingDeg(a, b) {
  if (!usable(a) || !usable(b)) return null;
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const dLon = toRad(Number(b.lon) - Number(a.lon));
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  const value = toDeg(Math.atan2(y, x));
  return (value + 360) % 360;
}

/** A fix reduced to the fields a direct-to needs. */
export function directTarget(point) {
  if (!usable(point)) return null;
  const id = String(point.id || point.ident || '').trim().toUpperCase();
  if (!id) return null;
  return {
    id,
    name: String(point.name || point.id || id),
    lat: Number(point.lat),
    lon: Number(point.lon),
    kind: String(point.kind || 'fix'),
    elev: Number.isFinite(Number(point.elev)) ? Number(point.elev) : null,
  };
}

function sameFix(a, b) {
  const one = directTarget(a);
  const two = directTarget(b);
  if (!one || !two) return false;
  if (one.id !== two.id) return false;
  const gap = distanceNm(one, two);
  return gap !== null && gap < 0.1;
}

/** The active direct-to on a plan, or null. */
export function directToState(plan) {
  const direct = plan && plan.direct;
  if (!direct || !direct.id) return null;
  return {
    id: String(direct.id).toUpperCase(),
    name: String(direct.name || direct.id),
    lat: Number(direct.lat),
    lon: Number(direct.lon),
    at: Number(direct.at) || null,
  };
}

/**
 * Build the direct-to route.
 *
 * `plan.points` is the stored route: departure first, destination last when one
 * is set. The selected fix may already be in the route (the usual case: a
 * waypoint ahead) or may be a fix the pilot searched for. Either way the
 * result is [origin, fix, ...remainder], with consecutive duplicates removed so
 * a repeated tap cannot draw the same leg twice.
 */
export function planDirectTo(plan, target, { gsKt = 0, now = Date.now() } = {}) {
  const points = plan && Array.isArray(plan.points) ? plan.points.filter(usable) : [];
  if (!points.length) return { ok: false, error: 'No flight plan is loaded. Build or import a route first.' };
  const fix = directTarget(target);
  if (!fix) return { ok: false, error: 'That point has no usable coordinates.' };

  const origin = points[0];
  const at = points.findIndex(point => sameFix(point, fix));
  const resume = at > 0
    ? points.slice(at + 1)
    : points.slice(1).filter(point => !sameFix(point, fix));

  const nextPoints = [origin, fix, ...resume];
  const deduped = nextPoints.filter((point, index) => index === 0 || !sameFix(point, nextPoints[index - 1]));

  let totalNm = 0;
  for (let index = 1; index < deduped.length; index += 1) {
    const leg = distanceNm(deduped[index - 1], deduped[index]);
    if (leg !== null) totalNm += leg;
  }

  const legNm = distanceNm(origin, fix) || 0;
  const bearing = bearingDeg(origin, fix);
  const speed = Number(gsKt);
  const eteMin = Number.isFinite(speed) && speed > 0 ? (legNm / speed) * 60 : null;

  // How much of the original route this replaces: the fixes between the origin
  // and the selected fix, which the direct leg flies past.
  const skipped = at > 0 ? at - 1 : Math.max(0, points.length - 2);
  let skippedNm = 0;
  for (let index = 1; index <= (at > 0 ? at : points.length - 1); index += 1) {
    const leg = distanceNm(points[index - 1], points[index]);
    if (leg !== null) skippedNm += leg;
  }

  return {
    ok: true,
    plan: {
      ...plan,
      points: deduped,
      direct: {
        id: fix.id,
        name: fix.name,
        lat: fix.lat,
        lon: fix.lon,
        at: now,
        resumed: resume.length,
      },
      dirty: true,
    },
    preview: {
      from: { id: String(origin.id || 'FROM'), lat: Number(origin.lat), lon: Number(origin.lon) },
      to: fix,
      legNm,
      bearingDeg: bearing === null ? null : Math.round(bearing),
      eteMin: eteMin === null ? null : Math.round(eteMin),
      totalNm,
      skippedPoints: skipped,
      skippedNm,
      resumedPoints: resume.length,
      inRoute: at > 0,
      // The direct leg is measured from the plan's origin when no position is
      // known. The preview labels it rather than pretending it is the aircraft.
      fromPlanOrigin: true,
    },
  };
}

/**
 * Restore the route a direct-to replaced. Returns the plan unchanged when there
 * is nothing to restore, so a double tap on CLEAR is harmless.
 */
export function restoreDirectTo(plan, backup) {
  if (!plan) return plan;
  const points = backup && Array.isArray(backup.points) ? backup.points.filter(usable) : null;
  if (!points || !points.length) {
    // `direct` is set to null rather than deleted: the plan is merged into the
    // stored object on write, and a deleted key would let the old marker win.
    return plan.direct ? { ...plan, direct: null, dirty: true } : plan;
  }
  return { ...plan, points, direct: null, dirty: true };
}

/**
 * Search for a direct-to fix: the loaded route first (nearest match wins),
 * then whatever airport/navaid pool the caller supplies.
 *
 * `reference` is the aircraft position when one is known, otherwise the plan's
 * origin, so every result can show a distance and a bearing.
 */
export function searchDirect(plan, query, pool = [], { reference = null, limit = 12 } = {}) {
  const text = String(query || '').trim().toUpperCase();
  if (!text) return [];
  const points = plan && Array.isArray(plan.points) ? plan.points.filter(usable) : [];
  const origin = reference && usable(reference) ? reference : points[0] || null;
  const seen = new Set();
  const results = [];

  const push = (candidate, source) => {
    const fix = directTarget(candidate);
    if (!fix) return;
    const key = `${fix.id}@${fix.lat.toFixed(3)},${fix.lon.toFixed(3)}`;
    if (seen.has(key)) return;
    seen.add(key);
    results.push({
      ...fix,
      source,
      distanceNm: origin ? distanceNm(origin, fix) : null,
      bearingDeg: origin ? bearingDeg(origin, fix) : null,
    });
  };

  const score = fix => {
    if (fix.id === text) return 100;
    if (fix.id.startsWith(text)) return 80;
    if (String(fix.name || '').toUpperCase().startsWith(text)) return 55;
    if (fix.id.includes(text)) return 40;
    return String(fix.name || '').toUpperCase().includes(text) ? 20 : 0;
  };

  const routeMatches = points
    .map((point, index) => ({ point, index, rank: score(directTarget(point) || {}) }))
    .filter(row => row.rank > 0)
    .sort((a, b) => b.rank - a.rank || a.index - b.index);
  for (const row of routeMatches) push({ ...row.point, routeIndex: row.index }, 'route');

  const poolMatches = (Array.isArray(pool) ? pool : [])
    .map(point => ({ point, rank: score(directTarget(point) || {}) }))
    .filter(row => row.rank > 0)
    .sort((a, b) => b.rank - a.rank || String(a.point.id).localeCompare(String(b.point.id)));
  for (const row of poolMatches) push(row.point, 'airport');

  return results
    .map((row, index) => ({ ...row, _index: index }))
    .sort((a, b) => {
      const routeA = a.source === 'route' ? 0 : 1;
      const routeB = b.source === 'route' ? 0 : 1;
      if (routeA !== routeB) return routeA - routeB;
      if (a.distanceNm !== null && b.distanceNm !== null && a.distanceNm !== b.distanceNm) {
        return a.distanceNm - b.distanceNm;
      }
      return a._index - b._index;
    })
    .slice(0, limit)
    .map(({ _index, ...row }) => row);
}
