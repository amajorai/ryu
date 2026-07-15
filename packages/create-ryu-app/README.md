# <img src="https://raw.githubusercontent.com/amajorai/ryu/main/.github/logo.png" width="50" align="middle" alt="" />&nbsp; create-ryu-app

> Scaffold a starter Ryu SDK project in one command. Part of [Ryu](../../README.md).

[![License](https://shieldcn.dev/badge/License-Apache--2.0-73DC8C.svg?logo=apache&logoColor=white)](./LICENSE)
[![Stack](https://shieldcn.dev/badge/TypeScript-CLI-3178C6.svg?logo=typescript&logoColor=white)](../../README.md)

`create-ryu-app` is the project scaffolder for the Ryu SDK. Running it generates a starter project with a Runnable, a gateway-pointed model config, and a `plugin.json` (legacy `ryu.json`) manifest validated against the PluginManifest schema, so a new plugin compiles and packs out of the box. It depends on `@ryuhq/sdk` by semver.

Pick a starter with `--template` (default `agent`):

| Template | Emits | Factory |
|---|---|---|
| `agent` | A loop-owning Runnable agent | `Agent` / `ryuTool` |
| `hook-plugin` | A post-assistant-turn plugin | `definePlugin` + `defineTurnHook` |
| `ryu-app` | An interactive in-chat widget | `defineApp` + a self-contained widget |
| `companion-plugin` | A Ryu App whose widget calls a companion tool, plus a panel surface | `defineApp` |

**Tier:** OSS, Apache-2.0

## Install / Build

```bash
# scaffold a new project (default: agent template)
bunx create-ryu-app <name>

# scaffold a specific template
bunx create-ryu-app <name> --template ryu-app

# build from source
bun run build   # tsup → dist/
bun test
```

## What it provides

- A one-command scaffolder (`create-ryu-app <name> [--template <t>]`) bundled with a `template/<name>/` tree per starter.
- A generated starter Runnable plus a gateway-pointed model config.
- A `plugin.json` / `ryu.json` manifest validated against the PluginManifest schema, ready for `ryu pack`.

## License

Apache-2.0. See [LICENSE](./LICENSE). © 2026 A Major Pte. Ltd.
