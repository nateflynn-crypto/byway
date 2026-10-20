#!/usr/bin/env node
/* Byway end-to-end tests.
   Loads index.html in headless Chromium with every outside service replaced by local fakes
   (Photon, OSRM, Overpass, Wikipedia/Wikidata, map tiles), so the whole scan pipeline can be
   checked without the internet and without load on the free servers.

   Usage:  node tests/run.mjs            (from the repo root)
           node tests/run.mjs cache      (only tests whose name contains "cache")
   Needs:  Playwright (npm install in tests/, or a global install). Real Leaflet is used when
           tests/node_modules/leaflet exists; otherwise tests/leaflet-stub.js stands in. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const require = createRequire(import.meta.url);

let chromium;
try { ({ chromium } = require('playwright')); }
catch { ({ chromium } = require(require.resolve('playwright', { paths: [process.env.NODE_PATH || '', '/opt/npm-tools/node_modules'] }))); }

const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
// BYWAY_FIXTURE=fixtures/other.json swaps in another fixture (e.g. one captured with ?debug=1 → Copy fixture);
// most assertions are written for troy-lake-placid.json, so use it with the debug dump.
const FIX_PATH = process.env.BYWAY_FIXTURE ? path.resolve(HERE, process.env.BYWAY_FIXTURE) : path.join(HERE, 'fixtures', 'troy-lake-placid.json');
const FIX = JSON.parse(fs.readFileSync(FIX_PATH, 'utf8'));
const leafletDir = path.join(HERE, 'node_modules', 'leaflet', 'dist');
const REAL_LEAFLET = fs.existsSync(path.join(leafletDir, 'leaflet.js'));
const LEAFLET_JS = REAL_LEAFLET ? fs.readFileSync(path.join(leafletDir, 'leaflet.js'), 'utf8') : fs.readFileSync(path.join(HERE, 'leaflet-stub.js'), 'utf8');
const LEAFLET_CSS = REAL_LEAFLET ? fs.readFileSync(path.join(leafletDir, 'leaflet.css'), 'utf8') : '';
const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==', 'base64');
const BASE = 'https://byway.test/';

/* ---------- geometry for the fakes ---------- */
const MI = 1609.344, R_EARTH = 6371008.8, rad = d => d * Math.PI / 180;
const havM = (a, b) => { const dLat = rad(b[0] - a[0]), dLon = rad(b[1] - a[1]); const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLon / 2) ** 2; return 2 * R_EARTH * Math.asin(Math.sqrt(h)); };
function densify(wps, stepM = 800) {
  const out = [wps[0]];
  for (let i = 1; i < wps.length; i++) {
    const a = wps[i - 1], b = wps[i], n = Math.max(1, Math.ceil(havM(a, b) / stepM));
    for (let k = 1; k <= n; k++) out.push([a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n]);
  }
  return out;
}
function segDistM(p, a, b) { // equirectangular, fine at these scales
  const kx = Math.cos(rad(p[0])) * R_EARTH * Math.PI / 180, ky = R_EARTH * Math.PI / 180;
  const ax = (a[1] - p[1]) * kx, ay = (a[0] - p[0]) * ky, bx = (b[1] - p[1]) * kx, by = (b[0] - p[0]) * ky;
  const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
  const t = L2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L2)) : 0;
  return Math.hypot(ax + t * dx, ay + t * dy);
}
const ROUTE = densify(FIX.waypoints);
const ROUTE_M = ROUTE.slice(1).reduce((s, p, i) => s + havM(ROUTE[i], p), 0) * 1.12; // road vs straight-line
function parseAround(q) {
  const m = /\(around:(\d+),([-\d.,]+)\)/.exec(q);
  if (!m) return null;
  const nums = m[2].split(',').map(Number), pts = [];
  for (let i = 0; i + 1 < nums.length; i += 2) pts.push([nums[i], nums[i + 1]]);
  return { r: +m[1], pts };
}
function overpassAnswer(q, extra = []) {
  const a = parseAround(q);
  if (!a) return { elements: [] };
  const els = FIX.elements.concat(extra).filter(e => {
    const p = e.lat != null ? [e.lat, e.lon] : [e.center.lat, e.center.lon];
    for (let i = 1; i < a.pts.length; i++) if (segDistM(p, a.pts[i - 1], a.pts[i]) <= a.r) return true;
    return a.pts.length === 1 && havM(p, a.pts[0]) <= a.r;
  });
  return { version: 0.6, generator: 'byway-test', elements: els };
}

/* ---------- places index built from the fixture by the real builder ---------- */
// Coverage area for tests: Troy → Schroon Lake (lat 42.5–44.0), deliberately leaving Lake Placid out.
const TEST_POLY = 'test-area\n1\n  -74.5 42.5\n  -73.0 42.5\n  -73.0 44.0\n  -74.5 44.0\n  -74.5 42.5\nEND\nEND\n';
let builtIndex;
function testIndex() {
  if (builtIndex !== undefined) return builtIndex;
  const py = spawnSync('python3', ['--version'], { encoding: 'utf8' });
  if (py.status !== 0) return (builtIndex = null);
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'byway-index-'));
  const seq = path.join(dir, 'features.geojsonseq'), poly = path.join(dir, 'area.poly'), out = path.join(dir, 'places', 'v1');
  fs.writeFileSync(seq, FIX.elements.map(e => JSON.stringify({ type: 'Feature',
    geometry: { type: 'Point', coordinates: e.lat != null ? [e.lon, e.lat] : [e.center.lon, e.center.lat] },
    properties: { '@type': e.type, '@id': e.id, ...e.tags } })).join('\n') + '\n');
  fs.writeFileSync(poly, TEST_POLY);
  const r = spawnSync('python3', [path.join(ROOT, 'tools', 'build_places.py'), '--geojsonseq', seq, '--poly', poly, '--out', out, '--rules-from', path.join(ROOT, 'index.html')], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`build_places.py failed:\n${r.stderr}`);
  return (builtIndex = { dir: out, log: r.stdout.trim() });
}
const INDEX_PREFIX = { 'cdn.jsdelivr.net': '/gh/nateflynn/byway@places-data/places/v1/', 'raw.githubusercontent.com': '/nateflynn/byway/places-data/places/v1/' };

// Towns along the fixture route, for the fake reverse lookup.
const TOWNS = [['Troy', 42.7284, -73.6918], ['Latham', 42.747, -73.759], ['Clifton Park', 42.8656, -73.771], ['Saratoga Springs', 43.0831, -73.7846], ['Glens Falls', 43.3095, -73.644], ['Lake George', 43.4262, -73.7123], ['Warrensburg', 43.4967, -73.7762], ['Schroon Lake', 43.73, -73.817], ['North Hudson', 43.98, -73.74], ['Keene', 44.256, -73.792], ['Lake Placid', 44.2795, -73.9799]];

