#!/usr/bin/env node
/* Local development server for app/.
 *
 * `python -m http.server` serves the same files, but the public ADS-B mirrors
 * (adsb.fi, adsb.one, adsb.lol, airplanes.live, OpenSky) send no CORS headers,
 * so a browser refuses to read them from a plain http origin and the ADS-B
 * traffic source dies with "unavailable". The hosted build avoids that with the
 * /api/traffic function; this server mounts that same handler, so a local
 * browser gets the identical server-side fetch and no duplicate allowlist.
 *
 * Usage: npm run dev   (then open http://127.0.0.1:8123)
 * Env:   PORT (default 8123), HOST (default 127.0.0.1), and STRATOS_BRIDGE
 *        (default http://127.0.0.1:8765) for the simulator's own procedure data.
 */
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import traffic from '../api/traffic.js';
import sectors from '../api/sectors.js';
import runways from '../api/runways.js';
import photo from '../api/photo.js';
import weather from '../api/weather.js';
import winds from '../api/winds.js';
import charts from '../api/charts.js';
import chart from '../api/chart.js';
import ourairports from '../api/ourairports.js';
import procedures from '../api/procedures.js';

const ROOT = path.resolve(import.meta.dirname, '..', 'app');
const PORT = Number(process.env.PORT) || 8123;
const HOST = process.env.HOST || '127.0.0.1';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

/** Minimal Express-shaped shim so the Vercel handler runs unchanged. */
function adapt(handler) {
  return (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    req.query = Object.fromEntries(url.searchParams);
    const shim = {
      status(code) {
        res.statusCode = code;
        return {
          json(body) {
            if (!res.hasHeader('Content-Type')) res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify(body));
          },
          send(body) {
            if (!res.hasHeader('Content-Type')) res.setHeader('Content-Type', 'application/octet-stream');
            res.end(body);
          },
        };
      },
      setHeader(name, value) { res.setHeader(name, value); },
    };
    return handler(req, shim);
  };
}

const trafficApi = adapt(traffic);
const photoApi = adapt(photo);
/* The procedure deck asks its own origin first (`/procedures.json`): that is
   the desktop build's bridge, answering from the simulator's own CIFP. A
   browser preview has no bridge on its origin, so this forwards that one path
   to a bridge running on this PC (STRATOS_BRIDGE, default the standard port).
   The simulator's files cover the whole world, so a preview can draw the real
   SID, STAR and approach geometry the FAA dataset does not carry. With no
   bridge answering, a plain 404 is passed back and the deck falls through to
   /api/procedures and the bundled dataset exactly as before. */
const BRIDGE = (process.env.STRATOS_BRIDGE || 'http://127.0.0.1:8765').replace(/\/+$/, '');

async function bridgeProcedures(req, res) {
  const miss = () => {
    res.statusCode = 404;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end('Not found');
  };
  let upstream;
  try {
    upstream = await fetch(BRIDGE + req.url, { signal: AbortSignal.timeout(30000) });
  } catch (_) {
    miss();
    return;
  }
  const body = await upstream.text().catch(() => null);
  if (!upstream.ok || body == null) {
    miss();
    return;
  }
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'HEAD') res.end();
  else res.end(body);
}

/* Satellite imagery. Over plain http the page asks its own origin for
   /tile/{z}/{x}/{y}.jpg, the way the packaged bridge answers it; without this
   route a local preview returned 404 and the satellite style painted nothing.
   Esri's template takes the row before the column, and a tile is immutable, so
   a small cache spares the upstream service a second fetch per pan. */
const TILE_RE = /^\/tile\/(\d+)\/(\d+)\/(\d+)\.jpg$/;
const TILE_CACHE = new Map();
const TILE_CACHE_MAX = 400;

