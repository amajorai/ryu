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

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

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

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

export type TicketViewId =
	| "all"
	| "open"
	| "pending"
	| "recent"
	| "solved"
	| "unsolved"
	| "urgent";

export interface TicketView {
	/** Shown when the view holds nothing. */
	empty: { description: string; title: string };
	id: TicketViewId;
	label: string;
	matches: (ticket: Ticket, now: number) => boolean;
}

/** "Recently updated" looks back this far. */
export const TICKET_RECENT_MS = DAY;

/** The views panel, in Zendesk's order and words. */
export const TICKET_VIEWS: readonly TicketView[] = [
	{
		empty: {
			description: "Every ticket assigned to you has been solved.",
			title: "No unsolved tickets",
		},
		id: "unsolved",
		label: "Your unsolved tickets",
		matches: (ticket) => ticket.status !== "solved",
	},
	{
		empty: {
			description: "Tickets whose last run failed or stopped show up here.",
			title: "No urgent tickets",
		},
		id: "urgent",
		label: "Urgent tickets",
		matches: (ticket) => ticket.priority === "urgent",
	},
	{
		empty: {
			description: "No agent is waiting on a reply from you.",
			title: "No open tickets",
		},
		id: "open",
		label: "Open tickets",
		matches: (ticket) => ticket.status === "open" || ticket.status === "new",
	},
	{
		empty: {
			description: "Tickets waiting on an agent's answer show up here.",
			title: "No pending tickets",
		},
		id: "pending",
		label: "Pending tickets",
		matches: (ticket) => ticket.status === "pending",
	},
	{
		empty: {
			description: "Nothing has changed in the last 24 hours.",
			title: "No recent updates",
		},
		id: "recent",
		label: "Recently updated tickets",
		matches: (ticket, now) => now - ticket.updatedAt < TICKET_RECENT_MS,
	},
	{
		empty: {
			description:
				"A ticket is solved a day after the agent's answer, with no follow-up.",
			title: "No solved tickets",
		},
		id: "solved",
		label: "Recently solved tickets",
		matches: (ticket) => ticket.status === "solved",
	},
	{
		empty: {
			description: "Start a conversation with an agent to open a ticket.",
			title: "No tickets yet",
		},
		id: "all",
		label: "All tickets",
		matches: () => true,
	},
];

export const DEFAULT_TICKET_VIEW: TicketViewId = "unsolved";

export function findTicketView(id: string): TicketView {
	return (
		TICKET_VIEWS.find((view) => view.id === id) ??
		(TICKET_VIEWS[0] as TicketView)
	);
}

export function ticketViewCounts(
	tickets: readonly Ticket[],
	now: number
): Record<TicketViewId, number> {
	const counts = {} as Record<TicketViewId, number>;
	for (const view of TICKET_VIEWS) {
		let count = 0;
		for (const ticket of tickets) {
			if (view.matches(ticket, now)) {
				count += 1;
			}
		}
		counts[view.id] = count;
	}
	return counts;
}

// ---------------------------------------------------------------------------
// Filter, sort, group
// ---------------------------------------------------------------------------

export interface TicketFilter {
	priorities: TicketPriority[];
	query: string;
	/** Requester agent ids; "none" matches tickets without a requester. */
	requesterIds: string[];
}

export const EMPTY_TICKET_FILTER: TicketFilter = {
	priorities: [],
	query: "",
	requesterIds: [],
};

export const NO_REQUESTER_ID = "none";

export function ticketFilterCount(filter: TicketFilter): number {
	return filter.priorities.length + filter.requesterIds.length;
}

