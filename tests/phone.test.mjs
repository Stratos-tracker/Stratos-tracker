import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

const tracker = read('app/index.html');
const mobileJs = read('app/js/mobile.js');
const mobileCss = read('app/mobile.css');
const manifest = JSON.parse(read('app/manifest-phone.webmanifest'));
const sw = read('app/sw.js');
const vercel = JSON.parse(read('vercel.json'));
const home = read('index.html');
const devServer = read('scripts/dev-server.mjs');

test('/phone is the Flight Deck itself, not a second interface', () => {
  const rewrites = vercel.rewrites || [];
  assert.ok(
    rewrites.some(rule => rule.source === '/phone' && rule.destination === '/app/index.html'),
    'the host serves the tracker at /phone',
  );
  assert.ok(
    rewrites.some(rule => rule.source === '/phone/' && rule.destination === '/app/index.html'),
    'and with a trailing slash',
  );
  assert.match(devServer, /'\/phone': '\/index\.html'/, 'the dev server does the same');
  for (const gone of ['app/phone.html', 'app/phone.css', 'app/js/phone.js']) {
    assert.equal(fs.existsSync(path.join(root, gone)), false, `${gone} is gone — there is only one UI`);
  }
});

test('the phone gets the PC deck: chart, telemetry, controls and the rail', () => {
  assert.match(tracker, /<canvas id="map"/, 'the Flight Deck chart');
  assert.match(tracker, /id="tel"/, 'the PC telemetry strip');
  assert.match(tracker, /id="fab"/, 'the PC map control column');
  assert.match(tracker, /id="efbbar"/, 'the PC flight-status bar');
  assert.match(tracker, /class="rail-product" href="efb\.html"/, 'the EFB is still one press away');
  assert.match(tracker, /href="logbook\.html"/);
  assert.match(tracker, /href="discover\.html"/);
  assert.match(tracker, /data-mobile-section="map"/, 'the page declares its phone layout');
  assert.match(tracker, /href="mobile\.css"/, 'and loads the iPhone optimisation');
  assert.match(mobileCss, /body\[data-mobile-section="map"\] #app \{ height: 100vh; height: 100dvh; \}/, 'the map fills the phone screen');
  assert.match(mobileCss, /body\[data-mobile-section="map"\] #tabs \{ display: none !important; \}/, 'the desktop rail is replaced, not stacked in front of the map');
});

test('the phone nav carries the PC destinations and the EFB', () => {
  assert.match(mobileJs, /id: 'map', label: 'Map', href: 'index\.html'/);
  assert.match(mobileJs, /id: 'flights', label: 'Flights', href: 'logbook\.html'/);
  assert.match(mobileJs, /id: 'efb', label: 'EFB', href: 'efb\.html'/);
  assert.match(mobileJs, /id: 'profile', label: 'Profile', href: 'pilot\.html#settings'/);
  assert.match(mobileJs, /id: 'plan', label: 'Plan', href: 'efb\.html#\/flightplan'/, 'planning stays one tap away once the map bar is gone');
  assert.match(mobileCss, /grid-template-columns: repeat\(7, 1fr\)/, 'seven items, including Plan and the EFB');
  assert.match(mobileCss, /\.m-nav a svg \{ width: 21px; height: 21px/, 'phone-sized icons, not desktop ones');
});

test('serving the deck at /phone keeps every asset and link resolving', () => {
  assert.match(tracker, /manifest-phone\.webmanifest/, 'the phone manifest is selected on that URL');
  assert.match(tracker, /\^\\\/phone\\\/\?\$\/\.test\(location\.pathname\)/, 'the base is applied to the /phone URL only');
  assert.ok(tracker.includes("base.href = '/app/'"), 'the base points at the deployed app directory');
  assert.equal(manifest.start_url, '/phone');
  assert.equal(manifest.scope, '/');
  assert.equal(manifest.display, 'standalone');
  assert.ok(manifest.icons.some(icon => icon.purpose === 'maskable'));
});

test('the service worker opens /phone from the cached deck', () => {
  const shell = sw.match(/const SHELL = \[([\s\S]*?)\n\];/)[1];
  assert.doesNotMatch(shell, /'phone\.html'/, 'the deleted phone page is not part of the shell');
  assert.doesNotMatch(shell, /'phone\.css'/);
  assert.doesNotMatch(shell, /'js\/phone\.js'/);
  assert.match(shell, /'index\.html'/, 'the tracker is');
  assert.match(sw, /caches\.match\('index\.html'\)/, 'the phone fallback is the tracker');
  assert.match(sw, /\\\/phone\(\\\.html\)\?\$/, 'a navigation to /phone is still recognised');
  assert.match(sw, /hasLegacyPhoneShell/, 'a worker from the phone-page build is detected and replaced');
  assert.match(sw, /const CACHE = 'stratos-shell-2\.1\.46-phone'/, 'the cache is versioned for this build');
  assert.match(sw, /client\.navigate\(client\.url\)/, 'a phone still on the deleted shell is navigated onto the Flight Deck');
});

test('the phone map carries no procedure or flight-plan panels', () => {
  const hud = read('app/efb-hud.css');
  assert.match(hud, /html\.phone-mode #procpane, html\.phone-mode #planpane \{ display: none !important; \}/, 'both charts bars are dropped on the phone only');
  assert.doesNotMatch(hud, /^#planpane \{ display: none/m, 'the desktop Flight Planning tab keeps its pane');
});

test('the deck follows the pilot back from /phone', () => {
  assert.match(tracker, /sessionStorage\.setItem\('stratos\.phoneMode', '1'\)/, 'choosing Phone Mode is remembered for the tab');
  assert.match(tracker, /sessionStorage\.getItem\('stratos\.phoneMode'\)/, 'and read back when the Map tab loads this file');
  assert.match(tracker, /remembered && narrow/, 'only a phone-width window acts on the memory');
  assert.match(tracker, /max-width: 767px/, 'the same breakpoint the phone nav uses');
  assert.match(mobileCss, /html\.phone-mode #dlOffer, html\.phone-mode #dlChip \{ display: none !important; \}/, 'the desktop installer offer stays off the phone deck');
});

test('the landing page keeps offering Phone Mode', () => {
  assert.ok((home.match(/href="\/phone"/g) || []).length >= 2, 'the header and the access cards link to it');
  assert.match(home, /Access a streamlined, touchscreen-optimized Stratos experience on your smartphone\./);
});

test('the phone bar marks the section the page is actually showing', () => {
  assert.match(mobileJs, /const EFB_ROUTES = \{ '#\/flightplan': 'plan', '#\/charts': 'charts' \}/, 'the EFB routes map to the bar destinations');
  assert.match(mobileJs, /if \(!document\.body\.classList\.contains\('efb'\)\) return declared;/, 'every other page keeps its declared section');
  assert.match(mobileJs, /window\.addEventListener\('hashchange', markCurrent\)/, 'the bar follows an EFB route change without a reload');
  assert.match(mobileJs, /if \(link\.dataset\.mnav === sectionNow\(\)\)/, 'tapping the section already on screen scrolls instead of reloading');
});
