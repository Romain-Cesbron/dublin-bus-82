/**
 * GET /api/live - the deployed equivalent of server.py's NTA GTFS-Realtime
 * proxy. Same path and same response shape, so web/app.js needs no change
 * between running locally against server.py and running on Cloudflare.
 *
 * Why a function at all: the NTA API sends no CORS headers, so a browser
 * cannot call it directly even with a key in hand. The key also has to stay
 * server-side, and here it lives in the NTA_API_KEY environment secret.
 *
 * Set it as a secret on the Worker (dashboard: Settings -> Variables and
 * Secrets -> type Secret).
 */

const GTFSR_BASE = "https://api.nationaltransport.ie/gtfsr/v2";

// Route 82's id in the national feed. Filtering on this alone is enough -
// every route-82 vehicle observed carried it - and it avoids shipping all
// 1,420 trip ids into the function.
const ROUTE_IDS = ["1 82 a"];

// The NTA free tier rate-limits hard and GTFS-R only refreshes every ~30s, so
// a longer cache costs almost no freshness and keeps us well clear of 429s.
const CACHE_SECONDS = 60;
const UPSTREAM_TIMEOUT_MS = 20000;

/** The live feed quotes numbers as strings; never int-truncate a float. */
function num(value) {
  if (value === null || value === undefined || value === "" ||
      typeof value === "boolean") return null;
  if (typeof value === "number") return value;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** GTFS-R JSON arrives snake_case or camelCase depending on the producer. */
function pick(obj, ...names) {
  if (!obj) return undefined;
  for (const n of names) {
    if (obj[n] !== null && obj[n] !== undefined) return obj[n];
  }
  return undefined;
}

function isRoute82(trip) {
  return ROUTE_IDS.includes(pick(trip, "route_id", "routeId") ?? "");
}

function normaliseVehicles(feed) {
  const out = [];
  for (const entity of feed?.entity ?? feed?.Entity ?? []) {
    const vehicle = pick(entity, "vehicle", "Vehicle");
    if (!vehicle) continue;
    const trip = pick(vehicle, "trip", "Trip") ?? {};
    if (!isRoute82(trip)) continue;

    const pos = pick(vehicle, "position", "Position") ?? {};
    const lat = num(pick(pos, "latitude", "Latitude"));
    const lon = num(pick(pos, "longitude", "Longitude"));
    if (lat === null || lon === null) continue;

    const desc = pick(vehicle, "vehicle", "Vehicle") ?? {};
    out.push({
      id: pick(entity, "id", "Id") ?? "",
      trip_id: pick(trip, "trip_id", "tripId") ?? "",
      route_id: pick(trip, "route_id", "routeId") ?? "",
      direction_id: num(pick(trip, "direction_id", "directionId")),
      start_time: pick(trip, "start_time", "startTime") ?? "",
      start_date: pick(trip, "start_date", "startDate") ?? "",
      schedule_relationship:
        pick(trip, "schedule_relationship", "scheduleRelationship") ?? "",
      lat,
      lon,
      // Dublin Bus reports position and timestamp only; the client derives
      // heading and next stop from the route geometry.
      bearing: num(pick(pos, "bearing", "Bearing")),
      speed: num(pick(pos, "speed", "Speed")),
      stop_sequence: num(pick(vehicle, "current_stop_sequence", "currentStopSequence")),
      stop_id: pick(vehicle, "stop_id", "stopId") ?? "",
      status: pick(vehicle, "current_status", "currentStatus") ?? "",
      timestamp: num(pick(vehicle, "timestamp", "Timestamp")),
      vehicle_label: pick(desc, "label", "Label") || pick(desc, "id", "Id") || "",
    });
  }
  return out;
}

function normaliseTripUpdates(feed) {
  const out = [];
  for (const entity of feed?.entity ?? feed?.Entity ?? []) {
    const tu = pick(entity, "trip_update", "tripUpdate", "TripUpdate");
    if (!tu) continue;
    const trip = pick(tu, "trip", "Trip") ?? {};
    if (!isRoute82(trip)) continue;

    const updates = [];
    for (const stu of pick(tu, "stop_time_update", "stopTimeUpdate") ?? []) {
      const arrival = pick(stu, "arrival", "Arrival") ?? {};
      const departure = pick(stu, "departure", "Departure") ?? {};
      updates.push({
        stop_sequence: num(pick(stu, "stop_sequence", "stopSequence")),
        stop_id: pick(stu, "stop_id", "stopId") ?? "",
        arrival_delay: num(pick(arrival, "delay", "Delay")),
        arrival_time: num(pick(arrival, "time", "Time")),
        departure_delay: num(pick(departure, "delay", "Delay")),
        departure_time: num(pick(departure, "time", "Time")),
        schedule_relationship:
          pick(stu, "schedule_relationship", "scheduleRelationship") ?? "",
      });
    }
    out.push({
      trip_id: pick(trip, "trip_id", "tripId") ?? "",
      route_id: pick(trip, "route_id", "routeId") ?? "",
      direction_id: num(pick(trip, "direction_id", "directionId")),
      start_time: pick(trip, "start_time", "startTime") ?? "",
      start_date: pick(trip, "start_date", "startDate") ?? "",
      schedule_relationship:
        pick(trip, "schedule_relationship", "scheduleRelationship") ?? "",
      timestamp: num(pick(tu, "timestamp", "Timestamp")),
      stop_time_updates: updates,
    });
  }
  return out;
}

function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...extraHeaders,
    },
  });
}

