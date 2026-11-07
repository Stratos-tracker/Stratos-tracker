/* The 3D track overlay for the Navigator.
 *
 * It draws the recorded track the map already holds; it never records, replays
 * or estimates a path of its own. Orbit is pointer drag, zoom is the wheel, and
 * hovering or tapping a sample states the altitude, height above ground, time
 * and vertical trend that the bridge recorded for it.
 */

import { altitudeInk, pickTrackPoint, projectTrack, trackHeight, verticalTrend } from '../lib/track3d.js';

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function fmtAlt(feet) {
  const value = Number(feet);
  if (!Number.isFinite(value)) return '—';
  return `${Math.round(value).toLocaleString('en-US')} ft`;
}

function fmtClock(stamp) {
  const value = Number(stamp);
  if (!Number.isFinite(value) || value <= 0) return '';
  const date = new Date(value < 1e12 ? value * 1000 : value);
  return `${String(date.getUTCHours()).padStart(2, '0')}:${String(date.getUTCMinutes()).padStart(2, '0')}:${String(date.getUTCSeconds()).padStart(2, '0')}Z`;
}

export class Track3DView {
  constructor(canvas, tip, { accent = '#22d3ee', leftTilt = true, ownMarker = false } = {}) {
    this.canvas = canvas;
    this.tip = tip;
    this.track = [];
    this.accent = accent;
    this.leftTilt = leftTilt !== false;
    this.ownMarker = Boolean(ownMarker);
    this.yaw = 0.62;
    this.pitch = 0.34;
    this.zoom = 1;
    this.projection = null;
    this.hover = null;
    this.selected = null;
    this.pinned = false;
    this.drag = null;
    this.frame = 0;
    this.destroyed = false;

    this.onDown = event => {
      // Right-drag is the map-mode pitch control; a left drag moves the view.
      if (event.button != null && event.button !== 0 && event.button !== 2) return;
      event.preventDefault();
      this.canvas.setPointerCapture?.(event.pointerId);
      this.drag = { x: event.clientX, y: event.clientY, moved: 0, right: event.button === 2 };
    };
    this.onMove = event => {
      const rect = this.canvas.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      if (this.drag) {
        const dx = event.clientX - this.drag.x;
        const dy = event.clientY - this.drag.y;
        this.drag.moved += Math.abs(dx) + Math.abs(dy);
        this.drag.x = event.clientX;
        this.drag.y = event.clientY;
        if (this.drag.right) {
          this.pitch = clamp(this.pitch + dy * 0.004, -0.15, 1.2);
        } else {
          this.yaw += dx * 0.006;
          if (this.leftTilt) this.pitch = clamp(this.pitch + dy * 0.004, -0.15, 1.2);
        }
        this.pinned = false;
        this.requestDraw();
        return;
      }
      const point = this.pick(x, y);
      this.hover = point;
      this.requestDraw();
      if (point) this.showTip(point);
      else if (!this.pinned) this.hideTip();
    };
    this.onUp = event => {
      const wasDrag = this.drag && this.drag.moved > 4;
      this.drag = null;
      if (wasDrag) return;
      const rect = this.canvas.getBoundingClientRect();
      const point = this.pick(event.clientX - rect.left, event.clientY - rect.top);
      this.selected = point || null;
      this.pinned = Boolean(point);
      if (point) this.showTip(point); else this.hideTip();
      this.requestDraw();
    };
    this.onLeave = () => {
      this.hover = null;
      if (!this.pinned) this.hideTip();
      this.requestDraw();
    };
    this.onWheel = event => {
      event.preventDefault();
      const direction = event.deltaY > 0 ? 0.9 : 1.1;
      this.zoom = clamp(this.zoom * direction, 0.4, 4.5);
      this.requestDraw();
    };

    canvas.addEventListener('pointerdown', this.onDown);
    canvas.addEventListener('pointermove', this.onMove);
    canvas.addEventListener('pointerup', this.onUp);
    canvas.addEventListener('pointercancel', this.onUp);
    canvas.addEventListener('pointerleave', this.onLeave);
    this.onContext = event => event.preventDefault();
    canvas.addEventListener('wheel', this.onWheel, { passive: false });
    canvas.addEventListener('contextmenu', this.onContext);
  }

