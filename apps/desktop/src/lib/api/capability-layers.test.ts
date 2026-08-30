// apps/desktop/src/lib/api/capability-layers.test.ts
//
// One question, asked two ways: **does picking this provider actually make the
// capability serve?**
//
// It shipped answered wrong. `canServe` did not exist and every picker read
// `servesVerbs` alone, so the five `document.parse` backends — which are served by
// Core calling their sidecar route directly and therefore declare zero verbs BY
// DESIGN — rendered disabled with "serves no verbs yet", including the bound
// default. Parsing worked the whole time; only the picker claimed otherwise, so
// nothing errored and nothing failed. Two individually-defensible halves (a
// capability with no verbs; a picker that gates on verbs) met and produced a dead
// layer.
//
//  1. TRUTH-TABLE tests over `canServe`. Cheap, and they pin the one case with no
//     provider in the repo to exercise it: serves neither ⇒ false. That branch is
//     unreachable in-tree today, which is exactly why it needs a test — it is the
//     guard a third-party manifest declaring a capability it cannot serve must
//     trip, and an unreachable guard is one refactor from being deleted as dead.
//
//  2. WIRE tests over `toProvider`'s fallbacks, asserted through
//     `fetchCapabilityLayers` because the mapper is not exported. The two fields
//     degrade in OPPOSITE directions against an older Core and both choices are
//     deliberate, so both are pinned: `serves_verbs` falls back to the verb array
//     (an old Core still sends it), while `serves_route` cannot fall back at all
//     (the route lives in a manifest only Core reads) and must not be guessed
//     `true` — that would offer a pick resolving to nothing on every verb-backed
//     provider that omits the field.

import { describe, expect, it } from "bun:test";
import {
	type CapabilityProvider,
	canServe,
	fetchCapabilityLayers,
} from "./capability-layers.ts";
import type { ApiTarget } from "./client.ts";

const TARGET: ApiTarget = {
	url: "http://127.0.0.1:7777",
	token: null,
	userJwt: null,
};

/** A provider with both serving flags off, overridden per case. */
function provider(over: Partial<CapabilityProvider>): CapabilityProvider {
	return {
		id: "@ryu/x",
		isDefault: false,
		name: "X",
		servesRoute: false,
		servesVerbs: false,
		target: null,
		verbs: [],
		version: "1.0.0",
		...over,
	};
}

/** Run `run` with `globalThis.fetch` answering every call with `payload`. */
async function withPayload<T>(
	payload: unknown,
	run: () => Promise<T>
): Promise<T> {
	const original = globalThis.fetch;
	globalThis.fetch = (async () => ({
		ok: true,
		status: 200,
		headers: new Headers({ "content-type": "application/json" }),
		json: async () => payload,
		text: async () => JSON.stringify(payload),
	})) as unknown as typeof fetch;
	try {
		return await run();
	} finally {
		globalThis.fetch = original;
	}
}

/** `/api/capabilities` carrying one provider row exactly as given. */
function payloadWith(row: Record<string, unknown>) {
	return {
		capabilities: [
			{
				capability: "document.parse",
				providers: [row],
				available: [],
				bound: null,
				overridden: false,
				selectable: true,
			},
		],
		verbs: [],
	};
}

/** The single mapped provider from a one-row payload. */
async function firstProvider(
	row: Record<string, unknown>
): Promise<CapabilityProvider> {
	const model = await withPayload(payloadWith(row), () =>
		fetchCapabilityLayers(TARGET)
	);
	const found = model.capabilities[0]?.providers[0];
	if (!found) {
		throw new Error("payload must map to exactly one provider row");
	}
	return found;
}

describe("canServe", () => {
	it("accepts a verb-backed provider", () => {
		expect(
			canServe(provider({ servesVerbs: true, verbs: ["web.search"] }))
		).toBe(true);
	});

	// The regression. `markitdown` is bound, default, and works — and was rendered
	// unpickable because this returned false.
	it("accepts a route-backed provider that binds no verbs", () => {
		expect(
			canServe(provider({ id: "@ryu/markitdown", servesRoute: true }))
		).toBe(true);
	});

	it("accepts a provider serving both ways", () => {
		expect(canServe(provider({ servesRoute: true, servesVerbs: true }))).toBe(
			true
		);
	});

	// Unreachable for anything shipped in the repo. Kept because it is the whole
	// point of the flag pair: a manifest that declares a capability with no serving
	// surface of either kind must not be offered as an equal choice, or selecting it
	// resolves the capability to nothing and the layer goes dark with no error.
	it("rejects a provider that serves neither verbs nor a route", () => {
		expect(canServe(provider({}))).toBe(false);
	});
});

