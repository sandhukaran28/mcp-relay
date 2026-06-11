/**
 * Runtime configuration, read once from environment variables.
 *
 * All settings are optional and fall back to sensible local-dev defaults so
 * the server runs with zero configuration. Override via the env vars below
 * (e.g. in the Claude Code MCP server config block).
 */

export interface Config {
  /** TCP port the HTTP server listens on. */
  port: number;
  /** Filesystem path to the SQLite database file. */
  dbPath: string;
  /** Milliseconds without a heartbeat before an agent is reported inactive. */
  staleMs: number;
  /** Host/interface to bind. Defaults to loopback only. */
  host: string;
}

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`Invalid integer for ${name}: ${JSON.stringify(raw)}`);
  }
  return parsed;
}

export function loadConfig(): Config {
  return {
    port: intFromEnv("RELAY_PORT", 3000),
    dbPath: process.env.RELAY_DB?.trim() || "context-bridge.db",
    staleMs: intFromEnv("RELAY_STALE_MS", 60_000),
    host: process.env.RELAY_HOST?.trim() || "127.0.0.1",
  };
}
