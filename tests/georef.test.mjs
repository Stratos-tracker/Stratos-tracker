import test from 'node:test';
import assert from 'node:assert/strict';
import {
  readGeoref, placementFromGeoref, placementAffine, maskInsets,
} from '../app/js/lib/georef.js';

const DEG = Math.PI / 180;
/* A plain Mercator world, in pixels at zoom 0, so the tests do not depend on
   the map's own projection code. */
const project = (lon, lat) => [
  (lon + 180) / 360 * 256,
  (1 - Math.log(Math.tan(Math.PI / 4 + lat * DEG / 2)) / Math.PI) / 2 * 256,
];

/* The structure from Navigraph's charts documentation: NZWN ARRIVALS, a
   bottom-left pixel origin, and three non-geographic insets. */
const NZWN = {
  is_georeferenced: true,
  width: 1508,
  height: 2500,
  bounding_boxes: {
    planview: {
      pixels: { x1: 56, y1: 2442, x2: 1450, y2: 69 },
      latlng: { lng1: 174.577667, lat1: -41.863, lng2: 175.658472, lat2: -40.473222 },
    },
    insets: [
      { pixels: { x1: 90, y1: 2413, x2: 1446, y2: 2218 } },
      { pixels: { x1: 91, y1: 2218, x2: 945, y2: 2072 } },
      { pixels: { x1: 89, y1: 708, x2: 1451, y2: 68 } },
    ],
  },
};

const near = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol;

test('a published plan view places the sheet from its corners', () => {
  const placement = placementFromGeoref(NZWN, { width: 1508, height: 2500 }, project);
  assert.equal(placement.ok, true, placement.reason);
  assert.equal(placement.confidence, 'published');
  /* (x1, y1) is published with (lng1, lat1); y is stated from the bottom. */
  const topLeft = placement.at(56, 2500 - 2442);
  const want1 = project(174.577667, -41.863);
  assert.ok(near(topLeft[0], want1[0], 1e-9) && near(topLeft[1], want1[1], 1e-9), 'top-left corner lands on its own coordinates');
  const bottomRight = placement.at(1450, 2500 - 69);
  const want2 = project(175.658472, -40.473222);
  assert.ok(near(bottomRight[0], want2[0], 1e-9) && near(bottomRight[1], want2[1], 1e-9), 'opposite corner lands on its own coordinates');
});

test('the map area is interpolated, not assumed to be the whole image', () => {
  const placement = placementFromGeoref(NZWN, { width: 1508, height: 2500 }, project);
  const centre = placement.at((56 + 1450) / 2, 2500 - (2442 + 69) / 2);
  /* The box is interpolated in the map's projection, so its centre is the
     midpoint of the projected corners — not the projection of the mean
     latitude, which the projection does not preserve. */
  const c1 = project(174.577667, -41.863), c2 = project(175.658472, -40.473222);
  assert.ok(Math.abs(centre[0] - (c1[0] + c2[0]) / 2) < 1e-9, 'centre longitude');
  assert.ok(Math.abs(centre[1] - (c1[1] + c2[1]) / 2) < 1e-9, 'centre latitude lies between the projected corners');
  /* And the sheet's own corner is not the plan view's corner: the margins
     around the map area are carried by the image, not by the placement. */
  const edge = placement.at(0, 0);
  assert.ok(Math.abs(edge[0] - c1[0]) > 1e-6, 'the image corner is offset from the plan-view corner');
});

test('a rendered size different from the chart size still places correctly', () => {
  const placement = placementFromGeoref(NZWN, { width: 754, height: 1250 }, project);
  assert.equal(placement.ok, true, placement.reason);
  const corner = placement.at(28, (1250 - 2442) / 2 + 0);
  const want = project(174.577667, -41.863);
  assert.ok(Math.abs(corner[0] - want[0]) < 1e-9, 'half-scale corner keeps its longitude');
  /* Half-scale canvas: the same chart point is at half the pixel offset. */
  const full = placementFromGeoref(NZWN, { width: 1508, height: 2500 }, project);
  const a = placement.at(700, 900);
  const b = full.at(1400, 1800);
  assert.ok(Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9, 'the rendered size is accounted for');
});

test('reversed boxes are honoured rather than sorted into a guess', () => {
  const reversed = {
    is_georeferenced: true,
    width: NZWN.width,
    height: NZWN.height,
    bounding_boxes: {
      planview: {
        pixels: { x1: 1450, y1: 69, x2: 56, y2: 2442 },
        latlng: { lng1: 175.658472, lat1: -40.473222, lng2: 174.577667, lat2: -41.863 },
      },
      insets: [],
    },
  };
  const placement = placementFromGeoref(reversed, { width: 1508, height: 2500 }, project);
  assert.equal(placement.ok, true, placement.reason);
  const corner = placement.at(1450, 2500 - 69);
  const want = project(175.658472, -40.473222);
  assert.ok(Math.abs(corner[0] - want[0]) < 1e-9 && Math.abs(corner[1] - want[1]) < 1e-9, 'reversed corners keep their meaning');
});

