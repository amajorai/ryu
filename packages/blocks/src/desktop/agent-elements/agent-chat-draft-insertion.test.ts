import { describe, expect, test } from "bun:test";
import {
	appendDraftInsertion,
	mergeDraftSeedWithInsertions,
} from "./agent-chat.tsx";

describe("appendDraftInsertion", () => {
	test("adds captured context after an existing composer draft", () => {
		expect(
			appendDraftInsertion("Help me debug this", "Captured activity")
		).toBe("Help me debug this\n\nCaptured activity");
	});

	test("keeps an empty composer as the captured context draft", () => {
		expect(appendDraftInsertion("", "Captured activity")).toBe(
			"Captured activity"
		);
	});

	test("does not change a draft for blank insertion text", () => {
		expect(appendDraftInsertion("Existing draft", "  \n ")).toBe(
			"Existing draft"
		);
	});

	test("keeps a restored draft when context arrives before the async restore", () => {
		expect(
			mergeDraftSeedWithInsertions("Saved draft", ["Captured activity"])
		).toBe("Saved draft\n\nCaptured activity");
	});
});
