/**
 * End-to-end account and live-sync test against a running local Worker.
 *
 *   npx wrangler d1 execute stratos-accounts --local \
 *     --config relay/worker/wrangler.toml --file relay/worker/schema.sql
 *   npx wrangler dev --config relay/worker/wrangler.toml --local --port 8788
 *   node relay/worker/test/accounts.mjs http://127.0.0.1:8788
 *
 * It uses real D1 and a real Durable Object through Wrangler's local runtime,
 * so registration, login, email verification, password reset, logbook sync,
 * per-user isolation and the live WebSocket fan-out are all exercised as the
 * browser will exercise them.
 */
import assert from 'node:assert/strict';

const BASE = (process.argv[2] || 'http://127.0.0.1:8788').replace(/\/+$/, '');
const EMAIL_DOMAIN = `test-${Date.now()}.example`;

async function api(method, path, { token, body, headers = {} } = {}) {
  const init = { method, headers: { ...headers } };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers['content-type'] = 'application/json';
  }
  if (token) init.headers.authorization = `Bearer ${token}`;
  const response = await fetch(BASE + path, init);
  const text = await response.text();
  let payload = null;
  try { payload = JSON.parse(text); } catch { payload = { raw: text }; }
  return { status: response.status, payload };
}

function tokenFrom(link) {
  assert.ok(link, 'the development link should be present without a mail provider');
  return new URL(link).searchParams.get('token');
}

const stamp = Date.now();
const pilot = {
  email: `pilot.${stamp}@${EMAIL_DOMAIN}`,
  password: 'Stratus-9-Kestrel',
  username: `Pilot${String(stamp).slice(-6)}`,
};
const other = {
  email: `other.${stamp}@${EMAIL_DOMAIN}`,
  password: 'Cumulus-4-Tailwind',
  username: `Other${String(stamp).slice(-6)}`,
};

let failures = 0;
const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push(['pass', name]);
  } catch (error) {
    failures++;
    results.push(['FAIL', name, error && error.message]);
  }
}

// ── Registration ────────────────────────────────────────────────────
let session;
let verifyToken;
await check('sign-up creates an account and a session', async () => {
  const response = await api('POST', '/api/auth/signup', { body: pilot });
  assert.equal(response.status, 201, JSON.stringify(response.payload));
  assert.ok(response.payload.token && response.payload.token.length > 20);
  assert.equal(response.payload.user.email, pilot.email);
  assert.equal(response.payload.user.emailVerified, false);
  assert.equal(response.payload.verification.sent, false, 'no mail provider is configured locally');
  assert.ok(response.payload.verification.devLink, 'the link is returned so the flow is testable');
  session = response.payload.token;
  verifyToken = tokenFrom(response.payload.verification.devLink);
});

await check('short passwords are refused', async () => {
  const response = await api('POST', '/api/auth/signup', {
    body: { email: `short.${stamp}@${EMAIL_DOMAIN}`, password: 'short', username: `Short${stamp}`.slice(0, 20) },
  });
  assert.equal(response.status, 400);
});

await check('a duplicate email is refused with a readable reason', async () => {
  const response = await api('POST', '/api/auth/signup', { body: { ...pilot, username: `Dupe${stamp}`.slice(0, 20) } });
  assert.equal(response.status, 409);
  assert.match(response.payload.error, /already exists/i);
});

await check('no token means no data', async () => {
  const response = await api('GET', '/api/dashboard');
  assert.equal(response.status, 401);
});

await check('the session identifies the account', async () => {
  const response = await api('GET', '/api/auth/session', { token: session });
  assert.equal(response.status, 200);
  assert.equal(response.payload.user.username, pilot.username);
});

// ── Email verification ──────────────────────────────────────────────
await check('the verification link confirms the address', async () => {
  const response = await api('POST', '/api/auth/verify', { body: { token: verifyToken } });
  assert.equal(response.status, 200);
  assert.equal(response.payload.verified, true);
  const session2 = await api('GET', '/api/auth/session', { token: session });
  assert.equal(session2.payload.user.emailVerified, true);
});

