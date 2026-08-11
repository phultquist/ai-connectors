/**
 * OAuth 2.1 authorization server + protected-resource metadata, per the MCP
 * authorization spec (2025-06-18).
 *
 * This exists so Claude Cowork, the web app, and Claude Desktop can connect —
 * they call the MCP endpoint from Anthropic's cloud, where the plugin's
 * `${SEVENSHIFTS_CONNECTOR_KEY}` shell expansion has nothing to expand from.
 *
 * The connector key is still the underlying credential: a customer pastes it
 * once on the consent screen, and we exchange it for OAuth tokens bound to
 * their tenant. Direct `ck_live_…` bearer auth on /mcp keeps working unchanged.
 */

import { hashKey, timingSafeEqual, TenantStore, type KVLike, type TenantRecord } from "./tenants.js";

const CLIENT_NS = "oauthclient:";
const CODE_NS = "authcode:";
const TOKEN_NS = "oauthtoken:";
const REFRESH_NS = "oauthrefresh:";

const CODE_TTL_MS = 60_000; // single-use, one minute
const ACCESS_TTL_MS = 60 * 60 * 1000; // short-lived, per spec guidance

interface ClientRecord {
  client_id: string;
  client_name?: string;
  redirect_uris: string[];
  created_at: string;
}

interface CodeRecord {
  client_id: string;
  tenant_id: string;
  redirect_uri: string;
  code_challenge: string;
  resource?: string;
  expires_at: number;
}

export interface TokenRecord {
  tenant_id: string;
  client_id: string;
  resource?: string;
  expires_at?: number;
}

function randomToken(prefix: string, bytes = 32): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return prefix + Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

function base64UrlEncode(bytes: ArrayBuffer): string {
  const str = String.fromCharCode(...new Uint8Array(bytes));
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** PKCE S256: BASE64URL(SHA256(verifier)) must equal the stored challenge. */
async function verifyPkce(verifier: string, challenge: string): Promise<boolean> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return timingSafeEqual(base64UrlEncode(digest), challenge);
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
      ...headers,
    },
  });

const oauthError = (error: string, description: string, status = 400) =>
  json({ error, error_description: description }, status);

/* ------------------------------------------------------------------ */
/* Metadata                                                            */
/* ------------------------------------------------------------------ */

export function protectedResourceMetadata(origin: string) {
  return {
    resource: `${origin}/mcp`,
    authorization_servers: [origin],
    scopes_supported: ["mcp"],
    bearer_methods_supported: ["header"],
    resource_documentation: "https://github.com/phultquist/ai-connectors",
  };
}

export function authorizationServerMetadata(origin: string) {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/authorize`,
    token_endpoint: `${origin}/token`,
    registration_endpoint: `${origin}/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: ["mcp"],
  };
}

/** RFC 9728 §5.1 — tells the client where to discover the auth server. */
export function wwwAuthenticate(origin: string, error?: string): string {
  const parts = [`Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`];
  if (error) parts.push(`error="${error}"`);
  return parts.join(", ");
}

/* ------------------------------------------------------------------ */
/* Token verification (used by the MCP endpoint)                       */
/* ------------------------------------------------------------------ */

/**
 * Resolves an OAuth access token to its tenant, or null. Expired tokens are
 * deleted as they are encountered.
 */
export async function resolveAccessToken(
  kv: KVLike,
  token: string,
  expectedResource: string,
): Promise<TenantRecord | null> {
  if (!token.startsWith("at_")) return null;

  const key = TOKEN_NS + (await hashKey(token));
  const raw = await kv.get(key);
  if (!raw) return null;

  const record = JSON.parse(raw) as TokenRecord;
  if (record.expires_at && record.expires_at < Date.now()) {
    await kv.delete(key);
    return null;
  }

  // Audience binding (RFC 8707): a token minted for another resource is not ours.
  if (record.resource && !resourceMatches(record.resource, expectedResource)) return null;

  const store = new TenantStore(kv);
  return store.getById(record.tenant_id);
}

