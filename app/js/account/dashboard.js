/* The signed-in Stratos dashboard.
 *
 * It renders only what the service returns: totals from the D1 logbook, the
 * live snapshot from the account's Durable Object, aircraft summed from real
 * flights. Nothing is estimated. When a request fails the panel says so and the
 * last good numbers stay on screen rather than being replaced by zeros.
 */

import * as api from './api.js';
import { LiveFeed, startPublisher, findBridge, LIVE_STALE_MS } from './live.js';
import { startBridgePresence, startAutoConnect } from './discovery.js';
import {
  $, $$, showAlert, hideAlert, setBusy, guard, goTo, paintAvatar, brandMark,
  formatHours, formatDuration, formatNumber, formatDate, timeAgo,
  shrinkImage, passwordScore, strengthLabel,
} from './ui.js';

const S = {
  user: null,
  data: null,
  feed: null,
  stopPublisher: null,
  bridge: null,
  lastLive: null,
  syncing: false,
  pendingAvatar: null,
};

const errorBox = $('#dash-error');
const okBox = $('#dash-ok');

function fail(message) {
  showAlert(errorBox, 'bad', message);
  hideAlert(okBox);
}

function okay(message, link) {
  showAlert(okBox, 'ok', message, link);
  hideAlert(errorBox);
}

for (const slot of $$('[data-brand-mark]')) slot.innerHTML = brandMark();

// ── Rendering ────────────────────────────────────────────────────────
function paintUser(user) {
  paintAvatar($('[data-avatar]'), user);
  paintAvatar($('[data-avatar-lg]'), user);
  const name = $('[data-username]');
  const email = $('[data-email]');
  if (name) name.textContent = user.username || 'Stratos pilot';
  if (email) email.textContent = user.email || '';

  const verify = $('[data-verify-chip]');
  if (verify) {
    verify.hidden = false;
    verify.className = `chip ${user.emailVerified ? 'chip--ok' : 'chip--warn'}`;
    verify.replaceChildren();
    verify.append(document.createTextNode(user.emailVerified ? 'Email confirmed' : 'Email not confirmed'));
    if (!user.emailVerified) {
      const resend = document.createElement('button');
      resend.type = 'button';
      resend.className = 'field__toggle';
      resend.style.position = 'static';
      resend.style.padding = '0 0 0 6px';
      resend.textContent = 'Resend';
      resend.addEventListener('click', async () => {
        resend.disabled = true;
        try {
          const result = await api.resendVerification();
          okay(result?.sent ? 'Confirmation email sent.' : 'Email delivery is not configured; the link is below.', result?.devLink);
        } catch (error) {
          fail(error.message);
        } finally {
          resend.disabled = false;
        }
      });
      verify.appendChild(resend);
    }
  }

  const since = $('[data-member-since]');
  if (since && user.createdAt) since.textContent = `Member since ${formatDate(user.createdAt)}`;

  const host = $('[data-api-host]');
  if (host) {
    try { host.textContent = new URL(api.apiBase()).host; } catch (_) { host.textContent = 'account service'; }
  }

  const emailField = $('#profile-email');
  if (emailField) emailField.value = user.email || '';
  const userField = $('#profile-username');
  if (userField) userField.value = user.username || '';
}

function emptyState(title, detail, action) {
  const box = document.createElement('div');
  box.className = 'empty';
  if (title) {
    const head = document.createElement('b');
    head.textContent = title;
    box.appendChild(head);
  }
  const text = document.createElement('span');
  text.textContent = detail;
  box.appendChild(text);
  if (action) {
    const link = document.createElement('a');
    link.className = 'btn btn--sm btn--ghost';
    link.href = action.href;
    link.textContent = action.label;
    box.appendChild(link);
  }
  return box;
}

function paintTotals(data) {
  const totals = data.totals || {};
  const set = (key, value) => {
    const node = $(`[data-kpi="${key}"]`);
    if (node) node.textContent = value;
  };
  set('flights', formatNumber(totals.flights || 0));
  set('hours', formatHours(totals.seconds || 0));
  set('distance', formatNumber(totals.distanceNm || 0));
  set('viewers', formatNumber((data.live && data.live.viewers) || 0));
}

