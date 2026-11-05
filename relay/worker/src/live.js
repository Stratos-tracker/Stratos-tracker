/**
 * One live flight per pilot.
 *
 * Each account gets its own Durable Object instance, so the WebSocket fan-out is
 * naturally scoped: a socket only ever receives the snapshot belonging to the
 * account it was opened for, and there is no topic for a client to guess. The
 * Worker authenticates the request and derives the instance name from the user
 * id before it forwards the upgrade, so this object never sees a client-supplied
 * identity.
 *
 * The object uses the WebSocket hibernation API: sockets are accepted by the
 * runtime and survive eviction without a keep-alive bill, and the last snapshot
 * is checkpointed to storage so a cold instance still answers a new viewer.
 *
 * Traffic is one small JSON snapshot a second from the PC, broadcast to however
 * many phones and tablets are watching. Everything here is ephemeral by design;
 * the durable record of a finished flight lives in D1 (`flights`).
 */

const MAX_SNAPSHOT_BYTES = 32 * 1024;
const PERSIST_EVERY_MS = 10 * 1000;
const STALE_AFTER_MS = 20 * 1000;
const SNAPSHOT_KEY = 'snapshot';

function json(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

/**
 * Keep only what a viewer draws, with numbers that are numbers. Anything that
 * does not validate is dropped rather than forwarded, so one broken client
 * cannot poison the room.
 */
export function cleanSnapshot(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('Expected a snapshot object');
  }
  const num = (value, min, max) => {
    if (value == null || value === '') return null;
    const n = Number(value);
    if (!Number.isFinite(n) || n < min || n > max) return null;
    return Math.round(n * 1000) / 1000;
  };
  const text = (value, max) => String(value == null ? '' : value).trim().slice(0, max);
  const telemetry = body.telemetry && typeof body.telemetry === 'object' ? body.telemetry : {};
  const aircraft = body.aircraft && typeof body.aircraft === 'object' ? body.aircraft : {};
  const route = body.route && typeof body.route === 'object' ? body.route : {};

  const lat = num(telemetry.lat, -90, 90);
  const lon = num(telemetry.lon, -180, 180);
  if (lat == null || lon == null || (Math.abs(lat) < 1e-6 && Math.abs(lon) < 1e-6)) {
    throw new Error('A live snapshot needs a position');
  }

  const snapshot = {
    ts: Date.now(),
    seenAt: Number.isFinite(Number(telemetry.ts)) ? Math.round(Number(telemetry.ts)) : Date.now(),
    phase: text(body.phase, 24).toUpperCase() || 'AIRBORNE',
    onGround: Boolean(body.onGround),
    callsign: text(body.callsign, 16).toUpperCase(),
    telemetry: {
      lat, lon,
      alt: num(telemetry.alt, -1000, 100000),
      gs: num(telemetry.gs, 0, 1200),
      hdg: num(telemetry.hdg, 0, 360),
      vs: num(telemetry.vs, -10000, 10000),
    },
    aircraft: {
      type: text(aircraft.type, 40),
      icao: text(aircraft.icao, 8).toUpperCase(),
      registration: text(aircraft.registration, 16).toUpperCase(),
      name: text(aircraft.name, 60),
    },
    route: {
      dep: text(route.dep, 8).toUpperCase(),
      dest: text(route.dest, 8).toUpperCase(),
      cruiseAlt: num(route.cruiseAlt, 0, 100000),
      progress: num(route.progress, 0, 1),
      distanceNm: num(route.distanceNm, 0, 30000),
      remainingNm: num(route.remainingNm, 0, 30000),
      etaMinutes: num(route.etaMinutes, 0, 3000),
    },
    source: text(body.source, 24),
  };

  if (JSON.stringify(snapshot).length > MAX_SNAPSHOT_BYTES) throw new Error('Snapshot too large');
  return snapshot;
}

