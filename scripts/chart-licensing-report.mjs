#!/usr/bin/env node
/* Write (or check) the chart licensing report.
 *
 *   node scripts/chart-licensing-report.mjs            # rewrite CHARTS-LICENSING.md
 *   node scripts/chart-licensing-report.mjs --check    # fail when it is stale
 *
 * The report is generated from app/js/data/chart-sources.js, so the document a
 * pilot, a lawyer or a future maintainer reads can never drift from the
 * registry the application uses. Nothing here is hand-written except the prose
 * in this file: every table row is a registry record.
 */

import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const check = process.argv.includes('--check');

const {
  ACCESS, CHART_SOURCES, COUNTRIES, LICENCES, REGIONAL_SOURCES, REGIONS, accessKeyFor, licenceFor,
} = await import('../app/js/data/chart-sources.js');

const TARGET = path.join(root, 'CHARTS-LICENSING.md');

const esc = value => String(value).replace(/\|/g, '\\|');
const byName = (a, b) => a.country.localeCompare(b.country);

const stats = {};
for (const entry of CHART_SOURCES) stats[entry.licence] = (stats[entry.licence] || 0) + 1;

const integrated = CHART_SOURCES.filter(entry => entry.licence === 'FREE_REUSE');
const blocked = CHART_SOURCES.filter(entry => ['PAID', 'PERMISSION_REQUIRED', 'FREE_PERSONAL_ONLY'].includes(entry.licence));

