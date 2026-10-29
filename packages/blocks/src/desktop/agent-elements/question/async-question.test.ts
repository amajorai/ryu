import { describe, expect, it } from "bun:test";
import {
	answeredQuestionIds,
	formatAsyncQuestionAnswer,
	isAsyncQuestionPart,
	isQuestionPartOpen,
	stripQuestionAnswerMarkers,
} from "./async-question.ts";

const questions = [
	{
		kind: "single" as const,
		options: [
			{ id: "pg", label: "Postgres" },
			{ id: "sqlite", label: "SQLite" },
		],
		title: "Which database?",
	},
];

describe("async questions", () => {
	it("treats agent-marked and Core-released cards as async", () => {
		expect(isAsyncQuestionPart({ input: { async: true } })).toBe(true);
		expect(
			isAsyncQuestionPart({
				output: { output: { deferred: true }, status: "completed" },
			})
		).toBe(true);
		expect(isAsyncQuestionPart({ input: {} })).toBe(false);
	});

	it("keeps an async card open after its tool call completed", () => {
		const part = {
			input: { async: true },
			output: { output: { deferred: true }, status: "completed" },
			toolCallId: "ask-1",
		};
		expect(isQuestionPartOpen(part, new Set())).toBe(true);
		expect(isQuestionPartOpen(part, new Set(["ask-1"]))).toBe(false);
	});

	it("closes a blocking card once its tool call has output", () => {
		expect(isQuestionPartOpen({ toolCallId: "q" }, new Set())).toBe(true);
		expect(
			isQuestionPartOpen(
				{ output: { status: "completed" }, toolCallId: "q" },
				new Set()
			)
		).toBe(false);
		expect(
			isQuestionPartOpen(
				{ output: { output: { answers: [] }, status: "completed" } },
				new Set()
			)
		).toBe(false);
	});

	it("round-trips the answer marker through a user message", () => {
		const content = formatAsyncQuestionAnswer("ask-7", questions, [
			{ kind: "single", selectedIds: ["pg"] },
		]);
		expect(content).toContain("- Which database?: Postgres");
		expect(
			answeredQuestionIds([
				{ parts: [{ text: content, type: "text" }], role: "user" },
			])
		).toEqual(new Set(["ask-7"]));
		expect(stripQuestionAnswerMarkers(content)).not.toContain(
			"ryu-question-answer"
		);
	});

	it("ignores markers in assistant messages", () => {
		const content = formatAsyncQuestionAnswer("ask-8", questions, [
			{ kind: "skip" },
		]);
		expect(
			answeredQuestionIds([
				{ parts: [{ text: content, type: "text" }], role: "assistant" },
			]).size
		).toBe(0);
	});
});
