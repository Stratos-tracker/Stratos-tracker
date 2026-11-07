/* Build the flight the pilot filed in SimBrief from real procedure geometry.
 *
 * SimBrief names what was selected — departure and arrival airports, runways,
 * the SID, the STAR and their transitions — but it is not an aeronautical
 * procedure database. This module takes those identifiers to the CIFP payload
 * for each airport, matches them exactly, and inserts only the legs that payload
 * publishes into one ordered plan.
 *
 * There is no fallback geometry. A missing airport payload, procedure, runway
 * or transition is reported as an unavailable procedure and the en-route plan is
 * left without it. An AIRAC mismatch is reported too, because a route built from
 * a different cycle is not the route the OFP describes.
 */

import { endpointsFor } from './procdeck.js';
import {
  applyProcedure, createPlan, mapRoute, procedureRoute, storedRoute,
  suggestTransitions,
} from './routeplan.js';

const up = value => String(value == null ? '' : value).trim().toUpperCase();
const num = value => (Number.isFinite(Number(value)) ? Number(value) : null);
const runway = value => up(value).replace(/^RW/, '');

function starNavlogFix(fix, star) {
  const stage = up(fix && fix.stage);
  return ['DES', 'DSC', 'ARR'].includes(stage)
    || Boolean(star && up(fix && fix.viaAirway) === star);
}

function withoutProcedureTag(plan, kind) {
  const tag = String(kind || '').toLowerCase() === 'approach' ? 'app' : String(kind || '').toLowerCase();
  return {
    ...plan,
    points: plan.points.map(point => (String(point.ss || '').toLowerCase() === tag
      ? { ...point, ss: '' }
      : point)),
  };
}

function fixKind(fix, origin, destination) {
  const type = String((fix && fix.type) || '').toLowerCase();
  const ident = up(fix && fix.ident);
  if (type === 'apt' || type === 'airport' || ident === origin || ident === destination) return 'apt';
  if (['vor', 'ndb', 'navaid', 'dme', 'vor/dme'].includes(type)) return 'nav';
  return 'fix';
}

/** The SimBrief selections this builder must resolve, normalised for lookup. */
export function procedureChoice(ofp) {
  const origin = (ofp && ofp.origin) || {};
  const destination = (ofp && ofp.destination) || {};
  return {
    cycle: up(ofp && ofp.airac),
    dep: up(origin.icao),
    depRwy: runway(origin.rwy),
    sid: up(origin.sid),
    sidTrans: up(origin.sidTrans),
    arr: up(destination.icao),
    arrRwy: runway(destination.rwy),
    star: up(destination.star),
    starTrans: up(destination.starTrans),
    approach: up(destination.approach),
    approachTrans: up(destination.approachTrans),
    approachRwy: runway(destination.approachRwy),
  };
}

/**
 * A stable identity for one SimBrief plan. `fetchedAt` is deliberately absent:
 * asking SimBrief again must not look like a new flight. The generated time and
 * request id, when published, distinguish two plans with identical text.
 */
export function planKey(ofp) {
  if (!ofp) return '';
  const choice = procedureChoice(ofp);
  return [
    up(ofp.requestId),
    String(ofp.generatedAt || ''),
    choice.cycle,
    choice.dep, choice.depRwy, choice.sid, choice.sidTrans,
    choice.arr, choice.arrRwy, choice.star, choice.starTrans,
    choice.approach, choice.approachTrans, choice.approachRwy,
    String((ofp.flight && ofp.flight.routeText) || ''),
    String((ofp.times && ofp.times.depUtc) || ''),
  ].join('|');
}

