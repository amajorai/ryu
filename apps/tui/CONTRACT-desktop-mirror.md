# TUI Desktop-Mirror Shell — Builder Contract

The `apps/tui` shell now mirrors the **desktop** app (`apps/desktop`), not the
legacy Rust CLI. This document is the contract downstream builders code against.

The Foundation ships:

- The **workspace** (tab/pane model) — `src/workspace/WorkspaceContext.tsx`
- The **surface router** (single registration point) — `src/workspace/router.ts`
- **TabStrip**, **SplitView**, **NodePicker** — `src/workspace/*`
- The **Sidebar** (three zones, live data wired) — `src/sidebar/*`
- The **CommandPalette** (Ctrl+K) — `src/palette/CommandPalette.tsx`
- The **OverlayHost** + registry — `src/overlays/*`
- The **Chat** reference home surface (`/chat`) — `src/surfaces/chat/index.tsx`
- The rewired shell — `src/App.tsx`

Verified green: `bun x tsc --noEmit` (0 errors), `bun test` (7 pass),
`bun x ultracite check .` (0 errors; 11 info-level `url`/`token` exhaustive-deps
which are intentional).

Rules that still bite (from the repo brief): first line of every JSX file is
`/* @jsxImportSource @opentui/react */`; import vendored termcn via the `@/` alias
with **no** file extension; local relative imports **do** use `.ts`/`.tsx`; never
run `ultracite fix` / `biome check --write` (rewrites `@/` imports). Use
`bun x biome format --write <file>` for formatting only (safe) and
`bun x ultracite check .` (no `--write`) to lint.

---

## 1. The Surface contract

A **surface** is one self-contained screen. Types live in
`src/workspace/router.ts`:

```ts
export interface SurfaceProps {
  /** True while this surface is the visible/active tab in ITS pane. With a split
   *  open, two surfaces can be active at once — gate keyboard on
   *  `active && focused pane`. */
  active: boolean;
  /** The pane this instance renders in. Compare to useWorkspace().focusedPaneId
   *  to know if this pane owns the keyboard. */
  paneId: string;
}

export interface SurfaceModule {
  Component: (props: SurfaceProps) => ReactNode; // plain fn (OpenTUI JSX constraint)
  icon?: string;
  id: string;                        // stable, e.g. "agents"
  match: (path: string) => boolean;  // exact or prefix; owns the path
  title: string;                     // palette label + default tab title
}
```

### Author a surface (builder owns one file-set, never edits the router)

Create `src/surfaces/<name>/index.tsx`:

```tsx
/* @jsxImportSource @opentui/react */
import { useKeyboard } from "@opentui/react";
import { useTheme } from "@/components/ui/theme-provider";
import { useCore } from "../../core/CoreContext.tsx";
import { useSetInputFocused } from "../../core/InputFocusContext.tsx";
import type { SurfaceModule, SurfaceProps } from "../../workspace/router.ts";
import { useWorkspace } from "../../workspace/WorkspaceContext.tsx";

function AgentsSurface({ active, paneId }: SurfaceProps) {
  const { target } = useCore();               // node access — NEVER read env
  const { focusedPaneId, openTab } = useWorkspace();
  const focused = active && focusedPaneId === paneId; // keyboard gate
  const setInputFocused = useSetInputFocused();       // claim raw input if you own a text field
  const theme = useTheme();

  useKeyboard((key) => {
    if (!focused) return;                     // MANDATORY: gate on focused
    // ...handle keys...
  });

  return <box flexGrow={1}>{/* ...theme.colors.* only... */}</box>;
}

export const agentsSurface: SurfaceModule = {
  id: "agents",
  title: "Agents",
  match: (path) => path === "/agents" || path.startsWith("/agents/"), // prefix ok
  Component: AgentsSurface,
};
```

Contract rules for a surface:

- Read the node with `useCore()` → `{ url, token, target, setTarget }`. Pass
  `target` to typed `@ryuhq/core-client/<module>` calls. Never build a target.
- Navigate with `useWorkspace().openTab(path, opts?)`.
- Gate `useKeyboard` on `focused = active && focusedPaneId === paneId`.
- If you own a focused `<input>`/`<textarea>`, call
  `useSetInputFocused()(focused)` so the shell suppresses plain-key globals.
- Colors only from `useTheme()` (`theme.colors.*`). Never hardcode.

### Register a surface (the Integrate step, in `src/workspace/router.ts`)

Add exactly two lines to `src/workspace/router.ts` — the ONLY place surfaces are
registered:

```ts
import { agentsSurface } from "../surfaces/agents/index.tsx";
// ...at the bottom, next to registerSurface(chatSurface);
registerSurface(agentsSurface);
```

`registerSurface(module: SurfaceModule): void` is idempotent by `id`.
`resolveSurface(path: string): SurfaceModule | undefined` matches by predicate.
`listSurfaces(): readonly SurfaceModule[]` (used by the palette).

Once registered, opening the path (palette, sidebar, or `openTab`) renders the
surface. Unregistered paths render a "No surface registered for `<path>`"
placeholder — harmless before Integrate.

---

## 2. The Overlay contract

