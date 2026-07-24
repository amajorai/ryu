// Unit tests for the client-side widget-state store (Ryu Apps).
//
// This is the host-lifecycle mirror that lets a widget's ephemeral UI state
// (filters, selection, running tally) survive a remount of the SAME tool row
// within a session. It is a plain zustand store keyed by `toolCallId`, so it is
// DOM-free and exercised directly via getState()/get()/set() — no render needed.

import { beforeEach, describe, expect, it } from "bun:test";
import { useWidgetStateStore } from "./widget-state-store.ts";

describe("useWidgetStateStore", () => {
	beforeEach(() => {
		// Reset the module-global singleton between tests (it is shared across surfaces).
		useWidgetStateStore.setState({ byToolCall: {} });
	});

	it("returns undefined for an unknown toolCallId", () => {
		expect(useWidgetStateStore.getState().get("missing")).toBeUndefined();
	});

	it("round-trips state for a toolCallId via set/get", () => {
		const store = useWidgetStateStore.getState();
		store.set("call-1", { filter: "open", selected: [1, 2] });
		expect(useWidgetStateStore.getState().get("call-1")).toEqual({
			filter: "open",
			selected: [1, 2],
		});
	});

	it("keeps distinct entries per toolCallId (no cross-key clobber)", () => {
		const store = useWidgetStateStore.getState();
		store.set("call-1", { a: 1 });
		store.set("call-2", { b: 2 });
		const after = useWidgetStateStore.getState();
		expect(after.get("call-1")).toEqual({ a: 1 });
		expect(after.get("call-2")).toEqual({ b: 2 });
	});

	it("overwrites the value for an existing toolCallId on a repeat set", () => {
		const store = useWidgetStateStore.getState();
		store.set("call-1", { v: "first" });
		store.set("call-1", { v: "second" });
		expect(useWidgetStateStore.getState().get("call-1")).toEqual({ v: "second" });
	});

	it("set produces a NEW byToolCall map (immutable update, does not mutate prior)", () => {
		const before = useWidgetStateStore.getState().byToolCall;
		useWidgetStateStore.getState().set("call-1", { v: 1 });
		const after = useWidgetStateStore.getState().byToolCall;
		expect(after).not.toBe(before); // fresh reference → subscribers re-render
		expect(before).toEqual({}); // the prior snapshot is untouched
	});
});
