/* Ceny nieruchomości (RCN) – interfejs. Dane pobiera i przetwarza rcn.js. */

const KINDS = {
  land:             { label: 'Działka niezabudowana',   color: '#8c6d1f' },
  built_land:       { label: 'Grunt zabudowany (bez bud.)', color: '#c9a227' },
  house:            { label: 'Dom',                     color: '#d1495b' },
  apartment_new:    { label: 'Mieszkanie – pierwotny',  color: '#2a6fdb' },
  apartment_resale: { label: 'Mieszkanie – wtórny',     color: '#00a6a6' },
  apartment:        { label: 'Mieszkanie – nieokreśl.', color: '#7aa6e0' },
  garage:           { label: 'Garaż / miejsce post.',   color: '#8e8e8e' },
  commercial_unit:  { label: 'Lokal użytkowy',          color: '#7b4fb5' },
  other_building:   { label: 'Inny budynek',            color: '#b5651d' },
  other:            { label: 'Inne',                    color: '#bbbbbb' },
};
// Polish plural forms: 1 transakcja, 2–4 transakcje (but 12–14: transakcji), 5+ transakcji.
function plural(n, one, few, many) {
  n = Math.abs(n);
  if (n === 1) return one;
  const d = n % 10, h = n % 100;
  return d >= 2 && d <= 4 && (h < 12 || h > 14) ? few : many;
}
const nTrans = (n) => `${n} ${plural(n, 'transakcja', 'transakcje', 'transakcji')}`;
// Readable Polish for RCN code values.
const MARKET = { rynekPierwotny: 'pierwotny', rynekWtorny: 'wtórny' };
const TRANS = { wolnyRynek: 'wolny rynek', sprzedazPrzetargowa: 'sprzedaż przetargowa', sprzedazBezprzetargowa: 'sprzedaż bezprzetargowa',
  sprzedazWTrybiePrzetargu: 'sprzedaż w trybie przetargu', sprzedazBezprzetargowaNaRzeczNajemcy: 'sprzedaż bezprzetargowa na rzecz najemcy', inna: 'inna' };
const DEFAULT_ON = ['land', 'house', 'apartment_new', 'apartment_resale'];
// Sequential palette (viridis-like), 7 classes.
const RAMP = ['#440154', '#443983', '#31688e', '#21918c', '#35b779', '#90d743', '#fde725'];

const $ = (id) => document.getElementById(id);
const fmt = (v, d = 0) => v == null || isNaN(v) ? '–' : Number(v).toLocaleString('pl-PL', { maximumFractionDigits: d });
const fmtK = (v) => v == null ? '–' : v >= 1e6 ? (v / 1e6).toFixed(2) + ' M' : v >= 1e3 ? Math.round(v / 1e3) + ' k' : Math.round(v);
const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const quantile = (s, p) => { if (!s.length) return null; const i = (s.length - 1) * p, lo = Math.floor(i); return s[lo] + (s[Math.min(lo + 1, s.length - 1)] - s[lo]) * (i - lo); };
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function distM(a, b, c, d) {
  const R = 6371000, r = Math.PI / 180, dLat = (c - a) * r, dLon = (d - b) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a * r) * Math.cos(c * r) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/* ---------------- state ---------------- */
const state = {
  center: null,   // chosen by search or map click
  radius: 1000,
  all: [],        // transactions inside the radius
  filtered: [],
  enabledKinds: new Set(DEFAULT_ON),
  sort: { key: 'date', dir: -1 },
};

/* ---------------- map ---------------- */
const WROCLAW = [51.1079, 17.0385];
const map = L.map('map', { preferCanvas: true, zoomControl: true }).setView(WROCLAW, 12);
// Default base map: the OpenStreetMap-based map served by GUGiK (WMTS, zoom levels "00"–"19"),
// which avoids leaning on the volunteer-run tile.openstreetmap.org servers.
const geoBase = L.tileLayer('https://mapy.geoportal.gov.pl/wss/ext/OSM/BaseMap/service?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0'
  + '&LAYER=osm_3857&STYLE=default&TILEMATRIXSET=GLOBAL_WEBMERCATOR&TILEMATRIX={zz}&TILEROW={y}&TILECOL={x}&FORMAT=image/png',
  { zz: (d) => String(d.z).padStart(2, '0'), maxZoom: 20, maxNativeZoom: 19, attribution: '© OpenStreetMap contributors, GUGiK' }).addTo(map);
const osm = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 20, maxNativeZoom: 19, attribution: '© OpenStreetMap' });
const wms = (url, layers, opts = {}) => L.tileLayer.wms(url, { layers, format: 'image/png', transparent: true, version: '1.3.0', maxZoom: 20, attribution: 'GUGiK / geoportal.gov.pl', ...opts });
const ortho = wms('https://mapy.geoportal.gov.pl/wss/service/PZGIK/ORTO/WMS/StandardResolution', 'Raster', { transparent: false, format: 'image/jpeg' });
const kieg = wms('https://integracja.gugik.gov.pl/cgi-bin/KrajowaIntegracjaEwidencjiGruntow', 'dzialki,numery_dzialek,budynki', { minZoom: 16, tileSize: 512 });
// Layers with text labels are requested as one image for the whole view; tiled
// requests make the server repeat and clip the labels on every tile.
const SingleWMS = L.Layer.extend({
  initialize(url, params, opts = {}) { this._url = url; this._params = params; L.setOptions(this, opts); },
  onAdd(map) { this._map = map; map.on('moveend', this._update, this); this._update(); },
  onRemove(map) { map.off('moveend', this._update, this); if (this._img) map.removeLayer(this._img); this._img = null; },
  getAttribution() { return 'GUGiK / geoportal.gov.pl'; },
  _update() {
    const map = this._map, b = map.getBounds(), size = map.getSize(), dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (this.options.minZoom && map.getZoom() < this.options.minZoom) { if (this._img) map.removeLayer(this._img); this._img = null; return; }
    const sw = L.CRS.EPSG3857.project(b.getSouthWest()), ne = L.CRS.EPSG3857.project(b.getNorthEast());
    const q = new URLSearchParams({ SERVICE: 'WMS', VERSION: '1.3.0', REQUEST: 'GetMap', STYLES: '', CRS: 'EPSG:3857', FORMAT: 'image/png', TRANSPARENT: 'TRUE',
      BBOX: [sw.x, sw.y, ne.x, ne.y].join(','), WIDTH: Math.round(size.x * dpr), HEIGHT: Math.round(size.y * dpr), ...this._params });
    const img = L.imageOverlay(this._url + '?' + q, b, { opacity: this.options.opacity ?? 1, interactive: false });
    img.once('load', () => { if (this._img && this._img !== img) map.removeLayer(this._img); this._img = img; });
    img.addTo(map);
    if (!this._img) this._img = img;
  },
});
const MPZP_URL = 'https://mapy.geoportal.gov.pl/wss/ext/KrajowaIntegracjaMiejscowychPlanowZagospodarowaniaPrzestrzennego';
const mpzp = new SingleWMS(MPZP_URL, { LAYERS: 'raster,wektor-str,wektor-lzb,wektor-pow,wektor-lin,wektor-pkt' }, { opacity: 0.6, minZoom: 14 });
const mpzpBounds = new SingleWMS(MPZP_URL, { LAYERS: 'granice' }, { opacity: 0.9, minZoom: 13 });
const rcnWms = wms('https://mapy.geoportal.gov.pl/wss/service/rcn', 'dzialki,budynki,lokale', { minZoom: 17, tileSize: 512 });
L.control.layers(
  { 'Mapa bazowa (Geoportal)': geoBase, 'OpenStreetMap (osm.org)': osm, 'Ortofotomapa (GUGiK)': ortho },
  { 'Działki ewidencyjne – KIEG (zoom ≥16)': kieg, 'Plany miejscowe – MPZP, rysunki (zoom ≥14)': mpzp, 'Granice i nazwy planów MPZP': mpzpBounds, 'Oficjalna warstwa RCN (zoom ≥17)': rcnWms },
  { collapsed: true }
).addTo(map);
L.control.scale({ imperial: false }).addTo(map);