Overlays are centered modal panels with their own inset nav (desktop Settings /
Gateway dialogs). Types live in `src/overlays/registry.ts`:

```ts
export interface OverlayBodyProps {
  close: () => void; // close this overlay
  id: string;        // the overlay id (one body can serve several ids)
}

export interface OverlayModule {
  Body: (props: OverlayBodyProps) => ReactNode; // plain fn
  id: string;                                    // "settings", "gateway"
  title: string;                                 // header chrome title
}
```

`settings` and `gateway` are pre-registered with **skeleton** bodies so
`openOverlay("settings")` / `openOverlay("gateway")` already work. Builders
**re-register** the same id with the real body (last registration wins).

### Author + register an overlay body

Settings builder owns `src/overlays/settings/*`, Gateway builder owns
`src/overlays/gateway/*`. Create `src/overlays/settings/index.tsx`:

```tsx
/* @jsxImportSource @opentui/react */
import { useTheme } from "@/components/ui/theme-provider";
import { useCore } from "../../core/CoreContext.tsx";
import type { OverlayBodyProps, OverlayModule } from "../registry.ts";

function SettingsBody({ close, id }: OverlayBodyProps) {
  const { target } = useCore();
  const theme = useTheme();
  return <box flexDirection="column">{/* inset nav + panels */}</box>;
}

export const settingsOverlay: OverlayModule = {
  id: "settings",
  title: "Settings",
  Body: SettingsBody,
};
```

The Integrate step registers it (see §6):

```ts
import { registerOverlay } from "../overlays/registry.ts";
import { settingsOverlay } from "../overlays/settings/index.tsx";
registerOverlay(settingsOverlay); // replaces the skeleton for id "settings"
```

Open/close at runtime with the `useOverlay()` hook from
`src/overlays/OverlayHost.tsx`: `openOverlay(id)`, `closeOverlay()`,
`openId`. The host renders the open overlay centered, claims raw input, and
handles `Esc` to close; the body owns its inner navigation (gate on being open).

---

## 3. The Sidebar-section contract (already wired by Foundation)

The Foundation **already loads and renders** every live-data section, so surface
builders do **not** wire sidebar data. Sections, in desktop order: `agents`,
`teams`, `spaces`, `meetings`, `workflows`, `pinned`, `projects`, `chats`,
`archived`. Each is a collapsible `SidebarSection` with a `+` create action.

Data lives in `src/sidebar/data.ts`:

```ts
export interface SidebarItem { badge?: string; id: string; label: string; path: string; }
export interface ProjectGroup { chats: SidebarItem[]; id: string; name: string; }
export interface SidebarData {
  agents: SidebarItem[]; teams: SidebarItem[]; spaces: SidebarItem[];
  meetings: SidebarItem[]; workflows: SidebarItem[]; pinned: SidebarItem[];
  projects: ProjectGroup[]; chats: SidebarItem[]; archived: SidebarItem[];
}
export function loadSidebarData(target: ApiTarget): Promise<SidebarData>;
```

Sources: `agents/teams/spaces/meetings/workflows` via their typed core-client
modules; conversations via raw `request(target, "/api/conversations")` (the
`spaces.tsx` pattern). Conversations are bucketed into `projects` (by
`folder`/`project` field), folderless `chats`, and `pinned`/`archived` flag
buckets. **Absent fields degrade to empty buckets** (Core may not serialize
them). Every source failure degrades that section to empty (never an error view).

Read it with `useSidebarData()` from `src/sidebar/useSidebarData.ts`
(`{ data: SidebarData; loading: boolean }`, reloads on node switch).

To **extend** the sidebar (rarely needed): add a source + mapping in
`src/sidebar/data.ts`, a field on `SidebarData`, and a `SectionSpec` entry in
`SectionList` inside `src/sidebar/Sidebar.tsx`. Do not add a second data path.

---

## 4. Shared primitives (import paths + key props)

| Primitive | Import | Key API |
| --- | --- | --- |
| `useWorkspace()` | `src/workspace/WorkspaceContext.tsx` | `{ tabs, panes, focusedPaneId, openTab(path, opts?), closeTab(id), restoreTab(), pinTab(id), splitActive(), focusPane(paneId), cycleTab(dir), activateTab(paneId, tabId) }` |
| `useCore()` | `src/core/CoreContext.tsx` | `{ url, token, target, setTarget(next) }` — pass `target` to core-client |
| `useOverlay()` | `src/overlays/OverlayHost.tsx` | `{ openId, openOverlay(id), closeOverlay() }` |
| `useToast()` | `src/ui/toast.tsx` | `notify(message, "info"\|"success"\|"warning"\|"error"\|"loading")` |
| `useTheme()` | `@/components/ui/theme-provider` | `theme.colors.{primary,foreground,background,muted,mutedForeground,border,focusRing,accent,secondary,success,warning,error,info,...}` |
| `useSetInputFocused()` | `src/core/InputFocusContext.tsx` | `(focused: boolean) => void` |
| `useInputFocused()` | `src/core/InputFocusContext.tsx` | `boolean` |
| `ListTab` | `src/ui/ListTab.tsx` | props `{ active, load(target, signal?) => Promise<ListRow[]>, onActivate?, onSecondary?, emptyLabel?, height? }` — a full data-driven list (lazy load, j/k nav, Enter/`a`/`r`, error/loading). Wrap it in a surface and pass `active={focused}`. |
| `StatusBar` | `src/ui/StatusBar.tsx` | `{ hints: {keys,label}[], left?: string }` (already mounted by the shell) |
| `registerPaletteAction` | `src/palette/CommandPalette.tsx` | `(action: { id; label; run }) => void` — contribute extra palette actions |

