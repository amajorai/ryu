# <img src="https://raw.githubusercontent.com/amajorai/ryu/main/.github/logo.png" width="50" align="middle" alt="" />&nbsp; ryu-collab

> Authoritative CRDT document engine for Ryu. Part of [Ryu](../../README.md).

[![License](https://shieldcn.dev/badge/License-Apache--2.0-73DC8C.svg?logo=apache&logoColor=white)](./LICENSE)
[![Stack](https://shieldcn.dev/badge/Rust-Crate-dea584.svg?logo=rust&logoColor=white)](../../README.md)

`ryu-collab` is Core's durable server-side replica of every live collaborative Yjs document (Phase 3 of the multi-user collaboration epic). "Authoritative" means **durable owner, not arbiter**: the underlying [`yrs`](https://crates.io/crates/yrs) CRDT converges without an arbiter, so Core never resolves conflicts — it stores, replays, and rebroadcasts the opaque Yjs update stream, and rehydrates late joiners.

## What it provides

- **`DocRegistry`** — keyed by `doc_id`, lazily rehydrates a `yrs::Doc` (snapshot + replayed update log) behind a per-doc single-writer `Mutex` (`yrs` doc mutation is `Send` but not `Sync`). CRDT primitives: `apply_remote_update`, `state_vector`, `diff_since`, `snapshot` (compaction), `materialize`, `flush_and_drop` (hibernation).
- **`CollabStore`** — rusqlite persistence at `~/.ryu/collab.db`: append-only `doc_updates` log + compacted `doc_snapshots` projection.
- **`DocSyncMessage`** — the self-framed wire protocol (1-byte tag + payload) riding `Frame::DocSync(Vec<u8>)`, plus the pure `classify_doc_sync` write-ACL gate.
- **Projection** (`projection.rs`) — the Y.Doc → source materialization the non-collaborative RAG/search readers consume.

## Role in the decomposition

An extracted Core capability crate consumed as a **non-optional in-process path dependency** — the kernel's `ServerState` holds a `DocRegistry` unconditionally and the `realtime_ws` transport drives it directly, never over IPC. **ZERO dependency on `apps/core`.**

**Swap-seam:** the single `~/.ryu` kernel coupling inverts through the narrow `CollabHost` trait (`ryu_dir`), set via `set_global_host`.

Placement (CLAUDE.md §1): storing and replaying live document state is *what runs*, so Core.

## Build

```bash
cargo build -p ryu-collab
cargo test  -p ryu-collab
```

## License

Apache-2.0; see [LICENSE](./LICENSE). © 2026 A Major Pte. Ltd.
