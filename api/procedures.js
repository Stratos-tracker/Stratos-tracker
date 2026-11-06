/* Terminal procedures for the website.
 *
 * The Flight Deck draws published SID, STAR and approach paths from real
 * navigation data. On a pilot's own PC that data comes from the simulator,
 * through the bridge (`/procedures.json`). The public site has no simulator, so
 * this endpoint serves the same payload from the FAA CIFP dataset Stratos ships
 * in `navdata/cifp` — one small JSON file per airport, parsed from FAACIFP18.
 *
 * Nothing is generated here: a file that is not in the dataset is a 404 with a
 * reason, never an empty procedure or an interpolated one. Coverage is the
 * United States (the FAA publishes that file publicly); the response says so.
 */
import fs from 'node:fs/promises';
import path from 'node:path';

const DATA_DIR = path.join(process.cwd(), 'navdata', 'cifp');
const CODE = /^[A-Z0-9]{4}$/;

/* Vercel hands the handler a plain ServerResponse; the local dev server hands
   it the small shim the EFB's other API routes use (`status().json()`). Both
   are answered here so one handler serves the site and the preview. */
function json(res, status, body, cache) {
  const cacheControl = cache || 'public, s-maxage=3600, stale-while-revalidate=86400';
  if (typeof res.status === 'function' && typeof res.end !== 'function') {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', cacheControl);
    res.status(status).json(body);
    return;
  }
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', cacheControl);
  res.end(JSON.stringify(body));
}

async function readAirport(code) {
  const file = path.join(DATA_DIR, `${code}.json`);
  const text = await fs.readFile(file, 'utf8');
  const payload = JSON.parse(text);
  if (!payload || payload.ok !== true) throw new Error('malformed');
  return payload;
}

export default async function handler(req, res) {
  if (req.method && req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    return json(res, 405, { ok: false, error: 'Only GET is supported.' }, 'no-store');
  }

  const airport = String((req.query && req.query.airport) || '').trim().toUpperCase();
  if (!airport) {
    return json(res, 400, {
      ok: false,
      reason: 'no-airport',
      error: 'Name an airport: /api/procedures?airport=KSEA',
      coverage: 'FAA CIFP — United States',
    }, 'no-store');
  }
  if (!CODE.test(airport)) {
    return json(res, 400, {
      ok: false,
      reason: 'bad-airport',
      error: 'An airport is a four-character ICAO or FAA ident, such as KSEA or KJFK.',
    }, 'no-store');
  }

  try {
    let payload = await readAirport(airport);

    // The selection card asks for one kind at a time; filtering keeps that
    // response small without changing the shape the map already reads.
    const kind = String((req.query && req.query.kind) || '').trim().toLowerCase();
    const ident = String((req.query && req.query.id) || '').trim().toUpperCase();
    if (kind) {
      const list = payload.procedures && payload.procedures[kind];
      if (!Array.isArray(list)) {
        return json(res, 200, {
          ...payload,
          procedures: { ...(payload.procedures || {}), [kind]: [] },
        });
      }
      if (ident) {
        payload = {
          ...payload,
          procedures: { ...payload.procedures, [kind]: list.filter(p => String(p.id).toUpperCase() === ident) },
        };
      }
    }
    return json(res, 200, payload);
  } catch (error) {
    const missing = error && (error.code === 'ENOENT' || error.code === 'ENOTDIR');
    return json(res, missing ? 404 : 502, {
      ok: false,
      reason: missing ? 'not-in-dataset' : 'unreadable',
      airport,
      error: missing
        ? `The bundled FAA CIFP dataset has no procedures for ${airport}. It covers United States airports; elsewhere the simulator's own CIFP is the only source.`
        : `The procedure file for ${airport} could not be read.`,
      coverage: 'FAA CIFP — United States',
    }, missing ? 'public, s-maxage=86400' : 'no-store');
  }
}
