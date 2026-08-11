#!/usr/bin/env node
/**
 * Local stdio entry point — for Claude Desktop and Claude Code.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { clientFromEnv } from "./config.js";
import { SERVER_INFO } from "./mcp.js";
import { callTool, listTools } from "./tools.js";

async function main() {
  const client = clientFromEnv(process.env as Record<string, string>);

  const server = new Server(SERVER_INFO, {
    capabilities: { tools: { listChanged: false } },
  });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: listTools(client.allowWrites),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { text, isError } = await callTool(
      request.params.name,
      (request.params.arguments ?? {}) as Record<string, unknown>,
      client,
    );
    return { content: [{ type: "text" as const, text }], isError };
  });

  await server.connect(new StdioServerTransport());
  // stdout is the transport; anything human-readable must go to stderr.
  console.error(
    `7shifts MCP server ready on stdio (writes ${client.allowWrites ? "ENABLED" : "disabled"}).`,
  );
}

main().catch((err) => {
  console.error("Failed to start 7shifts MCP server:", err?.message ?? err);
  process.exit(1);
});
