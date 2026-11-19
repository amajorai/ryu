// `ryu-cli secrets audit-device …`, `quota …` and `control-group …`, plus
// `get` on a value a control group gates. Core is faked through the target's
// `fetch`.

import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSecretsArgs } from "../cli/secrets-args.ts";
import { CONTROL_GROUP_PENDING_EXIT } from "../cli/secrets-control-groups.ts";
import { quotaRuleFrom } from "../cli/secrets-sys-admin.ts";
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

const device = {
	id: "siem",
	kind: "http",
	enabled: true,
	description: "",
	hmacFields: true,
	options: { url: "https://siem.example/ingest", secretRef: "secret:SIEM" },
	source: "api",
};

test("audit devices list with health, are set from a file, hashed and deleted", async () => {
	dir = await mkdtemp(join(tmpdir(), "ryu-audit-device-"));
	const file = join(dir, "siem.json");
	await writeFile(
		file,
		JSON.stringify({
			kind: "http",
			options: { url: "https://siem.example/ingest", secretRef: "secret:SIEM" },
		})
	);
	const node = fakeNode({
		"GET /api/vault/audit/devices": json({
			devices: [
				{
					...device,
					health: { failing: true, lastError: "HTTP 503", lastErrorAt: T },
				},
			],
			failClosed: true,
		}),
		"PUT /api/vault/audit/devices/siem": json({ ok: true, device }),
		"POST /api/vault/sys/audit-hash": json({
			device: "siem",
			hash: "hmac-sha256:ab",
		}),
		"DELETE /api/vault/audit/devices/siem": json({ ok: true }),
	});
	const listed = await runSecrets(["audit-device", "list"], node);
	expect(listed.out).toContain("https://siem.example/ingest");
	expect(listed.out).toContain("HTTP 503");
	expect(listed.out).toContain("Fail-closed auditing is on");

	const saved = await runSecrets(["audit-device", "set", "siem", file], node);
	expect(saved.out).toContain("Saved audit device siem (http).");
	expect(JSON.parse(node.calls[1]?.body ?? "{}")).toEqual({
		kind: "http",
		options: { url: "https://siem.example/ingest", secretRef: "secret:SIEM" },
	});
	const hashed = await runSecrets(
		["audit-device", "hash", "siem", "acc_1"],
		node
	);
	expect(hashed.out).toBe("hmac-sha256:ab\n");
	const deleted = await runSecrets(["audit-device", "delete", "siem"], node);
	expect(deleted.out).toContain("Deleted audit device siem.");

	await writeFile(file, JSON.stringify({ kind: "kafka" }));
	const bad = await runSecrets(["audit-device", "set", "siem", file], node);
	expect(bad.code).not.toBe(0);
	expect(node.calls).toHaveLength(4);
});

test("quota flags build exactly one rule kind", () => {
	const rule = (argv: string[]) =>
		quotaRuleFrom(parseSecretsArgs(["quota", "set", "q", ...argv]));
	expect(
		rule([
			"--rate",
			"10",
			"--interval",
			"1m",
			"--block",
			"5m",
			"--path",
			"agent/",
		])
	).toEqual({
		kind: "rate-limit",
		rate: 10,
		intervalSecs: 60,
		blockIntervalSecs: 300,
		path: "agent/",
	});
	expect(rule(["--max-leases", "25", "--role", "db-*"])).toEqual({
		kind: "lease-count",
		role: "db-*",
		maxLeases: 25,
	});
	expect(() => rule([])).toThrow("secrets quota");
	expect(() => rule(["--rate", "1", "--max-leases", "2"])).toThrow(
		"secrets quota"
	);
	expect(() => rule(["--max-leases", "2"])).toThrow("--role");
});

