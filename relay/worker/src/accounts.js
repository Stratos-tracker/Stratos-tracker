/**
 * Stratos account API.
 *
 * This lives in the same Worker as the existing phone relay, so the project
 * keeps one backend, one deployment and one origin for the app and the bridge.
 * It adds accounts on D1 and a per-user live room on Durable Objects; the relay
 * routes above it (`/api/pair`, `/api/ingest`, `/api/state`, …) are untouched.
 *
 * Session model
 *   A sign-in mints a 32-byte opaque token. The browser keeps it and sends it as
 *   `Authorization: Bearer`. Only its SHA-256 digest is stored, so the database
 *   cannot be replayed as a login. A bearer token is used rather than a cookie
 *   because the site runs on its own domain and the API on workers.dev: Safari
 *   blocks third-party cookies outright, so a cookie would silently fail on the
 *   exact device this feature is for. Sessions slide for 30 days and are listed
 *   and revocable from Settings.
 *
 * Isolation
 *   Every query is scoped by the authenticated user id. Flight rows use the
 *   composite key (user_id, id) so a client-chosen id cannot reach another
 *   account's row.
 */

import {
  ApiError,
  SESSION_TTL_MS,
  hashPassword,
  verifyPassword,
  randomToken,
  sha256,
  newId,
  normalizeEmail,
  normalizeUsername,
  validateEmail,
  validateUsername,
  validatePassword,
  sessionLabel,
} from './auth.js';

const MAX_BODY = 64 * 1024;
const MAX_SYNC_BODY = 3 * 1024 * 1024;
const MAX_PREFS_BYTES = 24 * 1024;
const MAX_AVATAR_CHARS = 420 * 1024;
const MAX_FLIGHTS = 1000;
const MAX_FLIGHT_TEXT = 110 * 1024;
const VERIFY_TTL_MS = 48 * 60 * 60 * 1000;
const RESET_TTL_MS = 60 * 60 * 1000;
const TICKET_TTL_MS = 90 * 1000;
const MAX_FAILED = 8;
const LOCK_MS = 15 * 60 * 1000;

