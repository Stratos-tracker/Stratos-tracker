import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';

function installDom() {
  const { window } = parseHTML('<!doctype html><html data-theme="night"><head></head><body><div id="centre"></div></body></html>');
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.HTMLElement = window.HTMLElement;
  globalThis.Event = window.Event;
  globalThis.CustomEvent = window.CustomEvent;
  // Pin the platform: these tests are a desktop build, and the installer offered
  // must be the one for this machine rather than the Linux browser linkedom
  // reports. Its navigator answers userAgent from a prototype that cannot be
  // overwritten, so the page gets a navigator of its own that inherits the rest.
  const desktopNavigator = Object.create(window.navigator);
  Object.defineProperty(desktopNavigator, 'userAgent', {
    configurable: true,
    value: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Stratos/2.1.15',
  });
  Object.defineProperty(globalThis, 'navigator', { value: desktopNavigator, configurable: true });
  Object.defineProperty(globalThis, 'location', {
    value: { protocol: 'http:', hostname: 'localhost', href: 'http://localhost/app/pilot.html', reload() {} },
    configurable: true,
  });
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      store: new Map(),
      getItem(key) { return this.store.get(key) ?? null; },
      setItem(key, value) { this.store.set(key, String(value)); },
      removeItem(key) { this.store.delete(key); },
    },
  });
}

const release = (version = '2.1.15', extra = {}) => ({
  version,    releasedAt: '2026-10-21',
  severity: 'normal',
  summary: '2 new features and 1 fix.',
  changelog: {
    features: ['Add a replay scrubber.', 'Show top of descent on the route.'],
    improvements: [],
    fixes: ['Keep landing rates signed.'],
    performance: [],
    ui: [],
    compatibility: [],
    other: [],
  },
  ...extra,
});

test('the announcement names both versions, the release date and real notes', async () => {
  installDom();
  const { showUpdateDialog } = await import('../app/js/update-ui.js');
  const dialog = showUpdateDialog({
    release: release(),
    installedVersion: '2.1.14',
    platform: 'desktop',
    onApply: async () => {},
  });
  const text = dialog.element.textContent;
  assert.match(text, /A new version of Stratos is available/);
  assert.match(text, /Update Stratos to get the latest improvements, features, and bug fixes\./);
  assert.match(text, /v2\.1\.14/);
  assert.match(text, /v2\.1\.15/);
  assert.match(text, /Add a replay scrubber\./);
  assert.match(text, /Keep landing rates signed\./);
  assert.match(text, /2026/, 'the release date is shown');
  assert.match(text, /Installed/);
  assert.match(text, /Available/);
  assert.match(text, /Update Now/);
  assert.match(text, /Remind me later/);
  assert.equal(dialog.element.querySelectorAll('[data-apply]').length, 1);
  assert.equal(dialog.element.querySelectorAll('[data-later]').length, 1, 'an optional update can be postponed');
  dialog.close();
  assert.equal(document.querySelector('.su-backdrop'), null, 'closing removes the dialog');
});

test('"Remind me later" closes the prompt without applying anything', async () => {
  installDom();
  const { showUpdateDialog } = await import('../app/js/update-ui.js');
  let later = 0;
  let applied = 0;
  const dialog = showUpdateDialog({
    release: release(),
    installedVersion: '2.1.14',
    onLater: () => { later += 1; },
    onApply: async () => { applied += 1; },
  });
  dialog.element.querySelector('[data-later]').click();
  assert.equal(later, 1);
  assert.equal(applied, 0);
  assert.equal(document.querySelector('.su-backdrop'), null);
});

test('a genuinely required update explains why and offers no silent postponement', async () => {
  installDom();
  const { showUpdateDialog } = await import('../app/js/update-ui.js');
  const dialog = showUpdateDialog({
    release: release('2.1.16', {
      severity: 'critical',
      reason: 'A logbook migration could drop completed flights on first launch.',
      minimumSupported: '2.1.16',
    }),
    installedVersion: '2.1.13',
    onApply: async () => {},
  });
  const text = dialog.element.textContent;
  assert.match(text, /Why this update is required/);
  assert.match(text, /logbook migration/);
  assert.equal(dialog.element.querySelectorAll('[data-later]').length, 0);
  dialog.close();
});