function paintRecent(flights) {
  const host = $('#recent-body');
  if (!host) return;
  host.replaceChildren();
  const list = Array.isArray(flights) ? flights.slice(0, 8) : [];
  if (!list.length) {
    host.appendChild(emptyState('Your logbook is empty', 'Fly once with the bridge running and the flight appears here, on every device.', { href: 'logbook.html', label: 'Open logbook' }));
    return;
  }
  const rows = document.createElement('div');
  rows.className = 'rows';
  for (const flight of list) {
    const row = document.createElement('div');
    row.className = 'row';

    const badge = document.createElement('div');
    badge.className = 'row__badge';
    const dep = String(flight.depAirport || '----').toUpperCase();
    const arr = String(flight.arrAirport || '----').toUpperCase();
    badge.textContent = `${dep} → ${arr}`;

    const main = document.createElement('div');
    main.className = 'row__main';
    const title = document.createElement('b');
    title.textContent = flight.aircraft || flight.aircraftType || 'Flight';
    const when = document.createElement('span');
    const stamp = flight.landingTime || flight.takeoffTime || flight.startTime;
    when.textContent = `${formatDate(stamp)}${flight.incomplete ? ' · incomplete' : ''}`;
    main.append(title, when);

    const right = document.createElement('div');
    right.className = 'row__right';
    const distance = document.createElement('b');
    distance.textContent = flight.distanceNm ? `${formatNumber(flight.distanceNm)} nm` : '—';
    const duration = document.createElement('span');
    duration.textContent = flight.seconds ? formatDuration(flight.seconds) : '';
    right.append(distance, duration);

    row.append(badge, main, right);
    rows.appendChild(row);
  }
  host.appendChild(rows);
}

function paintAircraft(aircraft) {
  const host = $('#aircraft-body');
  if (!host) return;
  host.replaceChildren();
  const list = Array.isArray(aircraft) ? aircraft.filter(entry => entry && (entry.type || entry.aircraft)) : [];
  if (!list.length) {
    host.appendChild(emptyState(null, 'No aircraft flown yet.'));
    return;
  }
  const most = Math.max(...list.map(entry => Number(entry.flights) || 0), 1);
  const bars = document.createElement('div');
  bars.className = 'bars';
  for (const entry of list.slice(0, 6)) {
    const label = entry.type || entry.aircraft;
    const bar = document.createElement('div');
    bar.className = 'bar';

    const head = document.createElement('div');
    head.className = 'bar__label';
    const name = document.createElement('b');
    name.textContent = label;
    const meta = document.createElement('span');
    const hours = entry.seconds ? ` · ${formatHours(entry.seconds)} h` : '';
    meta.textContent = `${formatNumber(entry.flights || 0)} flights${hours}`;
    head.append(name, meta);

    const track = document.createElement('div');
    track.className = 'bar__track';
    const fill = document.createElement('i');
    fill.style.width = `${Math.max(4, Math.round(((Number(entry.flights) || 0) / most) * 100))}%`;
    track.appendChild(fill);

    bar.append(head, track);
    bars.appendChild(bar);
  }
  host.appendChild(bars);
}

/** A heading dial is honest at a glance and needs no basemap to invent. */
function headingDial(heading) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 100 100');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', `Heading ${Math.round(heading || 0)} degrees`);
  const ring = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  ring.setAttribute('cx', '50');
  ring.setAttribute('cy', '50');
  ring.setAttribute('r', '44');
  ring.setAttribute('fill', 'none');
  ring.setAttribute('stroke', 'rgba(148,163,178,.22)');
  ring.setAttribute('stroke-width', '1');
  svg.appendChild(ring);
  for (let tick = 0; tick < 36; tick++) {
    const angle = (tick * 10 * Math.PI) / 180;
    const long = tick % 9 === 0;
    const outer = 44;
    const inner = long ? 36 : 40;
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', String(50 + Math.sin(angle) * outer));
    line.setAttribute('y1', String(50 - Math.cos(angle) * outer));
    line.setAttribute('x2', String(50 + Math.sin(angle) * inner));
    line.setAttribute('y2', String(50 - Math.cos(angle) * inner));
    line.setAttribute('stroke', long ? 'rgba(148,163,178,.55)' : 'rgba(148,163,178,.22)');
    line.setAttribute('stroke-width', long ? '1.4' : '.8');
    svg.appendChild(line);
  }
  const needle = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  needle.setAttribute('transform', `rotate(${Number(heading) || 0} 50 50)`);
  const point = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  point.setAttribute('d', 'M50 18 L56 56 L50 50 L44 56 Z');
  point.setAttribute('fill', 'var(--a-acc)');
  needle.appendChild(point);
  svg.appendChild(needle);
  return svg;
}

