# <img src="https://raw.githubusercontent.com/amajorai/ryu/main/.github/logo.png" width="50" align="middle" alt="" />&nbsp; @ryu/settings

> Shared account-settings hooks and UI. Part of [Ryu](../../README.md).

[![License](https://shieldcn.dev/badge/License-Proprietary-71717A.svg)](./LICENSE)
[![Stack](https://shieldcn.dev/badge/TypeScript-React-3178C6.svg?logo=typescript&logoColor=white)](../../README.md)

Reusable account-settings hooks, components, and framework adapters. Ships Next.js and React Router adapters so the same surface works across web and SPA hosts without duplicating account logic.

**Tier:** Closed, proprietary (A Major Pte. Ltd.)

## What it provides

- **Hooks** (`hooks/`): `useSubscription`, `usePasswordStatus`, `useEmailChangeStatus`, `useFileUpload`.
- **Components** (`components/`): `SessionsTab`, `AuthorizedAppsTab`, `SupportAccessTab`, and the shared `AvatarUploadCropper`.
- **Adapters** (`adapters/`): Next.js and React Router bindings over one shared surface (`next` and `react-router-dom` are optional peers).
- **Utilities** (`utils/`): the API client and validation schemas the hooks/components share.

## Role

Provides account/settings building blocks to Ryu's web and desktop surfaces. Depends on `@ryu/auth` (which pulls in `@ryu/db`), `@ryu/ui`, and `@tanstack/react-query`.

## License

Proprietary. See [LICENSE](./LICENSE). © 2026 A Major Pte. Ltd.
