# Dublin Bus 82 tracker

A commute tracker for **route 82 (Irishtown ↔ Kiltipper)**, focused on one
journey in each direction, with predicted departure times based on where the
buses actually are. The full route, all 129 stops and every live bus are still
there on the other tabs.

## The journey

Configured at the top of [`web/app.js`](web/app.js):

```javascript
var JOURNEYS = [
  { from: "397",  to: "2479" },   // outbound: Pearse Sq -> Grosvenor Road
  { from: "2478", to: "352"  },   // inbound:  Grosvenor Road -> Pearse Sq
];
```

Those are stop numbers as printed on the pole. Every place on a bus route has
two poles, one per direction, so the round trip touches four stop records — but
you only ever *wait* at two of them (397 and 2478), and those are the two the
map highlights. Ride time is 13–33 minutes each way, median 22.

## Run it

```bash
python3 dublin-bus-82/server.py
```

Then open <http://localhost:8082>. No dependencies — Python 3 standard library
and Leaflet from a CDN.

## The two position sources

| Mode | Needs a key? | What you see |
| --- | --- | --- |
| **Timetable** | no | Where each in-service trip *should* be right now, interpolated along the real route geometry from the published GTFS timetable |
| **Live GPS** | yes | Actual vehicle positions and punctuality from the NTA GTFS-Realtime feed |

Stops, the route line, and scheduled departures work with no setup at all. The
app starts in timetable mode and upgrades itself to live GPS as soon as a key is
present.

### Enabling live positions

Dublin has no open, keyless live-bus endpoint — the NTA's GTFS-Realtime API is
the authoritative source and it requires a free subscription key.

1. Register at <https://developer.nationaltransport.ie>.
2. Subscribe to the **GTFS-Realtime** product and copy your primary key.
3. Make it available to the server, either way:

   ```bash
   echo 'YOUR_KEY_HERE' > dublin-bus-82/.nta_key
   ```

   ```bash
   export NTA_API_KEY='YOUR_KEY_HERE'
   ```

4. Restart `server.py`. The status bar turns green and reads "Live GPS".

The key is read only by the local Python process and used as an `x-api-key`
header on the upstream request. It is never sent to the browser, and `/api/live`
returns only normalised route-82 data. `.nta_key` is mode `600` and listed in
`.gitignore`; rotate the key in the developer portal if it is ever exposed.

## What the live feed actually contains

Worth knowing before trusting any Dublin Bus tracker, including this one. The
NTA feed carries ~1,100 vehicles across 248 routes; 82 is typically 8–12 of
them. Two things about it shaped the implementation:

**Vehicles carry position only.** A Dublin Bus vehicle entity has `trip`,
`position` (latitude/longitude), `timestamp`, and a fleet number — no
`bearing`, no `speed`, no `stop_id`, no `current_stop_sequence`. So:

- the heading arrow is derived from the tangent of the route shape at the
  bus's position, and the popup labels it *(from route)*
- the next stop is derived by projecting the bus onto the route shape and
  taking the first stop further along it

**TripUpdates are historical, not predictive.** Each trip update holds a sparse
handful of stops the bus has *already passed*, carrying a delay and usually no
time at all. Taking its first entry as "next stop" put 7 of 10 buses between
1.5 km and 7 km away from where they actually were. The geometric derivation
puts all 10 within 30–300 m. Trip updates are therefore used only for
punctuality, reading the *last* entry since it is the most recent observation.

Numbers also arrive as JSON strings (`"timestamp": "1792494305"`), so the
server coerces them without truncating float coordinates.

## Rate limiting

The NTA free tier limits requests tightly — a cold start can 429 immediately.
The server therefore caches upstream responses for 30 s (GTFS-R only refreshes
every ~30 s anyway), parses the `Try again in N seconds` hint into a per-endpoint
backoff, and serves slightly stale cached data rather than burning a request
while blocked. If it has nothing cached it reports `rate_limited` and the UI
falls back to timetable positions with a countdown. The browser polls every
30 s to match.

## Predicted times, not timetable times

The timetable is the wrong answer to "when is my bus" — on this route buses were
observed anywhere from 5 minutes early to 13 minutes late. The **My trip** tab
predicts instead:

1. Find every trip that serves board-then-alight today.
2. Find the bus actually running each one in the live feed.
3. Work out how far along the route that bus is, and drop any that have already
   passed your stop (30 m of slack, so a bus pulling in still counts).
4. Shift the whole trip by that bus's current lateness.

Lateness comes from the operator's own figure when it is published, and
otherwise from comparing the bus's GPS position against where the timetable says
it should be by now. Those two measures were checked against each other across
the live fleet and agree to a **median of 1.2 minutes**, so either is a sound
basis.

Each row shows its working: `live` plus the fleet number means a real tracked
bus, with the original timetable time struck through when the prediction moved
it. `timetable` means no bus has been assigned to that trip yet, so it is a
scheduled time only — honest rather than falsely precise.

**What this assumes:** that a bus's current lateness persists until it reaches
you. There is no modelling of recovery, traffic ahead, or dwell time, and
lateness is not applied to departures more than 45 minutes out. For a bus
already en route to your stop this is a good assumption and is what real-time
passenger information systems do; for a trip whose bus has not started yet it
is no better than the timetable, which is why those rows say so.

## What's in the UI

- **My trip** — the two configured journeys with predicted departures, the bus
  serving each, its punctuality, and the predicted arrival at the far end.
  Clicking a row flies to that bus.