/* ---------- fake services ---------- */
const FIX_IDS_IN_CORRIDOR = FIX.elements.map(e => e.id).filter(id => id !== 26);
const OVERPASS_HOSTS = ['overpass-api.de', 'overpass.private.coffee', 'overpass.kumi.systems', 'maps.mail.ru'];
function makeWorld() {
  // behavior per host: 'ok' | 429 | 504 | 'remark' | 'xml' | 'refuse', or an array consumed one per request
  const world = { behavior: Object.fromEntries(OVERPASS_HOSTS.map(h => [h, 'ok'])), requests: [] };
  world.set = (h, b) => { world.behavior[h] = b; };
  world.all = b => OVERPASS_HOSTS.forEach(h => world.set(h, b));
  world.overpassCalls = () => world.requests.filter(r => r.kind === 'overpass');
  world.wikiCalls = () => world.requests.filter(r => r.kind === 'wiki');
  world.reset = () => { world.requests = []; };
  return world;
}
async function handle(route, world) {
  const req = route.request(), u = new URL(req.url()), host = u.hostname;
  const json = (obj, status = 200) => route.fulfill({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(obj) });
  if (host === 'byway.test') return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: HTML });
  if (host === 'cdnjs.cloudflare.com' && /leaflet.*\.js$/.test(u.pathname)) return route.fulfill({ status: 200, contentType: 'application/javascript', body: LEAFLET_JS });
  if (host === 'cdnjs.cloudflare.com' && /leaflet.*\.css$/.test(u.pathname)) return route.fulfill({ status: 200, contentType: 'text/css', body: LEAFLET_CSS });
  if (/fonts\.(googleapis|gstatic)\.com$/.test(host)) return route.fulfill({ status: 200, contentType: 'text/css', body: '' });
  if (/tile\.openstreetmap\.org$/.test(host)) return route.fulfill({ status: 200, contentType: 'image/png', body: PNG_1PX });
  if (host === 'photon.komoot.io' && u.pathname.startsWith('/reverse')) {
    world.requests.push({ kind: 'reverse' });
    const la = +u.searchParams.get('lat'), lo = +u.searchParams.get('lon');
    const near = TOWNS.reduce((a, t) => (havM([la, lo], [t[1], t[2]]) < havM([la, lo], [a[1], a[2]]) ? t : a));
    return json({ type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [near[2], near[1]] }, properties: { osm_key: 'place', osm_value: 'town', name: near[0], city: near[0], state: 'New York', countrycode: 'US' } }] });
  }
  if (host === 'photon.komoot.io') {
    world.requests.push({ kind: 'photon', url: u.href });
    if (world.photonDelay) await new Promise(r => setTimeout(r, world.photonDelay));
    const q = u.searchParams.get('q') || '';
    const hit = FIX.geocode[q];
    return json({ type: 'FeatureCollection', features: hit ? [{ type: 'Feature', geometry: { type: 'Point', coordinates: [hit[1], hit[0]] }, properties: { name: q.split(',')[0], state: 'New York', countrycode: 'US', osm_value: 'town' } }] : [] });
  }
  if (host === 'nominatim.openstreetmap.org') return json([]);
  if (INDEX_PREFIX[host] && u.pathname.startsWith(INDEX_PREFIX[host])) {
    const rel = u.pathname.slice(INDEX_PREFIX[host].length);
    world.requests.push({ kind: 'index', host, rel });
    const idx = world.index && testIndex();
    if (!idx || world.index === 'fail' || (world.index === 'cdnfail' && host === 'cdn.jsdelivr.net')) return route.fulfill({ status: 503, contentType: 'text/plain', headers: { 'access-control-allow-origin': '*' }, body: 'unavailable' });
    const file = path.join(idx.dir, rel);
    if (!file.startsWith(idx.dir) || !fs.existsSync(file)) return route.fulfill({ status: 404, contentType: 'text/plain', headers: { 'access-control-allow-origin': '*' }, body: 'not found' });
    return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: fs.readFileSync(file, 'utf8') });
  }
  if (host === 'router.project-osrm.org' || host === 'routing.openstreetmap.de') {
    world.requests.push({ kind: 'osrm', url: u.href });
    const nLegs = Math.max(1, decodeURIComponent(u.pathname.split('/').pop()).split(';').length - 1);
    return json({ code: 'Ok', routes: [{ geometry: { type: 'LineString', coordinates: ROUTE.map(([la, lo]) => [lo, la]) }, distance: ROUTE_M, duration: ROUTE_M / (52 * MI / 3600), legs: Array.from({ length: nLegs }, () => ({ distance: ROUTE_M / nLegs, duration: 1 })) }] });
  }
  const op = OVERPASS_HOSTS.find(h => host === h);
  if (op) {
    const q = new URLSearchParams(req.postData() || '').get('data') || '';
    let b = world.behavior[op];
    if (Array.isArray(b)) b = b.length > 1 ? b.shift() : b[0];
    world.requests.push({ kind: 'overpass', host: op, behavior: b });
    if (b === 'refuse') return route.abort('connectionrefused');
    if (b === 429) return route.fulfill({ status: 429, contentType: 'text/html', headers: { 'access-control-allow-origin': '*' }, body: '<html><body>Too Many Requests</body></html>' });
    if (b === 504) return route.fulfill({ status: 504, contentType: 'text/html', headers: { 'access-control-allow-origin': '*' }, body: '<html><body>504 Gateway Time-out</body></html>' });
    if (b === 'xml') return route.fulfill({ status: 200, contentType: 'application/osm3s+xml', headers: { 'access-control-allow-origin': '*' }, body: '<?xml version="1.0"?><osm><remark>runtime error</remark></osm>' });
    if (b === 'remark') return json({ elements: [], remark: 'runtime error: Query timed out in "query" at line 1 after 100 seconds.' });
    if (b === 'slowEmpty') { await new Promise(r => setTimeout(r, world.slowMs || 2600)); return json({ version: 0.6, elements: [] }); }
    return json(overpassAnswer(q, world.extra));
  }
  if (/\.wikipedia\.org$/.test(host) && u.searchParams.get('generator') === 'geosearch') {
    world.requests.push({ kind: 'wiki' });
    if (world.wiki === 'fail') return route.fulfill({ status: 503, contentType: 'text/plain', headers: { 'access-control-allow-origin': '*' }, body: 'unavailable' });
    const [la, lo] = (u.searchParams.get('ggscoord') || '0|0').split('|').map(Number), r = +u.searchParams.get('ggsradius');
    const pages = (FIX.wiki || []).filter(e => havM([la, lo], [e.lat, e.lon]) <= r).map(e => ({
      pageid: e.id, ns: 0, title: e.tags.name, coordinates: [{ lat: e.lat, lon: e.lon, primary: true, globe: 'earth' }],
      ...(e.tags.wikidata ? { pageprops: { wikibase_item: e.tags.wikidata } } : {}), ...(e.tags.wpdesc ? { description: e.tags.wpdesc, descriptionsource: 'local' } : {}) }));
    return json(pages.length ? { batchcomplete: true, query: { pages } } : { batchcomplete: true });
  }
  if (/\.wikipedia\.org$/.test(host)) {
    const titles = (u.searchParams.get('titles') || '').split('|').filter(Boolean);
    return json({ query: { pages: titles.map(t => ({ title: t, extract: `${t} — test extract.`, description: 'test description' })) } });
  }
  if (host === 'www.wikidata.org') return json({ entities: {} });
  return route.abort('blockedbyclient');
}