function liveCell(label, value) {
  const cell = document.createElement('div');
  cell.className = 'live__cell';
  const number = document.createElement('b');
  number.textContent = value;
  const caption = document.createElement('span');
  caption.textContent = label;
  cell.append(number, caption);
  return cell;
}

function paintLive(snapshot, { stale = false } = {}) {
  const host = $('#live-body');
  const chip = $('[data-live-state]');
  const liveChip = $('[data-live-chip]');
  if (!host) return;

  if (!snapshot) {
    host.replaceChildren(emptyState(
      'Nothing live right now',
      'Start the bridge and fly on your PC. This card fills in by itself, on this device and every other one.',
      { href: 'index.html', label: 'Open Flight Deck' },
    ));
    if (chip) { chip.className = 'chip'; chip.textContent = 'No live flight'; }
    if (liveChip) liveChip.hidden = true;
    return;
  }

  const telemetry = snapshot.telemetry || {};
  const route = snapshot.route || {};
  const aircraft = snapshot.aircraft || {};
  host.replaceChildren();

  const wrap = document.createElement('div');
  wrap.className = 'live';

  const map = document.createElement('div');
  map.className = 'live__map';
  map.appendChild(headingDial(telemetry.hdg));
  wrap.appendChild(map);

  const grid = document.createElement('div');
  grid.className = 'live__grid';
  const round = (value, suffix = '') => (value == null ? '—' : `${Math.round(Number(value)).toLocaleString('en-US')}${suffix}`);
  grid.append(
    liveCell('Altitude ft', round(telemetry.alt)),
    liveCell('Ground speed kt', round(telemetry.gs)),
    liveCell('Heading', round(telemetry.hdg, '°')),
    liveCell('Vertical speed', round(telemetry.vs, ' fpm')),
  );
  wrap.appendChild(grid);

  const meta = document.createElement('p');
  meta.className = 'set-note';
  const phase = snapshot.phase ? String(snapshot.phase) : 'AIRBORNE';
  const who = snapshot.callsign || aircraft.registration || aircraft.type || 'This flight';
  meta.textContent = `${who} · ${phase}${stale ? ' · last seen ' + timeAgo(snapshot.seenAt) : ''}`;
  wrap.appendChild(meta);

  if (route.dep || route.dest) {
    const line = document.createElement('div');
    line.className = 'live__route';
    const dep = document.createElement('span');
    dep.textContent = route.dep || '----';
    const bar = document.createElement('i');
    const fill = document.createElement('b');
    const progress = Number.isFinite(Number(route.progress)) ? Math.max(0, Math.min(1, Number(route.progress))) : null;
    fill.style.width = `${progress == null ? 0 : Math.round(progress * 100)}%`;
    bar.appendChild(fill);
    const dest = document.createElement('span');
    dest.textContent = route.dest || '----';
    line.append(dep, bar, dest);
    wrap.appendChild(line);
    if (progress != null) {
      const note = document.createElement('p');
      note.className = 'set-note';
      const remaining = route.remainingNm ? ` · ${formatNumber(route.remainingNm)} nm to go` : '';
      const eta = route.etaMinutes ? ` · ${formatDuration(route.etaMinutes * 60)} left` : '';
      note.textContent = `${Math.round(progress * 100)}% complete${remaining}${eta}`;
      wrap.appendChild(note);
    }
  }

  const coords = document.createElement('p');
  coords.className = 'set-note';
  coords.textContent = `${Number(telemetry.lat).toFixed(3)}, ${Number(telemetry.lon).toFixed(3)}`;
  wrap.appendChild(coords);

  const open = document.createElement('a');
  open.className = 'btn btn--sm btn--ghost';
  open.href = 'index.html';
  open.textContent = 'Open on the Flight Deck';
  wrap.appendChild(open);

  host.appendChild(wrap);

  if (chip) {
    chip.className = stale ? 'chip chip--warn' : 'chip chip--live';
    chip.textContent = stale ? 'Stale' : 'Live';
  }
  if (liveChip) liveChip.hidden = stale;
}

