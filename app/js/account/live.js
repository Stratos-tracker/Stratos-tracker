/* Live flight, end to end.
 *
 * Two halves:
 *
 *   LiveFeed  — a viewer. Opens one short-lived ticket, connects the WebSocket,
 *               reconnects with backoff, and falls back to polling if the socket
 *               cannot be established. Any number of devices may watch at once.
 *
 *   startPublisher — the PC. It reads the telemetry the bridge already streams to
 *               the tracker (GET /stream, server-sent events) and posts one small
 *               snapshot a second to the account service. The bridge keeps doing
 *               exactly what it did before; nothing on the simulator side changed.
 *
 * The phone never runs a bridge and never learns the PC's address: it only talks
 * to the account service.
 */

import { bridgeOrigin, probeBridge, blocksLocalBridge, BRIDGE_STORAGE_KEY } from '../lib/connect.js';
import * as api from './api.js';

const PING_MS = 25_000;
const STALE_MS = 20_000;

/** Whatever the bridge calls a value, one shape leaves this module. */
export function toSnapshot(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const flight = raw.currentFlight || raw.flight || {};
  const pick = (...values) => values.find(value => value !== undefined && value !== null && value !== '');

  const lat = Number(pick(raw.lat, raw.latitude, flight.lat));
  const lon = Number(pick(raw.lon, raw.lng, raw.longitude, flight.lon));
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  if (Math.abs(lat) < 1e-6 && Math.abs(lon) < 1e-6) return null;

  const number = value => {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  };

  return {
    telemetry: {
      lat,
      lon,
      alt: number(pick(raw.alt, raw.altFt, raw.altitude, raw.altitudeFt)),
      agl: number(pick(raw.agl, raw.altAgl, raw.aglFt)),
      // Four different speeds and three different directions. Each one is
      // forwarded as itself; none is used as a fallback for another.
      gs: number(pick(raw.gs, raw.groundSpeed, raw.spd)),
      ias: number(pick(raw.ias, raw.indicatedAirspeed, raw.kias)),
      tas: number(pick(raw.tas, raw.trueAirspeed, raw.ktas)),
      hdg: number(pick(raw.hdg, raw.heading, raw.trueHeading)),
      hdgMag: number(pick(raw.hdgMag, raw.magneticHeading)),
      trk: number(pick(raw.trk, raw.track, raw.groundTrack)),
      vs: number(pick(raw.vs, raw.verticalSpeed, raw.vsFpm)),
      bank: number(pick(raw.bank, raw.roll)),
      pitch: number(pick(raw.pitch)),
      windDir: number(pick(raw.windDir, raw.windDirection)),
      windSpd: number(pick(raw.windSpd, raw.windSpeed)),
      oat: number(pick(raw.oat, raw.temperature, raw.oatC)),
      ts: Date.now(),
    },
    aircraft: {
      type: String(pick(raw.aircraftType, raw.type, '') || '').slice(0, 40),
      icao: String(pick(raw.icao, raw.icaoType, '') || '').slice(0, 8).toUpperCase(),
      registration: String(pick(raw.registration, raw.reg, '') || '').slice(0, 16).toUpperCase(),
      name: String(pick(raw.aircraft, raw.name, '') || '').slice(0, 60),
    },
    route: {
      dep: String(pick(flight.depAirport, raw.depAirport, raw.dep, '') || '').slice(0, 8).toUpperCase(),
      dest: String(pick(flight.arrAirport, raw.arrAirport, raw.dest, '') || '').slice(0, 8).toUpperCase(),
      cruiseAlt: number(pick(flight.cruiseAlt, raw.cruiseAlt)),
      progress: number(pick(flight.progress, raw.progress)),
      distanceNm: number(pick(flight.distanceNm, raw.distanceNm)),
      remainingNm: number(pick(flight.remainingNm, raw.remainingNm)),
      etaMinutes: number(pick(flight.etaMinutes, raw.etaMinutes)),
    },
    phase: String(pick(raw.flightPhase, raw.phase, '') || '').slice(0, 24),
    onGround: Boolean(pick(raw.onGround, raw.on_ground)),
    callsign: String(pick(raw.callsign, flight.callsign, '') || '').slice(0, 16).toUpperCase(),
    source: 'bridge',
  };
}

export class LiveFeed {
  /**
   * @param {object} options
   * @param {(state:object)=>void} options.onState  every state/snapshot frame
   * @param {(status:{state:string,detail?:string,viewers?:number})=>void} options.onStatus
   */
  constructor({ onState, onStatus } = {}) {
    this.onState = onState || (() => {});
    this.onStatus = onStatus || (() => {});
    this.socket = null;
    this.timer = null;
    this.pinger = null;
    this.attempts = 0;
    this.stopped = true;
    this.polling = null;
    this.reported = '';
  }

  status(state, detail, viewers) {
    if (state === this.reported && !detail) return;
    this.reported = state;
    this.onStatus({ state, detail, viewers });
  }

