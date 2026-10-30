import {
	askKindWords,
	compareAsks,
	type InterfaceAgentAct,
	type InterfaceBlocker,
	type InterfaceSnapshot,
	type InterfaceThread,
	threadStatus,
} from "@ryuhq/protocol/interfaces";
import { countedBlockerThreads } from "./game3d-acts.ts";
import { plainText } from "./interface-ask-card.tsx";
import { STAGE_LABELS, type TripStage } from "./rides-model.ts";

/** How a trip's row word reads: your move, a counted failure, or old news. */
export type RidesTripTone = "alert" | "dim" | "plain" | "you";

/** A trip as the act layer sees it: its sheet stage and its row word. */
export interface RidesActTrip {
	/** The open trip's sentence under its word, true to the act. */
	detail: string;
	/** A finished trip that ended well: the track fills. */
	done: boolean;
	stage: TripStage;
	tone: RidesTripTone;
	word: string;
}

/**
 * Every thread's trip state from the acts, so the sheet, the list, the
 * open trip and the map agree with the counters: a blocking ask is
 * "Waiting on you", a counted failure its title (the only "Needs
 * attention" trips), a running thread en route, a reply ask "Answer
 * ready" (the only arrivals, as the Queue counts them), a limit a red
 * light, and an interrupted run or an old, uncounted blocker a word in
 * the history (dim when old). `updatedAt` never stages a trip.
 */
export function ridesActTrips(
	snapshot: Pick<InterfaceSnapshot, "agents" | "asks" | "privacy" | "threads">,
	acts: ReadonlyMap<string, InterfaceAgentAct>
): Map<string, RidesActTrip> {
	const counted = countedBlockerThreads(snapshot, acts);
	const asks = snapshot.asks ?? [];
	const redacted = snapshot.privacy === "redacted";
	const limited = new Set(
		[...acts.values()]
			.filter((act) => act.act === "limited" && act.threadId)
			.map((act) => act.threadId)
	);
	// The act on each thread: whose run, or whose limit, it is.
	const actOn = new Map(
		[...acts.values()]
			.filter((act) => act.threadId)
			.map((act) => [act.threadId, act.agentName] as const)
	);
	const actAsks = new Set(
		[...acts.values()].flatMap((act) =>
			act.act === "asking" && act.ask ? [act.ask.id] : []
		)
	);
	const nameOf = (agentId: string | null | undefined) =>
		snapshot.agents.find((agent) => agent.id === agentId)?.name;
	const out = new Map<string, RidesActTrip>();
	for (const thread of snapshot.threads) {
		const own = asks.filter((ask) => ask.threadId === thread.id);
		// The ask the act shows (its bubble and card), else the first in
		// queue order: never whichever the array happens to list first.
		const blocking =
			own.find((ask) => ask.blocking && actAsks.has(ask.id)) ??
			own.filter((ask) => ask.blocking).sort(compareAsks)[0];
		out.set(
			thread.id,
			actTrip(thread, {
				asked: blocking
					? redacted
						? askKindWords(blocking)
						: plainText(blocking.text) || askKindWords(blocking)
					: null,
				counted: counted.get(thread.id)?.blocker,
				// Who the sentence is about: the asker, else whose act is on
				// this thread, else its first member.
				driver:
					(blocking ? nameOf(blocking.agentId) : undefined) ??
					actOn.get(thread.id) ??
					nameOf(thread.agentIds[0]) ??
					"Your driver",
				redacted,
				limited: limited.has(thread.id),
				replied: own.some((ask) => ask.kind === "reply"),
			})
		);
	}
	return out;
}

function actTrip(
	thread: InterfaceThread,
	state: {
		/** The blocking ask's words, when one waits on this thread. */
		asked: string | null;
		counted: InterfaceBlocker | undefined;
		driver: string;
		limited: boolean;
		redacted: boolean;
		replied: boolean;
	}
): RidesActTrip {
	const { asked, counted, driver } = state;
	if (asked !== null) {
		return {
			detail: `${driver} is asking you: ${asked}`,
			done: false,
			stage: "requested",
			tone: "you",
			word: "Waiting on you",
		};
	}
	if (
		counted &&
		counted.kind !== "interrupted" &&
		counted.kind !== "rate-limited"
	) {
		return {
			detail:
				(state.redacted || !counted.detail
					? null
					: plainText(counted.detail)) ??
				`${counted.title}. Send a message to try again.`,
			done: false,
			stage: "cancelled",
			tone: "alert",
			word: counted.title,
		};
	}
	if (thread.running) {
		return {
			detail: `${driver} is on it.`,
			done: false,
			stage: "enroute",
			tone: "plain",
			word: STAGE_LABELS.enroute,
		};
	}
	if (state.replied) {
		return {
			detail: `${driver} brought an answer.`,
			done: true,
			stage: "arrived",
			tone: "you",
			word: "Answer ready",
		};
	}
	// A limit is a red light, never "Completed": on the thread or the agent.
	// (A reply already waiting outranks it: the answer can be read now.)
	if (state.limited || counted?.kind === "rate-limited") {
		return {
			detail: `${driver} is waiting at a red light (a usage limit).`,
			done: false,
			stage: "completed",
			tone: "plain",
			word: "Red light",
		};
	}
	if (counted?.kind === "interrupted") {
		return {
			detail: "The run was interrupted. Send a message to try again.",
			done: false,
			stage: "completed",
			tone: "plain",
			word: counted.title,
		};
	}
	if (thread.blocker) {
		return {
			detail: `An older run: ${thread.blocker.title}.`,
			done: false,
			stage: "completed",
			tone: "dim",
			word: thread.blocker.title,
		};
	}
	const stage = threadStatus(thread) === "quiet" ? "unstarted" : "completed";
	return {
		detail: stage === "unstarted" ? "Nothing has been sent yet." : "Done.",
		done: stage === "completed",
		stage,
		tone: "plain",
		word: STAGE_LABELS[stage],
	};
}

/** Where an act's working car is along its route: its pips, or nothing. */
export function actRouteShare(
	acts: ReadonlyMap<string, InterfaceAgentAct>,
	threadId: string
): number | null {
	for (const act of acts.values()) {
		const progress = act.progress;
		if (act.threadId === threadId && progress && progress.total > 0) {
			return Math.min(1, Math.max(0, progress.done / progress.total));
		}
	}
	return null;
}
