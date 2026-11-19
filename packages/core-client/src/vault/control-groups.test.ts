import { expect, test } from "bun:test";
import {
	authorizeVaultControlGroup,
	getVaultCapabilitiesSelf,
	getVaultControlGroup,
	listVaultControlGroups,
	redeemVaultControlGroup,
	revealVaultSecretGated,
} from "./control-groups.ts";

interface Seen {
	body: unknown;
	method: string;
	url: string;
}

function fakeCore(reply: unknown, status = 200) {
	const seen: Seen[] = [];
	const fetch = (input: RequestInfo | URL, init?: RequestInit) => {
		const url = new URL(String(input));
		seen.push({
			url: `${url.pathname}${url.search}`,
			method: init?.method ?? "GET",
			body: init?.body ? JSON.parse(String(init.body)) : undefined,
		});
		return Promise.resolve(Response.json(reply, { status }));
	};
	return {
		seen,
		target: { url: "http://127.0.0.1:7777", token: "node-token", fetch },
	};
}

// `ControlGroupRequest` (camelCase, `redeemedAt` skipped when absent) with
// RFC 3339 timestamps, as `respond` renders it.
const pending = {
	id: "cg_1",
	requester: "user:alice",
	policyKey: "prod/payments/STRIPE_KEY",
	target: {
		coords: {
			scope: "node",
			scopeId: "n1",
			environment: "prod",
			path: "/payments",
			name: "STRIPE_KEY",
		},
		version: 4,
	},
	factors: [{ name: "leads", approvers: ["team:security"], approvals: 2 }],
	approvals: [
		{
			factor: "leads",
			approver: "user:bob",
			approvedAt: "2030-01-01T00:05:00+00:00",
		},
	],
	status: "pending",
	createdAt: "2030-01-01T00:00:00+00:00",
	expiresAt: "2030-01-02T00:00:00+00:00",
};

test("requests list, read and authorize by encoded id", async () => {
	const listed = fakeCore({ controlGroups: [pending] });
	const { controlGroups } = await listVaultControlGroups(listed.target);
	expect(controlGroups[0]?.factors[0]?.approvals).toBe(2);
	expect(controlGroups[0]?.redeemedAt).toBeUndefined();
	expect(listed.seen[0]?.url).toBe("/api/vault/control-groups");

	const one = fakeCore({ controlGroup: pending });
	await getVaultControlGroup(one.target, "cg/1");
	expect(one.seen[0]?.url).toBe("/api/vault/control-groups/cg%2F1");

	const approved = fakeCore({
		ok: true,
		controlGroup: { ...pending, status: "approved" },
	});
	const result = await authorizeVaultControlGroup(approved.target, "cg_1");
	expect(result.controlGroup.status).toBe("approved");
	expect(approved.seen[0]).toMatchObject({
		url: "/api/vault/control-groups/cg_1/authorize",
		method: "POST",
	});
});

test("an unknown status is rejected", async () => {
	const { target } = fakeCore({
		controlGroups: [{ ...pending, status: "held" }],
	});
	await expect(listVaultControlGroups(target)).rejects.toThrow();
});

test("redeem sends the token and returns the pinned value", async () => {
	const { seen, target } = fakeCore({
		value: "sk_live_1",
		controlGroup: {
			...pending,
			status: "redeemed",
			redeemedAt: "2030-01-01T01:00:00+00:00",
		},
	});
	const redeemed = await redeemVaultControlGroup(
		target,
		"cg_1",
		"vcg_cg_1.tok"
	);
	expect(redeemed.value).toBe("sk_live_1");
	expect(seen[0]).toEqual({
		url: "/api/vault/control-groups/cg_1/redeem",
		method: "POST",
		body: { token: "vcg_cg_1.tok" },
	});
});

test("a gated reveal returns the value or the opened request", async () => {
	const open = fakeCore(
		{ ok: true, controlGroup: pending, token: "vcg_cg_1.tok" },
		202
	);
	const gated = await revealVaultSecretGated(open.target, "STRIPE_KEY", {
		scope: "node",
		environment: "prod",
		path: "/payments",
	});
	expect(gated).toMatchObject({
		status: "control_group",
		token: "vcg_cg_1.tok",
	});
	expect(open.seen[0]).toMatchObject({
		url: "/api/vault/secrets/STRIPE_KEY/reveal",
		method: "POST",
		body: { scope: "node", environment: "prod", path: "/payments" },
	});
	const plain = fakeCore({ value: "v1" });
	expect(
		await revealVaultSecretGated(plain.target, "A", { scope: "user" })
	).toEqual({ status: "revealed", value: "v1" });
});

test("capabilities-self joins the keys into one query", async () => {
	const { seen, target } = fakeCore({
		paths: {
			"prod/payments/STRIPE_KEY": {
				capabilities: ["read"],
				controlGroup: true,
			},
			"sys/quotas": { capabilities: [], controlGroup: false },
		},
	});
	const result = await getVaultCapabilitiesSelf(target, [
		"prod/payments/STRIPE_KEY",
		"sys/quotas",
	]);
	expect(result.paths["prod/payments/STRIPE_KEY"]?.controlGroup).toBe(true);
	expect(seen[0]?.url).toBe(
		"/api/vault/capabilities-self?paths=prod%2Fpayments%2FSTRIPE_KEY%2Csys%2Fquotas"
	);
});
