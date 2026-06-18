#!/usr/bin/env node
/**
 * mcp-relay — HTTP MCP server that brokers messages between Claude Code agents.
 *
 * Transport: Streamable HTTP with per-session servers. Each connecting agent
 * performs an MCP `initialize` handshake which mints a session id; subsequent
 * requests reuse that session. Every session gets its own {@link McpServer}
 * instance but they all share ONE {@link Store}, which is how agents in
 * different VS Code windows see each other's messages.
 *
 * Endpoints:
 *   POST   /mcp     MCP JSON-RPC (initialize + tool calls)
 *   GET    /mcp     server→client notification stream for a session
 *   DELETE /mcp     explicit session teardown
 *   GET    /health  plain liveness probe (no MCP)
 */

import express, { type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

import { loadConfig } from "./config.js";
import { Store } from "./store.js";
import { registerTools } from "./tools.js";
import { registerResources } from "./resources.js";

const SERVER_INFO = { name: "mcp-relay", version: "0.1.0" } as const;

const config = loadConfig();
const store = new Store(config.dbPath, config.staleMs);

/** Active transports keyed by MCP session id. */
const transports = new Map<string, StreamableHTTPServerTransport>();

/** Build a fresh MCP server wired to the shared store. */
function createMcpServer(): McpServer {
  const server = new McpServer(SERVER_INFO);
  registerTools(server, store);
  registerResources(server, store);
  return server;
}

const app = express();
app.use(express.json({ limit: "4mb" }));

app.get("/health", (_req: Request, res: Response) => {
  res.json({
    status: "ok",
    server: SERVER_INFO,
    sessions: transports.size,
    db: config.dbPath,
    time: Date.now(),
  });
});

// Main MCP endpoint: handles initialize (new session) and all follow-up calls.
app.post("/mcp", async (req: Request, res: Response) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;

  let transport: StreamableHTTPServerTransport | undefined = sessionId
    ? transports.get(sessionId)
    : undefined;

  if (!transport && isInitializeRequest(req.body)) {
    // New session: create a transport and connect a fresh server to it.
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        transports.set(id, transport!);
      },
    });

    transport.onclose = () => {
      if (transport!.sessionId) transports.delete(transport!.sessionId);
    };

    await createMcpServer().connect(transport);
  } else if (!transport) {
    res.status(400).json({
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message: "Bad Request: no valid session id and not an initialize request",
      },
      id: null,
    });
    return;
  }

  await transport.handleRequest(req, res, req.body);
});

// Server→client stream and teardown reuse the session's existing transport.
async function handleSessionRequest(req: Request, res: Response): Promise<void> {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  const transport = sessionId ? transports.get(sessionId) : undefined;
  if (!transport) {
    res.status(400).send("Invalid or missing session id");
    return;
  }
  await transport.handleRequest(req, res);
}

app.get("/mcp", handleSessionRequest);
app.delete("/mcp", handleSessionRequest);

const httpServer = app.listen(config.port, config.host, () => {
  console.error(
    `[mcp-relay] listening on http://${config.host}:${config.port}/mcp ` +
      `(db: ${config.dbPath})`
  );
});

/** Close transports, HTTP listener, and the database on shutdown. */
function shutdown(signal: string): void {
  console.error(`[mcp-relay] ${signal} received, shutting down...`);
  for (const transport of transports.values()) {
    void transport.close();
  }
  httpServer.close(() => {
    store.close();
    process.exit(0);
  });
  // Failsafe if connections refuse to drain.
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