// Marker and radius circle appear once a location has been chosen.
const centerMarker = L.marker(WROCLAW, { draggable: true, title: 'Środek' });
const circle = L.circle(WROCLAW, { radius: state.radius, color: '#1f6feb', weight: 1.5, fill: false, dashArray: '4 4', interactive: false });
const dataLayer = L.layerGroup().addTo(map);

function setCenter(lat, lon, pan = false) {
  state.center = { lat, lon };
  centerMarker.setLatLng([lat, lon]).addTo(map);
  circle.setLatLng([lat, lon]).addTo(map);
  $('loadBtn').disabled = false;
  if (!state.all.length) status('Lokalizacja ustawiona – kliknij „Pobierz transakcje”.');
  if (pan) map.fitBounds(circle.getBounds(), { padding: [20, 20], animate: false });
}
centerMarker.on('dragend', (e) => { const p = e.target.getLatLng(); setCenter(p.lat, p.lng); });
map.on('click', (e) => setCenter(e.latlng.lat, e.latlng.lng));

/* ---------------- controls ---------------- */
// The slider is the single source of truth for the radius. Browsers can restore a
// slider position on reload / back navigation without firing 'input', so re-read it then too.
function syncRadius() {
  state.radius = +$('radius').value;
  $('radiusOut').textContent = state.radius + ' m';
  circle.setRadius(state.radius);
}
$('radius').addEventListener('input', syncRadius);
window.addEventListener('pageshow', syncRadius);
syncRadius();

$('searchForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const ul = $('results');
  ul.innerHTML = '<li>Szukam…</li>';
  try {
    const res = await geocode($('q').value);
    ul.innerHTML = res.length ? '' : '<li>Nic nie znaleziono</li>';
    res.forEach((r) => {
      const li = document.createElement('li');
      li.textContent = r.display_name;
      li.onclick = () => { setCenter(+r.lat, +r.lon, true); ul.innerHTML = ''; };
      ul.appendChild(li);
    });
    if (res.length === 1) { setCenter(+res[0].lat, +res[0].lon, true); ul.innerHTML = ''; }
  } catch (err) { ul.innerHTML = `<li>${esc(err.message)}</li>`; }
});

// Address search: GUGiK's UUG service first (official Polish addresses, CORS-enabled),
// OpenStreetMap Nominatim as a fallback for anything UUG doesn't know.
async function geocode(q) {
  const out = [];
  // UUG expects "town, street number"; also try the reversed order for "street, town" input.
  const parts = q.split(',').map((x) => x.trim()).filter(Boolean);
  const variants = parts.length === 2 ? [q, `${parts[1]}, ${parts[0]}`] : [q];
  for (const v of variants) {
    if (out.length) break;
    await uug(v, out);
  }
  if (out.length) return out;
  const n = await (await fetch('https://nominatim.openstreetmap.org/search?format=json&limit=6&countrycodes=pl&q=' + encodeURIComponent(q))).json();
  return n.map((r) => ({ lat: +r.lat, lon: +r.lon, display_name: r.display_name }));
}
async function uug(q, out) {
  try {
    const j = await (await fetch('https://services.gugik.gov.pl/uug/?request=GetAddress&address=' + encodeURIComponent(q))).json();
    Object.values(j.results || {}).forEach((r) => {
      let x = +r.x, y = +r.y;   // UUG: x = easting, y = northing (EPSG:2180)
      if (!(x && y)) { const m = /([\d.]+) ([\d.]+)/.exec(r.geometry_wkt || ''); if (m) { x = +m[1]; y = +m[2]; } }
      if (!(x && y)) return;
      const [lon, lat] = RCN.puwg92ToWgs84(y, x);
      const street = [r.street, r.number].filter(Boolean).join(' ');
      const where = (r.jednostka || '').replace(/[{}]/g, '').split(',').filter((p) => p && !/^\d+$/.test(p) && p !== 'Polska').join(', ');
      out.push({ lat, lon, display_name: [street, r.city, where].filter(Boolean).join(', ') });
    });
  } catch (e) { /* service unavailable – caller falls back to Nominatim */ }
}

$('loadBtn').addEventListener('click', load);
['cleanOnly', 'trim', 'undated'].forEach((id) => $(id).addEventListener('change', applyFilters));

/* ---------------- date range selector ---------------- */
// Months are indexed from the first month present in the loaded data.
const dr = { months: [] };
const monthKey = (y, m) => `${y}-${String(m).padStart(2, '0')}`;
function buildDateRange() {
  const ds = state.all.map((t) => t.date).filter(Boolean).sort();
  dr.months = [];
  if (ds.length) {
    let [y, m] = ds[0].slice(0, 7).split('-').map(Number);
    const [ey, em] = ds.at(-1).slice(0, 7).split('-').map(Number);
    while (y < ey || (y === ey && m <= em)) { dr.months.push(monthKey(y, m)); if (++m > 12) { m = 1; y++; } }
  }
  const max = Math.max(dr.months.length - 1, 0);
  ['drFrom', 'drTo'].forEach((id) => { $(id).max = max; });
  $('mFrom').min = $('mTo').min = dr.months[0] || '';
  $('mFrom').max = $('mTo').max = dr.months.at(-1) || '';
  $('drMin').textContent = dr.months[0] || '';
  $('drMax').textContent = dr.months.at(-1) || '';
  // Histogram of all loaded sales, grouped so there are at most ~60 bars.
  const per = Math.max(1, Math.ceil(dr.months.length / 60));
  const counts = new Array(Math.ceil(dr.months.length / per)).fill(0);
  const idx = new Map(dr.months.map((k, i) => [k, i]));
  state.all.forEach((t) => { const i = t.date && idx.get(t.date.slice(0, 7)); if (i != null) counts[Math.floor(i / per)]++; });
  const top = Math.max(...counts, 1);
  dr.per = per;
  $('drHist').innerHTML = counts.map((c, i) => `<span data-i="${i}" style="height:${(100 * c / top).toFixed(1)}%" title="${dr.months[i * per]}: ${nTrans(c)}"></span>`).join('');
  setDateRange(0, max, false);
}
function setDateRange(a, b, apply = true) {
  const max = Math.max(dr.months.length - 1, 0);
  a = Math.max(0, Math.min(a, max)); b = Math.max(0, Math.min(b, max));
  if (a > b) [a, b] = [b, a];
  $('drFrom').value = a; $('drTo').value = b;
  $('mFrom').value = dr.months[a] || ''; $('mTo').value = dr.months[b] || '';
  $('drLabel').textContent = dr.months.length ? `${dr.months[a]} → ${dr.months[b]}` : '–';
  const pct = (i) => (max ? 100 * i / max : 0);
  Object.assign($('drBand').style, { left: pct(a) + '%', width: (pct(b) - pct(a)) + '%' });
  $('drHist').querySelectorAll('span').forEach((s) => {
    const i0 = +s.dataset.i * dr.per, i1 = i0 + dr.per - 1;
    s.classList.toggle('in', i1 >= a && i0 <= b);
  });
  // Keep the lower thumb grabbable when both handles sit at the right end.
  $('drFrom').style.zIndex = a >= max - 1 ? 3 : 1;
  if (apply) applyFiltersSoon();
}
let filterTimer;
function applyFiltersSoon() { clearTimeout(filterTimer); filterTimer = setTimeout(applyFilters, 120); }
$('drFrom').addEventListener('input', () => setDateRange(+$('drFrom').value, Math.max(+$('drFrom').value, +$('drTo').value)));
$('drTo').addEventListener('input', () => setDateRange(Math.min(+$('drFrom').value, +$('drTo').value), +$('drTo').value));
$('mFrom').addEventListener('change', () => { const i = dr.months.indexOf($('mFrom').value); if (i >= 0) setDateRange(i, +$('drTo').value); });
$('mTo').addEventListener('change', () => { const i = dr.months.indexOf($('mTo').value); if (i >= 0) setDateRange(+$('drFrom').value, i); });
$('drHist').addEventListener('click', (e) => {
  // Clicking a bar moves the nearest handle there.
  const i = e.target.dataset?.i; if (i == null) return;
  const m = +i * dr.per, a = +$('drFrom').value, b = +$('drTo').value;
  Math.abs(m - a) <= Math.abs(m - b) ? setDateRange(m, b) : setDateRange(a, Math.min(m + dr.per - 1, dr.months.length - 1));
});
document.querySelectorAll('.presets button').forEach((btn) => btn.addEventListener('click', () => {
  const n = +btn.dataset.months, max = dr.months.length - 1;
  setDateRange(n ? Math.max(0, max - n + 1) : 0, max);
}));

