import { describe, expect, test } from "bun:test";
import { backendPromptFields } from "../cloud-task-backend-choice.ts";
import {
	parseAccounts,
	parseBackendsView,
	parseRoutingSettings,
	parseSessions,
	parseSubscriptionRun,
	parseSubscriptionRunDiff,
} from "./cloud-task-backends.ts";

const NO_FEATURES = {
	diffInRyu: false,
	followUp: true,
	liveScreen: false,
	liveStatus: false,
	pullRequestInRyu: false,
	runLog: false,
	ryuCredits: false,
	stopFromRyu: false,
};

describe("cloud task backends", () => {
	test("reads the owner's backends and routing", () => {
		const view = parseBackendsView({
			backends: [
				{
					backend: "anthropic-subscription-cli",
					billing: "user-plan",
					cooldownSecondsRemaining: null,
					features: NO_FEATURES,
					installed: true,
					signIn: "subscription",
					signInCommand: "claude auth login",
				},
			],
			owner: true,
			rollout: true,
			settings: {
				agentOverrides: { "agent-1": ["ryu-box"] },
				defaultOrder: ["anthropic-subscription-cli", "ryu-box"],
				enabled: true,
				environments: { "env-1": { claudeCheckout: "/code/repo" } },
			},
		});
		expect(view.backends[0]?.signIn).toBe("subscription");
		expect(view.settings?.agentOverrides["agent-1"]).toEqual(["ryu-box"]);
		expect(view.settings?.environments["env-1"]?.claudeCheckout).toBe(
			"/code/repo"
		);
	});

	test("rejects unknown backends and drops links to other sites", () => {
		expect(() =>
			parseBackendsView({
				backends: [{ backend: "someone-elses-cloud" }],
				owner: true,
				rollout: true,
				settings: null,
			})
		).toThrow("Invalid cloud task backend response");
		const run = parseSubscriptionRun({
			backend: "openai-subscription-cli",
			conversationId: "c",
			createdAt: 1,
			environmentId: "e",
			executor: "codex",
			externalId: "task_e_1",
			features: NO_FEATURES,
			lastError: null,
			status: "pending",
			summary: null,
			updatedAt: 1,
			url: "https://evil.example/codex/tasks/task_e_1",
		});
		expect(run.url).toBeNull();
	});

	test("maps a session choice to prompt fields", () => {
		expect(backendPromptFields(undefined)).toEqual({});
		expect(backendPromptFields({ kind: "auto" })).toEqual({});
		expect(
			backendPromptFields({
				kind: "pinned",
				backend: "openai-subscription-cli",
				strict: true,
			})
		).toEqual({ backend: "openai-subscription-cli", fallback: false });
	});
	test("reads a run on this computer with its log, branch and diff", () => {
		const run = parseSubscriptionRun({
			backend: "anthropic-subscription-sdk",
			branch: "ryu/task-0a1b2c3d4e5f",
			conversationId: "c",
			createdAt: 1,
			environmentId: "e",
			executor: "claude-code",
			externalId: "0b7d7c4e-9a2f-4c1e-8f3a-2d5e6f7a8b9c",
			features: {
				...NO_FEATURES,
				diffInRyu: true,
				runLog: true,
				stopFromRyu: true,
			},
			lastError: null,
			outputTail: "Working\n→ Edit",
			status: "running",
			summary: null,
			updatedAt: 1,
			url: null,
		});
		expect(run.branch).toBe("ryu/task-0a1b2c3d4e5f");
		expect(run.outputTail).toContain("→ Edit");
		expect(
			parseSubscriptionRunDiff({
				branch: run.branch,
				files: ["A  new.txt"],
				patch: "+made by the agent",
				truncated: false,
			}).files
		).toEqual(["A  new.txt"]);
		expect(() =>
			parseSubscriptionRunDiff({ files: "nope", patch: "", truncated: false })
		).toThrow("Invalid cloud task backend response");
	});
	test("reads a Codex run on this computer", () => {
		const run = parseSubscriptionRun({
			backend: "openai-subscription-sdk",
			branch: "ryu/task-0a1b2c3d4e5f",
			conversationId: "c",
			createdAt: 1,
			environmentId: "e",
			executor: "codex",
			externalId: "5f0c2a8e-1d3b-4e6f-9a7c-0b1d2e3f4a5b",
			features: {
				...NO_FEATURES,
				diffInRyu: true,
				runLog: true,
				stopFromRyu: true,
			},
			lastError: null,
			outputTail: "→ shell\nAdded codex.txt",
			status: "completed",
			summary: "Added codex.txt",
			updatedAt: 1,
			url: null,
		});
		expect(run.backend).toBe("openai-subscription-sdk");
		expect(run.features.stopFromRyu).toBe(true);
		expect(
			backendPromptFields({
				kind: "pinned",
				backend: "openai-subscription-sdk",
				strict: false,
			})
		).toEqual({ backend: "openai-subscription-sdk", fallback: true });
	});
	test("reads linked accounts, account routing and the combined session list", () => {
		const accounts = parseAccounts({
			accounts: [
				{
					builtin: true,
					cooldownSecondsRemaining: null,
					createdAt: null,
					id: "default",
					installed: true,
					isDefault: false,
					label: "this node's sign-in",
					provider: "anthropic",
					signIn: "subscription",
					tag: "Claude · this node's sign-in",
				},
				{
					builtin: false,
					cooldownSecondsRemaining: 1200,
					createdAt: 1,
					id: "0a1b2c3d4e5f",
					installed: true,
					isDefault: true,
					label: "work",
					provider: "anthropic",
					signIn: "subscription",
					tag: "Claude · work",
				},
			],
		});
		expect(accounts[1]?.tag).toBe("Claude · work");
		expect(accounts[1]?.cooldownSecondsRemaining).toBe(1200);
		const settings = parseRoutingSettings({
			accountFallbacks: { anthropic: ["0a1b2c3d4e5f"] },
			agentAccounts: { "agent-1": { openai: "default" } },
			defaultAccounts: { anthropic: "0a1b2c3d4e5f" },
			defaultOrder: ["anthropic-subscription-cli", "ryu-box"],
			enabled: true,
		});
		expect(settings.defaultAccounts.anthropic).toBe("0a1b2c3d4e5f");
		expect(settings.accountFallbacks.anthropic).toEqual(["0a1b2c3d4e5f"]);
		expect(settings.agentAccounts["agent-1"]?.openai).toBe("default");
		expect(() =>
			parseRoutingSettings({
				defaultAccounts: { gemini: "x" },
				defaultOrder: ["ryu-box"],
				enabled: true,
			})
		).toThrow("Invalid cloud task backend response");
		const sessions = parseSessions({
			sessions: [
				{
					accountId: "0a1b2c3d4e5f",
					conversationId: null,
					externalId: "task_e_1abcdef",
					provider: "openai",
					status: "ready",
					tag: "Codex · personal",
					title: "Fix it",
					updatedAt: null,
					url: "https://evil.example/x",
				},
			],
		});
		expect(sessions[0]?.tag).toBe("Codex · personal");
		expect(sessions[0]?.url).toBeNull();
	});

	test("a session pinned to an account sends <provider>:<id>", () => {
		expect(
			backendPromptFields({
				kind: "pinned",
				backend: "anthropic-subscription-sdk",
				strict: false,
				accountId: "0a1b2c3d4e5f",
			})
		).toEqual({
			account: "anthropic:0a1b2c3d4e5f",
			backend: "anthropic-subscription-sdk",
			fallback: true,
		});
	});
});
