/* Geometry for the 3D flight track.
 *
 * The recorded track is the only input: latitude, longitude and the altitude
 * the bridge reported with each sample. Nothing is interpolated beyond drawing
 * a smooth line through those samples, and no point is invented.
 *
 * The track is laid on a local tangent plane (metres east/north) and projected
 * through a small orbit camera. Altitude is normalised over the sample's own
 * range and given a fixed share of the horizontal span, so a 300 nm sector does
 * not flatten a 35,000 ft climb into a straight line; the vertical share is
 * printed on the chart so the exaggeration is never mistaken for true scale.
 */

const FT_TO_M = 0.3048;
const DEG = Math.PI / 180;

export function normaliseTrack(raw) {
  return (Array.isArray(raw) ? raw : [])
    .map(point => (Array.isArray(point)
      ? { lat: Number(point[0]), lon: Number(point[1]), alt: Number(point[2]), t: Number(point[3]), agl: Number(point[4]) }
      : point))
    .filter(point => point && Number.isFinite(Number(point.lat)) && Number.isFinite(Number(point.lon)))
    .map(point => ({
      lat: Number(point.lat),
      lon: Number(point.lon),
      alt: Number.isFinite(Number(point.alt)) ? Number(point.alt) : 0,
      agl: Number.isFinite(Number(point.agl)) && Number(point.agl) >= 0 ? Number(point.agl) : null,
      t: Number.isFinite(Number(point.t)) ? Number(point.t) : null,
    }));
}

export function trackBounds(points) {
  const list = normaliseTrack(points);
  if (!list.length) return null;
  let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
  let minAlt = Infinity, maxAlt = -Infinity, minAgl = Infinity, maxAgl = -Infinity;
  for (const point of list) {
    minLat = Math.min(minLat, point.lat); maxLat = Math.max(maxLat, point.lat);
    minLon = Math.min(minLon, point.lon); maxLon = Math.max(maxLon, point.lon);
    minAlt = Math.min(minAlt, point.alt); maxAlt = Math.max(maxAlt, point.alt);
    if (point.agl != null) { minAgl = Math.min(minAgl, point.agl); maxAgl = Math.max(maxAgl, point.agl); }
  }
  return { minLat, maxLat, minLon, maxLon, minAlt, maxAlt, minAgl: Number.isFinite(minAgl) ? minAgl : null, maxAgl: Number.isFinite(maxAgl) ? maxAgl : null };
}

/** Altitude above the ground when the recorder stored AGL, otherwise MSL. */
export function trackHeight(point, bounds) {
  if (!point) return 0;
  if (point.agl != null) return point.agl;
  return Math.max(0, point.alt - (bounds ? bounds.minAlt : 0));
}

function orbit({ X, Z, Y, pitch }) {
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  return { sx: X, sy: Y * cp - Z * sp, depth: Z * cp + Y * sp };
}

/**
 * Project the track into screen space.
 *
 * Returns the screen points plus a `toScreen(lat, lon, alt)` closure using the
 * same transform, so the ground grid, the altitude drop lines and the aircraft
 * all agree with the path.
 */