['mode', 'metric', 'hexSize'].forEach((id) => $(id).addEventListener('change', drawMap));
document.querySelectorAll('#tabs button[data-tab]').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('#tabs button[data-tab], .tab').forEach((x) => x.classList.remove('on'));
  b.classList.add('on');
  $('tab-' + b.dataset.tab).classList.add('on');
  setPanelCollapsed(false);   // picking a tab always brings the panel back
}));

// Collapse the data panel to just its tab bar so the map can use the space.
// The choice is remembered per browser (best effort; storage may be unavailable).
function setPanelCollapsed(collapsed) {
  if (document.body.classList.contains('panel-collapsed') === collapsed) return;
  document.body.classList.toggle('panel-collapsed', collapsed);
  const btn = $('panelToggle');
  btn.textContent = collapsed ? '▴ Pokaż panel' : '▾ Ukryj panel';
  btn.setAttribute('aria-expanded', String(!collapsed));
  btn.title = collapsed ? 'Pokaż panel z tabelą i ponownymi sprzedażami' : 'Ukryj panel danych, aby zobaczyć więcej mapy';
  try { localStorage.setItem('rcn.panelCollapsed', collapsed ? '1' : '0'); } catch (e) { /* ignore */ }
  const c = map.getCenter();
  map.invalidateSize({ pan: false });
  map.setView(c, map.getZoom(), { animate: false });   // keep the same spot in the middle
}
$('panelToggle').addEventListener('click', () => setPanelCollapsed(!document.body.classList.contains('panel-collapsed')));
try { if (localStorage.getItem('rcn.panelCollapsed') === '1') setPanelCollapsed(true); } catch (e) { /* ignore */ }
$('csvBtn').onclick = exportCsv;
$('geojsonBtn').onclick = exportGeojson;

function status(msg, err = false) { const s = $('status'); s.textContent = msg; s.className = 'status' + (err ? ' err' : ''); }

/* ---------------- loading ---------------- */
async function load() {
  const { lat, lon } = state.center, r = state.radius;
  const dLat = r / 111320, dLon = r / (111320 * Math.cos(lat * Math.PI / 180));
  const bbox = [lat - dLat, lon - dLon, lat + dLat, lon + dLon];
  status('Pobieranie z geoportal.gov.pl…');
  const stopLoading = showLoading(r);
  try {
    const data = await RCN.loadArea(bbox, layerProgress);
    state.all = data.transactions
      // PLN/m² outside 5–100 000 is a data-entry or unit error, not a price; drop the value but keep the sale.
      .map((t) => ({ ...t, ppm: t.ppm >= 5 && t.ppm <= 100000 ? t.ppm : null, dist: Math.round(distM(lat, lon, t.lat, t.lon)), year: t.date ? +t.date.slice(0, 4) : null }))
      .filter((t) => t.dist <= r);
    const years = state.all.map((t) => t.year).filter(Boolean);
    buildDateRange();
    if (state.pendingRange) {
      const [f, t] = state.pendingRange, i = dr.months.indexOf(f), j = dr.months.indexOf(t);
      setDateRange(i >= 0 ? i : 0, j >= 0 ? j : dr.months.length - 1, false);
      state.pendingRange = null;
    }
    status(`${nTrans(state.all.length)} w promieniu ${r} m (${data.raw_records} ${plural(data.raw_records, 'rekord', 'rekordy', 'rekordów')} rejestru, `
      + `${data.cached ? 'z pamięci przeglądarki' : data.seconds.toLocaleString('pl-PL') + ' s'}). `
      + `Najnowszy akt: ${years.length ? state.all.map((t) => t.date).sort().at(-1) : '–'}`);
    // Show the data panels only when there is something in them.
    document.body.classList.toggle('has-data', state.all.length > 0);
    map.invalidateSize({ pan: false });
    map.fitBounds(circle.getBounds(), { padding: [20, 20], animate: false });
    if (!state.all.length) status(`Brak transakcji w promieniu ${r} m. Spróbuj większego promienia albo innego miejsca.`, true);
    buildKindFilter();
    applyFilters();
  } catch (err) {
    status('Błąd: ' + err.message, true);
  } finally {
    stopLoading();
  }
}

// Overlay with spinner, elapsed time and per-layer progress, shown for every download.
const LAYER_NAMES = { dzialki: 'Działki', budynki: 'Budynki', lokale: 'Lokale' };
function layerProgress(layer, bytes, done) {
  const el = document.querySelector(`#loadingLayers li[data-layer="${layer}"] .lp`);
  if (!el) return;
  el.textContent = `${(bytes / 1048576).toFixed(1)} MB${done ? ' ✓' : '…'}`;
  el.parentElement.classList.toggle('done', done);
}
function showLoading(r) {
  const btn = $('loadBtn'), t0 = Date.now();
  btn.disabled = true;
  btn.classList.add('busy');
  btn.textContent = 'Pobieranie…';
  $('loadingTitle').textContent = `Pobieranie transakcji w promieniu ${r} m`;
  $('loadingHint').textContent = '';
  $('loadingTime').textContent = '0 s';
  $('loadingLayers').innerHTML = RCN.LAYERS.map((l) => `<li data-layer="${l}"><span>${LAYER_NAMES[l]}</span><span class="lp">czekam…</span></li>`).join('');
  $('loading').hidden = false;
  const tick = setInterval(() => {
    const sec = Math.round((Date.now() - t0) / 1000);
    $('loadingTime').textContent = sec + ' s';
    if (sec === 8) $('loadingHint').textContent = 'Usługa rejestru działa wolno przy dużych obszarach. Za pierwszym razem promień 1 km trwa zwykle 10–60 s; kolejne pobrania są brane z pamięci podręcznej.';
  }, 500);
  return () => {
    clearInterval(tick);
    $('loading').hidden = true;
    btn.classList.remove('busy');
    btn.textContent = 'Pobierz transakcje';
    btn.disabled = !state.center;
  };
}