function paintLiveStatus(status) {
  const host = $('[data-live-state]');
  if (!host || !status) return;
  if (status.state === 'connected') {
    if (S.lastLive) { host.className = 'chip chip--live'; host.textContent = 'Live'; }
    return;
  }
  if (status.state === 'polling') return;
  if (status.state === 'signed-out') {
    host.className = 'chip chip--warn';
    host.textContent = 'Signed out';
    return;
  }
  if (status.state === 'offline' || status.state === 'reconnecting') {
    host.className = 'chip chip--warn';
    host.textContent = 'Reconnecting…';
  }
}

// ── Live feed ────────────────────────────────────────────────────────
function applyFrame(frame) {
  if (!frame) return;
  const snapshot = frame.snapshot || null;
  const stale = Boolean(frame.stale) || (frame.updatedAt && Date.now() - Number(frame.updatedAt) > LIVE_STALE_MS);
  S.lastLive = snapshot;
  paintLive(snapshot, { stale });

  const viewers = $('[data-kpi="viewers"]');
  if (viewers) viewers.textContent = formatNumber(frame.viewers || 0);

  const chip = $('[data-live-chip]');
  if (chip && snapshot && !stale) chip.hidden = false;
}

function startFeed() {
  S.feed = new LiveFeed({
    onState: frame => applyFrame(frame),
    onStatus: status => paintLiveStatus(status),
  });
  S.feed.start();
}

async function startPublishing() {
  const toggle = $('#pref-live');
  if (toggle && !toggle.checked) return;
  const bridge = await findBridge();
  S.bridge = bridge;
  if (!bridge) return;
  S.stopPublisher = startPublisher(bridge.base, {
    onProblem: message => {
      const chip = $('[data-live-state]');
      if (chip && message) { chip.className = 'chip chip--warn'; chip.textContent = message.slice(0, 42); }
    },
  });
}

// ── Data loading ─────────────────────────────────────────────────────
async function syncLogbook({ quiet = true } = {}) {
  if (S.syncing) return;
  S.syncing = true;
  const chip = $('[data-sync-chip]');
  const note = $('#sync-note');
  if (chip) { chip.hidden = false; chip.className = 'chip'; chip.textContent = 'Syncing logbook…'; }
  try {
    const store = await import('../lib/store.js');
    let localCount = 0;
    if (typeof store.getFlights === 'function') {
      const local = await store.getFlights();
      if (Array.isArray(local) && local.length) {
        localCount = local.length;
        await api.syncFlights(local);
      }
    }
    const remote = await api.getFlights();
    const flights = Array.isArray(remote.flights) ? remote.flights : [];
    if (flights.length && typeof store.mergeFlights === 'function') {
      await store.mergeFlights(flights);
    }
    if (chip) {
      chip.className = 'chip chip--ok';
      chip.textContent = flights.length ? `${formatNumber(flights.length)} flights in sync` : 'Logbook in sync';
    }
    if (note) note.textContent = `${formatNumber(localCount)} sent · ${formatNumber(flights.length)} on the account`;
  } catch (error) {
    if (chip) { chip.className = 'chip chip--warn'; chip.textContent = 'Logbook not synced'; }
    if (note) note.textContent = error.message;
    if (!quiet) fail(error.message);
  } finally {
    S.syncing = false;
  }
}

async function loadPrefs() {
  try {
    const payload = await api.getPrefs();
    const prefs = payload.prefs || {};
    const live = $('#pref-live');
    const resources = $('#pref-resources');
    if (live && typeof prefs.livePublish === 'boolean') live.checked = prefs.livePublish;
    if (resources && prefs.resourceMode) resources.value = prefs.resourceMode;
  } catch (_) {
    // A preferences read failure must not stop the dashboard.
  }
}

