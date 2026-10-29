import { expect, test } from "bun:test";
import {
	appendContinuationText,
	appendErrorPart,
	appendReasoningPart,
	appendTextPart,
	appendToolInputPart,
	appendToolOutputPart,
	type ChatPart,
	chatPartsSchema,
	closeReasoningPart,
	readTodos,
	replaceTodoPart,
	settleRunningToolParts,
	toolStatus,
} from "../core/chatTranscript.ts";

test("keeps text, reasoning, tool status, and todo snapshots typed", () => {
	let parts = appendTextPart([], "answer");
	parts = appendReasoningPart(parts, "first", 1000);
	parts = appendReasoningPart(parts, " second", 1500);
	parts = appendToolInputPart(
		parts,
		"search",
		{ query: "ryu" },
		"tool-1",
		5200
	);
	parts = appendToolOutputPart(parts, "ok", { count: 3 }, "tool-1", 5500);
	parts = replaceTodoPart(parts, [
		{ content: "Inspect", status: "completed" },
		{ content: "Ship", status: "in_progress" },
	]);

	expect(parts).toEqual([
		{ type: "text", text: "answer" },
		{
			type: "reasoning",
			text: "first second",
			startedAt: 1000,
			endedAt: 5200,
		},
		{
			type: "tool",
			toolCallId: "tool-1",
			name: "search",
			status: "success",
			args: { query: "ryu" },
			result: { count: 3 },
			startedAt: 5200,
			endedAt: 5500,
		},
		{
			type: "todo",
			todos: [
				{ content: "Inspect", status: "completed" },
				{ content: "Ship", status: "in_progress" },
			],
		},
	]);
});

test("correlates interleaved tool outputs by tool call id", () => {
	let parts = appendToolInputPart([], "first", undefined, "call-1", 10);
	parts = appendToolInputPart(parts, "second", undefined, "call-2", 20);
	parts = appendToolOutputPart(parts, "ok", { result: 1 }, "call-1", 30);
	parts = appendToolOutputPart(parts, "error", { result: 2 }, "call-2", 40);

	expect(parts).toEqual([
		{
			type: "tool",
			toolCallId: "call-1",
			name: "first",
			status: "success",
			result: { result: 1 },
			startedAt: 10,
			endedAt: 30,
		},
		{
			type: "tool",
			toolCallId: "call-2",
			name: "second",
			status: "error",
			result: { result: 2 },
			startedAt: 20,
			endedAt: 40,
		},
	]);
});

test("filters malformed todo entries without losing valid plan items", () => {
	expect(
		readTodos({
			todos: [
				{ content: "valid", status: "pending" },
				null,
				{ content: 42, status: "pending" },
			],
		})
	).toEqual([{ content: "valid", status: "pending" }]);
});

test("applies interleaved tool results to their exact call IDs", () => {
	let parts = appendToolInputPart([], "first", undefined, "call-1", 1);
	parts = appendToolInputPart(parts, "second", undefined, "call-2", 2);
	parts = appendToolOutputPart(parts, "ok", { value: 1 }, "call-1", 3);

	expect(parts).toEqual([
		{
			type: "tool",
			toolCallId: "call-1",
			name: "first",
			status: "success",
			result: { value: 1 },
			startedAt: 1,
			endedAt: 3,
		},
		{
			type: "tool",
			toolCallId: "call-2",
			name: "second",
			status: "running",
			startedAt: 2,
		},
	]);
});

test("keeps a tool's start across re-emitted input and settles it once", () => {
	let parts = appendToolInputPart([], "Read", undefined, "call-1", 100);
	parts = appendToolInputPart(
		parts,
		"Read",
		{ file_path: "src/index.ts" },
		"call-1",
		400
	);
	expect(parts).toEqual([
		{
			type: "tool",
			toolCallId: "call-1",
			name: "Read",
			status: "running",
			args: { file_path: "src/index.ts" },
			startedAt: 100,
		},
	]);
	parts = appendToolOutputPart(parts, "in_progress", undefined, "call-1", 450);
	expect(parts[0]).not.toHaveProperty("endedAt");
	parts = appendToolOutputPart(parts, "completed", "ok", "call-1", 700);
	parts = appendToolOutputPart(parts, "completed", "ok again", "call-1", 9000);
	expect(parts[0]).toMatchObject({
		status: "success",
		result: "ok again",
		startedAt: 100,
		endedAt: 700,
	});
});

