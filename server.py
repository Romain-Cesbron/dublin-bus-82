#!/usr/bin/env python3
"""Local server for the Dublin Bus 82 tracker.

Serves the web UI and proxies the NTA GTFS-Realtime API so the API key stays
on this machine instead of in the browser. Standard library only.

    python3 server.py [--port 8082]

The API key is read from, in order:
  1. the NTA_API_KEY environment variable
  2. a file called .nta_key next to this script (first line)
Get a free key at https://developer.nationaltransport.ie (subscribe to
"GTFS-Realtime"). Without a key the UI still shows every stop and the route,
and falls back to timetable-derived positions.
"""
import argparse
import base64
import gzip
import io
import json
import os
import re
import socketserver
import sys
import threading
import time
import urllib.error
import urllib.request
from http.server import SimpleHTTPRequestHandler

HERE = os.path.dirname(os.path.abspath(__file__))
WEB_DIR = os.path.join(HERE, "web")
DATA_DIR = os.path.join(WEB_DIR, "data")   # served statically too
KEY_FILE = os.path.join(HERE, ".nta_key")

GTFSR_BASE = "https://api.nationaltransport.ie/gtfsr/v2"
# The NTA free tier rate-limits aggressively, so cache upstream responses well
# beyond the browser's polling interval. GTFS-R only refreshes every ~30s
# anyway, so a longer cache costs almost no freshness.
UPSTREAM_CACHE_SECONDS = 30
UPSTREAM_TIMEOUT = 20
# How long a cached payload may still be served once it is past its TTL but we
# are being rate-limited. Beyond this we admit the data is too old.
STALE_SERVE_SECONDS = 300

# Filled from data/route.json at startup.
ROUTE_IDS = set()
TRIP_IDS = set()

_cache = {}
_backoff = {}          # endpoint -> unix time we may call it again
_cache_lock = threading.Lock()

MOCK_LIVE = False   # --mock-live: serve a synthetic feed instead of calling NTA


def load_route_ids():
    """Read the route/trip ids we care about so we can filter the national feed."""
    global ROUTE_IDS, TRIP_IDS
    with open(os.path.join(DATA_DIR, "route.json"), encoding="utf-8") as fh:
        route = json.load(fh)
    ROUTE_IDS = set(route["route"]["route_ids"])
    with open(os.path.join(DATA_DIR, "schedule.json"), encoding="utf-8") as fh:
        TRIP_IDS = set(json.load(fh).keys())
    print(f"  route ids : {sorted(ROUTE_IDS)}")
    print(f"  trip ids  : {len(TRIP_IDS)} known route-82 trips")


def api_key():
    key = os.environ.get("NTA_API_KEY", "").strip()
    if key:
        return key
    if os.path.exists(KEY_FILE):
        with open(KEY_FILE, encoding="utf-8") as fh:
            return fh.readline().strip()
    return ""


class RateLimited(Exception):
    """Upstream returned 429. Carries how long it asked us to wait."""

    def __init__(self, retry_after):
        super().__init__(f"rate limited, retry in {retry_after}s")
        self.retry_after = retry_after


def _retry_after_seconds(exc, body):
    """NTA sends 'Try again in N seconds' in the body, sometimes a header too."""
    header = exc.headers.get("Retry-After") if exc.headers else None
    if header and header.strip().isdigit():
        return int(header.strip())
    m = re.search(r"try again in (\d+)\s*second", body, re.I)
    return int(m.group(1)) if m else 60


