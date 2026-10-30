import {
	DAY,
	TICKET_PRIORITY_LABELS,
	TICKET_PRIORITY_ORDER,
	TICKET_STATUS_LABELS,
	TICKET_STATUS_ORDER,
	type Ticket,
	type TicketPriority,
} from "./tickets-model-base.ts";

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
