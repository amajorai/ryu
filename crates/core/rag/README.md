# <img src="https://raw.githubusercontent.com/amajorai/ryu/main/.github/logo.png" width="50" align="middle" alt="" />&nbsp; ryu-rag

> Retrieval-augmented-generation primitive for Ryu. Part of [Ryu](../../README.md).

[![License](https://shieldcn.dev/badge/License-Apache--2.0-73DC8C.svg?logo=apache&logoColor=white)](./LICENSE)
[![Stack](https://shieldcn.dev/badge/Rust-Crate-dea584.svg?logo=rust&logoColor=white)](../../README.md)

`ryu-rag` is the retrieval capability behind Ryu's chat grounding (spec unit U17): embed the query, search short/long-term memory + Spaces + the OKF chunk index, merge and rank by cosine relevance, optionally re-rank the top-K candidates, and return the final chunks for the caller to inject into the model context before the model call.

## Role in the decomposition

An extracted Core capability crate with **ZERO dependency on `apps/core`**. Compiled into Core in-process as a **non-optional path dependency** — chat retrieval injection, agent auto-routing, and tool/space/search embedding all reach it unconditionally. It does **not** front a sidecar; it is a linked library.

**Swap-seam:** the `RagProvider` trait (`embed` / `retrieve` / `rerank`). The in-process `RetrievalStore` is the default impl. Every embedder/reranker/store here is built from plain config (`base_url` / `model` / `dims`), never from the model registry, so provider *selection* stays Core-side in the single resolver `apps/core/src/rag_host.rs`, keyed by the bound provider-id. The per-space embedder is a `RagProvider`/`Embedder` **instance** a consumer holds, not a process-global singleton. A future out-of-process provider (e.g. a GraphRAG sidecar) implements the same three verbs.

## What it provides

- **Embedder** — local hashing default + remote OpenAI-compatible `/v1/embeddings`.
- **Reranker** — local term-overlap default + remote cross-encoder `/rerank`.
- **`RetrievalStore`** — sqlite-backed memory + Spaces + OKF chunk index with cosine merge and top-K rerank; tenancy via `ryu-kernel-contracts` `ResourceKey`.

Placement (CLAUDE.md §1): retrieval is *what runs* (which chunks ground the answer), so it is Core, not Gateway.

## Build

```bash
cargo build -p ryu-rag
cargo test  -p ryu-rag
```

## License

Apache-2.0; see [LICENSE](./LICENSE). © 2026 A Major Pte. Ltd.