function resourceMatches(a: string, b: string): boolean {
  const norm = (s: string) => s.replace(/\/+$/, "").toLowerCase();
  return norm(a) === norm(b) || norm(a) === norm(b.replace(/\/mcp$/, ""));
}

/* ------------------------------------------------------------------ */
/* Endpoints                                                           */
/* ------------------------------------------------------------------ */

/** POST /register — RFC 7591 dynamic client registration (public clients). */
export async function handleRegister(request: Request, kv: KVLike): Promise<Response> {
  let body: any;
  try {
    body = await request.json();
  } catch {
    return oauthError("invalid_client_metadata", "Body must be JSON.");
  }

  const redirectUris: unknown = body?.redirect_uris;
  if (!Array.isArray(redirectUris) || redirectUris.length === 0) {
    return oauthError("invalid_redirect_uri", "redirect_uris is required.");
  }
  for (const uri of redirectUris) {
    if (typeof uri !== "string" || !isSafeRedirect(uri)) {
      return oauthError(
        "invalid_redirect_uri",
        `Redirect URIs must be https or localhost: ${String(uri)}`,
      );
    }
  }

  const record: ClientRecord = {
    client_id: randomToken("client_", 16),
    client_name: typeof body?.client_name === "string" ? body.client_name : undefined,
    redirect_uris: redirectUris as string[],
    created_at: new Date().toISOString(),
  };
  await kv.put(CLIENT_NS + record.client_id, JSON.stringify(record));

  return json(
    {
      client_id: record.client_id,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      redirect_uris: record.redirect_uris,
      client_name: record.client_name,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    },
    201,
  );
}

/** Only https, or loopback for local MCP clients. */
function isSafeRedirect(uri: string): boolean {
  try {
    const url = new URL(uri);
    if (url.protocol === "https:") return true;
    return url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  } catch {
    return false;
  }
}

/** GET /authorize — renders the consent screen. */
export async function handleAuthorizeGet(url: URL, kv: KVLike): Promise<Response> {
  const p = url.searchParams;
  const clientId = p.get("client_id") ?? "";
  const redirectUri = p.get("redirect_uri") ?? "";

  const client = await loadClient(kv, clientId);
  // Never redirect back on a client/redirect mismatch — that is the open-redirect hole.
  if (!client) return htmlError("Unknown client", "This application is not registered.");
  if (!client.redirect_uris.includes(redirectUri)) {
    return htmlError("Invalid redirect URI", "The redirect URI does not match this client's registration.");
  }
  if (p.get("response_type") !== "code") {
    return redirectError(redirectUri, "unsupported_response_type", "Only response_type=code is supported.", p.get("state"));
  }
  if (p.get("code_challenge_method") !== "S256" || !p.get("code_challenge")) {
    return redirectError(redirectUri, "invalid_request", "PKCE with S256 is required.", p.get("state"));
  }

  return htmlPage(consentForm(p, client));
}

/** POST /authorize — validates the connector key and issues a code. */
export async function handleAuthorizePost(request: Request, kv: KVLike): Promise<Response> {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return htmlError("Malformed request", "The consent form could not be read. Start the connection again.");
  }
  const get = (k: string) => (form.get(k) as string | null) ?? "";

  const clientId = get("client_id");
  const redirectUri = get("redirect_uri");
  const state = get("state");
  const connectorKey = get("connector_key").trim();

  const client = await loadClient(kv, clientId);
  if (!client) return htmlError("Unknown client", "This application is not registered.");
  if (!client.redirect_uris.includes(redirectUri)) {
    return htmlError("Invalid redirect URI", "The redirect URI does not match this client's registration.");
  }

  const tenant = await new TenantStore(kv).lookup(connectorKey);
  if (!tenant) {
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      state,
      code_challenge: get("code_challenge"),
      code_challenge_method: "S256",
      response_type: "code",
      ...(get("resource") ? { resource: get("resource") } : {}),
    });
    return htmlPage(
      consentForm(params, client, "That connector key was not recognised, or it has been revoked."),
      400,
    );
  }

  const code = randomToken("code_", 32);
  const record: CodeRecord = {
    client_id: clientId,
    tenant_id: tenant.tenant_id,
    redirect_uri: redirectUri,
    code_challenge: get("code_challenge"),
    resource: get("resource") || undefined,
    expires_at: Date.now() + CODE_TTL_MS,
  };
  await kv.put(CODE_NS + (await hashKey(code)), JSON.stringify(record));

  const target = new URL(redirectUri);
  target.searchParams.set("code", code);
  if (state) target.searchParams.set("state", state);
  return Response.redirect(target.toString(), 302);
}

