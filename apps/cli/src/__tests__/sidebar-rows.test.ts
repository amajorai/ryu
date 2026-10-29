import { expect, test } from "bun:test";
import { emptySidebarData, type SidebarData } from "../sidebar/data.ts";
import {
	buildSidebarRows,
	resolveCollapsed,
	type SidebarRowActions,
	truncateLabel,
	truncateStart,
} from "../sidebar/rows.ts";

function recordingActions(log: string[]): SidebarRowActions {
	return {
		openPalette: () => log.push("palette"),
		openSettings: () => log.push("settings"),
		openTab: (path, options) =>
			log.push(options?.forceNew ? `tab:${path}:new` : `tab:${path}`),
		switchMode: () => log.push("mode"),
		switchNode: () => log.push("node"),
		toggleSection: (section) => log.push(`toggle:${section}`),
	};
}

const DATA: SidebarData = {
	...emptySidebarData,
	agents: [{ id: "a1", label: "Agent One", path: "/agents" }],
	projects: [
		{
			id: "atlas",
			name: "Atlas",
			chats: [{ id: "c1", label: "Atlas chat", path: "/chat" }],
		},
	],
	chats: [{ id: "c2", label: "Loose chat", path: "/chat" }],
};

test("rows flatten node, mode, nav, sections and footer in render order", () => {
	const log: string[] = [];
	const rows = buildSidebarRows(
		DATA,
		resolveCollapsed(DATA, {}),
		"console",
		recordingActions(log)
	);
	expect(rows.map((row) => row.key)).toEqual([
		"node",
		"mode",
		"nav:home",
		"nav:new-chat",
		"nav:search",
		"nav:library",
		"nav:store",
		"nav:tasks",
		"nav:timeline",
		"section:agents",
		"item:agents:a1",
		"section:teams",
		"section:spaces",
		"section:meetings",
		"section:workflows",
		"section:pinned",
		"section:projects",
		"item:projects:atlas:c1",
		"section:chats",
		"item:chats:c2",
		"section:archived",
		"footer:account",
		"footer:inbox",
		"footer:downloads",
	]);
	for (const row of rows) {
		row.onSelect();
	}
	expect(log).toContain("tab:/chat:new");
	expect(log).toContain("toggle:agents");
	expect(log).toContain("palette");
	expect(log).toContain("settings");
	expect(rows.filter((row) => row.header).map((row) => row.section)).toEqual([
		"agents",
		"teams",
		"spaces",
		"meetings",
		"workflows",
		"pinned",
		"projects",
		"chats",
		"archived",
	]);
});

test("empty sections start collapsed and a user fold overrides the data default", () => {
	const collapsed = resolveCollapsed(DATA, { agents: true, teams: false });
	expect(collapsed.agents).toBe(true);
	expect(collapsed.teams).toBe(false);
	expect(collapsed.spaces).toBe(true);
	expect(collapsed.chats).toBe(false);
	const keys = buildSidebarRows(
		DATA,
		collapsed,
		"os",
		recordingActions([])
	).map((row) => row.key);
	expect(keys).not.toContain("item:agents:a1");
	expect(keys).toContain("item:chats:c2");
});

test("bot mode keeps only its reduced cluster", () => {
	const rows = buildSidebarRows(
		DATA,
		resolveCollapsed(DATA, {}),
		"bot",
		recordingActions([])
	);
	expect(rows.map((row) => row.key)).toEqual([
		"mode",
		"nav:new-chat",
		"nav:search",
		"footer:account",
	]);
});

test("labels truncate to their column budget with an ellipsis", () => {
	expect(truncateLabel("Short", 10)).toBe("Short");
	expect(truncateLabel("Exactly ten", 11)).toBe("Exactly ten");
	expect(truncateLabel("A very long agent name", 10)).toBe("A very lo…");
	// Trailing spaces before the cut are dropped.
	expect(truncateLabel("Alpha beta gamma", 7)).toBe("Alpha…");
	// Wide characters count as two columns.
	expect(
		Bun.stringWidth(truncateLabel("日本語のエージェント", 7))
	).toBeLessThanOrEqual(7);
	expect(truncateLabel("anything", 0)).toBe("");
});

test("the node url keeps its tail so the port stays visible", () => {
	expect(truncateStart("127.0.0.1:7980", 18)).toBe("127.0.0.1:7980");
	expect(truncateStart("my-very-long-node-host.example.com:7980", 18)).toBe(
		"….example.com:7980"
	);
	expect(
		Bun.stringWidth(
			truncateStart("my-very-long-node-host.example.com:7980", 18)
		)
	).toBe(18);
});
