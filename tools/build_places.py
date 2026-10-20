#!/usr/bin/env python3
"""Build Byway's places index from an OpenStreetMap extract.

Keeps exactly the places the app's Overpass query asks for (the OSM_RULES block in index.html),
reduces each to one point (the center of its bounding box, like Overpass `out center`), and writes
them into small files, one per 0.25° x 0.25° cell (about 17 x 12 miles), plus a manifest listing
which cells the extract fully covers. The app reads cells for any stretch of road inside the
covered area instead of asking the busy public Overpass servers.

Usage (the monthly GitHub workflow does this):
  build_places.py --pbf us-northeast-latest.osm.pbf virginia-latest.osm.pbf … \
                  --poly us-northeast.poly virginia.poly … --out out/places/v1
  (several extracts are filtered one by one, merged, and their outlines together form the covered area)
  build_places.py --geojsonseq features.geojsonseq --poly area.poly --out ...   # tests: skip osmium

Needs osmium-tool on PATH for --pbf. Standard library only otherwise.
"""
import argparse
import json
import math
import os
import re
import subprocess
import sys
import tempfile
from datetime import datetime, timezone

GRID = 0.25  # degrees per cell side
HERE = os.path.dirname(os.path.abspath(__file__))
INDEX_HTML = os.path.join(HERE, '..', 'index.html')

# Tags the app reads (classify, cards, links). Everything else is dropped to keep files small.
KEEP = {
    'name', 'name:en', 'tourism', 'historic', 'man_made', 'natural', 'waterway', 'bridge', 'leisure', 'boundary',
    'wikipedia', 'wikidata', 'website', 'contact:website', 'url', 'description', 'image', 'wikimedia_commons',
    'opening_hours', 'fee', 'access', 'artwork_type', 'artist_name', 'attraction', 'start_date',
    'heritage', 'heritage:operator', 'ref:nhl', 'protection_title', 'protection_object',
}
TYPE_CODE = {'node': 'n', 'way': 'w', 'relation': 'r'}


def load_rules(index_html=INDEX_HTML):
    src = open(index_html, encoding='utf-8').read()
    m = re.search(r'/\*OSM_RULES\*/(.*?)/\*END_OSM_RULES\*/', src, re.S)
    if not m:
        sys.exit('OSM_RULES block not found in index.html')
    return json.loads(m.group(1))


def matches(rules, osm_type, tags):
    for r in rules:
        if r['t'] == 'way' and osm_type != 'way':
            continue
        if tags.get(r['k']) in r['v'] and all(k in tags for k in r['need']):
            return True
    return False


def osmium_filter_expressions(rules):
    """osmium tags-filter expressions, e.g. nwr/tourism=museum,zoo  w/bridge=covered."""
    out = []
    for r in rules:
        prefix = 'w' if r['t'] == 'way' else 'nwr'
        out.append(f"{prefix}/{r['k']}={','.join(r['v'])}")
    return out


def bbox_center(geom):
    """Center of the geometry's bounding box (what Overpass `out center` returns)."""
    lo_lat = lo_lon = math.inf
    hi_lat = hi_lon = -math.inf

    def walk(c):
        nonlocal lo_lat, lo_lon, hi_lat, hi_lon
        if c and isinstance(c[0], (int, float)):
            lon, lat = c[0], c[1]
            lo_lat, hi_lat = min(lo_lat, lat), max(hi_lat, lat)
            lo_lon, hi_lon = min(lo_lon, lon), max(hi_lon, lon)
        else:
            for x in c:
                walk(x)

    walk(geom['coordinates'])
    if lo_lat is math.inf:
        return None
    return (lo_lat + hi_lat) / 2, (lo_lon + hi_lon) / 2


def read_poly(path):
    """Geofabrik/Osmosis .poly file → list of (ring, is_hole); rings are [(lon, lat), ...]."""
    rings, cur, hole = [], None, False
    with open(path, encoding='utf-8') as f:
        lines = [ln.strip() for ln in f if ln.strip()]
    for ln in lines[1:]:
        if cur is None:
            if ln == 'END':
                break
            hole, cur = ln.startswith('!'), []
        elif ln == 'END':
            rings.append((cur, hole))
            cur = None
        else:
            lon, lat = map(float, ln.split()[:2])
            cur.append((lon, lat))
    return rings


def in_ring(lon, lat, ring):
    inside = False
    j = len(ring) - 1
    for i in range(len(ring)):
        xi, yi = ring[i]
        xj, yj = ring[j]
        if (yi > lat) != (yj > lat) and lon < (xj - xi) * (lat - yi) / (yj - yi) + xi:
            inside = not inside
        j = i
    return inside


def in_poly(lon, lat, rings):
    outer = any(in_ring(lon, lat, r) for r, hole in rings if not hole)
    return outer and not any(in_ring(lon, lat, r) for r, hole in rings if hole)


def cell_key(lat, lon):
    return f'{math.floor(lat / GRID)}_{math.floor(lon / GRID)}'


