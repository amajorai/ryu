// The shell-page slice of the built-in pattern routes (see `../builtins.ts`). Order
// matters only relative to other patterns, and is preserved from the old chain.

import { createElement } from "react";
import { WHITEBOARD_PLUGIN_ID } from "@/src/lib/whiteboard/app.ts";
import ChatPage from "@/src/pages/ChatPage.tsx";
import { SKILL_EDITOR_ALIAS, topLevelAlias } from "../companion-alias.ts";
import { chatBoundary, companionAlias } from "./companion-routes.ts";
import {
	AgentEditPage,
	ArtifactViewPage,
	ChannelsPage,
	FileEditorPage,
	IdentitiesPage,
	KnowledgeGraphPage,
	ProjectDiffPage,
	ProjectFilesPage,
	ProjectGitGraphPage,
	SpaceAppDocPage,
	SpaceDatabaseEditorPage,
	SpaceDatabaseRowPage,
	SpaceDocEditorPage,
	SpaceFileViewerPage,
	SpacesPage,
	WorkflowsPage,
} from "./lazy-pages.ts";
import type { PatternRouteRegistrar } from "./registrars.ts";
import {
	AGENT_EDIT,
	ARTIFACT_VIEW,
	BLUEPRINT_DETAIL,
	CHANNEL_DETAIL,
	CHAT_MERGED_AGENT,
	IDENTITY_PROFILE,
	MAIL_DETAIL,
	MEETING_DETAIL,
	MONITOR_DETAIL,
	PROJECT_VIEW,
	REASONING_DETAIL,
	RLM_DETAIL,
	SKILL_EDIT,
	SOCIAL_DETAIL,
	SPACE_APP,
	SPACE_DB,
	SPACE_DB_ROW,
	SPACE_DETAIL,
	SPACE_DOC,
	SPACE_FILE,
	SPACE_GRAPH,
	SPACE_WB,
	TIMELINE_FOCUS,
	WORKFLOW_BUILD,
	WORKFLOW_DETAIL,
} from "./route-patterns.ts";

/** `/chat/agent/<agentId>`: registered between the Store and Library patterns. */
export function registerChatPatternRoutes(
	pattern: PatternRouteRegistrar
): void {
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
}

