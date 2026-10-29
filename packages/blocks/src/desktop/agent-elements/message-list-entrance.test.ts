import { describe, expect, it } from "bun:test";
import {
	type BubbleEntranceState,
	MAX_FRESH_PER_UPDATE,
	reconcileBubbleEntranceState,
} from "./message-list-entrance.ts";

function step(
	state: BubbleEntranceState | null,
	ids: readonly string[],
	conversationKey: string | null = "thread-1"
): BubbleEntranceState {
	return reconcileBubbleEntranceState(state, conversationKey, ids);
}

function fresh(state: BubbleEntranceState): string[] {
	return [...state.freshIds].sort();
}

describe("message-list bubble entrance", () => {
	it("never animates the history the list mounts with", () => {
		expect(fresh(step(null, ["u1", "a1", "u2", "a2"]))).toEqual([]);
	});

	it("animates a sent message and the reply that follows it", () => {
		const loaded = step(null, ["u1", "a1"]);
		const sent = step(loaded, ["u1", "a1", "u2"]);
		expect(fresh(sent)).toEqual(["u2"]);
		const replied = step(sent, ["u1", "a1", "u2", "a2"]);
		expect(fresh(replied)).toEqual(["a2", "u2"]);
	});

	it("keeps a fresh id fresh, and its set stable, across streaming updates", () => {
		const sent = step(step(null, ["u1"]), ["u1", "u2"]);
		const streaming = step(sent, ["u1", "u2"]);
		expect(streaming.freshIds).toBe(sent.freshIds);
	});

	it("animates the first message of a new chat even as it gains its key", () => {
		const empty = step(null, [], null);
		expect(fresh(step(empty, ["u1"], "thread-new"))).toEqual(["u1"]);
	});

	it("does not animate older pages prepended above the transcript", () => {
		const loaded = step(null, ["u3", "a3"]);
		expect(fresh(step(loaded, ["u1", "a1", "u2", "a2", "u3", "a3"]))).toEqual(
			[]
		);
	});

	it("settles on a thread switch or a wholesale replacement", () => {
		const sent = step(step(null, ["u1"]), ["u1", "u2"]);
		expect(fresh(step(sent, ["x1", "x2"], "thread-2"))).toEqual([]);
		expect(fresh(step(sent, ["x1", "x2"]))).toEqual([]);
	});

	it("does not replay when an optimistic id is swapped for its persisted one", () => {
		const replied = step(step(step(null, ["u1"]), ["u1", "u2"]), [
			"u1",
			"u2",
			"a2",
		]);
		expect(fresh(step(replied, ["u1", "u2-persisted", "a2"]))).toEqual(["a2"]);
	});

	it("treats a large backlog arriving at once as a load", () => {
		const loaded = step(null, ["u1"]);
		const backlog = Array.from(
			{ length: MAX_FRESH_PER_UPDATE + 1 },
			(_, index) => `m${index}`
		);
		expect(fresh(step(loaded, ["u1", ...backlog]))).toEqual([]);
		expect(fresh(step(step(null, []), backlog))).toEqual([]);
	});
});
