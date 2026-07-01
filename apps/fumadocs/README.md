# <img src="https://raw.githubusercontent.com/amajorai/ryu/main/.github/logo.png" width="50" align="middle" alt="" />&nbsp; Ryu Docs

> The Ryu documentation site. Part of [Ryu](../../README.md).

[![License](https://shieldcn.dev/badge/License-Apache--2.0-73DC8C.svg?logo=apache&logoColor=white)](./LICENSE)
[![Stack](https://shieldcn.dev/badge/Next.js-Fumadocs-000000.svg?logo=nextdotjs&logoColor=white)](../../README.md)

The Ryu documentation site: a Next.js + Fumadocs app of roughly 44 pages, plus an interactive OpenAPI reference. It is the deep "state of everything" reference for Ryu, organized into five sidebar realms and kept honest with file citations.

**Tier:** OSS (Apache-2.0)

## Stack

- Next.js (App Router) + `fumadocs-ui` / `fumadocs-core` / `fumadocs-mdx`
- `fumadocs-openapi` for the interactive API playground
- Tailwind CSS, `mermaid` diagrams

## Install / Build

```bash
bun install
bun run dev            # next dev on port 4000
bun run generate:docs  # regenerate API-reference pages from specs/
bun run build          # generate:docs + next build
```

## What it provides

- **Five sidebar realms:** Start Here, Using Ryu, Gateway, Core, and Develop, defined by `root: true` `meta.json` files.
- **Interactive OpenAPI reference** (`content/docs/develop/api-reference/`): rendered by `fumadocs-openapi` with a live request playground.
- **Two source specs** (`specs/`): `gateway-openapi.yaml` (hand-authored) and `core-openapi.json` (generated from Core's Axum handlers via utoipa, e.g. `ryu-core --dump-openapi`).
- **Regeneration:** `bun run generate:docs` (`scripts/generate-docs.ts`) rebuilds the API-reference pages from the specs.

## License

Apache-2.0. See [LICENSE](./LICENSE). © 2026 A Major Pte. Ltd.
