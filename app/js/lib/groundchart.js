/* Airport ground geometry from the bridge's OpenStreetMap cache.
 *
 * The bridge returns the real OSM ways around an airfield:
 *   [aeroway type, ref, [[lat, lon], ...]]
 * Nothing here invents a taxiway, a designator or an apron. The renderer draws
 * what the ways contain, labels only the refs the ways carry, and the taxi
 * router only follows the taxiway/taxilane centre lines those ways describe.
 */

const R = 6371008.8;
const DEG = Math.PI / 180;

export const LINE_TYPES = new Set(['taxiway', 'taxilane']);
export const AREA_TYPES = new Set(['apron', 'terminal']);

export function normaliseWays(raw) {
  const readPoints = points => (Array.isArray(points) ? points : [])
    .map(point => (Array.isArray(point) ? { lat: Number(point[0]), lon: Number(point[1]) } : { lat: Number(point?.lat), lon: Number(point?.lon) }))
    .filter(point => Number.isFinite(point.lat) && Number.isFinite(point.lon));
  return (Array.isArray(raw) ? raw : []).map(way => {
    // Already normalised objects are accepted, so the helper is idempotent.
    if (way && !Array.isArray(way) && Array.isArray(way.points)) {
      const points = readPoints(way.points);
      return points.length > 1 ? { type: String(way.type || '').trim().toLowerCase(), ref: String(way.ref || '').trim(), points } : null;
    }
    if (!Array.isArray(way) || way.length < 3) return null;
    const type = String(way[0] || '').trim().toLowerCase();
    const ref = String(way[1] || '').trim();
    const points = readPoints(way[2]);
    return points.length > 1 ? { type, ref, points } : null;
  }).filter(Boolean);
}

export function airportOrigin(ways) {
  const list = normaliseWays(ways);
  const points = list.flatMap(way => way.points);
  if (!points.length) return null;
  const lat = points.reduce((sum, point) => sum + point.lat, 0) / points.length;
  const lon = points.reduce((sum, point) => sum + point.lon, 0) / points.length;
  return { lat, lon };
}

/** Local tangent-plane metres, east and north, around a chosen origin. */
export function localise(ways, origin) {
  const list = normaliseWays(ways);
  if (!list.length) return [];
  const base = origin || airportOrigin(ways);
  if (!base) return [];
  const mx = 111320 * Math.cos(base.lat * DEG);
  const mz = 110540;
  return list.map(way => ({
    ...way,
    points: way.points.map(point => ({ lat: point.lat, lon: point.lon, x: (point.lon - base.lon) * mx, y: (point.lat - base.lat) * mz })),
  }));
}

export function geometryBounds(localWays) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const way of localWays) {
    for (const point of way.points) {
      minX = Math.min(minX, point.x); maxX = Math.max(maxX, point.x);
      minY = Math.min(minY, point.y); maxY = Math.max(maxY, point.y);
    }
  }
  if (!Number.isFinite(minX)) return null;
  return { minX, maxX, minY, maxY, width: Math.max(maxX - minX, 60), height: Math.max(maxY - minY, 60) };
}

export function distanceMetres(a, b) {
  const dLat = (b.lat - a.lat) * DEG;
  const dLon = (b.lon - a.lon) * DEG;
  const lat = (a.lat + b.lat) / 2 * DEG;
  const x = dLon * Math.cos(lat) * R;
  const y = dLat * R;
  return Math.hypot(x, y);
}

export function bearingDegrees(a, b) {
  const y = Math.sin((b.lon - a.lon) * DEG) * Math.cos(b.lat * DEG);
  const x = Math.cos(a.lat * DEG) * Math.sin(b.lat * DEG)
    - Math.sin(a.lat * DEG) * Math.cos(b.lat * DEG) * Math.cos((b.lon - a.lon) * DEG);
  return (Math.atan2(y, x) / DEG + 360) % 360;
}

