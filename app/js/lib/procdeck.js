/* The procedure deck: which published procedure to draw, and its real legs.
 *
 * A CIFP airport file publishes each SID and STAR as a set of named
 * transitions. A SID's runway transitions carry the legs from the runway to the
 * first en-route fix; its other transitions carry the legs from that fix
 * outward. A STAR is the mirror image. The card lets a pilot choose either
 * half, so this module joins them — at the fix the two halves share, and only
 * there. When they share no fix the halves come back as separate segments, so
 * the map draws two published paths instead of an invented line between them.
 *
 * Nothing is interpolated: every point returned here is a point the dataset
 * states, and a kind the dataset does not carry (approaches, today) is reported
 * as unavailable with its reason.
 */

export const KIND_ORDER = ['sid', 'star', 'approach'];

export const KINDS = {
  sid: { key: 'sid', label: 'SID', title: 'Departure', color: '#f472b6' },
  star: { key: 'star', label: 'STAR', title: 'Arrival', color: '#a78bfa' },
  approach: { key: 'approach', label: 'APP', title: 'Approach', color: '#fbbf24' },
};

const up = value => String(value == null ? '' : value).trim().toUpperCase();
const num = value => (Number.isFinite(Number(value)) ? Number(value) : null);

/* The ARINC 424 approach identifier carries its type in its first letter and
   the runway in the rest: I16C is the ILS to 16C, H16CZ is the RNAV (RNP) Z
   to 16C. Only the letters whose meaning the format fixes are named; anything
   else keeps its identifier rather than guessing a title. */
const APPROACH_TYPES = {
  I: 'ILS', L: 'LOC', R: 'RNAV', V: 'VOR', N: 'NDB', D: 'VOR/DME',
  G: 'IGS', H: 'RNAV (RNP)', B: 'LOC BC', F: 'FMS',
};

/** A readable approach title from its CIFP ident, or '' when it cannot be read. */
export function approachTitle(ident) {
  const code = up(ident);
  const match = code.match(/^([A-Z])(\d{2})([LRCB]?)([A-Z]?)$/);
  if (!match) return '';
  const type = APPROACH_TYPES[match[1]] || '';
  const runway = match[2] + (match[3] || '');
  const variant = match[4] ? ` ${match[4]}` : '';
  return type ? `${type}${variant} RWY ${runway}` : `${code} RWY ${runway}`;
}

/** A four-character airport ident, or ''. */
export function airportCode(value) {
  const code = up(value).replace(/\s+/g, '');
  return /^[A-Z0-9]{4}$/.test(code) ? code : '';
}

/** Where to ask for one airport's procedures, best source first.
 *
 * The website has the bundled dataset behind `/api/procedures`; a pilot's PC
 * has the simulator's own CIFP behind the bridge's `/procedures.json`. Both
 * answer with the same shape, so the caller tries them in order and keeps the
 * first that is not a connection failure. */
export function endpointsFor(airport, kind = '', ident = '') {
  const code = airportCode(airport);
  if (!code) return [];
  const query = new URLSearchParams({ airport: code });
  if (kind) query.set('kind', String(kind).toLowerCase());
  if (ident) query.set('id', up(ident));
  const qs = query.toString();
  return [`/procedures.json?${qs}`, `/api/procedures?${qs}`];
}

/** Runway designators the payload publishes, in runway order. */
export function runwayIds(payload) {
  const table = (payload && payload.runways) || {};
  return Object.keys(table)
    .filter(id => /^\d{2}[LRCB]?$/.test(id))
    .sort((a, b) => Number(a.slice(0, 2)) - Number(b.slice(0, 2)) || a.localeCompare(b));
}

/** One runway's threshold, or null. */
export function runwayThreshold(payload, runway) {
  const id = String(runway || '').replace(/^RW/i, '').toUpperCase();
  const point = payload && payload.runways && payload.runways[id];
  if (!point) return null;
  const lat = num(point.lat);
  const lon = num(point.lon);
  return lat == null || lon == null ? null : { id: 'RW' + id, lat, lon };
}

