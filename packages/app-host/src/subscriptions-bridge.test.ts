// `subscriptions.*` host-bridge contract: the grant gate (coded `denied`), the
// strict argument parsers (Core denies unknown fields; `force` is owner-HTTP
// only), and the coded `server_error` when a host has not wired the service.

import { describe, expect, test } from "bun:test";
import {
	ryuProviderUsageReadingSchema,
	ryuSubscriptionsSchema,
} from "./app-bridge.ts";
import {
	type Capability,
	CodedRpcError,
	capabilitiesFromGrants,
	dispatchRpc,
	type HostServices,
	METHOD_CAPABILITY,
	type RouteClaim,
} from "./rpc.ts";

const READING = {
	providerId: "claude-pro-max",
	accountId: "acct_1",
	accountLabel: "work@example.com",
	engine: "claude",
	available: true,
	plan: "max",
	observedAt: "2026-10-14T00:00:00Z",
	cached: true,
	windows: [
		{
			targetId: "window:5h::18000",
			label: "5h",
			scope: "account",
			model: null,
			usedPercent: 40,
			remainingPercent: 60,
			resetsAt: null,
			windowSeconds: 18_000,
			window: "5h",
		},
	],
	meters: [],
};

const SNAPSHOT = {
	version: 1,
	generatedAt: "2026-10-14T00:00:00Z",
	providers: [
		{
			providerId: "claude-pro-max",
			label: "Claude Pro/Max",
			kind: "subscription",
			managed: false,
			capabilities: {
				accountUsage: true,
				accountPing: true,
				accountPinning: "none",
				poolStrategies: ["manual", "round_robin"],
				quotaObservations: true,
			},
			policy: null,
			activeAccountId: "acct_1",
			accounts: [
				{
					accountId: "acct_1",
					label: "work@example.com",
					kind: "oauth",
					active: true,
					gatewayActive: false,
					needsReauth: false,
					updatedAt: 1,
					poolEnabled: true,
					poolPriority: null,
					state: "ok",
					usage: READING,
				},
			],
		},
	],
};

const GRANTED = new Set<Capability>(["subscriptions.read"]);

function baseServices(): HostServices {
	return {
		listAgents: () => Promise.resolve([]),
		registerRoute: (claim: RouteClaim) => Promise.resolve({ path: claim.path }),
	};
}

function wiredServices(calls: { method: string; input: unknown }[]) {
	return {
		...baseServices(),
		subscriptionsList: (input) => {
			calls.push({ method: "list", input });
			return Promise.resolve(ryuSubscriptionsSchema.parse(SNAPSHOT));
		},
		subscriptionsUsage: (input) => {
			calls.push({ method: "usage", input });
			return Promise.resolve(ryuProviderUsageReadingSchema.parse(READING));
		},
	} satisfies HostServices;
}

async function codedError(promise: Promise<unknown>): Promise<CodedRpcError> {
	const error = await promise.then(
		() => null,
		(reason: unknown) => reason
	);
	if (!(error instanceof CodedRpcError)) {
		throw new Error(`expected a CodedRpcError, got ${String(error)}`);
	}
	return error;
}

describe("subscriptions host bridge", () => {
	test("both methods map to the subscriptions:read grant", () => {
		expect(METHOD_CAPABILITY["subscriptions.list"]).toBe("subscriptions.read");
		expect(METHOD_CAPABILITY["subscriptions.usage"]).toBe("subscriptions.read");
		expect([...capabilitiesFromGrants(["subscriptions:read"])]).toEqual([
			"subscriptions.read",
		]);
		// The reserved pin grant unlocks nothing.
		expect([...capabilitiesFromGrants(["subscriptions:pin"])]).toEqual([]);
	});

	test("granted calls forward validated args to the host services", async () => {
		const calls: { method: string; input: unknown }[] = [];
		const services = wiredServices(calls);

		await expect(
			dispatchRpc("subscriptions.list", [], GRANTED, services)
		).resolves.toMatchObject({ version: 1 });
		await expect(
			dispatchRpc(
				"subscriptions.list",
				[{ providerId: "claude-pro-max", usage: "refresh" }],
				GRANTED,
				services
			)
		).resolves.toMatchObject({ providers: [{ providerId: "claude-pro-max" }] });
		await expect(
			dispatchRpc(
				"subscriptions.usage",
				[{ providerId: "claude-pro-max", accountId: "acct_1" }],
				GRANTED,
				services
			)
		).resolves.toMatchObject({ accountId: "acct_1", available: true });

		await dispatchRpc(
			"subscriptions.usage",
			[{ providerId: "claude-pro-max", accountId: undefined }],
			GRANTED,
			services
		);

		expect(calls).toEqual([
			{ method: "list", input: {} },
			{
				method: "list",
				input: { providerId: "claude-pro-max", usage: "refresh" },
			},
			{
				method: "usage",
				input: { providerId: "claude-pro-max", accountId: "acct_1" },
			},
			{ method: "usage", input: { providerId: "claude-pro-max" } },
		]);
		// An omitted account is dropped, not forwarded as `undefined`.
		expect(Object.keys(calls[3]?.input ?? {})).toEqual(["providerId"]);
	});

	test("ungranted calls are a coded denial and never reach the host", async () => {
		const calls: { method: string; input: unknown }[] = [];
		const services = wiredServices(calls);
		for (const [method, args] of [
			["subscriptions.list", []],
			["subscriptions.usage", [{ providerId: "claude-pro-max" }]],
		] as const) {
			const error = await codedError(
				dispatchRpc(method, [...args], new Set<Capability>(), services)
			);
			expect(error.code).toBe("denied");
		}
		expect(calls).toEqual([]);
	});

	test("extra, missing, or out-of-range args are rejected before the host", async () => {
		const calls: { method: string; input: unknown }[] = [];
		const services = wiredServices(calls);
		const invalid: [string, unknown[]][] = [
			["subscriptions.list", [{ providerId: "claude-pro-max", extra: true }]],
			["subscriptions.list", [{ usage: "force" }]],
			["subscriptions.list", [{ providerId: "" }]],
			["subscriptions.list", [{}, {}]],
			["subscriptions.usage", []],
			["subscriptions.usage", [{}]],
			["subscriptions.usage", [{ providerId: "   " }]],
			["subscriptions.usage", [{ providerId: "x".repeat(257) }]],
			[
				"subscriptions.usage",
				[{ providerId: "claude-pro-max", accountId: "acct_1", label: "x" }],
			],
		];
		for (const [method, args] of invalid) {
			const error = await codedError(
				dispatchRpc(method, args, GRANTED, services)
			);
			expect(error.code).toBe("invalid_args");
		}
		expect(calls).toEqual([]);
	});

	test("an unwired host answers a coded server_error", async () => {
		for (const [method, args] of [
			["subscriptions.list", []],
			["subscriptions.usage", [{ providerId: "claude-pro-max" }]],
		] as const) {
			const error = await codedError(
				dispatchRpc(method, [...args], GRANTED, baseServices())
			);
			expect(error.code).toBe("server_error");
		}
	});

	test("the reading schema keeps labels and degrades unknown reasons", () => {
		const parsed = ryuProviderUsageReadingSchema.parse({
			...READING,
			available: false,
			reason: "brand_new_reason",
		});
		expect(parsed.accountLabel).toBe("work@example.com");
		expect(parsed.reason).toBe("error");
	});
});
