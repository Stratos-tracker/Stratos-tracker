// Stratos API: SIGMETs and G-AIRMETs from the NOAA Aviation Weather Center.
// Public-domain NWS data, no API key. Query: /api/sigmets
// The three feeds are passed through as { airsigmet, isigmet, gairmet };
// app/js/lib/sigmets.js interprets them. A feed that fails is null, not empty,
// so the page can say which part is missing instead of showing "no hazards".
import { SIGMET_FEEDS } from '../app/js/lib/sigmets.js';

const CACHE_MS = 5 * 60 * 1000;
let cached = null; // { at, payload }

async function getArray(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': 'Stratos/2 (flight simulation companion)' },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`NOAA returned ${response.status}`);
    const data = await response.json();
    if (!Array.isArray(data)) throw new Error('NOAA returned an unexpected shape');
    return data;
  } finally {
    clearTimeout(timer);
  }
}

export default async function handler(req, res) {
  if (req.method && !['GET', 'HEAD'].includes(req.method)) {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  if (cached && Date.now() - cached.at < CACHE_MS) {
    res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=120');
    res.status(200).json(cached.payload);
    return;
  }
  const names = Object.keys(SIGMET_FEEDS);
  const results = await Promise.allSettled(names.map(name => getArray(SIGMET_FEEDS[name])));
  const payload = { fetchedAt: Date.now(), source: 'NOAA Aviation Weather Center', errors: {} };
  results.forEach((result, index) => {
    payload[names[index]] = result.status === 'fulfilled' ? result.value : null;
    if (result.status === 'rejected') payload.errors[names[index]] = String(result.reason && result.reason.message || result.reason).slice(0, 160);
  });
  if (results.every(result => result.status === 'rejected')) {
    res.setHeader('Cache-Control', 'no-store');
    res.status(502).json({ ...payload, error: 'NOAA advisories are unreachable right now.' });
    return;
  }
  cached = { at: Date.now(), payload };
  res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=120');
  res.status(200).json(payload);
}