/** Every remaining shell pattern route, in the old chain's order. */
// one flat registration list, mirroring the old tab router branch-for-branch.
export function registerShellPatternRoutes(
	pattern: PatternRouteRegistrar
): void {
	// /channels/:id ("new" => create form) — channel-bot manage page.
	pattern(
		CHANNEL_DETAIL,
		(tab) => {
			const id = tab.path.split("/")[2];
			return createElement(ChannelsPage, {
				initialNew: id === "new",
				initialSelectedId: id === "new" ? null : id,
			});
		},
		ChannelsPage.preload
	);
	// /identities/profile/:profileId — manage page focused on a profile.
	pattern(
		IDENTITY_PROFILE,
		(tab) => {
			let profileId = tab.path.split("/")[3] ?? "";
			try {
				profileId = decodeURIComponent(profileId);
			} catch {
				// keep raw segment
			}
			return createElement(IdentitiesPage, { initialProfileId: profileId });
		},
		IdentitiesPage.preload
	);
	// /spaces/:spaceId/doc/:docId
	pattern(
		SPACE_DOC,
		(tab) => {
			const segments = tab.path.split("/");
			return createElement(SpaceDocEditorPage, {
				documentId: segments[4],
				spaceId: segments[2],
			});
		},
		SpaceDocEditorPage.preload
	);
	// /spaces/:spaceId/file/:docId
	pattern(
		SPACE_FILE,
		(tab) => {
			const segments = tab.path.split("/");
			return createElement(SpaceFileViewerPage, {
				documentId: segments[4],
				spaceId: segments[2],
			});
		},
		SpaceFileViewerPage.preload
	);
	// /spaces/:spaceId/db/:databaseId/row/:rowId
	pattern(
		SPACE_DB_ROW,
		(tab) => {
			const segments = tab.path.split("/");
			return createElement(SpaceDatabaseRowPage, {
				databaseId: segments[4],
				rowId: segments[6],
				spaceId: segments[2],
			});
		},
		SpaceDatabaseRowPage.preload
	);
	// /spaces/:spaceId/db/:databaseId
	pattern(
		SPACE_GRAPH,
		(tab) =>
			createElement(KnowledgeGraphPage, { spaceId: tab.path.split("/")[2] }),
		KnowledgeGraphPage.preload
	);
	pattern(
		SPACE_DB,
		(tab) => {
			const segments = tab.path.split("/");
			return createElement(SpaceDatabaseEditorPage, {
				databaseId: segments[4],
				spaceId: segments[2],
			});
		},
		SpaceDatabaseEditorPage.preload
	);
	// /spaces/:spaceId/wb/:documentId — a legacy whiteboard link mounts the
	// Whiteboard Ryu App's Companion (which owns the document) via SpaceAppDocPage.
	pattern(
		SPACE_WB,
		(tab) => {
			const segments = tab.path.split("/");
			return createElement(SpaceAppDocPage, {
				documentId: segments[4],
				pluginId: WHITEBOARD_PLUGIN_ID,
				spaceId: segments[2],
			});
		},
		SpaceAppDocPage.preload
	);
	// /spaces/:spaceId/app/:pluginId/:documentId — a Space doc owned by a Ryu App.
	pattern(
		SPACE_APP,
		(tab) => {
			const segments = tab.path.split("/");
			return createElement(SpaceAppDocPage, {
				documentId: segments[5],
				pluginId: segments[4],
				spaceId: segments[2],
			});
		},
		SpaceAppDocPage.preload
	);
	// /spaces/:spaceId — open Spaces with that space pre-selected.
	pattern(
		SPACE_DETAIL,
		(tab) =>
			createElement(SpacesPage, { initialSpaceId: tab.path.split("/")[2] }),
		SpacesPage.preload
	);
	// /file/<encoded abs path>
	pattern(
		{ startsWith: "/file/" },
		(tab) => {
			const filePath = decodeURIComponent(tab.path.slice("/file/".length));
			return createElement(FileEditorPage, { filePath });
		},
		FileEditorPage.preload
	);
	// /project/diff/<encoded folder>, /project/files/<encoded folder>, and
	// /project/graph/<encoded folder>
	pattern(
		PROJECT_VIEW,
		(tab) => {
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
		},
		() =>
			Promise.all([
				ProjectDiffPage.preload(),
				ProjectFilesPage.preload(),
				ProjectGitGraphPage.preload(),
			]).then<void>(() => undefined)
	);
	// /workflows/build/:id — NL builder for an existing workflow (registered before
	// WORKFLOW_DETAIL for clarity; the two regexes are disjoint by segment count).
	pattern(
		WORKFLOW_BUILD,
		(tab) =>
			createElement(WorkflowsPage, {
				initialWorkflowId: tab.path.split("/")[3],
			}),
		WorkflowsPage.preload
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
	pattern(
		AGENT_EDIT,
		(tab, ctx) =>
			createElement(AgentEditPage, {
				agentIdProp: tab.path.split("/")[2],
				// A host may open the editor on one setting (the Store opens an
				// added Agent Template at Account access).
				initialSettingId:
					typeof tab.mountContext?.setting === "string"
						? tab.mountContext.setting
						: undefined,
				onClose: ctx.onClose,
			}),
		AgentEditPage.preload
	);
	// /artifact/:id — a workspace tab showing an artifact the agent surfaced this
	// session (session-local store, so a restored tab renders "no longer available").
	pattern(
		ARTIFACT_VIEW,
		(tab) =>
			createElement(ArtifactViewPage, { artifactId: tab.path.split("/")[2] }),
		ArtifactViewPage.preload
	);
}
