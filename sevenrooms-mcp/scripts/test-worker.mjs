#!/usr/bin/env node
/**
 * Tests the SevenRooms Worker against a mocked SevenRooms API.
 *
 * There is no public sandbox for SevenRooms — access needs a partnership
 * agreement — so this stubs fetch for api.sevenrooms.com and asserts the parts
 * that are ours: auth plumbing, envelope detection, pagination, the covers
 * math, read-only enforcement, and the OAuth/tenant layer.
 *
 * It does NOT prove the real API's field names. Re-run against live data with
 * scripts/verify-live.mjs once a key exists.
 *
 * Run: node scripts/test-worker.mjs
 */

const realFetch = globalThis.fetch;
const seen = [];

/** Envelope shapes we must survive, keyed by path. */
const MOCK = {
  "/2_4/venues": () => ({
    data: { results: [{ id: "vx1", name: "Flagship" }, { id: "vx2", name: "Uptown" }] },
  }),
  "/2_4/reservations": (url) => {
    const cursor = url.searchParams.get("cursor");
    if (!cursor) {
      return {
        data: {
          results: [
            { id: "r1", date: "2026-08-10", party_size: 4, status: "BOOKED" },
            { id: "r2", date: "2026-08-10", party_size: 2, status: "BOOKED" },
            { id: "r3", date: "2026-08-10", party_size: 6, status: "CANCELED" },
          ],
          cursor: "page2",
        },
      };
    }
    return {
      data: {
        results: [
          { id: "r4", date: "2026-08-11", party_size: 3, status: "BOOKED" },
          { id: "r5", date: "2026-08-11", party_size: 2, status: "NO_SHOW" },
        ],
        cursor: null,
      },
    };
  },
  // A different envelope, to prove shape detection is not hard-coded.
  "/2_4/clients": () => ({ results: [{ id: "c1", name: "Ada L." }] }),
  "/2_4/waitlist": () => ({ data: [{ id: "w1", quoted_wait: 25 }] }),
  // Nested under the venue id, so this only resolves if venue fallback worked.
  "/2_4/venues/vx1/availability": () => ({ data: { times: ["18:00", "20:30"] } }),
};

globalThis.fetch = async (input, init = {}) => {
  const href =
    input instanceof URL ? input.href : typeof input === "string" ? input : input.url;
  const url = new URL(href);
  if (url.hostname !== "api.sevenrooms.com") return realFetch(input, init);

  seen.push({ path: url.pathname, query: Object.fromEntries(url.searchParams), headers: init.headers ?? {} });

  const handler = MOCK[url.pathname];
  if (!handler) {
    return new Response(JSON.stringify({ status: 404, msg: "Could not find resource" }), {
      status: 404, headers: { "Content-Type": "application/json" },
    });
  }
  return new Response(JSON.stringify(handler(url)), {
    status: 200, headers: { "Content-Type": "application/json" },
  });
};

const worker = (await import("../dist/worker.js")).default;

const memory = new Map();
const KV = {
  async get(k) { return memory.has(k) ? memory.get(k) : null; },
  async put(k, v) { memory.set(k, v); },
  async delete(k) { memory.delete(k); },
  async list({ prefix = "" } = {}) {
    return { keys: [...memory.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })) };
  },
};
const env = { TENANTS: KV, ADMIN_SECRET: "admin-test", SEVENROOMS_API_VERSION: "2_4" };
const ORIGIN = "https://sr.example.test";

