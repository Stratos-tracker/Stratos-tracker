/* Stratos EFB — the flight-deck shell.
 *
 * One frame for the whole bag: a top bar that always states the flight and the
 * simulator connection, a section rail, and a single content region that the
 * selected section mounts into. The shell owns routing, preferences, the clock,
 * the flight summary and lazy loading; each section owns its own data and says
 * plainly when a source is unavailable.
 *
 * Nothing here invents data. The flight strip is built from the stored SimBrief
 * plan, the connection chip from the bridge's own status, and a section that
 * cannot reach its source renders its own empty state.
 */

import {
  esc, fmtFl, fmtFt, fmtKt, connectionText, loadPrefs, savePrefs, currentPlan,
  loadRoute, loadRouteMeta, onLive, onPlanChange, DEFAULT_PREFS, flightPhase,
} from './efb/common.js';
import { displayVersion } from './lib/version.js';
import { airlineText, applyAirline, resolveAirline } from './lib/airlines.js';
import { airlineMark } from './data/airline-marks.js';
import { HOME_LAYOUT_KEY, WIDGETS, readLayout, offsetLabel, airportTime, flightProgress, fits, placeAll, sizeOf } from './efb/homewidgets.js';
import { normalizeRegistration, photoRequest, photoFromPayload } from './lib/aircraftphoto.js';
import { distanceNm } from './lib/geo.js';

/* The rail, the router and the page titles all read this one list. */
export const APPS = [
  {
    id: 'navigator', group: 'Flight', name: 'Navigator', title: 'Navigator', subtitle: 'Moving map, planned route and live progress',
    icon: 'navigator', art: 'images/app-icons/safari.png', module: './efb/navigator.js',
  },
  {
    id: 'flightplan', group: 'Flight', name: 'Flight Planner', title: 'Flight Plan Builder', subtitle: 'Build the route, apply procedures, plan fuel and send it to the map',
    icon: 'flightplan', module: './efb/flightplan.js',
  },
  {
    id: 'routes', group: 'Flight', name: 'Route Finder', title: 'Route Finder', subtitle: 'Real flights to fly, ready for SimBrief',
    icon: 'routes', module: './efb/routes.js',
  },
  {
    id: 'briefing', group: 'Flight', name: 'OFP', title: 'Flight Plan & OFP', subtitle: 'Route, procedures and operational flight plan',
    icon: 'briefing', module: './efb/briefing.js',
  },
  {
    id: 'weather', group: 'Flight', name: 'Weather', title: 'Weather', subtitle: 'METAR, TAF and winds aloft',
    icon: 'weather', art: 'images/app-icons/weather.png', module: './efb/weather.js',
  },
  {
    id: 'charts', group: 'Flight', name: 'Charts', title: 'Charts', subtitle: 'Airport and procedure documents',
    icon: 'charts', module: './efb/charts.js',
  },
  {
    id: 'airport', group: 'Flight', name: 'Airports', title: 'Airport Information', subtitle: 'Runways, frequencies and services',
    icon: 'airport', module: './efb/airport.js',
  },
  {
    id: 'performance', group: 'Aircraft', name: 'Performance', title: 'Performance', subtitle: 'Takeoff and landing analysis',
    icon: 'performance', module: './efb/performance.js',
  },
  {
    id: 'weightbalance', group: 'Aircraft', name: 'Weight & Balance', title: 'Weight & Balance', subtitle: 'Loading, centre of gravity and limits',
    icon: 'weightbalance', module: './efb/weightbalance.js',
  },
  {
    id: 'fuel', group: 'Aircraft', name: 'Fuel', title: 'Fuel Planning', subtitle: 'Block fuel and reserves',
    icon: 'fuel', module: './efb/fuel.js',
  },
  {
    id: 'checklists', group: 'Aircraft', name: 'Checklists', title: 'Checklists', subtitle: 'Normal, abnormal and emergency procedures',
    icon: 'checklists', module: './efb/checklists.js',
  },
  {
    id: 'cabin', group: 'Cabin', name: 'Cabin', title: 'Cabin Experience', subtitle: 'Passenger announcements on the PC or this tablet',
    icon: 'cabin', module: './efb/cabin.js',
  },
  {
    id: 'notepad', group: 'Tools', name: 'Notepad', title: 'Notepad', subtitle: 'Typed note, kept on this device',
    icon: 'notepad', module: './efb/notepad.js',
  },
  {
    id: 'logbook', group: 'Records', name: 'Logbook', title: 'Flight Log', subtitle: 'Recorded flights',
    icon: 'logbook', module: './efb/logbook.js',
  },
  {
    id: 'settings', group: 'Records', name: 'Settings', title: 'EFB Settings', subtitle: 'Preferences and connections',
    icon: 'settings', art: 'images/app-icons/settings.png', module: './efb/settings.js',
  },
];

const GROUP_ORDER = ['Flight', 'Aircraft', 'Cabin', 'Tools', 'Records'];
const HOME_ROUTE = 'home';
const DEFAULT_ROUTE = HOME_ROUTE;

/* The map used to be called Live, and Map after that. A bookmarked or installed
   link still lands on Navigator instead of the deck. */
const LEGACY_ROUTES = { live: 'navigator', map: 'navigator' };

/* The dock: the five apps a pilot reaches for without thinking. Everything else
   is one tap away on the deck, and Settings also sits in the header. */
const DOCK = ['navigator', 'flightplan', 'briefing', 'charts', 'checklists'];

/* One solid tone for every tile, so the deck reads as an operating system
   rather than a colour-coded list. The glyph is what identifies the app.
   Line icons only, one stroke weight, on a 24-unit grid — the same set the rest
   of the bag draws with, so no page mixes styles. */
const ICONS = {
  // Navigator: a compass rose over a planned track, not a generic pin.
  // SF Symbols "map": the folded sheet, not a generic pin.
  navigator: '<path d="M9 4.6 3.8 6.7v12.7L9 17.3l6 2.3 5.2-2.1V4.8L15 6.9z"/><path d="M9 4.6v12.7M15 6.9v12.7"/>',
  // Two airports joined by a great-circle arc.
  routes: '<circle cx="5.5" cy="17.5" r="2"/><circle cx="18.5" cy="17.5" r="2"/><path d="M6.8 15.9C9 9 15 9 17.2 15.9"/><path d="m15.2 13.6 2 2.3.6-3"/>',
  // SF Symbols "doc.text".
  briefing: '<path d="M6.8 3.6h7.4L18.8 8v12.4H6.8z"/><path d="M14.2 3.7V8h4.5"/><path d="M9.5 11.6h6.4M9.5 14.4h6.4M9.5 17.2h4.2"/>',
  // A planned track between two fixes, with the turns a route makes.
  // SF Symbols "airplane".
  flightplan: '<path d="M10.6 3.2a1.4 1.4 0 0 1 2.8 0v5.2l6.8 4v1.8l-6.8-2v4.1l2.5 1.8v1.5l-3.9-.9-3.9.9v-1.5l2.5-1.8v-4.1l-6.8 2v-1.8l6.8-4z"/>',
  // SF Symbols "cloud.sun".
  weather: '<circle cx="12.4" cy="8.2" r="2.4"/><path d="M12.4 3.6v1.2M7.8 4.9l.9.9M17 4.9l-.9.9"/><path d="M8 18.6a3 3 0 0 1 .4-6 3.9 3.9 0 0 1 7.4 1 2.8 2.8 0 0 1-.4 5z"/>',
  // SF Symbols "chart.xyaxis.line".
  charts: '<path d="M4 4v16h16"/><path d="m7 15 3.4-4.2 2.8 2.3 4-5.6"/>',
  // SF Symbols "location".
  airport: '<path d="M12 20.8s6.6-5.8 6.6-10.4a6.6 6.6 0 1 0-13.2 0c0 4.6 6.6 10.4 6.6 10.4z"/><circle cx="12" cy="10.2" r="2.4"/>',
  // SF Symbols "gauge".
  performance: '<path d="M3.8 16.8a8.2 8.2 0 1 1 16.4 0"/><path d="M12 16.8 15.6 10"/><circle cx="12" cy="16.8" r="1.4"/>',
  // SF Symbols "scalemass".
  weightbalance: '<path d="M12 3.8v16.4M6.4 20.2h11.2M4.4 7.2h15.2"/><path d="M7.6 7.2 5 12.4a2.7 2.7 0 0 0 5.2 0z"/><path d="M16.4 7.2l-2.6 5.2a2.7 2.7 0 0 0 5.2 0z"/>',
  // SF Symbols "fuelpump".
  fuel: '<path d="M6 20V5.6h7V20"/><path d="M6 9.4h7"/><path d="M13 12h2.3a1.8 1.8 0 0 1 1.8 1.8v3.3a1.2 1.2 0 0 0 2.4 0V9.7l-2.2-2.2"/><path d="M4.6 20h9.8"/>',
  // SF Symbols "checklist".
  checklists: '<path d="M9.2 6.4h8.6M9.2 12h8.6M9.2 17.6h5.6"/><path d="m3.8 6.1 1.2 1.2 2-2.3M3.8 11.7l1.2 1.2 2-2.3"/>',
  // SF Symbols "square.and.pencil".
  notepad: '<path d="M4.6 18.9v-3.6L15.8 4.1a1.6 1.6 0 0 1 2.3 0l1.8 1.8a1.6 1.6 0 0 1 0 2.3L8.2 18.9z"/><path d="m14.6 5.3 4.1 4.1"/><path d="M4.6 18.9 8 18.3"/>',
  // Cabin: a cabin speaker with its own wave, not a generic horn.
  // SF Symbols "speaker.wave.2".
  cabin: '<path d="M4.2 9.4h3.2L13.8 5.6v12.8l-6.4-3.8H4.2z"/><path d="M16.8 9.3a4.2 4.2 0 0 1 0 5.4"/><path d="M19.1 6.9a8 8 0 0 1 0 10.2"/>',
  // SF Symbols "house".
  home: '<path d="M4.2 10.7 12 4.1l7.8 6.6V20H4.2z"/><path d="M9.7 20v-5.6h4.6V20"/>',
  // SF Symbols "book.closed".
  logbook: '<path d="M6.2 4.4h10.2A1.7 1.7 0 0 1 18.1 6.1v13.5H7.8a2.2 2.2 0 0 1-2.2-2.2V5.9a1.5 1.5 0 0 1 1.5-1.5z"/><path d="M9.2 8.1h5.6M9.2 11.3h4"/><path d="M5.6 17.4h12.5"/>',
  // SF Symbols "gearshape".
  settings: '<g transform="translate(2.4 1.8)"><path d="M14.83 8.5 16.43 9.25v1.9L14.83 11.9 15.69 13.45 14.57 14.99 12.83 14.65 12.62 16.41 10.81 16.99 9.6 15.7 8.39 16.99 6.58 16.41 6.37 14.65 4.63 14.99 3.51 13.45 4.37 11.9 2.77 11.15v-1.9L4.37 8.5 3.51 6.95 4.63 5.41 6.37 5.75 6.58 3.99 8.39 3.41 9.6 4.7 10.81 3.41 12.62 3.99 12.83 5.75 14.57 5.41 15.69 6.95z"/><circle cx="9.6" cy="10.2" r="2.9"/></g>',
  // SF Symbols "arrow.up.right.square".
  external: '<path d="M13.2 4.8h6v6"/><path d="m19 5-7.4 7.4"/><path d="M17.2 13.6v4.6a1 1 0 0 1-1 1H5.8a1 1 0 0 1-1-1V7.8a1 1 0 0 1 1-1h4.6"/>',
};

