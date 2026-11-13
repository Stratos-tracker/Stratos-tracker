// Stratos API: approach and departure jurisdiction polygons from the SimAware
// TRACON Project, licensed CC BY-SA 4.0 (https://github.com/vatsimnetwork/simaware-tracon-project).
//
// The dataset is a GitHub release asset and sends no CORS headers for the
// Stratos origin, so the browser cannot read it directly. The upstream address
// is fixed here rather than taken from the query, so this is a single
// permitted source and not an open proxy. One AIRAC cycle of caching is enough
// for data that changes with the publication cycle.
// Query: /api/sectors

const SOURCE = 'https://github.com/vatsimnetwork/simaware-tracon-project/releases/latest/download/TRACONBoundaries.geojson';
const CACHE_S = 12 * 60 * 60;
const TIMEOUT_MS = 12000;

export default async function handler(req, res) {
  if (req.method && !['GET', 'HEAD'].includes(req.method)) {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const upstream = await fetch(SOURCE, {
      headers: {
        Accept: 'application/geo+json, application/json',
        'User-Agent': 'Stratos/2 (flight simulation companion)',
      },
      signal: controller.signal,
    });
    if (!upstream.ok) {
      res.status(502).json({ error: `SimAware TRACON returned ${upstream.status}` });
      return;
    }
    const body = await upstream.text();
    res.setHeader('Content-Type', 'application/geo+json; charset=utf-8');
    res.setHeader('Cache-Control', `public, max-age=3600, s-maxage=${CACHE_S}`);
    // The licence requires attribution wherever the data is displayed.
    res.setHeader('X-Data-Source', 'SimAware TRACON Project (CC BY-SA 4.0)');
    res.status(200).send(req.method === 'HEAD' ? '' : body);
  } catch (error) {
    res.status(502).json({ error: String((error && error.message) || 'Sector data unavailable') });
  } finally {
    clearTimeout(timer);
  }
}
