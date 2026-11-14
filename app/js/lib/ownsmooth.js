/* Smooth the simulator aircraft between bridge samples.
 *
 * The bridge sends a position a few times a second; drawn raw, the aircraft
 * steps once per sample. Each frame the last sample is projected along its
 * track at its groundspeed (the same dead reckoning the map already applies to
 * ADS-B traffic), and the shown position eases toward that projection, so a
 * new sample corrects the aircraft gradually instead of snapping it. A jump
 * larger than SNAP_NM (slew, teleport, first fix) is taken at once.
 */

import { destination, distanceNm, validLatLon } from './geo.js';

export const SNAP_NM = 1;
export const MAX_PREDICT_S = 2; // a stalled feed stops moving instead of flying on
const RATE = 8; // per second; ~90% of a correction lands within 0.3 s

const wrap180 = d => ((d % 360) + 540) % 360 - 180;

const easeFactor = dt => 1 - Math.exp(-RATE * Math.max(0, Number(dt) || 0));

/** Ease angle `shown` toward `target` over dt seconds, the shorter way round. */
export function easeAngle(shown, target, dt) {
  if (!Number.isFinite(target)) return shown;
  if (!Number.isFinite(shown)) return target;
  return (shown + wrap180(target - shown) * easeFactor(dt) + 360) % 360;
}

/**
 * Next shown position.
 * shown:  { lat, lon } currently drawn, or null.
 * sample: { lat, lon, gs (kt), trk, hdg } latest bridge sample.
 * ageS:   seconds since that sample arrived.  dt: seconds since the last frame.
 */
export function smoothPosition(shown, sample, ageS, dt) {
  if (!sample || !validLatLon(sample.lat, sample.lon)) return shown;
  const gs = Number(sample.gs);
  const course = Number.isFinite(sample.trk) ? sample.trk : sample.hdg;
  const age = Math.max(0, Math.min(MAX_PREDICT_S, Number(ageS) || 0));
  const target = gs > 1 && Number.isFinite(course)
    ? destination(sample, course, (gs / 3600) * age)
    : { lat: sample.lat, lon: sample.lon };
  if (!shown || !validLatLon(shown.lat, shown.lon) || distanceNm(shown, target) > SNAP_NM) return target;
  const k = easeFactor(dt);
  return {
    lat: shown.lat + (target.lat - shown.lat) * k,
    lon: wrap180(shown.lon + wrap180(target.lon - shown.lon) * k),
  };
}