await check('a used verification link is refused', async () => {
  const response = await api('POST', '/api/auth/verify', { body: { token: verifyToken } });
  assert.equal(response.status, 400);
});

// ── Login ───────────────────────────────────────────────────────────
await check('a wrong password is refused', async () => {
  const response = await api('POST', '/api/auth/login', { body: { email: pilot.email, password: 'Wrong-000000' } });
  assert.equal(response.status, 401);
  assert.match(response.payload.error, /do not match/i);
});

await check('the right password signs in on a second device', async () => {
  const response = await api('POST', '/api/auth/login', {
    body: { email: pilot.email, password: pilot.password },
    headers: { 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari/605.1.15' },
  });
  assert.equal(response.status, 200, JSON.stringify(response.payload));
  assert.ok(response.payload.token);
  assert.equal(response.payload.user.email, pilot.email);

  const sessions = await api('GET', '/api/account/sessions', { token: response.payload.token });
  assert.equal(sessions.status, 200);
  assert.ok(sessions.payload.sessions.length >= 2, 'both devices are listed');
  assert.ok(sessions.payload.sessions.some(row => row.label.includes('iPhone')), 'the phone is labelled');
  assert.equal(sessions.payload.sessions.filter(row => row.current).length, 1);
});

// ── Profile and preferences ─────────────────────────────────────────
await check('the username and avatar can be changed', async () => {
  const avatar = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const response = await api('PATCH', '/api/account', {
    token: session,
    body: { username: `Sky${String(stamp).slice(-6)}`, avatar },
  });
  assert.equal(response.status, 200, JSON.stringify(response.payload));
  assert.equal(response.payload.user.avatar, avatar);
  assert.ok(response.payload.user.username.startsWith('Sky'));
});

await check('a script URL is not accepted as an avatar', async () => {
  const response = await api('PATCH', '/api/account', { token: session, body: { avatar: 'javascript:alert(1)' } });
  assert.equal(response.status, 400);
});

await check('preferences round-trip', async () => {
  const written = await api('PUT', '/api/prefs', {
    token: session,
    body: { prefs: { units: 'imperial', theme: 'night', mapStyle: 'vector' } },
  });
  assert.equal(written.status, 200);
  const read = await api('GET', '/api/prefs', { token: session });
  assert.deepEqual(read.payload.prefs, { units: 'imperial', theme: 'night', mapStyle: 'vector' });
});

// ── Logbook sync and dashboard ──────────────────────────────────────
const takeoff = Date.now() - 3 * 3600 * 1000;
const landing = takeoff + 2.5 * 3600 * 1000;
const flight = {
  id: `f-${stamp}-1`,
  callsign: 'SWR123',
  depAirport: 'LSZH',
  arrAirport: 'EGLL',
  aircraft: 'Airbus A320neo',
  icao: 'A20N',
  registration: 'HB-JCA',
  startTime: takeoff - 600000,
  takeoffTime: takeoff,
  landingTime: landing,
  endTime: landing + 120000,
  distanceNm: 412,
  complete: true,
};

await check('a flight is written to the account logbook', async () => {
  const response = await api('POST', '/api/flights/sync', { token: session, body: { flights: [flight] } });
  assert.equal(response.status, 200, JSON.stringify(response.payload));
  assert.equal(response.payload.total, 1);
});

await check('syncing the same flight again does not duplicate it', async () => {
  await api('POST', '/api/flights/sync', { token: session, body: { flights: [flight] } });
  const response = await api('GET', '/api/flights', { token: session });
  assert.equal(response.payload.flights.length, 1);
  assert.equal(response.payload.flights[0].arrAirport, 'EGLL');
});

await check('the dashboard totals come from the logbook', async () => {
  const response = await api('GET', '/api/dashboard', { token: session });
  assert.equal(response.status, 200);
  assert.equal(response.payload.totals.flights, 1);
  assert.equal(response.payload.totals.seconds, 9000, '2.5 hours in seconds');
  assert.equal(response.payload.totals.distanceNm, 412);
  assert.equal(response.payload.recent[0].callsign, 'SWR123');
  assert.equal(response.payload.aircraft[0].name, 'A20N');
});

// ── Live flight over WebSocket ──────────────────────────────────────
/**
 * A viewer that buffers messages from the moment it is created, so a reply that
 * arrives while the open handler is still running is not lost.
 */
async function connect(token) {
  const ticket = await api('POST', '/api/live/ticket', { token });
  assert.equal(ticket.status, 200, JSON.stringify(ticket.payload));
  const url = `${BASE.replace(/^http/, 'ws')}/api/live/ws?ticket=${encodeURIComponent(ticket.payload.ticket)}`;
  const socket = new WebSocket(url);
  const buffered = [];
  const waiters = [];
  let closed = null;

  socket.addEventListener('message', event => {
    let parsed = null;
    try { parsed = JSON.parse(event.data); } catch { return; }
    const index = waiters.findIndex(waiter => waiter.predicate(parsed));
    if (index === -1) { buffered.push(parsed); return; }
    const [waiter] = waiters.splice(index, 1);
    clearTimeout(waiter.timer);
    waiter.resolve(parsed);
  });
  socket.addEventListener('close', event => {
    closed = { code: event.code, reason: event.reason };
    for (const waiter of waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(`the live socket closed (${event.code}) ${event.reason || ''}`.trim()));
    }
  });

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the live socket did not open')), 8000);
    socket.addEventListener('open', () => {
      clearTimeout(timer);
      // A send from inside the upgrade handler can race the 101, so the client
      // asks for the snapshot as soon as it is open.
      try { socket.send(JSON.stringify({ type: 'hello' })); } catch (_) { /* closed already */ }
      resolve();
    }, { once: true });
    socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('the live socket failed')); }, { once: true });
  });

  return {
    socket,
    next(predicate, label, timeout = 8000) {
      const index = buffered.findIndex(predicate);
      if (index !== -1) return Promise.resolve(buffered.splice(index, 1)[0]);
      if (closed) return Promise.reject(new Error(`the live socket closed (${closed.code}) ${closed.reason || ''}`.trim()));
      return new Promise((resolve, reject) => {
        const waiter = { predicate, resolve, reject, timer: null };
        waiter.timer = setTimeout(() => {
          const at = waiters.indexOf(waiter);
          if (at !== -1) waiters.splice(at, 1);
          reject(new Error(`timed out waiting for ${label}`));
        }, timeout);
        waiters.push(waiter);
      });
    },
  };
}

