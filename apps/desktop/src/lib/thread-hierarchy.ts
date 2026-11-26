// apps/desktop/src/lib/thread-hierarchy.ts
//
// How a conversation is drawn in the Projects › Bots/Groups › Sessions sidebar.
//
// Every sidebar row is a MAIN thread: a project's coordinator thread, a bot's
// thread, or a group's coordinator thread. Sessions — the per-activity threads a
// main thread spawns — are not rows: they are reached from their main thread's
// session cards and Sessions panel. Chats from before the hierarchy (no project,
// no spawning thread) keep showing as ordinary rows, so nothing disappears.

import type { Conversation } from "@/types/chat.ts";

export type SidebarThreadKind = "project" | "group" | "chat" | "session";

/** A project's coordinator main thread. */
export function isProjectMainThread(conversation: Conversation): boolean {
	return (
		conversation.hierarchy?.role === "main" &&
		conversation.hierarchy.ownerKind === "project"
	);
}

/** A group's coordinator main thread (a saved Group or an ad-hoc group chat). */
export function isGroupMainThread(
	conversation: Pick<Conversation, "hierarchy">
): boolean {
	return (
		conversation.hierarchy?.role === "main" &&
		conversation.hierarchy.ownerKind === "group"
	);
}

/**
 * A session that belongs under a main thread rather than in the sidebar: it was
 * spawned by another thread, or it sits in a project without being that
 * project's (or a member's) main thread.
 */
export function isHiddenSession(conversation: Conversation): boolean {
	const hierarchy = conversation.hierarchy;
	if (!hierarchy || hierarchy.role === "main") {
		return false;
	}
	return Boolean(hierarchy.spawnedByConversationId || hierarchy.projectId);
}

/** A bot's main thread inside a project: reached from the project, not listed. */
export function isProjectMemberThread(conversation: Conversation): boolean {
	const hierarchy = conversation.hierarchy;
	return (
		hierarchy?.role === "main" &&
		hierarchy.ownerKind !== "project" &&
		Boolean(hierarchy.projectId)
	);
}

/** Which kind of sidebar row a conversation is. */
export function sidebarThreadKind(
	conversation: Conversation
): SidebarThreadKind {
	if (isHiddenSession(conversation) || isProjectMemberThread(conversation)) {
		return "session";
	}
	if (isProjectMainThread(conversation)) {
		return "project";
	}
	if (isGroupMainThread(conversation)) {
		return "group";
	}
	return "chat";
}

/** Rows the sidebar lists: every main thread and every pre-hierarchy chat. */
export function sidebarRows(
	conversations: readonly Conversation[]
): Conversation[] {
	return conversations.filter(
		(conversation) => sidebarThreadKind(conversation) !== "session"
	);
}

/** The sessions a main thread spawned, from an already-loaded list. */
export function sessionsOf(
	mainThreadId: string,
	conversations: readonly Conversation[]
): Conversation[] {
	return conversations.filter(
		(conversation) =>
			conversation.hierarchy?.spawnedByConversationId === mainThreadId
	);
}

/** True while any of a main thread's sessions is running — the row's live dot. */
export function hasRunningSession(
	mainThreadId: string,
	conversations: readonly Conversation[]
): boolean {
	return conversations.some(
		(conversation) =>
			conversation.hierarchy?.spawnedByConversationId === mainThreadId &&
			conversation.runStatus === "running"
	);
}

/** A thread beside a crumb: same spawning thread, or same project membership. */
export interface HierarchySibling {
	conversationId: string;
	label: string;
	/** Core's run status of that thread, when it has one. */
	runStatus?: string;
}

/** One step of the `Project › Bot › Session` breadcrumb. */
export interface HierarchyCrumb {
	/** The conversation to open, or null for the current (last) crumb. */
	conversationId: string | null;
	/** The conversation this crumb stands for, the current one included. */
	id: string;
	kind: "project" | "bot" | "group" | "session";
	label: string;
	/** Core's run status of that thread ("running", "failed", ...), when it has one. */
	runStatus?: string;
	/** Threads beside this one, newest activity first, for moving sideways. */
	siblings: HierarchySibling[];
}

/** How many crumbs a bar shows before the middle of the chain collapses. */
export const CRUMB_LIMIT = 4;
/** The same limit for a bar too narrow to hold a first crumb as well. */
export const COMPACT_CRUMB_LIMIT = 2;
/** A sibling menu lists at most this many threads; Sessions lists them all. */
export const MAX_CRUMB_SIBLINGS = 20;

/** A breadcrumb split into what stays visible and what moves into the menu. */
export interface CollapsedCrumbs<T> {
	/** Crumbs shown before the menu: the first one, or none on a narrow bar. */
	head: T[];
	/** Ancestors listed in the menu, outermost first. */
	hidden: T[];
	/** The parent and the current crumb, always visible. */
	tail: T[];
}

