# <img src="https://raw.githubusercontent.com/amajorai/ryu/main/.github/logo.png" width="50" align="middle" alt="" />&nbsp; ryu-knowledge

> Open Knowledge Format (OKF) primitive for Ryu. Part of [Ryu](../../README.md).

[![License](https://shieldcn.dev/badge/License-Apache--2.0-73DC8C.svg?logo=apache&logoColor=white)](./LICENSE)
[![Stack](https://shieldcn.dev/badge/Rust-Crate-dea584.svg?logo=rust&logoColor=white)](../../README.md)

`ryu-knowledge` is the in-memory model, permissive parser, and serializer for **Open Knowledge Format (OKF) v0.1** — git-shippable knowledge bundles. An OKF *bundle* is a directory of markdown files; every non-reserved `.md` file is a *concept* (YAML frontmatter + markdown body, only `type` required). Two filenames are reserved: `index.md` (bundle listing / progressive disclosure, may carry the `okf` version) and `log.md` (a `## YYYY-MM-DD` changelog).

Consumption is **permissive by contract**: missing optional fields, unknown `type` values, broken links, and extra frontmatter keys never hard-fail a bundle; a file with a missing/empty `type` is skipped with a warning.

## Role in the decomposition

An extracted Core capability crate consumed as a **non-optional path dependency** — the retrieval ingest layer, the knowledge catalog source, and the HTTP export handler reference the OKF types unconditionally in the default build. `ryu-rag` also depends on these types directly for its OKF chunk index. **ZERO dependency on `apps/core`**: the one kernel coupling (Windows `NoWindow` console-suppression for the `git clone` path) is vendored verbatim as a small std-`Command` util (`win_process.rs`).

## Public API

- `Concept` / `Concept::parse` / `Concept::to_markdown`
- `Bundle` / `Bundle::from_dir` / `Bundle::from_git` (offloads `git clone` to `spawn_blocking`) / `Bundle::write`
- `IndexDoc`, `LogDoc`, `LogEntry`, `Link`, `OKF_VERSION`

Placement (CLAUDE.md §1): a knowledge format's parse/serialize is *what runs*, so Core.

## Build

```bash
cargo build -p ryu-knowledge
cargo test  -p ryu-knowledge
```

## License

Apache-2.0; see [LICENSE](./LICENSE). © 2026 A Major Pte. Ltd.
