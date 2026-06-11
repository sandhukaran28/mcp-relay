/**
 * Core domain types for mcp-relay.
 *
 * These mirror the SQLite schema in {@link ./store.ts} and the shapes returned
 * by the MCP tools in {@link ./tools.ts}. Timestamps are Unix epoch milliseconds.
 */

/** Liveness state of a registered agent. */
export type AgentStatus = "active" | "inactive";

/** Lifecycle state of a message. */
export type MessageStatus = "pending" | "answered" | "error";

/**
 * A Claude Code instance registered with the relay.
 *
 * `name` is the human-facing handle other agents address messages to
 * (e.g. "frontend", "backend") and is unique across active agents.
 */
export interface Agent {
  id: string;
  name: string;
  capabilities: string[];
  status: AgentStatus;
  first_registered: number;
  last_heartbeat: number;
  created_at: number;
  updated_at: number;
}

/**
 * A single message routed through the relay.
 *
 * A message starts as `pending`, becomes `answered` once the recipient calls
 * `respond_to_message`, or `error` if it could not be processed. `parent_message_id`
 * threads follow-ups back to the message they reply to.
 */
export interface Message {
  id: string;
  from_agent: string;
  to_agent: string;
  action: string;
  query: string;
  response?: string;
  status: MessageStatus;
  error_details?: string;
  parent_message_id?: string;
  timestamp: number;
  response_timestamp?: number;
  created_at: number;
  updated_at: number;
}

/**
 * Row shape returned by SQLite for the `messages` table. better-sqlite3 hands
 * back `null` for absent columns, so the store layer maps this into a clean
 * {@link Message} (undefined for absent optionals) before returning.
 */
export interface MessageRow {
  id: string;
  from_agent: string;
  to_agent: string;
  action: string;
  query: string;
  response: string | null;
  status: MessageStatus;
  error_details: string | null;
  parent_message_id: string | null;
  timestamp: number;
  response_timestamp: number | null;
  created_at: number;
  updated_at: number;
}

/**
 * Row shape returned by SQLite for the `agents` table. `capabilities` is stored
 * as a JSON-encoded string and parsed into a string[] by the store layer.
 */
export interface AgentRow {
  id: string;
  name: string;
  capabilities: string;
  status: AgentStatus;
  first_registered: number;
  last_heartbeat: number;
  created_at: number;
  updated_at: number;
}
