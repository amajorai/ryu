// `ryu-cli secrets access …`: create, list, show, approve, deny, cancel and
// revoke access requests over Core's `/api/vault/access-requests` routes,
// plus the agent-session refusal for approve and deny.

import { expect, test } from "bun:test";
import { parseCapabilities } from "../cli/secrets-access.ts";
import { fakeNode, json, runSecrets } from "./secrets-fixture.ts";

const PENDING = {
	id: "ar_1",
	requester: "user:alice",
	environment: "prod",
	path: "prod/payments/**",
	capabilities: ["read", "write"],
	durationSecs: 3600,
	reason: "incident 42",
	policies: ["payments"],
	steps: [{ name: "payments/leads", approvers: ["team:leads"], approvals: 2 }],
	approvals: [
		{
			factor: "payments/leads",
			approver: "user:bob",
			approvedAt: "2026-01-01T00:01:00Z",
		},
	],
	status: "pending",
	currentStep: "payments/leads",
	createdAt: "2026-01-01T00:00:00Z",
	expiresAt: "2026-01-02T00:00:00Z",
};

const GRANTED = {
	...PENDING,
	status: "granted",
	currentStep: undefined,
	grantPolicy: "access-ar_1",
	grantedAt: "2026-01-01T00:05:00Z",
	grantExpiresAt: "2026-01-01T01:05:00Z",
};

test("access request posts path, capabilities, duration and reason", async () => {
	const node = fakeNode({
		"POST /api/vault/access-requests": () =>
			Response.json({ ok: true, accessRequest: PENDING }, { status: 201 }),
	});
	const result = await runSecrets(
		[
			"access",
			"request",
			"prod/payments/**",
			"--capability",
			"read,write",
			"--capability",
			"read",
			"--ttl",
			"1h",
			"--reason",
			"incident 42",
		],
		node
	);
	expect(result.code).toBe(0);
	expect(result.out).toContain(
		"Access request ar_1 is pending; waiting on payments/leads."
	);
	expect(JSON.parse(node.calls[0]?.body ?? "")).toEqual({
		path: "prod/payments/**",
		capabilities: ["read", "write"],
		durationSecs: 3600,
		reason: "incident 42",
	});
});

test("access request needs a capability, a duration and a reason", async () => {
	const node = fakeNode({});
	for (const argv of [
		["access", "request", "prod/**", "--ttl", "1h", "--reason", "r"],
		["access", "request", "prod/**", "--capability", "read", "--reason", "r"],
		["access", "request", "prod/**", "--capability", "read", "--ttl", "1h"],
		[
			"access",
			"request",
			"prod/**",
			"--capability",
			"admin",
			"--ttl",
			"1h",
			"--reason",
			"r",
		],
	]) {
		const result = await runSecrets(argv, node);
		expect(result.code).toBe(2);
	}
	expect(node.calls).toHaveLength(0);
});

test("access list shows requests and filters by --status", async () => {
	const node = fakeNode({
		"GET /api/vault/access-requests": json({
			accessRequests: [PENDING, { ...GRANTED, id: "ar_2" }],
		}),
	});
	const all = await runSecrets(["access", "list"], node);
	expect(all.code).toBe(0);
	expect(all.out).toContain(
		"ar_1  pending (payments/leads)  prod/payments/**  read,write  3600s  user:alice"
	);
	expect(all.out).toContain("ar_2  granted");
	const granted = await runSecrets(
		["access", "list", "--status", "granted", "--json"],
		node
	);
	expect(
		JSON.parse(granted.out).map((request: { id: string }) => request.id)
	).toEqual(["ar_2"]);
	const none = await runSecrets(["access", "list", "--status", "denied"], node);
	expect(none.out).toBe("No access requests.\n");
});

