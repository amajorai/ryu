# <img src="https://raw.githubusercontent.com/amajorai/ryu/main/.github/logo.png" width="50" align="middle" alt="" />&nbsp; ryu-vector-stores

> Pluggable vector stores for Ryu. Part of [Ryu](../../../README.md).

[![License](https://shieldcn.dev/badge/License-Apache--2.0-73DC8C.svg?logo=apache&logoColor=white)](../../../apps/core/LICENSE)
[![Stack](https://shieldcn.dev/badge/Rust-Crate-dea584.svg?logo=rust&logoColor=white)](../../../README.md)

`ryu-vector-stores` puts every vector database Ryu can talk to behind one `VectorStore` trait:
`ensure_collection`, `upsert`, `query` (nearest neighbours with an optional `MetadataFilter`), and
`delete`.

| Provider id | Backend | Transport |
| --- | --- | --- |
| `sqlite-vec` (default) | local SQLite file | in-process, sqlite-vec distance functions, exact search |
| `qdrant` | Qdrant | REST (`/collections/...`) |
| `chroma` | Chroma | REST v2 (`/api/v2/tenants/.../collections`) |
| `pinecone` | Pinecone | control + data plane REST; collections are namespaces of one index |
| `weaviate` | Weaviate | REST schema/batch + GraphQL `nearVector` |
| `milvus` | Milvus / Zilliz | RESTful v2 (`/v2/vectordb/...`) |
| `pgvector` | Postgres + pgvector | Postgres wire protocol (`tokio-postgres`) |

## Role in the decomposition

An extracted Core capability crate with **zero dependency on `apps/core`**. Core's
`apps/core/src/rag_host.rs` resolves the provider id, the data-dir path for the local store, and
the credential reference, then hands this crate plain `VectorStoreConfig`.

## Conventions

- Ids are opaque strings; Qdrant and Weaviate map them to stable derived UUIDs and keep the
  original in the payload.
- Scores are similarities (higher is better) on every backend.
- Metadata filters address top-level keys that are plain identifiers; values are strings, numbers
  or booleans.
- `VectorStoreConfig` redacts the credential from `Debug` and never serializes it.

## Build

```bash
cargo test -p ryu-vector-stores
```

The REST backends are tested against a scripted local HTTP server that asserts the documented wire
shapes; pgvector's SQL generation is unit-tested. Live round-trips against hosted services are not
part of the test suite.
