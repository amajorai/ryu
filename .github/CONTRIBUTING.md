# Contributing to Ryu

Thanks for wanting to help. Ryu's open-source core lives here; contributions to it are welcome.

## How this repository works (read first)

**This repo is a one-way mirror of a private monorepo, which is the source of truth.** Changes
flow *out* (monorepo → here) on every push. They do not flow back automatically.

What that means for you:

- **Open your PR against this repo as normal.** A maintainer reviews it here.
- When accepted, a maintainer **replays your change into the monorepo** with authorship preserved,
  and it returns on the next mirror sync. Your commit SHA on `main` here may be rewritten by that
  sync — this is expected, not a lost contribution.
- Because of the mirror, **don't base long-lived forks on a specific `main` SHA**; track releases.

If a change spans open and closed code (e.g. an API the desktop consumes), say so in the PR — the
closed half is handled in the monorepo and we'll coordinate.

## What lives here

Only the open-source units: `apps/{core,gateway,cli}`, the SDK family
(`packages/{sdk,create-ryu-app,client}`, `crates/ryu-sdk*`), and docs. The desktop, web, mobile,
and identity apps are proprietary and developed separately — they are not in this tree.
The documentation **site** is also its own repo, [`amajorai/ryu-docs`](https://github.com/amajorai/ryu-docs) —
open a docs PR there (or in the monorepo), not here.

See [`docs/open-core.md`](../docs/open-core.md) for the full tier map and
[`AGENTS.md`](../AGENTS.md) for the architecture and the Core-vs-Gateway placement rule.

## Before you start

- **Small fix / typo / docs:** just open a PR.
- **New feature or a behavior change:** open an issue (or a Discussion) first so we can agree on
  the shape before you build. It saves everyone a round-trip.
- **Security issue:** do **not** open a public issue — see [`SECURITY.md`](./SECURITY.md).

## Building

Each unit builds standalone; see its own `README.md`. The short version:

```bash
# Rust units (Core, Gateway, CLI)
cd apps/core    && cargo build
cd apps/gateway && cargo build

# TypeScript units (SDK, docs)
bun install && bun run build
```

## Placement rule (the one that matters)

Before writing code, decide where it belongs:

- If it decides **what runs** (which agent, session, workflow, tool) → **Core**.
- If it decides **what is allowed, shared, measured, or paid for** (routing, firewall, budgets,
  audit, policy) → **Gateway**.

Core never enforces policy inline; it routes every model call through the Gateway. A PR that puts
policy in Core or orchestration in the Gateway will be asked to move.

## Style & checks

- Rust: `cargo fmt` + `cargo clippy` clean.
- TypeScript: `bun x ultracite fix` before committing (Biome-based; most issues auto-fix).
- Keep PRs focused — one concern per PR reviews far faster than a mixed bag.
- Match the surrounding code's naming and comment density.

## License

By contributing you agree your contribution is licensed under the same license as the unit you're
touching (Apache-2.0 for most units, AGPL-3.0 for `apps/gateway`). See each unit's `LICENSE`.
