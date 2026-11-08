// Wire tests for the vault audit and seal calls on a loopback node.

import { afterEach, expect, test } from "bun:test";
import {
	getVaultSysStatus,
	listVaultAudit,
	sealVault,
	verifyVaultAudit,
} from "./vault-sys.ts";

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
			token: "sys-node-token",
			url: `http://127.0.0.1:${server.port}`,
			userJwt: null,
		},
	};
}

const SEAL = {
	activeKeyVersion: 1,
	keyVersions: [1],
	mode: "auto",
	progress: 0,
	sealed: true,
	shares: 1,
	threshold: 1,
};

test("seal posts an empty body and returns the seal state", async () => {
	const { seen, target } = node({ seal: SEAL });
	expect(await sealVault(target)).toMatchObject({ sealed: true });
	expect(seen).toEqual(["POST /api/vault/sys/seal {}"]);
});

test("audit lists filters in order and verify returns the report", async () => {
	const audit = node({ events: [], nextBefore: 4 });
	expect(
		await listVaultAudit(audit.target, { action: "reveal", limit: 5 })
	).toEqual({ events: [], nextBefore: 4 });
	expect(audit.seen).toEqual(["GET /api/vault/audit?limit=5&action=reveal"]);

	const report = { ok: true, rows: 3 };
	const verify = node({ report });
	expect(await verifyVaultAudit(verify.target)).toMatchObject(report);
	expect(verify.seen).toEqual(["GET /api/vault/audit/verify"]);
});

test("sys status is read from its own route", async () => {
	const { seen, target } = node({
		activeEnvironment: "prod",
		seal: SEAL,
		sharedRemote: false,
	});
	expect(await getVaultSysStatus(target)).toMatchObject({
		activeEnvironment: "prod",
		sharedRemote: false,
	});
	expect(seen).toEqual(["GET /api/vault/sys/status"]);
});