test('insets become cutouts in canvas coordinates, clipped to the sheet', () => {
  const read = readGeoref(NZWN, { width: 1508, height: 2500 });
  assert.equal(read.ok, true, read.reason);
  assert.equal(read.insets.length, 3);
  const [first] = read.insets;
  assert.equal(first.x, 90);
  /* y1 2413 is near the top in a bottom-left frame, so the cutout is near the
     top of a top-left canvas: 2500 - 2413 = 87. */
  assert.equal(first.y, 87);
  assert.equal(first.w, 1446 - 90);
  assert.equal(first.h, 2413 - 2218);
  for (const r of read.insets) {
    assert.ok(r.x >= 0 && r.y >= 0 && r.w > 0 && r.h > 0);
    assert.ok(r.x + r.w <= 1508 + 1 && r.y + r.h <= 2500 + 1);
  }
});

test('masking insets clears them and leaves the rest of the chart', () => {
  const read = readGeoref(NZWN, { width: 1508, height: 2500 });
  const drawn = [];
  const source = { width: 1508, height: 2500 };
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => ({ drawImage() {}, fillRect(...r) { drawn.push(r); }, set globalCompositeOperation(v) {}, set fillStyle(v) {} }),
  };
  const makeCanvas = (w, h) => { canvas.width = w; canvas.height = h; return canvas; };
  const out = maskInsets(source, read.insets, makeCanvas);
  assert.notEqual(out, source, 'a copy is made when there is something to cut');
  assert.equal(drawn.length, 3);
  assert.deepEqual(maskInsets(source, [], makeCanvas), source, 'nothing to cut leaves the source alone');
});

test('a chart that is not marked georeferenced is refused, not guessed', () => {
  assert.equal(readGeoref({ is_georeferenced: false }).ok, false);
  assert.equal(readGeoref(null).ok, false);
  assert.equal(readGeoref({ is_georeferenced: true }).ok, false);
  assert.equal(readGeoref({ is_georeferenced: true, bounding_boxes: { planview: { pixels: { x1: 0 } } } }).ok, false);
});

test('a plan view outside the image, or covering no ground, is refused', () => {
  const outside = structuredClone(NZWN);
  outside.bounding_boxes.planview.pixels = { x1: 56, y1: 2442, x2: 5000, y2: 69 };
  assert.equal(readGeoref(outside, { width: 1508, height: 2500 }).ok, false);

  const empty = structuredClone(NZWN);
  empty.bounding_boxes.planview.latlng = { lng1: 174.5, lat1: -41.8, lng2: 174.5, lat2: -41.8 };
  assert.equal(readGeoref(empty, { width: 1508, height: 2500 }).ok, false);

  const tiny = structuredClone(NZWN);
  tiny.bounding_boxes.planview.pixels = { x1: 100, y1: 100, x2: 104, y2: 96 };
  assert.equal(readGeoref(tiny, { width: 1508, height: 2500 }).ok, false);
});

test('a box drawn at two different scales is refused', () => {
  const stretched = structuredClone(NZWN);
  /* Latitude span squeezed to a quarter: the same pixels would be twice as
     wide as they are tall on the ground. */
  stretched.bounding_boxes.planview.latlng = { lng1: 174.577667, lat1: -41.863, lng2: 175.658472, lat2: -41.5 };
  const placement = placementFromGeoref(stretched, { width: 1508, height: 2500 }, project);
  assert.equal(placement.ok, false);
  assert.match(placement.reason, /one scale/);
});

test('the affine follows the map, so zoom and pan cannot move the chart off the ground', () => {
  const placement = placementFromGeoref(NZWN, { width: 1508, height: 2500 }, project);
  /* A camera at zoom 8, panned so the world origin sits at (100, -50). */
  const zoom = 8;
  const toScreen = (wx, wy) => [wx * zoom + 100, wy * zoom - 50];
  const affine = placementAffine(placement, { width: 1508, height: 2500 }, toScreen);
  assert.ok(affine && affine.w === 1508 && affine.h === 2500);
  /* Every chart pixel lands where the camera puts its ground position, so the
     sheet cannot drift as the map is zoomed or panned. */
  for (const [px, py] of [[0, 0], [700, 900], [1400, 2500]]) {
    const ground = placement.at(px, py);
    const want = toScreen(ground[0], ground[1]);
    const got = [affine.e + affine.a * px + affine.c * py, affine.f + affine.b * px + affine.d * py];
    assert.ok(Math.abs(got[0] - want[0]) < 1e-6 && Math.abs(got[1] - want[1]) < 1e-6, 'chart pixel sits on its ground position');
  }
});
