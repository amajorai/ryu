// Source, item-kind, and Core import-API schemas for `ryu migrate`.

import { z } from "zod";

export interface SourceSpec {
	/** Folders tried in order when no path is given (`~` expands on the node). */
	defaults: readonly string[];
	label: string;
	/** Shown when no default exists and no path was given. */
	needsPath?: string;
}

export const SOURCES = {
	openclaw: {
		label: "OpenClaw",
		defaults: ["~/.openclaw", "~/.clawdbot", "~/.moltbot"],
	},
	hermes: { label: "Hermes", defaults: ["~/.hermes"] },
	chatgpt: {
		label: "ChatGPT",
		defaults: [],
		needsPath:
			"Export your data from ChatGPT (Settings → Data controls → Export data), unzip the download, and pass the folder that holds conversations.json.",
	},
	claude: {
		label: "Claude",
		defaults: [],
		needsPath:
			"Export your data from Claude (Settings → Privacy → Export data), unzip the download, and pass the folder that holds conversations.json.",
	},
	muse: {
		label: "Muse",
		defaults: [],
		needsPath:
			"Download your Muse data (Settings → Data controls → Download your Muse data), extract it, and pass the folder that holds SOUL.md and MEMORY.md.",
	},
	mastra: { label: "Mastra", defaults: ["."] },
	langchain: { label: "LangChain", defaults: ["."] },
	dots: {
		label: "Dots",
		defaults: [],
		needsPath:
			"OpenAI Dots has no setup export. Save the dot's instructions as SOUL.md (add IDENTITY.md with `Name: <name>` to keep its name) and anything you want it to remember as MEMORY.md in one folder, then pass that folder.",
	},
} as const satisfies Record<string, SourceSpec>;

export type SourceId = keyof typeof SOURCES;

export const sourceIdSchema = z.enum([
	"openclaw",
	"hermes",
	"chatgpt",
	"claude",
	"muse",
	"mastra",
	"langchain",
	"dots",
]);

/** Core reports a Claude data export as `claude-ai`; the CLI says `claude`. */
export const CORE_SOURCE_IDS = new Map<SourceId, string>([
	["claude", "claude-ai"],
	["dots", "persona"],
]);

/** Accept a few common spellings of each source. */
export const SOURCE_ALIASES = new Map<string, SourceId>([
	["claw", "openclaw"],
	["clawdbot", "openclaw"],
	["moltbot", "openclaw"],
	["hermes-agent", "hermes"],
	["langgraph", "langchain"],
	["dot", "dots"],
	["openai-dots", "dots"],
	["meta-muse", "muse"],
	["openai", "chatgpt"],
	["claude.ai", "claude"],
	["claude-ai", "claude"],
	["anthropic", "claude"],
]);

export const ITEM_KINDS = [
	"conversations",
	"agent",
	"instructions",
	"skill",
	"mcp_server",
	"memory",
	"plugin",
	"slash_command",
] as const;
export const itemKindSchema = z.enum(ITEM_KINDS);
export type ItemKind = z.infer<typeof itemKindSchema>;

export const KIND_LABELS: Record<ItemKind, string> = {
	conversations: "Chats and projects",
	agent: "Agents",
	instructions: "Instructions",
	skill: "Skills",
	mcp_server: "MCP servers",
	memory: "Memory",
	plugin: "Plugins (installed disabled)",
	slash_command: "Slash commands",
};

export const scanItemSchema = z.object({
	already_exists: z.boolean().optional(),
	detail: z.string().optional(),
	id: z.string(),
	kind: z.string(),
	title: z.string(),
});
export type ScanItem = z.infer<typeof scanItemSchema>;

export const scanSchema = z.object({
	items: z.array(scanItemSchema).default([]),
	root: z.string(),
	source: z.string().nullish(),
	warnings: z.array(z.string()).default([]),
});
export type Scan = z.infer<typeof scanSchema>;

export const outcomeSchema = z.object({
	detail: z.string().nullish(),
	id: z.string(),
	kind: z.string(),
	status: z.string(),
	title: z.string(),
});
export type Outcome = z.infer<typeof outcomeSchema>;

export const runSchema = z.object({
	results: z.array(outcomeSchema).default([]),
	root: z.string().optional(),
});