const snapshot = {
  phase: 'CRUISE',
  callsign: 'SWR123',
  telemetry: { lat: 47.4647, lon: 8.5492, alt: 36000, gs: 452, hdg: 302, vs: 0 },
  aircraft: { type: 'Airbus A320neo', icao: 'A20N', registration: 'HB-JCA', name: 'SWR123' },
  route: { dep: 'LSZH', dest: 'EGLL', progress: 0.42, distanceNm: 412, remainingNm: 239, etaMinutes: 32 },
};

await check('a PC publishes and two viewers watch the same live flight', async () => {
  const phone = await connect(session);
  const tablet = await connect(session);
  const initialPhone = await phone.next(message => message.type === 'state', 'the first state');
  assert.equal(initialPhone.live, false, 'nothing has been published yet');

  const publish = await api('POST', '/api/live/ingest', { token: session, body: snapshot });
  assert.equal(publish.status, 200, JSON.stringify(publish.payload));

  const [a, b] = await Promise.all([
    phone.next(message => message.type === 'snapshot', 'phone snapshot'),
    tablet.next(message => message.type === 'snapshot', 'tablet snapshot'),
  ]);
  assert.equal(a.snapshot.telemetry.alt, 36000);
  assert.equal(b.snapshot.route.dest, 'EGLL');
  assert.equal(a.snapshot.callsign, 'SWR123');

  const read = await api('GET', '/api/live', { token: session });
  assert.equal(read.payload.live, true);
  assert.equal(read.payload.stale, false);
  assert.equal(read.payload.snapshot.telemetry.gs, 452);
  assert.ok(read.payload.viewers >= 2, 'both viewers are counted on the room');

  phone.socket.close();
  tablet.socket.close();
});

