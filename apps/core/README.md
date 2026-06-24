# <img src="https://raw.githubusercontent.com/amajorai/ryu/main/.github/logo.png" width="50" align="center" alt="" />&nbsp; Ryu Core

> The local backend and orchestration engine for AI agents. Part of [Ryu](../../README.md).

[![License](https://shieldcn.dev/badge/License-Apache--2.0-73DC8C.svg?logo=apache&logoColor=white)](./LICENSE)
[![Stack](https://shieldcn.dev/badge/Rust-Axum-dea584.svg?logo=rust&logoColor=white)](../../README.md)

Ryu Core is the real local backend: a Rust/Axum service that manages agent runtimes, routes chat, and owns sessions, memory, retrieval, tools, and workflows. It decides *what runs* (which agent, session, workflow, tool) and hands every model call to the Gateway. It runs headless and local-first, with no UI or cloud required.

**Tier:** OSS, self-hostable — Apache-2.0

## Stack

- Rust + Axum (Tokio async, Tower/Tower-HTTP middleware)
- SQLite via `rusqlite` (bundled) + `sqlite-vec` for vector storage
- ACP (`agent-client-protocol`) + `rmcp` for the MCP bridge
- `utoipa` for the generated OpenAPI spec

## Run standalone

```bash
# From this directory
cargo build --release        # produces the `ryu-core` binary in target/release

./target/release/ryu-core    # binds 127.0.0.1:7980 by default
```

Self-hosting: run Core alongside the [Ryu Gateway](../gateway/README.md), then point any OpenAI-compatible client at the Gateway. Core spawns and manages the Gateway as a sidecar on the default chat path.

Key environment variables:

- `RYU_BIND` — bind address (default `127.0.0.1:7980`)
- `RYU_TOKEN` — optional bearer token for API auth
- `RUST_LOG` — log level (e.g. `ryu_core=debug,info`)

OpenAPI: `ryu-core --dump-openapi` writes the spec, also served at `GET /api/openapi.json`.

## What it does

- **Sidecar lifecycle manager** — downloads, checksum-verifies, installs, spawns, and health-checks ~16 sidecars (agent runtimes, model providers, tools)
- **Chat routing** — an ACP adapter (spawns ACP agents, streams in Vercel AI SDK format) and an OpenAI-compat adapter
- **Sessions** — conversations, chat branching/fork, and encrypted long-term memory
- **Spaces / RAG** — retrieval over sqlite-vec, plus a `/goal` persistent completion condition
- **MCP registry** — registers and dispatches tools (reaches Ghost and Shadow over HTTP, no crate coupling)
- **Workflow DAG + sub-agent delegation** and a scheduler
- **Unified tool registry + PTC sandbox** — searchable tool catalog plus a programmatic tool-calling sandbox
- **Model catalog** — browse and install HF GGUF models; active-engine swap; a Pi config layer
- **Skills catalog** — browse and install Agent Skills from skills.sh into the universal skills dir
- **Website monitors** — price/content/stock/keyword/uptime checks with change alerting
- **Mesh** — opt-in Tailscale userspace networking
- **Git-native workspace** — per-run worktrees, diff capture, merge/PR apply
- **Wasmtime sandbox** — ephemeral WASI module execution (opt-in `sandbox-wasmtime` feature)

## License

Apache-2.0 — see [LICENSE](./LICENSE). © 2026 A Major Pte. Ltd.
