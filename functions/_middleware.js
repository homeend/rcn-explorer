// Runs before every request (pages and /api). Limits the site to visitors from the
// countries in ALLOWED_COUNTRIES (wrangler.toml / Pages settings; default "PL", "*" = everyone).
// Local development (wrangler pages dev on localhost) is never blocked.

const BLOCKED_PAGE = `<!doctype html>
<html lang="pl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>RCN Price Explorer</title>
<style>body{font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#f6f6f3;color:#1d232a}
main{max-width:420px;padding:24px;text-align:center}h1{font-size:20px}p{color:#66707a}</style></head>
<body><main><h1>Serwis dostępny tylko w Polsce</h1><p>RCN Price Explorer is available only to visitors in Poland.</p></main></body></html>`;

export async function onRequest({ request, env, next }) {
  const { hostname } = new URL(request.url);
  const local = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
  const allowed = (env.ALLOWED_COUNTRIES || 'PL').split(',').map((c) => c.trim().toUpperCase()).filter(Boolean);
  const country = request.cf && request.cf.country;

  if (local || allowed.includes('*') || !country || allowed.includes(country)) return next();
  return new Response(BLOCKED_PAGE, {
    status: 403,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