let pass = 0, fail = 0;
const check = (label, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}${detail ? `\n      ${detail}` : ""}`); }
};
const call = (p, i) => worker.fetch(new Request(ORIGIN + p, i), env);

/* ---- provision --------------------------------------------------- */
const created = await (await call("/admin/tenants", {
  method: "POST",
  headers: { Authorization: `Bearer ${env.ADMIN_SECRET}`, "Content-Type": "application/json" },
  body: JSON.stringify({ name: "Test Group", sevenrooms_token: "sr_test_key_123", venue_id: "vx1" }),
})).json();
const KEY = created.connector_key;

const rpc = (body, token = KEY) =>
  call("/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  }).then((r) => r.json());

const callTool = (name, args = {}) =>
  rpc({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } })
    .then((d) => d.result);

console.log("\nTenancy and protocol");
{
  check("connector key issued", /^ck_live_[0-9a-f]{64}$/.test(KEY ?? ""));
  check("API key not echoed back", created.tenant?.sevenrooms_token === "[stored]");
  const tools = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  check("tools/list returns the surface", tools.result?.tools?.length === 14, `got ${tools.result?.tools?.length}`);
  const un = await call("/mcp", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  check("unauthenticated rejected", un.status === 401, `got ${un.status}`);
}

console.log("\nAuth headers reaching SevenRooms");
{
  seen.length = 0;
  await callTool("sevenrooms_list_venues");
  const h = seen[0]?.headers ?? {};
  check("Bearer header sent", h.Authorization === "Bearer sr_test_key_123", JSON.stringify(h));
  check("X-API-Key header sent", h["X-API-Key"] === "sr_test_key_123", JSON.stringify(h));
}

console.log("\nEnvelope detection");
{
  const venues = JSON.parse((await callTool("sevenrooms_list_venues")).content[0].text);
  check("data.results envelope unwrapped", venues.data?.length === 2 && venues.shape === "data.results", JSON.stringify(venues).slice(0, 140));

  const clients = JSON.parse((await callTool("sevenrooms_list_clients")).content[0].text);
  check("bare results envelope unwrapped", clients.data?.length === 1 && clients.shape === "results", clients.shape);

  const wait = JSON.parse((await callTool("sevenrooms_list_waitlist")).content[0].text);
  check("data-array envelope unwrapped", wait.data?.length === 1 && wait.shape === "data", wait.shape);
}

console.log("\nPagination");
{
  const res = JSON.parse((await callTool("sevenrooms_list_reservations", {
    from_date: "2026-08-10", to_date: "2026-08-11",
  })).content[0].text);
  check("follows cursor across pages", res.data?.length === 5, `got ${res.data?.length}`);
  check("reports pages fetched", res.pages_fetched === 2, String(res.pages_fetched));
}

console.log("\nCovers math");
{
  const s = JSON.parse((await callTool("sevenrooms_covers_summary", {
    from_date: "2026-08-10", to_date: "2026-08-11",
  })).content[0].text);
  const v0 = s.venues[0];
  // Seated: 4 + 2 + 3 = 9 covers over 3 reservations. One cancel, one no-show.
  check("covers exclude cancels and no-shows", v0.covers === 9, `got ${v0.covers}`);
  check("cancellations counted", v0.canceled === 1, `got ${v0.canceled}`);
  check("no-shows counted", v0.no_shows === 1, `got ${v0.no_shows}`);
  check("average party size", v0.average_party_size === 3, `got ${v0.average_party_size}`);
  check("daily series bucketed by date", v0.daily?.length === 2, JSON.stringify(v0.daily));
  check("totals aggregate", s.totals.covers === 9 && s.totals.reservations === 5);
}

console.log("\nVenue resolution and safety");
{
  const noVenue = await callTool("sevenrooms_get_availability", { date: "2026-08-11" });
  check("falls back to the tenant's default venue", noVenue.isError !== true, (noVenue.content?.[0]?.text ?? "").slice(0, 120));

  const write = await callTool("sevenrooms_api_request", { method: "POST", path: "/2_4/reservations", body: {} });
  check("writes refused in read-only mode", write.isError === true && /read-only/.test(write.content[0].text));

  const bad = await callTool("sevenrooms_api_request", { path: "https://evil.example.com/x" });
  check("absolute URLs rejected", bad.isError === true, bad.content?.[0]?.text?.slice(0, 100));

  const missing = await callTool("sevenrooms_api_request", { path: "/2_4/nope" });
  check("upstream 404 surfaces as a tool error", missing.isError === true && /404/.test(missing.content[0].text));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
