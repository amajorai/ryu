# <img src="https://raw.githubusercontent.com/amajorai/ryu/main/.github/logo.png" width="50" align="middle" alt="" />&nbsp; @ryuhq/core-client

> The platform-agnostic, typed client for a Ryu Core node. Part of [Ryu](../../README.md).

[![License](https://shieldcn.dev/badge/License-Proprietary-71717A.svg)](./LICENSE)
[![Stack](https://shieldcn.dev/badge/TypeScript-Client-3178C6.svg?logo=typescript&logoColor=white)](../../README.md)

`@ryu/core-client` is the shared HTTP client every surface uses to talk to a Ryu Core (and Gateway) node. It has **no platform dependencies** (no `localStorage`, no Tauri, no React), so the desktop (Tauri webview) and mobile (React Native / Expo) share the same domain modules verbatim. The base URL and bearer token always come from the caller's active node (`{ url, token }`), never hardcoded: Core listens on `:7980` but the active node may be remote.

**Tier:** OSS, Apache-2.0

## React Native / Expo

This package is the full React Native client library. It does not need a
separate native module: pass the selected Core node and import only the domain
you need.

```tsx
import { fetch as expoFetch } from "expo/fetch";
import { fetchAgents } from "@ryuhq/core-client/agents";
import type { ApiTarget, RyuFetch } from "@ryuhq/core-client/client";

const target: ApiTarget = {
  url: "http://192.168.1.10:7980",
  token: "your-node-token",
  fetch: expoFetch as RyuFetch,
};

const agents = await fetchAgents(target);
```

Use `@ryuhq/client` when you only need embedded chat, sessions, and Spaces.
Use this package when the app needs Core management such as agents, models,
plugins, skills, MCP servers, workflows, or Gateway settings. Keep the node
token in `expo-secure-store`, not in source or bundled environment values.

## What it provides

- **HTTP primitives** (`client.ts`, root export): `ApiTarget`, `request`, `apiUrl`, `makeHeaders`, plus the marketplace buyer-token seam (`BUYER_TOKEN_HEADER`, `setBuyerTokenProvider`, `buyerTokenHeader`). Bearer auth and base-URL handling live here in exactly one place.
- **Typed domain modules** (subpath exports): one file per Core feature: `agents`, `chat`, `harness`, `models`, `engines`, `spaces`, `skills`, `tools`, `workflows`, `teams`, `monitors`, `meetings`, `schedules`, `voice`, `mesh`, `mcp`, `plugins`, `recipes`, `delegation`, `goals`, `sessions`, `runs`, and more.
- **Subpath imports**: pull a feature by path: `import { fetchAgents } from "@ryuhq/core-client/agents"`. The root re-exports only the HTTP primitives by design (no kitchen-sink barrel).

## Role

Designed to be shared verbatim by the desktop and mobile surfaces. Surface-specific concerns (the desktop buyer-token / presence headers, the mobile secure-store token) are layered on top by each app, not here. Consumed today by `apps/native`.

## License

Proprietary. See [LICENSE](./LICENSE). © 2026 A Major Pte. Ltd.