def fetch_upstream(endpoint, key):
    """GET a GTFS-R endpoint as JSON, with a shared cache and 429 backoff.

    Returns (payload, age_seconds). Raises RateLimited if we are backed off and
    have nothing cached worth serving.
    """
    now = time.time()
    with _cache_lock:
        hit = _cache.get(endpoint)
        if hit and now - hit[0] < UPSTREAM_CACHE_SECONDS:
            return hit[1], now - hit[0]
        blocked_until = _backoff.get(endpoint, 0)

    # Still inside a 429 backoff window: serve what we have rather than
    # burning another request and extending the block.
    if now < blocked_until:
        if hit and now - hit[0] < STALE_SERVE_SECONDS:
            return hit[1], now - hit[0]
        raise RateLimited(int(blocked_until - now))

    url = f"{GTFSR_BASE}/{endpoint}?format=json"
    req = urllib.request.Request(url, headers={
        "x-api-key": key,
        "Cache-Control": "no-cache",
        "Accept": "application/json",
    })
    try:
        with urllib.request.urlopen(req, timeout=UPSTREAM_TIMEOUT) as resp:
            raw = resp.read()
            if resp.headers.get("Content-Encoding") == "gzip":
                raw = gzip.decompress(raw)
            payload = json.loads(raw.decode("utf-8"))
    except urllib.error.HTTPError as exc:
        if exc.code != 429:
            raise
        try:
            body = exc.read().decode("utf-8", "replace")
        except Exception:
            body = ""
        wait = _retry_after_seconds(exc, body)
        with _cache_lock:
            _backoff[endpoint] = time.time() + wait
        if hit and time.time() - hit[0] < STALE_SERVE_SECONDS:
            return hit[1], time.time() - hit[0]
        raise RateLimited(wait)

    with _cache_lock:
        _cache[endpoint] = (now, payload)
        _backoff.pop(endpoint, None)
    return payload, 0.0


def _trip_of(obj):
    """GTFS-R JSON uses snake_case or camelCase depending on the producer."""
    return obj.get("trip") or obj.get("Trip") or {}


def _get(d, *names, default=None):
    for n in names:
        if n in d and d[n] is not None:
            return d[n]
    return default


def _num(value):
    """The live NTA feed quotes numbers as strings ("1792494305"); normalise.

    Numbers that arrive already typed are passed straight through - calling
    int() on them would truncate float latitudes to whole degrees.
    """
    if value is None or value == "" or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return value
    try:
        return int(value)
    except (TypeError, ValueError):
        pass
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def is_route_82(trip):
    route_id = _get(trip, "route_id", "routeId", default="")
    trip_id = _get(trip, "trip_id", "tripId", default="")
    return route_id in ROUTE_IDS or trip_id in TRIP_IDS


def normalise_vehicles(feed):
    """Pull route-82 vehicles out of the national Vehicles feed."""
    out = []
    for entity in feed.get("entity", feed.get("Entity", [])) or []:
        vehicle = _get(entity, "vehicle", "Vehicle", default=None)
        if not vehicle:
            continue
        trip = _trip_of(vehicle)
        if not is_route_82(trip):
            continue
        pos = _get(vehicle, "position", "Position", default={}) or {}
        lat = _num(_get(pos, "latitude", "Latitude"))
        lon = _num(_get(pos, "longitude", "Longitude"))
        if lat is None or lon is None:
            continue
        veh_desc = _get(vehicle, "vehicle", "Vehicle", default={}) or {}
        out.append({
            "id": _get(entity, "id", "Id", default=""),
            "trip_id": _get(trip, "trip_id", "tripId", default=""),
            "route_id": _get(trip, "route_id", "routeId", default=""),
            "direction_id": _num(_get(trip, "direction_id", "directionId")),
            "start_time": _get(trip, "start_time", "startTime", default=""),
            "start_date": _get(trip, "start_date", "startDate", default=""),
            "schedule_relationship": _get(trip, "schedule_relationship",
                                          "scheduleRelationship", default=""),
            "lat": lat,
            "lon": lon,
            # bearing/speed/stop are optional - Dublin Bus vehicles report
            # position and timestamp only, so these are usually absent and the
            # client derives heading from the route shape instead.
            "bearing": _num(_get(pos, "bearing", "Bearing")),
            "speed": _num(_get(pos, "speed", "Speed")),
            "stop_sequence": _num(_get(vehicle, "current_stop_sequence",
                                       "currentStopSequence")),
            "stop_id": _get(vehicle, "stop_id", "stopId", default=""),
            "status": _get(vehicle, "current_status", "currentStatus", default=""),
            "timestamp": _num(_get(vehicle, "timestamp", "Timestamp")),
            "vehicle_label": (_get(veh_desc, "label", "Label", default="")
                              or _get(veh_desc, "id", "Id", default="")),
        })
    return out


