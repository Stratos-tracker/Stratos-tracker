/* EFB · Performance.
 *
 *   Airframe  the bundled profile, detected from X-Plane or chosen by hand.
 *   Inputs    airport, runway, weight and weather, prefilled from the plan,
 *             X-Plane and the METAR; every value editable.
 *   Estimate  recomputed as you type (lib/perfmodel.js): V1/VR/V2, FLEX and
 *             flaps for takeoff; VAPP, autobrake and stopping point for
 *             landing, drawn on a to-scale runway with the wind on it.
 *
 * Weight limits come from the profile source; every speed and distance is a
 * Stratos estimate for simulator use, and the page says so.
 */

import {
  airportByCode, airportRunways, currentPlan, esc, fmtAge, fmtFt, fmtNum,
  liveStatus, loadPrefs, loadRouteMeta, loadWbUplink, onLive, weatherFor,
} from './common.js';
import { loadDatabase, profileById, profileLabel } from '../lib/performance-db.js';
import { matchAircraft } from '../lib/aircraft-match.js';
import { convertWeight, evaluatePhase } from '../lib/aircraftperformance.js';
import { parseMetar } from '../lib/routeweather.js';
import { autobrakes, estimateLanding, estimateTakeoff, family, landingFlaps, takeoffFlaps } from '../lib/perfmodel.js';

// 09L -> 27R: the far end of the same strip.
function opposite(id) {
  const m = /^(\d{1,2})([LRC]?)$/.exec(String(id || ''));
  if (!m) return '';
  const n = ((Number(m[1]) + 17) % 36) + 1;
  return String(n).padStart(2, '0') + ({ L: 'R', R: 'L', C: 'C' }[m[2]] || '');
}