/** Every procedure of one kind, with the runways and branches it publishes. */
export function procedureList(payload, kind) {
  const key = String(kind || '').toLowerCase();
  const list = payload && payload.procedures && payload.procedures[key];
  if (!Array.isArray(list)) return [];
  return list
    .filter(proc => proc && proc.id)
    .map(proc => {
      const transitions = Array.isArray(proc.transitions) ? proc.transitions : [];
      // Runway transitions name the runway in their id; an approach names its
      // entry fixes instead, so its runways come from the runway legs it draws.
      let runways = transitions
        .filter(t => up(t.id).startsWith('RW'))
        .map(t => String(t.runway || up(t.id).slice(2, 4)).replace(/[A-Z]$/, ''))
        .filter((id, i, all) => /^\d{2}[LRC]?$/.test(id) && all.indexOf(id) === i);
      const approach = String(kind || '').toLowerCase() === 'approach';
      if (approach && !runways.length) {
        runways = transitions
          .flatMap(t => (Array.isArray(t.points) ? t.points : []).map(p => up(p.id)))
          .map(id => id.match(/^RW(\d{2}[LRCB]?)$/))
          .filter(Boolean)
          .map(m => m[1])
          .filter((id, i, all) => all.indexOf(id) === i);
      }
      const branches = transitions
        .filter(t => !up(t.id).startsWith('RW') && !(approach && !up(t.id)))
        .map(t => String(t.id || '') || 'ALL');
      return {
        id: String(proc.id).toUpperCase(),
        title: approach ? approachTitle(proc.id) : '',
        transitions: transitions.map(t => String(t.id || '')),
        runways,
        branches: branches.filter((id, i, all) => all.indexOf(id) === i),
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** The transitions a pilot can choose, labelled by what they connect to. */
export function transitionList(payload, { kind = 'sid', ident } = {}) {
  const proc = procedureList(payload, kind).find(p => p.id === up(ident));
  if (!proc) return [];
  const list = ((payload.procedures[String(kind).toLowerCase()] || []).find(p => up(p.id) === proc.id) || {}).transitions || [];
  const approach = String(kind || '').toLowerCase() === 'approach';
  const rank = item => (item.kind === 'runway' ? 0 : item.kind === 'final' ? 1 : 2);
  return list.map(t => {
    const id = String(t.id || '');
    const runway = up(t.runway) || (up(id).startsWith('RW') ? up(id).slice(2, 4) : '');
    const final = approach && !id;
    return {
      id,
      runway,
      kind: up(id).startsWith('RW') ? 'runway' : final ? 'final' : 'branch',
      points: Array.isArray(t.points) ? t.points.length : 0,
      complete: t.complete !== false,
      skipped: Number(t.skipped) || 0,
      label: up(id).startsWith('RW') ? `Runway ${runway}` : final ? 'Final approach' : (id ? `via ${id}` : 'Common legs'),
    };
  }).sort((a, b) => (rank(a) === rank(b) ? a.id.localeCompare(b.id) : rank(a) - rank(b)));
}

function cleanPoints(points) {
  const out = [];
  for (const point of points || []) {
    const lat = num(point && point.lat);
    const lon = num(point && point.lon);
    if (lat == null || lon == null) continue;
    const previous = out[out.length - 1];
    if (previous && Math.abs(previous.lat - lat) < 1e-6 && Math.abs(previous.lon - lon) < 1e-6) continue;
    out.push({ id: up(point.id), lat, lon, terminator: up(point.terminator) });
  }
  return out;
}

/* Two published pieces joined only where they name the same fix. */
function join(first, second) {
  const head = (first && first.points) || [];
  const tail = (second && second.points) || [];
  if (!head.length) return { points: tail.slice(), joined: false };
  if (!tail.length) return { points: head.slice(), joined: false };
  const last = up(head[head.length - 1].id);
  const sharedAt = tail.findIndex(point => up(point.id) === last);
  if (!last || sharedAt < 0) return { points: null, joined: false };
  return { points: [...head, ...tail.slice(sharedAt + 1)], joined: true };
}

function failure(reason, error) {
  return { ok: false, reason, error, segments: [], points: [], notes: [] };
}

/** The published geometry for one procedure choice.
 *
 * `transition` may name either a runway transition or an en-route branch; the
 * runway transition for `runway` is added automatically when it is not the one
 * named. Returns `segments` (each an ordered list of published fixes) so a
 * choice whose halves do not meet is still drawn truthfully as two pieces. */
export function pathFor(payload, { kind = 'sid', ident = '', runway = '', transition = '' } = {}) {
  const key = String(kind || '').toLowerCase();
  const meta = KINDS[key];
  if (!meta) return failure('bad-kind', `Unknown procedure kind "${kind}".`);
  if (!payload || payload.ok !== true) {
    return failure('unavailable', (payload && payload.error) || 'Procedure data is not available for this airport.');
  }
  const list = (payload.procedures && payload.procedures[key]) || [];
  if (!Array.isArray(list) || !list.length) {
    return failure('not-in-dataset', `${payload.airport || 'This airport'} publishes no ${meta.label} legs in this dataset.`);
  }
  const wanted = up(ident);
  const procedure = list.find(item => up(item && item.id) === wanted);
  if (!procedure) {
    return failure('not-in-data', `${payload.airport || 'This airport'} has no ${meta.label} ${wanted || ''} in this dataset.`.replace('  ', ' '));
  }

  const transitions = Array.isArray(procedure.transitions) ? procedure.transitions : [];
  const byId = id => transitions.find(item => up(item && item.id) === up(id)) || null;
  const rwy = String(runway || '').replace(/^RW/i, '').toUpperCase();
  const runwayTransition = rwy ? (byId('RW' + rwy) || byId('RW' + rwy.slice(0, 2) + 'B')) : null;
  const chosen = transition ? byId(transition) : null;
  const isRunway = item => Boolean(item) && up(item.id).startsWith('RW');
  const notes = [];

  // An approach is published as entry branches plus one final segment, which
  // carries an empty transition id and ends on the runway leg.
  const finalSegment = key === 'approach'
    ? (transitions.find(item => up(item.id) === '') || transitions.find(item => (Array.isArray(item.points) ? item.points : []).some(p => up(p.id).startsWith('RW'))) || null)
    : null;

  let pieces;
  if (key === 'approach') {
    if (chosen && chosen !== finalSegment) pieces = finalSegment ? [chosen, finalSegment] : [chosen];
    else if (finalSegment) pieces = [finalSegment];
    else pieces = chosen ? [chosen] : [];
  } else if (chosen && chosen === runwayTransition) {
    pieces = [chosen];
  } else if (chosen) {
    pieces = isRunway(chosen) ? [chosen] : (runwayTransition ? [runwayTransition, chosen] : [chosen]);
  } else if (runwayTransition) {
    pieces = [runwayTransition];
  } else {
    const trunk = transitions.find(item => {
      const id = up(item.id);
      return id === '' || id === 'ALL';
    });
    const branch = transitions.find(item => {
      const id = up(item.id);
      return id !== '' && id !== 'ALL' && !id.startsWith('RW');
    });
    pieces = trunk ? [trunk, ...(branch ? [branch] : [])] : branch ? [branch] : [];
  }
  if (!pieces.length) {
    return failure('no-transition', `${procedure.id} publishes no legs for ${rwy ? 'runway ' + rwy : 'that choice'} in this dataset.`);
  }

  // SID halves run runway first, STAR halves run runway last. Joining in the
  // published order keeps the drawn path running the way the aircraft flies it.
  const segments = [];
  let current = null;
  for (const piece of pieces) {
    const points = cleanPoints(piece.points);
    if (!points.length) {
      if (Number(piece.skipped) > 0) notes.push(`${up(piece.id) || 'common'}: ${piece.skipped} leg${piece.skipped === 1 ? '' : 's'} not resolvable`);
      continue;
    }
    if (!current) {
      current = points.slice();
      continue;
    }
    const merged = key === 'star' ? join({ points }, { points: current }) : join({ points: current }, { points });
    if (merged.joined) current = merged.points;
    else {
      segments.push(current);
      current = points.slice();
    }
  }
  if (current && current.length) segments.push(current);

  if (!segments.length) {
    return failure('empty', `${procedure.id} publishes no usable fixes in this dataset.`);
  }

  let served = rwy;
  if (key === 'approach') {
    // The legs published after the runway are the missed approach, a separate
    // path; the drawn approach stops on the runway it lands on.
    for (const segment of segments) {
      const at = segment.findIndex(point => up(point.id).startsWith('RW'));
      if (at >= 0) {
        segment.length = at + 1;
        if (!served) {
          const match = up(segment[at].id).match(/^RW(\d{2}[LRCB]?)$/);
          if (match) served = match[1];
        }
      }
    }
  }

  const threshold = runwayThreshold(payload, served);
  if (threshold) {
    const first = segments[0][0];
    const last = segments[segments.length - 1][segments[segments.length - 1].length - 1];
    const atAirport = up(last.id) === up(payload.airport);
    if (key === 'star') {
      // A STAR's terminal leg often ends at the airport itself: the runway
      // threshold replaces that point instead of drawing into the field centre.
      const tail = segments[segments.length - 1];
      if (atAirport) tail[tail.length - 1] = { ...tail[tail.length - 1], ...threshold, id: threshold.id };
    } else if (!up(first.id).startsWith('RW') && !first.terminator) {
      // A SID's first leg that carries no terminator is a direct-to from the
      // runway, which ARINC 424 spells as the runway threshold itself.
      segments[0].unshift({ ...threshold, terminator: 'DF' });
    }
  }

  for (const segment of segments) {
    for (const point of segment) {
      if (!point.id) point.id = point.terminator === 'DF' ? 'RW' + served : '';
    }
  }

  const complete = pieces.every(piece => piece.complete !== false);
  const skipped = pieces.reduce((total, piece) => total + (Number(piece.skipped) || 0), 0);
  return {
    ok: true,
    kind: key,
    label: meta.label,
    id: String(procedure.id).toUpperCase(),
    runway: served,
    transition: chosen ? String(chosen.id) : String((runwayTransition && runwayTransition.id) || ''),
    segments,
    points: segments.flat(),
    complete,
    skipped,
    notes,
    runwayThreshold: threshold,
    source: String(payload.source || ''),
    cycle: String(payload.cycle || ''),
    airport: String(payload.airport || ''),
  };
}

/** One sentence for the card: where the geometry came from, or why it is not there. */
export function pathNote(result) {
  if (!result) return '';
  if (!result.ok) return result.error || 'Procedure path unavailable';
  const cycle = result.cycle ? `AIRAC ${result.cycle}` : 'the navigation cycle';
  const pieces = result.segments.length > 1 ? ` · drawn as ${result.segments.length} published sections` : '';
  const missing = result.complete ? '' : ` · ${result.skipped} leg${result.skipped === 1 ? '' : 's'} not resolvable`;
  const extras = result.notes && result.notes.length ? ' · ' + result.notes.join(' · ') : '';
  const title = result.kind === 'approach' ? approachTitle(result.id) : '';
  const named = title ? `${title} (${result.id})` : `${result.label} ${result.id}`;
  return `${named}${result.runway ? ' · runway ' + result.runway : ''} from ${cycle}${pieces}${missing}${extras}`;
}

/** What the dataset carries for an airport, in the panel's words. */
export function describe(payload) {
  const procedures = (payload && payload.procedures) || {};
  const counts = {};
  for (const kind of KIND_ORDER) counts[kind] = Array.isArray(procedures[kind]) ? procedures[kind].length : 0;
  return {
    airport: String((payload && payload.airport) || ''),
    cycle: String((payload && payload.cycle) || ''),
    source: String((payload && payload.source) || ''),
    runways: runwayIds(payload),
    counts,
    total: counts.sid + counts.star + counts.approach,
    has: kind => counts[String(kind).toLowerCase()] > 0,
  };
}

/** Why a kind cannot be picked, in the panel's words, or '' when it can. */
export function kindNote(payload, kind) {
  const key = String(kind || '').toLowerCase();
  const info = describe(payload);
  if (!payload || payload.ok !== true) return 'No procedure data for this airport.';
  if (info.counts[key] > 0) return '';
  if (key === 'approach') {
    return 'No approach leg geometry for this airport in this dataset — open the approach chart instead.';
  }
  return `This dataset publishes no ${key.toUpperCase()} legs for ${info.airport || 'this airport'}.`;
}

/** The starting selection a SimBrief plan implies, without trusting guesses. */
export function planSelection(ofp) {
  const origin = (ofp && ofp.origin) || {};
  const destination = (ofp && ofp.destination) || {};
  return {
    dep: airportCode(origin.icao),
    depRwy: String(origin.rwy || '').replace(/^RW/i, '').toUpperCase(),
    sid: up(origin.sid),
    sidTrans: up(origin.sidTrans),
    arr: airportCode(destination.icao),
    arrRwy: String(destination.rwy || '').replace(/^RW/i, '').toUpperCase(),
    star: up(destination.star),
    starTrans: up(destination.starTrans),
    approach: up(destination.approach),
    approachRwy: String(destination.approachRwy || '').replace(/^RW/i, '').toUpperCase(),
  };
}

/** Every label the map should print for the drawn procedures, at a zoom.
 *
 * Zoomed out, only where a procedure ends matters — the fix it hands over to,
 * which joins it to the plan. Zoomed in, every published fix is named. */
export function procedureLabels(results, zoom = 0) {
  const out = [];
  for (const result of results || []) {
    if (!result || !result.ok) continue;
    const lastSegment = result.segments.length - 1;
    result.segments.forEach((segment, segmentIndex) => {
      segment.forEach((point, index) => {
        if (!point.id || point.id.startsWith('RW')) return;
        const end = segmentIndex === lastSegment && index === segment.length - 1;
        if (zoom >= 8.5 || end) out.push({ id: point.id, lat: point.lat, lon: point.lon, kind: result.kind, end });
      });
    });
  }
  return out;
}
