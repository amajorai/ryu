import { expect, test } from "bun:test";
import {
	normalisePaletteQuery,
	type RankableEntry,
	rankPaletteEntries,
} from "../palette/rank.ts";

const ENTRIES: RankableEntry[] = [
	{ id: "nav:/chat", label: "Go to Chat" },
	{ id: "nav:/agents", label: "Go to Agents" },
	{ id: "nav:/engines", label: "Go to Engines" },
	{ id: "nav:/home", label: "Go to Home" },
	{ id: "nav:/monitors", label: "Go to Monitors" },
	{ id: "action:new-chat", label: "New chat", aliases: ["new tab"] },
	{ id: "action:split", label: "Split pane" },
	{
		id: "action:gateway",
		label: "Open Gateway",
		aliases: ["channels", "identities"],
	},
	{ id: "action:node", label: "Switch node" },
];

function labels(query: string, recent?: string[]): string[] {
	return rankPaletteEntries(ENTRIES, query, recent).map((entry) => entry.label);
}

test("normalises case and collapses inner whitespace", () => {
	expect(normalisePaletteQuery("  New   CHAT ")).toBe("new chat");
});

test("an empty query keeps every entry in declaration order", () => {
	expect(labels("   ")).toEqual(ENTRIES.map((entry) => entry.label));
});

test("space-free queries match across words", () => {
	expect(labels("gotohome")[0]).toBe("Go to Home");
	expect(labels("gotoagents")[0]).toBe("Go to Agents");
});

test("queries with spaces rank the exact label first", () => {
	expect(labels("new chat")[0]).toBe("New chat");
});

test("fuzzy subsequence finds abbreviated labels", () => {
	expect(labels("nwcht")).toContain("New chat");
});

test("aliases match without appearing in the label", () => {
	expect(labels("channels")).toEqual(["Open Gateway"]);
});

test("a query no label can contain yields no matches", () => {
	expect(labels("go to agentsx")).toEqual([]);
});

test("ties keep declaration order and fuzzy matches sort after prefix matches", () => {
	const ranked = labels("go to");
	expect(ranked.slice(0, 5)).toEqual([
		"Go to Chat",
		"Go to Agents",
		"Go to Engines",
		"Go to Home",
		"Go to Monitors",
	]);
});

test("word-prefix outranks substring and subsequence", () => {
	// "sw n" prefixes Switch/node; "Split pane" only contains s..n as a subsequence.
	expect(labels("sw n")[0]).toBe("Switch node");
});

test("recent ids are boosted within, never across, a tier", () => {
	expect(labels("go to", ["nav:/monitors"])[0]).toBe("Go to Monitors");
	expect(labels("new", ["action:gateway"])[0]).toBe("New chat");
});
