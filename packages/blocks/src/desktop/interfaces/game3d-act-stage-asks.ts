import type {
	InterfaceAgentAct,
	InterfaceAsk,
	InterfaceBlocker,
	InterfaceSnapshot,
} from "@ryuhq/protocol/interfaces";
import { threadClaims } from "@ryuhq/protocol/interfaces";
import { actHasBlocker } from "./game3d-acts.ts";

/**
 * The reply asks waiting at an agent's station (not the one it carries),
 * newest first, owned as the protocol owns asks: a present `agentId`, else
 * the agent that claims the ask's thread (`threadClaims`).
 * Pass `claims` when drawing many stations, so it is computed once.
 */
export function unreadAsksOf(
	act: InterfaceAgentAct,
	snapshot: InterfaceSnapshot,
	claims: ReadonlyMap<string, string> = threadClaims(snapshot)
): InterfaceAsk[] {
	const present = new Set(snapshot.agents.map((agent) => agent.id));
	// The protocol's ask owner: a present agentId, else the thread's claimant.
	const ownerOf = (ask: InterfaceAsk) =>
		ask.agentId && present.has(ask.agentId)
			? ask.agentId
			: ask.threadId
				? (claims.get(ask.threadId) ?? null)
				: null;
	return (snapshot.asks ?? [])
		.filter(
			(ask) =>
				ask.kind === "reply" &&
				ask.id !== act.ask?.id &&
				ownerOf(ask) === act.agentId
		)
		.sort(
			(a, b) =>
				(Date.parse(b.since ?? "") || 0) - (Date.parse(a.since ?? "") || 0)
		);
}

/** An agent's failures too old to count, on threads it claims: dim marks only. */
export function oldBlockersOf(
	act: InterfaceAgentAct,
	snapshot: InterfaceSnapshot,
	claims: ReadonlyMap<string, string> = threadClaims(snapshot)
): InterfaceBlocker[] {
	return snapshot.threads
		.filter(
			(thread) =>
				claims.get(thread.id) === act.agentId &&
				thread.blocker &&
				!act.blockers.includes(thread.blocker)
		)
		.map((thread) => thread.blocker as InterfaceBlocker);
}

/**
 * The thread `blocker` (one of `act`'s alarms) stands for: the same object
 * on a thread the agent claims first, then a value match among its claimed
 * threads, so a copied blocker (stableActs, redaction) still finds its card
 * and two value-equal blockers each open their own.
 */
export function blockerThread(
	act: InterfaceAgentAct,
	blocker: InterfaceBlocker,
	snapshot: InterfaceSnapshot,
	claims: ReadonlyMap<string, string> = threadClaims(snapshot)
): InterfaceSnapshot["threads"][number] | undefined {
	// The same object first (two blockers can be equal by value: two
	// "Interrupted" with no time, or redacted ones), then by value.
	const claimed = (thread: InterfaceSnapshot["threads"][number]) =>
		claims.get(thread.id) === act.agentId;
	const one = { agentId: act.agentId, blockers: [blocker] };
	return (
		snapshot.threads.find(
			(thread) => thread.blocker === blocker && claimed(thread)
		) ??
		snapshot.threads.find((thread) => thread.blocker === blocker) ??
		snapshot.threads.find((thread) => actHasBlocker(one, thread, claims)) ??
		snapshot.threads.find((thread) => actHasBlocker(one, thread))
	);
}
