// `ryu-cli secrets machine …` and `token list|create|revoke|roles|role`:
// machine identities, token settings, secret ids and token administration.
// Core is faked through the target's `fetch`.

import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSecretsArgs } from "../cli/secrets-args.ts";
import { tokenConfigFrom } from "../cli/secrets-machines.ts";
import { tokenRequestFrom } from "../cli/secrets-token-admin.ts";
import { fakeNode, json, runSecrets } from "./secrets-fixture.ts";

const AGENT_ENV = { HOME: "/home/me", CLAUDECODE: "1" };
const T = "2026-01-01T00:00:00Z";

let dir: string | null = null;
afterEach(async () => {
	if (dir) {
		await rm(dir, { recursive: true, force: true });
		dir = null;
	}
});

function machine(name: string, auth: Record<string, unknown>) {
	return {
		id: `mi_${name}`,
		name,
		auth,
		policies: ["ci"],
		tokenTtlSecs: 900,
		disabled: false,
		createdAt: T,
		createdBy: null,
		tokenConfig: {},
	};
}

const runner = machine("runner", { kind: "approle", role_id: "role-1" });
const k8s = machine("web", {
	kind: "kubernetes",
	host: "https://10.0.0.1:6443",
	caPem: null,
	reviewerJwtEnv: null,
	boundServiceAccountNames: ["web"],
	boundServiceAccountNamespaces: ["prod"],
	audiences: [],
});

const tokenInfo = {
	accessor: "acc_1",
	boundCidrs: [],
	createdAt: T,
	expiresAt: "2026-01-01T00:15:00Z",
	identityId: "mi_runner",
	lastUsedAt: null,
	maxExpiresAt: null,
	numUsesRemaining: null,
	orphan: false,
	parentAccessor: null,
	periodSecs: null,
	policies: ["ci"],
	renewable: true,
	revokedAt: null,
	role: "deploy",
	ttlSecs: 900,
};

const role = {
	name: "deploy",
	allowedPolicies: ["ci"],
	disallowedPolicies: ["root"],
	orphan: false,
	ttlSecs: 900,
	createdAt: T,
	updatedAt: T,
};

test("machine list shows every auth kind without secrets", async () => {
	const node = fakeNode({
		"GET /api/vault/machines": json({ machines: [runner, k8s] }),
	});
	const result = await runSecrets(["machine", "list"], node);
	expect(result.code).toBe(0);
	expect(result.out).toContain("approle role-1");
	expect(result.out).toContain("kubernetes prod");
});

test("machine create defaults to AppRole and reads other kinds from a file", async () => {
	const node = fakeNode({
		"POST /api/vault/machines": json({ machine: runner }),
	});
	const plain = await runSecrets(
		["machine", "create", "runner", "--policy", "ci", "--ttl", "15m"],
		node
	);
	expect(plain.code).toBe(0);
	expect(JSON.parse(node.calls[0]?.body ?? "{}")).toEqual({
		name: "runner",
		auth: { kind: "approle" },
		policies: ["ci"],
		tokenTtlSecs: 900,
	});
	expect(plain.err).toContain("machine secret-id runner");

	dir = await mkdtemp(join(tmpdir(), "ryu-machine-"));
	const file = join(dir, "k8s.json");
	await writeFile(
		file,
		JSON.stringify({
			kind: "kubernetes",
			host: "https://10.0.0.1:6443",
			boundServiceAccountNames: ["web"],
			boundServiceAccountNamespaces: ["prod"],
		})
	);
	await runSecrets(["machine", "create", "web", file], node);
	expect(JSON.parse(node.calls[1]?.body ?? "{}").auth).toMatchObject({
		kind: "kubernetes",
		boundServiceAccountNamespaces: ["prod"],
	});

	await writeFile(file, JSON.stringify({ kind: "ldap" }));
	const bad = await runSecrets(["machine", "create", "x", file], node);
	expect(bad.code).not.toBe(0);
	expect(bad.err).toContain("needs a kind");
	expect(node.calls).toHaveLength(2);
});

test("update patches only the given fields and token-config replaces settings", async () => {
	const node = fakeNode({
		"PATCH /api/vault/machines/runner": json({ machine: runner }),
		"PUT /api/vault/machines/runner/token-config": json({ machine: runner }),
	});
	await runSecrets(["machine", "update", "runner", "--disable"], node);
	expect(JSON.parse(node.calls[0]?.body ?? "{}")).toEqual({ disabled: true });
	const empty = await runSecrets(["machine", "update", "runner"], node);
	expect(empty.code).not.toBe(0);
	const saved = await runSecrets(
		[
			"machine",
			"token-config",
			"runner",
			"--max-ttl",
			"1h",
			"--uses",
			"5",
			"--cidr",
			"10.0.0.0/8",
			"--not-renewable",
		],
		node
	);
	expect(saved.out).toContain("Saved token settings for runner.");
	expect(JSON.parse(node.calls[1]?.body ?? "{}")).toEqual({
		maxTtlSecs: 3600,
		numUses: 5,
		boundCidrs: ["10.0.0.0/8"],
		renewable: false,
	});
});