async function loadSessions() {
  const host = $('#sessions-body');
  if (!host) return;
  try {
    const payload = await api.listSessions();
    const sessions = Array.isArray(payload.sessions) ? payload.sessions : [];
    host.replaceChildren();
    if (!sessions.length) {
      host.appendChild(emptyState(null, 'No other devices are signed in.'));
      return;
    }
    for (const session of sessions) {
      const row = document.createElement('div');
      row.className = 'row';

      const badge = document.createElement('div');
      badge.className = 'row__badge';
      badge.textContent = session.current ? 'THIS' : 'DEVICE';

      const main = document.createElement('div');
      main.className = 'row__main';
      const title = document.createElement('b');
      title.textContent = session.label || session.device || 'Signed-in device';
      const when = document.createElement('span');
      const seen = session.lastSeenAt || session.lastUsedAt || session.createdAt;
      when.textContent = seen ? `Last used ${timeAgo(seen)}` : 'Active';
      main.append(title, when);

      const right = document.createElement('div');
      right.className = 'row__right';
      if (session.current) {
        const tag = document.createElement('b');
        tag.textContent = 'This device';
        right.appendChild(tag);
      } else {
        const revoke = document.createElement('button');
        revoke.type = 'button';
        revoke.className = 'btn btn--sm btn--ghost';
        revoke.textContent = 'Sign out';
        revoke.addEventListener('click', async () => {
          revoke.disabled = true;
          try {
            await api.revokeSession(session.id || session.sessionId || session.token);
            await loadSessions();
            okay('That device is signed out.');
          } catch (error) {
            fail(error.message);
          } finally {
            revoke.disabled = false;
          }
        });
        right.appendChild(revoke);
      }

      row.append(badge, main, right);
      host.appendChild(row);
    }
  } catch (error) {
    host.replaceChildren(emptyState(null, error.message));
  }
}

async function loadDashboard() {
  const button = $('[data-refresh]');
  setBusy(button, true, 'Refreshing…');
  try {
    const data = await api.dashboard();
    S.data = data;
    if (data.user) {
      S.user = { ...S.user, ...data.user };
      paintUser(S.user);
    }
    paintTotals(data);
    paintRecent(data.recent);
    paintAircraft(data.aircraft);
    if (data.live) applyFrame({ type: 'state', ...data.live });
  } catch (error) {
    fail(error.message);
  } finally {
    setBusy(button, false);
  }
}

// ── Interaction ──────────────────────────────────────────────────────
for (const button of $$('[data-toggle-password]')) {
  button.addEventListener('click', () => {
    const input = document.getElementById(button.dataset.togglePassword);
    if (!input) return;
    const reveal = input.type === 'password';
    input.type = reveal ? 'text' : 'password';
    button.textContent = reveal ? 'Hide' : 'Show';
  });
}

const strengthBox = $('#strength');
const newPassword = $('#new-password');
if (strengthBox && newPassword) {
  const label = $('#strength-label');
  newPassword.addEventListener('input', () => {
    const score = passwordScore(newPassword.value);
    strengthBox.dataset.score = String(score);
    if (label) label.textContent = newPassword.value ? strengthLabel(score) : 'At least 10 characters';
  });
}

$('[data-refresh]')?.addEventListener('click', async () => {
  await loadDashboard();
  await syncLogbook();
});

$('[data-signout]')?.addEventListener('click', async () => {
  S.feed?.stop();
  if (S.stopPublisher) S.stopPublisher();
  try { await api.logout(); } catch (_) { /* the token is cleared regardless */ }
  goTo('login.html');
});

$('#avatar-pick')?.addEventListener('click', () => $('#avatar-input')?.click());
document.querySelector('[data-avatar-pick]')?.addEventListener('click', () => $('#avatar-input')?.click());

$('#avatar-input')?.addEventListener('change', async event => {
  const file = event.target.files && event.target.files[0];
  if (!file) return;
  try {
    S.pendingAvatar = await shrinkImage(file, 160);
    paintAvatar($('[data-avatar]'), { ...S.user, avatar: S.pendingAvatar });
    paintAvatar($('[data-avatar-lg]'), { ...S.user, avatar: S.pendingAvatar });
    okay('Picture ready. Save the profile to apply it.');
  } catch (error) {
    fail(error.message);
  }
});

