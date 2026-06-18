/**
 * MCP resource registrations for mcp-relay.
 *
 * Resources are read-only views an agent can fetch for context, as opposed to
 * tools which perform actions. {@link registerResources} attaches both relay
 * resources to a given {@link McpServer}, backed by the shared {@link Store}.
 *
 *   - message_history (relay://messages/history)
 *       Paginated audit log of every message. Supports query params:
 *       ?limit=<1..1000>&offset=<n>&status=<pending|answered|error>
 *   - agent_status (relay://agents/status)
 *       Current state of all registered agents with live-derived status.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Store } from "./store.js";

const HISTORY_URI = "relay://messages/history";
const AGENT_STATUS_URI = "relay://agents/status";

/** Newest-N messages returned by the history resource. */
const HISTORY_LIMIT = 100;

/** Wrap a JSON-serializable value as a single MCP resource content entry. */
function jsonContents(uri: string, value: unknown) {
  return {
    contents: [
      {
        uri,
        mimeType: "application/json",
        text: JSON.stringify(value, null, 2),
      },
    ],
  };
}

export function registerResources(server: McpServer, store: Store): void {
  // ---------------------------------------------------------------------------
  // message_history — recent audit log (newest first).
  // ---------------------------------------------------------------------------
  server.registerResource(
    "message_history",
    HISTORY_URI,
    {
      title: "Message History",
      description:
        "Audit log of the most recent messages sent through the relay (newest " +
        `first, up to ${HISTORY_LIMIT}). Useful for debugging, replaying a ` +
        "conversation, or auditing what happened across all agents.",
      mimeType: "application/json",
    },
    async (uri: URL) => {
      const messages = store.getHistory({ limit: HISTORY_LIMIT });
      return jsonContents(uri.toString(), {
        count: messages.length,
        limit: HISTORY_LIMIT,
        messages,
      });
    }
  );

  // ---------------------------------------------------------------------------
  // agent_status — current state of all agents.
  // ---------------------------------------------------------------------------
  server.registerResource(
    "agent_status",
    AGENT_STATUS_URI,
    {
      title: "Agent Status",
      description:
        "Current state of every registered agent: name, capabilities, live " +
        "status (active/inactive based on heartbeat age), and last-seen time. " +
        "Read this to see who is available before messaging them.",
      mimeType: "application/json",
    },
    async (uri: URL) => {
      const now = Date.now();
      const agents = store.getAllAgents(now).map((a) => ({
        name: a.name,
        status: a.status,
        capabilities: a.capabilities,
        first_registered: a.first_registered,
        last_heartbeat: a.last_heartbeat,
        last_heartbeat_age_ms: now - a.last_heartbeat,
      }));

      return jsonContents(uri.toString(), {
        count: agents.length,
        active: agents.filter((a) => a.status === "active").length,
        agents,
      });
    }
  );
}
