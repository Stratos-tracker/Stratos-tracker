/* Universal chart georeferencing.
 *
 * A georeferenced chart carries a pixel rectangle whose corners correspond to a
 * geographic rectangle, so the whole sheet can be placed from metadata alone:
 * no fitting, no pilot nudging, and no assumption that the image is all map.
 *
 * The shape used here is the one Navigraph publishes per chart, because it is
 * the documented structure for this job:
 *
 *   is_georeferenced : true
 *   width, height    : size of the chart image the pixel box refers to
 *   bounding_boxes.planview.pixels : { x1, y1, x2, y2 }  origin bottom-left
 *   bounding_boxes.planview.latlng : { lng1, lat1, lng2, lat2 }
 *   bounding_boxes.insets[]        : { pixels: { x1, y1, x2, y2 } }  not to scale
 *
 * (x1, y1) is published with (lng1, lat1) and (x2, y2) with (lng2, lat2), so a
 * box whose corners arrive in the other order is honoured rather than sorted
 * into a guess. The image origin is bottom-left while a canvas origin is
 * top-left, and the pixel box is stated in the chart image's own size, which is
 * not necessarily the resolution Stratos rendered: both are converted here.
 *
 * The module only maps chart pixels to the map's world pixels. It does not know
 * about zoom, panning or rotation: those are applied by the caller's projection
 * callbacks, so the placement is fixed to the ground rather than to the screen.
 */

const CLIP_TOLERANCE = 1; // px of slack when checking a box against the image

function refuse(reason) {
  return { ok: false, reason };
}

/** Read and validate a chart's published georeferencing. */
export function readGeoref(meta, image = {}) {
  if (!meta || typeof meta !== 'object') return refuse('this chart has no georeferencing metadata');
  if (meta.is_georeferenced !== true && meta.georeferenced !== true) {
    return refuse('this chart is not marked as georeferenced');
  }
  const boxes = meta.bounding_boxes || meta.boundingBoxes || null;
  const plan = boxes && (boxes.planview || boxes.plan_view) || null;
  if (!plan || !plan.pixels || !plan.latlng) return refuse('the chart publishes no plan-view bounding box');

  const p = plan.pixels;
  const g = plan.latlng;
  const px = [p.x1, p.y1, p.x2, p.y2].map(Number);
  const ll = [g.lng1, g.lat1, g.lng2, g.lat2].map(Number);
  if (!px.every(Number.isFinite) || !ll.every(Number.isFinite)) {
    return refuse('the plan-view bounding box is not numeric');
  }

  const imageWidth = Number(image.width) || Number(meta.width) || 0;
  const imageHeight = Number(image.height) || Number(meta.height) || 0;
  if (!(imageWidth > 0 && imageHeight > 0)) return refuse('the chart image size is unknown');
  const metaWidth = Number(meta.width) || imageWidth;
  const metaHeight = Number(meta.height) || imageHeight;
  if (!(metaWidth > 0 && metaHeight > 0)) return refuse('the chart does not state its own size');

  /* The box is stated in the chart image's coordinates, in either corner order,
     but it must describe an area inside that image. */
  const left = Math.min(px[0], px[2]);
  const right = Math.max(px[0], px[2]);
  const bottom = Math.min(px[1], px[3]);
  const top = Math.max(px[1], px[3]);
  if (left < -CLIP_TOLERANCE || bottom < -CLIP_TOLERANCE
    || right > metaWidth + CLIP_TOLERANCE || top > metaHeight + CLIP_TOLERANCE) {
    return refuse('the plan view lies outside the chart image');
  }
  if (!(right - left >= 8 && top - bottom >= 8)) return refuse('the plan view is too small to place');
  if (Math.abs(ll[2] - ll[0]) <= 0 || Math.abs(ll[3] - ll[1]) <= 0) {
    return refuse('the plan view covers no ground');
  }

  const insets = Array.isArray(boxes.insets) ? boxes.insets : (Array.isArray(plan.insets) ? plan.insets : []);
  const scaleX = imageWidth / metaWidth;
  const scaleY = imageHeight / metaHeight;

  /* Insets are drawn to a different scale, so they are cut out of the overlay
     rather than allowed to sit on the map as if they were geography. */
  const cutouts = [];
  for (const inset of insets) {
    const ib = inset && (inset.pixels || inset);
    if (!ib) continue;
    const iv = [ib.x1, ib.y1, ib.x2, ib.y2].map(Number);
    if (!iv.every(Number.isFinite)) continue;
    const ix1 = Math.min(iv[0], iv[2]) * scaleX;
    const ix2 = Math.max(iv[0], iv[2]) * scaleX;
    const iyBottom = Math.min(iv[1], iv[3]);
    const iyTop = Math.max(iv[1], iv[3]);
    const y = (metaHeight - iyTop) * scaleY;
    const w = ix2 - ix1;
    const h = (iyTop - iyBottom) * scaleY;
    if (!(w > 1 && h > 1)) continue;
    cutouts.push({
      x: Math.max(0, ix1),
      y: Math.max(0, y),
      w: Math.min(imageWidth, ix2) - Math.max(0, ix1),
      h: Math.min(imageHeight, y + h) - Math.max(0, y),
    });
  }

  return {
    ok: true,
    pixels: { x1: px[0], y1: px[1], x2: px[2], y2: px[3] },
    latlng: { lng1: ll[0], lat1: ll[1], lng2: ll[2], lat2: ll[3] },
    metaWidth, metaHeight, imageWidth, imageHeight, scaleX, scaleY,
    insets: cutouts,
    raw: { pixels: px, latlng: ll },
  };
}

