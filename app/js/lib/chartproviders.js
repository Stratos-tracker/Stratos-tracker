/* Chart providers.
 *
 * Two publishers are integrated because their own terms allow it:
 *   - FAA d-TPP (U.S. Government work, public domain).
 *   - AIP Austria (CC BY 4.0, AIP Austria GEN 3.2 §3.1.2).
 * Every other registered publisher is link-only for a stated reason, taken from
 * its own terms rather than assumed: DFS forbids third-party display, Airservices
 * permits personal on-screen viewing only, NAV CANADA sells its charts.
 *
 * Coverage therefore answers four questions honestly — which publisher owns the
 * charts, what its access category is, why Stratos can or cannot display the
 * documents, and where the pilot can open them.
 */

import { FAA_SOURCE, categoryLabel } from './charts.js';
import { EAIP_LIST, eaipForIcao } from './eaip.js';
import {
  ACCESS, accessKeyFor, countryForIcao, coverageText, establishedFor, licenceFor,
  LISTED_PUBLISHERS, officialSourcesFor, publisherFor,
} from './chartdir.js';

const ALL_CATEGORIES = ['diagram', 'sid', 'star', 'approach', 'odp', 'minimums', 'hotspot', 'supplement', 'enroute', 'vfr'];

export const FAA_PROVIDER = {
  id: FAA_SOURCE.id,
  name: FAA_SOURCE.name,
  publisher: FAA_SOURCE.publisher,
  status: 'integrated',
  country: 'United States',
  iso2: 'US',
  regions: ['United States and territories'],
  categories: ALL_CATEGORIES,
  format: 'PDF',
  update: '28-day d-TPP publication cycle',
  retrieval: 'cycle',
  attribution: FAA_SOURCE.license,
  licence: FAA_SOURCE.license,
  licenceCategory: 'FREE_REUSE',
  access: 'AVAILABLE_IN_APP',
  accessLabel: ACCESS.AVAILABLE_IN_APP.label,
  terms: FAA_SOURCE.terms,
  redistributable: true,
  checked: '2026-11-06',
  note: 'U.S. Government work in the public domain.',
};

/** Descriptor for an eAIP publisher Stratos is allowed to render. */
function eaipDescriptor(source) {
  return {
    id: source.id,
    name: source.name,
    publisher: source.publisher,
    status: 'integrated',
    country: source.country,
    iso2: source.iso2,
    regions: [source.region],
    categories: ALL_CATEGORIES,
    format: 'PDF',
    update: 'AIRAC / AIP amendment cycle',
    retrieval: 'eaip-cycle',
    attribution: source.attribution,
    licence: `${source.licenceLabel} — reuse granted`,
    licenceCategory: source.licenceCategory,
    licenceLabel: source.licenceLabel,
    licenceTone: 'good',
    access: 'AVAILABLE_IN_APP',
    accessLabel: ACCESS.AVAILABLE_IN_APP.label,
    accessTone: 'good',
    terms: source.terms,
    url: source.cycleIndexUrl,
    redistributable: true,
    checked: source.checked,
    note: source.note,
  };
}

/** Descriptor for a registered publisher Strom cannot display documents for. */
function descriptor(entry) {
  const licence = licenceFor(entry.licence);
  const accessKey = accessKeyFor(entry);
  const access = ACCESS[accessKey] || ACCESS.UNKNOWN;
  const established = establishedFor(entry) || {};
  return {
    id: entry.id,
    name: entry.name,
    publisher: entry.authority,
    status: accessKey === 'AVAILABLE_IN_APP' ? 'integrated' : 'link-only',
    country: entry.country,
    iso2: entry.iso2,
    regions: [entry.region],
    categories: entry.categories,
    format: entry.format || 'PDF',
    update: entry.update,
    retrieval: 'publisher-portal',
    attribution: `${entry.authority} · ${access.label}`,
    licence: licence.detail,
    licenceCategory: licence.key,
    licenceLabel: licence.label,
    licenceTone: licence.tone,
    access: accessKey,
    accessLabel: access.label,
    accessTone: access.tone,
    accessDetail: access.detail,
    checked: entry.checked || null,
    note: entry.note || established.note || '',
    terms: entry.terms || established.terms || entry.url,
    url: entry.url,
    redistributable: accessKey === 'AVAILABLE_IN_APP',
  };
}

const EAIP_PROVIDERS = EAIP_LIST.map(eaipDescriptor);
const EAIP_ISO = new Set(EAIP_LIST.map(source => source.iso2));

/* A registry entry for a country that already has an integrated eAIP provider is
   not repeated: the provider is the one row the interface should show, and a
   duplicate would make the same country look separately integrated. */
const LISTED_ONLY = LISTED_PUBLISHERS.filter(entry => (
  entry.id !== FAA_PROVIDER.id
  && !EAIP_ISO.has(entry.iso2)
  && !EAIP_LIST.some(source => source.id === entry.id)
  && accessKeyFor(entry) !== 'AVAILABLE_IN_APP'
));

/** Every provider Stratos knows about, integrated or not, without duplicates. */
export const CHART_PROVIDERS = [FAA_PROVIDER, ...EAIP_PROVIDERS, ...LISTED_ONLY.map(descriptor)];

/** True when the FAA d-TPP publishes terminal procedures for this airport. */
export function isFaaIcao(icao) {
  const code = String(icao || '').trim().toUpperCase();
  return /^[A-Z]{4}$/.test(code) && /^(K|P[A-Z]|TJ|TI)/.test(code);
}

