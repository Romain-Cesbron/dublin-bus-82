/* Dublin Bus 82 tracker
 *
 * Two position sources:
 *   live      - GPS from the NTA GTFS-Realtime Vehicles feed (needs an API key)
 *   timetable - where each in-service trip should be right now, interpolated
 *               along the route shape from the GTFS schedule
 */
(function () {
  "use strict";

  // The NTA free tier rate-limits hard, and the server caches upstream calls
  // for 30s, so polling faster than that only burns requests for stale data.
  var POLL_MS = 30000;
  var TIMETABLE_TICK_MS = 5000; // redraw cadence for timetable positions
  var STALE_AFTER_S = 180;      // dim a bus whose GPS fix is older than this

  // The commute this app is focused on. Stop numbers are the ones on the pole.
  // Each journey is board -> alight, and the pair must sit on the same
  // direction of the route (checked at load).
  var JOURNEYS = [
    { from: "397",  to: "2479" },   // outbound: Pearse Sq -> Grosvenor Road
    { from: "2478", to: "352"  },   // inbound:  Grosvenor Road -> Pearse Sq
  ];

  // How long a bus's current lateness is assumed to hold for. Beyond this the
  // prediction is really just the timetable again, so we say so.
  var LATENESS_TRUST_MINS = 45;

  var state = {
    route: null,
    schedule: null,            // trip_id -> [service, dir, shape, headsign, [[stop,secs]]]
    stopIndex: {},             // stop_id -> [[trip_id, dep_secs], ...] sorted
    watched: [],               // every stop in JOURNEYS (board + alight)
    boardStops: [],            // just the board stops
    journeys: [],              // resolved JOURNEYS
    shapeCache: {},            // shape_id -> { cum: [], stopIdx: {} }
    mode: "pending",           // live | timetable | error
    vehicles: [],
    tripUpdates: {},           // trip_id -> update
    direction: "all",
    selected: null,            // { kind: 'bus'|'stop', id }
    lastUpdate: null,
    feedTimestamp: null,
    statusMessage: "",
  };

  var map, layers = {}, busMarkers = {}, stopMarkers = {};

  // ---------------------------------------------------------------- utils
  function $(sel) { return document.querySelector(sel); }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function pad(n) { return (n < 10 ? "0" : "") + n; }

  function secsToClock(secs) {
    var s = ((secs % 86400) + 86400) % 86400;
    return pad(Math.floor(s / 3600)) + ":" + pad(Math.floor(s / 60) % 60);
  }

  /** Seconds since midnight in Europe/Dublin, plus the local date parts. */
  function dublinNow() {
    var fmt = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/Dublin", hour12: false,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
      weekday: "short",
    });
    var parts = {};
    fmt.formatToParts(new Date()).forEach(function (p) { parts[p.type] = p.value; });
    var hour = parseInt(parts.hour, 10) % 24;
    return {
      secs: hour * 3600 + parseInt(parts.minute, 10) * 60 + parseInt(parts.second, 10),
      ymd: parts.year + parts.month + parts.day,
      weekdayIdx: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(parts.weekday),
      clock: parts.hour + ":" + parts.minute,
    };
  }

  function shiftYmd(ymd, days) {
    var d = new Date(Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8)));
    d.setUTCDate(d.getUTCDate() + days);
    return "" + d.getUTCFullYear() + pad(d.getUTCMonth() + 1) + pad(d.getUTCDate());
  }

  function relativeTime(unixSecs) {
    if (!unixSecs) return "—";
    var age = Math.round(Date.now() / 1000 - unixSecs);
    if (age < 0) age = 0;
    if (age < 60) return age + "s ago";
    if (age < 3600) return Math.floor(age / 60) + "m ago";
    return Math.floor(age / 3600) + "h ago";
  }

  function formatWait(mins) {
    if (mins <= 0) return "due";
    if (mins < 60) return mins + " min";
    return Math.floor(mins / 60) + "h " + (mins % 60) + "m";
  }

  function delayBadge(delaySecs) {
    if (delaySecs == null) return "";
    var mins = Math.round(delaySecs / 60);
    if (mins <= -2) return '<span class="badge-delay delay-early">' + Math.abs(mins) + "m early</span>";
    if (mins >= 2) return '<span class="badge-delay delay-late">' + mins + "m late</span>";
    return '<span class="badge-delay delay-ontime">on time</span>';
  }

  // ------------------------------------------------------------- geometry
  function metresBetween(a, b) {
    var dLat = (b[0] - a[0]) * 111320;
    var dLon = (b[1] - a[1]) * 111320 * Math.cos(a[0] * Math.PI / 180);
    return Math.sqrt(dLat * dLat + dLon * dLon);
  }

  function bearingBetween(a, b) {
    var y = Math.sin((b[1] - a[1]) * Math.PI / 180) * Math.cos(b[0] * Math.PI / 180);
    var x = Math.cos(a[0] * Math.PI / 180) * Math.sin(b[0] * Math.PI / 180) -
            Math.sin(a[0] * Math.PI / 180) * Math.cos(b[0] * Math.PI / 180) *
            Math.cos((b[1] - a[1]) * Math.PI / 180);
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  }

  /** Cumulative distances along a shape + each stop's nearest vertex index. */
  function shapeInfo(shapeId) {
    if (state.shapeCache[shapeId]) return state.shapeCache[shapeId];
    var pts = state.route.shapes[shapeId];
    if (!pts || pts.length < 2) return null;
    var cum = [0];
    for (var i = 1; i < pts.length; i++) cum.push(cum[i - 1] + metresBetween(pts[i - 1], pts[i]));
    var info = { pts: pts, cum: cum, stopIdx: {} };
    state.shapeCache[shapeId] = info;
    return info;
  }

  function stopVertexIndex(info, stopId) {
    if (info.stopIdx[stopId] != null) return info.stopIdx[stopId];
    var stop = state.route.stops[stopId];
    if (!stop) return (info.stopIdx[stopId] = -1);
    var target = [stop.lat, stop.lon], best = -1, bestD = Infinity;
    for (var i = 0; i < info.pts.length; i++) {
      var d = metresBetween(info.pts[i], target);
      if (d < bestD) { bestD = d; best = i; }
    }
    return (info.stopIdx[stopId] = best);
  }

  /**
   * Heading of the route itself at the point nearest a position.
   * Dublin Bus vehicles don't report bearing, so derive it from the shape the
   * trip follows. Returns null if we don't know the trip's shape.
   */
  function bearingFromShape(lat, lon, tripId) {
    var trip = state.schedule && state.schedule[tripId];
    if (!trip) return null;
    var info = shapeInfo(trip[2]);
    if (!info) return null;
    var here = [lat, lon], best = -1, bestD = Infinity;
    for (var i = 0; i < info.pts.length; i++) {
      var d = metresBetween(info.pts[i], here);
      if (d < bestD) { bestD = d; best = i; }
    }
    if (best < 0 || bestD > 400) return null;   // too far off-route to trust
    var a = info.pts[Math.max(best - 1, 0)];
    var b = info.pts[Math.min(best + 1, info.pts.length - 1)];
    if (a === b) return null;
    return bearingBetween(a, b);
  }

  /**
   * The stop a bus is heading for, worked out from how far along the route
   * shape it has got. The live TripUpdates feed cannot be used for this: it
   * carries sparse *historical* delay observations, so its first entry is
   * often kilometres behind the bus (see the note in server.py).
   */
  function nextStopFromPosition(lat, lon, tripId) {
    var trip = state.schedule && state.schedule[tripId];
    if (!trip) return null;
    var info = shapeInfo(trip[2]);
    if (!info) return null;
    var here = [lat, lon], best = -1, bestD = Infinity;
    for (var i = 0; i < info.pts.length; i++) {
      var d = metresBetween(info.pts[i], here);
      if (d < bestD) { bestD = d; best = i; }
    }
    if (best < 0 || bestD > 500) return null;      // too far off-route to trust
    var along = info.cum[best];
    var stops = trip[4];
    for (var j = 0; j < stops.length; j++) {
      var idx = stopVertexIndex(info, stops[j][0]);
      // 20m of slack so a bus sitting at a stop reports the one after it
      if (idx >= 0 && info.cum[idx] > along + 20) return stops[j][0];
    }
    return stops.length ? stops[stops.length - 1][0] : null;
  }

  /** Point `frac` of the way along a shape between two stops. */
  function pointAlongShape(shapeId, stopA, stopB, frac) {
    var info = shapeInfo(shapeId);
    if (!info) return null;
    var iA = stopVertexIndex(info, stopA), iB = stopVertexIndex(info, stopB);
    if (iA < 0 || iB < 0 || iB <= iA) return null;   // loop/odd ordering: caller falls back
    var target = info.cum[iA] + (info.cum[iB] - info.cum[iA]) * frac;
    var lo = iA;
    while (lo < iB && info.cum[lo + 1] < target) lo++;
    var segLen = info.cum[lo + 1] - info.cum[lo];
    var t = segLen > 0 ? (target - info.cum[lo]) / segLen : 0;
    var p0 = info.pts[lo], p1 = info.pts[Math.min(lo + 1, info.pts.length - 1)];
    return {
      lat: p0[0] + (p1[0] - p0[0]) * t,
      lon: p0[1] + (p1[1] - p0[1]) * t,
      bearing: bearingBetween(p0, p1),
    };
  }

  // ------------------------------------------------------------- schedule
  var serviceCache = {};

  function activeServiceIds(ymd, weekdayIdx) {
    var cacheKey = ymd + ":" + weekdayIdx;
    if (serviceCache[cacheKey]) return serviceCache[cacheKey];
    var cal = state.route.calendar, exc = state.route.calendar_exceptions || {};
    var active = {};
    Object.keys(cal).forEach(function (sid) {
      var c = cal[sid];
      if (ymd >= c.start_date && ymd <= c.end_date && c.days[weekdayIdx] === 1) active[sid] = true;
    });
    Object.keys(exc).forEach(function (sid) {
      (exc[sid] || []).forEach(function (e) {
        if (e.date !== ymd) return;
        if (e.type === 1) active[sid] = true;
        if (e.type === 2) delete active[sid];
      });
    });
    serviceCache[cacheKey] = active;
    return active;
  }

  /**
   * Buses that should be running right now according to the timetable.
   * Checks today's service plus yesterday's (for trips running past midnight,
   * which GTFS encodes as 24:xx / 25:xx).
   */
  function timetablePositions() {
    if (!state.schedule) return [];
    var now = dublinNow();
    var windows = [
      { ymd: now.ymd, wd: now.weekdayIdx, secs: now.secs },
      { ymd: shiftYmd(now.ymd, -1), wd: (now.weekdayIdx + 6) % 7, secs: now.secs + 86400 },
    ];
    var out = [];
    windows.forEach(function (w) {
      var active = activeServiceIds(w.ymd, w.wd);
      Object.keys(state.schedule).forEach(function (tripId) {
        var t = state.schedule[tripId];
        if (!active[t[0]]) return;
        var stops = t[4];
        if (stops.length < 2) return;
        if (w.secs < stops[0][1] || w.secs > stops[stops.length - 1][1]) return;

        var i = 0;
        while (i < stops.length - 2 && stops[i + 1][1] <= w.secs) i++;
        var span = stops[i + 1][1] - stops[i][1];
        var frac = span > 0 ? (w.secs - stops[i][1]) / span : 0;
        frac = Math.max(0, Math.min(1, frac));

        var p = pointAlongShape(t[2], stops[i][0], stops[i + 1][0], frac);
        if (!p) {
          var a = state.route.stops[stops[i][0]], b = state.route.stops[stops[i + 1][0]];
          if (!a || !b) return;
          p = {
            lat: a.lat + (b.lat - a.lat) * frac,
            lon: a.lon + (b.lon - a.lon) * frac,
            bearing: bearingBetween([a.lat, a.lon], [b.lat, b.lon]),
          };
        }
        out.push({
          id: "sched:" + tripId,
          trip_id: tripId,
          direction_id: t[1],
          headsign: t[3],
          lat: p.lat, lon: p.lon, bearing: p.bearing,
          stop_id: stops[i + 1][0],
          stop_sequence: i + 2,
          start_secs: stops[0][1],
          end_secs: stops[stops.length - 1][1],
          synthetic: true,
        });
      });
    });
    return out;
  }

  function buildStopIndex() {
    var idx = {};
    Object.keys(state.schedule).forEach(function (tripId) {
      var stops = state.schedule[tripId][4];
      for (var i = 0; i < stops.length; i++) {
        (idx[stops[i][0]] || (idx[stops[i][0]] = [])).push([tripId, stops[i][1]]);
      }
    });
    Object.keys(idx).forEach(function (s) { idx[s].sort(function (a, b) { return a[1] - b[1]; }); });
    state.stopIndex = idx;
  }

  function nextDepartures(stopId, limit) {
    var now = dublinNow();
    var active = activeServiceIds(now.ymd, now.weekdayIdx);
    var entries = state.stopIndex[stopId] || [];
    var out = [];
    for (var i = 0; i < entries.length && out.length < limit; i++) {
      var tripId = entries[i][0], secs = entries[i][1];
      if (secs < now.secs) continue;
      var t = state.schedule[tripId];
      if (!active[t[0]]) continue;
      var live = state.tripUpdates[tripId];
      var delay = null;
      if (live) {
        (live.stop_time_updates || []).forEach(function (stu) {
          if (stu.stop_id === stopId) {
            var d = stu.departure_delay != null ? stu.departure_delay : stu.arrival_delay;
            if (d != null) delay = d;
          }
        });
      }
      out.push({
        trip_id: tripId, secs: secs, headsign: t[3], direction_id: t[1],
        mins: Math.round((secs - now.secs) / 60), delay: delay,
      });
    }
    return out;
  }

  // ------------------------------------------------------------ prediction

  /** Where a position sits along a trip's shape, and how far off-route it is. */
  function alongForPosition(tripId, lat, lon) {
    var trip = state.schedule && state.schedule[tripId];
    if (!trip) return null;
    var info = shapeInfo(trip[2]);
    if (!info) return null;
    var here = [lat, lon], best = -1, bestD = Infinity;
    for (var i = 0; i < info.pts.length; i++) {
      var d = metresBetween(info.pts[i], here);
      if (d < bestD) { bestD = d; best = i; }
    }
    if (best < 0) return null;
    return { along: info.cum[best], offRoute: bestD, info: info };
  }

  function alongForStop(info, stopId) {
    var idx = stopVertexIndex(info, stopId);
    return idx >= 0 ? info.cum[idx] : null;
  }

  /** The scheduled clock time (secs) at a given distance along a trip. */
  function schedSecsAtAlong(tripId, info, along) {
    var stops = state.schedule[tripId][4];
    var prev = null;
    for (var i = 0; i < stops.length; i++) {
      var c = alongForStop(info, stops[i][0]);
      if (c == null) continue;
      if (prev && prev.c <= along && along <= c) {
        var f = (along - prev.c) / Math.max(c - prev.c, 1);
        return prev.t + (stops[i][1] - prev.t) * f;
      }
      prev = { c: c, t: stops[i][1] };
    }
    return null;
  }

  /**
   * How late a tracked bus is, in seconds (positive = late).
   * Prefers the operator's own figure; otherwise compares the bus's GPS
   * position against where the timetable says it should be by now. The two
   * agree to about a minute, so either is a sound basis for a prediction.
   */
  function busLateness(bus) {
    if (bus.delay != null) return { secs: bus.delay, source: "feed" };
    var p = alongForPosition(bus.trip_id, bus.lat, bus.lon);
    if (!p || p.offRoute > 500) return null;
    var sched = schedSecsAtAlong(bus.trip_id, p.info, p.along);
    if (sched == null) return null;
    var secs = dublinNow().secs - sched;
    if (Math.abs(secs) > 3 * 3600) return null;      // nonsense, ignore
    return { secs: secs, source: "position" };
  }

  /**
   * Predicted departures for one journey.
   *
   * For every trip that serves board-then-alight today, look for the bus
   * actually running it. If that bus is tracked and has not passed the board
   * stop yet, shift the whole trip by its current lateness. Trips with no bus
   * on them yet fall back to the timetable and are labelled as such.
   */
  function predictJourney(journey, limit) {
    if (!state.schedule || !journey.fromId || !journey.toId) return [];
    var now = dublinNow();
    var active = activeServiceIds(now.ymd, now.weekdayIdx);

    var live = {};
    if (state.mode === "live") {
      allBuses().forEach(function (b) {
        if (b.trip_id && !b.synthetic) live[b.trip_id] = b;
      });
    }

    var out = [], seen = {};
    Object.keys(state.schedule).forEach(function (tripId) {
      var t = state.schedule[tripId];
      if (!active[t[0]]) return;
      var stops = t[4], iFrom = -1, iTo = -1;
      for (var i = 0; i < stops.length; i++) {
        if (iFrom < 0) { if (stops[i][0] === journey.fromId) iFrom = i; }
        else if (stops[i][0] === journey.toId) { iTo = i; break; }
      }
      if (iFrom < 0 || iTo < 0) return;

      var schedDep = stops[iFrom][1], schedArr = stops[iTo][1];
      var bus = live[tripId] || null;
      var lateness = null, delaySecs = 0, gone = false;

      if (bus) {
        var lat = busLateness(bus);
        if (lat) { lateness = lat; delaySecs = lat.secs; }
        var p = alongForPosition(tripId, bus.lat, bus.lon);
        var fromAlong = p ? alongForStop(p.info, journey.fromId) : null;
        // 30m of slack so a bus pulling into the stop still counts as coming
        if (p && fromAlong != null && p.along > fromAlong + 30) gone = true;
      }
      if (gone) return;

      var predDep = schedDep + delaySecs;
      if (predDep < now.secs - 60) return;                 // already departed

      // A lateness reading is only worth applying while it is fresh and the
      // departure is near enough that the bus is unlikely to recover.
      var staleFix = !!(bus && bus.timestamp &&
                        (Date.now() / 1000 - bus.timestamp) > STALE_AFTER_S);
      var farOut = (schedDep - now.secs) > LATENESS_TRUST_MINS * 60;
      if (farOut) { delaySecs = 0; lateness = null; }
      predDep = schedDep + delaySecs;

      // collapse duplicate timetable entries (same departure, several
      // service ids); keep whichever one has a real bus attached
      var key = schedDep;
      if (seen[key] != null) {
        var kept = out[seen[key]];
        if (!kept.bus && bus) out[seen[key]] = makeRow();
        return;
      }
      seen[key] = out.length;
      out.push(makeRow());

      function makeRow() {
        return {
          trip_id: tripId,
          sched_dep: schedDep,
          sched_arr: schedArr,
          pred_dep: predDep,
          pred_arr: schedArr + delaySecs,
          mins: Math.round((predDep - now.secs) / 60),
          ride_mins: Math.round((schedArr - schedDep) / 60),
          delay: lateness ? lateness.secs : null,
          delay_source: lateness ? lateness.source : null,
          bus: bus,
          live: !!bus,
          stale_fix: staleFix,
        };
      }
    });

    out.sort(function (a, b) { return a.pred_dep - b.pred_dep; });
    return out.slice(0, limit);
  }

  // ---------------------------------------------------------------- data
  function getJSON(url) {
    return fetch(url, { cache: "no-store" }).then(function (r) {
      if (!r.ok) throw new Error(url + " -> HTTP " + r.status);
      return r.json();
    });
  }

  function loadStatic() {
    return getJSON("data/route.json").then(function (route) {
      state.route = route;
      resolveWatched();
      drawRoute();
      drawStops();
      renderStopList();
      $("#route-name").textContent = "Dublin Bus " + route.route.short_name;
      $("#route-sub").textContent = route.route.long_name;
      $("#stop-search").placeholder = "Search " + Object.keys(route.stops).length + " stops…";
      $("#legend-out").textContent = route.patterns["0"] ? route.patterns["0"].headsign : "";
      $("#legend-in").textContent = route.patterns["1"] ? route.patterns["1"].headsign : "";
      // Name the destinations in the direction picker rather than bare arrows.
      ["0", "1"].forEach(function (d) {
        var opt = $('#direction-filter option[value="' + d + '"]');
        var p = route.patterns[d];
        if (opt && p) opt.textContent = (d === "0" ? "Outbound" : "Inbound") + " — to " + p.headsign;
      });
      $("#feed-date").textContent = "(built " + route.generated_at_utc.slice(0, 10) + ")";
      return getJSON("data/schedule.json");
    }).then(function (schedule) {
      state.schedule = schedule;
      buildStopIndex();
      renderStopList();   // re-render: the first pass had no departure times yet
      renderJourneys();
    });
  }

  function poll() {
    return getJSON("/api/live").then(function (res) {
      if (res.ok) {
        state.mode = "live";
        state.vehicles = res.vehicles;
        state.feedTimestamp = res.feed_timestamp;
        state.tripUpdates = {};
        (res.trip_updates || []).forEach(function (u) { state.tripUpdates[u.trip_id] = u; });
        state.mock = !!res.mock;
        state.statusMessage = (res.mock ? "MOCK feed · " : "") + (res.vehicles.length
          ? "Live GPS · " + res.vehicles.length + " bus" + (res.vehicles.length === 1 ? "" : "es") + " on route"
          : "Live feed connected · no 82s reporting right now");
      } else if (res.reason === "no_api_key") {
        state.mode = "timetable";
        state.statusMessage = "Timetable mode — add an NTA key for live GPS";
      } else if (res.reason === "rate_limited") {
        state.mode = "timetable";
        state.statusMessage = "NTA rate limit — live GPS resumes in " +
                              (res.retry_after || 60) + "s";
      } else {
        state.mode = "error";
        state.statusMessage = res.message || "Live feed unavailable";
      }
      state.lastUpdate = Date.now();
      render();
    }).catch(function (err) {
      state.mode = "error";
      state.statusMessage = "Server unreachable: " + err.message;
      render();
    });
  }

  /** Every bus we know about, before any direction filter. */
  function allBuses() {
    var list;
    if (state.mode === "live" && state.vehicles.length) {
      list = state.vehicles.map(function (v) {
        var t = state.schedule && state.schedule[v.trip_id];
        var update = state.tripUpdates[v.trip_id];
        var delay = null;
        if (update) {
          // Entries are ordered by stop_sequence and are mostly stops already
          // passed, so the LAST one with a delay is the freshest reading.
          var stus = update.stop_time_updates || [];
          for (var i = stus.length - 1; i >= 0; i--) {
            var d = stus[i].arrival_delay != null ? stus[i].arrival_delay : stus[i].departure_delay;
            if (d != null) { delay = d; break; }
          }
        }
        return {
          id: v.id || ("trip:" + v.trip_id),
          trip_id: v.trip_id,
          direction_id: v.direction_id != null ? v.direction_id : (t ? t[1] : null),
          headsign: t ? t[3] : (v.direction_id === 1 ? "Inbound" : "Outbound"),
          lat: v.lat, lon: v.lon,
          bearing: v.bearing != null ? v.bearing
                                     : bearingFromShape(v.lat, v.lon, v.trip_id),
          bearing_derived: v.bearing == null,
          speed: v.speed,
          stop_id: v.stop_id || nextStopFromPosition(v.lat, v.lon, v.trip_id) || "",
          stop_sequence: v.stop_sequence,
          status: v.status,
          timestamp: v.timestamp,
          label: v.vehicle_label,
          start_time: v.start_time,
          delay: delay,
          synthetic: false,
        };
      });
    } else if (state.mode === "live") {
      list = [];
    } else {
      list = timetablePositions();
    }
    return list;
  }

  /** Buses to draw right now, honouring the direction filter. */
  function currentBuses() {
    var list = allBuses();
    if (state.direction !== "all") {
      list = list.filter(function (b) { return String(b.direction_id) === state.direction; });
    }
    return list;
  }

  // ----------------------------------------------------------------- map
  function initMap() {
    map = L.map("map", { zoomControl: true, preferCanvas: true }).setView([53.3365, -6.29], 12);
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors · schedule &amp; live data: Transport for Ireland / NTA',
    }).addTo(map);
    layers.shapes = L.layerGroup().addTo(map);
    layers.stops = L.layerGroup().addTo(map);
    layers.buses = L.layerGroup().addTo(map);

    map.on("zoomend", function () {
      Object.keys(stopMarkers).forEach(function (id) {
        stopMarkers[id].setRadius(radiusFor(id));
      });
    });
  }

  function drawRoute() {
    layers.shapes.clearLayers();
    var bounds = [];
    ["0", "1"].forEach(function (dir) {
      var pattern = state.route.patterns[dir];
      if (!pattern) return;
      var pts = state.route.shapes[pattern.shape_id];
      if (!pts) return;
      L.polyline(pts, {
        color: dir === "0" ? "#ffb500" : "#38bdf8",
        weight: 4, opacity: 0.8,
        dashArray: dir === "1" ? "1 0" : null,
      }).addTo(layers.shapes);
      bounds = bounds.concat(pts);
    });
    if (bounds.length) {
      state.routeBounds = L.latLngBounds(bounds);
      fitRoute();
    }
  }

  /** Fit the whole route, once the map container actually has a size. */
  function fitRoute() {
    if (!state.routeBounds) return;
    map.invalidateSize({ animate: false });
    var size = map.getSize();
    if (size.x < 50 || size.y < 50) {         // not laid out yet - try next frame
      requestAnimationFrame(fitRoute);
      return;
    }
    map.fitBounds(state.routeBounds, { padding: [40, 40], animate: false });
  }

  function isWatched(stopId) { return state.watched.indexOf(stopId) >= 0; }

  /** Resolve the configured journeys to stop_ids and sanity-check them. */
  function resolveWatched() {
    var byCode = {};
    Object.keys(state.route.stops).forEach(function (id) {
      var code = String(state.route.stops[id].code || "");
      if (code) byCode[code] = id;
    });

    state.journeys = JOURNEYS.map(function (j) {
      var fromId = byCode[String(j.from)], toId = byCode[String(j.to)];
      if (!fromId || !toId) {
        console.warn("journey stop not on route 82:", j);
        return null;
      }
      var dir = stopDirection(fromId);
      if (stopDirection(toId) !== dir) {
        console.warn("journey stops are on opposite directions:", j);
      }
      return {
        fromId: fromId, toId: toId, direction: dir,
        fromName: state.route.stops[fromId].name,
        toName: state.route.stops[toId].name,
        fromCode: j.from, toCode: j.to,
      };
    }).filter(Boolean);

    state.boardStops = state.journeys.map(function (j) { return j.fromId; });
    // Highlight only the poles you actually wait at. Each place has a pole per
    // direction, so the alight poles are the same two locations about 40m
    // across the road - marking them too would just double up the map.
    state.watched = state.boardStops.filter(function (id, i, a) {
      return a.indexOf(id) === i;
    });
  }

  function isBoardStop(stopId) { return (state.boardStops || []).indexOf(stopId) >= 0; }

  function radiusFor(stopId) {
    return isWatched(stopId) ? Math.max(stopRadius() + 4, 9) : stopRadius();
  }

  function stopDirection(stopId) {
    var p0 = state.route.patterns["0"];
    if (p0 && (p0.stop_ids.indexOf(stopId) >= 0 || p0.variant_stop_ids.indexOf(stopId) >= 0)) return 0;
    return 1;
  }

  /** Stops crowd together at city-wide zooms, so shrink them. */
  function stopRadius() {
    var z = map.getZoom();
    if (z <= 11) return 2;
    if (z <= 12) return 2.5;
    if (z <= 13) return 3.5;
    if (z <= 15) return 4.5;
    return 6;
  }

  function drawStops() {
    layers.stops.clearLayers();
    stopMarkers = {};
    var r = stopRadius();
    var ids = Object.keys(state.route.stops);
    ids.forEach(function (id) {
      var s = state.route.stops[id];
      var dir = stopDirection(id);
      var watched = isWatched(id);
      var m = L.circleMarker([s.lat, s.lon], {
        radius: watched ? Math.max(r + 4, 9) : r,
        weight: watched ? 3 : 2,
        color: watched ? "#ff5fa2" : (dir === 0 ? "#ffb500" : "#38bdf8"),
        fillColor: watched ? "#2a0d1c" : "#0e1116",
        fillOpacity: 1,
      });
      if (watched) {
        // interactive:true lets the label itself take clicks and forward them
        // to the marker, so tapping the name opens the stop's timetable panel
        m.bindTooltip(s.name + " · " + (s.code || id),
                      { permanent: true, direction: "top",
                        className: "stop-label", offset: [0, -8],
                        interactive: true });
      }
      // maxHeight caps the popup so Leaflet's auto-pan doesn't shove the stop
      // off the bottom of a short map pane
      m.bindPopup(function () { return stopPopup(id); },
                  { minWidth: 272, maxWidth: 272, maxHeight: 240,
                    autoPanPadding: [12, 12] });
      m.on("click", function () { select("stop", id); });
      m._dirId = dir;
      m._watched = watched;
      m.addTo(layers.stops);
      stopMarkers[id] = m;
    });
    applyStopFilter();
  }

  function applyStopFilter() {
    var show = $("#toggle-stops").checked;
    Object.keys(stopMarkers).forEach(function (id) {
      var m = stopMarkers[id];
      // Watched stops stay on the map regardless of filters.
      var visible = m._watched ||
                    (show && (state.direction === "all" || String(m._dirId) === state.direction));
      if (visible && !layers.stops.hasLayer(m)) layers.stops.addLayer(m);
      if (!visible && layers.stops.hasLayer(m)) layers.stops.removeLayer(m);
    });
  }

  function busIcon(bus, selected) {
    var dir = bus.direction_id === 1 ? 1 : 0;
    var stale = !bus.synthetic && bus.timestamp &&
                (Date.now() / 1000 - bus.timestamp) > STALE_AFTER_S;
    var cls = "bus-marker" + (stale ? " is-stale" : "") + (selected ? " is-selected" : "");
    var arrow = bus.bearing != null
      ? '<i class="bus-arrow dir-' + dir + '" style="transform:translateX(-50%) rotate(' +
        Math.round(bus.bearing) + 'deg)"></i>'
      : "";
    return L.divIcon({
      className: "",
      html: '<div class="' + cls + '" style="position:relative">' + arrow +
            '<div class="bus-dot dir-' + dir + '">82</div></div>',
      iconSize: [24, 24], iconAnchor: [12, 12],
    });
  }

  function drawBuses(buses) {
    var seen = {};
    buses.forEach(function (bus) {
      seen[bus.id] = true;
      var selected = state.selected && state.selected.kind === "bus" && state.selected.id === bus.id;
      var m = busMarkers[bus.id];
      if (!m) {
        m = L.marker([bus.lat, bus.lon], {
          icon: busIcon(bus, selected), zIndexOffset: 1000, riseOnHover: true,
        });
        m.bindPopup(function () { return busPopup(bus.id); }, { minWidth: 272, maxWidth: 272 });
        m.on("click", function () { select("bus", bus.id); });
        m.addTo(layers.buses);
        busMarkers[bus.id] = m;
      } else {
        m.setLatLng([bus.lat, bus.lon]);
        m.setIcon(busIcon(bus, selected));
      }
      m._bus = bus;
      if (m.isPopupOpen()) m.setPopupContent(busPopup(bus.id));
    });
    Object.keys(busMarkers).forEach(function (id) {
      if (!seen[id]) { layers.buses.removeLayer(busMarkers[id]); delete busMarkers[id]; }
    });
    if ($("#toggle-follow").checked && buses.length) {
      // Only cap the zoom for a single bus - otherwise the cap stops the map
      // from actually fitting a fleet spread across the whole route.
      map.fitBounds(L.latLngBounds(buses.map(function (b) { return [b.lat, b.lon]; })),
                    buses.length === 1 ? { padding: [60, 60], maxZoom: 15 }
                                       : { padding: [50, 50] });
    }
  }

  // -------------------------------------------------------------- popups
  function busPopup(busId) {
    var m = busMarkers[busId];
    if (!m || !m._bus) return "<div class='pop'>—</div>";
    var bus = m._bus;
    var dir = bus.direction_id === 1 ? 1 : 0;
    var nextStop = bus.stop_id && state.route.stops[bus.stop_id];
    var rows = [];

    if (bus.synthetic) {
      rows.push(["Trip started", secsToClock(bus.start_secs)]);
      rows.push(["Due to finish", secsToClock(bus.end_secs)]);
    } else {
      if (bus.label) rows.push(["Vehicle", esc(bus.label)]);
      if (bus.start_time) rows.push(["Trip started", esc(bus.start_time.slice(0, 5))]);
      if (bus.speed != null) rows.push(["Speed", Math.round(bus.speed * 3.6) + " km/h"]);
      if (bus.bearing != null) {
        rows.push(["Heading", Math.round(bus.bearing) + "°" +
                   (bus.bearing_derived ? " <span class='muted'>(from route)</span>" : "")]);
      }
      rows.push(["GPS fix", relativeTime(bus.timestamp)]);
      if (bus.delay != null) rows.push(["Punctuality", delayBadge(bus.delay)]);
    }
    if (nextStop) rows.push([bus.synthetic ? "Heading to" : "Next stop", esc(nextStop.name)]);

    return '<div class="pop">' +
      '<div class="pop-head"><div class="pop-badge dir-' + dir + '">82</div><div>' +
        '<div class="pop-title">' + esc(bus.headsign || "Route 82") + '</div>' +
        '<div class="pop-sub">' + (bus.synthetic ? "Timetable position" : "Live GPS") +
          ' · trip ' + esc(String(bus.trip_id).slice(-8)) + '</div>' +
      '</div></div>' +
      '<dl>' + rows.map(function (r) {
        return "<dt>" + r[0] + "</dt><dd>" + r[1] + "</dd>";
      }).join("") + '</dl>' +
      (bus.synthetic
        ? '<div class="pop-note">Interpolated from the published timetable, not a GPS fix.</div>'
        : "") +
      '</div>';
  }

  function stopPopup(stopId) {
    var s = state.route.stops[stopId];
    if (!s) return "<div class='pop'>—</div>";
    var dir = stopDirection(stopId);
    var deps = state.schedule ? nextDepartures(stopId, 6) : [];
    var body = deps.length
      ? deps.map(function (d) {
          var when = formatWait(d.mins);
          return '<div class="pop-time"><span>' + esc(d.headsign) + "</span><span>" +
                 secsToClock(d.secs) + " · " + when +
                 (d.delay != null ? " " + delayBadge(d.delay) : "") + "</span></div>";
        }).join("")
      : '<div class="pop-sub">No more departures scheduled today.</div>';

    return '<div class="pop">' +
      '<div class="pop-head"><div class="pop-badge dir-' + dir + '">◉</div><div>' +
        '<div class="pop-title">' + esc(s.name) + '</div>' +
        '<div class="pop-sub">Stop ' + esc(s.code || s.id) +
          ' · ' + (dir === 0 ? "outbound" : "inbound") + '</div>' +
      '</div></div>' +
      '<div class="pop-section-title">Next 82s</div>' +
      '<div class="pop-times">' + body + "</div>" +
      (state.mode === "live"
        ? ""
        : '<div class="pop-note">Scheduled times. Live predictions appear once an NTA key is set.</div>') +
      '</div>';
  }

  // ------------------------------------------------------------ rendering
  function render() {
    var buses = currentBuses();
    drawBuses(buses);
    renderStatus(buses);
    renderBusList(buses);
    renderJourneys();
  }

  function renderStatus(buses) {
    var bar = $("#status-bar");
    var cls = { live: "status--live", timetable: "status--sched", error: "status--error" };
    bar.className = "status " + (cls[state.mode] || "status--pending");
    $("#status-text").textContent = state.statusMessage || "…";
    $("#bus-count-pill").textContent = buses.length;

    var badge = $("#mode-badge");
    if (state.mode === "live") {
      badge.innerHTML = "<strong>" + (state.mock ? "Mock GPS feed" : "Live GPS") +
                        "</strong> · feed " + relativeTime(state.feedTimestamp);
    } else if (state.mode === "timetable") {
      badge.innerHTML = "<strong>Timetable positions</strong> · " + dublinNow().clock + " Dublin";
    } else {
      // Still drawing timetable positions, so say that rather than "offline".
      badge.innerHTML = "<strong>Live feed unavailable</strong> · timetable positions";
    }
    $("#last-update").textContent = state.lastUpdate
      ? "Updated " + relativeTime(Math.round(state.lastUpdate / 1000))
      : "—";
  }

  /** The commute view: predicted departures for each configured journey. */
  function renderJourneys() {
    var host = $("#journeys");
    if (!host) return;
    host.innerHTML = "";

    if (!state.journeys.length) {
      host.innerHTML = '<div class="empty"><strong>No journeys configured</strong>'
        + 'Set JOURNEYS at the top of app.js.</div>';
      return;
    }

    state.journeys.forEach(function (j) {
      var card = el("div", "jcard");

      var head = el("div", "jcard-head");
      var route = el("div", "jcard-route");
      route.innerHTML = esc(j.fromName) + ' <span class="jarrow">→</span> ' + esc(j.toName);
      head.appendChild(route);
      head.appendChild(el("div", "jcard-sub",
        "Stop " + j.fromCode + " → " + j.toCode + " · " +
        (j.direction === 0 ? "outbound" : "inbound")));
      card.appendChild(head);

      var rows = predictJourney(j, 4);
      if (!rows.length) {
        card.appendChild(el("div", "jempty", "No more buses on this journey today."));
        host.appendChild(card);
        return;
      }

      rows.forEach(function (r, idx) {
        var row = el("div", "jrow" + (idx === 0 ? " is-next" : ""));

        var when = el("div", "jwhen");
        when.appendChild(el("div", "jmins", formatWait(r.mins)));
        when.appendChild(el("div", "jclock", secsToClock(r.pred_dep)));
        row.appendChild(when);

        var mid = el("div", "jmid");

        var line1 = el("div", "jline");
        if (r.live) {
          var shifted = Math.abs(r.pred_dep - r.sched_dep) >= 60;
          line1.innerHTML =
            '<span class="jtag jtag-live">live</span>' +
            (r.bus.label ? '<span class="jveh">bus ' + esc(r.bus.label) + "</span>" : "") +
            (r.delay != null
              ? " " + delayBadge(r.delay)
              : '<span class="jveh jveh-dim">no delay reading yet</span>') +
            (shifted ? '<span class="jsched">timetable ' + secsToClock(r.sched_dep) + "</span>" : "");
        } else {
          line1.innerHTML =
            '<span class="jtag jtag-sched">timetable</span>' +
            '<span class="jveh">no bus tracked yet</span>';
        }
        mid.appendChild(line1);

        mid.appendChild(el("div", "jline jline-2",
          "arrives " + j.toName + " ~" + secsToClock(r.pred_arr) +
          "  ·  " + r.ride_mins + " min ride" +
          (r.stale_fix ? "  ·  stale GPS fix" : "")));
        row.appendChild(mid);

        if (r.bus) {
          row.addEventListener("click", function () {
            var marker = busMarkers[r.bus.id];
            select("bus", r.bus.id);
            map.setView([r.bus.lat, r.bus.lon], Math.max(map.getZoom(), 15));
            if (marker) marker.openPopup();
          });
          row.classList.add("is-clickable");
        }
        card.appendChild(row);
      });

      host.appendChild(card);
    });
  }

  function renderBusList(buses) {
    var host = $("#bus-list");
    host.innerHTML = "";
    if (!buses.length) {
      var msg = state.mode === "live"
        ? "<strong>No 82s reporting</strong>Nothing on the live feed for this route right now — check back shortly, or outside service hours this is expected."
        : "<strong>No 82s in service</strong>Nothing is scheduled on route 82 at this time of day.";
      host.innerHTML = '<div class="empty">' + msg + "</div>";
      return;
    }
    buses.sort(function (a, b) {
      return (a.direction_id - b.direction_id) || String(a.trip_id).localeCompare(String(b.trip_id));
    });
    buses.forEach(function (bus) {
      var dir = bus.direction_id === 1 ? 1 : 0;
      var row = el("div", "row");
      if (state.selected && state.selected.kind === "bus" && state.selected.id === bus.id) {
        row.classList.add("is-selected");
      }
      row.appendChild(el("div", "row-icon dir-" + dir, dir === 0 ? "→" : "←"));

      var main = el("div", "row-main");
      main.appendChild(el("div", "row-title", bus.headsign || "Route 82"));
      var nextStop = bus.stop_id && state.route.stops[bus.stop_id];
      main.appendChild(el("div", "row-sub",
        (nextStop ? (bus.synthetic ? "→ " : "next: ") + nextStop.name : "in service") +
        (bus.label ? " · " + bus.label : "")));
      row.appendChild(main);

      var meta = el("div", "row-meta");
      if (bus.synthetic) {
        meta.innerHTML = secsToClock(bus.start_secs) + "<br><span class='muted'>departed</span>";
      } else {
        meta.innerHTML = (bus.delay != null ? delayBadge(bus.delay) : "") +
          "<br>" + relativeTime(bus.timestamp);
      }
      row.appendChild(meta);

      row.addEventListener("click", function () {
        select("bus", bus.id);
        map.setView([bus.lat, bus.lon], Math.max(map.getZoom(), 15));
        if (busMarkers[bus.id]) busMarkers[bus.id].openPopup();
      });
      host.appendChild(row);
    });
  }

  function renderStopList() {
    var host = $("#stop-list");
    var query = ($("#stop-search").value || "").trim().toLowerCase();
    host.innerHTML = "";

    var ids = Object.keys(state.route.stops).filter(function (id) {
      var s = state.route.stops[id];
      if (isWatched(id) && !query) return true;   // pinned stops always listed
      if (state.direction !== "all" && String(stopDirection(id)) !== state.direction) return false;
      if (!query) return true;
      return s.name.toLowerCase().indexOf(query) >= 0 ||
             String(s.code).toLowerCase().indexOf(query) >= 0;
    });

    // Keep timetable order per direction rather than alphabetical.
    var order = {};
    ["0", "1"].forEach(function (d) {
      var p = state.route.patterns[d];
      if (!p) return;
      p.stop_ids.concat(p.variant_stop_ids).forEach(function (id, i) {
        if (order[id] == null) order[id] = parseInt(d, 10) * 1000 + i;
      });
    });
    ids.sort(function (a, b) {
      // watched stops float to the top, everything else in timetable order
      var wa = isWatched(a) ? 0 : 1, wb = isWatched(b) ? 0 : 1;
      if (wa !== wb) return wa - wb;
      return (order[a] == null ? 9999 : order[a]) - (order[b] == null ? 9999 : order[b]);
    });
    $("#stop-count-pill").textContent = ids.length;

    if (!ids.length) {
      host.innerHTML = '<div class="empty"><strong>No stops match</strong>Try a different name or stop number.</div>';
      return;
    }

    ids.forEach(function (id) {
      var s = state.route.stops[id];
      var dir = stopDirection(id);
      var row = el("div", "row");
      if (state.selected && state.selected.kind === "stop" && state.selected.id === id) {
        row.classList.add("is-selected");
      }
      if (isWatched(id)) row.classList.add("is-watched");
      row.appendChild(el("div", "row-icon " + (isWatched(id) ? "watched" : "dir-" + dir),
                         isWatched(id) ? "\u2605" : (dir === 0 ? "→" : "←")));
      var main = el("div", "row-main");
      main.appendChild(el("div", "row-title", s.name));
      main.appendChild(el("div", "row-sub", "Stop " + (s.code || s.id)));
      row.appendChild(main);

      var next = state.schedule ? nextDepartures(id, 1)[0] : null;
      var meta = el("div", "row-meta");
      meta.innerHTML = next
        ? formatWait(next.mins) + "<br><span class='muted'>" + secsToClock(next.secs) + "</span>"
        : "<span class='muted'>—</span>";
      row.appendChild(meta);

      row.addEventListener("click", function () {
        select("stop", id);
        map.setView([s.lat, s.lon], Math.max(map.getZoom(), 16));
        if (stopMarkers[id]) {
          if (!layers.stops.hasLayer(stopMarkers[id])) layers.stops.addLayer(stopMarkers[id]);
          stopMarkers[id].openPopup();
        }
      });
      host.appendChild(row);
    });
  }

  function select(kind, id) {
    state.selected = { kind: kind, id: id };
    render();
    renderStopList();
  }

  // ------------------------------------------------------------------ ui
  function wireUI() {
    document.querySelectorAll(".tab").forEach(function (tab) {
      tab.addEventListener("click", function () {
        document.querySelectorAll(".tab").forEach(function (t) { t.classList.remove("is-active"); });
        document.querySelectorAll(".tab-panel").forEach(function (p) { p.classList.remove("is-active"); });
        tab.classList.add("is-active");
        $('.tab-panel[data-panel="' + tab.dataset.tab + '"]').classList.add("is-active");
      });
    });

    $("#direction-filter").addEventListener("change", function (e) {
      state.direction = e.target.value;
      applyStopFilter();
      render();
      renderStopList();
    });
    $("#toggle-stops").addEventListener("change", applyStopFilter);
    $("#stop-search").addEventListener("input", renderStopList);
    $("#refresh-btn").addEventListener("click", function (e) {
      e.target.classList.add("spin");
      setTimeout(function () { e.target.classList.remove("spin"); }, 700);
      poll();
    });
    $("#fit-btn").addEventListener("click", function () {
      $("#toggle-follow").checked = false;
      fitRoute();
    });

    window.addEventListener("resize", function () {
      map.invalidateSize({ animate: false });
    });
  }

  // ---------------------------------------------------------------- boot
  initMap();
  wireUI();
  loadStatic()
    .then(function () {
      render();
      poll();
      setInterval(poll, POLL_MS);
      setInterval(function () {
        if (state.mode !== "live") render();
        else renderStatus(currentBuses());
      }, TIMETABLE_TICK_MS);
    })
    .catch(function (err) {
      state.mode = "error";
      state.statusMessage = "Could not load route data: " + err.message;
      renderStatus([]);
      console.error(err);
    });
})();
