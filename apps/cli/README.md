# Ryu CLI

A terminal UI for Ryu Core, built with [OpenTUI](https://github.com/sst/opentui) (React reconciler) and [termcn](https://www.termcn.dev) components. It is a pure HTTP/SSE client to a running Ryu Core node - it embeds nothing.

This is the Bun/OpenTUI terminal client for Ryu Core. Its primary parity target is the
Desktop app's user-facing capabilities and information architecture where a terminal
can provide a useful equivalent. It shares the Rust CLI's node configuration and
deep-link conventions, but the Desktop app is the product reference for feature parity.

## Run

The TUI talks to a running Ryu Core node (start `ryu-core` first, default `http://127.0.0.1:7980`).

From this directory:

```sh
bun run dev      # bun run src/index.tsx
bun run start    # same entry, alias
```

From the repo root:

```sh
bun run --filter cli dev
```

Once installed globally the `ryu-cli` bin resolves to `src/index.tsx`:

```sh
ryu-cli
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
| `RYU_AUTH_URL`    | `https://api.ryuhq.com` (`http://localhost:3000` under `RYU_PROFILE=dev`) | Control-plane (Better-Auth) URL for the Account tab, waitlist gate, managed nodes and product mode. An unset plain-HTTP loopback default (dev profile) is a port any local program can claim, so it is sent no account token or user JWT; set `RYU_AUTH_URL=http://localhost:3000` explicitly to use a local dev control plane. |
| `RYU_FRONTEND_URL` | `https://ryuhq.com` (`http://localhost:3001` under `RYU_PROFILE=dev`) | Web app origin used in printed links. |

```sh
RYU_CORE_URL=http://192.168.1.10:7980 RYU_CORE_TOKEN=xxxx bun run dev
```

Once running, `Ctrl+N` opens the node picker, which reads the shared `~/.ryu/nodes.json` config (same file the Rust CLI uses), health-checks each node, and switches the active node (url + token) for every subsequent call, persisting the choice back to `default`.

### Ryu Connect (`ryu-cli connect`)

Bare `ryu-cli connect` and its Connect subcommands talk to a Ryu Connect
deployment instead of Core (`ryu-cli connect <agent>` still wires Ryu's MCP
tools into a coding agent; the first word routes)
(`src/cli/connect.ts` over the typed client in `src/cli/connectClient.ts`;
Treg parity B12). It reads `RYU_CONNECT_URL` (or `--url`) and `RYU_CONNECT_KEY`
(environment only, sent only to that HTTPS or loopback origin, no redirects),
and browses the anonymous catalog at `RYU_TOOL_CATALOG_URL`, else
`<RYU_CONTROL_PLANE_URL | RYU_SERVER_URL | https://api.ryuhq.com>/api/tool-catalog`.
Subcommands: bare `ryu-cli connect` (live status), `browse [platform]`,
`search <words>`, `describe <id>`, `request <text>`, `call <id>` (result on
stdout, one JSON line with the call id and charge on stderr; a fresh
`Idempotency-Key` unless `--idempotency-key` is given) and `balance`. Tests:
`src/__tests__/cli.connect.test.ts` against a loopback Connect.

## Key bindings

Global workspace bindings:

| Key | Action |
|---|---|
| `Ctrl+K` | Open the fuzzy command palette. |
| `Ctrl+N` | Open the node picker. |
| `Ctrl+T` | Open a new chat tab. |
| `Ctrl+Shift+T` | Restore the last-closed tab. |
| `Ctrl+W` | Close the focused pane's active tab. |
| `Ctrl+Alt+S` | Toggle a two-pane split. |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | Cycle the focused pane's tabs. |
| `Alt+1` … `Alt+9` | Jump to tab 1-9 of the focused pane. |
| `Alt+Left` / `Alt+Right` | Move focus between panes. |
| `Ctrl+B` / `Alt+B` | Show or hide the sidebar (`Alt+B` for tmux/Herdr, which own `Ctrl+B`). |
| `F6` / `Alt+0` | Focus the sidebar (`↑↓` move, `Enter` open, `←→` fold, `Esc` back). |
| `Ctrl+Shift+M` | Choose Bot, Console, or OS mode. |
| `F1` / `Ctrl+?` / `?` | Open the searchable keyboard-shortcuts overlay (`?` only outside text fields). |
| `Ctrl+C` | Copy the mouse selection, stop streaming, or clear the chat draft; otherwise arm quit. |
| `Ctrl+C` ×2 | Quit and restore the terminal (second press within 2 seconds). |

Chat bindings (the full list, generated from `src/core/keymap.ts`, is in the `F1` overlay):

| Key | Action |
|---|---|
| `Enter` | Send (queues while a reply streams; resumes a paused queue when the composer is empty). |
| `Shift+Enter` / `Alt+Enter` / `Ctrl+J` | Insert a newline. |
| `↑` / `↓` | Prompt history from the first / last line of the draft. |
| `Esc` | Interrupt the reply (pauses the queue; again clears it) or close an overlay. |
| `PgUp` / `PgDn`, `Ctrl+Alt+U` / `Ctrl+Alt+D` | Scroll the transcript a page / half a page. |
| `Ctrl+Home` / `Ctrl+End` | Transcript top / jump to latest. |
| `Ctrl+A` / `Ctrl+R` | Choose agent / ACP settings (not in Bot mode). |
| `Ctrl+L` | Start a new conversation. |
| `Ctrl+Q` | Focus queued prompts. |
| `Ctrl+O` | Expand or collapse long prompts. |
| `Alt+1` / `Alt+2` / `Alt+3` | Resume a recent conversation from an empty chat (single-tab pane). |

The command palette is the primary jump surface; the sidebar also opens Home, Chat, Library,
Customize, Tasks, Timeline, and data-backed sections. Individual surfaces own their list and form
keys. Most lists use `j`/`k` or arrow keys, `Enter` for the primary action, and `r` to refresh;
available actions are shown in the status bar, which drops lower-priority hints to fit the width.
Destructive Store and Services actions (uninstall, cascade, start/stop all) ask for confirmation:
`y` confirms, `n`/`Esc` cancels.

## Workspace surfaces

The TUI mirrors the Desktop workspace model with route-backed surfaces rather than the legacy
flat-tab list. Built-in destinations include Chat, Agents, Groups, Home, Library, Store sections,
Spaces, Tools, Workflows, Calendar, Timeline, Monitors, Tasks, Meetings, Inbox, Downloads, Setup,
and contributed app views. The Store surface groups Plugins, Sidecars, Models, Skills, MCP, Agents,
Engines, and Fine-tune; it also supports whole-store search.

Some Desktop effects have no terminal equivalent. Voice capture, rich file editing, the workflow
canvas, screen-capture timelines, native Dock/window management, and Tauri OS permission prompts
remain host-owned; `ryu open <page>` hands supported pages to Desktop. See the public
[Desktop parity guide](../fumadocs/content/docs/surfaces/cli/parity.mdx) for the current mapping.

## Standalone services

`ryu-cli services <args…>` delegates to the `ryu-services` command line from
`@ryuhq/services-cli` (`src/cli/services.ts`). Every token after `services` is passed
unchanged, including `--help`, `--json`, and a literal `--`, so put flags after `services`;
a token before it (`ryu-cli --json services …`) is rejected with exit 2 instead of being dropped. Configuration is
the `ryu-services` contract (environment variables and flags only, no Core node), and the
exit code is `ryu-services`' own. `ryu-cli services` with no arguments prints its help.

```sh
ryu-cli services doctor
ryu-cli services notify publish --title "Deploy finished" --dry-run
```

## Develop

```sh
bun run check             # TypeScript
bun test                  # CLI unit, shell, and interaction regressions
bun x ultracite check .   # lint/format check
```

termcn components are vendored (not hand-edited) under `components/ui`, `hooks`, and `lib`. To add or update them, edit and re-run the reproducible script:

```sh
bun run scripts/vendor-termcn.ts opentui-<name>
```