function numberOrNull(value) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function timestampOf(value) {
  const number = Number(value);
  if (Number.isFinite(number) && number > 0) return number < 1e12 ? number * 1000 : number;
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function headingValue(row) {
  return row && numberOrNull(row.heading) != null ? String(row.heading) : '';
}

/* Match the planned runway to a real end. A suffix (16L) is used when the
 * source publishes it. A numeric snapshot cannot identify a parallel strip,
 * so a number shared by several runways is never guessed: the page asks. */
export function matchRunwayEnd(rows, planned) {
  const wanted = String(planned || '').trim().toUpperCase();
  if (!wanted) return { row: null, message: '' };
  const exact = rows.filter(row => String(row.id).trim().toUpperCase() === wanted);
  if (exact.length === 1) return { row: exact[0], message: '' };
  if (exact.length > 1) {
    return { row: null, message: `The plan names runway ${wanted}, but the airport record lists ${exact.length} runways with that identifier. Choose the one in use.` };
  }
  const number = wanted.replace(/[A-Z]$/, '');
  const sameNumber = rows.filter(row => String(row.id).trim().toUpperCase() === number);
  if (sameNumber.length === 1 && wanted === number) return { row: sameNumber[0], message: '' };
  if (sameNumber.length === 1) {
    return { row: null, message: `The plan names runway ${wanted}, but the airport record publishes only ${number}, without a parallel suffix. Choose the runway in use.` };
  }
  return {
    row: null,
    message: sameNumber.length > 1
      ? `The plan names runway ${wanted}, but the airport record lists ${sameNumber.length} parallel runways numbered ${number} and does not publish the suffix. Choose the one in use.`
      : `The plan names runway ${wanted}, which is not in the airport record. Choose one.`,
  };
}

/* A physical runway has two ends. The airport helper returns one row per pair
 * (08/26), so both ends are offered here with their own headings; otherwise a
 * plan that names 26 would be flown at 080°.
 *
 * Runway data from the simulator names the parallel strip (16L/34R); the
 * bundled snapshot sometimes carries only the numbers (16/34). Those are kept
 * as separate choices, marked ambiguous, because three physical runways cannot
 * honestly be collapsed into one "16". */
export function runwayEnds(rows) {
  const ends = [];
  const seen = new Set();
  for (const row of rows) {
    const heading = numberOrNull(row.heading);
    if (heading == null) continue;
    const [first, second] = String(row.id || '').split('/');
    for (const [id, endHeading] of [[first, heading], [second, (heading + 180) % 360]]) {
      if (!id) continue;
      const key = `${id}|${endHeading}|${row.lengthFt || ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      ends.push({ key: String(ends.length + 1), id, heading: endHeading, lengthFt: row.lengthFt || null });
    }
  }
  const counts = {};
  for (const end of ends) counts[end.id] = (counts[end.id] || 0) + 1;
  return ends.map(end => ({ ...end, ambiguous: counts[end.id] > 1 }));
}

export async function mount(root, ctx) {
  let destroyed = false;
  const prefs = loadPrefs();
  const unit = prefs.units === 'lb' ? 'lb' : 'kg';
  const plan = currentPlan();
  const ofp = plan && plan.ofp;
  const builtPlan = loadRouteMeta().plan;

  const state = {
    database: null,
    dbError: '',
    phase: 'takeoff',
    profileId: '',
    manualProfile: false,
    airport: '',
    airportName: '',
    airportMissing: false,
    elevationFt: '',
    qnhHpa: '',
    oatC: '',
    windFromDeg: '',
    windKt: '',
    gustKt: '',
    weight: '',
    runway: '',
    runwayLengthFt: '',
    prefill: {},
    manual: {},
    runwayRows: [],
    runwayMissing: '',
    weatherAt: 0,
    metarRaw: '',
    windVariable: false,
    detected: null,
    live: null,
    liveSignature: '',
    calculation: null,
    estimate: null,
    opts: { toFlaps: 'auto', thrust: 'auto', surface: 'dry', ldgFlaps: '', autobrake: '' },
    contextSeq: 0,
  };

  /* A SimBrief plan is used when one is stored. Without it, the route built in
   * the Flight Planner names its own airports and runways, so the page works
   * from that flight rather than asking for the airport a second time. */
  function phaseLeg() {
    if (ofp) return state.phase === 'landing' ? ofp.destination : ofp.origin;
    if (!builtPlan) return null;
    return state.phase === 'landing' ? builtPlan.destination : builtPlan.origin;
  }

  function phaseAirport() {
    const leg = phaseLeg();
    const code = leg && (leg.icao || leg.id);
    return String(code || '').trim().toUpperCase();
  }

  function phaseRunway() {
    const leg = phaseLeg();
    if (leg && leg.rwy) return String(leg.rwy).trim().toUpperCase();
    if (ofp) return '';
    const rwy = builtPlan && (state.phase === 'landing' ? builtPlan.arrivalRwy : builtPlan.departureRwy);
    return String(rwy || '').trim().toUpperCase();
  }

  function planWeightKg() {
    if (!ofp || !ofp.weights) return null;
    const value = state.phase === 'landing' ? ofp.weights.lw : ofp.weights.tow;
    return numberOrNull(value) != null ? convertWeight(value, ofp.units || 'kg', 'kg') : null;
  }

  function displayWeight(kg) {
    return kg == null ? '' : String(Math.round(convertWeight(kg, 'kg', unit)));
  }

  function setPrefill(key, value, source) {
    state[key] = value;
    state.prefill[key] = source;
  }

  function clearPhaseFields() {
    for (const key of ['airportName', 'elevationFt', 'qnhHpa', 'oatC', 'windFromDeg', 'windKt', 'gustKt', 'runway', 'runwayLengthFt']) {
      state[key] = '';
    }
    state.airport = '';
    state.airportMissing = false;
    state.weight = '';
    state.prefill = {};
    state.manual = {};
    state.runwayRows = [];
    state.runwayMissing = '';
    state.weatherAt = 0;
    state.metarRaw = '';
    state.windVariable = false;
    state.calculation = null;
  }

  // A load sheet uplinked from Weight & Balance outranks the plan's weights.
  function wbWeightKg() {
    const wb = loadWbUplink();
    const value = wb && (state.phase === 'landing' ? wb.lwKg : wb.towKg);
    return numberOrNull(value);
  }

  function loadPlanPhase() {
    clearPhaseFields();
    state.airport = phaseAirport();
    const wb = wbWeightKg();
    const kg = planWeightKg();
    if (wb != null) setPrefill('weight', displayWeight(wb), 'W&B');
    else if (kg != null) setPrefill('weight', displayWeight(kg), 'flight plan');
  }

  function simPerformance() {
    return state.live && state.live.performance ? state.live.performance : null;
  }

  function applySimulatorFields() {
    const sim = simPerformance();
    if (!sim) return;
    const simWeight = numberOrNull(sim.weightKg);
    if (simWeight != null && !state.manual.weight) {
      if (wbWeightKg() == null && (state.phase === 'takeoff' || planWeightKg() == null)) {
        setPrefill('weight', displayWeight(simWeight), 'X-Plane');
      }
    }
    const qnh = numberOrNull(sim.qnhHpa);
    if (qnh != null && !state.manual.qnhHpa) setPrefill('qnhHpa', String(Math.round(qnh)), 'X-Plane');
  }

  function airportRunwayRows() {
    return state.runwayRows;
  }

  function adoptRunway(row) {
    if (!state.manual.runway) state.runway = row.key;
    if (!state.manual.runwayLengthFt && row.lengthFt) setPrefill('runwayLengthFt', String(row.lengthFt), 'airport database');
  }

  function matchPlannedRunway() {
    // A runway belongs to the airport the plan names. After the pilot types a
    // different airport, its runway is not a fact about this one.
    const planned = state.airport === phaseAirport() ? phaseRunway() : '';
    const match = matchRunwayEnd(airportRunwayRows(), planned);
    state.runwayMissing = match.message;
    if (match.row) adoptRunway(match.row);
  }

  async function hydratePhase() {
    const token = ++state.contextSeq;
    const code = String(state.airport || '').trim().toUpperCase();
    state.airport = code;
    state.airportName = '';
    state.airportMissing = false;
    state.runwayRows = [];
    if (!code) {
      state.runwayMissing = '';
      if (!destroyed && token === state.contextSeq) render();
      return;
    }

    const airport = await airportByCode(code).catch(() => null);
    if (destroyed || token !== state.contextSeq) return;
    if (airport) {
      state.airportName = String(airport.name || '');
      state.runwayRows = runwayEnds(airportRunways(airport));
      const elevation = numberOrNull(airport.elev);
      if (elevation != null && !state.manual.elevationFt) setPrefill('elevationFt', String(Math.round(elevation)), 'airport database');
      matchPlannedRunway();
    } else {
      state.runwayRows = [];
      state.airportMissing = true;
    }
    // The airport record is local; weather is not. Draw the elevation, runway
    // and length as soon as they are known instead of holding them behind a
    // network request.
    if (!destroyed && token === state.contextSeq) render();

    const weather = await weatherFor(code).catch(() => null);
    if (destroyed || token !== state.contextSeq) return;
    const metar = weather && weather.metar ? parseMetar(weather.metar) : null;
    if (metar) {
      state.metarRaw = weather.metar;
      state.weatherAt = timestampOf((weather.decoded && weather.decoded.obs_time) || weather.obs_time || weather.fetchedAt);
      if (metar.temperatureC != null && !state.manual.oatC) setPrefill('oatC', String(metar.temperatureC), 'METAR');
      if (metar.altimeter != null && !state.manual.qnhHpa && state.prefill.qnhHpa !== 'X-Plane') {
        const qnh = metar.altimeterUnit === 'inHg' ? metar.altimeter * 33.8639 : metar.altimeter;
        setPrefill('qnhHpa', String(Math.round(qnh)), 'METAR');
      }
      if (metar.wind) {
        state.windVariable = metar.wind.direction == null;
        if (metar.wind.direction != null && !state.manual.windFromDeg) setPrefill('windFromDeg', String(metar.wind.direction), 'METAR');
        if (metar.wind.speedKt != null && !state.manual.windKt) setPrefill('windKt', String(metar.wind.speedKt), 'METAR');
        if (metar.wind.gustKt != null && !state.manual.gustKt) setPrefill('gustKt', String(metar.wind.gustKt), 'METAR');
      }
    }
    applySimulatorFields();
    if (!destroyed && token === state.contextSeq) render();
  }

  function profile() {
    return profileById(state.database, state.profileId);
  }

  function detect() {
    const health = liveStatus().health;
    const identity = (health && health.xplaneIdentity) || {};
    const stored = (health && health.identity) || {};
    const snapshot = liveStatus().snapshot || {};
    const telemetry = snapshot.telemetry || snapshot.parsed || {};
    const description = String(stored.aircraft || telemetry.aircraft || '').trim();
    const type = String(identity.type || telemetry.aircraftType || '').trim();
    const match = matchAircraft(state.database, { icaoType: type, description });
    state.detected = { ...match, type, description };
    if (!state.manualProfile) {
      if (match.profile) {
        if (state.profileId !== match.profile.id) {
          state.profileId = match.profile.id;
          state.calculation = null;
        }
      } else if (type) {
        // X-Plane now reports a type the database does not cover. Keeping the
        // previous airframe's profile would silently calculate for the wrong
        // aircraft; clear it and let the page say the type is unsupported.
        state.profileId = '';
        state.calculation = null;
      }
    }
  }

  function applyLive(status) {
    if (destroyed || !state.database) return;
    const health = status && status.health;
    const identity = (health && health.xplaneIdentity) || {};
    const performance = (health && health.xplanePerformance) || null;
    const stored = (health && health.identity) || {};
    // The performance inputs are a pre-takeoff snapshot. Fuel burn changes the
    // simulated weight every refresh; re-rendering the whole page for that would
    // move the fields under the pilot. Only a new airframe re-runs detection and
    // prefill. The latest values are still kept for the next phase switch.
    const signature = JSON.stringify({
      type: identity.type || '',
      description: stored.aircraft || '',
      available: Boolean(identity.available),
    });
    state.live = { performance };
    if (signature !== state.liveSignature) {
      state.liveSignature = signature;
      detect();
      applySimulatorFields();
      render();
    }
  }

  /* ── Inputs ─────────────────────────────────────────────────────── */

  function field(key, label, value, options = {}) {
    const source = state.prefill[key] ? `<span class="pf-src">${esc(state.prefill[key])}</span>` : '';
    return `<label class="pf-field${options.wide ? ' wide' : ''}">
      <span class="pf-label">${esc(label)}${source}</span>
      <span class="pf-input"><input id="perf-${key}" data-key="${key}" inputmode="decimal" value="${esc(value)}" placeholder="${esc(options.placeholder || '—')}" autocomplete="off">${options.unit ? `<i>${esc(options.unit)}</i>` : ''}</span>
    </label>`;
  }

  function seg(name, label, items, value) {
    return `<div class="pf-field wide"><span class="pf-label">${esc(label)}</span>
      <div class="e-seg pf-seg" role="group" aria-label="${esc(label)}">${items.map(([id, text]) => `<button type="button" data-opt="${name}" data-val="${esc(id)}" aria-pressed="${id === value}">${esc(text)}</button>`).join('')}</div></div>`;
  }

  function aircraftCard() {
    const detected = state.detected;
    const current = profile();
    const live = liveStatus();
    const detectedHere = Boolean(detected && detected.profile && current && detected.profile.id === current.id);
    const line = detectedHere ? `Detected from X-Plane · ${detected.reason}`
      : current ? (state.manualProfile ? 'Chosen by hand' : 'Selected')
        : live.status === 'offline' ? 'The Stratos bridge is offline, so no airframe can be detected. Choose a profile.'
          : detected && detected.type ? detected.reason : 'Choose the aircraft you are flying.';
    return `<section class="pf-card">
      <header class="pf-card-head"><b>Aircraft</b><span class="e-badge ${detectedHere ? 'good' : current ? 'accent' : 'warn'}">${detectedHere ? 'Detected' : current ? 'Selected' : 'None'}</span></header>
      <select class="e-select" id="perf-profile">
        <option value="">Choose an aircraft…</option>
        ${(state.database ? state.database.profiles : []).map(item => `<option value="${esc(item.id)}" ${item.id === state.profileId ? 'selected' : ''}>${esc(profileLabel(item))} · ${esc(item.icao)}</option>`).join('')}
      </select>
      <div class="pf-note">${esc(line)}</div>
      ${state.manualProfile && detected && detected.profile && detected.profile.id !== state.profileId
        ? `<button class="e-btn small" type="button" data-use-detected>Use detected ${esc(profileLabel(detected.profile))}</button>` : ''}
    </section>`;
  }

  function inputsCard() {
    const current = profile();
    const takeoff = state.phase === 'takeoff';
    const runwayOptions = ['<option value="">Runway…</option>', ...state.runwayRows.map(row => `<option value="${esc(row.key)}" ${row.key === state.runway ? 'selected' : ''}>${esc(row.id)} · ${esc(headingValue(row))}°${row.lengthFt ? ` · ${fmtNum(row.lengthFt)} ft` : ''}${row.ambiguous ? ' · suffix?' : ''}</option>`)].join('');
    let options = '';
    if (current) {
      const opt = state.opts;
      options = takeoff
        ? seg('toFlaps', family(current) === 'airbus' ? 'Config' : 'Flaps', [['auto', 'Auto'], ...takeoffFlaps(current).map(f => [f.id, f.id])], opt.toFlaps)
          + seg('thrust', 'Thrust', [['auto', family(current) === 'airbus' ? 'FLEX' : 'Assumed'], ['toga', family(current) === 'airbus' ? 'TOGA' : 'Full']], opt.thrust)
        : seg('ldgFlaps', family(current) === 'airbus' ? 'Config' : 'Flaps', landingFlaps(current).map(f => [f.id, f.id]), opt.ldgFlaps || landingFlaps(current)[0].id)
          + seg('autobrake', 'Autobrake', autobrakes(current).map(([id]) => [id, id]), opt.autobrake || defaultBrake(current));
      options += seg('surface', 'Runway', [['dry', 'Dry'], ['wet', 'Wet']], opt.surface);
    }
    return `<section class="pf-card">
      <header class="pf-card-head">
        <div class="e-seg pf-phase" role="group" aria-label="Phase">
          <button type="button" data-phase="takeoff" aria-pressed="${takeoff}">Takeoff</button>
          <button type="button" data-phase="landing" aria-pressed="${!takeoff}">Landing</button>
        </div>
      </header>
      <div class="pf-grid">
        <label class="pf-field"><span class="pf-label">Airport</span>
          <span class="pf-input"><input id="perf-airport" value="${esc(state.airport)}" placeholder="ICAO" autocomplete="off" spellcheck="false" maxlength="4"></span></label>
        <label class="pf-field"><span class="pf-label">Runway</span>
          <select class="e-select pf-select" id="perf-runway">${runwayOptions}</select></label>
        ${state.airportName || state.airportMissing || state.runwayMissing ? `<div class="pf-note wide">${esc(state.airportMissing ? 'Unknown airport · enter elevation and runway length.' : state.runwayMissing || state.airportName)}</div>` : ''}
        ${field('runwayLengthFt', takeoff ? 'TORA' : 'LDA', state.runwayLengthFt, { unit: 'ft' })}
        ${field('elevationFt', 'Elevation', state.elevationFt, { unit: 'ft' })}
        ${field('weight', takeoff ? 'Takeoff weight' : 'Landing weight', state.weight, { unit, wide: true })}
        ${field('oatC', 'OAT', state.oatC, { unit: '°C' })}
        ${field('qnhHpa', 'QNH', state.qnhHpa, { unit: 'hPa' })}
        ${field('windFromDeg', 'Wind', state.windFromDeg, { unit: '°' })}
        ${field('windKt', 'Speed', state.windKt, { unit: 'kt' })}
        ${field('gustKt', 'Gust', state.gustKt, { unit: 'kt' })}
        ${options}
      </div>
      ${state.weatherAt ? `<div class="pf-note">Weather from the METAR observed ${esc(fmtAge(state.weatherAt))}${state.metarRaw ? `<details><summary>Raw</summary>${esc(state.metarRaw)}</details>` : ''}</div>` : ''}
    </section>`;
  }

  /* ── Graphics ───────────────────────────────────────────────────── */

  const flagSvg = (x, top, text, sub, tone = '#f59e0b') => `
    <line x1="${x}" y1="${top}" x2="${x}" y2="122" stroke="${tone}" stroke-width="2"/>
    <path d="M${x} ${top} h62 l-11 13 l11 13 h-62 z" fill="${tone}"/>
    <text x="${x + 6}" y="${top + 18}" class="pf-flag-t">${esc(text)}</text>
    <text x="${x + 70}" y="${top + 18}" class="pf-flag-s">${esc(sub)}</text>`;

  function runwaySvg(est, takeoff) {
    const end = state.runwayRows.find(row => row.key === state.runway);
    const lengthFt = numberOrNull(state.runwayLengthFt) || 0;
    const needFt = takeoff ? est.requiredFt : est.factoredFt;
    const total = Math.max(lengthFt, needFt, takeoff ? est.todrFt : est.stopFt) * 1.06 || 1;
    const x0 = 40, span = 900;
    const X = ft => x0 + (ft / total) * span;
    const xEnd = X(lengthFt || needFt);
    const y = 122, h = 52, cy = y + h / 2;
    const ids = end ? [end.id, opposite(end.id)] : ['', ''];
    const keys = Array.from({ length: 8 }, (_, i) => `<rect x="${x0 + 5}" y="${y + 5 + i * 5.6}" width="22" height="3" fill="#e5e7eb"/><rect x="${xEnd - 27}" y="${y + 5 + i * 5.6}" width="22" height="3" fill="#e5e7eb"/>`).join('');
    const dashes = [];
    for (let x = x0 + 70; x < xEnd - 70; x += 30) dashes.push(`<rect x="${x}" y="${cy - 1}" width="17" height="2" fill="#e5e7eb" opacity=".85"/>`);
    let marks = '';
    if (!takeoff) // From 1,000 ft: at this scale the 500 ft bars would sit on the runway numbers.
    for (const [ft, n, len] of [[1000, 1, 150], [1500, 2, 75], [2000, 2, 75], [2500, 1, 75], [3000, 1, 75]]) {
      if (ft >= (lengthFt || needFt) / 2) break;
      const w = Math.max(3, (len / total) * span), thick = len === 150 ? 6 : 3;
      for (let k = 0; k < n; k += 1) marks += `<rect x="${X(ft)}" y="${y + 7 + k * 5}" width="${w}" height="${thick}" fill="#e5e7eb"/><rect x="${X(ft)}" y="${y + h - 7 - thick - k * 5}" width="${w}" height="${thick}" fill="#e5e7eb"/>`;
    }
    const ticks = [];
    const step = total > 12000 ? 2000 : 1000;
    for (let ft = 0; ft <= total; ft += step) ticks.push(`<line x1="${X(ft)}" y1="239" x2="${X(ft)}" y2="245" class="pf-axis"/><text x="${X(ft)}" y="260" class="pf-tick">${ft ? `${ft / 1000}k` : '0'}</text>`);
    const margin = takeoff ? est.marginFt : est.marginFt;
    const short = margin != null && margin < 0;
    let overlay = '';
    if (takeoff) {
      const xv1 = X(est.v1Ft), xvr = X(est.vrFt), xlof = X(est.liftoffFt), xtod = X(est.todrFt), xasd = X(est.asdrFt);
      const vrOffset = xvr - xv1 < 72 ? 30 : 0;
      overlay = `
        <line x1="${x0}" y1="${cy}" x2="${xlof}" y2="${cy}" stroke="url(#pf-roll)" stroke-width="5" stroke-linecap="round"/>
        <path d="M${xlof} ${cy} C ${xlof + (xtod - xlof) * 0.5} ${cy}, ${xtod - 20} 60, ${xtod} 52" fill="none" stroke="var(--efb-accent)" stroke-width="2.5" stroke-dasharray="6 5"/>
        ${speedPin(xv1, 'V1', est.v1, 96)}${speedPin(xvr, 'VR', est.vr, 96 - vrOffset)}
        ${flagSvg(xtod, 18, '35 FT', `${fmtNum(est.todrFt)} ft`)}
        <line x1="${x0}" y1="198" x2="${xv1}" y2="198" stroke="var(--efb-muted)" stroke-width="2"/>
        <line x1="${xv1}" y1="198" x2="${xasd}" y2="198" stroke="#ef4444" stroke-width="2.5" stroke-dasharray="5 4"/>
        <path d="M${xasd} 191 l6 7 l-6 7 l-6 -7 z" fill="#ef4444"/>
        <text x="${Math.min(xasd, 900)}" y="222" class="pf-lab" text-anchor="middle">STOP ${fmtNum(est.asdrFt)} ft</text>`;
    } else {
      const xtd = X(est.touchdownFt), xstop = X(est.stopFt), xfac = X(est.factoredFt);
      overlay = `
        <path d="M${x0 - 30} 34 L${x0} ${y - 8} L${xtd} ${cy}" fill="none" stroke="var(--efb-accent)" stroke-width="2.5" stroke-dasharray="6 5"/>
        <text x="${x0 + 4}" y="${y - 14}" class="pf-lab">50 ft</text>
        <circle cx="${xtd}" cy="${cy}" r="5" fill="var(--efb-accent)"/>
        <line x1="${xtd}" y1="${cy}" x2="${xstop}" y2="${cy}" stroke="url(#pf-brake)" stroke-width="5" stroke-linecap="round"/>
        <text x="${xtd}" y="${y + h + 18}" class="pf-lab" text-anchor="middle">Touchdown ${fmtNum(est.touchdownFt)} ft</text>
        ${flagSvg(xstop, 30, 'STOP', `${fmtNum(est.stopFt)} ft`)}
        <line x1="${xfac}" y1="${y - 6}" x2="${xfac}" y2="${y + h + 30}" stroke="var(--efb-muted)" stroke-dasharray="3 3"/>
        <text x="${xfac}" y="${y + h + 44}" class="pf-lab" text-anchor="middle">×1.15 · ${fmtNum(est.factoredFt)} ft</text>`;
    }
    const xNeed = X(needFt);
    const marginBand = lengthFt && !short
      ? `<rect x="${xNeed}" y="${y}" width="${Math.max(0, xEnd - xNeed)}" height="${h}" fill="#22c55e" opacity=".16"/>
         <text x="${(xNeed + xEnd) / 2}" y="${y - 10}" class="pf-margin" text-anchor="middle">+${fmtNum(margin)} ft</text>`
      : short ? `<rect x="${xEnd}" y="${y}" width="${xNeed - xEnd}" height="${h}" fill="url(#pf-hatch)"/>
         <text x="${(xNeed + xEnd) / 2}" y="${y - 10}" class="pf-margin bad" text-anchor="middle">${fmtNum(-margin)} ft short</text>` : '';
    return `<svg class="pf-runway" viewBox="0 0 980 272" role="img" aria-label="Runway diagram">
      <defs>
        <linearGradient id="pf-roll" x1="0" x2="1"><stop offset="0" stop-color="#0ea5e9" stop-opacity=".25"/><stop offset="1" stop-color="#22d3ee"/></linearGradient>
        <linearGradient id="pf-brake" x1="0" x2="1"><stop offset="0" stop-color="#f59e0b"/><stop offset="1" stop-color="#ef4444"/></linearGradient>
        <pattern id="pf-hatch" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="8" height="8" fill="#ef4444" opacity=".15"/><rect width="3" height="8" fill="#ef4444" opacity=".55"/></pattern>
      </defs>
      <rect x="${x0}" y="${y}" width="${xEnd - x0}" height="${h}" rx="2" fill="#1c2128"/>
      <rect x="${x0 + 2}" y="${y + 2}" width="${xEnd - x0 - 4}" height="${h - 4}" fill="none" stroke="#e5e7eb" stroke-opacity=".6" stroke-width="1"/>
      ${keys}${dashes.join('')}${marks}
      ${ids[0] ? `<text transform="translate(${x0 + 44} ${cy}) rotate(90)" class="pf-rwy-id">${esc(ids[0])}</text>` : ''}
      ${ids[1] ? `<text transform="translate(${xEnd - 44} ${cy}) rotate(-90)" class="pf-rwy-id">${esc(ids[1])}</text>` : ''}
      ${marginBand}${overlay}
      <line x1="${x0}" y1="242" x2="${X(total)}" y2="242" class="pf-axis"/>${ticks.join('')}
      ${lengthFt ? `<text x="${x0}" y="${y + h + 46}" class="pf-lab">${takeoff ? 'TORA' : 'LDA'} ${fmtNum(lengthFt)} ft · ${fmtNum(Math.round(lengthFt * 0.3048))} m</text>` : ''}
    </svg>`;
  }

  const speedPin = (x, label, kt, top) => `
    <line x1="${x}" y1="${top + 14}" x2="${x}" y2="122" stroke="var(--efb-text)" stroke-opacity=".5"/>
    <rect x="${x - 34}" y="${top - 6}" width="68" height="24" rx="12" fill="#161b22" stroke="#334155"/>
    <text x="${x}" y="${top + 11}" class="pf-pin" text-anchor="middle">${label} ${kt}</text>`;

  function windSvg(wind) {
    if (!wind) return '<div class="pf-empty">Choose a runway and enter the wind.</div>';
    const r = 62, c = 80;
    const rad = deg => ((deg - 90) * Math.PI) / 180;
    const ticks = Array.from({ length: 36 }, (_, i) => {
      const a = rad(i * 10), long = i % 9 === 0, r1 = long ? r - 9 : r - 5;
      return `<line x1="${c + Math.cos(a) * r1}" y1="${c + Math.sin(a) * r1}" x2="${c + Math.cos(a) * r}" y2="${c + Math.sin(a) * r}" class="pf-axis"/>`;
    }).join('');
    const cardinal = [['N', 0], ['E', 90], ['S', 180], ['W', 270]].map(([t, d]) => `<text x="${c + Math.cos(rad(d)) * (r + 11)}" y="${c + Math.sin(rad(d)) * (r + 11) + 4}" class="pf-tick" text-anchor="middle">${t}</text>`).join('');
    const wa = rad(wind.windFrom);
    const tip = [c + Math.cos(wa) * 16, c + Math.sin(wa) * 16], tail = [c + Math.cos(wa) * (r - 4), c + Math.sin(wa) * (r - 4)];
    const head = wind.headwindKt >= 0;
    return `<svg class="pf-wind" viewBox="0 0 160 160" role="img" aria-label="Wind on the runway">
      <circle cx="${c}" cy="${c}" r="${r}" fill="none" class="pf-axis"/>${ticks}${cardinal}
      <g transform="rotate(${wind.runwayHeading} ${c} ${c})"><rect x="${c - 7}" y="${c - 44}" width="14" height="88" rx="2" fill="#1c2128" stroke="#e5e7eb" stroke-opacity=".5"/>
        <line x1="${c}" y1="${c - 36}" x2="${c}" y2="${c + 36}" stroke="#e5e7eb" stroke-dasharray="5 4" stroke-opacity=".8"/></g>
      <line x1="${tail[0]}" y1="${tail[1]}" x2="${tip[0]}" y2="${tip[1]}" stroke="${head ? 'var(--efb-accent)' : '#f59e0b'}" stroke-width="3.5" marker-end="url(#pf-arrow)"/>
      <defs><marker id="pf-arrow" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="4" markerHeight="4" orient="auto"><path d="M0 0 L10 5 L0 10 z" fill="${head ? 'var(--efb-accent)' : '#f59e0b'}"/></marker></defs>
    </svg>
    <div class="pf-wind-read">
      <div><span>${head ? 'Head' : 'Tail'}</span><b class="${head ? '' : 'warn'}">${Math.round(Math.abs(head ? wind.headwindKt : wind.tailwindKt))} kt</b></div>
      <div><span>Cross${wind.crosswindSide !== 'none' ? ` · ${wind.crosswindSide}` : ''}</span><b class="${wind.crosswindKt >= 25 ? 'warn' : ''}">${Math.round(wind.crosswindKt)} kt</b></div>
      <div><span>Wind</span><b>${String(wind.windFrom).padStart(3, '0')}°/${wind.speedKt}${wind.gustKt ? `G${wind.gustKt}` : ''}</b></div>
    </div>`;
  }

  function weightGauge(evaluation) {
    const limitKg = evaluation.phase === 'takeoff' ? profile().limits.mtowKg : profile().limits.mlwKg;
    const kg = evaluation.inputs.weightKg;
    const pct = Math.min(110, (kg / limitKg) * 100);
    const over = kg > limitKg;
    const show = v => fmtNum(Math.round(convertWeight(v, 'kg', unit)));
    return `<div class="pf-gauge">
      <div class="pf-gauge-top"><span>${evaluation.phase === 'takeoff' ? 'TOW' : 'LW'} ${show(kg)} ${unit}</span><span>${evaluation.phase === 'takeoff' ? 'MTOW' : 'MLW'} ${show(limitKg)}</span></div>
      <div class="pf-bar"><i class="${over ? 'bad' : pct > 95 ? 'warn' : ''}" style="width:${Math.min(100, pct / 1.1)}%"></i><b style="left:${100 / 1.1}%"></b></div>
      <div class="pf-gauge-foot ${over ? 'bad' : ''}">${over ? `${show(kg - limitKg)} ${unit} over the limit` : `${show(limitKg - kg)} ${unit} below the limit`}</div>
    </div>`;
  }

  /* ── Results ────────────────────────────────────────────────────── */

  function heroCard(est, takeoff, current) {
    const airbus = family(current) === 'airbus';
    if (takeoff) {
      const thrustTag = est.thrust === 'FLEX'
        ? `<span class="pf-tag flag">${airbus ? 'FLEX' : 'ASSUMED'} <b>${est.flexC}°</b></span>`
        : `<span class="pf-tag flag toga">${airbus ? 'TOGA' : 'FULL RATED'}</span>`;
      return `<div class="pf-hero">
        <div class="pf-speeds">${[['V1', est.v1, 'Decision'], ['VR', est.vr, 'Rotate'], ['V2', est.v2, 'Safety']].map(([k, v, s]) => `<div class="pf-speed"><span>${k}</span><b>${v}</b><i>${s}</i></div>`).join('')}</div>
        <div class="pf-tags">${thrustTag}<span class="pf-tag">${airbus ? 'CONF' : 'FLAPS'} <b>${esc(est.flaps)}</b></span></div>
      </div>`;
    }
    return `<div class="pf-hero">
      <div class="pf-speeds">
        <div class="pf-speed main"><span>VAPP</span><b>${est.vapp}</b><i>Approach · +${est.additive}</i></div>
        <div class="pf-speed"><span>${airbus ? 'VLS' : 'VREF'}</span><b>${est.vref}</b><i>${airbus ? 'Lowest selectable' : 'Reference'}</i></div>
      </div>
      <div class="pf-tags"><span class="pf-tag flag">AUTOBRAKE <b>${esc(est.autobrake)}</b></span><span class="pf-tag">${airbus ? 'CONF' : 'FLAPS'} <b>${esc(est.flaps)}</b></span></div>
    </div>`;
  }

  function statusStrip(est, takeoff) {
    const lengthFt = numberOrNull(state.runwayLengthFt);
    if (!lengthFt) return '<div class="pf-status warn">Enter the runway length to check the margin.</div>';
    if (!est.fits) return `<div class="pf-status bad"><b>NOT POSSIBLE</b> · needs ${fmtNum(takeoff ? est.requiredFt : est.factoredFt)} ft, the runway has ${fmtNum(lengthFt)} ft${takeoff ? ' — lower the weight, use more flap or a longer runway' : ' — use more autobrake, more flap or another runway'}</div>`;
    return `<div class="pf-status good"><b>${takeoff ? 'TAKEOFF' : 'LANDING'} OK</b> · ${fmtNum(est.marginFt)} ft of runway to spare</div>`;
  }

  function conditionsGrid(c) {
    const rows = [
      ['Press. alt', c.pressureAltitudeFt != null ? fmtFt(c.pressureAltitudeFt) : '—'],
      ['Density alt', c.densityAltitudeFt != null ? fmtFt(c.densityAltitudeFt) : '—'],
      ['ISA dev', c.isaDeviationC != null ? `${c.isaDeviationC > 0 ? '+' : ''}${c.isaDeviationC}°C` : '—'],
      ['QNH', state.qnhHpa ? `${state.qnhHpa} hPa` : '—'],
    ];
    return `<div class="pf-cond">${rows.map(([k, v]) => `<div><span>${k}</span><b>${esc(v)}</b></div>`).join('')}</div>`;
  }

  function missingInputs() {
    const missing = [];
    if (!profile()) missing.push('aircraft');
    if (numberOrNull(state.weight) == null || Number(state.weight) <= 0) missing.push('weight');
    if (numberOrNull(state.elevationFt) == null) missing.push('elevation');
    const qnh = numberOrNull(state.qnhHpa);
    if (qnh == null || qnh < 850 || qnh > 1085) missing.push('QNH');
    if (numberOrNull(state.oatC) == null) missing.push('OAT');
    return missing;
  }

  function outputHtml() {
    if (state.dbError) return `<section class="pf-card"><div class="e-notice bad"><div>${esc(state.dbError)}</div></div></section>`;
    if (!state.database) return '<section class="pf-card"><div class="pf-empty">Loading…</div></section>';
    const missing = missingInputs();
    if (missing.length) {
      return `<section class="pf-card pf-placeholder">
        <svg viewBox="0 0 240 60" class="pf-ph-rwy"><rect x="10" y="20" width="220" height="22" rx="2" fill="#1c2128"/>${Array.from({ length: 7 }, (_, i) => `<rect x="${40 + i * 25}" y="30" width="14" height="2" fill="#e5e7eb" opacity=".6"/>`).join('')}</svg>
        <b>Ready when you are</b><p>Still needed: ${esc(missing.join(', '))}. Everything else is optional; results update as you type.</p>
      </section>`;
    }
    const current = profile();
    const takeoff = state.phase === 'takeoff';
    const evaluation = state.calculation;
    const est = state.estimate;
    if (!evaluation || !est) return '<section class="pf-card"><div class="pf-empty">The estimate could not be computed for these inputs.</div></section>';
    const c = evaluation.conditions;
    const warnings = evaluation.warnings.filter(w => !/input window/.test(w));
    return `<section class="pf-card pf-results">
        <header class="pf-card-head"><b>${takeoff ? 'Takeoff' : 'Landing'} · ${esc(profileLabel(current))}</b><span class="pf-sub">${esc(state.airport)}${state.runway ? ` · RWY ${esc((state.runwayRows.find(r => r.key === state.runway) || {}).id || '')}` : ''}</span></header>
        ${heroCard(est, takeoff, current)}
        ${statusStrip(est, takeoff)}
        ${runwaySvg(est, takeoff)}
        ${takeoff ? `<div class="pf-legs">
          <div><span>TODR</span><b>${fmtNum(est.todrFt)} ft</b><i>takeoff distance required</i></div>
          <div><span>ASDR</span><b>${fmtNum(est.asdrFt)} ft</b><i>accelerate-stop, abort at V1</i></div>
          <div><span>AGD</span><b>${fmtNum(est.agdFt)} ft</b><i>accelerate-go, engine out to 35 ft</i></div>
          <div><span>Climb grad.</span><b class="${est.gradientPct < est.minGradientPct ? 'bad' : ''}">${est.gradientPct}%</b><i>2nd segment OEI, min ${est.minGradientPct}%</i></div>
          <div><span>Max TOW</span><b>${fmtNum(Math.round(convertWeight(est.maxTowKg, 'kg', unit)))} ${unit}</b><i>limited by ${esc(est.limitedBy)}</i></div>
        </div>
        <div class="pf-cond">${Object.entries(est.limits).filter(([, kg]) => kg != null).map(([k, kg]) => `<div><span>${k[0].toUpperCase() + k.slice(1)} limit</span><b class="${k === est.limitedBy ? 'warn' : ''}">${fmtNum(Math.round(convertWeight(kg, 'kg', unit)))} ${unit}</b></div>`).join('')}</div>` : `<div class="pf-legs">
          <div><span>Actual</span><b>${fmtNum(est.stopFt)} ft</b><i>50 ft to stop</i></div>
          <div><span>Factored</span><b>${fmtNum(est.factoredFt)} ft</b><i>×1.15 in-flight</i></div>
          <div><span>Air</span><b>${fmtNum(est.airFt)} ft</b><i>threshold to touchdown</i></div>
        </div>`}
      </section>
      <div class="pf-row">
        <section class="pf-card pf-windcard"><header class="pf-card-head"><b>Wind</b></header><div class="pf-wind-wrap">${windSvg(c.wind)}</div></section>
        <section class="pf-card"><header class="pf-card-head"><b>Weight & air</b></header>${weightGauge(evaluation)}${conditionsGrid(c)}</section>
      </div>
      ${warnings.length ? `<div class="e-notice warn"><div>${warnings.map(esc).join('<br>')}</div></div>` : ''}
      <details class="pf-method"><summary>Stratos estimate · simulator use only</summary>
        Takeoff speeds come from ${esc(current.name)} reference speeds per flap setting, scaled by weight and kept above VMCG/VMCA; thrust, engine count and climb L/D are type-specific. Landing scales from the approach speed (${current.landing.vrefKt} kt at MLW, ${esc(current.source.name)}).
        Takeoff picks the balanced V1 and the flap setting with the highest assumed temperature that fits, never more than 25% below full thrust.
        Wind is factored 50% head and 150% tail. Landing uses the autobrake deceleration the surface allows and the 1.15 in-flight factor.
        Not certified performance and not for real-world flight.
      </details>`;
  }

  function render() {
    compute();
    root.innerHTML = `<div class="pf" id="perf-layout">
      <div class="pf-side">${aircraftCard()}${inputsCard()}</div>
      <div class="pf-main" id="perf-output">${outputHtml()}</div>
    </div>`;
    wire();
  }

  function defaultBrake(current) {
    return family(current) === 'airbus' ? 'MED' : '3';
  }

  /* Recompute on every change; the inputs are never re-drawn under the cursor. */
  function compute() {
    const current = profile();
    state.calculation = null;
    state.estimate = null;
    if (!current || missingInputs().length) return;
    const runwayHeadingDeg = numberOrNull((state.runwayRows.find(row => row.key === state.runway) || {}).heading);
    const evaluation = evaluatePhase(current, state.phase, {
      weight: state.weight, elevationFt: state.elevationFt, qnhHpa: state.qnhHpa, oatC: state.oatC,
      windFromDeg: state.windFromDeg, windKt: state.windKt, gustKt: state.gustKt,
      runwayHeadingDeg, runwayLengthFt: state.runwayLengthFt, units: { weight: unit, distance: 'ft' },
    });
    const c = evaluation.conditions;
    const wind = c.wind || {};
    const base = {
      weightKg: evaluation.inputs.weightKg, paFt: c.pressureAltitudeFt, oatC: Number(state.oatC),
      headwindKt: wind.headwindKt != null ? wind.headwindKt : 0, surface: state.opts.surface,
    };
    const lengthFt = numberOrNull(state.runwayLengthFt) || 0;
    state.estimate = state.phase === 'takeoff'
      ? estimateTakeoff(current, { ...base, toraFt: lengthFt, flaps: state.opts.toFlaps, thrust: state.opts.thrust })
      : estimateLanding(current, { ...base, ldaFt: lengthFt, flaps: state.opts.ldgFlaps, autobrake: state.opts.autobrake || defaultBrake(current), windKt: numberOrNull(state.windKt) || 0, gustKt: numberOrNull(state.gustKt) || 0 });
    state.calculation = evaluation;
  }

  function readInput(input) {
    const key = input.dataset.key;
    if (!key) return;
    state[key] = input.value;
    state.manual[key] = true;
    // The value is now the pilot's, so the source badge stops claiming METAR or X-Plane.
    delete state.prefill[key];
    input.closest('.pf-field')?.querySelector('.pf-src')?.remove();
    updateOutput();
  }

  function updateOutput() {
    compute();
    const output = root.querySelector('#perf-output');
    if (output) output.innerHTML = outputHtml();
  }

  function switchPhase(phase) {
    if (phase === state.phase) return;
    state.phase = phase;
    loadPlanPhase();
    applySimulatorFields();
    compute();
    render();
    hydratePhase();
  }

  function wire() {
    root.querySelector('#perf-profile')?.addEventListener('change', event => {
      state.manualProfile = true;
      state.profileId = event.target.value;
      state.opts = { ...state.opts, toFlaps: 'auto', ldgFlaps: '', autobrake: '' };
      compute();
      render();
    });
    root.querySelector('[data-use-detected]')?.addEventListener('click', () => {
      if (!state.detected || !state.detected.profile) return;
      state.manualProfile = false;
      state.profileId = state.detected.profile.id;
      compute();
      render();
    });
    root.querySelectorAll('[data-phase]').forEach(button => button.addEventListener('click', () => switchPhase(button.dataset.phase)));
    root.querySelectorAll('[data-opt]').forEach(button => button.addEventListener('click', () => {
      state.opts[button.dataset.opt] = button.dataset.val;
      root.querySelectorAll(`[data-opt="${button.dataset.opt}"]`).forEach(b => b.setAttribute('aria-pressed', String(b === button)));
      updateOutput();
    }));
    root.querySelector('#perf-airport')?.addEventListener('change', async event => {
      state.airport = String(event.target.value || '').trim().toUpperCase();
      for (const key of ['elevationFt', 'qnhHpa', 'oatC', 'windFromDeg', 'windKt', 'gustKt', 'runway', 'runwayLengthFt']) {
        state[key] = '';
        delete state.prefill[key];
        delete state.manual[key];
      }
      state.runwayRows = [];
      state.runwayMissing = '';
      state.weatherAt = 0;
      state.metarRaw = '';
      compute();
      render();
      await hydratePhase();
    });
    root.querySelectorAll('[data-key]').forEach(input => input.addEventListener('input', () => readInput(input)));
    root.querySelector('#perf-runway')?.addEventListener('change', event => {
      state.runway = String(event.target.value || '');
      state.manual.runway = true;
      const row = state.runwayRows.find(item => item.key === state.runway);
      if (row && row.lengthFt && !state.manual.runwayLengthFt) setPrefill('runwayLengthFt', String(row.lengthFt), 'airport database');
      compute();
      render();
    });
  }

  root.innerHTML = '<div class="e-card"><h3>Performance</h3><div class="e-small e-muted">Loading the bundled performance database…</div></div>';

  try {
    state.database = await loadDatabase();
  } catch (error) {
    state.dbError = error.message;
    if (!destroyed) render();
    return { destroy() { destroyed = true; } };
  }
  if (destroyed) return { destroy() { destroyed = true; } };

  loadPlanPhase();
  applySimulatorFields();
  detect();
  render();

  const unsubscribe = onLive(applyLive);
  hydratePhase();

  return {
    destroy() {
      destroyed = true;
      unsubscribe?.();
    },
  };
}
