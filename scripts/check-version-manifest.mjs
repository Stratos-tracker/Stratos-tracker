#!/usr/bin/env node
/* Check the published update manifests the app checks on startup.
 *
 *   node scripts/check-version-manifest.mjs              # main branch
 *   node scripts/check-version-manifest.mjs --tag v2.1.35
 *   node scripts/check-version-manifest.mjs --dir dist   # files built for a release
 *
 * For every case it verifies that:
 *   - version.json parses and its latestVersion is a version;
 *   - it agrees with releases.json (same latest version, same download table);
 *   - the download URL is https, answers 200 and serves a plausible installer;
 *   - release notes and a release date are present, so the dialog is never empty.
 *
 * This replaces the old electron-updater smoke test: the release no longer
 * publishes latest.yml, so the path a user actually depends on is
 * version.json -> installer download.
 */
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const arg = (name, fallback = '') => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : (args[index + 1] || fallback);
};

const REPO = 'Stratos-tracker/Stratos-tracker';
const MIN_BYTES = 30 * 1000 * 1000;
const failures = [];
const pass = message => console.log(`  ok   ${message}`);
const fail = message => { failures.push(message); console.log(`  FAIL ${message}`); };

async function readJson(source) {
  if (source.kind === 'file') {
    return JSON.parse(fs.readFileSync(source.path, 'utf8'));
  }
  const response = await fetch(source.url, { headers: { 'User-Agent': 'stratos-version-check', Accept: 'application/json', 'Cache-Control': 'no-cache' } });
  if (!response.ok) throw new Error(`${source.url} answered ${response.status}`);
  return response.json();
}

const dir = arg('dir');
const tag = arg('tag');
const sources = dir
  ? { version: { kind: 'file', path: path.join(dir, 'version.json'), label: dir }, releases: { kind: 'file', path: path.join(dir, 'releases.json'), label: dir } }
  : {
    version: {
      kind: 'url',
      url: tag
        ? `https://raw.githubusercontent.com/${REPO}/${tag}/app/version.json`
        : `https://raw.githubusercontent.com/${REPO}/main/app/version.json`,
      label: tag || 'main',
    },
    releases: {
      kind: 'url',
      url: tag
        ? `https://raw.githubusercontent.com/${REPO}/${tag}/app/releases.json`
        : `https://raw.githubusercontent.com/${REPO}/main/app/releases.json`,
      label: tag || 'main',
    },
  };

console.log(`Checking the update manifests in ${sources.version.label}`);

let version = null;
let releases = null;
try {
  version = await readJson(sources.version);
} catch (error) {
  fail(`version.json could not be read: ${error.message}`);
}
try {
  releases = await readJson(sources.releases);
} catch (error) {
  fail(`releases.json could not be read: ${error.message}`);
}

if (version) {
  /^\d+\.\d+\.\d+$/.test(String(version.latestVersion || ''))
    ? pass(`latestVersion is ${version.latestVersion}`)
    : fail(`latestVersion is ${JSON.stringify(version.latestVersion)}`);
  if (version.minimumSupportedVersion) {
    /^\d+\.\d+\.\d+$/.test(String(version.minimumSupportedVersion))
      ? pass(`minimumSupportedVersion is ${version.minimumSupportedVersion}`)
      : fail(`minimumSupportedVersion is ${JSON.stringify(version.minimumSupportedVersion)}`);
  }
  Array.isArray(version.releaseNotes) && version.releaseNotes.length
    ? pass(`${version.releaseNotes.length} release notes are published`)
    : fail('version.json carries no release notes, so the dialog would be empty');
  /^\d{4}-\d{2}-\d{2}/.test(String(version.releaseDate || ''))
    ? pass(`releaseDate is ${version.releaseDate}`)
    : fail(`releaseDate is ${JSON.stringify(version.releaseDate)}`);
  if (typeof version.mandatory !== 'boolean') fail('mandatory must be true or false');

  const url = String(version.downloadUrl || '');
  if (!/^https:\/\//.test(url)) {
    fail(`downloadUrl is not https: ${JSON.stringify(url)}`);
  } else {
    const head = await fetch(url, { method: 'HEAD', redirect: 'follow' }).catch(() => null);
    const size = head ? Number(head.headers.get('content-length') || 0) : 0;
    if (!head || head.status !== 200) fail(`downloadUrl answers ${head ? head.status : 'nothing'}`);
    else if (size && size < MIN_BYTES) fail(`downloadUrl serves ${size} bytes, below the ${MIN_BYTES}-byte installer floor`);
    else pass(`downloadUrl answers 200${size ? ` (${(size / 1048576).toFixed(1)} MB)` : ''}`);
  }
}

if (version && releases) {
  const latest = releases.latest || {};
  version.latestVersion === latest.version
    ? pass('version.json and releases.json agree on the latest version')
    : fail(`version.json says ${version.latestVersion}, releases.json says ${latest.version}`);
  const versionUrls = JSON.stringify(version.downloads || {});
  const releaseUrls = JSON.stringify(latest.downloads || {});
  versionUrls === releaseUrls
    ? pass('both manifests publish the same download table')
    : fail('version.json and releases.json publish different download tables');
  for (const platform of ['windows', 'mac-arm64', 'mac-x64', 'linux-x64']) {
    const entry = (latest.downloads || {})[platform];
    entry && /^https:\/\//.test(String(entry.url || ''))
      ? pass(`${platform} download is published`)
      : fail(`${platform} has no published download`);
  }
}

console.log(failures.length ? `\n${failures.length} problem(s) with the update manifests` : '\nThe update manifests are publishable.');
process.exit(failures.length ? 1 : 0);
