# Licensing

This repository is **open-core** and multi-licensed. This document summarizes the boundary; it
does not replace the licence declarations it is built from. For each unit, the table follows the
unit's own `LICENSE` file where it has one; otherwise the SPDX `license` field in its package
manifest (`Cargo.toml` or `package.json`); otherwise the root `LICENSE` (Apache-2.0).

## Open source

| License | Units |
|---|---|
| **Apache-2.0** | `apps/{core,cli,plugins}`, `crates/{core,ghost}/*`, `crates/gateway/credentials` (`ryu-gw-credentials`, which has neither a `LICENSE` file nor a manifest `license` field, so the root `LICENSE` applies), `packages/{client,services,services-cli,core-client,protocol,config}`, and the OSS Ghost, Shadow, and SDK satellites |
| **AGPL-3.0** | `apps/gateway` (its `LICENSE` file is the AGPL-3.0 text) and every other `crates/gateway/*` crate, each of which declares `license = "AGPL-3.0-only"` in its `Cargo.toml` and has no `LICENSE` file of its own |
| **MIT** | `amajorai/ryu-raycast` satellite (not included in this hub) |

Other open-source paths in this repository (for example `apps/{skills,mcp}`, `.agents/plugins`,
`packages/github-action`, `registry`, and `tools/toolsmith`) fall under the root Apache-2.0
`LICENSE` unless a subdirectory `LICENSE` says otherwise; `vendor/genai` keeps its upstream
MIT OR Apache-2.0 licence.

## Commercial (source-available — NOT open source)

Governed by [`LICENSE-COMMERCIAL.md`](./LICENSE-COMMERCIAL.md).

| Unit | What it is |
|---|---|
| `apps/desktop` | The Ryu desktop application |
| `apps/island` | The Island companion |
| `packages/{ui,blocks,settings,command,hotkeys,app-host,marketplace}` | The shared UI layer both are built from |
| `packages/{auth,step-up}` | Shared auth client/config and the step-up ("confirm it's you") client used by those surfaces |
| `packages/env` | Server/environment configuration shared by the source-available layer |
| `packages/{assistant-widget,browser-local-ai}` | The reusable assistant surface and its browser-local inference |
| `packages/i18n` | The language-pack validator, catalog, and provider used by Desktop and Island. The copy in this repository is source-available; the same package is also published in [`amajorai/ryu-sdk`](https://github.com/amajorai/ryu-sdk), where that hub's Apache-2.0 licence applies |
| `packages/portable-packages` | The package validate/import/export implementation used by the public CLI |
| `packages/workbench` | The tab and split-view workbench model and reducer used by Desktop |

These are published so you can **read, audit, build locally, and contribute** —
not so you can ship them. Production use requires an official binary;
redistribution, hosted resale, and competing products are not permitted.

**Source-available is not open source.** Visibility grants no open-source rights.

## Trademarks

The Ryu name and logo are **not** licensed by any file here. A permitted fork
must be renamed and rebranded — see [`TRADEMARK.md`](./TRADEMARK.md).

---

SDK packages, SDK crates, bindings, and examples are maintained in
[`amajorai/ryu-sdk`](https://github.com/amajorai/ryu-sdk). Feature-app source is maintained in
the corresponding `amajorai/ryu-<app>` satellite, while plugin source and catalog metadata are
maintained in [`amajorai/ryu-marketplace`](https://github.com/amajorai/ryu-marketplace).

If a subdirectory's `LICENSE` conflicts with the root `LICENSE`, the subdirectory's file governs
that subtree. See `docs/open-core.md` for the rationale.

© 2026 A Major Pte. Ltd.
