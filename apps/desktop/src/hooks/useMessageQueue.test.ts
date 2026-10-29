// The composer queue's drain rule, tested without a renderer.
//
// It is the rule the "messages queue forever after a turn errors" trap lived
// in: `useChat` parks at `"error"` and never walks back to `"ready"`, so a
// drain that waited for a ready-transition stranded every message typed after a
// failure — with a "send now" button whose `stop()` had nothing to stop. The
// hook itself needs React; this predicate does not, so the rule that decides
// whether a turn is dispatched is covered here directly.

import { describe, expect, it } from "bun:test";
import type { ChatStatus } from "ai";
import {
	isTerminalChatStatus,
	shouldDrainQueue,
} from "@/src/hooks/useMessageQueue.ts";

function signal(
	partial: Partial<{
		blocked: boolean;
		prevQueueLen: number;
		prevStatus: ChatStatus;
		queueLen: number;
		status: ChatStatus;
	}> = {}
) {
	return {
		status: "ready" as const,
		prevStatus: "streaming" as const,
		queueLen: 1,
		prevQueueLen: 1,
		blocked: false,
		...partial,
	};
}

describe("isTerminalChatStatus", () => {
	it("counts an errored turn as finished, alongside ready", () => {
		expect(isTerminalChatStatus("ready")).toBe(true);
		expect(isTerminalChatStatus("error")).toBe(true);
		expect(isTerminalChatStatus("streaming")).toBe(false);
		expect(isTerminalChatStatus("submitted")).toBe(false);
	});
});

describe("shouldDrainQueue", () => {
	it("drains on the classic busy → ready edge", () => {
		expect(
			shouldDrainQueue(signal({ status: "ready", prevStatus: "streaming" }))
		).toBe(true);
	});

	it("drains when a turn ERRORS — the failure is terminal", () => {
		expect(
			shouldDrainQueue(signal({ status: "error", prevStatus: "streaming" }))
		).toBe(true);
	});

	it("drains a message enqueued while already parked in error", () => {
		// No status edge is coming: the turn errored before the user typed.
		expect(
			shouldDrainQueue(
				signal({
					status: "error",
					prevStatus: "error",
					queueLen: 1,
					prevQueueLen: 0,
				})
			)
		).toBe(true);
	});

	it("does not re-dispatch on a re-render in the error state", () => {
		expect(
			shouldDrainQueue(
				signal({
					status: "error",
					prevStatus: "error",
					queueLen: 2,
					prevQueueLen: 2,
				})
			)
		).toBe(false);
	});

	it("does not dispatch on a re-render in the ready state", () => {
		// The ready path keeps its edge-only semantics: nothing enqueues while an
		// idle composer can send straight through.
		expect(
			shouldDrainQueue(
				signal({
					status: "ready",
					prevStatus: "ready",
					queueLen: 2,
					prevQueueLen: 1,
				})
			)
		).toBe(false);
	});

	it("drains when a recovered chat returns error → ready", () => {
		// `clearError()` on re-hydration is a real transition, and the queue that
		// built up during the failure has to go somewhere.
		expect(
			shouldDrainQueue(signal({ status: "ready", prevStatus: "error" }))
		).toBe(true);
	});

	it("never dispatches while a turn is in flight", () => {
		expect(
			shouldDrainQueue(signal({ status: "streaming", prevStatus: "ready" }))
		).toBe(false);
		expect(
			shouldDrainQueue(signal({ status: "submitted", prevStatus: "ready" }))
		).toBe(false);
	});

	it("stays suspended while the node is unreachable", () => {
		// Otherwise a persistently-down Core would drain the whole queue into
		// failures the moment the first turn errored.
		expect(
			shouldDrainQueue(
				signal({ status: "error", prevStatus: "streaming", blocked: true })
			)
		).toBe(false);
		expect(
			shouldDrainQueue(
				signal({
					status: "error",
					prevStatus: "error",
					queueLen: 1,
					prevQueueLen: 0,
					blocked: true,
				})
			)
		).toBe(false);
	});

	it("does nothing with an empty queue", () => {
		expect(
			shouldDrainQueue(
				signal({ status: "error", prevStatus: "streaming", queueLen: 0 })
			)
		).toBe(false);
	});
});
