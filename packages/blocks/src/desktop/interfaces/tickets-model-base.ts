import {
	type InterfaceAgent,
	type InterfaceGroup,
	type InterfaceSnapshot,
	type InterfaceThread,
	type ThreadStatus,
	threadStatus,
} from "@ryuhq/protocol/interfaces";

/**
 * Tickets: the view model behind a Zendesk-style agent workspace. Every
 * thread is a ticket. The lead agent is the requester, you are the assignee,
 * and the ticket's status says whose move it is, in help-desk vocabulary.
 */

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export type TicketStatus = "new" | "open" | "pending" | "solved";
export type TicketPriority = "high" | "low" | "normal" | "urgent";

/** Zendesk's status order: what needs triage first, solved last. */
export const TICKET_STATUS_ORDER: readonly TicketStatus[] = [
	"new",
	"open",
	"pending",
	"solved",
];

export const TICKET_STATUS_LABELS: Record<TicketStatus, string> = {
	new: "New",
	open: "Open",
	pending: "Pending",
	solved: "Solved",
};

/** What each status means here, for tooltips and screen readers. */
export const TICKET_STATUS_HINTS: Record<TicketStatus, string> = {
	new: "Nothing has been said yet",
	open: "The agent answered. Your reply is next",
	pending: "Waiting on the agent",
	solved: "No follow-up for a day after the agent answered",
};

/** Hint for an open ticket whose last run failed or stopped. */
export const TICKET_ATTENTION_HINT =
	"The last run failed or stopped. Retry or reply";

/**
 * The status hint for a ticket: an open ticket whose run failed or stopped
 * never heard back from the agent, so it does not get the "answered" hint.
 */
export function ticketStatusHint(
	ticket: Pick<Ticket, "status" | "threadStatus">
): string {
	return ticket.threadStatus === "attention"
		? TICKET_ATTENTION_HINT
		: TICKET_STATUS_HINTS[ticket.status];
}

export const TICKET_PRIORITY_ORDER: readonly TicketPriority[] = [
	"urgent",
	"high",
	"normal",
	"low",
];

export const TICKET_PRIORITY_LABELS: Record<TicketPriority, string> = {
	high: "High",
	low: "Low",
	normal: "Normal",
	urgent: "Urgent",
};

/** An agent's answer left this long without a follow-up counts as solved. */
export const TICKET_SOLVE_AFTER_MS = DAY;

/** Reply-time targets: how long you have to answer, by priority. */
export const TICKET_SLA_TARGET_MS: Record<TicketPriority, number> = {
	high: 4 * HOUR,
	low: 3 * DAY,
	normal: DAY,
	urgent: HOUR,
};

export type TicketSlaState = "breached" | "due-soon" | "on-track";

export interface TicketSla {
	/** Epoch ms when the reply target is (or was) due. */
	dueAt: number;
	/** Compact chip text: "35m", "3h", "-2d". */
	label: string;
	/** Spoken form: "Reply due in 3 hours", "Reply overdue by 35 minutes". */
	longLabel: string;
	state: TicketSlaState;
	/** The priority target this SLA measures against. */
	targetMs: number;
}

export interface Ticket {
	/** Agents on the thread besides the requester (Zendesk's CCs). */
	ccs: InterfaceAgent[];
	id: string;
	/** Stable, human ticket number derived from the thread id. */
	number: number;
	priority: TicketPriority;
	project: InterfaceGroup | null;
	/** The lead agent, or null for a thread with no agent. */
	requester: InterfaceAgent | null;
	sla: TicketSla | null;
	status: TicketStatus;
	/** Zendesk-style tags: lowercase words joined by underscores. */
	tags: string[];
	team: InterfaceGroup | null;
	thread: InterfaceThread;
	threadStatus: ThreadStatus;
	/** Epoch ms of the latest activity (NaN-safe: 0 when unparseable). */
	updatedAt: number;
}

function parseTime(iso: string): number {
	const value = Date.parse(iso);
	return Number.isNaN(value) ? 0 : value;
}

/** Map a thread's own status onto the help-desk lifecycle. */
export function ticketStatusOf(
	thread: InterfaceThread,
	now: number
): TicketStatus {
	const status = threadStatus(thread);
	if (status === "working" || status === "waiting") {
		return "pending";
	}
	if (status === "quiet") {
		return "new";
	}
	if (
		status === "your-turn" &&
		now - parseTime(thread.updatedAt) >= TICKET_SOLVE_AFTER_MS
	) {
		return "solved";
	}
	return "open";
}

/** Failed runs are urgent, answers waiting on you are high. */
export function ticketPriorityOf(
	status: TicketStatus,
	ownStatus: ThreadStatus
): TicketPriority {
	if (status === "solved") {
		return "low";
	}
	if (ownStatus === "attention") {
		return "urgent";
	}
	if (status === "open") {
		return "high";
	}
	return "normal";
}

