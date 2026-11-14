import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chartKind, flightKey, isPinned, pickChart, readClip, toggleClip, wantedChart, writeClip, CLIP_KEY,
} from '../app/js/lib/chartclip.js';
import { inferPhase } from '../app/js/lib/checklists.js';

const memory = () => { const m = new Map(); return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) }; };
const DIAGRAM = { icao: 'KSEA', title: 'AIRPORT DIAGRAM', pdf: '00582AD.PDF', category: 'diagram' };
const SID = { icao: 'KSEA', title: 'BANGR NINE', pdf: '00582BANGR.PDF', category: 'sid' };
const ILS = { icao: 'KPDX', title: 'ILS OR LOC RWY 10R', pdf: '00319IL10R.PDF', category: 'ils' };

test('the clipboard is per flight and survives a reload', () => {
  const store = memory();
  const key = flightKey('KSEA', 'KPDX');
  assert.equal(key, 'KSEA-KPDX');
  assert.equal(flightKey('', ''), 'no-plan');
  let clip = toggleClip([], DIAGRAM);
  clip = toggleClip(clip, ILS);
  writeClip(store, key, clip);
  assert.deepEqual(readClip(store, key).map(c => c.pdf), ['00582AD.PDF', '00319IL10R.PDF']);
  assert.deepEqual(readClip(store, flightKey('EGLL', 'LFPG')), [], 'another flight has its own list');
  assert.ok(isPinned(clip, { ...DIAGRAM }), 'pinned by identity, not object');
  assert.deepEqual(toggleClip(clip, DIAGRAM).map(c => c.pdf), ['00319IL10R.PDF'], 'a second tap unpins');
  store.setItem(CLIP_KEY, '{broken');
  assert.deepEqual(readClip(store, key), [], 'a corrupt store reads as empty');
});

test('only the six most recent flights keep a clipboard', () => {
  const store = memory();
  for (let i = 0; i < 8; i += 1) writeClip(store, `K00${i}-K11${i}`, [DIAGRAM]);
  const kept = Object.keys(JSON.parse(store.getItem(CLIP_KEY)));
  assert.equal(kept.length, 6);
  assert.ok(kept.includes('K007-K117'));
});

test('each phase asks for the chart a pilot would open', () => {
  assert.deepEqual(wantedChart('taxi', 400), { role: 'DEP', kind: 'diagram' });
  assert.deepEqual(wantedChart('climb', 4000), { role: 'DEP', kind: 'sid' });
  assert.equal(wantedChart('cruise', 35000), null, 'the cruise keeps the open chart');
  assert.deepEqual(wantedChart('descent', 24000), { role: 'ARR', kind: 'star' });
  assert.deepEqual(wantedChart('descent', 8000), { role: 'ARR', kind: 'approach' });
  assert.deepEqual(wantedChart('afterLanding', 30), { role: 'ARR', kind: 'diagram' });
});

test('a pinned chart wins over the catalogue, and kinds group approach families', () => {
  assert.equal(chartKind(ILS), 'approach');
  assert.equal(chartKind({ category: 'hotspot' }), '');
  const catalogue = [{ ...DIAGRAM, pdf: 'OTHER.PDF' }, SID];
  assert.equal(pickChart({ role: 'DEP', kind: 'diagram' }, 'KSEA', [DIAGRAM], catalogue).pdf, '00582AD.PDF');
  assert.equal(pickChart({ role: 'DEP', kind: 'sid' }, 'KSEA', [DIAGRAM], catalogue).pdf, '00582BANGR.PDF');
  assert.equal(pickChart({ role: 'ARR', kind: 'approach' }, 'KPDX', [ILS], []).pdf, '00319IL10R.PDF');
  assert.equal(pickChart({ role: 'ARR', kind: 'star' }, 'KPDX', [ILS], []), null);
});

test('the phase inference the Auto mode reads, end to end', () => {
  let phase = 'dispatch';
  const step = t => { phase = inferPhase(t, phase).key; return wantedChart(phase, t.alt); };
  assert.deepEqual(step({ onGround: true, gs: 12, vs: 0, alt: 400 }), { role: 'DEP', kind: 'diagram' });
  assert.deepEqual(step({ onGround: false, agl: 1500, gs: 180, vs: 2200, alt: 1900 }), { role: 'DEP', kind: 'sid' });
  assert.equal(step({ onGround: false, agl: 34000, gs: 450, vs: 0, alt: 35000 }), null);
  assert.deepEqual(step({ onGround: false, agl: 20000, gs: 420, vs: -1800, alt: 21000 }), { role: 'ARR', kind: 'star' });
  assert.deepEqual(step({ onGround: false, agl: 5000, gs: 220, vs: -900, alt: 5500 }), { role: 'ARR', kind: 'approach' });
  assert.deepEqual(step({ onGround: true, gs: 60, vs: 0, alt: 30 }), { role: 'ARR', kind: 'diagram' });
});
