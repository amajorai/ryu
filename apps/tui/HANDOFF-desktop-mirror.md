# Handoff: rebuild `apps/tui` to mirror the desktop app's UI/layout

You are taking over a redesign of the Ryu terminal UI. Read this whole brief before acting. Work in `D:\Code\ryu` (Bun + Turborepo monorepo, Windows), **in place on the `main` branch**. Use Bun for everything.

---

## 1. Mission

`apps/tui` is a Bun + OpenTUI (React reconciler) + termcn terminal UI that is a pure HTTP/SSE client to a running Ryu Core node. It currently mirrors the **legacy Rust CLI** (`apps/cli`) as **17 flat, equal tabs**. 

**Your job:** re-architect the shell so the TUI mirrors the **desktop app** (`apps/desktop`, Tauri + React) instead - its layout, information architecture, and navigation - so a desktop user has the same mental model in the terminal (the way `t1code` mirrors `t3chat`). This is a **shell rebuild + reorganization**, not a rewrite of the data/fetch logic: reuse the existing surface content components, re-grouped and re-skinned into the desktop's IA.

Do NOT match `apps/cli` anymore. The parity target is now `apps/desktop`.

### Confirmed design decisions (do not re-litigate)
1. **Full tabbed workspace with split-view** - a top tab-strip of open surfaces, split panes side-by-side, pinned tabs, `Ctrl+T` new / `Ctrl+W` close / `Ctrl+Shift+T` restore / `Ctrl+Alt+S` split / `Alt+←/→` navigate / `Ctrl+Tab` cycle. Maximum desktop fidelity.
2. **Settings and Gateway are modal overlay panels** (centered, own inset nav), opened over the workspace - faithful to desktop's dialog model. Not top-level tabs, not sidebar pages.

---

## 2. Current state of `apps/tui` (what already exists - REUSE it)

Built and verified green (`bun x tsc --noEmit` = 0, `bun test` passing). Key facts:

- Entry `src/index.tsx` (bin `ryu-tui`) → `src/App.tsx` (the shell you will replace). Providers: `ThemeProvider` → `CoreProvider` → `InputFocusProvider` → `ToastProvider` → `ChatIntentProvider` → `Shell`.
- **Core node access**: `src/core/CoreContext.tsx` exposes `useCore()` → `{ url, token, target, setTarget }`. `src/core/target.ts` seeds from env (`RYU_CORE_URL` default `http://127.0.0.1:7980`, `RYU_CORE_TOKEN`). Tabs call typed `@ryuhq/core-client/<module>` functions with the `ApiTarget` from `useCore()`. **Never** read env or build a target inside a surface - always `useCore()`.
- **Multi-node**: `src/core/nodes.ts` reads/writes the shared `~/.ryu/nodes.json` (`{ default, nodes:[{name,url,token,mesh?}] }`; active = the `default` name; missing→`local`/`127.0.0.1:2049`) and `healthCheck(target)`. The current shell has a `Ctrl+N` NodePicker. In the redesign, fold this into the **sidebar header node-selector** (desktop has a node-selector at the sidebar top).
- **Chat intent bridge**: `src/core/ChatIntentContext.tsx` lets the palette trigger chat-scoped actions (New chat / Sessions / Toggle double-check). Keep or adapt this pattern for cross-surface actions.
- **17 surface components** in `src/tabs/*.tsx`, each self-contained (fetch + render + keybindings), registered in `src/tabs/registry.ts`. These are your reusable content. The `TabModule`/`TabProps` contract is in `src/tabs/types.ts`.
- **Shared UI**: `src/ui/` has `ListTab.tsx` (generic list primitive), `StatusBar.tsx`, `toast.tsx`, `theme.ts` (`ryuTheme`). `src/core/featureList.ts` powers the list tabs. `InputFocusContext` gates plain-key globals while a text input is focused.
- **Chat reference**: `src/tabs/chat.tsx` is the fullest surface (SSE streaming via `src/core/chatStream.ts`, agent picker, `/btw /goal(cap25) /check /model /team /sessions /new /newchat`). It becomes the home surface.

