import { afterEach, describe, expect, test } from "bun:test";
import { createFetchFixture } from "../../test-fixtures/native-fetch-fixture.ts";
import {
	fetchSubscriptionCostUsage,
	setSubscriptionCostTracking,
} from "./subscription-costs.ts";

const realFetch = globalThis.fetch;
const target = {
	token: "node-token",
	url: "http://127.0.0.1:8980",
	userJwt: null,
};

afterEach(() => {
	globalThis.fetch = realFetch;
});

describe("subscription API-equivalent usage API", () => {
	test("reads month totals from the selected Core node", async () => {
		let requestUrl = "";
		let authorization = "";
		globalThis.fetch = createFetchFixture(realFetch, async (input, init) => {
			requestUrl = String(input);
			authorization = new Headers(init?.headers).get("Authorization") ?? "";
			return Response.json({
				accounts: [
					{
						accountId: "acct-a",
						estimatedCostMicroUsd: 125_000,
						inputTokens: 12_000,
						models: [],
						outputTokens: 2000,
						providerId: "anthropic",
						turns: 3,
						unpricedInputTokens: 0,
						unpricedOutputTokens: 0,
						missingInputTurns: 0,
						missingOutputTurns: 0,
					},
				],
				enabled: true,
				month: "2026-09",
			});
		});

		const usage = await fetchSubscriptionCostUsage(target);

		expect(requestUrl).toBe(
			"http://127.0.0.1:8980/api/usage/subscription-costs"
		);
		expect(authorization).toBe("Bearer node-token");
		expect(usage).toMatchObject({
			enabled: true,
			month: "2026-09",
			accounts: [
				{
					providerId: "anthropic",
					accountId: "acct-a",
					estimatedCostMicroUsd: 125_000,
				},
			],
		});
	});

	test("persists the user's opt-in choice through the selected Core node", async () => {
		let method = "";
		let requestBody: unknown;
		globalThis.fetch = createFetchFixture(realFetch, async (_input, init) => {
			method = init?.method ?? "GET";
			requestBody = JSON.parse(String(init?.body ?? "null"));
			return Response.json({ enabled: true });
		});

		await expect(setSubscriptionCostTracking(target, true)).resolves.toEqual({
			enabled: true,
		});
		expect(method).toBe("PUT");
		expect(requestBody).toEqual({ enabled: true });
	});
});
