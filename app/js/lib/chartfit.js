/* Placing a chart on the map from what it prints.
 *
 * A chart PDF carries no coordinates, but it prints the names of the fixes,
 * navaids and runways it shows. Each name the navigation data knows is a pair:
 * where it sits on the sheet and where it is on the ground. A chart drawn to
 * scale maps every pair with one similarity (scale, rotation, offset), so a
 * placement is accepted only when at least three printed names agree on it.
 * A chart that is not to scale cannot satisfy that, and stays off the map.
 */

/** Least-squares similarity world = [a -b; b a]·chart + t, or null. */
export function fitSimilarity(pairs) {
  const n = pairs.length;
  if (n < 2) return null;
  let cx = 0, cy = 0, wx = 0, wy = 0;
  for (const p of pairs) { cx += p.chart[0]; cy += p.chart[1]; wx += p.world[0]; wy += p.world[1]; }
  cx /= n; cy /= n; wx /= n; wy /= n;
  let sxx = 0, sab = 0, sba = 0;
  for (const p of pairs) {
    const x = p.chart[0] - cx, y = p.chart[1] - cy, u = p.world[0] - wx, v = p.world[1] - wy;
    sxx += x * x + y * y; sab += x * u + y * v; sba += x * v - y * u;
  }
  if (!sxx) return null;
  const a = sab / sxx, b = sba / sxx;
  return { a, b, tx: wx - a * cx + b * cy, ty: wy - b * cx - a * cy };
}

/** Where a chart point lands in world units under a fit. */
export function applyFit(fit, x, y) {
  return [fit.a * x - fit.b * y + fit.tx, fit.b * x + fit.a * y + fit.ty];
}

const normal = text => String(text || '').trim().toUpperCase().replace(/^RWY\s*/, '').replace(/^0+(?=\d)/, '');

/**
 * The placement for one chart, or null.
 * labels: [{ text, x, y }] in sheet units; refs: Map(name -> { lat, lon });
 * project(lat, lon) -> [x, y] world units; metresPerUnit(lat) for the report.
 */
export function fitChart(labels, refs, project, { metresPerUnit = () => 1, minAgree = 3 } = {}) {
  const pairs = [];
  for (const label of Array.isArray(labels) ? labels : []) {
    const ref = refs && refs.get(normal(label.text));
    if (!ref || !Number.isFinite(label.x) || !Number.isFinite(label.y)) continue;
    pairs.push({ ident: normal(label.text), chart: [label.x, label.y], world: project(ref.lat, ref.lon), lat: ref.lat });
  }
  if (pairs.length < minAgree) return null;
  const error = (fit, p) => { const w = applyFit(fit, ...p.chart); return Math.hypot(w[0] - p.world[0], w[1] - p.world[1]); };
  // The sheet's own span decides how close "agreeing" is: 2% of what it covers.
  const spanOf = fit => Math.hypot(fit.a, fit.b) * Math.max(...pairs.map(p => Math.hypot(p.chart[0] - pairs[0].chart[0], p.chart[1] - pairs[0].chart[1])), 1);
  let best = null;
  for (let i = 0; i < pairs.length; i++) for (let j = i + 1; j < pairs.length; j++) {
    if (pairs[i].ident === pairs[j].ident) continue;
    if (Math.hypot(pairs[j].chart[0] - pairs[i].chart[0], pairs[j].chart[1] - pairs[i].chart[1]) < 25) continue;
    const fit = fitSimilarity([pairs[i], pairs[j]]);
    if (!fit) continue;
    const gate = spanOf(fit) * 0.02;
    const agree = pairs.filter(p => error(fit, p) <= gate);
    if (new Set(agree.map(p => p.ident)).size > (best ? best.idents : 0)) best = { agree, idents: new Set(agree.map(p => p.ident)).size };
  }
  if (!best || best.idents < minAgree) return null;
  // Refit on everything that agreed, then once more on what agrees with that:
  // the consensus of the sheet, not the two labels that happened to seed it.
  let fit = fitSimilarity(best.agree);
  for (let pass = 0; fit && pass < 2; pass++) {
    const gate = spanOf(fit) * 0.01;
    const agree = pairs.filter(p => error(fit, p) <= gate);
    if (new Set(agree.map(p => p.ident)).size < minAgree) break;
    best.agree = agree;
    fit = fitSimilarity(agree);
  }
  if (!fit) return null;
  const metres = best.agree.map(p => error(fit, p) * metresPerUnit(p.lat)).sort((a, b) => a - b);
  return {
    ...fit,
    idents: [...new Set(best.agree.map(p => p.ident))],
    medianM: Math.round(metres[Math.floor(metres.length / 2)]),
  };
}