/** POST /token — authorization_code and refresh_token grants. */
export async function handleToken(request: Request, kv: KVLike): Promise<Response> {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return oauthError("invalid_request", "Body must be application/x-www-form-urlencoded.");
  }
  const get = (k: string) => (form.get(k) as string | null) ?? "";
  const grant = get("grant_type");

  if (grant === "authorization_code") {
    const code = get("code");
    const verifier = get("code_verifier");
    if (!code || !verifier) {
      return oauthError("invalid_request", "code and code_verifier are required.");
    }

    const codeKey = CODE_NS + (await hashKey(code));
    const raw = await kv.get(codeKey);
    if (!raw) return oauthError("invalid_grant", "Authorization code is invalid or already used.");
    await kv.delete(codeKey); // single use, deleted before validation completes

    const record = JSON.parse(raw) as CodeRecord;
    if (record.expires_at < Date.now()) {
      return oauthError("invalid_grant", "Authorization code has expired.");
    }
    if (record.client_id !== get("client_id")) {
      return oauthError("invalid_grant", "Authorization code was issued to a different client.");
    }
    if (get("redirect_uri") && get("redirect_uri") !== record.redirect_uri) {
      return oauthError("invalid_grant", "redirect_uri does not match the authorization request.");
    }
    if (!(await verifyPkce(verifier, record.code_challenge))) {
      return oauthError("invalid_grant", "PKCE verification failed.");
    }

    return issueTokens(kv, {
      tenant_id: record.tenant_id,
      client_id: record.client_id,
      resource: record.resource,
    });
  }

  if (grant === "refresh_token") {
    const presented = get("refresh_token");
    if (!presented) return oauthError("invalid_request", "refresh_token is required.");

    const refreshKey = REFRESH_NS + (await hashKey(presented));
    const raw = await kv.get(refreshKey);
    if (!raw) return oauthError("invalid_grant", "Refresh token is invalid or has been rotated.");
    await kv.delete(refreshKey); // public clients: rotate on every use

    const record = JSON.parse(raw) as TokenRecord;
    if (record.client_id !== get("client_id")) {
      return oauthError("invalid_grant", "Refresh token was issued to a different client.");
    }
    // A revoked tenant must not be able to refresh back into access.
    if (!(await new TenantStore(kv).getById(record.tenant_id))) {
      return oauthError("invalid_grant", "The underlying connector key has been revoked.");
    }
    return issueTokens(kv, record);
  }

  return oauthError("unsupported_grant_type", `Unsupported grant_type: ${grant || "(none)"}`);
}

async function issueTokens(kv: KVLike, base: TokenRecord): Promise<Response> {
  const accessToken = randomToken("at_");
  const refreshToken = randomToken("rt_");
  const expiresAt = Date.now() + ACCESS_TTL_MS;

  await kv.put(
    TOKEN_NS + (await hashKey(accessToken)),
    JSON.stringify({ ...base, expires_at: expiresAt } satisfies TokenRecord),
  );
  await kv.put(REFRESH_NS + (await hashKey(refreshToken)), JSON.stringify(base));

  return json({
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: Math.floor(ACCESS_TTL_MS / 1000),
    refresh_token: refreshToken,
    scope: "mcp",
  });
}

