# <img src="https://raw.githubusercontent.com/amajorai/ryu/main/.github/logo.png" width="50" align="middle" alt="" />&nbsp; Ryu Gateway

> The control layer that governs every model call. Part of [Ryu](../../README.md).

[![License](https://shieldcn.dev/badge/License-AGPL--3.0-4B78E6.svg?logo=gnu&logoColor=white)](./LICENSE)
[![Stack](https://shieldcn.dev/badge/Rust-Axum-dea584.svg?logo=rust&logoColor=white)](../../README.md)

Ryu Gateway is the control layer: a full LLM gateway that decides *what is allowed, shared, measured, and paid for*. It exposes an OpenAI-compatible API and sits in front of any agent, applying routing, caching, rate limiting, a firewall, evals, and audit to every request. Core runs it as a managed sidecar, and all default-route chat traffic flows through it.

**Tier:** OSS, self-hostable, AGPL-3.0

> **AGPL note (deliberate):** the Gateway is copyleft. Under AGPL §13, running a *modified* Gateway as a network service obligates you to offer its source to your users. This is intentional: it keeps the control layer open and prevents a SaaS competitor from forking it and closing the source. Unmodified self-hosting carries no such obligation.

## Stack

- Rust + Axum (Tokio async, Tower/Tower-HTTP middleware)
- SQLite via `rusqlite` (bundled) for exact caching
- `ed25519-dalek` + `hmac` for manifest signing and webhook verification

## Run standalone

Prerequisites: a Rust toolchain, a C compiler, `pkg-config` and the OpenSSL
headers (`build-essential pkg-config libssl-dev` on Debian/Ubuntu).

```bash
# From the repository root (the Gateway has path dependencies in crates/ and vendor/)
cargo build --release --manifest-path apps/gateway/Cargo.toml
./target/release/ryu-gateway    # binds 127.0.0.1:7981 by default
```

Inside this monorepo the binary lands in the workspace `target/`; in a checkout
without the root `Cargo.toml` it lands in `apps/gateway/target/`. The container
image builds from the repository root: `docker build -f apps/gateway/Dockerfile .`.

Configuration (providers, cache, rate limits, circuit breaker) is loaded from
`$GATEWAY_CONFIG` when set, otherwise from `gateway.toml` in the platform config
directory: `~/.config/ryu/` on Linux, `~/Library/Application Support/ryu/` on
macOS, `%APPDATA%\ryu\` on Windows. A non-release `RYU_PROFILE` adds a suffix
(`ryu-dev`). The startup log names the file it loaded and warns when none exists
(the Gateway then runs on built-in defaults). Point any OpenAI-compatible client
at `http://localhost:7981/v1`.

Auth is on by default. With no keys configured, the Gateway writes
`gateway-admin.key` (administrator key) and `gateway-relay.key` (inference key)
next to `gateway.toml` on first start. They are sealed when the Gateway has a key
(`RYU_MASTER_KEY`, or the one Core passes it); print one with
`ryu-gateway print-key admin|relay`. Without a key they stay plaintext (`0600`). Every key must be at least 24 printable
characters with no whitespace.

The root `GET /` returns a short JSON description of the Gateway, or redirects
to `RYU_PRODUCT_DASHBOARD_URL` when that is set. The OpenAI-compatible and Ryu
API paths remain available for programmatic callers.

Key environment variables:

- `GATEWAY_CONFIG`: path to `gateway.toml`
- `GATEWAY_BIND`: listen address (or pass `--bind=`)
- `GATEWAY_MASTER_KEY`: a known administrator key instead of the generated one
- `RYU_PRODUCT_DASHBOARD_URL`, `RYU_CORS_ORIGINS`, `RYU_CORS_ALLOW_HOSTED_WEB`:
  root redirect and browser origins (see the standalone Gateway docs)
- `RUST_LOG`: defaults to `info`; set `ryu_gateway=debug,info` for Gateway debug output

Admin routes (`/v1/config`, `/v1/audit*`, `/v1/budget/spend`, `/v1/doctor*`,
metrics, evals and live traffic) require the administrator key, and that key
works from any peer. Only when auth is disabled, no master key is set, and mesh
and fleet mode are off does a loopback peer get credential-less admin access.
Exec routes (`/v1/exec/tool`, `/v1/exec/scan`, `/v1/exec/audit`,
`/v1/exec/budget/check`, `/sandbox/tick`, `/sandbox/quote`, `/sandbox/complete`) require a trusted-forwarder or
administrator key and are not limited by peer address. On a non-loopback bind,
keep both of those keys away from remote clients and give external callers the
inference key.

## What it does

- **OpenAI-compat API:** `POST /v1/chat/completions` with streaming
- **Multi-provider routing + fallback:** OpenAI, Anthropic, OpenRouter, local, and Core upstreams
- **Smart routing:** a cheap classifier picks the model per request from plain-language rules
- **Rate limiting:** per-user/per-endpoint buckets
- **Circuit breaker:** per-provider fault tolerance
- **Caching:** exact (SHA-256) and semantic (vector similarity)
- **Firewall:** request validation and content filtering
- **Skills + Composio:** custom handlers and external integrations
- **Evals + audit:** response-quality evaluation and request/response logging
- **Tool gateway:** a tool-search front plus `POST /v1/exec/tool` (allowlist + exec-budget + exec-audit)

## Footprint

<!-- BENCH:START (generated by scripts/benchmark.mjs, do not edit by hand) -->

One self-contained native binary: no interpreter, no runtime, no Electron, no Docker.

| Metric | Value |
| --- | --- |
| Release binary | 18.7 MB |
| Resolved crates (transitive deps) | 548 |
| Source | 98,280 lines of Rust across 113 files |
| Idle memory (RSS) | 17.0 MB |
| Idle CPU | 0.0% |

_Release binary and idle figures were last measured on `win32`; crate and source counts were refreshed from the tree on `linux`. Reproduce all of them with `node scripts/benchmark.mjs --build --runtime --write`._

<!-- BENCH:END -->

## License

AGPL-3.0. See [LICENSE](./LICENSE). © 2026 A Major Pte. Ltd.
