# <img src="https://raw.githubusercontent.com/amajorai/ryu/main/.github/logo.png" width="50" align="middle" alt="" />&nbsp; @ryu/blocks

> Composed, surface-specific UI sections built on the design system. Part of [Ryu](../../README.md).

[![License](https://shieldcn.dev/badge/License-Proprietary-71717A.svg)](./LICENSE)
[![Stack](https://shieldcn.dev/badge/TypeScript-React-3178C6.svg?logo=typescript&logoColor=white)](../../README.md)

`@ryu/blocks` is the layer above `@ryu/ui`: ready-made, composed sections and feature blocks for each closed surface. Where `@ryu/ui` ships primitives (button, dialog, table), `@ryu/blocks` ships whole sections (`hero`, `pricing`, `chat`, `agent-edit`, `marketplace`) that the apps drop in. It is the single source of UI truth for the web marketing site and the desktop/extension/island/command surfaces, so they stay visually and behaviorally consistent.

**Tier:** Closed, proprietary (A Major Pte. Ltd.)

## What it provides

- **Web blocks** (`web/*`): landing/marketing + portal sections: `hero`, `pricing`, `features`, `faq`, `footer`, `header`, `blog`, `dashboard`, auth forms, and more.
- **Desktop blocks** (`desktop/*`): feature surfaces: `chat`, `council`, `agents`, `agent-edit`, `spaces`, `marketplace`, `model-catalog`, `monitors`, `schedules`, `tools`, `onboarding`, `settings-items`, etc.
- **Extension / Island / Command blocks** (`extension/*`, `island/*`, `command/*`): the section shells those surfaces reuse (e.g. the command-bar shell shared by the island and desktop palette).
- **`./styles.css`**: the shared block stylesheet.

## Role

Built on `@ryu/ui` and `@ryu/command`; `motion`, `next`, `react`, and `react-dom` are peers. Exposed via per-surface `exports` subpaths (`@ryu/blocks/web/*`, `@ryu/blocks/desktop/*`, …), resolved through those export entries, so imports carry no file extension. Consumed by the closed `apps/web`, `apps/desktop`, `apps/extension`, and `apps/island`.

## License

Proprietary. See [LICENSE](./LICENSE). © 2026 A Major Pte. Ltd.
