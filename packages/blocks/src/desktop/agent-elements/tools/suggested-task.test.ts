import { describe, expect, test } from "bun:test";
import {
	isSuggestTaskPart,
	latestSuggestedTask,
	suggestedTaskFromInput,
} from "./suggested-task.ts";

const input = {
	title: "Answer step-up email cooldown with 429, not 500",
	description: "The cooldown error escapes as a 500.",
	prompt: "Map the per-recipient cooldown error to a 429 with the wait time.",
};

function suggestPart(overrides: Record<string, unknown> = {}) {
	return {
		type: "dynamic-tool",
		toolName: "tasks.suggest",
		toolCallId: "call-1",
		state: "output-available",
		input,
		...overrides,
	};
}

describe("isSuggestTaskPart", () => {
	test("matches the typed and dynamic forms only", () => {
		expect(isSuggestTaskPart("tool-tasks.suggest", undefined)).toBe(true);
		expect(isSuggestTaskPart("dynamic-tool", "tasks.suggest")).toBe(true);
		expect(isSuggestTaskPart("dynamic-tool", "other.suggest")).toBe(false);
		expect(isSuggestTaskPart("tool-suggest", undefined)).toBe(false);
	});
});

describe("suggestedTaskFromInput", () => {
	test("trims and keeps a valid suggestion", () => {
		expect(
			suggestedTaskFromInput("id", { ...input, title: `  ${input.title}  ` })
		).toEqual({ id: "id", ...input });
	});

	test("rejects blank, missing and overlong fields like Core does", () => {
		expect(suggestedTaskFromInput("id", { ...input, title: "  " })).toBeNull();
		expect(
			suggestedTaskFromInput("id", { title: input.title, prompt: input.prompt })
		).toBeNull();
		expect(
			suggestedTaskFromInput("id", { ...input, title: "a".repeat(81) })
		).toBeNull();
		// Core counts scalar values, so 80 emoji is still within the limit.
		expect(
			suggestedTaskFromInput("id", { ...input, title: "🙂".repeat(80) })
		).not.toBeNull();
	});
});

describe("latestSuggestedTask", () => {
	test("returns the suggestion from the newest assistant message", () => {
		const task = latestSuggestedTask([
			{ role: "user", parts: [{ type: "text", text: "fix it" }] },
			{ role: "assistant", parts: [{ type: "text" }, suggestPart()] },
		]);
		expect(task?.id).toBe("call-1");
		expect(task?.title).toBe(input.title);
	});

	test("goes stale once the conversation moves on", () => {
		expect(
			latestSuggestedTask([
				{ role: "assistant", parts: [suggestPart()] },
				{ role: "user", parts: [{ type: "text", text: "next" }] },
			])
		).toBeNull();
	});

	test("ignores rejected, streaming, and dismissed calls", () => {
		const messages = (part: Record<string, unknown>) => [
			{ role: "assistant", parts: [suggestPart(part)] },
		];
		expect(latestSuggestedTask(messages({ state: "output-error" }))).toBeNull();
		expect(
			latestSuggestedTask(messages({ state: "input-streaming" }))
		).toBeNull();
		expect(latestSuggestedTask(messages({}), new Set(["call-1"]))).toBeNull();
		expect(latestSuggestedTask(messages({ toolCallId: "" }))).toBeNull();
	});

	test("picks the last valid call when a turn made more than one", () => {
		const task = latestSuggestedTask([
			{
				role: "assistant",
				parts: [
					suggestPart({ toolCallId: "first" }),
					suggestPart({ toolCallId: "second" }),
					suggestPart({ toolCallId: "broken", input: { title: "x" } }),
				],
			},
		]);
		expect(task?.id).toBe("second");
	});

	test("shows nothing for a turn without a suggestion", () => {
		expect(
			latestSuggestedTask([{ role: "assistant", parts: [{ type: "text" }] }])
		).toBeNull();
		expect(latestSuggestedTask([])).toBeNull();
	});
});
