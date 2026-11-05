/**
 * Account cryptography and validation.
 *
 * Passwords are never stored or logged. Each one is stretched with PBKDF2-
 * HMAC-SHA256 using a per-user random salt from the platform CSPRNG, and the
 * iteration count is stored beside the hash so a future increase can be applied
 * without invalidating existing accounts: a login proves the old record and the
 * new one is written on the next password change.
 *
 * Session tokens are 32 random bytes. Only their SHA-256 digest is written to
 * the database, so a database copy cannot be replayed as a login. The same rule
 * applies to email verification and password reset tokens.
 *
 * PBKDF2 is the one primitive WebCrypto offers in a Worker, and workerd refuses
 * to run it above 100,000 iterations, so that ceiling is the configured count.
 * The count is configurable (PBKDF2_ITERATIONS) and stored per user, so changing
 * it later is not a breaking change.
 */

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/* workerd rejects any PBKDF2 count above 100000 at runtime, so this is both the
   ceiling and the default. It is still a deliberately slow hash; the count is
   stored per user, so it can be raised if the platform ever allows more. */
export const MAX_ITERATIONS = 100000;
export const DEFAULT_ITERATIONS = MAX_ITERATIONS;
export const MIN_PASSWORD_LENGTH = 10;

const encoder = new TextEncoder();

/** An error a route turns into a JSON response. */
export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function bytesToHex(bytes) {
  return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
}

export function hexToBytes(hex) {
  const clean = String(hex || '');
  if (clean.length % 2 !== 0 || /[^0-9a-f]/i.test(clean)) return new Uint8Array();
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function base64url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** A URL-safe token with 256 bits of entropy unless told otherwise. */
export function randomToken(bytes = 32) {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function sha256(value) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(String(value)));
  return bytesToHex(new Uint8Array(digest));
}

/** A random public id, not a secret: 18 hex characters. */
export function newId() {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(9)));
}

export function normalizeEmail(value) {
  return String(value == null ? '' : value).trim().toLowerCase();
}

/** Usernames are compared and reserved case-insensitively. */
export function normalizeUsername(value) {
  return String(value == null ? '' : value).trim().toLowerCase();
}

export function validateEmail(value) {
  const email = normalizeEmail(value);
  if (!email) return 'Enter your email address.';
  if (email.length > 254) return 'That email address is too long.';
  // One @, a dot in the domain, and no whitespace. Deliberately permissive:
  // the verification email is the real check, not a clever regex.
  if (!/^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(email)) return 'That does not look like an email address.';
  return '';
}

export function validateUsername(value) {
  const name = String(value == null ? '' : value).trim();
  if (name.length < 3) return 'Choose a username of at least 3 characters.';
  if (name.length > 24) return 'Usernames are limited to 24 characters.';
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
    return 'Use letters, numbers, dots, dashes or underscores, starting with a letter or number.';
  }
  if (/^[0-9]+$/.test(name)) return 'A username cannot be only numbers.';
  return '';
}

export function validatePassword(value) {
  const password = String(value == null ? '' : value);
  if (password.length < MIN_PASSWORD_LENGTH) return `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
  if (password.length > 200) return 'That password is too long.';
  if (/^\s|\s$/.test(password)) return 'The password cannot start or end with a space.';
  return '';
}

async function derive(password, saltHex, iterations) {
  const salt = hexToBytes(saltHex);
  if (!salt.length) throw new ApiError(500, 'Stored password record is unreadable.');
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    key,
    256,
  );
  return bytesToHex(new Uint8Array(bits));
}

/** A fresh record for a new or changed password. */
export async function hashPassword(password, iterations = DEFAULT_ITERATIONS) {
  const count = Number.isFinite(Number(iterations)) && Number(iterations) >= 10000
    ? Math.min(MAX_ITERATIONS, Math.floor(Number(iterations)))
    : DEFAULT_ITERATIONS;
  const salt = bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
  return { password_hash: await derive(password, salt, count), password_salt: salt, iterations: count };
}

/** Constant-time comparison of two hex digests. */
function equalHex(a, b) {
  const left = String(a || '');
  const right = String(b || '');
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i++) diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return diff === 0;
}

export async function verifyPassword(password, record) {
  if (!record || !record.password_hash || !record.password_salt) return false;
  const candidate = await derive(String(password), record.password_salt, Number(record.iterations) || DEFAULT_ITERATIONS);
  return equalHex(candidate, record.password_hash);
}

/** A short, human label for a session row, never the raw user agent. */
export function sessionLabel(userAgent) {
  const ua = String(userAgent || '');
  const device = /iPhone/i.test(ua) ? 'iPhone'
    : /iPad/i.test(ua) ? 'iPad'
      : /Android/i.test(ua) ? 'Android'
        : /Macintosh|Mac OS X/i.test(ua) ? 'Mac'
          : /Windows/i.test(ua) ? 'Windows PC'
            : /Linux/i.test(ua) ? 'Linux'
              : 'Browser';
  const browser = /Edg\//i.test(ua) ? 'Edge'
    : /OPR\/|Opera/i.test(ua) ? 'Opera'
      : /Firefox\//i.test(ua) ? 'Firefox'
        : /Chrome\//i.test(ua) ? 'Chrome'
          : /Safari\//i.test(ua) ? 'Safari'
            : '';
  return browser ? `${browser} on ${device}` : device;
}
