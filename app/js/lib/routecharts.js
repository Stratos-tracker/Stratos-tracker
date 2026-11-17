/* The charts a route needs, picked from one airport's catalogue: the aerodrome
 * chart, the filed SID, STAR and approach. Matching is by what the publisher
 * printed in the title, so a chart is only offered for a procedure it names.
 *
 * Sources name procedures differently: the simulator data truncates
 * ("IMPE3E" for IMPED 3E), the FAA spells numbers ("CAMRN FIVE"), and an
 * approach arrives as a code ("I31L" = ILS runway 31L). Each is normalised
 * before comparing; nothing is guessed when no title matches.
 */

const WORDS = ['ZERO', 'ONE', 'TWO', 'THREE', 'FOUR', 'FIVE', 'SIX', 'SEVEN', 'EIGHT', 'NINE'];
const up = value => String(value || '').trim().toUpperCase();

/** diagram | sid | star | approach | other, from the entry's category or the FAA code. */
export function chartFamily(chart) {
  const category = String((chart && chart.category) || '');
  if (['diagram', 'sid', 'star', 'approach'].includes(category)) return category;
  const code = up(chart && chart.code);
  if (code === 'APD') return 'diagram';
  if (code === 'DP') return 'sid';
  if (code === 'STR') return 'star';
  if (code === 'IAP') return 'approach';
  return 'other';
}

/** Title in capitals with spelled numbers as digits: "CAMRN FIVE (RNAV)" -> "CAMRN 5 (RNAV)". */
function normalTitle(title) {
  return up(title).replace(new RegExp(`\\b(${WORDS.join('|')})\\b`, 'g'), word => String(WORDS.indexOf(word)));
}

/** True when the title names this SID or STAR ("IMPE3E", "IMPED3E", "CAMRN5"). */
export function namesProcedure(title, ident) {
  const want = /^([A-Z]{2,6})(\d)([A-Z]?)$/.exec(up(ident));
  if (!want) return false;
  const [, fix, digit, letter] = want;
  for (const m of normalTitle(title).matchAll(/\b([A-Z]{2,6})\s?(\d)([A-Z]?)\b/g)) {
    // A six-character code keeps the fix's first letters: IMPE3E is IMPED 3E.
    if (m[1].startsWith(fix) && m[2] === digit && m[3] === letter) return true;
  }
  return false;
}

const APPROACH_TYPES = {
  I: /\bILS\b/, L: /\bLOC\b/, R: /\bRNAV\b|\bRNP\b|\bGPS\b/, H: /\bRNP\b|\bRNAV\b/, P: /\bGPS\b|\bRNAV\b/,
  D: /\bVOR\b/, V: /\bVOR\b/, S: /\bVOR\b/, N: /\bNDB\b/, Q: /\bNDB\b/,
};

/** True when the title is this approach ("I31L", "R13LZ") or, with no code, an approach to this runway. */
export function namesApproach(title, ident, runway = '') {
  const text = normalTitle(title);
  const code = /^([A-Z])(\d{2}[LRC]?)([A-Z]?)$/.exec(up(ident));
  const rwy = code ? code[2] : up(runway).replace(/^RW/, '');
  if (!/^\d{2}[LRC]?$/.test(rwy)) return false;
  if (!new RegExp(`\\b${rwy}\\b`).test(text.replace(/\bRWY\s+/g, ''))) return false;
  if (!code) return true;
  const type = APPROACH_TYPES[code[1]];
  if (type && !type.test(text)) return false;
  return !code[3] || new RegExp(`\\b${code[3]}\\b`).test(text);
}

const isContinuation = chart => /\bCONT\.?\s*\d/i.test(String((chart && chart.title) || ''));

/**
 * The route's charts in one airport's catalogue, as indexes into it:
 * { diagram, sid, star, approach } with null where nothing matches.
 */
export function pickRouteCharts(charts, { sid = '', star = '', approach = '', runway = '' } = {}) {
  const list = Array.isArray(charts) ? charts : [];
  const find = (family, test) => {
    const at = list.findIndex(chart => chartFamily(chart) === family && !isContinuation(chart) && test(String(chart.title || '')));
    return at >= 0 ? at : null;
  };
  return {
    diagram: find('diagram', title => !/PARKING|DOCKING|HOT SPOT/i.test(title)) ?? find('diagram', () => true),
    sid: sid ? find('sid', title => namesProcedure(title, sid)) : null,
    star: star ? find('star', title => namesProcedure(title, star)) : null,
    // Without a filed approach, the runway's ILS is what a pilot briefs first.
    approach: approach
      ? find('approach', title => namesApproach(title, approach))
      : runway ? (find('approach', title => namesApproach(title, `I${up(runway).replace(/^RW/, '')}`)) ?? find('approach', title => namesApproach(title, '', runway))) : null,
  };
}
