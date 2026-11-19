// `ryu secrets agent` leases: issue, when a renewal means "replace it", and
// revocation that reports failures without throwing.

import { describe, expect, test } from "bun:test";
import {
	type HeldLease,
	issueLease,
	renewLease,
	revokeLeases,
} from "../cli/secrets-agentd-leases.ts";
import { agentLease } from "./secrets-agentd-fixture.ts";
import { fakeNode, type Responder } from "./secrets-fixture.ts";

function target(routes: Record<string, Responder>) {
	const node = fakeNode(routes);
	return {
		node,
		agent: {
			url: node.target.url,
			fetch: node.target.fetch,
			vaultToken: "rvt_1",
		},
	};
}

const config = { name: "db", role: "postgres-ro", ttlSecs: 3600 };

function held(overrides: Partial<HeldLease> = {}): HeldLease {
	return {
		config,
		data: { password: "pw" },
		id: "lease_1",
		expiresAtMs: 30_000,
		renewable: true,
		...overrides,
	};
}

test("issueLease keeps the credential and the lease timing", async () => {
	const { agent, node } = target({
		"POST /api/vault/agent/dynamic/postgres-ro": () =>
			Response.json({
				credential: {
					data: { username: "u", password: "pw" },
					lease: agentLease("lease_1", 30_000),
				},
			}),
	});
	expect(await issueLease(agent, config)).toEqual({
		config,
		data: { username: "u", password: "pw" },
		id: "lease_1",
		expiresAtMs: 30_000,
		renewable: true,
	});
	expect(JSON.parse(node.calls[0]?.body ?? "{}")).toEqual({ ttlSecs: 3600 });
});

describe("renewLease", () => {
	test("an extended lease is kept", async () => {
		const { agent } = target({
			"POST /api/vault/agent/leases/lease_1/renew": () =>
				Response.json({ lease: agentLease("lease_1", 60_000) }),
		});
		expect((await renewLease(agent, held()))?.expiresAtMs).toBe(60_000);
	});

	test("no extension, revoked, unknown or refused mean replace it", async () => {
		const cases: Responder[] = [
			() => Response.json({ lease: agentLease("lease_1", 30_000) }),
			() =>
				Response.json({
					lease: { ...agentLease("lease_1", 60_000), revokedAt: 1 },
				}),
			() => Response.json({ error: "unknown" }, { status: 404 }),
			() => Response.json({ error: "max ttl" }, { status: 400 }),
			() => Response.json({ error: "denied" }, { status: 403 }),
		];
		for (const respond of cases) {
			const { agent } = target({
				"POST /api/vault/agent/leases/lease_1/renew": respond,
			});
			expect(await renewLease(agent, held())).toBeNull();
		}
		const { agent, node } = target({});
		expect(await renewLease(agent, held({ renewable: false }))).toBeNull();
		expect(node.calls).toEqual([]);
	});

	test("an outage is thrown so the caller retries", async () => {
		const { agent } = target({
			"POST /api/vault/agent/leases/lease_1/renew": () =>
				Response.json({ error: "down" }, { status: 503 }),
		});
		await expect(renewLease(agent, held())).rejects.toThrow();
	});
});

test("revokeLeases reports a failed revoke and continues", async () => {
	const { agent, node } = target({
		"POST /api/vault/agent/leases/lease_2/revoke": () =>
			Response.json({
				lease: { ...agentLease("lease_2", 0), revokedAt: 1 },
			}),
	});
	let err = "";
	await revokeLeases(agent, [held(), held({ id: "lease_2" })], (text) => {
		err += text;
	});
	expect(node.calls.map((call) => call.route)).toEqual([
		"POST /api/vault/agent/leases/lease_1/revoke",
		"POST /api/vault/agent/leases/lease_2/revoke",
	]);
	expect(err).toContain("Could not revoke lease lease_1");
	expect(err).not.toContain("lease_2");
});
