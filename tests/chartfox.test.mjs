import test from 'node:test';
import assert from 'node:assert/strict';
import {
  pkceChallenge, authorizeUrl, tokenRecord, chartfoxRedirectUri, randomToken,
  CHARTFOX_CLIENT_ID, CHARTFOX_SCOPES,
} from '../app/js/lib/chartfox.js';

test('the PKCE challenge matches the RFC 7636 example', async () => {
  assert.equal(await pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  const verifier = randomToken(48);
  assert.match(verifier, /^[A-Za-z0-9_-]{43,128}$/, 'a verifier PKCE accepts');
});

test('the consent URL asks for exactly the listed scopes with PKCE', () => {
  const url = new URL(authorizeUrl({ redirectUri: 'https://www.stratos-tracker.com/app/chartfox-callback.html', state: 's1', challenge: 'c1' }));
  assert.equal(url.origin + url.pathname, 'https://api.chartfox.org/oauth/authorize');
  assert.equal(url.searchParams.get('client_id'), CHARTFOX_CLIENT_ID);
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('state'), 's1');
  assert.deepEqual(url.searchParams.get('scope').split(' '), [
    'oauth:user:name', 'oauth:telemetry:view', 'airports:view', 'charts:index', 'charts:view', 'charts:view_source_url', 'charts:files',
  ]);
  assert.equal(CHARTFOX_SCOPES.length, 7);
  assert.equal(url.searchParams.get('client_secret'), null, 'a public client sends no secret');
});

test('the callback page sits beside the EFB on any host', () => {
  assert.equal(chartfoxRedirectUri('https://www.stratos-tracker.com/app/efb.html#/charts'), 'https://www.stratos-tracker.com/app/chartfox-callback.html');
  assert.equal(chartfoxRedirectUri('http://127.0.0.1:8765/efb.html'), 'http://127.0.0.1:8765/chartfox-callback.html');
});

test('a token response keeps both tokens and when access ends', () => {
  assert.deepEqual(tokenRecord({ access_token: 'a', refresh_token: 'r', expires_in: 3600 }, 1000), { access: 'a', refresh: 'r', expiresAt: 1000 + 3600000 });
  assert.equal(tokenRecord({ error: 'invalid_grant' }), null);
  assert.equal(tokenRecord(null), null);
});