  async start() {
    if (!this.stopped) return;
    this.stopped = false;
    await this.connect();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    clearInterval(this.pinger);
    clearInterval(this.polling);
    this.timer = null;
    this.polling = null;
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      try { socket.close(1000, 'viewer left'); } catch (_) { /* already gone */ }
    }
  }

  schedule(ms) {
    clearTimeout(this.timer);
    if (this.stopped) return;
    this.timer = setTimeout(() => this.connect(), ms);
  }

  /** Exponential backoff with jitter, capped so a phone on a train keeps trying. */
  backoff() {
    this.attempts += 1;
    const base = Math.min(30_000, 800 * 2 ** Math.min(6, this.attempts));
    return Math.round(base * (0.7 + Math.random() * 0.6));
  }

  async connect() {
    if (this.stopped) return;
    clearInterval(this.polling);
    this.polling = null;
    this.status(this.attempts ? 'reconnecting' : 'connecting');

    let ticket;
    try {
      const response = await api.liveTicket();
      ticket = response.ticket;
      if (!ticket) throw new Error('no ticket');
    } catch (error) {
      if (error && error.status === 401) {
        this.status('signed-out');
        return;
      }
      // The account service is unreachable, not the socket: retry later.
      this.status('offline', error && error.message);
      this.schedule(this.backoff());
      return;
    }

    let socket;
    try {
      socket = new WebSocket(api.liveSocketUrl(ticket));
    } catch (_) {
      this.startPolling();
      return;
    }
    this.socket = socket;

    socket.addEventListener('open', () => {
      this.attempts = 0;
      this.status('connected');
      // Listeners are attached before this send, so the reply cannot be missed.
      try { socket.send(JSON.stringify({ type: 'hello' })); } catch (_) { /* closing */ }
      clearInterval(this.pinger);
      this.pinger = setInterval(() => {
        try { socket.send(JSON.stringify({ type: 'ping' })); } catch (_) { /* closing */ }
      }, PING_MS);
    });

    socket.addEventListener('message', event => {
      let frame = null;
      try { frame = JSON.parse(event.data); } catch { return; }
      if (!frame || typeof frame !== 'object') return;
      if (frame.type === 'pong') return;
      this.onState(frame);
    });

    socket.addEventListener('close', event => {
      clearInterval(this.pinger);
      if (this.stopped) return;
      if (event.code === 1008 || event.code === 4401) {
        // Authorization is gone (session revoked elsewhere). Do not hammer.
        this.status('signed-out');
        return;
      }
      // A normal close right after a ticket is usually a deploy or a sleep.
      if (this.attempts >= 2) this.startPolling();
      this.status('reconnecting');
      this.schedule(this.backoff());
    });

    socket.addEventListener('error', () => {
      // A close event follows; nothing to do beyond letting it run.
    });
  }

  /**
   * If the socket cannot stay up (a proxy that strips upgrades, for example),
   * keep the data flowing with plain HTTP. Same payload, one second apart.
   */
  startPolling() {
    if (this.stopped || this.polling) return;
    const tick = async () => {
      try {
        const payload = await api.liveSnapshot();
        this.onState({ type: 'state', ...payload, transport: 'poll' });
        this.status('polling');
      } catch (_) { /* the next tick tries again */ }
    };
    tick();
    this.polling = setInterval(tick, 3000);
  }
}

/**
 * Is a bridge running on this machine, and where? The tracker is normally opened
 * from the bridge itself, in which case the answer is simply this origin.
 */
export async function findBridge() {
  if (blocksLocalBridge()) return null;
  const saved = (() => {
    try { return localStorage.getItem(BRIDGE_STORAGE_KEY) || ''; } catch (_) { return ''; }
  })();
  const sameOrigin = `${location.protocol}//${location.host}`;
  const candidates = [saved, sameOrigin, bridgeOrigin('127.0.0.1')].filter(Boolean);
  for (const candidate of candidates) {
    try {
      // probeBridge answers with a result object even when nothing is there, so
      // only ok:true proves a bridge; anything else would start a publisher
      // pointed at an ordinary web server.
      const result = await probeBridge(candidate);
      if (result && result.ok) return { base: result.base, health: result.health };
    } catch (_) { /* try the next one */ }
  }
  return null;
}

/**
 * Forward the simulator to the account service while this page is open.
 * Returns a stop function; it is safe to call more than once.
 */
export function startPublisher(base, { onPublished, onProblem } = {}) {
  let source = null;
  let stopped = false;
  let lastSent = 0;
  let lastKey = '';
  let lastProblem = '';

  const problem = message => {
    if (message === lastProblem) return;
    lastProblem = message;
    if (onProblem) onProblem(message);
  };

  try {
    source = new EventSource(`${String(base).replace(/\/+$/, '')}/stream?hz=2`);
  } catch (_) {
    problem('This browser cannot open the bridge stream.');
    return () => {};
  }

  source.addEventListener('message', async event => {
    if (stopped) return;
    let raw = null;
    try { raw = JSON.parse(event.data); } catch { return; }
    const snapshot = toSnapshot(raw);
    if (!snapshot) return;

    const now = Date.now();
    const position = snapshot.telemetry;
    const key = [position.lat.toFixed(3), position.lon.toFixed(3), position.alt, position.gs, position.hdg].join('|');
    // One a second is plenty for a phone and keeps the free plan comfortable;
    // a heartbeat still goes out every five seconds while nothing changes.
    if (now - lastSent < 900) return;
    if (key === lastKey && now - lastSent < 5000) return;

    lastSent = now;
    lastKey = key;
    try {
      const result = await api.ingestLive(snapshot);
      lastProblem = '';
      if (onPublished) onPublished(result);
    } catch (error) {
      if (error && error.status === 401) {
        stopped = true;
        try { source.close(); } catch (_) { /* already closed */ }
        problem('The account session ended, so live publishing stopped. Sign in again.');
        return;
      }
      problem(error.message || 'The live snapshot could not be published.');
    }
  });

  source.addEventListener('error', () => {
    if (stopped) return;
    problem('Waiting for the bridge stream…');
  });

  return () => {
    stopped = true;
    try { source.close(); } catch (_) { /* already closed */ }
  };
}

export const LIVE_STALE_MS = STALE_MS;
