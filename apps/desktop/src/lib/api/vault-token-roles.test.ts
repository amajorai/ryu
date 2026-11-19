// Wire tests for the token-role client on a loopback node.

import { afterEach, expect, test } from "bun:test";
import {
	deleteVaultTokenRole,
	listVaultTokenRoles,
	putVaultTokenRole,
} from "./vault-token-roles.ts";

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
			token: "token-roles-node",
			url: `http://127.0.0.1:${server.port}`,
			userJwt: null,
		},
	};
}

const ROLE = {
	allowedPolicies: ["ci-read"],
	createdAt: 1,
	disallowedPolicies: [],
	name: "ci",
	orphan: false,
	ttlSecs: 3600,
	updatedAt: 1,
};

test("list, put and delete use the role's encoded path", async () => {
	const list = node({ roles: [ROLE] });
	expect(await listVaultTokenRoles(list.target)).toEqual([ROLE]);
	expect(list.seen).toEqual(["GET /api/vault/token-roles"]);

	const put = node({ role: ROLE });
	expect(
		(
			await putVaultTokenRole(put.target, "ci/main", {
				allowedPolicies: ["ci-read"],
				ttlSecs: 3600,
			})
		).name
	).toBe("ci");
	expect(put.seen).toEqual([
		'PUT /api/vault/token-roles/ci%2Fmain {"allowedPolicies":["ci-read"],"ttlSecs":3600}',
	]);

	const del = node({ deleted: true });
	expect(await deleteVaultTokenRole(del.target, "ci")).toBe(true);
	expect(del.seen).toEqual(["DELETE /api/vault/token-roles/ci"]);
});

test("a role without its policy lists is refused", async () => {
	const broken = node({ roles: [{ name: "ci" }] });
	await expect(listVaultTokenRoles(broken.target)).rejects.toThrow();
});