const lines = [];
lines.push('# Chart licensing');
lines.push('');
lines.push('Where Stratos gets its charts, what each publisher\'s terms allow, and what the');
lines.push('application will and will not do with them. Generated from');
lines.push('`app/js/data/chart-sources.js` by `scripts/chart-licensing-report.mjs`; edit the');
lines.push('registry, then regenerate, rather than editing this file.');
lines.push('');
lines.push('## The rule');
lines.push('');
lines.push('A public web page is not a redistribution licence. Stratos embeds a document only');
lines.push('when the publisher\'s terms allow third-party display: today the U.S. FAA, whose');
lines.push('terminal procedures are a U.S. Government work in the public domain, and AIP');
lines.push('Austria, whose charts Austro Control publishes under CC BY 4.0. For every other');
lines.push('publisher the EFB shows the airport\'s coverage status and a link to the');
lines.push('authority\'s own portal. Nothing is scraped, framed or re-hosted, and the proxy in');
lines.push('`api/chart.js` only fetches a document name the authority itself publishes.');
lines.push('');
lines.push('## Categories');
lines.push('');
lines.push('| Category | Meaning | Publishers |');
lines.push('| --- | --- | --- |');
for (const [key, licence] of Object.entries(LICENCES)) {
  lines.push(`| ${key} | ${esc(licence.detail)} | ${stats[key] || 0} |`);
}
lines.push('');
lines.push(`**${CHART_SOURCES.length} national publishers and ${REGIONAL_SOURCES.length} regional indexes across ${COUNTRIES.length} countries.**`);
lines.push('');
lines.push('## Access statuses');
lines.push('');
lines.push('Every airport resolves to exactly one of these. Only `AVAILABLE_IN_APP` documents');
lines.push('open inside the EFB; every other status keeps the publisher link and says why.');
lines.push('');
lines.push('| Status | Meaning | Publishers |');
lines.push('| --- | --- | --- |');
for (const [key, access] of Object.entries(ACCESS)) {
  const count = CHART_SOURCES.filter(entry => accessKeyFor(entry) === key).length;
  lines.push(`| ${key} | ${esc(access.detail)} | ${count} |`);
}
lines.push('');
lines.push('## Embedded today');
lines.push('');
if (!integrated.length) {
  lines.push('No publisher is embedded: every registered source is link-only.');
} else {
  lines.push('| Country | Authority | Publisher | Charts | Terms | Last checked |');
  lines.push('| --- | --- | --- | --- | --- | --- |');
  for (const entry of integrated.sort(byName)) {
    lines.push(`| ${esc(entry.country)} | ${esc(entry.authority)} | [${esc(entry.name)}](${entry.url}) | ${esc(entry.categories.join(', '))} | ${esc(licenceFor(entry.licence).detail)} | ${entry.checked || 'not recorded'} |`);
  }
}
lines.push('');
lines.push('## Link-only, free to view');
lines.push('');
lines.push('Free public access to the charts; reuse terms are not established, so the EFB');
lines.push('links to the publisher and never embeds the document.');
lines.push('');
lines.push('| Country | Authority | Publisher | Licence | Last checked |');
lines.push('| --- | --- | --- | --- | --- |');
for (const entry of CHART_SOURCES.filter(row => row.licence === 'FREE_PUBLIC').sort(byName)) {
  lines.push(`| ${esc(entry.country)} | ${esc(entry.authority)} | [${esc(entry.name)}](${entry.url}) | FREE_PUBLIC | ${entry.checked || 'not recorded'} |`);
}
lines.push('');
lines.push('## Paid or permission required');
lines.push('');
lines.push('Stratos cannot embed these charts. The country still resolves to its publisher,');
lines.push('so a pilot always sees who owns the documents and where to ask.');
lines.push('');
lines.push('| Country | Authority | Publisher | Licence | Reason |');
lines.push('| --- | --- | --- | --- | --- |');
for (const entry of blocked.sort(byName)) {
  lines.push(`| ${esc(entry.country)} | ${esc(entry.authority)} | [${esc(entry.name)}](${entry.url}) | ${entry.licence} | ${esc(entry.note || licenceFor(entry.licence).detail)} |`);
}
lines.push('');
lines.push('## Registered, terms not yet verified');
lines.push('');
lines.push('The authority is known and linked; the licence position has not been established.');
lines.push('The EFB labels these airports exactly that way rather than guessing.');
lines.push('');
lines.push('| Country | Authority | Publisher | Region |');
lines.push('| --- | --- | --- | --- |');
for (const entry of CHART_SOURCES.filter(row => row.licence === 'UNKNOWN').sort(byName)) {
  lines.push(`| ${esc(entry.country)} | ${esc(entry.authority)} | [${esc(entry.name)}](${entry.url}) | ${esc(entry.region)} |`);
}
lines.push('');
lines.push('## Regional indexes');
lines.push('');
lines.push('| Publisher | Scope | Licence | Why it is listed |');
lines.push('| --- | --- | --- | --- |');
for (const entry of REGIONAL_SOURCES) {
  lines.push(`| [${esc(entry.name)}](${entry.url}) | ${esc(entry.country)} | ${entry.licence} | ${esc(entry.note)} |`);
}
lines.push('');
lines.push('## Coverage by region');
lines.push('');
lines.push('| Region | Countries registered | Publishers |');
lines.push('| --- | --- | --- |');
for (const region of REGIONS) {
  const countries = COUNTRIES.filter(country => country.region === region);
  const publishers = CHART_SOURCES.filter(entry => entry.region === region);
  lines.push(`| ${region} | ${countries.length} | ${publishers.length} |`);
}
lines.push('');
lines.push('## Countries with no registered source');
lines.push('');
lines.push('These are not hidden and not faked: the EFB reports "No source" for their');
lines.push('airports. Adding one is a registry edit, not a code change.');
lines.push('');
lines.push('Afghanistan, Albania, Algeria, Angola, Armenia, Azerbaijan, Belarus, Bhutan,');
lines.push('Bosnia and Herzegovina, Brunei, Cambodia, Cameroon, Congo (DRC), Costa Rica,');
lines.push('Cuba, Cyprus, Estonia, Georgia, Iran, Iraq, Jamaica, Kazakhstan, Kyrgyzstan,');
lines.push('Laos, Latvia, Libya, Lithuania, Luxembourg, Madagascar, Maldives, Malta,');
lines.push('Moldova, Mongolia, Montenegro, Mozambique, Myanmar, North Korea, Panama,');
lines.push('Senegal, Serbia, Sudan, Syria, Trinidad and Tobago, Turkmenistan, Uzbekistan,');
lines.push('Yemen.');
lines.push('');
lines.push('## Adding a country');
lines.push('');
lines.push('1. Find the publisher\'s **own** portal (the AIS/AIP site, not an aggregator).');
lines.push('2. Read its terms. Choose the category that describes what it actually allows:');
lines.push('   `FREE_REUSE`, `FREE_PUBLIC`, `FREE_PERSONAL_ONLY`, `PAID`,');
lines.push('   `PERMISSION_REQUIRED` or `UNKNOWN`. Never choose `FREE_REUSE` without written');
lines.push('   terms naming third-party display and redistribution.');
lines.push('3. Add one record to `app/js/data/chart-sources.js`:');
lines.push('');
lines.push('```js');
lines.push('source({');
lines.push("  id: 'caa-xx', country: 'Country', iso2: 'XX', region: 'Europe',");
lines.push("  icao: ['XX'],                   // ICAO location-indicator prefixes");
lines.push("  authority: 'Civil Aviation Authority',");
lines.push("  name: 'CAA — AIP Country',");
lines.push("  url: 'https://ais.example.gov/',");
lines.push("  licence: 'FREE_PUBLIC',");
lines.push("  checked: null,                  // only a date you actually verified");
lines.push("  note: 'What the terms say, in one sentence.',");
lines.push('});');
lines.push('```');
lines.push('');
lines.push('4. Run `node scripts/chart-licensing-report.mjs` and commit the regenerated report');
lines.push('   with the registry change.');
lines.push('5. Run `npm test`. `tests/charts.test.mjs` checks every record has an https portal, a');
lines.push('   licence category from the list above, and no document URL.');
lines.push('');
lines.push('## Adding an embedded provider');
lines.push('');
lines.push('Embedding is a separate step and needs terms that permit it. Add a descriptor with');
lines.push('`status: \'integrated\'` in `app/js/lib/chartproviders.js` plus a fetch adapter, and');
lines.push('keep the proxy narrow: a fixed host, a fixed path shape and a document-name pattern,');
lines.push('as `api/chart.js` does for the FAA. AIRAC cycles are recorded per catalogue, and a');
lines.push('document whose cycle has expired is labelled expired, never current.');
lines.push('');
lines.push('An eAIP authority that serves a per-airport chart index is added the same way: a');
lines.push('descriptor in `app/js/lib/eaip.js` (cycle index, airport page, document-name');
lines.push('pattern) plus one branch each in `api/charts.js` and `api/chart.js`. AIP Austria is');
lines.push('the worked example. After any provider change run');
lines.push('`node scripts/check-charts-live.mjs`: it opens a real document for each integrated');
lines.push('publisher and prints the status the other test airports resolve to.');
lines.push('');

const output = `${lines.join('\n')}\n`;

if (check) {
  const current = fs.existsSync(TARGET) ? fs.readFileSync(TARGET, 'utf8') : '';
  if (current !== output) {
    console.error('CHARTS-LICENSING.md is out of date; run node scripts/chart-licensing-report.mjs');
    process.exit(1);
  }
  console.log(`CHARTS-LICENSING.md is current (${CHART_SOURCES.length} publishers, ${COUNTRIES.length} countries).`);
} else {
  fs.writeFileSync(TARGET, output);
  console.log(`Wrote CHARTS-LICENSING.md (${CHART_SOURCES.length} publishers, ${COUNTRIES.length} countries).`);
}