`ListRow` (`src/core/featureList.ts`): `{ id, title, subtitle?, badge? }`.

### `useWorkspace()` full type

```ts
interface Tab { id: string; path: string; pinned: boolean; title: string; }
interface Pane { activeTabId: string | null; id: string; tabIds: string[]; }
openTab(path: string, opts?: { forceNew?: boolean; title?: string }): string; // returns tab id
cycleTab(dir: 1 | -1): void;
```

Singleton paths (everything except `/chat`) are revealed if already open in the
focused pane; `/chat` always opens a new tab. `forceNew: true` forces a new tab
for any path. The workspace supports **one** split (two panes).

---

## 5. Workspace keybinding map

Owned by `WorkspaceShell` in `src/App.tsx`. Only `Ctrl+C` is global; while the
palette / an overlay / the node picker is open, the shell yields to it.

| Keys | Action |
| --- | --- |
| `Ctrl+C` | Quit (`renderer.destroy()` — never `process.exit`) |
| `Ctrl+K` | Toggle the command palette |
| `Ctrl+T` | New chat tab (`openTab("/chat", { forceNew: true })`) |
| `Ctrl+W` | Close the focused pane's active tab |
| `Ctrl+Shift+T` | Restore the last-closed tab |
| `Ctrl+Alt+S` | Toggle a two-pane split (`splitActive`) |
| `Alt+Left` / `Alt+Right` | Move focus between panes |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | Cycle tabs in the focused pane |
| `Esc` | Close the open palette / overlay / node picker |

Within a surface, keys are the surface's own (gated on `active && focused pane`).
The Chat surface keeps `Ctrl+A` (agent picker), `Ctrl+L` (new chat), `Enter`
(send), and slash commands `/btw /goal /check /model /team /sessions /new`.

Modifier fields on the OpenTUI `KeyEvent`: `key.ctrl`, `key.shift`, `key.option`
(Alt), `key.meta`, `key.name`.

---

## 6. Exactly how the Integrate step wires things

All wiring is additive and lives in three known files. Downstream builders write
their surface/overlay files; Integrate flips them on.

1. **New surface path** → edit `src/workspace/router.ts`:
   `import { xSurface } from "../surfaces/x/index.tsx";` then
   `registerSurface(xSurface);` (next to `registerSurface(chatSurface)`).

2. **Overlay body** → edit the Integrate wiring point (a module imported by
   `App.tsx`, e.g. an `src/overlays/register.ts` you add, or inline near the
   `OverlayProvider`): `import { registerOverlay } from "../overlays/registry.ts";`
   `import { settingsOverlay } from "../overlays/settings/index.tsx";`
   `registerOverlay(settingsOverlay);`. This replaces the skeleton for that id.

3. **Extra palette entry** → call `registerPaletteAction({ id, label, run })`
   from `src/palette/CommandPalette.tsx` at import time (e.g. from the surface's
   own module or the Integrate module). Navigation destinations for registered
   surfaces are already auto-derived from the router, so a plain surface needs no
   palette edit; use `registerPaletteAction` only for non-navigation actions.

No builder edits `src/App.tsx`, `TabStrip`, `SplitView`, `OverlayHost`, or the
`Sidebar` internals.

---

## 7. File ownership (so builders never collide)

| Builder | Owns (create/edit only these) |
| --- | --- |
| Foundation (this) | `src/workspace/*`, `src/sidebar/*`, `src/palette/*`, `src/overlays/OverlayHost.tsx`, `src/overlays/registry.ts`, `src/surfaces/chat/*`, `src/App.tsx`, `src/__tests__/*` |
| store | `src/surfaces/store/*` |
| settings | `src/overlays/settings/*` |
| gateway | `src/overlays/gateway/*` |
| pages-A | `src/surfaces/agents/*`, `src/surfaces/tools/*`, `src/surfaces/monitors/*` |
| pages-B | `src/surfaces/workflows/*`, `src/surfaces/spaces/*`, `src/surfaces/meetings/*` |
| pages-C | `src/surfaces/home/*`, `src/surfaces/library/*`, `src/surfaces/tasks/*`, `src/surfaces/timeline/*`, `src/surfaces/calendar/*` |

Shared, edited **only** at Integrate: `src/workspace/router.ts` (surface
registrations), the overlay registration module, and any `registerPaletteAction`
call sites. `src/core/*` and `src/ui/*` are stable — reuse, do not modify. The
legacy `src/tabs/*` flat surfaces remain in place for content reference and are
retired by Integrate/Verify; the new shell does not depend on them.
