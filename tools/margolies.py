#!/usr/bin/env python3
"""Build Byway's vintage roadside photo list from the John Margolies Roadside America archive.

The archive (Library of Congress, about 11,700 photos taken 1972–2008) has no known copyright
restrictions, so the result is a plain public file: data/margolies.json.

Its coordinates are town centres, not the exact spot, and many of the places are gone, so Byway shows
these by town ("photographed here, then") and only attaches a photo to a find when a place of the
same name is near that town.

  margolies.py --csv Margolies-best.csv --out data/margolies.json

Output: {"v":1, "source":…, "towns": [[town, state code, lat, lon, [place, …]], …]}
  place: [name, first year, last year, photo count, interest 0–3, [[image path, LCCN, caption], …]]
  image path "00200/00262" → https://cdn.loc.gov/service/pnp/mrg/00200/00262_150px.jpg (thumbnail)
                             https://tile.loc.gov/storage-services/service/pnp/mrg/00200/00262r.jpg (larger)
  LCCN → https://www.loc.gov/pictures/collection/mrg/item/<LCCN>/
"""
import argparse, csv, json, re
from collections import defaultdict, Counter

STATE_CODES = {'Alabama': 'AL', 'Alaska': 'AK', 'Arizona': 'AZ', 'Arkansas': 'AR', 'California': 'CA', 'Colorado': 'CO', 'Connecticut': 'CT',
    'Delaware': 'DE', 'District of Columbia': 'DC', 'Washington, D.C.': 'DC', 'Florida': 'FL', 'Georgia': 'GA', 'Hawaii': 'HI', 'Idaho': 'ID',
    'Illinois': 'IL', 'Indiana': 'IN', 'Iowa': 'IA', 'Kansas': 'KS', 'Kentucky': 'KY', 'Louisiana': 'LA', 'Maine': 'ME', 'Maryland': 'MD',
    'Massachusetts': 'MA', 'Michigan': 'MI', 'Minnesota': 'MN', 'Mississippi': 'MS', 'Missouri': 'MO', 'Montana': 'MT', 'Nebraska': 'NE',
    'Nevada': 'NV', 'New Hampshire': 'NH', 'New Jersey': 'NJ', 'New Mexico': 'NM', 'New York': 'NY', 'North Carolina': 'NC', 'North Dakota': 'ND',
    'Ohio': 'OH', 'Oklahoma': 'OK', 'Oregon': 'OR', 'Pennsylvania': 'PA', 'Rhode Island': 'RI', 'South Carolina': 'SC', 'South Dakota': 'SD',
    'Tennessee': 'TN', 'Texas': 'TX', 'Utah': 'UT', 'Vermont': 'VT', 'Virginia': 'VA', 'Washington': 'WA', 'West Virginia': 'WV',
    'Wisconsin': 'WI', 'Wyoming': 'WY', 'Ontario': 'ON', 'Quebec': 'QC', 'British Columbia': 'BC', 'Alberta': 'AB', 'Manitoba': 'MB',
    'Saskatchewan': 'SK', 'Nova Scotia': 'NS', 'New Brunswick': 'NB'}

# How much a subject says "roadside curiosity" (3) versus "ordinary building" (0).
INTEREST = [
    (3, r'dinosaurs|mimetic|sculpture|statues|giants|animal sculpture|miniature golf|tipis|wigwam|roadside attractions|figures|totem'),
    (2, r'amusement|signs|billboards|drive-in|diners|boardwalk|piers|roller coasters|trading posts|gift shops|neon|lighthouses|windmills|tourist'),
    (1, r'motels|hotels|resorts|restaurants|cafes|ice cream|motion picture|theaters|service stations|cabins|beaches|eating|bars|fast food|stores|museums'),
]
ADDRESS = re.compile(r'^(route|rt\.?|rts\.?|routes|highway|hwy|interstate|i-\d|u\.?s\.? \d|state route|county road|old route)\b|'
                     r'\b(street|st\.|avenue|ave\.?|boulevard|blvd\.?|road|rd\.|drive|lane|parkway|pike|turnpike|highway|way|place|square)$|'
                     r'^\d+\s|^\d+$|\b\d+(st|nd|rd|th) (street|avenue)\b|&| and \w+ (street|avenue)', re.I)
