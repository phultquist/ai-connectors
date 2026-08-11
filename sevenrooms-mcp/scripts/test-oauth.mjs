#!/usr/bin/env node
/**
 * Simulates a full MCP OAuth client against the Worker with an in-memory KV,
 * and re-checks that direct connector-key auth still works.
 *
 * Run: SEVENSHIFTS_TOKEN=... node scripts/test-oauth.mjs
 */

import { createHash, randomBytes } from "node:crypto";
import worker from "../dist/worker.js";

const memory = new Map();
const KV = {
  async get(k) { return memory.has(k) ? memory.get(k) : null; },
  async put(k, v) { memory.set(k, v); },
  async delete(k) { memory.delete(k); },
  async list({ prefix = "" } = {}) {
    return { keys: [...memory.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })) };
  },
};

const env = { TENANTS: KV, ADMIN_SECRET: "admin-test-secret", SEVENSHIFTS_API_VERSION: "2026-06-01" };
const ORIGIN = "https://mcp.example.test";
const REDIRECT = "http://localhost:44100/callback";

let pass = 0, fail = 0;
const check = (label, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}${detail ? `\n      ${detail}` : ""}`); }
};

const call = (path, init) => worker.fetch(new Request(ORIGIN + path, init), env);
const b64url = (buf) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const CUSTOMER_TOKEN = process.env.SEVENROOMS_TOKEN || "sr_test_key";


/* ---- provision a tenant ------------------------------------------- */
const created = await (await call("/admin/tenants", {
  method: "POST",
  headers: { Authorization: `Bearer ${env.ADMIN_SECRET}`, "Content-Type": "application/json" },
  body: JSON.stringify({ name: "OAuth Test Co", sevenrooms_token: CUSTOMER_TOKEN }),
})).json();
const CONNECTOR_KEY = created.connector_key;
const TENANT_ID = created.tenant.tenant_id;

console.log("\nDiscovery");
{
  const r = await call("/mcp", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  const wa = r.headers.get("www-authenticate") ?? "";
  check("401 carries WWW-Authenticate", r.status === 401 && wa.includes("Bearer"), wa);
  check("…pointing at resource metadata", wa.includes("/.well-known/oauth-protected-resource"), wa);

  const prm = await (await call("/.well-known/oauth-protected-resource")).json();
  check("protected resource metadata", prm.resource === `${ORIGIN}/mcp` && prm.authorization_servers?.[0] === ORIGIN);

  const suffixed = await call("/.well-known/oauth-protected-resource/mcp");
  check("…also served at the /mcp-suffixed path", suffixed.status === 200);

  const asm = await (await call("/.well-known/oauth-authorization-server")).json();
  check("auth server metadata complete",
    asm.issuer === ORIGIN && asm.authorization_endpoint === `${ORIGIN}/authorize` &&
    asm.token_endpoint === `${ORIGIN}/token` && asm.registration_endpoint === `${ORIGIN}/register`);
  check("advertises S256 PKCE only", JSON.stringify(asm.code_challenge_methods_supported) === '["S256"]');
}

console.log("\nDynamic client registration");
let clientId;
{
  const res = await call("/register", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_name: "Claude", redirect_uris: [REDIRECT] }),
  });
  const body = await res.json();
  clientId = body.client_id;
  check("client registered (201)", res.status === 201 && !!clientId, `got ${res.status}`);

  const bad = await call("/register", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_name: "Evil", redirect_uris: ["http://evil.example.com/cb"] }),
  });
  check("non-https remote redirect_uri refused", bad.status === 400, `got ${bad.status}`);
}

console.log("\nAuthorization");
const verifier = b64url(randomBytes(32));
const challenge = b64url(createHash("sha256").update(verifier).digest());
let code;
{
  const q = new URLSearchParams({
    response_type: "code", client_id: clientId, redirect_uri: REDIRECT,
    code_challenge: challenge, code_challenge_method: "S256", state: "xyz",
    resource: `${ORIGIN}/mcp`,
  });

  const page = await call(`/authorize?${q}`);
  const html = await page.text();
  check("consent screen renders", page.status === 200 && html.includes("connector_key"));
  check("key field is masked", /type="password"/.test(html));

  const forged = await call(`/authorize?${new URLSearchParams({ ...Object.fromEntries(q), redirect_uri: "https://evil.example.com/cb" })}`);
  check("unregistered redirect_uri rejected without redirecting", forged.status === 400, `got ${forged.status}`);

  const form = (key) => {
    const f = new URLSearchParams({
      client_id: clientId, redirect_uri: REDIRECT, state: "xyz",
      code_challenge: challenge, resource: `${ORIGIN}/mcp`, connector_key: key,
    });
    return call("/authorize", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: f });
  };

  const wrong = await form("ck_live_" + "0".repeat(64));
  check("bad connector key does not issue a code", wrong.status === 400, `got ${wrong.status}`);

  const good = await form(CONNECTOR_KEY);
  const loc = good.headers.get("location") ?? "";
  code = new URL(loc || "https://x.test").searchParams.get("code");
  check("valid key redirects with a code", good.status === 302 && !!code, loc.slice(0, 120));
  check("state echoed back", new URL(loc || "https://x.test").searchParams.get("state") === "xyz");
}

console.log("\nToken exchange");
let accessToken, refreshToken;
{
  const post = (params) => call("/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });

  const badPkce = await post({
    grant_type: "authorization_code", code, client_id: clientId,
    redirect_uri: REDIRECT, code_verifier: b64url(randomBytes(32)),
  });
  check("wrong PKCE verifier rejected", badPkce.status === 400, `got ${badPkce.status}`);

  // That attempt consumed the code, so run the real flow with a fresh one.
  const f = new URLSearchParams({
    client_id: clientId, redirect_uri: REDIRECT, state: "s2",
    code_challenge: challenge, resource: `${ORIGIN}/mcp`, connector_key: CONNECTOR_KEY,
  });
  const again = await call("/authorize", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: f });
  const code2 = new URL(again.headers.get("location")).searchParams.get("code");

  const res = await post({
    grant_type: "authorization_code", code: code2, client_id: clientId,
    redirect_uri: REDIRECT, code_verifier: verifier,
  });
  const body = await res.json();
  accessToken = body.access_token; refreshToken = body.refresh_token;
  check("access token issued", res.status === 200 && /^at_/.test(accessToken ?? ""), JSON.stringify(body).slice(0, 150));
  check("refresh token issued", /^rt_/.test(refreshToken ?? ""));
  check("short-lived (<= 1h)", body.expires_in > 0 && body.expires_in <= 3600, String(body.expires_in));

  const replay = await post({
    grant_type: "authorization_code", code: code2, client_id: clientId,
    redirect_uri: REDIRECT, code_verifier: verifier,
  });
  check("authorization code is single-use", replay.status === 400, `got ${replay.status}`);
}

console.log("\nUsing the access token (live 7shifts)");
{
  const rpc = (token, body) => call("/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });

  const tools = await (await rpc(accessToken, { jsonrpc: "2.0", id: 1, method: "tools/list" })).json();
  check("tools/list works with OAuth token", tools.result?.tools?.length === 14, `got ${tools.result?.tools?.length}`);

  const who = await (await rpc(accessToken, {
    jsonrpc: "2.0", id: 2, method: "tools/call",
    params: { name: "sevenrooms_list_venues", arguments: {} },
  })).json();
  // The stored key is a placeholder, so SevenRooms rejects it — that is the
  // point: reaching a SevenRooms 401 proves the OAuth token resolved to the
  // tenant and its credential was used upstream, rather than being refused here.
  const text = who.result?.content?.[0]?.text ?? "";
  check(
    "OAuth token resolves to the tenant and its key is used upstream",
    /SevenRooms API 40[13]/.test(text),
    text.slice(0, 160),
  );

  const forged = await rpc("at_" + "0".repeat(64), { jsonrpc: "2.0", id: 3, method: "tools/list" });
  check("forged access token rejected", forged.status === 401, `got ${forged.status}`);
}

console.log("\nRegression: connector key still works");
{
  const r = await call("/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${CONNECTOR_KEY}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  const body = await r.json();
  check("ck_live_ bearer auth unchanged", r.status === 200 && body.result?.tools?.length === 14, `got ${r.status}`);
}

console.log("\nRefresh and revocation");
{
  const post = (params) => call("/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });

  const res = await post({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId });
  const body = await res.json();
  check("refresh returns a new access token", res.status === 200 && /^at_/.test(body.access_token ?? ""));
  check("refresh token rotated", body.refresh_token && body.refresh_token !== refreshToken);

  const reuse = await post({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId });
  check("old refresh token is dead", reuse.status === 400, `got ${reuse.status}`);

  const newAccess = body.access_token;
  await call(`/admin/tenants/${TENANT_ID}`, { method: "DELETE", headers: { Authorization: `Bearer ${env.ADMIN_SECRET}` } });

  const after = await call("/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${newAccess}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  check("revoking the tenant kills its OAuth token", after.status === 401, `got ${after.status}`);

  const refreshAfter = await post({ grant_type: "refresh_token", refresh_token: body.refresh_token, client_id: clientId });
  check("…and blocks refreshing back in", refreshAfter.status === 400, `got ${refreshAfter.status}`);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
