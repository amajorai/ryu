// apps/desktop/src/lib/picker-favorites.test.ts
//
// Tests for the picker's local Recents/Pinned store. The load-bearing behaviours
// are the REF-KEY scheme (it is the persisted format, so a change silently drops
// everyone's saved picks), recents being move-to-front + deduped + capped, pins
// toggling without reordering, and every reader surviving a hostile or absent
// localStorage — these are UI hints, and a parse failure must degrade to "no
// favorites" rather than throw inside a render.

import { beforeEach, describe, expect, it } from "bun:test";
import {
	DEFAULT_RECENTS_LIMIT,
	getPins,
	getRecents,
	getRecentsLimit,
	isPinned,
	type PickerRef,
	parseRefKey,
	recordRecent,
	refKey,
	setRecentsLimit,
	togglePin,
} from "./picker-favorites.ts";

const agent = (id: string): PickerRef => ({ kind: "agent", agentId: id });
const model = (providerId: string, modelId: string): PickerRef => ({
	kind: "model",
	providerId,
	modelId,
});

/** A minimal in-memory localStorage, reset between tests. */
function installStorage(impl?: Partial<Storage>) {
	const map = new Map<string, string>();
	// `defineProperty`, not assignment. happy-dom's global registration defines
	// `localStorage` as a READONLY property, so `globalThis.localStorage = …`
	// throws "Attempted to assign to readonly property" as soon as any earlier
	// file in the same `bun test` process has registered it.
	const storage = {
		getItem: (k: string) => map.get(k) ?? null,
		setItem: (k: string, v: string) => {
			map.set(k, v);
		},
		removeItem: (k: string) => {
			map.delete(k);
		},
		clear: () => map.clear(),
		key: (i: number) => [...map.keys()][i] ?? null,
		get length() {
			return map.size;
		},
		...impl,
	} satisfies Storage;
	Object.defineProperty(globalThis, "localStorage", {
		configurable: true,
		writable: true,
		value: storage,
	});
	return map;
}

beforeEach(() => {
	installStorage();
});

describe("refKey / parseRefKey", () => {
	it("round-trips both target kinds", () => {
		expect(parseRefKey(refKey(agent("auto")))).toEqual(agent("auto"));
		expect(parseRefKey(refKey(model("openai", "gpt-5")))).toEqual(
			model("openai", "gpt-5")
		);
	});

	it("uses the documented on-disk format", () => {
		// This IS the persisted format — changing it drops every saved pick.
		expect(refKey(agent("ryu"))).toBe("agent:ryu");
		expect(refKey(model("anthropic", "claude-opus-5"))).toBe(
			"pm:anthropic:claude-opus-5"
		);
	});

	it("keeps colons inside a model id, splitting only on the first", () => {
		const ref = model("ollama", "llama3:70b");
		expect(parseRefKey(refKey(ref))).toEqual(ref);
	});

	it("returns null for malformed keys rather than a half-built ref", () => {
		for (const bad of ["", "agent:", "pm:", "pm:openai", "pm::gpt-5", "junk"]) {
			expect(parseRefKey(bad)).toBeNull();
		}
	});
});

describe("recents", () => {
	it("moves a repeat pick to the front instead of duplicating it", () => {
		recordRecent(agent("a"));
		recordRecent(agent("b"));
		recordRecent(agent("a"));
		expect(getRecents()).toEqual(["agent:a", "agent:b"]);
	});

	it("caps the stored list so it cannot grow without bound", () => {
		for (let i = 0; i < 40; i++) {
			recordRecent(agent(`a${i}`));
		}
		const recents = getRecents();
		expect(recents).toHaveLength(20);
		// Newest first: the last write is at the head, the oldest fell off.
		expect(recents[0]).toBe("agent:a39");
		expect(recents).not.toContain("agent:a0");
	});

	it("is empty, not throwing, when storage holds junk", () => {
		localStorage.setItem("ryu_picker_recents", "{not json");
		expect(getRecents()).toEqual([]);
	});

	it("drops non-string entries a hand-edited storage might contain", () => {
		localStorage.setItem("ryu_picker_recents", JSON.stringify(["ok", 7, null]));
		expect(getRecents()).toEqual(["ok"]);
	});
});

describe("pins", () => {
	it("toggles on and off and reports state", () => {
		const ref = model("openai", "gpt-5");
		expect(isPinned(ref)).toBe(false);
		expect(togglePin(ref)).toEqual(["pm:openai:gpt-5"]);
		expect(isPinned(ref)).toBe(true);
		expect(togglePin(ref)).toEqual([]);
		expect(isPinned(ref)).toBe(false);
	});

	it("appends in pin order and leaves existing pins in place", () => {
		togglePin(agent("a"));
		togglePin(agent("b"));
		togglePin(agent("c"));
		expect(getPins()).toEqual(["agent:a", "agent:b", "agent:c"]);
		// Unpinning the middle one does not reorder the survivors.
		togglePin(agent("b"));
		expect(getPins()).toEqual(["agent:a", "agent:c"]);
	});
});

describe("recents limit", () => {
	it("defaults when unset or unparseable", () => {
		expect(getRecentsLimit()).toBe(DEFAULT_RECENTS_LIMIT);
		localStorage.setItem("ryu_picker_recents_limit", "abc");
		expect(getRecentsLimit()).toBe(DEFAULT_RECENTS_LIMIT);
	});

	it("clamps both the setter and the reader to 0..20", () => {
		setRecentsLimit(999);
		expect(getRecentsLimit()).toBe(20);
		setRecentsLimit(-5);
		expect(getRecentsLimit()).toBe(0);
		localStorage.setItem("ryu_picker_recents_limit", "9999");
		expect(getRecentsLimit()).toBe(20);
	});
});

describe("hostile storage", () => {
	it("never throws when writes are rejected (private mode / quota)", () => {
		installStorage({
			setItem: () => {
				throw new Error("QuotaExceededError");
			},
		});
		// Each of these writes; none may propagate the failure into a render.
		expect(() => recordRecent(agent("a"))).not.toThrow();
		expect(() => togglePin(agent("a"))).not.toThrow();
		expect(() => setRecentsLimit(3)).not.toThrow();
	});

	it("reads degrade to empty when getItem itself throws", () => {
		installStorage({
			getItem: () => {
				throw new Error("SecurityError");
			},
		});
		expect(getRecents()).toEqual([]);
		expect(getPins()).toEqual([]);
		expect(getRecentsLimit()).toBe(DEFAULT_RECENTS_LIMIT);
	});
});
