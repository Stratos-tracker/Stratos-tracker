/* 3D aircraft models for the 3D map (globe, flat and chase views).

   Low-poly models built here in code (no model files to license or
   download), one shape per family: narrowbody, widebody twin, four-engine,
   regional jet, turboprop, business jet and light aircraft. Each is painted in
   its airline's colours (no logos: colour schemes only) or white, and drawn by
   a MapLibre custom WebGL layer at its real position, altitude, heading and
   bank. Models are true to size up close and drawn larger when zoomed out so
   they stay visible. A thin line drops from each aircraft to the ground.

   Exposes window.StratosPlane3D = { layer, buildMesh, kindOf, schemeFor, modelLength }. */
(function () {
  'use strict';

  var RAD = Math.PI / 180;
  var FT = 0.3048;

  /* ── aircraft families ─────────────────────────────────────────────
     Sizes in metres. wingZ is in fuselage radii (negative = low wing).
     eng: 'wing' (pods under the wing at the given span fractions), 'rear'
     (pods on the rear fuselage), 'prop' (nacelles with propellers on the
     wing) or 'nose' (one propeller). */
  var KINDS = {
    narrow: { len: 38, r: 1.95, span: 35, chord: [6.5, 1.6], sweep: 25, wingAt: 0.03, wingZ: -0.55, eng: 'wing', at: [0.33], er: 1.0, el: 4.2, fin: [7.5, 5.5], stab: 13, tTail: false },
    wide: { len: 64, r: 3.0, span: 62, chord: [11, 2.6], sweep: 31, wingAt: 0.05, wingZ: -0.55, eng: 'wing', at: [0.32], er: 1.7, el: 6.5, fin: [10, 8.5], stab: 22, tTail: false },
    quad: { len: 70, r: 3.2, span: 66, chord: [12, 3], sweep: 37, wingAt: 0.02, wingZ: -0.55, eng: 'wing', at: [0.38, 0.66], er: 1.3, el: 5.5, fin: [12, 10], stab: 23, tTail: false },
    regional: { len: 30, r: 1.4, span: 25, chord: [4.5, 1.3], sweep: 24, wingAt: -0.02, wingZ: -0.6, eng: 'rear', at: [], er: 0.75, el: 4.2, fin: [5, 4.5], stab: 8.5, tTail: true },
    turboprop: { len: 25, r: 1.35, span: 27, chord: [2.6, 1.6], sweep: 3, wingAt: 0.06, wingZ: 0.85, eng: 'prop', at: [0.3], er: 0.6, el: 5, fin: [4.6, 4.5], stab: 8, tTail: true },
    bizjet: { len: 20, r: 1.0, span: 19, chord: [3.4, 1.0], sweep: 26, wingAt: -0.04, wingZ: -0.6, eng: 'rear', at: [], er: 0.55, el: 3.2, fin: [3.2, 3.6], stab: 7, tTail: true },
    ga: { len: 8.3, r: 0.6, span: 11, chord: [1.6, 1.4], sweep: 0, wingAt: 0.18, wingZ: 0.95, eng: 'nose', at: [], er: 0, el: 0, fin: [1.5, 1.4], stab: 3.4, tTail: false },
  };

  /** The family for an ICAO type code or a simulator's aircraft title. */
  function kindOf(type) {
    var t = String(type || '').toUpperCase();
    if (!t) return 'narrow';
    if (/B74|A38|A34[0-6]|74[78]|A380|A340|IL96|A124|AN12/.test(t)) return 'quad';
    if (/B77|B78|A33|A35|B76|A30|MD11|A310|77[0-9W]|78[789]|A330|A350|DC10|L101/.test(t)) return 'wide';
    if (/C25|C5[0-9]|C6[0-9]|C68|C7[0-9]|GLF|GL[0-9]|GLEX|CL3|CL6|FA[0-9]|F2TH|F900|LJ|E50P|E55P|PC24|H25|HDJT|PRM1|CITATION|GULF|FALCON|LEAR|CHALLENGER|PHENOM/.test(t)) return 'bizjet';
    if (/CRJ|E1[3-9][05]|E17|E19|E75|E29|EMB|ERJ|F70|F100|RJ[0-9]|B712|DC9|MD8|MD9|SU95|AJ27/.test(t)) return 'regional';
    if (/AT[4-7]|ATR|DH8|DASH|Q400|SF34|JS41|D328|SW4|B190|F50|C27J|C130/.test(t)) return 'turboprop';
    if (/^C1[0-9]{2}|^C2[0-9]{2}|^PA|^SR2|^DA[24]|^BE[0-9]|^TBM|^PC12|^M20|^P28|^P32|^DR40|^C17[0-9]|CESSNA|CIRRUS|PIPER|DIAMOND|BONANZA|KING AIR|TBM|PILATUS PC-12|DHC2|DHC6|ICON|^DV20/.test(t)) return 'ga';
    return 'narrow';
  }

  /* ── airline colour schemes ────────────────────────────────────────
     Colours only (no logos or tail art), keyed by the ICAO airline code at
     the start of the callsign: [upper fuselage, belly, tail, engines]. */
  var WHITE = '#f2f4f6';
  var SCHEMES = {
    UAE: [WHITE, WHITE, '#d71921', '#e9ebee'], // Emirates
    DLH: [WHITE, WHITE, '#05164d', '#05164d'], // Lufthansa
    BAW: [WHITE, '#1c2c5b', '#c8102e', '#1c2c5b'], // British Airways
    DAL: [WHITE, '#003268', '#c01933', '#003268'], // Delta
    UAL: [WHITE, '#0a3d91', '#0033a0', '#0a3d91'], // United
    AAL: ['#c9d0d7', '#b9c1c9', '#0078d2', '#c9d0d7'], // American
    RYR: [WHITE, '#073590', '#073590', '#073590'], // Ryanair
    QTR: [WHITE, '#d9dcdf', '#5c0632', '#d9dcdf'], // Qatar Airways
    AFR: [WHITE, WHITE, '#002157', WHITE], // Air France
    KLM: ['#00a1de', WHITE, '#00a1de', '#00a1de'], // KLM
    THY: [WHITE, WHITE, '#c8102e', '#d9dcdf'], // Turkish Airlines
    SIA: [WHITE, WHITE, '#1d2c6b', '#1d2c6b'], // Singapore Airlines
    EZY: [WHITE, WHITE, '#ff6600', '#ff6600'], // easyJet
    SWA: ['#304cb2', '#e21d38', '#304cb2', '#304cb2'], // Southwest
    ACA: [WHITE, '#111111', '#111111', '#111111'], // Air Canada
    ETD: ['#e6dccb', '#d8cbb3', '#b5945b', '#e6dccb'], // Etihad
    CPA: [WHITE, '#d9dcdf', '#006564', '#006564'], // Cathay Pacific
    QFA: [WHITE, WHITE, '#e40000', '#e9ebee'], // Qantas
    WZZ: [WHITE, WHITE, '#c6007e', '#2a2d7c'], // Wizz Air
    SWR: [WHITE, WHITE, '#e2001a', '#e9ebee'], // Swiss
    IBE: [WHITE, WHITE, '#d7192d', '#f6b300'], // Iberia
    JBU: [WHITE, '#003876', '#0033a0', '#003876'], // JetBlue
    ANA: [WHITE, WHITE, '#13448f', '#13448f'], // All Nippon
    JAL: [WHITE, WHITE, '#cc0000', WHITE], // Japan Airlines
  };

  /** [top, belly, tail, engines] for a callsign; white when the airline is not listed. */
  function schemeFor(callsign) {
    var code = String(callsign || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 3);
    return /^[A-Z]{3}$/.test(code) && SCHEMES[code] ? SCHEMES[code] : null;
  }

  /* ── the meshes ─────────────────────────────────────────────────────
     Frame: x = right wing, y = nose, z = up, in metres, then scaled to a
     length of 1. Parts: 0 upper fuselage, 1 belly, 2 wings, 3 tail, 4 engines. */
  var MESHES = {};
  function buildMesh(kind) {
    var k = KINDS[kind] ? kind : 'narrow';
    if (MESHES[k]) return MESHES[k];
    var K = KINDS[k];
    var pos = [];
    var part = [];
    function tri(a, b, c, p) { pos.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]); part.push(p, p, p); }
    function quad(a, b, c, d, p) { tri(a, b, c, p); tri(a, c, d, p); }
    function tube(rings, cx, cz, n, p, split) {
      // rings: [y, radius, zOffset]; a radius of 0 closes the end. `split`
      // paints the lower part of each ring as belly.
      for (var i = 0; i < rings.length - 1; i += 1) {
        for (var j = 0; j < n; j += 1) {
          var a0 = (j / n) * Math.PI * 2, a1 = ((j + 1) / n) * Math.PI * 2;
          var A = rings[i], B = rings[i + 1];
          var pp = split && Math.sin((a0 + a1) / 2) < -0.3 ? 1 : p;
          quad(
            [cx + Math.cos(a0) * A[1], A[0], cz + (A[2] || 0) + Math.sin(a0) * A[1]],
            [cx + Math.cos(a1) * A[1], A[0], cz + (A[2] || 0) + Math.sin(a1) * A[1]],
            [cx + Math.cos(a1) * B[1], B[0], cz + (B[2] || 0) + Math.sin(a1) * B[1]],
            [cx + Math.cos(a0) * B[1], B[0], cz + (B[2] || 0) + Math.sin(a0) * B[1]], pp);
        }
      }
    }
    function slab(r0, r1, t1, t0, t, p) {
      // A thin surface: root leading/trailing and tip trailing/leading corners.
      var up = function (v) { return [v[0], v[1], v[2] + t]; };
      var dn = function (v) { return [v[0], v[1], v[2] - t]; };
      quad(up(r0), up(r1), up(t1), up(t0), p);
      quad(dn(r0), dn(t0), dn(t1), dn(r1), p);
      quad(up(r0), up(t0), dn(t0), dn(r0), p);
      quad(up(r1), dn(r1), dn(t1), up(t1), p);
      quad(up(t0), up(t1), dn(t1), dn(t0), p);
    }
    function fin(r0, r1, t1, t0, t, p) {
      // A vertical surface (thickness along x).
      var l = function (v) { return [v[0] - t, v[1], v[2]]; };
      var rr = function (v) { return [v[0] + t, v[1], v[2]]; };
      quad(l(r0), l(r1), l(t1), l(t0), p);
      quad(rr(r0), rr(t0), rr(t1), rr(r1), p);
      quad(l(r0), l(t0), rr(t0), rr(r0), p);
      quad(l(t0), l(t1), rr(t1), rr(t0), p);
    }
    function disc(cx, cy, cz, rad, p) {
      // A propeller disc facing forward.
      for (var j = 0; j < 12; j += 1) {
        var a0 = (j / 12) * Math.PI * 2, a1 = ((j + 1) / 12) * Math.PI * 2;
        tri([cx, cy, cz], [cx + Math.cos(a0) * rad, cy, cz + Math.sin(a0) * rad], [cx + Math.cos(a1) * rad, cy, cz + Math.sin(a1) * rad], p);
      }
    }
    var L = K.len, R = K.r, H = L / 2;
    var nose = k === 'ga' ? 0.16 : 0.12;
    // Fuselage: a rounded nose, a constant section and a tail cone swept up.
    tube([
      [H, 0, -0.15 * R], [H - 0.02 * L, 0.45 * R, -0.12 * R], [H - 0.05 * L, 0.75 * R, -0.06 * R], [H - nose * L, R, 0],
      [-H + 0.3 * L, R, 0], [-H + 0.16 * L, 0.72 * R, 0.18 * R], [-H + 0.05 * L, 0.32 * R, 0.42 * R], [-H, 0.08 * R, 0.55 * R],
    ], 0, 0, 14, 0, true);

    // Wings.
    var s = K.span / 2, cr = K.chord[0], ct = K.chord[1];
    var rootLE = K.wingAt * L + cr / 2, back = Math.tan(K.sweep * RAD) * s;
    var wz = K.wingZ * R, dih = K.wingZ > 0 ? -0.01 * s : 0.06 * s, wt = Math.max(0.08, cr * 0.05);
    var leAt = function (x) { return rootLE - back * (x / s); };
    var chAt = function (x) { return cr + (ct - cr) * (x / s); };
    [1, -1].forEach(function (side) {
      var root0 = [side * R * 0.6, rootLE, wz], root1 = [side * R * 0.6, rootLE - cr, wz];
      var tip0 = [side * s, leAt(s), wz + dih], tip1 = [side * s, leAt(s) - ct, wz + dih];
      if (side > 0) slab(root0, root1, tip1, tip0, wt, 2);
      else slab(root0, tip0, tip1, root1, wt, 2);
    });

    // Engines.
    var ER = K.er, EL = K.el;
    if (K.eng === 'wing') {
      K.at.forEach(function (f) {
        [1, -1].forEach(function (side) {
          var x = side * f * s, y = leAt(f * s) + EL * 0.45, z = wz + dih * f - ER * 1.15;
          tube([[y, 0], [y - 0.04 * EL, ER * 0.95], [y - 0.7 * EL, ER], [y - EL, ER * 0.6], [y - EL * 1.08, 0]], x, z, 12, 4);
        });
      });
    } else if (K.eng === 'rear') {
      [1, -1].forEach(function (side) {
        var x = side * (R + ER * 1.2), y = -H + 0.27 * L, z = 0.35 * R;
        tube([[y, 0], [y - 0.04 * EL, ER * 0.95], [y - 0.75 * EL, ER], [y - EL, ER * 0.65], [y - EL * 1.06, 0]], x, z, 12, 4);
        slab([side * R * 0.7, y - EL * 0.3, z], [side * R * 0.7, y - EL * 0.7, z], [x, y - EL * 0.7, z], [x, y - EL * 0.3, z], 0.12, 3);
      });
    } else if (K.eng === 'prop') {
      K.at.forEach(function (f) {
        [1, -1].forEach(function (side) {
          var x = side * f * s, y = leAt(f * s) + EL * 0.35, z = wz - ER * 0.7;
          tube([[y, 0], [y - 0.08 * EL, ER * 0.85], [y - 0.6 * EL, ER], [y - EL, ER * 0.4], [y - EL * 1.05, 0]], x, z, 10, 4);
          disc(x, y + 0.05, z, s * 0.15, 4);
        });
      });
    } else if (K.eng === 'nose') {
      disc(0, H + 0.05, -0.1 * R, s * 0.17, 4);
    }

    // Tail: the fin, and the stabiliser on the fuselage or on top of the fin (T-tail).
    var finH = K.fin[0], finC = K.fin[1], finBack = finH * 0.75;
    var f0 = [0, -H + 0.04 * L + finC, 0.6 * R], f1 = [0, -H + 0.02 * L, 0.6 * R];
    var f2 = [0, f1[1] - finBack * 0.25, 0.6 * R + finH], f3 = [0, f0[1] - finBack, 0.6 * R + finH];
    fin(f0, f1, f2, f3, Math.max(0.08, finC * 0.04), 3);
    var hs = K.stab / 2, hc = finC * 0.7, hz = K.tTail ? 0.6 * R + finH : 0.35 * R, hy = K.tTail ? f3[1] - 0.1 : -H + 0.06 * L + hc;
    [1, -1].forEach(function (side) {
      var r0 = [side * 0.3, hy, hz], r1 = [side * 0.3, hy - hc, hz];
      var t0 = [side * hs, hy - hs * 0.55, hz + 0.04 * hs], t1 = [side * hs, hy - hs * 0.55 - hc * 0.45, hz + 0.04 * hs];
      if (side > 0) slab(r0, r1, t1, t0, 0.07, 3);
      else slab(r0, t0, t1, r1, 0.07, 3);
    });

    // To a length of one, with flat normals (one per triangle).
    for (var i = 0; i < pos.length; i += 1) pos[i] /= L;
    var nrm = new Float32Array(pos.length);
    for (var q = 0; q < pos.length; q += 9) {
      var ux = pos[q + 3] - pos[q], uy = pos[q + 4] - pos[q + 1], uz = pos[q + 5] - pos[q + 2];
      var vx = pos[q + 6] - pos[q], vy = pos[q + 7] - pos[q + 1], vz = pos[q + 8] - pos[q + 2];
      var nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      var nl = Math.hypot(nx, ny, nz) || 1;
      for (var w = 0; w < 3; w += 1) { nrm[q + w * 3] = nx / nl; nrm[q + w * 3 + 1] = ny / nl; nrm[q + w * 3 + 2] = nz / nl; }
    }
    MESHES[k] = { kind: k, len: L, position: new Float32Array(pos), normal: nrm, part: new Float32Array(part), count: pos.length / 3 };
    return MESHES[k];
  }

  /* ── small column-major mat4 helpers ─────────────────────────────── */
  function mul(a, b) {
    var o = new Float64Array(16);
    for (var c = 0; c < 4; c += 1) for (var r = 0; r < 4; r += 1) {
      o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    }
    return o;
  }
  function rotZ(t) { var c = Math.cos(t), s = Math.sin(t); return [c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]; }
  function rotX(t) { var c = Math.cos(t), s = Math.sin(t); return [1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1]; }
  function rotY(t) { var c = Math.cos(t), s = Math.sin(t); return [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1]; }
  function scale(k) { return [k, 0, 0, 0, 0, k, 0, 0, 0, 0, k, 0, 0, 0, 0, 1]; }
  /* MapLibre's model matrix is glTF-style (x east, y up, z south). This turns
     the mesh frame (x right, y nose, z up) into it, nose north at heading 0. */
  var BASIS = [1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1];

  /** Length to draw: true size up close; zoomed out, never under ~46 px for an
      airliner (smaller types keep their size relative to it). */
  function modelLength(lat, zoom, metres) {
    var m = metres || 38;
    var mpp = (40075016.686 * Math.cos(Math.max(-85, Math.min(85, lat)) * RAD)) / (512 * Math.pow(2, zoom));
    return Math.max(m, 46 * Math.sqrt(m / 38) * mpp);
  }

  function rgb(hex) {
    var m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
    if (!m) return [0.95, 0.96, 0.97];
    var n = parseInt(m[1], 16);
    return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255];
  }

  /* ── downloaded models ─────────────────────────────────────────────
     Realistic models (CC BY 4.0, credited on the map and in
     SOURCES_AND_LICENSING.md) for the families they fit; the others keep the
     shapes built above. `axes` turns the file's frame into ours: for our x
     (right wing), y (nose) and z (up), the file axis (0 x, 1 y, 2 z) and its
     sign. `len` is the real length in metres. */
  var MODELS = {
    narrow: { url: 'models/a320.glb', len: 37.6, axes: [[2, -1], [0, -1], [1, 1]], credit: '"Airbus A320 Airliner" by Kyaie' },
    wide: { url: 'models/b789.glb', len: 62.8, axes: [[0, -1], [2, 1], [1, 1]], credit: '"Boeing 787-9" by Nobilis 2' },
    a321: { url: 'models/a321.glb', len: 44.5, axes: [[0, -1], [2, 1], [1, 1]], credit: '"Airbus A321-232" by piggyrockstarYT' },
    // 474k triangles and 15 MB: drawn only for the pilot's own A320, and loaded only when one is flown.
    a320hd: { url: 'models/a320hd.glb', len: 37.6, axes: [[0, -1], [2, 1], [1, 1]], credit: '"Airbus A320-200 V2" by fDlruosne', lazy: true },
  };

  /** Which model draws a plane: the A321 for A321s, the detailed A320 for the
      pilot's own A320, otherwise the model (or built shape) of its family. */
  function modelKey(type, own) {
    var t = String(type || '').toUpperCase();
    if (/A321|A21N/.test(t)) return 'a321';
    if (own && /A320|A20N|A32NX/.test(t)) return 'a320hd';
    return kindOf(t);
  }
  var CREDIT = '3D aircraft: ' + Object.keys(MODELS).map(function (k) { return MODELS[k].credit; }).join(', ') + ' (CC BY 4.0, Sketchfab)';

  var NCOMP = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
  var GETTER = { 5120: 'getInt8', 5121: 'getUint8', 5122: 'getInt16', 5123: 'getUint16', 5125: 'getUint32', 5126: 'getFloat32' };
  var SIZE = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
  var NORM = { 5120: 127, 5121: 255, 5122: 32767, 5123: 65535 };

  function trs(n) {
    if (n.matrix) return n.matrix;
    var t = n.translation || [0, 0, 0], q = n.rotation || [0, 0, 0, 1], s = n.scale || [1, 1, 1];
    var x = q[0], y = q[1], z = q[2], w = q[3];
    return [
      (1 - 2 * (y * y + z * z)) * s[0], 2 * (x * y + z * w) * s[0], 2 * (x * z - y * w) * s[0], 0,
      2 * (x * y - z * w) * s[1], (1 - 2 * (x * x + z * z)) * s[1], 2 * (y * z + x * w) * s[1], 0,
      2 * (x * z + y * w) * s[2], 2 * (y * z - x * w) * s[2], (1 - 2 * (x * x + y * y)) * s[2], 0,
      t[0], t[1], t[2], 1,
    ];
  }

  /** A binary glTF as primitives in our frame, centred and one length long:
      [{position, normal, uv, index, color: [r,g,b,a], image: {mime, bytes, key} | null}]. */
  function parseGlb(buffer, spec) {
    var dv = new DataView(buffer);
    if (dv.byteLength < 20 || dv.getUint32(0, true) !== 0x46546C67) throw new Error('not a binary glTF');
    var json = null, bin = null, off = 12;
    while (off + 8 <= dv.byteLength) {
      var len = dv.getUint32(off, true), type = dv.getUint32(off + 4, true);
      if (type === 0x4E4F534A) json = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, off + 8, len)));
      else if (type === 0x004E4942) bin = { offset: off + 8, length: len };
      off += 8 + len;
    }
    if (!json || !bin) throw new Error('missing glTF chunks');
    if ((json.extensionsRequired || []).length) throw new Error('needs ' + json.extensionsRequired.join(', '));

    function read(index) {
      var a = json.accessors[index], view = json.bufferViews[a.bufferView];
      var n = NCOMP[a.type], size = SIZE[a.componentType], getter = GETTER[a.componentType];
      if (!n || !getter) throw new Error('unsupported accessor');
      var stride = view.byteStride || n * size, start = bin.offset + (view.byteOffset || 0) + (a.byteOffset || 0);
      var integer = a.componentType !== 5126 && !a.normalized;
      var out = integer ? (a.componentType === 5125 ? new Uint32Array(a.count * n) : new Uint16Array(a.count * n)) : new Float32Array(a.count * n);
      for (var i = 0; i < a.count; i += 1) {
        for (var c = 0; c < n; c += 1) {
          var v = dv[getter](start + i * stride + c * size, true);
          out[i * n + c] = a.normalized ? Math.max(-1, v / NORM[a.componentType]) : v;
        }
      }
      return out;
    }

    var prims = [];
    function walk(nodeIndex, parent) {
      var node = json.nodes[nodeIndex];
      var world = mul(parent, trs(node));
      if (node.mesh != null) {
        json.meshes[node.mesh].primitives.forEach(function (p) {
          if ((p.mode == null ? 4 : p.mode) !== 4 || p.attributes.POSITION == null) return;
          var pos = read(p.attributes.POSITION), nrm = p.attributes.NORMAL != null ? read(p.attributes.NORMAL) : null;
          var count = pos.length / 3, P = new Float32Array(count * 3), N = new Float32Array(count * 3);
          for (var i = 0; i < count; i += 1) {
            var x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
            var w = [world[0] * x + world[4] * y + world[8] * z + world[12], world[1] * x + world[5] * y + world[9] * z + world[13], world[2] * x + world[6] * y + world[10] * z + world[14]];
            var nx = nrm ? nrm[i * 3] : 0, ny = nrm ? nrm[i * 3 + 1] : 1, nz = nrm ? nrm[i * 3 + 2] : 0;
            // shortcut: normals use the node's 3x3 as is; fine while models carry no non-uniform scale.
            var wn = [world[0] * nx + world[4] * ny + world[8] * nz, world[1] * nx + world[5] * ny + world[9] * nz, world[2] * nx + world[6] * ny + world[10] * nz];
            for (var k = 0; k < 3; k += 1) {
              P[i * 3 + k] = w[spec.axes[k][0]] * spec.axes[k][1];
              N[i * 3 + k] = wn[spec.axes[k][0]] * spec.axes[k][1];
            }
          }
          var mat = p.material != null && json.materials ? json.materials[p.material] : {};
          var pbr = mat.pbrMetallicRoughness || {};
          var image = null;
          if (pbr.baseColorTexture && json.textures) {
            var img = json.images[json.textures[pbr.baseColorTexture.index].source];
            if (img && img.bufferView != null) {
              var bv = json.bufferViews[img.bufferView];
              image = { mime: img.mimeType || 'image/png', bytes: new Uint8Array(buffer, bin.offset + (bv.byteOffset || 0), bv.byteLength), key: json.textures[pbr.baseColorTexture.index].source };
            }
          }
          prims.push({
            position: P, normal: N,
            uv: p.attributes.TEXCOORD_0 != null ? read(p.attributes.TEXCOORD_0) : null,
            index: p.indices != null ? read(p.indices) : null,
            color: pbr.baseColorFactor || [1, 1, 1, 1],
            image: image,
          });
        });
      }
      (node.children || []).forEach(function (c) { walk(c, world); });
    }
    json.scenes[json.scene || 0].nodes.forEach(function (n) { walk(n, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]); });
    if (!prims.length) throw new Error('no triangles');

    // Centre the model and scale it to one length, nose to tail.
    var lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    prims.forEach(function (p) { for (var i = 0; i < p.position.length; i += 1) { var k = i % 3; lo[k] = Math.min(lo[k], p.position[i]); hi[k] = Math.max(hi[k], p.position[i]); } });
    var length = hi[1] - lo[1] || 1, mid = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
    prims.forEach(function (p) { for (var i = 0; i < p.position.length; i += 1) p.position[i] = (p.position[i] - mid[i % 3]) / length; });
    return prims;
  }

  function fetchBytes(url) {
    // XHR rather than fetch: the desktop app loads from file://, where fetch is refused.
    return new Promise(function (resolve, reject) {
      var x = new XMLHttpRequest();
      x.open('GET', url);
      x.responseType = 'arraybuffer';
      x.onload = function () { if ((x.status === 200 || x.status === 0) && x.response && x.response.byteLength) resolve(x.response); else reject(new Error('HTTP ' + x.status)); };
      x.onerror = function () { reject(new Error('unreachable')); };
      x.send();
    });
  }

  var VS = 'attribute vec3 a_pos; attribute vec3 a_nrm; attribute float a_part; attribute vec2 a_uv;'
    + 'uniform mat4 u_mvp; uniform mat4 u_rot; varying vec3 v_n; varying float v_part; varying vec2 v_uv;'
    + 'void main(){ v_n = (u_rot * vec4(a_nrm, 0.0)).xyz; v_part = a_part; v_uv = a_uv; gl_Position = u_mvp * vec4(a_pos, 1.0); }';
  var FS = 'precision mediump float; varying vec3 v_n; varying float v_part; varying vec2 v_uv;'
    + 'uniform vec3 u_top; uniform vec3 u_belly; uniform vec3 u_tail; uniform vec3 u_eng; uniform float u_mode; uniform float u_alpha;'
    + 'uniform vec4 u_color; uniform sampler2D u_tex; uniform float u_hasTex;'
    + 'void main(){'
    + ' if (u_mode > 1.5) { gl_FragColor = vec4(u_tail, u_alpha); return; }'
    + ' vec3 base;'
    + ' if (u_mode > 0.5) { base = u_color.rgb; if (u_hasTex > 0.5) base *= texture2D(u_tex, v_uv).rgb; }'
    + ' else base = v_part < 0.5 ? u_top : v_part < 1.5 ? u_belly : v_part < 2.5 ? vec3(0.78, 0.81, 0.84) : v_part < 3.5 ? u_tail : u_eng;'
    + ' vec3 n = normalize(v_n); float d = abs(dot(n, normalize(vec3(0.35, 0.45, 0.82))));'
    + ' gl_FragColor = vec4(base * (0.5 + 0.55 * d), 1.0); }';

  function compile(gl, type, src) {
    var sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    return sh;
  }

  /** The custom layer. setPlanes([{lon, lat, alt (ft), hdg, bank, pitch, type, callsign, highlight, own}]).
      `highlight` colours the drop line (and the tail of a code-built model):
      the pilot's own aircraft when its airline is unknown, or the selected
      traffic. Downloaded models keep their own paint. */
  function layer(map, id) {
    var planes = [], trail = [];
    var prog = null, loc = {}, gpu = {}, glb = {}, lineBuf = null, uint32 = false;
    function buffer(gl, target, data) { var b = gl.createBuffer(); gl.bindBuffer(target, b); gl.bufferData(target, data, gl.STATIC_DRAW); return b; }
    function upload(gl, kind) {
      if (gpu[kind]) return gpu[kind];
      var mesh = buildMesh(kind);
      gpu[kind] = { count: mesh.count, len: mesh.len, pos: buffer(gl, gl.ARRAY_BUFFER, mesh.position), nrm: buffer(gl, gl.ARRAY_BUFFER, mesh.normal), part: buffer(gl, gl.ARRAY_BUFFER, mesh.part) };
      return gpu[kind];
    }
    function texture(gl, cache, image, into) {
      var entry = cache[image.key];
      if (!entry) {
        entry = cache[image.key] = { tex: null, waiting: [] };
        createImageBitmap(new Blob([image.bytes], { type: image.mime })).then(function (bmp) {
          var t = gl.createTexture();
          gl.bindTexture(gl.TEXTURE_2D, t);
          gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bmp);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
          entry.tex = t;
          entry.waiting.forEach(function (w) { w.tex = t; });
          map.triggerRepaint();
        }).catch(function () {});
      }
      if (entry.tex) into.tex = entry.tex; else entry.waiting.push(into);
    }
    /** The downloaded model for a family once it is ready; null while it loads,
        when there is none, or when it failed (the code-built shape is drawn). */
    function model(gl, kind) {
      var spec = MODELS[kind];
      if (!spec) return null;
      if (glb[kind]) return glb[kind].ready ? glb[kind] : null;
      var entry = glb[kind] = { ready: false, prims: [], len: spec.len };
      fetchBytes(spec.url).then(function (bytes) {
        var cache = {};
        parseGlb(bytes, spec).forEach(function (p) {
          if (p.index instanceof Uint32Array && !uint32) return; // shortcut: 32-bit indices need WebGL2 or OES_element_index_uint.
          var g = {
            count: p.index ? p.index.length : p.position.length / 3,
            indexType: p.index instanceof Uint32Array ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT,
            pos: buffer(gl, gl.ARRAY_BUFFER, p.position), nrm: buffer(gl, gl.ARRAY_BUFFER, p.normal),
            uv: p.uv ? buffer(gl, gl.ARRAY_BUFFER, p.uv) : null,
            idx: p.index ? buffer(gl, gl.ELEMENT_ARRAY_BUFFER, p.index) : null,
            color: p.color, tex: null,
          };
          if (p.image && p.uv) texture(gl, cache, p.image, g);
          entry.prims.push(g);
        });
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null);
        entry.ready = entry.prims.length > 0;
        map.triggerRepaint();
      }).catch(function () { entry.failed = true; });
      return null;
    }
    /* The trail: each segment placed from its own start point (so the globe's
       curvature never lifts a long path off the surface), a line at the
       recorded altitude and a faint curtain down to sea level; the terrain
       hides the part of the curtain under the ground. */
    function drawTrail(gl, main, attrib) {
      gl.uniform1f(loc.u_mode, 2);
      attrib('a_nrm', null);
      attrib('a_part', null);
      attrib('a_uv', null);
      // The path ends where the selected model is drawn this frame, so the two always meet.
      var pts = trail, sel = planes.filter(function (q) { return q.selected; })[0];
      if (sel && Number.isFinite(sel.lat)) pts = trail.concat([{ lat: sel.lat, lon: sel.lon, alt: Number(sel.alt) || 0, rgb: trail[trail.length - 1].rgb }]);
      var step = Math.max(1, Math.ceil(pts.length / 400)), idx = [];
      for (var i = 0; i < pts.length; i += step) idx.push(i);
      if (idx[idx.length - 1] !== pts.length - 1) idx.push(pts.length - 1);
      for (var k = 1; k < idx.length; k += 1) {
        var a = pts[idx[k - 1]], b = pts[idx[k]];
        var dLon = ((b.lon - a.lon + 540) % 360) - 180;
        var e = dLon * Math.cos(a.lat * RAD) * 111320, n = (b.lat - a.lat) * 110574;
        var za = Math.max(0, a.alt * FT), zb = Math.max(0, b.alt * FT);
        var c = a.rgb && b.rgb ? [(a.rgb[0] + b.rgb[0]) / 510, (a.rgb[1] + b.rgb[1]) / 510, (a.rgb[2] + b.rgb[2]) / 510] : [0.65, 0.95, 0.99];
        gl.uniformMatrix4fv(loc.u_mvp, false, new Float32Array(mul(main, mul(map.transform.getMatrixForModel([a.lon, a.lat], 0), BASIS))));
        gl.uniform3fv(loc.u_tail, c);
        gl.bindBuffer(gl.ARRAY_BUFFER, lineBuf);
        gl.depthMask(false);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 0, e, n, 0, e, n, zb, 0, 0, 0, e, n, zb, 0, 0, za]), gl.DYNAMIC_DRAW);
        gl.uniform1f(loc.u_alpha, 0.2);
        attrib('a_pos', lineBuf, 3);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
        gl.depthMask(true);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, za, e, n, zb]), gl.DYNAMIC_DRAW);
        gl.uniform1f(loc.u_alpha, 0.95);
        attrib('a_pos', lineBuf, 3);
        gl.drawArrays(gl.LINES, 0, 2);
      }
    }
    return {
      id: id || 'planes3d',
      type: 'custom',
      renderingMode: '3d',
      setPlanes: function (list) { planes = Array.isArray(list) ? list : []; map.triggerRepaint(); },
      /** The selected flight's recorded path: [{lat, lon, alt (ft), rgb: [r,g,b] 0-255}]. */
      setTrail: function (list) {
        trail = (Array.isArray(list) ? list : []).filter(function (q) { return Number.isFinite(q.lat) && Number.isFinite(q.lon); });
        map.triggerRepaint();
      },
      onAdd: function (_map, gl) {
        prog = gl.createProgram();
        gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VS));
        gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FS));
        gl.linkProgram(prog);
        ['a_pos', 'a_nrm', 'a_part', 'a_uv'].forEach(function (n) { loc[n] = gl.getAttribLocation(prog, n); });
        ['u_mvp', 'u_rot', 'u_top', 'u_belly', 'u_tail', 'u_eng', 'u_mode', 'u_alpha', 'u_color', 'u_tex', 'u_hasTex'].forEach(function (n) { loc[n] = gl.getUniformLocation(prog, n); });
        lineBuf = gl.createBuffer();
        uint32 = (typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext) || !!gl.getExtension('OES_element_index_uint');
        Object.keys(MODELS).forEach(function (key) { if (!MODELS[key].lazy) model(gl, key); });
      },
      render: function (gl, args) {
        if ((!planes.length && trail.length < 2) || !prog) return;
        var main = args && args.defaultProjectionData && args.defaultProjectionData.mainMatrix;
        if (!main) return;
        var zoom = map.getZoom();
        gl.useProgram(prog);
        gl.enable(gl.DEPTH_TEST);
        gl.depthFunc(gl.LEQUAL);
        gl.disable(gl.CULL_FACE);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        gl.activeTexture(gl.TEXTURE0);
        gl.uniform1i(loc.u_tex, 0);
        function attrib(name, buf, size) {
          if (loc[name] < 0) return;
          if (!buf) { gl.disableVertexAttribArray(loc[name]); return; }
          gl.bindBuffer(gl.ARRAY_BUFFER, buf);
          gl.enableVertexAttribArray(loc[name]);
          gl.vertexAttribPointer(loc[name], size, gl.FLOAT, false, 0, 0);
        }
        if (trail.length > 1) drawTrail(gl, main, attrib);
        for (var i = 0; i < planes.length; i += 1) {
          var p = planes[i];
          if (!Number.isFinite(p.lat) || !Number.isFinite(p.lon)) continue;
          var kind = kindOf(p.type), key = modelKey(p.type, p.own);
          // While a specific model loads (or if it failed), the family's model stands in.
          var real = model(gl, key) || (key !== kind ? model(gl, kind) : null);
          var built = real ? null : upload(gl, kind);
          var altM = Math.max(0, (Number(p.alt) || 0) * FT);
          var place = map.transform.getMatrixForModel([p.lon, p.lat], altM);
          var orient = mul(BASIS, mul(rotZ(-(Number(p.hdg) || 0) * RAD), mul(rotX((Number(p.pitch) || 0) * RAD), rotY((Number(p.bank) || 0) * RAD))));
          gl.uniformMatrix4fv(loc.u_mvp, false, new Float32Array(mul(main, mul(place, mul(orient, scale(modelLength(p.lat, zoom, real ? real.len : built.len)))))));
          gl.uniformMatrix4fv(loc.u_rot, false, new Float32Array(orient));
          if (real) {
            gl.uniform1f(loc.u_mode, 1);
            attrib('a_part', null);
            for (var j = 0; j < real.prims.length; j += 1) {
              var g = real.prims[j];
              gl.uniform4fv(loc.u_color, g.color);
              gl.uniform1f(loc.u_hasTex, g.tex ? 1 : 0);
              if (g.tex) gl.bindTexture(gl.TEXTURE_2D, g.tex);
              attrib('a_pos', g.pos, 3);
              attrib('a_nrm', g.nrm, 3);
              attrib('a_uv', g.uv, 2);
              if (g.idx) { gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, g.idx); gl.drawElements(gl.TRIANGLES, g.count, g.indexType, 0); }
              else gl.drawArrays(gl.TRIANGLES, 0, g.count);
            }
          } else {
            var paint = schemeFor(p.callsign) || [WHITE, '#d9dde1', WHITE, '#e1e4e8'];
            gl.uniform3fv(loc.u_top, rgb(paint[0]));
            gl.uniform3fv(loc.u_belly, rgb(paint[1]));
            gl.uniform3fv(loc.u_tail, rgb(p.highlight || paint[2]));
            gl.uniform3fv(loc.u_eng, rgb(paint[3]));
            gl.uniform1f(loc.u_mode, 0);
            attrib('a_uv', null);
            attrib('a_pos', built.pos, 3);
            attrib('a_nrm', built.nrm, 3);
            attrib('a_part', built.part, 1);
            gl.drawArrays(gl.TRIANGLES, 0, built.count);
          }
          // The drop line: straight down to sea level; the terrain hides what is below ground.
          if (altM > 30) {
            gl.bindBuffer(gl.ARRAY_BUFFER, lineBuf);
            gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 0, 0, 0, -altM]), gl.DYNAMIC_DRAW);
            gl.uniformMatrix4fv(loc.u_mvp, false, new Float32Array(mul(main, mul(place, BASIS))));
            gl.uniform3fv(loc.u_tail, rgb(p.highlight || '#38bdf8'));
            gl.uniform1f(loc.u_alpha, 0.55);
            gl.uniform1f(loc.u_mode, 2);
            attrib('a_nrm', null);
            attrib('a_part', null);
            attrib('a_uv', null);
            attrib('a_pos', lineBuf, 3);
            gl.drawArrays(gl.LINES, 0, 2);
          }
        }
        ['a_pos', 'a_nrm', 'a_part', 'a_uv'].forEach(function (n) { if (loc[n] >= 0) gl.disableVertexAttribArray(loc[n]); });
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null);
      },
    };
  }

  window.StratosPlane3D = { layer: layer, buildMesh: buildMesh, kindOf: kindOf, schemeFor: schemeFor, modelLength: modelLength, parseGlb: parseGlb, modelKey: modelKey, MODELS: MODELS, CREDIT: CREDIT };
})();
