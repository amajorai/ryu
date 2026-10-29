import { describe, expect, it } from "bun:test";
import { deriveTodoProgress } from "./todo-progress.ts";

describe("deriveTodoProgress", () => {
	it("uses the newest valid TodoWrite snapshot", () => {
		const result = deriveTodoProgress([
			{
				role: "assistant",
				parts: [
					{
						type: "tool-TodoWrite",
						input: {
							todos: [{ content: "Old", status: "pending" }],
						},
					},
				],
			},
			{
				role: "assistant",
				parts: [
					{
						type: "tool-TodoWrite",
						input: {
							todos: [
								{ content: " Inspect ", status: "completed" },
								{ content: "Build", status: "in_progress" },
								{ content: "Verify", status: "pending" },
							],
						},
					},
				],
			},
		]);

		expect(result).toEqual({
			completed: 1,
			current: 2,
			hasInProgress: true,
			isComplete: false,
			items: [
				{ label: "Inspect", status: "completed" },
				{ label: "Build", status: "in_progress" },
				{ label: "Verify", status: "pending" },
			],
			percentage: 33,
			total: 3,
		});
	});

	it("supports dynamic TodoWrite parts and clears on an empty snapshot", () => {
		const dynamic = deriveTodoProgress([
			{
				parts: [
					{
						type: "dynamic-tool",
						toolName: "TodoWrite",
						input: {
							todos: [{ content: "Done", status: "completed" }],
						},
					},
				],
			},
		]);
		const cleared = deriveTodoProgress([
			{
				parts: [{ type: "tool-TodoWrite", input: { todos: [] } }],
			},
		]);

		expect(dynamic?.isComplete).toBe(true);
		expect(dynamic?.percentage).toBe(100);
		expect(cleared).toBeUndefined();
	});

	it("uses output todos when input is not available", () => {
		const result = deriveTodoProgress([
			{
				parts: [
					{
						type: "tool-TodoWrite",
						output: {
							newTodos: [{ content: "Done", status: "completed" }],
						},
					},
				],
			},
		]);

		expect(result?.items).toEqual([{ label: "Done", status: "completed" }]);
	});

	it("ignores malformed todo entries and does not invent progress", () => {
		expect(
			deriveTodoProgress([
				{
					parts: [
						{
							type: "tool-TodoWrite",
							input: {
								todos: [null, { status: "wat" }, { content: "   " }],
							},
						},
					],
				},
			])
		).toBeUndefined();
		expect(
			deriveTodoProgress([{ parts: [{ type: "tool-Read", input: {} }] }])
		).toBeUndefined();
	});
});

it("keeps live optional metadata and future JSON without widening todo statuses", () => {
	const future = JSON.parse('{"__proto__":{"owner":"future"},"revision":2}');
	const item = {
		content: " Validate ",
		status: "pending",
		optional: undefined,
		future,
	};
	const input = {
		todos: [null, item, { content: "Unknown", status: "future_status" }],
		optional: undefined,
	};
	const part = { type: "dynamic-tool", toolName: "TodoWrite", input, future };
	const result = deriveTodoProgress([{ parts: [part] }]);
	expect(result?.items).toEqual([{ label: "Validate", status: "pending" }]);
	expect(result?.percentage).toBe(0);
	expect(part.input).toBe(input);
	expect(item.future).toBe(future);
});
