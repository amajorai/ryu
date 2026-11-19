// Wire tests for the dynamic-secret and lease client on a loopback node.

import { afterEach, expect, test } from "bun:test";
import {
	changeVaultLease,
	deleteVaultDynamicRole,
	issueVaultDynamicCredential,
	listVaultDynamicRoles,
	listVaultLeases,
	putVaultDynamicRole,
	revokeAllVaultDynamicLeases,
} from "./vault-dynamic.ts";

const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(() => {
	for (const server of servers.splice(0)) {
		server.stop(true);
	}
});

function node(reply: unknown, status = 200) {
	const seen: string[] = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const url = new URL(request.url);
			seen.push(
				`${request.method} ${url.pathname}${url.search} ${await request.text()}`.trim()
			);
			return Response.json(reply, { status });
		},
	});
	servers.push(server);
	return {
		seen,
		target: {
			token: "dynamic-node-token",
			url: `http://127.0.0.1:${server.port}`,
			userJwt: null,
		},
	};
}

const ROLE = {
	createdAt: 1,
	defaultTtlSecs: 3600,
	maxTtlSecs: 86_400,
	name: "db ro",
	provider: "postgres",
	summary: { connectionUrl: "postgres://***@db/app" },
	updatedAt: 2,
};

const LEASE = {
	createdAt: 1,
	expiresAt: 3_600_001,
	id: "dl_1",
	issuedTo: "user:ada",
	maxExpiresAt: 86_400_001,
	provider: "postgres",
	renewable: true,
	revokedAt: null,
	role: "db ro",
};

test("roles list, put with an encoded name, delete and revoke-all", async () => {
	const list = node({ roles: [ROLE] });
	expect(await listVaultDynamicRoles(list.target)).toEqual([ROLE]);
	expect(list.seen).toEqual(["GET /api/vault/dynamic/roles"]);

	const put = node({ role: ROLE });
	await putVaultDynamicRole(put.target, "db ro", {
		defaultTtlSecs: 3600,
		provider: { kind: "random", length: 32, charset: "hex" },
	});
	expect(put.seen).toEqual([
		'PUT /api/vault/dynamic/roles/db%20ro {"defaultTtlSecs":3600,"provider":{"kind":"random","length":32,"charset":"hex"}}',
	]);

	const del = node({ deleted: true });
	expect(await deleteVaultDynamicRole(del.target, "db ro")).toBe(true);
	expect(del.seen).toEqual(["DELETE /api/vault/dynamic/roles/db%20ro"]);

	const revoke = node({ revoked: 3 });
	expect(await revokeAllVaultDynamicLeases(revoke.target, "db ro")).toBe(3);
	expect(revoke.seen).toEqual([
		"POST /api/vault/dynamic/roles/db%20ro/revoke-all",
	]);
});

test("issue returns the one-time data with its lease, and sends the TTL only when set", async () => {
	const issued = node({
		credential: { data: { username: "v_1", password: "pw" }, lease: LEASE },
	});
	const credential = await issueVaultDynamicCredential(
		issued.target,
		"db ro",
		600
	);
	expect(credential.data).toEqual({ username: "v_1", password: "pw" });
	expect(credential.lease.id).toBe("dl_1");
	await issueVaultDynamicCredential(issued.target, "db ro");
	expect(issued.seen).toEqual([
		'POST /api/vault/dynamic/issue/db%20ro {"ttlSecs":600}',
		"POST /api/vault/dynamic/issue/db%20ro {}",
	]);
});

test("leases filter by role and revoked, renew and revoke post to the lease", async () => {
	const list = node({ leases: [LEASE] });
	expect(
		await listVaultLeases(list.target, { includeRevoked: true, role: "db ro" })
	).toEqual([LEASE]);
	await listVaultLeases(list.target);
	expect(list.seen).toEqual([
		"GET /api/vault/leases?role=db+ro&includeRevoked=true",
		"GET /api/vault/leases",
	]);

	const change = node({ lease: { ...LEASE, revokedAt: 9 } });
	expect(
		(await changeVaultLease(change.target, "dl_1", "revoke")).revokedAt
	).toBe(9);
	await changeVaultLease(change.target, "dl_1", "renew", 900);
	expect(change.seen).toEqual([
		"POST /api/vault/leases/dl_1/revoke {}",
		'POST /api/vault/leases/dl_1/renew {"ttlSecs":900}',
	]);
});

test("a reply without the credential is refused", async () => {
	const broken = node({ lease: LEASE });
	await expect(
		issueVaultDynamicCredential(broken.target, "db ro")
	).rejects.toThrow();
});
