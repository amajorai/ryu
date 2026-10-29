import { expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { piModelDiscoveryKey } from "./pi-model-discovery-key.ts";

test("switching accounts fetches the new catalog while the previous catalog is fresh", async () => {
	const client = new QueryClient();
	const input = {
		nodeUrl: "http://node.test",
		provider: "openai",
		routing: "direct",
		baseUrl: null,
		api: null,
	};
	let calls = 0;
	const fetch = (accountId: string) =>
		client.fetchQuery({
			queryKey: piModelDiscoveryKey({ ...input, accountId }),
			staleTime: 60_000,
			queryFn: () => {
				calls++;
				return Promise.resolve([`${accountId}-model`]);
			},
		});
	try {
		expect(await fetch("account-a")).toEqual(["account-a-model"]);
		expect(await fetch("account-b")).toEqual(["account-b-model"]);
		expect(await fetch("account-a")).toEqual(["account-a-model"]);
		expect(calls).toBe(2);
	} finally {
		client.clear();
	}
});

test("changing the endpoint for the same custom provider fetches its own catalog", async () => {
	const client = new QueryClient();
	const input = {
		nodeUrl: "http://node.test",
		provider: "custom-service",
		routing: "direct",
		accountId: null,
		api: "openai-completions",
	};
	let calls = 0;
	const fetch = (baseUrl: string) =>
		client.fetchQuery({
			queryKey: piModelDiscoveryKey({ ...input, baseUrl }),
			staleTime: 60_000,
			queryFn: () => {
				calls++;
				return Promise.resolve([`${baseUrl}/model`]);
			},
		});
	try {
		expect(await fetch("http://127.0.0.1:10001/v1")).toEqual([
			"http://127.0.0.1:10001/v1/model",
		]);
		expect(await fetch("http://127.0.0.1:10002/v1")).toEqual([
			"http://127.0.0.1:10002/v1/model",
		]);
		expect(calls).toBe(2);
	} finally {
		client.clear();
	}
});
