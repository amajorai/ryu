# <img src="https://raw.githubusercontent.com/amajorai/ryu/main/.github/logo.png" width="50" align="middle" alt="" />&nbsp; ryu-spaces

> Spaces primitive for Ryu: named document collections with vector + GraphRAG retrieval. Part of [Ryu](../../README.md).

[![License](https://shieldcn.dev/badge/License-Apache--2.0-73DC8C.svg?logo=apache&logoColor=white)](./LICENSE)
[![Stack](https://shieldcn.dev/badge/Rust-Crate-dea584.svg?logo=rust&logoColor=white)](../../README.md)

`ryu-spaces` is Ryu's document-collection engine (spec unit U16). A *Space* is a named collection: each ingested document is chunked, embedded into a fixed-dimension vector, and stored in a [sqlite-vec](https://github.com/asg017/sqlite-vec) `vec0` table alongside human-readable `spaces` / `documents` / `chunks` rows and a content-addressed blob store. It mirrors the U10 `ConversationStore` shape.

## Role in the decomposition

An extracted Core capability crate compiled in-process as a **non-optional path dependency**. **ZERO dependency on `apps/core`.** Embedders/rerankers are injected as `ryu-rag` `Embedder` / `Reranker` instances, so the model-registry-driven embedder choice, default `~/.ryu` paths, tenancy (`Tenancy` / `ResourceTenancy`) mapping, and preferences all stay Core-side (`apps/core/src/server/spaces.rs` shim).

## What it provides

- **`SpaceStore`** — ingest / chunk / embed / KNN search over `vec0`.
- **GraphRAG mode (spec unit U046)** — per-Space `retrieval_mode` of `"vector"` (default) or `"graph"`. Graph mode extracts entities/relations into `graph_nodes` / `graph_edges` and answers via entity-matching + BFS traversal. The extractor is registry-configurable (`RYU_GRAPH_EXTRACTION_MODEL` / `graph_extraction_model`); the built-in `local-cooccurrence` extractor is deterministic and offline.
- **`DocOwner` / `DocAccessMeta` / `DocFilter`** — tenancy via `ryu-kernel-contracts` `ResourceKey`.
- **Idempotent migrations** — `retrieval_mode` column and graph tables added in-place on first open.

**Swap-seam:** the injected `ryu-rag` embedder/reranker instances (the retrieval model per Space is chosen by the Core resolver, not baked in). Placement (CLAUDE.md §1): a collection and its embeddings are *what runs*, so Core.

## Build

```bash
cargo build -p ryu-spaces
cargo test  -p ryu-spaces
```

## License

Apache-2.0; see [LICENSE](./LICENSE). © 2026 A Major Pte. Ltd.