def normalise_trip_updates(feed):
    """Pull route-82 trip updates (delays + per-stop predictions)."""
    out = []
    for entity in feed.get("entity", feed.get("Entity", [])) or []:
        tu = _get(entity, "trip_update", "tripUpdate", "TripUpdate", default=None)
        if not tu:
            continue
        trip = _trip_of(tu)
        if not is_route_82(trip):
            continue
        updates = []
        for stu in _get(tu, "stop_time_update", "stopTimeUpdate", default=[]) or []:
            arrival = _get(stu, "arrival", "Arrival", default={}) or {}
            departure = _get(stu, "departure", "Departure", default={}) or {}
            updates.append({
                "stop_sequence": _num(_get(stu, "stop_sequence", "stopSequence")),
                "stop_id": _get(stu, "stop_id", "stopId", default=""),
                "arrival_delay": _num(_get(arrival, "delay", "Delay")),
                "arrival_time": _num(_get(arrival, "time", "Time")),
                "departure_delay": _num(_get(departure, "delay", "Delay")),
                "departure_time": _num(_get(departure, "time", "Time")),
                "schedule_relationship": _get(stu, "schedule_relationship",
                                              "scheduleRelationship", default=""),
            })
        out.append({
            "trip_id": _get(trip, "trip_id", "tripId", default=""),
            "route_id": _get(trip, "route_id", "routeId", default=""),
            "direction_id": _get(trip, "direction_id", "directionId"),
            "start_time": _get(trip, "start_time", "startTime", default=""),
            "start_date": _get(trip, "start_date", "startDate", default=""),
            "schedule_relationship": _get(trip, "schedule_relationship",
                                          "scheduleRelationship", default=""),
            "timestamp": _num(_get(tu, "timestamp", "Timestamp")),
            "stop_time_updates": updates,
        })
    return out


# NOTE: the next stop deliberately is NOT taken from TripUpdates.
# Dublin Bus publishes sparse *historical* delay observations there - a handful
# of already-passed stops carrying a delay and usually no time at all - so its
# first entry is often many kilometres behind the bus. The client derives the
# next stop geometrically from the trip's shape instead, and uses TripUpdates
# only for punctuality.