export function icon(name, size = 16) {
  const body = ICONS[name] || ICONS.settings;
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}

/* Home-screen artwork, drawn in the idiom of a tablet's own apps: Notes with
   its yellow band, Settings' grey gears, Safari's compass, Reminders' coloured
   bullets, Calculator's keypad. These are Stratos' own drawings in that style,
   not Apple artwork, and they are used only on the deck tiles; the rail keeps
   the single-weight line set above. */
const APP_ICONS = {
  navigator: '<circle cx="12" cy="12" r="9.5" fill="#1e8fff"/><circle cx="12" cy="12" r="8.2" fill="#3aa2ff"/><path d="M12 3.3v1.4M12 19.3v1.4M3.3 12h1.4M19.3 12h1.4M5.9 5.9l1 1M17.1 17.1l1 1M5.9 18.1l1-1M17.1 6.9l1-1" stroke="#e6f4ff" stroke-width=".95" stroke-linecap="round"/><g transform="rotate(-45 12 12)"><path d="M12 4 13.2 12h-2.4z" fill="#ff3b30"/><path d="M12 20l-1.2-8h2.4z" fill="#f8fbff"/></g><circle cx="12" cy="12" r="1.2" fill="#fff"/><circle cx="12" cy="12" r=".55" fill="#d92d20"/>',
  flightplan: '<path d="M3 12.4 21 4l-6.6 16-2.6-6.3z" fill="#ff9500"/><path d="m11.8 13.7 9.2-9.7-6.6 16z" fill="#ffb340"/>',
  routes: '<circle cx="12" cy="12.4" r="8.4" fill="#eaf3ff"/><g fill="none" stroke="#9cc3f5" stroke-width=".9"><ellipse cx="12" cy="12.4" rx="3.7" ry="8.4"/><path d="M3.6 12.4h16.8M4.6 8.4h14.8M4.6 16.4h14.8"/></g><path d="M5 17.2C7.4 10 12.6 6.6 17.9 6.9" fill="none" stroke="#ff9f0a" stroke-width="1.8" stroke-linecap="round"/><circle cx="5" cy="17.2" r="1.7" fill="#ff9f0a" stroke="#ffffff" stroke-width=".8"/><path d="M0-3.4.7-.9 3.2.4v.8L.7-.3.5 2l.9.7v.6L0 3l-1.4.3v-.6l.9-.7L-.7-.3l-2.5.7v-.8L-.7-.9z" fill="#ffffff" stroke="#0b3a8f" stroke-width=".35" transform="translate(18.6 6.6) rotate(78) scale(1.25)"/>',
  briefing: '<path d="M3 7.9a2 2 0 0 1 2-2h4.1l1.9 2.3H19a2 2 0 0 1 2 2v8.9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" fill="#0a84ff"/><path d="M3 10.2h18v6.6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" fill="#4fa9ff"/>',
  weather: '<defs><linearGradient id="wxCloud" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#d7e8fa"/></linearGradient></defs><circle cx="15.4" cy="8.6" r="3.4" fill="#ffcf00"/><circle cx="15.4" cy="8.6" r="2.6" fill="#ffd60a"/><g fill="url(#wxCloud)"><circle cx="9.2" cy="13.4" r="3"/><circle cx="12.4" cy="11.8" r="3.7"/><circle cx="15.6" cy="13.6" r="2.9"/><rect x="7.2" y="13.2" width="10.2" height="4.2" rx="2.1"/></g>',
  charts: '<path d="M6 3.4h7.7l4.3 4.3v12.1a.9.9 0 0 1-.9.9H6.9a.9.9 0 0 1-.9-.9z" fill="#ff3b30"/><path d="M13.7 3.4v4.3h4.3" fill="#ff8a80"/><path d="M8.4 10.8h6.6M8.4 13.2h6.6M8.4 15.6h4.4" stroke="#fff" stroke-width="1.3" stroke-linecap="round"/>',
  airport: '<defs><linearGradient id="aptPin" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ffb340"/><stop offset=".55" stop-color="#ff7a00"/><stop offset="1" stop-color="#e01b1b"/></linearGradient></defs><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7Z" fill="url(#aptPin)"/><circle cx="12" cy="9" r="4.9" fill="#fff"/><path d="M21 16v-2l-8-5V3.5c0-.83-.67-1.5-1.5-1.5S10 2.67 10 3.5V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5l8 2.5z" transform="translate(12 9) scale(.3) translate(-12 -12)" fill="url(#aptPin)"/>',
  performance: '<path d="M4.4 16.6a7.6 7.6 0 1 1 15.2 0" fill="none" stroke="#ff9500" stroke-width="2.3" stroke-linecap="round"/><path d="M12 16.6l3.8-6.4" stroke="#ff3b30" stroke-width="1.8" stroke-linecap="round"/><circle cx="12" cy="16.6" r="1.6" fill="#ff3b30"/>',
  weightbalance: '<rect x="4" y="2.6" width="16" height="18.8" rx="3.4" fill="#2c2c2e"/><rect x="6.2" y="5" width="11.6" height="4.2" rx="1.1" fill="#d1d1d6"/><circle cx="7.6" cy="12.4" r="1.1" fill="#8e8e93"/><circle cx="12" cy="12.4" r="1.1" fill="#8e8e93"/><circle cx="16.4" cy="12.4" r="1.1" fill="#ff9f0a"/><circle cx="7.6" cy="15.2" r="1.1" fill="#8e8e93"/><circle cx="12" cy="15.2" r="1.1" fill="#8e8e93"/><circle cx="16.4" cy="15.2" r="1.1" fill="#ff9f0a"/><circle cx="7.6" cy="18" r="1.1" fill="#8e8e93"/><circle cx="12" cy="18" r="1.1" fill="#8e8e93"/><circle cx="16.4" cy="18" r="1.1" fill="#ff9f0a"/>',
  fuel: '<path d="M6 20V6a1.6 1.6 0 0 1 1.6-1.6h3.8A1.6 1.6 0 0 1 13 6v14z" fill="#fff"/><rect x="7.4" y="6.4" width="4.2" height="3.2" rx=".8" fill="#34c759"/><path d="M13 11.6h1.8a1.7 1.7 0 0 1 1.7 1.7v3a1.3 1.3 0 0 0 2.6 0V9.6l-2-2" fill="none" stroke="#fff" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/><path d="M4.6 20h9.8" stroke="#fff" stroke-width="1.7" stroke-linecap="round"/>',
  checklists: '<path d="M10.6 7.4h9M10.6 12h9M10.6 16.6h6.4" stroke="#c7c7cc" stroke-width="1.7" stroke-linecap="round"/><circle cx="6.4" cy="7.4" r="1.6" fill="#ff3b30"/><circle cx="6.4" cy="12" r="1.6" fill="#ff9500"/><circle cx="6.4" cy="16.6" r="1.6" fill="#0a84ff"/>',
  cabin: '<path d="M4.4 9.4h3.2L14 5.6v12.8l-6.4-3.8H4.4z" fill="#fff"/><path d="M17 9.2a4.4 4.4 0 0 1 0 5.6M19.2 6.8a8 8 0 0 1 0 10.4" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round"/>',
  notepad: '<path d="M8.2 10.6h7.6M8.2 13.4h7.6M8.2 16.2h5" stroke="#c7c7cc" stroke-width="1.5" stroke-linecap="round"/>',
  logbook: '<path d="M4 6.4c2.6-1 5.4-.3 8 1.5v10.9c-2.6-1.8-5.4-2.5-8-1.5z" fill="#ff9500"/><path d="M20 6.4c-2.6-1-5.4-.3-8 1.5v10.9c2.6-1.8 5.4-2.5 8-1.5z" fill="#ffb340"/>',
  settings: '<path d="M14.83 8.50L16.43 9.25L16.43 11.15L14.83 11.90L14.83 11.90L15.69 13.45L14.57 14.99L12.83 14.65L12.83 14.65L12.62 16.41L10.81 16.99L9.60 15.70L9.60 15.70L8.39 16.99L6.58 16.41L6.37 14.65L6.37 14.65L4.63 14.99L3.51 13.45L4.37 11.90L4.37 11.90L2.77 11.15L2.77 9.25L4.37 8.50L4.37 8.50L3.51 6.95L4.63 5.41L6.37 5.75L6.37 5.75L6.58 3.99L8.39 3.41L9.60 4.70L9.60 4.70L10.81 3.41L12.62 3.99L12.83 5.75L12.83 5.75L14.57 5.41L15.69 6.95L14.83 8.50Z" fill="#eef0f3" stroke="#aab0b8" stroke-width=".45"/><path d="M9.6 10.2V5.6M9.6 10.2l4.1 2.4M9.6 10.2 5.5 12.6" stroke="#8d939c" stroke-width="1.3" stroke-linecap="round"/><circle cx="9.6" cy="10.2" r="2.1" fill="#c7ccd2" stroke="#8d939c" stroke-width=".6"/><path d="M20.43 15.32L21.63 15.91L21.63 17.49L20.43 18.08L20.43 18.08L20.86 19.35L19.75 20.46L18.48 20.03L18.48 20.03L17.89 21.23L16.31 21.23L15.72 20.03L15.72 20.03L14.45 20.46L13.34 19.35L13.77 18.08L13.77 18.08L12.57 17.49L12.57 15.91L13.77 15.32L13.77 15.32L13.34 14.05L14.45 12.94L15.72 13.37L15.72 13.37L16.31 12.17L17.89 12.17L18.48 13.37L18.48 13.37L19.75 12.94L20.86 14.05L20.43 15.32Z" fill="#f7f8fa" stroke="#aab0b8" stroke-width=".45"/><circle cx="17.1" cy="16.7" r="1.5" fill="#8d939c"/>',
};

