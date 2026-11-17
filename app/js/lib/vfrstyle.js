/* The Stratos VFR map: a worldwide vector base map styled for visual flying.
 *
 * Elevation tints from green lowland to tan high ground and white peaks, relief
 * shading, towns as yellow patches, rivers and lakes, roads and railways,
 * borders and place names. Map data: OpenStreetMap through OpenFreeMap (free,
 * no key, OpenMapTiles schema). Terrain: AWS Open Data Terrain Tiles (Mapzen),
 * the same elevation tiles the 3D views use. The style follows the Mapbox
 * style specification and is rendered by the bundled MapLibre.
 */

export const VFR_ATTRIBUTION = 'OpenFreeMap © OpenMapTiles · Data © OpenStreetMap contributors · Terrain: AWS Terrain Tiles (Mapzen)';

const TOWN = '#f6dc45';
const INK = '#20303c';
const HALO = 'rgba(255,255,255,.9)';
const zoom = (...stops) => ['interpolate', ['linear'], ['zoom'], ...stops];

export function vfrStyle() {
  return {
    version: 8,
    name: 'Stratos VFR',
    glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
    sources: {
      osm: { type: 'vector', url: 'https://tiles.openfreemap.org/planet' },
      dem: {
        type: 'raster-dem',
        tiles: ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'],
        encoding: 'terrarium',
        tileSize: 256,
        maxzoom: 14,
      },
    },
    layers: [
      { id: 'land', type: 'background', paint: { 'background-color': '#c9dcb1' } },
      // Elevation tints, metres: lowland green through tan to white peaks.
      {
        id: 'relief-tint', type: 'color-relief', source: 'dem',
        paint: {
          'color-relief-opacity': 0.9,
          'color-relief-color': ['interpolate', ['linear'], ['elevation'],
            0, '#c9dcb1', 300, '#d7e0ae', 800, '#e4dba9', 1500, '#dcc79d', 2400, '#cfb79b', 3400, '#e8e2da', 4500, '#ffffff'],
        },
      },
      {
        id: 'relief-shade', type: 'hillshade', source: 'dem',
        paint: {
          'hillshade-exaggeration': 0.55,
          'hillshade-shadow-color': '#4a3d2c',
          'hillshade-highlight-color': 'rgba(255,255,255,.5)',
          'hillshade-accent-color': '#5c4b37',
        },
      },
      { id: 'wood', type: 'fill', source: 'osm', 'source-layer': 'landcover', filter: ['==', ['get', 'class'], 'wood'], paint: { 'fill-color': '#93bd7c', 'fill-opacity': 0.4 } },
      { id: 'ice', type: 'fill', source: 'osm', 'source-layer': 'landcover', filter: ['==', ['get', 'class'], 'ice'], paint: { 'fill-color': '#f3f7fa', 'fill-opacity': 0.9 } },
      // Built-up areas as yellow patches, the way VFR charts show towns.
      {
        id: 'towns', type: 'fill', source: 'osm', 'source-layer': 'landuse', minzoom: 6,
        filter: ['match', ['get', 'class'], ['residential', 'commercial', 'industrial', 'retail'], true, false],
        paint: { 'fill-color': TOWN, 'fill-opacity': zoom(6, 0.75, 12, 0.6), 'fill-outline-color': '#c7a400' },
      },
      { id: 'water', type: 'fill', source: 'osm', 'source-layer': 'water', paint: { 'fill-color': '#a7cfe6' } },
      { id: 'water-edge', type: 'line', source: 'osm', 'source-layer': 'water', minzoom: 7, paint: { 'line-color': '#5f9cc4', 'line-width': 0.7 } },
      {
        id: 'rivers', type: 'line', source: 'osm', 'source-layer': 'waterway',
        filter: ['==', ['get', 'class'], 'river'],
        paint: { 'line-color': '#5f9fcf', 'line-width': zoom(6, 0.6, 12, 2.2) },
      },
      { id: 'streams', type: 'line', source: 'osm', 'source-layer': 'waterway', minzoom: 11, filter: ['==', ['get', 'class'], 'stream'], paint: { 'line-color': '#7db3da', 'line-width': 0.7 } },
      {
        id: 'borders-state', type: 'line', source: 'osm', 'source-layer': 'boundary', minzoom: 5,
        filter: ['all', ['==', ['get', 'admin_level'], 4], ['!=', ['get', 'maritime'], 1]],
        paint: { 'line-color': '#9d8bb3', 'line-width': 0.8, 'line-dasharray': [3, 3] },
      },
      {
        id: 'borders-country', type: 'line', source: 'osm', 'source-layer': 'boundary',
        filter: ['all', ['==', ['get', 'admin_level'], 2], ['!=', ['get', 'maritime'], 1]],
        paint: { 'line-color': '#7d5f9c', 'line-width': zoom(3, 1, 10, 2), 'line-dasharray': [6, 3] },
      },
      { id: 'rail', type: 'line', source: 'osm', 'source-layer': 'transportation', minzoom: 9, filter: ['==', ['get', 'class'], 'rail'], paint: { 'line-color': '#6f6862', 'line-width': 0.9, 'line-dasharray': [4, 3] } },
      { id: 'roads-minor', type: 'line', source: 'osm', 'source-layer': 'transportation', minzoom: 10, filter: ['match', ['get', 'class'], ['secondary', 'tertiary'], true, false], paint: { 'line-color': '#c9a960', 'line-width': zoom(10, 0.6, 14, 1.6) } },
      { id: 'roads-primary', type: 'line', source: 'osm', 'source-layer': 'transportation', minzoom: 8, filter: ['==', ['get', 'class'], 'primary'], paint: { 'line-color': '#d9a845', 'line-width': zoom(8, 0.7, 14, 2.2) } },
      { id: 'roads-major', type: 'line', source: 'osm', 'source-layer': 'transportation', minzoom: 5, filter: ['match', ['get', 'class'], ['motorway', 'trunk'], true, false], paint: { 'line-color': '#d9832b', 'line-width': zoom(5, 0.8, 14, 3) } },
      {
        id: 'water-names', type: 'symbol', source: 'osm', 'source-layer': 'water_name', minzoom: 5,
        layout: { 'text-field': ['get', 'name'], 'text-font': ['Noto Sans Italic'], 'text-size': 11 },
        paint: { 'text-color': '#3a79a8', 'text-halo-color': HALO, 'text-halo-width': 1.2 },
      },
      {
        id: 'villages', type: 'symbol', source: 'osm', 'source-layer': 'place', minzoom: 10,
        filter: ['match', ['get', 'class'], ['village', 'hamlet'], true, false],
        layout: { 'text-field': ['get', 'name'], 'text-font': ['Noto Sans Regular'], 'text-size': 10.5 },
        paint: { 'text-color': INK, 'text-halo-color': HALO, 'text-halo-width': 1.2 },
      },
      {
        id: 'towns-names', type: 'symbol', source: 'osm', 'source-layer': 'place', minzoom: 7,
        filter: ['==', ['get', 'class'], 'town'],
        layout: { 'text-field': ['get', 'name'], 'text-font': ['Noto Sans Regular'], 'text-size': 11.5 },
        paint: { 'text-color': INK, 'text-halo-color': HALO, 'text-halo-width': 1.4 },
      },
      {
        id: 'cities', type: 'symbol', source: 'osm', 'source-layer': 'place', minzoom: 4,
        filter: ['==', ['get', 'class'], 'city'],
        layout: { 'text-field': ['get', 'name'], 'text-font': ['Noto Sans Bold'], 'text-size': zoom(4, 11, 10, 14) },
        paint: { 'text-color': INK, 'text-halo-color': HALO, 'text-halo-width': 1.6 },
      },
    ],
  };
}

