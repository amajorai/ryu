# shadow-core

> Capture + semantic-search engine crate for Ryu's Shadow sidecar. Part of [Ryu](../../README.md).

[![License](https://shieldcn.dev/badge/License-Apache--2.0-73DC8C.svg?logo=apache&logoColor=white)](./LICENSE)
[![Stack](https://shieldcn.dev/badge/Rust-Crate-dea584.svg?logo=rust&logoColor=white)](../../README.md)

`shadow-core` is the storage and search engine behind the Shadow sidecar: append-only MessagePack event logs (zstd-compressed), a SQLite timeline for time-range queries, Tantivy full-text search, and vector embeddings for semantic recall. It backs Shadow's screen/audio/OCR capture and memory/search, and depends on the ghost-* crates for desktop perception.

**Tier:** OSS — Apache-2.0

## Install / Build

```bash
cargo build -p shadow-core
cargo test  -p shadow-core
```

## What it provides

- **Event storage** (`storage.rs`, `event.rs`) — append-only MessagePack log with zstd compression.
- **Timeline** (`timeline.rs`) — SQLite time-range index.
- **Search** (`search.rs`, `vector.rs`) — Tantivy full-text + vector semantic search.
- **Retention** and **behavioral / workflow extraction** (`retention.rs`, `behavioral.rs`, `workflow_extractor.rs`).

## License

Apache-2.0 — see [LICENSE](./LICENSE). © 2026 A Major Pte. Ltd.
