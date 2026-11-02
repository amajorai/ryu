import {
	activeLocale,
	formatCompactAge,
	formatRelativeTime,
	translate as tr,
	unitFormatter,
} from "@ryu/i18n/lite";
import type {
	KitchenStation,
	KitchenTicket,
	TicketAct,
} from "./kitchen-model.ts";

/** A ticket state's label in the UI language, for copy that interpolates it. */
export function ticketStateLabel(state: KitchenTicket["state"]): string {
	switch (state) {
		case "burnt":
			return tr("Burnt");
		case "cooking":
			return tr("Cooking");
		case "limited":
			return tr("86'd");
		case "needs":
			return tr("Needs you");
		case "queued":
			return tr("Waiting");
		case "ready":
			return tr("Ready");
		default:
			return tr("Served");
	}
}

/** Kitchen ticket timers and the spoken names of tickets and chefs, in the UI language. */

/**
 * Ticket timer since the last update. Cooking tickets run a live kitchen
 * timer (`m:ss`, then `1:02:05`); every other ticket shows a compact age
 * (`now`, `4m`, `3h`, `2d`, `5w`), so one rail never mixes the two for the
 * same kind of ticket.
 */
export function ticketTimer(
	updatedAt: number,
	now: number,
	live = false
): string {
	if (updatedAt <= 0) {
		return "";
	}
	const seconds = Math.max(0, Math.floor((now - updatedAt) / 1000));
	if (live) {
		const hours = Math.floor(seconds / 3600);
		const minutes = Math.floor((seconds % 3600) / 60);
		const rest = String(seconds % 60).padStart(2, "0");
		return hours > 0
			? `${hours}:${String(minutes).padStart(2, "0")}:${rest}`
			: `${minutes}:${rest}`;
	}
	return formatCompactAge(activeLocale(), updatedAt, { now });
}

/** Spoken form of the timer, for accessible names. */
export function spokenAge(updatedAt: number, now: number): string {
	if (updatedAt <= 0) {
		return tr("no updates yet");
	}
	if (now - updatedAt < 60_000) {
		return tr("updated just now");
	}
	return tr("updated {age}", {
		age: formatRelativeTime(activeLocale(), Math.min(updatedAt, now), {
			now,
			numeric: "always",
		}),
	});
}

/** Short duration for the estimate note ("about 6 min"). */
export function roughDuration(ms: number): string {
	const minutes = Math.max(1, Math.round(ms / 60_000));
	if (minutes < 60) {
		return unitFormatter(activeLocale(), "minute", "short").format(minutes);
	}
	return unitFormatter(activeLocale(), "hour", "short").format(
		Math.round(minutes / 6) / 10
	);
}

/**
 * Accessible name for a ticket button. With the act layer (`act`) the
 * words come from the act and the only time said is the run's exact
 * elapsed time: a last-update time is never spoken.
 */
export function ticketLabel(
	ticket: KitchenTicket,
	now: number,
	act?: Pick<TicketAct, "elapsed" | "label"> | null
): string {
	const chef = ticket.chef
		? tr(", {name}", { name: ticket.chef.name })
		: tr(", no chef");
	if (act) {
		const running = act.elapsed
			? tr(", running {elapsed}", { elapsed: act.elapsed })
			: "";
		return tr("{title}: {label}{chef}{running}", {
			chef,
			label: act.label,
			running,
			title: ticket.title,
		});
	}
	return tr("{title}: {label}{chef}, {age}", {
		age: spokenAge(ticket.updatedAt, now),
		chef,
		label: ticketStateLabel(ticket.state),
		title: ticket.title,
	});
}

/** Accessible name for a chef (plate or roster button). */
export function chefLabel(station: KitchenStation): string {
	const parts = [station.agent.name];
	if (station.working) {
		parts.push(tr("cooking"));
	}
	const ready = station.orders.filter((order) => order.state === "ready");
	if (ready.length > 0) {
		parts.push(tr("{count} ready", { count: ready.length }));
	}
	if (station.burnt) {
		parts.push(tr("burnt order"));
	}
	return parts.join(", ");
}
