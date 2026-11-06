import test from 'node:test';
import assert from 'node:assert/strict';

import {
  aircraftKey, photoCacheKey, readSpotterCache, writeSpotterCache,
  slideshowInterval, nextSlide, imageAcceptable, SLIDESHOW_INTERVALS,
} from '../app/js/lib/aircraftgallery.js';

function memoryStorage() {
  const rows = new Map();
  return {
    getItem: key => (rows.has(key) ? rows.get(key) : null),
    setItem: (key, value) => rows.set(key, String(value)),
    removeItem: key => rows.delete(key),
  };
}

const photo = {
  src: 'https://t.plnspttrs.net/x.jpg',
  thumb: 'https://t.plnspttrs.net/x_t.jpg',
  link: 'https://www.planespotters.net/photo/1/x',
  photographer: 'A. Spotter',
  width: 420,
  height: 280,
};

test('media: the registration identifies the airframe, not the type', () => {
  assert.equal(aircraftKey({ registration: 'n8312c', type: 'B738' }), 'REG:N8312C');
  assert.equal(aircraftKey({ registration: 'A7-AGA', type: 'A359' }), 'REG:A7-AGA');
  assert.equal(aircraftKey({ type: 'Boeing 777-300ER' }), 'TYPE:BOEING 777-300ER');
  assert.equal(aircraftKey({ type: 'B77W', callsign: 'BAW2620' }), 'TYPE:B77W:BAW2620');
  assert.equal(aircraftKey({}), '');
  // Two aircraft of the same type stay apart when their tails differ.
  assert.notEqual(aircraftKey({ registration: 'G-TAWI', type: 'B738' }), aircraftKey({ registration: 'G-TAWV', type: 'B738' }));
});

test('media: lookup keys prefer the registration and never guess', () => {
  assert.equal(photoCacheKey({ registration: 'n8312c' }), 'reg:N8312C');
  assert.equal(photoCacheKey({ hex: 'ab5eb2' }), 'hex:AB5EB2');
  assert.equal(photoCacheKey({ registration: 'BAW2620', hex: 'AB5EB2' }), 'hex:AB5EB2');
  assert.equal(photoCacheKey({ registration: 'B738' }), '');
});

test('media: a cached photo lasts a week and a miss lasts a day', () => {
  const storage = memoryStorage();
  const start = Date.UTC(2026, 10, 6);
  const key = photoCacheKey({ registration: 'N8312C' });
  assert.equal(readSpotterCache(storage, key, start), null, 'nothing cached yet');
  assert.equal(writeSpotterCache(storage, key, { state: 'ok', photo }, start), true);
  assert.deepEqual(readSpotterCache(storage, key, start + 3 * 864e5).photo.src, photo.src);
  assert.equal(readSpotterCache(storage, key, start + 8 * 864e5), null, 'the photo entry expires');

  writeSpotterCache(storage, key, { state: 'none' }, start);
  assert.equal(readSpotterCache(storage, key, start + 3600e3).state, 'none');
  assert.equal(readSpotterCache(storage, key, start + 25 * 3600e3), null, 'a miss is retried after a day');
});

test('media: a cached photo needs an https image and is stored as metadata only', () => {
  const storage = memoryStorage();
  const key = photoCacheKey({ registration: 'N8312C' });
  writeSpotterCache(storage, key, { state: 'ok', photo: { ...photo, src: 'http://insecure/x.jpg' } }, 1);
  assert.equal(readSpotterCache(storage, key, 2), null, 'an insecure image is not shown');
  const raw = storage.getItem('stratos.photo.' + key);
  assert.ok(raw.includes('plnspttrs.net'), 'the image URL is kept');
  assert.ok(!raw.includes('data:'), 'no image bytes are stored');
});

test('media: slideshow intervals are fixed choices and cycling wraps', () => {
  assert.deepEqual(SLIDESHOW_INTERVALS, [0, 4, 6, 8, 12, 20]);
  assert.equal(slideshowInterval(0), 0, 'zero disables cycling');
  assert.equal(slideshowInterval(12), 12);
  assert.equal(slideshowInterval('99'), 8, 'an unknown value falls back to the default');
  assert.equal(slideshowInterval(null), 8);
  assert.equal(nextSlide(0, 3), 1);
  assert.equal(nextSlide(2, 3), 0, 'the last photo wraps forward');
  assert.equal(nextSlide(0, 3, -1), 2, 'and the first wraps back');
  assert.equal(nextSlide(4, 0), 0);
});

test('media: only real image files are accepted for the gallery', () => {
  for (const type of ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif']) {
    assert.equal(imageAcceptable(type), true, type);
  }
  for (const type of ['', 'text/html', 'application/pdf', 'image/svg+xml', null]) {
    assert.equal(imageAcceptable(type), false, String(type));
  }
});
