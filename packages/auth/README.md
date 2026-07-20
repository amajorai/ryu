# <img src="https://raw.githubusercontent.com/amajorai/ryu/main/.github/logo.png" width="50" align="middle" alt="" />&nbsp; @ryu/auth

> Ryu's identity layer. Part of [Ryu](../../README.md).

[![License](https://shieldcn.dev/badge/License-Proprietary-71717A.svg)](./LICENSE)
[![Stack](https://shieldcn.dev/badge/TypeScript-Better--Auth-3178C6.svg?logo=typescript&logoColor=white)](../../README.md)

Better Auth server and client configuration plus plugins: organizations/teams, OAuth, device authorization, 2FA, OTP, and Polar billing wiring. The single identity layer shared across every Ryu surface (web, desktop, CLI, extension, native).

**Tier:** Closed, proprietary (A Major Pte. Ltd.)

## What it provides

- **Configured auth instance** (`index.ts`, `seed-clients.ts`): the Better Auth server/client and trusted OAuth client seeding.
- **Plans + billing** (`lib/{plans.ts,payments.ts,cloud-tiers.ts}`): plan/quota definitions and Polar payment helpers, the single source of plan numbers.
- **Organizations** (`lib/organizations.ts`): personal-org provisioning and active-org resolution.
- **Waitlist gate** (`lib/{waitlist.ts,waitlist-queue.ts}`): account-based waitlist + referral admission, grandfathering, and `ADMIN_EMAILS` bypass.
- **Support access** (`lib/support-access.ts`): user-granted, auto-expiring impersonation (RFC 8693 delegation) for support actors.
- **Helpers** (`lib/{avatar.ts,constants.ts}`): shared avatar and constant utilities.

## Role

Provides the configured auth instance and helpers to `apps/server` and downstream packages. Depends on `@ryu/db`, `@ryu/email`, and `@ryu/env`.

## License

Proprietary. See [LICENSE](./LICENSE). © 2026 A Major Pte. Ltd.
