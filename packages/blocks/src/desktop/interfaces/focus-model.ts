import {
	type InterfaceAgent,
	type InterfaceGroup,
	type InterfaceSnapshot,
	type InterfaceThread,
	THREAD_STATUS_ORDER,
	type ThreadStatus,
	threadStatus,
} from "@ryuhq/protocol/interfaces";
import { compactAge } from "./interface-renderer.ts";

/** One card in the Focus queue: a thread plus everything its card shows. */
export interface FocusItem {
	agents: InterfaceAgent[];
	/** The project or team the thread is filed under, when it has one. */
	group: InterfaceGroup | undefined;
	status: ThreadStatus;
	thread: InterfaceThread;
}

/**
 * Where the reader is in the queue. A thread cursor remembers the id it
 * points at (so the card follows its thread when the queue re-sorts) and the
 * index it was last seen at (so a thread that disappears falls back to its
 * neighbour instead of jumping to the top).
 */
export type FocusCursor =
	| { id: string; index: number; kind: "thread" }
	| { kind: "done" };

const STATUS_RANK = new Map(
	THREAD_STATUS_ORDER.map((status, rank) => [status, rank])
);

function statusRank(status: ThreadStatus): number {
	return STATUS_RANK.get(status) ?? THREAD_STATUS_ORDER.length;
}

function compareItems(a: FocusItem, b: FocusItem): number {
	return (
		statusRank(a.status) - statusRank(b.status) ||
		Number(b.thread.pinned) - Number(a.thread.pinned) ||
		b.thread.updatedAt.localeCompare(a.thread.updatedAt) ||
		a.thread.id.localeCompare(b.thread.id)
	);
}

/**
 * Every thread, most urgent first: failed runs, then replies waiting on you,
 * live runs, messages waiting on an agent, and untouched threads. Pinned
 * threads lead their status; ties go to the most recent activity.
 */
export function buildFocusQueue(snapshot: InterfaceSnapshot): FocusItem[] {
	const agents = new Map(snapshot.agents.map((agent) => [agent.id, agent]));
	const groups = new Map(snapshot.groups.map((group) => [group.id, group]));
	const items: FocusItem[] = [];
	for (const thread of snapshot.threads) {
		const threadAgents: InterfaceAgent[] = [];
		for (const agentId of thread.agentIds) {
			const agent = agents.get(agentId);
			if (agent) {
				threadAgents.push(agent);
			}
		}
		const groupId = thread.projectId ?? thread.teamId;
		items.push({
			agents: threadAgents,
			group: groupId ? groups.get(groupId) : undefined,
			status: threadStatus(thread),
			thread,
		});
	}
	return items.sort(compareItems);
}

/** The first card for a fresh visit, or the open thread when there is one. */
export function initialFocusCursor(
	queue: FocusItem[],
	activeThreadId: string | null
): FocusCursor {
	const activeIndex = activeThreadId
		? queue.findIndex((item) => item.thread.id === activeThreadId)
		: -1;
	const index = Math.max(0, activeIndex);
	const item = queue[index];
	return item
		? { id: item.thread.id, index, kind: "thread" }
		: { kind: "done" };
}

/**
 * The queue index a cursor points at now. `queue.length` means the
 * caught-up card after the last thread.
 */
export function resolveFocusIndex(
	queue: FocusItem[],
	cursor: FocusCursor
): number {
	if (cursor.kind === "done" || queue.length === 0) {
		return queue.length;
	}
	const found = queue.findIndex((item) => item.thread.id === cursor.id);
	if (found !== -1) {
		return found;
	}
	return Math.min(Math.max(cursor.index, 0), queue.length - 1);
}

/** A cursor for an index, clamped to the queue plus its caught-up card. */
export function focusCursorAt(queue: FocusItem[], index: number): FocusCursor {
	const clamped = Math.min(Math.max(index, 0), queue.length);
	const item = queue[clamped];
	return item
		? { id: item.thread.id, index: clamped, kind: "thread" }
		: { kind: "done" };
}

