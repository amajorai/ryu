import {
	DAY,
	HOUR,
	MINUTE,
	TICKET_SOLVE_AFTER_MS,
	type Ticket,
} from "./tickets-model-base.ts";

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
