import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeAeroways, tilesAround } from '../app/js/lib/aerotiles.js';

// A minimal Mapbox Vector Tile, encoded by hand: one "aeroway" layer holding
// taxiway A (a line) and a runway polygon, which the decoder must skip.
const varint = n => { const out = []; do { let b = n & 127; n = Math.floor(n / 128); if (n) b |= 128; out.push(b); } while (n); return out; };
const key = (field, wire) => varint(field * 8 + wire);
const bytes = (field, body) => [...key(field, 2), ...varint(body.length), ...body];
const text = s => [...new TextEncoder().encode(s)];
const zig = n => (n << 1) ^ (n >> 31);
const packed = (field, nums) => bytes(field, nums.flatMap(varint));
const feature = (tags, type, geom) => [...packed(2, tags), ...key(3, 0), ...varint(type), ...packed(4, geom)];

const layer = [
  ...key(15, 0), ...varint(2),
  ...bytes(1, text('aeroway')),
  // taxiway A: MoveTo(1024, 1024) LineTo(+1024, 0)
  ...bytes(2, feature([0, 0, 1, 1], 2, [9, zig(1024), zig(1024), 10, zig(1024), zig(0)])),
  // runway polygon (type 3): not a centre line, so not drawn
  ...bytes(2, feature([0, 2], 3, [9, zig(0), zig(0), 18, zig(10), zig(0), zig(0), zig(10), 15])),
  ...bytes(3, text('class')), ...bytes(3, text('ref')),
  ...bytes(4, bytes(1, text('taxiway'))), ...bytes(4, bytes(1, text('A'))), ...bytes(4, bytes(1, text('runway'))),
  ...key(5, 0), ...varint(4096),
];
const tile = new Uint8Array(bytes(3, layer));

test('aeroway tiles decode to the bridge /osm shape', () => {
  const [x, y] = [2621, 6333]; // zoom 14 tile over San Francisco
  const ways = decodeAeroways(tile.buffer, 14, x, y);
  assert.equal(ways.length, 1, 'the runway polygon is skipped, the taxiway kept');
  const [cls, ref, points] = ways[0];
  assert.equal(cls, 'taxiway');
  assert.equal(ref, 'A');
  assert.equal(points.length, 2);
  for (const [lat, lon] of points) {
    assert.ok(lat > 37 && lat < 38.2 && lon > -122.5 && lon < -122.3, `point ${lat},${lon} lies inside the tile`);
  }
  assert.ok(points[1][1] > points[0][1], 'the line runs east');
  assert.equal(points[0][0], points[1][0], 'a horizontal tile line keeps one latitude');
});

// 2622/6341 is KSFO by the standard slippy-map formula (the log(tan + sec) form), worked independently of the module.
test('tiles around an airfield cover it at zoom 14', () => {
  const tiles = tilesAround(37.6189, -122.375);
  assert.ok(tiles.length >= 9 && tiles.length <= 36, `${tiles.length} tiles`);
  assert.ok(tiles.some(([x, y]) => x === 2622 && y === 6341), 'the tile under KSFO is included');
});
