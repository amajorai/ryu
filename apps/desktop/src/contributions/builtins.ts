// Seeds every built-in desktop page into the contribution registry, reproducing
// the exact routes (and first-match precedence) of the old `TabContent` if-else
// in `Layout.tsx`. This is the behavior-preserving half of #446: Layout renders
// via `RouteOutlet` (which calls `contributionRegistry.resolve`), so this file is
// the single place built-in routes are declared, and a plugin appends to the same
// registry instead of editing `Layout.tsx`.
//
// This module is the EXACT mirror of `Layout.tsx`'s former `TabContent`: every
// branch below maps one branch there, in the same exact-then-pattern order. The
// old chain interleaved exact and pattern branches, but every pattern is
// `$`-anchored and requires a deeper path segment than its exact sibling
// (`/agents` vs `/agents/.+/edit`, `/workflows` vs `/workflows/.+`, `/spaces` vs
// `/spaces/:id`, `/library` vs `/library/:section`, `/meetings` vs
// `/meetings/:id`), so no path matches both. Exacts therefore go in the O(1) map
// (checked first) and patterns in an ordered list — behavior-identical to the
// interleaved chain, only relative pattern order matters (and is preserved here).
//
// Deliberately NOT registered here (all are wired elsewhere so this stays a pure
// behavior-preserving mirror of the old chain):
//   - `/plugin/<id>` — registered per enabled companion by
//     `usePluginContributionRoutes`, so a disabled plugin's route disappears
//     (resolves null → blank) exactly as #446 item 4 wants.
//   - The Home dashboard — registered by `useAppShellRoutes` at whatever path
//     `@ryu/dashboards` declares in `contributes.sidebar_buttons[].target`. The
//     component is a shell page (no companion bundle), but the feature is the app's,
//     so the app decides both the path AND whether the route exists at all. It used
//     to be a frozen `exact("/home", …)` here: the sidebar button was already
//     app-registered and correctly hid itself when the (not pre-installed) app was
//     disabled, while the route stayed live — the exact disagreement
//     `companion-alias.ts` exists to prevent. See `app-shell-routes.ts`.
//   - The scaffold "extras" the old `TabContent` never handled (`/graph`,
//     `/spaces/:id/graph`, `/profile`): the old chain returned `null` (blank) for those
//     paths, so mounting a real page here would be a regression, not a refactor. Left
//     for a separate PR. (`/skills/new` + `/skills/:id/edit` ARE now handled below — the
//     W7 frontend extraction landed the SKILL.md editor as the @ryu/skill-editor
//     companion; both previously resolved to blank.)
//
// No COMPANION ID is named here. This file used to carry twelve hardcoded aliases of the
// shape `createElement(PluginCompanionPage, { companionId: "app__<x>-companion" })`
// (activity, approvals/inbox, calendar, learning, mail, meetings, monitors, quests,
// skill-editor, timeline, webhooks, workflows). They duplicated the
// `usePluginContributionRoutes` seam AND kept resolving after their app was disabled
// — a companion id baked into shell code cannot know the app is gone. They are
// replaced by `CompanionAliasRoute` below: one generic catch-all that looks the
// companion up in the LIVE contributions feed, so an app that is not enabled
// contributes no companion, matches nothing, and its short path renders blank
// exactly as the seam intends. See `resolveCompanionAlias` for the lookup order.
//
// NOTE (PR-1 wiring): `seedBuiltinRoutes()` is called once at `Layout.tsx` module
// load (before first render) so the registry is populated before `RouteOutlet`
// resolves. Kept as JSX-free `createElement` calls so the file is `.ts` (no
// `.tsx`) and carries no JSX-runtime assumptions.

