import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// A plain browser script: run it the way the page does and read what it puts on window.
const sandbox = { window: {}, Math, Float32Array, Float64Array, Uint32Array, Uint16Array, Uint8Array, DataView, TextDecoder, JSON, Infinity, Number, Error, Object };
vm.runInNewContext(fs.readFileSync(new URL('../app/js/lib/plane3d.js', import.meta.url), 'utf8'), sandbox);
const P3 = sandbox.window.StratosPlane3D;
const globe = fs.readFileSync(new URL('../app/js/lib/globe3d.js', import.meta.url), 'utf8');
const page = fs.readFileSync(new URL('../app/index.html', import.meta.url), 'utf8');

test('each aircraft family has a whole model at its own proportions', () => {
  for (const kind of ['narrow', 'wide', 'quad', 'regional', 'turboprop', 'bizjet', 'ga']) {
    const mesh = P3.buildMesh(kind);
    assert.equal(mesh.kind, kind);
    assert.ok(mesh.count > 300 && mesh.count % 3 === 0, kind + ': whole triangles');
    let minY = Infinity, maxY = -Infinity, maxX = 0, bad = 0;
    for (let i = 0; i < mesh.position.length; i += 3) {
      minY = Math.min(minY, mesh.position[i + 1]); maxY = Math.max(maxY, mesh.position[i + 1]);
      maxX = Math.max(maxX, Math.abs(mesh.position[i]));
      if (!Number.isFinite(mesh.normal[i])) bad += 1;
    }
    assert.equal(bad, 0, kind + ': every normal is a number');
    assert.ok(Math.abs(maxY - minY - 1) < 0.08, kind + ': about one length nose to tail');
    assert.ok(maxX * 2 > 0.6 && maxX * 2 < 1.4, kind + ': a believable span for its length');
    assert.ok([...new Set(mesh.part)].length >= 4, kind + ': fuselage, belly, wings, tail and engines');
  }
  assert.ok(P3.buildMesh('quad').len > P3.buildMesh('narrow').len, 'a jumbo is longer than a narrowbody');
});

test('types and callsigns pick the shape and the colours', () => {
  for (const [type, kind] of [['A320', 'narrow'], ['B738', 'narrow'], ['B77W', 'wide'], ['A359', 'wide'], ['B748', 'quad'], ['A388', 'quad'],
    ['CRJ9', 'regional'], ['E190', 'regional'], ['AT76', 'turboprop'], ['DH8D', 'turboprop'], ['C68A', 'bizjet'], ['GLF6', 'bizjet'],
    ['E55P', 'bizjet'], ['C172', 'ga'], ['SR22', 'ga'], ['Boeing 747-8F', 'quad'], ['Cessna 172 Skyhawk', 'ga'], ['', 'narrow']]) {
    assert.equal(P3.kindOf(type), kind, type);
  }
  assert.equal(P3.schemeFor('UAE449')[2], '#d71921', 'Emirates red tail');
  assert.equal(P3.schemeFor('dlh4ab')[2], '#05164d', 'Lufthansa blue tail');
  assert.equal(P3.schemeFor('N172SP'), null, 'a registration is not an airline');
  assert.equal(P3.schemeFor('ZZZ1'), null);
});

test('models are true size up close and never vanish when zoomed out', () => {
  assert.equal(P3.modelLength(47, 18, 38), 38);
  assert.ok(P3.modelLength(47, 8, 38) > 5000, 'thousands of metres at zoom 8 so it stays visible');
  assert.ok(P3.modelLength(47, 8, 70) > P3.modelLength(47, 8, 8), 'a jumbo still looks bigger than a Cessna');
});

test('the 3D map draws aircraft models and offers a chase camera', () => {
  assert.match(page, /<script src="js\/lib\/plane3d\.js"><\/script>\s*<script src="js\/lib\/globe3d\.js">/);
  assert.match(globe, /window\.StratosPlane3D\.layer\(this\.map, 'planes3d'\)/);
  assert.match(globe, /elevation: Math\.max\(0, \(Number\(ac\.alt\) \|\| 0\) \* FT_TO_M\)/, 'the chase camera flies at the aircraft altitude');
  assert.match(globe, /centerClampedToGround: false/);
});

test('the downloaded models parse, face north and are credited', () => {
  const sources = fs.readFileSync(new URL('../SOURCES_AND_LICENSING.md', import.meta.url), 'utf8');
  for (const [kind, spec] of Object.entries(P3.MODELS)) {
    const file = fs.readFileSync(new URL('../app/' + spec.url, import.meta.url));
    const prims = P3.parseGlb(file.buffer.slice(file.byteOffset, file.byteOffset + file.length), spec);
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    let top = { y: 0, z: -Infinity };
    for (const p of prims) for (let i = 0; i < p.position.length; i += 3) {
      for (let k = 0; k < 3; k += 1) { lo[k] = Math.min(lo[k], p.position[i + k]); hi[k] = Math.max(hi[k], p.position[i + k]); }
      if (p.position[i + 2] > top.z) top = { y: p.position[i + 1], z: p.position[i + 2] };
    }
    assert.ok(Math.abs(hi[1] - lo[1] - 1) < 1e-6, kind + ': one length nose to tail');
    assert.ok(hi[0] - lo[0] > 0.65 && hi[0] - lo[0] < 1.05, kind + ': an airliner span across x');
    assert.ok(hi[2] - lo[2] < 0.4, kind + ': up is z, not the span');
    assert.ok(top.y < -0.3, kind + ': the fin tip is at the tail, so the nose points along +y');
    assert.ok(sources.includes(spec.url), kind + ': listed in SOURCES_AND_LICENSING.md');
    assert.ok(P3.CREDIT.includes(spec.credit), kind + ': credited on the map');
  }
  assert.throws(() => P3.parseGlb(new ArrayBuffer(24), P3.MODELS.narrow), /not a binary glTF/);
  assert.equal(P3.modelKey('A321', false), 'a321');
  assert.equal(P3.modelKey('A21N', true), 'a321');
  assert.equal(P3.modelKey('A320', true), 'a320hd', 'your own A320 gets the detailed model');
  assert.equal(P3.modelKey('FlyByWire A32NX', true), 'a320hd');
  assert.equal(P3.modelKey('A320', false), 'narrow', 'traffic A320s keep the light model');
  assert.equal(P3.modelKey('B77W', false), 'wide');
  assert.ok(P3.MODELS.a320hd.lazy, 'the 15 MB model only loads when flown');
});
