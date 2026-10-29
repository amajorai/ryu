import { describe, expect, test } from "bun:test";
import type { AgentUiSavedState } from "@ryu/blocks/desktop/agent-elements/agent-ui/state-host-context.tsx";
import { jsonEqual, mergeServerRead } from "./agent-ui-state-merge.ts";

function states(
	entries: Record<string, AgentUiSavedState>
): Map<string, AgentUiSavedState> {
	return new Map(Object.entries(entries));
}

const never = () => false;

describe("jsonEqual", () => {
	test("ignores object key order but not array order", () => {
		expect(jsonEqual({ a: 1, b: [1, 2] }, { b: [1, 2], a: 1 })).toBe(true);
		expect(jsonEqual({ b: [2, 1] }, { b: [1, 2] })).toBe(false);
		expect(jsonEqual({ a: 1 }, { a: 1, b: undefined })).toBe(false);
		expect(jsonEqual([], {})).toBe(false);
		expect(jsonEqual(null, {})).toBe(false);
	});
});

describe("mergeServerRead", () => {
	test("a collaborator's edit replaces a copy with no newer local edit", () => {
		const local = states({ list: { state: { done: [false] } } });
		const server = states({ list: { state: { done: [true] } } });
		const merged = mergeServerRead(local, server, never);
		expect(merged.changed).toBe(true);
		expect(merged.keptLocal).toBe(false);
		expect(merged.states.get("list")?.state).toEqual({ done: [true] });
	});

	test("a newer local copy outranks the read and flags the cache", () => {
		const local = states({ list: { state: { done: [true, true] } } });
		const server = states({
			list: { state: { done: [true, false] } },
			other: { state: { x: 1 } },
		});
		const merged = mergeServerRead(local, server, (id) => id === "list");
		expect(merged.keptLocal).toBe(true);
		expect(merged.changed).toBe(true);
		expect(merged.states.get("list")?.state).toEqual({ done: [true, true] });
		expect(merged.states.get("other")?.state).toEqual({ x: 1 });
	});

	test("an identical read changes nothing, so widgets need not remount", () => {
		const local = states({ list: { state: { a: 1, b: 2 }, title: "List" } });
		const server = states({ list: { title: "List", state: { b: 2, a: 1 } } });
		const merged = mergeServerRead(local, server, () => true);
		expect(merged).toMatchObject({ changed: false, keptLocal: false });
	});

	test("unchanged entries keep their local object when another one changes", () => {
		const page = { state: { score: 3 }, title: "Game" };
		const local = states({ list: { state: { done: [false] } }, page });
		const server = states({
			list: { state: { done: [true] } },
			page: { title: "Game", state: { score: 3 } },
		});
		const merged = mergeServerRead(local, server, never);
		expect(merged.changed).toBe(true);
		// Same value, same object: an artifact page's frame is not reloaded.
		expect(merged.states.get("page")).toBe(page);
		expect(merged.states.get("list")?.state).toEqual({ done: [true] });
	});

	test("a widget gone from the server is dropped unless newer locally", () => {
		const local = states({ gone: { state: {} }, kept: { state: { v: 1 } } });
		const merged = mergeServerRead(local, new Map(), (id) => id === "kept");
		expect([...merged.states.keys()]).toEqual(["kept"]);
		expect(merged.changed).toBe(true);
	});
});
