import { expect, test } from "bun:test";
import {
	listVaultLockouts,
	setVaultLockoutConfig,
	unlockVaultIdentity,
} from "./lockouts.ts";

function fakeCore(reply: unknown) {
	const seen: { body: unknown; method: string; url: string }[] = [];
	const fetch = (input: RequestInfo | URL, init?: RequestInit) => {
		seen.push({
			url: new URL(String(input)).pathname,
			method: init?.method ?? "GET",
			body: init?.body ? JSON.parse(String(init.body)) : undefined,
		});
		return Promise.resolve(Response.json(reply));
	};
	return {
		seen,
		target: { url: "http://127.0.0.1:7777", token: "node-token", fetch },
	};
}

const config = {
	enabled: true,
	threshold: 5,
	windowSecs: 900,
	durationSecs: 900,
};

test("lists locked identities with RFC 3339 or epoch timestamps", async () => {
	const locked = [
		{
			identity: "ci",
			failures: 5,
			lockedAt: "2026-11-12T00:00:00Z",
			lockedUntil: 1_794_446_100_000,
		},
	];
	const { seen, target } = fakeCore({ config, locked });
	expect(await listVaultLockouts(target)).toEqual({ config, locked });
	expect(seen[0]).toMatchObject({
		method: "GET",
		url: "/api/vault/sys/lockouts",
	});
});

test("config sends every field, and unlock encodes the identity", async () => {
	const updated = { ...config, threshold: 3 };
	const put = fakeCore({ config: updated });
	expect(await setVaultLockoutConfig(put.target, updated)).toEqual({
		config: updated,
	});
	expect(put.seen[0]).toEqual({
		method: "PUT",
		url: "/api/vault/sys/lockouts/config",
		body: updated,
	});
	const unlock = fakeCore({ wasLocked: true });
	expect(await unlockVaultIdentity(unlock.target, "ci/runner")).toEqual({
		wasLocked: true,
	});
	expect(unlock.seen[0]).toMatchObject({
		method: "POST",
		url: "/api/vault/sys/lockouts/ci%2Frunner/unlock",
	});
});

test("a reply without the config is rejected", async () => {
	const { target } = fakeCore({ locked: [] });
	await expect(listVaultLockouts(target)).rejects.toThrow();
});