async function loadClient(kv: KVLike, clientId: string): Promise<ClientRecord | null> {
  if (!clientId) return null;
  const raw = await kv.get(CLIENT_NS + clientId);
  return raw ? (JSON.parse(raw) as ClientRecord) : null;
}

/* ------------------------------------------------------------------ */
/* Consent screen                                                      */
/* ------------------------------------------------------------------ */

const escape = (s: string) =>
  s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );

function consentForm(p: URLSearchParams, client: ClientRecord, error?: string): string {
  const hidden = ["client_id", "redirect_uri", "state", "code_challenge", "resource"]
    .map((k) => {
      const v = p.get(k);
      return v ? `<input type="hidden" name="${k}" value="${escape(v)}">` : "";
    })
    .join("");

  return `
  <h1>Connect 7shifts</h1>
  <p class="sub">${escape(client.client_name || "An application")} is requesting read-only access to your 7shifts data.</p>
  ${error ? `<div class="err">${escape(error)}</div>` : ""}
  <form method="POST" action="/authorize">
    ${hidden}
    <label for="connector_key">Connector key</label>
    <input id="connector_key" name="connector_key" type="password" placeholder="ck_live_…"
           autocomplete="off" autocapitalize="off" spellcheck="false" required autofocus>
    <p class="hint">This was provided to you by AI Connectors. It is not your 7shifts password.</p>
    <button type="submit">Connect</button>
  </form>
  <p class="foot">Read-only. This cannot create, edit, or delete anything in 7shifts.</p>`;
}

function htmlPage(inner: string, status = 200): Response {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect 7shifts</title><style>
:root{color-scheme:light dark}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;
 font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
 background:#f6f7f9;color:#16181d}
main{width:100%;max-width:420px;background:#fff;border:1px solid #e3e5e9;
 border-radius:14px;padding:32px}
h1{margin:0 0 6px;font-size:21px}
.sub{margin:0 0 20px;color:#5c6270;font-size:14px}
label{display:block;font-size:13px;font-weight:600;margin-bottom:6px}
input{width:100%;padding:11px 12px;font-size:15px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;
 border:1px solid #ccd0d6;border-radius:8px;background:#fff;color:inherit}
input:focus{outline:2px solid #3b6fd4;outline-offset:-1px;border-color:#3b6fd4}
.hint{font-size:12px;color:#6b7280;margin:8px 0 18px}
button{width:100%;padding:11px;font-size:15px;font-weight:600;color:#fff;
 background:#1f2937;border:0;border-radius:8px;cursor:pointer}
button:hover{background:#111827}
.err{background:#fdeced;border:1px solid #f5c2c7;color:#8a1c24;
 padding:10px 12px;border-radius:8px;font-size:13.5px;margin-bottom:16px}
.foot{margin:20px 0 0;font-size:12px;color:#6b7280;text-align:center}
@media(prefers-color-scheme:dark){
 body{background:#0f1115;color:#e6e8ec}
 main{background:#171a21;border-color:#2a2f3a}
 input{background:#0f1115;border-color:#39404d}
 .sub,.hint,.foot{color:#9aa3b2}
 button{background:#3b6fd4}button:hover{background:#3462bd}
 .err{background:#3a1d20;border-color:#6b2c33;color:#f4b7bd}}
</style></head><body><main>${inner}</main></body></html>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } },
  );
}

function htmlError(title: string, detail: string): Response {
  return htmlPage(`<h1>${escape(title)}</h1><p class="sub">${escape(detail)}</p>`, 400);
}

function redirectError(
  redirectUri: string,
  error: string,
  description: string,
  state: string | null,
): Response {
  const target = new URL(redirectUri);
  target.searchParams.set("error", error);
  target.searchParams.set("error_description", description);
  if (state) target.searchParams.set("state", state);
  return Response.redirect(target.toString(), 302);
}
