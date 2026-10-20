# Byway

Find the oddities, landmarks, waterfalls and tiny museums hiding just off your drive.

**Open it:** https://nateflynn.github.io/byway/

Enter a start and a destination (plus any stops in between). Byway draws the route, scans a corridor along it for interesting places, and builds a spread-out shortlist (about 10 per day of driving, up to 60) so one big city can't crowd out the rest of the trip. At most 100 finds are shown per route, picked stretch by stretch along the road; category and corridor filters apply before that cap. Star the stops you like, then hand the whole trip to Google Maps for turn-by-turn navigation. Google takes 9 stops per link, so Byway warns when more picks will split the drive into parts.

## How it works

Everything runs in the browser — one self-contained `index.html`, no build step, no API keys, no tracking.

| Piece | Service |
| --- | --- |
| Place search & "use my location" | [Photon](https://photon.komoot.io) (OpenStreetMap), Nominatim fallback |
| Driving route | [OSRM](https://project-osrm.org) public servers |
| Places along the route | Wikipedia articles near the route (geosearch), then OpenStreetMap via the [Overpass API](https://overpass-api.de) |
| Descriptions & photos | Wikipedia / Wikidata |
| Map tiles | © OpenStreetMap contributors (tile.openstreetmap.org) |
| Navigation handoff | Google Maps URLs (`dir_action=navigate`) |

Places come from two sources. Wikipedia's "articles near a point" search runs first: about one lookup per 3–5 miles of road, filtered by each article's short description to real stops (museums, forts, waterfalls, parks, historic sites — not towns, schools, offices or events). It's quick and dependable, so the list fills in seconds. OpenStreetMap then adds the smaller spots (viewpoints, covered bridges, public art, roadside oddities) through the free public Overpass servers, which get busy; when they don't answer, the Wikipedia finds still stand and Retry asks again later. The same place from both sources is merged by its Wikidata ID or title.

For OpenStreetMap, Byway splits the route into ~40 mi sections, sends them to whichever mirror is healthy (a mirror that rate-limits or errors is set aside for a minute), and saves each answer (Wikipedia's too) in the browser for a week, so a retry or a repeat drive only asks for what's missing.

### Places index (East Coast)

Along the US East Coast (New England, New York, New Jersey and Pennsylvania down to Florida), OpenStreetMap places come from a monthly snapshot instead of the public Overpass servers. `.github/workflows/build-places.yml` downloads Geofabrik's `us-northeast` extract and the extracts for Delaware, Maryland, D.C., Virginia, the Carolinas, Georgia and Florida on the 3rd of each month (or on demand from the Actions tab). `tools/build_places.py` filters each extract, merges them, and keeps the places matching the app's `OSM_RULES` (the same list the Overpass query is built from). It reduces each to one point and writes them into small files, one per 0.25° square (about 17 × 12 mi), plus `index.json`, which lists the squares the extracts fully cover between them. The output is force-pushed to the `places-data` branch, so history doesn't grow, and served by jsDelivr, with raw.githubusercontent.com as backup.

The app loads `index.json` while it looks up your stops. Any stretch of road whose corridor lies wholly inside covered squares reads those squares, which are saved in the browser. Everything else uses Overpass, as does any stretch whose squares fail to load. To cover more states, add Geofabrik extracts to `EXTRACTS` in the workflow (any region with a `.poly` file works).

Route links keep the trip in the address (`?from=…&via=…&to=…`), so a link reopens the same drive.

Distances are straight-line from the route and detour times are rough estimates — check hours and access before leaving the highway.

## Tests

`tests/run.mjs` loads `index.html` in headless Chromium with every outside service replaced by local fakes (`tests/fixtures/troy-lake-placid.json`), then checks the scan, scoring, shortlist, answer cache, mirror failover, Retry, Google Maps links and the QR code.

```sh
cd tests
npm install                      # Playwright + real Leaflet 1.9.4
npx playwright install chromium  # first time only
npm test                         # or: node run.mjs cache   (only tests matching "cache")
```

Without `npm install`, a small Leaflet stand-in (`tests/leaflet-stub.js`) is used. The QR test also needs `python3` with OpenCV (`pip install opencv-python-headless`) and is skipped without it. `BYWAY_DEBUG=1 node run.mjs "debug dump"` prints every find with its score, which helps when tuning.

### Scan log

Add `&debug=1` to a Byway link to show a scan log: geocoding and routing times, then every Overpass attempt with its mirror, time, place count, and whether it came from the saved answers or failed (and why). **Copy log** copies it as JSON. **Copy fixture** copies the route plus every place Overpass returned, in the same format as `tests/fixtures/`; save it as `tests/fixtures/<name>.json` and replay it offline with `BYWAY_FIXTURE=fixtures/<name>.json BYWAY_DEBUG=1 node run.mjs "debug dump"`.
