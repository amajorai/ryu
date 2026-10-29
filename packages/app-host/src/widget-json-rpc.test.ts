import { describe, expect, test } from "bun:test";
import type { RouteClaim } from "./rpc.ts";
import { type Capability, dispatchRpc, type HostServices } from "./rpc.ts";

const capabilities: Set<Capability> = new Set(["tool.call", "widget.state"]);

describe("persistable widget JSON", () => {
	test("retains nested tool/state values and absent arguments", async () => {
		const value = { future: [null, { enabled: true }] };
		const reply = { result: value };
		const services: HostServices = {
			listAgents: async () => [],
			registerRoute: async (claim: RouteClaim) => ({ path: claim.path }),
			callTool: async (_name, input) => {
				expect(input).toBe(value);
				return reply;
			},
			setWidgetState: async (state) => {
				expect(state).toBe(value);
			},
		};
		expect(
			await dispatchRpc("tool.call", ["tool", value], capabilities, services)
		).toBe(reply);
		await dispatchRpc("widget.setState", [value], capabilities, services);
		await dispatchRpc("tool.call", ["tool"], capabilities, {
			...services,
			callTool: async (_name, input) => {
				expect(input).toBeUndefined();
				return undefined;
			},
		});
		await dispatchRpc("widget.setState", [undefined], capabilities, {
			...services,
			setWidgetState: async (state) => {
				expect(state).toBeUndefined();
			},
		});
	});
	test("denies non-JSON structured-clone payloads before invoking the host", async () => {
		let calls = 0;
		const services: HostServices = {
			listAgents: async () => [],
			registerRoute: async (claim: RouteClaim) => ({ path: claim.path }),
			callTool: async () => {
				calls += 1;
				return null;
			},
			setWidgetState: async () => {
				calls += 1;
			},
		};
		for (const value of [
			BigInt(1),
			new Map([["key", "value"]]),
			{ nested: { callback: () => null } },
		]) {
			await expect(
				dispatchRpc("tool.call", ["tool", value], capabilities, services)
			).rejects.toMatchObject({ code: "invalid_args" });
			await expect(
				dispatchRpc("widget.setState", [value], capabilities, services)
			).rejects.toMatchObject({ code: "invalid_args" });
		}
		expect(calls).toBe(0);
	});
});
