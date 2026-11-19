// Wire tests for the vault audit-device and control-group calls on a loopback
// node, with replies in the shapes Core renders (`audit_devices.rs`,
// `policy_ext/control_groups.rs`).

import { afterEach, expect, test } from "bun:test";
import {
	authorizeVaultControlGroup,
	controlGroupProgress,
	listVaultAuditDevices,
	listVaultControlGroups,
	type VaultControlGroup,
} from "./vault-admin.ts";

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
			token: "admin-node-token",
			url: `http://127.0.0.1:${server.port}`,
			userJwt: null,
		},
	};
}

const T = "2030-01-01T00:00:00+00:00";

const group: VaultControlGroup = {
	id: "cg/1",
	requester: "user:alice",
	policyKey: "prod/payments/STRIPE_KEY",
	target: { coords: { name: "STRIPE_KEY" }, version: 2 },
	factors: [
		{ name: "leads", approvers: ["team:security"], approvals: 2 },
		{ name: "owner", approvers: ["user:carol"], approvals: 1 },
	],
	approvals: [
		{ factor: "leads", approver: "user:bob", approvedAt: T },
		{ factor: "leads", approver: "user:bob", approvedAt: T },
		{ factor: "owner", approver: "user:carol", approvedAt: T },
	],
	status: "pending",
	createdAt: T,
	expiresAt: T,
};

test("audit devices list with their health and the fail-closed flag", async () => {
	const { seen, target } = node({
		devices: [
			{
				id: "local",
				kind: "file",
				enabled: true,
				description: "",
				hmacFields: true,
				options: { path: "/var/lib/ryu/audit/vault.log" },
				source: "declarative",
				health: { failing: false, lastOkAt: T },
			},
		],
		failClosed: true,
	});
	const listing = await listVaultAuditDevices(target);
	expect(listing.failClosed).toBe(true);
	expect(listing.devices[0]?.health.lastOkAt).toBe(T);
	expect(seen).toEqual(["GET /api/vault/audit/devices"]);
});

test("a device of an unknown kind is rejected", async () => {
	const { target } = node({
		devices: [
			{
				id: "x",
				kind: "kafka",
				enabled: true,
				description: "",
				hmacFields: true,
				options: {},
				source: "api",
				health: { failing: false },
			},
		],
		failClosed: false,
	});
	await expect(listVaultAuditDevices(target)).rejects.toThrow();
});

test("control groups list and authorize by encoded id", async () => {
	const listed = node({ controlGroups: [group] });
	expect(await listVaultControlGroups(listed.target)).toHaveLength(1);
	const approved = node({
		ok: true,
		controlGroup: { ...group, status: "approved" },
	});
	const result = await authorizeVaultControlGroup(approved.target, "cg/1");
	expect(result.status).toBe("approved");
	expect(approved.seen).toEqual([
		"POST /api/vault/control-groups/cg%2F1/authorize {}",
	]);
});

test("progress counts distinct approvers per factor, capped at the requirement", () => {
	expect(controlGroupProgress(group)).toEqual([
		{ factor: "leads", given: 1, required: 2 },
		{ factor: "owner", given: 1, required: 1 },
	]);
});
