#!/usr/bin/env node
/**
 * Exercises the Worker end to end with an in-memory KV, against the live
 * 7shifts API. Run: SEVENSHIFTS_TOKEN=... node scripts/test-worker.mjs
 */

import worker from "../dist/worker.js";

const memory = new Map();
const KV = {
  async get(key) { return memory.has(key) ? memory.get(key) : null; },
  async put(key, value) { memory.set(key, value); },
  async delete(key) { memory.delete(key); },
  async list({ prefix = "" } = {}) {
    return { keys: [...memory.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })) };
  },
};

const env = {
  TENANTS: KV,
  ADMIN_SECRET: "admin-test-secret",
  SEVENSHIFTS_API_VERSION: "2026-06-01",
};

const BASE = "https://api.example.test";
let pass = 0, fail = 0;

function check(label, condition, detail = "") {
  if (condition) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}${detail ? `\n      ${detail}` : ""}`); }
}

const call = (path, init) => worker.fetch(new Request(BASE + path, init), env);

const rpc = (key, body) =>
  call("/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify(body),
  });

const CUSTOMER_TOKEN = process.env.SEVENSHIFTS_TOKEN;
if (!CUSTOMER_TOKEN) {
  console.error("Set SEVENSHIFTS_TOKEN to run the live portion.");
  process.exit(1);
}

console.log("\nAuth gate");
{
  const r = await rpc(null, { jsonrpc: "2.0", id: 1, method: "tools/list" });
  check("unauthenticated /mcp is rejected", r.status === 401, `got ${r.status}`);

  const r2 = await rpc("ck_live_deadbeef", { jsonrpc: "2.0", id: 1, method: "tools/list" });
  check("bogus connector key is rejected", r2.status === 401, `got ${r2.status}`);

  const r3 = await call("/admin/tenants", { headers: { Authorization: "Bearer wrong" } });
  check("wrong admin secret is rejected", r3.status === 401, `got ${r3.status}`);
}

console.log("\nProvisioning");
let connectorKey, tenantId;
{
  const res = await call("/admin/tenants", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.ADMIN_SECRET}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Acme Restaurant Group", sevenshifts_token: CUSTOMER_TOKEN }),
  });
  const body = await res.json();
  connectorKey = body.connector_key;
  tenantId = body.tenant?.tenant_id;
  check("tenant created (201)", res.status === 201, `got ${res.status}`);
  check("connector key issued", /^ck_live_[0-9a-f]{64}$/.test(connectorKey ?? ""), connectorKey);
  check("7shifts token not echoed back", body.tenant?.sevenshifts_token === "[stored]");
  check(
    "raw token absent from KV",
    ![...memory.values()].some((v) => v.includes(CUSTOMER_TOKEN) && v.includes("keyhash") === false) ||
      ![...memory.keys()].some((k) => k.includes(connectorKey)),
    "connector key must not be a KV key",
  );

  const list = await (await call("/admin/tenants", { headers: { Authorization: `Bearer ${env.ADMIN_SECRET}` } })).json();
  check("tenant appears in list", list.tenants?.length === 1);
  check("list never leaks the token", list.tenants?.[0]?.sevenshifts_token === "[stored]");
}

console.log("\nMCP protocol");
{
  const init = await (await rpc(connectorKey, {
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } },
  })).json();
  check("initialize negotiates protocol", init.result?.protocolVersion === "2025-06-18");

  const notif = await rpc(connectorKey, { jsonrpc: "2.0", method: "notifications/initialized" });
  check("notification returns 202 with no body", notif.status === 202);

  const tools = await (await rpc(connectorKey, { jsonrpc: "2.0", id: 2, method: "tools/list" })).json();
  check("tools/list returns the full surface", tools.result?.tools?.length === 28, `got ${tools.result?.tools?.length}`);
  check("no write tools exposed by default", !tools.result?.tools?.some((t) => t.name.includes("create")));
}

console.log("\nLive 7shifts calls through the tenant key");
{
  const who = await (await rpc(connectorKey, {
    jsonrpc: "2.0", id: 3, method: "tools/call",
    params: { name: "sevenshifts_whoami", arguments: {} },
  })).json();
  const text = who.result?.content?.[0]?.text ?? "";
  check("whoami resolves through tenant credentials", text.includes("company_id"), text.slice(0, 120));

  const locs = await (await rpc(connectorKey, {
    jsonrpc: "2.0", id: 4, method: "tools/call",
    params: { name: "sevenshifts_list_locations", arguments: {} },
  })).json();
  check("list_locations returns data", (locs.result?.content?.[0]?.text ?? "").includes("Testraunt"));

  const summary = await (await rpc(connectorKey, {
    jsonrpc: "2.0", id: 5, method: "tools/call",
    params: { name: "sevenshifts_executive_summary", arguments: { start_date: "2026-08-01", end_date: "2026-08-11" } },
  })).json();
  const sText = summary.result?.content?.[0]?.text ?? "";
  check("executive_summary runs and degrades gracefully", sText.includes("totals"), sText.slice(0, 200));

  const write = await (await rpc(connectorKey, {
    jsonrpc: "2.0", id: 6, method: "tools/call",
    params: { name: "sevenshifts_api_request", arguments: { method: "POST", path: "/company/435911/locations", body: {} } },
  })).json();
  check("writes refused in read-only mode", write.result?.isError === true && /read-only/.test(write.result?.content?.[0]?.text ?? ""));
}

console.log("\nRotation and revocation");
{
  const rotated = await (await call(`/admin/tenants/${tenantId}/rotate`, {
    method: "POST", headers: { Authorization: `Bearer ${env.ADMIN_SECRET}` },
  })).json();
  const newKey = rotated.connector_key;
  check("rotate issues a new key", /^ck_live_/.test(newKey ?? "") && newKey !== connectorKey);

  const old = await rpc(connectorKey, { jsonrpc: "2.0", id: 7, method: "tools/list" });
  check("old key stops working immediately", old.status === 401, `got ${old.status}`);

  const fresh = await rpc(newKey, { jsonrpc: "2.0", id: 8, method: "tools/list" });
  check("new key works", fresh.status === 200, `got ${fresh.status}`);

  await call(`/admin/tenants/${tenantId}`, { method: "DELETE", headers: { Authorization: `Bearer ${env.ADMIN_SECRET}` } });
  const revoked = await rpc(newKey, { jsonrpc: "2.0", id: 9, method: "tools/list" });
  check("revoked key is rejected", revoked.status === 401, `got ${revoked.status}`);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