import { createElement, type ReactNode } from "react";
import type { AttachedImage } from "@/components/agent-elements/input-bar.tsx";
import { CrashBoundary } from "@/src/components/CrashBoundary.tsx";
import {
	MemoryDreamPage,
	MemoryReflectPage,
} from "@/src/components/memory/MemoryLibrary.tsx";
import { PANE_CHOOSER_PATH } from "@/src/lib/splitPresets.ts";
import { WHITEBOARD_PLUGIN_ID } from "@/src/lib/whiteboard/app.ts";
import AgentEditPage from "@/src/pages/AgentEditPage.tsx";
import ArtifactViewPage from "@/src/pages/ArtifactViewPage.tsx";
import ChannelsPage from "@/src/pages/ChannelsPage.tsx";
import ChatPage from "@/src/pages/ChatPage.tsx";
import DownloadsPage from "@/src/pages/DownloadsPage.tsx";
import FileEditorPage from "@/src/pages/FileEditorPage.tsx";
import IdentitiesPage from "@/src/pages/IdentitiesPage.tsx";
import LibraryPage from "@/src/pages/LibraryPage.tsx";
import { PaneChooserPage } from "@/src/pages/PaneChooserPage.tsx";
import PluginCompanionPage, {
	CompanionUnavailable,
} from "@/src/pages/PluginCompanionPage.tsx";
import ProjectDiffPage from "@/src/pages/ProjectDiffPage.tsx";
import ProjectFilesPage from "@/src/pages/ProjectFilesPage.tsx";
import ProjectGitGraphPage from "@/src/pages/ProjectGitGraphPage.tsx";
import ReviewPage from "@/src/pages/ReviewPage.tsx";
import SettingsPage from "@/src/pages/SettingsPage.tsx";
import SpaceAppDocPage from "@/src/pages/SpaceAppDocPage.tsx";
import SpaceDatabaseEditorPage from "@/src/pages/SpaceDatabaseEditorPage.tsx";
import SpaceDatabaseRowPage from "@/src/pages/SpaceDatabaseRowPage.tsx";
import SpaceDocEditorPage from "@/src/pages/SpaceDocEditorPage.tsx";
import SpaceFileViewerPage from "@/src/pages/SpaceFileViewerPage.tsx";
import SpacesPage from "@/src/pages/SpacesPage.tsx";
import StorePage from "@/src/pages/StorePage.tsx";
import WorkflowsPage from "@/src/pages/WorkflowsPage.tsx";
import {
	APPROVALS_ALIAS,
	SKILL_EDITOR_ALIAS,
	topLevelAlias,
} from "./companion-alias.ts";
import { contributionRegistry, type RouteTab } from "./registry.ts";
import { useCompanionAlias } from "./use-companion-alias.ts";

// /channels/:id — manage a channel bot ("new" opens create mode).
const CHANNEL_DETAIL = /^\/channels\/[^/]+$/;
// /identities/profile/:profileId — manage identities with a profile focused.
const IDENTITY_PROFILE = /^\/identities\/profile\/[^/]+$/;
// A Notion-style markdown page inside a Space: /spaces/:spaceId/doc/:docId
const SPACE_DOC = /^\/spaces\/[^/]+\/doc\/[^/]+$/;
// A stored binary file in its native viewer/editor: /spaces/:spaceId/file/:docId
const SPACE_FILE = /^\/spaces\/[^/]+\/file\/[^/]+$/;
// A single database row's detail: /spaces/:spaceId/db/:databaseId/row/:rowId
const SPACE_DB_ROW = /^\/spaces\/[^/]+\/db\/[^/]+\/row\/[^/]+$/;
// A Space's data-grid database: /spaces/:spaceId/db/:databaseId
const SPACE_DB = /^\/spaces\/[^/]+\/db\/[^/]+$/;
// A Space's whiteboard (ported to the Whiteboard Ryu App): /spaces/:spaceId/wb/:documentId
const SPACE_WB = /^\/spaces\/[^/]+\/wb\/[^/]+$/;
// A Space document owned by a Ryu App: /spaces/:spaceId/app/:pluginId/:documentId
const SPACE_APP = /^\/spaces\/[^/]+\/app\/[^/]+\/[^/]+$/;
// /spaces/:spaceId — a single trailing segment (the doc/db patterns above are
// deeper), opening the Spaces page with that space pre-selected.
const SPACE_DETAIL = /^\/spaces\/[^/]+$/;
// /library/<section> — opens the unified Library on a specific collection tab.
const LIBRARY_SECTION = /^\/library\/([^/]+)$/;
// Memory keeps its Dream and Reflect views as deep links so a review can be
// reopened from notifications, command palette results, or a shared tab.
const MEMORY_VIEW = /^\/library\/memory\/(dream|reflect)$/;
/** `/chat/agent/<agentId>` — the messaging-style merged view: every thread with
 *  that agent in one scroll, with the composer choosing which one a send joins. */
