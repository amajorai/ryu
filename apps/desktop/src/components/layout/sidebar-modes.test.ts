import { describe, expect, it } from "bun:test";
import type { PluginSidebarMode } from "@/src/lib/api/plugins.ts";
import {
	BUILTIN_SIDEBAR_MODES,
	contributedSidebarModes,
	orderedSidebarModeSections,
	resolveSidebarMode,
} from "./sidebar-modes.ts";

const mode = (over: Partial<PluginSidebarMode> = {}): PluginSidebarMode => ({
	id: "bots",
	plugin: "@acme/bots",
	title: "Bot mode",
	sections: ["chats", "agents"],
	...over,
});

describe("contributedSidebarModes", () => {
	it("namespaces the key and keeps declared order and default", () => {
		const [resolved] = contributedSidebarModes(
			[mode({ default_section: "agents", order: 1 })],
			[]
		);
		expect(resolved?.key).toBe("plugin:@acme/bots:bots");
		expect(resolved?.sections).toEqual(["chats", "agents"]);
		expect(resolved?.defaultSection).toBe("agents");
		expect(resolved?.layout).toBe("strip");
	});

	it("sorts by `order`, unordered modes last", () => {
		const keys = contributedSidebarModes(
			[
				mode({ id: "c" }),
				mode({ id: "b", order: 2 }),
				mode({ id: "a", order: 1 }),
			],
			[]
		).map((m) => m.key);
		expect(keys).toEqual([
			"plugin:@acme/bots:a",
			"plugin:@acme/bots:b",
			"plugin:@acme/bots:c",
		]);
	});

	it("keeps a contributed section the shell actually has, drops one it does not", () => {
		const [resolved] = contributedSidebarModes(
			[
				mode({
					sections: [
						"agents",
						"plugin:@acme/bots:roster",
						"plugin:@other/app:gone",
					],
				}),
			],
			["plugin:@acme/bots:roster"]
		);
		// A section belonging to an app the user has not installed costs a TAB, not
		// the mode — the arrangement is still usable without it.
		expect(resolved?.sections).toEqual(["agents", "plugin:@acme/bots:roster"]);
	});

	it("drops a mode left with no resolvable section", () => {
		expect(
			contributedSidebarModes([mode({ sections: ["plugin:@x/y:nope"] })], [])
		).toEqual([]);
		expect(contributedSidebarModes([mode({ sections: [] })], [])).toEqual([]);
	});

	it("ignores a default_section that is not among the surviving sections", () => {
		const [resolved] = contributedSidebarModes(
			[mode({ sections: ["agents"], default_section: "plugin:@x/y:gone" })],
			[]
		);
		expect(resolved?.defaultSection).toBeUndefined();
	});
});

describe("resolveSidebarMode", () => {
	const modes = [
		...BUILTIN_SIDEBAR_MODES,
		...contributedSidebarModes([mode()], []),
	];

	it("resolves a built-in and a contributed mode", () => {
		expect(resolveSidebarMode("agent", modes, true).mode.key).toBe("agent");
		expect(
			resolveSidebarMode("plugin:@acme/bots:bots", modes, true).mode.title
		).toBe("Bot mode");
	});

	it("falls back to built-in Bot mode without calling a mode stale while the feed is unsettled", () => {
		// Cold start: the mode is unknown because nothing has answered yet. Clearing
		// here would silently un-choose a mode the user did pick.
		const pending = resolveSidebarMode("plugin:@acme/bots:bots", [], false);
		expect(pending.mode.key).toBe("agent");
		expect(pending.stale).toBe(false);
	});

	it("calls a stored mode stale once the feed has answered without it", () => {
		const gone = resolveSidebarMode(
			"plugin:@acme/bots:bots",
			modes.slice(0, 3),
			true
		);
		expect(gone.mode.key).toBe("agent");
		expect(gone.stale).toBe(true);
	});

	it("never calls a built-in stale", () => {
		expect(resolveSidebarMode("tabbed", modes, true).stale).toBe(false);
	});
});

describe("built-in modes", () => {
	it("expresses Bot mode with the same fields a contributed mode gets", () => {
		const agent = BUILTIN_SIDEBAR_MODES.find((m) => m.key === "agent");
		expect(agent?.title).toBe("Agents view");
		expect(agent?.sections).toEqual(["agents", "chats"]);
		// Agents are primary, direct threads live under each bot, and other chats
		// stay reachable below the roster.
		expect(agent?.defaultSection).toBe("agents");
		expect(agent?.layout).toBe("stacked");
	});

	it("keeps Bot mode Agents first despite global sidebar ordering", () => {
		const agent = BUILTIN_SIDEBAR_MODES.find((m) => m.key === "agent");
		if (!agent) {
			throw new Error("Bot mode descriptor is missing");
		}
		expect(orderedSidebarModeSections(agent, ["chats", "agents"])).toEqual([
			"agents",
			"chats",
		]);
	});

	it("leaves the two shell-wide modes naming no sections", () => {
		expect(
			BUILTIN_SIDEBAR_MODES.filter((m) => m.sections === null).map((m) => m.key)
		).toEqual(["sections", "tabbed"]);
	});
});
