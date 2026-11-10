import test from 'node:test';
import assert from 'node:assert/strict';

import {
  distanceNm, bearingDeg, planDirectTo, restoreDirectTo, searchDirect, directToState, directTarget,
} from '../app/js/lib/directto.js';
import {
  readPlan, writePlan, readBackup, writeBackup, clearBackup, ROUTE_KEY, BACKUP_KEY,
} from '../app/js/lib/routestore.js';

const LHR = { id: 'EGLL', name: 'London Heathrow', lat: 51.4706, lon: -0.4619, kind: 'apt' };
const JFK = { id: 'KJFK', name: 'New York Kennedy', lat: 40.6413, lon: -73.7781, kind: 'apt' };
const FIX_B = { id: 'BEXET', name: 'BEXET', lat: 53.2, lon: -12.4, kind: 'fix' };
const FIX_C = { id: 'DOGAL', name: 'DOGAL', lat: 52.1, lon: -35.0, kind: 'fix' };

function fakeStorage() {
  const map = new Map();
  return {
    getItem: key => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: key => map.delete(key),
    _map: map,
  };
}

test('great-circle distance and initial bearing are sane', () => {
  const nm = distanceNm(LHR, JFK);
  assert.ok(nm > 2950 && nm < 3060, `Heathrow to Kennedy is about 3000 nm, got ${nm}`);

  const bearing = bearingDeg(LHR, JFK);
  assert.ok(bearing > 280 && bearing < 298, `initial bearing is roughly west-north-west, got ${bearing}`);

  assert.equal(distanceNm(LHR, { id: 'BAD', lat: 'x', lon: 0 }), null, 'an unusable fix has no distance');
  assert.equal(bearingDeg(null, JFK), null);
});

test('a direct-to keeps the origin, flies to the fix, and resumes the route', () => {
  const plan = { points: [LHR, FIX_B, FIX_C, JFK], cruiseKts: 450, name: 'EGLL → KJFK' };
  const result = planDirectTo(plan, FIX_C, { gsKt: 450, now: 1740000000000 });

  assert.equal(result.ok, true);
  assert.deepEqual(result.plan.points.map(point => point.id), ['EGLL', 'DOGAL', 'KJFK'],
    'the fixes between the origin and the selected fix are bypassed, the arrival is kept');
  assert.equal(result.preview.inRoute, true);
  assert.equal(result.preview.skippedPoints, 1, 'BEXET was the one fix bypassed');
  assert.equal(result.preview.resumedPoints, 1, 'Kennedy resumes after DOGAL');
  assert.ok(result.preview.legNm > 500, 'the direct leg is a real distance');
  assert.ok(result.preview.eteMin > 60, 'endurance follows the supplied groundspeed');
  assert.ok(result.preview.totalNm > result.preview.legNm, 'the route continues past the fix');
  assert.equal(result.plan.direct.id, 'DOGAL');
  assert.equal(directToState(result.plan).id, 'DOGAL');

  const original = plan.points.map(point => point.id);
  assert.deepEqual(plan.points.map(point => point.id), original, 'the input plan is not mutated');
});

test('a direct-to to a fix that is not in the route keeps the existing points', () => {
  const plan = { points: [LHR, FIX_B, JFK] };
  const target = { id: 'TNT', name: 'Trent VOR', lat: 53.05, lon: -1.67, kind: 'nav' };
  const result = planDirectTo(plan, target);
  assert.equal(result.ok, true);
  assert.deepEqual(result.plan.points.map(point => point.id), ['EGLL', 'TNT', 'BEXET', 'KJFK']);
  assert.equal(result.preview.inRoute, false);
  assert.equal(result.preview.eteMin, null, 'no groundspeed means no estimate, not a guess');
});

test('a direct-to never draws the same leg twice', () => {
  const plan = { points: [LHR, JFK] };
  const result = planDirectTo(plan, JFK);
  assert.deepEqual(result.plan.points.map(point => point.id), ['EGLL', 'KJFK']);

  const toOrigin = planDirectTo(plan, LHR);
  assert.deepEqual(toOrigin.plan.points.map(point => point.id), ['EGLL', 'KJFK'],
    'a direct-to back to the departure is a no-op rather than a duplicated point');
});