document.querySelector('[data-avatar-clear]')?.addEventListener('click', async () => {
  S.pendingAvatar = '';
  paintAvatar($('[data-avatar]'), S.user);
  paintAvatar($('[data-avatar-lg]'), S.user);
  try {
    const result = await api.updateAccount({ avatar: '' });
    if (result.user) { S.user = result.user; paintUser(S.user); }
    okay('Profile picture removed.');
  } catch (error) {
    fail(error.message);
  }
});

$('#profile-form')?.addEventListener('submit', async event => {
  event.preventDefault();
  const button = $('#profile-save');
  const username = String($('#profile-username')?.value || '').trim();
  if (username.length < 2) return fail('Choose a username of at least 2 characters.');
  setBusy(button, true, 'Saving…');
  try {
    const changes = { username };
    if (S.pendingAvatar !== null) changes.avatar = S.pendingAvatar;
    const result = await api.updateAccount(changes);
    if (result.user) S.user = result.user;
    S.pendingAvatar = null;
    paintUser(S.user);
    okay('Profile saved.');
  } catch (error) {
    fail(error.message);
  } finally {
    setBusy(button, false);
  }
});

$('#password-form')?.addEventListener('submit', async event => {
  event.preventDefault();
  const button = $('#password-save');
  const current = String($('#cur-password')?.value || '');
  const next = String(newPassword?.value || '');
  const repeat = String($('#new-password2')?.value || '');
  if (!current) return fail('Enter your current password.');
  if (next.length < 10) return fail('Use at least 10 characters for the new password.');
  if (next !== repeat) return fail('The two new passwords do not match.');
  setBusy(button, true, 'Changing…');
  try {
    await api.changePassword({ current, next });
    $('#password-form').reset();
    if (strengthBox) strengthBox.dataset.score = '0';
    okay('Password changed. Other devices were signed out.');
    await loadSessions();
  } catch (error) {
    fail(error.message);
  } finally {
    setBusy(button, false);
  }
});

$('#pref-save')?.addEventListener('click', async () => {
  const button = $('#pref-save');
  const prefs = {
    livePublish: Boolean($('#pref-live')?.checked),
    resourceMode: String($('#pref-resources')?.value || 'auto'),
  };
  setBusy(button, true, 'Saving…');
  try {
    await api.putPrefs(prefs);
    try { localStorage.setItem('stratos.resourceMode', prefs.resourceMode); } catch (_) { /* private mode */ }
    const store = await import('../lib/store.js');
    if (typeof store.setSetting === 'function') await store.setSetting('resourceMode', prefs.resourceMode);
    okay('Preferences saved. They follow you to every device.');
    if (prefs.livePublish && !S.stopPublisher) startPublishing();
    if (!prefs.livePublish && S.stopPublisher) { S.stopPublisher(); S.stopPublisher = null; }
  } catch (error) {
    fail(error.message);
  } finally {
    setBusy(button, false);
  }
});

$('#sync-now')?.addEventListener('click', async () => {
  await syncLogbook({ quiet: false });
  await loadDashboard();
});

$('#signout-all')?.addEventListener('click', async () => {
  const button = $('#signout-all');
  setBusy(button, true, 'Signing out…');
  try {
    const payload = await api.listSessions();
    const sessions = Array.isArray(payload.sessions) ? payload.sessions : [];
    for (const session of sessions) {
      const id = session.id || session.sessionId;
      if (id) { try { await api.revokeSession(id); } catch (_) { /* already gone */ } }
    }
    S.feed?.stop();
    if (S.stopPublisher) S.stopPublisher();
    await api.logout();
  } catch (_) {
    api.forgetToken();
  } finally {
    goTo('login.html');
  }
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  if (S.feed && S.feed.stopped) S.feed.start();
  loadDashboard();
});

// ── Start ────────────────────────────────────────────────────────────
async function boot() {
  const user = await guard({ signedIn: true });
  if (!user) return;
  S.user = user;
  const bootScreen = $('#boot');
  const dash = $('#dash');
  if (bootScreen) bootScreen.hidden = true;
  if (dash) dash.hidden = false;
  paintUser(user);

  await loadPrefs();
  await loadDashboard();
  await syncLogbook();
  await loadSessions();
  startFeed();
  startPublishing();
  // On a PC this publishes the bridge's LAN address to the account; on a tablet
  // it opens the discovered PC map without asking for an address or a tap.
  startBridgePresence();
  startAutoConnect();
}

boot();
