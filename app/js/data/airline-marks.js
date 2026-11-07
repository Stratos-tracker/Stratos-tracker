/*
 * Symbol-only airline marks for the EFB wallpaper.
 *
 * Each entry is the airline's already-bundled mark with its root viewBox
 * narrowed to the symbol — the Lufthansa crane, the Air Canada leaf, the
 * Aer Lingus shamrock and so on. The deck shows the symbol alone, never the
 * wordmark, so an operator whose file is lettering only has no entry here and
 * simply leaves the accent wash behind. These are crops of the same artwork
 * recorded in images/airlines/ATTRIBUTION.md, not redrawings.
 */
export const AIRLINE_MARKS = Object.freeze({
  ACA: 'images/airlines/marks/ACA.svg',
  DLH: 'images/airlines/marks/DLH.svg',
  EIN: 'images/airlines/marks/EIN.svg',
  SWR: 'images/airlines/marks/SWR.svg',
  THA: 'images/airlines/marks/THA.svg',
  THY: 'images/airlines/marks/THY.svg',
});

export function airlineMark(icao) {
  return AIRLINE_MARKS[icao] || null;
}
