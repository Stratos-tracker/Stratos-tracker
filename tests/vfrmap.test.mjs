import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { vfrStyle, ifrStyle, styleFor, VFR_ATTRIBUTION } from '../app/js/lib/vfrstyle.js';

const page = fs.readFileSync(new URL('../app/index.html', import.meta.url), 'utf8');

test('the VFR style is a complete map: relief, towns, water, roads and names from free sources', () => {
  const style = vfrStyle();
  assert.equal(style.version, 8);
  assert.equal(style.sources.osm.url, 'https://tiles.openfreemap.org/planet', 'OpenStreetMap vector tiles, no key');
  assert.equal(style.sources.dem.encoding, 'terrarium', 'the same terrain tiles as the 3D views');
  const ids = style.layers.map(l => l.id);
  for (const id of ['land', 'relief-tint', 'relief-shade', 'towns', 'water', 'rivers', 'roads-major', 'borders-country', 'cities']) {
    assert.ok(ids.includes(id), id + ' is drawn');
  }
  assert.ok(ids.indexOf('relief-shade') < ids.indexOf('towns') && ids.indexOf('towns') < ids.indexOf('cities'), 'relief under the towns, names on top');
  for (const layer of style.layers) {
    if (layer.source) assert.ok(style.sources[layer.source], layer.id + ' names a real source');
  }
  const fonts = new Set(style.layers.flatMap(l => (l.layout && l.layout['text-font']) || []));
  for (const font of fonts) assert.match(font, /^Noto Sans (Regular|Bold|Italic)$/, 'a font OpenFreeMap serves');
  assert.match(VFR_ATTRIBUTION, /OpenStreetMap/);
});

test('the VFR display draws the vector map under the canvas, kept in step with it', () => {
  assert.ok(page.includes("vfr:{n:'VFR',m:18,vec:'vfr',"), 'VFR is the vector map now');
  assert.ok(page.includes('OpenFreeMap © OpenMapTiles · Data © OpenStreetMap contributors'), 'credited on the map');
  assert.ok(page.includes('<div id="vbase" hidden aria-hidden="true"></div><canvas id="map"'), 'under the canvas');
  assert.ok(page.includes('const vecBase=vecSync();if(vecBase)cx.clearRect(0,0,W,H);'), 'the canvas lets it show through');
  assert.ok(page.includes('zoom:Math.max(0,V.z-1)'), 'MapLibre zoom is one less (512 px tiles)');
  assert.ok(!page.includes("if(l=='vfr')return 'https://tiles.arcgis.com"), 'the FAA raster is no longer the VFR base');
  assert.ok(page.includes('data-l="faavfr">FAA Sectional</button>'), 'the FAA sectional stays as an overlay');
});

test('the IFR maps are quiet: no relief or roads, High barer than Low', () => {
  const low = ifrStyle('low').layers.map(l => l.id), high = ifrStyle('high').layers.map(l => l.id);
  for (const id of ['land', 'water', 'coast', 'borders-country', 'cities']) {
    assert.ok(low.includes(id) && high.includes(id), id + ' on both');
  }
  assert.ok(low.includes('towns') && low.includes('borders-state') && low.includes('towns-names'), 'Low keeps towns and state borders');
  assert.ok(!high.includes('towns') && !high.includes('borders-state'), 'High leaves them out');
  assert.ok(![...low, ...high].some(id => /relief|roads|rail/.test(id)), 'nothing competes with airways');
  assert.deepEqual(['vfr', 'ifrlo', 'ifrhi'].map(k => styleFor(k).name), ['Stratos VFR', 'Stratos IFR Low', 'Stratos IFR High']);
});

test('choosing an IFR display brings its airways, and one map swaps styles', () => {
  assert.ok(page.includes("const pre={lowifr:'ifrlo',highifr:'ifrhi'}[k];"), 'IFR presets turn on their airway layer');
  assert.ok(page.includes('VB.setStyle(window.VFRSTYLE.styleFor(kind))'), 'one MapLibre map is reused across displays');
  assert.ok(page.includes("if(!CH.on&&V.mode!=='globe'&&MS[L.style]&&MS[L.style].vec)return true;"), 'labels treat the vector displays as light maps');
});