/* ---------- harness ---------- */
let browser;
async function openPage(world, { context, search = '' } = {}) {
  const ctx = context || await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.route('**/*', r => handle(r, world));
  const page = await ctx.newPage();
  page.on('pageerror', e => { world.pageErrors = (world.pageErrors || []).concat(String(e)); });
  await page.goto(BASE + search);
  await page.waitForFunction(() => !!window.__byway);
  return { page, ctx };
}
const [FROM, TO] = Object.keys(FIX.geocode);
const TROY = `?from=${encodeURIComponent(FROM)}&to=${encodeURIComponent(TO)}`;
async function settle(page, timeout = 30000) {
  await page.waitForFunction(() => {
    const S = window.__byway && window.__byway.state, st = document.querySelector('#status');
    return S && !S.busy && !S.bg && st && !st.hidden && !/Scouting|Retrying|Finding your|Drawing|Looking up|checking OpenStreetMap/.test(st.textContent);
  }, null, { timeout });
  return page.evaluate(() => {
    const S = window.__byway.state, st = document.querySelector('#status');
    return {
      status: st.textContent.trim(), kind: st.className,
      finds: S.finds.map(f => ({ id: f.id, src: f.src, name: f.name, cat: f.cat, base: f.base, off: f.off, score: f.score, info: !!(f.info && f.info.extract) })),
      wikiPoints: window.__byway.wikiPoints(S.route, S.queryRadius).length,
      shortlist: S.shortlist.map(f => f.name), failed: S.failed.length, raw: S.raw.size,
      chunks: window.__byway.makeChunks(S.route, S.queryRadius).length,
    };
  });
}
// Starts a scan after shrinking timing knobs, so failure paths run in seconds, not minutes.
async function scanWithFastTimers(page) {
  await page.evaluate(() => {
    const C = window.__byway.CFG; if (C) { C.benchMaxWaitMs = 150; C.overpassMs = 3000; }
    document.querySelector('[data-action="preset"][data-i="3"]').click();
  });
  await page.waitForFunction(() => window.__byway.state.busy);
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
function assert(cond, msg) { if (!cond) throw new Error(msg); }
const names = list => list.map(f => (typeof f === 'string' ? f : f.name));

/* ---------- tests ---------- */
test('classify: heritage, shop-like gallery, bare viewpoint, weird', async () => {
  const world = makeWorld();
  const { page, ctx } = await openPage(world);
  const r = await page.evaluate(() => {
    const c = window.__byway.classify;
    return {
      jb: c({ boundary: 'protected_area', 'ref:nhl': '72000840', 'heritage:operator': 'nhl', protection_title: 'State Historic Site' }, 'John Brown Farm State Historic Site'),
      wild: c({ boundary: 'protected_area', wikipedia: 'en:Sentinel Range Wilderness' }, 'Sentinel Range Wilderness'),
      otter: c({ tourism: 'gallery', building: 'yes' }, 'The Curious Otter'),
      gallery: c({ tourism: 'gallery', website: 'https://x' }, 'Adirondack Store & Gallery'),
      bareView: c({ tourism: 'viewpoint' }, 'Valley View Ledge'),
      generic: c({ tourism: 'viewpoint' }, 'Scenic Overlook'),
      gnome: c({ tourism: 'attraction' }, "World's Largest Garden Gnome"),
      giantView: c({ tourism: 'viewpoint' }, 'Giant Washbowl Overlook'),
      // from a measured pass over the Northeast index
      mermaid: c({ tourism: 'artwork', artwork_type: 'statue' }, 'Nerida, Eastport Mermaid'),
      totem: c({ tourism: 'artwork', artwork_type: 'installation' }, 'Indian Steps Totem Pole'),
      garden: c({ tourism: 'artwork', artwork_type: 'sculpture' }, "Mr. Imagination's Sculpture Garden"),
      milk: c({ tourism: 'attraction' }, 'Hood Milk Bottle'),
      haunt: c({ tourism: 'attraction', attraction: 'haunted_house' }, 'Halls of Horror'),
      wheel: c({ tourism: 'attraction', attraction: 'big_wheel' }, 'Giant Wheel'),
      coaster: c({ tourism: 'attraction', attraction: 'roller_coaster', wikipedia: 'en:El Toro (Six Flags Great Adventure)' }, 'El Toro'),
      lighthouse: c({ man_made: 'lighthouse', description: 'White house and tower on brown square skeleton framework.' }, 'Gloucester Breakwater Light'),
      bigBen: c({ tourism: 'artwork' }, 'Big Ben'),
      giantPeak: c({ natural: 'peak' }, 'Giant Mountain'),
      priv: c({ historic: 'ruins', access: 'private' }, 'Private Ruins'),
    };
  });
  assert(r.jb.cat === 'history' && Math.abs(r.jb.base - 3.0) < 1e-9, `John Brown Farm → ${JSON.stringify(r.jb)}`);
  assert(r.wild.cat === 'nature', `wilderness → ${r.wild.cat}`);
  assert(Math.abs(r.otter.base - 0.6) < 1e-9 && Math.abs(r.gallery.base - 1.9) < 1e-9, `galleries → ${r.otter.base}, ${r.gallery.base}`);
  assert(Math.abs(r.bareView.base - 0.5) < 1e-9, `bare viewpoint → ${r.bareView.base}`);
  assert(r.generic.base < 0, `generic name should go negative → ${r.generic.base}`);
  assert(r.gnome.cat === 'weird', `gnome → ${r.gnome.cat}`);
  assert(r.giantView.cat === 'nature' && Math.abs(r.giantView.base - 0.5) < 1e-9, `"Giant" viewpoint → ${JSON.stringify(r.giantView)}`);
  assert(r.giantPeak.cat === 'nature', `"Giant" peak → ${r.giantPeak.cat}`);
  for (const k of ['mermaid', 'totem', 'garden', 'milk', 'haunt']) assert(r[k].cat === 'weird', `${k} should be an Oddity: ${JSON.stringify(r[k])}`);
  for (const k of ['wheel', 'coaster', 'lighthouse', 'bigBen']) assert(r[k].cat !== 'weird', `${k} should not be an Oddity: ${JSON.stringify(r[k])}`);
  assert(r.wheel.base < 0 && r.coaster.base < 2, `rides inside parks should score low: wheel ${r.wheel.base}, coaster ${r.coaster.base}`);
  assert(r.priv.base < 0, `private → ${r.priv.base}`);
  await ctx.close();
});

test('full scan: every section queried once, sensible finds and shortlist', async () => {
  const world = makeWorld();
  const { page, ctx } = await openPage(world, { search: TROY });
  const r = await settle(page);
  const calls = world.overpassCalls();
  assert(/^✓?\s*Found \d+ spots/.test(r.status), `status: ${r.status}`);
  assert(r.failed === 0, `failed sections: ${r.failed}`);
  assert(r.chunks >= 3, `expected the 40 mi sections to split this drive into 3+, got ${r.chunks}`);
  assert(calls.length === r.chunks, `overpass calls ${calls.length} ≠ sections ${r.chunks}`);
  const n = names(r.finds), byName = Object.fromEntries(r.finds.map(f => [f.name, f]));
  for (const want of ['Fort William Henry', 'John Brown Farm State Historic Site', 'The Hyde Collection', "World's Largest Garden Gnome", 'Hackensack Covered Bridge'])
    assert(n.includes(want), `missing find: ${want}`);
  assert(!n.includes('Far Away Museum'), 'place far outside the corridor was included');
  assert(n.filter(x => x === 'Lake Placid Olympic Museum').length === 1, 'duplicate Olympic Museum not merged');
  assert(byName['John Brown Farm State Historic Site'].cat === 'history', 'John Brown Farm not History');
  assert(byName["World's Largest Garden Gnome"].cat === 'weird', 'gnome not an Oddity');
  assert(byName['Hackensack Covered Bridge'].cat === 'history', 'covered bridge not History');
  for (const junk of ['Scenic Overlook', 'Private Ruins', 'Mural', 'Saratoga Battle Historical Marker', 'The Curious Otter', 'Valley View Ledge'])
    assert(!r.shortlist.includes(junk), `junk on shortlist: ${junk}`);
  // The shortlist spreads picks along the road, so a decent find in an already-crowded stretch
  // (John Brown Farm sits in the last 10 mi with two Olympic sites) can be left to All finds.
  for (const good of ['Fort William Henry', 'National Museum of Racing and Hall of Fame', 'The Hyde Collection'])
    assert(r.shortlist.includes(good), `strong find missing from shortlist: ${good}`);
  assert(byName['Fort William Henry'].info, 'Wikipedia enrichment did not attach an extract');
  assert(r.shortlist.length === 10, `a ~136 mi day trip should get a 10-stop shortlist, got ${r.shortlist.length}`);
  assert(!world.pageErrors, `page errors: ${world.pageErrors}`);
  await ctx.close();
});

test('cache: reloading the same drive asks Overpass nothing', async () => {
  const world = makeWorld();
  const { page, ctx } = await openPage(world, { search: TROY });
  const first = await settle(page);
  world.reset();
  await page.reload();
  const second = await settle(page);
  assert(world.overpassCalls().length === 0, `expected 0 Overpass calls after reload, got ${world.overpassCalls().length}`);
  assert(world.wikiCalls().length === 0, `expected 0 Wikipedia lookups after reload, got ${world.wikiCalls().length}`);
  assert(second.finds.length === first.finds.length && second.finds.length > 0, `finds ${second.finds.length} vs ${first.finds.length}`);
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('byway.opidx') || '[]').length);
  assert(stored === first.chunks + first.wikiPoints, `localStorage holds ${stored} answers, expected ${first.chunks} sections + ${first.wikiPoints} Wikipedia lookups`);
  await ctx.close();
});

test('corridor: narrowing re-filters instantly without new queries', async () => {
  const world = makeWorld();
  const { page, ctx } = await openPage(world, { search: TROY });
  const wide = await settle(page);
  world.reset();
  await page.evaluate(() => { const r = document.querySelector('#radius'); r.value = '1'; r.dispatchEvent(new Event('input', { bubbles: true })); });
  const narrow = await settle(page);
  assert(world.overpassCalls().length === 0, 'narrowing triggered Overpass calls');
  assert(narrow.finds.length < wide.finds.length, `finds did not shrink (${wide.finds.length} → ${narrow.finds.length})`);
  assert(narrow.finds.every(f => f.off <= 1), 'a find beyond 1 mi survived narrowing');
  await ctx.close();
});

test('failover: rate-limited and erroring hosts are skipped and benched', async () => {
  const world = makeWorld();
  world.set('overpass-api.de', 429);
  world.set('overpass.private.coffee', 504);
  const { page, ctx } = await openPage(world);
  await scanWithFastTimers(page);
  const r = await settle(page);
  assert(r.failed === 0 && /Found/.test(r.status), `scan did not recover: ${r.status}`);
  const hs = await page.evaluate(() => Object.fromEntries([...window.__byway.hostState].map(([u, v]) => [new URL(u).hostname, v.why])));
  assert(hs['overpass-api.de'] === 'rate-limited', `overpass-api.de bench: ${hs['overpass-api.de']}`);
  assert(hs['overpass.private.coffee'] === 'HTTP 504', `private.coffee bench: ${hs['overpass.private.coffee']}`);
  const deCalls = world.overpassCalls().filter(c => c.host === 'overpass-api.de').length;
  assert(deCalls <= 2, `kept hammering a rate-limited host (${deCalls} calls)`);
  await ctx.close();
});

