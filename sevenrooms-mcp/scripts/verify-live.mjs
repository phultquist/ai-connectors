#!/usr/bin/env node
/**
 * Run this the moment you have a real SevenRooms API key.
 *
 *   SEVENROOMS_TOKEN=... node scripts/verify-live.mjs [venue_id]
 *
 * The typed tools guess at query-parameter and response field names, because
 * SevenRooms' API is not publicly documented. This hits the real API and prints
 * what actually comes back, so those guesses can be corrected.
 *
 * It only issues GET requests.
 */

const TOKEN = process.env.SEVENROOMS_TOKEN;
if (!TOKEN) {
  console.error("Set SEVENROOMS_TOKEN to a real SevenRooms API key.");
  process.exit(1);
}
const VERSION = process.env.SEVENROOMS_API_VERSION ?? "2_4";
const BASE = "https://api.sevenrooms.com";

const styles = {
  bearer: { Authorization: `Bearer ${TOKEN}` },
  apikey: { "X-API-Key": TOKEN },
  both: { Authorization: `Bearer ${TOKEN}`, "X-API-Key": TOKEN },
};

async function hit(path, query = {}, style = "both") {
  const url = new URL(BASE + path);
  for (const [k, val] of Object.entries(query)) if (val != null) url.searchParams.set(k, String(val));
  const res = await fetch(url, { headers: { Accept: "application/json", ...styles[style] } });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
}

/** Describes an object's shape without printing personal data. */
function shape(value, depth = 0) {
  if (Array.isArray(value)) return depth > 2 ? "[…]" : `[${value.length ? shape(value[0], depth + 1) : ""}]`;
  if (value && typeof value === "object") {
    if (depth > 2) return "{…}";
    return `{ ${Object.entries(value).slice(0, 24).map(([k, v]) => `${k}: ${shape(v, depth + 1)}`).join(", ")} }`;
  }
  return typeof value;
}

console.log("\n=== 1. Which auth style does this key use? ===");
let working = null;
for (const style of ["bearer", "apikey", "both"]) {
  const { status } = await hit(`/${VERSION}/venues`, {}, style);
  console.log(`  ${style.padEnd(7)} -> HTTP ${status}`);
  if (status === 200 && !working) working = style;
}
if (!working) {
  console.error("\nNo auth style succeeded. Check the key, or ask SevenRooms which header it expects.");
  process.exit(1);
}
console.log(`\n  → set SEVENROOMS_AUTH_STYLE="${working}"`);

console.log("\n=== 2. Venues (shape) ===");
const venues = await hit(`/${VERSION}/venues`, {}, working);
console.log("  " + shape(venues.body));

let venueId = process.argv[2];
if (!venueId) {
  const rows = venues.body?.data?.results ?? venues.body?.data ?? venues.body?.results ?? [];
  venueId = rows[0]?.id ?? rows[0]?.venue_id;
}
console.log(`  using venue_id: ${venueId ?? "(none found — pass one as an argument)"}`);
if (!venueId) process.exit(1);

const today = new Date().toISOString().slice(0, 10);
const weekAgo = new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10);

const probes = [
  ["reservations", `/${VERSION}/reservations`, { venue_id: venueId, from_date: weekAgo, to_date: today }],
  ["clients", `/${VERSION}/clients`, { venue_id: venueId, limit: 2 }],
  ["waitlist", `/${VERSION}/waitlist`, { venue_id: venueId, from_date: weekAgo, to_date: today }],
  ["requests", `/${VERSION}/requests`, { venue_id: venueId, from_date: weekAgo, to_date: today }],
  ["availability", `/${VERSION}/venues/${venueId}/availability`, { date: today, party_size: 2 }],
  ["tables", `/${VERSION}/venues/${venueId}/tables`, {}],
  ["shifts", `/${VERSION}/venues/${venueId}/shifts`, { from_date: weekAgo, to_date: today }],
  ["events", `/${VERSION}/venues/${venueId}/events`, { from_date: weekAgo, to_date: today }],
];

console.log("\n=== 3. Endpoint shapes ===");
for (const [label, path, query] of probes) {
  const { status, body } = await hit(path, query, working);
  console.log(`\n  ${label}  (HTTP ${status})`);
  console.log("    " + shape(body).slice(0, 700));
}

console.log(`
=== 4. What to check ===
  - Do the date filters actually narrow reservations, or is everything returned?
    (If unfiltered, the parameter names differ — correct them in src/tools.ts.)
  - What key holds party size? The covers math looks for
    party_size / max_guests / guests / covers.
  - What are the status values for cancellations and no-shows?
  - Which envelope is used (data.results / data / results)? The client reports
    this as response_shape.
`);
