# <img src="https://raw.githubusercontent.com/amajorai/ryu/main/.github/logo.png" width="50" align="middle" alt="" />&nbsp; ryu-durable

> Durable-execution primitive for Ryu. Part of [Ryu](../../README.md).

[![License](https://shieldcn.dev/badge/License-Apache--2.0-73DC8C.svg?logo=apache&logoColor=white)](./LICENSE)
[![Stack](https://shieldcn.dev/badge/Rust-Crate-dea584.svg?logo=rust&logoColor=white)](../../README.md)

`ryu-durable` is the checkpoint/resume/replay backend behind Ryu's durable workflow execution (M5). It owns the swap-seam and the crash-recoverable run-state store; the execution *semantics* stay with the consumer.

## What it provides

- **`DurableEngine<W, R>`** — the backend seam a durable run flows through (`execute` / `checkpoint` / `resume`). Generic over the caller's workflow (`W`) and run-state (`R`) types, so the crate never depends on any concrete workflow model. One in-process impl exists today — Core's `FallbackEngine` (the petgraph topological executor, which *is* the workflow-app and stays Core-side).
- **`FileCheckpointStore`** — the directory-backed, atomically-durable run-state store. Each record is one `<dir>/<id>.json` written via temp-file + `fsync` + atomic rename, so a crash mid-write can never leave a torn file: a reader always sees either the previous or the new complete state. Generic over any `serde`-serializable record keyed by a path-safe id (`validate_id`).

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

Apache-2.0; see [LICENSE](./LICENSE). © 2026 A Major Pte. Ltd.