test("a bare input re-emission keeps the args already recorded", () => {
	let parts = appendToolInputPart(
		[],
		"Bash",
		{ command: "bun test" },
		"call-1",
		100
	);
	parts = appendToolInputPart(parts, "Bash", undefined, "call-1", 200);
	expect(parts[0]).toMatchObject({
		args: { command: "bun test" },
		startedAt: 100,
	});
});

test("legacy tool parts without timestamps still parse", () => {
	const parsed = chatPartsSchema.safeParse([
		{ type: "tool", name: "Bash", status: "success" },
	]);
	expect(parsed.success).toBe(true);
});

test("records reasoning start and closes it on the following text part", () => {
	let parts = appendReasoningPart([], "**Plan** step", 100);
	parts = appendReasoningPart(parts, " more", 900);
	expect(parts).toEqual([
		{ type: "reasoning", text: "**Plan** step more", startedAt: 100 },
	]);
	parts = appendTextPart(parts, "Answer", 4300);
	parts = appendTextPart(parts, " continues", 9000);
	expect(parts).toEqual([
		{
			type: "reasoning",
			text: "**Plan** step more",
			startedAt: 100,
			endedAt: 4300,
		},
		{ type: "text", text: "Answer continues" },
	]);
});

test("closes trailing reasoning on todo updates and turn settlement only once", () => {
	const todoParts = replaceTodoPart(
		appendReasoningPart([], "plan", 10),
		[{ content: "Ship", status: "pending" }],
		70
	);
	expect(todoParts[0]).toEqual({
		type: "reasoning",
		text: "plan",
		startedAt: 10,
		endedAt: 70,
	});

	const settled = closeReasoningPart(appendReasoningPart([], "solo", 5), 50);
	expect(settled).toEqual([
		{ type: "reasoning", text: "solo", startedAt: 5, endedAt: 50 },
	]);
	expect(closeReasoningPart(settled, 999)).toBe(settled);
	// Reasoning after a closed block starts a new timed part.
	expect(appendReasoningPart(settled, "again", 60).at(-1)).toEqual({
		type: "reasoning",
		text: "again",
		startedAt: 60,
	});
});

test("legacy reasoning parts without timestamps still parse", () => {
	const parsed = chatPartsSchema.parse([{ type: "reasoning", text: "old" }]);
	expect(parsed).toEqual([{ type: "reasoning", text: "old" }]);
	// A stamp that is not a number is dropped; the part itself still parses.
	expect(
		chatPartsSchema.parse([
			{ type: "reasoning", text: "bad", startedAt: "soon" },
		])[0]?.startedAt
	).toBeUndefined();
});

test("settles running and pending tools for each turn outcome", () => {
	const parts: ChatPart[] = [
		{
			type: "tool",
			toolCallId: "run",
			name: "Bash",
			status: "running",
			startedAt: 1000,
		},
		{ type: "tool", toolCallId: "wait", name: "Read", status: "pending" },
		{
			type: "tool",
			toolCallId: "ok",
			name: "Grep",
			status: "success",
			result: "hits",
			startedAt: 1000,
			endedAt: 1100,
		},
		{
			type: "tool",
			toolCallId: "bad",
			name: "Edit",
			status: "error",
			result: "denied by fs",
			startedAt: 1000,
			endedAt: 1200,
		},
		{ type: "text", text: "after" },
	];
	for (const outcome of ["interrupted", "error", "success"] as const) {
		const settled = settleRunningToolParts(parts, outcome, "stream lost", 1500);
		expect(settled[0]).toEqual({
			type: "tool",
			toolCallId: "run",
			name: "Bash",
			status: outcome,
			startedAt: 1000,
			endedAt: 1500,
			result: "stream lost",
		});
		// Legacy parts without a start keep no fabricated duration.
		expect(settled[1]).toEqual({
			type: "tool",
			toolCallId: "wait",
			name: "Read",
			status: outcome,
			result: "stream lost",
		});
		expect(settled.slice(2)).toEqual(parts.slice(2));
		expect(settled[2]).toBe(parts[2]);
		expect(settled[3]).toBe(parts[3]);
	}
	const kept = settleRunningToolParts(
		[{ type: "tool", name: "Bash", status: "running", result: "partial" }],
		"error",
		"boom"
	);
	expect(kept[0]).toMatchObject({ status: "error", result: "partial" });
	const settledOnly = parts.slice(2);
	expect(settleRunningToolParts(settledOnly, "interrupted")).toBe(settledOnly);
});