test("quotas list with lease counts, save and delete", async () => {
	const lease = {
		name: "db-cap",
		kind: "lease-count",
		role: "db-*",
		maxLeases: 1,
		builtin: false,
		createdAt: T,
		updatedAt: T,
	};
	const node = fakeNode({
		"GET /api/vault/sys/quotas": json({
			quotas: [
				{
					name: "default-login",
					kind: "rate-limit",
					path: "auth/",
					rate: 60,
					intervalSecs: 60,
					blockIntervalSecs: null,
					builtin: true,
					createdAt: T,
					updatedAt: T,
				},
				lease,
			],
			leases: { total: 3, byRole: { db: 3 } },
		}),
		"PUT /api/vault/sys/quotas/db-cap": json({ quota: lease }),
		"DELETE /api/vault/sys/quotas/db-cap": json({ deleted: true }),
	});
	const listed = await runSecrets(["quota", "list"], node);
	expect(listed.out).toContain("60/60s");
	expect(listed.out).toContain("1 lease");
	expect(listed.out).toContain("Live leases: 3");
	const saved = await runSecrets(
		["quota", "set", "db-cap", "--max-leases", "1", "--role", "db-*"],
		node
	);
	expect(saved.out).toContain("Saved quota db-cap.");
	const deleted = await runSecrets(["quota", "delete", "db-cap"], node);
	expect(deleted.out).toContain("Deleted quota db-cap.");
});

const group = {
	id: "cg_1",
	requester: "user:alice",
	policyKey: "prod/payments/STRIPE_KEY",
	target: { coords: { scope: "user", name: "STRIPE_KEY" }, version: 2 },
	factors: [{ name: "leads", approvers: ["team:security"], approvals: 2 }],
	approvals: [{ factor: "leads", approver: "user:bob", approvedAt: T }],
	status: "pending",
	createdAt: T,
	expiresAt: T,
};

test("control groups list, authorize and redeem; redeem is refused for agents", async () => {
	const node = fakeNode({
		"GET /api/vault/control-groups": json({ controlGroups: [group] }),
		"POST /api/vault/control-groups/cg_1/authorize": json({
			ok: true,
			controlGroup: { ...group, status: "approved" },
		}),
		"POST /api/vault/control-groups/cg_1/redeem": json({
			value: "sk_live_value",
			controlGroup: { ...group, status: "redeemed" },
		}),
	});
	const listed = await runSecrets(["control-group", "list"], node);
	expect(listed.out).toContain("leads 1/2");
	const approved = await runSecrets(
		["control-group", "authorize", "cg_1"],
		node
	);
	expect(approved.out).toContain("approved");
	const redeemed = await runSecrets(
		["control-group", "redeem", "cg_1", "vcg_cg_1.tok"],
		node
	);
	expect(redeemed.out).toBe("sk_live_value\n");
	expect(JSON.parse(node.calls[2]?.body ?? "{}")).toEqual({
		token: "vcg_cg_1.tok",
	});
	const refused = await runSecrets(
		["control-group", "redeem", "cg_1", "vcg_cg_1.tok"],
		node,
		{ env: AGENT_ENV }
	);
	expect(refused.code).toBe(1);
	expect(refused.out).not.toContain("sk_live_value");
	expect(node.calls).toHaveLength(3);
});

test("get on a gated value exits 3 with the redeem command and no value", async () => {
	const node = fakeNode({
		"POST /api/vault/secrets/STRIPE_KEY/reveal": () =>
			Response.json(
				{ ok: true, controlGroup: group, token: "vcg_cg_1.tok" },
				{ status: 202 }
			),
	});
	const result = await runSecrets(["get", "STRIPE_KEY"], node);
	expect(result.code).toBe(CONTROL_GROUP_PENDING_EXIT);
	expect(CONTROL_GROUP_PENDING_EXIT).toBe(3);
	expect(result.out).toBe("");
	expect(result.err).toContain("control-group authorize cg_1");
	expect(result.err).toContain("control-group redeem cg_1 vcg_cg_1.tok");
});
