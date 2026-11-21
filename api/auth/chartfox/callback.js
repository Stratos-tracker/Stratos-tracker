// ChartFox OAuth redirect URI: https://www.stratos-tracker.com/api/auth/chartfox/callback
//
// Stratos is a public client using PKCE, so the code is exchanged in the
// browser that holds the PKCE verifier, not here. This route only hands the
// authorization response to the EFB's callback page on the same site. Only
// the OAuth response parameters are passed on, and nothing is logged or stored.

const PASSED = ['code', 'state', 'error', 'error_description'];

export default function handler(req, res) {
  if (req.method !== 'GET') {
    res.statusCode = 405;
    res.setHeader('Allow', 'GET');
    res.end();
    return;
  }
  const incoming = new URL(req.url, 'https://www.stratos-tracker.com').searchParams;
  const outgoing = new URLSearchParams();
  for (const key of PASSED) {
    const value = incoming.get(key);
    if (value) outgoing.set(key, value.slice(0, 2048));
  }
  res.statusCode = 302;
  res.setHeader('Location', `/app/chartfox-callback.html?${outgoing}`);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.end();
}
