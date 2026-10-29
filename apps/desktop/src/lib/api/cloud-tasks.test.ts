import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ApiTarget } from "./client.ts";
import {
	fetchCloudTask,
	fetchCloudTaskDiff,
	finishCloudTask,
	parseCloudTaskStatus,
	startCloudTaskPrompt,
	stopCloudTask,
} from "./cloud-tasks.ts";

interface Call {
	body: unknown;
	method: string;
	path: string;
}

const target: ApiTarget = {
	url: "https://cloud-tasks.fixture",
	token: "node-token",
	userJwt: "user-jwt",
};
const nativeFetch = globalThis.fetch;
let calls: Call[];
let reply: () => Response;

const status = {
	conversationId: "conv-1",
	environmentId: "env-1",
	backend: "box",
	executor: "codex",
	state: "running",
	expiresAt: "2026-10-14T12:00:00Z",
	baseSha: "abc123",
	baseBranch: "main",
	activeRun: {
		id: "run-1",
		status: "running",
		startedAt: "2026-10-14T11:30:00Z",
		outputTail: "working",
	},
	lastRun: null,
	finish: null,
};

beforeEach(() => {
	calls = [];
	reply = () => Response.json(status);
	globalThis.fetch = Object.assign(
		(input: RequestInfo | URL, init?: RequestInit) => {
			const url = new URL(String(input));
			calls.push({
				path: url.pathname,
				method: init?.method ?? "GET",
				body: init?.body ? JSON.parse(String(init.body)) : null,
			});
			return Promise.resolve(reply());
		},
		{ preconnect: nativeFetch.preconnect }
	);
});

afterEach(() => {
	globalThis.fetch = nativeFetch;
});