export function appIcon(name, size = 40) {
  const body = APP_ICONS[name] || APP_ICONS.settings;
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" aria-hidden="true">${body}</svg>`;
}

/* ── shell state ─────────────────────────────────────────────────────── */

const state = {
  prefs: loadPrefs(),
  app: null,
  query: '',
  cleanup: null,
  plan: null,
  route: [],
  live: null,
  liveCallsign: '',
  airline: null,
  clockTimer: null,
  unsubLive: null,
};

const dom = {};

function applyPreferences() {
  state.prefs = state.prefs || loadPrefs();
  document.body.dataset.wall = state.prefs.wallpaper || DEFAULT_PREFS.wallpaper;
  document.documentElement.dataset.efbMotion = state.prefs.motion === 'reduced' ? 'reduced' : 'full';
  applyAirlineState();
}

/*
 * Branding is resolved, not stored as colours: the preference says whether the
 * airline comes from the plan or from a manual choice, and this turns that into
 * the accent tokens the whole bag reads, the mark in the header and the wordmark
 * on the deck. A resolved airline is always a record from the airline table, or
 * none at all — never a name invented from a three-letter string.
 */
function applyAirlineState() {
  const resolved = resolveAirline(state.prefs, state.plan, state.liveCallsign);
  state.airline = resolved;
  applyAirline(resolved.airline);
  renderAirlineMark(resolved);
  syncFlightWidget(state.live);
  window.dispatchEvent(new CustomEvent('stratos:efb-airline', { detail: resolved }));
}

function renderAirlineMark(resolved) {
  const air = resolved && resolved.airline;
  const detected = resolved && resolved.source === 'manual' ? 'Selected airline' : 'Detected airline';
  if (dom.airline) {
    dom.airline.hidden = !air;
    dom.airline.innerHTML = air
      ? `${air.logo
          ? `<img class="et-logo" src="${esc(air.logo)}" alt="" width="84" height="16">`
          : `<b>${esc(airlineText(air))}</b>`}<span>${esc(air.name)}</span>`
      : '';
    dom.airline.title = air
      ? `${detected}: ${air.name} (${air.icao})${resolved.detected && resolved.detected.callsign ? ` · callsign ${resolved.detected.callsign}` : ''}`
      : '';
  }
  if (dom.homeAirline) {
    dom.homeAirline.hidden = !air;
    dom.homeAirline.innerHTML = air
      ? `<b>${esc(air.name)}</b><span>${esc(air.icao)}${air.iata ? ` · ${esc(air.iata)}` : ''}</span>`
      : '';
  }
  renderAirlineWallpaper(air);
}

/*
 * The deck wallpaper in three steps: the airline's symbol when one can stand
 * on its own (the crane, the leaf, the Delta widget), otherwise the bundled
 * wordmark, otherwise the airline's plain name when no artwork is shipped.
 * All three are masked or drawn in the airline accent. The house theme clears
 * this and the Stratos wing takes over.
 */
function renderAirlineWallpaper(air) {
  if (!dom.airlineWallpaper) return;
  if (!air) { dom.airlineWallpaper.innerHTML = ''; return; }
  const mark = airlineMark(air.icao);
  if (mark) {
    dom.airlineWallpaper.innerHTML = `<span class="hb-mark hb-symbol" style="--brand-logo:url('${esc(mark)}')"></span>`;
  } else if (air.logo) {
    dom.airlineWallpaper.innerHTML = `<span class="hb-mark hb-wordmark" style="--brand-logo:url('${esc(air.logo)}')"></span>`;
  } else {
    dom.airlineWallpaper.innerHTML = `<span class="hb-name">${esc(air.name)}</span>`;
  }
}

/* ── navigation ──────────────────────────────────────────────────────── */

function renderNav() {
  if (!dom.nav) return;
  const groups = GROUP_ORDER
    .map(group => ({ group, apps: APPS.filter(app => app.group === group) }))
    .filter(entry => entry.apps.length);
  dom.nav.innerHTML = `
    <a class="en-home" href="#/${HOME_ROUTE}" data-home title="EFB home screen">
      <span class="en-icon">${icon('home', 15)}</span><span class="en-label">Home</span>
    </a>
    ${groups.map(entry => `
    <div class="en-group">
      <div class="en-group-head">${esc(entry.group)}</div>
      ${entry.apps.map(app => `
        <a class="en-item" href="#/${esc(app.id)}" data-app="${esc(app.id)}" title="${esc(app.title)}">
          <span class="en-icon">${icon(app.icon, 15)}</span>
          <span class="en-label">${esc(app.name)}</span>
        </a>`).join('')}
    </div>`).join('')}
    <div class="en-foot">
      <span>Stratos EFB <b>${esc(displayVersion())}</b></span>
      <span class="en-foot-note">Simulator use only · not for real-world navigation</span>
    </div>`;
}

/* The rail is a horizontal scroller on a tablet. Without an edge hint the last
   sections look absent rather than off-screen, so the fade follows the scroll
   position instead of always fading the final item. */
function syncNavFade() {
  if (!dom.nav) return;
  const more = dom.nav.scrollLeft + dom.nav.clientWidth < dom.nav.scrollWidth - 4;
  const back = dom.nav.scrollLeft > 4;
  dom.nav.classList.toggle('is-more', more);
  dom.nav.classList.toggle('is-back', back);
}

function markActive(id) {
  if (!dom.nav) return;
  for (const item of dom.nav.querySelectorAll('[data-app]')) {
    const active = item.dataset.app === id;
    item.classList.toggle('is-active', active);
    if (active) item.setAttribute('aria-current', 'page');
    else item.removeAttribute('aria-current');
  }
  const home = dom.nav.querySelector('[data-home]');
  if (home) {
    const active = id === HOME_ROUTE;
    home.classList.toggle('is-active', active);
    if (active) home.setAttribute('aria-current', 'page');
    else home.removeAttribute('aria-current');
  }
}

/* ── home screen ─────────────────────────────────────────────────────── */

function tileMarkup(app, size = 44) {
  // Three tiles use downloaded artwork as-is: the image already is the whole
  // icon, so it fills the tile and the deck's tint and gloss step aside.
  const art = app.art
    ? `<img class="hi-art" src="${esc(app.art)}" alt="" width="${size}" height="${size}" decoding="async">`
    : appIcon(app.icon, size);
  return `<a class="hi hi-${esc(app.id)}" href="#/${esc(app.id)}" data-open="${esc(app.id)}">
    <span class="hi-tile${app.art ? ' is-art' : ''}">${art}</span>
    <span class="hi-label">${esc(app.name)}</span>
  </a>`;
}

function loadLayout() {
  let raw = null;
  try { raw = localStorage.getItem(HOME_LAYOUT_KEY); } catch (_) { /* private mode */ }
  return readLayout(raw, APPS.map(app => app.id), DOCK);
}

function saveLayout() {
  try { localStorage.setItem(HOME_LAYOUT_KEY, JSON.stringify(state.layout)); } catch (_) { /* private mode */ }
}

/* One grid of cells for apps and widgets, like iPadOS: each item keeps the
   cell it was put in, gaps included. */
const CELL = 116;
const boardKey = el => (el.dataset.widget ? `w:${el.dataset.widget}` : el.dataset.open);

function placeOnBoard(el, spot) {
  el.style.gridColumn = `${spot.c + 1} / span ${spot.w}`;
  el.style.gridRow = `${spot.r + 1} / span ${spot.h}`;
}

/* Lay the board out for the space there is. Below six columns (a phone)
   everything flows in order instead of keeping cells. */
