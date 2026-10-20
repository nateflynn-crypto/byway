# Byway

Find the oddities, landmarks, waterfalls and tiny museums hiding just off your drive.

**Open it:** https://nateflynn-crypto.github.io/byway/

Enter a start and a destination (plus any stops in between). Byway draws the route, scans a corridor along it for interesting places, and builds a spread-out shortlist so one big city can't crowd out the rest of the trip. Star the stops you like, then hand the whole trip to Google Maps for turn-by-turn navigation.

## How it works

Everything runs in the browser — one self-contained `index.html`, no build step, no API keys, no tracking.

| Piece | Service |
| --- | --- |
| Place search & "use my location" | [Photon](https://photon.komoot.io) (OpenStreetMap), Nominatim fallback |
| Driving route | [OSRM](https://project-osrm.org) public servers |
| Places along the route | OpenStreetMap via the [Overpass API](https://overpass-api.de) |
| Descriptions & photos | Wikipedia / Wikidata |
| Map tiles | © OpenStreetMap contributors, © CARTO |
| Navigation handoff | Google Maps URLs (`dir_action=navigate`) |

Route links keep the trip in the address (`?from=…&via=…&to=…`), so a link reopens the same drive.

Distances are straight-line from the route and detour times are rough estimates — check hours and access before leaving the highway.
