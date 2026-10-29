import { describe, expect, test } from "bun:test";
import { getFailoverNote, getFailoverVerdict } from "./live-message-flags.ts";

const part = (data: Record<string, unknown>) => ({
	data,
	type: "data-ryu-failover",
});

describe("getFailoverVerdict", () => {
	test("reads wait / held / reroute / no_candidate with their fields", () => {
		expect(
			getFailoverVerdict(
				part({
					agent_id: "acp:codex",
					kind: "wait",
					note: "Every plan is out of room.",
					resets_at: "2026-10-16T15:10:00Z",
				})
			)
		).toEqual({
			agentId: "acp:codex",
			kind: "wait",
			note: "Every plan is out of room.",
			resetsAt: "2026-10-16T15:10:00Z",
		});
		for (const kind of ["held", "reroute", "no_candidate"] as const) {
			expect(getFailoverVerdict(part({ kind, note: "n" }))).toEqual({
				kind,
				note: "n",
			});
		}
	});

	test("unknown kinds, stand and other parts are null", () => {
		expect(getFailoverVerdict(part({ kind: "stand" }))).toBeNull();
		expect(getFailoverVerdict(part({ kind: "later" }))).toBeNull();
		expect(getFailoverVerdict(part({}))).toBeNull();
		expect(
			getFailoverVerdict({ data: { kind: "wait" }, type: "text" })
		).toBeNull();
		expect(getFailoverVerdict(null)).toBeNull();
	});

	test("the note reader is unchanged", () => {
		expect(getFailoverNote(part({ kind: "wait", note: " Moving on " }))).toBe(
			"Moving on"
		);
	});
});
