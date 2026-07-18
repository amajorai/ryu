# ryu-tool-registry

Unified tool-catalog primitive for Ryu (#474): the descriptor types and the pure
search / describe bodies behind a swappable ranker seam.

## Role in the decomposition

An extracted Core capability crate — **in-process by default** and consumed as a
**non-optional path dependency**: the `/api/tools/{search,describe}` endpoints and
the `mcp_bridge` tool-search meta-tool reach it in every build (including lean). It
carries **zero dependency on `apps/core`**. The semantic embedder injects via the
narrow `ToolEmbedder` trait. The `RegistryTool → ToolDescriptor` ingest adapter,
built-in server inventory classification, Composio live fetch, and the
registry-driven embedder choice stay Core-side.

## Key API (`src/lib.rs`)

- `ToolDescriptor` / `ToolKind` / `DescribedTool` / `DescribedArg` — the Contract-1
  descriptor types over which search and describe operate.
- `ToolRanker` — swappable ranker; **BM25 default** plus an embedder-backed
  `Semantic` seam.
- `ToolEmbedder` — trait the semantic ranker calls; supplied by Core.
- `run_search` — the pure search body over `[ToolDescriptor]`.
- `describe_from_parts` / `describe_composio` / `described_args` / `arg_summary` —
  argument-schema parsing and describe bodies.

## Swap seam

`ToolRanker` selects the ranking strategy: BM25 lexical default, or a Semantic
ranker backed by any host-provided `ToolEmbedder` — chosen by Core via the model
registry, never hardcoded.

## Consumed as

Compiled-into-Core crate (default path dependency); no optional features (leaf-pure
`serde` / `serde_json` / `async-trait`).