/** Graph of taxiway/taxilane centre lines, merged where ways meet within `toleranceM`. */
export function buildTaxiGraph(localWays, { toleranceM = 8 } = {}) {
  const nodes = [];
  const cells = new Map();
  const cellKey = (cx, cy) => `${cx}:${cy}`;
  const cellOf = value => Math.floor(value / toleranceM);

  function nodeFor(point, lat, lon) {
    const cx = cellOf(point.x);
    const cy = cellOf(point.y);
    for (let dx = -1; dx <= 1; dx += 1) {
      for (let dy = -1; dy <= 1; dy += 1) {
        const bucket = cells.get(cellKey(cx + dx, cy + dy));
        if (!bucket) continue;
        for (const id of bucket) {
          const node = nodes[id];
          if (Math.hypot(node.x - point.x, node.y - point.y) <= toleranceM) return id;
        }
      }
    }
    const id = nodes.length;
    nodes.push({ id, x: point.x, y: point.y, lat, lon, edges: [] });
    const key = cellKey(cx, cy);
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key).push(id);
    return id;
  }

  const lineWays = localWays.filter(way => LINE_TYPES.has(way.type));
  // OSM does not always split a taxiway where another way joins it. Add a node
  // at each real vertex that sits on another centre line, so the graph joins at
  // the charted junction instead of refusing the route. The added node lies on
  // the existing line; no new geometry is introduced.
  const vertices = [];
  for (const way of lineWays) for (const point of way.points) vertices.push(point);
  const onSegment = (point, a, b) => {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lengthSq = dx * dx + dy * dy;
    if (lengthSq < 0.0001) return null;
    const t = ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSq;
    if (t <= 0.02 || t >= 0.98) return null;
    const x = a.x + dx * t;
    const y = a.y + dy * t;
    const distance = Math.hypot(point.x - x, point.y - y);
    return distance <= toleranceM ? { t, x, y, lat: a.lat + (b.lat - a.lat) * t, lon: a.lon + (b.lon - a.lon) * t } : null;
  };

  const edges = [];
  for (const way of lineWays) {
    const line = [way.points[0]];
    for (let i = 1; i < way.points.length; i += 1) {
      const a = way.points[i - 1];
      const b = way.points[i];
      if (Math.hypot(a.x - b.x, a.y - b.y) < 0.5) continue;
      const hits = [];
      for (const vertex of vertices) {
        if (Math.hypot(vertex.x - a.x, vertex.y - a.y) <= toleranceM) continue;
        if (Math.hypot(vertex.x - b.x, vertex.y - b.y) <= toleranceM) continue;
        const hit = onSegment(vertex, a, b);
        if (hit) hits.push(hit);
      }
      hits.sort((left, right) => left.t - right.t);
      let lastT = 0;
      for (const hit of hits) {
        if (hit.t - lastT < 0.01) continue;
        line.push({ x: hit.x, y: hit.y, lat: hit.lat, lon: hit.lon });
        lastT = hit.t;
      }
      line.push(b);
    }
    for (let i = 1; i < line.length; i += 1) {
      const a = line[i - 1];
      const b = line[i];
      const aId = nodeFor(a, a.lat, a.lon);
      const bId = nodeFor(b, b.lat, b.lon);
      if (aId === bId) continue;
      const length = Math.hypot(a.x - b.x, a.y - b.y);
      edges.push({ a: aId, b: bId, length, ref: way.ref, type: way.type });
      nodes[aId].edges.push({ to: bId, length, ref: way.ref, type: way.type, edge: edges.length - 1 });
      nodes[bId].edges.push({ to: aId, length, ref: way.ref, type: way.type, edge: edges.length - 1 });
    }
  }
  return { nodes, edges, toleranceM };
}

export function nearestNode(graph, point, maxMetres = Infinity) {
  if (!graph || !point) return null;
  let best = null;
  let bestDistance = maxMetres;
  for (const node of graph.nodes) {
    const distance = Math.hypot(node.x - point.x, node.y - point.y);
    if (distance <= bestDistance) { bestDistance = distance; best = node; }
  }
  return best ? { node: best, distance: bestDistance } : null;
}

export function shortestPath(graph, startId, endId) {
  if (!graph || startId == null || endId == null) return null;
  const count = graph.nodes.length;
  const dist = new Array(count).fill(Infinity);
  const prev = new Array(count).fill(null);
  const done = new Array(count).fill(false);
  dist[startId] = 0;
  for (let step = 0; step < count; step += 1) {
    let current = -1;
    let best = Infinity;
    for (let i = 0; i < count; i += 1) {
      if (!done[i] && dist[i] < best) { best = dist[i]; current = i; }
    }
    if (current < 0) break;
    if (current === endId) break;
    done[current] = true;
    for (const edge of graph.nodes[current].edges) {
      const next = dist[current] + edge.length;
      if (next < dist[edge.to]) {
        dist[edge.to] = next;
        prev[edge.to] = { node: current, ref: edge.ref };
      }
    }
  }
  if (!Number.isFinite(dist[endId])) return null;
  const chain = [];
  const refs = [];
  let cursor = endId;
  while (cursor != null) {
    chain.push(graph.nodes[cursor]);
    const step = prev[cursor];
    if (!step) break;
    if (step.ref && step.ref !== refs[refs.length - 1]) refs.unshift(step.ref);
    cursor = step.node;
  }
  chain.reverse();
  // One label per taxiway, in the order the route flies it.
  const uniqueRefs = refs.filter((ref, index) => ref && ref !== refs[index - 1]);
  return { nodes: chain, lengthM: dist[endId], refs: uniqueRefs };
}

