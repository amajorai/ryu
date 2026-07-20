# <img src="https://raw.githubusercontent.com/amajorai/ryu/main/.github/logo.png" width="50" align="middle" alt="" />&nbsp; @ryu/ui

> The shared Ryu design system. Part of [Ryu](../../README.md).

[![License](https://shieldcn.dev/badge/License-Proprietary-71717A.svg)](./LICENSE)
[![Stack](https://shieldcn.dev/badge/TypeScript-React-3178C6.svg?logo=typescript&logoColor=white)](../../README.md)

The single source of UI truth across Ryu's closed surfaces: ~66 React components built on Base UI primitives (NOT Radix), shadcn-style patterns, and Tailwind v4, plus shared hooks, theme helpers, and a vendored PlateJS editor.

**Tier:** Closed, proprietary (A Major Pte. Ltd.)

## What it provides

- **Components** (`components/*`): the shadcn-style primitive set on Base UI, plus the data grid (`@tanstack/react-table` + virtualization) and the vendored PlateJS editor (`components/editor/*`).
- **Hooks, lib, theme** (`hooks/*`, `lib/*`, `theme/*`): shared utilities and theming.
- **Styles** (`./globals.css`, `./components/editor/editor.css`): the base stylesheet and editor CSS.

## Role

Consumed by the closed desktop, extension, island, and command-bar apps (and `@ryu/command`, `@ryu/blocks`, `@ryu/settings`). Exposes `components/*`, `hooks/*`, `lib/*`, `theme/*`, and `globals.css` via package `exports`, resolved through those export entries, **not** a path alias, so imports carry no file extension.

## License

Proprietary. See [LICENSE](./LICENSE). © 2026 A Major Pte. Ltd.
