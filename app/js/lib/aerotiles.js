/* Airfield ground geometry from OpenFreeMap vector tiles (OpenStreetMap data).
 *
 * The same source the Flight Deck draws its taxiways from: the tiles are on a
 * CDN, so they answer in a second where the Overpass servers can take minutes
 * or refuse. Output matches the bridge's /osm shape: [aeroway, ref, [[lat, lon], ...]].
 * The tiles carry runways, taxiways, aprons and gates, not holding points. */

const TILEJSON = 'https://tiles.openfreemap.org/planet';
const ZOOM = 14;
const KEEP = new Set(['runway', 'taxiway', 'apron', 'gate']);

/** The aeroway layer of one Mapbox Vector Tile (protobuf), as [class, ref, [[lat, lon], ...]]. */
export function decodeAeroways(buffer, z, tx, ty) {
  const d = new Uint8Array(buffer);
  let p = 0;
  const out = [];
  const varint = () => { let r = 0, s = 1, b; do { b = d[p++]; r += (b & 127) * s; s *= 128; } while (b & 128); return r; };
  const skip = w => { if (w === 0) varint(); else if (w === 1) p += 8; else if (w === 2) { const l = varint(); p += l; } else if (w === 5) p += 4; };
  const str = (s, e) => new TextDecoder().decode(d.subarray(s, e));
  const value = (s, e) => { p = s; let v = null; while (p < e) { const k = varint(), f = Math.floor(k / 8), w = k & 7; if (f === 1 && w === 2) { const l = varint(); v = str(p, p + l); p += l; } else if (w === 0) v = varint(); else skip(w); } return v; };
  const latLon = (px, py, extent) => {
    const n = Math.PI - 2 * Math.PI * (ty + py / extent) / 2 ** z;
    return [180 / Math.PI * Math.atan(Math.sinh(n)), (tx + px / extent) / 2 ** z * 360 - 180];
  };
  const layer = end => {
    let name = '', extent = 4096;
    const keys = [], vals = [], feats = [];
    while (p < end) {
      const k = varint(), f = Math.floor(k / 8), w = k & 7;
      if (w === 2) {
        const l = varint(), s = p, e = p + l;
        if (f === 1) name = str(s, e); else if (f === 2) feats.push([s, e]); else if (f === 3) keys.push(str(s, e)); else if (f === 4) vals.push(value(s, e));
        p = e;
      } else if (f === 5 && w === 0) extent = varint(); else skip(w);
    }
    if (name !== 'aeroway') return;
    for (const [s, e] of feats) {
      p = s;
      const tags = [], geom = [];
      let type = 0;
      while (p < e) {
        const k = varint(), f = Math.floor(k / 8), w = k & 7;
        if (f === 2 && w === 2) { const l = varint(), e2 = p + l; while (p < e2) tags.push(varint()); }
        else if (f === 4 && w === 2) { const l = varint(), e2 = p + l; while (p < e2) geom.push(varint()); }
        else if (f === 3 && w === 0) type = varint(); else skip(w);
      }
      const at = {};
      for (let i = 0; i < tags.length; i += 2) at[keys[tags[i]]] = vals[tags[i + 1]];
      const cls = at.class;
      // Runway polygons are the paved outline; the centre line (a line string) is what the chart draws.
      if (!KEEP.has(cls) || (cls === 'runway' && type !== 2)) continue;
      let x = 0, y = 0, i = 0, cur = null;
      const rings = [];
      while (i < geom.length) {
        const c = geom[i++], id = c & 7, n = c >>> 3;
        if (id === 7) { if (cur && cur.length) cur.push(cur[0]); continue; }
        for (let q = 0; q < n; q++) {
          const dx = geom[i++], dy = geom[i++];
          x += (dx >>> 1) ^ -(dx & 1); y += (dy >>> 1) ^ -(dy & 1);
          if (id === 1) { cur = [latLon(x, y, extent)]; rings.push(cur); } else cur.push(latLon(x, y, extent));
        }
      }
      for (const ring of rings) if (ring.length > 1 || cls === 'gate') out.push([cls, at.ref == null ? '' : String(at.ref), ring]);
    }
  };
  while (p < d.length) {
    const k = varint(), f = Math.floor(k / 8), w = k & 7;
    if (f === 3 && w === 2) { const l = varint(), e = p + l; layer(e); p = e; } else skip(w);
  }
  return out;
}

/** Tiles (x, y at zoom 14) covering about 3.5 km around a point. */
export function tilesAround(lat, lon, z = ZOOM) {
  const n = 2 ** z, rad = Math.PI / 180, dl = 0.032, dn = dl / Math.cos(lat * rad);
  const tx = l => Math.floor((l + 180) / 360 * n);
  const ty = l => { const s = Math.sin(l * rad); return Math.floor((0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n); };
  const out = [];
  for (let x = tx(lon - dn); x <= tx(lon + dn); x++) for (let y = ty(lat + dl); y <= ty(lat - dl); y++) out.push([x, y]);
  return out;
}

let template = null;

/** Every aeroway around an airfield from the vector tiles; throws when none can be read. */
export async function aerowaysFromTiles(lat, lon, { fetcher = fetch } = {}) {
  if (!template) {
    const r = await fetcher(TILEJSON);
    if (!r.ok) throw new Error(`map tiles answered ${r.status}`);
    template = (await r.json()).tiles[0];
  }
  let out = [], failed = 0;
  await Promise.all(tilesAround(lat, lon).map(async ([x, y]) => {
    try {
      const r = await fetcher(template.replace('{z}', ZOOM).replace('{x}', x).replace('{y}', y));
      if (!r.ok) { failed++; return; }
      let buffer = await r.arrayBuffer();
      const head = new Uint8Array(buffer);
      if (head[0] === 31 && head[1] === 139) buffer = await new Response(new Blob([buffer]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
      out = out.concat(decodeAeroways(buffer, ZOOM, x, y));
    } catch (_) { failed++; }
  }));
  if (!out.length) throw new Error(failed ? 'map tiles unreachable' : 'no airfield in the map tiles');
  return out;
}
