import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createRyuClient } from "./client.ts";
import { installFetch } from "./test-fetch.ts";
import type { RyuClientOptions } from "./types.ts";

const realFetch = globalThis.fetch;
const OPTIONS: RyuClientOptions = {
	baseUrl: "http://localhost:7980",
	token: "node",
};

afterEach(() => {
	globalThis.fetch = realFetch;
});

function event(type: string, extra: Record<string, unknown> = {}, seq = 1) {
	return {
		createdAt: "2026-09-01T00:00:00Z",
		id: `evt-${type}`,
		protocolVersion: "ryu.harness.v1",
		runId: "run-1",
		seq,
		sessionId: "sess-1",
		type,
		...extra,
	};
}

describe("HarnessAPI", () => {
	test("tracks the Rust-canonical harness schema projection", () => {
		const schema = JSON.parse(
			readFileSync(
				join(
					import.meta.dir,
					"../../../crates/core/agent-contracts/schemas/agent-harness.schema.json"
				),
				"utf8"
			)
		) as {
			properties: Record<string, { properties?: Record<string, unknown> }>;
		};
		const sessionProperties = schema.properties.session.properties ?? {};
		const eventProperties = schema.properties.event.properties ?? {};
		expect(sessionProperties).toHaveProperty("conversationId");
		expect(sessionProperties).toHaveProperty("executionProfile");
		expect(eventProperties).toHaveProperty("runId");
		expect(eventProperties).toHaveProperty("sessionId");
	});

	test("creates a session and starts an idempotent run", async () => {
		const calls: Array<{ body?: string; url: string }> = [];
		installFetch((input, init) => {
			calls.push({ body: init?.body?.toString(), url: String(input) });
			if (String(input).endsWith("/api/harness/sessions")) {
				return Promise.resolve(
					Response.json({
						protocolVersion: "ryu.harness.v1",
						session: {
							createdAt: "2026-09-01T00:00:00Z",
							conversationId: "conv-1",
							executionProfile: {
								approval: "inherit",
								kind: "worktree",
								network: "inherit",
								sandbox: "inherit",
								worktreeIsolation: true,
							},
							id: "sess-1",
							protocolVersion: "ryu.harness.v1",
							runnableId: "agent-1",
							runnableKind: "agent",
							status: "pending",
							updatedAt: "2026-09-01T00:00:00Z",
						},
					})
				);
			}
			return Promise.resolve(
				Response.json({
					created: false,
					eventsUrl: "/api/harness/runs/run-1/events",
					protocolVersion: "ryu.harness.v1",
					run: {
						attempt: 1,
						createdAt: "2026-09-01T00:00:00Z",
						eventCursor: 1,
						executionProfile: {
							approval: "inherit",
							kind: "worktree",
							network: "inherit",
							sandbox: "inherit",
							worktreeIsolation: true,
						},
						id: "run-1",
						protocolVersion: "ryu.harness.v1",
						sessionId: "sess-1",
						status: "completed",
					},
				})
			);
		});

		const client = createRyuClient(OPTIONS);
		const session = await client.harness.createSession({
			executionProfile: {
				approval: "inherit",
				kind: "worktree",
				network: "inherit",
				sandbox: "inherit",
				worktreeIsolation: true,
			},
			runnableId: "agent-1",
			runnableKind: "agent",
		});
		const run = await client.harness.startRun(
			session.id,
			{ prompt: "inspect the repo" },
			{ idempotencyKey: "turn-1" }
		);

		expect(session.conversationId).toBe("conv-1");
		expect(run.created).toBe(false);
		expect(calls[0].body).toContain('"runnableId":"agent-1"');
		expect(calls[1].body).toContain('"idempotencyKey":"turn-1"');
		expect(calls[1].url).toBe(
			"http://localhost:7980/api/harness/sessions/sess-1/runs"
		);
	});

	test("replays typed SSE events and stops at the terminal event", async () => {
		installFetch(() => {
			const body = [
				event("run_started", {}, 1),
				event("input_accepted", { inputHash: "abc123", messageCount: 1 }, 2),
				event("text_delta", { delta: "done" }, 3),
				event("run_completed", {}, 4),
			]
				.map((value) => `event: run\ndata: ${JSON.stringify(value)}\n\n`)
				.join("");
			return Promise.resolve(
				new Response(body, { headers: { "content-type": "text/event-stream" } })
			);
		});
		const events = [];
		for await (const value of createRyuClient(OPTIONS).harness.events(
			"run-1"
		)) {
			events.push(value);
		}
		expect(events.map((value) => value.type)).toEqual([
			"run_started",
			"input_accepted",
			"text_delta",
			"run_completed",
		]);
		expect(events[2]?.type === "text_delta" && events[2].delta).toBe("done");
	});
});
