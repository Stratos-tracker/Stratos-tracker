import test from 'node:test';
import assert from 'node:assert/strict';
import {
  pkceChallenge, authorizeUrl, tokenRecord, randomToken, canSignInHere, CHARTFOX_REDIRECT_URI,
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

test('one fixed redirect URI, and sign-in only where it comes back', async () => {
  assert.equal(CHARTFOX_REDIRECT_URI, 'https://www.stratos-tracker.com/api/auth/chartfox/callback');
  assert.equal(canSignInHere('https://www.stratos-tracker.com'), true);
  assert.equal(canSignInHere('https://stratos-tracker.com'), false, 'the bare domain is a different origin');
  assert.equal(canSignInHere('http://127.0.0.1:8765'), false);
  // A redirect, not a function: the Hobby plan allows 12 functions and the site uses them all.
  const fs = await import('node:fs');
  const vercel = JSON.parse(fs.readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));
  const rule = vercel.redirects.find(r => r.source === '/api/auth/chartfox/callback');
  assert.equal(rule && rule.destination, '/app/chartfox-callback.html', 'the code goes to the EFB page (Vercel keeps the query)');
  assert.equal(rule.permanent, false);
  assert.equal(fs.existsSync(new URL('../api/auth/chartfox/callback.js', import.meta.url)), false, 'no 13th function');
});

test('a token response keeps both tokens and when access ends', () => {
  assert.deepEqual(tokenRecord({ access_token: 'a', refresh_token: 'r', expires_in: 3600 }, 1000), { access: 'a', refresh: 'r', expiresAt: 1000 + 3600000 });
  assert.equal(tokenRecord({ error: 'invalid_grant' }), null);
  assert.equal(tokenRecord(null), null);
});
