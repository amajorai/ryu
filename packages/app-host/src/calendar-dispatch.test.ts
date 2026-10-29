import { expect, test } from "bun:test";
import { dispatchRpc, type HostServices } from "./rpc.ts";

test("Calendar dispatch refuses absent grants and malformed input before any host call", async () => {
	const calls: unknown[] = [];
	const services: HostServices = {
		listAgents: async () => {
			throw new Error("Unexpected listAgents");
		},
		registerRoute: async () => {
			throw new Error("Unexpected registerRoute");
		},
		calendarCreateAutomation: async (input) => {
			calls.push(input);
		},
	};
	const input = {
		agentId: "review-agent",
		agentName: "Reviewed",
		schedule: { kind: "every", interval: "1h" },
	};
	await expect(
		dispatchRpc("calendar.createAutomation", [input], new Set(), services)
	).rejects.toThrow(
		"Capability not granted: calendar.crud (required by calendar.createAutomation)"
	);
	for (const malformed of [
		null,
		{ ...input, agentId: "" },
		{ ...input, schedule: { kind: "bad" } },
		{ ...input, requireApproval: "yes" },
		{ ...input, conversationId: 4 },
	]) {
		await expect(
			dispatchRpc(
				"calendar.createAutomation",
				[malformed],
				new Set(["calendar.crud"]),
				services
			)
		).rejects.toThrow("calendar.createAutomation requires");
	}
	expect(calls).toEqual([]);
});

test("Calendar dispatch preserves omitted versus cleared conversation and exact host refusals", async () => {
	const calls: unknown[] = [];
	const refusal = new Error("authoritative schedule write refused");
	let refuse = true;
	const services: HostServices = {
		listAgents: async () => {
			throw new Error("Unexpected listAgents");
		},
		registerRoute: async () => {
			throw new Error("Unexpected registerRoute");
		},
		calendarCreateAutomation: async (input) => {
			calls.push(input);
			if (refuse) {
				refuse = false;
				throw refusal;
			}
		},
	};
	const base = {
		agentId: "review-agent",
		agentName: "Renamed",
		schedule: { kind: "cron", expr: "0 9 * * *" },
		requireApproval: true,
	};
	await expect(
		dispatchRpc(
			"calendar.createAutomation",
			[base],
			new Set(["calendar.crud"]),
			services
		)
	).rejects.toBe(refusal);
	expect(
		await dispatchRpc(
			"calendar.createAutomation",
			[base],
			new Set(["calendar.crud"]),
			services
		)
	).toBeNull();
	const cleared = { ...base, conversationId: null };
	await dispatchRpc(
		"calendar.createAutomation",
		[cleared],
		new Set(["calendar.crud"]),
		services
	);
	const retained = { ...base, conversationId: "persistent-chat" };
	await dispatchRpc(
		"calendar.createAutomation",
		[retained],
		new Set(["calendar.crud"]),
		services
	);
	expect(calls).toEqual([base, base, cleared, retained]);
});