function positionBoard() {
  const grid = dom.homeGrid;
  if (!grid) return;
  const width = (grid.parentElement && grid.parentElement.clientWidth) || grid.clientWidth || 0;
  const cols = Math.max(1, Math.floor(width / CELL));
  const items = [...grid.children].filter(el => !el.hidden);
  state.cols = cols;
  if (cols < 6) {
    grid.classList.add('is-flow');
    for (const el of items) { el.style.gridColumn = ''; el.style.gridRow = ''; }
    state.placed = null;
    return;
  }
  grid.classList.remove('is-flow');
  grid.style.setProperty('--cols', String(cols));
  state.placed = placeAll(items.map(boardKey), state.layout.pos, cols);
  for (const el of items) placeOnBoard(el, state.placed[boardKey(el)]);
  state.layout.pos = Object.fromEntries(Object.entries(state.placed).map(([key, spot]) => [key, [spot.c, spot.r]]));
}

/* Chosen widgets join the board; the rest wait, hidden, for the gallery. */
function applyWidgets() {
  const holder = document.getElementById('home-widgets');
  const grid = dom.homeGrid;
  if (!holder || !grid) return;
  const chosen = state.layout.widgets;
  for (const el of document.querySelectorAll('#home-widgets [data-widget], #home-grid > [data-widget]')) {
    const on = chosen.includes(el.dataset.widget);
    el.hidden = !on;
    if (on && el.parentElement !== grid) grid.appendChild(el);
    if (!on && el.parentElement !== holder) { holder.appendChild(el); el.style.gridColumn = ''; el.style.gridRow = ''; }
  }
  positionBoard();
}

function renderHome() {
  if (!dom.homeGrid) return;
  state.layout = state.layout || loadLayout();
  const byId = new Map(APPS.map(app => [app.id, app]));
  const holder = document.getElementById('home-widgets');
  // Widgets step out before the apps are redrawn, then come back in.
  if (holder) for (const el of dom.homeGrid.querySelectorAll(':scope > [data-widget]')) holder.appendChild(el);
  dom.homeGrid.innerHTML = state.layout.apps.filter(id => !state.layout.dock.includes(id)).map(id => byId.get(id)).filter(Boolean).map(app => tileMarkup(app)).join('');
  applyWidgets();
  drawClockRings();
  // An app sits on the home screen or in the dock, never both, as on an iPad.
  if (dom.homeDock) dom.homeDock.innerHTML = state.layout.dock.map(id => byId.get(id)).filter(Boolean).map(app => tileMarkup(app, 32)).join('');
}

/* ── home widgets: flight tracking and airport clocks ───────────────── */

/* The SimBrief plan describes this flight only while its airports are the
   route's own, the rule the strip above follows too. */
function planOfp(parts) {
  const ofp = state.plan && state.plan.ofp;
  if (!ofp || !parts) return null;
  const same = (ofp.origin && ofp.origin.icao) === parts.origin && (ofp.destination && ofp.destination.icao) === parts.destination;
  return same ? ofp : null;
}

function drawClockRings() {
  const ticks = Array.from({ length: 60 }, (_, i) => {
    const major = i % 5 === 0;
    return `<line x1="50" y1="2.5" x2="50" y2="${major ? 8 : 6}" stroke="${major ? '#1c1c1e' : '#b8b8bd'}" stroke-width="${major ? 1.4 : 0.8}" transform="rotate(${i * 6} 50 50)"/>`;
  }).join('');
  for (const ring of document.querySelectorAll('.tz-ring')) ring.innerHTML = ticks;
}

/* Local time at each airport from the UTC offset SimBrief publishes; without
   one the clock says UTC instead of guessing a zone. */
function syncAirportClocks() {
  const parts = flightParts(state.plan);
  const ofp = planOfp(parts);
  const now = Date.now();
  for (const [key, icao, airport] of [['dep', parts && parts.origin, ofp && ofp.origin], ['arr', parts && parts.destination, ofp && ofp.destination]]) {
    const tz = airport ? airport.timezone : null;
    const label = offsetLabel(tz);
    const set = (id, text) => { const el = document.getElementById(id); if (el) el.textContent = text; };
    set(`tz-${key}-icao`, icao || (key === 'dep' ? 'DEP' : 'ARR'));
    set(`tz-${key}-time`, icao ? airportTime(now, tz) : '--:--');
    set(`tz-${key}-off`, icao ? (label || 'UTC') : '');
  }
}

function syncFlightWidget(status) {
  const card = document.querySelector('[data-widget="flight"]');
  if (!card) return;
  const set = (id, text) => { const el = document.getElementById(id); if (el) el.textContent = text; };
  const parts = flightParts(state.plan);
  const ofp = planOfp(parts);
  const snapshot = status && status.status === 'live' ? status.snapshot : null;
  const t = snapshot && snapshot.telemetry;
  const callsign = (parts && parts.callsign) || (t && t.callsign) || '';
  const type = (parts && parts.aircraft) || '';
  const registration = normalizeRegistration((t && t.registration) || (ofp && ofp.aircraft && ofp.aircraft.reg) || '');
  const airline = state.airline && state.airline.airline;

  set('hf-cs', callsign || 'No flight');
  const fn = document.getElementById('hf-fn');
  const number = ofp && ofp.flight && ofp.flight.flightNumber;
  if (fn) { fn.hidden = !number; fn.textContent = number ? `${(ofp.flight.airline || '').slice(0, 3)}${number}` : ''; }
  const typeTag = document.getElementById('hf-type');
  if (typeTag) { typeTag.hidden = !type; typeTag.textContent = type; }
  const about = [airline && airline.name, ofp && ofp.aircraft && ofp.aircraft.name, registration].filter(Boolean);
  set('hf-air', parts ? (about.join(' · ') || 'Flight from the loaded plan') : 'Import a SimBrief plan to track the flight here');
  set('hf-dep', (parts && parts.origin) || '----');
  set('hf-arr', (parts && parts.destination) || '----');
  set('hf-depn', (ofp && ofp.origin.name) || '');
  set('hf-arrn', (ofp && ofp.destination.name) || '');

  const zulu = ms => (Number.isFinite(ms) && ms > 0 ? `${new Date(ms).toISOString().slice(11, 16)}Z` : '—');
  set('hf-out', zulu(ofp && ofp.times && ofp.times.depUtc));

  // Distance along the great circle between the two airports, from the plan's
  // coordinates or the route's own end points.
  const ends = [ofp && ofp.origin, ofp && ofp.destination];
  const route = state.route || [];
  const from = ends[0] && Number.isFinite(ends[0].lat) ? ends[0] : route[0];
  const to = ends[1] && Number.isFinite(ends[1].lat) ? ends[1] : route[route.length - 1];
  const located = p => p && Number.isFinite(Number(p.lat)) && Number.isFinite(Number(p.lon));
  const total = (ofp && ofp.distanceNm) || (located(from) && located(to) ? distanceNm(from, to) : null);
  const remaining = t && located(to) ? distanceNm(t, to) : null;
  const progress = flightProgress(total, remaining);
  const fill = document.getElementById('hf-fill');
  const pos = document.getElementById('hf-pos');
  const pct = progress ? `${(progress.fraction * 100).toFixed(1)}%` : '0%';
  if (fill) fill.style.width = pct;
  if (pos) pos.style.left = pct;
  set('hf-flown', progress ? `${Math.round(progress.flown)} nm flown` : '');
  const eta = t && remaining != null && t.gs > 50 ? Date.now() + (remaining / t.gs) * 3600000 : null;
  set('hf-left', progress ? `${Math.round(progress.left)} nm${eta ? ` · ${fmtMinutesLeft((eta - Date.now()) / 60000)} left` : ''} to go` : '');
  set('hf-in-k', eta ? 'Estimated in' : 'Scheduled in');
  set('hf-in', eta ? zulu(eta) : zulu(ofp && ofp.times && ofp.times.arrUtc));
  document.getElementById('hf-in')?.classList.toggle('is-live', Boolean(eta));

  set('hf-alt', t ? fmtFl(t.alt) : '—');
  set('hf-gs', t ? fmtKt(t.gs) : '—');
  const phase = t ? flightPhase(snapshot) : null;
  set('hf-phase', phase ? phase.label : (status && status.status === 'live' ? 'Live' : 'Offline'));

  if (registration !== state.photoReg) {
    state.photoReg = registration;
    showAircraftPhoto(registration);
  }
}

