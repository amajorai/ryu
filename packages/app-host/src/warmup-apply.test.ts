import { describe, expect, test } from "bun:test";
import {
	asWarmupJobsArg,
	type Capability,
	dispatchRpc,
	type HostServices,
	type WarmupJobInput,
} from "./rpc.ts";

const schedule = {
	kind: "cron" as const,
	expr: "0 5 * * *",
	tz: "Europe/Lisbon",
};

describe("warmup.apply arguments", () => {
	test("accepts one ping per provider account and drops a claimed owner", () => {
		const jobs = asWarmupJobsArg([
			{
				name: "Warmup: Claude Pro/Max (work) at 05:00",
				ownerApp: "@ryu/other",
				schedule,
				target: {
					type: "provider_account",
					providerId: "claude-pro-max",
					accountId: "acct-work",
					prompt: "hi",
					model: "claude-haiku-4-5",
					extra: "ignored",
				},
			},
		]);
		expect(jobs).toEqual([
			{
				name: "Warmup: Claude Pro/Max (work) at 05:00",
				schedule,
				target: {
					type: "provider_account",
					providerId: "claude-pro-max",
					accountId: "acct-work",
					prompt: "hi",
					model: "claude-haiku-4-5",
				},
			},
		]);
	});

	test("still accepts an agent ping", () => {
		expect(
			asWarmupJobsArg([
				{
					name: "Warmup: Codex at 05:00",
					schedule,
					target: { type: "agent", agentId: "codex", prompt: "hi" },
				},
			])
		).toEqual([
			{
				name: "Warmup: Codex at 05:00",
				schedule,
				target: { type: "agent", agentId: "codex", prompt: "hi" },
			},
		]);
	});

	test("refuses a provider ping without an account or a model", () => {
		const target = {
			type: "provider_account",
			providerId: "chatgpt",
			accountId: "acct",
			prompt: "hi",
			model: "gpt-5-codex-mini",
		};
		for (const broken of [
			{ ...target, accountId: "" },
			{ ...target, model: "" },
			{ ...target, model: undefined },
		]) {
			expect(
				asWarmupJobsArg([{ name: "x", schedule, target: broken }])
			).toBeNull();
		}
	});

	test("refuses targets a warmup grant must not schedule", () => {
		expect(
			asWarmupJobsArg([
				{
					name: "x",
					schedule,
					target: { type: "workflow", workflowId: "wf" },
				},
			])
		).toBeNull();
	});

	test("dispatch forwards provider pings to the host", async () => {
		let received: WarmupJobInput[] = [];
		const services: HostServices = {
			listAgents: () => Promise.resolve([]),
			registerRoute: () => Promise.resolve({ path: "" }),
			warmupApply: (jobs) => {
				received = jobs;
				return Promise.resolve();
			},
		};
		const grants = new Set<Capability>(["warmup.crud"]);
		const target = {
			type: "provider_account" as const,
			providerId: "chatgpt",
			accountId: "acct",
			prompt: "hi",
			model: "gpt-5-codex-mini",
		};
		await dispatchRpc(
			"warmup.apply",
			[[{ name: "ping", schedule, target }]],
			grants,
			services
		);
		expect(received).toEqual([{ name: "ping", schedule, target }]);
	});
});
