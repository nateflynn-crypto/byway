#!/usr/bin/env node
/* Private place list for Byway: build it, make a key, encrypt it.

   The encrypted file (private/places.enc.json) can sit in the public repo: without the key it's
   unreadable. Byway decrypts it in the browser of anyone who has opened the key link
   (https://nateflynn.github.io/byway/#key=…), which stores the key in that browser only.

   node tools/private_list.mjs newkey
       → prints a new random key (keep it out of the repo)
   node tools/private_list.mjs atlas --csv atlasobscura.csv --states east --out list.json
       → Atlas Obscura export → places in the listed US states ("east" = Maine to Florida plus
         Vermont, Pennsylvania and D.C.; or a comma-separated list of state names), open and shown,
         foods excluded. Keeps id, name, one-line subtitle, coordinates, link, town.
       (or --manifest index.json instead of --states: places inside the places index's cells)
   node tools/private_list.mjs roadside --csv RoadsideAmerica.csv --coords coords.json --out ra.json
       → Roadside America list (State, Name, Address, City, Approximate) plus coordinates found for it
         ({row: [lat, lon, how]}, how = addr | name | town | approx; rows without coordinates are left out)
   node tools/private_list.mjs merge --in atlas.json,ra.json --out list.json
   node tools/private_list.mjs encrypt --in list.json --key <key> --out private/places.enc.json
   node tools/private_list.mjs decrypt --in private/places.enc.json --key <key>   (check a file)

   List format: { "v": 1, "source": "…", "built": "…", "places": [[id, name, subtitle, lat, lon, url, town, src?, approx?], …] }
   src: omitted for Atlas Obscura, "ra" for Roadside America (subtitle = street address, no url).
   approx: "town" when only the town centre is known, "approx" when the source marks it approximate.
   Encrypted format: { "v": 1, "alg": "A256GCM+gzip", "iv": base64, "ct": base64 } where ct is
   AES-256-GCM over the gzipped list JSON. */
import fs from 'node:fs';
import zlib from 'node:zlib';
import { webcrypto as crypto } from 'node:crypto';

const args = Object.fromEntries(process.argv.slice(3).reduce((a, x, i, all) => (x.startsWith('--') ? [...a, [x.slice(2), all[i + 1]]] : a), []));
const b64url = buf => Buffer.from(buf).toString('base64url');

async function importKey(k) {
  const raw = Buffer.from(k, 'base64url');
  if (raw.length !== 32) throw new Error('key must be 32 bytes (base64url)');
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

// Minimal CSV parser (quoted fields, embedded commas/newlines/quotes).
function parseCSV(text) {
  const rows = []; let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; } else field += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(field); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const [head, ...body] = rows.filter(r => r.length > 1 || r[0]);
  return body.map(r => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ''])));
}