export function json(status, payload, cors = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

function requireDb(env) {
  if (!env || !env.DB) {
    throw new ApiError(503, 'Accounts are not set up on this relay yet. Create the D1 database, apply relay/worker/schema.sql, and deploy.');
  }
  return env.DB;
}

async function readJson(request, limit = MAX_BODY) {
  const text = await request.text();
  if (text.length > limit) throw new ApiError(413, 'That request is too large.');
  if (!text.trim()) return {};
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (_) {
    throw new ApiError(400, 'That request was not valid JSON.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ApiError(400, 'Expected a JSON object.');
  }
  return parsed;
}

function safeParse(value, fallback) {
  try {
    const parsed = JSON.parse(value);
    return parsed == null ? fallback : parsed;
  } catch (_) {
    return fallback;
  }
}

function userView(row) {
  return {
    id: row.id,
    email: row.email,
    username: row.username,
    avatar: row.avatar || '',
    emailVerified: Boolean(row.email_verified_at),
    createdAt: row.created_at,
    prefs: safeParse(row.prefs, {}),
  };
}

const USER_COLUMNS = 'u.id, u.email, u.username, u.avatar, u.prefs, u.email_verified_at, u.created_at';

async function authenticate(request, env) {
  const db = requireDb(env);
  const header = String(request.headers.get('authorization') || '');
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token || token.length < 20 || token.length > 200) {
    throw new ApiError(401, 'Sign in to continue.');
  }
  const row = await db.prepare(
    `SELECT s.id AS session_id, s.expires_at, s.last_seen_at, ${USER_COLUMNS}
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ?`,
  ).bind(await sha256(token)).first();
  if (!row) throw new ApiError(401, 'Your session has ended. Sign in again.');
  const now = Date.now();
  if (Number(row.expires_at) < now) {
    await db.prepare('DELETE FROM sessions WHERE id = ?').bind(row.session_id).run();
    throw new ApiError(401, 'Your session has expired. Sign in again.');
  }
  // Slide the window at most twice an hour on a busy account.
  if (now - Number(row.last_seen_at) > 30 * 60 * 1000) {
    await db.prepare('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?')
      .bind(now, now + SESSION_TTL_MS, row.session_id).run();
  }
  return { user: row, sessionId: row.session_id, token };
}

async function createSession(env, userId, request, now = Date.now()) {
  const token = randomToken(32);
  const userAgent = String(request.headers.get('user-agent') || '').slice(0, 200);
  await requireDb(env).prepare(
    `INSERT INTO sessions (id, user_id, token_hash, label, user_agent, created_at, last_seen_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(newId(), userId, await sha256(token), sessionLabel(userAgent), userAgent, now, now, now + SESSION_TTL_MS).run();
  return token;
}

async function issueEmailToken(env, userId, purpose, ttlMs) {
  const token = randomToken(32);
  const now = Date.now();
  await requireDb(env).prepare(
    'INSERT INTO email_tokens (token_hash, user_id, purpose, created_at, expires_at, used_at) VALUES (?, ?, ?, ?, ?, NULL)',
  ).bind(await sha256(token), userId, purpose, now, now + ttlMs).run();
  return token;
}

function appBase(env) {
  return String(env.APP_BASE_URL || 'https://www.stratos-tracker.com').replace(/\/+$/, '');
}

/**
 * One email helper for both messages. A provider is optional: without
 * EMAIL_API_KEY the link is returned to the caller in development so the flow
 * can be completed and tested, and nothing is silently pretended to have been
 * sent. With a key, it posts Resend's HTTP API (or EMAIL_API_URL for any
 * provider that accepts {from,to,subject,text}).
 */
async function sendMail(env, { to, subject, text }) {
  const key = String(env.EMAIL_API_KEY || '').trim();
  if (!key) return { sent: false, reason: 'not-configured' };
  const from = String(env.EMAIL_FROM || 'Stratos <accounts@stratos-tracker.com>');
  const endpoint = String(env.EMAIL_API_URL || 'https://api.resend.com/emails');
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to: [to], subject, text }),
    });
    if (!response.ok) {
      console.error('email provider refused the message', response.status, (await response.text()).slice(0, 300));
      return { sent: false, reason: 'provider-error' };
    }
    return { sent: true };
  } catch (error) {
    console.error('email provider could not be reached', error && error.message);
    return { sent: false, reason: 'network' };
  }
}

function verificationMail(base, token) {
  const link = `${base}/app/verify.html?token=${encodeURIComponent(token)}`;
  return {
    link,
    subject: 'Confirm your Stratos account',
    text: `Welcome to Stratos.\n\nConfirm your email address to finish setting up your account:\n\n${link}\n\nThe link expires in 48 hours. If you did not create a Stratos account, ignore this message.`,
  };
}

function resetMail(base, token) {
  const link = `${base}/app/reset.html?token=${encodeURIComponent(token)}`;
  return {
    link,
    subject: 'Reset your Stratos password',
    text: `Someone asked to reset the password for this Stratos account.\n\nChoose a new password here:\n\n${link}\n\nThe link expires in one hour and works once. If this was not you, no action is needed and your password is unchanged.`,
  };
}

function ms(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n < 1e12 ? Math.round(n * 1000) : Math.round(n);
}

function seconds(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round(n * 10) / 10;
}

function text(value, max) {
  return String(value == null ? '' : value).trim().slice(0, max);
}

/** A logbook record from the app, reduced to the columns the dashboard reads. */
function compactFlight(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const id = text(raw.id, 64);
  if (!id || /[^\w.:@+-]/.test(id)) return null;
  const data = JSON.stringify(raw);
  if (data.length > MAX_FLIGHT_TEXT) return null;
  // The logbook records a takeoff and a landing time; the dashboard sums from
  // those first, and only falls back to the wider session window.
  const takeoff = ms(raw.takeoffTime);
  const landing = ms(raw.landingTime);
  const started = takeoff || ms(raw.startTime ?? raw.startedAt ?? raw.start ?? raw.start_time ?? raw.date);
  const ended = landing || ms(raw.endTime ?? raw.endedAt ?? raw.end);
  const flown = takeoff > 0 && landing > takeoff ? Math.round((landing - takeoff) / 1000) : 0;
  return {
    id,
    callsign: text(raw.callsign, 16).toUpperCase(),
    dep: text(raw.depAirport ?? raw.dep ?? raw.from ?? raw.origin, 8).toUpperCase(),
    arr: text(raw.arrAirport ?? raw.arr ?? raw.to ?? raw.destination, 8).toUpperCase(),
    aircraft: text(raw.aircraftType ?? raw.aircraft ?? raw.type ?? raw.aircraftName, 60),
    icao: text(raw.icao ?? raw.aircraftIcao ?? raw.typeCode, 8).toUpperCase(),
    registration: text(raw.registration ?? raw.reg ?? raw.tail, 16).toUpperCase(),
    started,
    ended,
    duration: flown || seconds(raw.durationSec ?? raw.durationSeconds ?? raw.duration ?? raw.blockSeconds ?? raw.hours * 3600),
    distance: seconds(raw.distanceNm ?? raw.distance ?? raw.nm),
    data,
  };
}

function liveStub(env, userId) {
  if (!env || !env.LIVE) {
    throw new ApiError(503, 'Live sync is not set up on this relay yet.');
  }
  return env.LIVE.get(env.LIVE.idFromName(`user:${userId}`));
}

async function liveSnapshot(env, userId) {
  try {
    const response = await liveStub(env, userId).fetch(new Request('https://live.internal/snapshot'));
    if (!response.ok) return { ok: false, live: false, stale: true, snapshot: null };
    return await response.json();
  } catch (_) {
    return { ok: false, live: false, stale: true, snapshot: null };
  }
}

/**
 * The router. Returns null for a path it does not own, so the Worker can pass
 * that request to the existing relay Durable Object unchanged.
 */
export async function handleAccountApi(request, env, url, cors = {}) {
  const method = request.method.toUpperCase();
  const path = url.pathname;

  const isAccountPath = path.startsWith('/api/auth/')
    || path === '/api/account'
    || path === '/api/account/password'
    || path === '/api/account/sessions'
    || path === '/api/account/sessions/revoke'
    || path === '/api/dashboard'
    || path === '/api/flights'
    || path === '/api/flights/sync'
    || path === '/api/prefs'
    || path === '/api/live'
    || path === '/api/live/ingest'
    || path === '/api/live/ticket'
    || path === '/api/live/ws'
    || path === '/api/live/clear';
  if (!isAccountPath) return null;

  try {
    const db = requireDb(env);

    // ── Create an account ──────────────────────────────────────────
    if (path === '/api/auth/signup' && method === 'POST') {
      const body = await readJson(request);
      const emailProblem = validateEmail(body.email);
      if (emailProblem) throw new ApiError(400, emailProblem);
      const passwordProblem = validatePassword(body.password);
      if (passwordProblem) throw new ApiError(400, passwordProblem);
      const usernameProblem = validateUsername(body.username);
      if (usernameProblem) throw new ApiError(400, usernameProblem);

      const email = String(body.email).trim();
      const emailNorm = normalizeEmail(email);
      const username = String(body.username).trim();
      const usernameNorm = normalizeUsername(username);

      const takenEmail = await db.prepare('SELECT id FROM users WHERE email_norm = ?').bind(emailNorm).first();
      if (takenEmail) throw new ApiError(409, 'An account with that email already exists. Sign in instead.');
      const takenName = await db.prepare('SELECT id FROM users WHERE username_norm = ?').bind(usernameNorm).first();
      if (takenName) throw new ApiError(409, 'That username is taken. Try another.');

      const now = Date.now();
      const userId = newId();
      const password = await hashPassword(String(body.password), env.PBKDF2_ITERATIONS);
      await db.prepare(
        `INSERT INTO users (id, email, email_norm, username, username_norm, password_hash, password_salt,
                            iterations, avatar, prefs, email_verified_at, failed_attempts, locked_until,
                            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, '{}', NULL, 0, 0, ?, ?)`,
      ).bind(userId, email, emailNorm, username, usernameNorm,
        password.password_hash, password.password_salt, password.iterations, now, now).run();

      const token = await createSession(env, userId, request, now);
      const verifyToken = await issueEmailToken(env, userId, 'verify', VERIFY_TTL_MS);
      const mail = verificationMail(appBase(env), verifyToken);
      const delivery = await sendMail(env, { to: email, subject: mail.subject, text: mail.text });

      const row = await db.prepare(`SELECT ${USER_COLUMNS} FROM users u WHERE u.id = ?`).bind(userId).first();
      return json(201, {
        ok: true,
        token,
        user: userView(row),
        verification: {
          sent: delivery.sent,
          reason: delivery.reason || null,
          // Only ever returned when no mail provider is configured, so a local
          // or staging deployment can finish the flow without pretending.
          devLink: delivery.sent ? null : mail.link,
        },
      }, cors);
    }

    // ── Sign in ────────────────────────────────────────────────────
    if (path === '/api/auth/login' && method === 'POST') {
      const body = await readJson(request);
      const emailNorm = normalizeEmail(body.email);
      const password = String(body.password == null ? '' : body.password);
      if (!emailNorm || !password) throw new ApiError(400, 'Enter your email address and password.');

      const record = await db.prepare(
        `SELECT ${USER_COLUMNS}, u.password_hash, u.password_salt, u.iterations, u.failed_attempts, u.locked_until
           FROM users u WHERE u.email_norm = ?`,
      ).bind(emailNorm).first();
      // One message for an unknown address and a wrong password, so the endpoint
      // cannot be used to discover which addresses have accounts.
      const rejected = new ApiError(401, 'That email and password do not match an account.');
      if (!record) throw rejected;

      const now = Date.now();
      if (Number(record.locked_until) > now) {
        const minutes = Math.max(1, Math.ceil((Number(record.locked_until) - now) / 60000));
        throw new ApiError(429, `Too many attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`);
      }
      if (!(await verifyPassword(password, record))) {
        const failed = Number(record.failed_attempts) + 1;
        const lockedUntil = failed >= MAX_FAILED ? now + LOCK_MS : 0;
        await db.prepare('UPDATE users SET failed_attempts = ?, locked_until = ? WHERE id = ?')
          .bind(failed >= MAX_FAILED ? 0 : failed, lockedUntil, record.id).run();
        throw rejected;
      }
      await db.prepare('UPDATE users SET failed_attempts = 0, locked_until = 0 WHERE id = ?').bind(record.id).run();
      const token = await createSession(env, record.id, request, now);
      return json(200, { ok: true, token, user: userView(record) }, cors);
    }

    // ── Who am I ───────────────────────────────────────────────────
    if (path === '/api/auth/session' && method === 'GET') {
      const { user } = await authenticate(request, env);
      return json(200, { ok: true, user: userView(user) }, cors);
    }

    // ── Sign out ───────────────────────────────────────────────────
    if (path === '/api/auth/logout' && method === 'POST') {
      const { sessionId } = await authenticate(request, env);
      await db.prepare('DELETE FROM sessions WHERE id = ?').bind(sessionId).run();
      return json(200, { ok: true }, cors);
    }

    // ── Confirm an email address ───────────────────────────────────
    if (path === '/api/auth/verify' && method === 'POST') {
      const body = await readJson(request, 4096);
      const token = String(body.token || '').trim();
      if (!token) throw new ApiError(400, 'That confirmation link is incomplete.');
      const row = await db.prepare(
        'SELECT token_hash, user_id, expires_at, used_at FROM email_tokens WHERE token_hash = ? AND purpose = ?',
      ).bind(await sha256(token), 'verify').first();
      if (!row || row.used_at || Number(row.expires_at) < Date.now()) {
        throw new ApiError(400, 'That link has expired. Request a new confirmation email from Settings.');
      }
      const now = Date.now();
      await db.prepare('UPDATE email_tokens SET used_at = ? WHERE token_hash = ?').bind(now, row.token_hash).run();
      await db.prepare('UPDATE users SET email_verified_at = ?, updated_at = ? WHERE id = ?')
        .bind(now, now, row.user_id).run();
      return json(200, { ok: true, verified: true }, cors);
    }

    // ── Ask for another confirmation email ─────────────────────────
    if (path === '/api/auth/resend' && method === 'POST') {
      const { user } = await authenticate(request, env);
      if (user.email_verified_at) return json(200, { ok: true, alreadyVerified: true }, cors);
      const recent = await db.prepare(
        'SELECT created_at FROM email_tokens WHERE user_id = ? AND purpose = ? ORDER BY created_at DESC LIMIT 1',
      ).bind(user.id, 'verify').first();
      if (recent && Date.now() - Number(recent.created_at) < 60 * 1000) {
        throw new ApiError(429, 'A confirmation email was just sent. Give it a minute before asking again.');
      }
      const token = await issueEmailToken(env, user.id, 'verify', VERIFY_TTL_MS);
      const mail = verificationMail(appBase(env), token);
      const delivery = await sendMail(env, { to: user.email, subject: mail.subject, text: mail.text });
      return json(200, {
        ok: true, sent: delivery.sent, reason: delivery.reason || null,
        devLink: delivery.sent ? null : mail.link,
      }, cors);
    }

    // ── Forgot password ────────────────────────────────────────────
    if (path === '/api/auth/forgot' && method === 'POST') {
      const body = await readJson(request, 4096);
      const emailProblem = validateEmail(body.email);
      if (emailProblem) throw new ApiError(400, emailProblem);
      const emailNorm = normalizeEmail(body.email);
      const record = await db.prepare('SELECT id, email FROM users WHERE email_norm = ?').bind(emailNorm).first();
      // The same answer either way: this endpoint must not reveal which
      // addresses have accounts.
      const generic = { ok: true, sent: true };
      if (!record) return json(200, generic, cors);
      const token = await issueEmailToken(env, record.id, 'reset', RESET_TTL_MS);
      const mail = resetMail(appBase(env), token);
      const delivery = await sendMail(env, { to: record.email, subject: mail.subject, text: mail.text });
      return json(200, {
        ok: true, sent: delivery.sent, reason: delivery.reason || null,
        devLink: delivery.sent ? null : mail.link,
      }, cors);
    }

    // ── Choose a new password from a reset link ────────────────────
    if (path === '/api/auth/reset' && method === 'POST') {
      const body = await readJson(request, 4096);
      const token = String(body.token || '').trim();
      const problem = validatePassword(body.password);
      if (problem) throw new ApiError(400, problem);
      if (!token) throw new ApiError(400, 'That reset link is incomplete.');
      const row = await db.prepare(
        'SELECT token_hash, user_id, expires_at, used_at FROM email_tokens WHERE token_hash = ? AND purpose = ?',
      ).bind(await sha256(token), 'reset').first();
      if (!row || row.used_at || Number(row.expires_at) < Date.now()) {
        throw new ApiError(400, 'That reset link has expired or was already used. Request a new one.');
      }
      const now = Date.now();
      const password = await hashPassword(String(body.password), env.PBKDF2_ITERATIONS);
      await db.prepare(
        `UPDATE users SET password_hash = ?, password_salt = ?, iterations = ?, failed_attempts = 0,
                          locked_until = 0, updated_at = ? WHERE id = ?`,
      ).bind(password.password_hash, password.password_salt, password.iterations, now, row.user_id).run();
      await db.prepare('UPDATE email_tokens SET used_at = ? WHERE token_hash = ?').bind(now, row.token_hash).run();
      // A reset is the recovery path for a suspected compromise: every other
      // device is signed out, and this browser gets a fresh session.
      await db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(row.user_id).run();
      const session = await createSession(env, row.user_id, request, now);
      const user = await db.prepare(`SELECT ${USER_COLUMNS} FROM users u WHERE u.id = ?`).bind(row.user_id).first();
      return json(200, { ok: true, token: session, user: userView(user) }, cors);
    }

    // ── Everything below needs a signed-in session ─────────────────
    if (path === '/api/account' && method === 'PATCH') {
      const { user } = await authenticate(request, env);
      const body = await readJson(request, MAX_AVATAR_CHARS + MAX_PREFS_BYTES + 4096);
      const now = Date.now();
      const updates = [];
      const values = [];

      if (body.username != null) {
        const problem = validateUsername(body.username);
        if (problem) throw new ApiError(400, problem);
        const username = String(body.username).trim();
        const usernameNorm = normalizeUsername(username);
        if (usernameNorm !== String(user.username).toLowerCase()) {
          const taken = await db.prepare('SELECT id FROM users WHERE username_norm = ? AND id <> ?')
            .bind(usernameNorm, user.id).first();
          if (taken) throw new ApiError(409, 'That username is taken. Try another.');
        }
        updates.push('username = ?', 'username_norm = ?');
        values.push(username, usernameNorm);
      }

      if (body.avatar !== undefined) {
        if (body.avatar === null || body.avatar === '') {
          updates.push('avatar = NULL');
        } else {
          const avatar = String(body.avatar);
          if (avatar.length > MAX_AVATAR_CHARS) throw new ApiError(413, 'That picture is too large. Choose a smaller one.');
          if (!/^data:image\/(png|jpeg|jpg|webp);base64,[A-Za-z0-9+/=]+$/.test(avatar)) {
            throw new ApiError(400, 'The profile picture must be a PNG, JPEG or WebP image.');
          }
          updates.push('avatar = ?');
          values.push(avatar);
        }
      }

      if (body.prefs !== undefined) {
        if (!body.prefs || typeof body.prefs !== 'object' || Array.isArray(body.prefs)) {
          throw new ApiError(400, 'Preferences must be an object.');
        }
        const encoded = JSON.stringify(body.prefs);
        if (encoded.length > MAX_PREFS_BYTES) throw new ApiError(413, 'Those preferences are too large to sync.');
        updates.push('prefs = ?');
        values.push(encoded);
      }

      if (!updates.length) throw new ApiError(400, 'Nothing to change.');
      updates.push('updated_at = ?');
      values.push(now, user.id);
      await db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).bind(...values).run();
      const updated = await db.prepare(`SELECT ${USER_COLUMNS} FROM users u WHERE u.id = ?`).bind(user.id).first();
      return json(200, { ok: true, user: userView(updated) }, cors);
    }

    if (path === '/api/account/password' && method === 'POST') {
      const { user, sessionId } = await authenticate(request, env);
      const body = await readJson(request, 4096);
      const current = String(body.current || '');
      const next = String(body.next || body.password || '');
      const problem = validatePassword(next);
      if (problem) throw new ApiError(400, problem);
      if (current === next) throw new ApiError(400, 'Choose a password different from the current one.');
      const record = await db.prepare('SELECT password_hash, password_salt, iterations FROM users WHERE id = ?')
        .bind(user.id).first();
      if (!(await verifyPassword(current, record))) throw new ApiError(401, 'That current password is not right.');
      const password = await hashPassword(next, env.PBKDF2_ITERATIONS);
      const now = Date.now();
      await db.prepare(
        'UPDATE users SET password_hash = ?, password_salt = ?, iterations = ?, updated_at = ? WHERE id = ?',
      ).bind(password.password_hash, password.password_salt, password.iterations, now, user.id).run();
      // Every other device is signed out; this one keeps working.
      await db.prepare('DELETE FROM sessions WHERE user_id = ? AND id <> ?').bind(user.id, sessionId).run();
      return json(200, { ok: true }, cors);
    }

    if (path === '/api/account/sessions' && method === 'GET') {
      const { user, sessionId } = await authenticate(request, env);
      const rows = await db.prepare(
        'SELECT id, label, created_at, last_seen_at, expires_at FROM sessions WHERE user_id = ? ORDER BY last_seen_at DESC',
      ).bind(user.id).all();
      return json(200, {
        ok: true,
        sessions: (rows.results || []).map(row => ({
          id: row.id,
          label: row.label || 'Browser',
          createdAt: row.created_at,
          lastSeenAt: row.last_seen_at,
          expiresAt: row.expires_at,
          current: row.id === sessionId,
        })),
      }, cors);
    }

    if (path === '/api/account/sessions/revoke' && method === 'POST') {
      const { user } = await authenticate(request, env);
      const body = await readJson(request, 4096);
      const id = String(body.id || '');
      if (!id) throw new ApiError(400, 'Name the session to sign out.');
      const result = await db.prepare('DELETE FROM sessions WHERE id = ? AND user_id = ?').bind(id, user.id).run();
      if (!result.meta || !result.meta.changes) throw new ApiError(404, 'That session was already signed out.');
      return json(200, { ok: true }, cors);
    }

    // ── Preferences ────────────────────────────────────────────────
    if (path === '/api/prefs' && method === 'GET') {
      const { user } = await authenticate(request, env);
      return json(200, { ok: true, prefs: safeParse(user.prefs, {}) }, cors);
    }

    if (path === '/api/prefs' && method === 'PUT') {
      const { user } = await authenticate(request, env);
      const body = await readJson(request, MAX_PREFS_BYTES + 4096);
      const prefs = body.prefs && typeof body.prefs === 'object' && !Array.isArray(body.prefs) ? body.prefs : null;
      if (!prefs) throw new ApiError(400, 'Preferences must be an object.');
      const encoded = JSON.stringify(prefs);
      if (encoded.length > MAX_PREFS_BYTES) throw new ApiError(413, 'Those preferences are too large to sync.');
      await db.prepare('UPDATE users SET prefs = ?, updated_at = ? WHERE id = ?').bind(encoded, Date.now(), user.id).run();
      return json(200, { ok: true, prefs }, cors);
    }

    // ── Logbook ────────────────────────────────────────────────────
    if (path === '/api/flights' && method === 'GET') {
      const { user } = await authenticate(request, env);
      const rows = await db.prepare(
        'SELECT data FROM flights WHERE user_id = ? ORDER BY started_at DESC LIMIT 2000',
      ).bind(user.id).all();
      const flights = [];
      for (const row of rows.results || []) {
        const parsed = safeParse(row.data, null);
        if (parsed) flights.push(parsed);
      }
      return json(200, { ok: true, flights }, cors);
    }

    if (path === '/api/flights/sync' && method === 'POST') {
      const { user } = await authenticate(request, env);
      const body = await readJson(request, MAX_SYNC_BODY);
      const list = Array.isArray(body.flights) ? body.flights.slice(0, MAX_FLIGHTS) : [];
      if (!list.length) return json(200, { ok: true, added: 0, updated: 0, total: 0 }, cors);
      const now = Date.now();
      let written = 0;
      const statements = [];
      for (const raw of list) {
        const flight = compactFlight(raw);
        if (!flight) continue;
        statements.push(
          db.prepare(
            `INSERT INTO flights (user_id, id, callsign, dep, arr, aircraft, icao, registration,
                                  started_at, ended_at, duration_sec, distance_nm, data, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(user_id, id) DO UPDATE SET
               callsign = excluded.callsign, dep = excluded.dep, arr = excluded.arr,
               aircraft = excluded.aircraft, icao = excluded.icao, registration = excluded.registration,
               started_at = excluded.started_at, ended_at = excluded.ended_at,
               duration_sec = excluded.duration_sec, distance_nm = excluded.distance_nm,
               data = excluded.data, updated_at = excluded.updated_at
             WHERE excluded.updated_at >= flights.updated_at`,
          ).bind(user.id, flight.id, flight.callsign, flight.dep, flight.arr, flight.aircraft, flight.icao,
            flight.registration, flight.started, flight.ended, flight.duration, flight.distance, flight.data, now),
        );
        written++;
      }
      if (statements.length) await db.batch(statements);
      const total = await db.prepare('SELECT COUNT(*) AS n FROM flights WHERE user_id = ?').bind(user.id).first();
      return json(200, { ok: true, received: written, total: Number(total && total.n) || 0 }, cors);
    }

    // ── Dashboard ──────────────────────────────────────────────────
    if (path === '/api/dashboard' && method === 'GET') {
      const { user } = await authenticate(request, env);
      const totals = await db.prepare(
        'SELECT COUNT(*) AS flights, COALESCE(SUM(duration_sec), 0) AS seconds, COALESCE(SUM(distance_nm), 0) AS distance FROM flights WHERE user_id = ?',
      ).bind(user.id).first();
      const recentRows = await db.prepare(
        `SELECT id, callsign, dep, arr, aircraft, icao, registration, started_at, ended_at,
                duration_sec, distance_nm
           FROM flights WHERE user_id = ? ORDER BY started_at DESC LIMIT 8`,
      ).bind(user.id).all();
      const aircraftRows = await db.prepare(
        `SELECT CASE WHEN icao <> '' THEN icao ELSE aircraft END AS name,
                COUNT(*) AS flights, COALESCE(SUM(duration_sec), 0) AS seconds
           FROM flights WHERE user_id = ? AND (icao <> '' OR aircraft <> '')
          GROUP BY name ORDER BY flights DESC, seconds DESC LIMIT 8`,
      ).bind(user.id).all();
      const live = await liveSnapshot(env, user.id);
      return json(200, {
        ok: true,
        user: userView(user),
        totals: {
          flights: Number(totals && totals.flights) || 0,
          seconds: Math.round(Number(totals && totals.seconds) || 0),
          distanceNm: Math.round(Number(totals && totals.distance) || 0),
        },
        recent: (recentRows.results || []).map(row => ({
          id: row.id,
          callsign: row.callsign,
          dep: row.dep,
          arr: row.arr,
          aircraft: row.aircraft,
          icao: row.icao,
          registration: row.registration,
          startedAt: row.started_at,
          endedAt: row.ended_at,
          durationSec: row.duration_sec,
          distanceNm: row.distance_nm,
        })),
        aircraft: (aircraftRows.results || []).map(row => ({
          name: row.name,
          flights: Number(row.flights) || 0,
          seconds: Math.round(Number(row.seconds) || 0),
        })),
        live,
      }, cors);
    }

    // ── Live flight ────────────────────────────────────────────────
    if (path === '/api/live' && method === 'GET') {
      const { user } = await authenticate(request, env);
      return json(200, await liveSnapshot(env, user.id), cors);
    }

    if (path === '/api/live/ingest' && method === 'POST') {
      const { user } = await authenticate(request, env);
      const raw = await request.text();
      if (raw.length > 64 * 1024) throw new ApiError(413, 'That snapshot is too large.');
      const stub = liveStub(env, user.id);
      const forwarded = await stub.fetch(new Request('https://live.internal/ingest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: raw,
      }));
      const payload = await forwarded.json();
      return json(forwarded.status, payload, cors);
    }

    if (path === '/api/live/clear' && method === 'POST') {
      const { user } = await authenticate(request, env);
      const stub = liveStub(env, user.id);
      const forwarded = await stub.fetch(new Request('https://live.internal/clear', { method: 'POST' }));
      return json(forwarded.status, await forwarded.json(), cors);
    }

    if (path === '/api/live/ticket' && method === 'POST') {
      const { user } = await authenticate(request, env);
      const ticket = randomToken(24);
      const now = Date.now();
      await db.prepare(
        'INSERT INTO live_tickets (token_hash, user_id, created_at, expires_at, used_at) VALUES (?, ?, ?, ?, NULL)',
      ).bind(await sha256(ticket), user.id, now, now + TICKET_TTL_MS).run();
      // Housekeeping: an expired ticket can never be used again.
      await db.prepare('DELETE FROM live_tickets WHERE expires_at < ?').bind(now - 10 * 60 * 1000).run();
      return json(200, { ok: true, ticket, expiresAt: now + TICKET_TTL_MS }, cors);
    }

    if (path === '/api/live/ws' && method === 'GET') {
      const ticket = String(url.searchParams.get('ticket') || '').trim();
      if (!ticket) throw new ApiError(401, 'A live connection needs a ticket.');
      const tokenHash = await sha256(ticket);
      const row = await db.prepare('SELECT user_id, expires_at, used_at FROM live_tickets WHERE token_hash = ?')
        .bind(tokenHash).first();
      if (!row || row.used_at || Number(row.expires_at) < Date.now()) {
        throw new ApiError(401, 'That live ticket has expired. Reload the page.');
      }
      await db.prepare('UPDATE live_tickets SET used_at = ? WHERE token_hash = ?').bind(Date.now(), tokenHash).run();
      // The upgrade is proxied to the account's own room. The room is chosen
      // from the authenticated row, never from anything the client sent.
      return liveStub(env, row.user_id).fetch(request);
    }

    return json(404, { ok: false, error: `Not found: ${method} ${path}` }, cors);
  } catch (error) {
    const status = error instanceof ApiError ? error.status : 500;
    if (status >= 500) console.error('account api error:', error && error.stack ? error.stack : error);
    return json(status, { ok: false, error: (error && error.message) || 'Account service error' }, cors);
  }
}
