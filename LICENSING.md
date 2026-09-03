# Licensing

This repository is **open-core** and multi-licensed. Root and unit-level `LICENSE` files
govern the public projection; this document summarizes the boundary.

## Open source

| License | Units |
|---|---|
| **Apache-2.0** | `apps/{core,cli}`, `crates/{core,ghost}/*`, and the OSS Ghost, Shadow, SDK, and Raycast satellites |
| **AGPL-3.0** | `apps/gateway` |
| **MIT** | `amajorai/ryu-raycast` satellite (not included in this hub) |

## Commercial (source-available — NOT open source)

Governed by [`LICENSE-COMMERCIAL.md`](./LICENSE-COMMERCIAL.md).

| Unit | What it is |
|---|---|
| `apps/desktop` | The Ryu desktop application |
| `apps/island` | The Island companion |
| `packages/{ui,blocks,settings,command,hotkeys,app-host,marketplace}` | The shared UI layer both are built from |
| `packages/auth` | Shared auth client/config used by those surfaces |
| `packages/env` | Server/environment configuration shared by the source-available layer |

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
