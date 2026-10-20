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
const FIX = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'troy-lake-placid.json'), 'utf8'));
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
function overpassAnswer(q) {
  const a = parseAround(q);
  if (!a) return { elements: [] };
  const els = FIX.elements.filter(e => {
    const p = e.lat != null ? [e.lat, e.lon] : [e.center.lat, e.center.lon];
    for (let i = 1; i < a.pts.length; i++) if (segDistM(p, a.pts[i - 1], a.pts[i]) <= a.r) return true;
    return a.pts.length === 1 && havM(p, a.pts[0]) <= a.r;
  });
  return { version: 0.6, generator: 'byway-test', elements: els };
}

/* ---------- fake services ---------- */
const OVERPASS_HOSTS = ['overpass-api.de', 'overpass.private.coffee', 'overpass.kumi.systems', 'maps.mail.ru'];
function makeWorld() {
  // behavior per host: 'ok' | 429 | 504 | 'remark' | 'xml' | 'refuse', or an array consumed one per request
  const world = { behavior: Object.fromEntries(OVERPASS_HOSTS.map(h => [h, 'ok'])), requests: [] };
  world.set = (h, b) => { world.behavior[h] = b; };
  world.all = b => OVERPASS_HOSTS.forEach(h => world.set(h, b));
  world.overpassCalls = () => world.requests.filter(r => r.kind === 'overpass');
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
  if (host === 'photon.komoot.io') {
    world.requests.push({ kind: 'photon', url: u.href });
    const q = u.searchParams.get('q') || '';
    const hit = FIX.geocode[q];
    return json({ type: 'FeatureCollection', features: hit ? [{ type: 'Feature', geometry: { type: 'Point', coordinates: [hit[1], hit[0]] }, properties: { name: q.split(',')[0], state: 'New York', countrycode: 'US', osm_value: 'town' } }] : [] });
  }
  if (host === 'nominatim.openstreetmap.org') return json([]);
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
    return json(overpassAnswer(q));
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
const TROY = '?from=Troy%2C+NY&to=Lake+Placid%2C+NY';
async function settle(page, timeout = 30000) {
  await page.waitForFunction(() => {
    const S = window.__byway && window.__byway.state, st = document.querySelector('#status');
    return S && !S.busy && st && !st.hidden && !/Scouting|Retrying|Finding your|Drawing/.test(st.textContent);
  }, null, { timeout });
  return page.evaluate(() => {
    const S = window.__byway.state, st = document.querySelector('#status');
    return {
      status: st.textContent.trim(), kind: st.className,
      finds: S.finds.map(f => ({ name: f.name, cat: f.cat, base: f.base, off: f.off, score: f.score, info: !!(f.info && f.info.extract) })),
      shortlist: S.shortlist.map(f => f.name), failed: S.failed.length, raw: S.raw.size,
      chunks: window.__byway.makeChunks(S.route, S.queryRadius).length,
    };
  });
}
// Starts a scan after shrinking timing knobs, so failure paths run in seconds, not minutes.
async function scanWithFastTimers(page) {
  await page.evaluate(() => {
    const C = window.__byway.CFG; if (C) { C.benchMaxWaitMs = 150; C.overpassMs = 8000; }
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
      priv: c({ historic: 'ruins', access: 'private' }, 'Private Ruins'),
    };
  });
  assert(r.jb.cat === 'history' && Math.abs(r.jb.base - 3.0) < 1e-9, `John Brown Farm → ${JSON.stringify(r.jb)}`);
  assert(r.wild.cat === 'nature', `wilderness → ${r.wild.cat}`);
  assert(Math.abs(r.otter.base - 0.6) < 1e-9 && Math.abs(r.gallery.base - 1.9) < 1e-9, `galleries → ${r.otter.base}, ${r.gallery.base}`);
  assert(Math.abs(r.bareView.base - 0.5) < 1e-9, `bare viewpoint → ${r.bareView.base}`);
  assert(r.generic.base < 0, `generic name should go negative → ${r.generic.base}`);
  assert(r.gnome.cat === 'weird', `gnome → ${r.gnome.cat}`);
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
  assert(second.finds.length === first.finds.length && second.finds.length > 0, `finds ${second.finds.length} vs ${first.finds.length}`);
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('byway.opidx') || '[]').length);
  assert(stored === first.chunks, `localStorage holds ${stored} answers, expected ${first.chunks}`);
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
