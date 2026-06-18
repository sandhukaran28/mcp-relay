/**
 * MCP tool registrations for mcp-relay.
 *
 * {@link registerTools} attaches every relay tool to a given {@link McpServer},
 * backed by a shared {@link Store}. The server skeleton calls this once per MCP
 * session so each connected agent sees the same tool surface.
 *
 * Tool descriptions are written for the *calling agent* (another Claude): they
 * explain when to reach for each tool, since the model picks tools by reading
 * these strings.
 *
 * Implemented so far (step 5):
 *   - register_agent
 *   - send_message
 *   - get_incoming_messages
 *   - get_message_responses
 * Still to come: respond_to_message, get_active_agents, heartbeat.
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

/** An agent name: non-empty, trimmed, no whitespace surprises. */
const agentName = z
  .string()
  .trim()
  .min(1, "agent name must not be empty")
  .max(64, "agent name too long");

export function registerTools(server: McpServer, store: Store): void {
  // ---------------------------------------------------------------------------
  // register_agent — announce this agent to the relay on startup.
  // ---------------------------------------------------------------------------
  server.registerTool(
    "register_agent",
    {
      title: "Register Agent",
      description:
        "Register yourself with the relay so other agents can find and message " +
        "you. Call this once when you start up. Pick a stable, human-readable " +
        "name like 'frontend' or 'backend' — other agents address messages to " +
        "that name. Re-registering with the same name is safe: it keeps your id " +
        "and updates your capabilities. 'capabilities' is a free-form list of " +
        "actions you can handle (e.g. ['check_endpoint','create_endpoint']).",
      inputSchema: {
        name: agentName.describe(
          "Your stable handle other agents will message, e.g. 'backend'."
        ),
        capabilities: z
          .array(z.string().trim().min(1))
          .default([])
          .describe("Actions you can handle, e.g. ['check_endpoint']."),
      },
    },
    async ({ name, capabilities }) => {
      const agent = store.registerAgent(name, capabilities, Date.now());
      return jsonResult({
        status: "registered",
        agent_id: agent.id,
        name: agent.name,
        capabilities: agent.capabilities,
        first_registered: agent.first_registered,
      });
    }
  );

  // ---------------------------------------------------------------------------
  // send_message — ask another agent something.
  // ---------------------------------------------------------------------------
  server.registerTool(
    "send_message",
    {
      title: "Send Message",
      description:
        "Send a message/question to another agent. The message is queued; the " +
        "recipient picks it up the next time it polls get_incoming_messages, and " +
        "its reply comes back to you via get_message_responses. Use 'action' as a " +
        "short verb for what you want (e.g. 'check_endpoint', 'create_api') and " +
        "'query' for the full request text. To continue a thread, pass the " +
        "parent_message_id of the message you're following up on. Returns the new " +
        "message_id — keep it to match the response later.",
      inputSchema: {
        to_agent: agentName.describe("Name of the recipient agent."),
        from_agent: agentName.describe("Your own registered agent name."),
        action: z
          .string()
          .trim()
          .min(1)
          .describe("Short verb for the request, e.g. 'check_endpoint'."),
        query: z
          .string()
          .min(1)
          .describe("The full question or request text."),
        parent_message_id: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe("Id of the message this replies to, for threading."),
      },
    },
    async ({ to_agent, from_agent, action, query, parent_message_id }) => {
      const recipient = store.getAgent(to_agent);
      const message = store.createMessage(
        { from_agent, to_agent, action, query, parent_message_id },
        Date.now()
      );
      return jsonResult({
        status: "sent",
        message_id: message.id,
        to_agent,
        // Surface a soft warning rather than failing: the recipient may simply
        // not have registered yet, but the message is still queued for them.
        recipient_known: Boolean(recipient),
        recipient_status: recipient?.status ?? "unregistered",
      });
    }
  );

  // ---------------------------------------------------------------------------
  // get_incoming_messages — pull messages addressed to you.
  // ---------------------------------------------------------------------------
  server.registerTool(
    "get_incoming_messages",
    {
      title: "Get Incoming Messages",
      description:
        "Poll for pending messages addressed to you (oldest first). Call this " +
        "periodically while you work. Each returned message includes its id, who " +
        "it's from, the action, and the query. After you've handled one, reply " +
        "with respond_to_message using its id so the sender gets your answer.",
      inputSchema: {
        for_agent: agentName.describe(
          "Your registered agent name — whose inbox to read."
        ),
      },
    },
    async ({ for_agent }) => {
      const messages = store.getIncomingMessages(for_agent);
      return jsonResult({ for_agent, count: messages.length, messages });
    }
  );

  // ---------------------------------------------------------------------------
  // get_message_responses — pull replies to messages you sent.
  // ---------------------------------------------------------------------------
  server.registerTool(
    "get_message_responses",
    {
      title: "Get Message Responses",
      description:
        "Poll for answers to messages YOU previously sent (newest first). Call " +
        "this after send_message to see if the other agent has responded yet. " +
        "Each result includes the original action/query plus the 'response' text " +
        "and when it arrived. Match results to your sent messages by message id.",
      inputSchema: {
        for_agent: agentName.describe(
          "Your registered agent name — whose sent messages to check."
        ),
      },
    },
    async ({ for_agent }) => {
      const responses = store.getResponses(for_agent);
      return jsonResult({ for_agent, count: responses.length, responses });
    }
  );
}