function buildKindFilter() {
  const counts = {};
  state.all.forEach((t) => (counts[t.kind] = (counts[t.kind] || 0) + 1));
  $('kinds').innerHTML = '';
  Object.entries(KINDS).forEach(([k, v]) => {
    if (!counts[k]) return;
    const lab = document.createElement('label');
    lab.innerHTML = `<input type="checkbox" ${state.enabledKinds.has(k) ? 'checked' : ''}><span class="sw" style="background:${v.color}"></span>${v.label}<span class="n">${counts[k]}</span>`;
    lab.querySelector('input').onchange = (e) => { e.target.checked ? state.enabledKinds.add(k) : state.enabledKinds.delete(k); applyFilters(); };
    $('kinds').appendChild(lab);
  });
}

/* ---------------- filtering ---------------- */
function applyFilters() {
  const mFrom = dr.months[+$('drFrom').value] || '0000', mTo = dr.months[+$('drTo').value] || '9999';
  const undated = $('undated').checked, clean = $('cleanOnly').checked, trim = $('trim').checked;
  let rows = state.all.filter((t) => state.enabledKinds.has(t.kind)
    && (t.date ? (t.date.slice(0, 7) >= mFrom && t.date.slice(0, 7) <= mTo) : undated)
    && (!clean || (t.trans_type === 'wolnyRynek' && t.full_share && t.price > 0)));
  if (trim) {
    const bounds = {};
    Object.keys(KINDS).forEach((k) => {
      const v = rows.filter((t) => t.kind === k && t.ppm).map((t) => t.ppm).sort((a, b) => a - b);
      if (v.length >= 10) bounds[k] = [quantile(v, 0.02), quantile(v, 0.98)];
    });
    rows = rows.filter((t) => !t.ppm || !bounds[t.kind] || (t.ppm >= bounds[t.kind][0] && t.ppm <= bounds[t.kind][1]));
  }
  // Percentile of PLN/m² within the same property type and year window, so that
  // land (~hundreds PLN/m²) and flats (~thousands) can share one colour scale.
  Object.keys(KINDS).forEach((k) => {
    const v = rows.filter((t) => t.kind === k && t.ppm).map((t) => t.ppm).sort((a, b) => a - b);
    const pv = rows.filter((t) => t.kind === k && t.price).map((t) => t.price).sort((a, b) => a - b);
    const pct = (arr, x) => Math.round(100 * arr.filter((y) => y < x).length / (arr.length - 1));
    rows.forEach((t) => {
      if (t.kind !== k) return;
      t.rel = t.ppm && v.length > 1 ? pct(v, t.ppm) : null;
      t.relprice = t.price && pv.length > 1 ? pct(pv, t.price) : null;
    });
  });
  state.filtered = rows;
  $('csvBtn').disabled = $('geojsonBtn').disabled = !rows.length;
  drawMap();
  drawSummary();
  drawTable();
  drawRepeat();
}

/* ---------------- colour scales ---------------- */
function metricValue(t, metric) {
  if (metric === 'rel') return t.rel;
  if (metric === 'relprice') return t.relprice;
  if (metric === 'ppm') return t.ppm;
  if (metric === 'price') return t.price;
  if (metric === 'year') return t.year;
  return null;
}
function makeScale(values) {
  const s = values.filter((v) => v != null).sort((a, b) => a - b);
  if (!s.length) return null;
  const breaks = RAMP.slice(1).map((_, i) => quantile(s, (i + 1) / RAMP.length));
  return { breaks, min: quantile(s, 0.01), max: quantile(s, 0.99), color: (v) => { if (v == null) return '#bdbdbd'; let i = 0; while (i < breaks.length && v > breaks[i]) i++; return RAMP[i]; } };
}

/* ---------------- map drawing ---------------- */
let markerIndex = new Map();
function drawMap() {
  dataLayer.clearLayers();
  markerIndex = new Map();
  const mode = $('mode').value, metric = $('metric').value, rows = state.filtered;
  $('hexRow').style.display = mode === 'hex' ? '' : 'none';
  if (mode === 'hex' && metric === 'kind') $('metric').value = 'ppm';
  const m = $('metric').value;

  if (mode === 'hex') return drawHex(rows, m);

  const scale = m === 'kind' ? null : makeScale(rows.map((t) => metricValue(t, m)));
  // Outline always shows the property type; fill shows the chosen value.
  // No value (e.g. houses rarely have a floor area, so no PLN/m²) -> hollow ring.
  const fillOf = (t) => m === 'kind' ? KINDS[t.kind].color : scale && metricValue(t, m) != null ? scale.color(metricValue(t, m)) : null;
  const sorted = [...rows].sort((a, b) => (metricValue(a, m) ?? -1) - (metricValue(b, m) ?? -1)); // high values on top

  sorted.forEach((t) => {
    const fill = fillOf(t), edge = KINDS[t.kind].color;
    let layer;
    if (mode === 'polygons') {
      const geoms = t.records.map((r) => r.geom).filter((g) => g && g.type === 'Polygon');
      // Prefer building outlines for houses, parcel outlines otherwise; flats are points.
      const bld = t.records.filter((r) => r.layer === 'budynki' && r.geom?.type === 'Polygon').map((r) => r.geom);
      const use = bld.length && t.kind === 'house' ? bld : t.records.filter((r) => r.layer === 'dzialki' && r.geom?.type === 'Polygon').map((r) => r.geom);
      if (use.length || geoms.length) {
        layer = L.geoJSON({ type: 'GeometryCollection', geometries: use.length ? use : geoms },
          { style: { color: m === 'kind' ? '#fff' : edge, weight: m === 'kind' ? 1 : 2, fillColor: fill || edge, fillOpacity: fill ? 0.6 : 0.08 } });
      }
    }
    if (!layer) {
      const r = t.price ? Math.max(3, Math.min(7, Math.log10(t.price) - 0.5)) : 3;
      layer = m === 'kind'
        ? L.circleMarker([t.lat, t.lon], { radius: r, color: '#fff', weight: 1, fillColor: fill, fillOpacity: 0.9 })
        : L.circleMarker([t.lat, t.lon], { radius: r + 1, color: edge, weight: 2.5, fillColor: fill || '#fff', fillOpacity: fill ? 0.95 : 0.6 });
    }
    layer.bindPopup(() => popupHtml(t), { maxWidth: 360 });
    layer.addTo(dataLayer);
    markerIndex.set(t.id, layer);
  });
  drawLegend(m, scale);
}