DETAIL_HEAD = re.compile(r'^(view|overall|overview|detail|close-?up|closeup|hole|holes|angle|side|front|rear|back|entry|entrance|interior|exterior|'
                         r'sign|signs|night|day|straight-on|diagonal|horizontal|vertical|long|wide|full|partial|left|right|top|bottom|another|second|'
                         r'first|third|water hazard|waterfall|obstacle|with people|aerial|elevation|facade|façade|panorama|alternate|alt)\b', re.I)
DETAIL_TAIL = re.compile(r'(\s+\((?:[^)]*)\))+$|'
                         r'\s+(horizontal|vertical|diagonal|straight-on|overall|close-?up|front|side|rear|back|night|daytime|full height|alternate|detail|entrance|entry|parking lot|roadside|neon|marquee|tower|roof|window|door)?\s*'
                         r'(view|views|detail|details|sign|signs|angle|shot|version|image)(\s+\w+){0,2}$|'
                         r'\s+(one|two|three|four|five|\d+|i|ii|iii|iv|v)$', re.I)


def interest(subjects):
    s = ' '.join(subjects).lower()
    for score, pat in INTEREST:
        if re.search(pat, s):
            return score
    return 0


def candidates(title, city, state):
    parts = [p.strip() for p in re.sub(r'\.$', '', title.strip()).split(',')]
    # drop trailing country/state/city
    low = [p.lower() for p in parts]
    while parts and low[-1] in {'canada', 'united states', 'usa', state.lower(), city.lower()} | ({'d.c.'} if 'D.C' in state or 'Columbia' in state else set()):
        parts.pop(); low.pop()
    out = []
    for p in parts:
        if not p or ADDRESS.search(p) or DETAIL_HEAD.match(p):
            continue
        if p[0].islower():
            continue
        out.append(p)
    return out or [parts[0] if parts else title]


def clean(name):
    prev = None
    while prev != name:
        prev = name
        name = DETAIL_TAIL.sub('', name).strip(' -;:')
    return name


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--csv', required=True)
    ap.add_argument('--out', required=True)
    a = ap.parse_args()
    rows = list(csv.DictReader(open(a.csv, encoding='utf-8', errors='replace')))
    towns = defaultdict(list)
    for r in rows:
        try:
            lat, lon = float(r['y']), float(r['x'])
        except ValueError:
            continue
        state = r['State'].strip()
        towns[(r['City'].strip(), state, round(lat, 5), round(lon, 5))].append(r)
    out_towns = []
    photos = 0
    for (city, state, lat, lon), rs in towns.items():
        cand = [candidates(r['Title'], city, state) for r in rs]
        freq = Counter(clean(c) for cs in cand for c in set(cs))
        places = defaultdict(list)
        for r, cs in zip(rs, cand):
            # the place is the part of the caption shared by the most photos in this town (ties: the later part,
            # since captions usually run "detail, place, address, town")
            best = max(enumerate(cs), key=lambda ic: (freq[clean(ic[1])], ic[0]))[1]
            places[clean(best) or best].append(r)
        plist = []
        for name, prs in places.items():
            years = [int(x['Date_Created'][:4]) for x in prs if x['Date_Created'][:4].isdigit()]
            subj = [x[f'Subject_{i}'] for x in prs for i in range(1, 6) if x[f'Subject_{i}']]
            pics = []
            for x in prs[:6]:
                m = re.search(r'/mrg/(\d{5}/\d{5})', x['Full_Image'])
                if m:
                    pics.append([m.group(1), x['LCCN'].strip(), x['Title'].strip()])
            photos += len(prs)
            plist.append([name, min(years) if years else None, max(years) if years else None, len(prs), interest(subj), pics])
        plist.sort(key=lambda p: (-p[4], -p[3], p[0]))
        out_towns.append([city, STATE_CODES.get(state, state), lat, lon, plist])
    out_towns.sort(key=lambda t: (t[1], t[0]))
    doc = {'v': 1, 'source': 'John Margolies Roadside America photograph archive (1972-2008), Library of Congress Prints & Photographs Division. No known restrictions on publication.',
           'photos': photos, 'towns': out_towns}
    with open(a.out, 'w', encoding='utf-8') as f:
        json.dump(doc, f, ensure_ascii=False, separators=(',', ':'))
    print(f"{photos} photos, {sum(len(t[4]) for t in out_towns)} places in {len(out_towns)} towns → {a.out}")


if __name__ == '__main__':
    main()
