import {
	compareAsks,
	estimateProgress,
	type InterfaceAgentAct,
	type InterfaceAsk,
	type InterfaceSnapshot,
	threadClaims,
} from "@ryuhq/protocol/interfaces";
import { actHasBlocker } from "./game3d-acts.ts";
import {
	compareTickets,
	type KitchenTicket,
	type TicketState,
	toTicket,
} from "./kitchen-model.ts";

/** Kitchen tickets as the act layer shows them. */

/**
 * What a ticket shows when the host sends asks, from the acts alone: its
 * place on the rail (`rank`: an ask that needs you, a stop or limit, a
 * run, an unread answer), its words and colour, the ask its patience bar
 * drains from (a blocking ask, else an unread answer; never a suggestion),
 * the run's elapsed time (exact starts only) and its estimate (a cron
 * routine's own firing only).
 */
export interface TicketAct {
	ask: InterfaceAsk | null;
	elapsed: string | null;
	estimate: number | null;
	label: string;
	rank: number;
	state: TicketState;
}

/** The rail from the acts: what needs you first, in ask order, then the rest. */
export function actTickets(
	snapshot: InterfaceSnapshot,
	acts: ReadonlyMap<string, InterfaceAgentAct>,
	nowMs: number
): { rail: KitchenTicket[]; views: Map<string, TicketAct> } {
	const claims = threadClaims(snapshot);
	const asks = [...(snapshot.asks ?? [])].sort(compareAsks);
	const views = new Map<string, TicketAct>();
	const tickets: KitchenTicket[] = [];
	for (const thread of snapshot.threads) {
		const act = acts.get(claims.get(thread.id) ?? "");
		const blocking = asks.find(
			(ask) => ask.threadId === thread.id && ask.blocking
		);
		const reply = asks.find(
			(ask) => ask.threadId === thread.id && ask.kind === "reply"
		);
		// By value and claim (the kit's check), never object identity.
		const counted =
			act && actHasBlocker(act, thread, claims) ? thread.blocker : null;
		// A rate limit is not a failure: it reads 86'd, never burnt.
		const limit = counted?.kind === "rate-limited";
		const stopped = limit ? null : counted;
		let view: Omit<TicketAct, "ask" | "elapsed" | "estimate"> | null = null;
		if (blocking) {
			view = { label: "Needs you", rank: 0, state: "needs" };
		} else if (stopped) {
			view = {
				label: stopped.kind === "interrupted" ? "Pulled" : "Burnt",
				rank: 1,
				state: "burnt",
			};
		} else if (
			limit ||
			(act?.act === "limited" && act.threadId === thread.id)
		) {
			view = { label: "86'd", rank: 1, state: "limited" };
		} else if (thread.running) {
			view = { label: "Cooking", rank: 2, state: "cooking" };
		} else if (reply) {
			view = { label: "Ready", rank: 3, state: "ready" };
		}
		if (!view) {
			continue;
		}
		const estimate = estimateProgress(thread, nowMs, snapshot.events);
		views.set(thread.id, {
			...view,
			ask: blocking ?? reply ?? null,
			elapsed:
				act?.act === "working" && act.threadId === thread.id
					? act.elapsed
					: null,
			estimate:
				estimate && estimate.total > 0 ? estimate.done / estimate.total : null,
		});
		tickets.push(toTicket(snapshot, thread));
	}
	const order = (ticket: KitchenTicket) => views.get(ticket.id);
	tickets.sort((a, b) => {
		const left = order(a);
		const right = order(b);
		const rank = (left?.rank ?? 9) - (right?.rank ?? 9);
		if (rank !== 0) {
			return rank;
		}
		if (left?.ask && right?.ask && left.rank === 0) {
			return compareAsks(left.ask, right.ask);
		}
		return compareTickets(a, b);
	});
	return { rail: tickets, views };
}