test('refusals are explicit', () => {
  assert.equal(planDirectTo({ points: [] }, JFK).ok, false);
  assert.match(planDirectTo({ points: [] }, JFK).error, /no flight plan/i);
  assert.equal(planDirectTo({ points: [LHR] }, { id: 'X', lat: 'nope', lon: 2 }).ok, false);
  assert.equal(directTarget({ id: '', lat: 1, lon: 1 }), null, 'a fix needs an identifier');
});

test('clearing a direct-to restores the original route', () => {
  const plan = { points: [LHR, FIX_B, FIX_C, JFK], name: 'EGLL → KJFK' };
  const backup = { points: plan.points.map(point => ({ ...point })), at: 1 };
  const applied = planDirectTo(plan, FIX_C).plan;
  const restored = restoreDirectTo(applied, backup);
  assert.deepEqual(restored.points.map(point => point.id), ['EGLL', 'BEXET', 'DOGAL', 'KJFK']);
  assert.equal(restored.direct, null, 'the direct marker is cleared, not left behind');
  assert.equal(restored.name, 'EGLL → KJFK', 'other plan fields survive the round trip');
  assert.equal(directToState(restored), null, 'the plan no longer reports an active direct-to');
  const noBackup = restoreDirectTo(applied, null);
  assert.equal(noBackup.points.length, 3, 'with nothing to restore the points are left alone');
  assert.equal(noBackup.direct, null, 'but an active direct-to marker is still cleared');
  assert.equal(restoreDirectTo(plan, null), plan, 'a plan with no direct-to is returned untouched');
});

test('direct-to search prefers route fixes and reports distance', () => {
  const plan = { points: [LHR, FIX_B, FIX_C, JFK] };
  const pool = [
    { id: 'EGLL', name: 'London Heathrow', lat: 51.4706, lon: -0.4619 },
    { id: 'EIDW', name: 'Dublin', lat: 53.4213, lon: -6.2701 },
  ];

  const dogal = searchDirect(plan, 'dog', pool) [0];
  assert.equal(dogal.id, 'DOGAL');
  assert.equal(dogal.source, 'route');
  assert.ok(dogal.distanceNm > 0);

  const egll = searchDirect(plan, 'egll', pool)[0];
  assert.equal(egll.id, 'EGLL');

  assert.deepEqual(searchDirect(plan, 'zz', pool), [], 'no match is an empty list, not a fabricated fix');
  assert.deepEqual(searchDirect(plan, '', pool), []);
});

test('clearing writes the cleared marker over the stored direct-to', () => {
  // A regression: the store merges into the previous object, so a deleted key
  // let the old direct-to survive a CLEAR. The marker must be written as null.
  const storage = fakeStorage();
  writePlan({ points: [LHR, FIX_C, JFK], direct: { id: 'DOGAL' } }, storage);
  const restored = restoreDirectTo(readPlan(storage), { points: [LHR, FIX_B, FIX_C, JFK] });
  writePlan(restored, storage);
  const reread = JSON.parse(storage.getItem(ROUTE_KEY));
  assert.equal(reread.direct, null);
  assert.deepEqual(reread.points.map(point => point.id), ['EGLL', 'BEXET', 'DOGAL', 'KJFK']);
});

test('the route store keeps the plan shape and the restore backup', () => {
  const storage = fakeStorage();
  assert.deepEqual(readPlan(storage).points, [], 'an empty store is an empty plan');

  storage.setItem(ROUTE_KEY, JSON.stringify({ simbriefId: 'abc', cruiseKts: 460, points: [LHR] }));
  const plan = readPlan(storage);
  assert.equal(plan.points.length, 1);

  const expanded = { ...plan, points: [LHR, JFK], name: 'EGLL → KJFK' };
  assert.equal(writePlan(expanded, storage), true);
  const reread = JSON.parse(storage.getItem(ROUTE_KEY));
  assert.equal(reread.points.length, 2);
  assert.equal(reread.simbriefId, 'abc', 'fields the direct-to does not own are preserved');
  assert.ok(reread.savedAt > 0);

  assert.equal(readBackup(storage), null);
  assert.equal(writeBackup({ points: [LHR, FIX_B, JFK], at: 5 }, storage), true);
  assert.equal(readBackup(storage).points.length, 3);
  clearBackup(storage);
  assert.equal(storage.getItem(BACKUP_KEY), null);
  assert.equal(writeBackup({ points: [] }, storage), false, 'an empty backup is refused');
});
