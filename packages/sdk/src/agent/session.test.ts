import { afterEach, describe, expect, test } from "bun:test";
import { Agent } from "./agent.ts";

const realFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = realFetch;
});

describe("Agent durable session projection", () => {
	test("starts a Core harness run and maps replayable events", async () => {
		const requests: Array<{ body?: string; url: string }> = [];
		globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
			const url = String(input);
			requests.push({ body: init?.body?.toString(), url });
			if (url.endsWith("/api/harness/sessions/sess-1/runs")) {
				return Promise.resolve(
					Response.json({
						created: true,
						eventsUrl: "/api/harness/runs/run-1/events",
						protocolVersion: "ryu.harness.v1",
						run: {
							attempt: 1,
							createdAt: "2026-09-01T00:00:00Z",
							eventCursor: 1,
							executionProfile: {
								approval: "inherit",
								kind: "local",
								network: "inherit",
								sandbox: "inherit",
								worktreeIsolation: false,
							},
							id: "run-1",
							protocolVersion: "ryu.harness.v1",
							sessionId: "sess-1",
							status: "running",
						},
					})
				);
			}
			const frames = [
				{
					createdAt: "2026-09-01T00:00:00Z",
					id: "evt-1",
					protocolVersion: "ryu.harness.v1",
					runId: "run-1",
					seq: 1,
					sessionId: "sess-1",
					type: "run_started",
					executionProfile: {
						approval: "inherit",
						kind: "local",
						network: "inherit",
						sandbox: "inherit",
						worktreeIsolation: false,
					},
				},
				{
					createdAt: "2026-09-01T00:00:01Z",
					id: "evt-2",
					protocolVersion: "ryu.harness.v1",
					runId: "run-1",
					seq: 2,
					sessionId: "sess-1",
					type: "text_delta",
					delta: "hello",
				},
				{
					createdAt: "2026-09-01T00:00:02Z",
					id: "evt-3",
					protocolVersion: "ryu.harness.v1",
					runId: "run-1",
					seq: 3,
					sessionId: "sess-1",
					type: "run_completed",
				},
			]
				.map((frame) => `event: run\ndata: ${JSON.stringify(frame)}\n\n`)
				.join("");
			return Promise.resolve(
				new Response(frames, {
					headers: { "content-type": "text/event-stream" },
				})
			);
		}) as typeof fetch;

		const events: string[] = [];
		const result = await new Agent({
			core: { baseUrl: "http://127.0.0.1:7980" },
			model: "unused",
			name: "durable",
			sessionId: "sess-1",
		}).generate("say hello");
		// `generate` consumes the stream, so verify the wire request and terminal
		// result instead of duplicating the stream collection here.
		events.push(...requests.map((request) => request.url));
		expect(result.text).toBe("hello");
		expect(events).toEqual([
			"http://127.0.0.1:7980/api/harness/sessions/sess-1/runs",
			"http://127.0.0.1:7980/api/harness/runs/run-1/events?after=0",
		]);
		expect(requests[0]?.body).toContain('"prompt":"say hello"');
	});

	test("resolves a native approval through the SDK handler", async () => {
		const requests: Array<{ body?: string; url: string }> = [];
		globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
			const url = String(input);
			requests.push({ body: init?.body?.toString(), url });
			if (url.endsWith("/api/harness/sessions/sess-1/runs")) {
				return Promise.resolve(
					Response.json({
						created: true,
						eventsUrl: "/api/harness/runs/run-2/events",
						protocolVersion: "ryu.harness.v1",
						run: {
							attempt: 1,
							createdAt: "2026-09-01T00:00:00Z",
							eventCursor: 1,
							executionProfile: {
								approval: "inherit",
								kind: "local",
								network: "inherit",
								sandbox: "inherit",
								worktreeIsolation: false,
							},
							id: "run-2",
							protocolVersion: "ryu.harness.v1",
							sessionId: "sess-1",
							status: "running",
						},
					})
				);
			}
			if (url.endsWith("/api/chat/permission")) {
				return Promise.resolve(Response.json({ resolved: true }));
			}
			const frames = [
				{
					createdAt: "2026-09-01T00:00:00Z",
					id: "evt-1",
					protocolVersion: "ryu.harness.v1",
					runId: "run-2",
					seq: 1,
					sessionId: "sess-1",
					type: "run_started",
					executionProfile: {
						approval: "inherit",
						kind: "local",
						network: "inherit",
						sandbox: "inherit",
						worktreeIsolation: false,
					},
				},
				{
					approvalId: "perm-2",
					createdAt: "2026-09-01T00:00:01Z",
					id: "evt-2",
					options: [
						{
							kind: "allow_once",
							name: "Allow once",
							optionId: "allow-once",
						},
					],
					protocolVersion: "ryu.harness.v1",
					runId: "run-2",
					seq: 2,
					sessionId: "sess-1",
					summary: "Permission is required",
					type: "approval_requested",
				},
				{
					createdAt: "2026-09-01T00:00:02Z",
					id: "evt-3",
					protocolVersion: "ryu.harness.v1",
					runId: "run-2",
					seq: 3,
					sessionId: "sess-1",
					type: "text_delta",
					delta: "approved",
				},
				{
					createdAt: "2026-09-01T00:00:03Z",
					id: "evt-4",
					protocolVersion: "ryu.harness.v1",
					runId: "run-2",
					seq: 4,
					sessionId: "sess-1",
					type: "run_completed",
				},
			]
				.map((frame) => `event: run\ndata: ${JSON.stringify(frame)}\n\n`)
				.join("");
			return Promise.resolve(
				new Response(frames, {
					headers: { "content-type": "text/event-stream" },
				})
			);
		}) as typeof fetch;

		const result = await new Agent({
			approvalHandler: async (request) => {
				expect(request.options?.[0]?.optionId).toBe("allow-once");
				return "allow-once";
			},
			core: { baseUrl: "http://127.0.0.1:7980" },
			model: "unused",
			name: "durable",
			sessionId: "sess-1",
		}).generate("continue");

		expect(result.text).toBe("approved");
		expect(result.approvalRequired?.approvalId).toBe("perm-2");
		expect(
			requests.some((request) => request.url.endsWith("/api/chat/permission"))
		).toBe(true);
		expect(requests.at(-1)?.body).toContain('"option_id":"allow-once"');
	});
});