/* ── Where the aircraft is on a chart, from the fixes the chart prints ──────
   Works on charts that are not drawn to scale: the position comes from the
   fixes nearest the aircraft, not from one fit of the whole sheet. Over a
   printed fix (within snapNm) the aircraft sits on that fix's label; between
   fixes it is mapped with the affine transform of the three nearest fixes
   that are not in a line (two give a similarity, one alone is not enough).
   labels: [{ text, x, y }] in sheet units; refs: Map(IDENT -> { lat, lon }).
   -> { x, y, rot, on, via } or null. rot is the chart angle of true north. */
const RAD = Math.PI / 180;
const merc = (lat, lon) => [lon * RAD, Math.log(Math.tan(Math.PI / 4 + Math.max(-85, Math.min(85, lat)) * RAD / 2))];
function gcNm(lat1, lon1, lat2, lon2) {
  const a = Math.sin((lat2 - lat1) * RAD / 2) ** 2 + Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.sin((lon2 - lon1) * RAD / 2) ** 2;
  return 3440.065 * 2 * Math.asin(Math.min(1, Math.sqrt(a)));
}
export function placeOnChart(labels, refs, lat, lon, { snapNm = 0.6, maxNm = 60, symbols = [], snapUnits = 36, route = [] } = {}) {
  if (!refs || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const byId = new Map();
  for (const label of Array.isArray(labels) ? labels : []) {
    const id = String((label && label.text) || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    // Two-letter tokens (runway sides, units) are too ambiguous to place by.
    if (id.length < 3 || byId.has(id)) continue;
    const ref = refs.get(id);
    if (!ref || !Number.isFinite(ref.lat) || !Number.isFinite(ref.lon)) continue;
    byId.set(id, { id, sx: label.x, sy: label.y, lat: ref.lat, lon: ref.lon, w: merc(ref.lat, ref.lon), d: gcNm(lat, lon, ref.lat, ref.lon) });
  }
  // The fix itself is the symbol printed next to its name, not the name: pair each
  // named fix with a nearby symbol, closest pairs first, one symbol per fix.
  const pairs = [];
  for (const f of byId.values()) symbols.forEach((s, i) => { const d = Math.hypot(s.x - f.sx, s.y - f.sy); if (d <= snapUnits) pairs.push([d, f, i]); });
  pairs.sort((a, b) => a[0] - b[0]);
  const takenFix = new Set(), takenSym = new Set();
  for (const [, f, i] of pairs) { if (takenFix.has(f.id) || takenSym.has(i)) continue; takenFix.add(f.id); takenSym.add(i); f.sx = symbols[i].x; f.sy = symbols[i].y; }
  const pts = [...byId.values()].sort((a, b) => a.d - b.d);
  if (!pts.length || pts[0].d > maxNm) return null;
  const [ax0, ay0] = merc(lat, lon);
  // Flying a leg of the route whose two fixes the chart prints: place the aircraft
  // along that printed leg by how far along it is. Charts not drawn to scale still
  // draw each leg as a line between its fixes, so this stays on the line.
  const ids = (Array.isArray(route) ? route : []).map(r => String(r || '').toUpperCase().replace(/[^A-Z0-9]/g, ''));
  let leg = null;
  for (let i = 0; i < ids.length - 1; i++) {
    const a = byId.get(ids[i]), b = byId.get(ids[i + 1]);
    if (!a || !b) continue;
    const dx = b.w[0] - a.w[0], dy = b.w[1] - a.w[1], L2 = dx * dx + dy * dy;
    if (!L2) continue;
    const u = ((ax0 - a.w[0]) * dx + (ay0 - a.w[1]) * dy) / L2;
    if (u < -0.05 || u > 1.05) continue;
    const cu = Math.max(0, Math.min(1, u)), xt = gcNm(lat, lon, a.lat + (b.lat - a.lat) * cu, a.lon + (b.lon - a.lon) * cu);
    if (xt <= 8 && (!leg || xt < leg.xt)) leg = { a, b, u: cu, xt };
  }
  if (leg) {
    const { a, b, u } = leg;
    const chartAngle = Math.atan2(b.sx - a.sx, -(b.sy - a.sy));
    const trueAngle = Math.atan2(b.w[0] - a.w[0], b.w[1] - a.w[1]);
    return { x: a.sx + (b.sx - a.sx) * u, y: a.sy + (b.sy - a.sy) * u, rot: chartAngle - trueAngle, on: u < .02 ? a.id : u > .98 ? b.id : '', via: [a.id, b.id], leg: true };
  }
  const near = pts.slice(0, 8);
  let T = null, via = [];
  // Affine from the nearest three fixes that span an area.
  for (let i = 0; i < near.length && !T; i++) for (let j = i + 1; j < near.length && !T; j++) for (let k = j + 1; k < near.length && !T; k++) {
    const [p, q, r] = [near[i], near[j], near[k]];
    const det = (q.w[0] - p.w[0]) * (r.w[1] - p.w[1]) - (r.w[0] - p.w[0]) * (q.w[1] - p.w[1]);
    const span = Math.max(Math.hypot(q.w[0] - p.w[0], q.w[1] - p.w[1]), Math.hypot(r.w[0] - p.w[0], r.w[1] - p.w[1])) ** 2;
    if (!(Math.abs(det) > span * 0.08)) continue;
    const solve = (vp, vq, vr) => {
      const a = ((vq - vp) * (r.w[1] - p.w[1]) - (vr - vp) * (q.w[1] - p.w[1])) / det;
      const b = ((vr - vp) * (q.w[0] - p.w[0]) - (vq - vp) * (r.w[0] - p.w[0])) / det;
      return [a, b, vp - a * p.w[0] - b * p.w[1]];
    };
    const X = solve(p.sx, q.sx, r.sx), Y = solve(p.sy, q.sy, r.sy);
    T = (x, y) => [X[0] * x + X[1] * y + X[2], Y[0] * x + Y[1] * y + Y[2]];
    via = [p.id, q.id, r.id];
  }
  if (!T && near.length >= 2) {
    // Two fixes: rotation, scale and shift (the sheet's y runs down, so mirror it).
    const [p, q] = near;
    const dw = [q.w[0] - p.w[0], -(q.w[1] - p.w[1])], ds = [q.sx - p.sx, q.sy - p.sy];
    const n = dw[0] ** 2 + dw[1] ** 2;
    if (n > 0) {
      const c = (ds[0] * dw[0] + ds[1] * dw[1]) / n, s = (ds[1] * dw[0] - ds[0] * dw[1]) / n;
      T = (x, y) => { const u = x - p.w[0], v = -(y - p.w[1]); return [p.sx + c * u - s * v, p.sy + s * u + c * v]; };
      via = [p.id, q.id];
    }
  }
  const [ax, ay] = merc(lat, lon);
  const on = pts[0].d <= snapNm ? pts[0].id : '';
  let pos = on ? [pts[0].sx, pts[0].sy] : T ? T(ax, ay) : null;
  if (!pos || !pos.every(Number.isFinite)) return null;
  let rot = 0;
  if (T) { const a = T(ax, ay), b = T(ax, ay + 0.001); rot = Math.atan2(b[0] - a[0], -(b[1] - a[1])); }
  return { x: pos[0], y: pos[1], rot, on, via: on ? [on] : via };
}
