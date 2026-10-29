import { describe, expect, it } from "bun:test";
import type { UIMessage } from "ai";
import {
	formatGoalElapsed,
	getGoalElapsedMs,
	isGoalMessage,
} from "./goal-message.ts";

function message(metadata?: UIMessage["metadata"]): UIMessage {
	return {
		id: "message",
		metadata,
		parts: [{ text: "Finish the task", type: "text" }],
		role: "user",
	};
}

describe("goal message metadata", () => {
	it("recognizes goal-setting messages", () => {
		expect(isGoalMessage(message({ goal: true }))).toBe(true);
	});

	it("ignores ordinary and malformed metadata", () => {
		expect(isGoalMessage(message())).toBe(false);
		expect(isGoalMessage(message({ goal: false }))).toBe(false);
		expect(isGoalMessage(message({ goal: "true" }))).toBe(false);
		expect(isGoalMessage(message("goal"))).toBe(false);
	});
});

describe("goal completion timing", () => {
	it("formats the compact duration used in the ending-turn status", () => {
		expect(formatGoalElapsed(4 * 60 * 60 * 1000 + 2 * 1000)).toBe("4h 2s");
		expect(formatGoalElapsed(3 * 60 * 1000 + 5 * 1000)).toBe("3m 5s");
		expect(formatGoalElapsed(8 * 1000)).toBe("8s");
	});

	it("uses the persisted achieved time when available", () => {
		const startedAt = 1_000_000;
		expect(
			getGoalElapsedMs(
				{ achievedAt: startedAt + 4002, startedAt },
				startedAt + 99_999
			)
		).toBe(4002);
	});
});
