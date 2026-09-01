import { describe, expect, test } from "bun:test";
import type { ApiTarget } from "./client.ts";
import { startHarnessRun, streamHarnessRunEvents } from "./harness.ts";

const target: ApiTarget = {
	token: "node-token",
	url: "http://127.0.0.1:7980",
	fetch: async (input) => {
		const url = String(input);
		if (url.endsWith("/api/harness/sessions/sess-1/runs")) {
			return Response.json({
				created: true,
				eventsUrl: "/api/harness/runs/run-1/events",
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
			});
		}
		const frames = [
			{
				createdAt: "2026-09-01T00:00:00Z",
				id: "evt-1",
				protocolVersion: "ryu.harness.v1",
				runId: "run-1",
				seq: 1,
				sessionId: "sess-1",
				type: "text_delta",
				delta: "hi",
			},
			{
				createdAt: "2026-09-01T00:00:01Z",
				id: "evt-2",
				protocolVersion: "ryu.harness.v1",
				runId: "run-1",
				seq: 2,
				sessionId: "sess-1",
				type: "run_completed",
			},
		]
			.map((frame) => `event: run\ndata: ${JSON.stringify(frame)}\n\n`)
			.join("");
		return new Response(frames, {
			headers: { "content-type": "text/event-stream" },
		});
	},
};

describe("core-client harness", () => {
	test("starts runs and consumes terminal event streams", async () => {
		const started = await startHarnessRun(target, "sess-1", { prompt: "hi" });
		expect(started.run.id).toBe("run-1");
		const events = [];
		for await (const event of streamHarnessRunEvents(target, started.run.id)) {
			events.push(event);
		}
		expect(events.map((event) => event.type)).toEqual([
			"text_delta",
			"run_completed",
		]);
	});
});
