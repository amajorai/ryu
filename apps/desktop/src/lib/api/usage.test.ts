import { afterEach, describe, expect, test } from "bun:test";
import type { SubscriptionProvider } from "@ryuhq/core-client/usage.ts";
import { createFetchFixture } from "../../test-fixtures/native-fetch-fixture.ts";
import {
	fetchAgentUsage,
	fetchProviderAccountUsage,
	fetchProviderUsageReading,
	fetchSubscriptionsSnapshot,
	supportsSubscriptionProviderUsage,
	supportsUsage,
	usageSnapshotFromReading,
} from "./usage.ts";

const realFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = realFetch;
});

describe("subscription provider usage eligibility", () => {
	test("accepts configured Ryu OAuth providers whose accounts Core can read", () => {
		for (const id of [
			"openai-codex",
			"chatgpt",
			"claude-pro-max",
			"github-copilot",
		]) {
			expect(
				supportsSubscriptionProviderUsage({
					accountUsage: true,
					authKind: "subscription",
					configured: true,
					id,
					managed: false,
				})
			).toBe(true);
		}
	});

	test("keeps pool, api-key, unconfigured, and unreadable rows quiet", () => {
		for (const provider of [
			{
				accountUsage: true,
				authKind: "subscription",
				configured: true,
				id: "managed-openrouter",
				managed: true,
			},
			{
				accountUsage: true,
				authKind: "api-key",
				configured: true,
				id: "openai",
				managed: false,
			},
			{
				accountUsage: true,
				authKind: "subscription",
				configured: false,
				id: "claude-pro-max",
				managed: false,
			},
			// Capability unknown (no snapshot yet): quiet, not guessed from the id.
			{
				authKind: "subscription",
				configured: true,
				id: "claude-pro-max",
				managed: false,
			},
			// Core reports no per-account usage for these providers.
			...["chatgpt-plan", "kiro", "kimi-coding", "devin", "gemini"].map(
				(id) => ({
					accountUsage: false,
					authKind: "subscription",
					configured: true,
					id,
					managed: false,
				})
			),
		]) {
			expect(supportsSubscriptionProviderUsage(provider)).toBe(false);
		}
	});

	test("reads the capability from a subscriptions snapshot provider", () => {
		const provider: SubscriptionProvider = {
			providerId: "claude-pro-max",
			label: "Claude Pro/Max",
			kind: "subscription",
			managed: false,
			capabilities: {
				accountUsage: true,
				accountPing: true,
				accountPinning: "none",
				poolStrategies: ["manual"],
				quotaObservations: true,
			},
			policy: null,
			activeAccountId: "acct_one",
			accounts: [
				{
					accountId: "acct_one",
					label: "Work",
					kind: "oauth",
					active: true,
					gatewayActive: false,
					needsReauth: false,
					updatedAt: 0,
					poolEnabled: true,
					poolPriority: null,
					state: "ok",
					usage: null,
				},
			],
		};
		expect(supportsSubscriptionProviderUsage(provider)).toBe(true);
		expect(
			supportsSubscriptionProviderUsage({
				...provider,
				capabilities: { ...provider.capabilities, accountUsage: false },
			})
		).toBe(false);
		expect(
			supportsSubscriptionProviderUsage({ ...provider, accounts: [] })
		).toBe(false);
		expect(
			supportsSubscriptionProviderUsage({ ...provider, kind: "agent_login" })
		).toBe(false);
	});

	test("subscriptions requests carry the provider, mode and account", async () => {
		const urls: string[] = [];
		globalThis.fetch = createFetchFixture(realFetch, async (input) => {
			urls.push(String(input));
			return String(input).includes("/reading")
				? Response.json({
						providerId: "claude-pro-max",
						accountId: "acct/one",
						available: true,
						windows: [
							{
								targetId: "window:Session::18000",
								label: "Session",
								scope: "account",
								usedPercent: 40,
								remainingPercent: 60,
								window: "5h",
								windowSeconds: 18_000,
							},
						],
						meters: [],
					})
				: Response.json({ version: 1, generatedAt: "", providers: [] });
		});
		const target = {
			token: "node-token",
			url: "http://127.0.0.1:8980",
			userJwt: null,
		};
		await fetchSubscriptionsSnapshot(target, {
			providerId: "claude-pro-max",
			usage: "force",
		});
		const reading = await fetchProviderUsageReading(target, {
			providerId: "claude-pro-max",
			accountId: "acct/one",
		});
		expect(urls).toEqual([
			"http://127.0.0.1:8980/api/usage/subscriptions?provider=claude-pro-max&usage=force",
			"http://127.0.0.1:8980/api/usage/subscriptions/claude-pro-max/reading?account=acct%2Fone",
		]);
		expect(usageSnapshotFromReading(reading)).toMatchObject({
			agentId: "claude-pro-max",
			accountId: "acct/one",
			available: true,
			windows: [
				{
					label: "Session",
					model: null,
					resetsAt: null,
					usedPercent: 40,
					windowSeconds: 18_000,
				},
			],
		});
	});

	test("uses the same engine hints as ACP usage polling", () => {
		expect(supportsUsage("acp:claude")).toBe(true);
		expect(supportsUsage("acp:codex")).toBe(true);
		expect(supportsUsage("chatgpt")).toBe(true);
		expect(supportsUsage("acp:copilot")).toBe(true);
		expect(supportsUsage("acp:devin")).toBe(true);
		expect(supportsUsage("acp:opencode")).toBe(true);
		expect(supportsUsage("acp:ollama")).toBe(true);
		expect(supportsUsage("acp:cursor")).toBe(true);
		expect(supportsUsage("acp:gemini")).toBe(true);
		expect(supportsUsage("ryu")).toBe(false);
	});

	test("fetches one saved account without changing the active account", async () => {
		const urls: string[] = [];
		globalThis.fetch = createFetchFixture(realFetch, async (input) => {
			urls.push(String(input));
			return Response.json({
				agent_id: "claude-pro-max",
				available: true,
				engine: "claude",
				plan: "Max 20x",
				windows: [],
			});
		});

		const snapshot = await fetchProviderAccountUsage(
			{ token: "node-token", url: "http://127.0.0.1:8980", userJwt: null },
			"claude-pro-max",
			"acct/work/account"
		);

		expect(snapshot).toMatchObject({
			agentId: "claude-pro-max",
			available: true,
			plan: "Max 20x",
		});
		expect(urls).toEqual([
			"http://127.0.0.1:8980/api/pi-config/providers/claude-pro-max/accounts/acct%2Fwork%2Faccount/usage",
		]);
	});
});

