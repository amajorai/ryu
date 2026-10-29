import { afterEach, expect, test } from "bun:test";
import type { ApiTarget } from "./client.ts";
import { fetchJobs } from "./schedules.ts";
import { createFetchFixture } from "./test-support/http-fixture.ts";

const realFetch = globalThis.fetch;
const target: ApiTarget = {
	url: "http://127.0.0.1:7980/",
	token: "node-token",
	userJwt: null,
};
const job = {
	created_at: "created",
	id: "job",
	name: "Routine",
	schedule: { kind: "every", interval: "1h" },
	updated_at: "updated",
};

afterEach(() => {
	globalThis.fetch = realFetch;
});

function serve(jobs: unknown[], urls: string[] = []): void {
	globalThis.fetch = createFetchFixture((url: string | URL) => {
		urls.push(String(url));
		return Promise.resolve(Response.json({ jobs }));
	});
}

test("fetchJobs opts in to app jobs", async () => {
	const urls: string[] = [];
	serve([], urls);
	await fetchJobs(target);
	expect(urls).toEqual([
		"http://127.0.0.1:7980/heartbeat/jobs?include=app_jobs",
	]);
});

test("app, legacy and unknown targets parse and project to read-only system rows", async () => {
	serve([
		{
			...job,
			id: "app",
			target: {
				type: "app_job",
				plugin_id: "@ryu/monitors",
				job_id: "m1",
				payload: { k: 1 },
			},
		},
		{ ...job, id: "monitor", target: { type: "monitor", monitor_id: "m1" } },
		{ ...job, id: "quest", target: { type: "quest", quest_id: "q1" } },
		{ ...job, id: "health", target: { type: "identity_health" } },
		{ ...job, id: "future", target: { type: "future_kind", extra: [1] } },
		{
			...job,
			id: "agent",
			target: { type: "agent", agent_id: "a", prompt: "p" },
		},
	]);
	const rows = await fetchJobs(target);
	expect(rows.map((row) => row.system)).toEqual([
		true,
		true,
		true,
		true,
		true,
		false,
	]);
	expect(rows.map((row) => row.target)).toEqual([
		{ type: "system", kind: "app_job", pluginId: "@ryu/monitors", jobId: "m1" },
		{ type: "system", kind: "monitor" },
		{ type: "system", kind: "quest" },
		{ type: "system", kind: "identity_health" },
		{ type: "system", kind: "future_kind" },
		{ type: "agent", agentId: "a", prompt: "p" },
	]);
});

test("known target types are still validated strictly", async () => {
	serve([{ ...job, target: { type: "app_job", plugin_id: "@ryu/x" } }]);
	await expect(fetchJobs(target)).rejects.toThrow();
	serve([{ ...job, target: { type: "monitor" } }]);
	await expect(fetchJobs(target)).rejects.toThrow();
});
