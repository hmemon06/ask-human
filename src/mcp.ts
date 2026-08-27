/**
 * Stdio MCP shim for local use: Claude Code spawns this; it forwards ask_human to the HTTP
 * service (POST /call). For hosted use, point Claude Code at the service's /mcp endpoint instead.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { config } from "./config.js";
import { createAskHumanServer } from "./mcp-tool.js";
import type { AskHumanResult } from "./sessions.js";

const server = createAskHumanServer(async (context): Promise<AskHumanResult> => {
  const res = await fetch(`${config.serverUrl}/call`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(config.askHumanToken ? { Authorization: `Bearer ${config.askHumanToken}` } : {}),
    },
    body: JSON.stringify({ context }),
    signal: AbortSignal.timeout(config.callTimeoutMs + 60_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`ask-human server error (${res.status}): ${text}`);
  return JSON.parse(text) as AskHumanResult;
});

await server.connect(new StdioServerTransport());