- **Map** — both direction shapes (gold outbound to Kiltipper Way, blue inbound
  to Sean Moore Rd), all 129 stops, and a bus marker per vehicle with a heading
  arrow. The two boarding poles are highlighted in pink with permanent labels
  and stay visible through every filter. Stale GPS fixes (>3 min) are dimmed.
- **Buses tab** — one row per bus: destination, next stop, vehicle number,
  punctuality badge, and GPS fix age. Click to fly to it.
- **Stops tab** — every stop in timetable order with the next 82 due. Searchable
  by name or stop number. Click a stop for the next six departures.
- **Direction filter** — restricts buses, stops, and the map to one direction.

## Layout

```
server.py                 local web server + NTA GTFS-R proxy (stdlib only)
functions/api/live.js     the same proxy as a Cloudflare Pages Function
wrangler.toml             Pages config (no secrets in it)
mock_feed.py              synthetic GTFS-R feed for testing without a key
build_route_data.py       extracts route 82 out of the full GTFS feed
split_data.py             splits that into a map payload + a schedule payload
refresh_gtfs.sh           re-download the feed and rebuild both payloads
web/index.html            the app
web/app.js                map, predictions, commute view
web/style.css
web/data/route.json       stops, shapes, patterns, calendar  (0.6 MB)
web/data/schedule.json    1,420 trips as [stop_id, seconds]  (2.1 MB)
build/                    intermediate GTFS extract, gitignored
```

Everything the browser needs sits under `web/`, so the only dynamic endpoint is
`/api/live`. `server.py` serves `web/` statically and handles `/api/live`
locally; on Pages the static files are served directly and the function handles
`/api/live`.

### HTTP endpoints

| Endpoint | Returns |
| --- | --- |
| `GET /api/status` | whether a key is configured, known route/trip ids |
| `GET /data/route.json` | stops, shapes, direction patterns, service calendar (static) |
| `GET /data/schedule.json` | per-trip stop times (static) |
| `GET /api/live` | route-82 vehicles + trip updates, or a reason it can't (`no_api_key`, `rate_limited`, `bad_api_key`, `upstream_error`) |

Upstream responses are cached for 30 s so the browser's polling doesn't
multiply into extra NTA API calls. See **Rate limiting** above.

## Deploying (Cloudflare Pages, free)

Everything except `/api/live` is static, so the site is a static host plus one
small function. On the free plan this costs nothing and needs no card: Workers
allow 100,000 requests/day and a single user with the page open an hour a day
makes about 120.

[`functions/api/live.js`](functions/api/live.js) is the deployed equivalent of
`server.py`'s proxy - same path, same response shape, so the frontend is
identical whether it is talking to the local Python server or to Pages.

```bash
npx wrangler login
npx wrangler pages secret put NTA_API_KEY     # paste the key when prompted
npx wrangler pages deploy web
```

Or connect the GitHub repo in the Cloudflare dashboard and set **build output
directory** to `web`; it then rebuilds on every push to `main`.

### Why not GitHub Pages on its own

Pages serves static files only, so there is nowhere to keep the API key - and
more fundamentally the NTA API returns no `Access-Control-Allow-Origin` header,
so a browser cannot call it directly whatever you do about the key. Without a
proxy you get the map, the stops and the timetable panels, but no live
positions and no predictions.

### Rate limiting when deployed

The function caches each upstream feed for 60s through Cloudflare's cache, so
repeat loads and additional visitors are served without a fresh NTA call. This
matters more than it sounds: the free NTA tier returns 429 at surprisingly low
rates, and a single browser polling every 30s is already enough to trip it
without caching.

## Testing without a key

```bash
python3 dublin-bus-82/server.py --mock-live
```

Serves a synthetic feed shaped exactly like the NTA's GTFS-R v2 JSON — built
from trips the timetable says are running now, with a spread of delays and one
deliberate non-82 vehicle to prove the route filter works. The UI labels this
clearly as a mock feed. Useful for exercising the live code path; not real buses.

## Refreshing the timetable

TFI republishes the GTFS feed roughly weekly:

```bash
bash dublin-bus-82/refresh_gtfs.sh
```

## Data sources & attribution

- Schedule and stops: [Transport for Ireland GTFS](https://www.transportforireland.ie/transitData/PT_Data.html)
  (`GTFS_Dublin_Bus.zip`), built 2026-10-19.
- Live vehicles: NTA GTFS-Realtime v2 `Vehicles` and `TripUpdates`.
- Map tiles: © OpenStreetMap contributors.

## Known limits

- Timetable positions assume buses run exactly to schedule — they are an
  estimate, not a GPS fix, and the UI says so on every popup.
- Stops are matched to the route shape by nearest vertex; on the rare trip
  pattern where that ordering breaks down, the bus falls back to a straight-line
  interpolation between the two stops.
- Calendar handling covers `calendar.txt` plus `calendar_dates.txt` exceptions,
  including trips that run past midnight (GTFS `24:xx`/`25:xx` times).
- Route 82 only — the extractor is parameterised by `ROUTE_SHORT_NAME` in
  `build_route_data.py` if you want another Dublin Bus route.
- Predictions cannot see a bus that has not yet started your trip. GTFS
  `block_id` would let the delay on a vehicle's *previous* trip carry into the
  next one; `build_route_data.py` does not currently keep that column, so those
  rows fall back to the timetable.
- Punctuality is read from the most recent trip-update entry. Whether that stays
  accurate for buses near the end of their route, where observations get sparse,
  has not been verified.