### termcn + build gotchas (CRITICAL - violating these breaks the build)
- **termcn is VENDORED, not CLI-installed.** 48 components in `components/ui/*` (each `// @ts-nocheck`), plus `hooks/`, `lib/`. To add/update, edit + re-run `bun run scripts/vendor-termcn.ts opentui-<name>`. Never hand-edit vendored files. They are excluded from biome (root `biome.json`: `!apps/tui/components/ui`, `!apps/tui/hooks`, `!apps/tui/lib`) and have tsconfig relaxations.
- **`@/` alias imports must NOT get file extensions appended** - biome's `useImportExtensions` would add `.ts`/`.tsx` and break the alias (TS5097). The `apps/tui` biome override disables it; **never run `biome --write` / `ultracite fix` in a way that rewrites `@/` imports.** Use `ultracite check` (not `--write`) to lint; format individual new files carefully.
- Root `bunfig.toml` exempts `@opentui/*` from the 7-day `minimumReleaseAge`; platform binaries are os/cpu-gated optionalDependencies. `bun build src/index.tsx` fails only on statically resolving a non-matching platform binary (runtime-dynamic) - **trust `tsc --noEmit` + `bun test`, not `bun build`**, for verification.
- **Implement before importing** - biome auto-removes unused imports on save; add the usage in the same edit as the import.
- The `useExhaustiveDependencies` info-level diagnostic on `url`/`token` effect deps is **intentional** (drives node-switch reload). Leave it; it does not fail checks.
- Project standards (Ultracite/Biome): no em dashes; no `:` after inline `code` (use `-`); arrow callbacks; `for...of`; `const`; early returns; no `console.log`; throw `Error` objects; keep function cognitive complexity <= 20 (extract sub-components/helpers if a render callback gets complex).
- **OpenTUI**: JSX intrinsics `<box> <text> <input> <textarea> <select> <scrollbox> <ascii-font> <code>`, text modifiers `<span fg> <b> <em> <u> <br>`. Bootstrap `createCliRenderer()` + `createRoot()`. **Never call `process.exit()`** - use `renderer.destroy()`. Hooks: `useKeyboard`, `useRenderer`, `useOnResize`, `useTerminalDimensions`. Consult the local skill at `C:\Users\jiawei\.claude\skills\opentui\references` (react/api.md, react/patterns.md, react/gotchas.md, components/*.md, layout/REFERENCE.md, keyboard/REFERENCE.md, testing/REFERENCE.md). Headless verification uses the OpenTUI **test renderer** (`@opentui/react/test-utils` `testRender`) - see existing tests in `src/__tests__/`.

---

## 3. Target: the desktop app's information architecture (build to THIS)

`apps/desktop` is a **tabbed, browser-like shell** (react-router MemoryRouter). Layout:

```
┌───────────────────────────────────────────────────────────────┐
│ ‹titlebar + TAB STRIP: open surfaces, pinned chips, split brackets›│  h-12 overlay
├──────────────┬────────────────────────────────────────────────┤
│  AppSidebar  │   SidebarInset (active tab, or split panes)     │
│  header btns │   ┌──────────────────┬───────────────────────┐  │
│  sections    │   │  pane A           │  pane B (split)       │  │
│  footer      │   └──────────────────┴───────────────────────┘  │
│  (NavUser)   │                                    [Ask Ryu ◎]  │  floating assistant
└──────────────┴────────────────────────────────────────────────┘
```

Reference files (read these): `apps/desktop/src/App.tsx`, `components/layout/Layout.tsx`, `components/layout/AppSidebar.tsx`, `components/layout/TitleBar.tsx`, `components/layout/CommandPalette.tsx`, `components/layout/NavUser.tsx`, `components/layout/CreateMenu.tsx`, `components/settings/SettingsDialog.tsx`, `components/gateway/GatewayDialog.tsx`, `pages/StorePage.tsx`, `pages/ChatPage.tsx`, `contexts/TabsContext.tsx`.

### Navigation model
Features are **routes opened as tabs** via `openTab(path)` (desktop `TabsContext`). One `/*` route renders `Layout`; a `TabContent` map (`Layout.tsx:98-224`) turns a tab's `path` → page component. Users navigate via (a) the sidebar, (b) the **Cmd/Ctrl+K command palette** (canonical destination list `CommandPalette.tsx` `NAV_ITEMS`: Chat, Agents, Engines, Models, Skills, Spaces, Tools, Workflows, Calendar, Timeline, Monitors, Tasks, Inbox, Meetings, + Channels/Identities→Gateway, Credits→Settings), (c) **modal dialogs** (Settings, Gateway). **Chat is the default/home surface.**

Top-level tab paths (desktop `Layout.tsx`): `/home`, `/chat` (default), `/agents` (+`/agents/:id/edit`), `/store` (+ `/models /skills /engines /finetune` = StorePage with `initialSection`), `/library`, `/spaces` (+ doc editor), `/tools`, `/workflows` (+`/:id` canvas), `/calendar`, `/timeline`, `/monitors`, `/quests` (Tasks), `/inbox`, `/meetings`, `/marketplace`, `/apps`, `/fleet`, `/extensions`, `/settings`, `/file/…`.

### Left sidebar (`AppSidebar.tsx`)
Three zones - **Header chrome → Content sections → Footer (NavUser)**:
- **Header nav buttons** (`HEADER_BUTTON_CHROME`): Home, New chat, Search (⌘K), Library, Customize (→ /store), Tasks (quests), Timeline, Calendar. Plus a **node-selector** at the top-right of the header (which machine/node).
- **Content sections** (`DEFAULT_SECTION_ORDER`, order): `agents · teams · spaces · meetings · workflows · pinned · projects · chats · archived`. Each is collapsible, has a "+" create action, driven by **live data**. Projects = workspace folders with chats nested under them; Chats = folderless conversations; Pinned/Archived = flag buckets.
- **Footer NavUser**: account avatar/dropdown (name, plan badge, Theme, Settings, Sign out), CreateMenu, Inbox (approvals), Downloads, Settings gear.

### Chat surface (`ChatPage.tsx`)
Wrapped in `WorkspacePanels` (optional right + bottom panels) around `AgentChat`: message list (scrolls under the frosted titlebar), empty-state header with agent/team **mode picker**, composer/InputBar (attachments, voice, stop/branch), a `WorkspaceBar` above the textarea (project-folder picker + model selection). In a terminal, the right/bottom panels map to a **split pane or an overlay**; keep the composer + model/agent picker + slash commands from the existing `chat.tsx`.

### Store (`StorePage.tsx`) - central, unified
A single shell with a store-wide search + a section tab-row: **Plugins · Models · Skills · MCP · Agents · Engines · Fine-tune**. Reached via the sidebar "Customize"/Store button (`/store`).

### Settings dialog (`SettingsDialog.tsx`) - modal, own inset sidebar
Groups: **(ungrouped)** General, Features, Appearance, Island, Shadow, Voice, Memory, Meetings, Tasks, Predictive typing, Share your story · **Account** (Profile, Account, Sessions, Authorized Apps) · **Services** (Connections, Integrations, Billing, Teams, Credits) · **System** (Privacy, Storage, Updates, Danger Zone).

### Gateway dialog (`GatewayDialog.tsx`) - modal
Sub-nav (`GATEWAY_NAV_GROUPS`): **Overview** · **Policy** (Routing, Guardrails, Budgets, Keys, Identities, Channels) · **Observability** (Audit, Evals).

### Visual language
- Accent: monochrome/neutral by default (`--primary` near-black light / near-white dark), selectable color presets. Status dots: primary pulsing = running, destructive = failed.
- Frameless custom **titlebar** (`h-12`) carrying the tab strip; frosted "liquid glass" on chat (content scrolls under it). A terminal echoes this with a top tab-strip bar.
- **split-view-tabs**: horizontal scrollable tab strip; tabs support pinned icon-chips, groups (color brackets), splits (bracketed cluster, side-by-side panes). Keys: Ctrl+T/W/Shift+T, Ctrl+Alt+S split, Alt+←/→.
- **Command palette** (⌘K) + a separate **Island** companion (out of scope for the TUI).

---

## 4. Reuse mapping: existing `src/tabs/*` → new desktop IA

| Existing component | New home in the desktop IA |
|---|---|
| `chat.tsx` | **Chat surface** (home / default tab). Restructure toward the `AgentChat` layout; drive the sidebar Chats/Projects/Pinned/Archived from real conversations. |
| `agents.tsx` | **`/agents` page** (list + detail) **and** sidebar **Agents** section. |
| `teams.tsx` | sidebar **Teams** section (+ Settings→Services→Teams for billing). |
| `spaces.tsx` | **`/spaces` page** + sidebar **Spaces** section. |
| `meetings.tsx` | **`/meetings` page** + sidebar **Meetings** section. |
| `workflows.tsx` | **`/workflows` page** + sidebar **Workflows** section. |
| `monitors.tsx` | **`/monitors` page**. |
| `tools.tsx` | **`/tools` page** + Store **MCP** section. |
| `models.tsx` | Store **Models** section. |
| `skills.tsx` | Store **Skills** section. |
| `engines.tsx` | Store **Engines** section. |
| `apps.tsx` | **`/apps` page** + Store **Plugins** section. |
| `gateway.tsx` | **Gateway overlay** content (Overview/Policy/Observability). |
| `account.tsx` | **Settings overlay → Account** group + NavUser footer dropdown. |
| `services.tsx` | **Settings overlay → Services** group (+ node/gateway). |
| `schedules.tsx` | **`/quests` (Tasks) page** (desktop folds scheduling into Tasks/Calendar/Timeline). |
| `recipes.tsx` | fold into **Workflows** or **Library** (no dedicated desktop surface). |

New surfaces with no existing component (build fresh, lighter): **Home**, **Library**, **Tasks/Quests**, **Timeline**, **Calendar**, **Inbox** (approvals). Conversation list for the sidebar uses `GET /api/conversations` (the existing `spaces.tsx` already reads it via the raw `request()` primitive - reuse that pattern or add a typed helper).

---

## 5. Architecture to build

Replace the flat-tab shell with a desktop-mirrored one. Suggested structure:

- **`src/workspace/WorkspaceContext.tsx`** - the tab/pane model (desktop `TabsContext` analog): open tabs (each `{ id, path, title, pinned }`), an active tab per pane, a pane tree supporting **one split** (two panes side-by-side) minimum, focused pane, and actions: `openTab(path)`, `closeTab`, `restoreTab`, `pinTab`, `splitActive`, `focusPane`, `cycleTab`. Persisted session optional.
- **`src/workspace/TabStrip.tsx`** - the titlebar tab strip (open tabs, pinned chips, split brackets, active highlight).
- **`src/workspace/SplitView.tsx`** - render one or two panes side-by-side; route focus/keys to the focused pane.
- **`src/workspace/router.ts`** - `path` string → surface component map (desktop `TabContent` analog). This is the single registration point; surface builders do NOT edit it (integration does).
- **`src/sidebar/Sidebar.tsx`** - desktop `AppSidebar` analog: header nav-button cluster + node-selector (fold in `nodes.ts`), live-data content sections (`SidebarSection` collapsible, "+" action), footer `NavUser` (account, settings gear, inbox, downloads). Sections declare via a small registry so their data-loading is co-located; the sidebar itself is core (build it in the foundation, including the conversation/agents/teams/spaces/meetings/workflows section data-wiring, to avoid cross-agent conflicts).
- **`src/palette/CommandPalette.tsx`** - Ctrl+K, desktop `NAV_ITEMS` destinations (openTab) + actions (open Settings/Gateway overlays, New chat, Switch node, Quit). Fuzzy filter.
- **`src/overlays/OverlayHost.tsx`** + an overlay registry - modal centered panels with their own inset nav. Build **Settings** (`src/overlays/settings/*`) and **Gateway** (`src/overlays/gateway/*`) as overlays.
- **`src/surfaces/*`** - the page surfaces (chat, agents, store, tools, monitors, workflows, spaces, meetings, library, tasks, timeline, home). Each conforms to a **Surface contract** (props: `active`, the pane it lives in; declares title/icon; gates keyboard on active + focused-pane). Reuse the `src/tabs/*` content inside these.
- Keep `src/core/*` (CoreContext, nodes, chatStream, InputFocusContext, ChatIntentContext) and `src/ui/*` (theme, toast, ListTab, StatusBar). Migrate the old `src/tabs/registry.ts` into the new router; the old flat sidebar in `App.tsx` is replaced.

Every surface, overlay, and section must be built from **termcn components + `ryuTheme`** for visual consistency (mandatory).

---

## 6. Suggested execution plan (this is large - consider a Workflow)

Given the size, run it as phases (a `Workflow` fan-out works well - foundation first on the critical path, then parallel surface builders writing distinct files, then integrate + verify):

1. **Foundation (1 agent, high effort, critical path)** - build the entire shell in §5 (workspace/tabs/splits, tab strip, split view, router skeleton, full sidebar incl. live section data + node-selector, command palette, overlay host) and migrate **Chat** as the reference home surface. Publish a precise **CONTRACT**: the Surface-module shape + how to register a `path`; the overlay-registration shape; the sidebar-section shape; shared primitives/theme; the workspace keybinding map; and exactly how integration wires new paths/overlays/palette entries. Self-verify: `tsc --noEmit` 0, boot under the test renderer, `ultracite check` clean.
2. **Surfaces (parallel agents, one file-set each, against the contract)**:
   - Store unified shell (`src/surfaces/store/*`) reusing models/skills/tools(MCP)/apps/engines content, with the Plugins/Models/Skills/MCP/Agents/Engines/Fine-tune section row + search.
   - Settings overlay (`src/overlays/settings/*`) - Account/Services/System groups, reusing account/services content.
   - Gateway overlay (`src/overlays/gateway/*`) - Overview/Policy/Observability, reusing gateway content.
   - Pages bundle A (`src/surfaces/`): Agents (list+detail), Tools, Monitors.
   - Pages bundle B: Workflows, Spaces, Meetings.
   - Pages bundle C (fresh/light): Home, Library, Tasks/Quests, Timeline.
   Each builder READS the reference Chat surface + the contract + the relevant `src/tabs/*` source + the matching `apps/desktop` page for layout cues, and writes only its own files. Builders do NOT touch the router/sidebar/palette registries.
3. **Integrate (1 agent, high effort)** - wire every surface into the router, every destination into the palette, every section into the sidebar, every overlay into the overlay host, in desktop order. `bun install`; `tsc --noEmit` 0; add/repair OpenTUI-test-renderer smoke tests (open each surface as a tab, split a pane, pin a tab, open Settings + Gateway overlays, palette-nav); `ultracite check` clean; fix everything.
4. **Verify (1 agent, high effort)** - parity audit **against `apps/desktop`** (not `apps/cli`): sidebar header buttons + sections match; tabs/splits/pins work; Store sections present; Settings + Gateway overlays match their desktop groups; Chat echoes AgentChat; palette destinations match `NAV_ITEMS`. Re-run `tsc` + `bun test` and paste results. Produce a ranked gap list.

---

## 7. Verification gates (must be green before declaring done)
- `cd apps/tui && bun x tsc --noEmit` → **0 errors**.
- `cd apps/tui && bun test` → all pass (smoke tests must cover: workspace open/close/split/pin, each surface mounts, both overlays open, palette navigates).
- `cd apps/tui && bun x ultracite check .` → **0 errors** (info-level `url`/`token` exhaustive-deps are acceptable; never `--write` the `@/` alias extension change).
- Do NOT rely on `bun build` (platform-binary static-resolution false failure).
- Run gates yourself and paste real output - do not claim green without running.

## 8. Parity checklist (audit against `apps/desktop`)
- [ ] Sidebar header buttons: Home, New chat, Search(⌘K), Library, Store, Tasks, Timeline (+ node-selector at top).
- [ ] Sidebar sections in order: Agents, Teams, Spaces, Meetings, Workflows, Pinned, Projects, Chats, Archived - driven by live data.
- [ ] Footer NavUser: account + plan, Settings gear, Inbox, Downloads.
- [ ] Tabbed workspace: open/close/restore/pin tabs, split panes side-by-side, Ctrl+T/W/Shift+T/Ctrl+Alt+S/Alt+←→/Ctrl+Tab.
- [ ] Chat is the default surface; conversations populate the sidebar.
- [ ] Store unified shell with sections Plugins/Models/Skills/MCP/Agents/Engines/Fine-tune + search.
- [ ] Settings overlay: Account / Services / System groups.
- [ ] Gateway overlay: Overview / Policy(Routing,Guardrails,Budgets,Keys,Identities,Channels) / Observability(Audit,Evals).
- [ ] Ctrl+K palette destinations match desktop `NAV_ITEMS`.
- [ ] Pages exist and open as tabs: Agents, Tools, Monitors, Workflows, Spaces, Meetings, Library, Tasks, Timeline, Home.
- [ ] termcn components + `ryuTheme` used throughout; no ad-hoc colors.

## 9. Do / Don't
- DO reuse `src/tabs/*` content and `src/core/*` + `src/ui/*` infrastructure; regroup, don't rewrite the fetch logic.
- DO keep the multi-node `nodes.ts` (surface it in the sidebar node-selector) and the streaming chat logic.
- DON'T match `apps/cli` anymore; DON'T hand-edit vendored termcn; DON'T `--write` biome over `@/` imports (TS5097); DON'T `process.exit()`; DON'T trust `bun build` for verification.
- Ship alongside: bare `ryu` (classic ratatui) and `ryu tui` (this app) already coexist via `apps/cli/src/main.rs`; don't break that launcher.
