// packages/core-client/src/workflows.test.ts
//
// Tests for the DAG workflow client. Two things carry real logic here and both
// are covered against a stubbed fetch:
//   1. The Core error envelope. Unlike the shared `request` helper (which throws
//      only the status), these endpoints read `{ success:false, error }` out of
//      the body so a DAG validation failure (cycle / unknown node) reaches the UI
//      verbatim, with a status-code fallback when the body isn't a JSON error.
//   2. The snake_case wire → camelCase mapping (`toWorkflow` / `toRun`), which
//      fills every optional field with a default so the canvas never sees
//      `undefined`.

import { afterEach, describe, expect, test } from "bun:test";
import type { ApiTarget } from "./client.ts";
import { createWorkflow, fetchWorkflows, getWorkflowRun } from "./workflows.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

const target: ApiTarget = { url: "http://127.0.0.1:7980", token: "t" };

function stub(bodyText: string, status = 200): void {
	globalThis.fetch = (() =>
		Promise.resolve(new Response(bodyText, { status }))) as typeof fetch;
}

describe("workflow error envelope", () => {
	test("createWorkflow surfaces the Core validation error verbatim", async () => {
		stub(
			JSON.stringify({ success: false, error: "cycle detected: a→b→a" }),
			400
		);
		await expect(createWorkflow(target, {})).rejects.toThrow(
			"cycle detected: a→b→a"
		);
	});

	test("createWorkflow falls back to the status when error is empty", async () => {
		stub(JSON.stringify({ success: false, error: "" }), 400);
		await expect(createWorkflow(target, {})).rejects.toThrow(
			"/workflows failed: 400"
		);
	});

	test("createWorkflow falls back to the status when the body has no error", async () => {
		stub("{}", 500);
		await expect(createWorkflow(target, {})).rejects.toThrow(
			"/workflows failed: 500"
		);
	});

	test("fetchWorkflows falls back to the status on a non-JSON error body", async () => {
		stub("<html>502 Bad Gateway</html>", 502);
		await expect(fetchWorkflows(target)).rejects.toThrow(
			"/workflows failed: 502"
		);
	});
});

describe("wire → camel mapping", () => {
	test("toWorkflow fills every optional field with a default", async () => {
		stub(JSON.stringify({ workflows: [{ id: "w1", name: "Flow" }] }));
		const [wf] = await fetchWorkflows(target);
		expect(wf).toEqual({
			id: "w1",
			name: "Flow",
			description: null,
			nodes: [],
			edges: [],
			triggers: [],
			createdAt: null,
			updatedAt: null,
		});
	});

	test("toWorkflow renames snake_case timestamps to camelCase", async () => {
		stub(
			JSON.stringify({
				workflows: [
					{
						id: "w1",
						name: "Flow",
						description: "d",
						nodes: [{ id: "n1", type: "prompt" }],
						edges: [{ from: "n1", to: "n2" }],
						triggers: [{ type: "manual" }],
						created_at: "2026-01-01",
						updated_at: "2026-01-02",
					},
				],
			})
		);
		const [wf] = await fetchWorkflows(target);
		expect(wf.createdAt).toBe("2026-01-01");
		expect(wf.updatedAt).toBe("2026-01-02");
		expect(wf.nodes).toEqual([{ id: "n1", type: "prompt" }]);
		expect(wf.triggers).toEqual([{ type: "manual" }]);
	});

	test("fetchWorkflows defaults a missing list to []", async () => {
		stub("{}");
		expect(await fetchWorkflows(target)).toEqual([]);
	});

	test("toRun maps run wire fields and defaults the maps", async () => {
		stub(
			JSON.stringify({
				run: {
					run_id: "r1",
					workflow_id: "w1",
					status: "awaiting_input",
					awaiting_node: "gate1",
					created_at: "2026-01-01",
					updated_at: "2026-01-02",
				},
			})
		);
		const run = await getWorkflowRun(target, "r1");
		expect(run).toEqual({
			runId: "r1",
			workflowId: "w1",
			status: "awaiting_input",
			awaitingNode: "gate1",
			input: {},
			output: {},
			nodes: {},
			error: null,
			createdAt: "2026-01-01",
			updatedAt: "2026-01-02",
		});
	});
});