const cmd = process.argv[2];
if (cmd === 'newkey') {
  console.log(b64url(crypto.getRandomValues(new Uint8Array(32))));
} else if (cmd === 'atlas') {
  const rows = parseCSV(fs.readFileSync(args.csv, 'utf8'));
  const EAST = ['Maine', 'New Hampshire', 'Vermont', 'Massachusetts', 'Rhode Island', 'Connecticut', 'New York', 'New Jersey', 'Pennsylvania',
    'Delaware', 'Maryland', 'Washington, D.C.', 'Virginia', 'North Carolina', 'South Carolina', 'Georgia', 'Florida'];
  const states = args.states ? (args.states === 'east' ? EAST : args.states.split(',').map(x => x.trim())) : null;
  let inArea;
  if (states) inArea = r => r.country === 'United States' && states.some(st => r.location.trim().endsWith(st));
  else {
    const m = JSON.parse(fs.readFileSync(args.manifest, 'utf8'));
    const grid = m.grid || 0.25, cells = new Set([...(m.covered || []), ...Object.keys(m.cells || {})]);
    inArea = r => cells.has(`${Math.floor(+r.coordinates_lat / grid)}_${Math.floor(+r.coordinates_lng / grid)}`);
  }
  const places = [];
  for (const r of rows) {
    const lat = +r.coordinates_lat, lon = +r.coordinates_lng;
    if (!isFinite(lat) || !isFinite(lon) || !inArea(r)) continue;
    if (r.thing_type === 'Food' || String(r.hide_from_maps).toLowerCase() === 'true' || String(r.physical_status).toUpperCase() === 'CLOSED') continue;
    const url = r.url.startsWith('http') ? r.url : 'https://www.atlasobscura.com' + r.url;
    places.push([+r.id, r.title.trim(), r.subtitle.trim(), +lat.toFixed(6), +lon.toFixed(6), url, r.location.trim()]);
  }
  places.sort((a, b) => a[0] - b[0]);
  fs.writeFileSync(args.out, JSON.stringify({ v: 1, source: 'Atlas Obscura (personal use)', area: states ? (args.states === 'east' ? 'East Coast' : states.join(', ')) : 'places index cells', built: new Date().toISOString().slice(0, 10), places }));
  console.log(`${places.length} places → ${args.out}`);
} else if (cmd === 'roadside') {
  const rows = parseCSV(fs.readFileSync(args.csv, 'utf8')), coords = JSON.parse(fs.readFileSync(args.coords, 'utf8'));
  const places = [];
  rows.forEach((r, i) => {
    const c = coords[i]; if (!c) return;
    const how = r.Approximate === 'Yes' && c[2] === 'addr' ? 'approx' : c[2];
    const p = [`r${i}`, r.Name.trim(), r.Address.trim(), +(+c[0]).toFixed(6), +(+c[1]).toFixed(6), '', r.City.trim(), 'ra'];
    if (how === 'town' || how === 'approx') p.push(how);
    places.push(p);
  });
  fs.writeFileSync(args.out, JSON.stringify({ v: 1, source: 'Roadside America (personal use)', area: 'East Coast', built: new Date().toISOString().slice(0, 10), places }));
  const n = k => places.filter(p => (p[8] || 'addr') === k).length;
  console.log(`${places.length} of ${rows.length} places → ${args.out} (${places.length - n('town') - n('approx')} pinned, ${n('approx')} approximate, ${n('town')} town centre)`);
} else if (cmd === 'merge') {
  const lists = args.in.split(',').map(f => JSON.parse(fs.readFileSync(f, 'utf8')));
  const places = lists.flatMap(l => l.places);
  fs.writeFileSync(args.out, JSON.stringify({ v: 1, source: lists.map(l => l.source).join(' + '), area: lists.map(l => l.area).join(' + '), built: new Date().toISOString().slice(0, 10), places }));
  console.log(`${places.length} places → ${args.out}`);
} else if (cmd === 'encrypt') {
  const key = await importKey(args.key);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, zlib.gzipSync(fs.readFileSync(args.in), { level: 9 }));
  fs.mkdirSync(args.out.replace(/\/[^/]*$/, '') || '.', { recursive: true });
  fs.writeFileSync(args.out, JSON.stringify({ v: 1, alg: 'A256GCM+gzip', iv: Buffer.from(iv).toString('base64'), ct: Buffer.from(ct).toString('base64') }));
  console.log(`encrypted ${fs.statSync(args.in).size} bytes → ${fs.statSync(args.out).size} bytes in ${args.out}`);
} else if (cmd === 'decrypt') {
  const f = JSON.parse(fs.readFileSync(args.in, 'utf8')), key = await importKey(args.key);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: Buffer.from(f.iv, 'base64') }, key, Buffer.from(f.ct, 'base64'));
  const list = JSON.parse(zlib.gunzipSync(Buffer.from(pt)));
  console.log(`${list.places.length} places, built ${list.built}, source ${list.source}`);
} else {
  console.log('usage: newkey | atlas --csv --states|--manifest --out | roadside --csv --coords --out | merge --in a,b --out | encrypt --in --key --out | decrypt --in --key');
  process.exit(1);
}
