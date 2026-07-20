# <img src="https://raw.githubusercontent.com/amajorai/ryu/main/.github/logo.png" width="50" align="middle" alt="" />&nbsp; @ryu/command

> The shared command palette. Part of [Ryu](../../README.md).

[![License](https://shieldcn.dev/badge/License-Proprietary-71717A.svg)](./LICENSE)
[![Stack](https://shieldcn.dev/badge/TypeScript-React-3178C6.svg?logo=typescript&logoColor=white)](../../README.md)

A renderer-only, transport-agnostic command palette and chat surface. `CommandPalette` renders a `CommandAction[]`; `ChatView` takes an injected `ChatStreamFn`, so the same components render in the Tauri webview and an Electron renderer with no transport assumptions baked in.

**Tier:** Closed, proprietary (A Major Pte. Ltd.)

## What it provides

- **`CommandPalette`** (`./CommandPalette`): renders a `CommandAction[]` into the palette UI.
- **`ChatView`** (`./ChatView`): the chat surface, driven by an injected `ChatStreamFn`.
- **`registry` + `types`** (`./registry`, `./types`): the action registry and shared types (`CommandAction`, `ChatStreamFn`).

## Role

Powers the desktop's Cmd+K palette and the island's "Golden Gate" command surface from one codebase. Depends on `@ryu/ui` (and `@ryu/config`); `react`/`react-dom` are peers.

## License

Proprietary. See [LICENSE](./LICENSE). © 2026 A Major Pte. Ltd.
