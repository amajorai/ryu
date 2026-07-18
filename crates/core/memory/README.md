# <img src="https://raw.githubusercontent.com/amajorai/ryu/main/.github/logo.png" width="50" align="middle" alt="" />&nbsp; ryu-memory

> Long-term memory primitive for Ryu. Part of [Ryu](../../README.md).

[![License](https://shieldcn.dev/badge/License-Apache--2.0-73DC8C.svg?logo=apache&logoColor=white)](./LICENSE)
[![Stack](https://shieldcn.dev/badge/Rust-Crate-dea584.svg?logo=rust&logoColor=white)](../../README.md)

`ryu-memory` owns the durable, cross-conversation facts an agent recalls (spec unit U11). It is the SQLite-backed, encryption-at-rest `MemoryStore` plus the multi-level scope model, category/importance/tags metadata, and scoped recall/CRUD. Long-term memory is **opt-in** (privacy-by-default): nothing is recorded or recalled unless the request enables it. Short-term memory (recent turns of the current conversation) is derived from the conversation store and needs no storage here.

## Role in the decomposition

Extracted from `apps/core/src/server/memory.rs` as an in-process capability crate (mirrors `ryu-crypto` / `ryu-search`). Compiled into Core as a **non-optional path dependency** — the chat auto-recall loop reaches it unconditionally. **ZERO dependency on `apps/core`.**

**Swap-seam / inversion:** the two Core couplings — the `~/.ryu` default db path and the bind-time owner backfill's org/account resolution — invert through plain constructor injection: `MemoryStore::open(path, node_bound, owner)`. The Core wiring lives in `apps/core/src/memory_host.rs`.

## What it provides

- **`MemoryStore`** — SQLite store; rows encrypted with the shared `ryu-crypto` master key.
- **`MemoryScope`** — multi-level scoping: `User` (visible everywhere) / `Node` (this machine) / `Project` (one working folder, `scope_id` = folder path). Which levels an agent may read is governed Core-side by its `MemorySlot.read_levels`.
- **`MemoryCategory`**, `importance`, `when_to_use` hint, free-form `tags` — all editable metadata.
- **`MemoryVisibility`** — caller/tenancy filter derived from `ryu-kernel-contracts` `ResourceKey`.

Placement (CLAUDE.md §1): durable facts are *what runs* (orchestration context), so Core.

## Build

```bash
cargo build -p ryu-memory
cargo test  -p ryu-memory
```

## License

Apache-2.0; see [LICENSE](./LICENSE). © 2026 A Major Pte. Ltd.