function fmtMinutesLeft(minutes) {
  const m = Math.max(0, Math.round(minutes));
  return m >= 60 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m` : `${m}m`;
}

/* The airframe's photo by registration, from Planespotters through Stratos'
   own /api/photo endpoint, always shown with the credit and link it requires. */
function showAircraftPhoto(registration) {
  const img = document.getElementById('hf-img');
  const credit = document.getElementById('hf-cred');
  const none = document.getElementById('hf-nophoto');
  if (!img || !credit || !none) return;
  const clear = text => { img.hidden = true; img.removeAttribute('src'); credit.hidden = true; none.hidden = false; none.textContent = text; };
  if (!registration) { clear('No aircraft photo'); return; }
  clear(`Looking for a photo of ${registration}…`);
  fetch(photoRequest(registration), { headers: { Accept: 'application/json' } })
    .then(response => (response.ok ? response.json() : null))
    .then(payload => {
      if (state.photoReg !== registration) return;
      const photo = photoFromPayload(payload);
      if (!photo) { clear(`No photo of ${registration} yet`); return; }
      img.src = photo.src;
      img.alt = `${registration}, photographed by ${photo.photographer || 'a Planespotters contributor'}`;
      img.hidden = false;
      none.hidden = true;
      credit.href = photo.link;
      credit.textContent = `${registration} · © ${photo.photographer || 'Planespotters contributor'} · planespotters.net`;
      credit.hidden = false;
    })
    .catch(() => { if (state.photoReg === registration) clear(`No photo of ${registration} available`); });
}

/* ── edit mode: hold the wallpaper ─────────────────────────────────── */

/* Holding the deck for half a second makes everything wiggle, as on iPadOS:
   apps can be dragged to new places, widgets removed with their minus, and
   added back from the gallery. Done (or a tap on the wallpaper) saves. */
function setupHomeEdit() {
  const home = dom.home;
  const grid = dom.homeGrid;
  const dock = dom.homeDock;
  const holder = document.getElementById('home-widgets');
  const bar = document.getElementById('home-editbar');
  const gallery = document.getElementById('wg-gallery');
  const list = document.getElementById('wg-list');
  if (!home || !grid || !dock || !holder || !bar || !gallery || !list) return;
  const DOCK_MAX = 8;
  const EASE = 'cubic-bezier(.32, .72, 0, 1)';
  let hold = null, press = null, swallowClick = false, drag = null;

  const editing = () => document.body.classList.contains('home-editing');
  const enter = () => { document.body.classList.add('home-editing'); bar.hidden = false; };
  const exit = () => {
    document.body.classList.remove('home-editing');
    bar.hidden = true;
    gallery.hidden = true;
    saveLayout();
  };
  const draggableAt = node => node && node.closest('#home-grid > .hi, #home-grid > [data-widget], #home-dock .hi');
  const shown = () => [...grid.children, ...dock.querySelectorAll('.hi')].filter(el => !el.hidden);

  // Everything that changes place slides there, as on iPadOS. `translate` is
  // its own property, so it runs alongside the wiggle's rotation.
  const flip = mutate => {
    const items = shown().filter(el => !drag || el !== drag.item);
    const before = new Map(items.map(el => [el, el.getBoundingClientRect()]));
    mutate();
    for (const el of items) {
      if (!before.has(el) || !el.isConnected) continue;
      const a = before.get(el), b = el.getBoundingClientRect();
      const dx = a.left - b.left, dy = a.top - b.top;
      if (Math.abs(dx) + Math.abs(dy) > 0.5) {
        el.animate([{ translate: `${dx}px ${dy}px` }, { translate: '0 0' }], { duration: 320, easing: EASE });
      }
    }
  };

  const saveOrder = () => {
    state.layout.dock = [...dock.querySelectorAll('.hi')].map(tile => tile.dataset.open);
    const onBoard = [...grid.querySelectorAll(':scope > .hi')].map(tile => tile.dataset.open);
    state.layout.apps = [...onBoard, ...state.layout.dock];
    if (state.placed) state.layout.pos = Object.fromEntries(Object.entries(state.placed).map(([key, spot]) => [key, [spot.c, spot.r]]));
    saveLayout();
  };

  function startDrag(event) {
    const item = press.item;
    // A settle or slide still running would override the position it follows.
    for (const run of item.getAnimations()) run.cancel();
    item.classList.add('is-dragging');
    const box = item.getBoundingClientRect();
    // Anchored by the centre, so an icon that changes size in the dock stays under the finger.
    drag = {
      item, widget: item.matches('[data-widget]'), x: press.x, y: press.y,
      cx: box.left + box.width / 2, cy: box.top + box.height / 2,
      // Where in the item it was picked up, so its top-left cell follows that point.
      grabX: press.x - box.left, grabY: press.y - box.top,
    };
    try { home.setPointerCapture(press.id); } catch (_) { /* synthetic event */ }
    moveDrag(event);
  }

  function moveDrag(event) {
    const { item } = drag;
    const under = document.elementFromPoint(event.clientX, event.clientY);
    const overDock = under && under.closest('#home-dock');
    if (!drag.widget && overDock) {
      // Into the dock, or along it.
      const target = under.closest('#home-dock .hi');
      const full = item.parentElement !== dock && dock.querySelectorAll('.hi').length >= DOCK_MAX;
      if (!full && target !== item && (target || item.parentElement !== dock)) {
        flip(() => {
          if (state.placed) delete state.placed[boardKey(item)];
          item.style.gridColumn = ''; item.style.gridRow = '';
          if (!target) { dock.appendChild(item); return; }
          const siblings = [...dock.children];
          const after = item.parentElement === dock && siblings.indexOf(target) > siblings.indexOf(item);
          dock.insertBefore(item, after ? target.nextSibling : target);
        });
      }
    } else if (state.placed && under && under.closest('#home-grid, .home-layout, .home-stage')) {
      // Anywhere on the board: the item's top-left cell follows the point it
      // was picked up by; a free spot takes it, an app swaps with an app.
      const key = boardKey(item);
      const [w, h] = sizeOf(key);
      const area = grid.getBoundingClientRect();
      const c = Math.min(state.cols - w, Math.max(0, Math.round((event.clientX - drag.grabX - area.left) / CELL)));
      const r = Math.max(0, Math.round((event.clientY - drag.grabY - area.top) / CELL));
      const now = state.placed[key];
      if (!now || now.c !== c || now.r !== r) {
        if (fits(state.placed, c, r, w, h, state.cols, key)) {
          flip(() => {
            if (item.parentElement !== grid) grid.appendChild(item);
            state.placed[key] = { c, r, w, h };
            placeOnBoard(item, state.placed[key]);
          });
        } else if (!drag.widget && now) {
          const other = Object.keys(state.placed).find(k => k !== key && !k.startsWith('w:') && state.placed[k].c === c && state.placed[k].r === r);
          const otherEl = other && grid.querySelector(`:scope > .hi[data-open="${other}"]`);
          if (otherEl) {
            flip(() => {
              state.placed[other] = { ...now };
              state.placed[key] = { c, r, w, h };
              placeOnBoard(otherEl, state.placed[other]);
              placeOnBoard(item, state.placed[key]);
            });
          }
        }
      }
    } else if (!state.placed && !drag.widget) {
      // A phone's flowing grid: apps swap places in order.
      const target = under && under.closest('#home-grid > .hi');
      if (target && target !== item) {
        flip(() => {
          if (item.parentElement !== grid) grid.appendChild(item);
          const siblings = [...grid.children];
          grid.insertBefore(item, siblings.indexOf(target) > siblings.indexOf(item) ? target.nextSibling : target);
        });
      }
    }
    // The item stays under the finger wherever its slot now is.
    for (const run of item.getAnimations()) run.cancel();
    item.style.transform = 'none';
    const box = item.getBoundingClientRect();
    item.style.transform = `translate(${drag.cx + (event.clientX - drag.x) - (box.left + box.width / 2)}px, ${drag.cy + (event.clientY - drag.y) - (box.top + box.height / 2)}px) scale(1.06)`;
  }

  function endDrag() {
    let { item } = drag;
    drag = null;
    const lifted = item.style.transform;
    item.classList.remove('is-dragging');
    item.style.transform = '';
    // An app keeps the icon size of the row it landed in.
    if (item.matches('.hi')) {
      const app = APPS.find(entry => entry.id === item.dataset.open);
      const size = item.parentElement === dock ? 32 : 44;
      const svg = item.querySelector('.hi-tile svg');
      if (app && svg && Number(svg.getAttribute('width')) !== size) {
        const fresh = document.createElement('template');
        fresh.innerHTML = tileMarkup(app, size).trim();
        const tile = fresh.content.firstElementChild;
        tile.style.gridColumn = item.style.gridColumn;
        tile.style.gridRow = item.style.gridRow;
        item.replaceWith(tile);
        item = tile;
      }
    }
    item.animate([{ transform: lifted || 'none' }, { transform: 'none' }], { duration: 300, easing: EASE });
    saveOrder();
  }

  home.addEventListener('pointerdown', event => {
    if (event.button > 0 || event.target.closest('.home-indicator, .home-editbar, .wg-gallery, .wg-remove')) return;
    press = { x: event.clientX, y: event.clientY, id: event.pointerId, item: draggableAt(event.target) };
    if (editing()) { if (press.item) event.preventDefault(); return; }
    // Holding anywhere, an icon or a widget included, starts editing; keep
    // the finger down and the item it is on can be dragged straight away.
    hold = setTimeout(() => { hold = null; swallowClick = true; enter(); }, 500);
  });
  home.addEventListener('pointermove', event => {
    if (!press) return;
    const moved = Math.hypot(event.clientX - press.x, event.clientY - press.y);
    if (hold) {
      if (moved > 10) { clearTimeout(hold); hold = null; press = null; }
      return;
    }
    if (!editing() || !press.item) return;
    if (!drag && moved > 4) startDrag(event);
    else if (drag) moveDrag(event);
  });
  const release = () => {
    if (hold) { clearTimeout(hold); hold = null; }
    if (drag) { endDrag(); swallowClick = true; }
    press = null;
  };
  home.addEventListener('pointerup', release);
  home.addEventListener('pointercancel', release);
  home.addEventListener('contextmenu', event => { if (event.target.closest('#efb-home')) event.preventDefault(); });

  // While editing nothing opens; a tap on the bare wallpaper finishes.
  home.addEventListener('click', event => {
    if (swallowClick) { swallowClick = false; event.preventDefault(); event.stopPropagation(); return; }
    if (!editing()) return;
    const remove = event.target.closest('[data-remove]');
    if (remove) {
      event.preventDefault(); event.stopPropagation();
      flip(() => {
        state.layout.widgets = state.layout.widgets.filter(id => id !== remove.dataset.remove);
        delete state.layout.pos[`w:${remove.dataset.remove}`];
        applyWidgets();
      });
      saveLayout();
      return;
    }
    if (event.target.closest('.home-editbar, .wg-gallery')) return;
    if (draggableAt(event.target) || event.target.closest('.home-dock')) { event.preventDefault(); event.stopPropagation(); return; }
    exit();
  }, true);

  document.getElementById('he-done')?.addEventListener('click', exit);
  document.getElementById('he-add')?.addEventListener('click', () => {
    const missing = WIDGETS.filter(widget => !state.layout.widgets.includes(widget.id));
    list.innerHTML = missing.length
      ? missing.map(widget => `<div><span>${esc(widget.name)}</span><button type="button" data-add="${esc(widget.id)}">Add</button></div>`).join('')
      : '<p>Every widget is already on the home screen.</p>';
    gallery.hidden = false;
  });
  document.getElementById('wg-close')?.addEventListener('click', () => { gallery.hidden = true; });
  list.addEventListener('click', event => {
    const add = event.target.closest('[data-add]');
    if (!add) return;
    flip(() => {
      state.layout.widgets.push(add.dataset.add);
      applyWidgets();
    });
    syncHomeWidget();
    syncAirportClocks();
    saveLayout();
    gallery.hidden = true;
  });
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && editing()) { event.stopPropagation(); exit(); } }, true);
}

/* The deck widget: route from the stored plan, numbers from the same bridge
   stream the Map app reads. Nothing is held on screen after the feed stops. */
function syncHomeWidget(status = state.live) {
  syncFlightWidget(status);
  if (!dom.homeWidget) return;
  const parts = flightParts(state.plan);
  const snapshot = status && status.status === 'live' ? status.snapshot : null;
  const t = snapshot && snapshot.telemetry;

  if (dom.hwRoute) {
    dom.hwRoute.innerHTML = parts && (parts.origin || parts.destination)
      ? `${esc(parts.origin || '????')}<s>→</s>${esc(parts.destination || '????')}`
      : 'No flight plan loaded';
    dom.hwRoute.classList.toggle('is-empty', !(parts && (parts.origin || parts.destination)));
  }
  if (dom.hwMeta) {
    const meta = parts
      ? [parts.callsign, parts.aircraft, parts.cruise ? `CRZ ${parts.cruise}` : ''].filter(Boolean)
      : [];
    dom.hwMeta.textContent = meta.length
      ? meta.join(' · ')
      : 'Import a SimBrief plan to show the route here';
  }
  if (dom.hwPhase) {
    // Phase comes from the recorded flight when the bridge has one, otherwise
    // from the position itself; the title says which, so a derived phase is
    // never mistaken for something the aircraft reported.
    const phase = t ? flightPhase(snapshot) : null;
    dom.hwPhase.hidden = !phase;
    dom.hwPhase.textContent = phase ? phase.label : '';
    dom.hwPhase.dataset.phase = phase ? phase.code : '';
    dom.hwPhase.title = phase
      ? (phase.derived ? 'Phase read from the current position' : 'Phase reported by the bridge')
      : '';
  }
  if (dom.hwState) {
    const name = !status ? 'offline' : status.status === 'live' ? 'live' : status.status === 'offline' ? 'offline' : 'connecting';
    dom.hwState.dataset.state = name;
    const label = dom.hwState.querySelector('span');
    if (label) label.textContent = !status ? 'Offline' : status.status === 'live' ? 'Connected' : status.status === 'offline' ? 'Offline' : 'Waiting';
  }
  if (!dom.hwTele) return;
  if (t) {
    const vs = Number(t.vs);
    const vsText = Number.isFinite(vs) ? `${vs > 0 ? '+' : vs < 0 ? '−' : ''}${Math.abs(Math.round(vs / 10) * 10)}` : '—';
    const trend = Number.isFinite(vs) && vs > 200 ? 'climb' : Number.isFinite(vs) && vs < -200 ? 'descent' : 'level';
    dom.hwTele.innerHTML = `
      <span class="hw-cell"><em>Altitude</em><b>${esc(fmtFl(t.alt))}</b>${t.agl != null ? `<small>${esc(fmtFt(t.agl))} AGL</small>` : ''}</span>
      <span class="hw-cell"><em>Ground speed</em><b>${esc(fmtKt(t.gs))}</b>${Number.isFinite(Number(t.hdg)) ? `<small>hdg ${String(Math.round(t.hdg)).padStart(3, '0')}°</small>` : ''}</span>
      <span class="hw-cell"><em>Vertical speed</em><b>${esc(vsText)}<small class="hw-unit"> fpm</small></b><small>${esc(trend)}</small></span>`;
    return;
  }
  const reason = status && status.status === 'offline'
    ? 'The simulator is offline. Open the map for the connection details.'
    : status && status.status === 'waiting'
      ? 'The bridge is up; no simulator telemetry is arriving yet.'
      : 'Waiting for the simulator. Open the map to connect.';
  dom.hwTele.innerHTML = `<span class="hw-hint">${esc(reason)}</span>`;
}


/* ── lock screen ─────────────────────────────────────────────────────── */

/* Shown each time the bag opens, over the deck's wallpaper so the airline's
   mark stays behind it. A tap, an upward swipe or any key opens the deck. */
function setupLock() {
  const lock = document.getElementById('efb-lock');
  if (!lock) return;
  // Moving between Stratos pages (the Flight Deck rail, the phone's EFB tab)
  // skips it; opening the bag from the website, a home-screen icon or a new
  // tab shows it.
  try {
    const from = document.referrer ? new URL(document.referrer) : null;
    if (from && from.origin === location.origin && /\/(app|phone)(\/|$)/.test(from.pathname)) return;
  } catch (_) { /* unreadable referrer: show the lock */ }
  dom.lock = lock;
  for (const ticks of lock.querySelectorAll('.lkf-ticks')) {
    ticks.innerHTML = Array.from({ length: 12 }, (_, i) =>
      `<line x1="50" y1="6" x2="50" y2="${i % 3 ? 11 : 15}" transform="rotate(${i * 30} 50 50)"/>`).join('');
  }
  document.body.classList.add('efb-locked');
  lock.hidden = false;
  updateLock();

  const onKey = event => {
    if (event.key === 'Tab' || event.metaKey || event.ctrlKey || event.altKey) return;
    event.preventDefault();
    event.stopPropagation();
    open();
  };
  // The lock follows the finger up, the deck comes in under it, and a release
  // either finishes the unlock or springs back, as on iOS.
  const drag = swipeUp(lock, {
    move(rise, height) {
      const progress = Math.max(0, Math.min(1, rise / height));
      lock.style.transform = `translate3d(0, ${-rise}px, 0)`;
      lock.style.opacity = String(1 - progress * 0.5);
      document.body.style.setProperty('--unlock', (progress * 1.6 > 1 ? 1 : progress * 1.6).toFixed(3));
    },
    start() { lock.classList.add('lk-drag'); document.body.classList.add('lk-dragging'); },
    end(done) {
      lock.classList.remove('lk-drag');
      document.body.classList.remove('lk-dragging');
      if (done) { open(); return; }
      lock.style.transform = '';
      lock.style.opacity = '';
      document.body.style.removeProperty('--unlock');
    },
  });
  function open() {
    if (lock.dataset.opening) return;
    lock.dataset.opening = '1';
    document.removeEventListener('keydown', onKey, true);
    drag.detach();
    lock.style.transform = 'translate3d(0, -100%, 0)';
    lock.style.opacity = '0';
    document.body.style.setProperty('--unlock', '1');
    setTimeout(() => {
      document.body.classList.remove('efb-locked');
      document.body.style.removeProperty('--unlock');
      lock.hidden = true;
      lock.removeAttribute('style');
      delete lock.dataset.opening;
    }, 520);
  }
  document.addEventListener('keydown', onKey, true);
  try { document.getElementById('lk-open').focus({ preventScroll: true }); } catch (_) { /* no focus API */ }
}

/* An upward swipe on an element, followed by the finger: `move(rise, height)`
   on every frame of the drag, `end(done)` on release, where done is a swipe
   past 15% of the screen, a quick flick, or a tap. Pulling down meets
   resistance instead of moving freely, like iOS's rubber band. */
function swipeUp(el, { move, start, end }) {
  let from = null, lastY = 0, lastT = 0, speed = 0, id = null;
  const height = () => window.innerHeight || el.clientHeight || 800;
  const down = event => {
    from = event.clientY; lastY = from; lastT = event.timeStamp; speed = 0; id = event.pointerId;
    try { el.setPointerCapture(id); } catch (_) { /* synthetic event */ }
    start && start();
  };
  const moveTo = event => {
    if (from == null) return;
    const dt = Math.max(1, event.timeStamp - lastT);
    speed = (lastY - event.clientY) / dt;
    lastY = event.clientY; lastT = event.timeStamp;
    const raw = from - event.clientY;
    move(raw >= 0 ? raw : -Math.min(40, Math.sqrt(-raw) * 3), height());
  };
  const up = event => {
    if (from == null) return;
    const rise = from - event.clientY;
    from = null;
    end(rise > height() * 0.15 || (rise > 12 && speed > 0.45) || Math.abs(rise) < 8);
  };
  const cancel = () => { if (from == null) return; from = null; end(false); };
  el.addEventListener('pointerdown', down);
  el.addEventListener('pointermove', moveTo);
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', cancel);
  return {
    detach() {
      el.removeEventListener('pointerdown', down);
      el.removeEventListener('pointermove', moveTo);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', cancel);
    },
  };
}

/* The home bar on the deck: swiping it up (or tapping it) shrinks the bag
   away, like closing an app, and returns to the Flight Deck. */
function setupHomeIndicator() {
  const bar = document.getElementById('home-indicator');
  const home = document.getElementById('efb-home');
  if (!bar || !home) return;
  let leaving = false;
  const leave = () => {
    if (leaving) return;
    leaving = true;
    home.classList.remove('hm-drag');
    home.style.transform = '';
    home.style.opacity = '';
    home.classList.add('hm-leaving');
    setTimeout(() => { location.href = 'index.html'; }, 400);
  };
  swipeUp(bar, {
    start() { home.classList.add('hm-drag'); },
    move(rise, height) {
      const progress = Math.max(0, Math.min(1, rise / height));
      home.style.transform = `translate3d(0, ${-rise * 0.5}px, 0) scale(${1 - progress * 0.35})`;
      home.style.borderRadius = `${Math.round(progress * 120)}px`;
    },
    end(done) {
      if (done) { leave(); return; }
      home.classList.remove('hm-drag');
      home.style.transform = '';
      home.style.borderRadius = '';
    },
  });
  bar.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); leave(); }
  });
}

function updateLock() {
  const lock = dom.lock;
  if (!lock || lock.hidden) return;
  const now = new Date();
  const set = (id, text) => { const el = document.getElementById(id); if (el) el.textContent = text; };
  set('lk-date', now.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' }));
  set('lk-time', now.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }).replace(/\s*[AaPp]\.?\s?[Mm]\.?$/, ''));
  set('lk-utc', `${now.toISOString().slice(11, 16)} UTC`);
  const hands = (id, h, m) => {
    document.getElementById(`${id}-h`)?.setAttribute('transform', `rotate(${(h % 12) * 30 + m / 2} 50 50)`);
    document.getElementById(`${id}-m`)?.setAttribute('transform', `rotate(${m * 6} 50 50)`);
  };
  hands('lk-utc', now.getUTCHours(), now.getUTCMinutes());
  hands('lk-lcl', now.getHours(), now.getMinutes());

  const parts = flightParts(state.plan);
  const items = parts ? [
    parts.origin || parts.destination ? `${parts.origin || '????'} → ${parts.destination || '????'}` : '',
    [parts.callsign, parts.aircraft].filter(Boolean).join(' · '),
    [parts.cruise ? `Cruise ${parts.cruise}` : '', parts.alternate ? `Alternate ${parts.alternate}` : ''].filter(Boolean).join(' · '),
  ].filter(Boolean) : [];
  const list = document.getElementById('lk-flight');
  if (list) {
    list.innerHTML = items.length
      ? items.map(item => `<li>${esc(item)}</li>`).join('')
      : '<li class="lk-empty">No flight plan loaded</li>';
  }
  set('lk-count', items.length ? String(items.length) : '');

  const sim = dom.conn ? dom.conn.dataset.state : 'offline';
  lock.dataset.sim = sim;
  set('lk-sim', sim === 'live' ? 'Connected' : sim === 'connecting' ? 'Waiting for the simulator' : 'Offline');
  const meter = document.getElementById('lk-meter');
  if (meter) meter.style.width = sim === 'live' ? '100%' : sim === 'connecting' ? '40%' : '0%';

  const cal = document.getElementById('lk-cal');
  const day = now.toDateString();
  if (cal && cal.dataset.day !== day) {
    cal.dataset.day = day;
    const year = now.getFullYear(), month = now.getMonth(), first = new Date(year, month, 1).getDay();
    const days = new Date(year, month + 1, 0).getDate();
    const cells = Array(first).fill('').concat(Array.from({ length: days }, (_, i) => i + 1));
    while (cells.length % 7) cells.push('');
    const rows = [];
    for (let i = 0; i < cells.length; i += 7) {
      rows.push(`<tr>${cells.slice(i, i + 7).map(d => d === now.getDate()
        ? `<td class="lk-today"><span>${d}</span></td>` : `<td>${d}</td>`).join('')}</tr>`);
    }
    const heads = ['S', 'M', 'T', 'W', 'T', 'F', 'S'].map(d => `<th>${d}</th>`).join('');
    cal.innerHTML = `<b>${esc(now.toLocaleDateString(undefined, { month: 'long' }).toUpperCase())}</b><table><thead><tr>${heads}</tr></thead><tbody>${rows.join('')}</tbody></table>`;
  }
}

function syncHomeBar() {
  updateLock();
  if (dom.homeFlight) {
    const parts = flightParts(state.plan);
    dom.homeFlight.innerHTML = parts
      ? `${parts.callsign ? `<b>${esc(parts.callsign)}</b>` : ''}${parts.origin || parts.destination ? `<span>${esc(parts.origin || '????')} → ${esc(parts.destination || '????')}</span>` : ''}${parts.aircraft ? `<span>${esc(parts.aircraft)}</span>` : ''}`
      : '<span class="e-faint">No flight plan loaded</span>';
  }
  if (dom.homeDate) {
    dom.homeDate.textContent = new Date().toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short' }).toUpperCase();
  }
  if (dom.homeConn) {
    const live = dom.conn ? dom.conn.dataset.state : 'offline';
    dom.homeConn.dataset.state = live;
    const label = dom.homeConn.querySelector('span');
    if (label) label.textContent = live === 'live' ? 'Connected' : live === 'connecting' ? 'Waiting' : 'Offline';
  }
}

function showHome() {
  closeApp();
  state.app = HOME_ROUTE;
  document.body.classList.add('view-home');
  if (dom.home) dom.home.hidden = false;
  markActive(HOME_ROUTE);
  document.title = 'Stratos EFB';
  syncHomeBar();
}

/* ── top bar ─────────────────────────────────────────────────────────── */

/* The flight this bag is showing. A route built in the Flight Plan app carries
   the plan it came from in the shared record, so it names its own airports and
   cruise. The SimBrief plan supplies the callsign and the aircraft, and only
   while that plan is this route's own city pair: a plan left loaded from an
   earlier flight is never read as if it were the route on the chart. */
function flightParts(plan) {
  const ofp = plan && plan.ofp;
  const meta = loadRouteMeta();
  const own = meta.plan || null;
  if (!own) {
    if (!ofp) return null;
    const origin = (ofp.origin && ofp.origin.icao) || '';
    const destination = (ofp.destination && ofp.destination.icao) || '';
    if (!origin && !destination && !(ofp.flight && ofp.flight.callsign)) return null;
    return {
      callsign: (ofp.flight && ofp.flight.callsign) || '',
      origin,
      destination,
      aircraft: (ofp.aircraft && (ofp.aircraft.icao || ofp.aircraft.type)) || '',
      cruise: ofp.flight && ofp.flight.cruiseFt ? fmtFl(ofp.flight.cruiseFt) : '',
      alternate: (ofp.alternate && ofp.alternate.icao) || '',
    };
  }
  const origin = (own.origin && own.origin.id) || '';
  const destination = (own.destination && own.destination.id) || '';
  if (!origin && !destination) return null;
  const sameFlight = Boolean(ofp && origin && destination
    && ((ofp.origin && ofp.origin.icao) || '') === origin
    && ((ofp.destination && ofp.destination.icao) || '') === destination);
  return {
    callsign: sameFlight ? (ofp.flight && ofp.flight.callsign) || '' : '',
    origin,
    destination,
    aircraft: sameFlight ? (ofp.aircraft && (ofp.aircraft.icao || ofp.aircraft.type)) || '' : '',
    cruise: meta.cruiseAlt ? fmtFl(meta.cruiseAlt) : (sameFlight && ofp.flight && ofp.flight.cruiseFt ? fmtFl(ofp.flight.cruiseFt) : ''),
    alternate: (own.alternate && own.alternate.id) || (sameFlight && ofp.alternate ? ofp.alternate.icao : '') || '',
  };
}

function renderFlightStrip() {
  if (!dom.flight) return;
  const parts = flightParts(state.plan);
  if (!parts) {
    dom.flight.innerHTML = '<span class="et-flight-empty">No flight plan loaded</span>';
    return;
  }
  const meta = [parts.aircraft, parts.cruise ? `CRZ ${parts.cruise}` : '', parts.alternate ? `ALTN ${parts.alternate}` : '']
    .filter(Boolean).join(' · ');
  dom.flight.innerHTML = `
    ${parts.callsign ? `<b class="etf-callsign">${esc(parts.callsign)}</b>` : ''}
    ${parts.origin || parts.destination
      ? `<span class="etf-route">${esc(parts.origin || '????')}<s>→</s>${esc(parts.destination || '????')}</span>`
      : ''}
    ${meta ? `<span class="etf-meta">${esc(meta)}</span>` : ''}`;
}

function setConnection(status) {
  const el = dom.conn;
  if (!el) return;
  const stateName = status.status === 'live' ? 'live' : status.status === 'offline' ? 'offline' : 'connecting';
  el.dataset.state = stateName;
  const label = el.querySelector('span');
  if (label) label.textContent = connectionText(status.status);
  el.title = status.detail || (status.health ? `Bridge ${status.health.version || ''}` : 'Simulator connection');
}

function updateClock() {
  const time = new Date().toISOString().slice(11, 16);
  if (dom.clock) dom.clock.innerHTML = `${time}<small>Z</small>`;
  const home = document.getElementById('home-clock');
  if (home) home.textContent = time;
  // the clock widget: an analogue face on UTC, the digital UTC and local time
  const now = new Date(), h = now.getUTCHours() % 12, m = now.getUTCMinutes(), sec = now.getUTCSeconds();
  const turn = (id, deg) => document.getElementById(id)?.setAttribute('transform', `rotate(${deg} 50 50)`);
  turn('hcw-h', h * 30 + m / 2); turn('hcw-m', m * 6 + sec / 10); turn('hcw-s', sec * 6);
  const utc = document.getElementById('hcw-utc'), lcl = document.getElementById('hcw-lcl');
  if (utc) utc.textContent = time;
  if (lcl) lcl.textContent = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  syncAirportClocks();
  updateLock();
}

/* ── routing ─────────────────────────────────────────────────────────── */

function parseRoute() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [id, query] = raw.split('?');
  return { id: id || '', params: new URLSearchParams(query || '') };
}

function setPageHead(app) {
  if (dom.pageTitle) dom.pageTitle.textContent = app.title;
  if (dom.pageSub) dom.pageSub.textContent = app.subtitle || '';
  if (dom.actions) dom.actions.innerHTML = '';
}

export function closeApp() {
  if (state.cleanup) {
    try { state.cleanup(); } catch (_) { /* a section must not block the shell */ }
    state.cleanup = null;
  }
  state.app = null;
  state.query = '';
  if (dom.body) dom.body.innerHTML = '';
  if (dom.actions) dom.actions.innerHTML = '';
}

async function openApp(id, params = new URLSearchParams()) {
  const app = APPS.find(item => item.id === id) || APPS[0];
  // Same app and same query: nothing to do. A new query (#/airport?icao=EGLL
  // while KSEA is open) remounts it, since each page reads ctx.params once.
  const query = params.toString();
  if (state.app === app.id && state.query === query) return;
  closeApp();
  document.body.classList.remove('view-home');
  if (dom.home) dom.home.hidden = true;
  state.app = app.id;
  state.query = query;
  markActive(app.id);
  setPageHead(app);
  document.title = `${app.title} · Stratos EFB`;
  if (dom.body) dom.body.scrollTop = 0;

  const ctx = {
    params,
    prefs: () => loadPrefs(),
    setPrefs(patch) { state.prefs = savePrefs(patch); applyPreferences(); },
    go(destination, query = {}) {
      const next = new URLSearchParams(query);
      const suffix = next.toString();
      location.hash = `#/${destination}${suffix ? `?${suffix}` : ''}`;
    },
    home: () => { location.hash = `#/${DEFAULT_ROUTE}`; },
    setActions(html) { if (dom.actions) dom.actions.innerHTML = html || ''; },
    setSubtitle(text) { if (dom.pageSub) dom.pageSub.textContent = text || ''; },
    plan: () => state.plan,
    route: () => state.route,
    refreshPlan: async id2 => {
      const { refreshPlan } = await import('./efb/common.js');
      return refreshPlan(id2);
    },
    notify(message, tone = '') {
      if (!dom.body) return;
      const notice = document.createElement('div');
      notice.className = `e-notice ${tone}`.trim();
      notice.textContent = message;
      dom.body.prepend(notice);
      setTimeout(() => notice.remove(), 6000);
    },
  };

  try {
    const module = await import(app.module);
    const result = await module.mount(dom.body, ctx);
    if (result && typeof result.destroy === 'function') state.cleanup = result.destroy;
    if (result && result.actions && dom.actions) dom.actions.innerHTML = result.actions;
  } catch (error) {
    console.error(error);
    dom.body.innerHTML = `<div class="e-notice bad"><div><b>${esc(app.title)} could not start.</b><br>${esc(error.message)}</div></div>
      <div class="e-row" style="margin-top:12px"><button class="e-btn" type="button" data-retry>Retry</button></div>`;
    dom.body.querySelector('[data-retry]')?.addEventListener('click', () => {
      state.app = null;
      closeApp();
      location.hash = `#/${app.id}`;
    });
  }
}