/** Matches subject, the number with or without "#", requester, CCs, and tags. */
export function matchesTicketQuery(ticket: Ticket, query: string): boolean {
	const needle = query.trim().toLowerCase();
	if (!needle) {
		return true;
	}
	const haystack = [
		ticket.thread.title,
		`#${ticket.number}`,
		ticket.requester?.name ?? "",
		...ticket.ccs.map((agent) => agent.name),
		...ticket.tags,
	]
		.join(" ")
		.toLowerCase();
	return needle
		.split(/\s+/)
		.every((word) => haystack.includes(word.replace(/^#?/, "")));
}

export function matchesTicketFilter(
	ticket: Ticket,
	filter: TicketFilter
): boolean {
	if (
		filter.priorities.length > 0 &&
		!filter.priorities.includes(ticket.priority)
	) {
		return false;
	}
	if (filter.requesterIds.length > 0) {
		const key = ticket.requester?.id ?? NO_REQUESTER_ID;
		if (!filter.requesterIds.includes(key)) {
			return false;
		}
	}
	return matchesTicketQuery(ticket, filter.query);
}

export type TicketSortKey =
	| "number"
	| "priority"
	| "requester"
	| "sla"
	| "status"
	| "subject"
	| "updated";

export interface TicketSort {
	direction: "asc" | "desc";
	key: TicketSortKey;
}

export const DEFAULT_TICKET_SORT: TicketSort = {
	direction: "desc",
	key: "updated",
};

/** The direction a column sorts in when first clicked. */
export const TICKET_SORT_FIRST_DIRECTION: Record<
	TicketSortKey,
	TicketSort["direction"]
> = {
	number: "desc",
	priority: "asc",
	requester: "asc",
	sla: "asc",
	status: "asc",
	subject: "asc",
	updated: "desc",
};

function compareKey(a: Ticket, b: Ticket, key: TicketSortKey): number {
	switch (key) {
		case "number":
			return a.number - b.number;
		case "priority":
			return (
				TICKET_PRIORITY_ORDER.indexOf(a.priority) -
				TICKET_PRIORITY_ORDER.indexOf(b.priority)
			);
		case "requester":
			return (a.requester?.name ?? "￿").localeCompare(b.requester?.name ?? "￿");
		case "sla":
			return (a.sla?.dueAt ?? 0) - (b.sla?.dueAt ?? 0);
		case "status":
			return (
				TICKET_STATUS_ORDER.indexOf(a.status) -
				TICKET_STATUS_ORDER.indexOf(b.status)
			);
		case "subject":
			return a.thread.title.localeCompare(b.thread.title);
		default:
			return a.updatedAt - b.updatedAt;
	}
}

export function sortTickets(
	tickets: readonly Ticket[],
	sort: TicketSort
): Ticket[] {
	const sign = sort.direction === "asc" ? 1 : -1;
	return [...tickets].sort((a, b) => {
		// Tickets with no running SLA sort after every running one, both ways.
		if (sort.key === "sla" && (a.sla === null) !== (b.sla === null)) {
			return a.sla === null ? 1 : -1;
		}
		const primary = compareKey(a, b, sort.key);
		if (primary !== 0) {
			return primary * sign;
		}
		return b.updatedAt - a.updatedAt || a.number - b.number;
	});
}

export type TicketGroupBy = "none" | "priority" | "status";

export interface TicketSection {
	id: string;
	/** "Status: Open". Null when the table is not grouped. */
	label: string | null;
	tickets: Ticket[];
}

/** Sections in lifecycle (or priority) order; empty groups are left out. */
export function groupTickets(
	tickets: readonly Ticket[],
	groupBy: TicketGroupBy
): TicketSection[] {
	if (groupBy === "none") {
		return [{ id: "all", label: null, tickets: [...tickets] }];
	}
	if (groupBy === "priority") {
		return TICKET_PRIORITY_ORDER.map((priority) => ({
			id: priority,
			label: `Priority: ${TICKET_PRIORITY_LABELS[priority]}`,
			tickets: tickets.filter((ticket) => ticket.priority === priority),
		})).filter((section) => section.tickets.length > 0);
	}
	return TICKET_STATUS_ORDER.map((status) => ({
		id: status,
		label: `Status: ${TICKET_STATUS_LABELS[status]}`,
		tickets: tickets.filter((ticket) => ticket.status === status),
	})).filter((section) => section.tickets.length > 0);
}

/** The rows a view shows, after filter and sort, plus its sections. */
export function ticketViewRows(
	tickets: readonly Ticket[],
	viewId: TicketViewId,
	filter: TicketFilter,
	sort: TicketSort,
	groupBy: TicketGroupBy,
	now: number
): { order: string[]; sections: TicketSection[]; total: number } {
	const view = findTicketView(viewId);
	const inView = tickets.filter((ticket) => view.matches(ticket, now));
	const shown = sortTickets(
		inView.filter((ticket) => matchesTicketFilter(ticket, filter)),
		sort
	);
	const sections = groupTickets(shown, groupBy);
	return {
		order: sections.flatMap((section) =>
			section.tickets.map((ticket) => ticket.id)
		),
		sections,
		total: inView.length,
	};
}

/** Other tickets from the same requester, newest first. */
export function requesterTickets(
	tickets: readonly Ticket[],
	ticket: Ticket,
	limit = 5
): Ticket[] {
	const requesterId = ticket.requester?.id;
	if (!requesterId) {
		return [];
	}
	return sortTickets(
		tickets.filter(
			(other) => other.id !== ticket.id && other.requester?.id === requesterId
		),
		DEFAULT_TICKET_SORT
	).slice(0, limit);
}

// ---------------------------------------------------------------------------
// Activity: only what the snapshot actually knows
// ---------------------------------------------------------------------------

export interface TicketActivity {
	/** Epoch ms, or null for "now" (a live run). */
	at: number | null;
	id: string;
	label: string;
	tone: "default" | "destructive" | "live" | "muted";
}

/** Newest first: live run, last run outcome, last reply, and the SLA mark. */
export function ticketActivity(ticket: Ticket, now: number): TicketActivity[] {
	const requester = ticket.requester?.name ?? "The agent";
	const items: TicketActivity[] = [];
	if (ticket.thread.running) {
		items.push({
			at: null,
			id: "running",
			label: `${requester} is working on a reply`,
			tone: "live",
		});
	}
	if (ticket.thread.runState === "failed") {
		items.push({
			at: ticket.updatedAt,
			id: "run",
			label: "The last run failed",
			tone: "destructive",
		});
	} else if (ticket.thread.runState === "interrupted") {
		items.push({
			at: ticket.updatedAt,
			id: "run",
			label: "The last run was stopped",
			tone: "destructive",
		});
	}
	if (ticket.thread.lastMessageRole) {
		items.push({
			at: ticket.updatedAt,
			id: "reply",
			label:
				ticket.thread.lastMessageRole === "user"
					? "You replied"
					: `${requester} replied`,
			tone: "default",
		});
	}
	if (ticket.sla) {
		items.unshift({
			at: ticket.sla.dueAt,
			id: "sla",
			label: ticket.sla.state === "breached" ? "Reply overdue" : "Reply due",
			tone: ticket.sla.state === "breached" ? "destructive" : "muted",
		});
	}
	if (ticket.status === "solved") {
		items.unshift({
			at: ticket.updatedAt + TICKET_SOLVE_AFTER_MS,
			id: "solved",
			label: "Solved after a day without follow-up",
			tone: "muted",
		});
	}
	// A live run (no time) is happening now, so it leads.
	const when = (item: TicketActivity) => item.at ?? now;
	return items.sort((a, b) => when(b) - when(a));
}

// ---------------------------------------------------------------------------
// Time labels
// ---------------------------------------------------------------------------

function sameLocalDay(a: Date, b: Date): boolean {
	return (
		a.getFullYear() === b.getFullYear() &&
		a.getMonth() === b.getMonth() &&
		a.getDate() === b.getDate()
	);
}

const CLOCK = new Intl.DateTimeFormat(undefined, {
	hour: "numeric",
	minute: "2-digit",
});
const MONTH_DAY = new Intl.DateTimeFormat(undefined, {
	day: "numeric",
	month: "short",
});
const MONTH_DAY_YEAR = new Intl.DateTimeFormat(undefined, {
	day: "numeric",
	month: "short",
	year: "numeric",
});
const FULL = new Intl.DateTimeFormat(undefined, {
	dateStyle: "medium",
	timeStyle: "short",
});

/**
 * The "Updated" column, the way help desks print it: minutes for the last
 * hour, then "Today 14:02", "Yesterday 09:15", "Oct 3", "Oct 3, 2025".
 */
export function ticketTimeLabel(at: number, now: number): string {
	if (at === 0) {
		return "";
	}
	const delta = now - at;
	if (delta >= 0 && delta < MINUTE) {
		return "Just now";
	}
	if (delta >= 0 && delta < HOUR) {
		return `${Math.floor(delta / MINUTE)} min ago`;
	}
	const date = new Date(at);
	const today = new Date(now);
	if (sameLocalDay(date, today)) {
		return `Today ${CLOCK.format(date)}`;
	}
	const yesterday = new Date(now - DAY);
	if (sameLocalDay(date, yesterday)) {
		return `Yesterday ${CLOCK.format(date)}`;
	}
	const tomorrow = new Date(now + DAY);
	if (sameLocalDay(date, tomorrow)) {
		return `Tomorrow ${CLOCK.format(date)}`;
	}
	return date.getFullYear() === today.getFullYear()
		? MONTH_DAY.format(date)
		: MONTH_DAY_YEAR.format(date);
}

export function ticketFullTime(at: number): string {
	return at === 0 ? "" : FULL.format(new Date(at));
}

export function ticketCountLabel(count: number): string {
	return `${count} ticket${count === 1 ? "" : "s"}`;
}
