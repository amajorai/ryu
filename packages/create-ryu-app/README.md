# <img src="https://raw.githubusercontent.com/amajorai/ryu/main/.github/logo.png" width="50" align="middle" alt="" />&nbsp; create-ryu-app

> Scaffold a starter Ryu SDK project in one command. Part of [Ryu](../../README.md).

[![License](https://shieldcn.dev/badge/License-Apache--2.0-73DC8C.svg?logo=apache&logoColor=white)](./LICENSE)
[![Stack](https://shieldcn.dev/badge/TypeScript-CLI-3178C6.svg?logo=typescript&logoColor=white)](../../README.md)

`create-ryu-app` is the project scaffolder for the Ryu SDK. Running it generates a starter project with a Runnable, a gateway-pointed model config, and a `plugin.json` (legacy `ryu.json`) manifest validated against the AppManifest schema, so a new plugin compiles and packs out of the box. It depends on `@ryu/sdk` by semver.

**Tier:** OSS, Apache-2.0

## Install / Build

```bash
# scaffold a new project
bunx create-ryu-app <name>

# build from source
bun run build   # tsup → dist/
bun test
```

## What it provides

- A one-command scaffolder (`create-ryu-app <name>`) bundled with a project `template/`.
- A generated starter Runnable plus a gateway-pointed model config.
- A `plugin.json` / `ryu.json` manifest validated against the AppManifest schema, ready for `ryu pack`.

## License

Apache-2.0. See [LICENSE](./LICENSE). © 2026 A Major Pte. Ltd.
