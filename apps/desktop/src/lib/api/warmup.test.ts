import { describe, expect, it } from "bun:test";
import { toScheduledJobs } from "./schedules.ts";
import {
	assertWarmupRunSucceeded,
	toAppliedWarmupJobs,
	toWarmupDetection,
} from "./warmup.ts";

const coreJob = {
	created_at: "2026-10-10T00:00:00Z",
	enabled: true,
	history: [],
	id: "job_1",
	name: "Claude Code · 05:00",
	owner_app: "@ryu/warmup",
	require_approval: false,
	schedule: { kind: "cron", expr: "0 5 * * *", tz: "Europe/Lisbon" },
	target: { type: "agent", agent_id: "claude-code", prompt: "hi" },
	updated_at: "2026-10-10T00:00:00Z",
};

describe("warmup bridge replies", () => {
	it("checks a detect reply and stamps the desktop's zone", () => {
		const detection = toWarmupDetection({
			agents: [
				{
					available: false,
					id: "claude-code",
					models: [{ description: null, modelId: "opus", name: "Opus" }],
					name: "Claude Code",
					plan: null,
					reason: "not_logged_in",
					windows: [],
				},
			],
			tz: "UTC",
		});
		expect(detection.agents[0]?.reason).toBe("not_logged_in");
		expect(detection.tz).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
		expect(() =>
			toWarmupDetection({ agents: [{ id: "claude-code" }], tz: "UTC" })
		).toThrow();
	});

	it("keeps provider accounts and window models, and defaults them for older Core", () => {
		const detection = toWarmupDetection({
			agents: [],
			providers: [
				{
					accounts: [
						{
							available: true,
							id: "acct_1",
							label: "work@example.com",
							needsReauth: false,
							plan: "max",
							reason: null,
							windows: [
								{
									label: "Weekly (Opus)",
									model: "opus",
									resetsAt: null,
									usedPercent: 40,
									windowSeconds: 604_800,
								},
							],
						},
					],
					id: "claude-pro-max",
					models: [
						{
							description: null,
							modelId: "claude-sonnet-4",
							name: "claude-sonnet-4",
						},
					],
					name: "Claude Pro/Max",
				},
			],
			tz: "UTC",
		});
		expect(detection.providers[0]?.accounts[0]?.windows[0]?.model).toBe("opus");
		expect(detection.providers[0]?.models[0]?.modelId).toBe("claude-sonnet-4");
		const legacy = toWarmupDetection({
			agents: [
				{
					available: true,
					id: "codex",
					models: [],
					name: "Codex",
					plan: null,
					reason: null,
					windows: [
						{
							label: "5h",
							resetsAt: null,
							usedPercent: 1,
							windowSeconds: 18_000,
						},
					],
				},
			],
			tz: "UTC",
		});
		expect(legacy.providers).toEqual([]);
		expect(legacy.agents[0]?.windows[0]?.model).toBeNull();
	});

	it("normalizes the owner-scoped job list to the camelCase job shape", () => {
		const [job] = toScheduledJobs({ jobs: [coreJob] });
		expect(job?.ownerApp).toBe("@ryu/warmup");
		expect(job?.schedule).toEqual({
			kind: "cron",
			expr: "0 5 * * *",
			tz: "Europe/Lisbon",
		});
		expect(job?.target).toMatchObject({
			type: "agent",
			agentId: "claude-code",
		});
		expect(toAppliedWarmupJobs({ jobs: [] })).toEqual([]);
		expect(() => toScheduledJobs({ jobs: [{ id: 1 }] })).toThrow();
	});

	it("surfaces a ping that ran and failed as an error", () => {
		expect(() =>
			assertWarmupRunSucceeded({ success: true, run_id: "run_1" })
		).not.toThrow();
		expect(() =>
			assertWarmupRunSucceeded({ success: false, error: "agent offline" })
		).toThrow("agent offline");
	});
});
