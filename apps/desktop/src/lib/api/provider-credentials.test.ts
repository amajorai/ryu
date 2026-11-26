import { afterEach, beforeEach, expect, test } from "bun:test";
import {
	claimPaidKeyNotice,
	fetchProviderCredentials,
	providerCredentialKeys,
	setApiKeyFallback,
} from "./provider-credentials.ts";

const target = {
	url: "http://credentials-fixture.test",
	token: null,
	userJwt: null,
};
const originalFetch = globalThis.fetch;

interface Call {
	body: string | null;
	method: string;
	path: string;
}
let calls: Call[];
let answer: (call: Call) => Response;

beforeEach(() => {
	calls = [];
	answer = () => Response.json({});
	globalThis.fetch = Object.assign(
		async (input: RequestInfo | URL, init?: RequestInit) => {
			const call: Call = {
				path: new URL(String(input)).pathname,
				method: init?.method ?? "GET",
				body: init?.body ? String(init.body) : null,
			};
			calls.push(call);
			return answer(call);
		},
		{ preconnect: originalFetch.preconnect }
	);
});

afterEach(() => {
	globalThis.fetch = originalFetch;
});

const coreAnswer = {
	providerId: "claude-pro-max",
	credentials: [
		{
			accountId: "login-a",
			label: "a@example.com",
			kind: "oauth",
			enabled: true,
			needsReauth: false,
		},
	],
	apiKeyFallback: {
		supported: true,
		enabled: true,
		keyProviderId: "anthropic",
		keys: [
			{
				accountId: "key-work",
				label: "Work",
				kind: "api_key",
				enabled: true,
				needsReauth: false,
				hint: "0001",
				resting: "limited",
			},
		],
	},
};

test("the credential list is read in Core's order with hints and the fallback block", async () => {
	answer = () => Response.json(coreAnswer);
	const result = await fetchProviderCredentials(target, "claude-pro-max");
	expect(calls.map((call) => [call.method, call.path])).toEqual([
		["GET", "/api/pi-config/providers/claude-pro-max/credentials"],
	]);
	expect(result).toEqual({
		providerId: "claude-pro-max",
		credentials: [
			{
				accountId: "login-a",
				label: "a@example.com",
				kind: "oauth",
				enabled: true,
				needsReauth: false,
				hint: null,
				resting: null,
			},
		],
		apiKeyFallback: {
			supported: true,
			enabled: true,
			keyProviderId: "anthropic",
			keys: [
				{
					accountId: "key-work",
					label: "Work",
					kind: "api_key",
					enabled: true,
					needsReauth: false,
					hint: "0001",
					resting: "limited",
				},
			],
		},
	});
});

test("an answer without a fallback block reads as not supported and off", async () => {
	answer = () =>
		Response.json({ providerId: "openrouter", credentials: "unexpected" });
	const result = await fetchProviderCredentials(target, "openrouter");
	expect(result.credentials).toEqual([]);
	expect(result.apiKeyFallback).toEqual({
		supported: false,
		enabled: false,
		keyProviderId: null,
		keys: [],
	});
});

test("a field Core never sends is not carried into the list", async () => {
	answer = () =>
		Response.json({
			...coreAnswer,
			credentials: [
				{ ...coreAnswer.credentials[0], key: "test-value-that-must-not-pass" },
			],
		});
	const result = await fetchProviderCredentials(target, "claude-pro-max");
	expect(JSON.stringify(result)).not.toContain("test-value-that-must-not-pass");
});

test("turning the fallback on sends only the setting and reads the new state back", async () => {
	answer = () => Response.json(coreAnswer);
	const result = await setApiKeyFallback(target, "claude-pro-max", true);
	expect(calls).toHaveLength(1);
	expect(calls[0]?.path).toBe(
		"/api/pi-config/providers/claude-pro-max/credentials"
	);
	expect(calls[0]?.method).toBe("PUT");
	expect(JSON.parse(calls[0]?.body ?? "null")).toEqual({
		apiKeyFallback: true,
	});
	expect(result.apiKeyFallback.enabled).toBe(true);
});

test("a provider id is escaped in the path", async () => {
	answer = () => Response.json({ providerId: "my provider/1" });
	await fetchProviderCredentials(target, "my provider/1");
	expect(calls[0]?.path).toBe(
		"/api/pi-config/providers/my%20provider%2F1/credentials"
	);
});

test("the paid key notice is claimed with a POST and is null when there is none", async () => {
	answer = () =>
		Response.json({
			notice: {
				providerId: "claude-pro-max",
				keyProviderId: "anthropic",
				accountId: "key-work",
				label: "Work",
			},
		});
	expect(await claimPaidKeyNotice(target, "conversation-a")).toEqual({
		providerId: "claude-pro-max",
		keyProviderId: "anthropic",
		accountId: "key-work",
		label: "Work",
	});
	expect(calls.map((call) => [call.method, call.path])).toEqual([
		["POST", "/api/conversations/conversation-a/paid-key-notice"],
	]);
	answer = () => Response.json({ notice: null });
	expect(await claimPaidKeyNotice(target, "conversation-a")).toBeNull();
});

test("query keys separate nodes, sign-ins and providers", () => {
	const key = providerCredentialKeys.list(target, "claude-pro-max");
	expect(key).toEqual([
		"provider-credentials",
		"http://credentials-fixture.test",
		null,
		null,
		"claude-pro-max",
	]);
	expect(
		providerCredentialKeys.list({ ...target, token: "other" }, "claude-pro-max")
	).not.toEqual(key);
	expect(providerCredentialKeys.list(target, "anthropic")).not.toEqual(key);
});
