#!/usr/bin/env node
/**
 * Node HTTP entry point — for self-hosting the remote connector anywhere that
 * runs Node (Fly, Render, Railway, a VM), and for testing the Worker logic
 * locally without Cloudflare.
 */

import { createServer, type IncomingMessage } from "node:http";

import { checkSharedSecret, clientFromEnv, type Env } from "./config.js";
import { CORS_HEADERS, handleHttp, SERVER_INFO } from "./mcp.js";

const env = process.env as Env;
const port = Number(process.env.PORT ?? 8787);

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 4_000_000) reject(new Error("Request body too large."));
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${port}`);

  const send = (status: number, body: unknown) => {
    res.writeHead(status, { "Content-Type": "application/json", ...CORS_HEADERS });
    res.end(JSON.stringify(body, null, 2));
  };

  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS_HEADERS);
    return res.end();
  }

  if (url.pathname === "/" || url.pathname === "/health") {
    return send(200, {
      server: SERVER_INFO,
      status: "ok",
      mcp_endpoint: `http://localhost:${port}/mcp`,
      auth_required: Boolean(env.MCP_SHARED_SECRET),
    });
  }

  if (url.pathname !== "/mcp") {
    return send(404, { error: "Not found. The MCP endpoint is at /mcp." });
  }

  const gate = checkSharedSecret(env, req.headers.authorization ?? null);
  if (gate) return send(401, { error: gate });

  try {
    const body = req.method === "POST" ? await readBody(req) : undefined;
    const request = new Request(url, {
      method: req.method,
      headers: Object.entries(req.headers).flatMap(([k, v]) =>
        v === undefined ? [] : [[k, Array.isArray(v) ? v.join(", ") : v] as [string, string]],
      ),
      body: body || undefined,
    });

    const token = (req.headers["x-SevenRooms-token"] as string | undefined) ?? undefined;
    const client = clientFromEnv(env, token);
    const response = await handleHttp(request, client);

    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key] = value;
    });
    res.writeHead(response.status, headers);
    res.end(response.body ? Buffer.from(await response.arrayBuffer()) : undefined);
  } catch (err) {
    send(500, { error: (err as Error)?.message ?? "Internal error" });
  }
});

server.listen(port, () => {
  console.log(`SevenRooms MCP server listening on http://localhost:${port}/mcp`);
});
