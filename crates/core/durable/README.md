# <img src="https://raw.githubusercontent.com/amajorai/ryu/main/.github/logo.png" width="50" align="middle" alt="" />&nbsp; ryu-durable

> Durable-execution primitive for Ryu. Part of [Ryu](../../../README.md).

[![License](https://shieldcn.dev/badge/License-Apache--2.0-73DC8C.svg?logo=apache&logoColor=white)](../../../apps/core/LICENSE)
[![Stack](https://shieldcn.dev/badge/Rust-Crate-dea584.svg?logo=rust&logoColor=white)](../../../README.md)

`ryu-durable` is the checkpoint/resume/replay backend behind Ryu's durable workflow execution (M5). It owns the swap-seam and the crash-recoverable run-state store; the execution *semantics* stay with the consumer.

## What it provides

- **`DurableEngine<W, R>`** — the backend seam a durable run flows through (`execute` / `checkpoint` / `resume`). Generic over the caller's workflow (`W`) and run-state (`R`) types, so the crate never depends on any concrete workflow model. One in-process impl exists today — Core's `FallbackEngine` (the petgraph topological executor, which *is* the workflow-app and stays Core-side).
- **`FileCheckpointStore`** — the directory-backed, atomically-durable run-state store. Each record is one `<dir>/<id>.json` written via temp-file + `fsync` + atomic rename, so a crash mid-write can never leave a torn file: a reader always sees either the previous or the new complete state. Generic over any `serde`-serializable record keyed by a path-safe id (`validate_id`).

- **`CheckpointStore`** — the pluggable, namespaced store seam (`put` / `get` / `delete` / `list` of JSON records, plus typed `save` / `load` helpers). Backends:

  | Backend | Feature | Where records live | Durability |
  | --- | --- | --- | --- |
  | `file` (default) | always | `<dir>/<id>.json`, one directory per namespace | temp + `fsync` + rename |
  | `memory` | always | process memory | none (tests, ephemeral runs) |
  | `postgres` | `postgres` (default) | one `JSONB` row per record in `ryu_durable_checkpoints` (created on first use) | Postgres commit |
  | `redis` | `redis` (default) | `<prefix>:<ns>:rec:<id>` strings + a `<prefix>:<ns>:ids` set, written in `MULTI`/`EXEC` | the server's (use `appendonly yes`) |

  `CheckpointStoreConfig::from_env()` reads `RYU_DURABLE_BACKEND` (`file` \| `memory` \| `postgres` \| `redis`), `RYU_DURABLE_POSTGRES_URL`, `RYU_DURABLE_POSTGRES_TABLE`, `RYU_DURABLE_REDIS_URL`, and `RYU_DURABLE_REDIS_PREFIX`; `CheckpointBackend::open(&config)?.store(namespace, file_dir)` returns an `Arc<dyn CheckpointStore>`. Connection URLs are never serialized and are redacted in errors and `describe()`. Network backends connect lazily.

## Conformance suite

`tests/checkpoint_conformance.rs` runs one contract (absent → `None`, atomic last-write-wins, `delete` reports existence, bytewise-sorted `list`, namespace isolation, id validation before I/O, concurrent writers, large records, visibility through a fresh handle) against `file`, `memory`, and Redis over an in-process RESP server on every run, and against live servers when the variables are set:

```bash
RYU_TEST_REDIS_URL=redis://127.0.0.1:6379/15 \
RYU_TEST_POSTGRES_URL='postgres://postgres@127.0.0.1:5432/postgres?sslmode=disable' \
  cargo test -p ryu-durable --test checkpoint_conformance -- --nocapture
```

Unset variables print `SKIPPED …` and pass.

## Role in the decomposition

An extracted Core capability crate compiled in-process as a **non-optional path dependency** — the workflow store checkpoints every node through it. **ZERO dependency on `apps/core`.**

**Swap-seam:** the `DurableEngine` trait re-admits an external Temporal / Restate / DBOS sidecar backend with no server-handler churn. What stays Core-side (`apps/core/src/workflow/{store,durable}.rs`): the topological/`While`-iteration/`Awakeable`-HITL semantics, the concrete `WorkflowRun` data model, and the `FallbackEngine` / `select_engine` host wiring. Sessions and workflows remain cheap, centrally-legible rows that gain checkpoint/resume — not resident actor processes.

Placement (CLAUDE.md §1): durability decides *what runs* (which step, resumed from where), so Core.

## Build

```bash
cargo build -p ryu-durable
cargo test  -p ryu-durable
```

## License

Apache-2.0; see [LICENSE](../../../apps/core/LICENSE). © 2026 A Major Pte. Ltd.
