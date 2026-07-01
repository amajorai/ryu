# <img src="https://raw.githubusercontent.com/amajorai/ryu/main/.github/logo.png" width="50" align="middle" alt="" />&nbsp; @ryu/config

> Shared workspace config. Part of [Ryu](../../README.md).

[![License](https://shieldcn.dev/badge/License-Proprietary-71717A.svg)](./LICENSE)
[![Stack](https://shieldcn.dev/badge/TypeScript-Config-3178C6.svg?logo=typescript&logoColor=white)](../../README.md)

Shared TypeScript/tooling defaults for the monorepo, referenced as a `devDependency` across packages so every workspace package compiles against the same baseline.

> **Status:** thin anchor. The package has no `src/`; it ships `tsconfig.base.json` and exists as the shared-config reference point.

**Tier:** Closed, proprietary (A Major Pte. Ltd.)

## What it provides

- **Base TypeScript config** (`tsconfig.base.json`): the shared compiler baseline extended by workspace packages.

## Role

A shared config anchor depended on by most workspace packages for consistent TypeScript/tooling defaults.

## License

Proprietary. See [LICENSE](./LICENSE). © 2026 A Major Pte. Ltd.