const CHAT_MERGED_AGENT = /^\/chat\/agent\/([^/]+)$/;
// /workflows/:id (":id" is a workflow id, or "new" for an empty canvas). Single
// segment ([^/]+, not .+) so it does NOT swallow the two-segment builder path
// `/workflows/build/:id`.
const WORKFLOW_DETAIL = /^\/workflows\/[^/]+$/;
// App-owned record details opened from contributed sidebar sections. The list
// lives in the host sidebar; the companion receives the selected id as mount
// context so its content surface never needs to rebuild that picker.
const BLUEPRINT_DETAIL = /^\/blueprint\/[^/]+$/;
const MAIL_DETAIL = /^\/mail\/[^/]+$/;
const MONITOR_DETAIL = /^\/monitors\/[^/]+$/;
const REASONING_DETAIL = /^\/reasoning\/[^/]+$/;
const RLM_DETAIL = /^\/rlm\/[^/]+$/;
// /workflows/build/:id — the NL workflow builder for an existing workflow (the
// `/workflows/build` new-draft entry is an exact route). The builder is shell-
// only (see WorkflowsPage): host.runAgent's PermissionPreset never exposes the
// `workflow_builder.*` tools to the sandboxed canvas companion.
const WORKFLOW_BUILD = /^\/workflows\/build\/[^/]+$/;
// /meetings/:id — a specific meeting's transcript + notes.
const MEETING_DETAIL = /^\/meetings\/[^/]+$/;
// /social/:id — one scheduled post inside Outpost.
const SOCIAL_DETAIL = /^\/social\/[^/]+$/;
// A deep-linked "open captured moment" into the Timeline: /timeline/:ts (ts in
// Unix µs). The command palette's "Search everything" opens this so the scrubber
// jumps straight to that moment; the ts is baked into the companion mount context
// as `window.ryu.context.focusTs` (the sandbox cannot receive the shell's
// `ryu:timeline-focus` window event the desktop page used).
const TIMELINE_FOCUS = /^\/timeline\/[^/]+$/;
// /agents/new/edit or /agents/:id/edit.
const AGENT_EDIT = /^\/agents\/.+\/edit$/;
// /artifact/:id — a session-local artifact surfaced by the agent, rendered
// full-size in a workspace tab (see ArtifactViewPage + useArtifactStore).
const ARTIFACT_VIEW = /^\/artifact\/[^/]+$/;
// Project-scoped workspace surfaces can be opened as first-class main tabs. The
// folder is encoded into one segment so Windows drives and nested paths survive
// the tab router without being mistaken for additional route segments.
const PROJECT_VIEW = /^\/project\/(diff|files|graph)\/([^/]+)$/;
// /skills/:id/edit — the SKILL.md editor for an existing skill (the `/skills/new`
// fresh-draft entry is an exact route). Single id segment ([^/]+), deeper than the
// `/skills` store exact, so no collision. The skill id is baked into the sandboxed
// @ryu/skill-editor companion as `window.ryu.context.skillId`.
const SKILL_EDIT = /^\/skills\/[^/]+\/edit$/;
// The legacy short-path catch-all: ANY single top-level segment the exact map and
// every pattern above declined (`/calendar`, `/timeline`, `/inbox`, …). Registered
// LAST so it can only ever see paths that used to fall through to `null`; it hands
// them to `CompanionAliasRoute`, which either finds a live companion in the
// contributions feed or renders blank — the same blank the fallthrough produced.
// Every pattern above needs at least two segments, so the two never compete.
const COMPANION_ALIAS = /^\/[^/]+$/;

/**
 * Mount whatever enabled app answers to `alias`, or nothing.
 *
 * The generic replacement for a hardcoded `companionId`. `mountContext` is forwarded
 * untouched so the context-carrying deep links (`/timeline/:ts` → `focusTs`,
 * `/meetings/:id` → `meetingId`, `/workflows/:id` → `workflowId`,
 * `/skills/:id/edit` → `skillId`) keep baking their parameter into the sandboxed
 * frame as `window.ryu.context.*` — losing that would be a silent regression, since
 * the sandbox cannot receive the window events the old desktop pages used.
 */
