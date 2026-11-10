/* Volanta-style 3D globe for the Flight Deck.

   This is a real WebGL globe: MapLibre's globe projection, Esri World Imagery
   draped over the AWS/Mapzen terrarium DEM, the plan drawn as great-circle legs,
   and the aircraft lifted off the surface by a stalk whose length is its real
   altitude at the current scale. It replaces the earlier canvas perspective
   mesh, which could tilt a small patch of ground but was never a globe.

   The library is vendored (app/vendor/maplibre) so the desktop build needs no
   bundler and no CDN for the renderer itself. Tiles still come from their
   publishers; both sources send CORS headers and are named on screen.

   A failure here must never cost the pilot the chart: if WebGL or the library
   is unavailable the container says so and the 2D map stays in use. */

(function () {
  'use strict';

  var ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
  var ESRI_LABELS = 'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}';
  var DEM = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
  var EMPTY = { type: 'FeatureCollection', features: [] };
  var RAD = Math.PI / 180;
  var AIRCRAFT_SHAPE = [[0, -14], [2, -8], [2, -3], [13, 3], [13, 6], [2, 3], [2, 9], [5, 12], [5, 14], [0, 13], [-5, 14], [-5, 12], [-2, 9], [-2, 3], [-13, 6], [-13, 3], [-2, -3], [-2, -8]];
  var FT_TO_M = 0.3048;
  var genericPlane = null;
  var genericPlaneCache = {};
  if (typeof Image !== 'undefined') {
    genericPlane = new Image();
    genericPlane.onload = function () { window.dispatchEvent(new Event('aircraft-atlas-ready')); };
    genericPlane.src = 'images/aircraft/generic.svg';
  }
  var ALT_STOPS = [
    [0, [163, 230, 53]],
    [7000, [34, 211, 238]],
    [18000, [129, 140, 248]],
    [30000, [192, 132, 252]],
    [45000, [233, 213, 255]],
  ];

  function altitudeRgb(feet) {
    var alt = Math.max(0, Number(feet) || 0);
    var lo = ALT_STOPS[0];
    var hi = ALT_STOPS[ALT_STOPS.length - 1];
    for (var i = 1; i < ALT_STOPS.length; i += 1) {
      if (alt <= ALT_STOPS[i][0]) {
        lo = ALT_STOPS[i - 1];
        hi = ALT_STOPS[i];
        break;
      }
    }
    var f = hi[0] === lo[0] ? 0 : Math.max(0, Math.min(1, (alt - lo[0]) / (hi[0] - lo[0])));
    return [
      Math.round(lo[1][0] + (hi[1][0] - lo[1][0]) * f),
      Math.round(lo[1][1] + (hi[1][1] - lo[1][1]) * f),
      Math.round(lo[1][2] + (hi[1][2] - lo[1][2]) * f),
    ];
  }

  function rgba(rgb, alpha) {
    return 'rgba(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ',' + alpha + ')';
  }

  /** A point on the great circle between two fixes. */
  function gcPoint(a, b, f) {
    var p1 = a.lat * RAD, l1 = a.lon * RAD, p2 = b.lat * RAD, l2 = b.lon * RAD;
    var h = Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin((l2 - l1) / 2) ** 2;
    var d = 2 * Math.asin(Math.min(1, Math.sqrt(Math.max(0, h))));
    if (!(d > 1e-9)) return { lat: a.lat + (b.lat - a.lat) * f, lon: a.lon + (b.lon - a.lon) * f };
    var A = Math.sin((1 - f) * d) / Math.sin(d);
    var B = Math.sin(f * d) / Math.sin(d);
    var x = A * Math.cos(p1) * Math.cos(l1) + B * Math.cos(p2) * Math.cos(l2);
    var y = A * Math.cos(p1) * Math.sin(l1) + B * Math.cos(p2) * Math.sin(l2);
    var z = A * Math.sin(p1) + B * Math.sin(p2);
    return { lat: Math.atan2(z, Math.hypot(x, y)) / RAD, lon: Math.atan2(y, x) / RAD };
  }

  function routeFeatures(points, active) {
    var features = [];
    for (var i = 0; i < points.length - 1; i += 1) {
      var a = points[i], b = points[i + 1];
      if (![a.lat, a.lon, b.lat, b.lon].every(Number.isFinite)) continue;
      var coords = [];
      for (var s = 0; s <= 24; s += 1) {
        var p = gcPoint(a, b, s / 24);
        coords.push([p.lon, p.lat]);
      }
      features.push({
        type: 'Feature',
        properties: { active: i === active - 1 ? 1 : 0 },
        geometry: { type: 'LineString', coordinates: coords },
      });
    }
    return { type: 'FeatureCollection', features: features };
  }

  function airportFeatures(list) {
    var features = [];
    for (var i = 0; i < list.length; i += 1) {
      var a = list[i];
      if (!Number.isFinite(a.lat) || !Number.isFinite(a.lon)) continue;
      features.push({
        type: 'Feature',
        properties: { id: a.id || '', major: a.major ? 1 : 0 },
        geometry: { type: 'Point', coordinates: [a.lon, a.lat] },
      });
    }
    return { type: 'FeatureCollection', features: features };
  }

  function trafficType(value) {
    return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  }

  /** A short ICAO type for a label, from either a code or a marketing name. */
  function aircraftTypeLabel(value) {
    var raw = String(value == null ? '' : value).trim();
    if (!raw) return '';
    try {
      if (window.PHOTO && typeof window.PHOTO.typeCode === 'function') {
        var code = window.PHOTO.typeCode(raw);
        if (code) return code;
      }
    } catch (_) {}
    return raw;
  }

  /** The callsign and aircraft type shown together on every aircraft label. */
  function aircraftLabel(callsign, type) {
    var parts = [];
    var id = String(callsign == null ? '' : callsign).trim();
    if (id) parts.push(id);
    var kind = aircraftTypeLabel(type);
    if (kind) parts.push(kind);
    return parts.join(' · ');
  }

  function trafficIconKey(type, shadow) {
    return (shadow ? 'traffic-shadow-' : 'traffic-plane-') + (trafficType(type) || 'generic');
  }

  function trafficFeatures(list, selected) {
    var features = [];
    var active = selected == null ? '' : String(selected).toUpperCase();
    for (var i = 0; i < list.length; i += 1) {
      var t = list[i] || {};
      var lat = Number(t.lat), lon = Number(t.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
      var key = String(t.key || t.hx || t.id || '');
      var id = String(t.id || t.callsign || key || '').toUpperCase();
      var alt = t.alt == null ? null : Number(t.alt);
      var hdg = Number(t.hdg);
      if (!Number.isFinite(hdg)) hdg = Number(t.trk);
      if (!Number.isFinite(hdg)) hdg = 0;
      var type = trafficType(t.type || t.aircraft || t.actype || t.model || '');
      var label = aircraftLabel(id, type);
      if (Number.isFinite(alt)) label += ' ' + Math.round(alt / 100);
      var selectedNow = !!(key && key.toUpperCase() === active);
      features.push({
        type: 'Feature',
        properties: {
          key: key,
          label: selectedNow ? '' : label,
          selected: selectedNow ? 1 : 0,
          hdg: ((hdg % 360) + 360) % 360,
          type: type,
          icon: trafficIconKey(type, selectedNow),
        },
        geometry: { type: 'Point', coordinates: [lon, lat] },
      });
    }
    return { type: 'FeatureCollection', features: features };
  }

  function planeArtwork(type, color) {
    var source = window.aircraftIcon ? window.aircraftIcon(type, color) : null;
    if (source) return source;
    if (!genericPlane || !genericPlane.complete || !genericPlane.naturalWidth) return null;
    var key = String(color || '');
    if (genericPlaneCache[key]) return genericPlaneCache[key];
    var canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 64;
    var ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(genericPlane, 0, 0, 64, 64);
    ctx.globalCompositeOperation = 'source-in';
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, 64, 64);
    genericPlaneCache[key] = canvas;
    return canvas;
  }

  function trafficIcon(type, color) {
    var canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 64;
    var ctx = canvas.getContext('2d');
    if (!ctx) return null;
    var source = planeArtwork(type, color);
    if (source) {
      /* The shared atlas is the detailed artwork the 2D chart already uses.
         A short shadow keeps the silhouette legible over bright imagery. */
      ctx.shadowColor = 'rgba(3, 10, 17, .9)';
      ctx.shadowBlur = 2.5;
      ctx.drawImage(source, 0, 0, 64, 64);
      return ctx.getImageData(0, 0, 64, 64);
    }
    ctx.translate(32, 32);
    ctx.scale(2.15, 2.15);
    ctx.beginPath();
    for (var i = 0; i < AIRCRAFT_SHAPE.length; i += 1) {
      var p = AIRCRAFT_SHAPE[i];
      if (i) ctx.lineTo(p[0], p[1]); else ctx.moveTo(p[0], p[1]);
    }
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
    ctx.lineWidth = 0.9;
    ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(3, 10, 17, .9)';
    ctx.stroke();
    return ctx.getImageData(0, 0, 64, 64);
  }

  function StratosGlobe3D(container, options) {
    options = options || {};
    this.el = container;
    this.accent = options.accent || '#22d3ee';
    this.onView = typeof options.onView === 'function' ? options.onView : null;
    this.onFollow = typeof options.onFollow === 'function' ? options.onFollow : null;
    this.map = null;
    this.marker = null;
    this.ready = false;
    this.failed = false;
    this.route = [];
    this.active = -1;
    this.airports = [];
    this.aircraft = null;
    this.traffic = [];
    this.trafficSelected = '';
    this.selectedTrail = [];
    this.selectedRoute = [];
    this.selectedMeta = null;
    this._iconSpecs = {};
    this._onAtlasReady = null;
    this.fx = null;
    this.fxCtx = null;
    this._fxW = 0;
    this._fxH = 0;
    this._fxDpr = 1;
    this._fxFrame = 0;
    this.follow = false;
    this.mode = options.mode === 'flat' ? 'flat' : 'globe';
    this.onTraffic = typeof options.onTraffic === 'function' ? options.onTraffic : null;
    this._placed = false;
    this.lon = -95;
    this.lat = 40;
    this.zoom = 5;
    this._build();
  }

  StratosGlobe3D.prototype._style = function () {
    return {
      version: 8,
      projection: { type: this.mode === 'flat' ? 'mercator' : 'globe' },
      glyphs: 'https://fonts.openmaptiles.org/{fontstack}/{range}.pbf',
      sources: {
        imagery: {
          type: 'raster',
          tiles: [ESRI],
          tileSize: 256,
          maxzoom: 19,
          attribution: 'Imagery: Esri, Maxar, Earthstar Geographics',
        },
        labels: {
          type: 'raster',
          tiles: [ESRI_LABELS],
          tileSize: 256,
          maxzoom: 18,
        },
        dem: {
          type: 'raster-dem',
          tiles: [DEM],
          encoding: 'terrarium',
          tileSize: 256,
          maxzoom: 15,
        },
        route: { type: 'geojson', data: EMPTY },
        airports: { type: 'geojson', data: EMPTY },
        traffic: { type: 'geojson', data: EMPTY },
        selectedRoute: { type: 'geojson', data: EMPTY },
      },
      layers: [
        { id: 'space', type: 'background', paint: { 'background-color': '#04080d' } },
        { id: 'imagery', type: 'raster', source: 'imagery', paint: { 'raster-fade-duration': 160 } },
        { id: 'labels', type: 'raster', source: 'labels', paint: { 'raster-opacity': 0.9 } },
        {
          id: 'route-glow',
          type: 'line',
          source: 'route',
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: {
            'line-color': this.accent,
            'line-width': ['case', ['==', ['get', 'active'], 1], 7, 4],
            'line-opacity': 0.18,
            'line-blur': 5,
          },
        },
        {
          id: 'route-line',
          type: 'line',
          source: 'route',
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: {
            'line-color': ['case', ['==', ['get', 'active'], 1], this.accent, '#8fa4b8'],
            'line-width': ['case', ['==', ['get', 'active'], 1], 2.6, 1.5],
            'line-opacity': 0.95,
          },
        },
        {
          id: 'selected-route-glow',
          type: 'line',
          source: 'selectedRoute',
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: { 'line-color': '#fbbf24', 'line-width': 7, 'line-opacity': 0.12, 'line-blur': 5 },
        },
        {
          id: 'selected-route-line',
          type: 'line',
          source: 'selectedRoute',
          layout: { 'line-join': 'round' },
          paint: { 'line-color': '#fbbf24', 'line-width': 2.2, 'line-opacity': 0.92, 'line-dasharray': [2, 1.6] },
        },
        {
          id: 'airport-dot',
          type: 'circle',
          source: 'airports',
          paint: {
            'circle-radius': ['case', ['==', ['get', 'major'], 1], 4.5, 2.6],
            'circle-color': '#e8f1fa',
            'circle-stroke-color': '#06111a',
            'circle-stroke-width': 1.4,
          },
        },
        {
          id: 'traffic-halo',
          type: 'circle',
          source: 'traffic',
          paint: {
            'circle-radius': ['interpolate', ['linear'], ['zoom'], 2, 5, 8, 8, 14, 12],
            'circle-color': ['case', ['==', ['get', 'selected'], 1], '#fbbf24', '#22d3ee'],
            'circle-opacity': ['case', ['==', ['get', 'selected'], 1], 0.25, 0.1],
            'circle-blur': 1,
          },
        },
        {
          id: 'traffic-selected',
          type: 'circle',
          source: 'traffic',
          filter: ['==', ['get', 'selected'], 1],
          paint: {
            'circle-radius': ['interpolate', ['linear'], ['zoom'], 2, 12, 8, 16, 14, 22],
            'circle-color': 'rgba(0, 0, 0, 0)',
            'circle-stroke-color': '#fbbf24',
            'circle-stroke-width': 2,
            'circle-stroke-opacity': 1,
          },
        },
        {
          id: 'traffic-plane',
          type: 'symbol',
          source: 'traffic',
          layout: {
            'icon-image': ['get', 'icon'],
            'icon-size': ['interpolate', ['linear'], ['zoom'], 2, ['case', ['==', ['get', 'selected'], 1], 0.56, 0.42], 6, ['case', ['==', ['get', 'selected'], 1], 0.68, 0.5], 10, ['case', ['==', ['get', 'selected'], 1], 0.82, 0.62], 14, ['case', ['==', ['get', 'selected'], 1], 0.96, 0.74]],
            'icon-rotate': ['get', 'hdg'],
            'icon-rotation-alignment': 'map',
            'icon-pitch-alignment': 'viewport',
            'icon-allow-overlap': true,
            'icon-ignore-placement': true,
            'symbol-sort-key': ['case', ['==', ['get', 'selected'], 1], 0, 1],
            'text-field': ['get', 'label'],
            'text-font': ['Open Sans Regular'],
            'text-size': ['interpolate', ['linear'], ['zoom'], 2, 9, 8, 10, 14, 11],
            'text-offset': [0, 1.25],
            'text-anchor': 'top',
            'text-optional': true,
            'text-allow-overlap': false,
            'text-padding': 2,
          },
          paint: {
            'text-color': ['case', ['==', ['get', 'selected'], 1], '#fde68a', '#e8f1fa'],
            'text-halo-color': '#041019',
            'text-halo-width': 1.4,
          },
        },
      ],
    };
  };

  StratosGlobe3D.prototype._build = function () {
    if (!this.el) return;
    if (!window.maplibregl) {
      this.failed = true;
      this.el.innerHTML = '<div class="g3-fail">The 3D globe engine did not load. The 2D chart is still available.</div>';
      return;
    }
    try {
      this.map = new window.maplibregl.Map({
        container: this.el,
        style: this._style(),
        center: [this.lon, this.lat],
        zoom: Math.max(1, this.zoom - 1),
        pitch: this.mode === 'flat' ? 55 : 30,
        bearing: 0,
        maxPitch: 78,
        renderWorldCopies: true,
        minZoom: 1,
        maxZoom: 18,
        antialias: true,
        attributionControl: false,
        fadeDuration: 120,
      });
    } catch (error) {
      this.failed = true;
      this.el.innerHTML = '<div class="g3-fail">The 3D globe needs WebGL, which this window did not provide. The 2D chart stays available.</div>';
      return;
    }

    this._createFx();
    var self = this;
    this.map.on('load', function () {
      self.ready = true;
      try { self.map.setProjection({ type: self.mode === 'flat' ? 'mercator' : 'globe' }); } catch (_) {}
      try { self.map.setTerrain({ source: 'dem', exaggeration: 1.15 }); } catch (_) {}
      self._addTrafficIcons();
      if (self.onTraffic) {
        self.map.on('click', 'traffic-plane', function (event) {
          var feature = event.features && event.features[0];
          var props = feature && feature.properties;
          var key = props && (props.key || props.id);
          if (key) self.onTraffic(String(key), props);
        });
        self.map.on('mouseenter', 'traffic-plane', function () {
          self.map.getCanvas().style.cursor = 'pointer';
        });
        self.map.on('mouseleave', 'traffic-plane', function () {
          self.map.getCanvas().style.cursor = '';
        });
      }
      self._apply();
      if (!self._onAtlasReady) {
        self._onAtlasReady = function () {
          self._refreshTrafficIcons();
          self._queueFx();
        };
        window.addEventListener('aircraft-atlas-ready', self._onAtlasReady);
      }
    });
    this.map.on('moveend', function () { self._emit(); });
    this.map.on('dragstart', function () {
      self.follow = false;
      if (self.onFollow) self.onFollow(false);
    });
    this.map.on('zoom', function () { self._updateAltitude(); });
    this.map.on('error', function () {});
    this.el.addEventListener('contextmenu', function (event) { event.preventDefault(); });

    var credit = document.createElement('div');
    credit.className = 'g3-credit';
    credit.textContent = 'Imagery: Esri, Maxar · Elevation: AWS Terrain Tiles (Mapzen) · display only, not for navigation';
    this.el.appendChild(credit);

    if (window.ResizeObserver) {
      this._observer = new window.ResizeObserver(function () { self.map.resize(); self._resizeFx(); });
      this._observer.observe(this.el);
    }
  };

  StratosGlobe3D.prototype._apply = function () {
    if (!this.map || !this.ready) return;
    this._setRouteData();
    this._setAirportData();
    this._setTrafficData();
    this._setSelectedData();
    if (this.aircraft) this._placeAircraft();
  };

  StratosGlobe3D.prototype._addTrafficIcons = function (force) {
    this._ensureTrafficIcon('', false, force);
    this._ensureTrafficIcon('', true, force);
  };

  StratosGlobe3D.prototype._addTrafficImage = function (name, data, force) {
    if (!this.map || !data) return;
    try {
      if (this.map.hasImage(name)) {
        if (force && typeof this.map.updateImage === 'function') this.map.updateImage(name, data);
      } else {
        this.map.addImage(name, data);
      }
    } catch (_) {}
  };

  StratosGlobe3D.prototype._ensureTrafficIcon = function (type, shadow, force) {
    var name = trafficIconKey(type, shadow);
    if (!this._iconSpecs[name]) this._iconSpecs[name] = { type: type || '', shadow: !!shadow };
    if (!this.map) return name;
    if (!force && this.map.hasImage(name)) return name;
    var data = trafficIcon(type, shadow ? 'rgba(251, 191, 36, .3)' : '#dbeafe');
    this._addTrafficImage(name, data, force);
    return name;
  };

  StratosGlobe3D.prototype._refreshTrafficIcons = function () {
    if (!this.map) return;
    var specs = this._iconSpecs || {};
    for (var name in specs) {
      if (!Object.prototype.hasOwnProperty.call(specs, name)) continue;
      var spec = specs[name];
      this._ensureTrafficIcon(spec.type, spec.shadow, true);
    }
    this._addTrafficIcons(true);
    this._setTrafficData();
  };

  StratosGlobe3D.prototype._createFx = function () {
    if (this.fx || !this.el) return;
    var canvas = document.createElement('canvas');
    canvas.className = 'g3-flightfx';
    canvas.setAttribute('aria-hidden', 'true');
    this.el.appendChild(canvas);
    this.fx = canvas;
    this.fxCtx = canvas.getContext('2d');
    var self = this;
    this._onMapRender = function () { self._queueFx(); };
    if (this.map) this.map.on('render', this._onMapRender);
    this._resizeFx();
  };

  StratosGlobe3D.prototype._resizeFx = function () {
    if (!this.fx || !this.el) return;
    var width = Math.max(1, Math.round(this.el.clientWidth || 0));
    var height = Math.max(1, Math.round(this.el.clientHeight || 0));
    var dpr = Math.min(2, window.devicePixelRatio || 1);
    this._fxW = width;
    this._fxH = height;
    this._fxDpr = dpr;
    var bw = Math.round(width * dpr);
    var bh = Math.round(height * dpr);
    if (this.fx.width !== bw || this.fx.height !== bh) {
      this.fx.width = bw;
      this.fx.height = bh;
    }
    this._queueFx();
  };

  StratosGlobe3D.prototype._queueFx = function () {
    if (!this.fx || this._fxFrame) return;
    var self = this;
    this._fxFrame = window.requestAnimationFrame(function () {
      self._fxFrame = 0;
      self._drawFlightPath();
    });
  };

  /**
   * MapLibre line layers cannot carry a per-vertex altitude. Draw the selected
   * observed track on a camera-aligned canvas instead: project its ground
   * position with the live map, lift it by the current map scale and pitch,
   * then fill the vertical curtain under the elevated line. This is the same
   * camera as the globe, so panning, pitching and zooming stay in sync.
   */
  StratosGlobe3D.prototype._drawFlightPath = function () {
    var ctx = this.fxCtx;
    if (!ctx || !this._fxW || !this._fxH) return;
    ctx.setTransform(this._fxDpr, 0, 0, this._fxDpr, 0, 0);
    ctx.clearRect(0, 0, this._fxW, this._fxH);
    if (!this.map || !this.ready || !this.selectedTrail.length) return;

    var pitch = Math.sin((Number(this.map.getPitch()) || 0) * RAD);
    var zoom = this.map.getZoom();
    var scale = 156543.03392 / Math.pow(2, zoom);
    var points = [];
    for (var i = 0; i < this.selectedTrail.length; i += 1) {
      var p = this.selectedTrail[i] || {};
      var lat = Number(p.lat), lon = Number(p.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
      var alt = Number(p.alt);
      if (!Number.isFinite(alt)) alt = Number(p.agl);
      if (!Number.isFinite(alt)) alt = 0;
      var ground = this.map.project([lon, lat]);
      var mpp = Math.max(1e-6, scale * Math.max(0.05, Math.cos(lat * RAD)));
      var lift = Math.max(0, alt) * FT_TO_M / mpp * pitch;
      points.push({ gx: ground.x, gy: ground.y, tx: ground.x, ty: ground.y - lift, alt: Math.max(0, alt) });
    }
    if (points.length < 2) return;

    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    // The translucent curtain is what makes the profile read as a 3D wall.
    for (var j = 1; j < points.length; j += 1) {
      var a = points[j - 1], b = points[j];
      var ink = altitudeRgb((a.alt + b.alt) * 0.5);
      var top = Math.min(a.ty, b.ty);
      var bottom = Math.max(a.gy, b.gy);
      if (bottom <= top) bottom = top + 1;
      var fill = ctx.createLinearGradient(0, top, 0, bottom);
      fill.addColorStop(0, rgba(ink, 0.38));
      fill.addColorStop(0.55, rgba(ink, 0.14));
      fill.addColorStop(1, rgba(ink, 0.025));
      ctx.fillStyle = fill;
      ctx.beginPath();
      ctx.moveTo(a.gx, a.gy);
      ctx.lineTo(b.gx, b.gy);
      ctx.lineTo(b.tx, b.ty);
      ctx.lineTo(a.tx, a.ty);
      ctx.closePath();
      ctx.fill();
    }

    // Faint ground trace keeps the track readable when the curtain is steep.
    ctx.beginPath();
    ctx.moveTo(points[0].gx, points[0].gy);
    for (var g = 1; g < points.length; g += 1) ctx.lineTo(points[g].gx, points[g].gy);
    ctx.setLineDash([4, 6]);
    ctx.strokeStyle = 'rgba(165,243,252,0.3)';
    ctx.lineWidth = 1.1;
    ctx.stroke();
    ctx.setLineDash([]);

    // Bright altitude-coloured top edge, with a broad low-alpha glow.
    for (var k = 1; k < points.length; k += 1) {
      var prev = points[k - 1], cur = points[k];
      var ink2 = altitudeRgb((prev.alt + cur.alt) * 0.5);
      ctx.beginPath();
      ctx.moveTo(prev.tx, prev.ty);
      ctx.lineTo(cur.tx, cur.ty);
      ctx.strokeStyle = rgba(ink2, 0.2);
      ctx.lineWidth = 10;
      ctx.stroke();
      ctx.strokeStyle = rgba(ink2, 0.98);
      ctx.lineWidth = 3.2;
      ctx.stroke();
    }

    // The selected aircraft rides at the top of its measured altitude path.
    // The surface symbol is now only an anchor; its detailed shadow icon is
    // chosen in trafficFeatures and the live callsign badge moves here.
    var last = points[points.length - 1];
    var meta = this.selectedMeta || {};
    var heading = Number(meta.heading);
    if (!Number.isFinite(heading)) {
      var prev = points.length > 1 ? points[points.length - 2] : last;
      heading = Math.atan2(last.gx - prev.gx, -(last.gy - prev.gy)) / RAD;
    }
    heading = ((heading % 360) + 360) % 360;

    ctx.save();
    ctx.beginPath();
    ctx.ellipse(last.gx, last.gy + 1.5, 11, 4.2, 0, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(2, 8, 14, .5)';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(last.gx, last.gy, 3.2, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(251, 191, 36, .9)';
    ctx.fill();
    ctx.setLineDash([3, 5]);
    ctx.strokeStyle = 'rgba(251, 191, 36, .55)';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(last.gx, last.gy);
    ctx.lineTo(last.tx, last.ty);
    ctx.stroke();
    ctx.restore();

    var plane = planeArtwork(meta.type || '', '#fbbf24');
    var zoom = this.map.getZoom();
    var size = Math.max(30, Math.min(74, 36 + (zoom - 6) * 6));
    ctx.save();
    ctx.translate(last.tx, last.ty);
    ctx.rotate(heading * RAD);
    ctx.shadowColor = 'rgba(4, 16, 25, .95)';
    ctx.shadowBlur = 4;
    if (plane) {
      ctx.drawImage(plane, -size / 2, -size / 2, size, size);
    } else {
      ctx.scale(size / 28, size / 28);
      ctx.beginPath();
      for (var f = 0; f < AIRCRAFT_SHAPE.length; f += 1) {
        var q = AIRCRAFT_SHAPE[f];
        if (f) ctx.lineTo(q[0], q[1]); else ctx.moveTo(q[0], q[1]);
      }
      ctx.closePath();
      ctx.fillStyle = '#fbbf24';
      ctx.fill();
      ctx.strokeStyle = 'rgba(4, 16, 25, .95)';
      ctx.lineWidth = 1.4;
      ctx.stroke();
    }
    ctx.restore();

    var label = aircraftLabel(meta.id, meta.type);
    if (label) {
      if (Number.isFinite(Number(meta.alt)) && Number(meta.alt) > 0) {
        label += ' · FL' + String(Math.round(Number(meta.alt) / 100)).padStart(3, '0');
      }
      ctx.save();
      ctx.font = '600 11px "Segoe UI", system-ui, sans-serif';
      ctx.textBaseline = 'middle';
      var tw = ctx.measureText(label).width;
      var pad = 7, bh = 20;
      var lx = last.tx + size * 0.55;
      var ly = last.ty - bh / 2;
      if (lx + tw + pad * 2 > this._fxW - 8) lx = last.tx - size * 0.55 - tw - pad * 2;
      lx = Math.max(8, Math.min(this._fxW - tw - pad * 2 - 8, lx));
      ly = Math.max(8, Math.min(this._fxH - bh - 8, ly));
      var rr = 5;
      ctx.beginPath();
      ctx.moveTo(lx + rr, ly);
      ctx.lineTo(lx + tw + pad * 2 - rr, ly);
      ctx.quadraticCurveTo(lx + tw + pad * 2, ly, lx + tw + pad * 2, ly + rr);
      ctx.lineTo(lx + tw + pad * 2, ly + bh - rr);
      ctx.quadraticCurveTo(lx + tw + pad * 2, ly + bh, lx + tw + pad * 2 - rr, ly + bh);
      ctx.lineTo(lx + rr, ly + bh);
      ctx.quadraticCurveTo(lx, ly + bh, lx, ly + bh - rr);
      ctx.lineTo(lx, ly + rr);
      ctx.quadraticCurveTo(lx, ly, lx + rr, ly);
      ctx.closePath();
      ctx.fillStyle = 'rgba(4, 16, 25, .86)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(251, 191, 36, .62)';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = '#fde68a';
      ctx.fillText(label, lx + pad, ly + bh / 2 + 0.5);
      ctx.restore();
    }

    ctx.restore();
  };

  StratosGlobe3D.prototype.show = function () {
    this.el.hidden = false;
    var self = this;
    if (this.map) window.requestAnimationFrame(function () { self.map.resize(); self._resizeFx(); self._queueFx(); });
  };

  StratosGlobe3D.prototype.hide = function () {
    this.el.hidden = true;
  };

  StratosGlobe3D.prototype.resize = function () {
    if (this.map) this.map.resize();
    this._resizeFx();
  };

  /** Zoom for the top-left controls, in the same direction as the 2D chart. */
  StratosGlobe3D.prototype.zoomBy = function (factor) {
    if (!this.map || !this.ready) return;
    this.map.easeTo({ zoom: this.map.getZoom() + Math.log2(factor), duration: 220 });
  };

  /** Globe or a flat Mercator chart tilted over the same real terrain. */
  StratosGlobe3D.prototype.setMode = function (mode) {
    this.mode = mode === 'flat' ? 'flat' : 'globe';
    if (!this.map || !this.ready) return this.mode;
    try { this.map.setProjection({ type: this.mode === 'flat' ? 'mercator' : 'globe' }); } catch (_) {}
    try {
      this.map.easeTo({
        pitch: this.mode === 'flat' ? 55 : (this.zoom > 7 ? 52 : 30),
        duration: 420,
      });
    } catch (_) {}
    this._updateAltitude();
    return this.mode;
  };

  /** Place the camera. `force` is used when 3D is entered, not every fix. */
  StratosGlobe3D.prototype.setView = function (view) {
    if (!view) return;
    this.lon = Number(view.lon);
    this.lat = Number(view.lat);
    this.zoom = Number(view.zoom);
    this.follow = !!view.follow;
    if (!this.map || !this.ready) return;
    var z = Math.max(1, Math.min(17.2, (Number.isFinite(this.zoom) ? this.zoom : 6) - 1));
    if (view.force || !this._placed) {
      this._placed = true;
      this.map.jumpTo({
        center: [this.lon, this.lat],
        zoom: z,
        pitch: this.mode === 'flat' ? 55 : (this.zoom > 7 ? 52 : 30),
        bearing: Number.isFinite(Number(view.bearing)) ? Number(view.bearing) : 0,
      });
    } else if (this.follow) {
      this.map.setCenter([this.lon, this.lat]);
    }
  };

  StratosGlobe3D.prototype.setFollow = function (on) {
    this.follow = !!on;
  };

  StratosGlobe3D.prototype._emit = function () {
    if (!this.map || !this.ready || !this.onView) return;
    var c = this.map.getCenter();
    this.onView({
      lat: c.lat,
      lon: c.lng,
      zoom: this.map.getZoom() + 1,
      pitch: this.map.getPitch(),
    });
  };

  StratosGlobe3D.prototype._setRouteData = function () {
    if (!this.map || !this.ready) return;
    var source = this.map.getSource('route');
    if (source) source.setData(routeFeatures(this.route, this.active));
  };

  StratosGlobe3D.prototype.setRoute = function (points, active) {
    this.route = Array.isArray(points) ? points : [];
    this.active = Number.isFinite(active) ? active : -1;
    this._setRouteData();
  };

  StratosGlobe3D.prototype._setAirportData = function () {
    if (!this.map || !this.ready) return;
    var source = this.map.getSource('airports');
    if (source) source.setData(airportFeatures(this.airports));
  };

  StratosGlobe3D.prototype.setAirports = function (list) {
    this.airports = Array.isArray(list) ? list : [];
    this._setAirportData();
  };

  StratosGlobe3D.prototype._setTrafficData = function () {
    if (!this.map || !this.ready) return;
    var active = this.trafficSelected == null ? '' : String(this.trafficSelected).toUpperCase();
    for (var i = 0; i < this.traffic.length; i += 1) {
      var t = this.traffic[i] || {};
      this._ensureTrafficIcon(t.type || '', false);
      if (String(t.key || t.hx || t.id || '').toUpperCase() === active) this._ensureTrafficIcon(t.type || '', true);
    }
    var source = this.map.getSource('traffic');
    if (source) source.setData(trafficFeatures(this.traffic, this.trafficSelected));
  };

  StratosGlobe3D.prototype.setTraffic = function (list, selected) {
    this.traffic = Array.isArray(list) ? list : [];
    this.trafficSelected = selected == null ? '' : String(selected);
    this._setTrafficData();
  };

  StratosGlobe3D.prototype._setSelectedData = function () {
    if (!this.map || !this.ready) return;
    var filed = this.map.getSource('selectedRoute');
    if (filed) filed.setData(routeFeatures(this.selectedRoute, -1));
    if (this.selectedMeta && this.selectedMeta.type) this._ensureTrafficIcon(this.selectedMeta.type, true);
    this._queueFx();
  };

  StratosGlobe3D.prototype.setSelectedTraffic = function (detail) {
    this.selectedTrail = detail && Array.isArray(detail.trail) ? detail.trail : [];
    this.selectedRoute = detail && Array.isArray(detail.route) ? detail.route : [];
    this.selectedMeta = detail ? {
      id: String(detail.id || ''),
      type: detail.type || '',
      heading: Number(detail.heading),
      alt: detail.alt == null ? null : Number(detail.alt),
    } : null;
    this._setSelectedData();
  };

  StratosGlobe3D.prototype._markerElement = function () {
    var el = document.createElement('div');
    el.className = 'g3-ac';
    el.innerHTML = '<span class="g3-tag"></span>'
      + '<span class="g3-head"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.2 13.8 9l7.2 3.7v2.1l-7.2 2.8-1 4.2-.8 1.9-.8-1.9-1-4.2-7.2-2.8V11L10.2 9z" fill="currentColor"/></svg></span>'
      + '<span class="g3-stalk"></span>';
    return el;
  };

  StratosGlobe3D.prototype._placeAircraft = function () {
    if (!this.map || !this.ready || !this.aircraft) return;
    if (!this.marker) {
      this.marker = new window.maplibregl.Marker({ element: this._markerElement(), anchor: 'bottom' })
        .setLngLat([this.aircraft.lon, this.aircraft.lat])
        .addTo(this.map);
    } else {
      this.marker.setLngLat([this.aircraft.lon, this.aircraft.lat]);
    }
    this._updateAltitude();
  };

  StratosGlobe3D.prototype._updateAltitude = function () {
    if (!this.marker || !this.aircraft || !this.map) return;
    var el = this.marker.getElement();
    var alt = Number(this.aircraft.alt) || 0;
    var zoom = this.map.getZoom();
    var nmPerPx = (360 * 60 * Math.cos(Math.max(-85, Math.min(85, this.aircraft.lat)) * RAD)) / (512 * 2 ** zoom);
    var px = Math.max(0, Math.min(150, alt / 6076.12 / Math.max(1e-6, nmPerPx)));
    var stalk = el.querySelector('.g3-stalk');
    if (stalk) stalk.style.height = px.toFixed(1) + 'px';
    var tag = el.querySelector('.g3-tag');
    if (tag) {
      var fl = alt >= 10000 ? 'FL' + String(Math.round(alt / 100)).padStart(3, '0') : Math.round(alt).toLocaleString('en-US') + ' FT';
      var who = aircraftLabel(this.aircraft.callsign, this.aircraft.type);
      tag.textContent = (who ? who + ' · ' : '') + fl;
    }
    var svg = el.querySelector('.g3-head svg');
    if (svg) svg.style.transform = 'rotate(' + (((Number(this.aircraft.hdg) || 0) % 360 + 360) % 360) + 'deg)';
  };

  StratosGlobe3D.prototype.setAircraft = function (aircraft) {
    if (!aircraft) {
      if (this.marker) { this.marker.remove(); this.marker = null; }
      this.aircraft = null;
      return;
    }
    this.aircraft = {
      lat: Number(aircraft.lat),
      lon: Number(aircraft.lon),
      alt: Number(aircraft.alt),
      hdg: Number(aircraft.hdg),
      trk: Number(aircraft.trk),
      callsign: aircraft.callsign || '',
      type: aircraft.type || '',
    };
    if (!Number.isFinite(this.aircraft.lat) || !Number.isFinite(this.aircraft.lon)) return;
    this._placeAircraft();
  };

  StratosGlobe3D.prototype.recenter = function () {
    if (!this.map || !this.ready) return;
    var lat = this.aircraft && Number.isFinite(this.aircraft.lat) ? this.aircraft.lat : this.lat;
    var lon = this.aircraft && Number.isFinite(this.aircraft.lon) ? this.aircraft.lon : this.lon;
    this.follow = true;
    this.map.easeTo({ center: [lon, lat], zoom: Math.max(this.map.getZoom(), 6.2), pitch: this.mode === 'flat' ? 55 : 52, duration: 700 });
  };

  StratosGlobe3D.prototype.destroy = function () {
    if (this._fxFrame) { window.cancelAnimationFrame(this._fxFrame); this._fxFrame = 0; }
    if (this.map && this._onMapRender) this.map.off('render', this._onMapRender);
    if (this._onAtlasReady) window.removeEventListener('aircraft-atlas-ready', this._onAtlasReady);
    if (this.fx && this.fx.parentNode) this.fx.parentNode.removeChild(this.fx);
    this.fx = null;
    this.fxCtx = null;
    if (this.marker) { this.marker.remove(); this.marker = null; }
    if (this._observer) { this._observer.disconnect(); this._observer = null; }
    if (this.map) { this.map.remove(); this.map = null; }
  };

  window.StratosGlobe3D = StratosGlobe3D;
})();
