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
// Deliberately NOT registered here (both are wired elsewhere so this stays a pure
// behavior-preserving mirror of the old chain):
//   - `/plugin/<id>` — registered per enabled companion by
//     `usePluginContributionRoutes`, so a disabled plugin's route disappears
//     (resolves null → blank) exactly as #446 item 4 wants.
//   - The scaffold "extras" the old `TabContent` never handled (`/graph`,
//     `/spaces/:id/graph`, `/profile`): the old chain returned `null` (blank) for those
//     paths, so mounting a real page here would be a regression, not a refactor. Left
//     for a separate PR. (`/skills/new` + `/skills/:id/edit` ARE now handled below — the
//     W7 frontend extraction landed the SKILL.md editor as the com.ryu.skill-editor
//     companion; both previously resolved to blank.)
//
// NOTE (PR-1 wiring): `seedBuiltinRoutes()` is called once at `Layout.tsx` module
// load (before first render) so the registry is populated before `RouteOutlet`
// resolves. Kept as JSX-free `createElement` calls so the file is `.ts` (no
// `.tsx`) and carries no JSX-runtime assumptions.

import { createElement } from "react";
import type { AttachedImage } from "@/components/agent-elements/input-bar.tsx";
import { WHITEBOARD_PLUGIN_ID } from "@/src/lib/whiteboard/app.ts";
import AgentEditPage from "@/src/pages/AgentEditPage.tsx";
import ChatPage from "@/src/pages/ChatPage.tsx";
import DownloadsPage from "@/src/pages/DownloadsPage.tsx";
import FileEditorPage from "@/src/pages/FileEditorPage.tsx";
import HomePage from "@/src/pages/HomePage.tsx";
import LibraryPage from "@/src/pages/LibraryPage.tsx";
import PluginCompanionPage from "@/src/pages/PluginCompanionPage.tsx";
import ReviewPage from "@/src/pages/ReviewPage.tsx";
import SettingsPage from "@/src/pages/SettingsPage.tsx";
import SpaceAppDocPage from "@/src/pages/SpaceAppDocPage.tsx";
import SpaceDatabaseEditorPage from "@/src/pages/SpaceDatabaseEditorPage.tsx";
import SpaceDatabaseRowPage from "@/src/pages/SpaceDatabaseRowPage.tsx";
import SpaceDocEditorPage from "@/src/pages/SpaceDocEditorPage.tsx";
import SpacesPage from "@/src/pages/SpacesPage.tsx";
import StorePage from "@/src/pages/StorePage.tsx";
import WorkflowsPage from "@/src/pages/WorkflowsPage.tsx";
import { contributionRegistry, type RouteTab } from "./registry.ts";