describe("cloud task client", () => {
	test("parses a status and encodes the conversation id", async () => {
		const task = await fetchCloudTask(target, "conv/1");
		expect(task?.executor).toBe("codex");
		expect(task?.activeRun?.outputTail).toBe("working");
		expect(calls[0]?.path).toBe("/api/cloud-tasks/conv%2F1");
	});

	test("returns null when Core has no task for this owner", async () => {
		reply = () =>
			Response.json(
				{ error: { code: "cloud_task_not_found", message: "Not found" } },
				{ status: 404 }
			);
		expect(await fetchCloudTask(target, "conv-1")).toBeNull();
	});

	test("rethrows other HTTP failures", async () => {
		reply = () => Response.json({}, { status: 500 });
		await expect(fetchCloudTask(target, "conv-1")).rejects.toThrow("500");
	});

	test("rejects a malformed status", async () => {
		reply = () => Response.json({ ...status, state: "sleeping" });
		await expect(fetchCloudTask(target, "conv-1")).rejects.toThrow(
			"Invalid cloud task response"
		);
		expect(() => parseCloudTaskStatus({ ...status, activeRun: 7 })).toThrow(
			"Invalid cloud task response"
		);
		expect(() => parseCloudTaskStatus(null)).toThrow(
			"Invalid cloud task response"
		);
	});

	test("posts only environmentId and text to the prompt route", async () => {
		reply = () =>
			Response.json(
				{ run: { id: "run-2", status: "queued" } },
				{ status: 202 }
			);
		const run = await startCloudTaskPrompt(target, "conv-1", {
			environmentId: "env-1",
			text: "Fix the tests",
		});
		expect(run).toEqual({
			backend: "ryu-box",
			id: "run-2",
			notices: [],
			status: "queued",
			subscription: null,
		});
		expect(calls[0]).toEqual({
			path: "/api/cloud-tasks/conv-1/prompt",
			method: "POST",
			body: { environmentId: "env-1", text: "Fix the tests" },
		});
	});

	test("sends a strict backend choice and reads a run on the owner's plan", async () => {
		reply = () =>
			Response.json(
				{
					run: { id: "session_01abcdefgh", status: "submitted" },
					backend: "anthropic-subscription-cli",
					subscription: {
						backend: "anthropic-subscription-cli",
						conversationId: "conv-1",
						createdAt: 1,
						environmentId: "env-1",
						executor: "claude-code",
						externalId: "session_01abcdefgh",
						features: {
							diffInRyu: false,
							followUp: true,
							liveScreen: false,
							liveStatus: false,
							pullRequestInRyu: false,
							runLog: false,
							ryuCredits: false,
							stopFromRyu: false,
						},
						lastError: null,
						owner: "node-owner",
						status: "submitted",
						summary: null,
						updatedAt: 1,
						url: "https://claude.ai/code/session_01abcdefgh",
					},
				},
				{ status: 202 }
			);
		const run = await startCloudTaskPrompt(target, "conv-1", {
			agentId: "agent-7",
			backend: "anthropic-subscription-cli",
			environmentId: "env-1",
			fallback: false,
			text: "Fix the tests",
		});
		expect(run.backend).toBe("anthropic-subscription-cli");
		expect(run.subscription?.url).toBe(
			"https://claude.ai/code/session_01abcdefgh"
		);
		expect(run.subscription?.features.ryuCredits).toBe(false);
		expect(calls[0]?.body).toEqual({
			agentId: "agent-7",
			backend: "anthropic-subscription-cli",
			environmentId: "env-1",
			fallback: false,
			text: "Fix the tests",
		});
	});

	test("reads the fallback notice when the plan hit its limit", async () => {
		reply = () =>
			Response.json(
				{
					run: { id: "run-3", status: "queued" },
					backend: "ryu-box",
					notices: [
						{
							backend: "anthropic-subscription-cli",
							code: "subscription_quota_fallback",
							message: "Your Claude plan reached its usage or rate limit.",
						},
					],
				},
				{ status: 202 }
			);
		const run = await startCloudTaskPrompt(target, "conv-1", {
			environmentId: "env-1",
			text: "Fix the tests",
		});
		expect(run.backend).toBe("ryu-box");
		expect(run.notices[0]?.code).toBe("subscription_quota_fallback");
	});

	test("passes teardown and the optional finish fields", async () => {
		const finish = {
			branch: "ryu/conv-1",
			headSha: "def456",
			pushed: false,
			pushError: "auth",
			compareUrl: null,
			pullRequest: null,
			pullRequestError: null,
			teardown: "kept",
			files: 2,
			insertions: 10,
			deletions: 1,
		};
		reply = () => Response.json({ finish });
		const result = await finishCloudTask(target, "conv-1", {
			push: true,
			branch: "ryu/conv-1",
			commitMessage: "Changes",
			teardown: "destroy",
		});
		expect(result).toEqual(finish as typeof result);
		expect(calls[0]).toEqual({
			path: "/api/cloud-tasks/conv-1/finish",
			method: "POST",
			body: {
				push: true,
				teardown: "destroy",
				branch: "ryu/conv-1",
				commitMessage: "Changes",
			},
		});
		await finishCloudTask(target, "conv-1", { push: false, teardown: "keep" });
		expect(calls[1]?.body).toEqual({ push: false, teardown: "keep" });
	});

	test("sends pull request fields only with push and openPullRequest", async () => {
		const pushed = {
			branch: "ryu/conv-1",
			headSha: "def456",
			pushed: true,
			pushError: null,
			compareUrl: "https://github.com/acme/app/compare/main...ryu/conv-1",
			pullRequest: { url: "https://github.com/acme/app/pull/12", number: 12 },
			pullRequestError: null,
			teardown: "destroyed",
			files: 1,
			insertions: 1,
			deletions: 0,
		};
		reply = () => Response.json({ finish: pushed });
		const result = await finishCloudTask(target, "conv-1", {
			push: true,
			teardown: "destroy",
			openPullRequest: true,
			pullRequestTitle: "Fix it",
			pullRequestBody: "Details",
			draft: true,
		});
		expect(result.pullRequest).toEqual({
			url: "https://github.com/acme/app/pull/12",
			number: 12,
		});
		expect(calls[0]?.body).toEqual({
			push: true,
			teardown: "destroy",
			openPullRequest: true,
			pullRequestTitle: "Fix it",
			pullRequestBody: "Details",
			draft: true,
		});
		await finishCloudTask(target, "conv-1", {
			push: false,
			teardown: "keep",
			openPullRequest: true,
			draft: true,
		});
		expect(calls[1]?.body).toEqual({ push: false, teardown: "keep" });
		await finishCloudTask(target, "conv-1", {
			push: true,
			teardown: "keep",
			openPullRequest: false,
			pullRequestTitle: "Ignored",
		});
		expect(calls[2]?.body).toEqual({ push: true, teardown: "keep" });
	});

	test("parses pull request outcomes and rejects unsafe ones", () => {
		const base = {
			...status,
			finish: {
				branch: "ryu/conv-1",
				headSha: "def456",
				pushed: true,
				pushError: null,
				compareUrl: "https://github.com/acme/app/compare/ryu/conv-1",
				teardown: "kept",
				files: 1,
				insertions: 1,
				deletions: 0,
			},
		};
		// An older Core omits the pull request fields entirely.
		const legacy = parseCloudTaskStatus(base);
		expect(legacy.finish?.pullRequest).toBeNull();
		expect(legacy.finish?.pullRequestError).toBeNull();
		const failed = parseCloudTaskStatus({
			...base,
			finish: { ...base.finish, pullRequest: null, pullRequestError: "auth" },
		});
		expect(failed.finish?.pullRequestError).toBe("auth");
		const withFinish = (finish: Record<string, unknown>) => () =>
			parseCloudTaskStatus({ ...base, finish: { ...base.finish, ...finish } });
		expect(withFinish({ pullRequestError: "rate_limited" })).toThrow(
			"Invalid cloud task response"
		);
		expect(
			withFinish({
				pullRequest: { url: "javascript:alert(1)", number: 1 },
			})
		).toThrow("Invalid cloud task response");
		expect(
			withFinish({
				pullRequest: { url: "https://evil.example/acme/app/pull/1", number: 1 },
			})
		).toThrow("Invalid cloud task response");
		expect(
			withFinish({
				pullRequest: { url: "https://github.com/acme/app/pull/1", number: 0 },
			})
		).toThrow("Invalid cloud task response");
	});

	test("parses a diff and rejects a malformed one", async () => {
		reply = () =>
			Response.json({
				baseSha: "abc123",
				files: [{ path: "a.ts", insertions: 3, deletions: null }],
				patch: "diff --git",
				truncated: false,
			});
		const diff = await fetchCloudTaskDiff(target, "conv-1");
		expect(diff.files).toEqual([
			{ path: "a.ts", insertions: 3, deletions: null },
		]);
		expect(calls[0]?.path).toBe("/api/cloud-tasks/conv-1/diff");
		reply = () => Response.json({ baseSha: "abc", files: "nope" });
		await expect(fetchCloudTaskDiff(target, "conv-1")).rejects.toThrow(
			"Invalid cloud task response"
		);
	});

	test("stops through the stop route", async () => {
		reply = () => Response.json({ ok: true });
		await stopCloudTask(target, "conv-1");
		expect(calls[0]).toMatchObject({
			path: "/api/cloud-tasks/conv-1/stop",
			method: "POST",
		});
	});
});
