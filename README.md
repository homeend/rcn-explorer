# RCN Price Explorer

Map and analysis of Polish property transaction prices from the GUGiK
*Rejestr Cen Nieruchomości* (RCN), built as a Cloudflare Pages site.

- `public/` – the website. `rcn.js` downloads and processes the register data in the
  browser; `app.js` is the map and UI.
- `functions/api/rcn.js` – relay for the RCN WFS (the register sends no CORS headers,
  so browsers can't read it directly). Validates the request, streams the GML through,
  caches answers at the edge for a day.

## Run locally

```
npm install
npm run dev          # http://127.0.0.1:8788
```

## Deploy to Cloudflare Pages

```
npx wrangler login
npm run deploy       # first run creates the "rcn-explorer" project; live at https://rcn-explorer.pages.dev
```

Or connect a GitHub repository in the Cloudflare dashboard (Workers & Pages → Create →
Pages → Connect to Git; build command: none, output directory: `public`).

## Custom domain (e.g. bought at OVH)

1. Cloudflare dashboard → Add a domain → free plan; Cloudflare shows two nameservers.
2. OVH panel → the domain → DNS servers → replace them with Cloudflare's.
3. Pages project → Custom domains → add the domain.
4. Replace `https://rcn-explorer.pages.dev/` with the new address in `public/index.html`
   (canonical and Open Graph tags), `public/robots.txt` and `public/sitemap.xml`.