function route() {
  const { id, params } = parseRoute();
  if (!id) {
    history.replaceState(null, '', `#/${HOME_ROUTE}`);
    showHome();
    return;
  }
  if (id === HOME_ROUTE) {
    showHome();
    return;
  }
  if (LEGACY_ROUTES[id]) {
    // Rewrite the address rather than only opening the app, so a reload or a
    // shared link lands on the current name.
    const suffix = params.toString();
    history.replaceState(null, '', `#/${LEGACY_ROUTES[id]}${suffix ? `?${suffix}` : ''}`);
    openApp(LEGACY_ROUTES[id], params);
    return;
  }
  if (!APPS.some(app => app.id === id)) {
    history.replaceState(null, '', `#/${HOME_ROUTE}`);
    showHome();
    return;
  }
  openApp(id, params);
}

/* ── boot ────────────────────────────────────────────────────────────── */

function bindEvents() {
  document.addEventListener('click', event => {
    const open = event.target.closest('[data-app]');
    if (open) {
      // One path for every section: the URL describes the page, and the router
      // mounts it. Selecting the section already on screen changes nothing.
      event.preventDefault();
      const id = open.dataset.app;
      if (state.app !== id) location.hash = `#/${id}`;
    }
  });
  window.addEventListener('hashchange', route);
  window.addEventListener('resize', () => { syncNavFade(); syncHomeBar(); });
  // The board is laid out for the width it has, including when the deck first
  // appears after the lock screen or an app (it measures 0 while hidden).
  if (typeof ResizeObserver === 'function' && dom.homeGrid && dom.homeGrid.parentElement) {
    let lastWidth = -1;
    new ResizeObserver(entries => {
      const width = Math.round(entries[0].contentRect.width);
      if (width !== lastWidth) { lastWidth = width; positionBoard(); }
    }).observe(dom.homeGrid.parentElement);
  }
  dom.nav?.addEventListener('scroll', syncNavFade, { passive: true });
  document.addEventListener('keydown', event => {
    const target = event.target;
    const typing = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT');
    if (event.key !== 'Escape') return;
    if (typing) { target.blur(); return; }
    // Escape is the keyboard equivalent of the home gesture, except at home.
    if (state.app && state.app !== HOME_ROUTE) location.hash = `#/${HOME_ROUTE}`;
  });
}