test("access get shows each step's progress and the grant expiry", async () => {
	const node = fakeNode({
		"GET /api/vault/access-requests/ar_1": json({ accessRequest: GRANTED }),
	});
	const result = await runSecrets(["access", "get", "ar_1"], node);
	expect(result.code).toBe(0);
	expect(result.out).toContain("Reason: incident 42");
	expect(result.out).toContain("payments/leads: 1/2  team:leads");
	expect(result.out).toContain("Granted until 2026-01-01T01:05:00Z.");
});

test("approve, deny with a reason, cancel and revoke post to their routes", async () => {
	const decided = (status: string) => () =>
		Response.json({ ok: true, accessRequest: { ...PENDING, status } });
	const node = fakeNode({
		"POST /api/vault/access-requests/ar_1/approve": decided("granted"),
		"POST /api/vault/access-requests/ar_1/deny": decided("denied"),
		"POST /api/vault/access-requests/ar_1/cancel": decided("cancelled"),
		"POST /api/vault/access-requests/ar_1/revoke": decided("revoked"),
	});
	const approve = await runSecrets(["access", "approve", "ar_1"], node);
	expect(approve.out).toBe(
		"Approved access request ar_1; it is now granted.\n"
	);
	const deny = await runSecrets(
		["access", "deny", "ar_1", "--reason", "too broad"],
		node
	);
	expect(deny.out).toBe("Denied access request ar_1.\n");
	const cancel = await runSecrets(["access", "cancel", "ar_1"], node);
	expect(cancel.out).toBe("Cancelled access request ar_1.\n");
	const revoke = await runSecrets(["access", "revoke", "ar_1"], node);
	expect(revoke.out).toBe("Revoked access request ar_1.\n");
	expect(node.calls.map((call) => call.body)).toEqual([
		"{}",
		JSON.stringify({ reason: "too broad" }),
		"{}",
		"{}",
	]);
});

test("a Core refusal surfaces as an error", async () => {
	const node = fakeNode({
		"POST /api/vault/access-requests/ar_1/approve": () =>
			Response.json(
				{ error: "vault_denied: requesters cannot approve their own request" },
				{ status: 403 }
			),
	});
	const result = await runSecrets(["access", "approve", "ar_1"], node);
	expect(result.code).not.toBe(0);
	expect(result.err).toContain("approve failed: 403");
});

test("an AI agent session cannot approve or deny, but can request and cancel", async () => {
	const node = fakeNode({
		"POST /api/vault/access-requests/ar_1/cancel": () =>
			Response.json({
				ok: true,
				accessRequest: { ...PENDING, status: "cancelled" },
			}),
	});
	const env = { HOME: "/home/me", CLAUDECODE: "1" };
	for (const action of ["approve", "deny"]) {
		const result = await runSecrets(["access", action, "ar_1"], node, { env });
		expect(result.code).toBe(1);
		expect(result.err).toContain(
			"Refusing to decide an access request in an AI agent session"
		);
	}
	expect(node.calls).toHaveLength(0);
	const cancel = await runSecrets(["access", "cancel", "ar_1"], node, { env });
	expect(cancel.code).toBe(0);
});

test("access policies lists who approves what", async () => {
	const node = fakeNode({
		"GET /api/vault/access-policies": json({
			accessPolicies: [
				{
					name: "payments",
					description: "",
					path: "prod/payments/**",
					capabilities: ["read"],
					maxDurationSecs: 86_400,
					steps: [{ name: "leads", approvers: ["team:leads"], approvals: 2 }],
				},
			],
		}),
	});
	const result = await runSecrets(["access", "policies"], node);
	expect(result.out).toBe(
		"payments  prod/payments/**  read  max 86400s  leads 2/team:leads\n"
	);
});

test("parseCapabilities splits, dedupes and refuses admin and approve", () => {
	expect(parseCapabilities(["read, write", "read", ""])).toEqual([
		"read",
		"write",
	]);
	expect(() => parseCapabilities(["approve"])).toThrow("cannot be requested");
});
