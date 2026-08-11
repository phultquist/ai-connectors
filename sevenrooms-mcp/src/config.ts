import { SevenRoomsClient, type AuthStyle } from "./client.js";

export interface Env {
  /** SevenRooms API key. Single-tenant deploys set this as a secret. */
  SEVENROOMS_TOKEN?: string;
  /** Optional default venue id, so tools can omit venue_id. */
  SEVENROOMS_VENUE_ID?: string;
  /** API version segment, e.g. "2_4". */
  SEVENROOMS_API_VERSION?: string;
  /** "bearer" | "apikey" | "both" (default "both"). */
  SEVENROOMS_AUTH_STYLE?: string;
  /** "true" enables POST/PUT/PATCH/DELETE. Off by default. */
  SEVENROOMS_ALLOW_WRITES?: string;
  /** Optional gate for a shared single-tenant deployment. */
  MCP_SHARED_SECRET?: string;
}

const truthy = (v?: string) => /^(1|true|yes|on)$/i.test(v ?? "");

export function authStyleFrom(value?: string): AuthStyle {
  return value === "bearer" || value === "apikey" ? value : "both";
}

export function clientFromEnv(env: Env, tokenOverride?: string): SevenRoomsClient {
  const token = tokenOverride || env.SEVENROOMS_TOKEN;
  if (!token) {
    throw new Error(
      "No SevenRooms API key available. Set the SEVENROOMS_TOKEN secret, or send one " +
        "per request in the X-Sevenrooms-Token header.",
    );
  }
  return new SevenRoomsClient({
    token,
    venueId: env.SEVENROOMS_VENUE_ID,
    apiVersion: env.SEVENROOMS_API_VERSION,
    authStyle: authStyleFrom(env.SEVENROOMS_AUTH_STYLE),
    allowWrites: truthy(env.SEVENROOMS_ALLOW_WRITES),
  });
}

/** Returns an error string when the shared-secret gate rejects the request. */
export function checkSharedSecret(env: Env, authHeader: string | null): string | null {
  if (!env.MCP_SHARED_SECRET) return null;
  const expected = `Bearer ${env.MCP_SHARED_SECRET}`;
  return authHeader === expected ? null : "Unauthorized: invalid or missing bearer token.";
}
