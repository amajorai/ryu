# @ryu/client

> Typed TypeScript client for the Ryu Core HTTP API. Part of [Ryu](../../README.md).

[![License](https://shieldcn.dev/badge/License-Apache--2.0-73DC8C.svg?logo=apache&logoColor=white)](./LICENSE)
[![Stack](https://shieldcn.dev/badge/TypeScript-Client-3178C6.svg?logo=typescript&logoColor=white)](../../README.md)

`@ryu/client` is a Mastra-style typed client over Ryu Core's HTTP API (:7980): create a client, pick an agent, and stream. It has no internal Ryu dependencies and zero runtime dependencies — it uses native `fetch` and works in Node 18+, Bun, Deno, and modern browsers. It pairs with the open Core.

**Tier:** OSS — Apache-2.0

## Install / Build

```bash
bun add @ryu/client
# build from source
bun run build   # tsup → dist/
```

## What it provides

- `createRyuClient` / `RyuClient` — entry point and typed options (`RyuClientOptions`).
- **Agents API** (`AgentsAPI`) — list and address agents, stream chat (`StreamChunk`).
- **Sessions API** (`SessionsAPI`) — conversations and messages (`Conversation`, `Message`).
- **Spaces API** (`SpacesAPI`) — Spaces / RAG retrieval (`Space`, `SpaceMatch`).

## License

Apache-2.0 — see [LICENSE](./LICENSE). © 2026 A Major Pte. Ltd.
