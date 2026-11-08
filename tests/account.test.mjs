import test from 'node:test';
import assert from 'node:assert/strict';

import { toSnapshot } from '../app/js/account/live.js';
import {
  liveSocketUrl, AccountError, savedToken, rememberToken, forgetToken,
} from '../app/js/account/api.js';
import { bridgeNextPath, pairConnectUrl, isPrivateBridgeUrl } from '../app/js/account/discovery.js';
import {
  esc, initials, formatDuration, formatHours, formatNumber,
  passwordScore, safeNext,
} from '../app/js/account/ui.js';

test('account: the bridge telemetry becomes the one snapshot shape the service stores', () => {
  const snapshot = toSnapshot({
    lat: 51.4706,
    lon: -0.4619,
    alt: 12400,
    gs: 452,
    hdg: 268,
    vs: -1200,
    flightPhase: 'cruise',
    aircraftType: 'B738',
    registration: 'G-TEST',
    callsign: 'SHT1A',
    currentFlight: { depAirport: 'egll', arrAirport: 'kjfk', progress: 0.42, remainingNm: 1800 },
  });
  assert.ok(snapshot, 'a real position produces a snapshot');
  assert.equal(snapshot.telemetry.lat, 51.4706);
  assert.equal(snapshot.telemetry.lon, -0.4619);
  assert.equal(snapshot.telemetry.alt, 12400);
  assert.equal(snapshot.telemetry.gs, 452);
  assert.equal(snapshot.telemetry.hdg, 268);
  assert.equal(snapshot.telemetry.vs, -1200);
  assert.equal(snapshot.aircraft.type, 'B738');
  assert.equal(snapshot.aircraft.registration, 'G-TEST');
  assert.equal(snapshot.route.dep, 'EGLL');
  assert.equal(snapshot.route.dest, 'KJFK');
  assert.equal(snapshot.route.progress, 0.42);
  assert.equal(snapshot.phase, 'cruise');
});

test('account: a snapshot without a usable position is refused, not published', () => {
  assert.equal(toSnapshot(null), null);
  assert.equal(toSnapshot({}), null);
  assert.equal(toSnapshot({ lat: 0, lon: 0 }), null, 'null island is not a position');
  assert.equal(toSnapshot({ lat: 'north', lon: 4 }), null);
  assert.equal(toSnapshot({ lat: 200, lon: 4 }), null, 'out-of-range latitudes are refused');
});

test('account: missing bridge values stay empty instead of becoming zero', () => {
  const snapshot = toSnapshot({ lat: 40.6, lon: -73.7 });
  assert.equal(snapshot.telemetry.alt, null);
  assert.equal(snapshot.telemetry.gs, null);
  assert.equal(snapshot.telemetry.hdg, null);
  assert.equal(snapshot.aircraft.type, '');
});

test('account: the live socket keeps https off the wire', () => {
  assert.equal(
    liveSocketUrl('abc 123', 'https://relay.example.com/'),
    'wss://relay.example.com/api/live/ws?ticket=abc%20123',
  );
  assert.equal(
    liveSocketUrl('t', 'http://127.0.0.1:8788'),
    'ws://127.0.0.1:8788/api/live/ws?ticket=t',
  );
});

test('account: an error carries the status the caller switches on', () => {
  const error = new AccountError(401, 'nope');
  assert.equal(error.status, 401);
  assert.equal(error.message, 'nope');
  assert.ok(error instanceof Error);
});

test('account: a next= target can only be a path on this site', () => {
  const withSearch = search => {
    const previous = globalThis.location;
    globalThis.location = { search };
    const value = safeNext();
    if (previous === undefined) delete globalThis.location;
    else globalThis.location = previous;
    return value;
  };
  assert.equal(withSearch('?next=account.html'), 'account.html');
  assert.equal(withSearch('?next=logbook.html%3Ftab%3Dcareer'), 'logbook.html?tab=career');
  assert.equal(withSearch(''), 'index.html', 'a plain sign-in lands on the map');
  assert.equal(withSearch('?next=https%3A%2F%2Fevil.example'), 'index.html');
  assert.equal(withSearch('?next=%2F%2Fevil.example'), 'index.html');
  assert.equal(withSearch('?next=javascript%3Aalert(1)'), 'index.html');
});

test('account: a remembered session outlives the tab, a short one does not', () => {
  const make = () => {
    const map = new Map();
    return {
      getItem: key => (map.has(key) ? map.get(key) : null),
      setItem: (key, value) => map.set(key, String(value)),
      removeItem: key => map.delete(key),
    };
  };
  const previous = { local: globalThis.localStorage, session: globalThis.sessionStorage };
  globalThis.localStorage = make();
  globalThis.sessionStorage = make();
  try {
    rememberToken('remembered-token', { remember: true });
    assert.equal(savedToken(), 'remembered-token');
    assert.equal(globalThis.sessionStorage.getItem('stratos.account.token'), null);

    rememberToken('tab-token', { remember: false });
    assert.equal(savedToken(), 'tab-token', 'the short session is still found');
    assert.equal(globalThis.localStorage.getItem('stratos.account.token'), null, 'but not written to the persistent store');

    forgetToken();
    assert.equal(savedToken(), '');
  } finally {
    if (previous.local === undefined) delete globalThis.localStorage; else globalThis.localStorage = previous.local;
    if (previous.session === undefined) delete globalThis.sessionStorage; else globalThis.sessionStorage = previous.session;
  }
});

test('account: durations, counts and initials read like the rest of the app', () => {
  assert.equal(formatDuration(0), '0m');
  assert.equal(formatDuration(1500), '25m');
  assert.equal(formatDuration(9000), '2h 30m');
  assert.equal(formatHours(9000), '2.5');
  assert.equal(formatHours(0), '0.0');
  assert.equal(formatNumber(1234.6), '1,235');
  assert.equal(formatNumber(null), '—');
  assert.equal(initials('Jamie Rivers'), 'JR');
  assert.equal(initials('pilot', 'pilot@example.com'), 'PI');
  assert.equal(esc('<script>&"'), '&lt;script&gt;&amp;&quot;');
});

test('account: automatic PC discovery only accepts a private bridge and keeps the hand-off out of the bridge query', () => {
  assert.equal(isPrivateBridgeUrl('http://192.168.1.20:8765'), true);
  assert.equal(isPrivateBridgeUrl('http://10.0.0.4:8765'), true);
  assert.equal(isPrivateBridgeUrl('http://stratos.local:8765'), true);
  assert.equal(isPrivateBridgeUrl('https://192.168.1.20:8765'), false, 'a TLS URL is not a local bridge');
  assert.equal(isPrivateBridgeUrl('http://203.0.113.9:8765'), false, 'a public address is refused');
  assert.equal(isPrivateBridgeUrl('http://192.168.1.20:8765/other'), false, 'only an origin is accepted');

  assert.equal(bridgeNextPath(), '/index.html');
  assert.equal(bridgeNextPath('abc 123'), '/index.html#account=abc%20123');
  assert.equal(
    pairConnectUrl('http://192.168.1.20:8765', 'abc123'),
    'http://192.168.1.20:8765/pair/connect?next=%2Findex.html%23account%3Dabc123',
  );
});

test('account: password strength never calls a one-character password strong', () => {
  assert.equal(passwordScore(''), 0);
  assert.equal(passwordScore('a'), 1);
  assert.ok(passwordScore('Str0ng-Passphrase!') >= 3);
  assert.ok(passwordScore('correct horse battery staple') >= 2);
});
