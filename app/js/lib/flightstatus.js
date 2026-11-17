/* A one-line flight status for the live strip ("Climbing through FL123 ·
 * 214 NM to EGLL"). The bridge only reports coarse phases (PARKED, TAXI,
 * AIRBORNE, LANDED, COMPLETE); the rest is read from the same live values the
 * strip already shows. Nothing is estimated that the simulator did not send. */

const num = value => {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

export function levelText(feet) {
  const alt = Math.max(0, feet);
  if (alt >= 18000) return 'FL' + String(Math.round(alt / 100)).padStart(3, '0');
  return (Math.round(alt / 100) * 100).toLocaleString('en-US') + ' ft';
}

/**
 * @param {object} t phase, alt (ft), agl (ft), vs (fpm), gs (kt), dep, arr, destNm
 * @returns {{key: string, label: string, detail: string}}
 */
export function flightStatus(t = {}) {
  const phase = String(t.phase || '').toUpperCase();
  const alt = num(t.alt);
  const agl = num(t.agl);
  const vs = num(t.vs) ?? 0;
  const gs = num(t.gs) ?? 0;
  const dest = num(t.destNm);
  const dep = String(t.dep || '');
  const arr = String(t.arr || '');
  if (alt == null && !phase) return { key: 'offline', label: 'Not connected', detail: '' };

  const nearArr = dest != null && dest < 8;
  const toArr = dest != null && arr ? `${Math.round(dest).toLocaleString('en-US')} NM to ${arr}` : '';
  const join = (...parts) => parts.filter(Boolean).join(' · ');
  const ground = phase === 'PARKED' || phase === 'TAXI' || phase === 'COMPLETE'
    || (agl != null && agl < 15 && Math.abs(vs) < 300);

  if (ground) {
    const done = phase === 'LANDED' || phase === 'COMPLETE' || nearArr;
    const at = done ? arr : dep;
    if (gs < 3) return done
      ? { key: 'arrived', label: 'Arrived', detail: arr ? `at ${arr}` : '' }
      : { key: 'parked', label: 'Parked', detail: dep ? `at ${dep}` : '' };
    if (gs >= 40) return done
      ? { key: 'rollout', label: 'Landing roll', detail: arr ? `at ${arr}` : '' }
      : { key: 'takeoff', label: 'Take-off roll', detail: dep ? `at ${dep}` : '' };
    return { key: 'taxi', label: 'Taxiing', detail: at ? (done ? `to the gate at ${at}` : `at ${at}`) : '' };
  }

  const level = alt == null ? '' : levelText(alt);
  if (vs > 300) {
    if (agl != null && agl < 1500 && dep && !nearArr) return { key: 'departing', label: 'Departing', detail: join(`out of ${dep}`, level) };
    return { key: 'climb', label: 'Climbing', detail: join(level && `through ${level}`, toArr) };
  }
  if (vs < -300) {
    if (dest != null && dest < 15 && agl != null && agl < 3000) return { key: 'final', label: 'Final approach', detail: join(arr && `into ${arr}`, level) };
    if (dest != null && dest < 60) return { key: 'approach', label: 'Approach', detail: join(level && `through ${level}`, toArr) };
    return { key: 'descent', label: 'Descending', detail: join(level && `through ${level}`, toArr) };
  }
  return { key: 'cruise', label: 'Cruising', detail: join(level && `at ${level}`, toArr) };
}