/**
 * Collapse the middle of a long chain. A chain of at most `limit` crumbs stays
 * whole. A longer one keeps the first crumb (when `limit` leaves room for it),
 * the parent and the current crumb, and hides the rest.
 */
export function collapseCrumbs<T>(
	crumbs: readonly T[],
	limit: number = CRUMB_LIMIT
): CollapsedCrumbs<T> {
	if (crumbs.length <= Math.max(limit, 2)) {
		return { head: [...crumbs], hidden: [], tail: [] };
	}
	const headCount = limit >= 3 ? 1 : 0;
	return {
		head: crumbs.slice(0, headCount),
		hidden: crumbs.slice(headCount, -2),
		tail: crumbs.slice(-2),
	};
}

/**
 * The threads beside `conversation`: the other sessions its spawning thread
 * started, or, for a member's main thread inside a project, the other members'
 * main threads. A project's own main thread and a plain chat have none.
 */
export function hierarchySiblings(
	conversation: Conversation,
	conversations: readonly Conversation[],
	agentName: (id: string) => string | undefined = () => undefined
): HierarchySibling[] {
	const parentId = conversation.hierarchy?.spawnedByConversationId;
	const projectId = conversation.hierarchy?.projectId;
	const member = !parentId && isProjectMemberThread(conversation);
	if (!(parentId || member)) {
		return [];
	}
	return conversations
		.filter((other) => {
			if (other.id === conversation.id) {
				return false;
			}
			if (parentId) {
				return other.hierarchy?.spawnedByConversationId === parentId;
			}
			return (
				isProjectMemberThread(other) &&
				!other.hierarchy?.spawnedByConversationId &&
				other.hierarchy?.projectId === projectId
			);
		})
		.sort((a, b) => b.updatedAt - a.updatedAt)
		.slice(0, MAX_CRUMB_SIBLINGS)
		.map((other) => ({
			conversationId: other.id,
			label: crumbFor(other, agentName).label,
			runStatus: other.runStatus,
		}));
}

function crumbFor(
	conversation: Conversation,
	agentName: (id: string) => string | undefined
): Pick<HierarchyCrumb, "kind" | "label"> {
	const kind = sidebarThreadKind(conversation);
	if (kind === "project") {
		return { kind: "project", label: conversation.title };
	}
	if (kind === "group") {
		return { kind: "group", label: conversation.title };
	}
	if (conversation.hierarchy?.role === "main") {
		const agentId = conversation.hierarchy.ownerId ?? conversation.agentId;
		return {
			kind: conversation.hierarchy.ownerKind === "group" ? "group" : "bot",
			label: (agentId && agentName(agentId)) || conversation.title,
		};
	}
	return { kind: "session", label: conversation.title };
}

/**
 * The breadcrumb for a thread: its project's main thread, then each spawning
 * main thread up the chain, then the thread itself. Empty for a plain chat
 * outside the hierarchy (nothing to navigate to). Cycles and missing parents
 * stop the walk rather than loop. Each crumb carries its run status and the
 * threads beside it.
 */
export function hierarchyCrumbs(
	current: Conversation,
	conversations: readonly Conversation[],
	agentName: (id: string) => string | undefined = () => undefined
): HierarchyCrumb[] {
	const byId = new Map(conversations.map((c) => [c.id, c]));
	const chain: Conversation[] = [current];
	const seen = new Set([current.id]);
	let parentId = current.hierarchy?.spawnedByConversationId;
	while (parentId && !seen.has(parentId)) {
		const parent = byId.get(parentId);
		if (!parent) {
			break;
		}
		chain.unshift(parent);
		seen.add(parent.id);
		parentId = parent.hierarchy?.spawnedByConversationId;
	}
	const projectId = current.hierarchy?.projectId;
	if (projectId && !isProjectMainThread(chain[0])) {
		const projectMain = conversations.find(
			(c) =>
				isProjectMainThread(c) &&
				(c.hierarchy?.ownerId === projectId ||
					c.hierarchy?.projectId === projectId)
		);
		if (projectMain && !seen.has(projectMain.id)) {
			chain.unshift(projectMain);
		}
	}
	if (chain.length === 1 && sidebarThreadKind(current) === "chat") {
		return [];
	}
	return chain.map((conversation, index) => ({
		...crumbFor(conversation, agentName),
		conversationId: index === chain.length - 1 ? null : conversation.id,
		id: conversation.id,
		runStatus: conversation.runStatus,
		siblings: hierarchySiblings(conversation, conversations, agentName),
	}));
}
