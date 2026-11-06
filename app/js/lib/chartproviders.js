/* Chart providers.
 *
 * One provider is integrated: the FAA d-TPP publication, a U.S. Government
 * work whose terms allow Stratos to fetch and render the documents itself.
 * Every other registered publisher is *link-only*: Stratos holds no reuse
 * licence, so the catalogue and the viewer point at the publisher instead of
 * copying its charts. Coverage therefore answers three questions honestly —
 * which publisher owns the charts, what its licence allows, and whether
 * Stratos can embed the documents.
 *
 * Adding an embedded provider later means one descriptor with
 * `status: 'integrated'` plus a fetch adapter; the catalogue and the viewer do
 * not change.
 */

import { FAA_SOURCE, categoryLabel } from './charts.js';
import {
  countryForIcao, coverageText, licenceFor, LISTED_PUBLISHERS, officialSourcesFor, publisherFor,
} from './chartdir.js';
import { REGIONAL_SOURCES } from '../data/chart-sources.js';

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
  terms: FAA_SOURCE.terms,
  redistributable: true,
};

function descriptor(entry) {
  const licence = licenceFor(entry.licence);
  return {
    id: entry.id,
    name: entry.name,
    publisher: entry.authority,
    status: 'link-only',
    country: entry.country,
    iso2: entry.iso2,
    regions: [entry.region],
    categories: entry.categories,
    format: entry.format || 'PDF',
    update: entry.update,
    retrieval: 'publisher-portal',
    attribution: `${entry.authority} · licence ${licence.label}`,
    licence: licence.detail,
    licenceCategory: licence.key,
    licenceLabel: licence.label,
    licenceTone: licence.tone,
    checked: entry.checked || null,
    note: entry.note || '',
    terms: entry.url,
    url: entry.url,
    redistributable: entry.licence === 'FREE_REUSE',
  };
}

/** Every provider Stratos knows about, integrated or not. */
export const CHART_PROVIDERS = [FAA_PROVIDER, ...LISTED_PUBLISHERS.map(descriptor)];

/** True when the FAA d-TPP publishes terminal procedures for this airport. */
export function isFaaIcao(icao) {
  const code = String(icao || '').trim().toUpperCase();
  return /^[A-Z]{4}$/.test(code) && /^(K|P[A-Z]|TJ|TI)/.test(code);
}

/**
 * What is available for one airport. `integrated` means Stratos can list and
 * open the documents itself; `linkOnly` means the publisher is known and its
 * licence does not permit embedding; `unavailable` means no publisher is
 * registered, and the interface says exactly that.
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
    const licence = licenceFor(primary.licenceCategory);
    // A paid or permission-gated publisher is a coverage gap the pilot can act on.
    const blocked = ['PAID', 'PERMISSION_REQUIRED', 'FREE_PERSONAL_ONLY'].includes(primary.licenceCategory);
    return {
      icao: code,
      integrated: false,
      linkOnly: true,
      available: false,
      status: blocked ? 'restricted' : 'link-only',
      country: country ? country.name : primary.country,
      iso2: primary.iso2,
      region: country ? country.region : (primary.regions || [])[0] || null,
      provider: primary,
      sources,
      categories: primary.categories,
      licenceCategory: licence.key,
      message: `${primary.name} publishes the charts for ${country ? country.name : primary.country}. ${licence.detail} `
        + 'Stratos does not hold a redistribution licence for these documents, so it links to the publisher instead.',
    };
  }

  // No national entry: a European airport still has the regional index.
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
      message: `${regional.name} indexes the charts for this state, but Stratos does not hold a redistribution licence for them, so it links to the publisher instead.`,
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
  return 'Integrated charts: United States and territories (FAA d-TPP). 60+ other publishers are registered with official links; their charts open at the source until a reuse licence is agreed.';
}

/** Display status for a coverage record: one word the interface can style. */
export function coverageStatus(coverage) {
  if (!coverage) return { key: 'unavailable', label: 'Unavailable', tone: 'bad' };
  if (coverage.integrated) return { key: 'integrated', label: 'Charts available', tone: 'good' };
  if (coverage.status === 'restricted') return { key: 'restricted', label: 'Publisher only', tone: 'warn' };
  if (coverage.status === 'link-only') return { key: 'link-only', label: 'Link only', tone: '' };
  return { key: 'unavailable', label: 'No source', tone: 'bad' };
}

/** Regional indexes, exposed for the interface's country picker. */
export { REGIONAL_SOURCES };
