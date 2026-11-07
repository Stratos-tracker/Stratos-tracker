/*
 * Symbol-only airline marks for the EFB wallpaper.
 *
 * Each entry is the airline's already-bundled mark with its root viewBox
 * narrowed to the symbol — the Lufthansa crane, the Air Canada leaf, the
 * Delta widget and so on (Delta's whole file is the widget). The deck shows
 * the symbol alone; a carrier whose file is lettering only has no entry and
 * falls back to its wordmark, then to its plain name. These are crops of the
 * same artwork recorded in images/airlines/ATTRIBUTION.md, not redrawings.
 */
export const AIRLINE_MARKS = Object.freeze({
  ACA: 'images/airlines/marks/ACA.svg',
  AEE: 'images/airlines/marks/AEE.svg',
  DAL: 'images/airlines/DAL.svg',
  DLH: 'images/airlines/marks/DLH.svg',
  EIN: 'images/airlines/marks/EIN.svg',
  EVA: 'images/airlines/marks/EVA.svg',
  IBE: 'images/airlines/marks/IBE.svg',
  KLM: 'images/airlines/marks/KLM.svg',
  SWR: 'images/airlines/marks/SWR.svg',
  THA: 'images/airlines/marks/THA.svg',
  THY: 'images/airlines/marks/THY.svg',
});

export function airlineMark(icao) {
  return AIRLINE_MARKS[icao] || null;
}
