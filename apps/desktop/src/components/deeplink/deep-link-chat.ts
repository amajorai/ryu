import type { DeepLinkIntent } from "@ryuhq/protocol/deep-link";
import { sameFolder } from "@/src/lib/folder-path.ts";

// A `ryu://chat/new` link may name a project folder. Setting that folder makes
// Core list it at once and the composer poll git in it, so the folder is an
// action, not navigation (Security sweep 19 Nov 2026, finding DT-1). The link's
// folder is used straight away only when it is already one of the user's
// projects or recent folders; any other folder waits for a confirm dialog that
// shows the full path.

export type ChatIntent = Extract<DeepLinkIntent, { kind: "chat" }>;

/** The workspace store fields that say which folders the user already has. */
export interface KnownFolders {
	projects: readonly { folders: readonly string[] }[];
	recentFolders: readonly string[];
	removedProjects: readonly string[];
}

/** Options for `openTab("/chat", ...)` that open a new chat for a link. */
export interface NewChatTabOptions {
	forceNew: true;
	initialAgent?: string;
	initialProject?: string;
	initialPrompt?: string;
	title: string;
}

export interface ChatLinkPlan {
	/** A folder the user must confirm before it is used, or null. */
	confirmProject: string | null;
	/** Tab options to open now; they never carry an unconfirmed folder. */
	options: NewChatTabOptions;
}

/** True when `path` is a project or recent folder the user has not removed. */
export function isKnownFolder(path: string, known: KnownFolders): boolean {
	if (known.removedProjects.some((removed) => sameFolder(removed, path))) {
		return false;
	}
	return (
		known.recentFolders.some((folder) => sameFolder(folder, path)) ||
		known.projects.some((project) =>
			project.folders.some((folder) => sameFolder(folder, path))
		)
	);
}

/** Tab options for a new chat from a link, with `project` as its folder. */
export function newChatTabOptions(
	intent: ChatIntent,
	project: string | null
): NewChatTabOptions {
	return {
		forceNew: true,
		title: "New chat",
		initialPrompt: intent.prompt ?? undefined,
		initialAgent: intent.agent ?? undefined,
		initialProject: project ?? undefined,
	};
}

/**
 * How to open a `ryu://chat/new` link: at once when it names no folder or a
 * known one, otherwise only after the user confirms `confirmProject`.
 */
export function planNewChatLink(
	intent: ChatIntent,
	known: KnownFolders
): ChatLinkPlan {
	const project = intent.project;
	if (project && !isKnownFolder(project, known)) {
		return {
			confirmProject: project,
			options: newChatTabOptions(intent, null),
		};
	}
	return {
		confirmProject: null,
		options: newChatTabOptions(intent, project),
	};
}

/**
 * The folder question that stays open when another link asks for one: the first.
 * A later link must never replace it, because the dialog would then show and
 * confirm a path the user has not read, and a link timed to the click on
 * "Use this folder" would swap the folder under the cursor. The later link is
 * dropped, as a second connect callback is.
 */
export function keepFirstPending<T>(current: T | null, next: T): T {
	return current ?? next;
}