test('failover: "timed out" remarks and XML error pages count as failures', async () => {
  const world = makeWorld();
  world.set('overpass-api.de', 'remark');
  world.set('overpass.private.coffee', 'xml');
  const { page, ctx } = await openPage(world);
  await scanWithFastTimers(page);
  const r = await settle(page);
  assert(r.failed === 0 && r.finds.length > 0, `remark/xml answers were accepted as empty: ${r.status}`);
  await ctx.close();
});

test('failover: refused connections bench the host', async () => {
  const world = makeWorld();
  world.set('overpass-api.de', 'refuse');
  const { page, ctx } = await openPage(world);
  await scanWithFastTimers(page);
  const r = await settle(page);
  assert(r.failed === 0, `scan failed: ${r.status}`);
  const why = await page.evaluate(() => (window.__byway.hostState.get('https://overpass-api.de/api/interpreter') || {}).why);
  assert(why === 'refused', `refused host bench reason: ${why}`);
  await ctx.close();
});

test('retry: all hosts down → Retry button; Retry fetches only missing sections', async () => {
  const world = makeWorld();
  world.all(504);
  const { page, ctx } = await openPage(world);
  await scanWithFastTimers(page);
  const down = await settle(page);
  assert(down.failed === down.chunks, `expected all ${down.chunks} sections failed, got ${down.failed}`);
  assert(/Retry/.test(down.status), `no Retry offered: ${down.status}`);
  world.all('ok'); world.reset();
  await page.click('[data-action="retry-failed"]');
  const up = await settle(page);
  assert(up.failed === 0 && up.finds.length > 0, `retry did not recover: ${up.status}`);
  assert(world.overpassCalls().length === down.chunks, `retry made ${world.overpassCalls().length} calls for ${down.chunks} sections`);
  await ctx.close();
});

test('drive it: Google Maps links navigate, keep route order, split at 9 waypoints', async () => {
  const world = makeWorld();
  const { page, ctx } = await openPage(world, { search: TROY });
  await settle(page);
  const r = await page.evaluate(() => {
    const B = window.__byway, S = B.state;
    const byAlong = S.finds.slice().sort((a, b) => a.along - b.along);
    S.picks.clear(); byAlong.slice(0, 3).forEach(f => S.picks.add(f.id));
    const three = B.navParts().map(p => p.url);
    byAlong.slice(0, 12).forEach(f => S.picks.add(f.id));
    const twelve = B.navParts().map(p => p.url);
    const expect3 = byAlong.slice(0, 3).map(f => `${f.lat.toFixed(5)},${f.lon.toFixed(5)}`);
    return { three, twelve, expect3 };
  });
  const p3 = new URL(r.three[0]).searchParams;
  assert(r.three.length === 1 && p3.get('dir_action') === 'navigate', 'single-part link missing navigate mode');
  assert(!p3.has('origin'), '"Start from my location" is on by default, so origin should be omitted');
  assert(p3.get('waypoints') === r.expect3.join('|'), `waypoints out of route order: ${p3.get('waypoints')}`);
  assert(r.twelve.length === 2, `12 picks should split into 2 links, got ${r.twelve.length}`);
  for (const u of r.twelve) assert((new URL(u).searchParams.get('waypoints') || '').split('|').length <= 9, 'more than 9 waypoints in one link');
  await ctx.close();
});

test('to phone: QR code decodes to the exact link (needs python3 + OpenCV; skipped otherwise)', async () => {
  const probe = spawnSync('python3', ['-c', 'import cv2, numpy'], { encoding: 'utf8' });
  if (probe.status !== 0) return 'skipped';
  const world = makeWorld();
  const { page, ctx } = await openPage(world);
  const url = 'https://www.google.com/maps/dir/?api=1&travelmode=driving&dir_action=navigate&destination=44.27950%2C-73.97990&waypoints=43.41890%2C-73.71080%7C44.25600%2C-73.97100';
  const q = await page.evaluate(u => { const r = window.__byway.QR.encode(u); return { size: r.size, mod: r.mod.map(row => row.map(Boolean)) }; }, url);
  await ctx.close();
  const py = `
import sys, json, numpy as np, cv2
q = json.load(sys.stdin); n = q['size']; s = 8; quiet = 4
img = np.full(((n + 2*quiet)*s, (n + 2*quiet)*s), 255, np.uint8)
for y, row in enumerate(q['mod']):
    for x, v in enumerate(row):
        if v: img[(y+quiet)*s:(y+quiet+1)*s, (x+quiet)*s:(x+quiet+1)*s] = 0
txt, pts, _ = cv2.QRCodeDetector().detectAndDecode(img)
print(txt)`;
  const out = spawnSync('python3', ['-c', py], { input: JSON.stringify(q), encoding: 'utf8' });
  assert(out.status === 0, `decoder crashed: ${out.stderr}`);
  assert(out.stdout.trim() === url, `QR decoded to "${out.stdout.trim()}"`);
});

test('shortlist size: about 10 per day of driving, capped at 60', async () => {
  const world = makeWorld();
  const { page, ctx } = await openPage(world);
  const sz = await page.evaluate(() => [50, 134, 400, 600, 800, 2450, 5000].map(window.__byway.shortlistSize));
  assert(JSON.stringify(sz) === JSON.stringify([10, 10, 10, 15, 20, 60, 60]), `sizes for 50/134/400/600/800/2450/5000 mi: ${sz}`);
  await ctx.close();
});

test('find cap: at most 100, spread along the road, weak finds last', async () => {
  const world = makeWorld();
  const { page, ctx } = await openPage(world);
  const r = await page.evaluate(() => {
    let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const list = [];
    for (let i = 0; i < 300; i++) list.push({ id: 'c' + i, along: rnd() * 20, score: 1 + rnd() * 5 });          // dense city, miles 0–20
    for (let i = 0; i < 80; i++) list.push({ id: 'r' + i, along: 20 + rnd() * 380, score: 0.6 + rnd() * 2 });  // sparse countryside
    for (let i = 0; i < 40; i++) list.push({ id: 'w' + i, along: rnd() * 400, score: -1 + rnd() * 1.4 });      // weak / junk
    const best = list.reduce((a, b) => (b.score > a.score ? b : a));
    const out = window.__byway.spreadCap(list, 100, 400);
    return { n: out.length, city: out.filter(f => f.along < 20).length, weak: out.filter(f => f.score < 0.5).length,
             hasBest: out.some(f => f.id === best.id), uniq: new Set(out.map(f => f.id)).size,
             small: window.__byway.spreadCap(list.slice(0, 50), 100, 400).length };
  });
  assert(r.n === 100 && r.uniq === 100, `cap returned ${r.n} (${r.uniq} unique)`);
  assert(r.city <= 30, `dense first 20 mi took ${r.city} of 100 slots`);
  assert(r.weak === 0, `weak finds used ${r.weak} slots while good ones were left out`);
  assert(r.hasBest, 'the single best find was dropped');
  assert(r.small === 50, 'a list under the cap should be returned whole');
  await ctx.close();
});

test('find cap in the app: dense corridor shows best 100 of all, chips count everything', async () => {
  const world = makeWorld();
  // 260 extra museums clustered around Saratoga Springs (route mile ~30), plus the regular fixture.
  world.extra = Array.from({ length: 260 }, (_, i) => ({ type: 'node', id: 10000 + i, lat: 43.07 + (i % 20) * 0.002, lon: -73.79 + Math.floor(i / 20) * 0.002, tags: { name: `Test Museum ${i}`, tourism: 'museum', ...(i % 3 ? {} : { website: 'https://example.org' }) } }));
  const { page, ctx } = await openPage(world, { search: TROY });
  await settle(page);
  const r = await page.evaluate(() => {
    const S = window.__byway.state;
    document.querySelector('[data-action="view"][data-view="all"]').click();
    return { total: S.finds.length, visible: S.visible.length, cards: document.querySelectorAll('#list .card').length,
             hint: document.querySelector('#hint').textContent, allChip: document.querySelector('[data-action="lens"][data-lens="all"] .n').textContent,
             fort: S.visible.some(f => f.name === 'Fort William Henry'), jb: S.visible.some(f => f.name === 'John Brown Farm State Historic Site'),
             stat: document.querySelector('#summary .stats').textContent };
  });
  assert(r.total > 250 && r.visible === 100 && r.cards === 100, `total ${r.total}, visible ${r.visible}, cards ${r.cards}`);
  assert(/best 100 of \d+/.test(r.hint), `hint: ${r.hint}`);
  assert(+r.allChip.replace(/,/g, '') === r.total, `"All" chip shows ${r.allChip}, expected the full ${r.total}`);
  assert(r.fort && r.jb, 'cap squeezed out finds elsewhere on the route because of one dense city');
  assert(r.stat.includes(r.total.toLocaleString()), 'summary stat should report the full count');
  // Category filter applies before the cap: History should still show its few finds, not be emptied by museums.
  const hist = await page.evaluate(() => { document.querySelector('[data-action="lens"][data-lens="history"]').click(); return window.__byway.state.visible.map(f => f.name); });
  assert(hist.includes('Fort William Henry') && hist.includes('Hackensack Covered Bridge'), `History view: ${hist}`);
  await ctx.close();
});

