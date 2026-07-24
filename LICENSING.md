# Licensing

This repository is **open-core** and multi-licensed. Each top-level unit carries its own
authoritative `LICENSE` file; this document summarizes the whole.

## Open source

| License | Units |
|---|---|
| **Apache-2.0** (root `LICENSE`) | `apps/{core,cli,ghost,shadow}`, all `crates/*`, `packages/{sdk,create-ryu-app,client}` |
| **AGPL-3.0** | `apps/gateway` |
| **MIT** | `apps/raycast` |

## Commercial (source-available — NOT open source)

Governed by [`LICENSE-COMMERCIAL.md`](./LICENSE-COMMERCIAL.md).

| Unit | What it is |
|---|---|
| `apps/desktop` | The Ryu desktop application |
| `apps/island` | The Island companion |
| `packages/{ui,blocks,settings,command,hotkeys,app-host,marketplace}` | The shared UI layer both are built from |
| `packages/auth` | Shared auth client/config used by those surfaces |

These are published so you can **read, audit, build locally, and contribute** —
not so you can ship them. Production use requires an official binary;
redistribution, hosted resale, and competing products are not permitted.

**Source-available is not open source.** Visibility grants no open-source rights.

## Trademarks

The Ryu name and logo are **not** licensed by any file here. A permitted fork
must be renamed and rebranded — see [`TRADEMARK.md`](./TRADEMARK.md).

---

If a subdirectory's `LICENSE` conflicts with the root `LICENSE`, the subdirectory's file governs
that subtree. See `docs/open-core.md` for the rationale.

© 2026 A Major Pte. Ltd.
