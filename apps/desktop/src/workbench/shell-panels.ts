import type {
	WorkbenchItem,
	WorkbenchRegion,
	WorkbenchScope,
	WorkbenchState,
} from "@ryu/workbench/model";
import { folderKey } from "@/src/lib/folder-path.ts";
import type { WorkbenchToolOption } from "./workbench-chrome.tsx";

/**
 * Shell tools that read only the project folder, so they can live in any
 * workbench region on any page. Labels match the chat dock's menu.
 */
export const PROJECT_TOOL_PANELS = [
	{ kind: "terminal", label: "Terminal", region: "bottom" },
	{ kind: "files", label: "Files", region: "right" },
	{ kind: "codereview", label: "Changes", region: "right" },
	{ kind: "gitgraph", label: "Git graph", region: "right" },
] as const satisfies ReadonlyArray<{
	kind: string;
	label: string;
	region: WorkbenchRegion;
}>;

/** Chat-bound panels offered for the focused chat. */
export const CONVERSATION_TOOL_PANELS = [
	{ kind: "context", label: "Context" },
	{ kind: "sources", label: "Sources" },
	{ kind: "subagents", label: "Subagents" },
] as const;

/**
 * Panels that render a specific chat's live data (its context, sources,
 * subagents, artifacts …). They are opened by that chat and stay in its docks
 * until conversations publish their data to the workbench.
 */
const CONVERSATION_PANEL_KINDS = new Set([
	"agent-activity",
	"artifact",
	"box-screen",
	"context",
	"cowork",
	"inspector",
	"mission",
	"sources",
	"subagent",
	"subagents",
]);

/** The dock tab kind a workbench item renders, e.g. `terminal` or `plugin:a:b`. */
export function shellPanelKind(item: WorkbenchItem): string | null {
	switch (item.source.kind) {
		case "shell":
			return item.source.panel;
		case "plugin":
			return `plugin:${item.source.pluginId}:${item.source.panelId}`;
		default:
			return null;
	}
}

/** Artifact panels carry their artifact id: `artifact:<id>`. */
export const ARTIFACT_PANEL_PREFIX = "artifact:";

export function isConversationPanelKind(kind: string): boolean {
	return (
		CONVERSATION_PANEL_KINDS.has(kind) || kind.startsWith(ARTIFACT_PANEL_PREFIX)
	);
}

export function isProjectToolKind(kind: string): boolean {
	return PROJECT_TOOL_PANELS.some((panel) => panel.kind === kind);
}

/**
 * Whether a project-scoped item may render for the open folder. A project tool
 * never shows another project's files, terminal, or history.
 */
export function scopeMatchesFolder(
	scope: WorkbenchScope,
	folder: string | null
): boolean {
	if (scope.kind !== "project") {
		return true;
	}
	return folder !== null && folderKey(scope.folder) === folderKey(folder);
}

function toolScope(
	option: WorkbenchToolOption,
	folder: string | null
): WorkbenchScope {
	if (isConversationPanelKind(option.id) && option.conversation) {
		return { kind: "conversation", conversationId: option.conversation.id };
	}
	return isProjectToolKind(option.id) && folder
		? { kind: "project", folder }
		: { kind: "window" };
}

function toolSource(kind: string): WorkbenchItem["source"] {
	if (kind.startsWith("plugin:")) {
		const [, pluginId = "", ...panelParts] = kind.split(":");
		return { kind: "plugin", panelId: panelParts.join(":"), pluginId };
	}
	return { kind: "shell", panel: kind };
}

/** A new workbench item for a tool, scoped to the open project when it needs one. */
export function workbenchToolItem(
	option: WorkbenchToolOption,
	folder: string | null,
	id: string
): WorkbenchItem {
	return {
		closable: true,
		duplicable: false,
		id,
		pinned: false,
		preferredRegion: option.region,
		scope: toolScope(option, folder),
		source: toolSource(option.id),
		// Several chats can each have a Context tab open, so name the chat. An
		// artifact's own title already identifies it.
		title:
			option.conversation && !option.id.startsWith(ARTIFACT_PANEL_PREFIX)
				? `${option.label}: ${option.conversation.title}`
				: option.label,
	};
}

/**
 * The already-open instance of a tool for this scope, if any. Reopening a tool
 * focuses that instance instead of stacking a second copy.
 */
export function findOpenToolItem(
	state: WorkbenchState,
	option: WorkbenchToolOption,
	folder: string | null
): WorkbenchItem | undefined {
	const scope = toolScope(option, folder);
	return state.items.find((item) => {
		if (shellPanelKind(item) !== option.id) {
			return false;
		}
		switch (scope.kind) {
			case "project":
				return (
					item.scope.kind === "project" &&
					scopeMatchesFolder(item.scope, scope.folder)
				);
			case "conversation":
				return (
					item.scope.kind === "conversation" &&
					item.scope.conversationId === scope.conversationId
				);
			default:
				return item.scope.kind === "window";
		}
	});
}

/** Open tabs showing the same panel in the same scope (for numbering copies). */
export function countOpenToolItems(
	state: WorkbenchState,
	option: WorkbenchToolOption,
	folder: string | null
): number {
	const scope = toolScope(option, folder);
	return state.items.filter(
		(item) =>
			shellPanelKind(item) === option.id &&
			item.scope.kind === scope.kind &&
			(scope.kind !== "project" ||
				(item.scope.kind === "project" &&
					scopeMatchesFolder(item.scope, scope.folder)))
	).length;
}