/** The en-route plan SimBrief's navlog describes, before any procedure is added. */
export function basePlanFromOfp(ofp) {
  const fixes = ofp && Array.isArray(ofp.fixes) ? ofp.fixes : [];
  const choice = procedureChoice(ofp);
  if (fixes.length < 2) {
    return { ok: false, reason: 'no-route', error: 'SimBrief did not publish a navlog for this plan, so there is no en-route route to join the procedures to.' };
  }
  if (!choice.dep || !choice.arr) {
    return { ok: false, reason: 'no-airports', error: 'SimBrief did not name both airports for this plan.' };
  }
  const points = fixes
    .filter(fix => num(fix.lat) != null && num(fix.lon) != null)
    .map(fix => ({
      id: up(fix.ident) || 'WPT',
      name: fix.name || fix.ident || 'Waypoint',
      lat: num(fix.lat),
      lon: num(fix.lon),
      kind: fixKind(fix, choice.dep, choice.arr),
      altFt: num(fix.altFt),
      // The plan's own tags are kept until a verified procedure replaces them.
      ss: fix.isSidStar ? (starNavlogFix(fix, choice.star) ? 'star' : 'sid') : '',
      aw: fix.viaAirway && !/^DCT$/i.test(fix.viaAirway) ? up(fix.viaAirway) : '',
      source: 'simbrief',
    }));
  const airportPoint = (icao, airport) => {
    const lat = num(airport && airport.lat);
    const lon = num(airport && airport.lon);
    if (!icao || lat == null || lon == null) return null;
    return {
      id: icao,
      name: (airport && airport.name) || icao,
      lat,
      lon,
      kind: 'apt',
      altFt: null,
      ss: '',
      aw: '',
      source: 'simbrief',
    };
  };
  // SimBrief may begin the navlog at the first en-route fix and omit the
  // departure airport. Its published airport coordinates are the filed
  // endpoint, not a guessed waypoint, so they anchor the route when needed.
  let first = points.findIndex(point => point.id === choice.dep);
  if (first < 0) {
    const anchor = airportPoint(choice.dep, ofp.origin);
    if (anchor) {
      points.unshift(anchor);
      first = 0;
    }
  }
  let last = points.map(point => point.id).lastIndexOf(choice.arr);
  if (last < 0) {
    const anchor = airportPoint(choice.arr, ofp.destination);
    if (anchor) {
      points.push(anchor);
      last = points.length - 1;
    }
  }
  if (first < 0 || last < 0 || last <= first) {
    return {
      ok: false,
      reason: 'no-airports-in-route',
      error: `The SimBrief plan does not carry ${choice.dep} and ${choice.arr} with coordinates at the ends of its navlog, so their procedure geometry cannot be anchored.`,
    };
  }
  const routePoints = points.slice(first, last + 1);
  // Airport endpoints are not procedure legs, even when SimBrief tags the last
  // navlog row with the STAR. Leaving that tag on the arrival would let the
  // STAR join strip the airport along with the procedure and lose the anchor.
  routePoints[0] = { ...routePoints[0], kind: 'apt', ss: '' };
  routePoints[routePoints.length - 1] = { ...routePoints[routePoints.length - 1], kind: 'apt', ss: '' };
  const plan = createPlan({
    points: routePoints,
    cruiseKts: Number(ofp.flight && ofp.flight.cruiseTasKt) > 0 ? Number(ofp.flight.cruiseTasKt) : 450,
    cruiseAlt: Number(ofp.flight && ofp.flight.cruiseFt) > 0 ? Number(ofp.flight.cruiseFt) : 35000,
    departureRwy: choice.depRwy,
    arrivalRwy: choice.arrRwy,
  });
  if (!plan.origin || !plan.destination) {
    return { ok: false, reason: 'no-airports', error: 'The SimBrief navlog does not identify both airports, so the route cannot be built.' };
  }
  return { ok: true, plan, choice };
}

/**
 * Resolve one selected procedure against its airport payload.
 * The SimBrief transition is used exactly when published; when the OFP leaves it
 * blank, a transition whose published end meets the route is the only addition,
 * and it is named in the result. Nothing else is guessed.
 */
function resolveProcedure(payload, { kind, ident, selectedRunway, transition, routeIds, airport }) {
  if (!payload || payload.ok !== true) {
    return {
      ok: false,
      reason: 'unavailable',
      error: (payload && payload.error) || `Procedure data is unavailable for ${airport}.`,
    };
  }
  const wanted = up(transition);
  const isRunwayTransition = wanted.startsWith('RW');
  let result = procedureRoute(payload, {
    kind,
    ident,
    runway: selectedRunway,
    runwayTransition: isRunwayTransition ? wanted : '',
    enrouteTransition: isRunwayTransition ? '' : wanted,
  });
  let transitionUsed = wanted;
  if (!result.ok && result.reason === 'needs-transition' && !wanted) {
    const suggested = suggestTransitions(payload, { kind, ident, runway: selectedRunway, routeIds, airport });
    if (suggested.enroute) {
      result = procedureRoute(payload, {
        kind,
        ident,
        runway: selectedRunway,
        enrouteTransition: suggested.enroute,
      });
      transitionUsed = suggested.enroute;
    }
  }
  return result.ok ? { ...result, transitionUsed } : result;
}