function drawHex(rows, metric) {
  const size = +$('hexSize').value;
  const { lat: lat0, lon: lon0 } = state.center;
  const kx = 111320 * Math.cos(lat0 * Math.PI / 180), ky = 110574;
  const toXY = (lat, lon) => [(lon - lon0) * kx, (lat - lat0) * ky];
  const toLL = (x, y) => [lat0 + y / ky, lon0 + x / kx];
  const bins = new Map();
  rows.forEach((t) => {
    const v = metricValue(t, metric);
    if (v == null) return;
    const [x, y] = toXY(t.lat, t.lon);
    let q = (Math.sqrt(3) / 3 * x - y / 3) / size, r = (2 / 3 * y) / size, s = -q - r;
    let rq = Math.round(q), rr = Math.round(r), rs = Math.round(s);
    const dq = Math.abs(rq - q), dr = Math.abs(rr - r), ds = Math.abs(rs - s);
    if (dq > dr && dq > ds) rq = -rr - rs; else if (dr > ds) rr = -rq - rs;
    const key = rq + ',' + rr;
    if (!bins.has(key)) bins.set(key, { q: rq, r: rr, vals: [], items: [] });
    bins.get(key).vals.push(v); bins.get(key).items.push(t);
  });
  const meds = [...bins.values()].map((b) => (b.med = median(b.vals)));
  const scale = makeScale(meds);
  bins.forEach((b) => {
    const cx = size * Math.sqrt(3) * (b.q + b.r / 2), cy = size * 1.5 * b.r;
    const pts = [...Array(6)].map((_, i) => { const a = Math.PI / 180 * (60 * i - 30); return toLL(cx + size * Math.cos(a), cy + size * Math.sin(a)); });
    const kinds = {};
    b.items.forEach((t) => (kinds[t.kind] = (kinds[t.kind] || 0) + 1));
    L.polygon(pts, { color: '#fff', weight: 1, fillColor: scale.color(b.med), fillOpacity: 0.75 })
      .bindTooltip(`<b>${{ year: 'Rok (mediana)', rel: 'Percentyl (mediana)', relprice: 'Percentyl (mediana)', ppm: 'Cena za m² (mediana)', price: 'Cena (mediana)' }[metric]}: `
        + `${metric === 'year' ? b.med : fmt(b.med)}${metric === 'ppm' || metric === 'price' ? ' zł' : ''}</b><br>${nTrans(b.vals.length)}<br>` +
        Object.entries(kinds).map(([k, n]) => `${KINDS[k].label}: ${n}`).join('<br>'), { sticky: true })
      .addTo(dataLayer);
  });
  drawLegend(metric, scale, metric === 'ppm' && state.enabledKinds.size > 1 ? 'Wskazówka: mediany w heksagonach mieszają typy nieruchomości. Zaznacz jeden typ, aby porównanie było rzetelne.' : '');
}

function drawLegend(metric, scale, note = '') {
  const el = $('legend');
  if (metric === 'kind') {
    el.innerHTML = Object.entries(KINDS).filter(([k]) => state.enabledKinds.has(k))
      .map(([, v]) => `<div class="cat"><span class="sw" style="background:${v.color}"></span>${v.label}</div>`).join('');
    return;
  }
  if (!scale) { el.innerHTML = '<span class="hint">Brak wartości dla tej miary.</span>'; return; }
  const f = metric === 'year' || metric === 'rel' || metric === 'relprice' ? (v) => Math.round(v) : metric === 'price' ? fmtK : (v) => fmt(v);
  const mapMode = $('mode').value, open = metric === 'ppm' || metric === 'price';
  el.innerHTML = `<div>${{ rel: 'Cena za m² – percentyl w obrębie typu', relprice: 'Cena całkowita – percentyl w obrębie typu', ppm: 'Cena za m² (zł)', price: 'Cena całkowita (zł)', year: 'Rok sprzedaży' }[metric]} – 7 klas o równej liczebności</div>
    <div class="bar">${RAMP.map((c) => `<span style="background:${c}"></span>`).join('')}</div>
    <div class="ticks"><span>${open ? '≤' : ''}${f(scale.min)}</span>${scale.breaks.filter((_, i) => i % 2 === 1).map((b) => `<span>${f(b)}</span>`).join('')}<span>${open ? '≥' : ''}${f(scale.max)}</span></div>
    ${metric === 'rel' || metric === 'relprice' ? '<div class="hint">0 = najtańsza w swoim typie w wybranym zakresie, 100 = najdroższa.</div>' : ''}
    ${mapMode !== 'hex' ? `<div class="outl">${Object.entries(KINDS).filter(([k]) => state.enabledKinds.has(k))
      .map(([, v]) => `<span class="cat"><span class="ring" style="border-color:${v.color}"></span>${v.label}</span>`).join('')}</div>
    <div class="hint">Obwódka = typ nieruchomości, wypełnienie = wartość. Puste kółko nie ma wartości dla tej miary${metric === 'rel' || metric === 'ppm'
      ? ' – zwykle to dom (RCN rzadko podaje powierzchnię użytkową domu) albo akt obejmujący kilka lokali. Wybierz <i>Cena całkowita względem typu</i>, aby pokolorować także domy.' : '.'}</div>` : ''}
    ${note ? `<div class="hint">${note}</div>` : ''}`;
}

const PARTY = { osobaFizyczna: 'osoba fizyczna', osobaPrawna: 'osoba prawna', gmina: 'gmina', jednostkaSamorzaduTerytorialnego: 'jedn. samorządu terytorialnego', skarbPanstwa: 'Skarb Państwa', powiat: 'powiat', wojewodztwo: 'województwo', inny: 'inny' };
function popupHtml(t) {
  const rows = [
    ['Data', t.date || '–'], ['Typ', KINDS[t.kind].label], ['Cena', fmt(t.price) + ' zł'],
    ['Powierzchnia', t.area ? fmt(t.area, 2) + ' m²' : '–'], ['Cena za m²', t.ppm ? fmt(t.ppm) + ' zł' : '–'], ['Pow. gruntu', t.land_area ? fmt(t.land_area) + ' m²' : '–'],
    ['Rynek', MARKET[t.market] || t.market || '–'], ['Rodzaj transakcji', TRANS[t.trans_type] || t.trans_type || '–'],
    ['Sprzedający → kupujący', `${PARTY[t.seller] || t.seller} → ${PARTY[t.buyer] || t.buyer}`], ['Udział', t.share || '–'],
    ['Działki', t.parcels.join(', ') || '–'], ['Akt', t.deed], ['Odległość', fmt(t.dist) + ' m'],
  ];
  const recs = t.records.map((r) => `<details><summary>rekord: ${LAYER_NAMES[r.layer] || r.layer}</summary><table>${Object.entries(r.attrs)
    .filter(([k]) => !['gid', 'TERYT', 'TRAN_PRZESTRZEN_NAZW', 'TRAN_LOKALNY_ID_IIP'].includes(k))
    .map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join('')}</table></details>`).join('');
  return `<div class="popup"><b>${esc(t.address || 'Brak adresu')}</b><table>${rows.map(([k, v]) => `<tr><td>${k}</td><td>${esc(v)}</td></tr>`).join('')}</table>
    ${t.desc ? `<p>${esc(t.desc)}</p>` : ''}${recs}</div>`;
}

/* ---------------- summary ---------------- */
function drawSummary() {
  const rows = state.filtered;
  if (!rows.length) { $('summary').innerHTML = 'Brak transakcji spełniających filtry.'; return; }
  const maxY = Math.max(...rows.map((t) => t.year || 0));
  const recentFrom = maxY - 2;
  const tr = Object.keys(KINDS).filter((k) => rows.some((t) => t.kind === k)).map((k) => {
    const all = rows.filter((t) => t.kind === k), rec = all.filter((t) => t.year >= recentFrom);
    const ppm = rec.map((t) => t.ppm).filter(Boolean), pr = rec.map((t) => t.price).filter(Boolean);
    return `<tr><td><span class="sw" style="background:${KINDS[k].color}"></span> ${KINDS[k].label}</td><td>${all.length}</td><td>${rec.length}</td><td>${fmtK(median(pr))}</td><td>${fmt(median(ppm))}</td></tr>`;
  }).join('');
  $('summary').innerHTML = `<table><tr><th>Typ</th><th>Wszystkie</th><th>${recentFrom}+</th><th>Med. cena</th><th>Med. zł/m²</th></tr>${tr}</table>
    <p class="hint">Kolumny z medianą obejmują lata ${recentFrom}–${maxY}.</p>`;
}