/**
 * Fetch one GTFS-R endpoint, going through Cloudflare's cache so repeat loads
 * (and any other visitor) are served without a fresh upstream call.
 */
async function fetchFeed(endpoint, key) {
  // Cache key must not carry the API key, so use a synthetic URL.
  const cacheKey = new Request(`https://bus82.invalid/${endpoint}`);
  const cache = caches.default;

  const hit = await cache.match(cacheKey);
  if (hit) return { payload: await hit.json(), cached: true };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  let resp;
  try {
    resp = await fetch(`${GTFSR_BASE}/${endpoint}?format=json`, {
      headers: { "x-api-key": key, Accept: "application/json" },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  if (resp.status === 429) {
    const err = new Error("rate limited");
    err.rateLimited = true;
    err.retryAfter = Number(resp.headers.get("Retry-After")) || 60;
    throw err;
  }
  if (!resp.ok) {
    const err = new Error(`upstream ${resp.status}`);
    err.status = resp.status;
    err.body = (await resp.text()).slice(0, 300);
    throw err;
  }

  const payload = await resp.json();
  await cache.put(
    cacheKey,
    new Response(JSON.stringify(payload), {
      headers: { "Cache-Control": `max-age=${CACHE_SECONDS}` },
    })
  );
  return { payload, cached: false };
}

export async function handleLive(env) {
  const key = env.NTA_API_KEY;
  if (!key) {
    return json({
      ok: false,
      reason: "no_api_key",
      message:
        "NTA_API_KEY is not set on this deployment. Add it in the Cloudflare " +
        "dashboard under Settings > Variables and Secrets, type Secret. " +
        "Showing timetable positions instead.",
    });
  }

  let vehiclesFeed, tripsFeed, cached;
  try {
    const v = await fetchFeed("Vehicles", key);
    const t = await fetchFeed("TripUpdates", key);
    vehiclesFeed = v.payload;
    tripsFeed = t.payload;
    cached = v.cached;
  } catch (err) {
    if (err.rateLimited) {
      return json({
        ok: false,
        reason: "rate_limited",
        retry_after: err.retryAfter,
        message:
          `NTA API rate limit reached. Retrying in ${err.retryAfter}s. ` +
          "Showing timetable positions meanwhile.",
      });
    }
    if (err.status === 401 || err.status === 403) {
      return json({
        ok: false,
        reason: "bad_api_key",
        status: err.status,
        message: `NTA API returned ${err.status}. ${err.body ?? ""}`,
      });
    }
    return json({
      ok: false,
      reason: "upstream_error",
      message: `${err.name}: ${err.message}`,
    });
  }

  const header = vehiclesFeed?.header ?? vehiclesFeed?.Header ?? {};
  return json({
    ok: true,
    feed_timestamp: num(pick(header, "timestamp", "Timestamp")),
    server_time: Math.floor(Date.now() / 1000),
    from_cache: cached,
    vehicles: normaliseVehicles(vehiclesFeed),
    trip_updates: normaliseTripUpdates(tripsFeed),
  });
}
