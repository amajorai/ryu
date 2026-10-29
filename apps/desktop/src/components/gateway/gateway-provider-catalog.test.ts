import { expect, mock, test } from "bun:test";
import {
	configureGatewayProviderAccount,
	type GatewayProvidersConfig,
} from "@/src/lib/api/gateway.ts";
import {
	byokAccountCount,
	gatewayProviderLabel,
	isByokProviderSet,
} from "./gateway-provider-catalog.ts";

const providers: GatewayProvidersConfig = {
	openai: null,
	anthropic: null,
	local: null,
	openrouter: null,
	core: null,
	genai: null,
	compatible: {
		mistral: {
			api_key: "***",
			api_key_count: 2,
			base_url: "https://mistral.invalid/v1",
		},
		huggingface: {
			api_key: "***",
			api_key_count: 2,
			base_url: "https://huggingface.invalid/v1",
		},
		nvidia: {
			api_key: "***",
			api_key_count: 2,
			base_url: "https://nvidia.invalid/v1",
		},
		together: {
			api_key: "***",
			api_key_count: 2,
			base_url: "https://together.invalid/v1",
		},
		fireworks: {
			api_key: "***",
			api_key_count: 2,
			base_url: "https://fireworks.invalid/v1",
		},
	},
};

test("compatible account counts and picker labels use the canonical nested config", () => {
	for (const id of [
		"mistral",
		"huggingface",
		"nvidia",
		"together",
		"fireworks",
	] as const) {
		expect(isByokProviderSet(providers, id)).toBe(true);
		expect(byokAccountCount(providers, id)).toBe(2);
		expect(gatewayProviderLabel(id)).not.toBe(id);
	}
	expect(isByokProviderSet(providers, "openai")).toBe(false);
	expect(gatewayProviderLabel("pool:balanced")).toBe("pool:balanced");
	expect(gatewayProviderLabel("constructor")).toBe("constructor");
});

test("legacy Gemini and account-qualified SDK discovery keep distinct counts", () => {
	const legacy = { ...providers, genai: { keys: ["gemini"] } };
	expect(byokAccountCount(legacy, "gemini")).toBe(1);
	const sdk: GatewayProvidersConfig = {
		...providers,
		genai: {
			keys: [],
			gemini_account_count: 0,
			sdk_providers: [
				{
					account_count: 3,
					account_scope: "genai-groq",
					accounts: [],
					auth_kind: "api_key",
					brand: "groq",
					configured: true,
					context_kind: "default",
					kind: "groq",
					label: "Groq",
					operations: ["chat", "stream"],
					provider_id: "genai-groq",
				},
			],
		},
	};
	expect(isByokProviderSet(sdk, "gemini")).toBe(false);
	expect(byokAccountCount(sdk, "genai-groq")).toBe(3);
	expect(isByokProviderSet(sdk, "genai-groq")).toBe(true);
	const empty = {
		...providers,
		compatible: {
			mistral: {
				api_key: "",
				api_key_count: 0,
				base_url: "https://mistral.invalid",
			},
		},
	};
	expect(isByokProviderSet(empty, "mistral")).toBe(false);
});

test("each compatible provider saves the stable named account and revision", async () => {
	const original = globalThis.fetch;
	const bodies: unknown[] = [];
	const fetchMock = mock(async (...args: Parameters<typeof fetch>) => {
		bodies.push(JSON.parse(String(args[1]?.body)));
		return Response.json({
			success: true,
			accountsApplied: true,
			gateway_restarted: false,
		});
	});
	globalThis.fetch = Object.assign(fetchMock, { preconnect: () => undefined });
	try {
		for (const provider of [
			"mistral",
			"huggingface",
			"nvidia",
			"together",
			"fireworks",
		] as const) {
			const account = {
				id: "a".repeat(64),
				name: "Work",
				enabled: true,
				priority: 7,
				drainThresholdPercent: 0,
			};
			await configureGatewayProviderAccount(
				{ url: "http://127.0.0.1:54590", token: null, userJwt: null },
				provider,
				account,
				"b".repeat(64)
			);
			expect(bodies.at(-1)).toEqual({
				provider,
				account_action: "configure",
				expectedRevision: "b".repeat(64),
				accountId: account.id,
				accountPolicy: {
					name: "Work",
					enabled: true,
					priority: 7,
					drain_threshold_percent: 0,
				},
			});
		}
	} finally {
		globalThis.fetch = original;
	}
});

test("direct provider views require the redacted provider contract", () => {
	for (const entry of [
		null,
		"invalid",
		{},
		{ api_key: 3, base_url: "https://api.invalid" },
		{ api_key: "***", base_url: null },
		{ api_key: "***", base_url: "https://api.invalid", api_key_count: "2" },
	]) {
		const config = JSON.parse(JSON.stringify({ ...providers, openai: entry }));
		expect(byokAccountCount(config, "openai")).toBe(0);
		expect(isByokProviderSet(config, "openai")).toBe(false);
	}
	const legacy = {
		...providers,
		openai: { api_key: "***", base_url: "https://api.invalid" },
	};
	expect(byokAccountCount(legacy, "openai")).toBe(1);
	const multiple = {
		...providers,
		openai: { ...legacy.openai, api_key_count: 4 },
	};
	expect(byokAccountCount(multiple, "openai")).toBe(4);
});
