/* Aircraft photography for Stratos: the Planespotters lookup cache and the
 * on-device photo gallery.
 *
 * Two kinds of photograph are kept apart on purpose:
 *
 *   - A spotter photograph is never downloaded or rehosted. Only the metadata
 *     the API returned (image URL, the page it came from, the photographer) is
 *     remembered, so the image is served by Planespotters under its own terms
 *     and credit stays attached to it. Lookups are cached for a week, a
 *     "no photo" answer for a day, and requests are serialised with a gap so a
 *     page full of aircraft cannot burst the service.
 *   - The pilot's own screenshots are theirs: they live in IndexedDB on this
 *     device, are never uploaded, and stay separate from the spotter photo.
 *
 * The pure helpers are separated from the browser storage so the tests can
 * check the identity, cache and slideshow rules without a browser.
 */

import {
  normalizeRegistration, photoRequest, photoHexRequest, photoOutcome,
} from './aircraftphoto.js';
import { normalizeHex } from './aircraftreg.js';

const SPOTTER_TTL = 7 * 24 * 60 * 60 * 1000;
const MISS_TTL = 24 * 60 * 60 * 1000;
const CACHE_PREFIX = 'stratos.photo.';
const MIN_GAP = 700;
const MAX_UPLOAD = 12 * 1024 * 1024;

export const SLIDESHOW_INTERVALS = [0, 4, 6, 8, 12, 20];
export const MAX_UPLOAD_BYTES = MAX_UPLOAD;

/* ── Identity ─────────────────────────────────────────────────────── */

/** One key per airframe. The registration is the airframe; when it is absent
 *  the type and callsign are used, never the type alone for two different
 *  tails. An empty key means the aircraft cannot be told apart. */
export function aircraftKey({ registration = '', type = '', callsign = '' } = {}) {
  const reg = normalizeRegistration(registration);
  if (reg) return 'REG:' + reg;
  const code = String(type == null ? '' : type).trim().toUpperCase().replace(/\s+/g, ' ');
  const call = String(callsign == null ? '' : callsign).trim().toUpperCase().replace(/\s+/g, '');
  if (!code) return '';
  return 'TYPE:' + code + (call ? ':' + call : '');
}

/** The cache key for a photo lookup: registration first, then Mode S. */
export function photoCacheKey({ registration = '', hex = '' } = {}) {
  const reg = normalizeRegistration(registration);
  if (reg) return 'reg:' + reg;
  const address = normalizeHex(hex);
  return address ? 'hex:' + address : '';
}

/* ── Spotter photo metadata cache ─────────────────────────────────── */

function cacheStorage(storage) {
  try {
    return storage || (typeof localStorage !== 'undefined' ? localStorage : null);
  } catch (_) {
    return null;
  }
}

/** A cached outcome, or null when absent or older than its lifetime. */
export function readSpotterCache(storage, key, now = Date.now()) {
  if (!key) return null;
  const store = cacheStorage(storage);
  if (!store) return null;
  try {
    const row = JSON.parse(store.getItem(CACHE_PREFIX + key) || 'null');
    if (!row || !row.outcome || typeof row.at !== 'number') return null;
    const ttl = row.outcome.state === 'ok' ? SPOTTER_TTL : MISS_TTL;
    if (!(now - row.at >= 0 && now - row.at < ttl)) return null;
    if (row.outcome.state === 'ok') {
      const photo = row.outcome.photo;
      if (!photo || !/^https:\/\//.test(String(photo.src || ''))) return null;
    }
    return row.outcome;
  } catch (_) {
    return null;
  }
}

/** Remember a lookup result. Only the API's metadata is stored, not the image. */
export function writeSpotterCache(storage, key, outcome, now = Date.now()) {
  const store = cacheStorage(storage);
  if (!store || !key || !outcome || !outcome.state) return false;
  try {
    store.setItem(CACHE_PREFIX + key, JSON.stringify({
      at: now,
      outcome: outcome.state === 'ok'
        ? {
            state: 'ok',
            photo: {
              src: outcome.photo.src,
              thumb: outcome.photo.thumb,
              width: outcome.photo.width,
              height: outcome.photo.height,
              link: outcome.photo.link,
              photographer: outcome.photo.photographer,
            },
          }
        : { state: outcome.state },
    }));
    return true;
  } catch (_) {
    return false; // storage full or disabled: the lookup simply is not cached
  }
}

export function forgetSpotterPhoto(storage, key) {
  const store = cacheStorage(storage);
  if (!store || !key) return;
  try { store.removeItem(CACHE_PREFIX + key); } catch (_) { /* nothing to forget */ }
}

/* ── Throttled lookup ─────────────────────────────────────────────── */

let chain = Promise.resolve();
let lastLookupAt = 0;

/** Find the spotter photograph for an airframe.
 *
 *  Registration first, Mode S only when there is no registration. The answer is
 *  one of the three states the pages already understand: `ok` with photo
 *  metadata, `none` when the service knows the airframe but publishes no photo,
 *  `unavailable` when the route or the service did not answer. A cached answer
 *  is returned without a request unless `force` is set (the Find Image button).
 */
export function lookupPhoto({ registration = '', hex = '' } = {}, {
  force = false, storage = null, fetchImpl = null, now = () => Date.now(), gap = MIN_GAP,
} = {}) {
  const key = photoCacheKey({ registration, hex });
  if (!key) return Promise.resolve({ state: 'none', reason: 'no-airframe' });
  const store = cacheStorage(storage);
  if (!force) {
    const cached = readSpotterCache(store, key, now());
    if (cached) return Promise.resolve({ ...cached, cached: true });
  }
  const url = photoRequest(registration) || photoHexRequest(hex);
  if (!url) return Promise.resolve({ state: 'none', reason: 'no-airframe' });
  const ask = async () => {
    const wait = Math.max(0, gap - (now() - lastLookupAt));
    if (wait) await new Promise(done => setTimeout(done, wait));
    lastLookupAt = now();
    let status = 0;
    let payload = null;
    try {
      const fetcher = fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
      if (!fetcher) return { state: 'unavailable' };
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 9000);
      try {
        const response = await fetcher(url, { signal: controller.signal, headers: { Accept: 'application/json' } });
        status = response.status;
        try { payload = await response.json(); } catch (_) { payload = null; }
      } finally {
        clearTimeout(timer);
      }
    } catch (_) {
      status = 0;
    }
    const outcome = status ? photoOutcome(status, payload) : { state: 'unavailable' };
    // A missing route (404) is not the airframe's answer; do not cache it as one.
    if (status && status !== 404) writeSpotterCache(store, key, outcome, now());
    return outcome;
  };
  const next = chain.then(ask, ask);
  chain = next.catch(() => {});
  return next;
}