test('picks: the 10th star warns that the drive splits into two Google Maps links', async () => {
  const world = makeWorld();
  const { page, ctx } = await openPage(world, { search: TROY });
  await settle(page);
  await page.click('[data-action="view"][data-view="all"]');
  const toasts = [];
  for (let i = 0; i < 10; i++) {
    await page.locator('#list .card .star[aria-pressed="false"]').first().click();
    const t = await page.evaluate(() => { const el = document.querySelector('#toast'); return el.classList.contains('show') ? el.textContent : ''; });
    toasts.push(t);
    await page.evaluate(() => document.querySelector('#toast').classList.remove('show'));
  }
  assert(toasts.slice(0, 9).every(t => !/parts/.test(t)), `warned too early: ${JSON.stringify(toasts.slice(0, 9))}`);
  assert(/opens in 2 parts/.test(toasts[9]), `no heads-up on the 10th pick: "${toasts[9]}"`);
  const picks = await page.evaluate(() => window.__byway.state.picks.size);
  assert(picks === 10, `soft limit should still allow the 10th pick (have ${picks})`);
  await ctx.close();
});

test('scan log (?debug=1): every step and section logged, panel shown, debug kept in URL', async () => {
  const world = makeWorld();
  world.set('overpass-api.de', 429);
  const { page, ctx } = await openPage(world, { search: TROY + '&debug=1' });
  const r = await settle(page);
  const d = await page.evaluate(() => ({ log: window.__byway.scanLog.entries, json: JSON.parse(window.__byway.scanLogJSON()),
    shown: !document.querySelector('#dbg').hidden, rows: document.querySelectorAll('#dbg tbody tr').length, url: location.search }));
  const kinds = d.log.map(e => e.kind);
  for (const k of ['start', 'geocode', 'route', 'sections', 'done']) assert(kinds.includes(k), `log missing "${k}": ${kinds}`);
  const ok = d.log.filter(e => e.kind === 'section' && e.outcome === 'ok');
  assert(ok.length === r.chunks, `${ok.length} ok section entries for ${r.chunks} sections`);
  assert(ok.every(e => e.host && e.s >= 0 && e.els >= 0 && e.sec >= 1 && e.of === r.chunks), `incomplete section entry: ${JSON.stringify(ok[0])}`);
  const fail = d.log.find(e => e.outcome === 'fail');
  assert(fail && fail.host === 'overpass-api.de' && /rate-limited/.test(fail.why), `429 not logged: ${JSON.stringify(fail)}`);
  assert(d.json.route && d.json.route.sections === r.chunks && d.json.hosts['overpass-api.de'] === 'rate-limited', 'Copy log JSON incomplete');
  assert(d.shown && d.rows === d.log.length, `panel shown ${d.shown}, rows ${d.rows} vs ${d.log.length} entries`);
  assert(/debug=1/.test(d.url), `debug flag dropped from URL: ${d.url}`);
  // Reload: every section should now come from the answer cache and be logged that way.
  await page.reload();
  await settle(page);
  const cached = await page.evaluate(() => window.__byway.scanLog.entries.filter(e => e.kind === 'section').map(e => e.outcome));
  assert(cached.length === r.chunks && cached.every(o => o === 'cache'), `after reload: ${cached}`);
  await ctx.close();
});

test('scan log: hidden without ?debug=1', async () => {
  const world = makeWorld();
  const { page, ctx } = await openPage(world, { search: TROY });
  await settle(page);
  const d = await page.evaluate(() => ({ hidden: document.querySelector('#dbg').hidden, n: window.__byway.scanLog.entries.length, url: location.search }));
  assert(d.hidden && !/debug/.test(d.url), 'debug panel or flag leaked into a normal run');
  assert(d.n > 0, 'log should still be collected for the console');
  await ctx.close();
});

test('fixture export: captures the route and every place Overpass returned', async () => {
  const world = makeWorld();
  const { page, ctx } = await openPage(world, { search: TROY + '&debug=1' });
  await settle(page);
  const fx = await page.evaluate(() => window.__byway.exportFixture());
  const expected = new Set(world.overpassCalls().length ? FIX_IDS_IN_CORRIDOR : []);
  assert(fx && fx.waypoints.length > 10 && Object.keys(fx.geocode).length === 2, 'fixture missing route or stops');
  const ids = new Set(fx.elements.map(e => e.id));
  for (const id of expected) assert(ids.has(id), `fixture missing element ${id}`);
  assert(!ids.has(26), 'fixture includes a place outside the corridor');
  assert(fx.elements.every(e => e.tags && (e.lat != null || e.center)), 'fixture elements lost coordinates or tags');
  assert(Array.isArray(fx.wiki) && fx.wiki.some(e => e.tags.name === 'Canfield Casino and Congress Park'), 'fixture missing Wikipedia results');
  await ctx.close();
  // Replay it: the captured fixture must drive a full offline run (debug dump) on its own.
  if (process.env.BYWAY_FIXTURE) return; // no recursion
  const tmp = path.join(fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'byway-')), 'captured.json');
  fs.writeFileSync(tmp, JSON.stringify(fx));
  const out = spawnSync(process.execPath, [fileURLToPath(import.meta.url), 'debug dump'], { env: { ...process.env, BYWAY_FIXTURE: tmp, BYWAY_DEBUG: '1' }, encoding: 'utf8', timeout: 120000 });
  assert(out.status === 0 && /Fort William Henry/.test(out.stdout) && /1 passed, 0 failed/.test(out.stdout), `replay of captured fixture failed:\n${out.stdout}\n${out.stderr}`);
});

test('wikipedia: lookup points cover the whole corridor at 1, 5 and 15 mi', async () => {
  const world = makeWorld();
  const { page, ctx } = await openPage(world, { search: TROY });
  await settle(page);
  const r = await page.evaluate(() => {
    const B = window.__byway, route = B.state.route, MIPD = 69.093;
    const out = {};
    for (const R of [1, 5, 15]) {
      const pts = B.wikiPoints(route, R), cum = B.cumulative(route.pts);
      let worst = 0;
      for (let i = 1; i < route.pts.length; i += 3) {
        const a = route.pts[i - 1], b = route.pts[i], kx = Math.cos(a[0] * Math.PI / 180) * MIPD;
        const dx = (b[1] - a[1]) * kx, dy = (b[0] - a[0]) * MIPD, len = Math.hypot(dx, dy) || 1;
        for (const off of [-R, 0, R]) {
          const lat = a[0] + (dx / len) * off / MIPD, lon = a[1] - (dy / len) * off / kx;
          let near = Infinity;
          for (const p of pts) near = Math.min(near, Math.hypot((p.lat - lat) * MIPD, (p.lon - lon) * kx));
          worst = Math.max(worst, near);
        }
      }
      out[R] = { n: pts.length, worst: +worst.toFixed(2), mi: Math.round(cum[cum.length - 1]) };
    }
    return out;
  });
  for (const R of [1, 5, 15]) assert(r[R].worst <= 6.2, `corridor ${R} mi: a point is ${r[R].worst} mi from the nearest lookup (limit 6.2) — ${JSON.stringify(r[R])}`);
  // The fixture route is straight lines with sharp corners, which costs extra lookups; real roads curve gently.
  assert(r[5].n <= Math.ceil(0.3 * r[5].mi), `too many lookups for a ${r[5].mi} mi drive at 5 mi: ${r[5].n}`);
  assert(r[1].n < r[5].n && r[5].n < r[15].n, `lookup counts should grow with the corridor: ${r[1].n}, ${r[5].n}, ${r[15].n}`);
  await ctx.close();
});

