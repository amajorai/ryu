import { describe, expect, it } from "bun:test";
import { ContributionRegistry } from "./registry.ts";

const ctx = { onClose: () => undefined };

describe("ContributionRegistry route resolution", () => {
	it("resolves an exact path to its render-fn", () => {
		const reg = new ContributionRegistry();
		reg.registerRoute({ kind: "exact", path: "/chat", render: () => "chat" });
		expect(reg.resolve("/chat")?.({ path: "/chat" }, ctx)).toBe("chat");
	});

	it("returns null for an unknown path (the old `return null` fallthrough)", () => {
		const reg = new ContributionRegistry();
		reg.registerRoute({ kind: "exact", path: "/chat", render: () => "chat" });
		expect(reg.resolve("/nope")).toBeNull();
	});

	it("prefers an exact match over a pattern (first-match-wins)", () => {
		const reg = new ContributionRegistry();
		// Pattern registered FIRST, exact SECOND — exact must still win, matching
		// the old chain where `/agents` sat above `/agents/.+/edit`.
		reg.registerRoute({
			kind: "pattern",
			test: /^\/agents\/.+$/,
			render: () => "pattern",
		});
		reg.registerRoute({
			kind: "exact",
			path: "/agents",
			render: () => "exact",
		});
		expect(reg.resolve("/agents")?.({ path: "/agents" }, ctx)).toBe("exact");
		expect(
			reg.resolve("/agents/abc/edit")?.({ path: "/agents/abc/edit" }, ctx)
		).toBe("pattern");
	});

	it("matches a startsWith pattern route", () => {
		const reg = new ContributionRegistry();
		reg.registerRoute({
			kind: "pattern",
			test: { startsWith: "/file/" },
			render: (tab) => tab.path,
		});
		expect(reg.resolve("/file/abc")?.({ path: "/file/abc" }, ctx)).toBe(
			"/file/abc"
		);
	});

	it("invokes the teardown on unregister (the Disposable seam)", () => {
		const reg = new ContributionRegistry();
		const dispose = reg.registerRoute({
			kind: "exact",
			path: "/chat",
			render: () => "chat",
		});
		expect(reg.resolve("/chat")).not.toBeNull();
		dispose();
		expect(reg.resolve("/chat")).toBeNull();
	});

	it("removes a pattern route on unregister without disturbing others", () => {
		const reg = new ContributionRegistry();
		reg.registerRoute({
			kind: "pattern",
			test: /^\/a\/.+$/,
			render: () => "a",
		});
		const disposeB = reg.registerRoute({
			kind: "pattern",
			test: /^\/b\/.+$/,
			render: () => "b",
		});
		disposeB();
		expect(reg.resolve("/a/x")?.({ path: "/a/x" }, ctx)).toBe("a");
		expect(reg.resolve("/b/x")).toBeNull();
	});
});

describe("ContributionRegistry commands", () => {
	it("registers and lists a command, and unregisters it", () => {
		const reg = new ContributionRegistry();
		const dispose = reg.registerCommand({
			id: "do.thing",
			group: "Plugin",
			title: "Do Thing",
			run: () => undefined,
		});
		expect(reg.listCommands().map((c) => c.id)).toEqual(["do.thing"]);
		dispose();
		expect(reg.listCommands()).toEqual([]);
	});
});