const decYear = (d) => +d.slice(0, 4) + (+d.slice(5, 7) - 1) / 12 + (+d.slice(8, 10) - 1) / 365;

/* ---------------- table ---------------- */
const COLS = [
  ['date', 'Data'], ['kind', 'Typ'], ['address', 'Adres'], ['price', 'Cena zł', 1], ['area', 'Pow. m²', 1],
  ['ppm', 'zł/m²', 1], ['land_area', 'Grunt m²', 1], ['dist', 'Odl. m', 1], ['seller', 'Sprzedający'], ['buyer', 'Kupujący'], ['parcels', 'Działki'], ['deed', 'Akt'],
];
function drawTable() {
  const { key, dir } = state.sort;
  const rows = [...state.filtered].sort((a, b) => { const x = a[key] ?? '', y = b[key] ?? ''; return (x > y ? 1 : x < y ? -1 : 0) * dir; });
  const head = `<thead><tr>${COLS.map(([k, l, n]) => `<th data-k="${k}" class="${n ? 'num' : ''}">${l}${k === key ? (dir > 0 ? ' ▲' : ' ▼') : ''}</th>`).join('')}</tr></thead>`;
  const body = rows.slice(0, 2000).map((t) => `<tr data-id="${t.id}">${COLS.map(([k, , n]) => {
    let v = t[k];
    if (k === 'kind') v = KINDS[v].label; else if (k === 'parcels') v = v.join(' '); else if (k === 'seller' || k === 'buyer') v = PARTY[v] || v;
    else if (n) v = fmt(v, k === 'area' ? 1 : 0);
    return `<td class="${n ? 'num' : ''}">${esc(v)}</td>`;
  }).join('')}</tr>`).join('');
  const tbl = $('tbl');
  tbl.className = 'data';
  tbl.innerHTML = head + '<tbody>' + body + '</tbody>';
  tbl.querySelectorAll('th').forEach((th) => th.onclick = () => { state.sort = { key: th.dataset.k, dir: state.sort.key === th.dataset.k ? -state.sort.dir : -1 }; drawTable(); });
  tbl.querySelectorAll('tbody tr').forEach((tr) => tr.onclick = () => focus(state.filtered.find((t) => t.id === tr.dataset.id)));
}

// ---- locating a sale on the map ----
// Marker radius is up to ~8 px plus a 2.5 px outline, so two dot centres need about
// 22 px between them to be told apart. For a target sale we find its nearest neighbour
// that is not at the very same point and pick the lowest zoom at which that gap is
// at least MIN_GAP_PX on screen: metres per pixel at zoom z = 156543·cos(lat) / 2^z.
const MIN_GAP_PX = 22, MIN_ZOOM = 15, MAX_ZOOM = 20;
function zoomToSeparate(t, others) {
  let nearest = Infinity, samePoint = 0;
  for (const o of others) {
    if (o === t) continue;
    const d = distM(t.lat, t.lon, o.lat, o.lon);
    if (d < 1) { samePoint++; continue; }   // same building: no zoom can separate these
    if (d < nearest) nearest = d;
  }
  const mpp0 = 156543.034 * Math.cos(t.lat * Math.PI / 180);   // metres per pixel at zoom 0
  const need = nearest === Infinity ? 17 : Math.ceil(Math.log2(mpp0 * MIN_GAP_PX / nearest));
  const gapAt = (z) => nearest / (mpp0 / 2 ** z);                 // on-screen gap in px
  const zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, need));
  return { zoom, nearest, samePoint, separable: nearest === Infinity || gapAt(zoom) >= MIN_GAP_PX, gapAt };
}

const highlightLayer = L.layerGroup().addTo(map);
function highlight(t, info) {
  highlightLayer.clearLayers();
  const lines = [esc(t.address || t.parcels.join(', ') || 'Brak adresu'), `${t.date || 'bez daty'} · ${fmt(t.price)} zł`];
  if (info.samePoint) lines.push(`<span class="hl-note">+${info.samePoint} ${plural(info.samePoint, 'inna transakcja', 'inne transakcje', 'innych transakcji')} w tym samym punkcie (ten sam budynek)</span>`);
  else if (!info.separable) lines.push(`<span class="hl-note">Bardzo bliski sąsiad (${info.nearest.toFixed(1).replace('.', ',')} m) – punkty mogą się stykać</span>`);
  const icon = L.divIcon({ className: 'hl-icon', iconSize: [0, 0],
    html: `<div class="hl"><div class="hl-ring"></div><div class="hl-arrow"></div><div class="hl-label" title="Kliknij, aby zobaczyć szczegóły">${lines.join('<br>')}<span class="hl-x" title="Ukryj">×</span></div></div>` });
  const m = L.marker([t.lat, t.lon], { icon, zIndexOffset: 1000, keyboard: false }).addTo(highlightLayer);
  const el = m.getElement();
  L.DomEvent.disableClickPropagation(el);
  el.querySelector('.hl-x').onclick = (e) => { e.stopPropagation(); highlightLayer.clearLayers(); };
  el.querySelector('.hl-label').onclick = (e) => {
    e.stopPropagation();
    L.popup({ maxWidth: 360, offset: [0, -40] }).setLatLng([t.lat, t.lon]).setContent(popupHtml(t)).openOn(map);
  };
  markerIndex.get(t.id)?.bringToFront?.();
}
function showOnMap(t) {
  if (!t) return;
  const info = zoomToSeparate(t, state.filtered);
  // Keep the current zoom if it already separates the dots; otherwise zoom in just enough.
  const cur = map.getZoom();
  const zoom = cur >= info.zoom ? cur : info.zoom;
  map.closePopup();
  map.setView([t.lat, t.lon], zoom, { animate: true });
  highlight(t, info);
}
// Several sales: fit them all; if they sit on one spot, treat them as one target.
function showManyOnMap(list) {
  list = list.filter(Boolean);
  if (!list.length) return;
  const latest = [...list].sort((a, b) => (b.date || '').localeCompare(a.date || ''))[0];
  if (list.every((t) => distM(t.lat, t.lon, latest.lat, latest.lon) < 30)) return showOnMap(latest);
  highlightLayer.clearLayers();
  map.closePopup();
  map.fitBounds(L.latLngBounds(list.map((t) => [t.lat, t.lon])), { padding: [40, 40], maxZoom: 18 });
  list.forEach((t) => L.circleMarker([t.lat, t.lon], { radius: 12, color: '#ff3d00', weight: 3, fill: false, className: 'hl-pulse', interactive: false }).addTo(highlightLayer));
}
const focus = showOnMap;

/* ---------------- repeat sales (location tree) ---------------- */
// Town › street › building number › property › sales. A property is one flat
// (unit ID) or one set of parcels; leaves are the individual sales.
const treeOpen = new Set();   // paths of expanded folders, kept across redraws
const leafOpen = new Set();   // ids of expanded sales
const treeSeen = new Set();   // towns already shown once (so a user's collapse sticks)

