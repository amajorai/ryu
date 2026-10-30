import type {
	InterfaceAgentAct,
	InterfaceSnapshot,
	InterfaceThread,
} from "@ryuhq/protocol/interfaces";
import { useMemo } from "react";
import { actHasBlocker } from "./game3d-acts.ts";
import {
	buildQuizBoard,
	parseRevealed,
	REVEALED_STORAGE_KEY,
	type RevealedMap,
} from "./quiz-model.ts";

export function readRevealed(): RevealedMap {
	try {
		return parseRevealed(
			globalThis.localStorage?.getItem(REVEALED_STORAGE_KEY)
		);
	} catch {
		return {};
	}
}

export function writeRevealed(revealed: RevealedMap) {
	try {
		if (Object.keys(revealed).length === 0) {
			globalThis.localStorage?.removeItem(REVEALED_STORAGE_KEY);
		} else {
			globalThis.localStorage?.setItem(
				REVEALED_STORAGE_KEY,
				JSON.stringify(revealed)
			);
		}
	} catch {
		// Storage can be full or blocked; the board still plays for this visit.
	}
}

export type Overlay =
	| { kind: "clue"; threadId: string }
	| { agentId?: string; kind: "final" };

export type FocusTarget =
	| { kind: "answer" }
	| { kind: "booth" }
	| { kind: "final" }
	| { kind: "restore" }
	| { kind: "tile"; threadId: string };

/** Below this stage width the HUD plates go compact. */
export const COMPACT_BELOW = 720;
/** The island's rim round the studio. */
export const ISLAND_RIM = 2.2;

/** A clue's status word from the act layer, for its tile's name. */
function clueWord(
	thread: InterfaceThread,
	state: {
		asked: Set<string>;
		blocking: Set<string>;
		stopped: Map<string, string>;
	},
	/** A delivered answer's headline: the flipped tile says it. */
	headline?: string
): string {
	if (state.blocking.has(thread.id)) {
		return "Needs you";
	}
	if ((thread.unread ?? 0) > 0) {
		return headline ? `Answer ready: ${headline}` : "Answer ready";
	}
	if (thread.running) {
		return "Working";
	}
	const stopped = state.stopped.get(thread.id);
	if (stopped) {
		return stopped;
	}
	return state.asked.has(thread.id) ? "Waiting on you" : "Done";
}

/** World units kept round the plates when the act layer frames the set. */
export const QUIZ_ACT_PLATE_FIT = { above: 4.2, below: 1, max: 2.2, side: 1 };

/**
 * The quiz board as the act layer sees it: each clue's ask/stop state, the
 * delivered headlines and the board itself.
 */
export function useQuizBoardState(
	snapshot: InterfaceSnapshot,
	acts: ReadonlyMap<string, InterfaceAgentAct>,
	withActs: boolean,
	round: Parameters<typeof buildQuizBoard>[1]
) {
	// What the act layer says about each clue's thread: an open ask (a
	// blocking one lights the clue), a run, a counted stop, an answer to read.
	const clueState = useMemo(() => {
		// Only a blocking ask or an answer to read keeps a clue up; a
		// suggestion does not.
		const asked = new Set<string>();
		const blocking = new Set<string>();
		const stopped = new Map<string, string>();
		for (const ask of snapshot.asks ?? []) {
			if (ask.threadId && (ask.blocking || ask.kind === "reply")) {
				asked.add(ask.threadId);
				if (ask.blocking) {
					blocking.add(ask.threadId);
				}
			}
		}
		// A counted stop's word is its act's: sitting out, paused or stopped.
		for (const act of acts.values()) {
			for (const thread of snapshot.threads) {
				if (!(thread.blocker && actHasBlocker(act, thread))) {
					continue;
				}
				let word = "Stopped";
				if (act.act === "limited") {
					word = "Sitting out";
				} else if (thread.blocker.kind === "interrupted") {
					word = "Paused";
				}
				stopped.set(thread.id, word);
			}
			// A limit on the agent (not on a thread) sits out the clue it was
			// on; its played clues stay played.
			if (act.act === "limited" && act.threadId && !stopped.has(act.threadId)) {
				stopped.set(act.threadId, "Sitting out");
			}
		}
		return { asked, blocking, stopped };
	}, [acts, snapshot.asks, snapshot.threads]);
	// With acts, a delivered answer flips its clue to the answer's headline.
	const headlines = useMemo(() => {
		const out = new Map<string, string>();
		if (!withActs) {
			return out;
		}
		for (const act of acts.values()) {
			const thread = act.threadId
				? snapshot.threads.find((item) => item.id === act.threadId)
				: undefined;
			const headline = thread?.outcome?.headline;
			if (act.act === "delivering" && thread && headline) {
				out.set(thread.id, headline);
			}
		}
		return out;
	}, [acts, snapshot.threads, withActs]);
	const legacyBoard = useMemo(
		() => buildQuizBoard(snapshot, round),
		[round, snapshot]
	);
	// With acts a clue is lit (needs you) only while a blocking ask waits on it.
	const board = useMemo(
		() =>
			withActs
				? {
						...legacyBoard,
						columns: legacyBoard.columns.map((category) =>
							category
								? {
										...category,
										tiles: category.tiles.map((tile) => ({
											...tile,
											needsYou: clueState.blocking.has(tile.thread.id),
											statusWord: clueWord(
												tile.thread,
												clueState,
												headlines.get(tile.thread.id)
											),
										})),
									}
								: category
						),
					}
				: legacyBoard,
		[clueState, headlines, legacyBoard, withActs]
	);
	return { board, clueState, headlines };
}
