// apps/desktop/src/lib/agent-migration.ts
//
// The agent frameworks Ryu can migrate from, shared by the onboarding migration
// step, the Import agent setup dialog, and Gateway → Import agents. Detection
// and every write stay in Core (`/api/import/scan` → `/api/import/run`); this
// module only knows where each product keeps its home folder and how to label
// what Core found.

import type { SvglSpec } from "@ryu/blocks/web/svgl-icon.tsx";
import type { ApiTarget } from "./api/client.ts";
import {
	type ImportItemKind,
	type ScanItem,
	type ScanResult,
	scanImportFolder,
} from "./api/import.ts";
import { listDirectory } from "./api/workspace.ts";

export type MigrationSourceId =
	| "claude"
	| "codex"
	| "cursor"
	| "openclaw"
	| "hermes"
	| "muse"
	| "mastra"
	| "langchain"
	| "persona"
	| "chatgpt"
	| "claude-ai";

export interface MigrationSource {
	/** One line on where to find the folder to pick. */
	hint: string;
	/** Home folders under `~`, tried in order. Absent when the source has no
	    fixed home (an export download or a code project). */
	homes?: readonly string[];
	id: MigrationSourceId;
	label: string;
	/** Bundled brand mark (`/logos/<slug>.svg`). */
	logo: SvglSpec;
}

export const MIGRATION_SOURCES: readonly MigrationSource[] = [
	{
		id: "claude",
		label: "Claude Code",
		logo: "claude",
		homes: [".claude"],
		hint: "Your ~/.claude folder",
	},
	{
		id: "codex",
		label: "Codex",
		logo: "codex",
		homes: [".codex"],
		hint: "Your ~/.codex folder",
	},
	{
		id: "cursor",
		label: "Cursor",
		logo: { light: "cursor_light", dark: "cursor_dark" },
		homes: [".cursor"],
		hint: "Your ~/.cursor folder",
	},
	{
		id: "openclaw",
		label: "OpenClaw",
		logo: "openclaw",
		homes: [".openclaw", ".clawdbot", ".moltbot"],
		hint: "Your ~/.openclaw folder",
	},
	{
		id: "hermes",
		label: "Hermes",
		logo: { light: "hermes_light", dark: "hermes_dark" },
		homes: [".hermes"],
		hint: "Your ~/.hermes folder",
	},
	{
		id: "chatgpt",
		label: "ChatGPT",
		logo: { light: "openai", dark: "openai_dark" },
		hint: "The unzipped folder from ChatGPT → Settings → Data controls → Export data",
	},
	{
		id: "claude-ai",
		label: "Claude",
		logo: "claude",
		hint: "The unzipped folder from Claude → Settings → Privacy → Export data",
	},
	{
		id: "muse",
		label: "Muse",
		logo: "meta",
		hint: "The extracted folder from Muse → Data controls → Download your Muse data",
	},
	{
		id: "persona",
		label: "Dots",
		logo: { light: "openai", dark: "openai_dark" },
		hint: "A folder with your dot's instructions saved as SOUL.md and notes as MEMORY.md",
	},
	{
		id: "mastra",
		label: "Mastra",
		logo: { light: "mastra_light", dark: "mastra_dark" },
		hint: "Your Mastra project folder",
	},
	{
		id: "langchain",
		label: "LangChain",
		logo: "langchain",
		hint: "Your LangChain or LangGraph project folder",
	},
];

/** Brand mark for a `source` reported by Core's scan, when known. */
export function migrationSourceLogo(
	source: string | undefined
): SvglSpec | null {
	return MIGRATION_SOURCES.find((entry) => entry.id === source)?.logo ?? null;
}

/** Display name for a `source` reported by Core's scan. */
export function migrationSourceLabel(source: string | undefined): string {
	if (!source) {
		return "Folder";
	}
	return (
		MIGRATION_SOURCES.find((entry) => entry.id === source)?.label ?? source
	);
}

const KIND_NOUNS: Record<ImportItemKind, [string, string]> = {
	agent: ["agent", "agents"],
	conversations: ["project", "projects"],
	instructions: ["instructions file", "instructions files"],
	mcp_server: ["MCP server", "MCP servers"],
	memory: ["memory file", "memory files"],
	plugin: ["plugin", "plugins"],
	skill: ["skill", "skills"],
	slash_command: ["slash command", "slash commands"],
};

const KIND_ORDER: readonly ImportItemKind[] = [
	"conversations",
	"agent",
	"memory",
	"skill",
	"mcp_server",
	"instructions",
	"plugin",
	"slash_command",
];

/** A ChatGPT / Claude export's chats outside any project. */
const isLooseChats = (item: ScanItem) =>
	item.kind === "conversations" && item.id.endsWith("#chats");
/** ChatGPT custom instructions or Claude saved memory from an export. */
const isSavedContext = (item: ScanItem) =>
	item.kind === "memory" && item.id.endsWith("#saved-context");

/** "1 agent · 4 memory files · 2 skills" for the items Ryu does not have yet;
    export items read "Chats · 2 projects · saved context". */
export function summarizeMigrationItems(items: readonly ScanItem[]): string {
	const parts: string[] = [];
	if (items.some(isLooseChats)) {
		parts.push("Chats");
	}
	const rest = items.filter((item) => !isLooseChats(item));
	for (const kind of KIND_ORDER) {
		const count = rest.filter(
			(item) => item.kind === kind && !isSavedContext(item)
		).length;
		if (count > 0) {
			const [one, many] = KIND_NOUNS[kind];
			parts.push(`${count} ${count === 1 ? one : many}`);
		}
	}
	if (items.some(isSavedContext)) {
		parts.push("saved context");
	}
	return parts.join(" · ");
}

/** Items a migration should import: everything not already present in Ryu. */
export function newMigrationItems(scan: ScanResult): ScanItem[] {
	return scan.items.filter((item) => !item.alreadyExists);
}

function joinHome(home: string, name: string): string {
	const separator = home.includes("\\") ? "\\" : "/";
	return `${home.replace(/[\\/]$/, "")}${separator}${name}`;
}

/**
 * Scan the well-known home folders on the node and return one scan per source
 * that has something to import. A missing folder is simply not detected.
 */
export async function detectMigrationSources(
	target: ApiTarget
): Promise<ScanResult[]> {
	const listing = await listDirectory(target);
	const found: ScanResult[] = [];
	for (const source of MIGRATION_SOURCES) {
		for (const home of source.homes ?? []) {
			const scan = await scanImportFolder(
				target,
				joinHome(listing.home, home)
			).catch(() => null);
			if (scan && scan.items.length > 0) {
				// Core names framework homes itself; agent config roots such as
				// ~/.claude carry no framework `source`, so label them here.
				found.push({ ...scan, source: scan.source ?? source.id });
				break;
			}
		}
	}
	return found;
}
