import { translate as tr } from "@ryu/i18n/lite";
import type { LiteralMessage } from "@ryu/i18n/react";
import {
	type DeskView,
	type DeskViewSection,
	type InterfaceAgent,
	type InterfaceGroup,
	type InterfaceSnapshot,
	type InterfaceThread,
	type ThreadStatus,
	threadStatus,
} from "@ryuhq/protocol/interfaces";
import { fullTimestamp } from "./interface-renderer.ts";
import { newConversationLabel } from "./thread-display-title.ts";

/** List order the user picked in the conversation list header. */
export type DeskSort = "newest" | "oldest";

export const DESK_ALL_VIEW_ID = "all";
export const DESK_NEEDS_YOU_VIEW_ID = "needs-you";

/** Everything one conversation row, header, and details pane need. */
export interface DeskRow {
	/** "Atlas", "Atlas +2", or "No agent". */
	actorLabel: string;
	agents: InterfaceAgent[];
	/** The team or project the thread is filed under, when there is one. */
	group: InterfaceGroup | undefined;
	lead: InterfaceAgent | undefined;
	/** True when the user is the one who should act (unread-style emphasis). */
	needsYou: boolean;
	preview: string;
	status: ThreadStatus;
	thread: InterfaceThread;
	title: string;
}

export function deskThreadTitle(thread: InterfaceThread): string {
	return thread.title.trim() || tr("Untitled conversation");
}

function actorLabel(agents: InterfaceAgent[]): string {
	const [lead] = agents;
	if (!lead) {
		return tr("No agent");
	}
	return agents.length > 1 ? `${lead.name} +${agents.length - 1}` : lead.name;
}

function previewText(thread: InterfaceThread): string {
	const line = thread.lastMessage?.trim();
	if (!line) {
		return tr("No messages yet");
	}
	return thread.lastMessageRole === "user"
		? tr("You: {text}", { text: line })
		: line;
}

export function deskRow(
	snapshot: InterfaceSnapshot,
	thread: InterfaceThread
): DeskRow {
	const agents = thread.agentIds
		.map((id) => snapshot.agents.find((agent) => agent.id === id))
		.filter((agent): agent is InterfaceAgent => agent !== undefined);
	const groupId = thread.teamId ?? thread.projectId;
	const status = threadStatus(thread);
	return {
		actorLabel: actorLabel(agents),
		agents,
		group: groupId
			? snapshot.groups.find((group) => group.id === groupId)
			: undefined,
		lead: agents[0],
		needsYou: status === "attention" || status === "your-turn",
		preview: previewText(thread),
		status,
		thread,
		title: deskThreadTitle(thread),
	};
}

export function findDeskView(
	sections: DeskViewSection[],
	viewId: string
): DeskView | undefined {
	for (const section of sections) {
		const view = section.views.find((candidate) => candidate.id === viewId);
		if (view) {
			return view;
		}
	}
	return undefined;
}

/**
 * The view the desk opens on: "Needs you" when something needs the user (and
 * it holds the thread the host already has open), else "All conversations".
 */
export function deskDefaultViewId(
	sections: DeskViewSection[],
	activeThreadId: string | null
): string {
	const needsYou = findDeskView(sections, DESK_NEEDS_YOU_VIEW_ID);
	if (!needsYou || needsYou.threadIds.length === 0) {
		return DESK_ALL_VIEW_ID;
	}
	if (activeThreadId && !needsYou.threadIds.includes(activeThreadId)) {
		return DESK_ALL_VIEW_ID;
	}
	return DESK_NEEDS_YOU_VIEW_ID;
}

/** Rows for a view, ordered strictly by last activity in the chosen direction. */
export function deskViewRows(
	snapshot: InterfaceSnapshot,
	view: DeskView | undefined,
	sort: DeskSort
): DeskRow[] {
	if (!view) {
		return [];
	}
	const byId = new Map(snapshot.threads.map((thread) => [thread.id, thread]));
	const rows: DeskRow[] = [];
	for (const id of view.threadIds) {
		const thread = byId.get(id);
		if (thread) {
			rows.push(deskRow(snapshot, thread));
		}
	}
	const direction = sort === "newest" ? -1 : 1;
	return rows.sort(
		(a, b) =>
			direction * a.thread.updatedAt.localeCompare(b.thread.updatedAt) ||
			a.thread.id.localeCompare(b.thread.id)
	);
}

