import { describe, expect, test } from "bun:test";
import type { RouteClaim } from "./rpc.ts";
import { type Capability, dispatchRpc, type HostServices } from "./rpc.ts";

const capabilities: Set<Capability> = new Set(["approvals.crud"]);

describe("notification archive filter boundary", () => {
	test("retains both archive selections and absent-filter semantics", async () => {
		const received: Parameters<
			NonNullable<HostServices["notificationsList"]>
		>[0][] = [];
		const services: HostServices = {
			listAgents: async () => [],
			registerRoute: async (claim: RouteClaim) => ({ path: claim.path }),
			notificationsList: async (input) => {
				received.push(input);
				return [];
			},
		};
		for (const input of [
			undefined,
			{},
			{ archived: false },
			{ archived: true },
		]) {
			expect(
				await dispatchRpc("notifications.list", [input], capabilities, services)
			).toEqual([]);
		}
		expect(received).toEqual([
			undefined,
			{},
			{ archived: false },
			{ archived: true },
		]);
	});
	test("refuses invalid filters before invoking the privileged service", async () => {
		let calls = 0;
		const services: HostServices = {
			listAgents: async () => [],
			registerRoute: async (claim: RouteClaim) => ({ path: claim.path }),
			notificationsList: async () => {
				calls++;
				return [];
			},
		};
		for (const input of [
			null,
			1,
			"true",
			{ archived: "true" },
			{ archived: 0 },
			{ archived: null },
		]) {
			await expect(
				dispatchRpc("notifications.list", [input], capabilities, services)
			).rejects.toMatchObject({ code: "invalid_args" });
		}
		expect(calls).toBe(0);
	});
});
