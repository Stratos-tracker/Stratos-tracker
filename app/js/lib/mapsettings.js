/* User preferences for the Flight Deck aircraft symbol and own trail.
 *
 * Stored as one JSON record so the map and Settings read exactly the same
 * values. Pure normalisation lives here so a malformed or older record can
 * never break the map, and the settings page can test its output without a
 * browser. */

export const MAP_SETTINGS_KEY = 'stratos.mapSettings';

export const DEFAULT_MAP_SETTINGS = Object.freeze({
  color: '#fbbf24',
  size: 1.35,
  halo: false,
  trail: true,
  trailWidth: 1,
});

const COLOR = /^#[0-9a-f]{6}$/i;
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

/** Turn any stored value into the complete, bounded settings object. */
export function normalizeMapSettings(value) {
  const raw = value && typeof value === 'object' ? value : {};
  const color = typeof raw.color === 'string' && COLOR.test(raw.color.trim())
    ? raw.color.trim().toLowerCase()
    : DEFAULT_MAP_SETTINGS.color;
  const size = Number.isFinite(Number(raw.size))
    ? clamp(Number(raw.size), 0.7, 2)
    : DEFAULT_MAP_SETTINGS.size;
  const trailWidth = Number.isFinite(Number(raw.trailWidth))
    ? clamp(Number(raw.trailWidth), 0.5, 2)
    : DEFAULT_MAP_SETTINGS.trailWidth;
  return {
    color,
    size: Math.round(size * 100) / 100,
    halo: typeof raw.halo === 'boolean' ? raw.halo : DEFAULT_MAP_SETTINGS.halo,
    trail: typeof raw.trail === 'boolean' ? raw.trail : DEFAULT_MAP_SETTINGS.trail,
    trailWidth: Math.round(trailWidth * 100) / 100,
  };
}

/** Read the settings from localStorage, falling back to the defaults. */
export function readMapSettings(storage = null) {
  try {
    const store = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
    if (!store) return { ...DEFAULT_MAP_SETTINGS };
    return normalizeMapSettings(JSON.parse(store.getItem(MAP_SETTINGS_KEY) || 'null'));
  } catch (_) {
    return { ...DEFAULT_MAP_SETTINGS };
  }
}

/** Persist one complete settings object and return it. */
export function writeMapSettings(storage, value) {
  const settings = normalizeMapSettings(value);
  try {
    const store = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
    store?.setItem(MAP_SETTINGS_KEY, JSON.stringify(settings));
  } catch (_) { /* storage disabled: the map keeps its defaults */ }
  return settings;
}
