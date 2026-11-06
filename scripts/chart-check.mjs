// Browser check for the native Charts workspace.
// Requires: the bridge on 127.0.0.1:8765 (it serves the app too), and
// `npm install --no-save playwright` plus `npx playwright install chromium`.
// Usage: python stratos_bridge.py --no-sim &  &&  node scripts/chart-check.mjs

import fs from 'node:fs';
import { chromium } from 'playwright';

// Screenshots are written here; the folder is not tracked.
fs.mkdirSync('artifacts', { recursive: true });

// Served by the bridge itself, so the page and its data share an origin.
const URL_BASE = 'http://127.0.0.1:8765/pilot.html';

const browser = await chromium.launch({ headless: true });
const problems = [];

async function open(icao = 'KJFK', viewport = { width: 1440, height: 900 }) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  page.on('pageerror', error => problems.push(`pageerror: ${error.message}`));
  page.on('console', message => { if (message.type() === 'error') problems.push(`console: ${message.text()}`); });
  await page.goto(`${URL_BASE}#charts?icao=${icao}`, { waitUntil: 'domcontentloaded' });
  return { context, page };
}

// ── The catalogue and the viewer ────────────────────────────────────────
const first = await open('KJFK');
const page = first.page;
await page.waitForSelector('.chart-row', { timeout: 30000 }).catch(error => {
  console.log('problems so far:', problems);
  throw error;
});
const header = await page.locator('#charts-head').innerText();
const airportHeader = await page.locator('.chart-airport').innerText();
const groups = await page.locator('.chart-group-head h3').allInnerTexts();
const rows = await page.locator('.chart-row').count();
const labels = await page.locator('.chart-access').count();
const locks = await page.locator('.chart-row-lock').count();
const meta = await page.locator('.chart-meta').innerText();
console.log('groups:', groups.join(' | '));
console.log('airport:', airportHeader.replace(/\s+/g, ' '));
console.log('rows:', rows, 'labels:', labels, 'locks:', locks);
console.log('meta:', meta.replace(/\s+/g, ' '));

// Open the airport diagram (single page, dense vector content).
const diagram = page.locator('.chart-row', { hasText: 'AIRPORT DIAGRAM' }).first();
await diagram.click();
await page.waitForFunction(() => {
  const canvas = document.querySelector('.chart-stage canvas');
  const zoom = document.getElementById('chart-zoom');
  return canvas && canvas.width > 400 && zoom && /%$/.test(zoom.textContent);
}, null, { timeout: 30000 });
await page.waitForTimeout(200);
const before = await page.evaluate(() => {
  const canvas = document.querySelector('.chart-stage canvas');
  return { width: canvas.width, height: canvas.height, cssWidth: canvas.style.width, zoom: document.getElementById('chart-zoom')?.textContent, pages: document.getElementById('chart-pages')?.textContent };
});
await page.screenshot({ path: 'artifacts/charts-diagram.png' });

await page.click('[data-zoom="in"]');
await page.click('[data-zoom="in"]');
await page.waitForTimeout(700);
const zoomed = await page.evaluate(() => {
  const canvas = document.querySelector('.chart-stage canvas');
  return { width: canvas.width, zoom: document.getElementById('chart-zoom')?.textContent, transform: canvas.style.transform };
});

// Drag to pan: the transform must move the page.
const box = await page.locator('.chart-stage').boundingBox();
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
await page.mouse.down();
await page.mouse.move(box.x + box.width / 2 - 140, box.y + box.height / 2 - 90, { steps: 8 });
await page.mouse.up();
const panned = await page.evaluate(() => document.querySelector('.chart-stage canvas').style.transform);

// Reset view returns to fit-width.
await page.click('[data-reset]');
await page.waitForTimeout(600);
const reset = await page.evaluate(() => {
  const canvas = document.querySelector('.chart-stage canvas');
  const stage = document.querySelector('.chart-stage');
  return { cssWidth: parseFloat(canvas.style.width), stageWidth: stage.clientWidth, zoom: document.getElementById('chart-zoom')?.textContent };
});

// Fit width returns to the stage width.
await page.click('[data-fit="width"]');
await page.waitForTimeout(400);
const fitted = await page.evaluate(() => {
  const canvas = document.querySelector('.chart-stage canvas');
  const stage = document.querySelector('.chart-stage');
  return { cssWidth: parseFloat(canvas.style.width), stageWidth: stage.clientWidth, zoom: document.getElementById('chart-zoom')?.textContent };
});

// Previous/next document navigation changes the open chart.
const firstTitle = await page.locator('.chart-footer-main b').innerText();
await page.click('[data-doc="1"]');
await page.waitForFunction(title => document.querySelector('.chart-footer-main b')?.textContent !== title, firstTitle, { timeout: 30000 });
await page.waitForTimeout(1000);
const secondTitle = await page.locator('.chart-footer-main b').innerText();
await page.click('[data-doc="-1"]');
await page.waitForFunction(title => document.querySelector('.chart-footer-main b')?.textContent === title, firstTitle, { timeout: 30000 });

