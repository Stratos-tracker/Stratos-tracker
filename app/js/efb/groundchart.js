/* EFB · Airport ground chart.
 *
 * Draws the OpenStreetMap aeroway ways the bridge caches for one airfield as a
 * chart: aprons and terminals as surfaces, taxiways with edge and centreline,
 * runways with centreline and threshold bars, and refs only where the way
 * carries one. The taxi route is a shortest path over those centre lines from
 * the live aircraft position to the runway threshold the plan names; when the
 * charted ways do not join them the card says so instead of drawing a route.
 */

import {
  airportOrigin, bearingDegrees, geometryBounds, localise,
  normaliseWays, runwayTarget, taxiRoute,
} from '../lib/groundchart.js';
import { defaultBridgeBase, isHostedPage } from '../bridge.js';

const esc = value => String(value == null ? '' : value)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function distanceToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const length = dx * dx + dy * dy;
  const t = length ? clamp(((px - ax) * dx + (py - ay) * dy) / length, 0, 1) : 0;
  return Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
}

export class GroundChart {
  constructor(container, { airport, runway = '', accent = '#22d3ee', ways = null } = {}) {
    this.container = container;
    this.airport = airport;
    this.runway = String(runway || '');
    this.accent = accent;
    this.ways = [];
    this.local = [];
    this.origin = null;
    this.bounds = null;
    this.zoom = 1;
    this.panX = 0;
    this.panY = 0;
    this.position = null;
    this.route = null;
    this.routeTarget = null;
    this.selected = null;
    this.hover = null;
    this.drag = null;
    this.frame = 0;
    this.destroyed = false;
    this.status = 'Loading the charted geometry…';
    // A caller may hand over already-fetched ways (preview and tests); the
    // page itself always lets the bridge be the source.
    this.injected = Array.isArray(ways) ? ways : null;

    container.innerHTML = `
      <div class="gc-head">
        <div class="gc-title"><b>Ground chart</b><span class="gc-status" data-gc-status>Loading the charted geometry…</span></div>
        <div class="gc-tools">
          <button type="button" data-gc="in" title="Zoom in" aria-label="Zoom in">+</button>
          <button type="button" data-gc="out" title="Zoom out" aria-label="Zoom out">−</button>
          <button type="button" data-gc="fit" title="Fit the airfield" aria-label="Fit the airfield">Fit</button>
        </div>
      </div>
      <div class="gc-wrap">
        <canvas aria-label="Airport ground chart for ${esc(airport.id)}"></canvas>
        <div class="gc-tip" hidden></div>
        <div class="gc-empty" hidden></div>
      </div>
      <div class="gc-legend">
        <span><i class="gc-key runway"></i>Runway</span>
        <span><i class="gc-key taxi"></i>Taxiway</span>
        <span><i class="gc-key apron"></i>Apron</span>
        <span><i class="gc-key terminal"></i>Terminal</span>
        <span><i class="gc-key route"></i>Taxi route</span>
      </div>
      <div class="gc-note">Geometry © OpenStreetMap contributors (ODbL), served by the Stratos Bridge. Only charted ways are drawn; no taxiway, stand or holding point is inferred.</div>`;

    this.canvas = container.querySelector('canvas');
    this.tip = container.querySelector('.gc-tip');
    this.empty = container.querySelector('.gc-empty');
    this.statusEl = container.querySelector('[data-gc-status]');

    this.onWheel = event => {
      event.preventDefault();
      this.zoomAt(event.clientX, event.clientY, event.deltaY > 0 ? 0.88 : 1.14);
    };
    this.onDown = event => {
      if (event.button != null && event.button !== 0) return;
      this.canvas.setPointerCapture?.(event.pointerId);
      this.drag = { x: event.clientX, y: event.clientY, moved: 0 };
    };
    this.onMove = event => {
      if (this.drag) {
        const dx = event.clientX - this.drag.x;
        const dy = event.clientY - this.drag.y;
        this.drag.moved += Math.abs(dx) + Math.abs(dy);
        this.drag.x = event.clientX;
        this.drag.y = event.clientY;
        this.panX += dx;
        this.panY += dy;
        this.hideTip();
        this.requestDraw();
        return;
      }
      this.hover = this.pickWay(event);
      if (this.hover) this.showWayTip(this.hover, event); else this.hideTip();
      this.requestDraw();
    };
    this.onUp = event => {
      const moved = this.drag && this.drag.moved > 4;
      this.drag = null;
      if (moved) return;
      const way = this.pickWay(event);
      this.selected = way && this.selected === way ? null : way;
      this.requestDraw();
    };
    this.onLeave = () => {
      this.hover = null;
      this.hideTip();
      this.requestDraw();
    };

    this.canvas.addEventListener('wheel', this.onWheel, { passive: false });
    this.canvas.addEventListener('pointerdown', this.onDown);
    this.canvas.addEventListener('pointermove', this.onMove);
    this.canvas.addEventListener('pointerup', this.onUp);
    this.canvas.addEventListener('pointercancel', this.onUp);
    this.canvas.addEventListener('pointerleave', this.onLeave);
    container.querySelectorAll('[data-gc]').forEach(button => {
      button.addEventListener('click', () => {
        const action = button.dataset.gc;
        if (action === 'in') this.zoomAt(null, null, 1.25);
        else if (action === 'out') this.zoomAt(null, null, 0.8);
        else this.fit();
      });
    });

    if (typeof ResizeObserver === 'function') {
      this.watch = new ResizeObserver(() => {
        const width = this.canvas.clientWidth;
        // A width change (tablet rotation, panel resize) needs a fresh fit so
        // the chart stays sharp and fully visible instead of keeping the old
        // scale and clipping at the new edge.
        if (width && Math.abs(width - (this.lastWidth || 0)) > 2) {
          this.lastWidth = width;
          this.fit();
        } else {
          this.requestDraw();
        }
      });
      this.watch.observe(this.canvas);
    }

    this.load();
  }

