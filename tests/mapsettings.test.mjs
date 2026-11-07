import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_MAP_SETTINGS, MAP_SETTINGS_KEY, normalizeMapSettings, readMapSettings, writeMapSettings,
} from '../app/js/lib/mapsettings.js';

test('map settings normalise malformed values to safe defaults', () => {
  assert.deepEqual(normalizeMapSettings(null), DEFAULT_MAP_SETTINGS);
  assert.deepEqual(normalizeMapSettings({ color: 'red', size: 99, trailWidth: -2 }), {
    ...DEFAULT_MAP_SETTINGS,
    size: 2,
    trailWidth: 0.5,
  });
});

test('map settings preserve valid user choices', () => {
  assert.deepEqual(normalizeMapSettings({
    color: '#38BDF8', size: 1.6, halo: true, trail: false, trailWidth: 1.4,
  }), {
    color: '#38bdf8', size: 1.6, halo: true, trail: false, trailWidth: 1.4,
  });
});

test('map settings round-trip through storage', () => {
  const rows = new Map();
  const storage = {
    getItem: key => rows.get(key) ?? null,
    setItem: (key, value) => rows.set(key, value),
  };
  const saved = writeMapSettings(storage, { color: '#22c55e', size: 1.2, halo: false });
  assert.equal(rows.has(MAP_SETTINGS_KEY), true);
  assert.deepEqual(readMapSettings(storage), saved);
  assert.deepEqual(saved, {
    ...DEFAULT_MAP_SETTINGS, color: '#22c55e', size: 1.2,
  });
});
