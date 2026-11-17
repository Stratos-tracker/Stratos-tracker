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