function cycleWarning(kind, ident, ofpCycle, payloadCycle) {
  if (!ofpCycle || !payloadCycle || up(ofpCycle) === up(payloadCycle)) return null;
  return {
    kind: 'airac',
    tone: 'warn',
    text: `${kind.toUpperCase()} ${ident} was resolved from AIRAC ${payloadCycle}; the SimBrief plan was built for AIRAC ${ofpCycle}. Verify the procedure before flight.`,
  };
}

/**
 * Build one continuous plan: runway → SID → transition → en-route → STAR
 * transition → STAR → arrival runway. `depPayload` and `arrPayload` are the
 * real CIFP payloads. The result always has the en-route route; each procedure
 * is either verified and inserted, or named in `warnings` and absent.
 */
export function buildProcedurePlan(ofp, { depPayload = null, arrPayload = null } = {}) {
  const base = basePlanFromOfp(ofp);
  if (!base.ok) return base;
  let plan = base.plan;
  const warnings = [];
  const applied = { sid: null, star: null, approach: null };
  const cycles = new Set();
  const hasApproach = Boolean(base.choice.approach);

  const requested = [
    {
      kind: 'sid', airport: base.choice.dep, ident: base.choice.sid,
      transition: base.choice.sidTrans, selectedRunway: base.choice.depRwy, payload: depPayload,
    },
    {
      // When an approach is filed, the STAR is the en-route arrival, not a
      // runway transition: the approach owns the path from its IAF/IF to the
      // threshold. A STAR that ends on the runway first would make the route
      // fly to the field, reverse to the IAF and land again.
      kind: 'star', airport: base.choice.arr, ident: base.choice.star,
      transition: base.choice.starTrans,
      selectedRunway: hasApproach ? '' : base.choice.arrRwy,
      payload: arrPayload,
    },
    {
      kind: 'approach', airport: base.choice.arr, ident: base.choice.approach,
      transition: base.choice.approachTrans || base.choice.starTrans,
      selectedRunway: base.choice.approachRwy || base.choice.arrRwy,
      payload: arrPayload,
    },
  ];

  for (const item of requested) {
    if (!item.ident) continue;
    const routeIds = plan.points.map(point => point.id);
    const resolved = resolveProcedure(item.payload, {
      kind: item.kind,
      ident: item.ident,
      selectedRunway: item.selectedRunway,
      transition: item.transition,
      routeIds,
      airport: item.airport,
    });
    if (!resolved.ok) {
      plan = withoutProcedureTag(plan, item.kind);
      warnings.push({
        kind: item.kind,
        tone: 'bad',
        text: `${item.kind.toUpperCase()} ${item.ident} at ${item.airport}: ${resolved.error || 'no verified geometry is available.'}`,
      });
      continue;
    }
    const result = applyProcedure(plan, item.kind, resolved);
    if (!result.ok) {
      plan = withoutProcedureTag(plan, item.kind);
      warnings.push({
        kind: item.kind,
        tone: 'bad',
        text: `${item.kind.toUpperCase()} ${item.ident} at ${item.airport}: ${result.error || 'its legs could not be inserted.'}`,
      });
      continue;
    }
    plan = result.plan;
    applied[item.kind] = {
      id: resolved.id,
      cycle: resolved.cycle,
      runway: resolved.runway,
      runwayTransition: resolved.runwayTransition,
      enrouteTransition: resolved.enrouteTransition,
      complete: resolved.complete !== false,
      transitionUsed: resolved.transitionUsed || '',
      join: result.plan.approach && item.kind === 'approach' ? result.plan.approach.join : '',
      validation: resolved.validation || null,
    };
    if (resolved.cycle) cycles.add(resolved.cycle);
    if (resolved.complete === false) {
      warnings.push({
        kind: item.kind,
        tone: 'warn',
        text: `${resolved.label || resolved.id} has ${resolved.skipped || 0} leg${resolved.skipped === 1 ? '' : 's'} the navigation data could not resolve; only its verified legs were added.`,
      });
    }
    const cycleNote = cycleWarning(item.kind, resolved.id, base.choice.cycle, resolved.cycle);
    if (cycleNote) warnings.push(cycleNote);
  }

  return {
    ok: true,
    plan,
    choice: base.choice,
    applied,
    cycles: [...cycles],
    warnings,
    complete: requested.filter(item => item.ident).every(item => Boolean(applied[item.kind])),
  };
}

