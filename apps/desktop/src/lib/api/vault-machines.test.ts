// Wire tests for the machine identity, secret id and machine token calls on
// a loopback node.

import { afterEach, expect, test } from "bun:test";
import {
	createVaultAppRole,
	deleteVaultMachine,
	issueVaultMachineToken,
	issueVaultSecretId,
	listVaultMachines,
	listVaultMachineTokens,
	listVaultSecretIds,
	revokeVaultMachineToken,
	revokeVaultSecretId,
	setVaultMachineDisabled,
} from "./vault-machines.ts";

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
				`${request.method} ${url.pathname}${url.search} ${await request.text()}`.trim()
			);
			return Response.json(reply);
		},
	});
	servers.push(server);
	return {
		seen,
		target: {
			token: "machines-node-token",
			url: `http://127.0.0.1:${server.port}`,
			userJwt: null,
		},
	};
}

const MACHINE = {
	id: "mid_1",
	name: "ci",
	auth: { kind: "approle", role_id: "role-1" },
	policies: ["ci-read"],
	tokenTtlSecs: 3600,
	disabled: false,
	createdAt: 1,
	createdBy: null,
	tokenConfig: {},
};

const SECRET_ID = {
	accessor: "sid-acc",
	createdAt: 1,
	expiresAt: null,
	usesRemaining: 3,
};

test("creates an AppRole, toggles and deletes an identity by encoded id", async () => {
	const listing = node({ machines: [MACHINE] });
	expect(await listVaultMachines(listing.target)).toEqual([MACHINE]);

	const created = node({ machine: MACHINE });
	await createVaultAppRole(created.target, {
		name: "ci",
		policies: ["ci-read"],
		tokenTtlSecs: 900,
	});
	expect(created.seen).toEqual([
		'POST /api/vault/machines {"name":"ci","policies":["ci-read"],"tokenTtlSecs":900,"auth":{"kind":"approle"}}',
	]);

	const patched = node({ machine: { ...MACHINE, disabled: true } });
	expect(
		(await setVaultMachineDisabled(patched.target, "a/b", true)).disabled
	).toBe(true);
	expect(patched.seen).toEqual([
		'PATCH /api/vault/machines/a%2Fb {"disabled":true}',
	]);

	const deleted = node({ deleted: true });
	expect(await deleteVaultMachine(deleted.target, "ci")).toBe(true);
	expect(deleted.seen).toEqual(["DELETE /api/vault/machines/ci"]);
});

test("secret ids are listed, issued once with their limits, and revoked by accessor", async () => {
	const listing = node({ secretIds: [SECRET_ID] });
	expect(await listVaultSecretIds(listing.target, "ci")).toEqual([SECRET_ID]);
	expect(listing.seen).toEqual(["GET /api/vault/machines/ci/secret-ids"]);

	const issued = node({ secretId: "sid-value", info: SECRET_ID });
	const reply = await issueVaultSecretId(issued.target, "ci", {
		ttlSecs: 600,
		uses: 3,
	});
	expect(reply.secretId).toBe("sid-value");
	expect(issued.seen).toEqual([
		'POST /api/vault/machines/ci/secret-ids {"ttlSecs":600,"uses":3}',
	]);

	const revoked = node({ revoked: true });
	expect(await revokeVaultSecretId(revoked.target, "sid acc")).toBe(true);
	expect(revoked.seen).toEqual(["DELETE /api/vault/secret-ids/sid%20acc"]);
});

test("tokens are listed per identity, minted for it, and revoked by accessor", async () => {
	const token = {
		accessor: "tok-acc",
		identityId: "mid_1",
		policies: ["ci-read"],
		role: null,
		createdAt: 1,
		expiresAt: 2,
		numUsesRemaining: null,
		revokedAt: null,
		ttlSecs: 60,
	};
	const listing = node({ tokens: [token] });
	expect(await listVaultMachineTokens(listing.target, "ci&x")).toEqual([token]);
	expect(listing.seen).toEqual(["GET /api/vault/tokens?identity=ci%26x"]);

	const minted = node({
		token: {
			token: "rvt_secret",
			accessor: "tok-acc",
			identityId: "mid_1",
			policies: ["ci-read"],
			expiresAt: 2,
		},
	});
	const issued = await issueVaultMachineToken(minted.target, "ci", {
		role: "deploy",
		ttlSecs: 900,
	});
	expect(issued.token).toBe("rvt_secret");
	expect(minted.seen).toEqual([
		'POST /api/vault/tokens {"role":"deploy","ttlSecs":900,"identity":"ci"}',
	]);

	const revoked = node({ revoked: true });
	expect(await revokeVaultMachineToken(revoked.target, "tok-acc")).toBe(true);
	expect(revoked.seen).toEqual(["POST /api/vault/tokens/tok-acc/revoke"]);
});

test("a reply that lacks the issued value is refused, not shown as empty", async () => {
	const broken = node({ info: SECRET_ID });
	await expect(issueVaultSecretId(broken.target, "ci", {})).rejects.toThrow();
});
