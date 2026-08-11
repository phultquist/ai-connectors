/**
 * Stateless MCP (Streamable HTTP) request handler.
 *
 * Dependency-free so it runs on Cloudflare Workers as-is. The server exposes
 * only tools, and holds no per-session state, so plain JSON responses are
 * sufficient — no SSE stream is required.
 */

import { SevenShiftsClient } from "./client.js";
import { callTool, listTools } from "./tools.js";

export const SERVER_INFO = { name: "sevenshifts", version: "1.0.0" };

const SUPPORTED_PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const FALLBACK_PROTOCOL = "2025-06-18";

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: any;
}

const result = (id: any, value: unknown) => ({ jsonrpc: "2.0", id, result: value });
const failure = (id: any, code: number, message: string) => ({
  jsonrpc: "2.0",
  id,
  error: { code, message },
});

/**
 * Handles one JSON-RPC message. Returns null for notifications, which must be
 * answered with HTTP 202 and an empty body.
 */
export async function handleMessage(
  msg: JsonRpcRequest,
  client: SevenShiftsClient,
): Promise<object | null> {
  const { id = null, method, params } = msg;

  switch (method) {
    case "initialize": {
      const asked = params?.protocolVersion;
      return result(id, {
        protocolVersion: SUPPORTED_PROTOCOLS.includes(asked) ? asked : FALLBACK_PROTOCOL,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions:
          "Read-only access to 7shifts scheduling, labor, and sales data. " +
          "Call sevenshifts_whoami first if you do not know the company id, then " +
          "sevenshifts_list_locations, since most reports are per-location. " +
          "sevenshifts_executive_summary gives a one-call rollup across all locations.",
      });
    }

    case "ping":
      return result(id, {});

    case "tools/list":
      return result(id, { tools: listTools(client.allowWrites) });

    case "tools/call": {
      const name = params?.name;
      if (typeof name !== "string") {
        return failure(id, -32602, "Missing tool name.");
      }
      const { text, isError } = await callTool(name, params?.arguments ?? {}, client);
      return result(id, { content: [{ type: "text", text }], isError });
    }

    // Advertised as unsupported, but answer politely rather than erroring out.
    case "resources/list":
      return result(id, { resources: [] });
    case "prompts/list":
      return result(id, { prompts: [] });

    default:
      // Notifications (no id) never get a response.
      if (id === null || id === undefined) return null;
      return failure(id, -32601, `Method not found: ${method}`);
  }
}

export const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, Mcp-Session-Id, MCP-Protocol-Version, X-7shifts-Token",
  "Access-Control-Expose-Headers": "Mcp-Session-Id",
  "Access-Control-Max-Age": "86400",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });

/**
 * Fetch-API entry point. Shared by the Cloudflare Worker and the Node HTTP
 * server so both behave identically.
 */
export async function handleHttp(
  request: Request,
  client: SevenShiftsClient,
): Promise<Response> {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  // Some clients probe with GET before opening a stream; we have no stream.
  if (request.method === "GET") {
    return json(
      { server: SERVER_INFO, transport: "streamable-http", status: "ok" },
      200,
    );
  }

  if (request.method === "DELETE") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (request.method !== "POST") {
    return json(failure(null, -32600, "Method not allowed."), 405);
  }

  let payload: any;
  try {
    payload = await request.json();
  } catch {
    return json(failure(null, -32700, "Parse error: body is not valid JSON."), 400);
  }

  // A client may send a batch; respond in kind.
  if (Array.isArray(payload)) {
    const responses = (
      await Promise.all(payload.map((m) => handleMessage(m, client)))
    ).filter((r): r is object => r !== null);
    if (responses.length === 0) {
      return new Response(null, { status: 202, headers: CORS_HEADERS });
    }
    return json(responses);
  }

  const response = await handleMessage(payload, client);
  if (response === null) {
    return new Response(null, { status: 202, headers: CORS_HEADERS });
  }
  return json(response);
}