/** The storage records the Flight Deck and EFB both read for this plan. */
export function storageFromPlan(plan, ofp, simbriefId, warnings = [], applied = {}) {
  const stored = storedRoute(plan);
  stored.plan.builtAt = Date.now();
  stored.plan.sources = [
    {
      label: 'SimBrief',
      detail: `Latest operational flight plan${ofp && ofp.airac ? ` · AIRAC ${ofp.airac}` : ''}`,
    },
    ...(warnings || []).map(warning => ({ label: 'Procedure', detail: warning.text, tone: warning.tone })),
  ];
  stored.plan.simbrief = {
    id: String(simbriefId || ''),
    key: planKey(ofp),
    airac: up(ofp && ofp.airac) || '',
    fetchedAt: Number(ofp && ofp.fetchedAt) || 0,
    generatedAt: Number(ofp && ofp.generatedAt) || 0,
    applied: {
      sid: applied.sid ? applied.sid.id : '',
      star: applied.star ? applied.star.id : '',
      approach: applied.approach ? applied.approach.id : '',
    },
    warnings: (warnings || []).map(warning => ({ kind: warning.kind, tone: warning.tone, text: warning.text })),
  };
  return {
    active: stored,
    map: mapRoute(plan),
    key: stored.plan.simbrief.key,
  };
}

/** The SimBrief marker on the active route, or null when it was not imported. */
export function activeSimbriefPlan(storage = (typeof localStorage === 'undefined' ? null : localStorage)) {
  try {
    const raw = storage && storage.getItem('stratos.activeRoute');
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && parsed.plan && parsed.plan.simbrief && typeof parsed.plan.simbrief === 'object'
      ? parsed.plan.simbrief
      : null;
  } catch (_) {
    return null;
  }
}

/** When the active route was last built, in ms, or 0 when it does not say. */
export function activeRouteBuiltAt(storage = (typeof localStorage === 'undefined' ? null : localStorage)) {
  try {
    const raw = storage && storage.getItem('stratos.activeRoute');
    const parsed = raw ? JSON.parse(raw) : null;
    return Number(parsed && parsed.plan && parsed.plan.builtAt) || 0;
  } catch (_) {
    return 0;
  }
}

async function payloadFor(airport, fetchImpl) {
  if (!airport) return null;
  let last = null;
  for (const url of endpointsFor(airport)) {
    try {
      const response = await fetchImpl(url, {
        cache: 'no-store',
        credentials: typeof location !== 'undefined' && location.protocol === 'file:' ? 'omit' : 'include',
      });
      const payload = await response.json().catch(() => null);
      // Only an answered airport stops the search. A bridge that reports why it
      // has no data still leaves the bundled/website source to try, which is
      // what makes a hosted preview resolve a US airport.
      if (payload && payload.ok === true) return payload;
      last = payload || last;
    } catch (_) { /* this source is not there; the next one may be */ }
  }
  return last;
}

/**
 * Fetch each airport's real CIFP payload, trying the local bridge and then the
 * bundled API. A non-OK payload is kept so its reason can be shown.
 */
export async function loadProcedurePayloads(ofp, fetchImpl = fetch) {
  const choice = procedureChoice(ofp);
  const [depPayload, arrPayload] = await Promise.all([
    choice.dep && choice.sid ? payloadFor(choice.dep, fetchImpl) : null,
    choice.arr && (choice.star || choice.approach) ? payloadFor(choice.arr, fetchImpl) : null,
  ]);
  return { depPayload, arrPayload };
}

/** Fetch the data and build the plan in one step, for the pages. */
export async function buildFromSimbrief(ofp, fetchImpl = fetch) {
  const payloads = await loadProcedurePayloads(ofp, fetchImpl);
  const built = buildProcedurePlan(ofp, payloads);
  return { ...built, payloads };
}
