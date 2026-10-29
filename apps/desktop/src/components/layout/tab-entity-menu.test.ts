import { describe, expect, it } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { Tab } from "@/src/contexts/TabsContext.tsx";
// The menu also mounts browser-backed workspace stores. Initialize their host
// before importing the real menu; keep all entity routing assertions unchanged.
if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
const { deriveTabEntity } = await import("./tab-entity-menu.tsx");

// `deriveTabEntity` is what decides whether a tab menu grows an entity section
// at all, and which anchor apps get to contribute to. The failure modes are both
// silent: derive nothing and an app's declared row never appears; derive the
// WRONG anchor/id and the row appears but dispatches a capability against
// something that isn't there. The list-vs-detail routes (`/agents/new/edit`) are
// the trap — they look exactly like a detail route to a naive split.

function tab(overrides: Partial<Tab>): Tab {
	return { id: "t1", path: "/home", title: "Tab", ...overrides };
}

describe("deriveTabEntity", () => {
	it("prefers the conversation a tab carries over its path", () => {
		expect(
			deriveTabEntity(tab({ path: "/chat", conversationId: "c1" }))
		).toEqual({ anchor: "conversation", id: "c1", idKey: "conversation_id" });
	});

	it("derives the entity from detail routes that carry an id", () => {
		expect(deriveTabEntity(tab({ path: "/spaces/s1" }))?.anchor).toBe("space");
		expect(deriveTabEntity(tab({ path: "/spaces/s1" }))?.id).toBe("s1");
		expect(deriveTabEntity(tab({ path: "/agents/a1/edit" }))?.id).toBe("a1");
		expect(deriveTabEntity(tab({ path: "/workflows/w1" }))?.idKey).toBe(
			"workflow_id"
		);
		expect(deriveTabEntity(tab({ path: "/channels/ch1" }))?.anchor).toBe(
			"channel"
		);
	});

	it("keeps a nested space route anchored to the space itself", () => {
		// `/spaces/s1/doc/d1` is still a space tab — the doc is a view inside it.
		expect(deriveTabEntity(tab({ path: "/spaces/s1/doc/d1" }))).toEqual({
			anchor: "space",
			id: "s1",
			idKey: "space_id",
		});
	});

	it("returns null for create routes whose id slot is a reserved word", () => {
		expect(deriveTabEntity(tab({ path: "/agents/new/edit" }))).toBeNull();
		expect(deriveTabEntity(tab({ path: "/workflows/new" }))).toBeNull();
		expect(deriveTabEntity(tab({ path: "/workflows/build" }))).toBeNull();
	});

	it("returns null for list routes and pages that show no entity", () => {
		expect(deriveTabEntity(tab({ path: "/spaces" }))).toBeNull();
		expect(deriveTabEntity(tab({ path: "/settings" }))).toBeNull();
		expect(deriveTabEntity(tab({ path: "/store/agents" }))).toBeNull();
		// A launchpad chat tab has no conversation yet — nothing to act on.
		expect(deriveTabEntity(tab({ path: "/chat" }))).toBeNull();
	});

	it("ignores a query string when reading the id", () => {
		expect(deriveTabEntity(tab({ path: "/spaces/s1?tab=graph" }))?.id).toBe(
			"s1"
		);
	});
});
