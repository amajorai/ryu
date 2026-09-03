# Contributing to Ryu

Thanks for wanting to help. Ryu's open-source core and source-available desktop layer welcome
contributions.

## How this public repository works

This public repository is generated from Ryu's monorepo and is an active contribution surface.

- Open a pull request here as normal. A maintainer reviews it in this repository.
- When accepted, a maintainer replays the change into the monorepo with authorship preserved.
  It is included in a later public sync.
- A sync can rewrite generated files and the public `main` branch. This does not discard an
  accepted contribution, but do not base a long-lived fork on a particular mirror commit.

If a change spans open and closed code, such as an API used by Desktop, say so in the pull request.
The closed half is handled in the monorepo by the maintainers.

## What lives here

The public tree contains the open-source runtime and the source-available Desktop, Island, and
shared UI layer those surfaces need. It also contains generated Core runtime assets under
`generated/ryu-runtime/`; those files are build inputs, not app or plugin source. The SDK packages,
Rust SDK, foreign bindings, and examples live in
[`amajorai/ryu-sdk`](https://github.com/amajorai/ryu-sdk). Feature-app source lives in the relevant
[`amajorai/ryu-<app>`](https://github.com/amajorai) satellite, and plugin source plus Marketplace
metadata live in [`amajorai/ryu-marketplace`](https://github.com/amajorai/ryu-marketplace). The Web,
server, mobile, and identity apps are developed separately. The documentation site is its own
repository, [`amajorai/ryu-docs`](https://github.com/amajorai/ryu-docs); open a docs pull request
there or in the monorepo.

See [`docs/open-core.md`](./docs/open-core.md) for the tier map and the public
[contribution-surface guide](https://docs.ryuhq.com/docs/extend/develop/extensions/contribution-surfaces).

## Before you start

- Small fixes, typos, and documentation changes can go straight into a pull request.
- For a new feature or behavior change, open an issue or Discussion first so the shape can be
  agreed before implementation.
- For security issues, do not open a public issue. Follow [`SECURITY.md`](./.github/SECURITY.md).

## Building

Each unit has its own `README.md`. The short version is:

```bash
# Rust units (Core and Gateway)
cd apps/core    && cargo build
cd apps/gateway && cargo build

# TypeScript units in this repository
bun install && bun run build

# Public plugin-tool harness
bun run test:toolsmith
```

## Placement rule

Before writing code, decide where it belongs:

- If it decides **what runs** - which agent, session, workflow, or tool - it belongs in **Core**.
- If it decides **what is allowed, shared, measured, or paid for** - routing, firewall, budgets,
  audit, or policy - it belongs in **Gateway**.

Core routes model calls through the Gateway. A pull request that puts policy in Core or
orchestration in Gateway will be asked to move.

## Style and checks

- Rust: run `cargo fmt` and keep `cargo clippy` clean.
- TypeScript: run `bun x ultracite fix` before committing.
- Keep pull requests focused on one concern.
- Match the surrounding code's naming and comment density.

## License

By contributing, you agree that your contribution is licensed under the same license as the unit
you touch: Apache-2.0 for most units and AGPL-3.0 for `apps/gateway`. See each unit's `LICENSE`.
