import { expect, test } from "bun:test";
import {
	MIGRATION_SOURCES,
	migrationSourceLabel,
	newMigrationItems,
	summarizeMigrationItems,
} from "./agent-migration.ts";
import type { ScanItem } from "./api/import.ts";

function item(kind: ScanItem["kind"], alreadyExists = false): ScanItem {
	return { alreadyExists, id: `${kind}/x`, kind, title: kind };
}

test("summarizes items in a stable kind order with singular and plural nouns", () => {
	expect(
		summarizeMigrationItems([
			item("skill"),
			item("memory"),
			item("agent"),
			item("memory"),
			item("mcp_server"),
		])
	).toBe("1 agent · 2 memory files · 1 skill · 1 MCP server");
	expect(summarizeMigrationItems([])).toBe("");
});

test("summarizes a chat export as chats, projects, and saved context", () => {
	expect(
		summarizeMigrationItems([
			{
				...item("conversations"),
				id: "conversations/conversations.json#chats",
			},
			{ ...item("conversations"), id: "conversations/conversations.json#p1" },
			{ ...item("conversations"), id: "conversations/conversations.json#p2" },
			{ ...item("memory"), id: "memory/conversations.json#saved-context" },
		])
	).toBe("Chats · 2 projects · saved context");
});

test("new items exclude what Ryu already has", () => {
	const scan = {
		items: [item("agent"), item("skill", true)],
		root: "/home/u/.openclaw",
		warnings: [],
	};
	expect(newMigrationItems(scan).map((i) => i.kind)).toEqual(["agent"]);
});

test("labels Core sources and keeps home folders only for installed agents", () => {
	expect(migrationSourceLabel("persona")).toBe("Dots");
	expect(migrationSourceLabel("hermes")).toBe("Hermes");
	expect(migrationSourceLabel(undefined)).toBe("Folder");
	expect(MIGRATION_SOURCES.filter((s) => s.homes).map((s) => s.id)).toEqual([
		"claude",
		"codex",
		"cursor",
		"openclaw",
		"hermes",
	]);
});
