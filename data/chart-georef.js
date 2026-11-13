/* Chart georeferencing stated by the chart's own publisher.
 *
 * A chart can be placed on the map from metadata alone when its publisher gives
 * the pixel rectangle that corresponds to a geographic rectangle — the structure
 * documented for Navigraph charts:
 *
 *   {
 *     is_georeferenced: true,
 *     width, height,                       // the chart image the pixels refer to
 *     bounding_boxes: {
 *       planview: {
 *         pixels: { x1, y1, x2, y2 },       // origin bottom-left
 *         latlng: { lng1, lat1, lng2, lat2 },
 *       },
 *       insets: [ { pixels: { x1, y1, x2, y2 } } ],   // drawn to another scale
 *     },
 *   }
 *
 * None of the publishers integrated so far — FAA d-TPP, AIP Austria (CC BY
 * 4.0), AIP France (Licence Ouverte) — states chart calibration, and Stratos
 * will not invent it: a wrong rectangle is worse than a chart that says it
 * cannot be placed. So the table is empty and every chart resolves to null,
 * which is what the client is told. A source that does publish calibration is
 * an entry here, not a code change.
 *
 * Keys are `<source>|<icao>|<pdf or chart code>`.
 */

const TABLE = new Map();

/** Georeferencing for one chart, or null when its publisher states none. */
export function chartGeoref({ source, icao, pdf, code } = {}) {
  const keys = [
    [source, icao, pdf].join('|'),
    [source, icao, code].join('|'),
  ];
  for (const key of keys) {
    const meta = TABLE.get(key);
    if (meta) return meta;
  }
  return null;
}

/** How many charts currently carry published calibration. */
export function georefCount() {
  return TABLE.size;
}

/** A short, honest line for the catalogue when a chart is not georeferenced. */
export const GEOREF_NOTE = 'This publisher states no chart calibration, so the chart is placed from published '
  + 'runway or fix coordinates, or not at all.';