// Filter narrows the visible list without a new airport request.
await page.fill('#chart-filter', 'ILS');
await page.waitForTimeout(250);
const filtered = await page.locator('.chart-row').count();

// ── No licence at all: a diagram still opens, with no prompt ───────────
const free = await open('KMIA');
const freePage = free.page;
await freePage.waitForSelector('.chart-row', { timeout: 30000 });
const freeRows = await freePage.locator('.chart-row').count();
const freeLabels = await freePage.locator('.chart-access').count();
const freeLocks = await freePage.locator('.chart-row-lock').count();
const freeInitial = await freePage.locator('#chart-viewer').innerText();

const freeDiagram = freePage.locator('.chart-row', { hasText: 'AIRPORT DIAGRAM' }).first();
await freeDiagram.click();
await freePage.waitForFunction(() => {
  const canvas = document.querySelector('.chart-stage canvas');
  return canvas && canvas.width > 400;
}, null, { timeout: 30000 }).catch(() => {});
await freePage.waitForTimeout(250);
const openState = await freePage.evaluate(() => ({
  canvas: Boolean(document.querySelector('.chart-stage canvas')),
  panel: Boolean(document.querySelector('.premium-panel')),
  title: document.querySelector('.chart-footer-main b')?.textContent || '',
  width: document.querySelector('.chart-stage canvas')?.width || 0,
}));
await freePage.screenshot({ path: 'artifacts/charts-open-diagram.png' });

// ── Non-FAA publishers: links, not copied documents ────────────────────
const canada = await open('CYYZ');
await canada.page.waitForSelector('.chart-sources a', { timeout: 10000 });
const canadaSources = await canada.page.locator('.chart-sources a b').allInnerTexts();
const canadaText = await canada.page.locator('#chart-list').innerText();
const canadaRows = await canada.page.locator('.chart-row').count();
await canada.page.screenshot({ path: 'artifacts/charts-canada-sources.png' });

const europe = await open('EGLL');
await europe.page.waitForSelector('.chart-sources a', { timeout: 10000 });
const europeSources = await europe.page.locator('.chart-sources a b').allInnerTexts();
const europeRows = await europe.page.locator('.chart-row').count();

// ── Mobile layout ──────────────────────────────────────────────────────
const mobile = await open('KMIA', { width: 390, height: 844 });
await mobile.page.waitForSelector('.chart-row', { timeout: 30000 });
const mobileOverflow = await mobile.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
await mobile.page.screenshot({ path: 'artifacts/charts-mobile.png' });
await mobile.page.locator('.chart-row', { hasText: /LOC RWY/ }).filter({ hasNotText: /ILS/ }).first().click();
await mobile.page.waitForTimeout(1500);
const mobileOpen = await mobile.page.evaluate(() => ({
  canvas: Boolean(document.querySelector('.chart-stage canvas')),
  panel: Boolean(document.querySelector('.premium-panel')),
}));
await mobile.page.screenshot({ path: 'artifacts/charts-mobile-loc.png' });

console.log('header:', header.replace(/\s+/g, ' ').slice(0, 160));
console.log('diagram before:', before);
console.log('after zoom:', zoomed);
console.log('transform after pan:', panned);
console.log('reset:', reset);
console.log('fit width:', fitted);
console.log('document navigation:', { firstTitle, secondTitle });
console.log('filtered rows:', filtered);
console.log('free rows/labels/locks:', freeRows, freeLabels, freeLocks);
console.log('free initial:', freeInitial.replace(/\s+/g, ' ').slice(0, 120));
console.log('no-licence diagram:', openState);
console.log('Canada:', canadaSources, 'rows:', canadaRows, 'text:', canadaText.replace(/\s+/g, ' ').slice(0, 140));
console.log('Europe:', europeSources, 'rows:', europeRows);
console.log('mobile overflow:', mobileOverflow, 'LOC open:', mobileOpen);
console.log('problems:', problems.length ? problems : 'none');

await browser.close();

const ok = rows > 20 && labels === 0 && locks === 0
  && /John F\.? Kennedy/.test(airportHeader) && /United States/.test(airportHeader)
  && /All charts open/.test(header)
  && before.width > 200 && zoomed.width > before.width
  && panned !== 'translate3d(0px, 0px, 0px)'
  && Math.abs(reset.cssWidth - reset.stageWidth) < 200
  && Math.abs(fitted.cssWidth - fitted.stageWidth) < 200
  && firstTitle !== secondTitle
  && filtered > 0
  && freeRows > 20 && freeLabels === 0 && freeLocks === 0
  && /Select a chart/.test(freeInitial)
  && openState.canvas && openState.width > 200 && !openState.panel && /AIRPORT DIAGRAM/.test(openState.title)
  && canadaSources.length === 1 && /NAV CANADA/.test(canadaSources[0]) && canadaRows === 0
  && europeSources.length === 3 && europeRows === 0
  && mobileOverflow <= 1 && mobileOpen.canvas && !mobileOpen.panel
  && problems.length === 0;
console.log(ok ? 'CHART CHECK PASSED' : 'CHART CHECK FAILED');
process.exit(ok ? 0 : 1);
