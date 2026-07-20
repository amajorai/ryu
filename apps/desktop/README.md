# <img src="https://raw.githubusercontent.com/amajorai/ryu/main/.github/logo.png" width="50" align="middle" alt="" />&nbsp; Ryu Desktop

> The primary Ryu product: download, pick an agent, go. Part of [Ryu](../../README.md).

[![License](https://shieldcn.dev/badge/License-Proprietary-71717A.svg)](./LICENSE)
[![Stack](https://shieldcn.dev/badge/Tauri-React-24C8DB.svg?logo=tauri&logoColor=white)](../../README.md)

A Tauri v2 + React desktop app that is Ryu's flagship product. It chats with agents through Core's ACP plane, runs council/team chat (@mention multi-agent), one-page agent creation, onboarding, and multi-node routing. Roughly 17+ route pages cover Gateway, engines, spaces, memory, tools, workflows, automations, monitors, models, and skills.

**Tier:** Closed, proprietary (A Major Pte. Ltd.)

## Stack

- Tauri v2 (Rust shell) + React 19 + Vite + TypeScript
- React Router v7, Zustand, TanStack Query, `@ryu/ui` primitives
- Talks to Core (`:7980`) over HTTP/SSE; `ryu://` deep links + system tray

## Develop

From the repo root:

```sh
bun run dev:desktop   # full Tauri shell (native window)
bun run dev:vite      # frontend-only on :5173 (no native shell)
```

`dev:vite` is the fast inner loop for UI work; the full shell is needed for native features (deep links, tray, multi-window).

## What it does

- Chat with any installed agent via Core's ACP adapter, with full tool loops
- Council / team chat: @mention multiple agents or a team in one thread
- One-page agent creation and per-agent model/provider/Composio config
- Pages for Gateway routing, engines, spaces, memory, tools, workflows, automations, website monitors, and the model and skill catalogs
- Onboarding (local stack install) and multi-node selection (local or remote Core)

## License

Proprietary. See [LICENSE](./LICENSE). © 2026 A Major Pte. Ltd.