/** Runway thresholds from the runway ways themselves, with their ref when tagged. */
export function runwayEnds(ways) {
  const ends = [];
  for (const way of normaliseWays(ways)) {
    if (way.type !== 'runway' || way.points.length < 2) continue;
    const first = way.points[0];
    const last = way.points[way.points.length - 1];
    ends.push({ lat: first.lat, lon: first.lon, ref: way.ref, toward: last });
    ends.push({ lat: last.lat, lon: last.lon, ref: way.ref, toward: first });
  }
  return ends;
}

/**
 * Pick the runway end a designator names. With no designator, or no match, the
 * end nearest the reference point is used and the caller labels it as nearest.
 */
export function runwayTarget(ways, reference, designator = '') {
  const ends = runwayEnds(ways);
  if (!ends.length) return null;
  const number = Number(String(designator || '').replace(/[^0-9]/g, '').slice(0, 2));
  let best = null;
  for (const end of ends) {
    const bearing = bearingDegrees(end, end.toward);
    const distance = reference ? distanceMetres(reference, end) : 0;
    let mismatch = null;
    if (Number.isFinite(number) && number > 0) {
      mismatch = Math.abs(((bearing - number * 10 + 540) % 360) - 180);
    }
    const score = mismatch != null ? mismatch : distance;
    if (!best || score < best.score) best = { ...end, bearing, distance, mismatch, score, matched: mismatch != null && mismatch <= 28 };
  }
  return best;
}

/**
 * A taxi route from a position to a target point, following only real taxiway
 * geometry. Returns null when the two ends are not joined by the charted ways.
 */
function distanceToWay(point, way) {
  let best = Infinity;
  for (let i = 1; i < way.points.length; i += 1) {
    const a = way.points[i - 1];
    const b = way.points[i];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lengthSq = dx * dx + dy * dy;
    const t = lengthSq < 0.0001 ? 0 : Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSq));
    best = Math.min(best, Math.hypot(point.x - (a.x + dx * t), point.y - (a.y + dy * t)));
  }
  return best;
}

export function taxiRoute(ways, from, target, { maxStartM = 300, maxTargetM = 400, preferRunway = false } = {}) {
  const local = localise(ways);
  if (!local.length || !from || !target) return null;
  const graph = buildTaxiGraph(local);
  if (!graph.nodes.length) return null;
  const startPoint = { x: (from.lon - (airportOrigin(ways) || from).lon) * 111320 * Math.cos(from.lat * DEG), y: (from.lat - (airportOrigin(ways) || from).lat) * 110540 };
  const endPoint = { x: (target.lon - (airportOrigin(ways) || target).lon) * 111320 * Math.cos(target.lat * DEG), y: (target.lat - (airportOrigin(ways) || target).lat) * 110540 };
  const start = nearestNode(graph, startPoint, maxStartM);
  // To a runway, end at a taxiway node that actually meets the runway, not at
  // whichever parallel taxiway happens to be closest to the threshold.
  const runwayWays = local.filter(way => way.type === 'runway');
  const runwayNodes = preferRunway && runwayWays.length
    ? graph.nodes.filter(node => runwayWays.some(way => distanceToWay(node, way) <= 45))
    : [];
  const end = (runwayNodes.length ? nearestNode({ nodes: runwayNodes }, endPoint, maxTargetM) : null)
    || nearestNode(graph, endPoint, maxTargetM);
  if (!start || !end) return null;
  const path = shortestPath(graph, start.node.id, end.node.id);
  if (!path) return null;
  return {
    ...path,
    fromDistanceM: start.distance,
    toDistanceM: end.distance,
    path: path.nodes.map(node => ({ lat: node.lat, lon: node.lon, x: node.x, y: node.y })),
  };
}
