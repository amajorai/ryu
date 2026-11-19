// Wire tests for the vault login-lockout calls on a loopback node.

import { afterEach, expect, test } from "bun:test";
import {
	listVaultLockouts,
	setVaultLockoutConfig,
	unlockVaultIdentity,
} from "./vault-lockouts.ts";

const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(() => {
	for (const server of servers.splice(0)) {
		server.stop(true);
	}
});

function node(reply: unknown) {
	const seen: string[] = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const url = new URL(request.url);
			seen.push(
				`${request.method} ${url.pathname} ${await request.text()}`.trim()
			);
			return Response.json(reply);
		},
	});
	servers.push(server);
	return {
		seen,
		target: {
			token: "lockout-node-token",
			url: `http://127.0.0.1:${server.port}`,
			userJwt: null,
		},
	};
}

const config = {
	enabled: true,
	threshold: 5,
	windowSecs: 900,
	durationSecs: 900,
};

test("lists locked identities, sends the full config, and unlocks by name", async () => {
	const locked = [
		{
			identity: "ci",
			failures: 5,
			lockedAt: "2026-11-12T00:00:00Z",
			lockedUntil: 1_794_446_100_000,
		},
	];
	const listing = node({ config, locked });
	expect(await listVaultLockouts(listing.target)).toEqual({ config, locked });
	expect(listing.seen).toEqual(["GET /api/vault/sys/lockouts"]);

	const updated = { ...config, enabled: false };
	const put = node({ config: updated });
	expect(await setVaultLockoutConfig(put.target, updated)).toEqual(updated);
	expect(put.seen).toEqual([
		`PUT /api/vault/sys/lockouts/config ${JSON.stringify(updated)}`,
	]);

	const unlock = node({ wasLocked: true });
	expect(await unlockVaultIdentity(unlock.target, "ci/runner")).toBe(true);
	expect(unlock.seen).toEqual([
		"POST /api/vault/sys/lockouts/ci%2Frunner/unlock",
	]);
});

test("a reply without the settings is rejected", async () => {
	const { target } = node({ locked: [] });
	await expect(listVaultLockouts(target)).rejects.toThrow();
});
