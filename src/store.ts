/**
 * SQLite persistence layer for mcp-relay.
 *
 * Wraps a single better-sqlite3 connection and exposes typed CRUD helpers that
 * the MCP tools call. The database doubles as a permanent audit log: every
 * message and every registration is recorded and never deleted. Liveness
 * (active/inactive) is derived from `last_heartbeat` at read time rather than
 * stored as ground truth, so a crashed agent naturally ages out.
 */

import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type {
  Agent,
  AgentRow,
  Message,
  MessageRow,
  MessageStatus,
} from "./types.js";

/** Agents not seen within this window are reported as "inactive". */
export const DEFAULT_STALE_MS = 60_000;

/** Generate a message id of the form `msg-{timestamp}-{random}`. */
function newMessageId(now: number): string {
  return `msg-${now}-${randomUUID().slice(0, 8)}`;
}

/** Map a raw agents row into a clean {@link Agent}, deriving live status. */
function rowToAgent(row: AgentRow, now: number, staleMs: number): Agent {
  return {
    id: row.id,
    name: row.name,
    capabilities: JSON.parse(row.capabilities) as string[],
    status: now - row.last_heartbeat <= staleMs ? "active" : "inactive",
    first_registered: row.first_registered,
    last_heartbeat: row.last_heartbeat,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/** Map a raw messages row into a clean {@link Message} (nulls → undefined). */
function rowToMessage(row: MessageRow): Message {
  return {
    id: row.id,
    from_agent: row.from_agent,
    to_agent: row.to_agent,
    action: row.action,
    query: row.query,
    response: row.response ?? undefined,
    status: row.status,
    error_details: row.error_details ?? undefined,
    parent_message_id: row.parent_message_id ?? undefined,
    timestamp: row.timestamp,
    response_timestamp: row.response_timestamp ?? undefined,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export class Store {
  private readonly db: Database.Database;
  private readonly staleMs: number;

  constructor(dbPath: string, staleMs: number = DEFAULT_STALE_MS) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.staleMs = staleMs;
    this.migrate();
  }

  /** Create tables and indexes if they don't already exist. */
  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agents (
        id               TEXT PRIMARY KEY,
        name             TEXT NOT NULL UNIQUE,
        capabilities     TEXT NOT NULL DEFAULT '[]',
        status           TEXT NOT NULL DEFAULT 'active',
        first_registered INTEGER NOT NULL,
        last_heartbeat   INTEGER NOT NULL,
        created_at       INTEGER NOT NULL,
        updated_at       INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS messages (
        id                TEXT PRIMARY KEY,
        from_agent        TEXT NOT NULL,
        to_agent          TEXT NOT NULL,
        action            TEXT NOT NULL,
        query             TEXT NOT NULL,
        response          TEXT,
        status            TEXT NOT NULL DEFAULT 'pending',
        error_details     TEXT,
        parent_message_id TEXT,
        timestamp         INTEGER NOT NULL,
        response_timestamp INTEGER,
        created_at        INTEGER NOT NULL,
        updated_at        INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_messages_to_status
        ON messages (to_agent, status);
      CREATE INDEX IF NOT EXISTS idx_messages_from_status
        ON messages (from_agent, status);
      CREATE INDEX IF NOT EXISTS idx_messages_timestamp
        ON messages (timestamp);
    `);
  }

  // ---------------------------------------------------------------------------
  // Agents
  // ---------------------------------------------------------------------------

  /**
   * Register an agent or refresh an existing one by name. Re-registering with
   * the same name keeps the original id and `first_registered`, updates
   * capabilities, and bumps the heartbeat.
   */
  registerAgent(name: string, capabilities: string[], now: number): Agent {
    const existing = this.db
      .prepare("SELECT * FROM agents WHERE name = ?")
      .get(name) as AgentRow | undefined;

    const caps = JSON.stringify(capabilities);

    if (existing) {
      this.db
        .prepare(
          `UPDATE agents
             SET capabilities = ?, status = 'active', last_heartbeat = ?, updated_at = ?
           WHERE name = ?`
        )
        .run(caps, now, now, name);
      return this.getAgent(name)!;
    }

    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO agents
           (id, name, capabilities, status, first_registered, last_heartbeat, created_at, updated_at)
         VALUES (?, ?, ?, 'active', ?, ?, ?, ?)`
      )
      .run(id, name, caps, now, now, now, now);
    return this.getAgent(name)!;
  }

  /** Fetch a single agent by name, or undefined if not registered. */
  getAgent(name: string, now: number = Date.now()): Agent | undefined {
    const row = this.db
      .prepare("SELECT * FROM agents WHERE name = ?")
      .get(name) as AgentRow | undefined;
    return row ? rowToAgent(row, now, this.staleMs) : undefined;
  }

  /** List all registered agents with live-derived status. */
  getAllAgents(now: number = Date.now()): Agent[] {
    const rows = this.db
      .prepare("SELECT * FROM agents ORDER BY name")
      .all() as AgentRow[];
    return rows.map((r) => rowToAgent(r, now, this.staleMs));
  }

  /**
   * Update an agent's heartbeat timestamp. Returns true if the agent exists.
   */
  heartbeat(name: string, now: number): boolean {
    const result = this.db
      .prepare(
        "UPDATE agents SET last_heartbeat = ?, updated_at = ? WHERE name = ?"
      )
      .run(now, now, name);
    return result.changes > 0;
  }

  // ---------------------------------------------------------------------------
  // Messages
  // ---------------------------------------------------------------------------

  /** Insert a new pending message and return it. */
  createMessage(
    params: {
      from_agent: string;
      to_agent: string;
      action: string;
      query: string;
      parent_message_id?: string;
    },
    now: number
  ): Message {
    const id = newMessageId(now);
    this.db
      .prepare(
        `INSERT INTO messages
           (id, from_agent, to_agent, action, query, response, status,
            error_details, parent_message_id, timestamp, response_timestamp,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, NULL, 'pending', NULL, ?, ?, NULL, ?, ?)`
      )
      .run(
        id,
        params.from_agent,
        params.to_agent,
        params.action,
        params.query,
        params.parent_message_id ?? null,
        now,
        now,
        now
      );
    return this.getMessage(id)!;
  }

  /** Fetch a single message by id. */
  getMessage(id: string): Message | undefined {
    const row = this.db
      .prepare("SELECT * FROM messages WHERE id = ?")
      .get(id) as MessageRow | undefined;
    return row ? rowToMessage(row) : undefined;
  }

  /** All pending messages addressed to `agent`, oldest first. */
  getIncomingMessages(agent: string): Message[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM messages
          WHERE to_agent = ? AND status = 'pending'
          ORDER BY timestamp ASC`
      )
      .all(agent) as MessageRow[];
    return rows.map(rowToMessage);
  }

  /** All answered messages that `agent` originally sent, newest first. */
  getResponses(agent: string): Message[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM messages
          WHERE from_agent = ? AND status = 'answered'
          ORDER BY response_timestamp DESC`
      )
      .all(agent) as MessageRow[];
    return rows.map(rowToMessage);
  }

  /**
   * Attach a response to a message and mark it answered. Returns the updated
   * message, or undefined if no such message exists.
   */
  respondToMessage(
    id: string,
    response: string,
    now: number
  ): Message | undefined {
    const result = this.db
      .prepare(
        `UPDATE messages
            SET response = ?, status = 'answered', response_timestamp = ?, updated_at = ?
          WHERE id = ?`
      )
      .run(response, now, now, id);
    return result.changes > 0 ? this.getMessage(id) : undefined;
  }

  /** Mark a message as errored with details. Returns the updated message. */
  setMessageError(
    id: string,
    errorDetails: string,
    now: number
  ): Message | undefined {
    const result = this.db
      .prepare(
        `UPDATE messages
            SET status = 'error', error_details = ?, updated_at = ?
          WHERE id = ?`
      )
      .run(errorDetails, now, id);
    return result.changes > 0 ? this.getMessage(id) : undefined;
  }

  /**
   * Paginated full message history (newest first), for the `message_history`
   * resource and debugging. Optionally filter by status.
   */
  getHistory(
    opts: { limit?: number; offset?: number; status?: MessageStatus } = {}
  ): Message[] {
    const limit = Math.min(Math.max(opts.limit ?? 100, 1), 1000);
    const offset = Math.max(opts.offset ?? 0, 0);

    if (opts.status) {
      const rows = this.db
        .prepare(
          `SELECT * FROM messages WHERE status = ?
            ORDER BY timestamp DESC LIMIT ? OFFSET ?`
        )
        .all(opts.status, limit, offset) as MessageRow[];
      return rows.map(rowToMessage);
    }

    const rows = this.db
      .prepare(
        `SELECT * FROM messages ORDER BY timestamp DESC LIMIT ? OFFSET ?`
      )
      .all(limit, offset) as MessageRow[];
    return rows.map(rowToMessage);
  }

  /** Close the underlying database connection. */
  close(): void {
    this.db.close();
  }
}
