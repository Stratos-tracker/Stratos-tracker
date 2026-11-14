/* Upper-air weather for the Flight Deck map: jet stream and turbulence.
 *
 * Source: Open-Meteo's forecast API (free, no key), pressure-level winds and
 * geopotential heights on a grid over the view, for the current hour.
 *
 * Jet stream: wind speed at the chosen flight level, coloured from 50 kt and
 * contoured every 20 kt (isotachs), as on a significant-weather chart.
 *
 * Turbulence: the Ellrod index (TI1, Ellrod & Knapp 1992), the standard
 * forecast index for clear-air turbulence: vertical wind shear between two
 * pressure levels times the sum of horizontal deformation and convergence.
 * Units 1e-7 s^-2; 4 light, 8 moderate, 12 severe. It is a forecast index on
 * a coarse grid, not an observation or a PIREP.
 */

// Flight level -> pressure level, and the level below it for the shear layer.
export const LEVELS = [
  { fl: 180, hpa: 500, lower: 600 },
  { fl: 240, hpa: 400, lower: 500 },
  { fl: 300, hpa: 300, lower: 400 },
  { fl: 340, hpa: 250, lower: 300 },
  { fl: 390, hpa: 200, lower: 250 },
  { fl: 450, hpa: 150, lower: 200 },
];
export const DEFAULT_FL = 340;
export const levelFor = fl => LEVELS.find(l => l.fl === Number(fl)) || LEVELS.find(l => l.fl === DEFAULT_FL);

export const GRID_COLS = 13;
export const GRID_ROWS = 9;
const KT = 0.514444;

/** Grid nodes over a lat/lon box, row by row from the south. */
export function gridPoints(box, cols = GRID_COLS, rows = GRID_ROWS) {
  const pts = [];
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      pts.push({
        lat: box.minLat + (box.maxLat - box.minLat) * (r / (rows - 1)),
        lon: box.minLon + (box.maxLon - box.minLon) * (c / (cols - 1)),
      });
    }
  }
  return pts;
}

export function openMeteoUrl(points, level) {
  const vars = [level.hpa, level.lower].flatMap(p => [`wind_speed_${p}hPa`, `wind_direction_${p}hPa`, `geopotential_height_${p}hPa`]);
  return 'https://api.open-meteo.com/v1/forecast'
    + `?latitude=${points.map(p => p.lat.toFixed(2)).join(',')}`
    + `&longitude=${points.map(p => p.lon.toFixed(2)).join(',')}`
    + `&hourly=${vars.join(',')}&forecast_hours=1&wind_speed_unit=kn&timezone=UTC`;
}

const uv = (kt, dirFrom) => {
  const d = (Number(dirFrom) || 0) * Math.PI / 180;
  const s = Number(kt) || 0;
  return { u: -s * Math.sin(d), v: -s * Math.cos(d), kt: s };
};

/** Open-Meteo's answer (one object per point) -> the grid the map reads. */
export function parseGrid(data, points, level, box, cols = GRID_COLS, rows = GRID_ROWS) {
  const list = Array.isArray(data) ? data : [data];
  if (list.length !== points.length) throw new Error('Open-Meteo answered for a different grid');
  const pick = (h, name) => (h && Array.isArray(h[name]) ? h[name][0] : null);
  const upper = [];
  const lower = [];
  for (const row of list) {
    const h = row && row.hourly;
    const up = uv(pick(h, `wind_speed_${level.hpa}hPa`), pick(h, `wind_direction_${level.hpa}hPa`));
    const lo = uv(pick(h, `wind_speed_${level.lower}hPa`), pick(h, `wind_direction_${level.lower}hPa`));
    upper.push({ ...up, z: Number(pick(h, `geopotential_height_${level.hpa}hPa`)) });
    lower.push({ ...lo, z: Number(pick(h, `geopotential_height_${level.lower}hPa`)) });
  }
  const time = list[0] && list[0].hourly && Array.isArray(list[0].hourly.time) ? list[0].hourly.time[0] : '';
  return { cols, rows, box, points, level, upper, lower, time, ti: ellrod({ cols, rows, points, upper, lower }) };
}

