# <img src="https://raw.githubusercontent.com/amajorai/ryu/main/.github/logo.png" width="50" align="middle" alt="" />&nbsp; @ryu/sdk

> Ryu's own developer SDK for authoring agents, workflows, tools, and skills. Part of [Ryu](../../README.md).

[![License](https://shieldcn.dev/badge/License-Apache--2.0-73DC8C.svg?logo=apache&logoColor=white)](./LICENSE)
[![Stack](https://shieldcn.dev/badge/TypeScript-SDK-3178C6.svg?logo=typescript&logoColor=white)](../../README.md)

`@ryu/sdk` provides typed Runnable factories (`agent`, `workflow`, `tool`, `skill` plus their builders), a gateway-mandatory model client so every model call routes through the Ryu Gateway, an MCP server/client, and a `ryu` CLI for packing and publishing plugin bundles. It is Runnable-native: reference the AI SDK / Mastra / ACP patterns, but depend on none of them. The native logic ships through a prebuilt addon, `@ryu/sdk-native` (the `crates/ryu-sdk-napi` binding).

**Tier:** OSS (Apache-2.0)

## Install / Build

```bash
bun add @ryu/sdk
# build from source
bun run build   # tsup → dist/
bun test
```

## What it provides

- **Runnable factories:** `agent`, `workflow`, `tool`, `skill` (and `AgentBuilder` / `WorkflowBuilder` / `ToolBuilder` / `SkillBuilder` / `PluginBuilder`) for the one Runnable contract (input to run to output).
- **Manifest model:** `PluginManifest` types + `PluginManifestSchema` / `validateManifestStrict` / `validatePluginId` (also exported from `@ryu/sdk/manifest`).
- **Gateway-mandatory model client:** chat types and a client where every model call routes through the Ryu Gateway.
- **MCP server/client:** author and consume MCP tool surfaces.
- **CLI:** `bunx ryu pack <dir>` (and `ryu publish`) via the package `bin` entry.

## License

Apache-2.0. See [LICENSE](./LICENSE). © 2026 A Major Pte. Ltd.