  setStatus(text) {
    this.status = text;
    if (this.statusEl) this.statusEl.textContent = text;
  }

  async load() {
    if (this.injected) { this.useWays(this.injected); return; }
    const { id, lat, lon } = this.airport || {};
    if (!id || !Number.isFinite(Number(lat)) || !Number.isFinite(Number(lon))) {
      this.setStatus('This airport has no position, so no ground chart can be placed.');
      this.showEmpty('No airport position');
      return;
    }
    if (isHostedPage()) {
      this.setStatus('The ground geometry is served by the bridge on the simulator PC.');
      this.showEmpty('Ground chart needs the bridge');
      return;
    }
    this.setStatus('Loading the charted geometry…');
    try {
      const base = defaultBridgeBase().replace(/\/+$/, '');
      const response = await fetch(`${base}/osm?id=${encodeURIComponent(id)}&lat=${Number(lat)}&lon=${Number(lon)}`, {
        credentials: location.protocol === 'file:' ? 'omit' : 'include',
        cache: 'no-store',
      });
      if (!response.ok) throw new Error(`The bridge answered ${response.status}.`);
      this.useWays(await response.json());
    } catch (error) {
      this.setStatus(`Ground geometry unavailable: ${error.message}`);
      this.showEmpty('Ground geometry unavailable');
    }
  }

  useWays(raw) {
    const ways = normaliseWays(raw);
    if (!ways.length) {
      this.ways = [];
      this.setStatus('The bridge returned no charted ground geometry for this airfield.');
      this.showEmpty('No charted geometry');
      return;
    }
    this.ways = ways;
    // One local frame for everything: the geometry's own centre. The aircraft
    // position is converted through the same frame below.
    this.origin = airportOrigin(ways);
    this.local = localise(ways, this.origin);
    this.bounds = geometryBounds(this.local);
    this.container.classList.remove('is-empty');
    this.empty.hidden = true;
    this.setStatus(`${ways.length} charted ways · ${ways.filter(way => way.type === 'taxiway').length} taxiways`);
    this.fit();
    this.updateRoute();
  }

  showEmpty(text) {
    if (!this.empty) return;
    // The card collapses to a short notice when no geometry is available, so a
    // missing bridge does not leave 420 px of empty chart on the page.
    this.container.classList.add('is-empty');
    this.empty.hidden = false;
    this.empty.textContent = text;
  }

  fit() {
    this.zoom = 1;
    this.panX = 0;
    this.panY = 0;
    this.requestDraw();
  }