function CompanionAliasRoute({
	alias,
	mountContext,
}: {
	alias: string;
	mountContext?: unknown;
}) {
	const companionId = useCompanionAlias(alias);
	if (!companionId) {
		// NOT `null`. A blank tab is the one outcome worse than a hardcoded route:
		// most apps ship not pre-installed, so on a fresh install the palette's "Inbox"
		// row, an OS notification click, the Timeline hotkey and the tray's
		// "Open Timeline" all reach this branch, and blank gives the user nothing to
		// read and nothing to do. Shares one definition with the by-id mount below so
		// the two cannot drift.
		return createElement(CompanionUnavailable);
	}
	return createElement(PluginCompanionPage, { companionId, mountContext });
}

/** Element factory for a route that mounts an app by short path rather than by id. */
const companionAlias = (alias: string, mountContext?: unknown) =>
	createElement(CompanionAliasRoute, { alias, mountContext });

// SKILL_EDITOR_ALIAS + APPROVALS_ALIAS — the two legacy paths no app can derive from
// its own id — moved to `companion-alias.ts`, because the surfaces that decide whether
// to OFFER these paths (the sidebar footer's Inbox tray, an OS notification's click
// target) need the same strings and must resolve them against the same feed. Both
// still name a PATH, never a companion id, so they blank out when their app is
// disabled — and both disappear the moment the owning manifest claims the path itself
// (a `sidebar_buttons[].target`-style route claim; see the manifest follow-up).

/**
 * The chat surface's OWN crash boundary (#97).
 *
 * `CrashBoundary` used to exist only at the app root (`App.tsx`), so a render
 * error anywhere in a chat took the whole renderer down with it and recovery
 * remounted EVERY tab — a crash in one conversation cost the user the sidebar,
 * the tab strip, the titlebar and every other open tab, all of which were
 * perfectly healthy. Wrapping here narrows the blast radius to one tab's body:
 * `RouteOutlet` is mounted *inside* `Layout`, so the shell chrome sits above
 * this boundary and survives untouched.
 *
 * WRAPPED AT THE ROUTE RATHER THAN INSIDE `ChatPage` for three reasons: it
 * catches crashes in ChatPage's own hooks and in `WorkspacePanels`, not just in
 * the transcript below them; `tab.conversationId` — the reset key — is already
 * in scope here and nowhere near the transcript; and the dock-hosted path
 * (`WorkspacePanels` renders the same `RouteOutlet`) gets the boundary for free.
 *
 * KNOWN LIMIT, stated rather than papered over: the composer does NOT survive a
 * transcript crash. `AgentChat` (@ryu/blocks) owns the message list and the
 * composer together and `ChatSlots` exposes no `MessageList` seam, so the
 * narrowest boundary reachable from this side still contains both. Fixing that
 * properly means adding a `MessageList` slot to `ChatSlots` and wrapping only
 * the list — an edit inside `packages/blocks`, whoever owns it.
 *
 * `resetKeys` is the conversation id: opening a different chat in the same tab
 * is a different bug, so it clears the crash and hands the new conversation a
 * fresh retry budget instead of inheriting a spent one. `undefined` (a brand-new
 * chat that has not bound an id yet) is a legitimate key — `resetKeysChanged`
 * compares by `Object.is`, so `undefined → "<id>"` reads as a change exactly
 * once, when `ChatPage` binds the tab to its conversation.
 */
const chatBoundary = (tab: RouteTab, children: ReactNode) =>
	createElement(CrashBoundary, { children, resetKeys: [tab.conversationId] });

let seeded = false;

