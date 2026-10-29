import { describe, expect, it } from "bun:test";
import { mergeResumedTurnMessage } from "./resume-merge.ts";
import type { NativeSdkValue } from "./utils/native-sdk-observation.ts";

describe("mergeResumedTurnMessage", () => {
	it("replaces the persisted parts with a replayed turn", () => {
		// The persisted row lags the live turn by up to one checkpoint; the replay
		// starts at the turn's first chunk, so it is the complete, newer state.
		const resumed = [
			{ type: "tool-Thinking", toolCallId: "t-0", state: "output-available" },
			{ type: "text", text: "partial and then some" },
			{ type: "tool-Bash", toolCallId: "b-1", state: "input-available" },
		];
		const merged = mergeResumedTurnMessage(
			{
				id: "m1",
				role: "assistant",
				parts: [
					{
						type: "tool-Thinking",
						toolCallId: "t-0",
						state: "input-streaming",
					},
					{ type: "text", text: "partial" },
				],
			},
			resumed,
			true
		);
		expect(merged.parts).toEqual(resumed);
		expect(merged.id).toBe("m1");
		expect(merged.role).toBe("assistant");
	});

	it("appends when Core could not replay the turn", () => {
		const persisted: { id: string; parts: NativeSdkValue[] } = {
			id: "m2",
			parts: [{ type: "tool-Bash", toolCallId: "b-1" }],
		};
		const merged = mergeResumedTurnMessage(
			persisted,
			[{ type: "text", text: "tail" }],
			false
		);
		const expectedParts: NativeSdkValue[] = [
			{ type: "tool-Bash", toolCallId: "b-1" },
			{ type: "text", text: "tail" },
		];
		expect(merged.parts).toEqual(expectedParts);
	});

	it("clears the interrupted flag a live reattach has just disproved", () => {
		const merged = mergeResumedTurnMessage(
			{ id: "m3", _interrupted: true, parts: [] },
			[{ type: "text", text: "still going" }],
			true
		);
		expect(merged._interrupted).toBe(false);
	});
});
