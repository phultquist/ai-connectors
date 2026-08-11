/**
 * Cloudflare Worker entry point — the shareable, multi-tenant remote connector.
 *
 * Routes
 *   GET    /                      health + endpoint discovery
 *   POST   /mcp                   the MCP endpoint clients connect to
 *   POST   /admin/tenants         provision a customer, returns their key once
 *   GET    /admin/tenants         list customers (never returns secrets)
 *   POST   /admin/tenants/:id/rotate
 *   DELETE /admin/tenants/:id     revoke access
 *
 * Auth
 *   /mcp    Authorization: Bearer ck_live_...   (per-customer connector key)
 *   /admin  Authorization: Bearer <ADMIN_SECRET>
 */

import { SevenShiftsClient } from "./client.js";
import type { Env } from "./config.js";
import { CORS_HEADERS, handleHttp, SERVER_INFO } from "./mcp.js";
import { TenantStore, timingSafeEqual, type KVLike } from "./tenants.js";

export interface WorkerEnv extends Env {
  /** KV namespace holding tenant records. Bound in wrangler.toml. */
  TENANTS?: KVLike;
  /** Bearer secret protecting the /admin routes. */
  ADMIN_SECRET?: string;
}

const json = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS, ...extra },
  });

const bearer = (request: Request): string | null => {
  const header = request.headers.get("authorization") ?? "";
  return header.startsWith("Bearer ") ? header.slice(7).trim() : null;
};

const unauthorized = (message: string) =>
  json({ error: message }, 401, { "WWW-Authenticate": 'Bearer realm="sevenshifts-mcp"' });

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (path === "/" || path === "/health") {
      return json({
        server: SERVER_INFO,
        status: "ok",
        mcp_endpoint: new URL("/mcp", url.origin).toString(),
        mode: env.TENANTS ? "multi-tenant" : "single-tenant",
        auth: env.TENANTS
          ? "Send Authorization: Bearer <your connector key>"
          : env.MCP_SHARED_SECRET
            ? "Send Authorization: Bearer <shared secret>"
            : "open (no auth configured)",
      });
    }

    if (path.startsWith("/admin")) return handleAdmin(request, env, path);
    if (path !== "/mcp") {
      return json({ error: "Not found. The MCP endpoint is at /mcp." }, 404);
    }

    /* ---- resolve the caller to a 7shifts client ---------------------- */
    const presented = bearer(request);
    let client: SevenShiftsClient;

    if (env.TENANTS) {
      if (!presented) {
        return unauthorized("Missing connector key. Send Authorization: Bearer ck_live_...");
      }
      const tenant = await new TenantStore(env.TENANTS).lookup(presented);
      if (!tenant) return unauthorized("Invalid or revoked connector key.");

      client = new SevenShiftsClient({
        token: tenant.sevenshifts_token,
        companyId: tenant.company_id,
        apiVersion: env.SEVENSHIFTS_API_VERSION,
        allowWrites: tenant.allow_writes ?? false,
      });
    } else {
      // Single-tenant fallback: one token in Worker secrets.
      if (env.MCP_SHARED_SECRET) {
        if (!presented || !timingSafeEqual(presented, env.MCP_SHARED_SECRET)) {
          return unauthorized("Invalid or missing bearer token.");
        }
      }
      if (!env.SEVENSHIFTS_TOKEN) {
        return json(
          { error: "Server misconfigured: no TENANTS namespace and no SEVENSHIFTS_TOKEN." },
          500,
        );
      }
      client = new SevenShiftsClient({
        token: env.SEVENSHIFTS_TOKEN,
        companyId: env.SEVENSHIFTS_COMPANY_ID ? Number(env.SEVENSHIFTS_COMPANY_ID) : undefined,
        apiVersion: env.SEVENSHIFTS_API_VERSION,
        allowWrites: /^(1|true|yes|on)$/i.test(env.SEVENSHIFTS_ALLOW_WRITES ?? ""),
      });
    }

    try {
      return await handleHttp(request, client);
    } catch (err) {
      return json(
        {
          jsonrpc: "2.0",
          id: null,
          error: { code: -32603, message: (err as Error)?.message ?? "Internal error" },
        },
        500,
      );
    }
  },
};

/* ------------------------------------------------------------------ */
/* Admin API                                                           */
/* ------------------------------------------------------------------ */

async function handleAdmin(
  request: Request,
  env: WorkerEnv,
  path: string,
): Promise<Response> {
  if (!env.ADMIN_SECRET) {
    return json({ error: "Admin API disabled: ADMIN_SECRET is not set." }, 503);
  }
  const presented = bearer(request);
  if (!presented || !timingSafeEqual(presented, env.ADMIN_SECRET)) {
    return unauthorized("Invalid admin credentials.");
  }
  if (!env.TENANTS) {
    return json(
      { error: "Admin API needs the TENANTS KV namespace bound in wrangler.toml." },
      503,
    );
  }

  const store = new TenantStore(env.TENANTS);
  const segments = path.split("/").filter(Boolean); // ["admin","tenants", id?, action?]

  if (segments[1] !== "tenants") return json({ error: "Unknown admin route." }, 404);

  // /admin/tenants
  if (segments.length === 2) {
    if (request.method === "GET") {
      return json({ tenants: await store.list() });
    }
    if (request.method === "POST") {
      let body: any;
      try {
        body = await request.json();
      } catch {
        return json({ error: "Body must be JSON." }, 400);
      }
      try {
        const { tenant, connector_key } = await store.create({
          name: body?.name,
          sevenshifts_token: body?.sevenshifts_token,
          company_id: body?.company_id,
          allow_writes: body?.allow_writes,
        });
        return json(
          {
            tenant,
            connector_key,
            warning:
              "This key is shown once and cannot be recovered. Send it to the customer over a secure channel.",
          },
          201,
        );
      } catch (err) {
        return json({ error: (err as Error).message }, 400);
      }
    }
    return json({ error: "Use GET or POST on /admin/tenants." }, 405);
  }

  const tenantId = segments[2];

  // /admin/tenants/:id/rotate
  if (segments.length === 4 && segments[3] === "rotate" && request.method === "POST") {
    const rotated = await store.rotate(tenantId);
    if (!rotated) return json({ error: "Tenant not found." }, 404);
    return json({
      tenant_id: tenantId,
      ...rotated,
      warning: "The previous key stopped working immediately.",
    });
  }

  // /admin/tenants/:id
  if (segments.length === 3 && request.method === "DELETE") {
    const ok = await store.revoke(tenantId);
    return ok
      ? json({ tenant_id: tenantId, revoked: true })
      : json({ error: "Tenant not found." }, 404);
  }

  return json({ error: "Unknown admin route." }, 404);
}
