// Scheduled runs and the credits wallet as protocol events and account.

import { localizeUsageTaskLabel } from "@ryu/blocks/desktop/usage-task-label.ts";
import type {
	InterfaceAccount,
	InterfaceEvent,
} from "@ryuhq/protocol/interfaces";
import {
	ledgerReasonLabel,
	type WalletResponse,
} from "@/src/lib/api/credits.ts";
import type { CalendarEvent } from "@/src/lib/calendar/events.ts";
import { activeTranslate, toIso } from "./snapshot-util.ts";

/** Most scheduled runs an interface receives (the calendar already collapses
 *  high-frequency schedules into one marker per day). */
export const MAX_INTERFACE_EVENTS = 1000;

/**
 * Scheduled runs as protocol events, oldest first. Core's internal maintenance
 * jobs stay out: they are not the user's routines. Over the cap, the runs
 * nearest `now` are kept, so a long history never crowds out what is next.
 */
export function toInterfaceEvents(
	events: readonly CalendarEvent[],
	now: number = Date.now()
): InterfaceEvent[] {
	const userEvents = events.filter((event) => !event.system);
	// Over the cap, keep the runs nearest `now`: recent history (which feeds
	// estimates and routine failures) and what is next both survive, and the
	// list is still delivered oldest first.
	const kept =
		userEvents.length > MAX_INTERFACE_EVENTS
			? [...userEvents]
					.sort(
						(a, b) =>
							Math.abs(a.start.getTime() - now) -
								Math.abs(b.start.getTime() - now) || a.id.localeCompare(b.id)
					)
					.slice(0, MAX_INTERFACE_EVENTS)
			: userEvents;
	return kept
		.map(
			(event): InterfaceEvent => ({
				agentId: event.agentId ?? null,
				count: event.aggregateCount ?? null,
				end: event.end ? toIso(event.end.getTime()) : null,
				error: event.error ?? null,
				id: event.id,
				jobId: event.jobId,
				kind: event.kind,
				label: event.scheduleLabel || null,
				outcome: event.outcome ?? null,
				requiresApproval: event.requireApproval === true,
				start: toIso(event.start.getTime()),
				// A persistent routine's chat for every run; a per-firing run's own
				// conversation only when it succeeded (Core records no run id for a
				// failure; linkOrphanRuns finds that one).
				threadId:
					event.conversationId ??
					(event.outcome === "success" ? (event.runId ?? null) : null),
				title: event.workflowName ?? event.jobName,
			})
		)
		.sort((a, b) => a.start.localeCompare(b.start) || a.id.localeCompare(b.id));
}

/** Most recent transactions an interface receives. */
export const MAX_INTERFACE_TRANSACTIONS = 200;

/**
 * The credits wallet as the protocol's usage account. A ledger row's
 * reference becomes a thread id only when it names a thread in the snapshot,
 * so an interface never links spend to the wrong conversation. Gateway writes
 * the request ID into `refId` for ordinary `gateway_usage` charges, so those
 * rows never match a thread and carry `threadId: null`; only rows whose `refId`
 * is a thread ID (routine or agent runs) are linked.
 */
export function toInterfaceAccount(
	response: WalletResponse,
	threadIds: ReadonlySet<string>
): InterfaceAccount {
	const { ledger, wallet } = response;
	const transactions = [...ledger]
		.sort(
			(a, b) =>
				b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id)
		)
		.slice(0, MAX_INTERFACE_TRANSACTIONS)
		.map((entry) => ({
			amount: entry.delta,
			at: toIso(Date.parse(entry.createdAt)),
			balanceAfter: Number.isFinite(entry.balanceAfter)
				? entry.balanceAfter
				: null,
			id: entry.id,
			inputTokens: entry.inputTokens,
			kind: entry.delta < 0 ? ("debit" as const) : ("credit" as const),
			label:
				(entry.taskLabel &&
					localizeUsageTaskLabel(entry.taskLabel, activeTranslate)) ||
				ledgerReasonLabel(entry.reason) ||
				entry.reason,
			model: entry.model,
			outputTokens: entry.outputTokens,
			provider: entry.upstreamProvider ?? entry.provider,
			threadId: entry.refId && threadIds.has(entry.refId) ? entry.refId : null,
		}));
	const breakdownKnown =
		wallet.subscriptionBalanceMicroUsd !== null ||
		wallet.topupBalanceMicroUsd !== null ||
		(wallet.giftBalanceMicroUsd ?? null) !== null;
	return {
		balance: Number.isFinite(wallet.balanceMicroUsd)
			? wallet.balanceMicroUsd
			: null,
		breakdown: breakdownKnown
			? {
					gift: wallet.giftBalanceMicroUsd ?? null,
					plan: wallet.subscriptionBalanceMicroUsd,
					topup: wallet.topupBalanceMicroUsd,
				}
			: null,
		currency: wallet.currency.toLowerCase(),
		transactions,
	};
}