  setTrack(points) {
    this.track = Array.isArray(points) ? points : [];
    if (this.selected && this.selected.index >= this.track.length) { this.selected = null; this.pinned = false; this.hideTip(); }
    this.requestDraw();
  }

  setAccent(accent) {
    this.accent = accent || this.accent;
    this.requestDraw();
  }

  resize() {
    this.requestDraw();
  }

  requestDraw() {
    if (this.destroyed || this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.draw();
    });
  }

  pick(x, y) {
    return this.projection ? pickTrackPoint(this.projection.points, x, y, 16) : null;
  }

  showTip(point) {
    if (!this.tip || !point) return;
    const trend = verticalTrend(this.projection ? this.projection.points : this.track, point.index);
    const agl = point.agl != null ? `AGL ${fmtAlt(point.agl)}` : 'AGL not recorded';
    const clock = fmtClock(point.t);
    this.tip.hidden = false;
    this.tip.innerHTML = `<b>${fmtAlt(point.alt)}</b><span>${agl}</span>${clock ? `<span>${clock}${trend ? ` · ${trend.label}` : ''}</span>` : trend ? `<span>${trend.label}</span>` : ''}`;
    const width = this.canvas.clientWidth || 1;
    const left = clamp(point.x + 16, 10, Math.max(10, width - 168));
    this.tip.style.left = `${left}px`;
    this.tip.style.top = `${clamp(point.y - 10, 8, (this.canvas.clientHeight || 1) - 70)}px`;
  }

  hideTip() {
    if (this.tip) this.tip.hidden = true;
  }

  draw() {
    if (this.destroyed) return;
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

    const background = ctx.createLinearGradient(0, 0, 0, height);
    background.addColorStop(0, '#08111b');
    background.addColorStop(1, '#04080d');
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, width, height);

    const projection = projectTrack(this.track, {
      width, height, yaw: this.yaw, pitch: this.pitch, zoom: this.zoom, pad: 42,
    });
    this.projection = projection;
    if (!projection.points.length) {
      ctx.fillStyle = 'rgba(148, 163, 184, .8)';
      ctx.font = '600 13px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('No recorded track yet', width / 2, height / 2 - 8);
      ctx.font = '12px system-ui, sans-serif';
      ctx.fillStyle = 'rgba(148, 163, 184, .55)';
      ctx.fillText('The path appears here as soon as the bridge records positions.', width / 2, height / 2 + 12);
      ctx.textAlign = 'left';
      return;
    }

    // Ground plane: a faint grid on the surface the track climbed away from.
    const { bounds, toScreen, minAlt } = projection;
    if (bounds && toScreen) {
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(148, 163, 184, .13)';
      const steps = 4;
      for (let i = 0; i <= steps; i += 1) {
        const f = i / steps;
        const lat = bounds.minLat + (bounds.maxLat - bounds.minLat) * f;
        const lon = bounds.minLon + (bounds.maxLon - bounds.minLon) * f;
        const a = toScreen(bounds.minLat, lon, minAlt);
        const b = toScreen(bounds.maxLat, lon, minAlt);
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
        const c = toScreen(lat, bounds.minLon, minAlt);
        const d = toScreen(lat, bounds.maxLon, minAlt);
        ctx.beginPath(); ctx.moveTo(c.x, c.y); ctx.lineTo(d.x, d.y); ctx.stroke();
      }
    }

    // Vertical drop lines tie the path to the ground and make the profile legible.
    const every = Math.max(1, Math.round(projection.points.length / 18));
    ctx.setLineDash([3, 4]);
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(34, 211, 238, .22)';
    projection.points.forEach((point, index) => {
      if (index % every !== 0 || index === projection.points.length - 1) return;
      const ground = toScreen(point.lat, point.lon, minAlt);
      ctx.beginPath(); ctx.moveTo(point.x, point.y); ctx.lineTo(ground.x, ground.y); ctx.stroke();
    });
    ctx.setLineDash([]);

    const drawPath = () => {
      ctx.beginPath();
      ctx.moveTo(projection.points[0].x, projection.points[0].y);
      for (let i = 1; i < projection.points.length; i += 1) {
        const prev = projection.points[i - 1];
        const point = projection.points[i];
        const mx = (prev.x + point.x) / 2;
        const my = (prev.y + point.y) / 2;
        ctx.quadraticCurveTo(prev.x, prev.y, mx, my);
      }
      const last = projection.points[projection.points.length - 1];
      ctx.lineTo(last.x, last.y);
    };

    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    drawPath();
    ctx.strokeStyle = 'rgba(2, 8, 14, .8)';
    ctx.lineWidth = 6;
    ctx.stroke();

    const ceiling = Math.max(1, projection.ceiling);
    let runStart = 0;
    let runInk = null;
    const strokeRun = to => {
      ctx.beginPath();
      for (let i = Math.max(1, runStart); i <= to; i += 1) {
        const a = projection.points[i - 1];
        const b = projection.points[i];
        if (i === Math.max(1, runStart)) ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
      }
      ctx.strokeStyle = runInk;
      ctx.lineWidth = 2.4;
      ctx.stroke();
    };
    for (let i = 1; i < projection.points.length; i += 1) {
      const ink = altitudeInk(trackHeight(projection.points[i], bounds) / ceiling);
      if (ink !== runInk) {
        if (runInk) strokeRun(i);
        runStart = i; runInk = ink;
      }
    }
    if (runInk && projection.points.length > 1) strokeRun(projection.points.length - 1);
    ctx.restore();

    const start = projection.points[0];
    const end = projection.points[projection.points.length - 1];
    if (this.ownMarker) {
      // A small aircraft-shaped marker at the latest recorded point, so the 3D
      // view reads as the same flight as the map below it.
      ctx.save();
      ctx.translate(end.x, end.y);
      ctx.fillStyle = this.accent;
      ctx.beginPath();
      ctx.moveTo(0, -7);
      ctx.lineTo(2, -1);
      ctx.lineTo(9, 2);
      ctx.lineTo(9, 4);
      ctx.lineTo(2, 3);
      ctx.lineTo(2, 7);
      ctx.lineTo(4, 9);
      ctx.lineTo(0, 8);
      ctx.lineTo(-4, 9);
      ctx.lineTo(-2, 7);
      ctx.lineTo(-2, 3);
      ctx.lineTo(-9, 4);
      ctx.lineTo(-9, 2);
      ctx.lineTo(-2, -1);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
    ctx.fillStyle = '#34d399';
    ctx.beginPath(); ctx.arc(start.x, start.y, 3.4, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = this.accent;
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(end.x, end.y, 5.5, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = 'rgba(34, 211, 238, .35)';
    ctx.beginPath(); ctx.arc(end.x, end.y, 2.4, 0, Math.PI * 2); ctx.fill();

    // Recorded samples: a dot when the recording is short enough to read.
    if (projection.points.length <= 240) {
      ctx.fillStyle = 'rgba(207, 250, 254, .55)';
      for (const point of projection.points) {
        ctx.beginPath(); ctx.arc(point.x, point.y, 1.1, 0, Math.PI * 2); ctx.fill();
      }
    }

    const marked = this.hover || this.selected;
    if (marked) {
      ctx.strokeStyle = '#e0fbff';
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(marked.x, marked.y, 6.5, 0, Math.PI * 2); ctx.stroke();
    }

    const ratio = projection.exaggeration > 0 && (projection.exaggeration < 0.95 || projection.exaggeration > 1.05)
      ? `vertical ×${projection.exaggeration.toFixed(1)}`
      : 'vertical true scale';
    ctx.fillStyle = 'rgba(148, 163, 184, .8)';
    ctx.font = '600 10.5px system-ui, sans-serif';
    ctx.fillText(`ALT ${fmtAlt(projection.minAlt)} – ${fmtAlt(projection.maxAlt)}`, 14, 20);
    ctx.fillStyle = 'rgba(148, 163, 184, .5)';
    ctx.font = '10.5px system-ui, sans-serif';
    ctx.fillText(`${ratio} · drag to orbit · wheel to zoom · hover a point for altitude`, 14, 35);
  }

  destroy() {
    this.destroyed = true;
    if (this.frame) cancelAnimationFrame(this.frame);
    const canvas = this.canvas;
    canvas.removeEventListener('pointerdown', this.onDown);
    canvas.removeEventListener('pointermove', this.onMove);
    canvas.removeEventListener('pointerup', this.onUp);
    canvas.removeEventListener('pointercancel', this.onUp);
    canvas.removeEventListener('pointerleave', this.onLeave);
    canvas.removeEventListener('wheel', this.onWheel);
    canvas.removeEventListener('contextmenu', this.onContext);
    this.hideTip();
  }
}
