# <img src="https://raw.githubusercontent.com/amajorai/ryu/main/.github/logo.png" width="50" align="middle" alt="" />&nbsp; shadow-core

> Capture, storage, and semantic-search engine crate for Ryu's Shadow sidecar. Part of [Ryu](../../README.md).

[![License](https://shieldcn.dev/badge/License-Apache--2.0-73DC8C.svg?logo=apache&logoColor=white)](./LICENSE)
[![Stack](https://shieldcn.dev/badge/Rust-Crate-dea584.svg?logo=rust&logoColor=white)](../../README.md)

`shadow-core` is the storage and search engine behind the Shadow sidecar. It captures screen/audio/OCR events into an append-only MessagePack log (zstd-compressed), indexes them in a SQLite timeline for time-range queries, and serves recall via Tantivy full-text search plus vector embeddings, including hybrid text + visual search and a media/keyframe retention tier.

**Tier:** OSS, Apache-2.0 (MIT-derived from Shadow; see [NOTICE](./NOTICE))

## Install / Build

```bash
cargo build -p shadow-core
cargo test  -p shadow-core
```

The crate exposes a process-global engine: `init_storage(data_dir)` once at startup, then the `write_event*` / `query_*` / `search_*` / `insert_*` free functions.

## What it provides

- **Event storage** (`storage.rs`, `event.rs`): append-only MessagePack log with zstd compression and segment rotation.
- **Timeline** (`timeline.rs`): SQLite time-range index for events, video/audio segments, sessions, app focus, and AX snapshots.
- **Search** (`search.rs`, `vector.rs`): Tantivy full-text + vector semantic search, with `search_hybrid` text/visual fusion and range-scoped variants.
- **Retention** (`retention.rs`): storage-usage accounting, cleanup planning, and hot/warm keyframe tiering.
- **Behavioral / workflow extraction** (`behavioral.rs`, `workflow_extractor.rs`).

## License

Apache-2.0; see [LICENSE](./LICENSE). Incorporates MIT-licensed portions of [Shadow](https://github.com/ghostwright/shadow); see [NOTICE](./NOTICE). © 2026 A Major Pte. Ltd.