export function projectTrack(raw, options = {}) {
  const points = normaliseTrack(raw);
  if (!points.length) {
    return { points: [], bounds: null, ceiling: 0, spanM: 0, minAlt: 0, maxAlt: 0, scale: 0, toScreen: null, exaggeration: 0 };
  }
  const width = Math.max(1, Number(options.width) || 640);
  const height = Math.max(1, Number(options.height) || 420);
  const pad = Number.isFinite(Number(options.pad)) ? Number(options.pad) : 42;
  const yaw = Number.isFinite(Number(options.yaw)) ? Number(options.yaw) : 0.55;
  const pitch = Math.min(1.35, Math.max(-0.35, Number.isFinite(Number(options.pitch)) ? Number(options.pitch) : 0.34));
  const zoom = Math.min(6, Math.max(0.24, Number.isFinite(Number(options.zoom)) ? Number(options.zoom) : 1));

  const lat0 = points.reduce((sum, point) => sum + point.lat, 0) / points.length;
  const lon0 = points.reduce((sum, point) => sum + point.lon, 0) / points.length;
  const mx = 111320 * Math.cos(lat0 * DEG);
  const mz = 110540;
  const local = points.map(point => ({ x: (point.lon - lon0) * mx, z: (point.lat - lat0) * mz, lat: point.lat, lon: point.lon, alt: point.alt, agl: point.agl, t: point.t }));

  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  let minAlt = Infinity, maxAlt = -Infinity;
  for (const point of local) {
    minX = Math.min(minX, point.x); maxX = Math.max(maxX, point.x);
    minZ = Math.min(minZ, point.z); maxZ = Math.max(maxZ, point.z);
    minAlt = Math.min(minAlt, point.alt); maxAlt = Math.max(maxAlt, point.alt);
  }
  const cx = (minX + maxX) / 2;
  const cz = (minZ + maxZ) / 2;
  // A very short recording still gets a usable frame rather than a divide-by-zero.
  const spanM = Math.max(maxX - minX, maxZ - minZ, 500);
  // A recording with no altitude change stays flat and says so; otherwise the
  // profile gets a fixed share of the horizontal span so it stays readable.
  const altSpread = maxAlt - minAlt;
  const flat = altSpread < 1;
  const altRange = flat ? 1 : altSpread;
  const verticalShare = flat ? 0 : 0.34;

  const rot = local.map(point => {
    const nx = (point.x - cx) / spanM;
    const nz = (point.z - cz) / spanM;
    const ny = ((point.alt - minAlt) / altRange) * verticalShare;
    const X = nx * Math.cos(yaw) - nz * Math.sin(yaw);
    const Z = nx * Math.sin(yaw) + nz * Math.cos(yaw);
    return { ...point, ...orbit({ X, Z, Y: ny, pitch }), ny };
  });

  let minSx = Infinity, maxSx = -Infinity, minSy = Infinity, maxSy = -Infinity;
  for (const point of rot) {
    minSx = Math.min(minSx, point.sx); maxSx = Math.max(maxSx, point.sx);
    minSy = Math.min(minSy, point.sy); maxSy = Math.max(maxSy, point.sy);
  }
  const fitW = Math.max(1e-6, maxSx - minSx);
  const fitH = Math.max(1e-6, maxSy - minSy);
  const scale = Math.min((width - pad * 2) / fitW, (height - pad * 2) / fitH) * zoom;
  const midSx = (minSx + maxSx) / 2;
  const midSy = (minSy + maxSy) / 2;

  const toScreen = (lat, lon, alt) => {
    const nx = ((lon - lon0) * mx - cx) / spanM;
    const nz = ((lat - lat0) * mz - cz) / spanM;
    const ny = ((Number(alt) - minAlt) / altRange) * verticalShare;
    const X = nx * Math.cos(yaw) - nz * Math.sin(yaw);
    const Z = nx * Math.sin(yaw) + nz * Math.cos(yaw);
    const p = orbit({ X, Z, Y: ny, pitch });
    return { x: width / 2 + (p.sx - midSx) * scale, y: height / 2 - (p.sy - midSy) * scale, depth: p.depth };
  };

  const bounds = trackBounds(points);
  const ceiling = bounds && bounds.maxAgl != null ? bounds.maxAgl : Math.max(0, maxAlt - minAlt);
  return {
    points: rot.map((point, index) => ({
      x: width / 2 + (point.sx - midSx) * scale,
      y: height / 2 - (point.sy - midSy) * scale,
      depth: point.depth,
      index,
      lat: point.lat,
      lon: point.lon,
      alt: point.alt,
      agl: point.agl,
      t: point.t,
    })),
    bounds, ceiling, spanM, minAlt, maxAlt, scale,
    exaggeration: flat ? 0 : (verticalShare * spanM) / altSpread,
    toScreen,
  };
}

/** Nearest projected sample to a screen point, or null outside `radius` px. */
export function pickTrackPoint(projected, x, y, radius = 16) {
  let best = null;
  let bestDistance = radius * radius;
  for (const point of (Array.isArray(projected) ? projected : [])) {
    const dx = point.x - x;
    const dy = point.y - y;
    const distance = dx * dx + dy * dy;
    if (distance <= bestDistance) { bestDistance = distance; best = point; }
  }
  return best;
}

/** Vertical trend around a sample, from the recorded altitudes and times. */
export function verticalTrend(points, index) {
  const list = Array.isArray(points) ? points : [];
  const point = list[index];
  if (!point) return null;
  const before = list[Math.max(0, index - 4)];
  const after = list[Math.min(list.length - 1, index + 4)];
  const minutes = before && after && before.t != null && after.t != null ? (after.t - before.t) / 60000 : null;
  if (minutes && minutes > 0.001) {
    const fpm = (after.alt - before.alt) / minutes;
    return { fpm, label: fpm > 180 ? 'climbing' : fpm < -180 ? 'descending' : 'level' };
  }
  const delta = point.alt - (before ? before.alt : point.alt);
  return { fpm: null, label: delta > 60 ? 'climbing' : delta < -60 ? 'descending' : 'level' };
}

function channel(value) {
  return Math.max(0, Math.min(255, Math.round(value)));
}

/** Stratos cyan, darker at the ground and near-white at the top of the track. */
export function altitudeInk(ratio) {
  const t = Math.max(0, Math.min(1, Number(ratio) || 0));
  const from = [14, 116, 144];
  const to = [207, 250, 254];
  return `rgb(${channel(from[0] + (to[0] - from[0]) * t)},${channel(from[1] + (to[1] - from[1]) * t)},${channel(from[2] + (to[2] - from[2]) * t)})`;
}