test("secret-id prints the value once and is refused in an agent session", async () => {
	const node = fakeNode({
		"POST /api/vault/machines/runner/secret-ids": json({
			secretId: "sid_value",
			info: {
				accessor: "sa_1",
				createdAt: T,
				expiresAt: null,
				usesRemaining: 1,
			},
		}),
		"GET /api/vault/machines/runner/secret-ids": json({
			secretIds: [
				{ accessor: "sa_1", createdAt: T, expiresAt: null, usesRemaining: 1 },
			],
		}),
	});
	const issued = await runSecrets(
		["machine", "secret-id", "runner", "--uses", "1"],
		node
	);
	expect(issued.out).toBe("sid_value\n");
	expect(issued.err).toContain("sa_1");
	expect(JSON.parse(node.calls[0]?.body ?? "{}")).toEqual({ uses: 1 });
	const listed = await runSecrets(["machine", "secret-ids", "runner"], node);
	expect(listed.out).toContain("sa_1");
	expect(listed.out).not.toContain("sid_value");

	const refused = await runSecrets(["machine", "secret-id", "runner"], node, {
		env: AGENT_ENV,
	});
	expect(refused.code).toBe(1);
	expect(refused.out).toBe("");
	expect(node.calls).toHaveLength(2);
});

test("token list, create and revoke; create is refused for agents", async () => {
	const node = fakeNode({
		"GET /api/vault/tokens": json({ tokens: [tokenInfo] }),
		"POST /api/vault/tokens": json({
			token: {
				token: "rvt_new",
				accessor: "acc_2",
				identityId: "mi_runner",
				policies: ["ci"],
				expiresAt: T,
			},
		}),
		"POST /api/vault/tokens/acc_1/revoke": json({ revoked: true }),
		"POST /api/vault/tokens/acc_1/revoke-orphan": json({
			revoked: { tokens: 1, leasesRevoked: 2, leasesFailed: 0 },
		}),
	});
	const listed = await runSecrets(
		["token", "list", "--identity", "runner"],
		node
	);
	expect(listed.out).toContain("acc_1");
	expect(node.calls[0]?.path).toBe("/api/vault/tokens?identity=runner");

	const created = await runSecrets(
		["token", "create", "runner", "--policy", "ci", "--ttl", "1h", "--orphan"],
		node
	);
	expect(created.out).toBe("rvt_new\n");
	expect(JSON.parse(node.calls[1]?.body ?? "{}")).toEqual({
		identity: "runner",
		policies: ["ci"],
		ttlSecs: 3600,
		orphan: true,
	});
	const refused = await runSecrets(["token", "create", "runner"], node, {
		env: AGENT_ENV,
	});
	expect(refused.code).toBe(1);
	expect(node.calls).toHaveLength(2);

	const revoked = await runSecrets(["token", "revoke", "acc_1"], node);
	expect(revoked.out).toContain("Revoked acc_1 and its child tokens.");
	const orphaned = await runSecrets(
		["token", "revoke", "acc_1", "--orphan"],
		node
	);
	expect(orphaned.out).toContain("2 leases revoked");
});

test("token roles list, show, set from a file, and delete", async () => {
	dir = await mkdtemp(join(tmpdir(), "ryu-role-"));
	const file = join(dir, "role.json");
	await writeFile(
		file,
		JSON.stringify({ allowedPolicies: ["ci"], ttlSecs: 900 })
	);
	const node = fakeNode({
		"GET /api/vault/token-roles": json({ roles: [role] }),
		"GET /api/vault/token-roles/deploy": json({ role }),
		"PUT /api/vault/token-roles/deploy": json({ role }),
		"DELETE /api/vault/token-roles/deploy": json({ deleted: true }),
	});
	expect((await runSecrets(["token", "roles"], node)).out).toContain("deploy");
	expect(
		(await runSecrets(["token", "role", "show", "deploy"], node)).out
	).toContain("root");
	await runSecrets(["token", "role", "set", "deploy", file], node);
	expect(JSON.parse(node.calls[2]?.body ?? "{}")).toEqual({
		allowedPolicies: ["ci"],
		ttlSecs: 900,
	});
	const deleted = await runSecrets(["token", "role", "delete", "deploy"], node);
	expect(deleted.out).toContain("Deleted token role deploy.");
});

test("token flags map to Core's token request and token config fields", () => {
	const args = (argv: string[]) => parseSecretsArgs(argv);
	expect(
		tokenRequestFrom(
			args([
				"token",
				"create",
				"runner",
				"--role",
				"deploy",
				"--period",
				"1h",
				"--explicit-max-ttl",
				"1d",
				"--uses",
				"3",
				"--cidr",
				"10.0.0.0/8",
				"--not-renewable",
			])
		)
	).toEqual({
		role: "deploy",
		periodSecs: 3600,
		explicitMaxTtlSecs: 86_400,
		numUses: 3,
		boundCidrs: ["10.0.0.0/8"],
		renewable: false,
	});
	expect(tokenRequestFrom(args(["token", "create", "runner"]))).toEqual({});
	expect(
		tokenConfigFrom(
			args(["machine", "token-config", "x", "--period", "30m", "--renewable"])
		)
	).toEqual({ periodSecs: 1800, renewable: true });
	expect(() =>
		tokenConfigFrom(args(["machine", "token-config", "x", "--max-ttl", "soon"]))
	).toThrow("Invalid duration");
});
