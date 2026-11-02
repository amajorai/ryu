// Conversations as protocol threads: filtering, run overlay, helper rollup
// and project groups.

import type {
	InterfaceGroup,
	InterfaceHelpers,
	InterfaceThread,
	ThreadRunState,
} from "@ryuhq/protocol/interfaces";
import { conversationParticipantIds } from "@/src/lib/agent-conversation-groups.ts";
import {
	isHiddenSession,
	isProjectMainThread,
} from "@/src/lib/thread-hierarchy.ts";
import type { Conversation } from "@/types/chat.ts";
import {
	MAX_INTERFACE_THREADS,
	type RunFrameStatus,
	type SnapshotProjectInput,
} from "./snapshot-types.ts";
import { basename, toIso } from "./snapshot-util.ts";

/**
 * Users talk to main threads and plain chats; archived threads and the
 * sessions the sidebar hides behind a main thread stay out. A standalone
 * conversation carries Core's default `session` role without a parent or a
 * project, and stays in, exactly as in the sidebar.
 */
export function isInterfaceThread(conversation: Conversation): boolean {
	return !(conversation.archived || isHiddenSession(conversation));
}

/** How many threads the snapshot leaves out past {@link MAX_INTERFACE_THREADS}. */
export function omittedInterfaceThreads(
	conversations: readonly Conversation[]
): number {
	let count = 0;
	for (const conversation of conversations) {
		if (isInterfaceThread(conversation)) {
			count += 1;
		}
	}
	return Math.max(0, count - MAX_INTERFACE_THREADS);
}

/**
 * Ids of conversations with a running session somewhere beneath them. Sessions
 * are hidden behind their main thread, so (as in the sidebar) the main thread
 * carries their live state. Walks the whole spawn chain; cycles stop the walk.
 */
export function runningAncestorIds(
	conversations: readonly Conversation[],
	statusOf: (conversation: Conversation) => string | undefined
): Set<string> {
	const parentOf = new Map<string, string>();
	for (const conversation of conversations) {
		const parent = conversation.hierarchy?.spawnedByConversationId;
		if (parent) {
			parentOf.set(conversation.id, parent);
		}
	}
	const ids = new Set<string>();
	for (const conversation of conversations) {
		if (statusOf(conversation) !== "running") {
			continue;
		}
		const seen = new Set([conversation.id]);
		let parent = parentOf.get(conversation.id);
		while (parent && !seen.has(parent)) {
			ids.add(parent);
			seen.add(parent);
			parent = parentOf.get(parent);
		}
	}
	return ids;
}

function activityMs(conversation: Conversation): number {
	const { lastMessageAt, updatedAt } = conversation;
	if (typeof lastMessageAt === "number" && Number.isFinite(lastMessageAt)) {
		return lastMessageAt;
	}
	return Number.isFinite(updatedAt) ? updatedAt : 0;
}

function messageRole(role: string | undefined): "assistant" | "user" | null {
	return role === "assistant" || role === "user" ? role : null;
}

const RUN_STATES: readonly ThreadRunState[] = [
	"completed",
	"failed",
	"interrupted",
	"running",
];

/** Core's run status, narrowed to the protocol's known run states. */
function runState(value: string | undefined): ThreadRunState | null {
	return RUN_STATES.find((state) => state === value) ?? null;
}

/**
 * The run status to show: a run-stream row overrides the list's value when it
 * was written at or after the list row. Both are epoch ms from the same
 * column, so they compare directly.
 */
export function overlayRunStatus(
	conversation: Conversation,
	runs: ReadonlyMap<string, RunFrameStatus> | undefined
): string | undefined {
	const run = runs?.get(conversation.id);
	if (run && run.updated_at >= conversation.updatedAt) {
		return run.run_status ?? conversation.runStatus;
	}
	return conversation.runStatus;
}

