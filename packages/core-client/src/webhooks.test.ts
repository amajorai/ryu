import { afterEach, describe, expect, test } from "bun:test";
import type { ApiTarget } from "./client.ts";
import { createFetchFixture } from "./test-support/http-fixture.ts";
import {
	fetchWebhookSecret,
	fetchWebhooks,
	setWebhookSecret,
} from "./webhooks.ts";

const realFetch = globalThis.fetch;
const target: ApiTarget = {
	token: "node-token",
	url: "http://127.0.0.1:7980",
	userJwt: null,
};

afterEach(() => {
	globalThis.fetch = realFetch;
});

describe("webhook client", () => {
	test("normalizes the registry while preserving metadata-only secrets", async () => {
		globalThis.fetch = createFetchFixture(() =>
			Promise.resolve(
				Response.json({
					endpoints: [
						{
							has_secret: true,
							id: "composio",
							kind: "composio",
							label: "Composio triggers",
							path: "/api/composio/webhook",
						},
					],
					ingress_kind: "ryu-relay",
					up: true,
				})
			)
		);

		expect(await fetchWebhooks(target)).toEqual({
			ingressKind: "ryu-relay",
			publicBaseUrl: null,
			up: true,
			endpoints: [
				{
					hasSecret: true,
					id: "composio",
					kind: "composio",
					label: "Composio triggers",
					lastDelivery: null,
					path: "/api/composio/webhook",
					publicUrl: null,
					subscriptionCount: null,
					workflowId: null,
					workflowName: null,
				},
			],
		});
	});

	test("uses explicit protected secret routes for read and generated write", async () => {
		const calls: {
			body?: RequestInit["body"];
			method?: string;
			url?: string;
		}[] = [];
		globalThis.fetch = createFetchFixture((url: string, init?: RequestInit) => {
			calls.push({
				body: init?.body,
				method: init?.method,
				url,
			});
			const body = url.endsWith("/secret")
				? init?.method === "POST"
					? { secret: "generated-secret" }
					: { secret: "stored-secret" }
				: {};
			return Promise.resolve(
				new Response(JSON.stringify(body), { status: 200 })
			);
		});

		expect(await fetchWebhookSecret(target, "composio")).toBe("stored-secret");
		expect(await setWebhookSecret(target, "composio")).toBe("generated-secret");
		expect(calls).toEqual([
			{
				method: "GET",
				url: "http://127.0.0.1:7980/api/webhooks/composio/secret",
			},
			{
				body: "{}",
				method: "POST",
				url: "http://127.0.0.1:7980/api/webhooks/composio/secret",
			},
		]);
	});
});