/**
 * Build the placement: chart pixels to world pixels, in the map's projection.
 * `project` converts lon/lat to the map's world pixel space at zoom 0.
 */
export function placementFromGeoref(meta, image, project) {
  const read = readGeoref(meta, image);
  if (!read.ok) return read;
  if (typeof project !== 'function') throw new Error('placementFromGeoref needs a projection function');

  const [x1, y1, x2, y2] = read.raw.pixels;
  const [lng1, lat1, lng2, lat2] = read.raw.latlng;
  const W1 = project(lng1, lat1);
  const W2 = project(lng2, lat2);
  if (!W1 || !W2 || !W1.every(Number.isFinite) || !W2.every(Number.isFinite)) {
    return refuse('the plan view cannot be projected onto the map');
  }

  /* Both axes must be drawn at one scale. A box that disagrees by a wide margin
     is not a plan view of the ground, however well-formed it looks. */
  const metresX = Math.abs(W2[0] - W1[0]) / Math.abs(x2 - x1);
  const metresY = Math.abs(W2[1] - W1[1]) / Math.abs(y2 - y1);
  const anisotropy = metresX > 0 && metresY > 0 ? metresX / metresY : Infinity;
  if (!(anisotropy > 0.5 && anisotropy < 2)) {
    return refuse('the plan view is not drawn at one scale in both directions');
  }

  const dx = (W2[0] - W1[0]) / (x2 - x1);
  const dy = (W2[1] - W1[1]) / (y2 - y1);

  return {
    ok: true,
    confidence: 'published',
    anisotropy,
    insets: read.insets,
    pixels: read.pixels,
    latlng: read.latlng,
    /* Chart pixel (canvas convention, top-left origin) to world pixel. */
    at(x, y) {
      const X = x / read.scaleX;
      const Ybottom = read.metaHeight - y / read.scaleY;
      return [W1[0] + (X - x1) * dx, W1[1] + (Ybottom - y1) * dy];
    },
    /* World pixel back to chart pixel, for hit-testing against the sheet. */
    from(wx, wy) {
      const X = x1 + (wx - W1[0]) / dx;
      const Ybottom = y1 + (wy - W1[1]) / dy;
      return [X * read.scaleX, (read.metaHeight - Ybottom) * read.scaleY];
    },
  };
}

/** Chart pixels to screen pixels, as the affine a canvas transform consumes. */
export function placementAffine(placement, image, toScreen) {
  if (!placement || !placement.ok) return null;
  const w = image.width;
  const h = image.height;
  const A = toScreen(...placement.at(0, 0));
  const B = toScreen(...placement.at(w, 0));
  const C = toScreen(...placement.at(0, h));
  if (!A || !B || !C) return null;
  return {
    a: (B[0] - A[0]) / w,
    b: (B[1] - A[1]) / w,
    c: (C[0] - A[0]) / h,
    d: (C[1] - A[1]) / h,
    e: A[0],
    f: A[1],
    w,
    h,
  };
}

/**
 * A copy of a chart with its non-geographic insets cleared, so only the plan
 * view is drawn on the map. Returns the source itself when there is nothing to
 * cut.
 */
export function maskInsets(source, insets, makeCanvas) {
  if (!insets || !insets.length) return source;
  const canvas = makeCanvas(source.width, source.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(source, 0, 0);
  ctx.globalCompositeOperation = 'destination-out';
  for (const r of insets) ctx.fillRect(r.x, r.y, r.w, r.h);
  ctx.globalCompositeOperation = 'source-over';
  return canvas;
}