/**
 * What is available for one airport.
 *   integrated: Stratos can fetch and display the documents itself.
 *   link-only:  the publisher is known and its terms do not permit that here.
 *   unavailable: no publisher is registered, and the interface says exactly that.
 */
export function chartCoverage(icao) {
  const code = String(icao || '').trim().toUpperCase();
  if (isFaaIcao(code)) {
    return {
      icao: code,
      integrated: true,
      linkOnly: false,
      available: true,
      status: 'integrated',
      country: FAA_PROVIDER.country,
      iso2: 'US',
      region: 'North America',
      provider: FAA_PROVIDER,
      sources: [FAA_PROVIDER],
      categories: FAA_PROVIDER.categories,
      licenceCategory: 'FREE_REUSE',
      access: 'AVAILABLE_IN_APP',
      accessLabel: ACCESS.AVAILABLE_IN_APP.label,
      accessTone: 'good',
      message: '',
    };
  }

  const eaip = eaipForIcao(code);
  if (eaip) {
    const provider = eaipDescriptor(eaip);
    return {
      icao: code,
      integrated: true,
      linkOnly: false,
      available: true,
      status: 'integrated',
      country: provider.country,
      iso2: provider.iso2,
      region: provider.regions[0],
      provider,
      sources: [provider],
      categories: provider.categories,
      licenceCategory: provider.licenceCategory,
      access: 'AVAILABLE_IN_APP',
      accessLabel: provider.accessLabel,
      accessTone: 'good',
      message: '',
    };
  }

  const national = publisherFor(code);
  const country = countryForIcao(code);
  const primary = national ? descriptor(national) : null;
  const sources = officialSourcesFor(code).map(entry => (
    entry.id === 'faa-dtpp' ? FAA_PROVIDER : descriptor(entry)
  ));

  if (primary) {
    const access = ACCESS[primary.access] || ACCESS.UNKNOWN;
    return {
      icao: code,
      integrated: primary.status === 'integrated',
      linkOnly: primary.status !== 'integrated',
      available: primary.status === 'integrated',
      status: primary.access === 'PAID' || primary.access === 'PERMISSION_REQUIRED' ? 'restricted' : 'link-only',
      country: country ? country.name : primary.country,
      iso2: primary.iso2,
      region: country ? country.region : (primary.regions || [])[0] || null,
      provider: primary,
      sources,
      categories: primary.categories,
      licenceCategory: primary.licenceCategory,
      access: primary.access,
      accessLabel: access.label,
      accessTone: access.tone,
      message: `${primary.name} publishes the charts for ${country ? country.name : primary.country}. ${access.detail}`
        + (primary.note ? ` ${primary.note}` : '')
        + ' Open the official source to use the chart there.',
    };
  }

  if (sources.length) {
    const regional = sources[0];
    return {
      icao: code,
      integrated: false,
      linkOnly: true,
      available: false,
      status: 'link-only',
      country: 'Europe',
      iso2: 'EU',
      region: 'Europe',
      provider: regional,
      sources,
      categories: regional.categories,
      licenceCategory: regional.licenceCategory,
      access: regional.access || 'FREE_PUBLIC_ACCESS',
      accessLabel: regional.accessLabel || ACCESS.FREE_PUBLIC_ACCESS.label,
      accessTone: regional.accessTone || '',
      message: `${regional.name} indexes the charts for this state: ${(ACCESS[regional.access] || ACCESS.FREE_PUBLIC_ACCESS).detail} `
        + 'Open the official source to use the charts there.',
    };
  }

  return {
    icao: code,
    integrated: false,
    linkOnly: false,
    available: false,
    status: 'unavailable',
    country: null,
    iso2: null,
    region: null,
    provider: null,
    sources: [],
    categories: [],
    licenceCategory: null,
    access: 'UNAVAILABLE',
    accessLabel: ACCESS.UNAVAILABLE.label,
    accessTone: 'bad',
    message: coverageText(code),
  };
}

/** Providers that can actually serve documents today. */
export function availableProviders() {
  return CHART_PROVIDERS.filter(provider => provider.status === 'integrated');
}

/** Human labels for the categories a provider publishes, in catalogue order. */
export function providerCategories(provider) {
  return (provider && provider.categories ? provider.categories : []).map(categoryLabel);
}

/** Short coverage sentence for the page header; never claims worldwide cover. */
export function coverageSummary() {
  const integrated = availableProviders();
  const names = integrated.map(provider => provider.country).filter(Boolean);
  const listed = CHART_PROVIDERS.length - integrated.length;
  return `Integrated charts: ${names.join(', ') || 'none'}. `
    + `${listed} further publishers are registered with official links and a stated access position.`;
}

/** Display status for a coverage record: one word the interface can style. */
export function coverageStatus(coverage) {
  if (!coverage) return { key: 'unavailable', label: ACCESS.UNAVAILABLE.label, tone: 'bad', access: 'UNAVAILABLE' };
  const access = ACCESS[coverage.access] || ACCESS.UNKNOWN;
  if (coverage.integrated) return { key: 'integrated', label: ACCESS.AVAILABLE_IN_APP.label, tone: 'good', access: 'AVAILABLE_IN_APP' };
  return { key: coverage.access || 'UNKNOWN', label: access.label, tone: access.tone, access: coverage.access || 'UNKNOWN' };
}

/** Access categories, for the interface and the licensing report. */
export { ACCESS };

/** Regional indexes, exposed for the interface's country picker. */
export { REGIONAL_SOURCES } from '../data/chart-sources.js';