async function tileImage(req, res) {
  const miss = () => {
    res.statusCode = 404;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end('Not found');
  };
  const match = TILE_RE.exec(new URL(req.url, 'http://localhost').pathname);
  if (!match) return miss();
  const [, z, x, y] = match;
  const key = z + '/' + x + '/' + y;
  let tile = TILE_CACHE.get(key);
  if (!tile) {
    const upstream = `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`;
    let answer;
    try {
      answer = await fetch(upstream, { signal: AbortSignal.timeout(15000) });
    } catch (_) {
      return miss();
    }
    if (!answer.ok) {
      if (answer.body) await answer.body.cancel().catch(() => {});
      return miss();
    }
    const type = answer.headers.get('content-type') || '';
    if (!/^image\//i.test(type)) {
      if (answer.body) await answer.body.cancel().catch(() => {});
      return miss();
    }
    tile = { body: Buffer.from(await answer.arrayBuffer()), type: type.split(';')[0] };
    TILE_CACHE.set(key, tile);
    if (TILE_CACHE.size > TILE_CACHE_MAX) TILE_CACHE.delete(TILE_CACHE.keys().next().value);
  }
  res.statusCode = 200;
  res.setHeader('Content-Type', tile.type);
  res.setHeader('Cache-Control', 'max-age=604800');
  if (req.method === 'HEAD') res.end();
  else res.end(tile.body);
}

/* The same serverless handlers the hosted site uses, so the EFB's weather,
   charts and airport search work in a local browser too. */
const ROUTES = {
  '/procedures.json': bridgeProcedures,
  '/api/traffic': trafficApi,
  '/api/sectors': adapt(sectors),
  '/api/runways': adapt(runways),
  '/api/photo': photoApi,
  '/api/weather': adapt(weather),
  '/api/winds': adapt(winds),
  '/api/charts': adapt(charts),
  '/api/chart': adapt(chart),
  '/api/ourairports': adapt(ourairports),
  '/api/procedures': adapt(procedures),
};

/** A path inside app/, or null when it escapes the root. */
function resolveFile(pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch (_) {
    return null;
  }
  let target = path.resolve(ROOT, '.' + decoded);
  if (target !== ROOT && !target.startsWith(ROOT + path.sep)) return null;
  try {
    if (fs.statSync(target).isDirectory()) target = path.join(target, 'index.html');
  } catch (_) {
    if (pathname.endsWith('/')) target = path.join(target, 'index.html');
  }
  return target;
}

/* Public page routes, so a clean URL works locally exactly as it does on the
   host. /phone is the landing page's Phone Mode entry point. */
const PAGE_ALIASES = {
  // Phone Mode is the Flight Deck itself: the same page, its own iPhone
  // optimization, and the same map — not a second interface.
  '/phone': '/index.html',
  '/phone/': '/index.html',
};

const server = http.createServer(async (req, res) => {
  const parsed = new URL(req.url, 'http://localhost');
  let pathname = PAGE_ALIASES[parsed.pathname] || parsed.pathname;
  // The hosted site serves this directory as /app (the landing page sits beside
  // it at the root). Matching that here keeps the phone page's /app/ base href
  // and the tracker's absolute asset paths working in a local browser too.
  if (pathname.startsWith('/app/')) pathname = pathname.slice(4);

  if (TILE_RE.test(pathname)) {
    try {
      await tileImage(req, res);
    } catch (_) {
      if (!res.writableEnded) {
        res.statusCode = 404;
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.end('Not found');
      }
    }
    return;
  }

  const route = ROUTES[pathname] || null;
  if (route) {
    try {
      await route(req, res);
    } catch (_) {
      if (!res.writableEnded) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ error: 'Proxy failed' }));
      }
    }
    return;
  }

  const file = resolveFile(pathname);
  if (!file) {
    res.statusCode = 404;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end('Not found');
    return;
  }
  let body;
  try {
    body = await fsp.readFile(file);
  } catch (_) {
    res.statusCode = 404;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end('Not found');
    return;
  }
  res.statusCode = 200;
  res.setHeader('Content-Type', TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream');
  res.setHeader('Cache-Control', 'no-cache');
  if (req.method === 'HEAD') res.end();
  else res.end(body);
});

server.listen(PORT, HOST, () => {
  console.log(`Stratos dev server: http://${HOST}:${PORT}/  (ADS-B via /api/traffic, photos via /api/photo)`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