test('the update centre reports installed, published and checked state with real history', async () => {
  installDom();
  const { writeCache } = await import('../app/js/lib/updates.js');
  const { mountUpdateCenter } = await import('../app/js/update-ui.js');

  const manifest = {
    schemaVersion: 1,
    source: 'https://example.test',
    latest: release(),
    releases: [release(), release('2.1.14', { summary: 'Previous build.', changelog: { features: [], improvements: [], fixes: ['Older fix.'], performance: [], ui: [], compatibility: [], other: [] } })],
  };
  writeCache(undefined, manifest, '2026-10-20T09:00:00.000Z');

  const root = document.getElementById('centre');
  const handle = await mountUpdateCenter({
    root,
    installedVersion: '2.1.14',
    fetchImpl: async () => { throw new Error('offline'); },
    urls: ['https://example.test/releases.json'],
  });
  await new Promise(resolve => setTimeout(resolve, 20));

  const text = root.textContent;
  assert.match(text, /Update centre|Installed/);
  assert.match(text, /v2\.1\.14/);
  assert.match(text, /v2\.1\.15/);
  assert.match(text, /from the last saved answer/);
  assert.equal(root.querySelectorAll('.su-release').length, 2, 'every published release can be inspected');
  assert.ok([...root.querySelectorAll('.su-release')].some(row => /Latest/.test(row.textContent)));

  // The saved answer is stale but still the honest one: the status says so.
  assert.match(text, /v2\.1\.15 is available/);
  handle.destroy();
  assert.equal(root.textContent.trim(), '');
});

test('the changelog viewer groups the published notes and can be closed', async () => {
  installDom();
  const { showChangelogDialog } = await import('../app/js/update-ui.js');
  showChangelogDialog(release(), { installedVersion: '2.1.14' });
  const modal = document.querySelector('.su-modal');
  assert.ok(modal);
  assert.match(modal.textContent, /New features/);
  assert.match(modal.textContent, /Bug fixes/);
  assert.equal(modal.querySelectorAll('.su-group').length, 2);
  modal.querySelector('[data-close]').click();
  assert.equal(document.querySelector('.su-backdrop'), null);
});

test('the update centre hands off to the published installer instead of an updater feed', async () => {
  installDom();
  const { writeCache } = await import('../app/js/lib/updates.js');
  const { mountUpdateCenter } = await import('../app/js/update-ui.js');

  const installer = 'https://github.com/Stratos-tracker/Stratos-tracker/releases/download/v2.1.15/Stratos-Setup.exe';
  const newer = release('2.1.15', {
    downloads: { windows: { url: installer, sha256: 'a'.repeat(64), size: 1000 } },
  });
  writeCache(undefined, { schemaVersion: 1, latest: newer, releases: [newer] }, '2026-10-20T09:00:00.000Z');

  const opened = [];
  // A desktop bridge from a build whose native updater is off, which is what the
  // published release ships: it can open a download but cannot feed-update.
  const desktop = {
    getUpdateStatus: async () => ({ supported: false, mode: 'installer', currentVersion: '2.1.14' }),
    checkForUpdates: async () => ({ supported: false, mode: 'installer' }),
    openUpdateDownload: async url => { opened.push(url); return { ok: true }; },
  };

  const root = document.getElementById('centre');
  const handle = await mountUpdateCenter({
    root,
    installedVersion: '2.1.14',
    desktop,
    fetchImpl: async () => { throw new Error('offline'); },
    urls: ['https://example.test/version.json'],
  });
  await new Promise(resolve => setTimeout(resolve, 20));

  const text = root.textContent;
  assert.doesNotMatch(text, /cannot update itself|latest\.ya?ml/, 'the old feed failure is never shown');
  const apply = root.querySelector('[data-apply]');
  assert.ok(apply, 'an available release offers an action');
  assert.equal(apply.textContent.trim(), 'Download installer');
  assert.equal(root.querySelector('[data-check]').disabled, false, 'checking for updates still works without a native updater');

  apply.click();
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.deepEqual(opened, [installer], 'the installer for this platform is opened, not a feed download');
  assert.doesNotMatch(root.textContent, /latest\.ya?ml|HttpError/, 'no raw updater error is surfaced');

  // If the bridge refuses the URL, the centre explains it in one line.
  desktop.openUpdateDownload = async () => ({ ok: false, message: 'That update link does not point at a Stratos download host.' });
  root.querySelector('[data-apply]').click();
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.match(root.textContent, /does not point at a Stratos download host/);
  handle.destroy();
});

test('a raw updater error is reduced to one useful sentence', async () => {
  const source = await import('node:fs').then(fs => fs.readFileSync('app/js/update-ui.js', 'utf8'));
  assert.match(source, /function friendlyMessage/, 'the centre cleans updater errors before showing them');
  assert.match(source, /updater feed that releases no longer publish/);
  assert.match(source, /Download the installer instead/);
});
