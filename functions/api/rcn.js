// Relay for the GUGiK RCN WFS (Cloudflare Pages Function, served at /api/rcn).
//
// The register service sends no CORS headers, so a browser page cannot read it directly.
// This function forwards one strictly validated GetFeature request and streams the GML
// back unchanged; parsing happens in the browser (public/rcn.js), which keeps the
// function well inside the free plan's CPU limit. Answers are cached at the edge.
//
//   GET /api/rcn?layer=dzialki|budynki|lokale&bbox=south,west,north,east   (WGS84 degrees)

const WFS = 'https://mapy.geoportal.gov.pl/wss/service/rcn';
const LAYERS = new Set(['dzialki', 'budynki', 'lokale']);
const POLAND = { s: 48.9, n: 55.0, w: 14.0, e: 24.3 };
const MAX_SPAN = { lat: 0.06, lon: 0.096 };   // ~6.5 km x 6.5 km; larger boxes are very slow upstream
const CACHE_SECONDS = 24 * 3600;

const json = (obj, status) => new Response(JSON.stringify(obj), {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
});

export async function onRequestGet({ request, waitUntil }) {
  const url = new URL(request.url);
  const layer = url.searchParams.get('layer');
  const bbox = (url.searchParams.get('bbox') || '').split(',').map(Number);

  if (!LAYERS.has(layer)) return json({ error: 'Nieznana warstwa.' }, 400);
  if (bbox.length !== 4 || bbox.some((v) => !Number.isFinite(v))) return json({ error: 'Parametr bbox musi mieć postać: południe,zachód,północ,wschód.' }, 400);
  const [s, w, n, e] = bbox;
  if (s >= n || w >= e) return json({ error: 'Pusty obszar.' }, 400);
  if (s < POLAND.s || n > POLAND.n || w < POLAND.w || e > POLAND.e) return json({ error: 'Obszar musi leżeć w Polsce.' }, 400);
  if (n - s > MAX_SPAN.lat || e - w > MAX_SPAN.lon) return json({ error: 'Obszar jest za duży – użyj promienia do ok. 2 km.' }, 400);

  // Normalised key so equal areas share one cache entry.
  const box = bbox.map((v) => v.toFixed(4)).join(',');
  const cacheKey = new Request(`${url.origin}/api/rcn?layer=${layer}&bbox=${box}`);
  const cache = typeof caches !== 'undefined' ? caches.default : null;

  if (cache) {
    try {
      const hit = await cache.match(cacheKey);
      if (hit) {
        const r = new Response(hit.body, hit);
        r.headers.set('X-RCN-Cache', 'HIT');
        return r;
      }
    } catch (err) { /* cache unavailable – fetch upstream */ }
  }

  const upstream = `${WFS}?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature&TYPENAMES=ms:${layer}`
    + `&BBOX=${box},urn:ogc:def:crs:EPSG::4326`;
  let res;
  try {
    res = await fetch(upstream, { headers: { 'User-Agent': 'rcn-explorer (Cloudflare Pages relay)' } });
  } catch (err) {
    return json({ error: `Brak połączenia z geoportal.gov.pl: ${err.message}` }, 502);
  }
  if (!res.ok || !res.body) return json({ error: `geoportal.gov.pl odpowiedział kodem ${res.status}.` }, 502);

  const headers = {
    // The document mixes UTF-8 and Windows-1250 values; the browser decodes the bytes itself.
    'Content-Type': 'application/xml',
    'Cache-Control': `public, max-age=${CACHE_SECONDS}`,
    'X-RCN-Cache': 'MISS',
  };
  if (!cache) return new Response(res.body, { headers });

  const [toClient, toCache] = res.body.tee();
  waitUntil(cache.put(cacheKey, new Response(toCache, { headers })).catch(() => {}));
  return new Response(toClient, { headers });
}
