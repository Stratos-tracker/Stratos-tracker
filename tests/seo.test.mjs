import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

const home = read('index.html');
const appPage = read('app/index.html');
const robots = read('robots.txt');
const sitemap = read('sitemap.xml');

function meta(html, attribute, name) {
  const match = html.match(new RegExp(`<meta ${attribute}="${name}" content="([^"]*)"`, 'i'));
  return match ? match[1] : '';
}

test('the homepage advertises both simulators in its title and description', () => {
  const title = home.match(/<title>([^<]*)<\/title>/i)[1];
  assert.match(title, /X-Plane 12/);
  assert.match(title, /MSFS 2020\/2024/);
  assert.equal(title, 'Stratos – Free Flight Tracker for X-Plane 12 &amp; MSFS 2020/2024');

  const description = meta(home, 'name', 'description');
  assert.match(description, /X-Plane 12/);
  assert.match(description, /Microsoft Flight Simulator 2020\/2024/, 'the description spells the simulator out');
  assert.equal(
    description,
    'Track your flights in X-Plane 12 and Microsoft Flight Simulator 2020/2024 with Stratos. Explore live flight tracking, interactive maps, flight planning, charts and more.',
  );
});

test('the homepage carries a complete, consistent social and canonical set', () => {
  assert.match(home, /<link rel="canonical" href="https:\/\/www\.stratos-tracker\.com\/">/);
  assert.match(meta(home, 'property', 'og:title'), /X-Plane 12/);
  assert.match(meta(home, 'property', 'og:description'), /Microsoft Flight Simulator 2020\/2024/);
  assert.equal(meta(home, 'property', 'og:url'), 'https://www.stratos-tracker.com/');
  assert.equal(meta(home, 'property', 'og:image'), 'https://www.stratos-tracker.com/app/icon-512.png');
  assert.equal(meta(home, 'property', 'og:type'), 'website');
  assert.equal(meta(home, 'name', 'twitter:card'), 'summary_large_image');
  assert.match(meta(home, 'name', 'twitter:title'), /X-Plane 12/);
  assert.equal(meta(home, 'name', 'twitter:image'), 'https://www.stratos-tracker.com/app/icon-512.png');
  assert.match(meta(home, 'name', 'robots'), /index/);
  assert.doesNotMatch(home, /noindex/, 'the landing page must stay indexable');
  assert.doesNotMatch(home, /vercel\.app/, 'no preview host may leak into the public metadata');
});

test('the homepage structured data is valid and names both simulators', () => {
  const blocks = [...home.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
  assert.equal(blocks.length, 1, 'exactly one JSON-LD block, so there is no conflicting entity');
  const data = JSON.parse(blocks[0][1]);
  assert.equal(data['@type'], 'SoftwareApplication');
  assert.equal(data.name, 'Stratos');
  assert.match(data.description, /X-Plane 12/);
  assert.match(data.description, /Microsoft Flight Simulator 2020\/2024/);
  assert.match(data.operatingSystem, /Windows/);
  assert.equal(data.offers.price, '0');
  assert.ok(Array.isArray(data.featureList) && data.featureList.length >= 5);
});

test('the homepage offers desktop and Phone Mode as equal choices', () => {
  assert.match(home, /id="access"/);
  assert.match(home, /<span class="ac-k">Desktop<\/span>/i);
  assert.match(home, /<span class="ac-k">Phone mode<\/span>/i);
  const phoneLinks = [...home.matchAll(/href="\/phone"/g)];
  assert.ok(phoneLinks.length >= 2, 'Phone Mode is offered from the header, the card and the hero');
  assert.match(home, /href="\/api\/download\?p=windows"/, 'the desktop download is preserved');
  assert.match(home, /Download Stratos for the complete desktop flight tracking experience\./);
  assert.match(home, /Access a streamlined, touchscreen-optimized Stratos experience on your smartphone\./);
});

test('the mobile prompt offers a switch and remembers the answer', () => {
  assert.match(home, /You're using Stratos on a mobile device\./);
  assert.match(home, /Would you like to switch to Phone Mode\?/);
  assert.match(home, /id="mp-switch"/);
  assert.match(home, /id="mp-dismiss"/);
  assert.match(home, /stratos\.mode/, 'the choice is stored in one preference');
  assert.match(home, /max-width: 767px/, 'the prompt is only offered to narrow screens');
});

test('the application page no longer claims X-Plane only, or a preview domain', () => {
  const title = appPage.match(/<title>([^<]*)<\/title>/i)[1];
  assert.match(title, /X-Plane 12/);
  assert.match(title, /Microsoft Flight Simulator|MSFS/);
  assert.doesNotMatch(appPage, /vercel\.app/);
  assert.match(appPage, /<link rel="canonical" href="https:\/\/www\.stratos-tracker\.com\/app\/">/);
  assert.equal(meta(appPage, 'property', 'og:url'), 'https://www.stratos-tracker.com/app/');
  assert.match(meta(appPage, 'name', 'description'), /Microsoft Flight Simulator 2020\/2024/);
  assert.equal(meta(appPage, 'property', 'og:image'), 'https://www.stratos-tracker.com/app/icon-512.png');
  assert.equal(meta(appPage, 'name', 'twitter:card'), 'summary_large_image');
});

test('robots.txt points at the sitemap and keeps private account screens out', () => {
  assert.match(robots, /User-agent: \*/);
  assert.match(robots, /Allow: \//);
  assert.match(robots, /Sitemap: https:\/\/www\.stratos-tracker\.com\/sitemap\.xml/);
  for (const page of ['login', 'signup', 'reset', 'verify', 'account']) {
    assert.match(robots, new RegExp(`Disallow: /app/${page}\\.html`), `${page} stays out of the index`);
  }
  assert.doesNotMatch(robots, /Disallow: \/\s*$/m, 'the whole site is not blocked');
});

test('the sitemap lists the landing page, Phone Mode and the public app pages', () => {
  assert.match(sitemap, /<loc>https:\/\/www\.stratos-tracker\.com\/<\/loc>/);
  assert.match(sitemap, /<loc>https:\/\/www\.stratos-tracker\.com\/phone<\/loc>/);
  assert.match(sitemap, /<loc>https:\/\/www\.stratos-tracker\.com\/app\/<\/loc>/);
  assert.equal((sitemap.match(/<url>/g) || []).length, (sitemap.match(/<\/url>/g) || []).length);
  assert.doesNotMatch(sitemap, /vercel\.app/);
  assert.doesNotMatch(sitemap, /login\.html|signup\.html|account\.html/, 'private screens are not advertised');
});