test('wikipedia: articles are filtered to real stops and typed sensibly', async () => {
  const world = makeWorld();
  const { page, ctx } = await openPage(world);
  const r = await page.evaluate(() => {
    const t = (name, wpdesc) => { const m = window.__byway.wikiTags({ name, wpdesc, wikipedia: 'en:' + name }); return m ? window.__byway.classify(m.tags, name).cat : null; };
    return {
      museum: t('Lake Placid Winter Olympic Museum', 'Museum in Lake Placid, New York'),
      fort: t('Fort William Henry', 'Fort in Lake George, New York'),
      site: t('John Brown Farm State Historic Site', 'State historic site in New York, United States'),
      falls: t('Hulls Falls', 'Waterfall in Keene, New York'),
      mountain: t('Cascade Mountain (New York)', 'Mountain in Essex County, New York'),
      race: t('Saratoga Race Course', 'Thoroughbred horse racing venue in Saratoga Springs, New York'),
      nodescMuseum: t('Adirondack Experience Museum', ''),
      nodescOther: t('Natural Stone Bridge and Caves', ''),
      postOffice: t('United States Post Office (Saratoga Springs, New York)', 'Post office building in Saratoga Springs, New York'),
      school: t('Saratoga Springs High School', 'Public high school in Saratoga Springs, New York'),
      battle: t('Battle of Lake George', '1755 battle of the French and Indian War'),
      city: t('Saratoga Springs, New York', 'City in New York, United States'),
      station: t('Lake George station', 'Former railroad station in Lake George, New York'),
      games: t('1932 Winter Olympics', 'Multi-sport event in Lake Placid, New York'),
      hotel: t('Grand Union Hotel', 'Demolished hotel in Saratoga Springs, New York'),
      hamlet: t('Museum Village (New York)', 'Hamlet in Warren County, New York'),
      // cases seen in a live Troy → Lake Placid run
      grant: t('Grant Cottage State Historic Site', 'United States historic place'),
      nhs: t('Kate Mullany House', 'National Historic Site of the United States'),
      generic: t('Jonesville Cemetery', 'Historic site in Saratoga County, New York'),
      genericPO: t('United States Post Office', 'United States historic place'),
      abandoned: t('Heritage Park', 'Abandoned sport stadium in Colonie, New York'),
      river: t('Poesten Kill', 'River in New York, United States'),
      giant: t('Giant Mountain Wilderness Area', 'Wilderness area in New York, United States'),
      home: t('A. S. Rugge House', 'Historic home in Glens Falls, New York, US'),
      hof: t('New York State Baseball Hall of Fame', ''),
      monument: t('Soldiers and Sailors Monument', ''),
      casino: t('Canfield Casino and Congress Park', 'Historic casino and park in Saratoga Springs, New York'),
      grange: t('Mohawk Valley Grange Hall', 'United States historic place'),
    };
  });
  const want = { museum: 'museum', fort: 'history', site: 'history', falls: 'nature', mountain: 'nature', race: 'attraction', nodescMuseum: 'museum',
    nodescOther: null, postOffice: null, school: null, battle: null, city: null, station: null, games: null, hotel: null, hamlet: null,
    grant: 'history', nhs: 'history', generic: 'history', genericPO: null, abandoned: null, river: null, giant: 'nature', home: 'history', hof: 'museum', monument: 'art', casino: 'attraction', grange: 'history' };
  for (const [k, v] of Object.entries(want)) assert(r[k] === v, `${k}: got ${r[k]}, want ${v}`);
  const b = await page.evaluate(() => { const s = (n, d) => { const m = window.__byway.wikiTags({ name: n, wpdesc: d, wikipedia: 'en:' + n }); return window.__byway.classify(m.tags, n).base + (m.adj || 0); };
    return { cemetery: s('Jonesville Cemetery', 'Historic site in Saratoga County, New York'), grant: s('Grant Cottage State Historic Site', 'United States historic place'), stadium: s('Joseph L. Bruno Stadium', 'Baseball stadium in Troy, New York'), stateFort: s('Fort William Henry', 'Fort in Lake George, New York') }; });
  assert(b.cemetery < 2.5 && b.stadium < 3 && b.grant > 5 && b.stateFort > 5, `scores off: ${JSON.stringify(b)}`);
  await ctx.close();
});

test('wikipedia + OpenStreetMap: merged without duplicates, junk dropped, names cleaned', async () => {
  const world = makeWorld();
  const { page, ctx } = await openPage(world, { search: TROY });
  const r = await settle(page);
  const n = names(r.finds), by = Object.fromEntries(r.finds.map(f => [f.name, f]));
  assert(world.wikiCalls().length === r.wikiPoints, `${world.wikiCalls().length} Wikipedia lookups for ${r.wikiPoints} points`);
  for (const want of ['Canfield Casino and Congress Park', 'Saratoga Race Course', 'Cascade Mountain', 'Lake Placid Olympic Ski Jumping Complex'])
    assert(n.includes(want), `missing Wikipedia find: ${want}`);
  for (const junk of ['United States Post Office', 'Saratoga Springs High School', 'Battle of Lake George', 'Saratoga Springs, New York', 'Lake George station', '1932 Winter Olympics', 'Grand Union Hotel', 'Museum Village', 'Far Away Lighthouse'])
    assert(!n.some(x => x.startsWith(junk)), `junk from Wikipedia kept: ${junk}`);
  assert(n.filter(x => x === 'Fort William Henry').length === 1 && by['Fort William Henry'].src === 'osm', 'Fort William Henry should appear once, from OpenStreetMap');
  assert(!n.includes('Lake Placid Winter Olympic Museum') && n.includes('Lake Placid Olympic Museum'), 'same Wikidata ID should merge into the OpenStreetMap entry');
  assert(n.filter(x => x === 'Hulls Falls').length === 1, 'Hulls Falls duplicated across sources');
  assert(by['Canfield Casino and Congress Park'].src === 'wikipedia' && by['Canfield Casino and Congress Park'].cat === 'attraction', `Canfield Casino: ${JSON.stringify(by['Canfield Casino and Congress Park'])}`);
  await ctx.close();
});

test('overpass down: Wikipedia finds still show, message is clear, Retry adds OSM and keeps stars', async () => {
  const world = makeWorld();
  world.all(504);
  const { page, ctx } = await openPage(world);
  await scanWithFastTimers(page);
  const down = await settle(page);
  assert(down.finds.length >= 7, `only ${down.finds.length} finds with Overpass down`);
  assert(down.finds.every(f => f.src === 'wikipedia'), 'non-Wikipedia finds while Overpass was down');
  assert(/Found \d+ spots/.test(down.status) && /smaller spots/.test(down.status) && /whole route/.test(down.status) && /Retry/.test(down.status), `status: ${down.status}`);
  const fwh = down.finds.find(f => f.name === 'Fort William Henry');
  assert(fwh, 'Fort William Henry should come from Wikipedia while Overpass is down');
  await page.evaluate(id => { window.__byway.state.picks.add(id); }, fwh.id);
  world.all('ok');
  await page.click('[data-action="retry-failed"]');
  const up = await settle(page);
  assert(up.failed === 0 && /^✓?\s*Found/.test(up.status), `after retry: ${up.status}`);
  const merged = up.finds.filter(f => f.name === 'Fort William Henry');
  assert(merged.length === 1 && merged[0].src === 'osm', 'Fort William Henry not merged into the OpenStreetMap entry after retry');
  const starred = await page.evaluate(id => window.__byway.state.picks.has(id), merged[0].id);
  assert(starred, 'star on the Wikipedia copy was lost when OpenStreetMap replaced it');
  assert(up.finds.some(f => f.name === "World's Largest Garden Gnome"), 'OpenStreetMap-only finds missing after retry');
  await ctx.close();
});

test('wikipedia down: OpenStreetMap carries the scan; Retry re-asks Wikipedia only', async () => {
  const world = makeWorld();
  world.wiki = 'fail';
  const { page, ctx } = await openPage(world, { search: TROY });
  const r = await settle(page);
  assert(r.finds.length > 0 && r.finds.every(f => f.src === 'osm'), 'expected OpenStreetMap finds only');
  assert(/Wikipedia lookups? didn’t answer/.test(r.status), `status: ${r.status}`);
  world.wiki = 'ok'; world.reset();
  await page.click('[data-action="retry-failed"]');
  const up = await settle(page);
  assert(world.overpassCalls().length === 0, 'retry re-asked Overpass for sections that had succeeded');
  assert(up.finds.some(f => f.name === 'Canfield Casino and Congress Park'), 'Wikipedia finds missing after retry');
  await ctx.close();
});

