/* Chart directory: which authority publishes an airport's charts.
 *
 * Built entirely from the worldwide registry in data/chart-sources.js. This
 * module only *resolves*: it maps an ICAO location indicator to the country
 * that governs it, that country's registered publisher, and the publisher's
 * licence category. It never contains a document URL, and it never fetches.
 *
 * A link is not a redistribution licence. A publisher is offered here so the
 * interface can point a pilot at the official source and state honestly what
 * Stratos may do with that publisher's charts.
 */

import {
  ACCESS, CHART_SOURCES, COUNTRIES, LICENCES, REGIONAL_SOURCES, REGIONS, SOURCE_BY_ID,
  accessFor, accessKeyFor, establishedFor, licenceFor,
} from '../data/chart-sources.js';

export { ACCESS, COUNTRIES, LICENCES, REGIONS, accessFor, accessKeyFor, establishedFor, licenceFor };

/** Every registered publisher, national and regional, for documentation. */
export const LISTED_PUBLISHERS = [...CHART_SOURCES, ...REGIONAL_SOURCES];

/* Longest prefix first, so a specific state wins over a broader block. */
const PREFIXES = CHART_SOURCES
  .flatMap(entry => entry.icao.map(prefix => ({ prefix: String(prefix).toUpperCase(), entry })))
  .sort((a, b) => b.prefix.length - a.prefix.length);

const COUNTRY_BY_ISO = new Map(COUNTRIES.map(country => [country.iso2, country]));

function normalIcao(icao) {
  const code = String(icao || '').trim().toUpperCase();
  return /^[A-Z]{2}[A-Z0-9]{2}$/.test(code) ? code : '';
}

/** The publisher that owns an airport's charts, or null when none is registered. */
export function publisherFor(icao) {
  const code = normalIcao(icao);
  if (!code) return null;
  const match = PREFIXES.find(entry => code.startsWith(entry.prefix));
  return match ? match.entry : null;
}

/** Country record for an airport, or null when no publisher is registered. */
export function countryForIcao(icao) {
  const publisher = publisherFor(icao);
  if (!publisher) return null;
  const country = COUNTRY_BY_ISO.get(publisher.iso2);
  return country || { iso2: publisher.iso2, name: publisher.country, region: publisher.region, sources: [publisher.id] };
}

/** Publishers registered for a country, by ISO 3166-1 alpha-2 code. */
export function sourcesForCountry(iso2) {
  const code = String(iso2 || '').trim().toUpperCase();
  return CHART_SOURCES.filter(entry => entry.iso2 === code);
}

/** Publishers registered in a region, for the country picker. */
export function sourcesForRegion(region) {
  const name = String(region || '').trim();
  return name ? CHART_SOURCES.filter(entry => entry.region === name) : [];
}

/** Countries in a region, for the region → country picker. */
export function countriesForRegion(region) {
  const name = String(region || '').trim();
  return name ? COUNTRIES.filter(country => country.region === name) : COUNTRIES;
}

/** True when an airport resolves to a registered publisher outside the FAA. */
export function isListedRegion(icao) {
  const publisher = publisherFor(icao);
  return Boolean(publisher) && publisher.id !== 'faa-dtpp';
}

const isEuropean = code => /^[ELB]/.test(String(code || ''));

/**
 * Official sources for an airport, in the order a pilot should try them.
 * An empty list means no publisher is registered for that part of the world —
 * which is coverage information, never a reason to show an invented chart.
 */
export function officialSourcesFor(icao) {
  const code = normalIcao(icao);
  if (!code) return [];
  const publisher = publisherFor(code);
  if (publisher) {
    // A European state is also served by the EUROCONTROL indexes, so they are
    // offered after the national publisher. Everywhere else the national
    // authority is the only listed source.
    if (publisher.region === 'Europe') {
      return [publisher, ...REGIONAL_SOURCES.filter(entry => entry.id !== publisher.id)];
    }
    return [publisher];
  }
  if (isEuropean(code)) return REGIONAL_SOURCES;
  return [];
}

/** Publishers for a country name, used by the licensing report. */
export function sourcesForCountryName(name) {
  const wanted = String(name || '').trim().toLowerCase();
  return CHART_SOURCES.filter(entry => entry.country.toLowerCase() === wanted);
}

/** One-line explanation for a catalogue's outside-coverage state. */
export function coverageText(icao) {
  const sources = officialSourcesFor(icao);
  if (!sources.length) return 'Stratos has no registered chart publisher for this region.';
  const licence = licenceFor(sources[0].licence);
  if (sources[0].licence === 'FREE_REUSE') {
    return 'Stratos can embed this publisher’s documents under its reuse terms.';
  }
  return `${sources[0].name}: ${licence.detail} Open the official source and use the chart there.`;
}

/** Honest one-line summary of what is actually integrated. */
export function registrySummary() {
  const integrated = CHART_SOURCES.filter(entry => entry.licence === 'FREE_REUSE');
  const listed = CHART_SOURCES.filter(entry => entry.licence !== 'FREE_REUSE');
  return `Integrated charts: ${integrated.map(entry => entry.country).join(', ') || 'none'}. `
    + `${listed.length} further publishers are registered with official links; their charts open at the source until a reuse licence is agreed.`;
}

/** Counts for the licensing report and the interface footer. */
export function registryStats() {
  const byLicence = {};
  for (const entry of CHART_SOURCES) byLicence[entry.licence] = (byLicence[entry.licence] || 0) + 1;
  return {
    publishers: CHART_SOURCES.length + REGIONAL_SOURCES.length,
    countries: COUNTRIES.length,
    byLicence,
  };
}

/** Publisher record by id, or null. */
export function sourceById(id) {
  return SOURCE_BY_ID[String(id || '')] || REGIONAL_SOURCES.find(entry => entry.id === id) || null;
}