test("maps rejected and aborted tool statuses and keeps a denial sticky", () => {
	expect(toolStatus("rejected")).toBe("denied");
	expect(toolStatus("aborted")).toBe("interrupted");
	expect(toolStatus("cancelled")).toBe("interrupted");
	expect(toolStatus("canceled")).toBe("interrupted");
	const running = appendToolInputPart(
		[],
		"Bash",
		{ command: "rm -rf" },
		"c",
		10
	);
	const denied = appendToolOutputPart(running, "denied", undefined, "c", 20);
	expect(denied[0]).toMatchObject({ status: "denied", endedAt: 20 });
	const refused = appendToolOutputPart(
		denied,
		"error",
		"user refused",
		"c",
		30
	);
	expect(refused[0]).toMatchObject({
		status: "denied",
		endedAt: 20,
		result: "user refused",
	});
	expect(
		chatPartsSchema.safeParse([
			{ type: "tool", name: "Bash", status: "interrupted" },
			{ type: "tool", name: "Edit", status: "denied" },
		]).success
	).toBe(true);
});

test("records a turn failure as an error part, separate from the text", () => {
	const streamed = appendReasoningPart(
		appendTextPart([], "Partial"),
		"why",
		10
	);
	const failed = appendErrorPart(
		streamed,
		"  HTTP 503 · upstream overloaded ",
		40
	);
	expect(failed).toEqual([
		{ type: "text", text: "Partial" },
		{ type: "reasoning", text: "why", startedAt: 10, endedAt: 40 },
		{ type: "error", message: "HTTP 503 · upstream overloaded" },
	]);
	// Later text starts a fresh part rather than merging into the error.
	expect(appendTextPart(failed, "more").at(-1)).toEqual({
		type: "text",
		text: "more",
	});
	expect(appendErrorPart(failed, "   ")).toBe(failed);
	expect(chatPartsSchema.parse(failed)).toEqual(failed);
});

test("a mistyped timing stamp drops the stamp, not the whole transcript", () => {
	const parsed = chatPartsSchema.parse([
		{ type: "reasoning", text: "why", startedAt: "2026-01-01T00:00:00Z" },
		{
			type: "tool",
			name: "Read",
			status: "success",
			startedAt: 10,
			endedAt: null,
		},
	]);
	expect(parsed[0]).toMatchObject({ type: "reasoning", text: "why" });
	expect(parsed[0]).not.toHaveProperty("startedAt", "2026-01-01T00:00:00Z");
	expect(parsed[1]).toMatchObject({ type: "tool", startedAt: 10 });
	expect(parsed[1]).not.toHaveProperty("endedAt", null);
});

test("continuation text opens a new paragraph without touching earlier parts", () => {
	const first = {
		content: "Done step A.",
		parts: appendTextPart([], "Done step A."),
	};
	expect(appendContinuationText(first, "Now step B", 10)).toEqual({
		content: "Done step A.\n\nNow step B",
		parts: [{ type: "text", text: "Done step A.\n\nNow step B" }],
	});

	// After a tool row the continuation is already its own text part; only the
	// history content needs the break.
	const afterTool = {
		content: "Done step A.",
		parts: appendToolInputPart(first.parts, "Read", undefined, "t1", 20),
	};
	const continued = appendContinuationText(afterTool, "Now step B", 30);
	expect(continued.content).toBe("Done step A.\n\nNow step B");
	expect(continued.parts.at(-1)).toEqual({ type: "text", text: "Now step B" });

	// Nothing before it, or a paragraph break already there: no extra break.
	const empty = { content: "", parts: [] };
	expect(appendContinuationText(empty, "Now", 40).content).toBe("Now");
	const brokenAlready = {
		content: "A.\n\n",
		parts: appendTextPart([], "A.\n\n"),
	};
	expect(appendContinuationText(brokenAlready, "B", 50).content).toBe(
		"A.\n\nB"
	);
});
