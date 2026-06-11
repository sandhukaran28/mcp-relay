/**
 * MCP tool registrations for mcp-relay.
 *
 * {@link registerTools} attaches every relay tool to a given {@link McpServer},
 * backed by a shared {@link Store}. The server skeleton calls this once per MCP
 * session so each connected agent sees the same tool surface.
 *
 * For now this registers only a `ping` tool to verify the transport wiring.
 * The seven relay tools (register_agent, send_message, ...) land in the next step.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Store } from "./store.js";

/** JSON-stringify a value into a single MCP text-content tool result. */
function jsonResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  };
}

export function registerTools(server: McpServer, _store: Store): void {
  server.registerTool(
    "ping",
    {
      title: "Ping",
      description:
        "Health check. Returns 'pong' and the server time so a connected " +
        "agent can confirm the relay is reachable.",
      inputSchema: {
        note: z
          .string()
          .optional()
          .describe("Optional text echoed back in the response."),
      },
    },
    async ({ note }) => {
      return jsonResult({
        ok: true,
        message: "pong",
        note: note ?? null,
        server_time: Date.now(),
      });
    }
  );
}