  zoomAt(clientX, clientY, factor) {
    const canvas = this.canvas;
    const rect = canvas.getBoundingClientRect();
    const x = clientX == null ? rect.width / 2 : clientX - rect.left;
    const y = clientY == null ? rect.height / 2 : clientY - rect.top;
    const before = this.unproject(x, y);
    this.zoom = clamp(this.zoom * factor, 0.6, 9);
    const after = this.unproject(x, y);
    if (before && after) {
      this.panX += (after.x - before.x) * this.scale;
      this.panY -= (after.y - before.y) * this.scale;
    }
    this.requestDraw();
  }

  transform() {
    const canvas = this.canvas;
    const width = canvas.clientWidth || 1;
    const height = canvas.clientHeight || 1;
    const bounds = this.bounds || { width: 1000, height: 1000, minX: 0, maxX: 0, minY: 0, maxY: 0 };
    const pad = 26;
    const scale = Math.min((width - pad * 2) / bounds.width, (height - pad * 2) / bounds.height) * this.zoom;
    const cx = (bounds.minX + bounds.maxX) / 2;
    const cy = (bounds.minY + bounds.maxY) / 2;
    return { width, height, scale, cx, cy };
  }

  project(point) {
    const { width, height, scale, cx, cy } = this.transform();
    return { x: width / 2 + (point.x - cx) * scale + this.panX, y: height / 2 - (point.y - cy) * scale + this.panY };
  }

  unproject(x, y) {
    const { width, height, scale, cx, cy } = this.transform();
    if (!this.scale) this.scale = scale;
    return { x: (x - width / 2 - this.panX) / scale + cx, y: -(y - height / 2 - this.panY) / scale + cy };
  }