/** "3 of 10" for a card, or a caught-up summary past the end. */
export function focusPosition(index: number, total: number): string {
	if (total === 0) {
		return "Queue empty";
	}
	if (index >= total) {
		return `All ${total} seen`;
	}
	return `${index + 1} of ${total}`;
}

/** The queue split into status runs, in order, for the segmented strip. */
export interface FocusRun {
	items: { index: number; item: FocusItem }[];
	status: ThreadStatus;
}

export function focusRuns(queue: FocusItem[]): FocusRun[] {
	const runs: FocusRun[] = [];
	for (const [index, item] of queue.entries()) {
		const last = runs.at(-1);
		if (last && last.status === item.status) {
			last.items.push({ index, item });
		} else {
			runs.push({ items: [{ index, item }], status: item.status });
		}
	}
	return runs;
}

/** Who the card is with: "Atlas", "Atlas and Echo", "Atlas +2", or no one. */
export function focusAgentLine(agents: InterfaceAgent[]): string {
	const [first, second] = agents;
	if (!first) {
		return "No agent";
	}
	if (agents.length === 1) {
		return first.name;
	}
	if (agents.length === 2 && second) {
		return `${first.name} and ${second.name}`;
	}
	return `${first.name} +${agents.length - 1}`;
}

/** "18m ago", or "just now" for fresh activity. */
export function focusAge(iso: string, now: number = Date.now()): string {
	const age = compactAge(iso, now);
	if (!age) {
		return "";
	}
	return age === "now" ? "just now" : `${age} ago`;
}

/**
 * A short clause that completes the status label ("Needs attention · Last run
 * failed"), so the card never says the same thing twice. Empty when the label
 * already says everything.
 */
export function focusReason(item: FocusItem): string {
	const lead = item.agents[0]?.name;
	switch (item.status) {
		case "attention":
			return item.thread.runState === "interrupted"
				? "Last run was interrupted"
				: "Last run failed";
		case "your-turn":
			return `${lead ?? "The agent"} replied`;
		case "working":
			return `${lead ?? "The agent"} is running`;
		case "waiting":
			return lead ? `Sent to ${lead}, not picked up yet` : "No agent assigned";
		default:
			return "";
	}
}

/** "You wrote" over your own latest message; the meta line already names the agent. */
export function focusAuthor(item: FocusItem): string | null {
	return item.thread.lastMessageRole === "user" ? "You wrote" : null;
}

/** How many threads sit in each status, for the caught-up summary. */
export function focusStatusCounts(
	queue: FocusItem[]
): Partial<Record<ThreadStatus, number>> {
	const counts: Partial<Record<ThreadStatus, number>> = {};
	for (const item of queue) {
		counts[item.status] = (counts[item.status] ?? 0) + 1;
	}
	return counts;
}

/** True for keys typed into a field, which shortcuts must never steal. */
export function isFocusTypingTarget(target: EventTarget | null): boolean {
	if (typeof HTMLElement === "undefined" || !(target instanceof HTMLElement)) {
		return false;
	}
	return (
		target.isContentEditable ||
		target.closest(
			"textarea, input, select, [contenteditable='true'], [role='dialog'], [role='menu'], [role='listbox']"
		) !== null
	);
}

export type FocusKeyAction =
	| "back"
	| "first"
	| "last"
	| "next"
	| "open"
	| "previous";

/** Maps a plain key press to a Focus action, or null when it is not ours. */
export function focusKeyAction(event: {
	altKey: boolean;
	ctrlKey: boolean;
	key: string;
	metaKey: boolean;
	shiftKey: boolean;
}): FocusKeyAction | null {
	if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
		return null;
	}
	switch (event.key) {
		case "j":
		case "J":
		case "ArrowRight":
			return "next";
		case "k":
		case "K":
		case "ArrowLeft":
			return "previous";
		case "Enter":
		case "o":
		case "O":
			return "open";
		case "Home":
			return "first";
		case "End":
			return "last";
		case "Escape":
			return "back";
		default:
			return null;
	}
}
