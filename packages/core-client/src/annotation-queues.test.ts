// packages/core-client/src/annotation-queues.test.ts
//
// Wire tests for the annotation-queue client: every helper must hit the Core
// path and method the Rust router registers, send the snake_case body Core's
// serde structs expect, and reject a response that does not match Core's shape
// instead of handing the UI a half-parsed object.

import { afterEach, describe, expect, test } from "bun:test";
import {
	type AnnotationItem,
	addAnnotationItems,
	assignAnnotationItem,
	createAnnotationQueue,
	exportAnnotationQueue,
	listAnnotationItems,
	listAnnotationQueues,
	nextAnnotationItem,
	submitAnnotation,
} from "./annotation-queues.ts";
import type { ApiTarget } from "./client.ts";
import {
	createFetchFixture,
	parseJsonRequestBody,
} from "./test-support/http-fixture.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

const target: ApiTarget = {
	token: "t",
	url: "http://127.0.0.1:7980",
	userJwt: null,
};

const queue = {
	agent_id: "agent-1",
	created_at: 1,
	created_by: null,
	description: null,
	id: "aq_1",
	labels: ["correct", "rude"],
	name: "Support answers",
	rubric: "Is it correct?",
	score_max: 5,
	score_min: 1,
	updated_at: 1,
};

const item: AnnotationItem = {
	assignee: "local",
	comment: null,
	completed_at: null,
	created_at: 2,
	id: "aqi_1",
	input: "How do I reset my password?",
	labels: [],
	message_id: null,
	metadata: {},
	output: "Use the reset link.",
	queue_id: "aq_1",
	reviewed_by: null,
	run_id: "run-1",
	score: null,
	source_kind: "run",
	status: "in_progress",
	trace_id: null,
	updated_at: 2,
};

interface Captured {
	body: unknown;
	method: string;
	url: string;
}

function respondWith(payload: unknown, captured: Captured[]): void {
	globalThis.fetch = createFetchFixture((url, init) => {
		captured.push({
			body:
				typeof init.body === "string"
					? parseJsonRequestBody(init.body)
					: undefined,
			method: init.method ?? "GET",
			url,
		});
		return Promise.resolve(Response.json(payload));
	});
}

describe("annotation queue client", () => {
	test("lists queues for an agent with counts", async () => {
		const captured: Captured[] = [];
		respondWith(
			{
				queues: [
					{
						...queue,
						counts: {
							completed: 1,
							in_progress: 0,
							pending: 2,
							skipped: 0,
							total: 3,
						},
					},
				],
			},
			captured
		);
		const queues = await listAnnotationQueues(target, "agent 1");
		expect(captured[0]?.url).toBe(
			"http://127.0.0.1:7980/api/annotation-queues?agent_id=agent%201"
		);
		expect(queues[0]?.counts.pending).toBe(2);
	});

	test("creates a queue with the agent id flattened into the body", async () => {
		const captured: Captured[] = [];
		respondWith({ queue }, captured);
		const created = await createAnnotationQueue(target, "agent-1", {
			labels: ["correct", "rude"],
			name: "Support answers",
			score_max: 5,
			score_min: 1,
		});
		expect(captured[0]?.method).toBe("POST");
		expect(captured[0]?.body).toEqual({
			agent_id: "agent-1",
			labels: ["correct", "rude"],
			name: "Support answers",
			score_max: 5,
			score_min: 1,
		});
		expect(created.id).toBe("aq_1");
	});

	test("adds items, claims the next one and submits a review", async () => {
		const captured: Captured[] = [];
		respondWith({ added: [item], skipped: 1 }, captured);
		const added = await addAnnotationItems(target, "aq_1", [
			{ run_id: "run-1" },
			{ input: "q", output: "a", trace_id: "trace-9" },
		]);
		expect(added.skipped).toBe(1);
		expect(captured[0]?.url).toEndWith("/api/annotation-queues/aq_1/items");
		expect(captured[0]?.body).toEqual({
			items: [
				{ run_id: "run-1" },
				{ input: "q", output: "a", trace_id: "trace-9" },
			],
		});

		respondWith({ item }, captured);
		expect((await nextAnnotationItem(target, "aq_1"))?.id).toBe("aqi_1");
		expect(captured[1]?.url).toEndWith("/api/annotation-queues/aq_1/next");
		expect(captured[1]?.method).toBe("POST");

		respondWith({ item: null }, captured);
		expect(await nextAnnotationItem(target, "aq_1")).toBeNull();

		const reviewed = { ...item, score: 4, status: "completed" };
		respondWith({ item: reviewed }, captured);
		const submitted = await submitAnnotation(target, "aq_1", "aqi_1", {
			comment: "Accurate",
			labels: ["correct"],
			score: 4,
		});
		expect(submitted.status).toBe("completed");
		expect(captured[3]?.url).toEndWith(
			"/api/annotation-queues/aq_1/items/aqi_1/submit"
		);
	});

	test("assigns and releases an item with PATCH", async () => {
		const captured: Captured[] = [];
		respondWith(
			{ item: { ...item, assignee: null, status: "pending" } },
			captured
		);
		const released = await assignAnnotationItem(target, "aq_1", "aqi_1", null);
		expect(captured[0]?.method).toBe("PATCH");
		expect(captured[0]?.body).toEqual({ assignee: null });
		expect(released.status).toBe("pending");
	});

	test("encodes item filters as query parameters", async () => {
		const captured: Captured[] = [];
		respondWith({ items: [item] }, captured);
		await listAnnotationItems(target, "aq_1", {
			limit: 20,
			status: "completed",
		});
		expect(captured[0]?.url).toEndWith(
			"/api/annotation-queues/aq_1/items?status=completed&limit=20"
		);
	});

	test("exports reviewed items to a prompt suite", async () => {
		const captured: Captured[] = [];
		respondWith(
			{
				added: 2,
				skipped: 0,
				suite_id: "ps_1",
				version: {
					created_at: 3,
					id: "psv_1",
					label: "Annotation export: Support answers",
					suite_id: "ps_1",
				},
			},
			captured
		);
		const result = await exportAnnotationQueue(target, "aq_1", {
			min_score: 4,
			suite_id: "ps_1",
		});
		expect(result.added).toBe(2);
		expect(captured[0]?.body).toEqual({ min_score: 4, suite_id: "ps_1" });
	});

	test("rejects a response that does not match Core's item shape", async () => {
		respondWith({ item: { id: "aqi_1" } }, []);
		await expect(nextAnnotationItem(target, "aq_1")).rejects.toThrow();
	});
});