export async function boot() {
  dom.nav = document.getElementById('efb-nav');
  dom.body = document.getElementById('efb-body');
  dom.actions = document.getElementById('efb-actions');
  dom.pageTitle = document.getElementById('efb-page-title');
  dom.pageSub = document.getElementById('efb-page-sub');
  dom.flight = document.getElementById('et-flight');
  dom.conn = document.getElementById('esb-conn');
  dom.clock = document.getElementById('esb-clock');
  dom.home = document.getElementById('efb-home');
  dom.homeGrid = document.getElementById('home-grid');
  dom.homeDock = document.getElementById('home-dock');
  dom.homeFlight = document.getElementById('home-flight');
  dom.homeDate = document.getElementById('home-date');
  dom.homeConn = document.getElementById('home-conn');
  dom.homeWidget = document.getElementById('home-widget');
  dom.hwRoute = document.getElementById('hw-route');
  dom.hwMeta = document.getElementById('hw-meta');
  dom.hwState = document.getElementById('hw-state');
  dom.hwPhase = document.getElementById('hw-phase');
  dom.hwTele = document.getElementById('hw-tele');
  dom.airline = document.getElementById('et-airline');
  dom.homeAirline = document.getElementById('home-airline');
  dom.airlineWallpaper = document.getElementById('home-airline-logo');

  state.plan = currentPlan();
  state.route = loadRoute();
  applyPreferences();
  renderNav();
  renderHome();
  renderFlightStrip();
  updateClock();
  syncHomeWidget();
  syncHomeBar();
  if (state.clockTimer) clearInterval(state.clockTimer);
  state.clockTimer = setInterval(updateClock, 15000);

  onPlanChange(plan => {
    state.plan = plan;
    renderFlightStrip();
    syncHomeWidget();
    syncHomeBar();
    // A new plan can mean a new callsign, and so a different airline.
    applyAirlineState();
  });

  state.unsubLive = onLive(status => {
    state.live = status;
    setConnection(status);
    syncHomeWidget(status);
    syncHomeBar();
    // Detection falls back to the callsign the simulator (or the bridge's
    // recorded flight) reports, and only re-resolves when it actually changes.
    const flight = status.snapshot && (status.snapshot.currentFlight || status.snapshot.flight);
    const callsign = String((flight && flight.callsign) || '').trim().toUpperCase();
    if (callsign !== state.liveCallsign) {
      state.liveCallsign = callsign;
      applyAirlineState();
    }
    if (state.app === 'navigator' || state.app === 'briefing') {
      window.dispatchEvent(new CustomEvent('stratos:efb-live', { detail: status }));
    }
  });

  bindEvents();
  syncNavFade();
  setupLock();
  setupHomeIndicator();
  setupHomeEdit();
  route();
}

if (typeof document !== 'undefined' && document.getElementById('efb-nav')) {
  boot().catch(error => {
    console.error(error);
    const body = document.getElementById('efb-body');
    if (body) {
      body.innerHTML = `<div class="e-notice bad"><div><b>Stratos EFB could not start.</b><br>${esc(error.message)}</div></div>`;
    }
  });
}

if (typeof window !== 'undefined') {
  window.StratosEFB = {
    apps: APPS,
    open: id => { location.hash = `#/${id}`; },
    home: () => { location.hash = `#/${DEFAULT_ROUTE}`; },
    prefs: () => loadPrefs(),
  };
}

// The update prompt belongs to every surface, not just the cockpit shell: a
// phone on the EFB, the live page and the airport pages should hear about a new
// release too. The check is background work and never blocks the first frame.
import('./update-ui.js')
  .then(({ initAppUpdates }) => initAppUpdates({ desktop: window.stratosDesktop || null }))
  .catch(() => { /* the Settings update centre still works on demand */ });
