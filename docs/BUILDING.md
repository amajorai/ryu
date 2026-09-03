# Building Ryu from source

This repository is the public runtime and source-available Desktop/Island projection of Ryu.
It is generated from the private monorepo, so the generated `generated/ryu-runtime/` directory is
build input only. App implementations live in their `amajorai/ryu-<app>` satellite repositories;
the SDK packages, kernel crates, bindings, and examples live in
[`amajorai/ryu-sdk`](https://github.com/amajorai/ryu-sdk).

Not every published unit has the same license. Read [`../LICENSING.md`](../LICENSING.md) and
[`../LICENSE-COMMERCIAL.md`](../LICENSE-COMMERCIAL.md) before building the source-available tier.

## Prerequisites

| Tool | Version | Needed for |
|---|---|---|
| [Bun](https://bun.sh) | 1.3.14 | JavaScript/TypeScript workspaces and the public toolsmith tests |
| Rust (stable) | latest | `apps/core` and `apps/gateway` |
| Node.js | 22+ | the public toolsmith tests |
| System deps (Linux) | see below | the Desktop app only |

Linux Desktop build dependencies:

```bash
sudo apt-get install -y libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf
```

Install the public workspaces from the repository root:

```bash
bun install --frozen-lockfile
```

## Open-source runtime

Core and Gateway are standalone Cargo packages in this projection; there is no root Cargo
workspace. Build them by pointing Cargo at their manifests:

```bash
cargo build --release --manifest-path apps/core/Cargo.toml
cargo build --release --manifest-path apps/gateway/Cargo.toml
```

Run Core locally without a UI, cloud account, or provider key:

```bash
cargo run --release --manifest-path apps/core/Cargo.toml
curl -s http://localhost:7980/api/health
```

The CLI is a Bun workspace:

```bash
bun run --cwd apps/cli check-types
bun run --cwd apps/cli start
```

## Feature apps

Feature-app source is not carried in this repository. Each app has its own public satellite, for
example:

```bash
git clone https://github.com/amajorai/ryu-mail.git
cargo build --release --manifest-path ryu-mail/backend/Cargo.toml
```

Use the [Marketplace catalog](https://github.com/amajorai/ryu-marketplace) to find the app
repository for another feature. The `generated/ryu-runtime/` files in this repository only let
Core embed the app's signed manifest and are not an app development checkout.

## Source-available Desktop and Island

Building these locally is permitted; shipping them is not.

```bash
# Desktop (Tauri)
bun run --cwd apps/desktop build:vite
bun run --cwd apps/desktop tauri build

# Island (Electron companion)
bun run --cwd apps/island build
```

The Desktop app uses the shared UI packages mirrored alongside it, including
`packages/{ui,blocks,settings,command,hotkeys,app-host,marketplace,auth}`.

## SDK and bindings

Clone the standalone SDK hub for the authoring packages, Rust SDK, language bindings, and
examples:

```bash
git clone https://github.com/amajorai/ryu-sdk.git
cd ryu-sdk
bun install --frozen-lockfile --ignore-scripts
bun run check-types
bun run test:packages
```

## Plugin-tool harness

The only general-purpose tool shipped in this repository is the public plugin authoring harness:

```bash
node tools/toolsmith/index.mjs scaffold --id @scope/name --tool slug --out ./plugin
bun run test:toolsmith
```

It does not make `generated/ryu-runtime/` or the Marketplace directories authoring surfaces.

## Docker

The root `Dockerfile` and `docker-compose.yml` run Core headless:

```bash
docker compose up
```
