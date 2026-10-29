import { afterEach, expect, test } from "bun:test";
import { listApprovals, pendingApprovalActionSchema } from "./approvals.ts";
import type { ApiTarget } from "./client.ts";
import { createFetchFixture } from "./test-support/http-fixture.ts";

const realFetch = globalThis.fetch;
const target: ApiTarget = {
	url: "http://127.0.0.1:7980/",
	token: "node-token",
	userJwt: null,
};

afterEach(() => {
	globalThis.fetch = realFetch;
});

const scheduled = (jobTarget: unknown) => ({
	type: "scheduled_job",
	target: jobTarget,
	job_id: "job",
});

test("scheduled-job approvals accept app, legacy and future targets", () => {
	for (const jobTarget of [
		{ type: "app_job", plugin_id: "@ryu/monitors", job_id: "m1" },
		{ type: "app_job", plugin_id: "@ryu/x", job_id: "j", payload: { k: [1] } },
		{ type: "monitor", monitor_id: "m1" },
		{ type: "quest", quest_id: "q1" },
		{ type: "future_kind", extra: true },
	]) {
		expect(
			pendingApprovalActionSchema.safeParse(scheduled(jobTarget)).success
		).toBe(true);
	}
	for (const jobTarget of [
		{ type: "app_job", plugin_id: "@ryu/x" },
		{ type: "agent", agent_id: "a" },
	]) {
		expect(
			pendingApprovalActionSchema.safeParse(scheduled(jobTarget)).success
		).toBe(false);
	}
});

test("listApprovals opts in to app-job approvals", async () => {
	const urls: string[] = [];
	globalThis.fetch = createFetchFixture((url: string | URL) => {
		urls.push(String(url));
		return Promise.resolve(Response.json({ approvals: [] }));
	});
	await listApprovals(target);
	await listApprovals(target, "pending");
	expect(urls).toEqual([
		"http://127.0.0.1:7980/api/approvals?include=app_jobs",
		"http://127.0.0.1:7980/api/approvals?status=pending&include=app_jobs",
	]);
});