/** Register all built-in routes exactly once. Idempotent. */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one-time flat registration of the built-in route table, mirroring the old tab router branch-for-branch.
export function seedBuiltinRoutes(): void {
	if (seeded) {
		return;
	}
	seeded = true;

	const exact = (path: string, render: (tab: RouteTab) => unknown) =>
		contributionRegistry.registerRoute({
			kind: "exact",
			path,
			render: render as never,
		});

	// ── Exact routes (matched first via the O(1) map) ─────────────────────────
	// No Home/dashboard route here — see the note above about app-owned shell
	// pages: `@ryu/dashboards` declares its own path and `useAppShellRoutes`
	// mints it from the feed.
	exact("/chat", (tab) =>
		chatBoundary(
			tab,
			createElement(ChatPage, {
				initialAgent: tab.initialAgent,
				initialTeamId: tab.initialTeamId,
				initialGhost: tab.initialGhost,
				initialPluginFlags: tab.initialPluginFlags,
				initialImages: tab.initialImages as AttachedImage[] | undefined,
				initialProject: tab.initialProject,
				initialPrompt: tab.initialPrompt,
				initialQuote: tab.initialQuote,
				initialModel: tab.initialModel,
				initialProactiveOpening: tab.initialProactiveOpening,
				initialSubmit: tab.initialSubmit,
				tabConversationId: tab.conversationId,
				tabWorktreeMode: tab.worktreeMode,
			})
		)
	);
	// Agents/Spaces/Workflows no longer have standalone list pages — they're
	// consolidated into the unified Library; the bare routes redirect there.
	exact("/agents", () =>
		createElement(LibraryPage, { initialSection: "agent" })
	);
	exact("/engines", () =>
		createElement(StorePage, { initialSection: "engines" })
	);
	exact("/store", () => createElement(StorePage));
	// The plugin catalog's two slices: companion-UI apps vs plain plugins.
	exact("/store/apps", () =>
		createElement(StorePage, { initialSection: "apps" })
	);
	exact("/store/plugins", () =>
		createElement(StorePage, { initialSection: "plugins" })
	);
	exact("/store/agents", () =>
		createElement(StorePage, { initialSection: "agents" })
	);
	exact("/store/workflows", () =>
		createElement(StorePage, { initialSection: "workflows" })
	);
	exact("/store/integrations", () =>
		createElement(StorePage, { initialSection: "integrations" })
	);
	exact("/store/connections", () =>
		createElement(StorePage, { initialSection: "connections" })
	);
	exact("/library", () => createElement(LibraryPage));
	// Channels/Identities: bare routes open the Library collection tab; manage
	// CRUD lives on `/channels/:id`, `/channels/new`, `/identities/new`, and
	// `/identities/profile/:profileId` (profiles are named strings, not UUIDs).
	exact("/channels", () =>
		createElement(LibraryPage, { initialSection: "channel" })
	);
	exact("/identities", () =>
		createElement(LibraryPage, { initialSection: "identity" })
	);
	exact("/identities/new", () =>
		createElement(IdentitiesPage, { initialNew: true })
	);
	exact("/models", () =>
		createElement(StorePage, { initialSection: "models" })
	);
	exact("/skills", () =>
		createElement(StorePage, { initialSection: "skills" })
	);
	// The SKILL.md authoring editor (fresh draft). Both `/skills/new` and the
	// `/skills/:id/edit` pattern route below mount whichever app answers to
	// SKILL_EDITOR_ALIAS; new-draft mode carries no mount context (the companion
	// detects the absent `window.ryu.context.skillId`).
	exact("/skills/new", () => companionAlias(SKILL_EDITOR_ALIAS));
	exact("/spaces", () =>
		createElement(LibraryPage, { initialSection: "space" })
	);
	// Tools moved from the Store to the Library — same bare route, new home. Kept as
	// `/tools` (not redirected to `/library/tools`) to match the other bare
	// collection routes (`/spaces`, `/workflows`) and so every existing sidebar
	// entry, palette command and deep link keeps working.
	exact("/tools", () =>
		createElement(LibraryPage, { initialSection: "tools" })
	);
	exact("/workflows", () =>
		createElement(LibraryPage, { initialSection: "workflow" })
	);
	exact("/review", () => createElement(ReviewPage));
	// Marketplace folded into the store: the legacy route opens the store.
	exact("/marketplace", (tab) =>
		createElement(StorePage, {
			initialMarketplaceItem: tab.initialStoreItem,
			initialMarketplaceQuery: tab.initialStoreQuery,
			initialSection:
				tab.initialStoreItem || tab.initialStoreQuery ? "browse" : undefined,
		})
	);
	// The NL workflow builder (fresh draft). The visual canvas is the
	// @ryu/workflows companion (see the /workflows/:id pattern route below); the
	// builder is architecturally shell-only, so it keeps its own shell page.
	exact("/workflows/build", () =>
		createElement(WorkflowsPage, { initialWorkflowId: null })
	);
	// `/approvals` itself needs no entry — the catch-all derives it from the app's
	// companion id — but `/inbox` is the historic alias of the same surface, and no
	// convention can get there from "approvals".
	exact("/inbox", () => companionAlias(APPROVALS_ALIAS));
	exact("/downloads", () => createElement(DownloadsPage));
	// An empty split pane: the picker that replaces itself with whatever the
	// user chooses. Reached only by applying a layout preset (and by a session
	// restore that revives one), never from the sidebar or the palette.
	exact(PANE_CHOOSER_PATH, () => createElement(PaneChooserPage));
	exact("/settings", () => createElement(SettingsPage));
	// Apps + Extensions + Fleet all used to open the Store's "Added" section. That
	// section is gone — it was a tab that was not a category — and its view is now
	// the shell's "Installed only" switch over a real realm. Each legacy route
	// therefore opens the realm it actually meant, already narrowed to what is
	// installed, instead of one undifferentiated list.
	exact("/extensions", () =>
		createElement(StorePage, {
			initialInstalledOnly: true,
			initialSection: "plugins",
		})
	);
	exact("/apps", () =>
		createElement(StorePage, {
			initialInstalledOnly: true,
			initialSection: "apps",
		})
	);
	exact("/fleet", () =>
		createElement(StorePage, {
			initialInstalledOnly: true,
			initialSection: "apps",
		})
	);

	// ── Pattern routes (ordered; each `$`-anchored regex uses [^/]+ per segment,
	// so deeper paths only match their own pattern — relative order among them is
	// preserved to mirror the old chain exactly) ─
	const pattern = (
		test: RegExp | { startsWith: string },
		render: (tab: RouteTab, ctx: { onClose: () => void }) => unknown
	) =>
		contributionRegistry.registerRoute({
			kind: "pattern",
			test,
			render: render as never,
		});

	// /store/mcp and /store/mcp/q/<query> — open the store's MCP catalog,
	// optionally pre-filtered. The integrations.sh MCP hand-off deep-links here so
	// a directory entry lands on a real, installable registry match instead of an
	// external docs page (openTab strips `?`, so the query rides as a path segment).
	pattern(/^\/store\/mcp(?:\/q\/(.+))?$/, (tab) => {
		const match = tab.path.match(/^\/store\/mcp\/q\/(.+)$/);
		let query: string | undefined;
		if (match) {
			try {
				query = decodeURIComponent(match[1]);
			} catch {
				query = match[1];
			}
		}
		return createElement(StorePage, {
			initialSection: "mcp",
			initialQuery: query,
		});
	});
	// /chat/agent/<agentId> — the merged agent view. Same ChatPage, seeded with
	// the agent whose threads it stitches; `mergedAgentId` also pins the composer
	// target so a send can never land on the global default agent.
	pattern(CHAT_MERGED_AGENT, (tab) => {
		const agentId = tab.path.match(CHAT_MERGED_AGENT)?.[1];
		return chatBoundary(
			tab,
			createElement(ChatPage, {
				initialProject: tab.initialProject,
				mergedAgentId: agentId ? decodeURIComponent(agentId) : undefined,
				tabConversationId: tab.conversationId,
				tabWorktreeMode: tab.worktreeMode,
			})
		);
	});
	// /library/<section> — open the Library on a specific collection tab.
	pattern(MEMORY_VIEW, (tab) => {
		const view = tab.path.split("/")[3];
		return createElement(
			view === "reflect" ? MemoryReflectPage : MemoryDreamPage
		);
	});
	pattern(LIBRARY_SECTION, (tab) =>
		createElement(LibraryPage, { initialSection: tab.path.split("/")[2] })
	);
	// /channels/:id ("new" => create form) — channel-bot manage page.
	pattern(CHANNEL_DETAIL, (tab) => {
		const id = tab.path.split("/")[2];
		return createElement(ChannelsPage, {
			initialNew: id === "new",
			initialSelectedId: id === "new" ? null : id,
		});
	});
	// /identities/profile/:profileId — manage page focused on a profile.
	pattern(IDENTITY_PROFILE, (tab) => {
		let profileId = tab.path.split("/")[3] ?? "";
		try {
			profileId = decodeURIComponent(profileId);
		} catch {
			// keep raw segment
		}
		return createElement(IdentitiesPage, { initialProfileId: profileId });
	});
	// /spaces/:spaceId/doc/:docId
	pattern(SPACE_DOC, (tab) => {
		const segments = tab.path.split("/");
		return createElement(SpaceDocEditorPage, {
			documentId: segments[4],
			spaceId: segments[2],
		});
	});
	// /spaces/:spaceId/file/:docId
	pattern(SPACE_FILE, (tab) => {
		const segments = tab.path.split("/");
		return createElement(SpaceFileViewerPage, {
			documentId: segments[4],
			spaceId: segments[2],
		});
	});
	// /spaces/:spaceId/db/:databaseId/row/:rowId
	pattern(SPACE_DB_ROW, (tab) => {
		const segments = tab.path.split("/");
		return createElement(SpaceDatabaseRowPage, {
			databaseId: segments[4],
			rowId: segments[6],
			spaceId: segments[2],
		});
	});
	// /spaces/:spaceId/db/:databaseId
	pattern(SPACE_DB, (tab) => {
		const segments = tab.path.split("/");
		return createElement(SpaceDatabaseEditorPage, {
			databaseId: segments[4],
			spaceId: segments[2],
		});
	});
	// /spaces/:spaceId/wb/:documentId — a legacy whiteboard link mounts the
	// Whiteboard Ryu App's Companion (which owns the document) via SpaceAppDocPage.
	pattern(SPACE_WB, (tab) => {
		const segments = tab.path.split("/");
		return createElement(SpaceAppDocPage, {
			documentId: segments[4],
			pluginId: WHITEBOARD_PLUGIN_ID,
			spaceId: segments[2],
		});
	});
	// /spaces/:spaceId/app/:pluginId/:documentId — a Space doc owned by a Ryu App.
	pattern(SPACE_APP, (tab) => {
		const segments = tab.path.split("/");
		return createElement(SpaceAppDocPage, {
			documentId: segments[5],
			pluginId: segments[4],
			spaceId: segments[2],
		});
	});
	// /spaces/:spaceId — open Spaces with that space pre-selected.
	pattern(SPACE_DETAIL, (tab) =>
		createElement(SpacesPage, { initialSpaceId: tab.path.split("/")[2] })
	);
	// /file/<encoded abs path>
	pattern({ startsWith: "/file/" }, (tab) => {
		const filePath = decodeURIComponent(tab.path.slice("/file/".length));
		return createElement(FileEditorPage, { filePath });
	});
	// /project/diff/<encoded folder>, /project/files/<encoded folder>, and
	// /project/graph/<encoded folder>
	pattern(PROJECT_VIEW, (tab) => {
		const match = tab.path.match(PROJECT_VIEW);
		let folder = match?.[2] ?? "";
		try {
			folder = decodeURIComponent(folder);
		} catch {
			// Keep the encoded segment so a malformed deep link fails as an empty
			// project surface rather than crashing the whole tab shell.
		}
		return createElement(
			match?.[1] === "files"
				? ProjectFilesPage
				: match?.[1] === "graph"
					? ProjectGitGraphPage
					: ProjectDiffPage,
			{ folder }
		);
	});
	// /workflows/build/:id — NL builder for an existing workflow (registered before
	// WORKFLOW_DETAIL for clarity; the two regexes are disjoint by segment count).
	pattern(WORKFLOW_BUILD, (tab) =>
		createElement(WorkflowsPage, { initialWorkflowId: tab.path.split("/")[3] })
	);
	// /workflows/:id ("new" => blank canvas) — the visual canvas belongs to whichever
	// app answers to `/workflows` (its own exact route above is the Library list, so
	// the alias is only ever used as a lookup key here). The deep-linked workflow id
	// is baked into the frame as `window.ryu.context.workflowId`.
	pattern(WORKFLOW_DETAIL, (tab) => {
		const workflowId = tab.path.split("/")[2];
		return companionAlias(
			topLevelAlias(tab.path),
			workflowId === "new" ? undefined : { workflowId }
		);
	});
	pattern(BLUEPRINT_DETAIL, (tab) =>
		companionAlias(topLevelAlias(tab.path), {
			planId: tab.path.split("/")[2],
		})
	);
	pattern(MAIL_DETAIL, (tab) =>
		companionAlias(topLevelAlias(tab.path), {
			inboxId: tab.path.split("/")[2],
		})
	);
	pattern(MONITOR_DETAIL, (tab) =>
		companionAlias(topLevelAlias(tab.path), {
			monitorId: tab.path.split("/")[2],
		})
	);
	pattern(REASONING_DETAIL, (tab) =>
		companionAlias(topLevelAlias(tab.path), {
			policyId: tab.path.split("/")[2],
		})
	);
	pattern(RLM_DETAIL, (tab) =>
		companionAlias(topLevelAlias(tab.path), {
			contextId: tab.path.split("/")[2],
		})
	);
	// /timeline/:ts — "open captured moment": mount the app that answers to `/timeline`
	// with the target timestamp (Unix µs) baked into the frame as
	// `window.ryu.context.focusTs`, so it scrubs straight to that moment (the desktop
	// page received this via the `ryu:timeline-focus` window event, which cannot cross
	// the sandbox). A non-numeric segment yields no focus context (harmless).
	pattern(TIMELINE_FOCUS, (tab) => {
		const focusTs = Number(tab.path.split("/")[2]);
		return companionAlias(
			topLevelAlias(tab.path),
			Number.isFinite(focusTs) ? { focusTs } : undefined
		);
	});
	// /meetings/:id — a specific meeting's detail (transcript + notes): mount the app
	// that answers to `/meetings` with the meeting id baked into the frame as
	// `window.ryu.context.meetingId` via the mount context (the desktop page received
	// it as a route prop, which cannot cross the sandbox).
	pattern(MEETING_DETAIL, (tab) =>
		companionAlias(topLevelAlias(tab.path), {
			meetingId: tab.path.split("/")[2],
		})
	);
	// /social/:id — one scheduled post inside Outpost: mount the app that answers to
	// `/social` with the post id baked into the frame as `window.ryu.context.postId`.
	// Same shape as `/meetings/:id`, and needed for the same reason — the bare
	// `/social` alias resolves through the single-segment catch-all below, but a
	// two-segment path never reaches it, so without this a deep link into a post would
	// render blank rather than opening Outpost on that post.
	pattern(SOCIAL_DETAIL, (tab) =>
		companionAlias(topLevelAlias(tab.path), {
			postId: tab.path.split("/")[2],
		})
	);
	// /skills/:id/edit — the SKILL.md editor for an existing skill, with the skill id
	// baked into the frame as `window.ryu.context.skillId` (the desktop page received
	// it as a route prop, which cannot cross the sandbox). `/skills` belongs to the
	// skills store, not the editor, so this verb route names SKILL_EDITOR_ALIAS rather
	// than deriving the app from its own path — see that constant.
	pattern(SKILL_EDIT, (tab) =>
		companionAlias(SKILL_EDITOR_ALIAS, { skillId: tab.path.split("/")[2] })
	);
	// /agents/:id/edit (carries onClose from the render context)
	pattern(AGENT_EDIT, (tab, ctx) =>
		createElement(AgentEditPage, {
			agentIdProp: tab.path.split("/")[2],
			onClose: ctx.onClose,
		})
	);
	// /artifact/:id — a workspace tab showing an artifact the agent surfaced this
	// session (session-local store, so a restored tab renders "no longer available").
	pattern(ARTIFACT_VIEW, (tab) =>
		createElement(ArtifactViewPage, { artifactId: tab.path.split("/")[2] })
	);
	// The legacy short paths (`/calendar`, `/timeline`, `/inbox`, `/mail`, …), minted
	// from the contributions feed instead of a hardcoded table — registered LAST so
	// every shell route above still wins, and so this only ever sees paths that used
	// to fall through to blank. An app that is disabled contributes no companion, so
	// its short path resolves to nothing exactly as the `/plugin/<id>` seam intends.
	pattern(COMPANION_ALIAS, (tab) => companionAlias(tab.path));
}