// A Notion-style markdown page inside a Space: /spaces/:spaceId/doc/:docId
const SPACE_DOC = /^\/spaces\/[^/]+\/doc\/[^/]+$/;
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
// /workflows/:id (":id" is a workflow id, or "new" for an empty canvas). Single
// segment ([^/]+, not .+) so it does NOT swallow the two-segment builder path
// `/workflows/build/:id`.
const WORKFLOW_DETAIL = /^\/workflows\/[^/]+$/;
// /workflows/build/:id — the NL workflow builder for an existing workflow (the
// `/workflows/build` new-draft entry is an exact route). The builder is shell-
// only (see WorkflowsPage): host.runAgent's PermissionPreset never exposes the
// `workflow_builder__*` tools to the sandboxed canvas companion.
const WORKFLOW_BUILD = /^\/workflows\/build\/[^/]+$/;
// /meetings/:id — a specific meeting's transcript + notes.
const MEETING_DETAIL = /^\/meetings\/[^/]+$/;
// A deep-linked "open captured moment" into the Timeline: /timeline/:ts (ts in
// Unix µs). The command palette's "Search everything" opens this so the scrubber
// jumps straight to that moment; the ts is baked into the companion mount context
// as `window.ryu.context.focusTs` (the sandbox cannot receive the shell's
// `ryu:timeline-focus` window event the desktop page used).
const TIMELINE_FOCUS = /^\/timeline\/[^/]+$/;
// /agents/new/edit or /agents/:id/edit.
const AGENT_EDIT = /^\/agents\/.+\/edit$/;
// /skills/:id/edit — the SKILL.md editor for an existing skill (the `/skills/new`
// fresh-draft entry is an exact route). Single id segment ([^/]+), deeper than the
// `/skills` store exact, so no collision. The skill id is baked into the sandboxed
// com.ryu.skill-editor companion as `window.ryu.context.skillId`.
const SKILL_EDIT = /^\/skills\/[^/]+\/edit$/;

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
	exact("/home", () => createElement(HomePage));
	exact("/chat", (tab) =>
		createElement(ChatPage, {
			initialAgent: tab.initialAgent,
			initialImages: tab.initialImages as AttachedImage[] | undefined,
			initialProject: tab.initialProject,
			initialPrompt: tab.initialPrompt,
			initialSubmit: tab.initialSubmit,
			tabConversationId: tab.conversationId,
		})
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
	exact("/library", () => createElement(LibraryPage));
	exact("/models", () =>
		createElement(StorePage, { initialSection: "models" })
	);
	exact("/skills", () =>
		createElement(StorePage, { initialSection: "skills" })
	);
	// The SKILL.md authoring editor (fresh draft). Both `/skills/new` and the
	// `/skills/:id/edit` pattern route below mount the sandboxed com.ryu.skill-editor
	// companion (ui_format:"html"); new-draft mode carries no mount context (the
	// companion detects the absent `window.ryu.context.skillId`). These two routes
	// previously resolved to blank (the SkillEditorPage was never wired into the tab
	// router); the W7 frontend extraction lands the editor as a companion. The runnable
	// id `skill-editor-companion` is exposed by Core as `app__skill-editor-companion`.
	exact("/skills/new", () =>
		createElement(PluginCompanionPage, {
			companionId: "app__skill-editor-companion",
		})
	);
	exact("/spaces", () =>
		createElement(LibraryPage, { initialSection: "space" })
	);
	exact("/tools", () => createElement(StorePage, { initialSection: "tools" }));
	exact("/workflows", () =>
		createElement(LibraryPage, { initialSection: "workflow" })
	);
	// Calendar is a sandboxed companion app (com.ryu.calendar, ui_format:"html").
	// The legacy /calendar route (kept so ryu://calendar + the palette + the sidebar
	// still resolve) mounts the companion via PluginCompanionPage. The runnable id
	// `calendar-companion` is exposed by Core as `app__calendar-companion`.
	exact("/calendar", () =>
		createElement(PluginCompanionPage, {
			companionId: "app__calendar-companion",
		})
	);
	// Timeline is a sandboxed companion app (com.ryu.timeline, ui_format:"html").
	// The legacy /timeline route (kept so ryu://timeline + the palette + the sidebar
	// + the hotkey still resolve) mounts the companion via PluginCompanionPage. The
	// runnable id `timeline-companion` is exposed by Core as `app__timeline-companion`.
	// The deep-linked focus timestamp (jump-to-moment) rides the /timeline/:ts pattern
	// route below.
	exact("/timeline", () =>
		createElement(PluginCompanionPage, {
			companionId: "app__timeline-companion",
		})
	);
	exact("/review", () => createElement(ReviewPage));
	// Activity is a sandboxed companion app (com.ryu.activity, ui_format:"html").
	// The legacy /activity route (kept so ryu://activity + the palette + the sidebar
	// still resolve) mounts the companion via PluginCompanionPage. The runnable id
	// `activity-companion` is exposed by Core as `app__activity-companion`.
	exact("/activity", () =>
		createElement(PluginCompanionPage, {
			companionId: "app__activity-companion",
		})
	);
	// Marketplace folded into the store: the legacy route opens the store.
	exact("/marketplace", () => createElement(StorePage));
	// Monitors is a sandboxed companion app (com.ryu.monitors, ui_format:"html").
	// The legacy /monitors route (kept so ryu://monitors + the palette still
	// resolve) mounts the companion via PluginCompanionPage. The runnable id
	// `monitors-companion` is exposed by Core as `app__monitors-companion`.
	exact("/monitors", () =>
		createElement(PluginCompanionPage, {
			companionId: "app__monitors-companion",
		})
	);
	// The NL workflow builder (fresh draft). The visual canvas is the
	// com.ryu.workflows companion (see the /workflows/:id pattern route below); the
	// builder is architecturally shell-only, so it keeps its own shell page.
	exact("/workflows/build", () =>
		createElement(WorkflowsPage, { initialWorkflowId: null })
	);
	// Webhooks is a sandboxed companion app (com.ryu.webhooks, ui_format:"html").
	// The legacy /webhooks route (kept so ryu://webhooks + the palette still resolve)
	// mounts the companion via PluginCompanionPage. The runnable id `webhooks-companion`
	// is exposed by Core as `app__webhooks-companion`.
	exact("/webhooks", () =>
		createElement(PluginCompanionPage, {
			companionId: "app__webhooks-companion",
		})
	);
	// Quests is a sandboxed companion app (com.ryu.quests, ui_format:"html").
	// The legacy /quests route (kept so ryu://quests + the palette still resolve)
	// mounts the companion via PluginCompanionPage. The runnable id `quests-companion`
	// is exposed by Core as `app__quests-companion`.
	exact("/quests", () =>
		createElement(PluginCompanionPage, {
			companionId: "app__quests-companion",
		})
	);
	// The Inbox (Approvals) is a sandboxed companion app (com.ryu.approvals,
	// ui_format:"html"). The unified inbox — pending HITL approvals + the per-user
	// notification feed + quest task check-offs + Shadow's proactive suggestions —
	// mounts the companion via PluginCompanionPage. The runnable id `approvals-companion`
	// is exposed by Core as `app__approvals-companion`.
	exact("/inbox", () =>
		createElement(PluginCompanionPage, {
			companionId: "app__approvals-companion",
		})
	);
	// Agent Inboxes is a sandboxed companion app (com.ryu.mail, ui_format:"html").
	// The legacy /mail route (kept so ryu://mail + the palette still resolve) mounts
	// the companion via PluginCompanionPage. The runnable id `mail-companion` is
	// exposed by Core as `app__mail-companion`. Distinct from the HITL approvals inbox.
	exact("/mail", () =>
		createElement(PluginCompanionPage, {
			companionId: "app__mail-companion",
		})
	);
	exact("/downloads", () => createElement(DownloadsPage));
	// The approvals deep link (ryu://approvals) lands on the same sandboxed Inbox
	// companion as /inbox (com.ryu.approvals; runnable `app__approvals-companion`).
	exact("/approvals", () =>
		createElement(PluginCompanionPage, {
			companionId: "app__approvals-companion",
		})
	);
	// Learning is a sandboxed companion app (com.ryu.learning, ui_format:"html").
	// The legacy /learning route (kept so ryu://learning + the palette + the
	// "Make a skill from this chat" affordance still resolve) mounts the companion via
	// PluginCompanionPage. The runnable id `learning-companion` is exposed by Core as
	// `app__learning-companion`.
	exact("/learning", () =>
		createElement(PluginCompanionPage, {
			companionId: "app__learning-companion",
		})
	);
	// Meetings is a sandboxed companion app (com.ryu.meetings, ui_format:"html").
	// The `/meetings` route (record-start empty state; the meeting list lives in the
	// sidebar MeetingsSection) mounts the companion via PluginCompanionPage. The
	// runnable id `meetings-companion` is exposed by Core as `app__meetings-companion`.
	// A specific meeting's detail rides the /meetings/:id pattern route below, with the
	// id baked into the frame as `window.ryu.context.meetingId`.
	exact("/meetings", () =>
		createElement(PluginCompanionPage, {
			companionId: "app__meetings-companion",
		})
	);
	exact("/settings", () => createElement(SettingsPage));
	// Apps + Extensions + Fleet all merged into the store's Installed section.
	exact("/extensions", () =>
		createElement(StorePage, { initialSection: "installed" })
	);
	exact("/apps", () =>
		createElement(StorePage, { initialSection: "installed" })
	);
	exact("/fleet", () =>
		createElement(StorePage, { initialSection: "installed" })
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
	// /library/<section> — open the Library on a specific collection tab.
	pattern(LIBRARY_SECTION, (tab) =>
		createElement(LibraryPage, { initialSection: tab.path.split("/")[2] })
	);
	// /spaces/:spaceId/doc/:docId
	pattern(SPACE_DOC, (tab) => {
		const segments = tab.path.split("/");
		return createElement(SpaceDocEditorPage, {
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
	// /workflows/build/:id — NL builder for an existing workflow (registered before
	// WORKFLOW_DETAIL for clarity; the two regexes are disjoint by segment count).
	pattern(WORKFLOW_BUILD, (tab) =>
		createElement(WorkflowsPage, { initialWorkflowId: tab.path.split("/")[3] })
	);
	// /workflows/:id ("new" => blank canvas) — the visual canvas is the sandboxed
	// com.ryu.workflows companion (runnable `workflows-companion` → exposed as
	// `app__workflows-companion`). The deep-linked workflow id is baked into the
	// frame as `window.ryu.context.workflowId` via the mount context.
	pattern(WORKFLOW_DETAIL, (tab) => {
		const workflowId = tab.path.split("/")[2];
		return createElement(PluginCompanionPage, {
			companionId: "app__workflows-companion",
			mountContext: workflowId === "new" ? undefined : { workflowId },
		});
	});
	// /timeline/:ts — "open captured moment": mount the sandboxed com.ryu.timeline
	// companion with the target timestamp (Unix µs) baked into the frame as
	// `window.ryu.context.focusTs`, so it scrubs straight to that moment (the desktop
	// page received this via the `ryu:timeline-focus` window event, which cannot cross
	// the sandbox). A non-numeric segment yields no focus context (harmless).
	pattern(TIMELINE_FOCUS, (tab) => {
		const focusTs = Number(tab.path.split("/")[2]);
		return createElement(PluginCompanionPage, {
			companionId: "app__timeline-companion",
			mountContext: Number.isFinite(focusTs) ? { focusTs } : undefined,
		});
	});
	// /meetings/:id — a specific meeting's detail (transcript + notes): mount the
	// sandboxed com.ryu.meetings companion with the meeting id baked into the frame as
	// `window.ryu.context.meetingId` via the mount context (the desktop page received
	// it as a route prop, which cannot cross the sandbox).
	pattern(MEETING_DETAIL, (tab) =>
		createElement(PluginCompanionPage, {
			companionId: "app__meetings-companion",
			mountContext: { meetingId: tab.path.split("/")[2] },
		})
	);
	// /skills/:id/edit — the SKILL.md editor for an existing skill: mount the sandboxed
	// com.ryu.skill-editor companion with the skill id baked into the frame as
	// `window.ryu.context.skillId` via the mount context (the desktop page received it as
	// a route prop, which cannot cross the sandbox).
	pattern(SKILL_EDIT, (tab) =>
		createElement(PluginCompanionPage, {
			companionId: "app__skill-editor-companion",
			mountContext: { skillId: tab.path.split("/")[2] },
		})
	);
	// /agents/:id/edit (carries onClose from the render context)
	pattern(AGENT_EDIT, (tab, ctx) =>
		createElement(AgentEditPage, {
			agentIdProp: tab.path.split("/")[2],
			onClose: ctx.onClose,
		})
	);
}
