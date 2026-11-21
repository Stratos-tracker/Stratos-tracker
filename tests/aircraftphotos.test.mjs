import test from 'node:test';
import assert from 'node:assert/strict';
import { findAircraftPhoto, sameTypeRegistrations } from '../app/js/lib/aircraftgallery.js';
import { photoSteps } from '../app/js/efb/homewidgets.js';

/* A storage and a fake network, so the whole search runs without the internet. */
function memoryStorage() {
  const data = new Map();
  return { getItem: k => (data.has(k) ? data.get(k) : null), setItem: (k, v) => data.set(k, String(v)), removeItem: k => data.delete(k) };
}
const photo = reg => ({ photos: [{ thumbnail_large: { src: `https://t.plnspttrs.net/${reg}.jpg`, size: { width: 420, height: 280 } }, link: `https://www.planespotters.net/photo/1/${reg}`, photographer: 'Test Spotter' }] });
function network(table, calls = []) {
  return async url => {
    calls.push(url);
    const reg = decodeURIComponent((String(url).match(/reg=([^&]+)/) || [])[1] || '');
    const answer = table(url, reg);
    if (answer === 'offline') throw new Error('offline');
    if (answer === 'broken') return { status: 200, ok: true, json: async () => { throw new Error('bad json'); } };
    return { status: answer ? 200 : 200, ok: true, json: async () => answer || { photos: [] } };
  };
}
const fast = { gap: 0 };
void fast;

test('an exact registration photo is used and labelled as this aircraft', async () => {
  const storage = memoryStorage();
  const answer = await findAircraftPhoto(photoSteps({ sim: 'C-FABC' }), { identity: 'a', type: 'A320' }, {
    storage, fetchImpl: network((url, reg) => (reg === 'C-FABC' ? photo(reg) : null)), live: async () => null,
  });
  assert.equal(answer.kind, 'exact');
  assert.equal(answer.registration, 'C-FABC');
  assert.equal(answer.photo.photographer, 'Test Spotter');
  assert.match(answer.photo.link, /^https:\/\/www\.planespotters\.net\/photo\//, 'the original photo page is linked');
});

test('a tail with no photo falls back to the same airline and type, labelled as a stand-in', async () => {
  const live = async url => (/\/type\//.test(url) ? { ac: [{ flight: 'ACA101 ', t: 'A320', r: 'C-FDCA' }] } : null);
  const answer = await findAircraftPhoto(photoSteps({ sim: 'C-GTLZ' }), { identity: 'b', callsign: 'ACA123', type: 'A320' }, {
    storage: memoryStorage(), fetchImpl: network((url, reg) => (reg === 'C-FDCA' ? photo(reg) : null)), live,
  });
  assert.equal(answer.kind, 'airline-type');
  assert.equal(answer.label, 'Same airline and type');
  assert.equal(answer.registration, 'C-FDCA', 'never presented as C-GTLZ');
});

test('then the type alone, then an illustration', async () => {
  const live = async url => (/\/type\//.test(url) ? { ac: [{ flight: 'DLH1', t: 'A320', r: 'D-AIZA' }] } : null);
  const sameType = await findAircraftPhoto(photoSteps({}), { identity: 'c', callsign: 'ZZZ9', type: 'A320' }, {
    storage: memoryStorage(), fetchImpl: network((url, reg) => (reg === 'D-AIZA' ? photo(reg) : null)), live,
  });
  assert.equal(sameType.kind, 'type');
  const nothing = await findAircraftPhoto(photoSteps({ sim: 'N1' }), { identity: 'd', type: 'C172', silhouette: 'images/aircraft/generic-light.svg' }, {
    storage: memoryStorage(), fetchImpl: network(() => null), live: async () => null,
  });
  assert.equal(nothing.kind, 'silhouette');
  assert.equal(nothing.image, 'images/aircraft/generic-light.svg');
});

test('no registration, an offline service and a malformed answer all end on the illustration', async () => {
  const none = await findAircraftPhoto(photoSteps({}), { identity: 'e', silhouette: 'x.svg' }, { storage: memoryStorage(), fetchImpl: network(() => null), live: async () => null });
  assert.equal(none.kind, 'silhouette');
  const storage = memoryStorage();
  const offline = await findAircraftPhoto(photoSteps({ sim: 'C-FXYZ' }), { identity: 'f', silhouette: 'x.svg' }, { storage, fetchImpl: network(() => 'offline'), live: async () => null });
  assert.equal(offline.kind, 'silhouette');
  assert.equal(storage.getItem('stratos.photo.resolved.f'), null, 'an offline answer is not remembered, so the next visit looks again');
  const broken = await findAircraftPhoto(photoSteps({ sim: 'C-FBAD' }), { identity: 'g', silhouette: 'x.svg' }, { storage: memoryStorage(), fetchImpl: network(() => 'broken'), live: async () => null });
  assert.equal(broken.kind, 'silhouette');
});

test('a found photo is cached, a new aircraft is looked up, and Find image asks again', async () => {
  const storage = memoryStorage();
  const calls = [];
  const fetchImpl = network((url, reg) => photo(reg), calls);
  await findAircraftPhoto(photoSteps({ sim: 'C-FAAA' }), { identity: 'h' }, { storage, fetchImpl, live: async () => null });
  const before = calls.length;
  const again = await findAircraftPhoto(photoSteps({ sim: 'C-FAAA' }), { identity: 'h' }, { storage, fetchImpl, live: async () => null });
  assert.equal(calls.length, before, 'the same aircraft makes no new request');
  assert.equal(again.cached, true);
  await findAircraftPhoto(photoSteps({ sim: 'C-FBBB' }), { identity: 'i' }, { storage, fetchImpl, live: async () => null });
  assert.ok(calls.some(url => /C-FBBB/.test(url)), 'switching aircraft looks up the new one');
  const n = calls.length;
  await findAircraftPhoto(photoSteps({ sim: 'C-FAAA' }), { identity: 'h' }, { storage, fetchImpl, live: async () => null, force: true });
  assert.equal(calls.length, n + 1, 'Find image skips the cache');
});

test('same-type registrations come only from aircraft of that type', () => {
  assert.deepEqual(sameTypeRegistrations({ ac: [{ t: 'A320', r: 'D-AIZA' }, { t: 'B738', r: 'EI-ABC' }, { t: 'A320', r: 'D-AIZA' }, { t: 'A320' }] }, 'A320'), ['D-AIZA']);
  assert.deepEqual(sameTypeRegistrations(null, 'A320'), []);
});