test('overpass: an empty answer at the time limit is a failure and is not saved', async () => {
  const world = makeWorld();
  world.set('overpass-api.de', 'slowEmpty');
  const { page, ctx } = await openPage(world);
  await scanWithFastTimers(page);
  const r = await settle(page, 60000);
  assert(r.failed === 0, `scan should recover on another mirror: ${r.status}`);
  const d = await page.evaluate(() => ({ log: window.__byway.scanLog.entries.filter(e => e.outcome === 'fail'), why: (window.__byway.hostState.get('https://overpass-api.de/api/interpreter') || {}).why }));
  assert(d.log.some(e => e.host === 'overpass-api.de' && /empty answer at the time limit/.test(e.why)), `not logged as a failure: ${JSON.stringify(d.log)}`);
  assert(r.finds.some(f => f.src === 'osm'), 'OpenStreetMap finds missing — the empty answer may have been accepted');
  await ctx.close();
});

// Wait until the Wikipedia pass is done and only the OpenStreetMap pass is left running.
const untilBackground = page => page.waitForFunction(() => { const S = window.__byway.state; return S.bg && !S.busy; }, null, { timeout: 30000 });

test('background: search unlocks once Wikipedia results are in, while OpenStreetMap keeps checking', async () => {
  const world = makeWorld();
  world.all('slowEmpty'); world.slowMs = 2600;
  const { page, ctx } = await openPage(world);
  await scanWithFastTimers(page);
  await untilBackground(page);
  const mid = await page.evaluate(() => ({ disabled: document.querySelector('#go').disabled, label: document.querySelector('#go').textContent,
    status: document.querySelector('#status').textContent, finds: window.__byway.state.finds.length, stop: !!document.querySelector('#status [data-action="cancel"]') }));
  assert(!mid.disabled && mid.label === 'Find fun stops', `search still locked: ${JSON.stringify(mid)}`);
  assert(/checking OpenStreetMap/.test(mid.status) && mid.stop, `background progress or its Stop button missing: ${mid.status}`);
  assert(mid.finds >= 7, `Wikipedia finds not on screen yet (${mid.finds})`);
  const end = await settle(page, 90000);
  assert(/smaller spots/.test(end.status) && end.failed > 0, `end status: ${end.status}`);
  await ctx.close();
});

test('background: starting a new search cancels the OpenStreetMap pass cleanly', async () => {
  const world = makeWorld();
  world.all('slowEmpty'); world.slowMs = 2600;
  const { page, ctx } = await openPage(world);
  await scanWithFastTimers(page);
  await untilBackground(page);
  world.all('ok');
  await page.click('#go');
  const r = await settle(page, 60000);
  assert(r.failed === 0 && /^✓?\s*Found/.test(r.status), `new search didn't finish cleanly: ${r.status}`);
  assert(r.finds.some(f => f.src === 'osm'), 'new search has no OpenStreetMap finds');
  await page.waitForTimeout(3500); // let the old run's slow answers arrive; they must be ignored
  const after = await page.evaluate(() => ({ failed: window.__byway.state.failed.length, status: document.querySelector('#status').textContent, bg: window.__byway.state.bg }));
  assert(after.failed === 0 && !after.bg && /Found/.test(after.status), `old run leaked into the new one: ${JSON.stringify(after)}`);
  await ctx.close();
});

test('background: narrowing the corridor re-filters without hiding OpenStreetMap progress', async () => {
  const world = makeWorld();
  world.all('slowEmpty'); world.slowMs = 2600;
  const { page, ctx } = await openPage(world);
  await scanWithFastTimers(page);
  await untilBackground(page);
  const before = await page.evaluate(() => window.__byway.state.finds.length);
  await page.evaluate(() => { const r = document.querySelector('#radius'); r.value = '2'; r.dispatchEvent(new Event('input', { bubbles: true })); });
  const d = await page.evaluate(() => ({ n: window.__byway.state.finds.length, status: document.querySelector('#status').textContent, bg: window.__byway.state.bg }));
  assert(d.n < before && d.bg && /checking OpenStreetMap/.test(d.status), `narrowing during background: ${JSON.stringify({ before, ...d })}`);
  await ctx.close();
});

test('places: stops are looked up at the same time and remembered for next time', async () => {
  const world = makeWorld();
  world.photonDelay = 1500;
  const { page, ctx } = await openPage(world, { search: TROY });
  await settle(page);
  const first = await page.evaluate(() => window.__byway.scanLog.entries.find(e => e.kind === 'geocode'));
  const photonFirst = world.requests.filter(r => r.kind === 'photon').length;
  assert(photonFirst === 2, `expected 2 place lookups, got ${photonFirst}`);
  assert(first.s < 2.6, `two 1.5 s lookups took ${first.s}s — not run at the same time`);
  world.reset();
  await page.reload();
  await settle(page);
  const second = await page.evaluate(() => window.__byway.scanLog.entries.find(e => e.kind === 'geocode'));
  assert(world.requests.filter(r => r.kind === 'photon').length === 0, 'remembered places were looked up again');
  assert(second.remembered === 2 && second.s < 0.5, `second run geocode: ${JSON.stringify(second)}`);
  const recalled = await page.evaluate(() => window.__byway.recallPlace('  troy,   ny '));
  assert(recalled && Math.abs(recalled.lat - 42.7284) < 1e-4, 'lookup key should ignore case and spacing');
  await ctx.close();
});

const OSM_RULES_SRC = JSON.parse(/\/\*OSM_RULES\*\/(.*?)\/\*END_OSM_RULES\*\//s.exec(HTML)[1]);
const ruleMatch = e => OSM_RULES_SRC.some(r => (r.t !== 'way' || e.type === 'way') && r.v.includes(e.tags[r.k]) && r.need.every(k => k in e.tags));

test('places index builder: keeps exactly the rule matches, one point each, with coverage', async () => {
  const idx = testIndex(); if (!idx) return 'skipped';
  const m = JSON.parse(fs.readFileSync(path.join(idx.dir, 'index.json'), 'utf8'));
  const want = FIX.elements.filter(ruleMatch);
  assert(m.places === want.length, `index has ${m.places} places, rules match ${want.length}`);
  const got = [];
  for (const k of Object.keys(m.cells)) for (const [t, id, lat, lon, tags] of JSON.parse(fs.readFileSync(path.join(idx.dir, 'c', k + '.json'), 'utf8')).els) {
    assert(`${Math.floor(lat / m.grid)}_${Math.floor(lon / m.grid)}` === k, `place ${id} filed in the wrong cell ${k}`);
    got.push(id);
    assert(tags.name && !('nysgissam:nysaddresspointid' in tags), `tags not trimmed for ${id}`);
  }
  assert(JSON.stringify(got.sort((a, b) => a - b)) === JSON.stringify(want.map(e => e.id).sort((a, b) => a - b)), `place ids differ: ${got}`);
  assert(!got.includes(25) && !got.includes(17), 'unnamed place or a protected area without a Wikipedia link slipped in');
  assert(m.covered.length > 0 && m.covered.every(k => { const [y, x] = k.split('_').map(Number); return y * m.grid >= 42.5 && (y + 1) * m.grid <= 44.0 && x * m.grid >= -74.5 && (x + 1) * m.grid <= -73.0; }), 'a covered cell lies outside the coverage area');
});

test('places index builder: several extracts — covered area is their union', async () => {
  if (!testIndex()) return 'skipped';
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'byway-union-'));
  const seq = path.join(dir, 'f.geojsonseq'), a = path.join(dir, 'south.poly'), b = path.join(dir, 'north.poly'), out = path.join(dir, 'out');
  fs.writeFileSync(seq, JSON.stringify({ type: 'Feature', geometry: { type: 'Point', coordinates: [-73.7, 43.0] }, properties: { '@type': 'node', '@id': 1, name: 'X', tourism: 'museum' } }) + '\n');
  // The same test area as TEST_POLY, split at 43.25° into two neighbouring extracts.
  fs.writeFileSync(a, 'south\n1\n -74.5 42.5\n -73.0 42.5\n -73.0 43.25\n -74.5 43.25\n -74.5 42.5\nEND\nEND\n');
  fs.writeFileSync(b, 'north\n1\n -74.5 43.25\n -73.0 43.25\n -73.0 44.0\n -74.5 44.0\n -74.5 43.25\nEND\nEND\n');
  const r = spawnSync('python3', [path.join(ROOT, 'tools', 'build_places.py'), '--geojsonseq', seq, '--poly', a, b, '--out', out, '--rules-from', path.join(ROOT, 'index.html')], { encoding: 'utf8' });
  assert(r.status === 0, r.stderr);
  const split = JSON.parse(fs.readFileSync(path.join(out, 'index.json'), 'utf8')).covered;
  const whole = JSON.parse(fs.readFileSync(path.join(testIndex().dir, 'index.json'), 'utf8')).covered;
  assert(JSON.stringify(split) === JSON.stringify(whole), `union of two extracts covers ${split.length} cells, one combined extract ${whole.length}`);
});

