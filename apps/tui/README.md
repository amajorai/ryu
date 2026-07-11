# Ryu TUI

A terminal UI for Ryu Core, built with [OpenTUI](https://github.com/sst/opentui) (React reconciler) and [termcn](https://www.termcn.dev) components. It is a pure HTTP/SSE client to a running Ryu Core node - it embeds nothing.

This is the Bun replacement for the legacy Rust ratatui CLI at `apps/cli`. Parity target is that CLI, not the desktop app.

## Run

The TUI talks to a running Ryu Core node (start `ryu-core` first, default `http://127.0.0.1:7980`).

From this directory:

```sh
bun run dev      # bun run src/index.tsx
bun run start    # same entry, alias
```

From the repo root:

```sh
bun run --filter tui dev
```

Once installed globally the `ryu-tui` bin resolves to `src/index.tsx`:

```sh
ryu-tui
```

The Rust CLI also launches it as a subcommand, seeding `RYU_CORE_URL`/`RYU_CORE_TOKEN` from its active node so both terminal UIs share one node config:

```sh
ryu tui        # classic ratatui stays on bare `ryu`
```

## Configuration

The active Core node is seeded from the environment on launch (mirrors `apps/mcp`):

| Variable          | Default                  | Purpose                                  |
| ----------------- | ------------------------ | ---------------------------------------- |
| `RYU_CORE_URL`    | `http://127.0.0.1:7980`  | Base URL of the Core node.               |
| `RYU_CORE_TOKEN`  | (unset)                  | Optional bearer token; no header if unset. |
| `RYU_AUTH_URL`    | `http://localhost:3000`  | Control-plane (Better-Auth) URL, used only by the Account tab. |

```sh
RYU_CORE_URL=http://192.168.1.10:7980 RYU_CORE_TOKEN=xxxx bun run dev
```

Once running, `Ctrl+N` opens the node picker, which reads the shared `~/.ryu/nodes.json` config (same file the Rust CLI uses), health-checks each node, and switches the active node (url + token) for every subsequent call, persisting the choice back to `default`.

## Key bindings

Global (the shell owns these):

| Key            | Action                                             |
| -------------- | -------------------------------------------------- |
| `Ctrl+P`       | Command palette - fuzzy jump to any tab plus New chat, Sessions, Toggle double-check, Switch node, Quit. |
| `Ctrl+N`       | Node picker - switch the active Core node (`~/.ryu/nodes.json`). |
| `Tab` / `Shift+Tab` | Cycle tabs forward / back.                    |
| `1`-`9`        | Jump to tab N (suppressed while a text input is focused). |
| `Ctrl+C`       | Quit. `q` also quits when no text input is focused. |

Within a tab (owned by the active tab, gated on visibility):

| Key            | Action                                             |
| -------------- | -------------------------------------------------- |
| `j` / `k`, arrows | Move the selection in list tabs.                |
| `Enter`        | Primary action on the selected row.                |
| `a`            | Secondary action on the selected row (where a tab defines one). |
| `r`            | Reload the current tab's data.                      |
| `Esc`          | Close an overlay / clear focus.                     |

The Chat tab (`src/tabs/chat.tsx`) is the streaming reference and adds its own composer plus slash commands.

## Tabs

The 17 tabs match `apps/cli`'s sidebar order: Chat, Services, Agents, Models, Skills, Tools, Apps, Gateway, Workflows, Recipes, Teams, Spaces, Engines, Monitors, Meetings, Schedules, Account. They are registered in `src/tabs/registry.ts` (the single intentional barrel).

Terminal-N/A features from the desktop app are intentionally not ported: voice, the Plate/file editor, the React Flow workflow canvas (Workflows is a list here), the Shadow capture timeline, Stripe checkout, and split-view/island.

## Develop

```sh
bun run typecheck        # tsc --noEmit
bun test                 # smoke tests (boot + all 17 tabs mount under the test renderer)
bun x ultracite check .  # lint/format check
```

termcn components are vendored (not hand-edited) under `components/ui`, `hooks`, and `lib`. To add or update them, edit and re-run the reproducible script:

```sh
bun run scripts/vendor-termcn.ts opentui-<name>
```