describe("fetchCapabilityLayers provider flags", () => {
	it("reads both serving flags off the wire", async () => {
		const p = await firstProvider({
			id: "@ryu/markitdown",
			name: "MarkItDown",
			serves_route: true,
			serves_verbs: false,
		});
		expect(p.servesRoute).toBe(true);
		expect(p.servesVerbs).toBe(false);
		expect(canServe(p)).toBe(true);
	});

	// An older Core omits `serves_verbs` but still sends `verbs`, so the array is a
	// truthful fallback. Defaulting to `true` instead would be the direction that
	// silently offers a dead pick.
	it("falls back to the verb array when serves_verbs is absent", async () => {
		expect(
			(await firstProvider({ id: "@ryu/exa", verbs: ["web.search"] }))
				.servesVerbs
		).toBe(true);
		expect(
			(await firstProvider({ id: "@ryu/exa", verbs: [] })).servesVerbs
		).toBe(false);
		expect((await firstProvider({ id: "@ryu/exa" })).servesVerbs).toBe(false);
	});

	// No fallback exists — the route is a manifest fact only Core can see. So a
	// desktop on a pre-`serves_route` Core keeps the pre-fix behaviour for
	// route-backed layers rather than guessing. Both halves must ship together.
	it("defaults serves_route to false when absent, never guessing true", async () => {
		const p = await firstProvider({ id: "@ryu/markitdown", verbs: [] });
		expect(p.servesRoute).toBe(false);
		expect(canServe(p)).toBe(false);
	});
});

// `toolkit` — "should the node dropdown list this as a swappable layer" — degrades
// the same way `serves_route` does, and for the same reason: only Core can compute
// it (it needs the facade verb table and the whole known manifest set), so the
// desktop has nothing truthful to fall back to.
//
// The tempting fallback is `selectable`, and that IS the bug this flag replaces:
// `selectable` is the binder's tie-break flag, trivially true for a capability with
// one provider, which is how four app-private capabilities became "toolkits".
// Falling back to it would keep reproducing that against an older Core.
describe("fetchCapabilityLayers toolkit flag", () => {
	async function firstLayer(over: Record<string, unknown>) {
		const payload = {
			capabilities: [
				{
					available: [],
					bound: null,
					capability: "news.crud",
					overridden: false,
					providers: [],
					selectable: true,
					...over,
				},
			],
			verbs: [],
		};
		const model = await withPayload(payload, () =>
			fetchCapabilityLayers(TARGET)
		);
		const layer = model.capabilities[0];
		if (!layer) {
			throw new Error("payload must map to exactly one layer");
		}
		return layer;
	}

	it("reads toolkit off the wire", async () => {
		expect((await firstLayer({ toolkit: true })).toolkit).toBe(true);
		expect((await firstLayer({ toolkit: false })).toolkit).toBe(false);
	});

	it("defaults an absent toolkit to false, not to selectable", async () => {
		const layer = await firstLayer({});
		expect(layer.selectable).toBe(true);
		expect(layer.toolkit).toBe(false);
	});

	// The layer's NAME now comes from its providers' manifests, so it is the first
	// string on this wire an app author writes rather than the client. Blank has to
	// collapse to `null`: a header rendered as empty space is worse than the
	// picker's own fallback naming, and "" is a value a manifest can carry.
	it("normalises the capability title, blank included", async () => {
		expect((await firstLayer({ title: "Search" })).title).toBe("Search");
		expect((await firstLayer({ title: "  Search  " })).title).toBe("Search");
		expect((await firstLayer({ title: "   " })).title).toBeNull();
		expect((await firstLayer({})).title).toBeNull();
	});
});
