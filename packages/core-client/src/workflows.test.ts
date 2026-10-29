import { createFetchFixture } from "./test-support/http-fixture.ts";
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
import {
	createWorkflow,
	createWorkflowVersion,
	fetchWorkflows,
	forkRun,
	getWorkflowRun,
	listRunHistory,
	runWorkflow,
} from "./workflows.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

const target: ApiTarget = {
	url: "http://127.0.0.1:7980",
	token: "t",
	userJwt: null,
};

function stub(bodyText: string, status = 200): void {
	globalThis.fetch = createFetchFixture(() =>
		Promise.resolve(new Response(bodyText, { status }))
	);
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
		expect(wf).toBeDefined();
		if (!wf) {
			return;
		}
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
			dryRun: false,
			input: {},
			output: {},
			nodes: {},
			error: null,
			createdAt: "2026-01-01",
			updatedAt: "2026-01-02",
		});
	});
});

describe("workflow dry runs", () => {
	test("sends dryRun and maps the transient result flag", async () => {
		let requestBody: unknown;
		globalThis.fetch = createFetchFixture(
			(_input: RequestInfo | URL, init?: RequestInit) => {
				requestBody = JSON.parse(String(init?.body));
				return Promise.resolve(
					new Response(
						JSON.stringify({
							run: {
								run_id: "dryrun-1",
								workflow_id: "w1",
								status: "completed",
								dryRun: true,
								created_at: "2026-01-01",
								updated_at: "2026-01-01",
							},
						}),
						{ status: 200 }
					)
				);
			}
		);

		const run = await runWorkflow(
			target,
			"w1",
			{ input: "hello" },
			{ dryRun: true }
		);
		expect(requestBody).toEqual({
			input: { input: "hello" },
			dryRun: true,
		});
		expect(run.dryRun).toBe(true);
	});
});

describe("caller-minted run ids and limit-parked runs", () => {
	test("sends runId and maps a waiting run's resume time", async () => {
		let requestBody: unknown;
		globalThis.fetch = createFetchFixture(
			(_input: RequestInfo | URL, init?: RequestInit) => {
				requestBody = JSON.parse(String(init?.body));
				return Promise.resolve(
					new Response(
						JSON.stringify({
							run: {
								run_id: "run_abc",
								workflow_id: "w1",
								status: "waiting",
								resume_at: "2026-01-01T01:00:00Z",
								wait_reason: "rate limit",
								created_at: "2026-01-01",
								updated_at: "2026-01-01",
							},
						}),
						{ status: 200 }
					)
				);
			}
		);

		const run = await runWorkflow(
			target,
			"w1",
			{ input: "hello" },
			{ runId: "run_abc" }
		);
		expect(requestBody).toEqual({
			input: { input: "hello" },
			runId: "run_abc",
		});
		expect(run.status).toBe("waiting");
		expect(run.resumeAt).toBe("2026-01-01T01:00:00Z");
		expect(run.waitReason).toBe("rate limit");
	});

	test("a dry run never forwards a caller run id", async () => {
		let requestBody: unknown;
		globalThis.fetch = createFetchFixture(
			(_input: RequestInfo | URL, init?: RequestInit) => {
				requestBody = JSON.parse(String(init?.body));
				return Promise.resolve(
					new Response(
						JSON.stringify({
							run: {
								run_id: "dryrun-2",
								workflow_id: "w1",
								status: "completed",
								created_at: "2026-01-01",
								updated_at: "2026-01-01",
							},
						}),
						{ status: 200 }
					)
				);
			}
		);
		await runWorkflow(target, "w1", {}, { dryRun: true, runId: "run_x" });
		expect(requestBody).toEqual({ input: {}, dryRun: true });
	});
});

test("checkpoint caller preserves opaque expectedRevision and legacy omission", async () => {
	const bodies: unknown[] = [];
	const checkpointTarget: ApiTarget = {
		...target,
		fetch: async (_input, init) => {
			bodies.push(JSON.parse(String(init?.body)));
			return Response.json({ success: true });
		},
	};
	await createWorkflowVersion(
		checkpointTarget,
		"workflow",
		"Reviewed",
		"opaque/revision:2"
	);
	await createWorkflowVersion(checkpointTarget, "workflow");
	expect(bodies).toEqual([
		{ label: "Reviewed", expectedRevision: "opaque/revision:2" },
		{},
	]);
});