/* The IFR maps: a quiet base for en-route work, as IFR charts are drawn. Pale
 * land, soft blue water, thin coastlines and borders and the main place names
 * only, so airways, fixes and airspace on top are what stands out. Low shows
 * towns and state borders; High, for the cruise, leaves them out. */
export function ifrStyle(level = 'low') {
  const low = level !== 'high';
  const label = { 'text-color': '#6b7785', 'text-halo-color': 'rgba(255,255,255,.85)', 'text-halo-width': 1.2 };
  const layers = [
    { id: 'land', type: 'background', paint: { 'background-color': low ? '#f3f3ef' : '#eef1f4' } },
    { id: 'water', type: 'fill', source: 'osm', 'source-layer': 'water', paint: { 'fill-color': '#d3e7f2' } },
    { id: 'coast', type: 'line', source: 'osm', 'source-layer': 'water', paint: { 'line-color': '#8fb4ca', 'line-width': zoom(3, 0.4, 10, 1) } },
    {
      id: 'borders-country', type: 'line', source: 'osm', 'source-layer': 'boundary',
      filter: ['all', ['==', ['get', 'admin_level'], 2], ['!=', ['get', 'maritime'], 1]],
      paint: { 'line-color': '#a3adb8', 'line-width': zoom(3, 0.6, 10, 1.2) },
    },
    { id: 'cities', type: 'symbol', source: 'osm', 'source-layer': 'place', minzoom: 4, filter: ['==', ['get', 'class'], 'city'], layout: { 'text-field': ['get', 'name'], 'text-font': ['Noto Sans Regular'], 'text-size': zoom(4, 10, 10, 12.5) }, paint: label },
  ];
  if (low) {
    layers.splice(1, 0, {
      id: 'towns', type: 'fill', source: 'osm', 'source-layer': 'landuse', minzoom: 7,
      filter: ['match', ['get', 'class'], ['residential', 'commercial', 'industrial', 'retail'], true, false],
      paint: { 'fill-color': '#e6e1d0', 'fill-opacity': 0.8 },
    });
    layers.splice(4, 0, {
      id: 'borders-state', type: 'line', source: 'osm', 'source-layer': 'boundary', minzoom: 5,
      filter: ['all', ['==', ['get', 'admin_level'], 4], ['!=', ['get', 'maritime'], 1]],
      paint: { 'line-color': '#c3c9d0', 'line-width': 0.7, 'line-dasharray': [3, 3] },
    });
    layers.push({ id: 'towns-names', type: 'symbol', source: 'osm', 'source-layer': 'place', minzoom: 8, filter: ['==', ['get', 'class'], 'town'], layout: { 'text-field': ['get', 'name'], 'text-font': ['Noto Sans Regular'], 'text-size': 10.5 }, paint: label });
  }
  return { version: 8, name: low ? 'Stratos IFR Low' : 'Stratos IFR High', glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf', sources: { osm: { type: 'vector', url: 'https://tiles.openfreemap.org/planet' } }, layers };
}

/** The style for a vector map display: 'vfr', 'ifrlo' or 'ifrhi'. */
export function styleFor(kind) {
  return kind === 'ifrlo' ? ifrStyle('low') : kind === 'ifrhi' ? ifrStyle('high') : vfrStyle();
}
