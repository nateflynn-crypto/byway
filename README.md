# Byway

Find the oddities, landmarks, waterfalls and tiny museums hiding just off your drive.

**Open it:** https://nateflynn.github.io/byway/

Enter a start and a destination (plus any stops in between). Byway draws the route, scans a corridor along it for interesting places, and builds a spread-out shortlist so one big city can't crowd out the rest of the trip. Star the stops you like, then hand the whole trip to Google Maps for turn-by-turn navigation.

## How it works

Everything runs in the browser — one self-contained `index.html`, no build step, no API keys, no tracking.

| Piece | Service |
| --- | --- |
| Place search & "use my location" | [Photon](https://photon.komoot.io) (OpenStreetMap), Nominatim fallback |
| Driving route | [OSRM](https://project-osrm.org) public servers |
| Places along the route | OpenStreetMap via the [Overpass API](https://overpass-api.de) |
| Descriptions & photos | Wikipedia / Wikidata |
| Map tiles | © OpenStreetMap contributors (tile.openstreetmap.org) |
| Navigation handoff | Google Maps URLs (`dir_action=navigate`) |

Places come from the free public Overpass servers, which get busy. Byway splits the route into ~40 mi sections, sends them to whichever mirror is healthy (a mirror that rate-limits or errors is set aside for a minute), and saves each answer in the browser for a week, so a retry or a repeat drive only asks for what's missing.

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

Without `npm install`, a small Leaflet stand-in (`tests/leaflet-stub.js`) is used. The QR test also needs `python3` with OpenCV (`pip install opencv-python-headless`) and is skipped without it. `BYWAY_DEBUG=1 node run.mjs debug` prints every find with its score, which helps when tuning.
