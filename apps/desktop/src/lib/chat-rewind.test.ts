import { describe, expect, test } from "bun:test";
import type { ChatCheckpoint } from "@/src/lib/api/chat-checkpoints.ts";
import { pickInitialCheckpoint } from "@/src/lib/chat-rewind.ts";

function checkpoint(overrides: Partial<ChatCheckpoint>): ChatCheckpoint {
	return {
		createdAt: "2026-10-12T00:00:00.000Z",
		hasFiles: true,
		id: "cp",
		kind: "turn",
		messageId: null,
		preview: null,
		skipReason: null,
		workspace: "/work",
		...overrides,
	};
}

// Newest first, as Core lists them.
const checkpoints = [
	checkpoint({ id: "undo", kind: "preRestore", messageId: "m2" }),
	checkpoint({ id: "second", messageId: "m2", preview: "Add tests…" }),
	checkpoint({ id: "first", messageId: "m1", preview: "Fix the bug" }),
];

describe("pickInitialCheckpoint", () => {
	test("selects the turn checkpoint of a persisted message id", () => {
		expect(pickInitialCheckpoint(checkpoints, { messageId: "m2" })).toBe(
			"second"
		);
	});

	test("matches a client-only message by its text", () => {
		expect(
			pickInitialCheckpoint(checkpoints, {
				messageId: "client-id",
				text: "Add tests for the parser",
			})
		).toBe("second");
		expect(
			pickInitialCheckpoint(checkpoints, { text: "  Fix the bug  " })
		).toBe("first");
	});

	test("falls back to the newest checkpoint", () => {
		expect(pickInitialCheckpoint(checkpoints, null)).toBe("undo");
		expect(pickInitialCheckpoint(checkpoints, { text: "unrelated" })).toBe(
			"undo"
		);
		expect(pickInitialCheckpoint([], { messageId: "m1" })).toBeNull();
	});
});