def covered_cells(polys):
    """Cells lying wholly inside the extracts (corners, edge midpoints and center each inside one of them).
    polys: one ring list per extract, from read_poly()."""
    lons = [p[0] for rings in polys for r, h in rings if not h for p in r]
    lats = [p[1] for rings in polys for r, h in rings if not h for p in r]
    out = []
    for i in range(math.floor(min(lats) / GRID), math.floor(max(lats) / GRID) + 1):
        for j in range(math.floor(min(lons) / GRID), math.floor(max(lons) / GRID) + 1):
            s, w = i * GRID, j * GRID
            probes = [(w + dx * GRID, s + dy * GRID) for dx in (0, 0.5, 1) for dy in (0, 0.5, 1)]
            if all(any(in_poly(x, y, rings) for rings in polys) for x, y in probes):
                out.append(f'{i}_{j}')
    return out


def run_osmium(pbfs, rules, workdir):
    seq = os.path.join(workdir, 'features.geojsonseq')
    parts = []
    for i, pbf in enumerate(pbfs):
        part = os.path.join(workdir, f'filtered-{i}.osm.pbf')
        subprocess.run(['osmium', 'tags-filter', '--overwrite', '-o', part, pbf, *osmium_filter_expressions(rules)], check=True)
        parts.append(part)
    filtered = parts[0]
    if len(parts) > 1:  # neighbouring extracts overlap at their borders; merge drops the duplicates
        filtered = os.path.join(workdir, 'filtered.osm.pbf')
        subprocess.run(['osmium', 'merge', '--overwrite', '-o', filtered, *parts], check=True)
    subprocess.run(['osmium', 'export', '--overwrite', '-f', 'geojsonseq', '-x', 'print_record_separator=false',
                    '-a', 'type,id', '-o', seq, filtered], check=True)
    return seq


def build(seq_path, rules, polys, out_dir, region, source_note):
    cells, seen, kept = {}, set(), 0
    with open(seq_path, encoding='utf-8') as f:
        for line in f:
            line = line.strip().lstrip('\x1e')
            if not line:
                continue
            feat = json.loads(line)
            props = feat.get('properties') or {}
            osm_type, osm_id = props.get('@type'), props.get('@id')
            if osm_type not in TYPE_CODE or osm_id is None or (osm_type, osm_id) in seen:
                continue
            tags = {k: v for k, v in props.items() if not k.startswith('@')}
            if not matches(rules, osm_type, tags):
                continue
            c = bbox_center(feat['geometry']) if feat.get('geometry') else None
            if not c:
                continue
            seen.add((osm_type, osm_id))
            lat, lon = round(c[0], 6), round(c[1], 6)
            small = {k: v for k, v in tags.items() if k in KEEP}
            cells.setdefault(cell_key(lat, lon), []).append([TYPE_CODE[osm_type], int(osm_id), lat, lon, small])
            kept += 1

    covered = covered_cells(polys)
    cell_dir = os.path.join(out_dir, 'c')
    os.makedirs(cell_dir, exist_ok=True)
    for key, els in cells.items():
        els.sort(key=lambda e: (e[0], e[1]))
        with open(os.path.join(cell_dir, f'{key}.json'), 'w', encoding='utf-8') as f:
            json.dump({'v': 1, 'cell': key, 'els': els}, f, ensure_ascii=False, separators=(',', ':'))
    manifest = {
        'v': 1, 'grid': GRID, 'region': region, 'source': source_note,
        'built': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%MZ'),
        'places': kept, 'covered': sorted(covered), 'cells': {k: len(v) for k, v in sorted(cells.items())},
    }
    with open(os.path.join(out_dir, 'index.json'), 'w', encoding='utf-8') as f:
        json.dump(manifest, f, separators=(',', ':'))
    return manifest


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument('--pbf', nargs='+', help='OSM extract(s) (.osm.pbf); needs osmium-tool')
    src.add_argument('--geojsonseq', help='already-exported features (one GeoJSON feature per line)')
    ap.add_argument('--poly', nargs='+', required=True, help='coverage polygon(s) (.poly), one per extract')
    ap.add_argument('--out', required=True, help='output folder, e.g. out/places/v1')
    ap.add_argument('--region', default='us-northeast')
    ap.add_argument('--source', default='© OpenStreetMap contributors, via Geofabrik')
    ap.add_argument('--rules-from', default=INDEX_HTML, help='index.html holding the OSM_RULES block')
    a = ap.parse_args()

    rules = load_rules(a.rules_from)
    polys = [read_poly(p) for p in a.poly]
    with tempfile.TemporaryDirectory() as tmp:
        seq = run_osmium(a.pbf, rules, tmp) if a.pbf else a.geojsonseq
        m = build(seq, rules, polys, a.out, a.region, a.source)
    print(f"{m['places']} places in {len(m['cells'])} cells; {len(m['covered'])} cells fully covered; built {m['built']}")


if __name__ == '__main__':
    main()
