# Ryu Docs

> The Ryu documentation site. Part of [Ryu](../../README.md).

[![License](https://shieldcn.dev/badge/License-Apache--2.0-73DC8C.svg?logo=apache&logoColor=white)](./LICENSE)
[![Stack](https://shieldcn.dev/badge/Next.js-Fumadocs-000000.svg?logo=nextdotjs&logoColor=white)](../../README.md)

A Next.js + Fumadocs documentation site for Ryu — roughly 44 pages organized into five sidebar "realms": Start Here, Using Ryu, Gateway, Core, and Develop. The `develop/api-reference/` pages are interactive OpenAPI (fumadocs-openapi playground) generated from two specs in `specs/`: a hand-authored Gateway YAML and a Core spec generated from Core's Axum handlers via utoipa.

**Tier:** OSS — Apache-2.0

## Install / Build

```bash
bun install
bun run dev            # next dev (port 4000)
bun run generate:docs  # regenerate API-reference pages from specs/
bun run build          # generate:docs + next build
```

## What it provides

- ~44 documentation pages across five sidebar realms (Start Here, Using Ryu, Gateway, Core, Develop).
- Interactive OpenAPI API reference (fumadocs-openapi) under `develop/api-reference/`.
- Specs in `specs/` — `gateway-openapi.yaml` (hand-authored) + `core-openapi.json` (utoipa-generated); regenerate pages with `bun run generate:docs`.

## License

Apache-2.0 — see [LICENSE](./LICENSE). © 2026 A Major Pte. Ltd.
