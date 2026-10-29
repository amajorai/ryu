import {
	type InboxSection,
	type InterfaceAgent,
	type InterfaceSnapshot,
	type InterfaceThread,
	projectInbox,
	THREAD_STATUS_LABELS,
	type ThreadStatus,
	threadStatus,
} from "@ryuhq/protocol/interfaces";
import { agentById } from "./interface-renderer.ts";

/** One inbox row, resolved from the snapshot. */
export interface InboxItem {
	/** Who the row is "from": the team, the agents, or nobody yet. */
	actorLabel: string;
	/** Every agent on the thread that the snapshot knows, lead first. */
	agents: InterfaceAgent[];
	/** Whether `groupName` is a team (else a project). */
	groupKind: "project" | "team" | null;
	/** Team or project the thread is filed under, when any. */
	groupName: string | null;
	leadAgent: InterfaceAgent | undefined;
	preview: string;
	status: ThreadStatus;
	thread: InterfaceThread;
	/** No agent is on the thread, so nobody will reply until one is added. */
	unassigned: boolean;
}

export interface InboxSectionView extends InboxSection {
	items: InboxItem[];
}

export interface InboxModel {
	/** Threads where the user should act (needs attention + your turn). */
	needsYou: InboxItem[];
	/** Every row id in display order, for roving focus and prev/next. */
	order: string[];
	sections: InboxSectionView[];
}

const NEEDS_YOU: ReadonlySet<ThreadStatus> = new Set([
	"attention",
	"your-turn",
]);

function actorLabel(
	snapshot: InterfaceSnapshot,
	thread: InterfaceThread,
	groupName: string | null
): string {
	if (thread.teamId && groupName) {
		return groupName;
	}
	const names = thread.agentIds
		.map((id) => agentById(snapshot, id)?.name)
		.filter((name): name is string => Boolean(name));
	if (names.length === 0) {
		return thread.agentIds.length === 0 ? "Unassigned" : "Unknown agent";
	}
	const [first, ...rest] = names;
	return rest.length > 0 ? `${first} +${rest.length}` : (first ?? "Agent");
}

function previewLine(thread: InterfaceThread): string {
	const text = thread.lastMessage?.trim();
	if (!text) {
		return "No messages yet";
	}
	return thread.lastMessageRole === "user" ? `You: ${text}` : text;
}

export function inboxItem(
	snapshot: InterfaceSnapshot,
	thread: InterfaceThread
): InboxItem {
	const groupId = thread.teamId ?? thread.projectId;
	const group = snapshot.groups.find((candidate) => candidate.id === groupId);
	const groupName = group?.name ?? null;
	return {
		actorLabel: actorLabel(snapshot, thread, groupName),
		agents: thread.agentIds.flatMap((id) => {
			const agent = agentById(snapshot, id);
			return agent ? [agent] : [];
		}),
		groupKind: group?.kind ?? null,
		groupName,
		leadAgent: agentById(snapshot, thread.agentIds[0]),
		preview: previewLine(thread),
		status: threadStatus(thread),
		thread,
		unassigned: thread.agentIds.length === 0 && !thread.teamId,
	};
}

/**
 * Statuses where an unassigned thread is regrouped under "Not started":
 * `projectInbox` files a thread the user wrote in as "Waiting on agent", but
 * with no agent on it nobody will ever reply.
 */
const REGROUP_UNASSIGNED: ReadonlySet<ThreadStatus> = new Set([
	"quiet",
	"waiting",
]);

/** Sections from `projectInbox`, with each thread resolved for display. */
export function buildInboxModel(snapshot: InterfaceSnapshot): InboxModel {
	const byId = new Map(snapshot.threads.map((thread) => [thread.id, thread]));
	const sections: InboxSectionView[] = [];
	const notStarted: InboxItem[] = [];
	for (const section of projectInbox(snapshot)) {
		const items: InboxItem[] = [];
		for (const id of section.threadIds) {
			const thread = byId.get(id);
			if (!thread) {
				continue;
			}
			const item = inboxItem(snapshot, thread);
			if (section.id === "quiet") {
				notStarted.push(item);
			} else if (item.unassigned && REGROUP_UNASSIGNED.has(section.id)) {
				notStarted.push(item);
			} else {
				items.push(item);
			}
		}
		if (items.length > 0) {
			sections.push({ ...section, items });
		}
	}
	if (notStarted.length > 0) {
		sections.push({
			id: "quiet",
			items: notStarted,
			label: THREAD_STATUS_LABELS.quiet,
			threadIds: notStarted.map((item) => item.thread.id),
		});
	}
	const order: string[] = [];
	const needsYou: InboxItem[] = [];
	for (const section of sections) {
		for (const item of section.items) {
			order.push(item.thread.id);
			if (NEEDS_YOU.has(item.status)) {
				needsYou.push(item);
			}
		}
	}
	return { needsYou, order, sections };
}

/** The ids either side of `threadId` in display order, for prev/next. */
export function inboxNeighbours(
	order: readonly string[],
	threadId: string | null | undefined
): { next: string | undefined; previous: string | undefined } {
	const index = threadId ? order.indexOf(threadId) : -1;
	if (index === -1) {
		return { next: undefined, previous: undefined };
	}
	return {
		next: order[index + 1],
		previous: index > 0 ? order[index - 1] : undefined,
	};
}
