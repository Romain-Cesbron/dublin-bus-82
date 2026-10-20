/**
 * Worker entry point for the Dublin Bus 82 tracker.
 *
 * Cloudflare serves everything in web/ as static assets. Requests that do not
 * match an asset fall through to this Worker, which handles the single dynamic
 * endpoint and passes anything else back to the asset handler.
 *
 * Static assets (web/) + one dynamic route is the whole architecture; see
 * README.md.
 */
import { handleLive } from "./live.js";

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);

    if (pathname === "/api/live") {
      if (request.method !== "GET") {
        return new Response("Method Not Allowed", { status: 405 });
      }
      return handleLive(env);
    }

    if (pathname === "/api/status") {
      return new Response(
        JSON.stringify({ has_key: Boolean(env.NTA_API_KEY), route_ids: ["1 82 a"] }),
        { headers: { "Content-Type": "application/json; charset=utf-8" } }
      );
    }

    // Not an asset and not an API route.
    return env.ASSETS.fetch(request);
  },
};
