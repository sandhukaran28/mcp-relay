# mcp-relay

> A local MCP server that lets multiple Claude Code instances talk to each other.

`mcp-relay` is a lightweight HTTP [Model Context Protocol](https://modelcontextprotocol.io)
server that acts as a **bidirectional message broker** between several Claude Code
agents. Agents register themselves, send each other queries, and poll for
responses — all routed through one shared server with a full SQLite audit log.

---

## The problem

When you work on a split frontend/backend project, you often have **two VS Code
windows open, each running Claude Code** — one in the frontend repo, one in the
backend repo. They can't see each other. So you end up as the human clipboard:
copy a question from the frontend window, paste it into the backend window, copy
the answer back, and so on.

## The solution

Run `mcp-relay` once in the background. Point both Claude Code windows at it as an
MCP server. Now the two agents can coordinate directly:

```
Frontend Claude:  "I'm building an upload feature. Does the backend have a
                   bulk-post endpoint?"
        │
        ├─ send_message(to: "backend", action: "check_endpoint",
        │               query: "POST /api/posts/bulk ?")
        ▼
   [ mcp-relay queues the message ]
        ▼
Backend Claude:   get_incoming_messages(for_agent: "backend")
                  → sees the question, checks the code
                  → respond_to_message(id, "Not found. Created it.
                                            Returns {id, status, created_at}")
        ▼
Frontend Claude:  get_message_responses(for_agent: "frontend")
                  → reads the answer, keeps building the UI with the real shape
```

No manual copy-paste. The agents never talk directly — everything goes through
the relay, which keeps a permanent record.

---

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│              mcp-relay  (HTTP, localhost:3000)            │
├──────────────────────────────────────────────────────────┤
│  Per MCP session: one McpServer instance                 │
│  Shared across all sessions: ONE SQLite store            │
│                                                          │
│  SQLite (context-bridge.db):                             │
│   ├─ agents    — registration + last heartbeat           │
│   └─ messages  — full audit log of every message         │
└──────────────────────────────────────────────────────────┘
        ▲                                  ▲
        │ HTTP (MCP, polling)              │ HTTP (MCP, polling)
        │                                  │
  Frontend Claude                    Backend Claude
  (VS Code window 1)                 (VS Code window 2)
```

Each Claude Code window opens its **own MCP session** (its own `initialize`
handshake), but every session is wired to the **same SQLite store** — that shared
state is how an agent in one window sees a message written by an agent in another.

**Communication is polling-based.** Agents pull messages when they're ready
(`get_incoming_messages`, `get_message_responses`) rather than being interrupted.
This fits how Claude Code works and keeps the system simple and crash-resilient:
if one agent goes away, its messages just wait in the queue.

**Liveness is derived, not stored.** An agent's `active`/`inactive` status is
computed from how long ago it last sent a `heartbeat` (default window: 60s), so a
crashed agent ages out automatically with no cleanup job.

---

## Tools

Agents call these to *do* things:

| Tool | What it does |
|------|--------------|
| `register_agent` | Announce yourself (name + capabilities). Idempotent by name. |
| `send_message` | Queue a message to another agent. Returns a `message_id`. |
| `get_incoming_messages` | Poll for pending messages addressed to you. |
| `respond_to_message` | Answer a message you received; routes back to the sender. |
| `get_message_responses` | Poll for answers to messages you sent. |
| `get_active_agents` | Discover who's registered and currently active. |
| `heartbeat` | Refresh your liveness so others see you as active. |

## Resources

Agents read these for context (read-only):

| Resource | URI | What it returns |
|----------|-----|-----------------|
| `message_history` | `relay://messages/history` | Newest-100 audit log of all messages. |
| `agent_status` | `relay://agents/status` | Live state of every registered agent. |

---

## Getting started

### Prerequisites

- Node.js **20+**
- npm

### Install & build

```bash
git clone https://github.com/sandhukaran28/mcp-relay.git
cd mcp-relay
npm install
npm run build
```

### Run the server

```bash
npm start
```

You should see:

```
[mcp-relay] listening on http://127.0.0.1:3000/mcp (db: context-bridge.db)
```

Quick health check from another terminal:

```bash
curl http://127.0.0.1:3000/health
# {"status":"ok","server":{"name":"mcp-relay","version":"0.1.0"},...}
```

During development you can run it with live reload instead:

```bash
npm run dev
```

---

## Integrating with Claude Code

`mcp-relay` uses **HTTP transport**, so the server runs as its own long-lived
process and each Claude Code window connects to it over HTTP. (This is what lets
*N* agents share one server — unlike stdio, which is one client per process.)

**1. Start the relay** (leave it running):

```bash
npm start
```

**2. Add it to each project** as an HTTP MCP server. In each repo's `.mcp.json`
(or via `claude mcp add`):

```json
{
  "mcpServers": {
    "mcp-relay": {
      "type": "http",
      "url": "http://127.0.0.1:3000/mcp"
    }
  }
}
```

**3. In each window, have the agent register on startup**, e.g. tell the frontend
Claude: *"Register with mcp-relay as 'frontend', then check for any messages."*
and the backend Claude the same with `'backend'`. From there they can
`send_message` / `respond_to_message` to coordinate.

---

## Configuration

All settings are environment variables with local-dev defaults:

| Variable | Default | Description |
|----------|---------|-------------|
| `RELAY_PORT` | `3000` | Port the HTTP server listens on. |
| `RELAY_HOST` | `127.0.0.1` | Interface to bind (loopback only by default). |
| `RELAY_DB` | `context-bridge.db` | SQLite file path. Use `:memory:` for ephemeral. |
| `RELAY_STALE_MS` | `60000` | Heartbeat age (ms) after which an agent is `inactive`. |

Example:

```bash
RELAY_PORT=4000 RELAY_DB=/tmp/relay.db npm start
```

---

## How it works (message lifecycle)

```
register_agent ──► agent stored, marked active
                       │
send_message ──────────┼──► message stored as "pending" (+ audit log)
                       │
get_incoming_messages ─┼──► recipient pulls its pending messages
                       │
respond_to_message ────┼──► message → "answered", response attached
                       │
get_message_responses ─┴──► original sender pulls the answer
```

A message moves `pending → answered` (or `error`). `parent_message_id` threads
follow-ups back to the message they reply to, so multi-turn exchanges stay linked.

---

## Project structure

```
mcp-relay/
├── src/
│   ├── server.ts      # Express + Streamable HTTP MCP transport, sessions
│   ├── store.ts       # SQLite layer (schema + typed CRUD)
│   ├── tools.ts       # The 7 MCP tools
│   ├── resources.ts   # The 2 MCP resources
│   ├── config.ts      # Env-driven configuration
│   └── types.ts       # Shared TypeScript types
├── build/             # Compiled output (generated)
├── package.json
└── tsconfig.json
```

## Tech stack

- **Node.js + TypeScript** (ESM, strict)
- **@modelcontextprotocol/sdk** — MCP server + Streamable HTTP transport
- **Express** — HTTP layer
- **better-sqlite3** — synchronous SQLite, audit log
- **zod** — tool input validation

## License

MIT
