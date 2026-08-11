import { SevenShiftsClient } from "./client.js";

export interface Env {
  /** 7shifts access token. Single-tenant deploys set this as a secret. */
  SEVENSHIFTS_TOKEN?: string;
  /** Optional default company id; otherwise resolved from /whoami. */
  SEVENSHIFTS_COMPANY_ID?: string;
  /** Pin the 7shifts API version. */
  SEVENSHIFTS_API_VERSION?: string;
  /** "true" enables POST/PUT/PATCH/DELETE. Off by default. */
  SEVENSHIFTS_ALLOW_WRITES?: string;
  /**
   * Optional gate for a shared remote deployment. When set, callers must send
   * `Authorization: Bearer <this value>`.
   */
  MCP_SHARED_SECRET?: string;
}

const truthy = (v?: string) => /^(1|true|yes|on)$/i.test(v ?? "");

export function clientFromEnv(env: Env, tokenOverride?: string): SevenShiftsClient {
  const token = tokenOverride || env.SEVENSHIFTS_TOKEN;
  if (!token) {
    throw new Error(
      "No 7shifts token available. Set the SEVENSHIFTS_TOKEN secret, or send one " +
        "per request in the X-7shifts-Token header.",
    );
  }
  const companyId = env.SEVENSHIFTS_COMPANY_ID
    ? Number(env.SEVENSHIFTS_COMPANY_ID)
    : undefined;

  return new SevenShiftsClient({
    token,
    companyId: Number.isFinite(companyId) ? companyId : undefined,
    apiVersion: env.SEVENSHIFTS_API_VERSION,
    allowWrites: truthy(env.SEVENSHIFTS_ALLOW_WRITES),
  });
}

/** Returns an error string when the shared-secret gate rejects the request. */
export function checkSharedSecret(env: Env, authHeader: string | null): string | null {
  if (!env.MCP_SHARED_SECRET) return null;
  const expected = `Bearer ${env.MCP_SHARED_SECRET}`;
  return authHeader === expected ? null : "Unauthorized: invalid or missing bearer token.";
}
