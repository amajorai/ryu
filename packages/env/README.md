# <img src="https://raw.githubusercontent.com/amajorai/ryu/main/.github/logo.png" width="50" align="middle" alt="" />&nbsp; @ryu/env

> Shared environment schemas. Part of [Ryu](../../README.md).

[![License](https://shieldcn.dev/badge/License-Proprietary-71717A.svg)](./LICENSE)
[![Stack](https://shieldcn.dev/badge/TypeScript-Config-3178C6.svg?logo=typescript&logoColor=white)](../../README.md)

Typed, validated environment-variable schemas built on `@t3-oss/env` and `zod`, split per runtime so each app validates only the vars it actually needs. A misconfigured environment fails fast at import time instead of at runtime.

**Tier:** Closed, proprietary (A Major Pte. Ltd.)

## What it provides

- **Server schema** (`src/server.ts`): vars for the control-plane server and server packages (`@ryu/auth`, `@ryu/db`, `@ryu/api`).
- **Web schema** (`src/web.ts`): `@t3-oss/env-nextjs` schema for `apps/web`, separating public (`NEXT_PUBLIC_*`) from server vars.
- **Native schema** (`src/native.ts`): the subset of vars the Expo app needs.

Each is a separate export (`@ryu/env/server`, `/web`, `/native`) so importing one runtime's schema never pulls in another's required vars.

## Role

Provides validated `env` objects to server packages and the web/native apps. Depends on `@t3-oss/env-core`, `@t3-oss/env-nextjs`, and `zod`.

## License

Proprietary. See [LICENSE](./LICENSE). © 2026 A Major Pte. Ltd.