const natCmp = (a, b) => a.localeCompare(b, 'pl', { numeric: true, sensitivity: 'base' });
function splitAddress(t) {
  const [town, ...rest] = (t.address || '').split(', ');
  const tail = rest.join(', ').trim();
  if (!t.address) return { town: '(brak adresu)', street: '(brak ulicy)', number: '–' };
  const m = tail.match(/^(.*\D)\s+(\S*\d\S*)$/);
  if (m) return { town, street: m[1].trim(), number: m[2] };
  if (/\d/.test(tail)) return { town, street: '(brak ulicy)', number: tail };
  return { town, street: tail || '(brak ulicy)', number: '–' };
}
function propertyOf(t) {
  if (t.unit_ids.length) {
    const nums = t.unit_ids.map((u) => (u.match(/BUD\.(\w+)_LOK/) || [])[1]).filter(Boolean);
    return { key: 'L:' + t.unit_ids.join('|'), label: nums.length ? `Lokal ${nums.join(', ')}` : 'Lokal' };
  }
  if (t.parcel_ids.length) return { key: 'P:' + t.parcel_ids.join('|'), label: `${t.parcels.length > 1 ? 'Działki' : 'Działka'} ${t.parcels.join(', ')}` };
  return { key: 'T:' + t.id, label: 'Nieruchomość' };
}
const pctTxt = (v, d = 0) => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(d).replace('.', ',')}%`;

function drawRepeat() {
  const onlyRepeat = $('treeRepeat').checked;
  const q = $('treeSearch').value.trim().toLowerCase();

  // Group sales into properties.
  const props = new Map();
  state.filtered.forEach((t) => {
    const p = propertyOf(t);
    if (!props.has(p.key)) props.set(p.key, { ...p, sales: [], loc: splitAddress(t) });
    const sales = props.get(p.key).sales;
    // RCN sometimes holds the same deed twice under different transaction IDs.
    if (!sales.some((o) => o.date === t.date && o.price === t.price)) sales.push(t);
  });

  // Price change vs the previous sale of the same property.
  props.forEach((p) => {
    p.sales.sort((a, b) => (a.date || '').localeCompare(b.date || ''));
    p.sales.forEach((t, i) => {
      const prev = p.sales[i - 1];
      t._chg = null;
      if (!prev || !prev.price || !t.price || !prev.date || !t.date) return;
      const yrs = decYear(t.date) - decYear(prev.date);
      if (yrs < 0.08) return; // same deed entered twice
      // A yearly rate over less than a year is mostly noise, so only total change is shown then.
      t._chg = { prev, total: t.price / prev.price - 1, yearly: yrs >= 1 ? Math.pow(t.price / prev.price, 1 / yrs) - 1 : null, yrs, sameKind: prev.kind === t.kind };
    });
  });

  let list = [...props.values()];
  if (onlyRepeat) list = list.filter((p) => p.sales.length > 1);
  if (q) list = list.filter((p) => `${p.loc.town} ${p.loc.street} ${p.loc.number} ${p.label}`.toLowerCase().includes(q));

  // Build town › street › number › property.
  const root = new Map();
  list.forEach((p) => {
    const { town, street } = p.loc;
    const number = p.loc.number === '–' ? p.label : p.loc.number; // no house number: file under the parcel/unit
    const tn = root.get(town) || root.set(town, new Map()).get(town);
    const st = tn.get(street) || tn.set(street, new Map()).get(street);
    (st.get(number) || st.set(number, []).get(number)).push(p);
  });

  const stats = (props) => {
    const sales = props.flatMap((p) => p.sales);
    const yearly = sales.filter((t) => t._chg && t._chg.sameKind && t._chg.yearly != null).map((t) => t._chg.yearly);
    const last = sales.map((t) => t.date).filter(Boolean).sort().at(-1);
    return `<span class="badges"><span>${props.length} ${plural(props.length, 'nieruchomość', 'nieruchomości', 'nieruchomości')}</span><span>${nTrans(sales.length)}</span>` +
      (yearly.length ? `<span class="${median(yearly) >= 0 ? 'up' : 'down'}" title="Mediana rocznej zmiany ceny między kolejnymi sprzedażami tej samej nieruchomości">${pctTxt(median(yearly), 1)}/rok</span>` : '') +
      (last ? `<span class="muted">ost. ${last}</span>` : '') + '</span>';
  };
  // Towns start expanded; while searching, every folder with a match is open.
  root.forEach((_, town) => { if (!treeSeen.has(town)) { treeSeen.add(town); treeOpen.add(town); } });
  const pinTargets = new Map();  // key -> sales to show when its pin is clicked
  const pin = (key, sales) => { pinTargets.set(key, sales); return `<button class="pin" data-pin="${esc(key)}" title="Pokaż na mapie">📍</button>`; };
  const folder = (path, icon, label, inner, props, cls = '') =>
    `<details class="node ${cls}" data-path="${esc(path)}" ${q || treeOpen.has(path) ? 'open' : ''}><summary><span class="ico">${icon}</span><span class="lbl">${esc(label)}</span>${pin(path, props.flatMap((p) => p.sales))}${stats(props)}</summary><div class="kids">${inner}</div></details>`;

  const leaf = (t) => {
    const c = t._chg;
    const chg = c ? `<span class="${c.total >= 0 ? 'up' : 'down'}" title="względem ${c.prev.date} (${fmt(c.prev.price)} zł)${c.sameKind ? '' : ' – zmienił się typ, np. działka została w międzyczasie zabudowana'}">${pctTxt(c.total)}${c.yearly != null ? ` · ${pctTxt(c.yearly, 1)}/rok` : ` w ${Math.round(c.yrs * 12)} mies.`}${c.sameKind ? '' : ' *'}</span>` : '';
    const rows = [
      ['Typ', KINDS[t.kind].label], ['Cena', fmt(t.price) + ' zł'], ['Pow. użytkowa', t.area ? fmt(t.area, 2) + ' m²' : '–'],
      ['Cena za m²', t.ppm ? fmt(t.ppm) + ' zł' : '–'], ['Pow. gruntu', t.land_area ? fmt(t.land_area) + ' m²' : '–'], ['Rynek', MARKET[t.market] || t.market || '–'],
      ['Rodzaj transakcji', TRANS[t.trans_type] || t.trans_type || '–'], ['Sprzedający', PARTY[t.seller] || t.seller || '–'], ['Kupujący', PARTY[t.buyer] || t.buyer || '–'],
      ['Udział', t.share || '–'], ['Działki', t.parcels.join(', ') || '–'], ['Lokale', t.unit_ids.join(', ') || '–'],
      ['Akt', t.deed || '–'], ['Notariusz', t.notary || '–'], ['Odległość', fmt(t.dist) + ' m'],
    ];
    if (c) rows.push(['Poprzednia sprzedaż', `${c.prev.date} · ${fmt(c.prev.price)} zł · ${c.yrs.toFixed(1).replace('.', ',')} r. wcześniej`]);
    if (t.desc) rows.push(['Opis', t.desc]);
    return `<details class="leaf" data-id="${t.id}" ${leafOpen.has(t.id) ? 'open' : ''}><summary><span class="ico">📄</span>${pin('sale:' + t.id, [t])}` +
      `<span class="date">${t.date || 'bez daty'}</span><span class="sw" style="background:${KINDS[t.kind].color}"></span>` +
      `<span class="price">${fmt(t.price)} zł</span><span class="muted">${t.ppm ? fmt(t.ppm) + ' zł/m²' : t.area ? fmt(t.area, 1) + ' m²' : ''}</span>${chg}</summary>` +
      `<div class="detail"><table>${rows.map(([k, v]) => `<tr><td>${k}</td><td>${esc(v)}</td></tr>`).join('')}</table>` +
      `<button class="mapBtn" data-id="${t.id}">Pokaż na mapie</button></div></details>`;
  };

  const last = (k) => k.startsWith('(');  // '(brak adresu)', '(brak ulicy)' go to the end
  const sortedEntries = (m) => [...m.entries()].sort((a, b) => (last(a[0]) - last(b[0])) || natCmp(a[0], b[0]));
  const html = sortedEntries(root).map(([town, streets]) => {
    const townProps = [...streets.values()].flatMap((n) => [...n.values()].flat());
    const inner = sortedEntries(streets).map(([street, numbers]) => {
      const stProps = [...numbers.values()].flat();
      const inner2 = sortedEntries(numbers).map(([num, ps]) => {
        const path = `${town}|${street}|${num}`;
        // Only add a property level when several properties share one address.
        const inner3 = ps.length === 1
          ? ps[0].sales.map(leaf).join('')
          : ps.sort((a, b) => natCmp(a.label, b.label)).map((p) => folder(`${path}|${p.key}`, '🏠', p.label, p.sales.map(leaf).join(''), [p], 'prop')).join('');
        const label = num === ps[0].label ? num : `${num}${ps.length === 1 ? ' · ' + ps[0].label : ''}`;
        return folder(path, '📁', label, inner3, ps);
      }).join('');
      return folder(`${town}|${street}`, '📁', street, inner2, stProps);
    }).join('');
    return folder(town, '📁', town, inner, townProps, 'town');
  }).join('');

  const allYearly = list.flatMap((p) => p.sales).filter((t) => t._chg && t._chg.sameKind && t._chg.yearly != null).map((t) => t._chg.yearly);
  $('treeInfo').innerHTML = `${list.length} ${plural(list.length, 'nieruchomość', 'nieruchomości', 'nieruchomości')}, ${nTrans(list.reduce((n, p) => n + p.sales.length, 0))}` +
    (allYearly.length ? ` · mediana zmiany ceny między sprzedażami tej samej nieruchomości: <b class="${median(allYearly) >= 0 ? 'up' : 'down'}">${pctTxt(median(allYearly), 1)}/rok</b>` : '');
  const tree = $('tree');
  tree.innerHTML = html || `<p class="hint">${onlyRepeat ? 'Żadna nieruchomość w bieżącym wyborze nie została sprzedana więcej niż raz.' : 'Brak transakcji spełniających filtry.'}</p>`;
  tree.querySelectorAll('details.node').forEach((d) => d.addEventListener('toggle', () => { d.open ? treeOpen.add(d.dataset.path) : treeOpen.delete(d.dataset.path); }));
  tree.querySelectorAll('details.leaf').forEach((d) => d.addEventListener('toggle', () => { d.open ? leafOpen.add(d.dataset.id) : leafOpen.delete(d.dataset.id); }));
  tree.querySelectorAll('.mapBtn').forEach((b) => b.onclick = () => focus(state.filtered.find((t) => t.id === b.dataset.id)));
  tree.querySelectorAll('.pin').forEach((b) => b.addEventListener('click', (e) => {
    e.preventDefault(); e.stopPropagation();   // don't open/close the folder
    showManyOnMap(pinTargets.get(b.dataset.pin) || []);
  }));
}
function setTreeOpen(open) {
  document.querySelectorAll('#tree details.node').forEach((d) => { d.open = open; });
}
$('treeSearch').addEventListener('input', () => { clearTimeout(drawRepeat._t); drawRepeat._t = setTimeout(drawRepeat, 150); });
$('treeRepeat').addEventListener('change', drawRepeat);
$('treeExpand').onclick = () => setTreeOpen(true);
$('treeCollapse').onclick = () => setTreeOpen(false);

/* ---------------- export ---------------- */
function download(name, text, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
const EXPORT_COLS = ['date', 'kind', 'address', 'price', 'area', 'ppm', 'land_area', 'dist', 'market', 'trans_type', 'seller', 'buyer', 'share', 'parcels', 'deed', 'notary', 'lat', 'lon', 'desc'];
// CSV is for people (Polish headers and values, Excel-friendly); GeoJSON keeps the raw codes.
const CSV_HEADERS = { date: 'data', kind: 'typ', address: 'adres', price: 'cena_zl', area: 'pow_uzytkowa_m2', ppm: 'cena_za_m2', land_area: 'pow_gruntu_m2',
  dist: 'odleglosc_m', market: 'rynek', trans_type: 'rodzaj_transakcji', seller: 'sprzedajacy', buyer: 'kupujacy', share: 'udzial', parcels: 'dzialki',
  deed: 'akt', notary: 'notariusz', lat: 'szer_geogr', lon: 'dl_geogr', desc: 'opis' };
function exportCsv() {
  const q = (v) => `"${String(Array.isArray(v) ? v.join(' ') : v ?? '').replace(/"/g, '""')}"`;
  const val = (t, c) => c === 'kind' ? KINDS[t.kind].label : c === 'market' ? MARKET[t.market] || t.market
    : c === 'trans_type' ? TRANS[t.trans_type] || t.trans_type : c === 'seller' || c === 'buyer' ? PARTY[t[c]] || t[c] : t[c];
  const csv = [EXPORT_COLS.map((c) => CSV_HEADERS[c]).join(';'), ...state.filtered.map((t) => EXPORT_COLS.map((c) => q(val(t, c))).join(';'))].join('\r\n');
  download('rcn_transakcje.csv', '﻿' + csv, 'text/csv;charset=utf-8');
}
function exportGeojson() {
  const fc = { type: 'FeatureCollection', features: state.filtered.map((t) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [t.lon, t.lat] },
    properties: Object.fromEntries(EXPORT_COLS.filter((c) => c !== 'lat' && c !== 'lon').map((c) => [c, t[c]])) })) };
  download('rcn_transakcje.geojson', JSON.stringify(fc), 'application/geo+json');
}

