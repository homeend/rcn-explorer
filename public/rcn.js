/* RCN data processing, done in the browser.
 *
 * The GUGiK RCN WFS (mapy.geoportal.gov.pl/wss/service/rcn) returns GML only and sends
 * no CORS headers, so the page fetches it through the /api/rcn relay (functions/api/rcn.js)
 * and does all parsing, reprojection and grouping here.
 */
(function () {
  'use strict';

  const LAYERS = ['dzialki', 'budynki', 'lokale'];

  /* ---------- fetching ---------- */

  // Downloads one layer through the relay, reporting bytes received as they arrive.
  async function fetchLayer(layer, bbox, onProgress) {
    const res = await fetch(`/api/rcn?layer=${layer}&bbox=${bbox.join(',')}`);
    if (!res.ok) {
      let msg = `${res.status} ${res.statusText}`;
      try { const j = await res.json(); if (j.error) msg = j.error; } catch (e) { /* not JSON */ }
      throw new Error(`${layer}: ${msg}`);
    }
    const reader = res.body.getReader();
    const chunks = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.length;
      onProgress && onProgress(size);
    }
    const bytes = new Uint8Array(size);
    let off = 0;
    for (const c of chunks) { bytes.set(c, off); off += c.length; }
    return bytes;
  }

  /* ---------- decoding ---------- */

  // RCN mixes UTF-8 and Windows-1250 values in one document, so the bytes are first
  // turned into a 1-char-per-byte string and each field value is decoded on its own.
  function bytesToBinaryString(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return s;
  }
  const utf8 = new TextDecoder('utf-8', { fatal: true });
  const cp1250 = new TextDecoder('windows-1250');
  const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  function decodeValue(bin) {
    let text = bin;
    if (/[\x80-\xff]/.test(bin)) {
      const b = Uint8Array.from(bin, (c) => c.charCodeAt(0));
      try { text = utf8.decode(b); } catch (e) { text = cp1250.decode(b); }
    }
    return text.replace(/&(amp|lt|gt|quot|apos);/g, (_, n) => ENTITIES[n]).trim();
  }

  /* ---------- coordinates ---------- */

  // EPSG:2180 (PUWG 1992; x = northing, y = easting) -> [lon, lat]. Inverse transverse Mercator on GRS80.
  function puwg92ToWgs84(x, y) {
    const a = 6378137.0, f = 1 / 298.257222101;
    const k0 = 0.9993, lon0 = 19 * Math.PI / 180, fe = 500000.0, fn = -5300000.0;
    const e2 = f * (2 - f), ep2 = e2 / (1 - e2);
    const m = (x - fn) / k0;
    const mu = m / (a * (1 - e2 / 4 - 3 * e2 ** 2 / 64 - 5 * e2 ** 3 / 256));
    const e1 = (1 - Math.sqrt(1 - e2)) / (1 + Math.sqrt(1 - e2));
    const p1 = mu + (3 * e1 / 2 - 27 * e1 ** 3 / 32) * Math.sin(2 * mu)
      + (21 * e1 ** 2 / 16 - 55 * e1 ** 4 / 32) * Math.sin(4 * mu)
      + (151 * e1 ** 3 / 96) * Math.sin(6 * mu) + (1097 * e1 ** 4 / 512) * Math.sin(8 * mu);
    const s1 = Math.sin(p1), c1 = Math.cos(p1), t1 = Math.tan(p1);
    const n1 = a / Math.sqrt(1 - e2 * s1 * s1);
    const r1 = a * (1 - e2) / (1 - e2 * s1 * s1) ** 1.5;
    const C1 = ep2 * c1 * c1, T1 = t1 * t1;
    const d = (y - fe) / (n1 * k0);
    const lat = p1 - (n1 * t1 / r1) * (d * d / 2 - (5 + 3 * T1 + 10 * C1 - 4 * C1 * C1 - 9 * ep2) * d ** 4 / 24
      + (61 + 90 * T1 + 298 * C1 + 45 * T1 * T1 - 252 * ep2 - 3 * C1 * C1) * d ** 6 / 720);
    const lon = lon0 + (d - (1 + 2 * T1 + C1) * d ** 3 / 6
      + (5 - 2 * C1 + 28 * T1 - 3 * C1 * C1 + 8 * ep2 + 24 * T1 * T1) * d ** 5 / 120) / c1;
    return [lon * 180 / Math.PI, lat * 180 / Math.PI];
  }
  // GML posList in EPSG:2180 comes as "northing easting northing easting …".
  function posList(txt) {
    const v = txt.trim().split(/\s+/).map(Number), out = [];
    for (let i = 0; i + 1 < v.length; i += 2) {
      const [lon, lat] = puwg92ToWgs84(v[i], v[i + 1]);
      out.push([+lon.toFixed(7), +lat.toFixed(7)]);
    }
    return out;
  }

  /* ---------- GML parsing ---------- */

  const MEMBER = /<wfs:member>([\s\S]*?)<\/wfs:member>/g;
  const FIELD = /<ms:([A-Za-z_]+)>([^<]*)<\/ms:\1>/g;
  const RING = /<gml:(exterior|interior)>[\s\S]*?<gml:posList[^>]*>([^<]*)</g;
  const POS = /<gml:(?:posList|pos)[^>]*>([^<]*)</;

  function parseLayer(bytes, layer) {
    const s = bytesToBinaryString(bytes);
    if (s.slice(0, 2000).includes('ExceptionReport')) {
      throw new Error(`${layer}: the register service returned an error – ${decodeValue(s.slice(0, 600)).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')}`);
    }
    const out = [];
    for (const m of s.matchAll(MEMBER)) {
      const body = m[1];
      const f = {};
      for (const fm of body.matchAll(FIELD)) f[fm[1]] = decodeValue(fm[2]);
      const rings = [...body.matchAll(RING)].map((r) => posList(r[2]));
      let geom = null;
      if (rings.length) geom = { type: 'Polygon', coordinates: rings };
      else {
        const p = body.match(POS);
        const pts = p ? posList(p[1]) : [];
        if (pts.length) geom = { type: 'Point', coordinates: pts[0] };
      }
      f._layer = layer;
      f._geom = geom;
      out.push(f);
    }
    return out;
  }

  /* ---------- grouping into transactions ---------- */

  const num = (v) => { if (v === '' || v == null) return null; const n = Number(v); return isNaN(n) ? null : n; };

  function centroid(geom) {
    if (!geom) return null;
    if (geom.type === 'Point') return geom.coordinates;
    const ring = geom.coordinates[0];
    let x = 0, y = 0;
    for (const p of ring) { x += p[0]; y += p[1]; }
    return [x / ring.length, y / ring.length];
  }

  function parseAddr(a) {
    if (!a) return '';
    const d = {};
    for (const part of a.split(';')) { const i = part.indexOf(':'); if (i > 0) d[part.slice(0, i)] = part.slice(i + 1); }
    const street = ((d.UL || '') + ' ' + (d.NR_PORZ || '')).trim();
    return [d.MSC || '', street].filter(Boolean).join(', ');
  }

  // Some counties (e.g. Wrocław city, TERYT 0264) store parcel areas in hectares, others in m².
  // The unit is detected per county from the typical parcel size and converted to m².
  function normaliseAreas(records) {
    const byCounty = {};
    for (const r of records) {
      const v = num(r.DZI_POW_EWID);
      if (r._layer === 'dzialki' && v) (byCounty[r.TERYT] ||= []).push(v);
    }
    const hectare = new Set(Object.entries(byCounty)
      .filter(([, vals]) => vals.sort((a, b) => a - b)[vals.length >> 1] < 2).map(([c]) => c));
    for (const r of records) {
      if (!hectare.has(r.TERYT)) continue;
      for (const k of ['DZI_POW_EWID', 'NIER_POW_GRUNTU']) {
        const v = num(r[k]);
        if (v != null) r[k] = String(Math.round(v * 10000 * 10) / 10);
      }
    }
  }

  function classify(recs) {
    const lok = recs.filter((r) => r._layer === 'lokale');
    const bud = recs.filter((r) => r._layer === 'budynki');
    const dz = new Map(recs.filter((r) => r._layer === 'dzialki').map((r) => [r.DZI_ID_DZIALKI, r]));
    const r0 = recs[0];
    let kind = 'other', area = null;
    // Garages, sheds and parking spaces are often sold with a flat or house,
    // so the presence of one dwelling decides the type.
    if (lok.length) {
      const flats = lok.filter((r) => r.LOK_FUNKCJA === 'mieszkalna');
      if (flats.length) {
        kind = { rynekPierwotny: 'apartment_new', rynekWtorny: 'apartment_resale' }[r0.TRAN_RODZAJ_RYNKU] || 'apartment';
        if (new Set(flats.map((r) => r.LOK_ID_LOKALU)).size === 1) area = num(flats[0].LOK_POW_UZYT);
      } else if (lok.every((r) => r.LOK_FUNKCJA === 'garaz')) kind = 'garage';
      else kind = 'commercial_unit';
    } else if (bud.length) {
      const homes = bud.filter((r) => r.BUD_RODZAJ === 'mieszkalny');
      if (homes.length) {
        kind = 'house';
        if (new Set(homes.map((r) => r.BUD_ID_BUDYNKU)).size === 1) area = num(homes[0].BUD_POW_UZYT);
      } else kind = 'other_building';
    } else if (dz.size) {
      const kinds = new Set([...dz.values()].map((r) => r.NIER_RODZAJ));
      if (kinds.size === 1 && kinds.has('nieruchomoscGruntowaNiezabudowana')) {
        kind = 'land';
        area = [...dz.values()].reduce((s, r) => s + (num(r.DZI_POW_EWID) || 0), 0) || null;
      } else kind = 'built_land';
    }
    return { kind, area };
  }

  function transactions(records) {
    normaliseAreas(records);
    const groups = new Map();
    for (const r of records) {
      const k = r.TRAN_LOKALNY_ID_IIP || r.gid;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(r);
    }
    const uniq = (arr) => [...new Set(arr.filter(Boolean))].sort();
    const out = [];
    for (const [tid, recs] of groups) {
      const r0 = recs[0];
      const { kind, area } = classify(recs);
      const price = num(r0.TRAN_CENA_BRUTTO);
      const shares = uniq(recs.map((r) => r.NIER_UDZIAL));
      // Representative point: unit > building > parcel.
      let pick = null;
      for (const layer of ['lokale', 'budynki', 'dzialki']) {
        pick = recs.find((r) => r._layer === layer && r._geom);
        if (pick) break;
      }
      const c = pick && centroid(pick._geom);
      if (!c) continue;
      let address = '';
      for (const r of recs) {
        for (const k of ['LOK_ADRES', 'BUD_ADRES', 'DZI_ADRES']) if (!address && r[k]) address = parseAddr(r[k]);
      }
      out.push({
        id: tid,
        date: (r0.DOK_DATA || '').slice(0, 10),
        kind,
        price,
        area,
        ppm: price && area ? Math.round(price / area) : null,
        land_area: num(r0.NIER_POW_GRUNTU),
        market: r0.TRAN_RODZAJ_RYNKU || '',
        trans_type: r0.TRAN_RODZAJ_TRANS || '',
        seller: r0.TRAN_SPRZEDAJACY || '',
        buyer: r0.TRAN_KUPUJACY || '',
        share: shares.join(','),
        full_share: shares.every((s) => s === '1/1'),
        address,
        deed: r0.DOK_OZNACZENIE || '',
        notary: r0.DOK_TWORCA || '',
        desc: r0.NIER_OPIS || '',
        lat: c[1], lon: c[0],
        parcels: uniq(recs.map((r) => r.DZI_NR_DZIALKI)),
        parcel_ids: uniq(recs.map((r) => r.DZI_ID_DZIALKI)),
        unit_ids: uniq(recs.map((r) => r.LOK_ID_LOKALU)),
        records: recs.map((r) => ({
          layer: r._layer,
          geom: r._geom,
          attrs: Object.fromEntries(Object.entries(r).filter(([k, v]) => !k.startsWith('_') && v)),
        })),
      });
    }
    out.sort((a, b) => a.date.localeCompare(b.date));
    return out;
  }

  /* ---------- browser cache (IndexedDB) ---------- */
  // Best effort: private windows or blocked storage simply mean no cache.
  const CACHE_VERSION = 3, CACHE_TTL_MS = 7 * 24 * 3600 * 1000;
  function idb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('rcn-explorer', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('areas');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async function cacheGet(key) {
    try {
      const db = await idb();
      const v = await new Promise((res, rej) => {
        const r = db.transaction('areas').objectStore('areas').get(key);
        r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
      });
      return v && v.version === CACHE_VERSION && Date.now() - v.saved < CACHE_TTL_MS ? v.data : null;
    } catch (e) { return null; }
  }
  async function cachePut(key, data) {
    try {
      const db = await idb();
      await new Promise((res, rej) => {
        const tx = db.transaction('areas', 'readwrite');
        tx.objectStore('areas').put({ version: CACHE_VERSION, saved: Date.now(), data }, key);
        tx.oncomplete = res; tx.onerror = () => rej(tx.error);
      });
    } catch (e) { /* ignore */ }
  }

  /* ---------- public entry point ---------- */

  // bbox = [south, west, north, east]. onProgress(layer, bytes, done) is called while downloading.
  async function loadArea(bbox, onProgress) {
    const b = bbox.map((v) => +v.toFixed(4));
    const key = b.join(',');
    const t0 = performance.now();
    const hit = await cacheGet(key);
    if (hit) return { ...hit, cached: true, seconds: 0 };
    const parts = await Promise.all(LAYERS.map(async (layer) => {
      const bytes = await fetchLayer(layer, b, (n) => onProgress && onProgress(layer, n, false));
      onProgress && onProgress(layer, bytes.length, true);
      return parseLayer(bytes, layer);
    }));
    const records = parts.flat();
    const data = { bbox: b, raw_records: records.length, transactions: transactions(records) };
    if (records.length) await cachePut(key, data);
    return { ...data, cached: false, seconds: Math.round((performance.now() - t0) / 100) / 10 };
  }

  window.RCN = { loadArea, puwg92ToWgs84, LAYERS };
})();
