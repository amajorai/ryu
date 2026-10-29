import { describe, expect, test } from "bun:test";
import type { UIMessage } from "ai";
import {
	extractWorkflowRun,
	isWorkflowRunProgress,
} from "./workflow-run-data.ts";

const run = {
	id: "workflow-run",
	nodes: [{ id: "ask", kind: "approval", status: "completed" as const }],
	runId: "run-1",
	status: "awaiting_input" as const,
	workflowId: "workflow-1",
	workflowName: "Review",
};

describe("workflow run stream data", () => {
	test("extracts the newest frame when the SDK gives an array", () => {
		const message = {
			parts: [
				{
					data: [{ ...run, status: "running" as const }, run],
					type: "data-ryu-workflow" as const,
				},
			],
		} satisfies Pick<UIMessage, "parts">;

		expect(extractWorkflowRun(message)).toEqual(run);
	});

	test("rejects malformed stream data instead of rendering a partial card", () => {
		const malformed = { ...run, nodes: [{ id: "ask", status: "unknown" }] };

		expect(isWorkflowRunProgress(malformed)).toBe(false);
		expect(
			extractWorkflowRun({
				parts: [{ data: malformed, type: "data-ryu-workflow" }],
			})
		).toBeNull();
	});
});

describe("complete native workflow node fields", () => {
	test("retains complete native publisher frames and nested metadata by reference", () => {
		const complete = {
			...run,
			metadata: { future: "retained" },
			nodes: [
				{
					id: "ask",
					kind: "approval",
					status: "failed" as const,
					error: "approval refused",
					output: "full output",
					metadata: { future: 1 },
				},
			],
		};
		const message = {
			parts: [{ type: "data-ryu-workflow" as const, data: complete }],
		};
		expect(extractWorkflowRun(message)).toBe(complete);
		expect(extractWorkflowRun(message)?.nodes[0]).toBe(complete.nodes[0]);
	});
	test("accepts nullable native fields and older omitted node details", () => {
		for (const status of [
			"pending",
			"running",
			"completed",
			"failed",
			"skipped",
		] as const) {
			const complete = {
				...run,
				nodes: [{ id: "ask", status, error: null, kind: null, output: null }],
			};
			expect(isWorkflowRunProgress(complete)).toBe(true);
		}
		expect(isWorkflowRunProgress(run)).toBe(true);
	});
	test("rejects malformed optional node fields before they reach the card", () => {
		for (const details of [
			{ error: { message: "not text" } },
			{ kind: ["approval"] },
			{ output: 42 },
		]) {
			const malformed = {
				...run,
				nodes: [{ id: "ask", status: "completed", ...details }],
			};
			expect(isWorkflowRunProgress(malformed)).toBe(false);
			expect(
				extractWorkflowRun({
					parts: [{ type: "data-ryu-workflow", data: malformed }],
				})
			).toBeNull();
		}
	});
});