  requestDraw() {
    if (this.destroyed || this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.draw();
    });
  }

  updateRoute() {
    if (!this.position) {
      this.route = null;
      this.routeTarget = null;
      return;
    }
    const target = runwayTarget(this.ways, this.position, this.runway);
    if (!target) {
      this.route = null;
      this.routeTarget = null;
      return;
    }
    this.routeTarget = target;
    this.route = taxiRoute(this.ways, this.position, { lat: target.lat, lon: target.lon }, { preferRunway: true });
    this.requestDraw();
  }

  setPosition(position) {
    if (!position || !Number.isFinite(Number(position.lat)) || !Number.isFinite(Number(position.lon))) return;
    this.position = { lat: Number(position.lat), lon: Number(position.lon), hdg: Number(position.hdg) };
    this.updateRoute();
    this.requestDraw();
  }

  setRunway(designator) {
    const next = String(designator || '');
    if (next === this.runway) return;
    this.runway = next;
    this.updateRoute();
    this.requestDraw();
  }

  pickWay(event) {
    if (!this.local.length) return null;
    const rect = this.canvas.getBoundingClientRect();
    const px = event.clientX - rect.left;
    const py = event.clientY - rect.top;
    let best = null;
    let bestDistance = 9;
    for (const way of this.local) {
      if (!['runway', 'taxiway', 'taxilane'].includes(way.type)) continue;
      for (let i = 1; i < way.points.length; i += 1) {
        const a = this.project(way.points[i - 1]);
        const b = this.project(way.points[i]);
        const distance = distanceToSegment(px, py, a.x, a.y, b.x, b.y);
        if (distance < bestDistance) { bestDistance = distance; best = way; }
      }
    }
    return best;
  }

  showWayTip(way, event) {
    if (!this.tip) return;
    const label = way.ref || (way.type === 'runway' ? 'Runway' : 'Taxiway');
    this.tip.hidden = false;
    this.tip.innerHTML = `<b>${esc(label)}</b><span>${esc(way.type)}${way.ref ? '' : ' · no ref charted'}</span>`;
    const rect = this.canvas.getBoundingClientRect();
    this.tip.style.left = `${clamp(event.clientX - rect.left + 14, 8, Math.max(8, rect.width - 150))}px`;
    this.tip.style.top = `${clamp(event.clientY - rect.top - 10, 8, Math.max(8, rect.height - 60))}px`;
  }

  hideTip() {
    if (this.tip) this.tip.hidden = true;
  }

  draw() {
    if (this.destroyed || !this.ways.length) return;
    const canvas = this.canvas;
    const width = canvas.clientWidth || 0;
    const height = canvas.clientHeight || 0;
    if (!width || !height) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = '#060b12';
    ctx.fillRect(0, 0, width, height);
    this.scale = this.transform().scale;

    const byType = { apron: [], terminal: [], taxiway: [], taxilane: [], runway: [] };
    for (const way of this.local) if (byType[way.type]) byType[way.type].push(way);

    const pathFor = way => {
      ctx.beginPath();
      way.points.forEach((point, index) => {
        const p = this.project(point);
        index ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y);
      });
    };

    // Surfaces first: aprons and terminals sit under the movement lines.
    for (const way of byType.apron) {
      pathFor(way);
      ctx.closePath();
      ctx.fillStyle = 'rgba(146, 162, 184, .16)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(203, 213, 225, .32)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    for (const way of byType.terminal) {
      pathFor(way);
      ctx.closePath();
      ctx.fillStyle = 'rgba(34, 211, 238, .14)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(34, 211, 238, .42)';
      ctx.lineWidth = 1.2;
      ctx.stroke();
    }

    const taxiStyle = (way, selected) => {
      pathFor(way);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.strokeStyle = selected ? this.accent : 'rgba(226, 232, 240, .55)';
      ctx.lineWidth = 7.4;
      ctx.stroke();
      pathFor(way);
      ctx.strokeStyle = selected ? 'rgba(8, 47, 58, .92)' : '#4a5664';
      ctx.lineWidth = 4.8;
      ctx.stroke();
      pathFor(way);
      ctx.strokeStyle = selected ? '#e0fbff' : 'rgba(241, 245, 249, .5)';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 5]);
      ctx.stroke();
      ctx.setLineDash([]);
    };

    for (const way of [...byType.taxilane, ...byType.taxiway]) {
      taxiStyle(way, way === this.selected);
    }

    // Runways: casing, asphalt, centreline, threshold bars.
    for (const way of byType.runway) {
      pathFor(way);
      ctx.strokeStyle = 'rgba(241, 245, 249, .68)';
      ctx.lineWidth = 13.5;
      ctx.lineCap = 'butt';
      ctx.stroke();
      pathFor(way);
      ctx.strokeStyle = '#414d5c';
      ctx.lineWidth = 10.5;
      ctx.stroke();
      pathFor(way);
      ctx.strokeStyle = 'rgba(248, 250, 252, .9)';
      ctx.lineWidth = 1.4;
      ctx.setLineDash([12, 9]);
      ctx.stroke();
      ctx.setLineDash([]);
      const ends = [way.points[0], way.points[way.points.length - 1]];
      const other = [way.points[way.points.length - 1], way.points[0]];
      ends.forEach((end, index) => {
        const a = this.project(end);
        const b = this.project(other[index]);
        const angle = Math.atan2(b.y - a.y, b.x - a.x);
        const normal = angle + Math.PI / 2;
        const half = 4.2;
        ctx.strokeStyle = 'rgba(226, 232, 240, .85)';
        ctx.lineWidth = 1.4;
        for (let bar = -2; bar <= 2; bar += 1) {
          const offset = (bar * half) / 2;
          const cx = a.x + Math.cos(normal) * offset + Math.cos(angle) * 6;
          const cy = a.y + Math.sin(normal) * offset + Math.sin(angle) * 6;
          ctx.beginPath();
          ctx.moveTo(cx + Math.cos(normal) * 2.2, cy + Math.sin(normal) * 2.2);
          ctx.lineTo(cx - Math.cos(normal) * 2.2, cy - Math.sin(normal) * 2.2);
          ctx.stroke();
        }
      });
    }

    if (this.route && this.route.path.length > 1) {
      ctx.beginPath();
      this.route.path.forEach((point, index) => {
        const p = this.project(point);
        index ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y);
      });
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.strokeStyle = 'rgba(34, 211, 238, .25)';
      ctx.lineWidth = 9;
      ctx.stroke();
      ctx.strokeStyle = this.accent;
      ctx.lineWidth = 2.6;
      ctx.stroke();
    }

    // Labels: only refs the ways carry, placed once each, and never overlapping.
    const placed = [];
    const labels = [];
    const routeRefs = new Set(this.route ? this.route.refs : []);
    for (const way of [...byType.taxiway, ...byType.taxilane]) {
      if (!way.ref) continue;
      let best = null;
      for (let i = 1; i < way.points.length; i += 1) {
        const a = this.project(way.points[i - 1]);
        const b = this.project(way.points[i]);
        const length = Math.hypot(b.x - a.x, b.y - a.y);
        if (!best || length > best.length) best = { length, x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      }
      if (best && best.length >= 18) labels.push({ text: way.ref, x: best.x, y: best.y, route: routeRefs.has(way.ref), type: 'taxi' });
    }
    for (const way of byType.runway) {
      if (!way.ref) continue;
      const parts = way.ref.split('/');
      const ends = [way.points[0], way.points[way.points.length - 1]];
      const toward = [way.points[way.points.length - 1], way.points[0]];
      ends.forEach((end, index) => {
        const p = this.project(end);
        const q = this.project(toward[index]);
        const angle = Math.atan2(q.y - p.y, q.x - p.x) + Math.PI / 2;
        const bearing = bearingDegrees(end, toward[index]);
        const number = Math.round(bearing / 10) % 36;
        const match = parts.find(part => Number(String(part).replace(/\D/g, '')) === (number === 0 ? 36 : number));
        labels.push({ text: match || parts[index] || way.ref, x: p.x + Math.cos(angle) * 16, y: p.y + Math.sin(angle) * 16, route: false, type: 'runway' });
      });
    }

    labels.sort((a, b) => Number(b.route) - Number(a.route));
    ctx.font = '700 10px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const label of labels) {
      const text = String(label.text);
      const w = ctx.measureText(text).width + 10;
      const h = 15;
      const rect = { x: label.x - w / 2, y: label.y - h / 2, w, h };
      if (rect.x < 4 || rect.y < 4 || rect.x + rect.w > width - 4 || rect.y + rect.h > height - 4) continue;
      if (placed.some(other => rect.x < other.x + other.w + 4 && rect.x + rect.w + 4 > other.x && rect.y < other.y + other.h + 3 && rect.y + rect.h + 3 > other.y)) continue;
      placed.push(rect);
      ctx.fillStyle = label.route ? 'rgba(8, 47, 58, .92)' : 'rgba(5, 10, 17, .84)';
      ctx.strokeStyle = label.route ? this.accent : 'rgba(148, 163, 184, .32)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.roundRect(rect.x, rect.y, rect.w, rect.h, 3);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = label.route ? '#dffbff' : '#e2e8f0';
      ctx.fillText(text, label.x, label.y + 0.5);
    }
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';

    // The live aircraft, drawn last so it is never hidden by a surface.
    if (this.position) {
        const p = this.project(this.localFromLatLon(this.position));
      if (p.x > -30 && p.x < width + 30 && p.y > -30 && p.y < height + 30) {
        ctx.save();
        ctx.translate(p.x, p.y);
        if (Number.isFinite(this.position.hdg)) ctx.rotate((this.position.hdg * Math.PI) / 180);
        ctx.beginPath();
        ctx.arc(0, 0, 9, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(4, 9, 15, .75)';
        ctx.fill();
        ctx.beginPath();
        ctx.moveTo(0, -8);
        ctx.lineTo(5.4, 7);
        ctx.lineTo(0, 4.2);
        ctx.lineTo(-5.4, 7);
        ctx.closePath();
        ctx.fillStyle = '#e0fbff';
        ctx.fill();
        ctx.strokeStyle = '#050b12';
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.restore();
      }
    }

    if (this.routeTarget) {
      const target = this.project(this.localFromLatLon(this.routeTarget));
      ctx.strokeStyle = 'rgba(34, 211, 238, .8)';
      ctx.lineWidth = 1.4;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.arc(target.x, target.y, 8, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  localFromLatLon(point) {
    if (!this.origin) return { x: 0, y: 0 };
    return {
      x: (point.lon - this.origin.lon) * 111320 * Math.cos((this.origin.lat * Math.PI) / 180),
      y: (point.lat - this.origin.lat) * 110540,
    };
  }

  destroy() {
    this.destroyed = true;
    if (this.frame) cancelAnimationFrame(this.frame);
    if (this.watch) this.watch.disconnect();
    const canvas = this.canvas;
    canvas.removeEventListener('wheel', this.onWheel);
    canvas.removeEventListener('pointerdown', this.onDown);
    canvas.removeEventListener('pointermove', this.onMove);
    canvas.removeEventListener('pointerup', this.onUp);
    canvas.removeEventListener('pointercancel', this.onUp);
    canvas.removeEventListener('pointerleave', this.onLeave);
    this.hideTip();
  }
}