/** "35m", "3h", "2d": the largest whole unit, at least one. */
export function compactDuration(ms: number): string {
	const minutes = Math.max(1, Math.floor(Math.abs(ms) / MINUTE));
	if (minutes < 60) {
		return `${minutes}m`;
	}
	const hours = Math.floor(minutes / 60);
	if (hours < 24) {
		return `${hours}h`;
	}
	return `${Math.floor(hours / 24)}d`;
}

function spokenDuration(ms: number): string {
	const minutes = Math.max(1, Math.floor(Math.abs(ms) / MINUTE));
	if (minutes < 60) {
		return `${minutes} minute${minutes === 1 ? "" : "s"}`;
	}
	const hours = Math.floor(minutes / 60);
	if (hours < 24) {
		return `${hours} hour${hours === 1 ? "" : "s"}`;
	}
	const days = Math.floor(hours / 24);
	return `${days} day${days === 1 ? "" : "s"}`;
}

/**
 * The next-reply SLA. It runs only while the ticket waits on you (New or
 * Open); pending and solved tickets have it paused, as in Zendesk.
 */
export function ticketSla(
	status: TicketStatus,
	priority: TicketPriority,
	updatedAt: number,
	now: number
): TicketSla | null {
	if (!(status === "open" || status === "new") || updatedAt === 0) {
		return null;
	}
	const targetMs = TICKET_SLA_TARGET_MS[priority];
	const dueAt = updatedAt + targetMs;
	const remaining = dueAt - now;
	if (remaining < 0) {
		return {
			dueAt,
			label: `-${compactDuration(remaining)}`,
			longLabel: `Reply overdue by ${spokenDuration(remaining)}`,
			state: "breached",
			targetMs,
		};
	}
	return {
		dueAt,
		label: compactDuration(remaining),
		longLabel: `Reply due in ${spokenDuration(remaining)}`,
		state: remaining <= targetMs / 2 ? "due-soon" : "on-track",
		targetMs,
	};
}

/** 32-bit FNV-1a, so a thread id always hashes to the same number. */
function fnv1a(value: string): number {
	let hash = 0x81_1c_9d_c5;
	for (const char of value) {
		hash ^= char.codePointAt(0) ?? 0;
		hash = Math.imul(hash, 0x01_00_01_93) >>> 0;
	}
	return hash >>> 0;
}

const NUMBER_BASE = 1000;
const NUMBER_SPAN = 9000;

/**
 * Four-digit ticket numbers (shown as "#" plus 1042) hashed from thread ids. Collisions
 * resolve by probing upward in id order, so the mapping is deterministic for
 * a given set of threads.
 */
export function ticketNumbers(
	threads: readonly InterfaceThread[]
): Map<string, number> {
	const ids = [...new Set(threads.map((thread) => thread.id))].sort();
	const taken = new Set<number>();
	const numbers = new Map<string, number>();
	for (const id of ids) {
		let offset = fnv1a(id) % NUMBER_SPAN;
		for (let step = 0; step < NUMBER_SPAN; step += 1) {
			const candidate = NUMBER_BASE + ((offset + step) % NUMBER_SPAN);
			if (!taken.has(candidate)) {
				offset = candidate;
				break;
			}
		}
		taken.add(offset);
		numbers.set(id, offset);
	}
	return numbers;
}

/** Zendesk tag form of a name: "Website Redesign" -> "website_redesign". */
export function ticketTag(name: string): string {
	return name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "");
}

function groupById(
	snapshot: InterfaceSnapshot,
	id: string | null
): InterfaceGroup | null {
	return id ? (snapshot.groups.find((group) => group.id === id) ?? null) : null;
}

/** Every thread as a ticket, in snapshot order. */
export function buildTickets(
	snapshot: InterfaceSnapshot,
	now: number
): Ticket[] {
	const numbers = ticketNumbers(snapshot.threads);
	const agents = new Map(snapshot.agents.map((agent) => [agent.id, agent]));
	return snapshot.threads.map((thread) => {
		const ownStatus = threadStatus(thread);
		const status = ticketStatusOf(thread, now);
		const priority = ticketPriorityOf(status, ownStatus);
		const updatedAt = parseTime(thread.updatedAt);
		const people: InterfaceAgent[] = [];
		for (const agentId of thread.agentIds) {
			const agent = agents.get(agentId);
			if (agent) {
				people.push(agent);
			}
		}
		const project = groupById(snapshot, thread.projectId);
		const team = groupById(snapshot, thread.teamId);
		const tags: string[] = [];
		for (const group of [project, team]) {
			const tag = group ? ticketTag(group.name) : "";
			if (tag) {
				tags.push(tag);
			}
		}
		if (thread.pinned) {
			tags.push("pinned");
		}
		return {
			ccs: people.slice(1),
			id: thread.id,
			number: numbers.get(thread.id) ?? NUMBER_BASE,
			priority,
			project,
			requester: people[0] ?? null,
			sla: ticketSla(status, priority, updatedAt, now),
			status,
			tags,
			team,
			thread,
			threadStatus: ownStatus,
			updatedAt,
		};
	});
}
