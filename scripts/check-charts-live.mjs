#!/usr/bin/env node
/* Live chart check: the ten airports from the international brief, plus the
 * Austrian provider, driven through the same API handlers the app calls.
 *
 * It answers, per airport: is a catalogue published, which categories, can a
 * document be fetched as a real PDF, and — when Stratos may not display the
 * charts — which access status and official source the pilot is given.
 *
 * Run: node scripts/check-charts-live.mjs
 */

import chartsHandler from '../api/charts.js';
import chartHandler from '../api/chart.js';
import { chartCoverage } from '../app/js/lib/chartproviders.js';

const AIRPORTS = [
  ['KJFK', 'United States'],
  ['CYUL', 'Canada'],
  ['EDDM', 'Germany'],
  ['EGLL', 'United Kingdom'],
  ['LFPG', 'France'],
  ['LOWW', 'Austria'],
  ['YSSY', 'Australia'],
  ['RJTT', 'Japan'],
  ['WSSS', 'Singapore'],
  ['SBGR', 'Brazil'],
  ['FACT', 'South Africa'],
];

function call(handler, query) {
  return new Promise(resolve => {
    const res = {
      statusCode: 0,
      headers: {},
      setHeader(name, value) { this.headers[String(name).toLowerCase()] = value; },
      status(code) { this.statusCode = code; return this; },
      json(body) { resolve({ status: this.statusCode, body, headers: this.headers }); },
      send(body) { resolve({ status: this.statusCode, body, headers: this.headers }); },
    };
    Promise.resolve(handler({ query }, res)).catch(error => resolve({ status: 0, body: { error: String(error) } }));
  });
}

/** Query the document proxy for one chart of an integrated provider. */
function documentQuery(chart) {
  if (chart.source === 'austrocontrol-eaip') {
    return { source: 'austrocontrol', icao: chart.icao, cycle: chart.cycle, pdf: chart.pdf };
  }
  if (chart.source === 'sia-france') {
    return { source: 'sia-france', icao: chart.icao, edition: chart.edition, pdf: chart.pdf };
  }
  return { cycle: chart.cycle, file: chart.pdf };
}

const rows = [];
for (const [icao, country] of AIRPORTS) {
  const coverage = chartCoverage(icao);
  const row = {
    icao,
    country,
    access: coverage.access,
    provider: coverage.provider ? coverage.provider.name : null,
    integrated: Boolean(coverage.integrated),
    charts: 0,
    categories: '',
    document: '',
    note: coverage.integrated ? '' : (coverage.provider && coverage.provider.url) || '',
  };

  if (coverage.integrated) {
    const catalogue = await call(chartsHandler, { icao });
    if (catalogue.status === 200) {
      const charts = catalogue.body.charts || [];
      row.charts = charts.length;
      const counts = charts.reduce((acc, chart) => {
        const key = chart.category
          || (chart.code === 'APD' ? 'diagram' : chart.code === 'DP' ? 'sid' : chart.code === 'STR' ? 'star' : chart.code === 'IAP' ? 'approach' : 'other');
        acc[key] = (acc[key] || 0) + 1;
        return acc;
      }, {});
      row.categories = Object.entries(counts).map(([key, n]) => `${key} ${n}`).join(', ');
      row.cycle = catalogue.body.cycle;
      // Fetch one document to prove it opens as a real PDF, not an HTML error.
      const pick = charts.find(chart => (chart.category || '') === 'approach') || charts[0];
      if (pick) {
        const chart = { ...pick, source: catalogue.body.source, cycle: catalogue.body.cycle, icao };
        const doc = await call(chartHandler, documentQuery(chart));
        const bytes = Buffer.isBuffer(doc.body) ? doc.body : Buffer.from(doc.body || []);
        row.document = doc.status === 200 && bytes.subarray(0, 4).toString() === '%PDF'
          ? `${pick.title || pick.pdf} (${Math.round(bytes.length / 1024)} kB)`
          : `FAILED: ${doc.status} ${bytes.subarray(0, 4).toString() || doc.body?.message || ''}`;
      }
    } else {
      row.document = `catalogue FAILED: ${catalogue.status} ${catalogue.body?.message || ''}`;
    }
  }

  rows.push(row);
  const where = row.integrated ? `${row.charts} documents [${row.categories}]` : `external · ${row.access}`;
  console.log(`${icao.padEnd(5)} ${row.country.padEnd(15)} ${where}`);
  if (row.document) console.log(`      document: ${row.document}`);
  if (row.note) console.log(`      source:   ${row.note}`);
}

const integrated = rows.filter(row => row.integrated);
const opened = integrated.filter(row => row.document && !row.document.startsWith('FAILED'));
const failed = integrated.filter(row => row.document && row.document.startsWith('FAILED'));

console.log('');
console.log(`${opened.length}/${integrated.length} integrated airports opened a real PDF document.`);
if (failed.length) {
  console.log(`Failed: ${failed.map(row => row.icao).join(', ')}`);
  process.exitCode = 1;
}
