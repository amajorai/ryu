import { afterEach, expect, test } from "bun:test";
import { listVaultBrokerUsage } from "./vault-broker-usage.ts";

const target = {
	token: "node-token",
	url: "https://usage-api.fixture",
	userJwt: null,
};
const originalFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = originalFetch;
});

test("asks Core for the secret: reference and returns the names sorted", async () => {
	const seen: string[] = [];
	globalThis.fetch = Object.assign(
		(input: RequestInfo | URL) => {
			seen.push(String(input));
			return Promise.resolve(
				Response.json({ ref: "secret:A B", services: ["stripe", "github"] })
			);
		},
		{ preconnect: originalFetch.preconnect }
	);
	expect(await listVaultBrokerUsage(target, "A B")).toEqual([
		"github",
		"stripe",
	]);
	expect(seen).toEqual([
		"https://usage-api.fixture/api/vault/broker/usage?ref=secret%3AA%20B",
	]);
});

test("a reply without services is an empty list; a refusal throws", async () => {
	globalThis.fetch = Object.assign(
		() => Promise.resolve(Response.json({ ref: "secret:X" })),
		{ preconnect: originalFetch.preconnect }
	);
	expect(await listVaultBrokerUsage(target, "X")).toEqual([]);
	globalThis.fetch = Object.assign(
		() => Promise.resolve(Response.json({ error: "denied" }, { status: 403 })),
		{ preconnect: originalFetch.preconnect }
	);
	await expect(listVaultBrokerUsage(target, "X")).rejects.toBeDefined();
});