test('places index: covered stretches skip Overpass; the rest still use it', async () => {
  if (!testIndex()) return 'skipped';
  const world = makeWorld(); world.index = 'ok';
  const { page, ctx } = await openPage(world, { search: TROY + '&debug=1' });
  const r = await settle(page);
  const d = await page.evaluate(() => {
    const L = window.__byway.scanLog.entries;
    return { idx: L.filter(e => e.outcome === 'index').length, info: L.find(e => e.kind === 'places-index'), fails: L.filter(e => e.outcome === 'fail') };
  });
  const op = world.overpassCalls().length;
  assert(d.info && d.info.region === 'us-northeast', `manifest not loaded: ${JSON.stringify(d.info)}`);
  assert(d.idx >= 1 && op >= 1 && d.idx + op === r.chunks, `index sections ${d.idx} + Overpass ${op} ≠ ${r.chunks} sections`);
  assert(!d.fails.length, `failures: ${JSON.stringify(d.fails)}`);
  const n = names(r.finds);
  for (const want of ['Fort William Henry', 'The Hyde Collection', 'Hackensack Covered Bridge', "World's Largest Garden Gnome", 'Lake Placid Olympic Museum'])
    assert(n.includes(want), `missing ${want} (index + Overpass should together cover the route)`);
  assert(r.failed === 0 && /Found/.test(r.status), r.status);
  await ctx.close();
});

test('places index: CDN down → GitHub copy; index down → Overpass for everything', async () => {
  if (!testIndex()) return 'skipped';
  const w1 = makeWorld(); w1.index = 'cdnfail';
  const a = await openPage(w1, { search: TROY + '&debug=1' });
  await settle(a.page);
  const used = await a.page.evaluate(() => window.__byway.scanLog.entries.filter(e => e.outcome === 'index').length);
  assert(used >= 1 && w1.requests.some(q => q.kind === 'index' && q.host === 'raw.githubusercontent.com'), 'GitHub fallback for the index not used');
  await a.ctx.close();
  const w2 = makeWorld(); w2.index = 'fail';
  const b = await openPage(w2, { search: TROY });
  const r = await settle(b.page);
  assert(w2.overpassCalls().length === r.chunks && r.failed === 0 && r.finds.some(f => f.name === 'Fort William Henry'), 'without the index every section should use Overpass');
  await b.ctx.close();
});

test('places index: cells are saved, so a reload downloads none', async () => {
  if (!testIndex()) return 'skipped';
  const world = makeWorld(); world.index = 'ok';
  const { page, ctx } = await openPage(world, { search: TROY });
  await settle(page);
  const cellsFirst = world.requests.filter(q => q.kind === 'index' && q.rel.startsWith('c/')).length;
  world.reset();
  await page.reload();
  await settle(page);
  const again = world.requests.filter(q => q.kind === 'index').length;
  assert(cellsFirst >= 1 && again === 0, `first run fetched ${cellsFirst} cells; reload fetched ${again} index files`);
  const fx = await page.evaluate(() => window.__byway.exportFixture());
  assert(fx.elements.some(e => e.tags.name === 'The Hyde Collection'), 'fixture export misses places that came from the index');
  await ctx.close();
});

test('oddity guides: towns along the drive with Atlas Obscura and Roadside America links', async () => {
  const world = makeWorld();
  const { page, ctx } = await openPage(world, { search: TROY });
  await settle(page);
  assert(world.requests.filter(q => q.kind === 'reverse').length === 0, 'towns looked up before the guides were opened');
  await page.evaluate(() => { document.querySelector('#guides').open = true; });
  await page.waitForFunction(() => document.querySelectorAll('#guides li').length > 0, null, { timeout: 10000 });
  const g = await page.evaluate(() => [...document.querySelectorAll('#guides li')].map(li => ({ town: li.querySelector('b').textContent, links: [...li.querySelectorAll('a')].map(a => a.href) })));
  const towns = g.map(x => x.town);
  assert(towns[0] === 'Troy, NY' && towns[towns.length - 1] === 'Lake Placid, NY', `towns: ${towns}`);
  assert(new Set(towns).size === towns.length && towns.length >= 3, `towns should be distinct and several: ${towns}`);
  for (const x of g) {
    const ao = new URL(x.links.find(h => h.includes('atlasobscura.com')));
    const ra = new URL(x.links.find(h => h.includes('roadsideamerica.com')));
    assert(ao.pathname === '/search' && ao.searchParams.get('lat') && ao.searchParams.get('lng'), `Atlas Obscura link: ${ao}`);
    assert(ra.pathname === '/search/map' && `${ra.searchParams.get('city')}, ${ra.searchParams.get('state')}` === x.town, `Roadside America link: ${ra}`);
  }
  const reverse = world.requests.filter(q => q.kind === 'reverse').length;
  assert(reverse <= 6, `${reverse} town lookups for a ~136 mi drive`);
  world.reset();
  await page.reload(); await settle(page);
  await page.evaluate(() => { document.querySelector('#guides').open = true; });
  await page.waitForFunction(() => document.querySelectorAll('#guides li').length > 0, null, { timeout: 10000 });
  assert(world.requests.filter(q => q.kind === 'reverse').length === 0, 'towns were looked up again after a reload');
  await ctx.close();
});

test('oddity guides: an opened find links to Atlas Obscura at its spot and Roadside America for its town', async () => {
  const world = makeWorld();
  const { page, ctx } = await openPage(world, { search: TROY });
  await settle(page);
  const target = await page.evaluate(() => { const f = window.__byway.state.shortlist.find(x => x.name === 'Fort William Henry'); return f && { id: f.id, lat: f.lat, lon: f.lon }; });
  assert(target, 'Fort William Henry not on the shortlist');
  await page.click(`#list .card[data-id="${target.id}"] h3`);
  await page.waitForFunction(id => !!document.querySelector(`#list .card[data-id="${id}"] .details a[href*="roadsideamerica.com"]`), target.id, { timeout: 10000 });
  const links = await page.evaluate(id => [...document.querySelectorAll(`#list .card[data-id="${id}"] .details a`)].map(a => a.href), target.id);
  const ao = new URL(links.find(h => h.includes('atlasobscura.com')));
  const ra = new URL(links.find(h => h.includes('roadsideamerica.com')));
  assert(Math.abs(+ao.searchParams.get('lat') - target.lat) < 1e-3 && Math.abs(+ao.searchParams.get('lng') - target.lon) < 1e-3, `Atlas Obscura link not at the find: ${ao}`);
  assert(ra.searchParams.get('city') === 'Lake George' && ra.searchParams.get('state') === 'NY', `Roadside America link: ${ra}`);
  await ctx.close();
});

// BYWAY_DEBUG=1 node tests/run.mjs debug  → prints every find with score and shortlist mark, for tuning.
if (process.env.BYWAY_DEBUG) test('debug dump', async () => {
  const world = makeWorld();
  const { page, ctx } = await openPage(world, { search: TROY });
  await settle(page);
  const d = await page.evaluate(() => { const S = window.__byway.state; const sl = new Set(S.shortlist.map(f=>f.id));
    return { mi: S.route.distanceMi, target: S.shortlist.length, rows: S.finds.slice().sort((a,b)=>a.along-b.along).map(f => [f.along.toFixed(0), f.off.toFixed(1), f.cat, f.score.toFixed(2), sl.has(f.id)?'*':' ', f.name].join(' ')) }; });
  console.log(JSON.stringify(d, null, 1)); await ctx.close();
});
/* ---------- run ---------- */
const only = process.argv[2];
browser = await chromium.launch();
console.log(`Leaflet: ${REAL_LEAFLET ? 'real 1.9.4' : 'stub (npm install in tests/ for the real one)'}`);
let pass = 0, fail = 0, skip = 0;
for (const t of tests) {
  if (only && !t.name.includes(only)) continue;
  const t0 = Date.now();
  try {
    const res = await t.fn();
    if (res === 'skipped') { skip++; console.log(`  - ${t.name} (skipped)`); }
    else { pass++; console.log(`  ✓ ${t.name} (${((Date.now() - t0) / 1000).toFixed(1)}s)`); }
  } catch (e) { fail++; console.log(`  ✗ ${t.name}\n      ${e.message}`); }
}
await browser.close();
console.log(`\n${pass} passed, ${fail} failed${skip ? `, ${skip} skipped` : ''}`);
process.exit(fail ? 1 : 0);
