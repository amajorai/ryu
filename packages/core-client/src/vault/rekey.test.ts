import { expect, test } from "bun:test";
import {
	cancelVaultRekey,
	getVaultRekey,
	initVaultRekey,
	updateVaultRekey,
} from "./rekey.ts";

const STATUS = {
	started: true,
	nonce: "n-1",
	required: 3,
	progress: 1,
	newShares: 5,
	newThreshold: 3,
	startedAt: "2026-01-01T00:00:00Z",
};

function fakeCore(reply: unknown) {
	const calls: { body?: unknown; method: string; path: string }[] = [];
	const fetch = (input: RequestInfo | URL, init?: RequestInit) => {
		calls.push({
			path: new URL(String(input)).pathname,
			method: init?.method ?? "GET",
			body: init?.body ? JSON.parse(String(init.body)) : undefined,
		});
		return Promise.resolve(Response.json(reply));
	};
	return { calls, target: { url: "http://127.0.0.1:7777", token: "t", fetch } };
}

test("status, init and cancel use the rekey routes", async () => {
	const { calls, target } = fakeCore({ rekey: STATUS });
	expect((await getVaultRekey(target)).rekey.nonce).toBe("n-1");
	await initVaultRekey(target, { shares: 5, threshold: 3 });
	await cancelVaultRekey(target);
	expect(calls).toEqual([
		{ path: "/api/vault/sys/rekey", method: "GET", body: undefined },
		{
			path: "/api/vault/sys/rekey/init",
			method: "POST",
			body: { shares: 5, threshold: 3 },
		},
		{ path: "/api/vault/sys/rekey/cancel", method: "POST", body: {} },
	]);
});

test("an update sends the nonce and share and returns new shares once", async () => {
	const done = fakeCore({
		complete: true,
		status: { ...STATUS, started: false, nonce: null, progress: 0 },
		shares: ["s1", "s2", "s3", "s4", "s5"],
	});
	const result = await updateVaultRekey(done.target, {
		nonce: "n-1",
		share: "old",
	});
	expect(result.complete).toBe(true);
	expect(result.shares).toHaveLength(5);
	expect(done.calls[0]?.body).toEqual({ nonce: "n-1", share: "old" });

	const partial = fakeCore({
		complete: false,
		status: { ...STATUS, progress: 2 },
	});
	const pending = await updateVaultRekey(partial.target, {
		nonce: "n-1",
		share: "x",
	});
	expect(pending.shares).toBeUndefined();
	expect(pending.status.progress).toBe(2);
});