/* ── Gallery: the pilot's own photographs ─────────────────────────── */

const DB_NAME = 'stratos_aircraft';
const DB_VERSION = 1;
let dbPromise = null;

/** True when the browser can show this file as an image. */
export function imageAcceptable(type) {
  return /^image\/(jpeg|png|webp|gif|avif)$/i.test(String(type || ''));
}

function openGalleryDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('This browser cannot store photos.'));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = event => {
      const database = event.target.result;
      if (!database.objectStoreNames.contains('photos')) {
        const photos = database.createObjectStore('photos', { keyPath: 'id', autoIncrement: true });
        photos.createIndex('aircraft', 'aircraft');
      }
      if (!database.objectStoreNames.contains('settings')) {
        database.createObjectStore('settings', { keyPath: 'key' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Could not open the photo store.'));
  }).catch(error => {
    dbPromise = null;
    throw error;
  });
  return dbPromise;
}

function done(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** Every photograph the pilot added for one airframe, oldest first. */
export async function listAircraftPhotos(key) {
  if (!key) return [];
  const database = await openGalleryDB();
  const rows = await done(database.transaction('photos', 'readonly').objectStore('photos').index('aircraft').getAll(key));
  return (rows || []).sort((a, b) => (a.addedAt || 0) - (b.addedAt || 0));
}

/** Store one screenshot under an airframe. The file never leaves the device. */
export async function addAircraftPhoto(key, file, { caption = '' } = {}) {
  if (!key) throw new Error('This aircraft cannot be told apart, so a photo cannot be attached to it.');
  if (!file) throw new Error('No photo was chosen.');
  if (file.size > MAX_UPLOAD) throw new Error('That image is larger than 12 MB.');
  if (file.type && !imageAcceptable(file.type)) throw new Error('Choose a JPEG, PNG, WebP, GIF or AVIF image.');
  const database = await openGalleryDB();
  const blob = file instanceof Blob ? file : new Blob([file]);
  const record = {
    aircraft: key,
    blob,
    name: String(file.name || 'screenshot').slice(0, 120),
    type: blob.type || 'image/jpeg',
    size: blob.size,
    caption: String(caption || '').slice(0, 160),
    addedAt: Date.now(),
  };
  const id = await done(database.transaction('photos', 'readwrite').objectStore('photos').add(record));
  return { ...record, id };
}

export async function deleteAircraftPhoto(id) {
  if (id == null) return false;
  const database = await openGalleryDB();
  await done(database.transaction('photos', 'readwrite').objectStore('photos').delete(id));
  return true;
}

export async function getGallerySetting(key, fallback = null) {
  try {
    const database = await openGalleryDB();
    const row = await done(database.transaction('settings', 'readonly').objectStore('settings').get(key));
    return row ? row.value : fallback;
  } catch (_) {
    return fallback;
  }
}

export async function setGallerySetting(key, value) {
  const database = await openGalleryDB();
  await done(database.transaction('settings', 'readwrite').objectStore('settings').put({ key, value }));
  return value;
}

/* ── Slideshow ────────────────────────────────────────────────────── */

/** A usable interval in seconds; 0 means automatic cycling is off. */
export function slideshowInterval(value) {
  // An absent setting is the default cycling interval; only an explicit 0 off.
  if (value == null || value === '') return 8;
  const seconds = Number(value);
  return SLIDESHOW_INTERVALS.includes(seconds) ? seconds : 8;
}

/** The next photo index, wrapping in both directions. */
export function nextSlide(index, length, step = 1) {
  if (!length) return 0;
  const size = Math.abs(Math.trunc(length));
  const from = Number.isFinite(Number(index)) ? Math.trunc(Number(index)) : 0;
  return ((from + step) % size + size) % size;
}