for (const kind of ["agent", "account"]) {
	test(`${kind} usage cancellation releases a pending HTTP body`, async () => {
		let closed = false;
		let receivedHeaders = false;
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch() {
				return new Response(
					new ReadableStream({
						start(controller) {
							controller.enqueue(new TextEncoder().encode("{"));
						},
						cancel() {
							closed = true;
						},
					})
				);
			},
		});
		globalThis.fetch = Object.assign(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const response = await realFetch(input, init);
				receivedHeaders = true;
				return response;
			},
			{ preconnect: realFetch.preconnect }
		);
		try {
			const target = {
				url: server.url.toString(),
				token: "fixture",
				userJwt: "fixture",
			};
			const controller = new AbortController();
			const result = (
				kind === "agent"
					? fetchAgentUsage(target, "acp:codex", controller.signal)
					: fetchProviderAccountUsage(
							target,
							"codex",
							"fixture",
							controller.signal
						)
			).then(
				() => "complete",
				() => "aborted"
			);
			const startDeadline = Date.now() + 1000;
			while (!receivedHeaders && Date.now() < startDeadline) {
				await Bun.sleep(5);
			}
			expect(receivedHeaders).toBe(true);
			controller.abort();
			const closeDeadline = Date.now() + 1000;
			while (!closed && Date.now() < closeDeadline) {
				await Bun.sleep(5);
			}
			expect(closed).toBe(true);
			expect(await result).toBe("aborted");
		} finally {
			server.stop(true);
		}
	});
}
