# <img src="https://raw.githubusercontent.com/amajorai/ryu/main/.github/logo.png" width="50" align="middle" alt="" />&nbsp; ryu-search

> Conversation search primitive for Ryu. Part of [Ryu](../../../README.md).

[![License](https://shieldcn.dev/badge/License-Apache--2.0-73DC8C.svg?logo=apache&logoColor=white)](../../../apps/core/LICENSE)
[![Stack](https://shieldcn.dev/badge/Rust-Crate-dea584.svg?logo=rust&logoColor=white)](../../../README.md)

`ryu-search` indexes past chat messages for recall. It pairs a semantic index of sealed message vectors searched in memory (`MessageIndex`; [sqlite-vec](https://github.com/asg017/sqlite-vec) is linked only to read and migrate older `vec0` indexes) with a blind-term FTS5 keyword index (`MessageFtsIndex`, keyed term tokens with secure-delete). Both stores hold **sealed vectors / keyed tokens + metadata only — never message text**; the caller re-reads and decrypts each hit's snippet from `conversations.db`.

## Role in the decomposition

An extracted Core capability crate compiled in-process as a **non-optional path dependency** — the `ConversationStore` reaches it unconditionally. **ZERO dependency on `apps/core`** (it never sees `ModelRegistry`).

**Swap-seam:** the narrow `SearchEmbedder` trait (`dims` / `model_id` / `is_local` / `embed`). Core wraps its registry-configured `retrieval::Embedder` behind this trait object at construction, so *which* embedder (local hashing vs. remote `/v1/embeddings`) is a per-consumer RAG choice that stays out of the crate. The default db paths (`~/.ryu/message-embeddings.db`, `~/.ryu/message-fts.db`) and the embedder choice live in the Core host shim `apps/core/src/search_host.rs`, mirroring the `ryu-storage` `open(path)` precedent.

## What it provides

- **`MessageIndex`** (`message_index.rs`) — sealed-vector semantic index → `MessageHit`.
- **`MessageFtsIndex`** (`message_fts.rs`) — blind-term FTS5 keyword index (whole words only) → `MessageFtsHit`.
- **`SearchEmbedder`** — the injection seam, plus a bundled `LocalHashingEmbedder` default.

Placement (CLAUDE.md §1): searching Core's own conversation history is *what runs*, so Core.

## Build

```bash
cargo build -p ryu-search
cargo test  -p ryu-search
```

## License

Apache-2.0; see [LICENSE](../../../apps/core/LICENSE). © 2026 A Major Pte. Ltd.
