# Building Ryu from source

This repository is a **mirror** of a private monorepo. Everything here is buildable,
but not everything here is open source — read [`../LICENSING.md`](../LICENSING.md)
first, and note that the commercial tier (desktop, Island, shared UI packages) is
**source-available**: you may build it locally to evaluate, audit, or contribute, but
not ship it. See [`../LICENSE-COMMERCIAL.md`](../LICENSE-COMMERCIAL.md).

## Prerequisites

| Tool | Version | Needed for |
|---|---|---|
| [Bun](https://bun.sh) | 1.3.5 | everything JS/TS (matches CI — other versions can drift `bun.lock`) |
| Rust (stable) | latest | `apps/core`, `apps/gateway`, `apps/cli`, `crates/*` |
| System deps (Linux) | see below | the desktop app only |

Linux desktop build deps:

```bash
sudo apt-get install -y libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf
```

```bash
bun install --frozen-lockfile
```

## The open-source parts

These are Apache-2.0 / AGPL-3.0 and build standalone:

```bash
# Core — the orchestration engine (Apache-2.0)
cargo build --release -p ryu-core

# Gateway — the LLM control layer (AGPL-3.0)
cargo build --release -p ryu-gateway

# CLI (Apache-2.0)
cargo build --release -p ryu-cli
```

Run Core on its own — no UI, no cloud, no API key required:

```bash
./target/release/ryu-core        # listens on :7980
curl -s localhost:7980/api/health
```

Feature-app backends build standalone from their own manifest:

```bash
cargo build --release --manifest-path apps-store/mail/backend/Cargo.toml
```

## The commercial tier (source-available)

Building these locally is permitted; shipping them is not.

```bash
# Desktop (Tauri). Needs the Rust toolchain + the Linux deps above.
cd apps/desktop && bun run build:vite      # frontend only
cd apps/desktop && bun run tauri build     # full installer

# Island (Electron companion)
cd apps/island && bun run build
```

The desktop app does not compile without the shared UI packages
(`packages/{ui,blocks,settings,command,hotkeys,app-host,marketplace,auth}`), which is
why they are mirrored alongside it.

## Docker

A `Dockerfile` and `docker-compose.yml` sit at the repo root and run Core headless:

```bash
docker compose up
```

## Notes that will save you time

- **Use Bun 1.3.5.** CI and the Docker images pin it; a different version can rewrite
  `bun.lock` and break `--frozen-lockfile`.
- **The desktop frontend is a ~21k-module Vite bundle.** It wants a large heap; if the
  build stalls in rollup's "rendering chunks" phase you are out of memory, not hung:
  `NODE_OPTIONS=--max-old-space-size=12288 bunx vite build --sourcemap false`.
- **Fonts** are imported from the JS entrypoints, not via CSS `@import`. Tailwind v4
  inlines an `@import`ed package's CSS without rebasing its relative `url()`s, which
  silently drops the `.woff2` files from the build output.
- **Contributions** go to this repo's issues and PRs for the open-source parts. For the
  commercial tier, contributions are welcome under the terms in
  [`../LICENSE-COMMERCIAL.md`](../LICENSE-COMMERCIAL.md).
