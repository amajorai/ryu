import { expect, test } from "bun:test";
import type { RouteClaim } from "./rpc.ts";
import { type Capability, dispatchRpc, type HostServices } from "./rpc.ts";

test("backup methods reject a frame without the backup capability", async () => {
	let invoked = false;
	const services: HostServices = {
		listAgents: async () => [],
		registerRoute: async (claim: RouteClaim) => ({ path: claim.path }),
		backupsRequest: async () => {
			invoked = true;
			return {};
		},
	};
	for (const method of [
		"backups.destinations",
		"backups.create",
		"backups.list",
		"backups.get",
		"backups.restore",
	]) {
		await expect(
			dispatchRpc(method, [{}], new Set<Capability>(), services)
		).rejects.toThrow();
	}
	expect(invoked).toBe(false);
});

test("granted frame forwards snapshot arguments through the existing host bridge", async () => {
	const calls: unknown[] = [];
	const operation = {
		action: "create",
		backup: null,
		completedAt: null,
		createdAt: "2026-10-06T00:00:00Z",
		destinationId: "dest",
		error: null,
		id: "backup",
		result: null,
		scope: {
			appId: "notes",
			kind: "app",
			namespace: "records",
			tenant: "tenant",
		},
		status: "queued",
	};
	const services: HostServices = {
		listAgents: async () => [],
		registerRoute: async (claim: RouteClaim) => ({ path: claim.path }),
		backupsRequest: async (method, input) => {
			calls.push({ method, input });
			return operation;
		},
	};
	const input = {
		destinationId: "dest",
		namespace: "records",
		idempotencyKey: "save-1",
		data: { records: [] },
	};
	expect(
		await dispatchRpc(
			"backups.create",
			[input],
			new Set<Capability>(["backups.app"]),
			services
		)
	).toBe(operation);
	expect(calls).toEqual([{ method: "backups.create", input }]);
});