export class AccountLive {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.snapshot = null;
    this.updatedAt = 0;
    this.lastPersist = 0;
    this.ready = state.blockConcurrencyWhile(async () => {
      const saved = await state.storage.get(SNAPSHOT_KEY);
      if (saved && saved.snapshot) {
        this.snapshot = saved.snapshot;
        this.updatedAt = Number(saved.updatedAt) || 0;
      }
    });
  }

  sockets() {
    try {
      return this.state.getWebSockets() || [];
    } catch (_) {
      return [];
    }
  }

  broadcast(message) {
    const text = typeof message === 'string' ? message : JSON.stringify(message);
    let sent = 0;
    for (const socket of this.sockets()) {
      try {
        socket.send(text);
        sent++;
      } catch (_) { /* a socket that closed mid-send is simply gone */ }
    }
    return sent;
  }

  presence() {
    return this.sockets().length;
  }

  payload() {
    return {
      ok: true,
      live: Boolean(this.snapshot),
      stale: !this.snapshot || Date.now() - this.updatedAt > STALE_AFTER_MS,
      updatedAt: this.updatedAt,
      viewers: this.presence(),
      snapshot: this.snapshot,
    };
  }

  async persist() {
    const now = Date.now();
    if (now - this.lastPersist < PERSIST_EVERY_MS) return;
    this.lastPersist = now;
    try {
      await this.state.storage.put(SNAPSHOT_KEY, { snapshot: this.snapshot, updatedAt: this.updatedAt });
    } catch (_) { /* storage pressure must not break the live feed */ }
  }

  async fetch(request) {
    await this.ready;
    const url = new URL(request.url);
    // The Worker forwards the original URL (/api/live/ws, /api/live/ingest, …),
    // so routes match on the tail. Only this object's own instance is reachable
    // from the Worker, and the instance is picked from the authenticated user.
    const path = url.pathname;
    const is = suffix => path === suffix || path.endsWith(suffix);

    if (is('/ws')) {
      if (String(request.headers.get('upgrade') || '').toLowerCase() !== 'websocket') {
        return json(426, { ok: false, error: 'Expected a WebSocket upgrade' });
      }
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.state.acceptWebSocket(server);
      try {
        server.send(JSON.stringify({ type: 'state', ...this.payload() }));
      } catch (_) { /* the client will ask for a snapshot instead */ }
      return new Response(null, { status: 101, webSocket: client });
    }

    if (is('/snapshot')) {
      return json(200, this.payload());
    }

    if (is('/ingest') && request.method === 'POST') {
      let body;
      try {
        body = await request.json();
      } catch (_) {
        return json(400, { ok: false, error: 'Invalid JSON' });
      }
      let snapshot;
      try {
        snapshot = cleanSnapshot(body);
      } catch (error) {
        return json(400, { ok: false, error: error.message });
      }
      this.snapshot = snapshot;
      this.updatedAt = snapshot.ts;
      const sent = this.broadcast({ type: 'snapshot', ...this.payload() });
      await this.persist();
      return json(200, { ok: true, updatedAt: this.updatedAt, viewers: sent });
    }

    if (is('/clear') && request.method === 'POST') {
      this.snapshot = null;
      this.updatedAt = 0;
      this.broadcast({ type: 'state', ...this.payload() });
      await this.state.storage.put(SNAPSHOT_KEY, { snapshot: null, updatedAt: 0 });
      return json(200, { ok: true });
    }

    return json(404, { ok: false, error: 'Not found' });
  }

  async webSocketMessage(socket, message) {
    // The server drives every update. A client asks for the current state once
    // it is open (a send from inside the upgrade handler can race the 101), and
    // pings only to keep a proxy from closing an idle socket.
    if (typeof message !== 'string' || message.length > 200) return;
    let parsed = null;
    try { parsed = JSON.parse(message); } catch (_) { return; }
    if (!parsed) return;
    if (parsed.type === 'hello') {
      try { socket.send(JSON.stringify({ type: 'state', ...this.payload() })); } catch (_) { /* closed */ }
      return;
    }
    if (parsed.type === 'ping') {
      try { socket.send(JSON.stringify({ type: 'pong', at: Date.now(), viewers: this.presence() })); } catch (_) { /* closed */ }
    }
  }

  async webSocketClose(socket, code, reason) {
    try { socket.close(code === 1005 ? 1000 : code, reason); } catch (_) { /* already closed */ }
  }

  async webSocketError(socket) {
    try { socket.close(1011, 'socket error'); } catch (_) { /* already closed */ }
  }
}