class Handler(SimpleHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=WEB_DIR, **kwargs)

    # --- helpers -----------------------------------------------------------
    def send_json(self, payload, status=200):
        body = json.dumps(payload).encode("utf-8")
        headers = [("Content-Type", "application/json; charset=utf-8"),
                   ("Cache-Control", "no-store")]
        if len(body) > 1024 and "gzip" in self.headers.get("Accept-Encoding", ""):
            buf = io.BytesIO()
            with gzip.GzipFile(fileobj=buf, mode="wb", compresslevel=6) as gz:
                gz.write(body)
            body = buf.getvalue()
            headers.append(("Content-Encoding", "gzip"))
        self.send_response(status)
        for name, value in headers:
            self.send_header(name, value)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def send_data_file(self, name):
        """Serve the pre-built JSON from data/, gzipped."""
        path = os.path.join(DATA_DIR, name)
        if not os.path.exists(path):
            self.send_json({"error": f"{name} missing - run build_route_data.py "
                                    "then split_data.py"}, 404)
            return
        with open(path, "rb") as fh:
            body = fh.read()
        headers = [("Content-Type", "application/json; charset=utf-8"),
                   ("Cache-Control", "public, max-age=3600")]
        if "gzip" in self.headers.get("Accept-Encoding", ""):
            buf = io.BytesIO()
            with gzip.GzipFile(fileobj=buf, mode="wb", compresslevel=6) as gz:
                gz.write(body)
            body = buf.getvalue()
            headers.append(("Content-Encoding", "gzip"))
        self.send_response(200)
        for n, v in headers:
            self.send_header(n, v)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    # --- routing -----------------------------------------------------------
    def do_GET(self):
        path = self.path.split("?", 1)[0]

        if path == "/favicon.ico":
            # 1x1 transparent GIF, so the browser stops asking
            body = base64.b64decode(
                "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7")
            self.send_response(200)
            self.send_header("Content-Type", "image/gif")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "public, max-age=86400")
            self.end_headers()
            self.wfile.write(body)
            return

        if path == "/api/status":
            self.send_json({
                "has_key": bool(api_key()),
                "route_ids": sorted(ROUTE_IDS),
                "trip_count": len(TRIP_IDS),
                "server_time": int(time.time()),
            })
            return

        if path == "/api/live":
            self.handle_live()
            return

        super().do_GET()

    def handle_live(self):
        if MOCK_LIVE:
            import mock_feed
            vehicles = normalise_vehicles(mock_feed.feed("Vehicles"))
            updates = normalise_trip_updates(mock_feed.feed("TripUpdates"))
            self.send_json({
                "ok": True,
                "mock": True,
                "feed_timestamp": int(time.time()),
                "server_time": int(time.time()),
                "vehicles": vehicles,
                "trip_updates": updates,
            })
            return

        key = api_key()
        if not key:
            self.send_json({
                "ok": False,
                "reason": "no_api_key",
                "message": "No NTA API key configured. Live positions need a free key "
                           "from developer.nationaltransport.ie (GTFS-Realtime "
                           "product). Showing timetable positions instead.",
            })
            return
        try:
            vehicles_feed, veh_age = fetch_upstream("Vehicles", key)
            trips_feed, _ = fetch_upstream("TripUpdates", key)
        except RateLimited as exc:
            self.send_json({
                "ok": False, "reason": "rate_limited", "retry_after": exc.retry_after,
                "message": f"NTA API rate limit reached. Retrying in "
                           f"{exc.retry_after}s. Showing timetable positions "
                           f"meanwhile.",
            })
            return
        except urllib.error.HTTPError as exc:
            detail = ""
            try:
                detail = exc.read().decode("utf-8", "replace")[:300]
            except Exception:
                pass
            reason = "bad_api_key" if exc.code in (401, 403) else "upstream_error"
            self.send_json({"ok": False, "reason": reason, "status": exc.code,
                            "message": f"NTA API returned {exc.code}. {detail}"})
            return
        except Exception as exc:
            self.send_json({"ok": False, "reason": "upstream_error",
                            "message": f"{type(exc).__name__}: {exc}"})
            return

        vehicles = normalise_vehicles(vehicles_feed)
        updates = normalise_trip_updates(trips_feed)
        header = vehicles_feed.get("header", vehicles_feed.get("Header", {})) or {}
        self.send_json({
            "ok": True,
            "feed_timestamp": _num(_get(header, "timestamp", "Timestamp")),
            "server_time": int(time.time()),
            "cache_age": round(veh_age),
            "vehicles": vehicles,
            "trip_updates": updates,
        })

    def log_message(self, fmt, *args):
        """Quieter console. Must never raise: log_error() passes an HTTPStatus
        here, not a string, and an exception would kill the response."""
        try:
            first = str(args[0]) if args else ""
            if "/api/live" in first:
                return
            sys.stderr.write("  %s\n" % (fmt % args))
        except Exception:
            pass


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


def main():
    global MOCK_LIVE
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8082)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--mock-live", action="store_true",
                    help="serve a synthetic GTFS-R feed (for testing without a key)")
    args = ap.parse_args()
    MOCK_LIVE = args.mock_live

    load_route_ids()
    if MOCK_LIVE:
        print("  api key   : bypassed - MOCK LIVE FEED (test data, not real buses)")
    else:
        print(f"  api key   : {'found' if api_key() else 'NOT SET (timetable mode)'}")
    with Server((args.host, args.port), Handler) as httpd:
        print(f"\n  Dublin Bus 82 tracker -> http://{args.host}:{args.port}\n")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\n  stopped")


if __name__ == "__main__":
    main()