/** What "New conversation" files the new thread under for a view. */
export function deskStartInput(view: DeskView | undefined): {
	agentId?: string;
	projectId?: string;
	teamId?: string;
} {
	if (!view?.refId) {
		return {};
	}
	switch (view.kind) {
		case "agent":
			return { agentId: view.refId };
		case "team":
			return { teamId: view.refId };
		case "project":
			return { projectId: view.refId };
		default:
			return {};
	}
}

/** Accessible name for the view's "New conversation" button. */
export function deskStartLabel(
	view: DeskView | undefined,
	tl: LiteralMessage
): string {
	if (view && (view.kind === "agent" || view.kind === "team")) {
		return tl("New conversation with {label}", { label: view.label });
	}
	if (view?.kind === "project") {
		return tl("New conversation in {label}", { label: view.label });
	}
	return newConversationLabel(tl);
}

/** Plain-language reason a thread has its status, for the details pane. */
export function deskStatusExplanation(
	row: DeskRow,
	tl: LiteralMessage
): string {
	switch (row.status) {
		case "attention":
			return row.thread.runState === "interrupted"
				? "The last run was interrupted before it finished. Reply to pick it back up."
				: "The last run failed. Read what happened and reply to retry.";
		case "your-turn":
			return row.lead
				? tl(
						"{name} replied last and nothing is running, so it is waiting on you.",
						{ name: row.lead.name }
					)
				: "The last reply is waiting on you and nothing is running.";
		case "working":
			return row.lead
				? tl("{name} is running on this conversation right now.", {
						name: row.lead.name,
					})
				: "An agent is running on this conversation right now.";
		case "waiting":
			if (!row.lead) {
				return "You wrote last, but no agent is on this conversation, so nothing will run until one is added.";
			}
			return tl("You wrote last. {name} has not started a run yet.", {
				name: row.lead.name,
			});
		default:
			return row.lead
				? "Nothing has been said in this conversation yet."
				: "Nothing has been said yet, and no agent is on this conversation.";
	}
}

/** Other conversations with any of the same agents, most recent first. */
export function deskRelatedThreads(
	snapshot: InterfaceSnapshot,
	row: DeskRow,
	limit = 5
): InterfaceThread[] {
	const agentIds = new Set(row.thread.agentIds);
	if (agentIds.size === 0) {
		return [];
	}
	return snapshot.threads
		.filter(
			(thread) =>
				thread.id !== row.thread.id &&
				thread.agentIds.some((id) => agentIds.has(id))
		)
		.sort(
			(a, b) =>
				b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id)
		)
		.slice(0, limit);
}

/** What an empty view should say, by kind. */
export function deskEmptyCopy(
	view: DeskView | undefined,
	tl: LiteralMessage
): {
	description: string;
	title: string;
} {
	switch (view?.id) {
		case DESK_NEEDS_YOU_VIEW_ID:
			return {
				description:
					"No replies or failed runs are waiting on you. Agents' answers land here.",
				title: "You're all caught up",
			};
		case "working":
			return {
				description: "No agent is running right now.",
				title: "Nothing is running",
			};
		case "waiting":
			return {
				description: "Every message you sent has been picked up.",
				title: "Nothing is waiting",
			};
		case "pinned":
			return {
				description: "Pin a conversation in the chat to keep it here.",
				title: "No pinned conversations",
			};
		default:
			break;
	}
	if (view?.kind === "agent") {
		return {
			description: tl("Start one and it lands in {label}'s inbox.", {
				label: view.label,
			}),
			title: tl("No conversations with {label} yet", { label: view.label }),
		};
	}
	if (view?.kind === "team" || view?.kind === "project") {
		return {
			description: tl("Start one and it is filed under {label}.", {
				label: view.label,
			}),
			title: tl("Nothing in {label} yet", { label: view.label }),
		};
	}
	return {
		description: "Every conversation with your agents shows up here.",
		title: "No conversations yet",
	};
}

/** "Oct 12, 2026, 1:04 PM" in the UI locale, or "" for a bad timestamp. */
export function deskFullTimestamp(iso: string): string {
	return fullTimestamp(iso);
}

/** "3 conversations · 1 needs you": a list's count line, as one ICU message. */
export function conversationCount(
	count: number,
	tl: LiteralMessage = tr
): string {
	return tl("{count, plural, one {# conversation} other {# conversations}}", {
		count,
	});
}

/** "1 needs you", "2 need you". */
export function needsYouCount(count: number, tl: LiteralMessage = tr): string {
	return tl("{count, plural, one {# needs you} other {# need you}}", { count });
}