// The app starts empty on Wrocław. A link with ?load=1&lat=…&lon=…&r=… opens and
// downloads that area; the parameters are then removed so a refresh starts clean.
(function initFromUrl() {
  const p = new URLSearchParams(location.search);
  if (location.search) history.replaceState(null, '', location.pathname);
  status('Wyszukaj adres albo kliknij mapę, aby wybrać lokalizację.');
  if (p.get('load') !== '1') return;
  if (p.has('r')) { state.radius = +p.get('r'); $('radius').value = state.radius; $('radiusOut').textContent = state.radius + ' m'; circle.setRadius(state.radius); }
  if (p.has('mode')) $('mode').value = p.get('mode');
  if (p.has('metric')) $('metric').value = p.get('metric');
  if (p.has('q')) $('treeSearch').value = p.get('q');
  const OVERLAYS = { ortho, kieg, mpzp, mpzpBounds, rcn: rcnWms };
  (p.get('overlays') || '').split(',').forEach((k) => OVERLAYS[k] && (k === 'ortho' ? (map.removeLayer(geoBase), ortho.addTo(map)) : OVERLAYS[k].addTo(map)));
  if (p.has('from') || p.has('to')) state.pendingRange = [p.get('from'), p.get('to')];
  if (p.has('tab')) document.querySelector(`#tabs button[data-tab="${p.get('tab')}"]`)?.click();
  if (p.has('lat') && p.has('lon')) { setCenter(+p.get('lat'), +p.get('lon'), true); load(); }
})();