describe("run history and fork", () => {
	test("listRunHistory maps checkpoints and defaults their snapshots", async () => {
		let requestedUrl = "";
		globalThis.fetch = createFetchFixture((input: RequestInfo | URL) => {
			requestedUrl = String(input);
			return Promise.resolve(
				Response.json({
					success: true,
					run_id: "r 1",
					checkpoints: [
						{
							checkpoint_id: "cp-000000",
							sequence: 0,
							run_id: "r 1",
							event: "run_started",
							iteration: 0,
							status: "running",
							created_at: "2026-01-01",
						},
						{
							checkpoint_id: "cp-000001",
							sequence: 1,
							run_id: "r 1",
							event: "node_completed",
							node_id: "a",
							iteration: 2,
							status: "running",
							created_at: "2026-01-02",
							state: { k: "v" },
							nodes: { a: { status: "completed", output: "A" } },
							output: {},
						},
					],
				})
			);
		});
		const history = await listRunHistory(target, "r 1");
		expect(requestedUrl).toBe(
			"http://127.0.0.1:7980/workflows/runs/r%201/history"
		);
		expect(history).toEqual([
			{
				checkpointId: "cp-000000",
				sequence: 0,
				runId: "r 1",
				event: "run_started",
				nodeId: null,
				iteration: 0,
				status: "running",
				createdAt: "2026-01-01",
				state: {},
				nodes: {},
				output: {},
			},
			{
				checkpointId: "cp-000001",
				sequence: 1,
				runId: "r 1",
				event: "node_completed",
				nodeId: "a",
				iteration: 2,
				status: "running",
				createdAt: "2026-01-02",
				state: { k: "v" },
				nodes: { a: { status: "completed", output: "A" } },
				output: {},
			},
		]);
	});

	test("listRunHistory surfaces the Core error", async () => {
		stub(JSON.stringify({ success: false, error: "run not found" }), 404);
		await expect(listRunHistory(target, "missing")).rejects.toThrow(
			"run not found"
		);
	});

	test("forkRun posts the checkpoint and patch and maps the lineage", async () => {
		let requestBody: unknown;
		let requestedUrl = "";
		globalThis.fetch = createFetchFixture(
			(input: RequestInfo | URL, init?: RequestInit) => {
				requestedUrl = String(input);
				requestBody = JSON.parse(String(init?.body));
				return Promise.resolve(
					Response.json({
						success: true,
						run: {
							run_id: "fork_1",
							workflow_id: "w1",
							status: "completed",
							forked_from: { run_id: "r1", checkpoint_id: "cp-000002" },
							output: { result: "patched!" },
							created_at: "2026-01-01",
							updated_at: "2026-01-01",
						},
					})
				);
			}
		);
		const run = await forkRun(target, "r1", "cp-000002", {
			statePatch: { k: "patched", n: 3 },
		});
		expect(requestedUrl).toBe("http://127.0.0.1:7980/workflows/runs/r1/fork");
		expect(requestBody).toEqual({
			checkpoint_id: "cp-000002",
			state_patch: { k: "patched", n: 3 },
		});
		expect(run.runId).toBe("fork_1");
		expect(run.forkedFrom).toEqual({ runId: "r1", checkpointId: "cp-000002" });
		expect(run.output).toEqual({ result: "patched!" });
	});

	test("forkRun omits an absent patch and accepts waiting runs", async () => {
		let requestBody: unknown;
		globalThis.fetch = createFetchFixture(
			(_input: RequestInfo | URL, init?: RequestInit) => {
				requestBody = JSON.parse(String(init?.body));
				return Promise.resolve(
					Response.json({
						run: {
							run_id: "fork_2",
							workflow_id: "w1",
							status: "waiting",
							created_at: "2026-01-01",
							updated_at: "2026-01-01",
						},
					})
				);
			}
		);
		const run = await forkRun(target, "r1", "cp-000000");
		expect(requestBody).toEqual({ checkpoint_id: "cp-000000" });
		expect(run.status).toBe("waiting");
		expect(run.forkedFrom).toBeUndefined();
	});
});
