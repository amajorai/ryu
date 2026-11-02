import {
	activeLocale,
	dateFormatter,
	relativeTimeFormatter,
	translate as tr,
} from "@ryu/i18n/lite";
import type { LiteralMessage } from "@ryu/i18n/react";
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
export function ticketActivity(
	ticket: Ticket,
	now: number,
	tl: LiteralMessage
): TicketActivity[] {
	const requester = ticket.requester?.name;
	const items: TicketActivity[] = [];
	if (ticket.thread.running) {
		items.push({
			at: null,
			id: "running",
			label:
				requester === undefined
					? tl("The agent is working on a reply")
					: tl("{requester} is working on a reply", { requester }),
			tone: "live",
		});
	}
	if (ticket.thread.runState === "failed") {
		items.push({
			at: ticket.updatedAt,
			id: "run",
			label: tl("The last run failed"),
			tone: "destructive",
		});
	} else if (ticket.thread.runState === "interrupted") {
		items.push({
			at: ticket.updatedAt,
			id: "run",
			label: tl("The last run was stopped"),
			tone: "destructive",
		});
	}
	if (ticket.thread.lastMessageRole) {
		items.push({
			at: ticket.updatedAt,
			id: "reply",
			label:
				ticket.thread.lastMessageRole === "user"
					? tl("You replied")
					: requesterReplied(requester, tl),
			tone: "default",
		});
	}
	if (ticket.sla) {
		items.unshift({
			at: ticket.sla.dueAt,
			id: "sla",
			label:
				ticket.sla.state === "breached" ? tl("Reply overdue") : tl("Reply due"),
			tone: ticket.sla.state === "breached" ? "destructive" : "muted",
		});
	}
	if (ticket.status === "solved") {
		items.unshift({
			at: ticket.updatedAt + TICKET_SOLVE_AFTER_MS,
			id: "solved",
			label: tl("Solved after a day without follow-up"),
			tone: "muted",
		});
	}
	// A live run (no time) is happening now, so it leads.
	const when = (item: TicketActivity) => item.at ?? now;
	return items.sort((a, b) => when(b) - when(a));
}

function requesterReplied(
	requester: string | undefined,
	tl: LiteralMessage
): string {
	return requester === undefined
		? tl("The agent replied")
		: tl("{requester} replied", { requester });
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

const CLOCK: Intl.DateTimeFormatOptions = {
	hour: "numeric",
	minute: "2-digit",
};
const MONTH_DAY: Intl.DateTimeFormatOptions = {
	day: "numeric",
	month: "short",
};

/**
 * The "Updated" column, the way help desks print it: minutes for the last
 * hour, then "Today 14:02", "Yesterday 09:15", "Oct 3", "Oct 3, 2025".
 */
export function ticketTimeLabel(
	at: number,
	now: number,
	tl: LiteralMessage,
	locale: string = activeLocale()
): string {
	if (at === 0) {
		return "";
	}
	const delta = now - at;
	if (delta >= 0 && delta < MINUTE) {
		return tl("Just now");
	}
	if (delta >= 0 && delta < HOUR) {
		return relativeTimeFormatter(locale, "short", "always").format(
			-Math.floor(delta / MINUTE),
			"minute"
		);
	}
	const date = new Date(at);
	const time = dateFormatter(locale, CLOCK).format(date);
	const today = new Date(now);
	if (sameLocalDay(date, today)) {
		return tl("Today {time}", { time });
	}
	const yesterday = new Date(now - DAY);
	if (sameLocalDay(date, yesterday)) {
		return tl("Yesterday {time}", { time });
	}
	const tomorrow = new Date(now + DAY);
	if (sameLocalDay(date, tomorrow)) {
		return tl("Tomorrow {time}", { time });
	}
	return dateFormatter(
		locale,
		date.getFullYear() === today.getFullYear()
			? MONTH_DAY
			: { ...MONTH_DAY, year: "numeric" }
	).format(date);
}

export function ticketFullTime(
	at: number,
	locale: string = activeLocale()
): string {
	return at === 0
		? ""
		: dateFormatter(locale, { dateStyle: "medium", timeStyle: "short" }).format(
				new Date(at)
			);
}

export function ticketCountLabel(count: number): string {
	return tr("{count, plural, one {# ticket} other {# tickets}}", { count });
}