await check('a live ticket is single use', async () => {
  const ticket = await api('POST', '/api/live/ticket', { token: session });
  assert.equal(ticket.status, 200);
  const query = `ticket=${encodeURIComponent(ticket.payload.ticket)}`;
  const socket = new WebSocket(`${BASE.replace(/^http/, 'ws')}/api/live/ws?${query}`);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the ticket socket did not open')), 8000);
    socket.addEventListener('open', () => { clearTimeout(timer); socket.close(); resolve(); }, { once: true });
    socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('the ticket socket failed')); }, { once: true });
  });
  // Replaying the same ticket must be refused, even as a plain request.
  const second = await api('GET', `/api/live/ws?${query}`);
  assert.equal(second.status, 401);
});

await check('a snapshot without a position is refused', async () => {
  const response = await api('POST', '/api/live/ingest', { token: session, body: { phase: 'CRUISE' } });
  assert.equal(response.status, 400);
});

// ── Per-user isolation ──────────────────────────────────────────────
await check('a second account sees none of the first account data', async () => {
  const created = await api('POST', '/api/auth/signup', { body: other });
  assert.equal(created.status, 201);
  const otherToken = created.payload.token;

  const dashboard = await api('GET', '/api/dashboard', { token: otherToken });
  assert.equal(dashboard.payload.totals.flights, 0, 'the logbook is empty for another account');
  const flights = await api('GET', '/api/flights', { token: otherToken });
  assert.equal(flights.payload.flights.length, 0);
  const live = await api('GET', '/api/live', { token: otherToken });
  assert.equal(live.payload.live, false, 'the live room is per account');

  const prefs = await api('GET', '/api/prefs', { token: otherToken });
  assert.deepEqual(prefs.payload.prefs, {});
  const sessions = await api('GET', '/api/account/sessions', { token: otherToken });
  assert.equal(sessions.payload.sessions.length, 1, 'only its own session is listed');
});

// ── Password reset ──────────────────────────────────────────────────
await check('a lost password can be reset and old sessions stop working', async () => {
  const forgot = await api('POST', '/api/auth/forgot', { body: { email: pilot.email } });
  assert.equal(forgot.status, 200);
  const resetToken = tokenFrom(forgot.payload.devLink);
  const nextPassword = 'Cirrus-7-Barometer';
  const reset = await api('POST', '/api/auth/reset', { body: { token: resetToken, password: nextPassword } });
  assert.equal(reset.status, 200, JSON.stringify(reset.payload));
  assert.ok(reset.payload.token, 'the browser that reset gets a fresh session');

  const old = await api('GET', '/api/dashboard', { token: session });
  assert.equal(old.status, 401, 'the previous session was revoked');

  const login = await api('POST', '/api/auth/login', { body: { email: pilot.email, password: nextPassword } });
  assert.equal(login.status, 200, 'the new password works');
  assert.equal(reset.payload.user.emailVerified, true, 'verification survives a reset');
});

await check('forgot-password does not reveal whether an address exists', async () => {
  const missing = await api('POST', '/api/auth/forgot', { body: { email: `nobody.${stamp}@${EMAIL_DOMAIN}` } });
  assert.equal(missing.status, 200);
  assert.equal(missing.payload.ok, true);
});

await check('logout ends the session', async () => {
  const login = await api('POST', '/api/auth/login', { body: { email: pilot.email, password: 'Cirrus-7-Barometer' } });
  const token = login.payload.token;
  assert.equal((await api('POST', '/api/auth/logout', { token })).status, 200);
  assert.equal((await api('GET', '/api/auth/session', { token })).status, 401);
});

for (const [state, name, detail] of results) {
  console.log(`${state === 'pass' ? '✔' : '✖'} ${name}${detail ? ` — ${detail}` : ''}`);
}
console.log(`\n${results.length - failures}/${results.length} account checks passed`);
process.exit(failures ? 1 : 0);
