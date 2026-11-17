import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { flightStatus, levelText } from '../app/js/lib/flightstatus.js';

const page = fs.readFileSync(new URL('../app/index.html', import.meta.url), 'utf8');
const plan = { dep: 'KJFK', arr: 'EGLL' };

test('the live status reads the phase and the numbers the strip shows', () => {
  assert.equal(flightStatus({}).key, 'offline');
  assert.deepEqual(flightStatus({ ...plan, phase: 'PARKED', alt: 13, agl: 0, gs: 0, destNm: 2990 }), { key: 'parked', label: 'Parked', detail: 'at KJFK' });
  assert.equal(flightStatus({ ...plan, phase: 'TAXI', alt: 13, agl: 0, gs: 14, destNm: 2990 }).detail, 'at KJFK');
  assert.equal(flightStatus({ ...plan, phase: 'TAXI', alt: 13, agl: 0, gs: 120, destNm: 2990 }).key, 'takeoff');
  assert.equal(flightStatus({ ...plan, phase: 'AIRBORNE', alt: 900, agl: 880, vs: 2200, gs: 160, destNm: 2985 }).key, 'departing');
  assert.deepEqual(flightStatus({ ...plan, phase: 'AIRBORNE', alt: 12340, agl: 12300, vs: 1800, gs: 290, destNm: 2950 }),
    { key: 'climb', label: 'Climbing', detail: 'through 12,300 ft · 2,950 NM to EGLL' });
  assert.equal(flightStatus({ ...plan, phase: 'AIRBORNE', alt: 37010, vs: 20, gs: 480, destNm: 1400 }).detail, 'at FL370 · 1,400 NM to EGLL');
  assert.equal(flightStatus({ ...plan, phase: 'AIRBORNE', alt: 24000, vs: -2000, gs: 420, destNm: 120 }).key, 'descent');
  assert.equal(flightStatus({ ...plan, phase: 'AIRBORNE', alt: 6000, agl: 5900, vs: -1200, gs: 220, destNm: 40 }).key, 'approach');
  assert.equal(flightStatus({ ...plan, phase: 'AIRBORNE', alt: 1500, agl: 1400, vs: -700, gs: 140, destNm: 5 }).label, 'Final approach');
  assert.equal(flightStatus({ ...plan, phase: 'LANDED', alt: 80, agl: 0, gs: 110, destNm: 1 }).key, 'rollout');
  assert.equal(flightStatus({ ...plan, phase: 'LANDED', alt: 80, agl: 0, gs: 12, destNm: 1 }).detail, 'to the gate at EGLL');
  assert.equal(flightStatus({ ...plan, phase: 'COMPLETE', alt: 80, agl: 0, gs: 0, destNm: 0.3 }).label, 'Arrived');
  assert.equal(flightStatus({ phase: 'AIRBORNE', alt: 9000, vs: 0 }).detail, 'at 9,000 ft', 'no plan, no distance');
  assert.equal(levelText(18040), 'FL180');
});

test('the Flight Deck strip carries the status and the 3D chase view', () => {
  assert.match(page, /id="tST"/, 'a status line in the live strip');
  assert.match(page, /window\.FSTATUS\.flightStatus\(/);
  assert.match(page, /id="bMap3dChase"/, 'a chase-camera 3D mode');
});
