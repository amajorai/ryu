# <img src="https://raw.githubusercontent.com/amajorai/ryu/main/.github/logo.png" width="50" align="middle" alt="" />&nbsp; @ryuhq/client

> Typed TypeScript client for the Ryu Core HTTP API. Part of [Ryu](../../README.md).

[![License](https://shieldcn.dev/badge/License-Apache--2.0-73DC8C.svg?logo=apache&logoColor=white)](./LICENSE)
[![Stack](https://shieldcn.dev/badge/TypeScript-Client-3178C6.svg?logo=typescript&logoColor=white)](../../README.md)

`@ryuhq/client` is a typed client over Ryu Core's HTTP API: create a client, pick an agent, and stream. It has no internal Ryu dependencies and zero runtime dependencies. It uses native `fetch` and works in Node 18+, Bun, Deno, modern browsers, and React Native. It pairs with the open Core.

**Tier:** OSS, Apache-2.0

## React Native / Expo

Use the same package in a React Native app. Expo apps can inject `expo/fetch`
when they need streaming response bodies:

```tsx
import { fetch as expoFetch } from "expo/fetch";
import { createRyuClient, type RyuFetch } from "@ryuhq/client";

const client = createRyuClient({
  baseUrl: "http://192.168.1.10:7980",
  token: "your-node-token",
  fetch: expoFetch as RyuFetch,
});

const reply = await client.agents.run("pi", [
  { role: "user", content: "What is Ryu?" },
]);
```

Store the node token with the platform's secure storage. Do not put a provider
API key in the mobile bundle. For the full Core surface, use
`@ryuhq/core-client` with the same `{ url, token, fetch }` target shape.

## Install / Build

```bash
bun add @ryuhq/client
# build from source
bun run build   # tsup → dist/
```

## What it provides

- **`createRyuClient` / `RyuClient`** (`client.ts`): entry point and typed options (`RyuClientOptions`).
- **Agents API** (`agents.ts`, `AgentsAPI`): list and address agents, stream chat (`StreamChunk`).
- **Sessions API** (`sessions.ts`, `SessionsAPI`): conversations and messages (`Conversation`, `Message`).
- **Spaces API** (`spaces.ts`, `SpacesAPI`): Spaces / RAG retrieval (`Space`, `SpaceMatch`).
- **Transport** (`request.ts`, `types.ts`): the native-`fetch` request layer and shared types.

## License

Apache-2.0. See [LICENSE](./LICENSE). © 2026 A Major Pte. Ltd.