export function toThread(
	conversation: Conversation,
	status: string | undefined
): InterfaceThread {
	const hierarchy = conversation.hierarchy;
	const ownerProjectId =
		hierarchy?.ownerKind === "project" ? hierarchy.ownerId : undefined;
	// A run paused for the user's answer cannot continue without them. The
	// protocol has no run state for it, so it reads as the agent having the
	// last word: `threadStatus()` then classifies it as the user's turn
	// instead of falling back to whoever happened to write last.
	const awaitingInput = status === "awaiting_input";
	const thread: InterfaceThread = {
		// The primary agent first, then the additional participants.
		agentIds: conversationParticipantIds(conversation),
		id: conversation.id,
		lastMessage: conversation.lastMessage?.trim() || null,
		lastMessageRole: awaitingInput
			? "assistant"
			: messageRole(conversation.lastMessageRole),
		messageCount: conversation.messageCount ?? conversation.messages.length,
		pinned: conversation.pinned === true,
		projectId: hierarchy?.projectId || ownerProjectId || null,
		running: status === "running",
		runState: runState(status),
		teamId:
			hierarchy?.ownerKind === "group" && hierarchy.ownerId
				? hierarchy.ownerId
				: null,
		title: conversation.title.trim() || "New chat",
		updatedAt: toIso(activityMs(conversation)),
	};
	if (
		typeof conversation.lastMessageAt === "number" &&
		Number.isFinite(conversation.lastMessageAt)
	) {
		thread.lastMessageAt = toIso(conversation.lastMessageAt);
	}
	const folder = conversation.folderPath
		? basename(conversation.folderPath)
		: "";
	// "<folder>@<branch>" only; a folder without a branch gives no workspace.
	if (folder && conversation.branch) {
		thread.workspace = `${folder}@${conversation.branch}`;
	}
	return thread;
}

/** Spawned sessions per parent main thread, with the run-overlaid status. */
export function helperRollup(
	conversations: readonly Conversation[],
	statusOf: (conversation: Conversation) => string | undefined
): Map<string, InterfaceHelpers> {
	const children = new Map<string, Conversation[]>();
	for (const conversation of conversations) {
		const parent = conversation.hierarchy?.spawnedByConversationId;
		if (conversation.hierarchy?.role === "session" && parent) {
			const list = children.get(parent) ?? [];
			list.push(conversation);
			children.set(parent, list);
		}
	}
	const rollup = new Map<string, InterfaceHelpers>();
	for (const [parent, sessions] of children) {
		const helpers: InterfaceHelpers = {
			done: 0,
			failed: 0,
			running: 0,
			titles: [],
		};
		const running: Conversation[] = [];
		for (const session of sessions) {
			const status = statusOf(session);
			if (status === "running") {
				helpers.running += 1;
				running.push(session);
			} else if (status === "failed") {
				helpers.failed += 1;
			} else if (status === "completed") {
				helpers.done += 1;
			}
		}
		helpers.titles = running
			.sort((a, b) => activityMs(b) - activityMs(a) || a.id.localeCompare(b.id))
			.slice(0, 3)
			.map((session) => session.title.trim() || "Helper");
		rollup.set(parent, helpers);
	}
	return rollup;
}

export function projectGroups(
	projects: readonly SnapshotProjectInput[],
	threads: readonly InterfaceThread[]
): InterfaceGroup[] {
	const members = new Map<string, Set<string>>();
	for (const thread of threads) {
		if (!thread.projectId) {
			continue;
		}
		const set = members.get(thread.projectId) ?? new Set<string>();
		for (const agentId of thread.agentIds) {
			set.add(agentId);
		}
		members.set(thread.projectId, set);
	}
	return projects.map((project) => ({
		id: project.id,
		kind: "project",
		memberAgentIds: [...(members.get(project.id) ?? [])],
		name: project.name,
	}));
}

/**
 * The projects an interface groups threads under. Threads carry the node's
 * project ids, so a desktop folder project is published under the node
 * project it was migrated to (`folderProjectMap`, per node), and node projects
 * known only from their coordinator main thread are added after the folder
 * projects. Each id appears once.
 */
export function resolveSnapshotProjects({
	conversations,
	folderProjectMap = {},
	workspaceProjects,
}: {
	conversations: readonly Conversation[];
	folderProjectMap?: Readonly<Record<string, string>>;
	workspaceProjects: readonly SnapshotProjectInput[];
}): SnapshotProjectInput[] {
	const projects = new Map<string, SnapshotProjectInput>();
	for (const project of workspaceProjects) {
		const id = folderProjectMap[project.id] || project.id;
		if (!projects.has(id)) {
			projects.set(id, { id, name: project.name });
		}
	}
	for (const conversation of conversations) {
		const id = conversation.hierarchy?.ownerId;
		if (
			id &&
			!conversation.archived &&
			isProjectMainThread(conversation) &&
			!projects.has(id)
		) {
			projects.set(id, { id, name: conversation.title.trim() || "Project" });
		}
	}
	return [...projects.values()];
}