/** Ellrod TI1 at every node, in 1e-7 s^-2 (negative values floored at 0). */
export function ellrod({ cols, rows, points, upper, lower }) {
  const at = (arr, r, c) => arr[Math.max(0, Math.min(rows - 1, r)) * cols + Math.max(0, Math.min(cols - 1, c))];
  // The layer's own wind: the mean of its two bounding levels, in m/s.
  const mid = upper.map((p, i) => ({ u: (p.u + lower[i].u) / 2 * KT, v: (p.v + lower[i].v) / 2 * KT }));
  const out = new Array(cols * rows).fill(0);
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      const i = r * cols + c;
      const dz = upper[i].z - lower[i].z;
      if (!(dz > 100)) continue;
      const vws = Math.hypot((upper[i].u - lower[i].u) * KT, (upper[i].v - lower[i].v) * KT) / dz;
      const c0 = Math.max(0, c - 1); const c1 = Math.min(cols - 1, c + 1);
      const r0 = Math.max(0, r - 1); const r1 = Math.min(rows - 1, r + 1);
      const lat = points[i].lat * Math.PI / 180;
      const dx = (at(points, r, c1).lon - at(points, r, c0).lon) * 111320 * Math.cos(lat);
      const dy = (at(points, r1, c).lat - at(points, r0, c).lat) * 110540;
      if (!(Math.abs(dx) > 1) || !(Math.abs(dy) > 1)) continue;
      const dudx = (at(mid, r, c1).u - at(mid, r, c0).u) / dx;
      const dvdx = (at(mid, r, c1).v - at(mid, r, c0).v) / dx;
      const dudy = (at(mid, r1, c).u - at(mid, r0, c).u) / dy;
      const dvdy = (at(mid, r1, c).v - at(mid, r0, c).v) / dy;
      const def = Math.hypot(dudx - dvdy, dvdx + dudy);
      const cvg = -(dudx + dvdy);
      out[i] = Math.max(0, vws * (def + cvg) * 1e7);
    }
  }
  return out;
}

export const TURB_LEVELS = [
  { min: 4, label: 'Light', rgb: [250, 204, 21] },
  { min: 8, label: 'Moderate', rgb: [249, 115, 22] },
  { min: 12, label: 'Severe', rgb: [220, 38, 38] },
];
export function turbCategory(ti) {
  let found = null;
  for (const level of TURB_LEVELS) if (ti >= level.min) found = level;
  return found;
}

/** Bilinear value of a node array at a lat/lon inside the grid's box. */
export function sample(grid, values, lat, lon) {
  const { box, cols, rows } = grid;
  const fx = Math.max(0, Math.min(cols - 1, (lon - box.minLon) / Math.max(1e-9, box.maxLon - box.minLon) * (cols - 1)));
  const fy = Math.max(0, Math.min(rows - 1, (lat - box.minLat) / Math.max(1e-9, box.maxLat - box.minLat) * (rows - 1)));
  const c = Math.min(cols - 2, Math.floor(fx));
  const r = Math.min(rows - 2, Math.floor(fy));
  const tx = fx - c;
  const ty = fy - r;
  const v = (rr, cc) => values[rr * cols + cc];
  const a = v(r, c) + (v(r, c + 1) - v(r, c)) * tx;
  const b = v(r + 1, c) + (v(r + 1, c + 1) - v(r + 1, c)) * tx;
  return a + (b - a) * ty;
}

/**
 * Marching squares: line segments where `values` crosses `level`, in grid
 * coordinates (x = column, y = row). Used for the isotachs.
 */
export function isolines(values, cols, rows, level) {
  const segs = [];
  const lerp = (a, b) => (level - a) / ((b - a) || 1e-9);
  for (let r = 0; r < rows - 1; r += 1) {
    for (let c = 0; c < cols - 1; c += 1) {
      const a = values[r * cols + c];
      const b = values[r * cols + c + 1];
      const d = values[(r + 1) * cols + c];
      const e = values[(r + 1) * cols + c + 1];
      const pts = [];
      if ((a < level) !== (b < level)) pts.push([c + lerp(a, b), r]);
      if ((b < level) !== (e < level)) pts.push([c + 1, r + lerp(b, e)]);
      if ((d < level) !== (e < level)) pts.push([c + lerp(d, e), r + 1]);
      if ((a < level) !== (d < level)) pts.push([c, r + lerp(a, d)]);
      if (pts.length === 2) segs.push([...pts[0], ...pts[1]]);
      else if (pts.length === 4) segs.push([...pts[0], ...pts[1]], [...pts[2], ...pts[3]]);
    }
  }
  return segs;
}

// Jet-stream colours by speed (kt): transparent below 50, as on the reference.
export const JET_STOPS = [[50, [34, 197, 94]], [80, [234, 179, 8]], [110, [249, 115, 22]], [140, [239, 68, 68]], [160, [217, 70, 239]], [180, [147, 51, 234]]];
export function jetColor(kt) {
  if (!(kt >= 40)) return null;
  const alpha = Math.min(0.62, 0.62 * (kt - 40) / 15);
  if (kt <= JET_STOPS[0][0]) return [...JET_STOPS[0][1], alpha];
  for (let i = 1; i < JET_STOPS.length; i += 1) {
    const [k1, c1] = JET_STOPS[i];
    const [k0, c0] = JET_STOPS[i - 1];
    if (kt <= k1) {
      const f = (kt - k0) / (k1 - k0);
      return [c0[0] + (c1[0] - c0[0]) * f, c0[1] + (c1[1] - c0[1]) * f, c0[2] + (c1[2] - c0[2]) * f, alpha];
    }
  }
  return [...JET_STOPS[JET_STOPS.length - 1][1], alpha];
}
