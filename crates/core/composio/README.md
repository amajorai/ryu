# ryu-composio

Composio integration orchestration (Core side) — the user's Composio-account seam.
Owns the whole Composio surface: API-key resolution, toolkit/action/trigger browsing,
connection lifecycle, the persisted trigger-subscription store, and the MCP
execute-action path.

## Role in the decomposition

An extracted **Core capability crate**, compiled into `apps/core` as the in-process
default — every hot path is a direct function call, no IPC. Consolidated from
`apps/core/src/{composio_auth,composio_catalog,composio_connect,composio_triggers}`
and `sidecar/mcp/composio.rs`.

Zero dependency on `apps/core`. The only kernel couplings — starting a workflow run
or an agent run when a trigger fires — invert through the **`ComposioHost`** trait,
installed by Core at boot. **That trait is the swap seam.** The
`__ryu_elicitation__` connection-required envelope is built Core-side (from the shared
identity builder) around a typed `execute::ExecOutcome`; this crate does only the
Composio-specific detection. The *gateway-governed* Composio execute path is a
separate package.

## Modules

- `auth` — preferences-first API-key resolver.
- `catalog` — toolkit/action/trigger browse client.
- `connect` — connection initiate/status.
- `triggers` — persisted trigger-subscription store (SQLite), poll loop, and
  fail-closed **HMAC-SHA256** webhook verification (`ComposioTriggerStore`,
  `TriggerSubscription`, `set_global`).
- `execute` — MCP execute-action HTTP path + connection-required elicitation
  detection (`ExecOutcome`).
- `host` — the `ComposioHost` inversion seam (`set_global_host`).

## Consumed as

Compiled-into-Core crate; the webhook-delivered trigger leg is reached via
`ryu-webhook-ingress` (which forwards inbound deliveries back into this crate's
verify/run through its own host).

Deps: reqwest, tokio, rusqlite, sha2/hex (HMAC), url, uuid, chrono, async-trait.
