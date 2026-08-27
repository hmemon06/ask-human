/**
 * The single ask_human tool, shared by the stdio shim (src/mcp.ts) and the HTTP endpoint (/mcp).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ASK_HUMAN_TOOL_DESCRIPTION } from "./prompts.js";
import type { AskHumanResult } from "./sessions.js";

export type AskHumanRunner = (context: string) => Promise<AskHumanResult>;

export function createAskHumanServer(run: AskHumanRunner): McpServer {
  const server = new McpServer({ name: "ask-human", version: "0.2.0" });

  server.registerTool(
    "ask_human",
    {
      description: ASK_HUMAN_TOOL_DESCRIPTION,
      inputSchema: {
        context: z
          .string()
          .min(20)
          .describe(
            "Self-contained briefing for the voice agent: goal, relevant discoveries, the question/decision, your recommendation, constraints."
          ),
      },
    },
    async ({ context }, extra) => {
      // Keep the HTTP/SSE connection alive while the phone call runs (proxies drop idle streams).
      const keepalive = setInterval(() => {
        extra
          .sendNotification({ method: "notifications/message", params: { level: "info", data: "ask_human: call in progress" } })
          .catch(() => {});
      }, 20_000);
      try {
        const result = await run(context);
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      } catch (err) {
        const fallback: AskHumanResult = {
          status: "unavailable",
          summary: `ask_human failed: ${(err as Error).message}`,
          decisions: [],
          new_context: [],
          unresolved_questions: [],
        };
        return { content: [{ type: "text", text: JSON.stringify(fallback) }], isError: true };
      } finally {
        clearInterval(keepalive);
      }
    }
  );

  return server;
}
