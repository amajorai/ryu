// Agent capability allowlists have three distinct Core meanings: an explicit
// "no tools" sentinel, an "all tools" marker (`*` or the legacy empty list),
// and a concrete list. These tests pin how the picker hydrates and re-encodes
// each state, so a save never silently widens or drops a grant.

import { expect, test } from "bun:test";
import type { McpTool } from "@ryuhq/core-client/mcp";
import {
	type AgentSkillOption,
	ALL_MCP_TOOLS,
	encodeSkillSelection,
	encodeToolSelection,
	NO_AGENT_CAPABILITIES,
	selectedSkillIds,
	selectedToolIds,
	skillPickerRows,
	toolPickerRows,
} from "./capabilities.ts";

function tool(server: string, name: string): McpTool {
	return {
		description: `${name} on ${server}`,
		id: `${server}.${name}`,
		inputSchema: null,
		name,
		server,
	};
}

const TOOLS: McpTool[] = [
	tool("fs", "read"),
	tool("fs", "write"),
	tool("web", "fetch"),
];

const SKILLS: AgentSkillOption[] = [
	{ description: "Writes docs", enabled: true, id: "docs", name: "Docs" },
	{ description: null, enabled: true, id: "review", name: "Review" },
	{ description: null, enabled: false, id: "deploy", name: "Deploy" },
];

test("an empty tool selection encodes the explicit no-capabilities sentinel", () => {
	expect(encodeToolSelection(new Set(), TOOLS)).toEqual([
		NO_AGENT_CAPABILITIES,
	]);
	expect(selectedToolIds([NO_AGENT_CAPABILITIES], TOOLS).size).toBe(0);
});

test("`*` and the legacy empty list both hydrate to every catalog tool", () => {
	const all = new Set(TOOLS.map((entry) => entry.id));
	expect(selectedToolIds([ALL_MCP_TOOLS], TOOLS)).toEqual(all);
	expect(selectedToolIds([], TOOLS)).toEqual(all);
});

test("selecting every visible tool saves concrete ids, never the `*` wildcard", () => {
	const all = new Set(TOOLS.map((entry) => entry.id));
	expect(encodeToolSelection(all, TOOLS)).toEqual([
		"fs.read",
		"fs.write",
		"web.fetch",
	]);
});

test("selectedToolIds matches an allowlist entry by id, name, or whole server", () => {
	expect(selectedToolIds(["fs.read"], TOOLS)).toEqual(new Set(["fs.read"]));
	expect(selectedToolIds(["fetch"], TOOLS)).toEqual(new Set(["web.fetch"]));
	expect(selectedToolIds(["fs"], TOOLS)).toEqual(
		new Set(["fs.read", "fs.write"])
	);
});

test("a saved tool grant missing from the catalog is kept and labelled unavailable", () => {
	const allowlist = ["fs.read", "gone.tool"];
	const selected = selectedToolIds(allowlist, TOOLS);
	expect(selected).toEqual(new Set(["fs.read", "gone.tool"]));

	const rows = toolPickerRows(allowlist, TOOLS);
	expect(rows.map((row) => row.id)).toEqual([
		"fs.read",
		"fs.write",
		"web.fetch",
		"gone.tool",
	]);
	const missing = rows.at(-1);
	expect(missing?.label).toBe("gone.tool · saved, unavailable");
	expect(missing?.tool).toBeNull();

	// Re-saving without touching the row keeps the unavailable grant.
	expect(encodeToolSelection(selected, TOOLS)).toEqual([
		"fs.read",
		"gone.tool",
	]);
});

test("wildcard and sentinel allowlists add no saved-unavailable tool rows", () => {
	expect(toolPickerRows([ALL_MCP_TOOLS], TOOLS)).toHaveLength(TOOLS.length);
	expect(toolPickerRows([NO_AGENT_CAPABILITIES], TOOLS)).toHaveLength(
		TOOLS.length
	);
	expect(toolPickerRows([], TOOLS)[0]?.label).toBe("read · fs");
});

test("skills: empty selection is the sentinel, all enabled is the legacy empty list", () => {
	expect(encodeSkillSelection(new Set(), SKILLS)).toEqual([
		NO_AGENT_CAPABILITIES,
	]);
	expect(encodeSkillSelection(new Set(["docs", "review"]), SKILLS)).toEqual([]);
	expect(encodeSkillSelection(new Set(["docs"]), SKILLS)).toEqual(["docs"]);
	expect(selectedSkillIds([], SKILLS)).toEqual(new Set(["docs", "review"]));
	expect(selectedSkillIds([NO_AGENT_CAPABILITIES], SKILLS).size).toBe(0);
});

test("a saved skill grant missing from the installed list is kept and labelled", () => {
	const allowlist = ["docs", "removed-skill"];
	const rows = skillPickerRows(allowlist, SKILLS);
	const missing = rows.find((row) => row.id === "removed-skill");
	expect(missing).toEqual({
		description: "Saved grant is not in the current installed-skill list.",
		enabled: false,
		id: "removed-skill",
		label: "removed-skill · saved, unavailable",
		missing: true,
	});
	expect(rows.find((row) => row.id === "deploy")?.label).toBe(
		"Deploy · disabled"
	);
	expect(
		encodeSkillSelection(selectedSkillIds(allowlist, SKILLS), SKILLS)
	).toEqual(["docs", "removed-skill"]);
	// The no-skills sentinel is a marker, not a saved grant to list.
	expect(
		skillPickerRows([NO_AGENT_CAPABILITIES], SKILLS).map((row) => row.id)
	).toEqual(["docs", "review", "deploy"]);
});
